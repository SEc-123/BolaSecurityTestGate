import type { AIScanArtifact, AIScanRun, AIScanTask } from '../services/ai-scan/types.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { DbProvider, TestRun, Workflow } from '../types/index.js';
import { saveBusinessFlow, type BusinessFlow } from '../services/ai-scan/agent-business-contract.js';

export const BUSINESS_PLAN_INTENT = 'plan_business_flows';
export const BUSINESS_LEARNING_INTENT = 'learn_business_flow';
export const BUSINESS_REVIEW_INTENT = 'review_business_flows';
export const BUSINESS_EXPERIMENT_INTENT = 'model_business_experiment';
export const BUSINESS_COVERAGE_ARTIFACT = 'business_flow_coverage';

/**
 * Planning is deliberately broader than a list of happy-path flows.  Each
 * discovered operation remains visible until the model either associates it
 * with a normal flow or writes down why it is deliberately deferred/blocked.
 * This record is safe to show to the model: it contains identifiers and
 * descriptions, never captured request values.
 */
export interface BusinessCoverageTarget {
  key: string;
  target_type: 'feature' | 'operation';
  target_id: string;
  name: string;
  feature_id?: string;
}

export interface BusinessCoverageEntry {
  target_type: 'feature' | 'operation';
  target_id: string;
  disposition: 'planned' | 'deferred' | 'blocked';
  flow_id?: string;
  reason?: string;
}

export interface BusinessCoverageRecord {
  revision: number;
  plan_task_id: string;
  target_manifest: BusinessCoverageTarget[];
  entries: BusinessCoverageEntry[];
}

export function businessCoverageKey(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

/**
 * A feature node that actually owns one or more endpoints is an operable
 * feature.  Every discovered endpoint is also an operation target, including
 * endpoints that have not yet been attached to a feature tree.  Keeping both
 * makes the coverage gate robust while discovery is still refining the tree.
 */
export async function businessCoverageTargets(repo: AIScanRepository, scanRunId: string): Promise<BusinessCoverageTarget[]> {
  const [features, endpoints] = await Promise.all([repo.listFeatures(scanRunId), repo.listEndpoints(scanRunId)]);
  const targets: BusinessCoverageTarget[] = [];
  for (const feature of features) {
    if (!Array.isArray(feature.endpoint_ids) || feature.endpoint_ids.length === 0) continue;
    targets.push({
      key: businessCoverageKey('feature', feature.id),
      target_type: 'feature',
      target_id: feature.id,
      name: feature.name,
    });
  }
  for (const endpoint of endpoints) {
    const owner = features.find(feature => (feature.endpoint_ids || []).includes(endpoint.id));
    targets.push({
      key: businessCoverageKey('operation', endpoint.id),
      target_type: 'operation',
      target_id: endpoint.id,
      name: `${endpoint.method} ${endpoint.path}`,
      ...(owner ? { feature_id: owner.id } : {}),
    });
  }
  return targets.sort((left, right) => left.key.localeCompare(right.key));
}

function artifactRevision(artifact: AIScanArtifact): number {
  return Number.isInteger(artifact.content_json?.revision) ? Number(artifact.content_json.revision) : 0;
}

function newestArtifact(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  return [...artifacts].sort((left, right) =>
    String(right.created_at).localeCompare(String(left.created_at)) || artifactRevision(right) - artifactRevision(left))[0];
}

export function latestBusinessCoverage(artifacts: AIScanArtifact[], planTaskId: string): AIScanArtifact | undefined {
  return newestArtifact(artifacts.filter(artifact => artifact.artifact_type === BUSINESS_COVERAGE_ARTIFACT &&
    artifact.task_id === planTaskId && artifact.content_json?.plan_task_id === planTaskId));
}

/** A coverage record is current only when it names every currently discovered
 * actionable feature/operation exactly once.  It is intentionally an async
 * gate because discovery may have added a target after the previous plan. */
export async function businessPlanningCompletionGap(repo: AIScanRepository, planTask: AIScanTask,
  flows: BusinessFlow[], artifacts: AIScanArtifact[] = []): Promise<string | undefined> {
  const coverageArtifact = latestBusinessCoverage(artifacts, planTask.id);
  if (!coverageArtifact) return 'No model-saved business coverage list exists. Cover every discovered feature/operation or record a deferred/blocked reason.';
  const coverage = coverageArtifact.content_json as Partial<BusinessCoverageRecord>;
  if (!Array.isArray(coverage.entries) || !Array.isArray(coverage.target_manifest)) {
    return 'The saved business coverage list is malformed; inspect the current discovery targets and save it again.';
  }
  const targets = await businessCoverageTargets(repo, planTask.scan_run_id);
  const expected = new Map(targets.map(target => [target.key, target]));
  const seen = new Set<string>();
  for (const entry of coverage.entries as BusinessCoverageEntry[]) {
    const key = businessCoverageKey(String(entry?.target_type || ''), String(entry?.target_id || ''));
    if (!expected.has(key)) return `The saved coverage list names an obsolete or unknown target (${key}); refresh it from current discovery.`;
    if (seen.has(key)) return `The saved coverage list names ${key} more than once.`;
    seen.add(key);
    if (!['planned', 'deferred', 'blocked'].includes(String(entry?.disposition || ''))) {
      return `Coverage for ${key} has no valid planned, deferred, or blocked disposition.`;
    }
    if (entry.disposition === 'planned') {
      if (!entry.flow_id || !flows.some(flow => flow.id === entry.flow_id)) {
        return `Coverage for ${key} is planned but does not reference a current saved business flow.`;
      }
    } else if (!String(entry.reason || '').trim()) {
      return `Coverage for ${key} is ${entry.disposition} without a concrete reason.`;
    }
  }
  const missing = [...expected.keys()].filter(key => !seen.has(key));
  if (missing.length) return `The model coverage list still omits ${missing.length} discovered feature/operation target(s): ${missing.slice(0, 8).join(', ')}.`;
  return undefined;
}

export function businessLearningEnabled(run: Pick<AIScanRun, 'scan_config'>): boolean {
  const config = run.scan_config || {};
  return ![config.surface, config.surface_type, config.mobile?.platform, config.android?.platform].includes('android') &&
    config.business_learning !== false && config.business_learning?.enabled !== false;
}

export function latestBusinessFlows(artifacts: AIScanArtifact[]): BusinessFlow[] {
  const latest = new Map<string, AIScanArtifact>();
  for (const artifact of artifacts.filter(item => item.artifact_type === 'business_flow')) {
    const id = String(artifact.content_json?.id || '');
    if (!id) continue;
    const previous = latest.get(id);
    if (!previous || Number(artifact.content_json.revision || 0) > Number(previous.content_json.revision || 0) ||
      (Number(artifact.content_json.revision || 0) === Number(previous.content_json.revision || 0) &&
        String(artifact.created_at) > String(previous.created_at))) latest.set(id, artifact);
  }
  return [...latest.values()].map(artifact => artifact.content_json as BusinessFlow);
}

/** The scheduler owns stage/dependency construction. Business names, goals,
 * operations, mappings and assertions remain the model's observed decisions. */
export async function scheduleBusinessLearning(repo: AIScanRepository, planTask: AIScanTask): Promise<AIScanTask[]> {
  const artifacts = await repo.listArtifacts(planTask.scan_run_id);
  const flows = latestBusinessFlows(artifacts);
  const coverageGap = await businessPlanningCompletionGap(repo, planTask, flows, artifacts);
  if (coverageGap) throw new Error(coverageGap);
  const coverage = latestBusinessCoverage(artifacts, planTask.id)?.content_json as BusinessCoverageRecord;
  const plannedFlowIds = new Set((coverage.entries || []).filter(entry => entry.disposition === 'planned').map(entry => entry.flow_id).filter((id): id is string => Boolean(id)));
  const existing = await repo.listTasks(planTask.scan_run_id);
  const learning: AIScanTask[] = [];
  for (const flow of flows.filter(item => plannedFlowIds.has(item.id))) {
    const previous = existing.find(task => task.execution_plan?.intent === BUSINESS_LEARNING_INTENT && task.execution_plan.flow_id === flow.id);
    if (previous) { learning.push(previous); continue; }
    const task = await repo.createTask({scan_run_id: planTask.scan_run_id, parent_task_id: planTask.id,
      task_type: 'learn_business_flow', title: `学习并验证正常业务：${flow.name}`, priority: 25,
      dependencies: [planTask.id], agent_goal: `完成并核验“${flow.name}”的正常业务目标：${flow.goal}。先开始绑定该流程和身份的录制，再实际操作页面；检查有序请求、响应和参数依赖，复用原生录制生成器准备 Workflow，选择有证据的映射和结果断言，执行新的正常 Test Run。失败时观察原因并调整，不把录制或 HTTP 成功算作业务验证。`,
      execution_plan: {intent: BUSINESS_LEARNING_INTENT, flow_id: flow.id, identity_key: flow.role,
        feature_id: flow.feature_id, parallel_capable: false, requires_identity_context: flow.role !== 'anonymous'}});
    await saveBusinessFlow(repo, planTask.scan_run_id, task.id, {...flow, owner_task_id: task.id});
    learning.push(task);
  }
  const review = existing.find(task => task.execution_plan?.intent === BUSINESS_REVIEW_INTENT && task.status === 'pending');
  if (review) await repo.updateTask(review.id, {dependencies: [...new Set([planTask.id, ...learning.map(task => task.id)])]});
  return learning;
}

/**
 * Review is a fan-out point, not a global pass/fail gate. A blocked refund
 * flow must remain visible and repairable, but it must not prevent an already
 * verified profile/order flow from reaching a model-designed native experiment.
 */
export async function scheduleBusinessExperiments(repo: AIScanRepository, reviewTask: AIScanTask): Promise<AIScanTask[]> {
  const artifacts = await repo.listArtifacts(reviewTask.scan_run_id);
  const flows = latestBusinessFlows(artifacts).filter(flow => flow.status === 'verified' && flow.assertions_verified === true && Boolean(flow.normal_run_id) && Boolean(flow.workflow_id));
  const existing = await repo.listTasks(reviewTask.scan_run_id);
  const experiments: AIScanTask[] = [];
  for (const flow of flows) {
    const prior = existing.find(task => task.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && task.execution_plan?.flow_id === flow.id);
    if (prior) { experiments.push(prior); continue; }
    experiments.push(await repo.createTask({
      scan_run_id: reviewTask.scan_run_id,
      parent_task_id: reviewTask.id,
      task_type: 'model_business_experiment',
      title: `模型驱动业务实验：${flow.name}`,
      priority: 42,
      dependencies: [reviewTask.id],
      agent_goal: `基于已验证的正常业务“${flow.name}”设计并执行一个精确的原生安全实验。模型必须先检查流程结构，再自行选择具体步骤、字段变化、动态绑定、身份、重放/并发和语义断言；依次调用 bstg.test_plan.create、bstg.test_plan.compile、bstg.test_plan.execute、bstg.test_plan.inspect 与 bstg.test_plan.assess。安全或未证实的结果同样要如实记录；不能把假设、HTTP 状态或旧录制当成漏洞证据。`,
      execution_plan: {
        intent: BUSINESS_EXPERIMENT_INTENT,
        flow_id: flow.id,
        feature_id: flow.feature_id,
        normal_run_id: flow.normal_run_id,
        source_flow_revision: flow.revision,
        // The experiment owns immutable workflows/Test Runs. It may be queued
        // alongside feature/candidate modeling, so a blocked unrelated flow
        // cannot become a scheduler-wide serial barrier. Native requests
        // within the experiment still follow their model-selected order.
        parallel_capable: true,
        requires_identity_context: flow.role !== 'anonymous',
      },
    }));
  }
  return experiments;
}

function newestByRevision(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  // Revisions are local to a plan/result ID. A later model may create a new
  // plan ID with revision 1, so chronology chooses the current plan first;
  // revision resolves records created in the same database timestamp tick.
  return [...artifacts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) ||
    Number(b.content_json?.revision || 0) - Number(a.content_json?.revision || 0))[0];
}

function hasTerminalNativeRun(run: TestRun | null): boolean {
  return Boolean(run && run.completed_at && run.status === 'completed' && run.has_execution_error !== true);
}

function nativeRunOwnedBy(run: TestRun | null, expected: Record<string, unknown>): boolean {
  if (!run) return false;
  return Object.entries(expected).every(([key, value]) => run.execution_params?.[key] === value);
}

function hasNativeTrace(artifacts: AIScanArtifact[], task: AIScanTask, plan: Record<string, any>, kind: 'control' | 'experiment', testRunId: string): boolean {
  return artifacts.some(artifact => artifact.artifact_type === 'agent_experiment_native_trace' && artifact.task_id === task.id &&
    artifact.source_ref === testRunId && artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision &&
    artifact.content_json?.kind === kind && artifact.content_json?.test_run_id === testRunId && artifact.content_json?.private === true);
}

function record(value: unknown): Record<string, any> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isCurrentMutationWorkflow(workflow: Workflow | null, workflowId: string, plan: Record<string, any>): boolean {
  const profile = record(workflow?.mutation_profile);
  return Boolean(workflow && workflow.id === workflowId && workflow.workflow_type === 'mutation' && workflow.base_workflow_id &&
    profile?.model_directed === true && profile.plan_id === plan.id && profile.plan_revision === plan.revision);
}

function currentExperimentCompilation(artifacts: AIScanArtifact[], task: AIScanTask, plan: Record<string, any>): AIScanArtifact | undefined {
  return newestByRevision(artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_compilation' && artifact.task_id === task.id &&
    artifact.source_ref === plan.id && artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision &&
    artifact.content_json?.private === true));
}

/** A completed experiment can be a confirmed issue, a secure counterexample,
 * or an inconclusive native result. Completion requires the actual persisted
 * Test Runs to belong to this scan/plan and to have terminal evidence, not
 * just user-controllable IDs embedded in an artifact. */
export async function businessExperimentCompletionGap(task: AIScanTask, artifacts: AIScanArtifact[], db?: DbProvider): Promise<string | undefined> {
  const flowId = String(task.execution_plan?.flow_id || '');
  const plans = artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_plan' && artifact.task_id === task.id && artifact.content_json?.flow_id === flowId);
  const planArtifact = newestByRevision(plans);
  const plan = planArtifact?.content_json;
  if (!plan?.id || !Number.isInteger(plan.revision)) return 'No model-designed experiment plan has been saved for this verified business flow.';
  if (plan.status !== 'compiled') return 'The latest model experiment plan has not been compiled into immutable native Workflow snapshots.';
  const resultArtifact = newestByRevision(artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_result' && artifact.task_id === task.id &&
    artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision));
  const result = resultArtifact?.content_json;
  if (!result || result.status !== 'executed') return 'The current compiled plan has no completed native control-and-experiment result.';
  const compilationArtifact = currentExperimentCompilation(artifacts, task, plan);
  const compilation = compilationArtifact?.content_json;
  if (!compilation || !Array.isArray(plan.evidence_artifact_ids) || !plan.evidence_artifact_ids.includes(compilationArtifact!.id)) {
    return 'The current compiled plan lacks its private native Workflow compilation record.';
  }
  const nativeRuns = Array.isArray(result.native_test_run_ids) ? result.native_test_run_ids.filter((id: unknown) => typeof id === 'string') : [];
  if (nativeRuns.length < 2 || !result.control_test_run_id || !result.experiment_test_run_id || result.control_test_run_id === result.experiment_test_run_id) {
    return 'The experiment result lacks distinct native control and experiment Test Runs.';
  }
  if (!nativeRuns.includes(result.control_test_run_id) || !nativeRuns.includes(result.experiment_test_run_id)) {
    return 'The experiment result does not consistently reference its control and experiment Test Runs.';
  }
  if (!db) return 'The experiment completion gate cannot verify native TestRun ownership without its repository context.';
  const normalRunId = String(task.execution_plan?.normal_run_id || '');
  if (!normalRunId) return 'The experiment task has no persisted normal baseline Test Run reference.';
  const [normalRun, controlRun, experimentRun] = await Promise.all([
    db.repos.testRuns.findById(normalRunId),
    db.repos.testRuns.findById(result.control_test_run_id),
    db.repos.testRuns.findById(result.experiment_test_run_id),
  ]);
  if (!normalRun || !controlRun || !experimentRun) {
    return 'The normal baseline, control, or experiment Test Run no longer exists.';
  }
  if (!hasTerminalNativeRun(normalRun) || !nativeRunOwnedBy(normalRun, {scan_run_id: task.scan_run_id, flow_id: flowId, business_normal_run: true})) {
    return 'The normal baseline Test Run is missing, not terminal, or is not owned by this scan and business flow.';
  }
  if (!hasTerminalNativeRun(controlRun) || !nativeRunOwnedBy(controlRun, {scan_run_id: task.scan_run_id, ai_scan_task_id: task.id,
    plan_id: plan.id, plan_revision: plan.revision, model_directed: true, kind: 'control'})) {
    return 'The control Test Run is missing, not terminal, or is not owned by the current scan/task/plan revision.';
  }
  if (!hasTerminalNativeRun(experimentRun) || !nativeRunOwnedBy(experimentRun, {scan_run_id: task.scan_run_id, ai_scan_task_id: task.id,
    plan_id: plan.id, plan_revision: plan.revision, model_directed: true, kind: 'experiment'})) {
    return 'The experiment Test Run is missing, not terminal, or is not owned by the current scan/task/plan revision.';
  }
  if (!normalRun.workflow_id || !controlRun.workflow_id || !experimentRun.workflow_id ||
    new Set([normalRun.workflow_id, controlRun.workflow_id, experimentRun.workflow_id]).size !== 3 ||
    controlRun.workflow_id !== compilation.control_workflow_id || experimentRun.workflow_id !== compilation.experiment_workflow_id) {
    return 'The native Test Runs do not reference three distinct current normal, control, and experiment Workflows.';
  }
  const [normalWorkflow, controlWorkflow, experimentWorkflow] = await Promise.all([
    db.repos.workflows.findById(normalRun.workflow_id),
    db.repos.workflows.findById(controlRun.workflow_id),
    db.repos.workflows.findById(experimentRun.workflow_id),
  ]);
  if (!normalWorkflow || compilation.flow_id !== flowId || compilation.source_workflow_id !== normalRun.workflow_id ||
    !isCurrentMutationWorkflow(controlWorkflow, compilation.control_workflow_id, plan) ||
    !isCurrentMutationWorkflow(experimentWorkflow, compilation.experiment_workflow_id, plan)) {
    return 'The current native Workflow compilation does not own the normal, control, and experiment Workflow snapshots.';
  }
  const normalEvidence = artifacts.some(artifact => artifact.artifact_type === 'business_workflow_validation' && artifact.source_ref === normalRunId &&
    artifact.content_json?.flow_id === flowId && artifact.content_json?.test_run_id === normalRunId && artifact.content_json?.workflow_id === normalRun.workflow_id &&
    artifact.content_json?.assertions_verified === true) &&
    artifacts.some(artifact => artifact.artifact_type === 'business_native_trace' && artifact.source_ref === normalRunId && artifact.content_json?.flow_id === flowId &&
      artifact.content_json?.test_run_id === normalRunId && artifact.content_json?.workflow_id === normalRun.workflow_id && artifact.content_json?.private === true);
  if (!normalEvidence) return 'The normal baseline Test Run lacks matching native validation and trace evidence.';
  if (!hasNativeTrace(artifacts, task, plan, 'control', result.control_test_run_id) || !hasNativeTrace(artifacts, task, plan, 'experiment', result.experiment_test_run_id)) {
    return 'The current control or experiment Test Run lacks matching private native trace evidence.';
  }
  const traceIds = artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_native_trace' && artifact.task_id === task.id &&
    [result.control_test_run_id, result.experiment_test_run_id].includes(String(artifact.source_ref)) && artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision).map(artifact => artifact.id);
  if (!Array.isArray(result.evidence_artifact_ids) || traceIds.some(id => !result.evidence_artifact_ids.includes(id))) {
    return 'The experiment result does not retain references to its current native trace evidence.';
  }
  const assessed = artifacts.some(artifact => artifact.artifact_type === 'agent_experiment_assessment' && artifact.task_id === task.id &&
    artifact.source_ref === plan.id && artifact.content_json?.plan_revision === plan.revision && artifact.content_json?.result_revision === result.revision);
  if (!assessed) return 'The model has not inspected and assessed the current native experiment result.';
  return undefined;
}

/** A model's completion sentence cannot substitute for persisted native proof. */
export async function businessCompletionGap(repo: AIScanRepository, task: AIScanTask, flows: BusinessFlow[], artifacts: AIScanArtifact[] = [], db?: DbProvider): Promise<string | undefined> {
  const intent = task.execution_plan?.intent;
  if (intent === BUSINESS_PLAN_INTENT) return businessPlanningCompletionGap(repo, task, flows, artifacts);
  if (intent === BUSINESS_LEARNING_INTENT) {
    const flow = flows.find(item => item.id === task.execution_plan?.flow_id);
    return flow?.status === 'verified' && flow.assertions_verified === true && flow.normal_run_id && flow.evidence_artifact_ids.length
      ? undefined : 'This normal business flow has no verified native Test Run. Inspect failed assertions, repair data dependencies or report a specific blocker.';
  }
  if (intent === BUSINESS_REVIEW_INTENT) {
    const planTask = (await repo.listTasks(task.scan_run_id)).find(item => item.execution_plan?.intent === BUSINESS_PLAN_INTENT);
    if (!planTask) return 'No business planning task exists for this review.';
    const coverageGap = await businessPlanningCompletionGap(repo, planTask, flows, artifacts);
    if (coverageGap) return coverageGap;
    // Failed/blocked normal flows are preserved in the review, but do not hold
    // independently verified flows hostage. scheduleBusinessExperiments()
    // releases only the latter and keeps the former visible as blockers.
    return undefined;
  }
  if (intent === BUSINESS_EXPERIMENT_INTENT) return businessExperimentCompletionGap(task, artifacts, db);
  return undefined;
}

export function businessTaskIntent(task: Pick<AIScanTask, 'execution_plan'>): boolean {
  return [BUSINESS_PLAN_INTENT, BUSINESS_LEARNING_INTENT, BUSINESS_REVIEW_INTENT, BUSINESS_EXPERIMENT_INTENT].includes(task.execution_plan?.intent);
}
