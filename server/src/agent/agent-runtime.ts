import { mobileDiscoveryReport } from '../services/mobile/mobile-explorer.js';
import { getLatestMobileSessionForScan } from '../services/mobile/mobile-session-service.js';
import { stopMobileLab, getMobileTestReport } from '../services/mobile/mobile-lab-service.js';
import type { DbProvider } from '../types/index.js';
import { AIScanRepository } from '../services/ai-scan/repository.js';
import { createAgentToolRegistry } from './index.js';
import type { AIScanRun, AIScanSnapshot, AIScanTask } from '../services/ai-scan/types.js';
import { buildAutonomousAgentContext } from './context-builder.js';
import { AgentProviderDecisionUnavailableError, AutonomousAgentPlanner, coverageRetryCompletionRecoveryRequired, localPolicy } from './autonomous-planner.js';
import type { AutonomousPlannerResult } from './decision-types.js';
import { closePersistentBrowserContextsForScan, closeTaskBrowserContexts } from '../services/ai-scan/browser/persistent-browser-runtime.js';
import { interruptBusinessCapturesForTask } from '../services/ai-scan/agent-business-capture.js';
import { rememberAgentObservation } from '../services/ai-scan/agent-memory.js';
import { agentEventBus } from '../observability/agent-event-bus.js';
import { assertScanActive, scanPolicyDenial, withScanControl, POLICY_DENIAL_MESSAGE } from '../services/ai-scan/run-control.js';
import { RunDecisionBudget, taskDecisionLimit } from './decision-budget.js';
import { blockFailedDependencies } from './dependency-finalization.js';
import { ensureManualIdentityPreparation } from '../services/ai-scan/manual-identity-preparation.js';
import { TargetScopeError } from '../services/ai-scan/target-scope.js';
import { CaptureRequiredError } from '../services/ai-scan/captured-request.js';
import { DISCOVERY_COMPLETED_PHASE, isDedicatedWebDiscovery, requiresAutomaticAccounts } from './discovery-task-lifecycle.js';
import { buildModelContextScope, projectContextForModel, selectModelVisibleTools, type ModelContextScope } from './model-context-profile.js';
import { BUSINESS_PLAN_INTENT, BUSINESS_LEARNING_INTENT, BUSINESS_REVIEW_INTENT, BUSINESS_EXPERIMENT_INTENT, businessLearningEnabled,
  androidBusinessLearningEnabled, businessLearningOnly, businessLearningAutoExperiments, businessCompletionGap, latestBusinessFlows, scheduleBusinessLearning, scheduleBusinessExperiments, businessTaskIntent,
  businessExperimentTerminalDisposition, businessLearningTerminalDisposition, scheduleBusinessCoverageRetry, coverageRetryTargetBindingGap,
  COVERAGE_RETRY_COMPLETION_RECOVERY_PHASE } from './business-task-lifecycle.js';
import { ANDROID_BUSINESS_PLAN_INTENT, ANDROID_BUSINESS_LEARNING_INTENT, ANDROID_BUSINESS_EXPERIMENT_INTENT } from '../services/ai-scan/android-business-contract.js';
import { normalBusinessObjectiveManifest, normalObjectiveManifestForTask } from './normal-business-objectives.js';
import { getBusinessFlow, sealedStrictObjectiveBindings } from '../services/ai-scan/agent-business-contract.js';

export interface AgentRunResult {
  scan_run_id: string;
  steps_executed: number;
  completed: boolean;
  blocked_waiting_selection: boolean;
  last_task?: AIScanTask;
  snapshot: AIScanSnapshot;
  parallel_agents?: number;
  batches_executed?: number;
}

export interface AgentRunOptions {
  max_steps?: number;
  max_parallel_agents?: number;
}

function now(): string {
  return new Date().toISOString();
}

function transientProviderTurnRetryLimit(scanConfig: Record<string, any> = {}): number {
  const configured = Number(scanConfig.agent_provider_turn_retries ?? process.env.BSTG_AGENT_PROVIDER_TURN_RETRIES ?? 1);
  return Number.isInteger(configured) ? Math.max(0, Math.min(2, configured)) : 1;
}

const MAX_NORMAL_ASSERTION_REVISION_ATTEMPTS = 3;
// A model gets one task-bound Workflow refresh and one corrected plan. If the
// same native-step binding still fails, stop this experiment instead of
// spending the rest of its decision budget in an inspect/retry loop.
const MAX_BUSINESS_EXPERIMENT_STEP_BINDING_MISMATCH_ATTEMPTS = 2;
// Compile recovery permits two inspected model-authored child plans. A third
// rejection ends the experiment instead of replaying compiler feedback until
// the general task budget expires.
const MAX_BUSINESS_EXPERIMENT_COMPILE_FAILURE_ATTEMPTS = 3;
// A model can initially choose a non-semantic event from an otherwise valid
// stopped capture. Keep that selection correction bounded and model-owned:
// the server returns only opaque candidate IDs, then the model re-inspects
// and chooses its corrected subset. It must never become an implicit
// all-events selection or an unbounded retry loop.
const MAX_NORMAL_SEMANTIC_SELECTION_ATTEMPTS = 3;
const MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS = 3;
// A browser operation can reach the target and then fail while refreshing the
// page observation. Replaying that operation could duplicate a state-changing
// request, so normal learning gets a small number of capture-only recovery
// attempts instead. This is intentionally separate from selector correction:
// it applies only after the browser reports that the operation happened.
const MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS = 2;
const NORMAL_CAPTURE_INSPECTION_NO_PROGRESS = 'normal_capture_inspection_no_progress';
const POST_ACTION_REPLAY_FINGERPRINT = /^[a-f0-9]{64}$/i;
const transactionPrerequisiteProposalClasses = new Set([
  'wrong_tool',
  'missing_control_ref',
  'unknown_control_ref',
  'ineligible_control',
  'required_control_not_clicked',
  'unrelated_control',
  'preparation_action_incompatible',
  'preparation_wrong_form',
]);

function waitForTransientProviderRetry(attempt: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.min(1_000, 250 * Math.max(1, attempt))));
}

function selectedVulnTypes(run: AIScanRun): string[] {
  return Array.isArray(run.selected_vuln_types) ? run.selected_vuln_types : [];
}

function decisionSummary(decision: AutonomousPlannerResult): string {
  if (decision.action === 'tool_call') return `tool_call:${safeToolName(decision.tool_name) || 'unknown'}`;
  return safeDecisionAction(decision.action);
}

const SAFE_DECISION_ACTIONS = new Set(['tool_call', 'complete_task', 'fail_task', 'block_task', 'wait_for_user_selection', 'create_child_tasks', 'model_decision_required']);
const SAFE_DECISION_SOURCES = new Set(['ai_provider', 'local_policy', 'fallback']);
const SAFE_VALIDATION_STATUSES = new Set(['accepted', 'rejected', 'fallback', 'local_only']);
const SAFE_DECISION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,160}$/;
// Upstream receipt identifiers are opaque correlation handles, not provider
// response text. Keep their grammar deliberately narrower than a free-form
// token so a body or error message cannot cross this durable boundary.
const SAFE_PROVIDER_RESPONSE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SAFE_TOOL_NAME = /^[a-z][a-z0-9_.-]{0,127}$/;
const SAFE_REJECTION_CODE = /^[a-z][a-z0-9_]{1,127}$/;

function safeDecisionAction(value: unknown): string {
  return SAFE_DECISION_ACTIONS.has(String(value)) ? String(value) : 'unknown';
}

function safeToolName(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOOL_NAME.test(value) ? value : undefined;
}

function safeDecisionToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_DECISION_TOKEN.test(value) ? value : undefined;
}

function safeProviderResponseId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_PROVIDER_RESPONSE_ID.test(value) ? value : undefined;
}

/** A durable planner receipt is an audit projection, not a copy of a model
 * response. Its counts tell operators whether structure was present without
 * recording task text, browser arguments, or any request-derived values. */
function safeDecisionAudit(decision: Partial<AutonomousPlannerResult> | undefined): Record<string, unknown> {
  if (!decision) return {};
  const argumentsValue = decision.arguments && typeof decision.arguments === 'object' ? decision.arguments : {};
  const tasks = Array.isArray(decision.tasks) ? decision.tasks : [];
  return {
    action: safeDecisionAction(decision.action),
    ...(safeToolName(decision.tool_name) ? { tool_name: safeToolName(decision.tool_name) } : {}),
    has_arguments: Object.keys(argumentsValue).length > 0,
    argument_count: Math.min(Object.keys(argumentsValue).length, 128),
    task_count: Math.min(tasks.length, 128),
    has_summary: typeof decision.summary === 'string' && decision.summary.length > 0,
    has_reason: typeof decision.reason === 'string' && decision.reason.length > 0,
    has_rationale: typeof decision.rationale === 'string' && decision.rationale.length > 0,
    stop_after_tool_call: decision.stop_after_tool_call === true,
  };
}

/** The public product projection needs two explicit, opaque selections for
 * accepted business decisions. Copy neither the surrounding arguments nor
 * any user/model text into the durable receipt. */
function safePublicSelection(decision: AutonomousPlannerResult): Record<string, unknown> | undefined {
  if (decision.source !== 'ai_provider' || decision.validation_status !== 'accepted') return undefined;
  if (decision.tool_name === 'bstg.business.workflow.prepare') {
    const eventIds = Array.isArray(decision.arguments?.event_ids)
      ? [...new Set(decision.arguments.event_ids.filter((id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)))].slice(0, 128)
      : [];
    return eventIds.length ? { event_ids: eventIds } : undefined;
  }
  if (decision.tool_name === 'bstg.business.flow.define') {
    const objectiveId = typeof decision.arguments?.objective_id === 'string' && /^objective:[a-f0-9]{24}$/.test(decision.arguments.objective_id)
      ? decision.arguments.objective_id : undefined;
    return objectiveId ? { objective_id: objectiveId } : undefined;
  }
  return undefined;
}

function safeModelScopeAudit(scope: ModelContextScope | undefined): Record<string, unknown> | undefined {
  if (!scope) return undefined;
  return {
    ...(typeof scope.stage === 'string' && /^[a-z_]{1,96}$/.test(scope.stage) ? { stage: scope.stage } : {}),
    allowed_tool_count: Math.min(Array.isArray(scope.allowed_tool_names) ? scope.allowed_tool_names.length : 0, 256),
    allowed_action_count: Math.min(Array.isArray(scope.allowed_actions) ? scope.allowed_actions.length : 0, 32),
    broader_assessment_context_withheld: scope.broader_assessment_context_withheld === true,
  };
}

function safeRejectionReason(decision: AutonomousPlannerResult): string | undefined {
  if (!decision.rejection_reason) return undefined;
  const code = typeof decision.rejection_code === 'string' && SAFE_REJECTION_CODE.test(decision.rejection_code)
    ? decision.rejection_code : undefined;
  return code ? `policy_rejected:${code}` : 'policy_rejected';
}

function providerAccessDenied(decision: AutonomousPlannerResult): boolean {
  const feedback = [decision.reason, decision.summary, decision.rejection_reason]
    .filter((value): value is string => typeof value === 'string').join(' ');
  return decision.source === 'fallback' && /flagged for possible cybersecurity risk|daybreak access/i.test(feedback);
}

function decisionSignature(decision: AutonomousPlannerResult): string {
  // This receipt is projected back into the model context and public snapshot.
  // It must not be a digest of browser/model arguments: a digest would still
  // durably encode selector, fill, URL, or DOM-derived material.  The action,
  // registered-style tool name, origin, and validation class are enough for
  // the existing repetition accounting while remaining value-free.
  const action = safeDecisionAction(decision.action);
  const toolName = safeToolName(decision.tool_name) || 'none';
  const source = SAFE_DECISION_SOURCES.has(String(decision.source)) ? decision.source : 'unknown';
  const validation = SAFE_VALIDATION_STATUSES.has(String(decision.validation_status)) ? decision.validation_status : 'unknown';
  return `v1:${action}:${toolName}:${source}:${validation}`;
}

function textSummary(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return fallback || String(value);
  }
}

/** The persistent browser runtime derives this digest from a private resolved
 * control.  Keep it opaque here: it is an execution guard, never a model
 * selection surface or a substitute for the native evidence chain. */
function postActionReplayFingerprint(value: unknown): string | undefined {
  const fingerprint = (value as any)?.post_action_replay_guard?.fingerprint;
  return typeof fingerprint === 'string' && POST_ACTION_REPLAY_FINGERPRINT.test(fingerprint)
    ? fingerprint.toLowerCase() : undefined;
}

/** Android lifecycle completion is receipt-bound.  A model may describe a
 * completed task, but it cannot close an Android stage without the tool call
 * or server artifact produced by its Android-native boundary. */
async function androidBusinessCompletionGap(repo: AIScanRepository, task: AIScanTask): Promise<string | undefined> {
  const intent = String(task.execution_plan?.intent || '');
  if (![ANDROID_BUSINESS_PLAN_INTENT, ANDROID_BUSINESS_LEARNING_INTENT, ANDROID_BUSINESS_EXPERIMENT_INTENT].includes(intent)) return undefined;
  const invocations = await repo.listToolInvocations(task.scan_run_id, task.id);
  const called = (name: string) => invocations.some(invocation => invocation.tool_name === name && invocation.status === 'completed');
  if (intent === ANDROID_BUSINESS_PLAN_INTENT) {
    return called('android.business.assets.inspect') ? undefined : 'Android asset planning requires a successful Android session asset inspection.';
  }
  const artifacts = await repo.listArtifacts(task.scan_run_id);
  if (intent === ANDROID_BUSINESS_LEARNING_INTENT) {
    return artifacts.some(artifact => artifact.task_id === task.id && artifact.artifact_type === 'android_business_normal_validation')
      ? undefined : 'Android normal business learning requires the persisted native normal-validation receipt.';
  }
  return artifacts.some(artifact => artifact.task_id === task.id && artifact.artifact_type === 'android_business_experiment_ready') &&
    called('bstg.generic_vuln.run_test')
    ? undefined : 'Android experiment completion requires its readiness receipt and a completed native generic executor invocation.';
}

interface CaptureInspectionNoProgressEpisode {
  recording_session_id: string;
  capture_status: 'recording' | 'stopped';
  event_count: number | null;
  semantic_candidate_available: boolean;
  material_progress_count: number;
  // This count is a locally calculated transition total. It carries no
  // selector, value, URL, DOM, or digest derived from those values.
  browser_state_progress_count: number;
  required_next_action_class: string;
  last_unsuccessful_action_class?: string;
  objective_navigation_hints?: string[];
  // Closed semantic transaction stages derived by local browser/capture
  // evidence. They never contain a control ref, DOM text, URL, or value.
  objective_required_control_intents?: string[];
  // A diagnostic count for each required finite intent. This remains
  // value-free and cannot be used as an opaque control reference.
  objective_eligible_current_control_counts?: Record<string, number>;
  // Closed local classification only. No provider argument, reference, DOM,
  // capture, route, or scalar value can pass through this field.
  transaction_prerequisite_proposal_class?: string;
  objective_completion_required_response_paths?: string[];
  objective_completion_candidate_count?: number;
  objective_operation_id?: string;
  objective_operation_side_effect_class?: string;
  objective_operation_candidate_count?: number;
  coverage_retry_candidate_count?: number;
  coverage_retry_all_candidates?: boolean;
}

/** Accept only the finite, value-free envelope emitted by the planner. This
 * prevents an accidental future caller from making raw capture/model content
 * part of either a durable counter or a terminal artifact. */
function safeCaptureInspectionNoProgressEpisode(value: unknown): CaptureInspectionNoProgressEpisode | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const recordingSessionId = typeof source.recording_session_id === 'string' ? source.recording_session_id : '';
  const captureStatus = source.capture_status === 'recording' || source.capture_status === 'stopped' ? source.capture_status : undefined;
  const eventCount = source.event_count === null ? null : (Number.isInteger(source.event_count) && Number(source.event_count) >= 0 ? Number(source.event_count) : undefined);
  const materialProgressCount = Number.isInteger(source.material_progress_count) && Number(source.material_progress_count) >= 0
    ? Number(source.material_progress_count) : undefined;
  const browserStateProgressCount = Number.isInteger(source.browser_state_progress_count) && Number(source.browser_state_progress_count) >= 0
    ? Number(source.browser_state_progress_count) : undefined;
  const nextClass = typeof source.required_next_action_class === 'string' && /^[a-z_]{1,96}$/.test(source.required_next_action_class)
    ? source.required_next_action_class : '';
  if (!recordingSessionId || !captureStatus || eventCount === undefined || materialProgressCount === undefined || browserStateProgressCount === undefined || !nextClass ||
      typeof source.semantic_candidate_available !== 'boolean') return undefined;
  const requiredPaths = Array.isArray(source.objective_completion_required_response_paths)
    ? [...new Set(source.objective_completion_required_response_paths.filter(path => typeof path === 'string' &&
      /^body\.[a-z0-9_.\[\]-]{1,500}$/i.test(path)))].slice(0, 24) : [];
  const candidateCount = Number.isInteger(source.objective_completion_candidate_count) &&
    Number(source.objective_completion_candidate_count) >= 0 ? Number(source.objective_completion_candidate_count) : undefined;
  const operationId = typeof source.objective_operation_id === 'string' && /^operation:[a-f0-9]{24}$/.test(source.objective_operation_id)
    ? source.objective_operation_id : undefined;
  const operationClass = typeof source.objective_operation_side_effect_class === 'string' &&
    ['authentication','update','add','create','transaction','write'].includes(source.objective_operation_side_effect_class)
    ? source.objective_operation_side_effect_class : undefined;
  const operationCount = Number.isInteger(source.objective_operation_candidate_count) &&
    Number(source.objective_operation_candidate_count) >= 0 ? Number(source.objective_operation_candidate_count) : undefined;
  const coverageCandidateCount = Number.isInteger(source.coverage_retry_candidate_count) &&
    Number(source.coverage_retry_candidate_count) >= 0 ? Number(source.coverage_retry_candidate_count) : undefined;
  const coverageAllCandidates = typeof source.coverage_retry_all_candidates === 'boolean'
    ? source.coverage_retry_all_candidates : undefined;
  const lastUnsuccessfulActionClass = typeof source.last_unsuccessful_action_class === 'string' &&
    /^(?:navigation|intent|action)_[a-z_]{1,48}$/.test(source.last_unsuccessful_action_class)
    ? source.last_unsuccessful_action_class : undefined;
  const navigationHints = Array.isArray(source.objective_navigation_hints)
    ? [...new Set(source.objective_navigation_hints.filter(value => typeof value === 'string' &&
      ['profile','cart','notes','settings','orders','checkout','search','home','authentication','other'].includes(value)))].slice(0, 4)
    : [];
  const requiredControlIntents = Array.isArray(source.objective_required_control_intents)
    ? [...new Set(source.objective_required_control_intents.filter(value => typeof value === 'string' &&
      ['add','review','confirm'].includes(value)))].slice(0, 3)
    : [];
  const sourceControlCounts = source.objective_eligible_current_control_counts;
  const eligibleCurrentControlCounts = sourceControlCounts && typeof sourceControlCounts === 'object'
    ? Object.fromEntries(requiredControlIntents.flatMap(intent => {
      const count = (sourceControlCounts as Record<string, unknown>)[intent];
      return Number.isInteger(count) && Number(count) >= 0 && Number(count) <= 100 ? [[intent, Number(count)]] : [];
    }))
    : {};
  const transactionProposalClass = typeof source.transaction_prerequisite_proposal_class === 'string' &&
    transactionPrerequisiteProposalClasses.has(source.transaction_prerequisite_proposal_class)
    ? source.transaction_prerequisite_proposal_class : undefined;
  return { recording_session_id: recordingSessionId, capture_status: captureStatus, event_count: eventCount,
    semantic_candidate_available: source.semantic_candidate_available, material_progress_count: materialProgressCount,
    browser_state_progress_count: browserStateProgressCount,
    required_next_action_class: nextClass,
    ...(lastUnsuccessfulActionClass ? {last_unsuccessful_action_class:lastUnsuccessfulActionClass}:{}),
    ...(navigationHints.length ? {objective_navigation_hints:navigationHints}:{}),
    ...(requiredControlIntents.length ? {objective_required_control_intents:requiredControlIntents}:{}),
    ...(Object.keys(eligibleCurrentControlCounts).length ? {objective_eligible_current_control_counts:eligibleCurrentControlCounts}:{}),
    ...(transactionProposalClass ? {transaction_prerequisite_proposal_class:transactionProposalClass}:{}),
    ...(requiredPaths.length ? {objective_completion_required_response_paths:requiredPaths}:{}),
    ...(candidateCount !== undefined ? {objective_completion_candidate_count:candidateCount}:{}),
    ...(operationId && operationClass ? {objective_operation_id:operationId,objective_operation_side_effect_class:operationClass}:{}),
    ...(operationCount !== undefined ? {objective_operation_candidate_count:operationCount}:{}),
    ...(coverageCandidateCount !== undefined ? {coverage_retry_candidate_count:coverageCandidateCount}:{}),
    ...(coverageAllCandidates !== undefined ? {coverage_retry_all_candidates:coverageAllCandidates}:{}), };
}

/** Persist the capture recovery envelope only after re-projecting it through
 * the runtime allowlist. Planner results can contain provider-owned fields;
 * no unrecognized rejection context may enter a durable receipt. */
function persistedRejectionContext(decision: AutonomousPlannerResult): Record<string, unknown> | undefined {
  if (decision.rejection_code !== NORMAL_CAPTURE_INSPECTION_NO_PROGRESS) return undefined;
  const episode = safeCaptureInspectionNoProgressEpisode(decision.rejection_context);
  return episode ? { ...episode } : undefined;
}

function sameCaptureInspectionNoProgressEpisode(left: CaptureInspectionNoProgressEpisode, right: CaptureInspectionNoProgressEpisode): boolean {
  return left.recording_session_id === right.recording_session_id &&
    // event_count is display/diagnostic information only. Background polling
    // can increase it without adding any semantic, strict-objective, or retry
    // candidate, so it must not reset the durable no-progress episode.
    left.capture_status === right.capture_status &&
    left.semantic_candidate_available === right.semantic_candidate_available &&
    left.browser_state_progress_count === right.browser_state_progress_count &&
    (left.objective_required_control_intents || []).join(',') === (right.objective_required_control_intents || []).join(',') &&
    left.objective_completion_candidate_count === right.objective_completion_candidate_count &&
    left.objective_operation_candidate_count === right.objective_operation_candidate_count &&
    left.coverage_retry_candidate_count === right.coverage_retry_candidate_count &&
    left.coverage_retry_all_candidates === right.coverage_retry_all_candidates;
}

interface NormalOnlyCompletionGap {
  flow_ids: string[];
  task_ids: string[];
}

interface NormalExperimentCompletionGap {
  required_objectives: number;
}

function hasVerifiedNormalBusinessFlow(flow: ReturnType<typeof latestBusinessFlows>[number]): boolean {
  return flow.status === 'verified' && flow.assertions_verified === true && Boolean(flow.workflow_id) &&
    Boolean(flow.normal_run_id) && sealedStrictObjectiveBindings(flow) &&
    Array.isArray(flow.evidence_artifact_ids) && flow.evidence_artifact_ids.length > 0;
}

/** The full normal-then-experiment lane has no useful successful terminal state
 * when its required normal objectives yielded no native-verified Flow.  Mixed
 * normal outcomes remain reviewable; this gate only rejects the zero-proof
 * case after every task has reached a terminal state. */
function normalExperimentCompletionGap(run: AIScanRun | null | undefined, tasks: AIScanTask[], flows: ReturnType<typeof latestBusinessFlows>): NormalExperimentCompletionGap | undefined {
  if (!run || !businessLearningAutoExperiments(run)) return undefined;
  const plan = tasks.find(task => task.execution_plan?.intent === BUSINESS_PLAN_INTENT);
  if (!plan || plan.execution_plan?.normal_objectives_required !== true) return undefined;
  if (flows.some(hasVerifiedNormalBusinessFlow)) return undefined;
  return { required_objectives: normalObjectiveManifestForTask(plan).length };
}

/**
 * A normal-only run is an acceptance stage, so a blocked or unfinished Flow
 * is a failed acceptance result even when its individual task has retained a
 * legitimate blocker record.  Ordinary full assessments deliberately keep
 * those Flow blockers visible while allowing unrelated verified work to
 * continue; this stricter terminal rule applies only to the bounded
 * normal-only mode.
 */
function normalOnlyCompletionGap(tasks: AIScanTask[], flows: ReturnType<typeof latestBusinessFlows>): NormalOnlyCompletionGap | undefined {
  const learningTasks = tasks.filter(task => task.execution_plan?.intent === BUSINESS_LEARNING_INTENT);
  const flowIds = new Set(flows.map(flow => flow.id));
  const incompleteFlows = flows.filter(flow => flow.status !== 'verified' || flow.assertions_verified !== true ||
    !flow.workflow_id || !flow.normal_run_id || !sealedStrictObjectiveBindings(flow) ||
    !Array.isArray(flow.evidence_artifact_ids) || flow.evidence_artifact_ids.length === 0)
    .map(flow => flow.id);
  const incompleteTasks = learningTasks.filter(task => task.status !== 'completed' || !flowIds.has(String(task.execution_plan?.flow_id || '')))
    .map(task => task.id);
  const flowsWithoutLearningTask = flows.filter(flow => !learningTasks.some(task => String(task.execution_plan?.flow_id || '') === flow.id))
    .map(flow => flow.id);
  const affectedFlows = [...new Set([...incompleteFlows, ...flowsWithoutLearningTask])];
  if (!affectedFlows.length && !incompleteTasks.length) return undefined;
  return { flow_ids: affectedFlows, task_ids: incompleteTasks };
}

export class AIScanAgentRuntime {
  private readonly registry = createAgentToolRegistry();
  private readonly repo: AIScanRepository;
  private readonly planner: AutonomousAgentPlanner;

  constructor(private readonly db: DbProvider) {
    this.repo = new AIScanRepository(db);
    this.planner = new AutonomousAgentPlanner(db);
  }

  getRepository(): AIScanRepository {
    return this.repo;
  }

  listTools(query = '') {
    return query.trim() ? this.registry.search(query) : this.registry.list();
  }

  async bootstrapRun(run: AIScanRun): Promise<void> {
    const tasks = await this.repo.listTasks(run.id);
    if (tasks.length > 0) {
      await ensureManualIdentityPreparation(this.repo, run);
      return;
    }
    const inventory = await this.repo.createTask({
      scan_run_id: run.id,
      title: '梳理 BSTG 原生能力并装载 Agent 驾驶层',
      task_type: 'autonomous_agent_task',
      priority: 5,
      agent_goal: '梳理模板、API test run、工作流、变量池、映射、提取器、学习、session、账号绑定、payload 字典、变异和校验能力，作为后续任务的原生执行底座。Agent 必须自己选择并调用合适工具。',
      execution_plan: { intent: 'inventory_bstg_capabilities' },
    });
    const isAndroidSurface = run.scan_config?.surface === 'android' || run.scan_config?.surface_type === 'android' || run.scan_config?.mobile?.platform === 'android' || run.scan_config?.android?.platform === 'android';
    const discover = await this.repo.createTask({
      scan_run_id: run.id,
      title: isAndroidSurface ? '自动连接 Android App 并导入移动端业务流量' : '自动理解目标并发现功能/接口',
      task_type: 'autonomous_agent_task',
      priority: 10,
      dependencies: [inventory.id],
      agent_goal: isAndroidSurface
        ? '连接预配置 Mobile Lab，启动 Android App，像 Playwright 一样通过 UIAutomator/ADB 观察和操作界面；确认 Burp HTTPS 明文抓包，导入 recording_events，生成 API/Workflow draft。'
        : '自动访问目标 URL，收集页面、表单、上传控件和接口观察，替代人工录制。Agent 需要自行决定先导航还是直接发现。',
      execution_plan: { intent: 'discover_target', surface: isAndroidSurface ? 'android' : 'web' },
    });
    let modelingDependencies = [discover.id];
    if (androidBusinessLearningEnabled(run)) {
      // Android stages consume only session-bound Appium/imported HTTPS assets
      // through android.business.* tools.  They deliberately do not call the
      // Web planner, capture, Playwright, or browser tool path.
      const plan = await this.repo.createTask({scan_run_id: run.id, task_type: 'plan_android_business_flows',
        title: '核验 Android 原生业务资产', priority: 18, dependencies: [discover.id],
        agent_goal: '只检查当前 Android Mobile Lab 会话已导入的、与设备会话绑定的解密 HTTPS 流量以及其原生 Workflow/Test Run。不得启动浏览器录制、Playwright 或 Web 业务工具。缺少设备会话或原生证据时明确阻塞。',
        execution_plan: {intent: ANDROID_BUSINESS_PLAN_INTENT, surface: 'android'}});
      const normal = await this.repo.createTask({scan_run_id: run.id, task_type: 'learn_android_business_flow',
        title: '核验 Android 正常业务原生回放', priority: 25, dependencies: [plan.id],
        agent_goal: '仅使用 Android 业务工具，将当前 Appium 会话已验证的解密 HTTPS 导入和已完成的原生 Test Run 作为正常业务证据。不得调用 Web 浏览器、Playwright 或 Web capture 工具。前置证据缺失时明确阻塞。',
        execution_plan: {intent: ANDROID_BUSINESS_LEARNING_INTENT, surface: 'android'}});
      modelingDependencies = [normal.id];
      if (!businessLearningOnly(run)) {
        const experiment = await this.repo.createTask({scan_run_id: run.id, task_type: 'model_android_business_experiment',
          title: '准备 Android 原生业务实验', priority: 35, dependencies: [normal.id],
          agent_goal: '只在当前 Android 会话已有正常业务验证收据后，确认可交给已有原生通用漏洞执行器的实验前置条件。不得调用 Web 浏览器、Playwright 或 Web capture 工具。',
          execution_plan: {intent: ANDROID_BUSINESS_EXPERIMENT_INTENT, surface: 'android'}});
        modelingDependencies = [experiment.id];
      }
    } else if (businessLearningEnabled(run)) {
      const normalObjectiveManifest = normalBusinessObjectiveManifest(run.scan_config || {});
      const automaticBusinessExperiments = businessLearningAutoExperiments(run);
      const strictNormalObjectives = businessLearningOnly(run) || automaticBusinessExperiments || run.scan_config?.business_learning?.strict_normal_objectives === true;
      const plan = await this.repo.createTask({scan_run_id: run.id, task_type: 'plan_business_flows',
        title: '建立可验证的正常业务流程计划', priority: 18, dependencies: [discover.id],
        agent_goal: '从实际页面、导航、表单及观察中梳理全部可达正常业务。先用 bstg.business.coverage.inspect 读取每个已发现可操作 feature/operation；逐项定义可验证的业务目标、起始状态、身份和前提，或记录明确的 deferred/blocked 原因。用 bstg.business.flow.define 保存 planned flow，并用 bstg.business.coverage.save 保存覆盖清单。登录只是可能的业务之一，不限定业务类别。不要把接口名猜测当成成功流程，也不要只因已有 flow 就结束规划。',
        execution_plan: {intent: BUSINESS_PLAN_INTENT, requires_identity_context: true,
          normal_objective_manifest: normalObjectiveManifest,
          strict_normal_objectives: strictNormalObjectives && normalObjectiveManifest.length > 0,
          normal_objectives_required: automaticBusinessExperiments}});
      const review = await this.repo.createTask({scan_run_id: run.id, task_type: 'review_business_flows',
        title: '核对正常业务与原生验证结果', priority: 35, dependencies: [plan.id],
        agent_goal: '检查每个正式业务流程的真实正常执行、断言和原生 Test Run。验证失败时基于结果创建明确的正常流程修复子任务；保留无法完成的原因，不把缺失证据视为验证成功。',
        execution_plan: {intent: BUSINESS_REVIEW_INTENT}});
      modelingDependencies = [review.id];
    }
    if (!businessLearningOnly(run)) {
      await this.repo.createTask({
        scan_run_id: run.id,
        title: '生成功能树和漏洞候选',
        task_type: 'autonomous_agent_task',
        priority: 20,
        dependencies: modelingDependencies,
        agent_goal: '基于自动发现的 endpoint 和页面语义，归纳功能/子功能，并生成用户可选择的大类漏洞列表。若用户已选择漏洞类型，继续展开持久化测试任务；否则等待用户选择。',
        execution_plan: { intent: 'model_features_and_candidates' },
      });
    }
    await ensureManualIdentityPreparation(this.repo, run);
  }

  async expandSelectedVulnerabilities(scanRunId: string, selectedVulnTypes: string[]): Promise<void> {
    return withScanControl(scanRunId, async () => {
      await this.expandSelectedVulnerabilitiesActive(scanRunId, selectedVulnTypes);
      if (scanPolicyDenial()) {
        await this.persistPolicyDenial(scanRunId);
        assertScanActive();
      }
    });
  }

  private async expandSelectedVulnerabilitiesActive(scanRunId: string, selectedVulnTypes: string[]): Promise<void> {
    const run = await this.repo.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
    if (['failed', 'completed'].includes(run.status)) throw new Error('本轮已经结束，请新建重试记录。');
    await this.repo.updateRun(scanRunId, {
      selected_vuln_types: selectedVulnTypes,
      status: 'planning',
      current_phase: 'expanding_selected_vulnerabilities',
    });
    const task = await this.repo.createTask({
      scan_run_id: scanRunId,
      title: '根据用户选择的漏洞类型自主展开可执行任务',
      task_type: 'autonomous_agent_task',
      priority: 25,
      agent_goal: '根据 selected_vuln_types、候选漏洞、功能树和 endpoint 上下文，自主调用任务展开工具，生成持久化漏洞测试任务。',
      execution_plan: { intent: 'expand_selected_vulnerabilities', selected_vuln_types: selectedVulnTypes },
    });
    const preparation = await ensureManualIdentityPreparation(this.repo, run);
    if (!preparation || preparation.status === 'completed') await this.executeTask(task);
  }

  async run(scanRunId: string, options: AgentRunOptions = {}): Promise<AgentRunResult> {
    return withScanControl(scanRunId, () => this.runActive(scanRunId, options));
  }

  private async runActive(scanRunId: string, options: AgentRunOptions): Promise<AgentRunResult> {
    // Validate direct callers as strictly as the HTTP entry point, before mutations.
    const budget = new RunDecisionBudget(options.max_steps);
    const run = await this.repo.getRun(scanRunId);
    if (!run) throw new Error(`AI scan run not found: ${scanRunId}`);
    if (['failed', 'completed'].includes(run.status)) throw new Error('本轮已经结束，请新建重试记录。');
    await this.bootstrapRun(run);

    const configuredParallel = Number(options.max_parallel_agents ?? run.scan_config?.max_parallel_agents ?? 1);
    const maxParallelAgents = Math.max(1, Math.min(32, Number.isFinite(configuredParallel) ? configuredParallel : 1));
    if (maxParallelAgents > 1) {
      return this.runParallel(scanRunId, { ...options, max_parallel_agents: maxParallelAgents }, budget);
    }

    let lastTask: AIScanTask | undefined;

    await this.repo.updateRun(scanRunId, { status: 'running', current_phase: 'autonomous_agent_loop' });

    while (budget.remaining > 0) {
      if (scanPolicyDenial()) break;
      await blockFailedDependencies(this.repo, scanRunId);
      const task = await this.repo.findNextPendingTask(scanRunId);
      if (!task) break;
      lastTask = task;
      await this.repo.createArtifact({
        scan_run_id: scanRunId,
        task_id: task.id,
        artifact_type: 'subagent_spawned',
        title: `Single Agent worker executing ${task.title}`,
        content_json: { mode: 'single', task_id: task.id, worker_id: 'agent-1' },
      });
      const used = await this.executeTask(task, budget);
      if (used <= 0) break;
    }

    return this.finishRun(scanRunId, budget, lastTask, 1, 0);
  }

  private async runParallel(scanRunId: string, options: AgentRunOptions, budget: RunDecisionBudget): Promise<AgentRunResult> {
    let batchesExecuted = 0;
    let lastTask: AIScanTask | undefined;
    const maxParallelAgents = Math.max(1, Math.min(32, Number(options.max_parallel_agents || 4)));

    await this.repo.updateRun(scanRunId, {
      status: 'running',
      current_phase: 'parallel_autonomous_agent_loop',
      summary: { max_parallel_agents: maxParallelAgents },
    });

    while (budget.remaining > 0) {
      if (scanPolicyDenial()) break;
      await blockFailedDependencies(this.repo, scanRunId);
      const claimed = await this.repo.claimRunnableTasks(scanRunId, Math.min(maxParallelAgents, budget.remaining), `agent-batch-${batchesExecuted + 1}`);
      if (claimed.length === 0) break;
      batchesExecuted += 1;
      lastTask = claimed[claimed.length - 1];
      const batchId = `parallel-batch-${batchesExecuted}`;
      await this.repo.createArtifact({
        scan_run_id: scanRunId,
        artifact_type: 'parallel_agent_batch_started',
        title: `Parallel Agent batch ${batchesExecuted}`,
        content_json: {
          batch_id: batchId,
          max_parallel_agents: maxParallelAgents,
          task_ids: claimed.map(task => task.id),
          task_titles: claimed.map(task => task.title),
          vuln_types: claimed.map(task => task.vuln_type).filter(Boolean),
        },
      });
      for (const task of claimed) {
        await this.repo.createArtifact({
          scan_run_id: scanRunId,
          task_id: task.id,
          artifact_type: 'subagent_spawned',
          title: `Sub-Agent spawned for ${task.title}`,
          content_json: {
            batch_id: batchId,
            task_id: task.id,
            worker_id: task.execution_plan?.agent_worker_id || 'agent-worker',
            vuln_type: task.vuln_type,
            browser_context_id: `browser-${task.id}`,
            endpoint_ids: task.endpoint_ids,
          },
        });
      }
      const usedBeforeBatch = budget.used;
      const results = await Promise.allSettled(claimed.map(task => this.executeTask(task, budget)));
      // Reservations remain authoritative even if a worker rejects during cleanup.
      const used = budget.used - usedBeforeBatch;
      await this.repo.createArtifact({
        scan_run_id: scanRunId,
        artifact_type: 'parallel_agent_batch_completed',
        title: `Parallel Agent batch ${batchesExecuted} completed`,
        content_json: {
          batch_id: batchId,
          steps_used: used,
          results: results.map((result, index) => ({
            task_id: claimed[index]?.id,
            status: result.status,
            steps: result.status === 'fulfilled' ? result.value : undefined,
            error: result.status === 'rejected' ? String(result.reason?.message || result.reason) : undefined,
          })),
        },
      });
      const freshRun = await this.repo.getRun(scanRunId);
      if (freshRun?.status === 'awaiting_selection') break;
      if (used <= 0) break;
    }

    return this.finishRun(scanRunId, budget, lastTask, maxParallelAgents, batchesExecuted);
  }

  private async finishRun(scanRunId: string, budget: RunDecisionBudget, lastTask: AIScanTask | undefined, parallelAgents: number, batchesExecuted: number): Promise<AgentRunResult> {
    if (scanPolicyDenial()) await this.persistPolicyDenial(scanRunId);
    const freshRun = await this.repo.getRun(scanRunId);
    let tasks = await this.repo.listTasks(scanRunId);
    const normalOnly = Boolean(freshRun && businessLearningOnly(freshRun));
    let blockedWaitingSelection = tasks.some(task => task.status === 'waiting_selection') || freshRun?.status === 'awaiting_selection';
    let normalOnlySelectionRejected = false;
    // A normal-only acceptance has no vulnerability-selection handoff.  Older
    // queued decisions or a malformed provider response must therefore end
    // this run explicitly instead of leaving a non-terminal
    // awaiting_selection state for the acceptance harness to poll forever.
    if (normalOnly && blockedWaitingSelection) {
      const reason = 'A normal-only business-learning run cannot wait for vulnerability selection.';
      for (const task of tasks.filter(item => ['pending', 'running', 'waiting_selection'].includes(item.status))) {
        await this.repo.updateTask(task.id, {
          status: 'failed', phase: 'normal_only_selection_not_allowed',
          result_summary: reason, error_message: reason, completed_at: now(),
        });
      }
      tasks = await this.repo.listTasks(scanRunId);
      blockedWaitingSelection = false;
      normalOnlySelectionRejected = true;
    }
    const runBudgetExhausted = budget.remaining === 0 && !blockedWaitingSelection && (
      tasks.some(task => ['pending', 'running'].includes(task.status)) || tasks.some(task => task.phase === 'run_step_limit_exceeded')
    );
    // The managed worker exits after this method: pending work cannot be left
    // displaying a running scan with no live owner. Preserve unstarted work as
    // blocked, retain all evidence, and require an independent retry record.
    if (runBudgetExhausted) {
      for (const task of tasks.filter(item => ['pending', 'running'].includes(item.status))) {
        await this.repo.updateTask(task.id, {
          status: task.status === 'pending' ? 'blocked' : 'failed',
          phase: 'run_step_limit_exceeded',
          error_message: `Run decision limit of ${budget.limit} exhausted before remaining work completed`,
          completed_at: now(),
        });
      }
      tasks = await this.repo.listTasks(scanRunId);
    }
    if (!blockedWaitingSelection && !runBudgetExhausted) tasks = await blockFailedDependencies(this.repo, scanRunId);
    // Reviews normally remain runnable after an ordinary failed/blocked normal
    // Flow so they can aggregate verified sibling evidence. Only a planning
    // task which could not persist *any* planner receipt or tool invocation is
    // different: its provider exhaustion leaves no evidence for that review,
    // and the managed worker has already stopped. A later provider outage must
    // preserve the normal review path so it can assess the retained evidence.
    const providerBlockedBusinessPlans = tasks.filter(task =>
      task.execution_plan?.intent === BUSINESS_PLAN_INTENT && task.status === 'blocked' &&
      task.phase === 'provider_temporarily_unavailable',
    );
    const providerBlockedBeforeEvidence = providerBlockedBusinessPlans.length > 0 && (
      await Promise.all(providerBlockedBusinessPlans.map(async task => {
        const [decisions, invocations] = await Promise.all([
          this.repo.listPlannerDecisions(scanRunId, task.id),
          this.repo.listToolInvocations(scanRunId, task.id),
        ]);
        return decisions.length === 0 && invocations.length === 0;
      }))
    ).every(Boolean);
    if (providerBlockedBeforeEvidence && !blockedWaitingSelection && !runBudgetExhausted) {
      const reason = 'Normal-business planning could not obtain a model decision after bounded retries; remaining work was not started.';
      for (const task of tasks.filter(item => ['pending', 'running'].includes(item.status))) {
        await this.repo.updateTask(task.id, {
          status: task.status === 'pending' ? 'blocked' : 'failed',
          phase: 'provider_dependency_unavailable',
          error_message: reason,
          completed_at: now(),
        });
      }
      tasks = await this.repo.listTasks(scanRunId);
    }
    const pending = tasks.filter(task => task.status === 'pending');
    const running = tasks.filter(task => task.status === 'running');
    const runnablePending = pending.length > 0 ? await this.repo.findRunnablePendingTasks(scanRunId, pending.length) : [];
    const deadlockedPending = pending.length > 0 && runnablePending.length === 0 && running.length === 0;
    if (deadlockedPending && !blockedWaitingSelection) {
      const byId = new Map(tasks.map(task => [task.id, task]));
      for (const task of pending) {
        const unresolved = task.dependencies.map(id => `${id} (${byId.get(id)?.status || 'missing'})`);
        await this.repo.updateTask(task.id, {
          status: 'blocked',
          phase: 'dependency_deadlock',
          error_message: `Task cannot run because its dependency graph cannot progress: ${unresolved.join(', ')}`,
          completed_at: now(),
        });
      }
      tasks = await this.repo.listTasks(scanRunId);
    }
    const runnableRemaining = tasks.some(task => ['pending', 'running'].includes(task.status));
    const terminalFlows = !runnableRemaining ? latestBusinessFlows(await this.repo.listArtifacts(scanRunId)) : [];
    const normalOnlyGap = normalOnly && !runnableRemaining
      ? normalOnlyCompletionGap(tasks, terminalFlows)
      : undefined;
    const normalExperimentGap = !runnableRemaining
      ? normalExperimentCompletionGap(freshRun, tasks, terminalFlows)
      : undefined;
    const failed = tasks.some(task => task.status === 'failed' || (task.status === 'blocked' && ['dependency_failed', 'dependency_deadlock', 'identity_required', 'provider_temporarily_unavailable'].includes(task.phase || ''))) ||
      deadlockedPending || runBudgetExhausted || normalOnlySelectionRejected || Boolean(normalOnlyGap) || Boolean(normalExperimentGap);

    if ((!runnableRemaining || deadlockedPending) && !blockedWaitingSelection) {
      const browserContextsClosed = await closePersistentBrowserContextsForScan(this.repo, scanRunId, 'closed').catch(() => 0);
      await this.repo.updateRun(scanRunId, {
        status: failed ? 'failed' : 'completed',
        current_phase: providerBlockedBeforeEvidence ? 'provider_temporarily_unavailable'
          : runBudgetExhausted ? 'run_step_limit_exceeded'
          : normalOnlySelectionRejected ? 'normal_only_selection_not_allowed'
          : normalOnlyGap ? 'normal_only_incomplete'
          : normalExperimentGap ? 'normal_business_objectives_unverified'
          : failed ? 'failed' : 'completed',
        summary: {
          ...(freshRun?.summary || {}),
          run_decision_limit: budget.limit,
          decisions_used: budget.used,
          ...(runBudgetExhausted ? { execution_error: `Run decision limit of ${budget.limit} exhausted; retry in a new record.` } : {}),
          ...(normalOnlyGap ? {
            normal_only_incomplete_flows: normalOnlyGap.flow_ids.length,
            normal_only_incomplete_tasks: normalOnlyGap.task_ids.length,
          } : {}),
          ...(providerBlockedBeforeEvidence ? { provider_planning_unavailable: true } : {}),
          ...(normalExperimentGap ? {
            normal_business_objectives_unverified: true,
            normal_business_objectives_required: normalExperimentGap.required_objectives,
          } : {}),
          tasks_total: tasks.length,
          tasks_completed: tasks.filter(task => task.status === 'completed').length,
          tasks_failed: tasks.filter(task => task.status === 'failed').length,
          tasks_blocked: tasks.filter(task => task.status === 'blocked').length,
          deadlocked_pending_tasks: deadlockedPending ? pending.map(task => ({ id: task.id, title: task.title, dependencies: task.dependencies })) : [],
          parallel_agents: parallelAgents,
          parallel_batches: batchesExecuted,
          persistent_browser_contexts_closed: browserContextsClosed,
        },
      });
    }

    return {
      scan_run_id: scanRunId,
      steps_executed: budget.used,
      completed: (!runnableRemaining || deadlockedPending) && !blockedWaitingSelection,
      blocked_waiting_selection: blockedWaitingSelection,
      last_task: lastTask,
      parallel_agents: parallelAgents,
      batches_executed: batchesExecuted,
      snapshot: await this.repo.getSnapshot(scanRunId),
    };
  }

  private async persistPolicyDenial(scanRunId: string): Promise<void> {
    const denial = scanPolicyDenial();
    if (!denial) return;
    const run = await this.repo.getRun(scanRunId);
    for (const task of await this.repo.listTasks(scanRunId)) {
      if (['pending', 'running', 'waiting_selection'].includes(task.status)) {
        await this.repo.updateTask(task.id, { status: 'failed', phase: 'provider_policy_denied',
          error_message: POLICY_DENIAL_MESSAGE, completed_at: now() });
      }
    }
    if (!run?.summary?.provider_policy_denial) {
      await this.repo.createArtifact({ scan_run_id: scanRunId, artifact_type: 'provider_policy_denial',
        title: 'Provider denied this run', content_json: denial });
    }
    await this.repo.updateRun(scanRunId, { status: 'failed', current_phase: 'provider_policy_denied',
      summary: { ...run?.summary, provider_policy_denial: denial, execution_error: POLICY_DENIAL_MESSAGE } });
  }

  private async recordDecision(task: AIScanTask, audit: Record<string, unknown>): Promise<void> {
    await this.repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'agent_decision',
      title: `Agent decision: ${String(audit.action || 'unknown')}${audit.tool_name ? `:${String(audit.tool_name)}` : ''}`,
      content_json: audit,
    });
  }

  /** Settle a normal learning Flow only from its persisted server evidence.
   * This is deliberately separate from the model's free-form task action: a
   * Flow block may be produced by capture teardown or by the dedicated tool. */
  private async settleBusinessLearningTerminal(task: AIScanTask): Promise<'blocked' | 'failed' | undefined> {
    if (task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT) return undefined;
    const artifacts = await this.repo.listArtifacts(task.scan_run_id);
    const terminal = businessLearningTerminalDisposition(task, artifacts);
    if (!terminal) return undefined;
    if (terminal.kind === 'blocked') {
      await this.repo.updateTask(task.id, {
        status: 'blocked', phase: 'normal_flow_blocked_with_evidence',
        result_summary: terminal.reason, error_message: terminal.reason, completed_at: now(),
      });
    } else {
      await this.repo.updateTask(task.id, {
        status: 'failed', phase: 'normal_flow_block_without_evidence',
        result_summary: terminal.reason, error_message: terminal.reason, completed_at: now(),
      });
    }
    await this.rememberTaskOutcome(task.id);
    return terminal.kind;
  }

  /**
   * A native validation may make the Flow fully provable in the final model
   * turn.  The next operation must be local reconciliation, not an extra
   * provider turn: task/run budgets limit model decisions, never the server's
   * ability to persist the terminal result of the decision that just ran.
   *
   * This is intentionally used only at a decision-budget boundary.  While a
   * model turn remains available, the Agent retains control of whether to
   * inspect, adapt, or deliberately finish the current learning task.
   */
  private async settleBusinessLearningAtBudgetBoundary(task: AIScanTask): Promise<boolean> {
    if (task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT) return false;
    if (await this.settleBusinessLearningTerminal(task)) return true;

    const artifacts = await this.repo.listArtifacts(task.scan_run_id);
    const flows = latestBusinessFlows(artifacts);
    const gap = await businessCompletionGap(this.repo, task, flows, artifacts, this.db);
    if (gap) {
      const retryTargetGap = coverageRetryTargetBindingGap(task, flows, artifacts);
      if (retryTargetGap) {
        await this.repo.updateTask(task.id, {
          status: 'failed',
          phase: 'coverage_retry_target_not_reached_before_budget_exhaustion',
          result_summary: retryTargetGap,
          error_message: 'The coverage-retry task exhausted its bounded decision allowance without a fresh task-scoped native validation for every scheduled target.',
          completed_at: now(),
        });
        await this.rememberTaskOutcome(task.id);
        return true;
      }
      const coverageRetry = await scheduleBusinessCoverageRetry(this.repo, task, flows, artifacts);
      if (!coverageRetry) return false;
      await this.repo.updateTask(task.id, {
        status: 'completed',
        phase: 'coverage_retry_scheduled',
        result_summary: `The current native evidence did not exercise every planned target. Fresh retry task ${coverageRetry.id} was scheduled with the persisted missing target references.`,
        completed_at: now(),
      });
      await this.rememberTaskOutcome(task.id);
      return true;
    }

    await this.repo.updateTask(task.id, {
      status: 'completed',
      phase: 'completed',
      result_summary: 'The final native validation satisfies the current normal business Flow.',
      completed_at: now(),
    });
    await this.rememberTaskOutcome(task.id);
    return true;
  }

  /**
   * A successful native normal validation is already the authoritative fact
   * needed to settle a learning task. Do not wait for the provider to spend a
   * later turn repeating a completion claim before checking that fact. This
   * helper deliberately reconciles only server-owned completion state: the
   * model still owns browser actions, selected capture events, mappings, and
   * semantic assertions.
   *
  * Returns true when the task became terminal. A false return leaves a
  * recoverable evidence gap in place for the next bounded turn.
  */
  private async hasTaskScopedVerifiedNormalValidation(task: AIScanTask, validation: {
    workflow_id?: unknown;
    test_run_id?: unknown;
  } | undefined, artifacts?: any[]): Promise<boolean> {
    const flowId=String(task.execution_plan?.flow_id||'');
    const workflowId=String(validation?.workflow_id||'');
    const testRunId=String(validation?.test_run_id||'');
    if(!flowId||!workflowId||!testRunId)return false;
    const evidence=artifacts||await this.repo.listArtifacts(task.scan_run_id);
    const artifact=evidence.find(item=>item.artifact_type==='business_workflow_validation'&&item.task_id===task.id&&
      String(item.source_ref||'')===testRunId&&String(item.content_json?.flow_id||'')===flowId&&
      String(item.content_json?.workflow_id||'')===workflowId&&String(item.content_json?.test_run_id||'')===testRunId&&
      item.content_json?.assertions_verified===true);
    if(!artifact)return false;
    const flow=await getBusinessFlow(this.repo,task.scan_run_id,flowId).catch(()=>undefined);
    const operationReceipt=flow?.objective_operation_binding;
    if(!flow || flow.status!=='verified' || flow.workflow_id!==workflowId || flow.normal_run_id!==testRunId || !sealedStrictObjectiveBindings(flow) ||
      (flow.objective_operation && operationReceipt?.validation_artifact_id!==artifact.id)) return false;
    const testRun=await this.db.repos.testRuns.findById(testRunId);
    const params=testRun?.execution_params||{};
    return Boolean(testRun&&testRun.workflow_id===workflowId&&testRun.status==='completed'&&testRun.has_execution_error!==true&&
      String(params.scan_run_id||'')===task.scan_run_id&&String(params.ai_scan_task_id||'')===task.id&&
      String(params.flow_id||'')===flowId&&params.business_normal_run===true);
  }

  private async assertionRevisionAttempts(task: AIScanTask, workflowId: string): Promise<number> {
    const invocations=await this.repo.listToolInvocations(task.scan_run_id,task.id);
    return invocations.filter(invocation=>invocation.tool_name==='bstg.business.workflow.validate'&&
      invocation.output_json?.status==='assertion_revision_required'&&
      (!workflowId||String(invocation.input_json?.workflow_id||'')===workflowId)).length;
  }

  private async workflowStepBindingMismatchAttempts(task: AIScanTask): Promise<number> {
    const invocations = await this.repo.listToolInvocations(task.scan_run_id, task.id);
    return invocations.filter(invocation => invocation.tool_name === 'bstg.test_plan.create' &&
      invocation.output_json?.status === 'workflow_step_binding_mismatch').length;
  }

  private async businessExperimentCompileFailureAttempts(task: AIScanTask): Promise<number> {
    const invocations = await this.repo.listToolInvocations(task.scan_run_id, task.id);
    return invocations.filter(invocation => invocation.tool_name === 'bstg.test_plan.compile' &&
      invocation.status === 'failed' && ['experiment_compile_requires_revision', 'experiment_compile_failed'].includes(String(invocation.output_json?.status || ''))).length;
  }

  private async normalEvidenceSelectionAttempts(task: AIScanTask): Promise<number> {
    const invocations=await this.repo.listToolInvocations(task.scan_run_id,task.id);
    return invocations.filter(invocation=>{
      if(!['bstg.business.capture.stop','bstg.business.workflow.prepare'].includes(invocation.tool_name))return false;
      const output=invocation.output_json&&typeof invocation.output_json==='object'?invocation.output_json:{};
      const data=output.data&&typeof output.data==='object'?output.data:output;
      // These are bounded, model-owned event-selection corrections. In
      // particular, a transaction prerequisite or replay eligibility gap must
      // not become a silent server-side event substitution or an unbounded
      // prepare loop.
      // Tool invocations are persisted before this count is read, which keeps
      // the limit intact across runtime/context refreshes.
      return ['semantic_body_candidate_required','objective_completion_candidate_required','objective_operation_candidate_required','workflow_eligible_event_selection_required','transaction_prerequisite_event_selection_required'].includes(String(data.status||''))&&data.retryable===true;
    }).length;
  }

  /** Count a browser result which crossed the dispatch boundary but could not
   * complete its post-action observation. `action_performed` may be absent
   * when Playwright cannot distinguish a dispatched navigation from a lost
   * observation; absence is deliberately treated as potentially dispatched. */
  private async postActionCaptureRecoveryAttempts(task: AIScanTask): Promise<number> {
    const invocations = await this.repo.listToolInvocations(task.scan_run_id, task.id);
    return invocations.filter(invocation => invocation.tool_name === 'browser.interact' &&
      invocation.output_json?.failure_phase === 'action_or_after' &&
      invocation.output_json?.action_performed !== false).length;
  }

  /** A rejected replay never reaches Chromium, but the model could keep
   * proposing it. Bound those persisted no-dispatch rejections separately
   * from potentially-dispatched actions so the latter are never retried. */
  private async postActionReplayBlockedAttempts(task: AIScanTask): Promise<number> {
    const invocations = await this.repo.listToolInvocations(task.scan_run_id, task.id);
    return invocations.filter(invocation => invocation.tool_name === 'browser.interact' &&
      invocation.output_json?.error_code === 'post_action_replay_blocked').length;
  }

  /** The source of truth is persisted planner receipts, so an application
   * restart cannot turn a repeated rejected inspection into a fresh episode. */
  private async captureInspectionNoProgressAttempts(task: AIScanTask,
    episode: CaptureInspectionNoProgressEpisode): Promise<number> {
    const decisions = await this.repo.listPlannerDecisions(task.scan_run_id, task.id);
    return decisions.filter(decision => {
      if (decision.validation_status !== 'rejected' ||
          decision.policy_json?.rejection_code !== NORMAL_CAPTURE_INSPECTION_NO_PROGRESS) return false;
      const prior = safeCaptureInspectionNoProgressEpisode(decision.policy_json?.rejection_context);
      return prior !== undefined && sameCaptureInspectionNoProgressEpisode(prior, episode);
    }).length;
  }

  private async reconcileBusinessLearningCompletion(task: AIScanTask, completionSummary: string, validation?: {
    workflow_id?: unknown;
    test_run_id?: unknown;
  }): Promise<boolean> {
    const businessArtifacts = await this.repo.listArtifacts(task.scan_run_id);
    const flows = latestBusinessFlows(businessArtifacts);
    const businessGap = await businessCompletionGap(this.repo, task, flows, businessArtifacts, this.db);
    if (businessGap) {
      const retryTargetGap = coverageRetryTargetBindingGap(task, flows, businessArtifacts);
      if (retryTargetGap) {
        // A generic complete_task proposal cannot turn a structurally rejected
        // assertion into a new recording. The one recovery capture is allowed
        // only after this exact retry task has persisted a verified native
        // validation that still proves the wrong coverage edge.
        if (!await this.hasTaskScopedVerifiedNormalValidation(task, validation, businessArtifacts)) {
          await this.repo.createArtifact({scan_run_id: task.scan_run_id, task_id: task.id,
            artifact_type: 'business_completion_gap', title: 'Normal business completion requires fresh retry evidence',
            content_json: {flow_id: task.execution_plan?.flow_id, intent: task.execution_plan?.intent, verified: false,
              reason: retryTargetGap, requires_fresh_task_scoped_native_validation: true}});
          await this.repo.updateTask(task.id, {phase: 'business_completion_requires_evidence', result_summary: retryTargetGap});
          return false;
        }
        const recovery = task.execution_plan?.coverage_retry?.completion_recovery;
        if (recovery?.status === 'capture_started') {
          await this.repo.updateTask(task.id, {
            status: 'failed', phase: 'coverage_retry_target_not_reached_after_recovery',
            result_summary: retryTargetGap,
            error_message: 'The one bounded fresh task-scoped recovery capture completed without proving every scheduled coverage-retry target.',
            completed_at: now(),
          });
          await this.rememberTaskOutcome(task.id);
          return true;
        }
        if (recovery?.status !== 'capture_required') {
          const targets = Array.isArray(task.execution_plan?.coverage_retry?.targets)
            ? task.execution_plan.coverage_retry.targets.map((target: any) => String(target?.key || '')).filter(Boolean) : [];
          await this.repo.updateTask(task.id, {
            phase: COVERAGE_RETRY_COMPLETION_RECOVERY_PHASE,
            result_summary: `${retryTargetGap} A fresh task-scoped capture is now required before task completion.`,
            execution_plan: { ...task.execution_plan, coverage_retry: {
              ...task.execution_plan?.coverage_retry,
              completion_recovery: { attempt: 1, status: 'capture_required', target_keys: targets, reason: retryTargetGap },
            } },
          });
        }
        return false;
      }
      const coverageRetry = await scheduleBusinessCoverageRetry(this.repo, task, flows, businessArtifacts);
      if (coverageRetry) {
        await this.repo.updateTask(task.id, {
          status: 'completed', phase: 'coverage_retry_scheduled',
          result_summary: `The current native evidence did not exercise every planned target. Fresh retry task ${coverageRetry.id} was scheduled with the persisted missing target references.`,
          completed_at: now(),
        });
        await this.rememberTaskOutcome(task.id);
        return true;
      }
      await this.repo.createArtifact({scan_run_id: task.scan_run_id, task_id: task.id,
        artifact_type: 'business_completion_gap', title: 'Normal business completion requires evidence',
        content_json: {flow_id: task.execution_plan?.flow_id, intent: task.execution_plan?.intent, verified: false, reason: businessGap}});
      await this.repo.updateTask(task.id, {phase: 'business_completion_requires_evidence', result_summary: businessGap});
      return false;
    }

    await this.repo.updateTask(task.id, {
      status: 'completed', phase: 'completed', result_summary: completionSummary, completed_at: now(),
    });
    await this.rememberTaskOutcome(task.id);
    return true;
  }

  private async rememberTaskOutcome(taskId: string): Promise<void> {
    const completedTask = await this.repo.getTask(taskId);
    if (!completedTask || !['completed', 'failed', 'blocked', 'waiting_selection'].includes(completedTask.status)) return;
    await rememberAgentObservation({
      repo: this.repo,
      scanRunId: completedTask.scan_run_id,
      taskId: completedTask.id,
      memoryType: 'task_outcome',
      memoryKey: completedTask.id,
      scopeType: 'task',
      scopeRef: completedTask.id,
      title: completedTask.title,
      summary: completedTask.result_summary || completedTask.error_message || `${completedTask.status}:${completedTask.phase || ''}`,
      content: { task_type: completedTask.task_type, vuln_type: completedTask.vuln_type, feature_id: completedTask.feature_id, endpoint_ids: completedTask.endpoint_ids, status: completedTask.status, phase: completedTask.phase },
      confidence: completedTask.status === 'completed' ? 0.9 : completedTask.status === 'waiting_selection' ? 0.75 : 0.65,
      provenance: { source: 'agent_runtime_task_terminal_state' },
    });
  }

  private async executeTask(task: AIScanTask, runBudget?: RunDecisionBudget): Promise<number> {
    const run = await this.repo.getRun(task.scan_run_id);
    const maxIterations = taskDecisionLimit(task, run?.scan_config);
    const maxTransientProviderRetries = transientProviderTurnRetryLimit(run?.scan_config || {});
    // Preserve this bounded recovery receipt across a task restart. Otherwise
    // a restart between the rejected plan and its read-only refresh could
    // erase the one-reinspection budget and permit another forced refresh.
    const preserveExperimentRecoveryPhase = task.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT &&
      ['experiment_workflow_step_binding_requires_inspection', 'experiment_workflow_step_binding_reinspection_completed',
        'experiment_compile_requires_inspection', 'experiment_compile_reinspection_completed'].includes(task.phase || '');
    await this.repo.updateTask(task.id, { status: 'running', started_at: now(),
      phase: preserveExperimentRecoveryPhase ? task.phase : 'autonomous_running' });
    let iterations = 0;
    let selectorCorrections = 0; // Consecutive correction episode, within the task/run decision budgets.
    try {
      await this.repo.createArtifact({
        scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'agent_task_budget',
        title: 'Bounded task decision allowance',
        content_json: { task_decision_limit: maxIterations, run_decision_limit: runBudget?.limit, run_remaining_at_start: runBudget?.remaining },
      });
      while (iterations < maxIterations) {
        assertScanActive();
        const current = await this.repo.getTask(task.id);
        if (!current) throw new Error(`AI scan task disappeared: ${task.id}`);
        // A persisted blocker is server-authoritative and requires no further
        // model decision.  Check it before reserving a scarce task/run slot.
        if (await this.settleBusinessLearningTerminal(current)) return iterations;
        if (runBudget && !runBudget.take()) break;
        const allTools = this.registry.list();
        const modelScope = buildModelContextScope({ task: current, scanConfig: run?.scan_config, tools: allTools });
        const canonicalContext = await buildAutonomousAgentContext({
          repo: this.repo,
          scanRunId: current.scan_run_id,
          task: current,
          tools: selectModelVisibleTools(allTools, modelScope.stage),
        });
        const context = projectContextForModel(canonicalContext, modelScope);
        context.task.decision_budget = {
          limit: maxIterations,
          used: iterations,
          // Includes the current reserved decision but not a failed provider
          // attempt. A decision is consumed only after the planner returns it.
          remaining: Math.min(maxIterations - iterations, runBudget ? runBudget.remaining + 1 : maxIterations - iterations),
        };
        // The recovery is a server-owned environment action. It deliberately
        // does not make a browser/event/assertion choice, and it prevents a
        // verified-but-wrong retry Flow from spending another provider turn on
        // complete_task before a new task-scoped capture exists.
        let decision: AutonomousPlannerResult;
        let transientProviderRetries = 0;
        while (true) {
          try {
            decision = coverageRetryCompletionRecoveryRequired(context)
              ? localPolicy(context)
              : await this.planner.decide(context);
            break;
          } catch (error) {
            if (!(error instanceof AgentProviderDecisionUnavailableError)) throw error;
            // This provider path always fails before a decision or tool call.
            // Return its current reservation both before a retry and before
            // terminal propagation so the shared run budget has no phantom use.
            if (runBudget) runBudget.release();
            if (transientProviderRetries >= maxTransientProviderRetries) throw error;
            transientProviderRetries += 1;
            await this.repo.createArtifact({ scan_run_id: current.scan_run_id, task_id: current.id,
              artifact_type: 'agent_provider_recovery', title: 'Transient provider decision recovery',
              content_json: { status: 'retrying', decision_index: iterations + 1, retry_attempt: transientProviderRetries,
                max_retries: maxTransientProviderRetries, tool_replayed: false } });
            assertScanActive();
            await waitForTransientProviderRetry(transientProviderRetries);
            assertScanActive();
            if (runBudget && !runBudget.take()) throw error;
            // A parallel worker may have reserved a slot while this task was
            // waiting. Keep the retried provider payload aligned with the
            // actual shared allowance without rebuilding any captured state.
            context.task.decision_budget.remaining = Math.min(maxIterations - iterations,
              runBudget ? runBudget.remaining + 1 : maxIterations - iterations);
          }
        }
        iterations += 1;
        assertScanActive();
        agentEventBus.publish({
          kind: 'agent_state_changed', status: decision.source === 'ai_provider' ? 'completed' : decision.source === 'fallback' ? 'failed' : 'info',
          scan_run_id: current.scan_run_id, task_id: current.id, provider_id: decision.provider_id, model: decision.model,
          error: decision.source === 'fallback' ? decision.reason : undefined,
          summary: `真实 Agent 决策已记录：source=${decision.source || 'local_policy'}${decision.provider_id ? ` provider=${decision.provider_id}` : ''}${decision.model ? ` model=${decision.model}` : ''}；action=${decision.action}${decision.tool_name ? ` tool=${decision.tool_name}` : ''}`,
        });
        const rejectionContext = persistedRejectionContext(decision);
        const signature = decisionSignature(decision);
        const rejectionReason = safeRejectionReason(decision);
        const publicSelection = safePublicSelection(decision);
        const decisionAudit = {
          ...safeDecisionAudit(decision),
          source: SAFE_DECISION_SOURCES.has(String(decision.source)) ? decision.source : 'local_policy',
          validation_status: SAFE_VALIDATION_STATUSES.has(String(decision.validation_status))
            ? decision.validation_status : (decision.source === 'ai_provider' ? 'accepted' : decision.source === 'fallback' ? 'fallback' : 'local_only'),
          ...(safeDecisionToken(decision.provider_id) ? { provider_id: safeDecisionToken(decision.provider_id) } : {}),
          ...(safeProviderResponseId(decision.provider_response_id) ? { provider_response_id: safeProviderResponseId(decision.provider_response_id) } : {}),
          ...(safeDecisionToken(decision.model) ? { model: safeDecisionToken(decision.model) } : {}),
          ai_provider_attempted: decision.ai_provider_attempted === true,
          ...(decision.ai_usage && Number.isInteger(decision.ai_usage.prompt_tokens) && Number.isInteger(decision.ai_usage.completion_tokens) && Number.isInteger(decision.ai_usage.total_tokens) ? {
            ai_usage: {
              prompt_tokens: Math.max(0, Math.min(decision.ai_usage.prompt_tokens, 10_000_000)),
              completion_tokens: Math.max(0, Math.min(decision.ai_usage.completion_tokens, 10_000_000)),
              total_tokens: Math.max(0, Math.min(decision.ai_usage.total_tokens, 10_000_000)),
              ...(decision.ai_usage.estimated === true ? { estimated: true } : {}),
            },
          } : {}),
          proposal: safeDecisionAudit(decision.proposal),
          policy_decision: safeDecisionAudit(decision.policy_decision),
          ...(typeof decision.rejection_code === 'string' && SAFE_REJECTION_CODE.test(decision.rejection_code)
            ? { rejection_code: decision.rejection_code } : {}),
          ...(rejectionContext ? { rejection_context: rejectionContext } : {}),
          ...(publicSelection ? { public_selection: publicSelection } : {}),
          ...(providerAccessDenied(decision) ? { provider_access_denied: true } : {}),
          decision_signature: signature,
        } as Record<string, unknown>;
        const policyAudit = {
          ...(safeModelScopeAudit(modelScope) ? { model_context: safeModelScopeAudit(modelScope) } : {}),
          policy_decision: safeDecisionAudit(decision.policy_decision),
          ...(typeof decision.rejection_code === 'string' && SAFE_REJECTION_CODE.test(decision.rejection_code)
            ? { rejection_code: decision.rejection_code } : {}),
          ...(rejectionContext ? { rejection_context: rejectionContext } : {}),
        } as Record<string, unknown>;
        await this.recordDecision(current, decisionAudit);
        await this.repo.createPlannerDecision({
          scan_run_id: current.scan_run_id,
          task_id: current.id,
          iteration: iterations,
          source: decision.source || 'local_policy',
          proposal_json: safeDecisionAudit(decision.proposal),
          decision_json: decisionAudit,
          policy_json: policyAudit,
          validation_status: decision.validation_status || (decision.source === 'ai_provider' ? 'accepted' : decision.source === 'fallback' ? 'fallback' : 'local_only'),
          rejection_reason: rejectionReason,
          decision_signature: signature,
        });

        const captureInspectionEpisode = decision.rejection_code === NORMAL_CAPTURE_INSPECTION_NO_PROGRESS
          ? safeCaptureInspectionNoProgressEpisode(rejectionContext) : undefined;
        if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && captureInspectionEpisode) {
          const attempts = await this.captureInspectionNoProgressAttempts(current, captureInspectionEpisode);
          if (attempts >= MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS) {
            const artifact = await this.repo.createArtifact({
              scan_run_id: current.scan_run_id,
              task_id: current.id,
              artifact_type: 'business_capture_inspection_no_progress_limit',
              title: 'Normal capture inspection progress limit reached',
              content_json: {
                flow_id: current.execution_plan?.flow_id,
                recording_session_id: captureInspectionEpisode.recording_session_id,
                capture_status: captureInspectionEpisode.capture_status,
                event_count: captureInspectionEpisode.event_count,
                semantic_candidate_available: captureInspectionEpisode.semantic_candidate_available,
                attempts,
                limit: MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS,
                rejection_code: NORMAL_CAPTURE_INSPECTION_NO_PROGRESS,
              },
            });
            await this.repo.updateTask(current.id, {
              status: 'failed',
              phase: 'normal_capture_inspection_no_progress_limit',
              result_summary: 'The normal Flow repeatedly inspected unchanged capture evidence without a model-selected progress action.',
              error_message: 'The bounded normal capture inspection recovery was exhausted without browser or capture-state progress.',
              completed_at: now(),
              created_assets_json: {
                ...(current.created_assets_json || {}),
                capture_inspection_no_progress_limit_artifact_id: artifact.id,
              },
            });
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
      await this.repo.updateTask(current.id, {
            phase: current.phase === 'normal_capture_objective_completion_required'
              ? 'normal_capture_objective_completion_required'
              : 'normal_capture_inspection_requires_model_progress',
            result_summary: current.phase === 'normal_capture_objective_completion_required'
              ? `Final-outcome capture evidence made no progress (${attempts}/${MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS}); choose the next browser action from safe current completion requirements.`
              : `Capture inspection made no new progress (${attempts}/${MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS}); choose the next browser or Workflow action from safe current evidence.`,
          });
        }

        // The provider proposal is advisory. A persisted failed/blocked native
        // experiment must settle to its real terminal task state before any
        // later proposal can call a generic completion path. In particular, a
        // blocked result is visible to the operator only when it carries both
        // an explicit reason and linked evidence; an underspecified block is a
        // failure rather than a completed test.
        if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT) {
          const experimentArtifacts = await this.repo.listArtifacts(current.scan_run_id);
          const terminal = businessExperimentTerminalDisposition(current, experimentArtifacts);
          if (terminal) {
            if (terminal.kind === 'blocked') {
              await this.repo.createArtifact({ scan_run_id: current.scan_run_id, task_id: current.id,
                artifact_type: 'business_experiment_blocked', title: '模型实验受阻，等待人工处理',
                content_json: { flow_id: current.execution_plan?.flow_id, status: 'blocked', reason: terminal.reason,
                  evidence_artifact_ids: terminal.evidence_artifact_ids } });
              await this.repo.updateTask(current.id, { status: 'blocked', phase: 'experiment_blocked_with_evidence',
                result_summary: terminal.reason, error_message: terminal.reason, completed_at: now() });
            } else {
              await this.repo.updateTask(current.id, { status: 'failed', phase: 'experiment_failed',
                result_summary: terminal.reason, error_message: terminal.reason, completed_at: now() });
            }
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
        }

        if (decision.action === 'tool_call') {
          assertScanActive();
          if (!decision.tool_name) throw new Error('Agent decision missing tool_name');
          agentEventBus.publish({
            kind: 'agent_tool_started', status: 'running', scan_run_id: current.scan_run_id, task_id: current.id,
            tool_name: decision.tool_name, summary: `Agent 开始调用真实工具：${decision.tool_name}`,
          });
          const toolStartedAt = Date.now();
          const result = await this.registry.call(decision.tool_name, decision.arguments || {}, {
            db: this.db,
            repo: this.repo,
            scanRunId: current.scan_run_id,
            taskId: current.id,
            allowed_tool_names: modelScope.allowed_tool_names,
          });
          agentEventBus.publish({
            kind: result.ok ? 'agent_tool_completed' : 'agent_tool_completed', status: result.ok ? 'completed' : 'failed',
            scan_run_id: current.scan_run_id, task_id: current.id, tool_name: decision.tool_name,
            duration_ms: Date.now() - toolStartedAt, error: result.ok ? undefined : textSummary(result.error),
            summary: textSummary(result.summary, result.ok ? `工具 ${decision.tool_name} 已完成。` : `工具 ${decision.tool_name} 失败。`),
          });
          // Resolve a potentially dispatched browser operation through a
          // fixed read-only sequence. Persist each transition so a restart
          // cannot spin on capture inspection or skip to another mutation.
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && result.ok) {
            if (decision.tool_name === 'bstg.business.capture.inspect' &&
                current.phase === 'normal_post_action_capture_requires_inspection') {
              await this.repo.updateTask(current.id, {
                phase: 'normal_post_action_capture_requires_authoritative_observation',
                result_summary: 'The existing task-bound capture was inspected after a potentially dispatched action; observe the current browser state before resolving the Flow.',
              });
              continue;
            }
            if (decision.tool_name === 'browser.interact' && decision.arguments?.operation?.action === 'observe' &&
                current.phase === 'normal_post_action_capture_requires_authoritative_observation') {
              await this.repo.updateTask(current.id, {
                phase: 'normal_post_action_capture_requires_post_observation_inspection',
                result_summary: 'The current browser state was observed after a potentially dispatched action; refresh the same task-bound capture before the next model decision.',
              });
              continue;
            }
            if (decision.tool_name === 'bstg.business.capture.inspect' &&
                current.phase === 'normal_post_action_capture_requires_post_observation_inspection') {
              await this.repo.updateTask(current.id, {
                phase: 'normal_post_action_capture_inspected_requires_model_resolution',
                result_summary: 'The post-observation capture inventory is current. Resolve it with native capture/workflow evidence; a matching potentially dispatched browser operation remains blocked.',
              });
              continue;
            }
          }
          if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && result.ok &&
              decision.tool_name === 'bstg.workflow.inspect' &&
              current.phase === 'experiment_workflow_step_binding_requires_inspection') {
            await this.repo.updateTask(current.id, {
              phase: 'experiment_workflow_step_binding_reinspection_completed',
              result_summary: 'The native Workflow step identifiers were refreshed after a rejected experiment plan. Choose a corrected plan from that inspection.',
            });
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && result.ok &&
              decision.tool_name === 'bstg.test_plan.inspect' &&
              current.phase === 'experiment_compile_requires_inspection') {
            await this.repo.updateTask(current.id, {
              phase: 'experiment_compile_reinspection_completed',
              result_summary: 'The failed native plan and safe compile feedback were inspected. Create a fresh child plan from that evidence; the failed plan cannot be compiled again.',
            });
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && result.ok &&
              decision.tool_name === 'bstg.test_plan.create' &&
              ['experiment_compile_reinspection_completed', 'experiment_workflow_step_binding_reinspection_completed'].includes(current.phase || '')) {
            await this.repo.updateTask(current.id, {
              phase: 'experiment_compile_child_plan_created',
              result_summary: 'A fresh child experiment plan was saved after inspecting the compile rejection. Compile this exact child once, then inspect any typed rejection before creating another bounded child.',
            });
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && result.ok &&
              decision.tool_name === 'bstg.test_plan.compile' && current.phase === 'experiment_compile_child_plan_created') {
            await this.repo.updateTask(current.id, {
              phase: 'autonomous_running',
              result_summary: 'The corrected child plan compiled successfully. The original compile-recovery phase is closed; continue through native execution and evidence assessment.',
            });
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && !result.ok &&
              decision.tool_name === 'bstg.test_plan.create' &&
              ['experiment_compile_reinspection_required', 'experiment_compile_parent_required'].includes(String(result.data?.status || ''))) {
            const needsReinspection = result.data?.status === 'experiment_compile_reinspection_required';
            await this.repo.updateTask(current.id, {
              phase: needsReinspection ? 'experiment_compile_requires_inspection' : 'experiment_compile_reinspection_completed',
              result_summary: textSummary(result.summary, needsReinspection
                ? 'Inspect the exact failed plan before creating its child.'
                : 'The revised plan must be a fresh child of the exact failed plan.'),
            });
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.workflow.validate' &&
              result.data?.status === 'assertion_revision_required') {
            const workflowId=String(result.data?.workflow_id||decision.arguments?.workflow_id||'');
            const attempts=await this.assertionRevisionAttempts(current,workflowId);
            if(attempts>=MAX_NORMAL_ASSERTION_REVISION_ATTEMPTS){
              await this.repo.createArtifact({scan_run_id: current.scan_run_id, task_id: current.id,
                artifact_type: 'business_assertion_revision_limit', title: 'Normal Workflow assertion revision limit reached',
                content_json: {flow_id: current.execution_plan?.flow_id, workflow_id: workflowId,
                  attempts, native_execution_started: false,
                  reason: 'The model repeatedly submitted structurally rejected normal-business assertions for the same Workflow.'}});
              await this.repo.updateTask(current.id, {status:'failed',phase:'normal_assertion_revision_limit_exceeded',
                result_summary:'The same normal Workflow exhausted its bounded assertion-revision attempts before any native Test Run could be created.',
                error_message:'Normal business assertion input remained structurally invalid after the bounded revision allowance.',completed_at:now()});
              await this.rememberTaskOutcome(current.id);
              return iterations;
            }
            const objectiveCompletionAssertionRequired=Array.isArray(result.data?.objective_completion_assertion_requirements)&&
              result.data.objective_completion_assertion_requirements.length>0;
            await this.repo.updateTask(current.id, {phase: objectiveCompletionAssertionRequired
              ? 'normal_objective_completion_assertion_requires_inspection'
              : 'normal_assertion_revision_requires_inspection',
              result_summary: textSummary(result.summary, objectiveCompletionAssertionRequired
                ? 'The final-outcome assertion contract was incomplete before native execution; inspect the same workflow and add every required final path.'
                : 'The assertion shape was rejected before native execution; inspect the same workflow and revise it.')});
            continue;
          }
          // A successful native validation is enough to reconcile task-owned
          // proof, coverage retries, and the one bounded retry recovery. Do
          // this before asking the provider for an otherwise redundant
          // completion decision.
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.workflow.validate' &&
              result.data?.verified === true) {
            if (await this.reconcileBusinessLearningCompletion(current,
              'The native normal validation satisfies the current normal business Flow.', {
                workflow_id: result.data?.workflow_id,
                test_run_id: result.data?.test_run_id,
              })) return iterations;
            continue;
          }
          // Native normal validation can execute successfully while disproving
          // its semantic goal. Treat that persisted verified:false fact as
          // adaptation feedback regardless of the tool wrapper's transport
          // `ok` value; otherwise a real failed baseline can be marked as a
          // completed helper call and later loop or complete incorrectly.
          if (businessTaskIntent(current) && decision.tool_name === 'bstg.business.workflow.validate' && result.data?.verified === false) {
            const executionFailed=result.data?.execution?.has_execution_error===true;
            const failureCount=executionFailed?(await this.repo.listArtifacts(current.scan_run_id)).filter(artifact=>
              artifact.artifact_type==='business_workflow_validation'&&artifact.task_id===current.id&&
              String(artifact.content_json?.flow_id||'')===String(current.execution_plan?.flow_id||'')&&
              artifact.content_json?.execution?.has_execution_error===true).length:0;
            const repeatedExecutionFailure=executionFailed&&failureCount>=2;
            await this.repo.updateTask(current.id, {phase: executionFailed
              ? repeatedExecutionFailure?'normal_validation_repeated_execution_error_requires_workflow_revision':'normal_validation_requires_adaptation'
              : 'normal_validation_semantic_requires_inspection',
              result_summary: textSummary(result.summary, executionFailed
                ? repeatedExecutionFailure
                  ? 'The repaired native path still has an execution error. Inspect the current Workflow, then let the model select an explicit observed-event revision.'
                  : 'Normal execution failed; repair the task-bound workflow evidence before revalidation.'
                : 'Normal execution completed but the business assertion did not pass; inspect and revise the same workflow.')});
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.workflow.repair' &&
              result.data?.status === 'repaired') {
            await this.repo.updateTask(current.id, {phase: 'normal_validation_repaired_requires_inspection',
              result_summary: textSummary(result.summary, 'Execution learning was applied to the current workflow; inspect it before revalidation.')});
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.capture.inspect' &&
              current.phase === 'normal_validation_repeated_execution_error_requires_workflow_revision') {
            await this.repo.updateTask(current.id, {phase: 'normal_validation_repeated_execution_error_requires_model_revision',
              result_summary: textSummary(result.summary, 'The stopped capture is refreshed. The next model decision must choose an explicit observed-event revision or another evidence-backed recovery.')});
            continue;
          }
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.workflow.revise' &&
              result.data?.status === 'revised') {
            await this.repo.updateTask(current.id, {phase: 'normal_workflow_revised_requires_inspection',
              result_summary: textSummary(result.summary, 'A model-selected Workflow revision was published. Inspect its new native steps before choosing fresh semantic validation.')});
            continue;
          }
          if (!result.ok) {
            // Planning is model-owned and an invalid Flow/coverage reference is
            // revision feedback, not an execution-side failure.  For example,
            // discovery can refine the inventory between two model turns or a
            // model can copy an opaque target ID incorrectly.  Preserve the
            // failed invocation, constrain recovery to the planning tools, and
            // let the next bounded provider turn inspect the current inventory
            // and choose its own corrected associations.  Do not extend this
            // to browser scope/auth failures or later native execution.
            if (current.execution_plan?.intent === BUSINESS_PLAN_INTENT &&
                ['bstg.business.coverage.inspect', 'bstg.business.coverage.save', 'bstg.business.flow.define'].includes(decision.tool_name)) {
              await this.repo.updateTask(current.id, {
                phase: 'normal_business_planning_requires_adaptation',
                result_summary: textSummary(result.summary, result.error || 'The model-owned normal-business plan needs a revision against current inventory facts.'),
              });
              continue;
            }
            // The dedicated Flow blocker is evidence-gated. A model can name
            // a stale or invented artifact, but that rejection must not turn
            // a repairable normal flow into a terminal failure. Keep the
            // rejected call and require a fresh evidence inspection; only a
            // successful blocker tool call can produce a blocked terminal.
            if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.flow.block') {
              await this.repo.updateTask(current.id, {
                phase: 'normal_flow_block_requires_adaptation',
                result_summary: textSummary(result.summary, result.error || 'The proposed normal-flow blocker was rejected; inspect current server evidence before adapting the Flow.'),
              });
              continue;
            }
            // A stopped capture may contain both navigation/context events and
            // successful semantic response events. Choosing only the former is
            // a model-owned subset error, not an executor failure. Preserve the
            // rejected decision, refresh the value-free stopped inventory, and
            // let the next provider turn choose one of the opaque candidates.
            // The same bounded recovery covers an early active-capture stop:
            // it remains active and the model must choose another browser
            // action rather than sealing an HTML-only trace.
            if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT &&
                ['bstg.business.capture.stop', 'bstg.business.workflow.prepare'].includes(decision.tool_name) &&
                ['semantic_body_candidate_required','objective_completion_candidate_required','objective_operation_candidate_required','workflow_eligible_event_selection_required','transaction_prerequisite_event_selection_required'].includes(String(result.data?.status||'')) && result.data?.retryable === true) {
              const attempts=await this.normalEvidenceSelectionAttempts(current);
              const completionRequired=['objective_completion_candidate_required','objective_operation_candidate_required'].includes(String(result.data?.status||''));
              if(attempts>=MAX_NORMAL_SEMANTIC_SELECTION_ATTEMPTS){
                const artifact=await this.repo.createArtifact({scan_run_id: current.scan_run_id, task_id: current.id,
                  artifact_type: 'business_semantic_selection_limit', title: 'Normal Workflow evidence selection limit reached',
                  content_json: {flow_id: current.execution_plan?.flow_id, attempts, tool_name: decision.tool_name,
                    candidate_event_count: Number.isInteger(result.data?.candidate_event_count) ? result.data.candidate_event_count : 0,
                    capture_remains_active: result.data?.capture_remains_active===true,
                    ...(completionRequired?{objective_completion_required:true}: {})}});
                await this.repo.updateTask(current.id, {status: 'failed', phase: 'normal_semantic_selection_limit',
                  result_summary: completionRequired?'The normal Flow repeatedly stopped before its required final objective evidence.':'The normal Flow repeatedly selected no semantic response evidence.',
                  error_message: completionRequired?'The normal Flow exhausted its bounded final-objective evidence corrections.':'The normal Flow exhausted its bounded semantic event-selection corrections.', completed_at: now(),
                  created_assets_json: {...(current.created_assets_json||{}), semantic_selection_limit_artifact_id:artifact.id}});
                await this.rememberTaskOutcome(current.id);
                return iterations;
              }
              const stopRejected=decision.tool_name==='bstg.business.capture.stop';
              await this.repo.updateTask(current.id, {
                phase: stopRejected ? (completionRequired?'normal_capture_objective_completion_required':'normal_capture_semantic_evidence_required') : 'normal_workflow_selection_requires_adaptation',
                result_summary: textSummary(result.summary, stopRejected
                  ? (completionRequired?'The active capture has not reached its required final objective outcome. Choose a browser action, then inspect again.':'The active capture has no semantic response yet. Choose a browser action, then inspect again.')
                  : (completionRequired?'The selected stopped-capture events omit the required final objective outcome. Inspect and choose an explicit corrected subset.':'The selected stopped-capture events omit semantic response evidence. Inspect and choose an explicit corrected subset.')),
              });
              continue;
            }
            // A coverage-retry capture can contain the scheduled endpoint yet
            // still be omitted from the model-selected Workflow subset. That
            // is an explicit, no-side-effect selection correction: preserve
            // the failed proposal and re-anchor the next turn on the stopped
            // capture rather than terminalizing a recoverable normal Flow or
            // silently adding the server's preferred event.
            if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.workflow.prepare' &&
                result.data?.status === 'coverage_retry_event_selection_required' && result.data?.retryable === true) {
              await this.repo.updateTask(current.id, {
                phase: 'normal_workflow_selection_requires_adaptation',
                result_summary: textSummary(result.summary, 'The selected retry Workflow omitted a target event that is present in the stopped capture. Inspect it and choose an explicit corrected subset.'),
              });
              continue;
            }
            // A malformed or stale model experiment is feedback, not a reason
            // to discard the whole verified flow. Keep the rejected invocation
            // in context so the model can inspect provenance and revise its own
            // plan. Network/executor failures still surface in the final gate.
            if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT &&
                decision.tool_name === 'bstg.test_plan.compile' &&
                ['experiment_compile_requires_revision', 'experiment_compile_failed'].includes(String(result.data?.status || ''))) {
              const attempts = await this.businessExperimentCompileFailureAttempts(current);
              const retryable = result.data?.status === 'experiment_compile_requires_revision' && result.data?.retryable === true;
              if (!retryable || attempts >= MAX_BUSINESS_EXPERIMENT_COMPILE_FAILURE_ATTEMPTS) {
                const failureCode = typeof result.data?.failure_code === 'string' && /^[a-z_]{1,64}$/.test(result.data.failure_code)
                  ? result.data.failure_code : 'compiler_internal_failure';
                const artifact = await this.repo.createArtifact({ scan_run_id: current.scan_run_id, task_id: current.id,
                  artifact_type: 'business_experiment_compile_limit', title: 'Native experiment compilation did not complete',
                  content_json: { flow_id: current.execution_plan?.flow_id, plan_id: String(decision.arguments?.plan_id || ''),
                    failure_code: failureCode, attempts, limit: MAX_BUSINESS_EXPERIMENT_COMPILE_FAILURE_ATTEMPTS,
                    reason: retryable ? 'The bounded model-authored child-plan corrections were rejected by native compilation.'
                      : 'The failure was not a model-correctable plan rejection or the verified baseline was stale.' } });
                await this.repo.updateTask(current.id, { status: 'failed', phase: retryable ? 'experiment_compile_limit_exceeded' : 'experiment_compile_failed',
                  result_summary: textSummary(result.summary, 'Native experiment compilation failed. No experiment execution or finding was verified.'),
                  error_message: 'Native experiment compilation did not produce an executable plan.', completed_at: now(),
                  created_assets_json: { ...(current.created_assets_json || {}), compile_failure_artifact_id: artifact.id } });
                await this.rememberTaskOutcome(current.id);
                return iterations;
              }
              await this.repo.updateTask(current.id, { phase: 'experiment_compile_requires_inspection',
                result_summary: textSummary(result.summary, 'Inspect the safe compiler feedback, then create one fresh child plan.') });
              continue;
            }
            if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT &&
                ['bstg.test_plan.create', 'bstg.test_plan.compile', 'bstg.test_plan.execute', 'bstg.test_plan.assess'].includes(decision.tool_name)) {
              const workflowStepBindingMismatch = decision.tool_name === 'bstg.test_plan.create' &&
                result.data?.status === 'workflow_step_binding_mismatch' && result.data?.retryable === true;
              if (workflowStepBindingMismatch) {
                const attempts = await this.workflowStepBindingMismatchAttempts(current);
                if (attempts >= MAX_BUSINESS_EXPERIMENT_STEP_BINDING_MISMATCH_ATTEMPTS) {
                  const artifact = await this.repo.createArtifact({ scan_run_id: current.scan_run_id, task_id: current.id,
                    artifact_type: 'business_experiment_step_binding_limit', title: 'Model experiment step-order correction limit reached',
                    content_json: { flow_id: current.execution_plan?.flow_id, attempts,
                      limit: MAX_BUSINESS_EXPERIMENT_STEP_BINDING_MISMATCH_ATTEMPTS,
                      reason: 'The model plan continued to reference an unknown or stale Workflow step order after the bounded native reinspection.' } });
                  await this.repo.updateTask(current.id, { status: 'failed', phase: 'experiment_step_binding_limit_exceeded',
                    result_summary: 'The model experiment selected a Workflow step order that does not exist after its bounded correction. No plan was saved.',
                    error_message: 'Native Workflow step-order correction attempts were exhausted before experiment execution.', completed_at: now(),
                    created_assets_json: { ...(current.created_assets_json || {}), step_binding_limit_artifact_id: artifact.id } });
                  await this.rememberTaskOutcome(current.id);
                  return iterations;
                }
              }
              await this.repo.updateTask(current.id, {phase: workflowStepBindingMismatch &&
                current.phase !== 'experiment_workflow_step_binding_reinspection_completed'
                  ? 'experiment_workflow_step_binding_requires_inspection'
                  : decision.tool_name === 'bstg.test_plan.create' && current.phase === 'experiment_compile_reinspection_completed'
                    ? 'experiment_compile_reinspection_completed'
                    : 'experiment_requires_adaptation',
                result_summary: textSummary(result.summary, result.error || 'The model experiment needs a concrete revision.')});
              continue;
            }
            if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.workflow.revise' &&
                current.phase === 'normal_validation_repeated_execution_error_requires_model_revision') {
              await this.repo.updateTask(current.id, {
                phase: 'normal_validation_repeated_execution_error_requires_model_revision',
                result_summary: textSummary(result.summary, result.error || 'The proposed Workflow revision was rejected. Inspect the current observed event IDs and choose a corrected explicit subset.'),
              });
              continue;
            }
            if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'browser.interact' &&
                result.data?.error_code === 'post_action_replay_blocked') {
              const attempts = await this.postActionReplayBlockedAttempts(current);
              if (attempts > MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS) {
                const artifact = await this.repo.createArtifact({
                  scan_run_id: current.scan_run_id,
                  task_id: current.id,
                  artifact_type: 'business_post_action_replay_block_limit',
                  title: 'Normal post-action replay block limit reached',
                  content_json: {
                    flow_id: current.execution_plan?.flow_id,
                    attempts,
                    limit: MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS,
                    pre_dispatch: true,
                  },
                });
                await this.repo.updateTask(current.id, {
                  status: 'failed', phase: 'normal_post_action_replay_block_limit',
                  result_summary: 'The normal Flow repeatedly proposed an operation guarded after a potentially dispatched action.',
                  error_message: 'The bounded post-action replay guard was repeatedly rejected before browser dispatch.',
                  completed_at: now(),
                  created_assets_json: { ...(current.created_assets_json || {}), post_action_replay_block_limit_artifact_id: artifact.id },
                });
                await this.rememberTaskOutcome(current.id);
                return iterations;
              }
              await this.repo.updateTask(current.id, {
                phase: 'normal_post_action_replay_blocked_requires_model_resolution',
                result_summary: `A potentially dispatched normal browser operation was blocked from replay (${attempts}/${MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS}); use the current capture/workflow evidence or choose a different observed action.`,
              });
              continue;
            }
            // Do not replay an action which crossed the browser dispatch
            // boundary just because its post-action observation failed. The
            // action may have taken effect even when Playwright cannot prove
            // completion. Persist a private runtime fingerprint and resolve
            // only through capture + live-state reads; this neither relaxes
            // TLS/evidence gates nor treats the action as a success.
            if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'browser.interact' &&
                result.data?.failure_phase === 'action_or_after' && result.data?.action_performed !== false) {
              const attempts = await this.postActionCaptureRecoveryAttempts(current);
              const flow = await getBusinessFlow(this.repo, current.scan_run_id, String(current.execution_plan?.flow_id || '')).catch(() => undefined);
              const replayFingerprint = postActionReplayFingerprint(result.data);
              const recoveryArtifact = await this.repo.createArtifact({
                scan_run_id: current.scan_run_id,
                task_id: current.id,
                artifact_type: 'business_post_action_replay_guard',
                title: 'Private normal post-action replay guard',
                content_json: {
                  private: true,
                  protocol: 'capture_then_observe_then_capture',
                  flow_id: current.execution_plan?.flow_id,
                  recording_session_id: flow?.recording_session_id || '',
                  potentially_dispatched: true,
                  failure_phase: 'action_or_after',
                  ...(replayFingerprint ? { operation_fingerprint: replayFingerprint } : {}),
                },
              });
              if (attempts > MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS) {
                const artifact = await this.repo.createArtifact({
                  scan_run_id: current.scan_run_id,
                  task_id: current.id,
                  artifact_type: 'business_post_action_capture_recovery_limit',
                  title: 'Normal post-action capture recovery limit reached',
                  content_json: {
                    flow_id: current.execution_plan?.flow_id,
                    attempts,
                    limit: MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS,
                    potentially_dispatched: true,
                    failure_phase: 'action_or_after',
                  },
                });
                await this.repo.updateTask(current.id, {
                  status: 'failed', phase: 'normal_post_action_capture_recovery_limit',
                  result_summary: 'A normal browser action repeatedly reached the dispatch boundary without a usable post-action observation; bounded capture inspection recovery was exhausted.',
                  error_message: 'The normal Flow exhausted its post-action capture-only recovery allowance without a verified native result.',
                  completed_at: now(),
                  created_assets_json: { ...(current.created_assets_json || {}), post_action_capture_recovery_artifact_id: recoveryArtifact.id, post_action_capture_recovery_limit_artifact_id: artifact.id },
                });
                await this.rememberTaskOutcome(current.id);
                return iterations;
              }
              await this.repo.updateTask(current.id, {
                phase: 'normal_post_action_capture_requires_inspection',
                result_summary: `A normal browser action may have been dispatched but its post-action observation failed (${attempts}/${MAX_NORMAL_POST_ACTION_CAPTURE_RECOVERY_ATTEMPTS}); inspect the existing capture before any further action.`,
                created_assets_json: { ...(current.created_assets_json || {}), post_action_capture_recovery_artifact_id: recoveryArtifact.id },
              });
              continue;
            }
            if (result.data?.blocked && ['identity_preparation_required', 'identity_session_required'].includes(result.data?.error_code)) {
              await this.repo.updateTask(current.id, { status: 'blocked', phase: 'identity_required',
                result_summary: result.summary, error_message: result.error, completed_at: now() });
              await this.rememberTaskOutcome(current.id);
              return iterations;
            }
            // Rejected pre-action readiness checks have dispatched no action. Keep the failed
            // invocation in model context so the model can choose a correction.
            // A normal-flow page assertion is likewise non-mutating feedback;
            // other task types retain their terminal assertion semantics.
            if ((current.execution_plan?.intent === 'discover_target' || current.execution_plan?.intent === BUSINESS_LEARNING_INTENT ||
                ['test_generic_vuln', 'test_file_upload'].includes(current.task_type)) &&
                decision.tool_name === 'browser.interact' &&
                result.data?.failure_phase === 'pre_action' && result.data?.action_performed === false && result.data?.retryable === true &&
                (['selector_no_match', 'selector_ambiguous', 'selector_not_visible', 'selector_invalid', 'selector_actionability_timeout', 'observation_reference_expired'].includes(result.data?.error_code) ||
                  (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && result.data?.error_code === 'assertion_not_observed')) && selectorCorrections < 2) {
              assertScanActive();
              selectorCorrections += 1;
              await this.repo.updateTask(current.id, { phase: 'awaiting_selector_correction', result_summary: result.error });
              continue;
            }
            await this.repo.updateTask(current.id, {
              status: 'failed',
              phase: 'failed',
              result_summary: textSummary(result.summary, result.error || `Tool ${decision.tool_name} failed`),
              error_message: textSummary(result.error, `Tool ${decision.tool_name} failed`),
              completed_at: now(),
            });
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
          if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT && decision.tool_name === 'bstg.business.flow.block') {
            if (await this.settleBusinessLearningTerminal(current)) return iterations;
            await this.repo.updateTask(current.id, {
              status: 'failed', phase: 'normal_flow_block_without_evidence',
              result_summary: 'The normal-flow blocker tool did not leave a persisted Flow block with linked server evidence.',
              error_message: 'A normal-flow block requires a concrete Flow blocker and linked server evidence.', completed_at: now(),
            });
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
          // A completed live-observation interaction resolves this correction
          // episode. The model boundary accepts opaque control/assertion refs,
          // while trusted runtime callers may still retain a selector. Later
          // independent controls get their own bounded recovery; observation,
          // scrolling, navigation and unrelated tools do not replenish it.
          const completedBrowserOperation = decision.arguments?.operation;
          const completedBrowserReference = typeof completedBrowserOperation?.control_ref === 'string'
            ? completedBrowserOperation.control_ref
            : typeof completedBrowserOperation?.assertion_ref === 'string'
              ? completedBrowserOperation.assertion_ref
              : typeof completedBrowserOperation?.selector === 'string'
                ? completedBrowserOperation.selector : '';
          if (decision.tool_name === 'browser.interact' &&
              ['click', 'fill', 'select', 'press', 'assert'].includes(completedBrowserOperation?.action) &&
              completedBrowserReference.length > 0) {
            selectorCorrections = 0;
          }
          // These tools fulfill their dedicated tasks after artifact and invocation
          // persistence. Do not let later provider decisions replace that outcome.
          // The same tools remain reusable helpers in other tasks.
          const completesCampaignSummary = decision.tool_name === 'task.summarize_vulnerability_campaign' &&
            (current.task_type === 'summarize_vulnerability_campaign' || current.execution_plan?.intent === 'summarize_vulnerability_campaign');
          const completesCapabilityInventory = decision.tool_name === 'bstg.capabilities.inventory' &&
            current.execution_plan?.intent === 'inventory_bstg_capabilities';
          const autoAccounts = requiresAutomaticAccounts(context.scan.scan_config);
          const completesDiscovery = isDedicatedWebDiscovery(current, context.scan.scan_config) &&
            ((decision.tool_name === 'browser.discover_target' && !autoAccounts) ||
              (decision.tool_name === 'bstg.identity.bootstrap_accounts' && autoAccounts && current.phase === DISCOVERY_COMPLETED_PHASE));
          const completesTask = completesCampaignSummary || completesCapabilityInventory || completesDiscovery;
          const recovery = current.execution_plan?.coverage_retry?.completion_recovery;
          const recoveryCaptureStarted = decision.tool_name === 'bstg.business.capture.start' &&
            recovery?.status === 'capture_required';
          await this.repo.updateTask(current.id, {
            phase: completesTask ? 'completed' : `tool_completed:${decision.tool_name}`,
            result_summary: textSummary(result.summary, `${decision.tool_name} completed.`),
            created_assets_json: { ...(current.created_assets_json || {}), ...(result.data?.assets || {}) },
            ...(recoveryCaptureStarted ? { execution_plan: {
              ...current.execution_plan,
              coverage_retry: { ...current.execution_plan?.coverage_retry, completion_recovery: {
                ...recovery, status: 'capture_started', recording_session_id: result.data?.recording_session_id,
              } },
            } } : {}),
            ...(completesTask ? { status: 'completed', completed_at: now() } : {}),
          });
          if (completesTask) {
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
          continue;
        }

        if (decision.action === 'create_child_tasks') {
          const children = Array.isArray(decision.tasks) ? decision.tasks : [];
          const preparation = run ? await ensureManualIdentityPreparation(this.repo, run) : undefined;
          const createdChildren: AIScanTask[] = [];
          for (const child of children) {
            assertScanActive();
            const created = await this.repo.createTask({
              scan_run_id: current.scan_run_id,
              parent_task_id: current.id,
              title: child.title,
              task_type: child.task_type,
              vuln_type: child.vuln_type,
              feature_id: child.feature_id,
              endpoint_ids: child.endpoint_ids || [],
              priority: child.priority ?? current.priority + 1,
              dependencies: [...new Set([...(child.dependencies || []), ...(preparation && (child.task_type.startsWith('test_') || child.vuln_type || child.execution_plan?.vuln_type || child.execution_plan?.requires_identity_context || child.execution_plan?.workflow_execution_plan || ['model_features_and_candidates', 'expand_selected_vulnerabilities'].includes(child.execution_plan?.intent)) ? [preparation.id] : [])])],
              agent_goal: child.agent_goal || child.title,
              execution_plan: child.execution_plan || {},
            });
            createdChildren.push(created);
          }
          // Review-created repair tasks remain independent follow-ups. They do
          // not add a continuation dependency to modeling or to experiments for
          // already verified flows: one blocked function must not hold another
          // verified function hostage.
          if (current.execution_plan?.intent === BUSINESS_PLAN_INTENT) {
            const currentArtifacts = await this.repo.listArtifacts(current.scan_run_id);
            const gap = await businessCompletionGap(this.repo, current, latestBusinessFlows(currentArtifacts), currentArtifacts, this.db);
            if (gap) {await this.repo.updateTask(current.id, {phase: 'business_completion_requires_evidence', result_summary: gap});continue;}
            await scheduleBusinessLearning(this.repo, current);
          }
          if (current.execution_plan?.intent === BUSINESS_REVIEW_INTENT && !businessLearningOnly({ scan_config: run?.scan_config || {} })) await scheduleBusinessExperiments(this.repo, current);
          await this.repo.updateTask(current.id, {
            status: 'completed',
            phase: 'completed',
            result_summary: textSummary(decision.summary, `Created ${children.length} child tasks.`),
            completed_at: now(),
          });
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        if (decision.action === 'wait_for_user_selection') {
          // This explicitly configured lane never fabricates a generic
          // candidate selection.  Its verified Flow experiments are already
          // scheduled by the business review stage, so an accidental/model
          // selection handoff here must complete the optional candidate
          // inventory without freezing those independent tasks.
          if (run && businessLearningAutoExperiments(run) && current.execution_plan?.intent === 'model_features_and_candidates') {
            await this.repo.updateTask(current.id, {
              status: 'completed',
              phase: 'candidate_selection_deferred_for_business_experiments',
              result_summary: 'Candidate inventory is retained without a generic selection; verified business experiments continue independently.',
              completed_at: now(),
            });
            await this.rememberTaskOutcome(current.id);
            return iterations;
          }
          await this.repo.updateRun(current.scan_run_id, { status: 'awaiting_selection', current_phase: 'awaiting_vulnerability_selection' });
          await this.repo.updateTask(current.id, {
            status: 'waiting_selection',
            phase: 'awaiting_selection',
            result_summary: textSummary(decision.summary || decision.reason, 'Waiting for user vulnerability selection.'),
            completed_at: now(),
          });
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        if (decision.action === 'fail_task') {
          await this.repo.updateTask(current.id, {
            status: 'failed',
            phase: 'failed',
            result_summary: textSummary(decision.summary || decision.reason, 'Agent failed task.'),
            error_message: textSummary(decision.reason || decision.summary, 'Agent failed task.'),
            completed_at: now(),
          });
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        if (decision.action === 'block_task') {
          // A model may block an ordinary helper task, but a business
          // experiment has a stronger contract: its earlier authoritative
          // terminal check must have found linked evidence. Do not allow a
          // free-form provider message to stop that evidence loop.
          if (current.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT) {
            await this.repo.updateTask(current.id, {
              status: 'failed', phase: 'experiment_block_without_evidence',
              result_summary: 'The model attempted to block a business experiment without a persisted explicit blocker and linked evidence.',
              error_message: 'A business experiment may be blocked only by a persisted blocker with linked evidence.', completed_at: now(),
            });
          } else if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT) {
            // Defense in depth for custom planners and old queued decisions:
            // real provider proposals are rejected by model-context scope
            // before reaching this branch, but never accept a bare normal-flow
            // block if that boundary is bypassed.
            if (await this.settleBusinessLearningTerminal(current)) return iterations;
            await this.repo.createArtifact({ scan_run_id: current.scan_run_id, task_id: current.id,
              artifact_type: 'business_flow_block_rejected', title: 'Rejected normal-flow model block',
              content_json: { flow_id: current.execution_plan?.flow_id, action: 'block_task',
                reason: textSummary(decision.reason || decision.summary, 'No concrete blocker reason was supplied.'),
                required_tool: 'bstg.business.flow.block' } });
            await this.repo.updateTask(current.id, {
              status: 'failed', phase: 'normal_flow_block_without_evidence',
              result_summary: 'The model attempted to block a normal business flow without a persisted Flow blocker and linked server evidence.',
              error_message: 'Inspect and adapt the normal Flow, or use bstg.business.flow.block with a concrete server blocker artifact.', completed_at: now(),
            });
          } else {
            await this.repo.updateTask(current.id, {
              status: 'blocked', phase: 'agent_declared_blocked',
              result_summary: textSummary(decision.summary || decision.reason, 'Agent reported a concrete blocker.'),
              error_message: textSummary(decision.reason || decision.summary, 'Agent reported a concrete blocker.'), completed_at: now(),
            });
          }
          await this.rememberTaskOutcome(current.id);
          return iterations;
        }

        assertScanActive();
        if (current.execution_plan?.intent === BUSINESS_LEARNING_INTENT) {
          if (await this.reconcileBusinessLearningCompletion(current,
            textSummary(decision.summary, 'Agent completed task.'))) return iterations;
          continue;
        }
        const androidGap = await androidBusinessCompletionGap(this.repo, current);
        if (androidGap) {
          await this.repo.updateTask(current.id, {phase: 'android_business_completion_requires_evidence', result_summary: androidGap});
          continue;
        }
        const businessArtifacts = await this.repo.listArtifacts(current.scan_run_id);
        const businessGap = await businessCompletionGap(this.repo, current, latestBusinessFlows(businessArtifacts), businessArtifacts, this.db);
        if (businessGap) {
          await this.repo.createArtifact({scan_run_id: current.scan_run_id, task_id: current.id,
            artifact_type: 'business_completion_gap', title: 'Normal business completion requires evidence',
            content_json: {flow_id: current.execution_plan?.flow_id, intent: current.execution_plan?.intent, verified: false, reason: businessGap}});
          await this.repo.updateTask(current.id, {phase: 'business_completion_requires_evidence', result_summary: businessGap});
          continue;
        }
        if (current.execution_plan?.intent === BUSINESS_PLAN_INTENT) await scheduleBusinessLearning(this.repo, current);
        if (current.execution_plan?.intent === BUSINESS_REVIEW_INTENT && !businessLearningOnly({ scan_config: run?.scan_config || {} })) await scheduleBusinessExperiments(this.repo, current);
        await this.repo.updateTask(current.id, {
          status: 'completed',
          phase: 'completed',
          result_summary: textSummary(decision.summary, 'Agent completed task.'),
          completed_at: now(),
        });
        await this.rememberTaskOutcome(current.id);
        return iterations;
      }
      // If the last permitted provider tool call persisted a verified normal
      // Flow, close it from that evidence before declaring the task budget
      // exhausted.  This does not invoke the provider or reserve another
      // decision; it only reconciles the result of the final real action.
      const terminalCurrent = await this.repo.getTask(task.id);
      if (terminalCurrent && await this.settleBusinessLearningAtBudgetBoundary(terminalCurrent)) return iterations;
      await this.repo.updateTask(task.id, {
        status: 'failed',
        phase: iterations >= maxIterations ? 'iteration_limit_exceeded' : 'run_step_limit_exceeded',
        error_message: iterations >= maxIterations
          ? `Autonomous Agent exhausted the task limit of ${maxIterations} decisions`
          : `Autonomous Agent exhausted the run limit of ${runBudget?.limit} decisions`,
        completed_at: now(),
      });
      await this.rememberTaskOutcome(task.id);
      return iterations;
    } catch (error: unknown) {
      // A temporary provider exhaustion occurred before a planner decision or
      // registry tool call. Preserve the task as an externally blocked state,
      // rather than claiming that its business evidence or native executor
      // failed. The message is intentionally constant: provider bodies never
      // enter the durable task record.
      if (error instanceof AgentProviderDecisionUnavailableError) {
        await this.repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id,
          artifact_type: 'agent_provider_recovery', title: 'Transient provider decision recovery exhausted',
          content_json: { status: 'exhausted', max_retries: maxTransientProviderRetries, tool_replayed: false } });
        await this.repo.updateTask(task.id, {
          status: 'blocked', phase: 'provider_temporarily_unavailable',
          error_message: 'The configured model service is temporarily unavailable after bounded decision retries.',
          result_summary: 'The configured model service is temporarily unavailable after bounded decision retries.',
          completed_at: now(),
        });
        await this.rememberTaskOutcome(task.id);
        return iterations;
      }
      // Scope and capture prerequisites block before execution. Keep the typed
      // guards; message text alone must never reclassify an execution failure.
      const scopeBlocked = error instanceof TargetScopeError;
      const captureBlocked = error instanceof CaptureRequiredError;
      const errorText = error instanceof Error ? error.message : String(error);
      await this.repo.updateTask(task.id, {
        status: scopeBlocked || captureBlocked ? 'blocked' : 'failed',
        phase: captureBlocked ? 'capture_required' : scopeBlocked ? 'target_scope_blocked' : 'failed',
        error_message: errorText,
        result_summary: errorText,
        completed_at: now(),
      });
      await this.rememberTaskOutcome(task.id);
      return iterations;
    } finally {
      const terminal = await this.repo.getTask(task.id);
      if(terminal && ['completed','failed','waiting_selection','blocked'].includes(terminal.status)) {
        try {
          const captureCleanup=await interruptBusinessCapturesForTask({db:this.db,repo:this.repo,scanRunId:task.scan_run_id,taskId:task.id});
          const captureCleanupOk=captureCleanup.errors.length===0&&captureCleanup.unresolved_recording_ids.length===0;
          if(captureCleanup.errors.length||captureCleanup.recovered_recordings||captureCleanup.live_interrupted){
            await this.repo.createArtifact({scan_run_id:task.scan_run_id,task_id:task.id,artifact_type:'business_capture_cleanup',title:'Business capture terminal cleanup',
              content_json:{ok:captureCleanupOk,...captureCleanup}});
          }
          if(!captureCleanupOk){
            await this.repo.updateTask(task.id,{status:'failed',phase:'business_capture_cleanup_failed',error_message:captureCleanup.unresolved_recording_ids.length
              ? 'Business capture cleanup left active recordings; inspect business_capture_cleanup.'
              : 'Business capture cleanup reported an error; inspect business_capture_cleanup.'});
          }
        } catch(error) {
          await this.repo.updateTask(task.id,{status:'failed',phase:'business_capture_cleanup_failed',error_message:'Business capture cleanup did not complete.'});
          await this.repo.createArtifact({scan_run_id:task.scan_run_id,task_id:task.id,artifact_type:'business_capture_cleanup',title:'Business capture terminal cleanup failed',content_json:{ok:false,error:String(error)}}).catch(()=>undefined);
        }
        try { await closeTaskBrowserContexts(this.repo,task.scan_run_id,task.id); }
        catch(error) {
          await this.repo.createArtifact({scan_run_id:task.scan_run_id,task_id:task.id,artifact_type:'browser_cleanup',title:'Browser cleanup failed',content_json:{ok:false,error:String(error)}});
          await this.repo.updateTask(task.id,{status:'failed',phase:'browser_cleanup_failed',error_message:'Test browser cleanup did not complete.'});
        }
      }
      // Cover tool failure, exhausted iteration budget and unexpected exceptions.
      // Only the discovery owner releases the device; parallel API tasks do not.
      if (terminal && ['completed', 'failed', 'waiting_selection'].includes(terminal.status) && (task.execution_plan?.intent === 'discover_target' || task.task_type === 'discover_target')) {
        const session = await getLatestMobileSessionForScan(this.db, task.scan_run_id);
        if (session) {
          let cleanup: Record<string, any>;
          try { cleanup = await stopMobileLab(this.db, session.id); }
          catch (error) { cleanup = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
          await this.repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'mobile_cleanup', title: 'Android runtime cleanup', content_json: cleanup });
          const exploring = session.health_json?.execution_profile?.config_json?.acquisition_mode === 'explore';
          const mobileReport = await (exploring ? mobileDiscoveryReport(this.db, session.id) : getMobileTestReport(this.db, session.id)).catch(error => ({ gate_result: 'BLOCK', acceptance_complete: false, evidence_level: 'appium_server_and_proxy_reported_requires_trusted_lab', error: error instanceof Error ? error.message : String(error) }));
          await this.repo.createArtifact({ scan_run_id: task.scan_run_id, task_id: task.id, artifact_type: 'mobile_appium_test_report', title: 'Appium + HTTPS final acceptance', content_json: mobileReport });
          if (terminal.status !== 'failed' && (exploring ? (mobileReport as any).acquisition_complete !== true : mobileReport.evidence_level === 'appium_server_and_proxy_reported_requires_trusted_lab' && mobileReport.acceptance_complete !== true)) await this.repo.updateTask(task.id, { status: 'failed', phase: 'mobile_appium_test_failed', error_message: 'Appium UI/HTTPS acceptance is BLOCK. Inspect mobile_appium_test_report.' });
          if (!cleanup.ok) await this.repo.updateTask(task.id, { status: 'failed', phase: 'mobile_cleanup_failed', error_message: 'Android runtime cleanup requires operator attention; inspect mobile_cleanup artifact.' });
        }
      }
    }
  }
}
