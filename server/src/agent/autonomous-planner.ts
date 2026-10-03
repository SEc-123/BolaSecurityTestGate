import { MANUAL_IDENTITY_INTENT } from '../services/ai-scan/manual-identity-preparation.js';
import { dbGet } from '../db/sql-helpers.js';
import type { DbProvider } from '../types/index.js';
import { AIClient, isRetryableAIProviderError, safeAIProviderFailureSummary } from '../services/ai/ai-client.js';
import type { AIProvider } from '../services/ai/types.js';
import type { AutonomousAgentContext } from './context-builder.js';
import { sanitizeForAIModel } from './model-context-sanitizer.js';
import { agentEventBus } from '../observability/agent-event-bus.js';
import type { AutonomousPlannerResult } from './decision-types.js';
import { AUTONOMOUS_DECISION_SCHEMA } from './decision-types.js';
import { DISCOVERY_COMPLETED_PHASE, isDedicatedWebDiscovery, requiresAutomaticAccounts } from './discovery-task-lifecycle.js';
import { BUSINESS_PLAN_INTENT, BUSINESS_LEARNING_INTENT, BUSINESS_REVIEW_INTENT, BUSINESS_EXPERIMENT_INTENT, MIN_NEGATIVE_COUNTEREXAMPLE_ATTEMPTS, businessExperimentNegativeCounterexampleAttempts, businessLearningAutoExperiments, businessExperimentRevisionRequirement, businessExperimentTerminalDisposition } from './business-task-lifecycle.js';
import { normalObjectiveManifestForTask } from './normal-business-objectives.js';
import { modelDecisionScopeError } from './model-context-profile.js';
import { deriveSelectorRecovery } from './selector-recovery.js';
import { sealedStrictObjectiveBindings } from '../services/ai-scan/agent-business-contract.js';

/** The provider exhausted its own bounded transport retry before returning a
 * decision.  The runtime may make one more decision-only attempt; it must not
 * re-run a tool or persist the upstream response body. */
export class AgentProviderDecisionUnavailableError extends Error {
  constructor() {
    super('AI provider decision is temporarily unavailable');
    this.name = 'AgentProviderDecisionUnavailableError';
  }
}

function normalizeBool(value: any): boolean {
  return value === true || value === 1 || value === '1';
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  if (row)
    return {
      ...row,
      is_enabled: normalizeBool(row.is_enabled),
      is_default: normalizeBool(row.is_default)
    } as AIProvider;

  // Internal relay fallback: credentials remain server-side and are never persisted or returned to the browser.
  const apiKey = process.env.BUILT_IN_FORGE_API_KEY || process.env.OPENAI_API_KEY;
  const configuredBase = process.env.BUILT_IN_FORGE_API_URL || process.env.OPENAI_API_BASE;
  if (!apiKey || !configuredBase) return null;
  const base = configuredBase.replace(/\/+$/, '');
  const normalizedBase = base.endsWith('/v1') ? base : `${base}/v1`;
  return {
    id: 'internal-agent-relay',
    name: 'BSTG Internal Agent Relay',
    provider_type: 'openai_compat',
    base_url: normalizedBase,
    api_key: apiKey,
    model: process.env.BSTG_INTERNAL_AGENT_MODEL || 'gpt-5-mini',
    is_enabled: true,
    is_default: true
  } as AIProvider;
}

function safeJsonParse(text: string): any | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }
  return null;
}

const ALL_VULN_TYPES = ['file_upload', 'file_download', 'path_traversal', 'bola_idor', 'bfla', 'business_logic', 'xss', 'command_injection', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'];

function isAutopilotContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.driving_mode === 'autopilot' || config.auto_start === true || config.selected_scope_strategy === 'all_vulnerability_types';
}

function isAccountAutoExecutionContext(context: AutonomousAgentContext): boolean {
  return requiresAutomaticAccounts(context.scan?.scan_config || {});
}

/** The provider receives a bounded normal-learning history, while lifecycle
 * guards must still evaluate the complete bounded task history. The latter is
 * held as a non-enumerable field by projectContextForModel and is never sent
 * over the model transport. */
function invocationHistory(context: AutonomousAgentContext): Record<string, any>[] {
  return context.lifecycle_tool_invocations || context.task_tool_invocations || [];
}

function invoked(context: AutonomousAgentContext, toolName: string): boolean {
  return invocationHistory(context).some((inv) => inv.tool_name === toolName && inv.status === 'completed');
}

/**
 * A normal-flow Workflow can be replaced by validation with an immutable
 * execution snapshot.  An inspect of an earlier Workflow therefore cannot
 * authorize validation of the current one.  Keep the deterministic hint
 * aligned with that provenance, while leaving assertion and mapping choices
 * to the model.
 */
function inspectedBusinessWorkflow(context: AutonomousAgentContext, workflowId: string): boolean {
  return invocationHistory(context).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.workflow.inspect' && invocation.output_json?.workflow_id === workflowId);
}

function latestInvocation(context: AutonomousAgentContext): any | undefined {
  const invocations = invocationHistory(context);
  return invocations[invocations.length - 1];
}

function latestCompletedToolOutput(context: AutonomousAgentContext, names: string[]): Record<string, any> | undefined {
  for (const invocation of [...invocationHistory(context)].reverse()) {
    if (invocation.status === 'completed' && names.includes(invocation.tool_name) && invocation.output_json && typeof invocation.output_json === 'object') {
      return invocation.output_json as Record<string, any>;
    }
  }
  return undefined;
}

function persistedCaptureStatus(invocation: any): string | undefined {
  const output = invocation?.output_json;
  if (!output || typeof output !== 'object') return undefined;
  const status = output.capture_status ?? output.status ?? output.data?.capture_status ?? output.data?.status;
  return typeof status === 'string' ? status : undefined;
}

function artifactType(artifact: any): string {
  return String(artifact?.type || artifact?.artifact_type || '');
}

function artifactContent(artifact: any): Record<string, any> {
  return artifact?.content_json && typeof artifact.content_json === 'object' ? artifact.content_json : {};
}

function newestContextArtifact(artifacts: any[]): any | undefined {
  return [...artifacts].sort((left, right) => {
    const leftTime = Date.parse(String(left?.created_at || '')) || 0;
    const rightTime = Date.parse(String(right?.created_at || '')) || 0;
    return rightTime - leftTime || Number(artifactContent(right).revision || 0) - Number(artifactContent(left).revision || 0);
  })[0];
}

function currentContextExperimentPlan(artifacts: any[], flowId: string | undefined): any | undefined {
  const plans = artifacts.filter((artifact) => artifactType(artifact) === 'agent_experiment_plan' && artifactContent(artifact).flow_id === flowId);
  const latestById = new Map<string, any>();
  for (const artifact of plans) {
    const id = String(artifactContent(artifact).id || '');
    if (!id) continue;
    const previous = latestById.get(id);
    if (!previous || newestContextArtifact([previous, artifact]) === artifact) latestById.set(id, artifact);
  }
  const parents = new Set([...latestById.values()].map((artifact) => String(artifactContent(artifact).parent_plan_id || '')).filter(Boolean));
  const leaves = [...latestById.entries()].filter(([id]) => !parents.has(id)).map(([, artifact]) => artifact);
  return newestContextArtifact(leaves.length ? leaves : [...latestById.values()]);
}

interface CurrentExperimentState {
  plan?: Record<string, any>;
  result?: Record<string, any>;
  assessment?: Record<string, any>;
  assessed: boolean;
  persisted: boolean;
}

/**
 * Invocation history is a useful audit trail, but it is not authority for the
 * next experiment stage: a model may have revised the same plan after an old
 * compile/execute/assessment.  Prefer the newest append-only artifacts and
 * only use an invocation as a short-lived fallback before context refresh.
 */
function currentExperimentState(context: AutonomousAgentContext): CurrentExperimentState {
  const artifacts = Array.isArray(context.task_artifacts) ? context.task_artifacts : [];
  const planArtifact = currentContextExperimentPlan(artifacts, context.task.execution_plan?.flow_id);
  if (planArtifact) {
    const plan = artifactContent(planArtifact);
    const resultArtifact = newestContextArtifact(artifacts.filter((artifact) => artifactType(artifact) === 'agent_experiment_result' && artifactContent(artifact).plan_id === plan.id && Number(artifactContent(artifact).plan_revision) === Number(plan.revision)));
    const result = resultArtifact ? artifactContent(resultArtifact) : undefined;
    const assessmentArtifact = result ? newestContextArtifact(artifacts.filter((artifact) => artifactType(artifact) === 'agent_experiment_assessment' && artifactContent(artifact).plan_id === plan.id && Number(artifactContent(artifact).plan_revision) === Number(plan.revision) && Number(artifactContent(artifact).result_revision) === Number(result.revision))) : undefined;
    const assessment = assessmentArtifact ? artifactContent(assessmentArtifact) : undefined;
    return {
      plan,
      result,
      assessment,
      assessed: Boolean(assessment),
      persisted: true
    };
  }
  const output = latestCompletedToolOutput(context, ['bstg.test_plan.create', 'bstg.test_plan.compile', 'bstg.test_plan.execute', 'bstg.test_plan.inspect']);
  if (typeof output?.plan_id !== 'string') return { assessed: false, persisted: false };
  return {
    plan: {
      id: output.plan_id,
      revision: Number(output.plan_revision || 0),
      status: output.status
    },
    result: Number.isInteger(output.result_revision)
      ? {
          plan_id: output.plan_id,
          plan_revision: Number(output.plan_revision || 0),
          revision: output.result_revision,
          status: output.result_status || output.status
        }
      : undefined,
    assessed: false,
    persisted: false
  };
}

function experimentLifecycleArtifacts(context: AutonomousAgentContext): Record<string, any>[] {
  return Array.isArray(context.lifecycle_task_artifacts)
    ? context.lifecycle_task_artifacts
    : Array.isArray(context.task_artifacts) ? context.task_artifacts : [];
}

function currentExperimentHasUnavailableReadback(context:AutonomousAgentContext,experiment:CurrentExperimentState,workflowId:string):boolean{
  const codes=experiment.result?.business_proof?.evidence_gaps;
  if(!Array.isArray(codes)||!codes.some((gap:any)=>gap?.failure_code==='authoritative_readback_unavailable'))return false;
  const inspection=[...(context.task_tool_invocations||[])].reverse().find(invocation=>invocation.status==='completed'&&
    invocation.tool_name==='bstg.workflow.inspect'&&String(invocation.output_json?.workflow_id||'')===workflowId);
  const steps=Array.isArray(inspection?.output_json?.steps)?inspection.output_json.steps:[];
  if(!steps.length||!Array.isArray(experiment.plan?.steps))return false;
  const byOrder=new Map(steps.map((step:any)=>[Number(step.step_order),String(step.method||'').toUpperCase()]));
  const selectedOrders=experiment.plan.steps.map((step:any)=>Number(step.source_step_order)).filter(Number.isInteger);
  const writeOrders=selectedOrders.filter((order:number)=>{
    const method=byOrder.get(order);
    return typeof method==='string'&&method.length>0&&!['GET','HEAD','OPTIONS'].includes(method);
  });
  if(!writeOrders.length)return false;
  const lastWriteOrder=Math.max(...writeOrders);
  return !steps.some((step:any)=>Number(step.step_order)>=lastWriteOrder&&['GET','HEAD'].includes(String(step.method||'').toUpperCase()));
}

function latestRecoverableExperimentCompileFailure(context: AutonomousAgentContext): any | undefined {
  return invocationHistory(context).filter(invocation => invocation.tool_name === 'bstg.test_plan.compile' &&
    invocation.status === 'failed' && invocation.output_json?.status === 'experiment_compile_requires_revision').at(-1);
}

function inspectedCurrentExperiment(context: AutonomousAgentContext, state: CurrentExperimentState): boolean {
  const plan = state.plan,
    result = state.result;
  if (!plan || !result) return false;
  return invocationHistory(context).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.test_plan.inspect' && invocation.output_json?.plan_id === plan.id && Number(invocation.output_json?.plan_revision) === Number(plan.revision) && Number(invocation.output_json?.result_revision) === Number(result.revision));
}

function hasSavedBusinessCoverage(context: AutonomousAgentContext): boolean {
  return (context.task_artifacts || []).some((artifact) => artifactType(artifact) === 'business_flow_coverage' && artifactContent(artifact).plan_task_id === context.task.id);
}

function endpointId(context: AutonomousAgentContext, vulnType = ''): string | undefined {
  const plannedTarget = context.task.execution_plan?.workflow_execution_plan?.target_endpoint_id;
  if (plannedTarget) return String(plannedTarget);
  const relevant = context.relevant_endpoints || [];
  const find = (re: RegExp, method?: string) => relevant.find((endpoint) => re.test(String(endpoint.path || endpoint.url || '')) && (!method || String(endpoint.method).toUpperCase() === method));
  if (vulnType === 'business_logic') return (find(/cart|quantity/i, 'GET') || find(/cart|quantity|order|amount|payment|withdraw|transfer/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'bfla') return (find(/admin\/users|admin|manage|role/i) || relevant[relevant.length - 1])?.id;
  if (vulnType === 'bola_idor') return (find(/order|historyorders|withdraw|transfer|wallet|user/i) || relevant[relevant.length - 1])?.id;
  const ids = Array.isArray(context.task.endpoint_ids) ? context.task.endpoint_ids : [];
  return ids[ids.length - 1] || relevant[relevant.length - 1]?.id || context.endpoint_inventory_summary.sample?.[0]?.id;
}

function normalizeDecision(input: any): AutonomousPlannerResult | null {
  if (!input || typeof input !== 'object') return null;
  const action = String(input.action || '').trim();
  if (!['tool_call', 'complete_task', 'fail_task', 'block_task', 'wait_for_user_selection', 'create_child_tasks'].includes(action)) return null;
  const decision: AutonomousPlannerResult = {
    action: action as any,
    tool_name: input.tool_name ? String(input.tool_name) : undefined,
    arguments: input.arguments && typeof input.arguments === 'object' ? input.arguments : {},
    tasks: Array.isArray(input.tasks) ? input.tasks : undefined,
    summary: input.summary ? String(input.summary) : undefined,
    reason: input.reason ? String(input.reason) : undefined,
    rationale: input.rationale ? String(input.rationale) : undefined,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : undefined,
    stop_after_tool_call: Boolean(input.stop_after_tool_call)
  };
  if (decision.action === 'tool_call' && !decision.tool_name) return null;
  if (['fail_task', 'block_task'].includes(decision.action) && !String(decision.reason || decision.summary || '').trim()) return null;
  return decision;
}

function isAndroidContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.surface === 'android' || config.surface_type === 'android' || config.mobile?.platform === 'android' || config.android?.platform === 'android';
}

/** The model sees a structurally projected target URL, while deterministic
 * browser lifecycle prerequisites must retain the server-owned full target.
 * This avoids letting a private capture redaction turn a local navigation into
 * the literal string "[REDACTED]". */
function executionBaseUrl(context: AutonomousAgentContext): string {
  return String(context.execution_base_url || context.scan?.base_url || '');
}

function plannerSystemPrompt(context: AutonomousAgentContext): string {
  const scope = context.model_scope;
  if (scope?.broader_assessment_context_withheld) {
    const planningToolNames =
      scope.stage === 'normal_business_planning'
        ? (context.available_tools || [])
            .map((tool) => String(tool?.name || ''))
            .filter(Boolean)
            .join(', ')
        : '';
    return [
      'You are the BSTG autonomous normal-business verification planner.',
      `Current bounded purpose: ${scope.purpose}`,
      scope.authorization === 'acknowledged' ? 'The operator has recorded authorization for the declared target and the supplied test identities.' : 'No authorization declaration is available in this decision context; do not broaden the current bounded task.',
      'Use only the tools supplied in context.available_tools. An omitted tool is unavailable for this decision.',
      'Your JSON response is also the tool-dispatch protocol: return {"action":"tool_call","tool_name":"<exact listed name>","arguments":{...}} and BSTG invokes it after this turn. Do not wait for a separate function-call channel. A tool listed in context.available_tools is callable in this decision.',
      'Observe and verify normal product behavior before any later persisted stage. Use actual browser observations, ordered captures, native Test Runs, and semantic assertions; do not infer completion from a response code or from a narrative.',
      'For bstg.business.flow.define, role must be exactly "anonymous" or an active/supplied execution identity key. When the immutable objective manifest marks requires_prepared_identity=true, choose an exact safe prepared identity key and never anonymous; if flow.define returns allowed_identity_keys, choose only one of those keys. Do not use a human account name or display label as role.',
      'Before bstg.business.workflow.validate, inspect the Workflow and use only its per-step assertion_paths. Valid paths are status, headers.<observed-header>, and body.<observed-json-field>; bare body, HTML, and text are invalid. A normal business proof needs an observed body field for a goal, identity, or state assertion. For an expected normal value that stays private, use an equals assertion with right.type "captured_baseline"; BSTG resolves the corresponding captured field server-side and exposes no value.',
      'Keep private captures, credentials, and raw dynamic values server-side. Use safe inspection facts and identifiers rather than requesting or copying raw values.',
      'When evidence is insufficient, record the concrete gap or choose another allowed observation/verification action. Do not fabricate a result.',
      ...(scope.stage === 'normal_business_planning'
        ? [
            'This response is the tool-dispatch protocol. To invoke a listed capability, return strict JSON with action "tool_call", its exact tool_name, and arguments; BSTG will execute it after receiving your JSON. There is no separate function-call channel to wait for.',
            `The callable planning capabilities in this turn are: ${planningToolNames || 'none recorded'}. They are available precisely because they appear in context.available_tools; do not describe them as unavailable.`,
            'If page state has not been observed, use browser.navigate or browser.interact first. Then call bstg.business.coverage.inspect. From the returned inventory, you choose the meaningful normal business flows, exact identity keys, prerequisites, and associations with bstg.business.flow.define. Save the complete model-owned coverage list with bstg.business.coverage.save. If flow.define or coverage.save rejects an input, inspect that tool feedback, refresh coverage.inspect, and use the returned target IDs exactly; do not invent replacement IDs. That rejection is a revision loop, not a terminal outcome. Do not emit a free-form block/fail/wait/child-task action; record a genuinely unavailable item as a deferred or blocked coverage entry with its observed reason. Complete only after coverage.save succeeds. The executor can require inventory/coverage evidence but never invents a Flow or chooses its business meaning for you.'
          ]
        : []),
      ...(scope.stage === 'normal_business_learning'
        ? [
            "Do not return block_task for normal business learning. Stop only after capture inspection shows at least one event with semantic_body_path_available=true. After bstg.business.capture.stop, first inspect that stopped recording. Then choose one or more exact returned event_id values and call bstg.business.workflow.prepare with event_ids. This is mandatory: BSTG never defaults to every captured event. Select one causally complete normal transaction: only its prerequisites, intended business operation, and required verification state. Do not retain a repeated one-time state-changing request after its successful occurrence unless you explicitly judge it needed. Task-scoped prepared-login prerequisites remain native executor responsibilities. An assertion-input rejection requires inspect then corrected validate on the same Workflow. For a scheduled coverage retry, keep the capture active until capture.inspect shows at least one candidate event for every scheduled target; if a target is still absent, choose a browser action yourself to reach it and inspect again. workflow.inspect exposes retry_target_assertion_requirements: choose a goal, identity, or state body assertion on one of each target's exact source_step_orders. An assertion on another replayed step cannot prove that target, and the server will reject it before native execution. A first native execution error requires bstg.business.workflow.repair on that exact current workflow_id and test_run_id, then inspect the repaired workflow and choose a fresh validation. If the current task says the repaired path still has a repeated execution error, use execution.execution_failures (step order, status, and fixed error kind only), inspect the stopped capture/current Workflow, and call bstg.business.workflow.revise with the current workflow_id/test_run_id plus the exact observed event_ids you selected and a rationale. The server never chooses or silently drops events; do not use a revision to remove currently bound observed coverage. A separately planned target absent from this stopped recording remains for a fresh retry after native validation. Inspect and validate the new Workflow afresh. Only a server-persisted hard blocker may end the Flow: call bstg.business.flow.block with the current flow_id, the exact blocker artifact ID, and a concrete reason. While recording, browser.navigate and browser.interact use the capture binding when omitted. Do not repeatedly inspect an active capture without an intervening browser operation; after the initial navigation, choose an observed visible UI action yourself. When a browser observation provides controls[].control_ref or assertion_targets[].assertion_ref, reuse an exact supplied candidate. After a selector pre-action rejection, do not invent a replacement selector: choose an exact candidate from the current observation or observe the current page again. An observe, scroll, or selectorless key only refreshes the candidate list; the correction remains active until a selector-based action or assertion succeeds with one current candidate.",
            'After capture.stop, do not navigate, interact with the browser, apply login, or start another capture unless the server explicitly reports a capture_required completion recovery. Such activity would create state outside the sealed recording; inspect it and choose the Workflow event sequence instead.'
          ]
        : []),
      'Return strict JSON only.'
    ].join('\n');
  }
  return [
    'You are the BSTG discovery-first autonomous security testing planner.',
    'Scope: operate only on the operator-declared target, using persisted scan evidence and the supplied test identities. Never expand to another target or assume authority that is not recorded.',
    'Goal: maximize useful vulnerability discovery on the operator-declared target using BSTG tools and evidence artifacts.',
    'First discover and verify the normal business flows, then base further testing on actual evidence. Incomplete evidence cannot confirm a risk; record the gap, inspect the failed outcome and iterate.',
    'Business planning, normal browser recording, native workflow validation and review are explicit task stages. In plan_business_flows, call bstg.business.coverage.inspect and save a model-owned coverage list with bstg.business.coverage.save: every discovered operable feature and endpoint operation must be planned through a saved flow or explicitly deferred/blocked with a concrete reason. A nonempty flow list is not coverage. Do not skip these stages or declare a normal business goal verified without a persisted native Test Run and passing semantic assertions.',
    'For bstg.business.flow.define, role is a literal execution identity key. Use only "anonymous" or an exact active/supplied key; account names, display labels, and aliases are invalid.',
    'Choose observed business operations, parameter mappings and result assertions yourself; deterministic tool suggestions are guidance rather than substitutes for reasoning about the actual site.',
    'For a model_business_experiment task, inspect the verified flow and native Workflow, then use bstg.test_plan.create, bstg.test_plan.compile, bstg.test_plan.execute, bstg.test_plan.inspect, and bstg.test_plan.assess in that order. On create, omit plan_id every time; BSTG generates it. For a corrected child create, set only parent_plan_id to the exact current inspected plan ID. Select every source step using its exact integer step_order from the latest native bstg.workflow.inspect.steps[].step_order, and use the same workflow_step_order fields for patches, bindings, repeats, concurrency and parallel groups. BSTG resolves these orders against the current Workflow; do not invent order values or use asset IDs or request field paths as references. For every patch, copy the exact location and path pair from that step’s observed_patch_targets; use body_patch_location for body fields and do not infer unsupported locations from observed_field_paths. For every response binding, select the exact observed response field/header from an earlier step and the exact observed_patch_targets location/path on a later step; the compiler verifies both against the real verified HTTPS Test Run. Do not invent bindings or use raw values. Use only normal or an exact prepared_identity_roles entry from bstg.business.flow.inspect. You decide the exact selected steps, supported patches, bindings, identities, repeats/concurrency and semantic control/impact assertions from observed structure. Do not copy raw request values into a plan. If compilation returns experiment_compile_requires_revision, use its safe failure_code and summary, inspect that exact failed plan once, then create a fresh child plan. The server pins its parent to the latest inspected compile failure, so do not reuse the failed plan or copy an older parent ID. Never retry compilation on the same plan. The native runtime permits up to two corrected child compilations (three total compile attempts); a third rejection ends the task as failed and cannot be reported as an experiment result. If the current assessment is inconclusive, evidence-insufficient, or requests not_vulnerable without a persisted native counterexample gate, do not complete or reuse its plan_id: create a fresh plan with parent_plan_id set to that current plan, then compile, execute, inspect, and assess the new current revision. A failed experiment is never complete. A blocked experiment may end only when it has an explicit persisted block reason and linked evidence, and must be reported as blocked for human follow-up. A native counterexample or rejected mutation is valid evidence; revise when needed and never call an unproven hypothesis a vulnerability.',
    'For model_business_experiment, the currently executable native lifecycle tool is the only required action for that turn. Before a new plan is created, BSTG may expose one bounded read-only lookup for task-bound object handles or prior memory, then removes those lookups after use. The current verified Flow and Workflow are already bound to the task; do not use scan-wide asset search. Do not spend experiment decisions on repeated inspection or memory writes. This lifecycle scope constrains sequencing only: the model still authors every plan hypothesis, step, patch, identity/binding, repeat/concurrency choice, control/impact assertion, and assessment.',
    'Use the safe business_proof.evidence_gaps codes and summaries from the latest inspection. If authoritative_readback_unavailable is present and bstg.workflow.inspect shows no GET/HEAD step after the selected write, the current Flow cannot prove persistent state and the experiment tools cannot add a source request. Call bstg.test_plan.block with that exact reason_code; do not execute another child plan. If authoritative_readback_assertions_missing is present and an observed GET/HEAD step exists after the write, create one fresh child plan that selects it and adds matching observed-body state assertions for both control and impact. If negative_counterexample_proof_missing persists in three distinct executed child-plan results whose native controls passed, call bstg.test_plan.block with that exact reason_code; the server verifies the attempt lineage and links every result. Do not keep varying replay counts after this gap repeats. A blocked outcome is explicitly unresolved and must never be described as not_vulnerable.',
    'Prefer actions that expand reachable routes, authenticated states, object IDs, workflows, and mutation opportunities.',
    'Plan within context.task.decision_budget; its remaining allowance includes this decision. Reserve a decision to complete, hand off, or explicitly fail the task instead of exploring until the allowance is exhausted.',
    'Your JSON response is the tool-dispatch protocol: return action "tool_call" with an exact name from context.available_tools and matching arguments; BSTG invokes it after this turn. Do not wait for a separate function-call channel. A listed tool is callable.',
    'Return strict JSON only.'
  ].join('\n');
}

function shouldCompleteAfterLastTool(context: AutonomousAgentContext): boolean {
  const last = latestInvocation(context);
  if (!last || last.status !== 'completed') return false;
  return ['bstg.capabilities.inventory', 'browser.discover_target', 'vuln.generate_candidates', 'agent.shared_context.prepare', 'task.expand_selected_vulnerabilities', 'task.summarize_vulnerability_campaign', 'bstg.file_upload.run_test', 'bstg.generic_vuln.run_test', 'bstg.identity.bootstrap_accounts', 'mobile.lab.stop'].includes(last.tool_name);
}

/** A free-form normal-flow block is deliberately out of scope.  Do not fall
 * through to the generic validation hint (which lacks model-selected
 * assertions): first give the next model turn the authoritative Flow state and
 * the rejected proposal so it can choose a supported repair, validation or
 * evidence-backed flow.block action. */
function rejectedNormalLearningTerminalRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult, fallback: AutonomousPlannerResult): AutonomousPlannerResult {
  const flowId = String(context.task.execution_plan?.flow_id || '');
  if (context.model_scope?.stage === 'normal_business_learning' &&
      ['block_task', 'fail_task'].includes(String(proposal.action || '')) && flowId) {
    return {
      action: 'tool_call',
      tool_name: 'bstg.business.flow.inspect',
      arguments: { flow_id: flowId },
      rationale: 'A free-form normal-flow terminal action was rejected. Inspect the persisted Flow and use an evidence-backed blocker, scoped repair, or semantic validation instead.',
      source: 'local_policy'
    };
  }
  return fallback;
}

function businessExperimentAllowedActions(context: AutonomousAgentContext, policyDecision: AutonomousPlannerResult): string[] | undefined {
  if (context.model_scope?.stage !== 'security_experiment') return undefined;
  const terminal = businessExperimentTerminalDisposition(context.task as any, (context.task_artifacts || []) as any);
  if (terminal?.kind === 'blocked') return ['block_task'];
  if (terminal?.kind === 'failed') return ['fail_task'];
  if (policyDecision.action === 'block_task' || policyDecision.action === 'fail_task') return [policyDecision.action];
  if (policyDecision.action === 'complete_task') return ['complete_task'];
  // A verified normal Flow alone is not an experiment result. Until the plan,
  // native runs, and evidence-gated assessment are persisted, the model must
  // continue through the visible experiment tools.
  return ['tool_call'];
}

/** The model owns the experiment contents, while the persisted plan/result
 * state owns which native lifecycle operation is currently executable. Keep
 * unrelated memory and asset tools out of a turn that must advance the
 * experiment. Before plan creation, permit at most one read from each
 * bounded evidence source so the model can inspect object handles without
 * opening an unbounded side-search loop. The current task already binds one
 * verified Flow and its exact native Workflow; scan-wide asset search adds
 * competing IDs without adding experiment evidence. */
export function businessExperimentAllowedToolNames(
  context: AutonomousAgentContext,
  policyDecision: AutonomousPlannerResult,
  allowedActions: string[] | undefined,
): string[] | undefined {
  if (allowedActions === undefined) return undefined;
  if (!allowedActions.includes('tool_call')) return [];
  const experiment=currentExperimentState(context);
  const flow=(context.business_flows||[]).find(item=>item.id===context.task.execution_plan?.flow_id);
  // Once native evidence and the inconclusive assessment establish that this
  // source has no authoritative read-back, expose the evidence-linked block
  // tool as the sole next action. A model decision is still required, but the
  // provider can no longer loop on execute/create or repeat a write.
  if(experiment.assessed&&flow?.workflow_id&&
      currentExperimentHasUnavailableReadback(context,experiment,String(flow.workflow_id))){
    return ['bstg.test_plan.block'];
  }
  if (policyDecision.action !== 'tool_call' || !policyDecision.tool_name || !allowedActions.includes('tool_call')) return [];

  const requiredTool = String(policyDecision.tool_name);
  const allowed = [requiredTool];
  if (requiredTool === 'bstg.test_plan.create' && !currentExperimentState(context).plan) {
    for (const optionalRead of ['bstg.business.object_handles.inspect', 'agent.memory.query']) {
      if (!invoked(context, optionalRead)) allowed.push(optionalRead);
    }
  }
  return [...new Set(allowed)];
}

/** A business experiment cannot be ended by a provider assertion. If the
 * provider proposes a terminal action before the persisted experiment gate
 * allows it, preserve its rejected receipt and either refresh current native
 * structure or ask the model for a concrete experiment-tool decision. */
function businessExperimentProposalRecovery(
  context: AutonomousAgentContext,
  proposal: AutonomousPlannerResult,
  fallback: AutonomousPlannerResult,
  allowedActions: string[] | undefined,
  allowedToolNames: string[] | undefined,
): { decision: AutonomousPlannerResult; reason: string } | undefined {
  if (allowedActions === undefined) return undefined;
  const actionAllowed = allowedActions.includes(String(proposal.action || ''));
  const toolAllowed = proposal.action !== 'tool_call' || (allowedToolNames || []).includes(String(proposal.tool_name || ''));
  if (actionAllowed && toolAllowed) return undefined;

  if (allowedActions.includes(String(fallback.action || '')) && fallback.action !== 'tool_call') {
    return {
      decision: fallback,
      reason: 'The provider terminal action did not match the current server-persisted experiment disposition; use the evidence-backed disposition already recorded by BSTG.',
    };
  }
  const safeRefreshTools = new Set(['bstg.business.flow.inspect', 'bstg.workflow.inspect', 'bstg.business.object_handles.inspect']);
  const decision = fallback.action === 'tool_call' && safeRefreshTools.has(String(fallback.tool_name || ''))
    ? fallback
    : {
        action: 'model_decision_required' as const,
        summary: 'The current business experiment has no persisted terminal evidence yet.',
        rationale: 'Choose a listed bstg.test_plan.* tool and design the experiment from the verified Flow and native Workflow. Do not end the task with a free-form block, failure, or completion claim; BSTG will allow a terminal action only after its evidence gate is satisfied.',
        source: 'local_policy' as const,
      };
  return {
    decision,
    reason: 'The proposed business-experiment action is not supported by the current persisted native evidence; continue with a listed experiment tool.',
  };
}

/** An evidence-less dedicated Flow block is recorded as a failed tool call so
 * the model can recover, but recovery has a strict first step: refresh the
 * server-owned Flow state.  Without this guard a provider could spend the next
 * turn repeating the same block, claiming completion, or terminalizing the
 * task before it sees the rejection and current evidence.  Once this exact
 * inspection succeeds, normal model ownership resumes for the following turn. */
function normalFlowBlockEvidenceProposalRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult): { decision: AutonomousPlannerResult; reason: string } | undefined {
  if (context.model_scope?.stage !== 'normal_business_learning' || String(context.task.phase || '') !== 'normal_flow_block_requires_adaptation') return undefined;
  const flowId = String(context.task.execution_plan?.flow_id || '');
  if (!flowId) return undefined;
  const last = latestInvocation(context);
  const inspectedCurrentFlow = last?.status === 'completed' && last.tool_name === 'bstg.business.flow.inspect' && String(last.output_json?.flow_id || '') === flowId;
  const requestedCurrentInspection = proposal.action === 'tool_call' && proposal.tool_name === 'bstg.business.flow.inspect' && String(proposal.arguments?.flow_id || '') === flowId;
  if (inspectedCurrentFlow || requestedCurrentInspection) return undefined;
  return {
    decision: {
      action: 'tool_call',
      tool_name: 'bstg.business.flow.inspect',
      arguments: { flow_id: flowId },
      rationale: 'The prior normal-flow blocker lacked valid current evidence. Refresh the persisted Flow before choosing any further block, completion, or repair action.',
      source: 'local_policy'
    },
    reason: 'An evidence-less normal-flow block requires a completed inspection of the current server-owned Flow before another model decision can change or end the task.'
  };
}

/** Planning retains model ownership of flow meaning.  When the provider emits
 * an unsupported terminal response (often because it mistook a JSON action
 * protocol for an absent function-calling channel), recover only with a fresh
 * inventory read.  We never manufacture a Flow, role, prerequisite, or
 * coverage disposition in this path. */
function normalBusinessPlanningProposalRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult): { decision: AutonomousPlannerResult; reason: string } | undefined {
  if (context.model_scope?.stage !== 'normal_business_planning') return undefined;
  const coverageSaved = hasSavedBusinessCoverage(context);
  if (proposal.action === 'complete_task' && coverageSaved) return undefined;
  if (proposal.action === 'tool_call') return undefined;
  const reason = proposal.action === 'complete_task' ? 'Normal-business planning cannot complete before the model saves a coverage list. The prior tool inventory remains callable; inspect it and save model-owned flow coverage.' : 'Normal-business planning accepts executable tool decisions only. The listed planning tools are callable through the JSON tool_call protocol; inspect the coverage inventory and then choose the flow and coverage meaning.';
  return {
    decision: {
      action: 'tool_call',
      tool_name: 'bstg.business.coverage.inspect',
      arguments: {},
      rationale: 'A non-executable planning proposal was rejected. Refresh the discovered coverage inventory; the next model turn must choose its own flows and coverage entries from observed facts.',
      source: 'local_policy'
    },
    reason
  };
}

function normalBusinessPlanningScopeRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult): AutonomousPlannerResult | undefined {
  if (context.model_scope?.stage !== 'normal_business_planning') return undefined;
  return {
    action: 'tool_call',
    tool_name: 'bstg.business.coverage.inspect',
    arguments: {},
    rationale: `The proposed ${proposal.action === 'tool_call' ? `tool ${String(proposal.tool_name || 'unknown')}` : 'action'} is outside the planning protocol. Refresh the actual coverage inventory before the next model-selected flow/coverage decision.`,
    source: 'local_policy'
  };
}

/**
 * Once a repaired native path repeated the same execution failure, the only
 * allowed next mutation is a model-selected observed-event revision. Keeping
 * validation/repair/browser tools available here caused failed revisions to
 * fall back into the same stale workflow loop. This guard does not choose an
 * event, rationale, or subset; it simply rejects every other action until the
 * model supplies its own revision proposal.
 */
function normalBusinessRevisionProposalRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult): { decision: AutonomousPlannerResult; reason: string } | undefined {
  if (context.model_scope?.stage !== 'normal_business_learning' ||
      context.task.phase !== 'normal_validation_repeated_execution_error_requires_model_revision') return undefined;
  if (proposal.action === 'tool_call' && proposal.tool_name === 'bstg.business.workflow.revise') return undefined;
  return {
    decision: {
      action: 'model_decision_required',
      summary: 'The repeated native execution recovery still requires a model-selected Workflow revision.',
      rationale: 'Return bstg.business.workflow.revise with the current workflow_id, test_run_id, a nonempty subset of current workflow-eligible event IDs, and a rationale. Use any transaction prerequisite groups returned by the prior capture inspection; BSTG will not choose those IDs for you.',
      source: 'local_policy'
    },
    reason: 'A repeated native execution error accepts only bstg.business.workflow.revise until a new model-selected Workflow revision is published.'
  };
}

/** A protocol misunderstanding before a native stage has observed anything is
 * recoverable. These repairs execute only the stage's fact-gathering first
 * step; they do not choose product semantics, business flows, or test inputs
 * for the model. Once a native observation exists, the model can report a
 * concrete evidence-backed terminal state through the normal lifecycle. */
function scopedToolProtocolRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult, fallback: AutonomousPlannerResult): { decision: AutonomousPlannerResult; reason: string } | undefined {
  const stage = context.model_scope?.stage;
  if (stage === 'capability_inventory' && !invoked(context, 'bstg.capabilities.inventory')) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.capabilities.inventory',
        arguments: {},
        rationale: 'The provider proposed a terminal state before the required native capability inventory. Invoke the listed inventory tool and return its persisted facts to the next model turn.',
        source: 'local_policy'
      },
      reason: 'The native capability inventory has not been invoked. Its listed JSON tool_call is executable; a free-form availability claim cannot replace the persisted inventory fact.'
    };
  }
  if (stage === 'normal_discovery' && ['block_task', 'fail_task', 'complete_task'].includes(String(proposal.action || '')) && !(invocationHistory(context) || []).some((invocation) => invocation.status === 'completed')) {
    return {
      decision: fallback,
      reason: 'Normal discovery cannot end before a listed browser/discovery tool has produced an observed fact. The JSON tool_call protocol is executable; invoke an initial observation before declaring a terminal state.'
    };
  }
  return undefined;
}

function captureBoundBrowserArguments(flow: any): Record<string, any> {
  return {
    ...(flow?.recording_context_key ? { context_key: flow.recording_context_key } : {}),
    ...(flow?.recording_context_scope ? { context_scope: flow.recording_context_scope } : {}),
    ...(flow?.recording_identity_key ? { identity_key: flow.recording_identity_key } : {})
  };
}

/** A coverage retry retains its parent evidence for audit, so the Flow can
 * still point to the parent's old recording when the child begins. That old
 * pointer must never satisfy the child's browser prerequisites. */
function coverageRetryNeedsFreshCapture(context: AutonomousAgentContext, flow: any): boolean {
  const retry = context.task.execution_plan?.coverage_retry;
  if (!retry || !Array.isArray(retry.targets) || retry.targets.length === 0 || !flow?.id) return false;
  return !(invocationHistory(context) || []).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.start' && String(invocation.output_json?.flow_id || '') === String(flow.id) && typeof invocation.output_json?.recording_session_id === 'string' && invocation.output_json.recording_session_id.length > 0);
}

/** This state is written only by terminal reconciliation after the retry's
 * own native proof missed a server-scheduled target. The forced step starts a
 * new environment capture; it never selects browser controls, events, or
 * semantic assertions for the model. */
export function coverageRetryCompletionRecoveryRequired(context: AutonomousAgentContext): boolean {
  const retry = context.task.execution_plan?.coverage_retry;
  return Boolean(retry && retry.completion_recovery?.status === 'capture_required');
}

function captureStartIndex(context: AutonomousAgentContext, recordingSessionId: string): number {
  let index = -1;
  for (const [position, invocation] of (invocationHistory(context) || []).entries()) {
    if (invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.start' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId) index = position;
  }
  return index;
}

function browserActionAfter(context: AutonomousAgentContext, index: number): boolean {
  return (invocationHistory(context) || []).slice(Math.max(0, index + 1)).some((invocation) => invocation.status === 'completed' && (invocation.tool_name === 'browser.navigate' || invocation.tool_name === 'browser.interact'));
}

/** A capture refresh follows an actual model-selected browser attempt, not a
 * passive observation. This keeps multi-step UI ownership with the model while
 * preventing a missing-evidence action from being followed by another write
 * without first reading the updated safe inventory. */
function isMaterialBrowserAction(invocation: any): boolean {
  if (invocation?.status !== 'completed') return false;
  if (invocation.tool_name === 'browser.navigate') return true;
  if (invocation.tool_name !== 'browser.interact') return false;
  const operation = invocation.input_json?.operation;
  return (
    (typeof operation?.control_ref === 'string' ||
      typeof operation?.assertion_ref === 'string' ||
      // Legacy private rows remain locally interpretable during migration.
      typeof operation?.selector === 'string') &&
    ['click', 'fill', 'select', 'press', 'assert'].includes(String(operation.action || ''))
  );
}

/** Filling or selecting a live form control is a locally observable setup
 * transition, but it cannot by itself create a HTTP business event. Keep a
 * small model-owned preparation window so a model can complete a form before
 * the capture rail asks it to inspect traffic. This never records a control
 * reference or a field value. */
const MAX_CONSECUTIVE_FORM_PREPARATION_ACTIONS = 4;

function isSuccessfulFormPreparationAction(invocation: any): boolean {
  if (invocation?.status !== 'completed' || invocation.tool_name !== 'browser.interact') return false;
  const operation = invocation.input_json?.operation;
  const reference = typeof operation?.control_ref === 'string' || typeof operation?.selector === 'string';
  if (!reference || !['fill', 'select'].includes(String(operation?.action || ''))) return false;
  const output = invocation.output_json || {};
  // Older persisted rows did not expose `ok`; a completed invocation still
  // represents a dispatched legacy form action. New opaque-reference actions
  // must explicitly report success before they extend the preparation window.
  return output.ok === undefined || output.ok === true;
}

function consecutiveFormPreparationActionsAfter(context: AutonomousAgentContext, afterIndex: number): number {
  const history = invocationHistory(context) || [];
  let count = 0;
  for (let index = history.length - 1; index > afterIndex; index -= 1) {
    const invocation = history[index];
    if (isSuccessfulFormPreparationAction(invocation)) {
      count += 1;
      continue;
    }
    // Lifecycle reads do not break an immediately preceding form sequence.
    if (invocation?.tool_name === 'bstg.business.capture.inspect') continue;
    if (invocation?.status === 'completed' && (invocation.tool_name === 'browser.navigate' || invocation.tool_name === 'browser.interact')) break;
  }
  return count;
}

function proposalContinuesPreparedForm(proposal: AutonomousPlannerResult): boolean {
  if (proposal.action !== 'tool_call' || proposal.tool_name !== 'browser.interact') return false;
  const operation = proposal.arguments?.operation;
  const reference = typeof operation?.control_ref === 'string' || typeof operation?.selector === 'string';
  // The final submit/continue is part of the same bounded form sequence. It
  // remains a model-selected opaque control and is followed by the normal
  // capture refresh before any further interaction.
  return reference && ['fill', 'select', 'click', 'press'].includes(String(operation?.action || ''));
}

function isReadOnlyBrowserAction(invocation: any): boolean {
  if (invocation?.status !== 'completed' || invocation.tool_name !== 'browser.interact') return false;
  const operation = invocation.input_json?.operation;
  const action = String(operation?.action || '');
  const reference = typeof operation?.control_ref === 'string' ? operation.control_ref : typeof operation?.assertion_ref === 'string' ? operation.assertion_ref : typeof operation?.selector === 'string' ? operation.selector : '';
  return action === 'observe' || action === 'scroll' || (action === 'press' && !reference);
}

function readOnlyBrowserActionsSinceLatestMaterial(context: AutonomousAgentContext, captureStart: number): number {
  let count = 0;
  for (const invocation of (invocationHistory(context) || []).slice(Math.max(0, captureStart + 1))) {
    if (isMaterialBrowserAction(invocation)) count = 0;
    else if (isReadOnlyBrowserAction(invocation)) count += 1;
  }
  return count;
}

function proposalIsReadOnlyBrowserAction(proposal: AutonomousPlannerResult): boolean {
  if (proposal.action !== 'tool_call' || proposal.tool_name !== 'browser.interact') return false;
  const operation = proposal.arguments?.operation;
  const action = String(operation?.action || '');
  const reference = typeof operation?.control_ref === 'string' ? operation.control_ref : typeof operation?.assertion_ref === 'string' ? operation.assertion_ref : typeof operation?.selector === 'string' ? operation.selector : '';
  return action === 'observe' || action === 'scroll' || (action === 'press' && !reference);
}

function materialBrowserActionAfter(context: AutonomousAgentContext, index: number): boolean {
  return (invocationHistory(context) || []).slice(Math.max(0, index + 1)).some(isMaterialBrowserAction);
}

/** This comparison stays entirely inside the planner. It intentionally derives
 * its key only from bounded, post-action UI structure. A model proposal's
 * action, selector, key, URL, value, and DOM identifiers cannot manufacture a
 * progress transition. The key never leaves this function; only its numeric
 * transition count is persisted. */
function localObservedBrowserStateKey(invocation: any): string | undefined {
  const output = invocation?.output_json || {};
  const observation = output?.observation || output?.data?.observation || {};
  const domSummary = output?.dom_summary || output?.data?.dom_summary || {};
  // These are already finite, server-authored observation classes. Including
  // them distinguishes a meaningful UI transition such as profile → cart
  // without admitting page text, hrefs, selectors, IDs, or control refs into
  // the private progress discriminator.
  const intents = new Set(['authenticate', 'continue', 'submit', 'cancel', 'add', 'review', 'confirm', 'checkout', 'search', 'navigation', 'generic']);
  const navigationTargets = new Set(['profile', 'cart', 'notes', 'settings', 'orders', 'checkout', 'search', 'home', 'authentication', 'other']);
  const compactNodes = (nodes: any[]) =>
    (Array.isArray(nodes) ? nodes : []).slice(0, 32).map((node) => ({
      tag: typeof node?.tag === 'string' ? node.tag : '',
      role: typeof node?.role === 'string' ? node.role : '',
      type: typeof node?.type === 'string' ? node.type : '',
      intent: typeof node?.intent === 'string' && intents.has(node.intent) ? node.intent : '',
      navigation_target: typeof node?.navigation_target === 'string' && navigationTargets.has(node.navigation_target) ? node.navigation_target : '',
      disabled: node?.disabled === true,
      in_dialog: node?.in_dialog === true,
      receives_pointer: node?.receives_pointer === true
    }));
  const controls = compactNodes(observation?.controls);
  const assertionTargets = compactNodes(observation?.assertion_targets);
  if (controls.length || assertionTargets.length) {
    return JSON.stringify({ controls, assertion_targets: assertionTargets });
  }
  // Navigation returns a bounded DOM summary rather than interaction controls.
  // Keep only counts and input types so page text, URLs, field names and other
  // source material cannot affect the in-memory transition discriminator.
  const forms = Array.isArray(domSummary?.forms)
    ? domSummary.forms.slice(0, 32).map((form: any) => ({
        input_types: Array.isArray(form?.inputs) ? form.inputs.slice(0, 32).map((input: any) => (typeof input?.type === 'string' ? input.type : '')) : []
      }))
    : [];
  const buttonCount = Array.isArray(domSummary?.buttons) ? Math.min(32, domSummary.buttons.length) : 0;
  if (forms.length || buttonCount) return JSON.stringify({ forms, button_count: buttonCount });
  return undefined;
}

function browserStateProgressCount(context: AutonomousAgentContext, recordingSessionId: string): number {
  const start = captureStartIndex(context, recordingSessionId);
  const observedStates = new Set<string>();
  for (const invocation of (invocationHistory(context) || []).slice(Math.max(0, start + 1))) {
    if (!isMaterialBrowserAction(invocation)) continue;
    const current = localObservedBrowserStateKey(invocation);
    // An action without a post-action structural observation cannot establish
    // progress. It may still trigger the mandatory capture refresh, but cannot
    // replenish the bounded no-progress episode. Each observed safe state
    // counts once, so an A → B → A selector cycle cannot reopen the episode.
    if (current) observedStates.add(current);
  }
  return observedStates.size;
}

function captureNavigationAfter(context: AutonomousAgentContext, index: number): boolean {
  return (invocationHistory(context) || []).slice(Math.max(0, index + 1)).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'browser.navigate');
}

function requiresPreparedCaptureLogin(flow: any): boolean {
  return Boolean(flow?.role) && flow.role !== 'anonymous' && flow.recording_context_scope === 'task';
}

/** A safe login outcome can be unsuccessful (for example, MFA or missing
 * test credentials). It still counts as the one deterministic setup attempt;
 * the model then receives the persisted result and must use the normal blocker
 * route rather than looping credential application. */
function preparedCaptureLoginAttemptedAfter(context: AutonomousAgentContext, index: number, recordingSessionId: string): boolean {
  return (invocationHistory(context) || []).slice(Math.max(0, index + 1)).some((invocation) => invocation.tool_name === 'bstg.identity.apply_login' && String(invocation.output_json?.recording_session_id || recordingSessionId) === recordingSessionId);
}

/** A successful prepared login replaces the live document and its opaque UI
 * references.  Require one new read-only observation before the model may
 * inspect capture evidence or choose an authenticated action. */
function successfulPreparedCaptureLoginIndex(context: AutonomousAgentContext, index: number, recordingSessionId: string): number {
  let loginIndex = -1;
  for (const [position, invocation] of (invocationHistory(context) || []).entries()) {
    if (position <= index || invocation?.status !== 'completed') continue;
    if (invocation?.tool_name !== 'bstg.identity.apply_login') continue;
    if (String(invocation.output_json?.recording_session_id || recordingSessionId) !== recordingSessionId) continue;
    if (invocation.output_json?.authenticated === true) loginIndex = position;
  }
  return loginIndex;
}

function observedBrowserStateAfter(context: AutonomousAgentContext, index: number): boolean {
  return (invocationHistory(context) || []).slice(Math.max(0, index + 1)).some((invocation) => invocation?.status === 'completed' && invocation?.tool_name === 'browser.interact' && invocation?.input_json?.operation?.action === 'observe');
}

function captureStopped(context: AutonomousAgentContext, recordingSessionId: string): boolean {
  return (invocationHistory(context) || []).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.stop' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId && persistedCaptureStatus(invocation) === 'stopped');
}

function inspectedStoppedCapture(context: AutonomousAgentContext, recordingSessionId: string): boolean {
  return (invocationHistory(context) || []).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId && String(invocation.output_json?.status || '') === 'stopped');
}

function lastInvocationIndex(context: AutonomousAgentContext, predicate: (invocation: any) => boolean): number {
  const history = invocationHistory(context) || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (predicate(history[index])) return index;
  }
  return -1;
}

function lastStoppedCaptureInspectionIndex(context: AutonomousAgentContext, recordingSessionId: string): number {
  return lastInvocationIndex(context, (invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId && persistedCaptureStatus(invocation) === 'stopped');
}

function lastWorkflowPreparationIndex(context: AutonomousAgentContext): number {
  return lastInvocationIndex(context, (invocation) => invocation.tool_name === 'bstg.business.workflow.prepare');
}

const MAX_UNCHANGED_ACTIVE_CAPTURE_INSPECTIONS = 2;
const MAX_CONSECUTIVE_READ_ONLY_CAPTURE_ACTIONS = 1;
/** A model may not spend the whole task allowance re-reading unchanged capture
 * evidence. This is a finite protocol category, never a model-derived label. */
export const NORMAL_CAPTURE_INSPECTION_NO_PROGRESS = 'normal_capture_inspection_no_progress';

function captureInspectionEventCount(invocation: any): number | undefined {
  const output = invocation?.output_json;
  const value = output?.event_count ?? output?.data?.event_count;
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Inspection exposes only this boolean and opaque event IDs. The planner must
 * never infer semantic proof from a navigation, status code, or private body. */
function inspectionHasSemanticBodyCandidate(invocation: any): boolean {
  const output = invocation?.output_json || invocation?.data || {};
  const data = output?.data || output;
  const events = Array.isArray(data.events) ? data.events : [];
  return events.some((event: any) => typeof event?.event_id === 'string' && event.event_id && typeof event?.action_id === 'string' && event.action_id && event.semantic_body_path_available === true);
}

/** The completion contract is a server-owned field-shape requirement.  These
 * paths are deliberately structural only: they never include the captured
 * value, a UI selector, or an event choice for the model. */
function objectiveCompletionRequiredPaths(flow: any): string[] {
  const paths = flow?.objective_completion?.required_response_paths;
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.filter((path: unknown) => typeof path === 'string' && /^body\.[a-z0-9_.\[\]-]{1,500}$/i.test(path)))].slice(0, 24);
}

function objectiveCompletionCandidateCount(invocation: any): number {
  const output = invocation?.output_json || invocation?.data || {};
  const data = output?.data || output;
  const candidates = data?.objective_completion?.completion_candidate_event_ids;
  return Array.isArray(candidates) ? candidates.filter((id: unknown) => typeof id === 'string' && id.length > 0).length : 0;
}

type ObjectiveOperationContract = {
  operation_id: string;
  side_effect_class: 'authentication' | 'update' | 'add' | 'create' | 'transaction' | 'write';
};

const NAVIGATION_TARGET_CLASSES = new Set(['profile', 'cart', 'notes', 'settings', 'orders', 'checkout', 'search', 'home', 'authentication', 'other']);
const CONTROL_INTENT_CLASSES = new Set(['authenticate', 'continue', 'submit', 'cancel', 'add', 'review', 'confirm', 'checkout', 'search', 'navigation', 'generic']);

/** These are optional, finite navigation suggestions derived from a sealed
 * operation class. They focus a model after an evidence-free action without
 * choosing a page, a control reference, or a business event on its behalf. */
function objectiveNavigationHints(operation?: ObjectiveOperationContract): string[] {
  switch (operation?.side_effect_class) {
    case 'authentication': return ['authentication'];
    case 'update': return ['profile', 'settings'];
    case 'add': return ['cart'];
    case 'create': return ['notes'];
    case 'transaction': return ['cart', 'checkout'];
    default: return [];
  }
}

function currentObservedControl(context: AutonomousAgentContext, reference: string): Record<string, any> | undefined {
  for (const invocation of [...(invocationHistory(context) || [])].reverse()) {
    const output = invocation?.output_json || {};
    const observation = output?.observation || output?.data?.observation;
    const controls = Array.isArray(observation?.controls) ? observation.controls : [];
    const control = controls.find((candidate: any) => candidate && candidate.control_ref === reference);
    if (control) return control;
  }
  return undefined;
}

/** The newest browser observation is the only place a provider may select a
 * live opaque control.  This helper deliberately returns local-only records:
 * callers below collapse them to closed intent/form facts before any recovery
 * receipt is persisted. */
function latestObservedControls(context: AutonomousAgentContext): Record<string, any>[] {
  for (const invocation of [...(invocationHistory(context) || [])].reverse()) {
    const output = invocation?.output_json || {};
    const observation = output?.observation || output?.data?.observation;
    if (Array.isArray(observation?.controls)) return observation.controls.filter((candidate: any) => candidate && typeof candidate === 'object');
  }
  return [];
}

function observedControlBeforeInvocation(history: any[], beforeIndex: number, reference: string): Record<string, any> | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const output = history[index]?.output_json || {};
    const observation = output?.observation || output?.data?.observation;
    const controls = Array.isArray(observation?.controls) ? observation.controls : [];
    const control = controls.find((candidate: any) => candidate && candidate.control_ref === reference);
    if (control) return control;
  }
  return undefined;
}

function observedControlIntent(control: any): string | undefined {
  const intent = typeof control?.intent === 'string' ? control.intent : '';
  return CONTROL_INTENT_CLASSES.has(intent) ? intent : undefined;
}

/** A semantic receipt is trustworthy only when the recorder has linked it to
 * the exact server-created action ID.  The action ID and body values never
 * leave this local comparison; callers receive at most a finite intent. */
function actionProducedSemanticCaptureEvent(context: AutonomousAgentContext, recordingSessionId: string, actionIndex: number): boolean {
  const history = invocationHistory(context) || [];
  const actionOutput = history[actionIndex]?.output_json || {};
  const actionId = typeof actionOutput?.action_id === 'string'
    ? actionOutput.action_id
    : typeof actionOutput?.data?.action_id === 'string' ? actionOutput.data.action_id : '';
  if (!actionId) return false;
  for (let index = actionIndex + 1; index < history.length; index += 1) {
    const invocation = history[index];
    if (invocation?.status !== 'completed' || invocation?.tool_name !== 'bstg.business.capture.inspect' ||
        String(invocation?.output_json?.recording_session_id || invocation?.output_json?.data?.recording_session_id || '') !== recordingSessionId) continue;
    const output = invocation.output_json || {};
    const data = output?.data || output;
    const events = Array.isArray(data?.events) ? data.events : [];
    if (events.some((event: any) => event?.semantic_body_path_available === true && String(event?.action_id || '') === actionId)) return true;
  }
  return false;
}

function hasTrustedSemanticIntentEffect(context: AutonomousAgentContext, recordingSessionId: string, intent: string): boolean {
  const history = invocationHistory(context) || [];
  const start = captureStartIndex(context, recordingSessionId);
  for (let index = Math.max(0, start + 1); index < history.length; index += 1) {
    const invocation = history[index];
    if (!isMaterialBrowserAction(invocation) || invocation?.tool_name !== 'browser.interact') continue;
    const reference = typeof invocation?.input_json?.operation?.control_ref === 'string'
      ? invocation.input_json.operation.control_ref : '';
    const control = reference ? observedControlBeforeInvocation(history, index, reference) : undefined;
    if (observedControlIntent(control) !== intent) continue;
    if (actionProducedSemanticCaptureEvent(context, recordingSessionId, index)) return true;
  }
  return false;
}

const TRANSACTION_PREREQUISITE_INTENTS = ['add', 'review', 'confirm'] as const;
const TRANSACTION_INTERACTION_ACTIONS = ['click', 'fill', 'select', 'press'] as const;
const TRANSACTION_PREREQUISITE_PROPOSAL_CLASSES = [
  'wrong_tool',
  'missing_control_ref',
  'unknown_control_ref',
  'ineligible_control',
  'required_control_not_clicked',
  'unrelated_control',
  'preparation_action_incompatible',
  'preparation_wrong_form',
  'accepted',
] as const;
type TransactionPrerequisiteProposalClass = typeof TRANSACTION_PREREQUISITE_PROPOSAL_CLASSES[number];

/** Use one eligibility predicate for finite candidate counts, the focused
 * provider view, and pre-dispatch validation. Otherwise a model could see a
 * disabled or obscured candidate that the browser cannot safely execute. */
function isEligibleTransactionControl(control: any): boolean {
  return typeof control?.control_ref === 'string' && control.control_ref.length > 0 &&
    control.disabled !== true && control.receives_pointer !== false;
}

function transactionControlFormIndex(control: any): number | undefined {
  return Number.isInteger(control?.form_index) ? Number(control.form_index) : undefined;
}

function hasTransactionPreparationShape(control: any): boolean {
  const tag = String(control?.tag || '').toLowerCase();
  const type = String(control?.type || '').toLowerCase();
  return tag === 'textarea' || tag === 'select' ||
    (tag === 'input' && !['button', 'checkbox', 'file', 'hidden', 'image', 'radio', 'reset', 'submit'].includes(type));
}

function isTransactionPreparationField(control: any): boolean {
  return isEligibleTransactionControl(control) && hasTransactionPreparationShape(control);
}

function transactionPreparationActionIsCompatible(control: any, action: string): boolean {
  if (!isTransactionPreparationField(control)) return false;
  const tag = String(control?.tag || '').toLowerCase();
  if (action === 'fill') return tag === 'input' || tag === 'textarea';
  if (action === 'select') return tag === 'select';
  return action === 'press' && ['input', 'textarea', 'select'].includes(tag);
}

/**
 * A transaction can expose several opaque submit controls at once.  Work out
 * only its finite, current prerequisite stage from (a) live control intent
 * classes and (b) action-bound semantic receipts.  This does not select a
 * control or assume a route: the provider still chooses an exact current ref,
 * field value, and later capture/Workflow evidence.
 */
function transactionPrerequisiteControlIntents(context: AutonomousAgentContext, recordingSessionId: string, operation?: ObjectiveOperationContract): string[] {
  if (operation?.side_effect_class !== 'transaction') return [];
  const controls = latestObservedControls(context).filter(isEligibleTransactionControl);
  for (const intent of TRANSACTION_PREREQUISITE_INTENTS) {
    if (controls.some(control => observedControlIntent(control) === intent) &&
        !hasTrustedSemanticIntentEffect(context, recordingSessionId, intent)) return [intent];
  }
  return [];
}

/** Keep the provider-facing transaction requirement auditable without
 * projecting the candidates themselves. The model still receives the opaque
 * candidates in its current browser observation and makes the exact choice;
 * this count only distinguishes "choose one now" from "refresh first". */
function eligibleCurrentTransactionControlCounts(context: AutonomousAgentContext, requiredIntents: string[]): Record<string, number> {
  const controls = latestObservedControls(context).filter(isEligibleTransactionControl);
  return Object.fromEntries(requiredIntents
    .filter(intent => TRANSACTION_PREREQUISITE_INTENTS.includes(intent as typeof TRANSACTION_PREREQUISITE_INTENTS[number]))
    .map(intent => [intent, controls.filter(control => observedControlIntent(control) === intent).length]));
}

/** A structured, per-turn reminder for a finite transaction stage. It is
 * deliberately stricter than prose but never chooses a reference, field
 * value, event, mapping, or assertion for the provider. */
function currentNormalBrowserRequirement(context: AutonomousAgentContext, policyDecision: AutonomousPlannerResult): Record<string, unknown> | undefined {
  if (context.model_scope?.stage !== 'normal_business_learning' || policyDecision.action !== 'model_decision_required') return undefined;
  const flow = (context.business_flows || []).find((item) => item.id === context.task.execution_plan?.flow_id);
  const recordingSessionId = String(flow?.recording_session_id || '');
  const operation = objectiveOperationContract(flow);
  if (!flow || !recordingSessionId || operation?.side_effect_class !== 'transaction') return undefined;
  const inspectionIndex = lastActiveCaptureInspectionIndex(context, recordingSessionId);
  const inspection = inspectionIndex >= 0 ? (invocationHistory(context) || [])[inspectionIndex] : undefined;
  if (!inspection || browserActionAfter(context, inspectionIndex)) return undefined;
  const completionMissing = objectiveCompletionRequiredPaths(flow).length > 0 && objectiveCompletionCandidateCount(inspection) === 0;
  const operationMissing = objectiveOperationCandidateCount(inspection) === 0;
  if (!completionMissing && !operationMissing) return undefined;
  const requiredControlIntents = transactionPrerequisiteControlIntents(context, recordingSessionId, operation);
  if (!requiredControlIntents.length) return undefined;
  const eligibleCurrentControlCounts = eligibleCurrentTransactionControlCounts(context, requiredControlIntents);
  if (!Object.values(eligibleCurrentControlCounts).some(count => count > 0)) return undefined;
  const previousProposalClass = typeof context.planner_state?.normal_capture_inspection_recovery?.transaction_prerequisite_proposal_class === 'string' &&
    TRANSACTION_PREREQUISITE_PROPOSAL_CLASSES.includes(context.planner_state.normal_capture_inspection_recovery.transaction_prerequisite_proposal_class as TransactionPrerequisiteProposalClass) &&
    context.planner_state.normal_capture_inspection_recovery.transaction_prerequisite_proposal_class !== 'accepted'
    ? context.planner_state.normal_capture_inspection_recovery.transaction_prerequisite_proposal_class : undefined;
  return {
    kind: 'transaction_prerequisite',
    required_control_intents: requiredControlIntents,
    eligible_current_control_counts: eligibleCurrentControlCounts,
    ...(previousProposalClass ? { previous_proposal_class: previousProposalClass } : {}),
    instruction: 'Return bstg.transaction.trigger with operation.intent equal to one listed required_control_intents value. That semantic intent is your model-owned transaction choice. When the narrowed observation has more than one eligible control for the chosen intent, also return one exact current controls[].candidate_index to disambiguate; when it has exactly one, omit candidate_index. BSTG resolves only that model-selected semantic capability to its private current browser reference at dispatch. If a compatible same-form field needs preparation first, return bstg.transaction.prepare with action, candidate_index, and any needed value or key instead. Do not use browser.interact, observe, assert, scroll, a selector, a browser control reference, an assertion reference, a capture lifecycle tool, or unrelated navigation in this one-turn lease.'
  };
}

/** A browser action's input references the document before its output
 * observation.  In a transaction prerequisite turn, only output references
 * from the newest observation are live selection candidates. */
function withoutTransactionBrowserInputReferences(invocation: Record<string, any>): Record<string, any> {
  const input = invocation?.input_json && typeof invocation.input_json === 'object' ? invocation.input_json : {};
  const operation = input?.operation && typeof input.operation === 'object' ? input.operation : undefined;
  if (!operation) return invocation;
  const { control_ref: _controlRef, assertion_ref: _assertionRef, selector: _selector, ...safeOperation } = operation;
  return { ...invocation, input_json: { ...input, operation: safeOperation } };
}

/** Keep lifecycle history visible while removing every stale selection surface
 * from older browser observations. The native runtime remains the authority
 * that checks freshness when the model later selects a current reference. */
function transactionHistoricalBrowserView(invocation: Record<string, any>): Record<string, any> {
  if (!['browser.navigate', 'browser.interact'].includes(String(invocation?.tool_name || ''))) return invocation;
  const withoutInputReferences = withoutTransactionBrowserInputReferences(invocation);
  const output = withoutInputReferences?.output_json && typeof withoutInputReferences.output_json === 'object'
    ? withoutInputReferences.output_json : {};
  const observation = output?.observation;
  if (!observation || typeof observation !== 'object') return withoutInputReferences;
  return {
    ...withoutInputReferences,
    output_json: {
      ...output,
      observation: { ...observation, controls: [], assertion_targets: [] },
    },
  };
}

function transactionRequiredIntents(requirement: Record<string, unknown>): string[] {
  return Array.isArray(requirement.required_control_intents)
    ? requirement.required_control_intents.filter((intent): intent is string => typeof intent === 'string' && TRANSACTION_PREREQUISITE_INTENTS.includes(intent as typeof TRANSACTION_PREREQUISITE_INTENTS[number]))
    : [];
}

function transactionEligibleInteractionControls(controls: any[], requiredIntents: string[]): any[] {
  const requiredFormIndexes = new Set(controls
    .filter((control: any) => requiredIntents.includes(String(control?.intent || '')) && isEligibleTransactionControl(control))
    .map(transactionControlFormIndex)
    .filter((formIndex: number | undefined): formIndex is number => formIndex !== undefined));
  return controls.filter((control: any) => {
    if (requiredIntents.includes(String(control?.intent || '')) && isEligibleTransactionControl(control)) return true;
    const formIndex = transactionControlFormIndex(control);
    return formIndex !== undefined && requiredFormIndexes.has(formIndex) && isTransactionPreparationField(control);
  });
}

/** A transaction lease uses short per-turn selection handles rather than
 * asking a language model to reproduce a long opaque browser UUID.  The
 * ordered handle map is built from the current live controls only; selecting
 * a handle remains a model decision, while resolution back to the live
 * browser reference is a server-side capability check. */
function currentTransactionCandidateMap(context: AutonomousAgentContext, requirement: Record<string, unknown>): Map<number, string> {
  const requiredIntents = transactionRequiredIntents(requirement);
  if (!requiredIntents.length) return new Map();
  const eligible = transactionEligibleInteractionControls(latestObservedControls(context), requiredIntents);
  return new Map(eligible.map((control, index) => [index + 1, String(control.control_ref)]));
}

/** Build a one-turn model view for a server-derived finite transaction stage.
 * The view hides unrelated current controls but retains every matching control
 * and any same-form field needed to prepare it.  It replaces the browser's
 * long opaque references with short transaction capability handles, so the
 * model still chooses an exact current candidate without copying UUIDs. */
function currentTransactionInteractionView(modelContext: Record<string, any>, requirement: Record<string, unknown>, candidateMap: Map<number, string>): Record<string, any> {
  const requiredIntents = transactionRequiredIntents(requirement);
  if (!requiredIntents.length || !Array.isArray(modelContext.task_tool_invocations)) return modelContext;
  const invocations = [...modelContext.task_tool_invocations];
  let currentObservationIndex = -1;
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    const invocation = invocations[index];
    const output = invocation?.output_json;
    const observation = output?.observation;
    const controls = Array.isArray(observation?.controls) ? observation.controls : undefined;
    if (!controls) continue;
    currentObservationIndex = index;
    break;
  }
  if (currentObservationIndex < 0) return modelContext;
  for (let index = 0; index < invocations.length; index += 1) {
    const invocation = invocations[index];
    if (!['browser.navigate', 'browser.interact'].includes(String(invocation?.tool_name || ''))) continue;
    if (index !== currentObservationIndex) {
      invocations[index] = transactionHistoricalBrowserView(invocation);
      continue;
    }
    const withoutInputReferences = withoutTransactionBrowserInputReferences(invocation);
    const output = withoutInputReferences?.output_json;
    const observation = output?.observation;
    const controls = Array.isArray(observation?.controls) ? observation.controls : [];
    const candidateIndexByControlRef = new Map([...candidateMap.entries()].map(([candidateIndex, controlRef]) => [controlRef, candidateIndex]));
    const eligible = transactionEligibleInteractionControls(controls, requiredIntents).flatMap((control: any) => {
      const candidateIndex = candidateIndexByControlRef.get(String(control?.control_ref || ''));
      if (!candidateIndex) return [];
      const { control_ref: _controlRef, ...candidateControl } = control;
      return [{ ...candidateControl, candidate_index: candidateIndex }];
    });
    invocations[index] = {
      ...withoutInputReferences,
      output_json: { ...output, observation: { ...observation, controls: eligible, assertion_targets: [] } },
    };
  }
  return { ...modelContext, task_tool_invocations: invocations };
}

/** The transaction prerequisite is a one-turn capability lease.  Narrow the
 * browser tool's advertised schema to the operations that can actually make
 * progress in this lease.  This is a provider-facing affordance only: the
 * model still chooses the short-lived candidate handle, while the runtime
 * resolves and validates the corresponding current browser capability. */
function narrowedTransactionControls(modelContext: Record<string, any>): any[] {
  const invocations = Array.isArray(modelContext.task_tool_invocations) ? modelContext.task_tool_invocations : [];
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    const controls = invocations[index]?.output_json?.observation?.controls;
    if (!Array.isArray(controls)) continue;
    return controls;
  }
  return [];
}

function narrowedTransactionCandidateIndexes(controls: any[], predicate: (control: any) => boolean): number[] {
  return [...new Set(controls
    .filter(predicate)
    .map((control: any) => Number.isInteger(control?.candidate_index) && Number(control.candidate_index) > 0 ? Number(control.candidate_index) : 0)
    .filter(Boolean))];
}

/** A transaction trigger is deliberately semantic: the model selects the
 * business intent, then the runtime resolves a unique live capability.  A
 * numeric index is required only when the selected intent remains ambiguous.
 * This avoids turning an opaque browser handle into the model's real task
 * while preserving its ownership of the business action. */
function currentTransactionInteractionTools(availableTools: any[], narrowedModelContext: Record<string, any>, requirement: Record<string, unknown>): Record<string, any>[] {
  const browserTool = availableTools.find((tool: any) => tool?.name === 'browser.interact');
  if (!browserTool) return [];
  const requiredIntents = transactionRequiredIntents(requirement);
  const controls = narrowedTransactionControls(narrowedModelContext);
  const triggerCandidateIndexes = narrowedTransactionCandidateIndexes(controls, (control) => requiredIntents.includes(String(control?.intent || '')));
  // The provider projection intentionally removes control_ref, so use the
  // field's structural shape here. Eligibility was already enforced when the
  // private candidate map and narrowed observation were constructed.
  const preparationCandidateIndexes = narrowedTransactionCandidateIndexes(controls, hasTransactionPreparationShape);
  const tools: Record<string, any>[] = [{
    ...browserTool,
    name: 'bstg.transaction.trigger',
    description: 'This one-turn transaction prerequisite lease triggers one current required business intent. Return operation.intent with one exact required intent from its enum. That intent is your choice. If more than one current eligible control has that chosen intent, return operation.candidate_index to choose one current numbered candidate; otherwise omit candidate_index. BSTG resolves only your selected semantic capability to its current private browser reference at dispatch. Do not use browser.interact, observe, assert, scroll, a selector, a browser control reference, or an assertion reference in this lease.',
    input_schema: {
      type: 'object',
      required: ['operation'],
      properties: {
        operation: {
          type: 'object',
          required: ['intent'],
          additionalProperties: false,
          properties: {
            intent: { type: 'string', enum: requiredIntents, description: 'Required transaction intent to trigger. Choose one current required intent yourself.' },
            candidate_index: { type: 'integer', ...(triggerCandidateIndexes.length ? { enum: triggerCandidateIndexes } : {}), description: 'Optional only to disambiguate multiple current eligible controls for the selected intent. Choose one current enum number; do not invent it.' },
          },
        },
      },
    },
  }];
  if (preparationCandidateIndexes.length) {
    tools.push({
      ...browserTool,
      name: 'bstg.transaction.prepare',
      description: 'Prepare an observed compatible field in the same form before triggering the required transaction intent. Return operation.action, operation.candidate_index, and a value or key only when that action requires it. This does not trigger the transaction; after it completes, choose bstg.transaction.trigger yourself. Do not use click, observe, assert, scroll, a selector, a browser control reference, or an assertion reference.',
      input_schema: {
        type: 'object',
        required: ['operation'],
        properties: {
          operation: {
            type: 'object',
            required: ['action', 'candidate_index'],
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['fill', 'select', 'press'] },
              candidate_index: { type: 'integer', enum: preparationCandidateIndexes, description: 'Current numbered compatible preparation field. Choose one enum number yourself; do not invent it.' },
              value: { type: 'string', description: 'Required only when a compatible fill or select action needs a value.' },
              key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Space'], description: 'Required only for press.' },
            },
          },
        },
      },
    });
  }
  return tools;
}

/** Resolve a one-turn semantic transaction proposal only after the model has
 * selected an allowed intent (and, when needed, a disambiguating candidate).
 * The server never chooses among multiple matching controls. Invalid special
 * proposals become an unresolved ordinary interaction and are rejected by the
 * existing freshness/actionability guard before browser dispatch. */
function resolveTransactionCandidateProposal(context: AutonomousAgentContext, requirement: Record<string, unknown>, proposal: AutonomousPlannerResult, candidateMap: Map<number, string>): AutonomousPlannerResult {
  if (proposal.action !== 'tool_call' || !candidateMap.size) return proposal;
  const toolName = String(proposal.tool_name || '');
  const operation = proposal.arguments?.operation && typeof proposal.arguments.operation === 'object'
    ? proposal.arguments.operation as Record<string, unknown> : {};
  const candidateIndex = Number.isInteger(operation.candidate_index) ? Number(operation.candidate_index) : undefined;
  const candidateRef = candidateIndex ? candidateMap.get(candidateIndex) : undefined;
  const candidate = candidateRef
    ? latestObservedControls(context).find((control) => String(control?.control_ref || '') === candidateRef && isEligibleTransactionControl(control))
    : undefined;
  const unresolved = (action: string): AutonomousPlannerResult => ({
    ...proposal,
    tool_name: 'browser.interact',
    arguments: { operation: { action } },
  });
  if (toolName === 'bstg.transaction.trigger') {
    const requiredIntents = transactionRequiredIntents(requirement);
    const intent = typeof operation.intent === 'string' && requiredIntents.includes(operation.intent) ? operation.intent : undefined;
    if (!intent) return unresolved('click');
    const matches = latestObservedControls(context).filter((control) =>
      isEligibleTransactionControl(control) && observedControlIntent(control) === intent &&
      [...candidateMap.values()].includes(String(control?.control_ref || '')));
    const selected = candidateIndex
      ? (candidate && observedControlIntent(candidate) === intent ? candidate : undefined)
      : (matches.length === 1 ? matches[0] : undefined);
    const controlRef = typeof selected?.control_ref === 'string' ? selected.control_ref : undefined;
    return controlRef ? {
      ...proposal,
      tool_name: 'browser.interact',
      arguments: { operation: { action: 'click', control_ref: controlRef } },
    } : unresolved('click');
  }
  if (toolName === 'bstg.transaction.prepare') {
    const action = typeof operation.action === 'string' ? operation.action : '';
    const compatible = candidate && isTransactionPreparationField(candidate) && transactionPreparationActionIsCompatible(candidate, action);
    if (!compatible) return unresolved(action || 'fill');
    return {
      ...proposal,
      tool_name: 'browser.interact',
      arguments: {
        operation: {
          action,
          control_ref: candidate.control_ref,
          ...(typeof operation.value === 'string' ? { value: operation.value } : {}),
          ...(typeof operation.key === 'string' ? { key: operation.key } : {}),
        },
      },
    };
  }
  // Accept a numbered legacy/generic response only when it explicitly
  // selects a current advertised capability. This preserves a harmless
  // compatibility path without re-exposing opaque references to the model.
  if (['browser.interact', 'bstg.transaction.interact'].includes(toolName) && candidateIndex) {
    const { candidate_index: _candidateIndex, ...resolvedOperation } = operation;
    return {
      ...proposal,
      tool_name: 'browser.interact',
      arguments: { operation: { ...resolvedOperation, ...(candidate?.control_ref ? { control_ref: candidate.control_ref } : {}) } },
    };
  }
  return proposal;
}

/** Classify a transaction-prerequisite proposal using a closed, value-free
 * vocabulary.  It never returns a control reference, selector, label, URL,
 * value, DOM detail, or model text.  The result is useful both to correct the
 * next provider turn and to distinguish a stale-reference problem from an
 * action/form mismatch without weakening model ownership of the choice. */
function transactionPrerequisiteProposalClass(context: AutonomousAgentContext, proposal: AutonomousPlannerResult, requiredIntents: string[]): TransactionPrerequisiteProposalClass {
  if (proposal.action !== 'tool_call' || proposal.tool_name !== 'browser.interact') return 'wrong_tool';
  const operation = proposal.arguments?.operation || {};
  const reference = typeof operation.control_ref === 'string' ? operation.control_ref : '';
  if (!reference) return 'missing_control_ref';
  const controls = latestObservedControls(context);
  const selected = reference ? controls.find(control => control.control_ref === reference) : undefined;
  if (!selected) return 'unknown_control_ref';
  if (!isEligibleTransactionControl(selected)) return 'ineligible_control';
  // A required transaction control denotes the state-changing UI trigger.
  // An assertion, observation, or field write against that control cannot
  // advance the capture, even when its opaque reference is current.
  if (requiredIntents.includes(String(observedControlIntent(selected) || ''))) {
    return String(operation.action || '') === 'click' ? 'accepted' : 'required_control_not_clicked';
  }
  const action = String(operation.action || '');
  if (!isTransactionPreparationField(selected)) return 'unrelated_control';
  if (!TRANSACTION_INTERACTION_ACTIONS.includes(action as typeof TRANSACTION_INTERACTION_ACTIONS[number]) || action === 'click' ||
      !transactionPreparationActionIsCompatible(selected, action)) return 'preparation_action_incompatible';
  const formIndex = transactionControlFormIndex(selected);
  return formIndex !== undefined && controls.some(control =>
    requiredIntents.includes(String(observedControlIntent(control) || '')) &&
    isEligibleTransactionControl(control) && transactionControlFormIndex(control) === formIndex)
    ? 'accepted' : 'preparation_wrong_form';
}

/** Convert a failed attempt into an intentionally coarse class. The ref,
 * selector, label, text, URL, and field value all remain private. */
function unsuccessfulBrowserActionClass(context: AutonomousAgentContext, afterIndex: number, beforeIndex: number): string | undefined {
  const action = latestMaterialBrowserActionBetween(context, afterIndex, beforeIndex);
  if (!action) return undefined;
  if (action.tool_name === 'browser.navigate') return 'navigation';
  const operation = action.input_json?.operation || {};
  const actionName = String(operation.action || '');
  const reference = typeof operation.control_ref === 'string' ? operation.control_ref : '';
  const control = reference ? currentObservedControl(context, reference) : undefined;
  const navigationTarget = typeof control?.navigation_target === 'string' && NAVIGATION_TARGET_CLASSES.has(control.navigation_target)
    ? control.navigation_target : undefined;
  if (navigationTarget) return `navigation_${navigationTarget}`;
  const intent = typeof control?.intent === 'string' && CONTROL_INTENT_CLASSES.has(control.intent) ? control.intent : undefined;
  if (intent) return `intent_${intent}`;
  return ['click', 'fill', 'select', 'press', 'assert'].includes(actionName) ? `action_${actionName}` : undefined;
}

/** Keep only the opaque operation identity and its effect class in planner
 * feedback. Method/route matching remains a server-side capture predicate. */
function objectiveOperationContract(flow: any): ObjectiveOperationContract | undefined {
  const operation = flow?.objective_operation;
  const operationId = typeof operation?.operation_id === 'string' && /^operation:[a-f0-9]{24}$/.test(operation.operation_id) ? operation.operation_id : '';
  const effect = typeof operation?.side_effect_class === 'string' ? operation.side_effect_class : '';
  if (!operationId || !['authentication', 'update', 'add', 'create', 'transaction', 'write'].includes(effect)) return undefined;
  return {
    operation_id: operationId,
    side_effect_class: effect as ObjectiveOperationContract['side_effect_class']
  };
}

function objectiveOperationCandidateCount(invocation: any): number {
  const output = invocation?.output_json || invocation?.data || {};
  const data = output?.data || output;
  const candidates = data?.objective_operation?.operation_candidate_event_ids;
  return Array.isArray(candidates) ? candidates.filter((id: unknown) => typeof id === 'string' && id.length > 0).length : 0;
}

type CaptureInspectionRecovery = {
  decision: AutonomousPlannerResult;
  reason: string;
  rejection_code?: string;
  rejection_context?: Record<string, unknown>;
};

/** Return only immutable protocol facts. In particular, this must not put a
 * DOM control, capture event, request, response, or provider argument into a
 * persisted rejection episode or the next model envelope. */
function captureInspectionRecoveryContext(context: AutonomousAgentContext, flow: any, requiredNextActionClass: string, completionRequiredPaths: string[] = [], operationRequirement?: ObjectiveOperationContract, transactionProposalClass?: TransactionPrerequisiteProposalClass): Record<string, unknown> {
  const recordingSessionId = String(flow?.recording_session_id || '');
  const history = invocationHistory(context) || [];
  const start = captureStartIndex(context, recordingSessionId);
  const inspectionIndex = lastInvocationIndex(context, (invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId);
  const inspection = inspectionIndex >= 0 ? history[inspectionIndex] : undefined;
  const previousInspectionIndex = inspectionIndex >= 0
    ? previousActiveCaptureInspectionIndex(context, recordingSessionId, inspectionIndex) : -1;
  const lastUnsuccessfulActionClass = inspectionIndex >= 0 && previousInspectionIndex >= 0
    ? unsuccessfulBrowserActionClass(context, previousInspectionIndex, inspectionIndex) : undefined;
  const navigationHints = objectiveNavigationHints(operationRequirement);
  const requiredControlIntents = transactionPrerequisiteControlIntents(context, recordingSessionId, operationRequirement);
  const eligibleCurrentControlCounts = eligibleCurrentTransactionControlCounts(context, requiredControlIntents);
  const captureStatus = captureStopped(context, recordingSessionId) ? 'stopped' : persistedCaptureStatus(inspection) === 'stopped' ? 'stopped' : 'recording';
  // Count only completed navigation or selector-based interaction as material
  // model-visible browser progress. Observe/scroll/no-op key operations do not
  // replenish this bounded recovery episode.
  const materialProgressCount = history.slice(Math.max(0, start + 1)).filter(isMaterialBrowserAction).length;
  const coverageCandidateCount = retryTargetCandidateCount(context, inspection);
  const coverageRetryActive = hasScheduledCoverageRetryTargets(context);
  return {
    recording_session_id: recordingSessionId,
    capture_status: captureStatus,
    event_count: captureInspectionEventCount(inspection) ?? null,
    semantic_candidate_available: inspectionHasSemanticBodyCandidate(inspection),
    material_progress_count: materialProgressCount,
    browser_state_progress_count: browserStateProgressCount(context, recordingSessionId),
    required_next_action_class: requiredNextActionClass,
    ...(lastUnsuccessfulActionClass ? { last_unsuccessful_action_class: lastUnsuccessfulActionClass } : {}),
    ...(navigationHints.length ? { objective_navigation_hints: navigationHints } : {}),
    ...(requiredControlIntents.length ? { objective_required_control_intents: requiredControlIntents } : {}),
    ...(requiredControlIntents.length ? { objective_eligible_current_control_counts: eligibleCurrentControlCounts } : {}),
    ...(transactionProposalClass && transactionProposalClass !== 'accepted'
      ? { transaction_prerequisite_proposal_class: transactionProposalClass } : {}),
    ...(completionRequiredPaths.length
      ? {
          objective_completion_required_response_paths: completionRequiredPaths,
          objective_completion_candidate_count: objectiveCompletionCandidateCount(inspection)
        }
      : {}),
    ...(operationRequirement
      ? {
          objective_operation_id: operationRequirement.operation_id,
          objective_operation_side_effect_class: operationRequirement.side_effect_class,
          objective_operation_candidate_count: objectiveOperationCandidateCount(inspection)
        }
      : {}),
    ...(coverageRetryActive
      ? {
          coverage_retry_candidate_count: coverageCandidateCount,
          coverage_retry_all_candidates: inspectionHasAllRetryTargetCandidates(context, inspection)
        }
      : {})
  };
}

function captureInspectionNoProgressRecovery(context: AutonomousAgentContext, flow: any, summary: string, rationale: string, reason: string, requiredNextActionClass: string, completionRequiredPaths: string[] = [], operationRequirement?: ObjectiveOperationContract, transactionProposalClass?: TransactionPrerequisiteProposalClass): CaptureInspectionRecovery {
  return {
    decision: {
      action: 'model_decision_required',
      summary,
      rationale,
      source: 'local_policy'
    },
    reason,
    rejection_code: NORMAL_CAPTURE_INSPECTION_NO_PROGRESS,
    rejection_context: captureInspectionRecoveryContext(context, flow, requiredNextActionClass, completionRequiredPaths, operationRequirement, transactionProposalClass)
  };
}

/**
 * An active capture can be inspected while the model is deciding which UI
 * action to take.  Re-reading the same completed-event count after another
 * browser observation adds no model-visible evidence, though, and otherwise
 * permits an observe/inspect loop to consume the complete task allowance.
 * Count only the value-free event total; request contents stay private.
 */
function unchangedActiveCaptureInspectionCount(context: AutonomousAgentContext, recordingSessionId: string): number {
  const start = captureStartIndex(context, recordingSessionId);
  const inspections = (invocationHistory(context) || []).slice(Math.max(0, start + 1)).filter((invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId && persistedCaptureStatus(invocation) === 'recording');
  const latest = inspections.at(-1);
  const eventCount = captureInspectionEventCount(latest);
  // stopBusinessCapture rejects an empty recording. Preserve the model's
  // browser-action ownership until at least one completed capture event exists.
  if (eventCount === undefined || eventCount < 1) return 0;
  let unchanged = 0;
  for (const inspection of inspections.reverse()) {
    if (captureInspectionEventCount(inspection) !== eventCount) break;
    unchanged += 1;
  }
  return unchanged;
}

function inspectionHasAllRetryTargetCandidates(context: AutonomousAgentContext, invocation: any): boolean {
  const targets = context.task.execution_plan?.coverage_retry?.targets;
  return Array.isArray(targets) && targets.length > 0 && retryTargetCandidateCount(context, invocation) === targets.length;
}

function retryTargetCandidateCount(context: AutonomousAgentContext, invocation: any): number {
  const targets = context.task.execution_plan?.coverage_retry?.targets;
  if (!Array.isArray(targets) || targets.length === 0) return 0;
  const output = invocation?.output_json;
  const candidates = output?.retry_target_event_candidates ?? output?.data?.retry_target_event_candidates;
  if (!Array.isArray(candidates)) return 0;
  return targets.filter((target) => candidates.some((candidate) => String(candidate?.target_type || '') === String(target?.target_type || '') && String(candidate?.target_id || '') === String(target?.target_id || '') && Array.isArray(candidate?.event_ids) && candidate.event_ids.some((eventId: unknown) => typeof eventId === 'string' && eventId.length > 0))).length;
}

function hasScheduledCoverageRetryTargets(context: AutonomousAgentContext): boolean {
  return Array.isArray(context.task.execution_plan?.coverage_retry?.targets) && context.task.execution_plan.coverage_retry.targets.length > 0;
}

/** The newest active inspection is the only safe evidence of whether a retry
 * capture currently contains every scheduled target. A later browser action
 * may have produced new traffic, but it must be inspected before sealing. */
function lastActiveCaptureInspectionIndex(context: AutonomousAgentContext, recordingSessionId: string): number {
  return lastInvocationIndex(context, (invocation) => invocation.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId && persistedCaptureStatus(invocation) === 'recording');
}

function previousActiveCaptureInspectionIndex(context: AutonomousAgentContext, recordingSessionId: string, beforeIndex: number): number {
  const history = invocationHistory(context) || [];
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const invocation = history[index];
    if (invocation?.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId && persistedCaptureStatus(invocation) === 'recording') return index;
  }
  return -1;
}

function latestMaterialBrowserActionBetween(context: AutonomousAgentContext, afterIndex: number, beforeIndex: number): any | undefined {
  const history = invocationHistory(context) || [];
  for (let index = beforeIndex - 1; index > afterIndex; index -= 1) {
    if (isMaterialBrowserAction(history[index])) return history[index];
  }
  return undefined;
}

/** A private, in-memory comparison only. The result is a boolean; no action
 * signature, browser state, selector, value, URL, DOM, or digest is stored or
 * returned. */
function sameActiveCaptureEvidence(context: AutonomousAgentContext, flow: any, left: any, right: any): boolean {
  const completionPaths = objectiveCompletionRequiredPaths(flow);
  const operation = objectiveOperationContract(flow);
  const coverageActive = hasScheduledCoverageRetryTargets(context);
  // Event count can grow from background polling or unrelated resources. It
  // is useful for display, but cannot establish progress toward this Flow's
  // semantic, strict-objective, or retry-target evidence.
  return inspectionHasSemanticBodyCandidate(left) === inspectionHasSemanticBodyCandidate(right) && (completionPaths.length === 0 || objectiveCompletionCandidateCount(left) === objectiveCompletionCandidateCount(right)) && (!operation || objectiveOperationCandidateCount(left) === objectiveOperationCandidateCount(right)) && (!coverageActive || (retryTargetCandidateCount(context, left) === retryTargetCandidateCount(context, right) && inspectionHasAllRetryTargetCandidates(context, left) === inspectionHasAllRetryTargetCandidates(context, right)));
}

function recoveryAlreadyRecordedAfterInspection(context: AutonomousAgentContext, inspection: any): boolean {
  const inspectedAt = String(inspection?.created_at || '');
  if (!inspectedAt) return false;
  const decisions = context.lifecycle_planner_decisions || [];
  return decisions.some((decision) => decision?.validation_status === 'rejected' && decision?.policy_json?.rejection_code === NORMAL_CAPTURE_INSPECTION_NO_PROGRESS && String(decision?.created_at || '') >= inspectedAt);
}

/** Once a retry target is already tied to an opaque captured event, one later
 * model-selected browser action is enough opportunity to reach any immediate
 * confirmation state. More active-capture inspection does not improve target
 * selection, so seal the evidence before it turns into another loop. */
function retryTargetCandidateFollowedByBrowserAction(context: AutonomousAgentContext, recordingSessionId: string): boolean {
  const history = invocationHistory(context) || [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const invocation = history[index];
    if (invocation.status !== 'completed' || invocation.tool_name !== 'bstg.business.capture.inspect' || String(invocation.output_json?.recording_session_id || '') !== recordingSessionId || persistedCaptureStatus(invocation) !== 'recording' || !inspectionHasAllRetryTargetCandidates(context, invocation)) continue;
    return history.slice(index + 1).some((next) => next.status === 'completed' && (next.tool_name === 'browser.navigate' || next.tool_name === 'browser.interact'));
  }
  return false;
}

function currentSelectorRecovery(context: AutonomousAgentContext): { candidates: string[] } | undefined {
  if (context.model_scope?.stage !== 'normal_business_learning') return undefined;
  const persisted = context.planner_state?.normal_business_selector_recovery;
  if (persisted === null) return undefined;
  if (persisted && typeof persisted === 'object' && Array.isArray(persisted.candidates)) {
    const candidates: string[] = [];
    for (const selector of persisted.candidates) {
      if (typeof selector === 'string' && selector.length > 0 && selector.length <= 1000) candidates.push(selector);
    }
    return { candidates: [...new Set(candidates)] };
  }
  return deriveSelectorRecovery(invocationHistory(context) || []);
}

/**
 * A selector correction is still selected by the model, but it has to be
 * selected from the browser's current, live-checked observation. This avoids
 * turning a no-action failure into a sequence of guessed labels or broad CSS
 * selectors. The local recovery only performs a fresh read when the model
 * offers no observed candidate; it never picks the semantic control itself.
 */
function normalBusinessSelectorProposalRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult): { decision: AutonomousPlannerResult; reason: string } | undefined {
  const recovery = currentSelectorRecovery(context);
  if (!recovery) return undefined;
  const operation = proposal.action === 'tool_call' && proposal.tool_name === 'browser.interact' ? proposal.arguments?.operation : undefined;
  const action = String(operation?.action || '');
  const selector = typeof operation?.control_ref === 'string' ? operation.control_ref : typeof operation?.assertion_ref === 'string' ? operation.assertion_ref : typeof operation?.selector === 'string' ? operation.selector : '';
  const selectorlessSafeAction = action === 'observe' || action === 'scroll' || (action === 'press' && !selector);
  const usesObservedCandidate = selector.length > 0 && recovery.candidates.includes(selector);
  const mayEndWithPersistedBlock = proposal.action === 'tool_call' && proposal.tool_name === 'bstg.business.flow.block';
  if (selectorlessSafeAction || usesObservedCandidate || mayEndWithPersistedBlock) return undefined;
  const flow = (context.business_flows || []).find((item) => item.id === context.task.execution_plan?.flow_id);
  return {
    decision: {
      action: 'tool_call',
      tool_name: 'browser.interact',
      arguments: {
        operation: { action: 'observe' },
        ...captureBoundBrowserArguments(flow)
      },
      rationale: 'The prior browser action was rejected before dispatch. Refresh the current bound page before selecting one exact observed control reference.',
      source: 'local_policy'
    },
    reason: recovery.candidates.length ? 'A normal-business correction must reuse one exact opaque reference from the latest observed controls or assertion targets.' : 'The rejected browser action has no safe control reference. Observe the current page before proposing another action.'
  };
}

/**
 * A provider is free to choose the normal business action. This guard only
 * prevents it from spending its decision budget inspecting an empty capture:
 * first navigate into the capture's exact context, then observe the live UI
 * before asking the provider to choose the semantic interaction.
 */
function normalBusinessCaptureProposalRecovery(context: AutonomousAgentContext, proposal: AutonomousPlannerResult, _fallback: AutonomousPlannerResult): CaptureInspectionRecovery | undefined {
  if (context.model_scope?.stage !== 'normal_business_learning') return undefined;
  const flow = (context.business_flows || []).find((item) => item.id === context.task.execution_plan?.flow_id);
  if (flow && coverageRetryCompletionRecoveryRequired(context)) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.start',
        arguments: {
          flow_id: flow.id,
          identity_key: flow.role
        },
        rationale: 'The retry verified a different Flow but still missed a scheduled target. Start the one bounded fresh task capture; the model will choose the target-reaching browser actions, event subset, and assertions after this native context exists.',
        source: 'local_policy'
      },
      reason: 'The persisted coverage-retry target gap requires one fresh task-scoped capture before another completion proposal.'
    };
  }
  if (flow && coverageRetryNeedsFreshCapture(context, flow)) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.start',
        arguments: {
          flow_id: flow.id,
          identity_key: flow.role
        },
        rationale: 'This server-created coverage retry must begin with its own fresh capture. The parent evidence remains audit-only; the model chooses current observed actions after this child context exists.',
        source: 'local_policy'
      },
      reason: 'A coverage-retry task cannot use the parent recording/context. Start its fresh task-bound capture before inspection, completion, or browser action.'
    };
  }
  const recordingSessionId = String(flow?.recording_session_id || '');
  if (!flow || !recordingSessionId) return undefined;
  if (captureStopped(context, recordingSessionId)) {
    // A stopped recording seals the UI capture boundary. Letting a later
    // model turn navigate, operate the page, reapply credentials, or start a
    // new capture here would create state outside the stopped evidence chain.
    // Re-anchor it to safe inspection; the next model turn still chooses the
    // event subset and semantic assertions.
    if (proposal.action === 'tool_call' && ['browser.navigate', 'browser.interact', 'bstg.identity.apply_login', 'bstg.business.capture.start'].includes(String(proposal.tool_name || ''))) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'bstg.business.capture.inspect',
          arguments: { recording_session_id: recordingSessionId },
          rationale: 'The normal capture is stopped. Re-read its bounded evidence before selecting a Workflow; browser activity or another capture is allowed only when the server schedules fresh completion recovery.',
          source: 'local_policy'
        },
        reason: 'A stopped normal-business recording cannot accept new browser activity, login, or recapture without a server-authorized completion-recovery boundary.'
      };
    }
    const phase = String(context.task.phase || '');
    const stoppedInspectionIndex = lastStoppedCaptureInspectionIndex(context, recordingSessionId);
    const selectionRefreshRequired = phase === 'normal_workflow_selection_requires_adaptation' && lastWorkflowPreparationIndex(context) > stoppedInspectionIndex;
    const revisionCaptureRefreshRequired = phase === 'normal_validation_repeated_execution_error_requires_workflow_revision';
    if (proposal.action === 'tool_call' && proposal.tool_name === 'bstg.business.capture.inspect' && stoppedInspectionIndex >= 0 && !selectionRefreshRequired && !revisionCaptureRefreshRequired) {
      // A stopped inspection is a value-free event inventory.  A read-only
      // memory/assets call after it cannot create new capture evidence, so
      // compare the relevant persisted invocation order rather than only the
      // absolute last tool.  A failed selection and the explicit repeated-
      // execution recovery phase each remain an authorized one-time refresh.
      if (phase === 'normal_validation_repeated_execution_error_requires_model_revision' && flow.workflow_id && flow.normal_run_id) {
        return captureInspectionNoProgressRecovery(context, flow, 'The stopped capture is already refreshed for workflow revision.', 'Choose bstg.business.workflow.revise with the current workflow_id, test_run_id, and a nonempty explicit event_ids subset from the inspected capture. BSTG will not select event IDs for you.', 'Repeated stopped-capture inspection has no new evidence. The model must now choose its explicit observed-event workflow revision.', 'model_selected_workflow_revision');
      }
      if (!flow.workflow_id) {
        return captureInspectionNoProgressRecovery(context, flow, 'The stopped capture is already inspected.', 'Choose bstg.business.workflow.prepare with a nonempty explicit event_ids subset from the inspected capture. BSTG will not select event IDs for you.', 'Repeated stopped-capture inspection has no new evidence. The model must now choose a nonempty explicit event_ids subset for bstg.business.workflow.prepare.', 'model_selected_workflow_prepare');
      }
      return captureInspectionNoProgressRecovery(context, flow, 'The stopped capture is already inspected for the current Workflow.', 'The stopped capture has no new evidence. Continue through the current Workflow inspection, validation, or server-announced recovery step instead of inspecting this capture again.', 'Repeated stopped-capture inspection has no new evidence for the current persisted Workflow.', 'model_selected_workflow_progress');
    }
    if (proposal.action === 'tool_call' && proposal.tool_name === 'bstg.business.workflow.prepare') {
      if (!inspectedStoppedCapture(context, recordingSessionId)) {
        return {
          decision: {
            action: 'tool_call',
            tool_name: 'bstg.business.capture.inspect',
            arguments: { recording_session_id: recordingSessionId },
            rationale: 'The stopped capture has not been inspected. Return its safe ordered event IDs before the model chooses an initial normal Workflow.',
            source: 'local_policy'
          },
          reason: 'Initial normal Workflow preparation requires a completed inspection of this stopped recording.'
        };
      }
      const eventIds = Array.isArray(proposal.arguments?.event_ids) ? proposal.arguments.event_ids.filter((id: unknown) => typeof id === 'string' && id.length > 0) : [];
      if (!eventIds.length) {
        return {
          decision: {
            action: 'tool_call',
            tool_name: 'bstg.business.capture.inspect',
            arguments: { recording_session_id: recordingSessionId },
            rationale: 'The model omitted event_ids. Re-read the same stopped capture and choose an explicit causally complete event sequence; no all-events fallback exists.',
            source: 'local_policy'
          },
          reason: 'Initial normal Workflow preparation requires one or more model-selected observed event_ids; BSTG never supplies a default all-events selection.'
        };
      }
    }
    return undefined;
  }
  const start = captureStartIndex(context, recordingSessionId);
  // Authenticated normal Flows always begin in a newly created task context.
  // Before the model may choose normal UI work, it must record that context's
  // initial navigation and one real prepared-login transition. Those two
  // transport prerequisites make native cookie/CSRF replay possible; they do
  // not choose a business action, mapping, or semantic assertion for the model.
  if (requiresPreparedCaptureLogin(flow)) {
    if (!captureNavigationAfter(context, start)) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'browser.navigate',
          arguments: {
            url: executionBaseUrl(context),
            ...captureBoundBrowserArguments(flow)
          },
          rationale: 'This authenticated normal Flow has not navigated its fresh task capture. Open the authorized login page in that exact context before applying the prepared identity.',
          source: 'local_policy'
        },
        reason: 'An authenticated normal-business capture must navigate its fresh task context before the prepared login or other UI work.'
      };
    }
    if (!preparedCaptureLoginAttemptedAfter(context, start, recordingSessionId) && !(proposal.action === 'tool_call' && proposal.tool_name === 'bstg.identity.apply_login')) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'bstg.identity.apply_login',
          arguments: { flow_id: flow.id },
          rationale: 'Record the exact scan-bound prepared identity login before choosing the authenticated normal business actions.',
          source: 'local_policy'
        },
        reason: 'An authenticated normal-business capture must record one prepared identity login before later browser actions, inspection, or stopping.'
      };
    }
  }
  const successfulLoginIndex = requiresPreparedCaptureLogin(flow) ? successfulPreparedCaptureLoginIndex(context, start, recordingSessionId) : -1;
  if (successfulLoginIndex >= 0 && !observedBrowserStateAfter(context, successfulLoginIndex)) {
    const isRequiredObservation = proposal.action === 'tool_call' && proposal.tool_name === 'browser.interact' && proposal.arguments?.operation?.action === 'observe';
    if (!isRequiredObservation) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'browser.interact',
          arguments: {
            operation: { action: 'observe' },
            ...captureBoundBrowserArguments(flow)
          },
          rationale: 'Prepared login changed the live browser document. Refresh its current opaque control references before inspecting capture evidence or choosing an authenticated action.',
          source: 'local_policy'
        },
        reason: 'A successful prepared login invalidates prior opaque browser references until one fresh browser observation completes.'
      };
    }
  }
  if (successfulLoginIndex >= 0 && observedBrowserStateAfter(context, successfulLoginIndex)) {
    const inspected = (invocationHistory(context) || []).slice(successfulLoginIndex + 1).some((invocation) => invocation?.status === 'completed' && invocation.tool_name === 'bstg.business.capture.inspect' && String(invocation.output_json?.recording_session_id || '') === recordingSessionId);
    if (!inspected) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'bstg.business.capture.inspect',
          arguments: { recording_session_id: recordingSessionId },
          rationale: 'The post-login browser observation is complete. Inspect the active capture once before selecting an authenticated business action.',
          source: 'local_policy'
        },
        reason: 'A completed prepared login requires one post-login observation followed by one active-capture inspection, preventing blind inspection loops.'
      };
    }
  }
  if (proposal.action !== 'tool_call') return undefined;
  const activeCaptureBoundaryProposal = ['bstg.business.capture.inspect', 'bstg.business.capture.stop'].includes(String(proposal.tool_name || ''));
  if (!browserActionAfter(context, start)) {
    const next =
      start < 0 || !(invocationHistory(context) || []).some((invocation) => invocation.status === 'completed' && invocation.tool_name === 'browser.navigate')
        ? {
            action: 'tool_call' as const,
            tool_name: 'browser.navigate',
            arguments: {
              url: executionBaseUrl(context),
              ...captureBoundBrowserArguments(flow)
            },
            rationale: 'An active capture has no browser operation yet. Navigate its exact context to the authorized target before inspecting or stopping it.',
            source: 'local_policy' as const
          }
        : {
            action: 'tool_call' as const,
            tool_name: 'browser.interact',
            arguments: {
              operation: { action: 'observe' },
              ...captureBoundBrowserArguments(flow)
            },
            rationale: 'The capture has no intervening UI observation/action. Observe its exact current page before choosing a semantic interaction or inspection.',
            source: 'local_policy' as const
          };
    return {
      decision: next,
      reason: 'An active normal-business capture needs an intervening bound browser operation before it can be inspected or stopped.'
    };
  }
  const last = latestInvocation(context);
  const activeInspectionIndex = lastActiveCaptureInspectionIndex(context, recordingSessionId);
  const activeInspection = activeInspectionIndex >= 0 ? (invocationHistory(context) || [])[activeInspectionIndex] : undefined;
  const retryCaptureNeedsCandidates = hasScheduledCoverageRetryTargets(context) && (!activeInspection || !inspectionHasAllRetryTargetCandidates(context, activeInspection));
  const activeInspectionNeedsBrowserAction = Boolean(activeInspection && retryCaptureNeedsCandidates && !browserActionAfter(context, activeInspectionIndex));
  const activeInspectionIsCurrent = Boolean(activeInspection && !browserActionAfter(context, activeInspectionIndex));
  const activeInspectionHasSemanticCandidate = inspectionHasSemanticBodyCandidate(activeInspection);
  const completionRecoveryRequired = String(context.task.phase || '') === 'normal_capture_objective_completion_required';
  const completionRequiredPaths = objectiveCompletionRequiredPaths(flow);
  const completionCandidateCount = objectiveCompletionCandidateCount(activeInspection);
  const operationRequirement = objectiveOperationContract(flow);
  const operationCandidateCount = objectiveOperationCandidateCount(activeInspection);
  const objectiveContractMissing = (completionRequiredPaths.length > 0 && completionCandidateCount === 0) || (operationRequirement !== undefined && operationCandidateCount === 0);
  const activeCaptureEvidenceMissing = Boolean(activeInspection) && (!activeInspectionHasSemanticCandidate || objectiveContractMissing || retryCaptureNeedsCandidates);
  const materialBrowserProgressAfterInspection = activeInspectionIndex >= 0 && materialBrowserActionAfter(context, activeInspectionIndex);
  const completionBrowserProgressAfterInspection = activeInspectionIndex >= 0 && browserActionAfter(context, activeInspectionIndex);
  const completionRecoveryProposal = proposal.action === 'tool_call' && ['bstg.business.capture.stop', 'bstg.business.workflow.prepare', 'bstg.business.capture.inspect'].includes(String(proposal.tool_name || ''));

  // The model has already selected the UI action that produced this strict
  // operation. Once the newest inspection proves a semantic candidate and
  // every sealed objective candidate, further UI activity can only duplicate
  // a state-changing request. Draining this capture is executor lifecycle
  // work: it does not select a control, event subset, mapping, or assertion.
  // The next provider turn still owns the explicit Workflow event selection.
  const strictCaptureReadyToSeal = Boolean(
    operationRequirement && activeInspection && activeInspectionIsCurrent &&
    activeInspectionHasSemanticCandidate && !objectiveContractMissing &&
    !retryCaptureNeedsCandidates,
  );
  if (strictCaptureReadyToSeal && proposal.tool_name !== 'bstg.business.capture.stop') {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.stop',
        arguments: { recording_session_id: recordingSessionId },
        rationale: 'The latest active inspection already contains the model-selected strict business effect and all required semantic candidates. Seal this recording before another UI action can repeat the state change; the model will select the stopped-capture event subset next.',
        source: 'local_policy',
      },
      reason: 'A current strict-objective capture with complete semantic and operation evidence must be sealed before additional browser activity.',
    };
  }

  // When a transaction exposes an unfinished finite prerequisite (for
  // example add → review → confirm), keep action choice model-owned while
  // rejecting unrelated navigation/clicks.  The required enum is derived
  // locally from live controls plus action-bound semantic receipts, never
  // from a model argument, visible label, selector, route, or capture value.
  const requiredTransactionIntents = activeInspection && activeInspectionIsCurrent && objectiveContractMissing
    ? transactionPrerequisiteControlIntents(context, recordingSessionId, operationRequirement) : [];
  const transactionProposalClass = requiredTransactionIntents.length &&
    ['browser.navigate', 'browser.interact'].includes(String(proposal.tool_name || ''))
    ? transactionPrerequisiteProposalClass(context, proposal, requiredTransactionIntents) : undefined;
  if (transactionProposalClass && transactionProposalClass !== 'accepted') {
    return captureInspectionNoProgressRecovery(
      context,
      flow,
      'The active transaction capture still needs its current semantic prerequisite.',
      'Choose an exact current control with the required finite intent, or prepare a field in that same observed form before selecting that control. Do not navigate to an unrelated page or choose another action class; BSTG will not choose the control, value, event, or assertion for you.',
      'A model-selected transaction action did not satisfy the server-derived current prerequisite stage.',
      'model_selected_transaction_prerequisite',
      completionRequiredPaths,
      operationRequirement,
      transactionProposalClass,
    );
  }

  // The first material browser operation is allowed to establish the bound
  // page. Once it has completed, the next decision must see one safe capture
  // inventory before issuing more UI operations. Without this boundary a
  // provider can keep clicking before it has ever learned whether capture
  // evidence exists.
  if (!activeInspection && materialBrowserActionAfter(context, start) && proposal.tool_name !== 'bstg.business.capture.inspect') {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        arguments: {
          recording_session_id: recordingSessionId
        },
        rationale: 'A material browser action completed before this active capture has been inspected. Read the safe inventory once before choosing another browser action or lifecycle step.',
        source: 'local_policy'
      },
      reason: 'An active normal-business capture requires its latest safe inspection after the first material browser action before additional browser work.'
    };
  }

  // Observe, scroll, and selectorless key presses are candidate refreshes;
  // they do not establish a business effect. Permit one between material
  // actions, then return a bounded model-owned recovery instead of dispatching
  // an unbounded passive browser loop.
  if (proposalIsReadOnlyBrowserAction(proposal) && readOnlyBrowserActionsSinceLatestMaterial(context, start) >= MAX_CONSECUTIVE_READ_ONLY_CAPTURE_ACTIONS) {
    return captureInspectionNoProgressRecovery(context, flow, 'The active capture has already used its bounded passive page refresh.', 'Choose a selector-based browser action or navigation yourself. Observe, scroll, and selectorless key presses cannot create the missing capture evidence.', 'Repeated passive browser operations cannot advance a normal-business capture without a material browser action.', 'model_selected_material_browser_action', completionRequiredPaths, operationRequirement);
  }

  // When a safe active inventory still lacks a semantic or strict candidate,
  // one material browser attempt is enough before re-reading capture evidence.
  // This is a read-only protocol boundary: it neither chooses the UI control
  // nor substitutes an event/assertion. It applies to ordinary semantic,
  // strict-objective, and coverage-retry captures alike.
  const formPreparationCount = consecutiveFormPreparationActionsAfter(context, activeInspectionIndex);
  const formPreparationContinuation = activeCaptureEvidenceMissing && materialBrowserProgressAfterInspection &&
    formPreparationCount > 0 && formPreparationCount <= MAX_CONSECUTIVE_FORM_PREPARATION_ACTIONS &&
    proposalContinuesPreparedForm(proposal);
  if (activeCaptureEvidenceMissing && materialBrowserProgressAfterInspection && proposal.tool_name !== 'bstg.business.capture.inspect' && !formPreparationContinuation) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        arguments: {
          recording_session_id: recordingSessionId
        },
        rationale: 'A model-selected browser action followed an active capture inventory that still lacked required evidence. Refresh the safe inventory once before another browser action, stop, or Workflow proposal.',
        source: 'local_policy'
      },
      reason: 'Missing semantic or strict-objective capture evidence must be refreshed once after each material browser action; BSTG does not choose the UI action, event, or assertion.'
    };
  }

  // A fresh action-generated inspection with unchanged evidence means the
  // model needs another decision, but it must not be charged as a failure when
  // the browser moved to a different safe state or control. The private
  // comparison never leaves this planner; only its value-free progress count
  // participates in the persisted recovery episode.
  const previousActiveInspectionIndex = activeInspectionIndex >= 0 ? previousActiveCaptureInspectionIndex(context, recordingSessionId, activeInspectionIndex) : -1;
  const actionBeforeActiveInspection = previousActiveInspectionIndex >= 0 ? latestMaterialBrowserActionBetween(context, previousActiveInspectionIndex, activeInspectionIndex) : undefined;
  const unchangedActionGeneratedInspection = Boolean(activeInspection && previousActiveInspectionIndex >= 0 && actionBeforeActiveInspection && sameActiveCaptureEvidence(context, flow, (invocationHistory(context) || [])[previousActiveInspectionIndex], activeInspection));
  if (activeCaptureEvidenceMissing && unchangedActionGeneratedInspection && !recoveryAlreadyRecordedAfterInspection(context, activeInspection)) {
    return captureInspectionNoProgressRecovery(context, flow, 'The refreshed active capture has not gained required evidence from the latest browser action.', 'Choose another browser navigation or interaction yourself. BSTG has refreshed the capture and will not choose a control, event, or assertion for you.', 'A model-selected browser action was followed by a fresh active capture inspection with unchanged safe evidence.', 'model_selected_browser_action', completionRequiredPaths, operationRequirement);
  }

  // Other active-capture tools are free only after the mandatory safe refresh
  // above. The remaining lifecycle rules concern inspect/stop specifically.
  if (!activeCaptureBoundaryProposal) return undefined;

  // A rejected early stop tells us only that the latest sealed inspection has
  // no final-outcome candidate.  It must not become a server-selected button,
  // event, or assertion.  First give the provider a browser-action turn.  If
  // it has since made one, one value-free inspection is the sole native
  // refresh; the following provider turn again owns the stop decision.
  if (completionRecoveryRequired && objectiveContractMissing && completionRecoveryProposal) {
    if (completionBrowserProgressAfterInspection) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'bstg.business.capture.inspect',
          arguments: {
            recording_session_id: recordingSessionId
          },
          rationale: 'A model-selected browser action followed the prior completion inventory. Refresh the active capture once so the next model decision can see whether the server-sealed final outcome now has a candidate.',
          source: 'local_policy'
        },
        reason: 'The strict objective inventory must be refreshed once after browser progress before another stop or Workflow proposal.'
      };
    }
    return captureInspectionNoProgressRecovery(context, flow, 'The active capture still lacks a required strict-objective candidate.', 'Keep the capture active and choose a browser navigation or interaction yourself that can produce the required business effect or final outcome. Do not stop, prepare a Workflow, or inspect again until that action completes; BSTG will not choose a control, event, or assertion for you.', 'The strict-objective capture has no browser progress after its latest safe inventory; the model must choose the next browser action.', 'model_selected_browser_action', completionRequiredPaths, operationRequirement);
  }
  if (proposal.tool_name === 'bstg.business.capture.stop' && !activeInspectionIsCurrent) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        arguments: {
          recording_session_id: recordingSessionId
        },
        rationale: 'Read the current active capture before deciding whether it can be sealed. The model still chooses the next browser action or Workflow event subset.',
        source: 'local_policy'
      },
      reason: 'Stopping an active normal-business capture requires a latest safe inspection; a prior browser action can add or change the semantic assertion candidates.'
    };
  }
  if (proposal.tool_name === 'bstg.business.capture.stop' && !activeInspectionHasSemanticCandidate) {
    return {
      decision: {
        action: 'model_decision_required',
        summary: 'The active capture has no successful semantic JSON event yet.',
        rationale: 'Keep the capture active. Choose a browser navigation or interaction yourself that reaches a normal result with an observable semantic body field, then inspect again. BSTG will not seal an HTML-only capture or choose a control for you.',
        source: 'local_policy'
      },
      reason: 'The proposed capture stop would seal a recording that cannot support a semantic normal-flow assertion.'
    };
  }
  if (proposal.tool_name === 'bstg.business.capture.stop' && retryCaptureNeedsCandidates) {
    // A capture may only be sealed from fresh inspection evidence. If the
    // model has acted since the prior inspection, an inspection is a safe
    // evidence read; otherwise return control without selecting any browser
    // control, event, or assertion on the model's behalf.
    if (!activeInspection || browserActionAfter(context, activeInspectionIndex)) {
      return {
        decision: {
          action: 'tool_call',
          tool_name: 'bstg.business.capture.inspect',
          arguments: {
            recording_session_id: recordingSessionId
          },
          rationale: 'Refresh the active retry capture before deciding whether it has observed candidate events for every scheduled target. This reads evidence only; the model still chooses any browser action and Workflow event subset.',
          source: 'local_policy'
        },
        reason: 'A coverage-retry capture must be inspected after its latest browser action before it can be stopped.'
      };
    }
    return {
      decision: {
        action: 'model_decision_required',
        summary: 'The active coverage-retry capture still lacks one or more scheduled target candidates.',
        rationale: 'Keep the capture active. Choose a browser navigation or interaction yourself that can reach an unrepresented scheduled target, then inspect the updated capture. BSTG will not choose a control, event, or assertion for you.',
        source: 'local_policy'
      },
      reason: 'The proposed capture stop would seal a coverage-retry recording before every scheduled target has an observed candidate event.'
    };
  }
  if (proposal.tool_name === 'bstg.business.capture.inspect' && activeInspectionNeedsBrowserAction) {
    return captureInspectionNoProgressRecovery(context, flow, 'The active coverage-retry capture still lacks one or more scheduled target candidates.', 'Do not inspect the unchanged active capture again. Choose a browser navigation or interaction yourself that can reach an unrepresented scheduled target, then inspect the updated capture. BSTG will not choose a control, event, or assertion for you.', 'Repeated active-capture inspection cannot create the missing scheduled target evidence; the model must choose the next browser action.', 'model_selected_browser_action');
  }
  if (!completionRecoveryRequired && proposal.tool_name === 'bstg.business.capture.inspect' && retryTargetCandidateFollowedByBrowserAction(context, recordingSessionId) && activeInspectionHasSemanticCandidate) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.stop',
        arguments: {
          recording_session_id: recordingSessionId
        },
        rationale: 'A scheduled retry target is already bound to an observed event and the model has completed one later browser action. Stop and drain this capture so the model can choose its Workflow event subset from sealed evidence.',
        source: 'local_policy'
      },
      reason: 'The active coverage-retry capture already contains a scheduled target candidate and one post-target browser action. Stop it before another inspection; the model still selects the Workflow event IDs.'
    };
  }
  // The generic capture drain guard is valid only once a retry has an
  // executable candidate for every scheduled target.  Otherwise it would
  // seal an empty retry merely because the model inspected after several
  // browser actions, leaving no Workflow source step for the target proof.
  if (proposal.tool_name === 'bstg.business.capture.inspect' && !retryCaptureNeedsCandidates && unchangedActiveCaptureInspectionCount(context, recordingSessionId) >= MAX_UNCHANGED_ACTIVE_CAPTURE_INSPECTIONS && !activeInspectionHasSemanticCandidate) {
    return captureInspectionNoProgressRecovery(context, flow, 'The unchanged active capture still has no successful semantic JSON event.', 'Keep the capture active and choose the next browser action yourself. A repeated inspection cannot turn HTML/navigation evidence into a semantic normal result, and BSTG will not auto-stop it.', 'Automatic capture draining is unsafe until a semantic assertion candidate exists.', 'model_selected_browser_action');
  }
  if (!completionRecoveryRequired && proposal.tool_name === 'bstg.business.capture.inspect' && !retryCaptureNeedsCandidates && unchangedActiveCaptureInspectionCount(context, recordingSessionId) >= MAX_UNCHANGED_ACTIVE_CAPTURE_INSPECTIONS && activeInspectionHasSemanticCandidate) {
    return {
      decision: {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.stop',
        arguments: {
          recording_session_id: recordingSessionId
        },
        rationale: 'The active capture has returned the same completed-event count across repeated inspections. Stop and drain it so the next model turn can inspect the sealed evidence and choose its own Workflow event subset.',
        source: 'local_policy'
      },
      reason: 'Repeated active-capture inspections produced no new completed event. Stop the recording before another inspection; the model retains ownership of the next Workflow event selection.'
    };
  }
  if (proposal.tool_name === 'bstg.business.capture.inspect' && last?.status === 'completed' && last.tool_name === 'bstg.business.capture.inspect') {
    return captureInspectionNoProgressRecovery(context, flow, 'The active capture was already inspected without later browser progress.', 'Choose a browser navigation or interaction yourself before another inspection. BSTG will not select a control, event, or assertion for you.', 'Repeated capture inspection without an intervening browser action is not a valid normal-business learning step.', 'model_selected_browser_action_or_capture_stop');
  }
  return undefined;
}

export function localPolicy(context: AutonomousAgentContext): AutonomousPlannerResult {
  const taskType = String(context.task.task_type || '');
  const hasExplicitVulnType = Boolean(context.task.vuln_type || context.task.execution_plan?.vuln_type);
  const vulnType = String(context.task.vuln_type || context.task.execution_plan?.vuln_type || '');
  const selected = Array.isArray(context.selected_vuln_types) ? context.selected_vuln_types : [];
  const selectedForPolicy = selected.length > 0 ? selected : isAutopilotContext(context) ? ALL_VULN_TYPES : [];
  const last = latestInvocation(context);
  const businessIntent = context.task.execution_plan?.intent;
  const businessFlows = context.business_flows || [];
  if (businessIntent === BUSINESS_PLAN_INTENT) {
    if (!invoked(context, 'browser.navigate'))
      return {
        action: 'tool_call',
        tool_name: 'browser.navigate',
        arguments: { url: executionBaseUrl(context) },
        rationale: 'Observe the actual site before defining business goals.',
        source: 'local_policy'
      };
    if (!invoked(context, 'bstg.business.coverage.inspect'))
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.coverage.inspect',
        arguments: {},
        rationale: 'Read every currently discovered operable feature and endpoint operation before deciding which normal flows to plan or defer.',
        source: 'local_policy'
      };
    if (hasSavedBusinessCoverage(context))
      return {
        action: 'complete_task',
        summary: 'The model saved a coverage decision for the discovered business inventory; schedule only its planned normal flows.',
        source: 'local_policy'
      };
    const objectiveManifest = normalObjectiveManifestForTask(context.task as any);
    const definedObjectives = new Set(businessFlows.map((flow) => String(flow?.objective_id || '')).filter(Boolean));
    const remainingObjective = objectiveManifest.find((objective) => !definedObjectives.has(objective.id));
    if (remainingObjective)
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.flow.define',
        arguments: { objective_id: remainingObjective.id, role: 'anonymous' },
        rationale: 'Select the next unassigned immutable normal objective. Coverage cannot be saved until every manifest objective has exactly one server-derived Flow.',
        source: 'local_policy'
      };
    if (businessFlows.length)
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.coverage.inspect',
        arguments: {},
        rationale: 'Flows alone do not release learning. Refresh the current inventory and save the model coverage list that maps every feature/operation to a planned flow or a concrete deferred/blocked reason.',
        source: 'local_policy'
      };
    const objective = objectiveManifest[0];
    return {
      action: 'tool_call',
      tool_name: 'bstg.business.flow.define',
      arguments: {
        ...(objective
          ? { objective_id: objective.id }
          : {
              name: context.feature_tree[0]?.name || 'Observed normal business',
              goal: context.feature_tree[0]?.description || context.scan.user_prompt || 'Complete an observed normal function and verify its resulting business state.'
            }),
        role: 'anonymous',
        ...(context.feature_tree[0]?.id
          ? {
              feature_id: context.feature_tree[0].id,
              feature_name: context.feature_tree[0]?.name
            }
          : {})
      },
      rationale: objective ? 'Select the first server-owned normal objective. The server retains its immutable name and goal; additional manifest objectives remain required before coverage can be saved.' : 'Define a goal grounded in current observations. The fallback uses anonymous because it is the only role safe to synthesize; an authenticated flow must use an exact active/supplied identity key, never a display label.',
      source: 'local_policy'
    };
  }
  if (businessIntent === BUSINESS_LEARNING_INTENT) {
    const flow = businessFlows.find((item) => item.id === context.task.execution_plan?.flow_id);
    if (!flow)
      return {
        action: 'fail_task',
        reason: 'The normal business task has no defined flow in this assessment.',
        source: 'local_policy'
      };
    if (coverageRetryCompletionRecoveryRequired(context)) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.start',
        arguments: { flow_id: flow.id, identity_key: flow.role },
        rationale: 'The retry missed a scheduled target after otherwise verified native work. Start its one bounded fresh task capture; choose the target-reaching browser actions, observed event subset, and assertions yourself after the native context exists.',
        source: 'local_policy'
      };
    }
    if (coverageRetryNeedsFreshCapture(context, flow)) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.start',
        arguments: { flow_id: flow.id, identity_key: flow.role },
        rationale: 'A server-created coverage retry starts a fresh task-bound recording before prior Flow evidence can be inspected or reused.',
        source: 'local_policy'
      };
    }
    if (flow.status === 'verified' && flow.assertions_verified === true && flow.normal_run_id && sealedStrictObjectiveBindings(flow as any))
      return {
        action: 'complete_task',
        summary: 'The normal business goal has native execution and sealed strict-objective proof.',
        source: 'local_policy'
      };
    const phase = String(context.task.phase || '');
    // A browser action whose post-action observation failed is not safe to
    // replay: it may already have caused a state change. The recovery is a
    // fixed, read-only capture → live observation → capture sequence. It
    // never selects a UI control, captured event, mapping, or assertion for
    // the model, and it ends before the model resolves the evidence.
    if (phase === 'normal_post_action_capture_requires_inspection' ||
        phase === 'normal_post_action_capture_requires_post_observation_inspection') {
      const recordingSessionId = String(flow.recording_session_id || '');
      if (!recordingSessionId) {
        return {
          action: 'fail_task',
          reason: 'The post-action recovery has no active task-bound recording to inspect.',
          source: 'local_policy'
        };
      }
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        // The recorder binding is resolved from the active task server-side.
        // Do not persist or expose the session handle in this deterministic
        // recovery call; the public tool contract deliberately has no such
        // parameter for either model or lifecycle callers.
        arguments: {},
        rationale: phase === 'normal_post_action_capture_requires_inspection'
          ? 'A browser operation may have been dispatched but its post-action observation failed. Inspect the existing task-bound capture before any further browser operation; do not replay the action.'
          : 'The current browser state was observed after a potentially dispatched operation. Refresh the same task-bound capture before model resolution; do not replay the operation.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_post_action_capture_requires_authoritative_observation') {
      return {
        action: 'tool_call',
        tool_name: 'browser.interact',
        arguments: { operation: { action: 'observe' } },
        rationale: 'The existing capture was inspected after a potentially dispatched operation. Read the current live browser state once before resolving the Flow; do not replay the operation.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_capture_objective_completion_required') {
      const recordingSessionId = String(flow.recording_session_id || '');
      const inspectionIndex = recordingSessionId ? lastActiveCaptureInspectionIndex(context, recordingSessionId) : -1;
      const requiredPaths = objectiveCompletionRequiredPaths(flow);
      const operation = objectiveOperationContract(flow);
      const inspection = inspectionIndex >= 0 ? (invocationHistory(context) || [])[inspectionIndex] : undefined;
      const missingObjective = (requiredPaths.length > 0 && objectiveCompletionCandidateCount(inspection) === 0) || (operation !== undefined && objectiveOperationCandidateCount(inspection) === 0);
      if (!recordingSessionId || inspectionIndex < 0) {
        return {
          action: 'tool_call',
          tool_name: 'bstg.business.capture.inspect',
          arguments: { recording_session_id: recordingSessionId },
          rationale: 'Refresh the active capture’s safe final-outcome inventory before deciding how to reach the required normal outcome.',
          source: 'local_policy'
        };
      }
      if (missingObjective && browserActionAfter(context, inspectionIndex)) {
        return {
          action: 'tool_call',
          tool_name: 'bstg.business.capture.inspect',
          arguments: { recording_session_id: recordingSessionId },
          rationale: 'A browser action followed the last strict-objective inspection. Refresh the safe candidate inventory once before the model decides whether the capture can be stopped.',
          source: 'local_policy'
        };
      }
      if (!missingObjective)
        return {
          action: 'model_decision_required',
          summary: 'The active capture has server-sealed strict-objective candidates.',
          rationale: 'Choose whether to stop the active capture from the current safe inventory. BSTG will not stop it, select an event, or choose an assertion for you.',
          source: 'local_policy'
        };
      return {
        action: 'model_decision_required',
        summary: 'The active capture needs a model-selected browser action to reach its strict objective.',
        rationale: `Choose a browser navigation or interaction that can produce the server-sealed business effect${operation ? ` (${operation.side_effect_class})` : ''}${requiredPaths.length ? ` and final response shape (${requiredPaths.join(', ')})` : ''}. Do not stop, prepare, or re-inspect unchanged capture evidence; BSTG will not select a control, event, or assertion.`,
        source: 'local_policy'
      };
    }
    if (phase === 'normal_flow_block_requires_adaptation') {
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.flow.inspect',
        arguments: { flow_id: flow.id },
        rationale: 'The proposed normal-flow blocker lacked current server evidence. Inspect the persisted Flow before choosing an evidence-backed block or another model-selected repair.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_workflow_selection_requires_adaptation') {
      if (!flow.recording_session_id) {
        return {
          action: 'fail_task',
          reason: 'The rejected normal Workflow selection has no current stopped recording to inspect.',
          source: 'local_policy'
        };
      }
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        arguments: { recording_session_id: flow.recording_session_id },
        rationale: 'The selected retry Workflow omitted a scheduled target event that is already present in this stopped capture. Refresh the server-derived event-to-target candidates before choosing a corrected model-owned subset.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_validation_requires_adaptation') {
      if (!flow.workflow_id || !flow.normal_run_id) {
        return {
          action: 'fail_task',
          reason: 'The failed normal validation has no current workflow/Test Run provenance for scoped repair.',
          source: 'local_policy'
        };
      }
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.workflow.repair',
        arguments: {
          workflow_id: flow.workflow_id,
          test_run_id: flow.normal_run_id
        },
        rationale: 'The current native normal execution failed. Apply server-side learning only to this task-bound workflow trace, then inspect and revalidate the repaired snapshot.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_validation_repeated_execution_error_requires_workflow_revision') {
      if (!flow.workflow_id || !flow.normal_run_id || !flow.recording_session_id) {
        return {
          action: 'fail_task',
          reason: 'The repeated normal execution error has no current workflow/Test Run/recording provenance for model-selected revision.',
          source: 'local_policy'
        };
      }
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        arguments: { recording_session_id: flow.recording_session_id },
        rationale: 'The repaired normal path still failed in native execution. Refresh the stopped capture with its exact observed event IDs before the model selects an explicit revision; do not silently omit a step.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_validation_repeated_execution_error_requires_model_revision') {
      if (!flow.workflow_id || !flow.normal_run_id) {
        return {
          action: 'fail_task',
          reason: 'The repeated normal execution error has no current workflow/Test Run provenance for model-selected revision.',
          source: 'local_policy'
        };
      }
      // This is a provider hint, never a runnable fallback: only the model may
      // choose the exact event_ids and rationale for a new observed sequence.
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.workflow.revise',
        arguments: {
          workflow_id: flow.workflow_id,
          test_run_id: flow.normal_run_id
        },
        rationale: 'The repaired path repeated a native execution error. Select exact current observed event IDs and a rationale for a new Workflow revision; retain all currently bound observed coverage targets. A separately planned target absent from this stopped recording remains for a fresh retry after native validation.',
        source: 'local_policy'
      };
    }
    if (phase === 'normal_validation_repaired_requires_inspection' || phase === 'normal_assertion_revision_requires_inspection' || phase === 'normal_objective_completion_assertion_requires_inspection' || phase === 'normal_validation_semantic_requires_inspection' || phase === 'normal_workflow_revised_requires_inspection') {
      if (!flow.workflow_id)
        return {
          action: 'fail_task',
          reason: 'The normal-flow recovery has no current workflow to inspect.',
          source: 'local_policy'
        };
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.workflow.inspect',
        arguments: { workflow_id: flow.workflow_id },
        rationale: 'Inspect the same recovered Workflow before selecting a corrected semantic validation; do not discard its task-bound capture.',
        source: 'local_policy'
      };
    }
    if (flow.workflow_id) {
      if (!inspectedBusinessWorkflow(context, flow.workflow_id)) {
        return {
          action: 'tool_call',
          tool_name: 'bstg.business.workflow.inspect',
          arguments: { workflow_id: flow.workflow_id },
          rationale: 'Inspect the current observed Workflow, fields, and dependency candidates before choosing semantic assertions and normal validation.',
          source: 'local_policy'
        };
      }
      // This is guidance sent to the real provider, not a runnable fallback:
      // validation requires model-selected semantic assertions.  Supplying
      // fixed assertions here would turn the normal business proof into a
      // rules-only flow and could incorrectly validate a different outcome.
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.workflow.validate',
        arguments: { workflow_id: flow.workflow_id },
        rationale: 'The current Workflow has been inspected. Select observed business assertions, any justified optional mapping IDs, and session propagation, then validate a fresh native normal run. Recording-proved required replay mappings are applied server-side.',
        source: 'local_policy'
      };
    }
    if (flow.recording_session_id) {
      // The provider may sensibly inspect a stopped recording before asking the
      // recorder to compile it. Persisted invocation history, rather than only
      // the immediately previous tool call, is the authority for whether this
      // exact flow session is ready for workflow preparation.
      const stoppedCapture = captureStopped(context, flow.recording_session_id);
      if (stoppedCapture) {
        if (!inspectedStoppedCapture(context, flow.recording_session_id)) {
          return {
            action: 'tool_call',
            tool_name: 'bstg.business.capture.inspect',
            arguments: { recording_session_id: flow.recording_session_id },
            rationale: "Inspect the stopped recording before selecting an initial normal Workflow. Its safe ordered event IDs are the model's input; native code will not choose a default sequence.",
            source: 'local_policy'
          };
        }
        return {
          action: 'model_decision_required',
          summary: 'Choose an explicit initial normal Workflow event sequence from the inspected stopped capture.',
          rationale: 'Select a nonempty, causally complete set of exact observed event IDs for bstg.business.workflow.prepare. This policy deliberately provides no default event selection.',
          source: 'local_policy'
        };
      }
      const start = captureStartIndex(context, flow.recording_session_id);
      if (!browserActionAfter(context, start)) {
        return {
          action: 'tool_call',
          tool_name: 'browser.navigate',
          arguments: {
            url: executionBaseUrl(context),
            ...captureBoundBrowserArguments(flow)
          },
          rationale: 'An active normal-flow recording must first navigate in its exact bound browser context before it can be inspected or stopped.',
          source: 'local_policy'
        };
      }
      if (requiresPreparedCaptureLogin(flow) && !preparedCaptureLoginAttemptedAfter(context, start, flow.recording_session_id)) {
        return {
          action: 'tool_call',
          tool_name: 'bstg.identity.apply_login',
          arguments: { flow_id: flow.id },
          rationale: 'Record the exact prepared identity login in this fresh task capture before choosing authenticated normal business actions.',
          source: 'local_policy'
        };
      }
      const successfulLoginIndex = requiresPreparedCaptureLogin(flow) ? successfulPreparedCaptureLoginIndex(context, start, flow.recording_session_id) : -1;
      if (successfulLoginIndex >= 0 && !observedBrowserStateAfter(context, successfulLoginIndex)) {
        return {
          action: 'tool_call',
          tool_name: 'browser.interact',
          arguments: {
            operation: { action: 'observe' },
            ...captureBoundBrowserArguments(flow)
          },
          rationale: 'Prepared login changed the live browser document. Refresh current opaque control references before capture inspection.',
          source: 'local_policy'
        };
      }
      // A current strict-objective inspection can prove that the capture is
      // still missing its sealed operation or final outcome.  Do not advertise
      // another deterministic capture.inspect in that state: it cannot create
      // evidence and competes with the model's next browser choice.  The
      // provider retains ownership of the exact opaque control, field value,
      // and later event/assertion selection; the policy exposes only a finite
      // transaction stage when one can be derived from local receipts.
      const activeInspectionIndex = lastActiveCaptureInspectionIndex(context, flow.recording_session_id);
      const activeInspection = activeInspectionIndex >= 0 ? (invocationHistory(context) || [])[activeInspectionIndex] : undefined;
      const completionRequiredPaths = objectiveCompletionRequiredPaths(flow);
      const operationRequirement = objectiveOperationContract(flow);
      const objectiveEvidenceMissing = Boolean(activeInspection) &&
        ((completionRequiredPaths.length > 0 && objectiveCompletionCandidateCount(activeInspection) === 0) ||
          (operationRequirement !== undefined && objectiveOperationCandidateCount(activeInspection) === 0));
      if (objectiveEvidenceMissing && !browserActionAfter(context, activeInspectionIndex)) {
        const requiredIntents = transactionPrerequisiteControlIntents(context, flow.recording_session_id, operationRequirement);
        const eligibleCounts = eligibleCurrentTransactionControlCounts(context, requiredIntents);
        const finiteStage = requiredIntents.length
          ? ` The current finite transaction prerequisite is ${requiredIntents.join(', ')}.`
          : '';
        const currentActionContract = requiredIntents.length && Object.values(eligibleCounts).some(count => count > 0)
          ? ` Return browser.interact using one exact current transaction candidate handle with that intent; the current safe observation has ${requiredIntents.reduce((total, intent) => total + (eligibleCounts[intent] || 0), 0)} eligible finite candidate(s). You choose the exact candidate and any necessary same-form preparation. Do not navigate or choose a capture lifecycle tool.`
          : '';
        return {
          action: 'model_decision_required',
          summary: 'The current strict normal capture still needs a model-selected browser action.',
          rationale: `Choose one browser.navigate or browser.interact action from the current safe observation that can produce the missing server-sealed business effect or final outcome.${finiteStage}${currentActionContract} Do not re-inspect, stop, prepare, or validate unchanged capture evidence. BSTG will not choose a control, field value, event, mapping, or assertion for you.`,
          source: 'local_policy'
        };
      }
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.capture.inspect',
        arguments: { recording_session_id: flow.recording_session_id },
        rationale: 'Review actual normal-flow actions and outcomes; choose further browser operations or stop only after the intended normal flow.',
        source: 'local_policy'
      };
    }
    return {
      action: 'tool_call',
      tool_name: 'bstg.business.capture.start',
      arguments: { flow_id: flow.id, identity_key: flow.role },
      rationale: 'Record the normal business flow before its first action.',
      source: 'local_policy'
    };
  }
  if (businessIntent === BUSINESS_REVIEW_INTENT) {
    const unresolved = businessFlows.filter((flow) => flow.status !== 'verified' || flow.assertions_verified !== true || !flow.normal_run_id || !sealedStrictObjectiveBindings(flow as any));
    if (businessFlows.length)
      return {
        action: 'complete_task',
        summary: unresolved.length ? `${businessFlows.length - unresolved.length} normal flows are verified; ${unresolved.length} blocked/failed flows remain recorded as independent repair work.` : 'Defined normal business flows have verified native results.',
        source: 'local_policy'
      };
  }
  if (businessIntent === BUSINESS_EXPERIMENT_INTENT) {
    const flow = businessFlows.find((item) => item.id === context.task.execution_plan?.flow_id);
    if (!flow || flow.status !== 'verified' || flow.assertions_verified !== true || !flow.normal_run_id || !flow.workflow_id || !sealedStrictObjectiveBindings(flow as any)) {
      return {
        action: 'fail_task',
        reason: 'A model experiment may run only for its persisted native-verified normal flow.',
        source: 'local_policy'
      };
    }
    const experiment = currentExperimentState(context);
    const lifecycleArtifacts = experimentLifecycleArtifacts(context);
    const terminal = businessExperimentTerminalDisposition(context.task as any, (context.task_artifacts || []) as any);
    if (terminal?.kind === 'blocked') {
      return {
        action: 'block_task',
        reason: terminal.reason,
        summary: `The current model experiment is explicitly blocked with persisted evidence (${terminal.evidence_artifact_ids.join(', ')}).`,
        source: 'local_policy'
      };
    }
    if (terminal?.kind === 'failed') {
      return {
        action: 'fail_task',
        reason: terminal.reason,
        summary: 'The current model experiment failed or recorded an unsupported blocked state; it cannot be completed.',
        source: 'local_policy'
      };
    }
    const plan = experiment.plan;
    const repeatedNegativeAttempts=plan?.id
      ?businessExperimentNegativeCounterexampleAttempts(context.task as any,lifecycleArtifacts as any,String(plan.id))
      :[];
    if(repeatedNegativeAttempts.length>=MIN_NEGATIVE_COUNTEREXAMPLE_ATTEMPTS&&repeatedNegativeAttempts.some(attempt=>attempt.plan_id===String(plan?.id||''))){
      return {
        action:'tool_call',
        tool_name:'bstg.test_plan.block',
        arguments:{plan_id:String(plan?.id||''),reason_code:'negative_counterexample_proof_missing'},
        rationale:`The same persisted negative-counterexample proof gap now spans ${repeatedNegativeAttempts.length} distinct completed, control-verified native plans. Stop this loop with an evidence-linked block; do not label the target secure or continue changing replay counts.`,
        source:'local_policy',
      };
    }
    if (context.task.phase === 'experiment_compile_requires_inspection') {
      const failed = latestRecoverableExperimentCompileFailure(context);
      const failedPlanId = String(failed?.input_json?.plan_id || plan?.id || '');
      return failedPlanId ? {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.inspect',
        arguments: { plan_id: failedPlanId },
        rationale: 'Read the failed plan and its safe compile_feedback before choosing a correction. This is a read-only, task-bound recovery step.',
        source: 'local_policy'
      } : { action: 'fail_task', reason: 'The failed plan could not be resolved for safe compile recovery.', source: 'local_policy' };
    }
    if (context.task.phase === 'experiment_compile_reinspection_completed') {
      const failed = latestRecoverableExperimentCompileFailure(context);
      const failedPlanId = String(failed?.input_json?.plan_id || '');
      if (failedPlanId) return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.create',
        arguments: { flow_id: flow.id, parent_plan_id: failedPlanId },
        rationale: 'Create one fresh model-authored child plan from the inspected compile failure. Keep the model’s selected mutation grounded in the safe failure_code and current native Workflow; never reuse the failed plan.',
        source: 'local_policy'
      };
    }
    if (context.task.phase === 'experiment_workflow_step_binding_reinspection_completed' &&
        latestRecoverableExperimentCompileFailure(context)) {
      const failed = latestRecoverableExperimentCompileFailure(context);
      const failedPlanId = String(failed?.input_json?.plan_id || '');
      if (failedPlanId) return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.create',
        arguments: { flow_id: flow.id, parent_plan_id: failedPlanId },
        rationale: 'The child plan’s corrected native step selection is now available. Create a fresh child of the failed compile plan, then compile it once.',
        source: 'local_policy'
      };
    }
    const parentPlanId = businessExperimentRevisionRequirement(context.task as any, (context.task_artifacts || []) as any);
    if (parentPlanId) {
      if(currentExperimentHasUnavailableReadback(context,experiment,String(flow.workflow_id||''))){
        return {
          action:'model_decision_required',
          rationale:'The native result identifies an authoritative-readback prerequisite that is absent from the inspected source Workflow. Ask the model to record the typed evidence-linked block; do not force another plan from the same source steps.',
          source:'local_policy',
        };
      }
      return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.create',
        arguments: { flow_id: flow.id, parent_plan_id: parentPlanId },
        rationale: 'The current assessment is inconclusive or evidence-insufficient. Create a fresh child plan with this parent_plan_id (do not reuse plan_id), then compile, execute, inspect, and assess that new plan revision.',
        source: 'local_policy'
      };
    }
    if (!invoked(context, 'bstg.business.flow.inspect')) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.business.flow.inspect',
        arguments: { flow_id: flow.id },
        rationale: 'Read the verified normal goal and evidence before selecting a concrete experiment.',
        source: 'local_policy'
      };
    }
    if (!invoked(context, 'bstg.workflow.inspect')) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.workflow.inspect',
        arguments: { workflow_id: flow.workflow_id },
        rationale: 'Inspect native step and field structure; the model must choose its own exact fields and mutations.',
        source: 'local_policy'
      };
    }
    if (context.task.phase === 'experiment_workflow_step_binding_requires_inspection') {
      return {
        action: 'tool_call',
        tool_name: 'bstg.workflow.inspect',
        arguments: { workflow_id: flow.workflow_id },
        rationale: 'Refresh the current native Workflow step orders after a rejected plan. The model must choose corrected orders itself.',
        source: 'local_policy'
      };
    }
    if (!plan?.id || !Number.isInteger(Number(plan.revision))) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.create',
        arguments: { flow_id: flow.id },
        rationale: 'Create a model-authored plan using observed steps, explicit changes, dynamic bindings and semantic control/impact assertions.',
        source: 'local_policy'
      };
    }
    if (plan.status !== 'compiled') {
      return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.compile',
        arguments: { plan_id: plan.id },
        rationale: 'Compile the exact model plan to immutable native control and experiment workflows.',
        source: 'local_policy'
      };
    }
    if (!experiment.result || experiment.result.status !== 'executed') {
      return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.execute',
        arguments: { plan_id: plan.id },
        rationale: 'Run fresh native control and model experiment Test Runs.',
        source: 'local_policy'
      };
    }
    if (!inspectedCurrentExperiment(context, experiment)) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.inspect',
        arguments: { plan_id: plan.id },
        rationale: 'Inspect safe execution facts before judging or revising the model plan.',
        source: 'local_policy'
      };
    }
    if (!experiment.assessed) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.test_plan.assess',
        arguments: { plan_id: plan.id },
        rationale: 'Record a model assessment grounded in the current native result; revise the plan if its evidence gaps require another experiment.',
        source: 'local_policy'
      };
    }
    return {
      action: 'complete_task',
      summary: 'The model has completed a native control/experiment loop and recorded its evidence-gated assessment.',
      source: 'local_policy'
    };
  }
  const isModelingTask = context.task.execution_plan?.intent === 'model_features_and_candidates' || /candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title);
  if (shouldCompleteAfterLastTool(context)) {
    if (last?.tool_name === 'vuln.generate_candidates' && isModelingTask && !invoked(context, 'agent.shared_context.prepare')) {
      // Continue to shared context preparation before waiting/completing.
    } else if (last?.tool_name === 'agent.shared_context.prepare' && isModelingTask && selectedForPolicy.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities')) {
      // Continue to selected vulnerability expansion when scan creation already included selected_vuln_types.
    } else if (last?.tool_name === 'browser.discover_target' && context.task.execution_plan?.intent === 'discover_target' && isAccountAutoExecutionContext(context) && !invoked(context, 'bstg.identity.bootstrap_accounts')) {
      // Default account mode must attempt a real register/login bootstrap before discovery is considered complete.
    } else if (last?.tool_name === 'bstg.capabilities.inventory' && context.task.execution_plan?.intent !== 'inventory_bstg_capabilities') {
      // Capability inventory is a reusable background capability; executable sub-agents must still run their actual test tool.
    } else {
      if ((taskType === 'generate_candidates' || context.task.execution_plan?.intent === 'model_features_and_candidates') && selected.length === 0 && context.vulnerability_candidates.length > 0 && invoked(context, 'agent.shared_context.prepare') && !invoked(context, 'task.expand_selected_vulnerabilities')) {
        if (businessLearningAutoExperiments(context.scan)) return {
          action: 'complete_task',
          summary: 'Candidate inventory is retained without selecting generic vulnerability categories; verified business experiments continue independently.',
          source: 'local_policy'
        };
        return {
          action: 'wait_for_user_selection',
          summary: 'Feature tree and vulnerability candidates are ready; waiting for selected vulnerability types.',
          source: 'local_policy'
        };
      }
      return {
        action: 'complete_task',
        summary: last?.output_summary || `${last?.tool_name || 'tool'} completed.`,
        source: 'local_policy'
      };
    }
  }

  if ((context.task.execution_plan?.intent === 'inventory_bstg_capabilities' || /inventory|capabilit/i.test(taskType + ' ' + context.task.title)) && !invoked(context, 'bstg.capabilities.inventory')) {
    return {
      action: 'tool_call',
      tool_name: 'bstg.capabilities.inventory',
      arguments: {},
      rationale: 'First load native BSTG capabilities as controllable Agent tools.',
      source: 'local_policy'
    };
  }
  if (context.task.execution_plan?.intent === 'discover_target' || (/discover|understand|目标|发现/i.test(taskType + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title))) {
    if (isAndroidContext(context)) {
      const mobileCfg = context.scan.scan_config?.mobile || context.scan.scan_config?.android || {};
      if (!invoked(context, 'mobile.lab.prepare')) {
        return {
          action: 'tool_call',
          tool_name: 'mobile.lab.prepare',
          arguments: {
            profile_id: mobileCfg.lab_profile_id,
            app_package: mobileCfg.app_package,
            app_activity: mobileCfg.app_activity,
            apk_path: mobileCfg.apk_path
          },
          rationale: 'Prepare Android Mobile Lab with preconfigured Burp/proxy/certificate health gate before App automation.',
          source: 'local_policy'
        };
      }
      if (!invoked(context, 'mobile.app.install')) {
        return {
          action: 'tool_call',
          tool_name: 'mobile.app.install',
          arguments: { apk_path: mobileCfg.apk_path },
          rationale: 'Install authorized APK when supplied, otherwise verify preinstalled App path.',
          source: 'local_policy'
        };
      }
      if (mobileCfg.acquisition_mode !== 'explore' && !invoked(context, 'mobile.app.launch')) {
        return {
          action: 'tool_call',
          tool_name: 'mobile.app.launch',
          arguments: {
            app_package: mobileCfg.app_package,
            app_activity: mobileCfg.app_activity
          },
          rationale: 'Launch the Android App for UIAutomator/Appium-style observation.',
          source: 'local_policy'
        };
      }
      if (mobileCfg.acquisition_mode !== 'explore' && !invoked(context, 'mobile.observe')) {
        return {
          action: 'tool_call',
          tool_name: 'mobile.observe',
          arguments: {},
          rationale: 'Capture Android screenshot and UIAutomator hierarchy for the right-side App panel.',
          source: 'local_policy'
        };
      }
      const acquisitionTool = mobileCfg.acquisition_mode === 'explore' ? 'mobile.app.explore' : 'mobile.flow.run';
      if (!invoked(context, acquisitionTool)) {
        return {
          action: 'tool_call',
          tool_name: acquisitionTool,
          arguments: mobileCfg.acquisition_mode === 'explore' ? {} : { steps: mobileCfg.flow_steps || [] },
          rationale: 'Run deterministic Android App flow to create authenticated state and business objects before importing traffic.',
          source: 'local_policy'
        };
      }
      if (!invoked(context, 'mobile.capture.import')) {
        return {
          action: 'tool_call',
          tool_name: 'mobile.capture.import',
          arguments: {
            export_path: mobileCfg.burp_flow_export_path,
            regenerate: true
          },
          rationale: 'Import decrypted Burp mobile flows into BSTG recording, API templates and workflow drafts.',
          source: 'local_policy'
        };
      }
      if (!invoked(context, 'mobile.lab.stop'))
        return {
          action: 'tool_call',
          tool_name: 'mobile.lab.stop',
          arguments: {},
          rationale: 'Release owned Android/proxy resources after persisting the capture.',
          source: 'local_policy'
        };
      return {
        action: 'complete_task',
        summary: 'Android App discovery flow completed; mobile capture has been imported for feature and vulnerability modeling.',
        source: 'local_policy'
      };
    }
    if (!invoked(context, 'browser.navigate')) {
      return {
        action: 'tool_call',
        tool_name: 'browser.navigate',
        arguments: {
          url: executionBaseUrl(context),
          timeout_ms: context.scan.scan_config?.timeout_ms || 45000
        },
        rationale: 'Navigate target and capture browser state before endpoint discovery.',
        source: 'local_policy'
      };
    }
    if (!invoked(context, 'browser.discover_target')) {
      return {
        action: 'tool_call',
        tool_name: 'browser.discover_target',
        arguments: { max_pages: context.scan.scan_config?.max_pages || 1000 },
        rationale: 'Discover endpoints, forms, upload controls, and page observations.',
        source: 'local_policy'
      };
    }
    if (isAccountAutoExecutionContext(context) && !invoked(context, 'bstg.identity.bootstrap_accounts')) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.identity.bootstrap_accounts',
        // The trusted account bootstrap reads its role, page, and optional
        // form settings from the canonical persisted run. Do not copy those
        // fields into model-visible invocation history, where form overrides
        // may contain operator-provided sensitive values.
        arguments: {},
        rationale: 'Default account mode requires a real registration/login bootstrap from the persisted account configuration before downstream authenticated testing.',
        source: 'local_policy'
      };
    }
  }
  if (context.task.execution_plan?.intent === 'expand_selected_vulnerabilities') {
    const selectedForExpansion = Array.isArray(context.task.execution_plan?.selected_vuln_types) && context.task.execution_plan.selected_vuln_types.length ? context.task.execution_plan.selected_vuln_types : selected;
    if (!invoked(context, 'task.expand_selected_vulnerabilities'))
      return {
        action: 'tool_call',
        tool_name: 'task.expand_selected_vulnerabilities',
        arguments: { selected_vuln_types: selectedForExpansion },
        rationale: 'Expand selected vulnerability types into persistent executable tasks.',
        source: 'local_policy'
      };
    return {
      action: 'complete_task',
      summary: `Expanded selected vulnerability types: ${selectedForExpansion.join(', ')}`,
      source: 'local_policy'
    };
  }

  if (isModelingTask) {
    if (!invoked(context, 'feature.extract_tree'))
      return {
        action: 'tool_call',
        tool_name: 'feature.extract_tree',
        arguments: {},
        rationale: 'Build feature/sub-feature tree before vulnerability inference.',
        source: 'local_policy'
      };
    if (!invoked(context, 'vuln.generate_candidates'))
      return {
        action: 'tool_call',
        tool_name: 'vuln.generate_candidates',
        arguments: {},
        rationale: 'Generate vulnerability candidates from feature and endpoint model.',
        source: 'local_policy'
      };
    if (!invoked(context, 'agent.shared_context.prepare'))
      return {
        action: 'tool_call',
        tool_name: 'agent.shared_context.prepare',
        arguments: { selected_vuln_types: selectedForPolicy },
        rationale: 'Prepare reusable cross-agent shared context before selection/expansion.',
        source: 'local_policy'
      };
    if (selectedForPolicy.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities'))
      return {
        action: 'tool_call',
        tool_name: 'task.expand_selected_vulnerabilities',
        arguments: { selected_vuln_types: selectedForPolicy },
        rationale: 'Selected vulnerability categories exist; expand them into persistent executable tasks.',
        source: 'local_policy'
      };
    if (businessLearningAutoExperiments(context.scan)) return {
      action: 'complete_task',
      summary: 'Candidate inventory is retained without selecting generic vulnerability categories; verified business experiments continue independently.',
      source: 'local_policy'
    };
    return {
      action: 'wait_for_user_selection',
      summary: 'Candidates generated; waiting for user-selected vulnerability categories.',
      source: 'local_policy'
    };
  }
  if (context.task.execution_plan?.intent === 'summarize_vulnerability_campaign' || taskType === 'summarize_vulnerability_campaign') {
    const summaryVulnType = vulnType || 'generic';
    if (!invoked(context, 'task.summarize_vulnerability_campaign'))
      return {
        action: 'tool_call',
        tool_name: 'task.summarize_vulnerability_campaign',
        arguments: {
          campaign_task_id: context.task.execution_plan?.campaign_task_id,
          child_task_ids: context.task.execution_plan?.child_task_ids || [],
          vuln_type: summaryVulnType
        },
        rationale: 'All child sub-agent tasks for this vulnerability campaign have completed; summarize campaign evidence and residual gaps.',
        source: 'local_policy'
      };
    return {
      action: 'complete_task',
      summary: `${summaryVulnType} campaign summarized.`,
      source: 'local_policy'
    };
  }
  if (taskType === 'test_file_upload' || vulnType === 'file_upload') {
    return {
      action: 'tool_call',
      tool_name: 'bstg.file_upload.run_test',
      arguments: {
        endpoint_id: endpointId(context, vulnType),
        endpoint_ids: context.task.endpoint_ids || []
      },
      rationale: 'File upload requires normal upload, mutation upload, post-upload access, and native workflow/API evidence.',
      source: 'local_policy'
    };
  }
  if (taskType.startsWith('test_') || hasExplicitVulnType) {
    const simpleApiTypes = new Set(['xss', 'command_injection', 'file_download', 'path_traversal']);
    if (simpleApiTypes.has(vulnType) && !invoked(context, 'bstg.api_test.run')) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.api_test.run',
        arguments: {
          endpoint_id: endpointId(context, vulnType),
          vuln_type: vulnType
        },
        rationale: 'This vulnerability is single-interface suitable; execute native API test-run mode first.',
        source: 'local_policy'
      };
    }
    return {
      action: 'tool_call',
      tool_name: 'bstg.generic_vuln.run_test',
      arguments: {
        endpoint_id: endpointId(context, vulnType),
        endpoint_ids: context.task.endpoint_ids || []
      },
      rationale: 'Run native BSTG vulnerability task with workflow/API evidence and finding gate.',
      source: 'local_policy'
    };
  }
  return {
    action: 'complete_task',
    summary: 'No additional action needed for this task.',
    source: 'local_policy'
  };
}

export class AutonomousAgentPlanner {
  constructor(private readonly db: DbProvider) {}

  async decide(context: AutonomousAgentContext): Promise<AutonomousPlannerResult> {
    // Login preparation is a lifecycle requirement and cannot be skipped by a provider decision.
    if (context.task.execution_plan?.intent === MANUAL_IDENTITY_INTENT) {
      if (!invoked(context, 'bstg.identity.bootstrap_accounts'))
        return {
          action: 'tool_call',
          tool_name: 'bstg.identity.bootstrap_accounts',
          arguments: {},
          source: 'local_policy',
          rationale: 'Prepare saved manual identities before authenticated tests.'
        };
      return {
        action: 'complete_task',
        source: 'local_policy',
        summary: '账号登录准备已记录；测试按各角色的实际会话和阻断结果执行。'
      };
    }
    if (context.task.execution_plan?.intent === 'expand_selected_vulnerabilities' && context.task.execution_plan?.identity_preparation_task_id) {
      if (!invoked(context, 'task.expand_selected_vulnerabilities'))
        return {
          action: 'tool_call',
          tool_name: 'task.expand_selected_vulnerabilities',
          arguments: {
            selected_vuln_types: context.task.execution_plan.selected_vuln_types || context.selected_vuln_types
          },
          source: 'local_policy',
          rationale: 'Build deferred workflows using the persisted identity preparation result.'
        };
      return {
        action: 'complete_task',
        source: 'local_policy',
        summary: '已按实际账号准备结果生成测试计划。'
      };
    }
    const config = context.scan.scan_config || {};
    if (isDedicatedWebDiscovery(context.task, config) && requiresAutomaticAccounts(config) && context.task.phase === DISCOVERY_COMPLETED_PHASE) {
      // This persisted phase follows the successful discovery invocation. A prior
      // bootstrap cannot satisfy it, and model continuation cannot skip it.
      return {
        action: 'tool_call',
        tool_name: 'bstg.identity.bootstrap_accounts',
        arguments: {},
        source: 'local_policy',
        rationale: 'Complete persisted account preparation after discovery before releasing dependent tasks.'
      };
    }
    const policyDecision = localPolicy(context);
    // A retry target gap has one native environment recovery step. Do not
    // spend a provider decision on a completion claim while that step is due.
    if (coverageRetryCompletionRecoveryRequired(context)) return policyDecision;
    // The post-action recovery is fixed read-only lifecycle work after a
    // browser action may have run. It is safe local work, not a model-selected
    // interaction, and asking the provider during it could encourage a
    // duplicate state-changing operation before evidence is refreshed.
    if (context.model_scope?.stage === 'normal_business_learning' &&
        ['normal_post_action_capture_requires_inspection',
          'normal_post_action_capture_requires_authoritative_observation',
          'normal_post_action_capture_requires_post_observation_inspection'].includes(context.task.phase || '') &&
        policyDecision.action === 'tool_call' &&
        ['bstg.business.capture.inspect', 'browser.interact'].includes(String(policyDecision.tool_name || ''))) return policyDecision;
    // A native step/ordering mismatch has one read-only recovery action. The
    // refreshed inspection is information only; the next provider turn still
    // chooses every corrected WorkflowStep reference.
    if (context.task.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT &&
        context.task.phase === 'experiment_workflow_step_binding_requires_inspection' &&
        policyDecision.action === 'tool_call' && policyDecision.tool_name === 'bstg.workflow.inspect') return policyDecision;
    // Compilation rejection gets one exact-plan read-only refresh. This is a
    // deterministic evidence step; the provider owns the subsequent child
    // plan contents after the inspection is complete.
    if (context.task.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT &&
        context.task.phase === 'experiment_compile_requires_inspection' &&
        policyDecision.action === 'tool_call' && policyDecision.tool_name === 'bstg.test_plan.inspect') return policyDecision;
    // The mobile acquisition contract is deterministic. An LLM may not skip
    // install/launch/assertions/capture/cleanup or pronounce this phase complete.
    const mobileDiscovery = isAndroidContext(context) && (context.task.execution_plan?.intent === 'discover_target' || (/discover|understand|目标|发现/i.test(context.task.task_type + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(context.task.task_type + ' ' + context.task.title)));
    if (mobileDiscovery) return policyDecision;
    // Imported App traffic is tested by the native security executor. Once a
    // mobile test has produced its evidence, a later model decision must not
    // restart the stopped capture session or switch to an incompatible
    // acquisition mode. The executor itself still uses the configured model
    // for vulnerability judgement.
    if (isAndroidContext(context) && (String(context.task.task_type || '').startsWith('test_') || context.task.execution_plan?.intent === 'model_features_and_candidates' || /candidate|feature|漏洞候选|功能树/i.test(String(context.task.task_type || '') + ' ' + String(context.task.title || '')))) return policyDecision;
    let provider: AIProvider | null = null;
    let providerError: unknown = null;
    try {
      provider = await getDefaultProvider(this.db);
    } catch (error) {
      providerError = error;
    }
    if (!provider) {
      const reason = providerError instanceof Error ? providerError.message : '未配置可用的模型服务。请在模型设置中启用并验证连接，再重新测试。';
      agentEventBus.publish({
        kind: 'agent_state_changed',
        status: 'blocked',
        scan_run_id: context.task.scan_run_id,
        task_id: context.task.id,
        error: reason,
        summary: '模型服务不可用，本轮停止执行。'
      });
      throw new Error(reason);
    }
    agentEventBus.publish({
      kind: 'agent_state_changed',
      status: 'info',
      scan_run_id: context.task.scan_run_id,
      task_id: context.task.id,
      provider_id: provider.id,
      model: provider.model,
      summary: `Agent 已选择真实 provider：${provider.id}`
    });

    const client = new AIClient(provider);
    const system = plannerSystemPrompt(context);
    const normalBusinessLearning = context.model_scope?.stage === 'normal_business_learning';
    const normalBusinessPlanning = context.model_scope?.stage === 'normal_business_planning';
    const normalBusinessRevisionRequired = normalBusinessLearning && context.task.phase === 'normal_validation_repeated_execution_error_requires_model_revision';
    const normalFlowCurrentBrowserRequirement = normalBusinessLearning
      ? currentNormalBrowserRequirement(context, policyDecision) : undefined;
    const allowedActions = context.model_scope?.allowed_actions?.join(' | ') || 'tool_call | complete_task | fail_task | block_task | wait_for_user_selection | create_child_tasks';
    // execution_base_url is a server-only dispatch capability. Excluding it
    // here ensures raw target/query data never reaches the provider, while
    // the local lifecycle still uses it for deterministic prerequisite steps.
    const {
      execution_base_url: _executionBaseUrl,
      // Lifecycle history is a server-side guard input. It is intentionally
      // distinct from the bounded task_tool_invocations provider projection.
      lifecycle_tool_invocations: _lifecycleToolInvocations,
      ...modelContext
    } = context;
    // A repeated native execution failure has already consumed the bounded
    // repair path. From here the model must reconstruct the recorded Workflow
    // itself. Expose only that one mutating capability so it cannot revalidate
    // the same failed snapshot or drift into browser/capture tools.
    const revisionTools = normalBusinessRevisionRequired
      ? (modelContext.available_tools || []).filter((tool: any) => tool?.name === 'bstg.business.workflow.revise')
      : undefined;
    const revisionModelContext = normalBusinessRevisionRequired
      ? {
          ...modelContext,
          available_tools: revisionTools,
          model_scope: modelContext.model_scope
            ? { ...modelContext.model_scope, allowed_tool_names: (revisionTools || []).map((tool: any) => tool.name), allowed_actions: ['tool_call'] }
            : modelContext.model_scope,
        }
      : modelContext;
    // A positive finite prerequisite count is a one-turn capability lease,
    // not a scripted browser action. Keeping only its semantic transaction
    // tools visible prevents lifecycle tools, generic browser calls, and
    // opaque control identifiers from competing with the model's business
    // intent choice.
    const transactionCandidateMap = normalFlowCurrentBrowserRequirement
      ? currentTransactionCandidateMap(context, normalFlowCurrentBrowserRequirement) : new Map<number, string>();
    const narrowedTransactionModelContext = normalFlowCurrentBrowserRequirement
      ? currentTransactionInteractionView(revisionModelContext, normalFlowCurrentBrowserRequirement, transactionCandidateMap) : undefined;
    const transactionLeaseTools = narrowedTransactionModelContext && normalFlowCurrentBrowserRequirement
      ? currentTransactionInteractionTools(revisionModelContext.available_tools || [], narrowedTransactionModelContext, normalFlowCurrentBrowserRequirement)
      : undefined;
    const currentTurnModelContext = narrowedTransactionModelContext
      ? {
          ...narrowedTransactionModelContext,
          available_tools: transactionLeaseTools,
          model_scope: modelContext.model_scope
            ? { ...modelContext.model_scope, allowed_tool_names: (transactionLeaseTools || []).map((tool) => tool.name), allowed_actions: ['tool_call'] }
            : modelContext.model_scope,
      }
      : revisionModelContext;
    const experimentAllowedActions = businessExperimentAllowedActions(context, policyDecision);
    const experimentAllowedTools = businessExperimentAllowedToolNames(context, policyDecision, experimentAllowedActions);
    const experimentScopedModelContext = experimentAllowedActions && currentTurnModelContext.model_scope
      ? {
          ...currentTurnModelContext,
          ...(experimentAllowedTools
            ? { available_tools: (currentTurnModelContext.available_tools || []).filter((tool: any) => experimentAllowedTools.includes(tool.name)) }
            : {}),
          model_scope: {
            ...currentTurnModelContext.model_scope,
            allowed_actions: experimentAllowedActions,
            ...(experimentAllowedTools ? { allowed_tool_names: experimentAllowedTools } : {}),
          },
        }
      : currentTurnModelContext;
    const currentTurnAllowedActions = experimentAllowedActions
      ? experimentAllowedActions.join(' | ')
      : normalFlowCurrentBrowserRequirement || normalBusinessRevisionRequired ? 'tool_call' : allowedActions;
    const userPayload = sanitizeForAIModel({
      context: experimentScopedModelContext,
      deterministic_next_step: policyDecision,
      ...(normalFlowCurrentBrowserRequirement ? { current_normal_browser_requirement: normalFlowCurrentBrowserRequirement } : {}),
      required_output: {
        action: currentTurnAllowedActions,
        tool_name: 'required only for tool_call',
        arguments: 'object; match selected tool input_schema',
        tool_dispatch: 'For tool_call, return the exact context.available_tools name and arguments in this JSON. BSTG executes this response directly; no separate function-call channel is needed.',
        ...(normalBusinessPlanning
          ? {
              planning_completion: 'Allowed only after the model calls bstg.business.coverage.save successfully. Before that, choose a listed tool_call; model-selected flows and coverage meanings must remain explicit tool inputs.'
            }
          : { reason: 'required for fail_task or block_task' }),
        rationale: normalBusinessLearning ? 'why this advances or repairs the current normal flow using persisted observations' : 'why this increases vulnerability discovery or closes replay gaps',
        ...(normalBusinessLearning
          ? {
              normal_flow_compilation: 'After a stopped capture has been inspected, choose the exact nonempty event_ids yourself for bstg.business.workflow.prepare. The deterministic_next_step value model_decision_required is an internal hint only: never return it. Return a normal tool_call for workflow.prepare with the inspected IDs. BSTG will reject omission and never substitutes every captured event.',
              normal_flow_blocking: 'block_task is not allowed. For a hard blocker, call bstg.business.flow.block with flow_id, evidence_artifact_id, and reason; otherwise inspect/adapt the current Flow. For assertion_revision_required, inspect then correct the same workflow. For a first native execution error, call bstg.business.workflow.repair with the current workflow_id and test_run_id, inspect, then revalidate. A repeated execution error after repair requires model-selected bstg.business.workflow.revise event_ids; it is never an automatic skip.',
              ...(normalBusinessRevisionRequired
                ? {
                    normal_flow_reconstruction: 'The repaired current workflow repeated a native execution error. Return a tool_call for the only listed tool, bstg.business.workflow.revise, with the exact current workflow_id, test_run_id, one or more exact workflow-eligible event_ids from the stopped capture/current Flow, and a concise rationale. You choose the subset. If the latest capture inspection or prior tool feedback lists transaction prerequisite intent groups, retain one opaque ID from every required group that precedes the final operation. Retain every currently bound observed coverage target. A separately planned target absent from this stopped recording remains for a fresh retry after native validation. Do not call repair or validate again on the same failed path.'
                  }
                : {})
            }
          : {}),
        ...(experimentAllowedActions
          ? {
              experiment_terminal_contract: experimentAllowedActions.includes('block_task') || experimentAllowedActions.includes('fail_task')
                ? 'Use only the currently allowed terminal action. It is available only because BSTG local policy or a persisted experiment record supports that exact action.'
                : experimentAllowedActions.includes('complete_task')
                  ? 'Completion is the only allowed action because the current native experiment assessment passed BSTG’s evidence gate.'
                  : 'Only tool_call is allowed, and context.available_tools contains the currently executable experiment lifecycle tool plus any unused bounded read-only pre-plan lookup. Do not return block_task, fail_task, wait_for_user_selection, create_child_tasks, or complete_task.'
            }
          : {}),
        ...(normalFlowCurrentBrowserRequirement
          ? {
              transaction_lease: 'This is the immediate one-turn transaction capability lease. Return only one exact listed bstg.transaction.* tool name. For bstg.transaction.trigger, choose operation.intent from its enum yourself; include candidate_index only if the selected intent has multiple live candidates. Do not return browser.interact or a browser reference in this lease.'
            }
          : {})
      }
    });
    const telemetry = agentEventBus.beginLLM({
      scan_run_id: context.task.scan_run_id,
      task_id: context.task.id,
      provider_id: provider.id,
      model: provider.model,
      request: {
        model: provider.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(userPayload) }
        ]
      },
      message_count: 2
    });
    try {
      const response = await client.chat(
        {
          model: provider.model,
          temperature: 0.1,
          max_tokens: 1800,
          ...(provider.id === 'internal-agent-relay' ? {} : { response_format: { type: 'json_object' } }),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: JSON.stringify(userPayload) }
          ]
        },
        {
          scan_run_id: context.task.scan_run_id,
          task_id: context.task.id,
          emit_events: false
        }
      );
      telemetry.succeed(response);
      const content = response.choices?.[0]?.message?.content || '';
      const parsed = safeJsonParse(content);
      let normalized = normalizeDecision(parsed);
      if (!normalized) throw new Error(`AI provider returned invalid decision JSON: ${content.slice(0, 400)}`);
      if (normalFlowCurrentBrowserRequirement) normalized = resolveTransactionCandidateProposal(context, normalFlowCurrentBrowserRequirement, normalized, transactionCandidateMap);
      const experimentRecovery = businessExperimentProposalRecovery(context, normalized, policyDecision, experimentAllowedActions, experimentAllowedTools);
      if (experimentRecovery) {
        return {
          ...experimentRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: experimentRecovery.reason
        };
      }
      const experimentScope = experimentAllowedActions && context.model_scope
        ? {
            ...context.model_scope,
            allowed_actions: experimentAllowedActions,
            ...(experimentAllowedTools ? { allowed_tool_names: experimentAllowedTools } : {}),
          }
        : context.model_scope;
      const scopeError = modelDecisionScopeError(normalized, experimentScope);
      const flowBlockEvidenceRecovery = normalFlowBlockEvidenceProposalRecovery(context, normalized);
      if (flowBlockEvidenceRecovery) {
        return {
          ...flowBlockEvidenceRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: flowBlockEvidenceRecovery.reason
        };
      }
      const planningRecovery = normalBusinessPlanningProposalRecovery(context, normalized);
      if (planningRecovery) {
        return {
          ...planningRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: planningRecovery.reason
        };
      }
      const revisionRecovery = normalBusinessRevisionProposalRecovery(context, normalized);
      if (revisionRecovery) {
        return {
          ...revisionRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: revisionRecovery.reason
        };
      }
      const protocolRecovery = scopedToolProtocolRecovery(context, normalized, policyDecision);
      if (protocolRecovery) {
        return {
          ...protocolRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: protocolRecovery.reason
        };
      }
      const captureRecovery = normalBusinessCaptureProposalRecovery(context, normalized, policyDecision);
      if (captureRecovery) {
        return {
          ...captureRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: captureRecovery.reason,
          rejection_code: captureRecovery.rejection_code,
          rejection_context: captureRecovery.rejection_context
        };
      }
      const selectorRecovery = normalBusinessSelectorProposalRecovery(context, normalized);
      if (selectorRecovery) {
        return {
          ...selectorRecovery.decision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: selectorRecovery.reason
        };
      }
      if (scopeError) {
        // Keep the actual receipt and rejected proposal for the next context,
        // but use the persisted lifecycle guidance rather than allowing an
        // out-of-stage capability to reach the global registry.
        const recoveryDecision = normalBusinessPlanningScopeRecovery(context, normalized) || rejectedNormalLearningTerminalRecovery(context, normalized, policyDecision);
        return {
          ...recoveryDecision,
          source: 'local_policy',
          proposal: normalized,
          raw_response: parsed,
          provider_id: provider.id,
          model: response.model,
          provider_response_id: response.id,
          ai_provider_attempted: true,
          ai_usage: response.usage,
          policy_decision: policyDecision,
          validation_status: 'rejected',
          rejection_reason: scopeError
        };
      }
      return {
        ...normalized,
        source: 'ai_provider',
        raw_response: parsed,
        provider_id: provider.id,
        model: response.model,
        provider_response_id: response.id,
        ai_provider_attempted: true,
        ai_usage: response.usage,
        policy_decision: policyDecision,
        validation_status: 'accepted'
      };
    } catch (error: unknown) {
      // Keep provider response bodies out of telemetry, events, and durable
      // task diagnostics. The structured AI-client classification retains the
      // retry decision without carrying gateway output across this boundary.
      const safeError = safeAIProviderFailureSummary(error);
      telemetry.fail(new Error(safeError));
      const retryable = isRetryableAIProviderError(error);
      agentEventBus.publish({
        kind: 'agent_state_changed',
        status: retryable ? 'info' : 'failed',
        scan_run_id: context.task.scan_run_id,
        task_id: context.task.id,
        provider_id: provider.id,
        model: provider.model,
        error: safeError,
        summary: retryable ? '模型服务暂时不可用，Agent 将在不重放工具的前提下重试决策。' : '模型决策失败，本轮停止执行。请检查服务权限或连接后重试。'
      });
      if (retryable) throw new AgentProviderDecisionUnavailableError();
      throw new Error(`模型服务未完成本次请求：${safeError}`);
    }
  }
}
