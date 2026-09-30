import { v4 as uuidv4 } from 'uuid';
import type { AIScanArtifact } from './types.js';
import type { AIScanRepository } from './repository.js';

/** Business facts and executable plans are separate from vulnerability labels. */
export interface BusinessAssertion {
  id: string;
  step_order: number;
  description: string;
  purpose: 'goal' | 'identity' | 'state' | 'control' | 'impact';
  op: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'regex' | 'greater_than' | 'less_than' | 'greater_or_equal' | 'less_or_equal';
  left: { type: 'response'; path: string };
  right: { type: 'literal' | 'workflow_variable' | 'workflow_context'; value?: string; key?: string };
  missing_behavior?: 'fail';
  passed?: boolean;
}

export interface BusinessFlow {
  id: string;
  revision: number;
  name: string;
  goal: string;
  feature_id?: string;
  feature_name?: string;
  role: string;
  status: 'discovered' | 'learning' | 'verified' | 'blocked' | 'failed';
  start_state?: string;
  prerequisites: string[];
  blockers: string[];
  steps: Array<{ id: string; description?: string; step_order?: number; endpoint_id?: string; event_id?: string }>;
  assertions: BusinessAssertion[];
  recording_session_id?: string;
  workflow_id?: string;
  normal_run_id?: string;
  assertions_verified?: boolean;
  evidence_artifact_ids: string[];
  hypotheses?: string[];
  owner_task_id?: string;
}

export interface RequestPatch {
  step_id: string;
  location: 'query' | 'header' | 'json_body' | 'form_body' | 'path';
  operation: 'set' | 'delete' | 'append';
  path: string;
  value?: unknown;
  value_ref?: { artifact_id: string; path: string };
}

export interface AgentExperimentPlan {
  id: string;
  /** Immutable append-only plan revision. A result must name this revision. */
  revision: number;
  flow_id: string;
  /** The normal-flow revision that was actually verified before planning. */
  source_flow_revision: number;
  name: string;
  hypothesis: string;
  category?: string;
  steps: Array<{ id: string; source_step_order: number; role?: string }>;
  patches: RequestPatch[];
  bindings?: Array<{ from_step_id: string; from_location: string; from_path: string; to_step_id: string; to_location: string; to_path: string; variable_name: string }>;
  repeats?: Array<{ step_id: string; count: number }>;
  concurrency?: { step_id: string; count: number };
  parallel?: Array<{ anchor_step_id: string; extra_step_ids: string[] }>;
  assertions: BusinessAssertion[];
  control_assertions: BusinessAssertion[];
  /** Identity for the fresh unmodified control replay. */
  control_role?: string;
  rationale: string;
  status: 'planned' | 'compiled' | 'executed' | 'blocked' | 'failed';
  parent_plan_id?: string;
  evidence_artifact_ids: string[];
}

export interface AgentExperimentResult {
  id: string;
  revision: number;
  plan_id: string;
  plan_revision: number;
  flow_id: string;
  source_flow_revision: number;
  status: 'executed' | 'blocked' | 'failed';
  native_test_run_ids: string[];
  control_test_run_id?: string;
  experiment_test_run_id?: string;
  execution_verified: boolean;
  control_verified: boolean;
  business_invariant_verified: boolean;
  /** A completed control plus a completed experiment that disproved the model
   * hypothesis. This is stronger than a transport error, but never a positive
   * vulnerability finding. */
  counterexample_verified: boolean;
  distinct_identity_verified: boolean;
  evidence_ready: boolean;
  missing_evidence: string[];
  control_assertions: Array<BusinessAssertion & { passed: boolean }>;
  assertions: Array<BusinessAssertion & { passed: boolean }>;
  evidence_artifact_ids: string[];
}

export function latestBusinessArtifact(artifacts: AIScanArtifact[], type: string, id: string): AIScanArtifact | undefined {
  return artifacts.filter(a => a.artifact_type === type &&
    (String(a.content_json.id || '') === id || String(a.content_json.plan_id || '') === id))
    .sort((a, b) => Number(b.content_json.revision || 0) - Number(a.content_json.revision || 0) ||
      String(b.created_at).localeCompare(String(a.created_at)))[0];
}

export async function getBusinessFlow(repo: AIScanRepository, scanRunId: string, flowId: string): Promise<BusinessFlow> {
  const artifact = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'business_flow', flowId);
  if (!artifact) throw new Error('Business flow does not belong to this assessment. Define or inspect the flow first.');
  return artifact.content_json as BusinessFlow;
}

export async function saveBusinessFlow(repo: AIScanRepository, scanRunId: string, taskId: string | undefined,
  flow: BusinessFlow): Promise<AIScanArtifact> {
  const previous = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'business_flow', flow.id);
  const content = { ...flow, revision: Number(previous?.content_json.revision || 0) + 1 };
  return repo.createArtifact({ scan_run_id: scanRunId, task_id: taskId, artifact_type: 'business_flow',
    title: flow.name, source_ref: flow.id, content_json: content });
}

export async function getAgentExperimentPlan(repo: AIScanRepository, scanRunId: string, planId: string): Promise<AgentExperimentPlan> {
  const artifact = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'agent_experiment_plan', planId);
  if (!artifact) throw new Error('Experiment plan does not belong to this assessment. Create or inspect the plan first.');
  return artifact.content_json as AgentExperimentPlan;
}

export async function saveAgentExperimentPlan(repo: AIScanRepository, scanRunId: string, taskId: string | undefined,
  plan: AgentExperimentPlan): Promise<AIScanArtifact> {
  const previous = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'agent_experiment_plan', plan.id);
  const content = { ...plan, revision: Number(previous?.content_json.revision || 0) + 1 };
  return repo.createArtifact({ scan_run_id: scanRunId, task_id: taskId, artifact_type: 'agent_experiment_plan',
    title: plan.name, source_ref: plan.id, content_json: content });
}

export async function getAgentExperimentResult(repo: AIScanRepository, scanRunId: string, planId: string): Promise<AgentExperimentResult | undefined> {
  const artifact = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'agent_experiment_result', planId);
  return artifact?.content_json as AgentExperimentResult | undefined;
}

export async function saveAgentExperimentResult(repo: AIScanRepository, scanRunId: string, taskId: string | undefined,
  result: AgentExperimentResult): Promise<AIScanArtifact> {
  const previous = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'agent_experiment_result', result.plan_id);
  const content = { ...result, revision: Number(previous?.content_json.revision || 0) + 1 };
  return repo.createArtifact({ scan_run_id: scanRunId, task_id: taskId, artifact_type: 'agent_experiment_result',
    title: `实验执行结果 ${result.plan_id}`, source_ref: result.plan_id, content_json: content });
}

export function newBusinessFlow(input: Record<string, any>, taskId?: string): BusinessFlow {
  if (typeof input.name !== 'string' || !input.name.trim() || typeof input.goal !== 'string' || !input.goal.trim()) {
    throw new Error('A business flow requires a name and an observable normal business goal.');
  }
  return { id: uuidv4(), revision: 0, name: input.name.trim(), goal: input.goal.trim(), role: String(input.role || 'anonymous'),
    feature_id: input.feature_id, feature_name: input.feature_name, start_state: input.start_state,
    status: 'discovered', prerequisites: Array.isArray(input.prerequisites) ? input.prerequisites.map(String) : [],
    blockers: [], steps: [], assertions: [], evidence_artifact_ids: [], owner_task_id: taskId };
}

export function validateBusinessAssertions(assertions: unknown, options: { requireSemantic?: boolean; purposes?: string[] } = {}): BusinessAssertion[] {
  if (!Array.isArray(assertions) || !assertions.length) throw new Error('Provide nonempty executable business assertions.');
  const ops = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'regex', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal']);
  const result = assertions.map((a: any, i) => {
    if (!a || !Number.isInteger(a.step_order) || a.step_order < 1 || a.left?.type !== 'response' ||
      !/^(status|body\.[^\s]+|headers\.[^\s]+)$/.test(String(a.left?.path || '')) || !ops.has(a.op) ||
      !['literal', 'workflow_variable', 'workflow_context'].includes(a.right?.type) ||
      (a.right.type === 'literal' ? a.right.value === undefined : typeof a.right.key !== 'string' || !a.right.key)) {
      throw new Error(`Assertion ${i + 1} must address an actual step response and a supported comparison.`);
    }
    if (!['goal', 'identity', 'state', 'control', 'impact'].includes(a.purpose) || !String(a.description || '').trim()) {
      throw new Error(`Assertion ${i + 1} requires a business purpose and explanation.`);
    }
    if (a.missing_behavior && a.missing_behavior !== 'fail') throw new Error('Missing business evidence must fail the assertion.');
    return { id: String(a.id || `assertion-${i + 1}`), step_order: a.step_order, description: String(a.description), purpose: a.purpose,
      left: { type: 'response', path: String(a.left.path) }, op: a.op,
      right: { ...a.right, ...(a.right.type === 'literal' ? { value: String(a.right.value) } : {}) }, missing_behavior: 'fail' } as BusinessAssertion;
  });
  if (options.requireSemantic && !result.some(a => a.left.path.startsWith('body.') &&
    (options.purposes || ['goal', 'identity', 'state', 'impact']).includes(a.purpose))) {
    throw new Error('HTTP status alone cannot verify a business goal. Include an identity, object or state assertion.');
  }
  return result;
}

/**
 * Experiments are allowed to be imaginative, but their proof language cannot
 * depend on an unrecorded secret or a transient value the executor cannot
 * later account for. Bind dynamic values through workflow mappings; use a
 * literal/regular-expression assertion for the observable business outcome.
 */
export function validateExperimentAssertions(assertions: unknown, kind: 'impact' | 'control'): BusinessAssertion[] {
  const validated = validateBusinessAssertions(assertions, { requireSemantic: true,
    purposes: kind === 'impact' ? ['impact', 'identity', 'state'] : ['control', 'goal', 'identity', 'state'] });
  if (validated.some(assertion => assertion.right.type !== 'literal')) {
    throw new Error(`${kind === 'impact' ? 'Experiment' : 'Control'} assertions must use literal or regex-compatible values so native evidence remains reproducible.`);
  }
  if (kind === 'impact' && !validated.some(assertion => assertion.purpose === 'impact' && assertion.left.path.startsWith('body.'))) {
    throw new Error('An experiment requires at least one response-body impact assertion; HTTP status alone cannot establish a business impact.');
  }
  if (kind === 'control' && !validated.some(assertion => assertion.left.path.startsWith('body.'))) {
    throw new Error('A control requires at least one response-body assertion; HTTP status alone is not a business control.');
  }
  return validated;
}
