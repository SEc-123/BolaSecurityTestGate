import { v4 as uuidv4 } from 'uuid';
import type { AIScanArtifact } from './types.js';
import type { AIScanRepository } from './repository.js';
import type { NormalBusinessObjectiveCompletion, NormalBusinessObjectiveOperation } from '../../agent/normal-business-objectives.js';

/** Business facts and executable plans are separate from vulnerability labels. */
export interface BusinessAssertion {
  id: string;
  step_order: number;
  description: string;
  purpose: 'goal' | 'identity' | 'state' | 'control' | 'impact';
  op: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'regex' | 'greater_than' | 'less_than' | 'greater_or_equal' | 'less_or_equal';
  left: { type: 'response'; path: string };
  right: { type: 'literal' | 'workflow_variable' | 'workflow_context' | 'value_ref' | 'captured_baseline'; value?: string; key?: string; handle_id?: string; captured_baseline?: boolean };
  missing_behavior?: 'fail';
  passed?: boolean;
}

/**
 * A model can make a syntactically plausible assertion that the native
 * evaluator cannot execute (for example, `body` instead of `body.state`).
 * Keep that as structured, non-terminal learning feedback for the normal
 * business stage.  The issue shape deliberately carries no model-supplied
 * value or response data.
 */
export interface BusinessAssertionIssue {
  assertion_index?: number;
  step_order?: number;
  invalid_path?: boolean;
  malformed_assertion?: boolean;
  semantic_body_required?: boolean;
  unobserved_path?: boolean;
  /** Value-free strict-objective completion field required on the final step. */
  required_response_path?: string;
  /** Value-free server-sealed operation ID required for strict business effect proof. */
  required_operation_id?: string;
}

export class BusinessAssertionValidationError extends Error {
  readonly issues: BusinessAssertionIssue[];

  constructor(message: string, issues: BusinessAssertionIssue[] = []) {
    super(message);
    this.name = 'BusinessAssertionValidationError';
    this.issues = issues;
  }
}

/**
 * A server-derived link from a discovered target to the concrete recording
 * event and native workflow step that exercised it.  It deliberately carries
 * only opaque IDs and execution metadata: request URLs, object values and
 * credentials remain in the private recording/trace artifacts.
 */
export interface BusinessCoverageBinding {
  target_type: 'feature' | 'operation';
  target_id: string;
  endpoint_id: string;
  source_event_id: string;
  /** Opaque browser action that produced the captured request, when available. */
  action_id?: string;
  source_step_order: number;
  source_workflow_id: string;
  normal_workflow_id?: string;
  normal_run_id?: string;
  /** Semantic normal-flow assertions that passed in the native replay. */
  validation_assertion_ids?: string[];
  validated?: boolean;
}

/**
 * Immutable, server-sealed normal-execution proof for one coverage target.
 * `coverage_bindings` describes only the current working capture and may be
 * replaced by a bounded retry; this ledger retains earlier native proof without
 * exposing captured traffic or values. A completion gate re-verifies the
 * referenced validation/trace artifacts before accepting a ledger entry.
 */
export interface BusinessCoverageProof extends BusinessCoverageBinding {
  normal_workflow_id: string;
  normal_run_id: string;
  validation_assertion_ids: string[];
  validated: true;
  validated_task_id: string;
  validation_artifact_id: string;
  trace_artifact_id?: string;
}

export interface BusinessFlow {
  id: string;
  revision: number;
  name: string;
  goal: string;
  /** Immutable server manifest objective selected when this Flow was defined. */
  objective_id?: string;
  objective_name?: string;
  /**
   * Immutable, value-free completion contract copied only from the
   * server-owned strict-objective manifest.  It binds a natural-language
   * objective to observable response shape without turning the model into a
   * route/template rule engine.
   */
  objective_completion?: NormalBusinessObjectiveCompletion;
  /** Immutable server-sealed state-changing operation contract. */
  objective_operation?: NormalBusinessObjectiveOperation;
  /** Server-derived action → capture-event → workflow-step proof for the required operation. */
  objective_operation_binding?: {
    operation_id: string;
    side_effect_class: NormalBusinessObjectiveOperation['side_effect_class'];
    source_event_ids: string[];
    action_ids: string[];
    source_workflow_id: string;
    source_step_orders: number[];
    normal_workflow_id?: string;
    normal_run_id?: string;
    validation_assertion_ids?: string[];
    /** The immutable native validation receipt that sealed this binding. */
    validation_artifact_id?: string;
    validated?: boolean;
  };
  /** Server-sealed execution prerequisite copied from the objective manifest. */
  requires_prepared_identity?: boolean;
  /** Server-derived action → capture-event → workflow-step completion proof. */
  objective_completion_binding?: {
    required_response_paths: string[];
    source_event_ids: string[];
    action_ids: string[];
    source_workflow_id: string;
    source_step_orders: number[];
    normal_workflow_id?: string;
    normal_run_id?: string;
    validation_assertion_ids?: string[];
    validated?: boolean;
  };
  feature_id?: string;
  feature_name?: string;
  role: string;
  status: 'discovered' | 'learning' | 'verified' | 'blocked' | 'failed';
  start_state?: string;
  prerequisites: string[];
  blockers: string[];
  steps: Array<{ id: string; description?: string; step_order?: number; endpoint_id?: string; event_id?: string }>;
  /** Server-generated coverage provenance for the current working capture.
   * The model cannot manufacture or edit these links through a flow-definition tool. */
  coverage_bindings?: BusinessCoverageBinding[];
  /** Append-only native proofs retained across a server-created coverage retry. */
  coverage_proof_ledger?: BusinessCoverageProof[];
  assertions: BusinessAssertion[];
  recording_session_id?: string;
  /** Immutable browser binding for the active normal recording. It is an opaque
   * execution identity, never a credential or storage-state value. */
  recording_context_key?: string;
  recording_context_scope?: 'scan' | 'task' | 'identity';
  recording_identity_key?: string;
  workflow_id?: string;
  normal_run_id?: string;
  /** The selected browser recording was observed through verified HTTPS. */
  captured_transport_verified_https?: boolean;
  /** A fresh native normal replay also completed over the verified HTTPS target. */
  transport_verified_https?: boolean;
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
  /** Opaque handle from a verified normal-flow response. Never accept a raw
   * artifact ID/path from a model as a value source. */
  value_ref?: { handle_id: string };
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
  /** Structured server-evaluated authentication/object/write/replay proof. */
  business_proof: Record<string, any>;
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

/** Strict objective proof is deliberately shaped as opaque provenance. Its
 * semantic linkage is created only by the native validation path; callers
 * cannot turn an operation declaration into a verified flow by setting a
 * status flag. */
function opaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}
function opaqueIds(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(opaqueId);
}
function stepOrders(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(order => Number.isInteger(order) && order > 0 && order <= 1_000_000);
}
export function sealedObjectiveOperationBinding(flow: Pick<BusinessFlow, 'objective_operation' | 'objective_operation_binding'>): boolean {
  const contract = flow.objective_operation, binding = flow.objective_operation_binding;
  if (!contract) return true;
  return Boolean(binding && binding.validated === true && binding.operation_id === contract.operation_id &&
    binding.side_effect_class === contract.side_effect_class && opaqueIds(binding.source_event_ids) && opaqueIds(binding.action_ids) &&
    opaqueId(binding.source_workflow_id) && stepOrders(binding.source_step_orders) && opaqueId(binding.normal_workflow_id) &&
    opaqueId(binding.normal_run_id) && opaqueIds(binding.validation_assertion_ids) && opaqueId(binding.validation_artifact_id));
}
export function sealedObjectiveCompletionBinding(flow: Pick<BusinessFlow, 'objective_completion' | 'objective_completion_binding'>): boolean {
  const contract = flow.objective_completion, binding = flow.objective_completion_binding;
  if (!contract?.required_response_paths?.length) return true;
  return Boolean(binding && binding.validated === true && Array.isArray(binding.required_response_paths) &&
    contract.required_response_paths.every(path => binding.required_response_paths.includes(path)) &&
    opaqueIds(binding.source_event_ids) && opaqueIds(binding.action_ids) && opaqueId(binding.source_workflow_id) &&
    stepOrders(binding.source_step_orders) && opaqueId(binding.normal_workflow_id) && opaqueId(binding.normal_run_id) &&
    opaqueIds(binding.validation_assertion_ids));
}
export function sealedStrictObjectiveBindings(flow: Pick<BusinessFlow, 'objective_operation' | 'objective_operation_binding' | 'objective_completion' | 'objective_completion_binding'>): boolean {
  return sealedObjectiveOperationBinding(flow) && sealedObjectiveCompletionBinding(flow);
}

function sameOpaqueIds(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter(opaqueId))].sort() : [];
  const a=normalize(left),b=normalize(right); return a.length===b.length && a.every((value,index)=>value===b[index]);
}
function nativeOperationReceiptMatches(flow: BusinessFlow, artifacts: AIScanArtifact[]): boolean {
  if (!flow.objective_operation) return true;
  const binding=flow.objective_operation_binding;
  if (!binding?.validation_artifact_id) return false;
  const receipt=artifacts.find(artifact => artifact.id===binding.validation_artifact_id && artifact.artifact_type==='business_workflow_validation');
  const recorded=receipt?.content_json?.objective_operation_binding;
  return Boolean(receipt && receipt.content_json?.assertions_verified===true && receipt.content_json?.flow_id===flow.id &&
    receipt.content_json?.workflow_id===binding.normal_workflow_id && receipt.content_json?.test_run_id===binding.normal_run_id &&
    recorded && recorded.operation_id===binding.operation_id && recorded.side_effect_class===binding.side_effect_class &&
    recorded.source_workflow_id===binding.source_workflow_id && sameOpaqueIds(recorded.source_event_ids,binding.source_event_ids) &&
    sameOpaqueIds(recorded.action_ids,binding.action_ids) && sameOpaqueIds(recorded.validation_assertion_ids,binding.validation_assertion_ids) &&
    Array.isArray(recorded.source_step_orders) && Array.isArray(binding.source_step_orders) &&
    recorded.source_step_orders.length===binding.source_step_orders.length && recorded.source_step_orders.every((order: unknown,index: number)=>order===binding.source_step_orders[index]));
}

export async function getBusinessFlow(repo: AIScanRepository, scanRunId: string, flowId: string): Promise<BusinessFlow> {
  const artifact = latestBusinessArtifact(await repo.listArtifacts(scanRunId), 'business_flow', flowId);
  if (!artifact) throw new Error('Business flow does not belong to this assessment. Define or inspect the flow first.');
  return artifact.content_json as BusinessFlow;
}

export async function saveBusinessFlow(repo: AIScanRepository, scanRunId: string, taskId: string | undefined,
  flow: BusinessFlow): Promise<AIScanArtifact> {
  const artifacts = await repo.listArtifacts(scanRunId);
  const previous = latestBusinessArtifact(artifacts, 'business_flow', flow.id);
  const prior = previous?.content_json as BusinessFlow | undefined;
  // A stale caller may update display/status fields after validation. Preserve
  // server-sealed objective provenance unless it explicitly carries the field
  // (coverage retry is the one deliberate reset and supplies `undefined`).
  const inherited = (field: keyof BusinessFlow) => prior && !(field in (flow as any)) ? { [field]: prior[field] } : {};
  const content = { ...prior, ...inherited('objective_id'), ...inherited('objective_name'), ...inherited('objective_completion'),
    ...inherited('objective_operation'), ...inherited('requires_prepared_identity'), ...inherited('objective_completion_binding'),
    ...inherited('objective_operation_binding'), ...flow, revision: Number(previous?.content_json.revision || 0) + 1 } as BusinessFlow;
  if (content.status === 'verified' && (!sealedStrictObjectiveBindings(content) || !nativeOperationReceiptMatches(content, artifacts))) {
    throw new Error('A strict normal-business Flow cannot be verified before every declared completion and state-changing operation binding is sealed by its matching native validation receipt.');
  }
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

function objectiveOperationFromInput(value: unknown): NormalBusinessObjectiveOperation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const operation_id = typeof item.operation_id === 'string' && /^operation:[a-f0-9]{24}$/.test(item.operation_id) ? item.operation_id : '';
  const method = typeof item.method === 'string' ? item.method.toUpperCase() : '';
  const route_shape = typeof item.route_shape === 'string' ? item.route_shape.trim() : '';
  const side_effect_class = typeof item.side_effect_class === 'string' ? item.side_effect_class : '';
  if (!operation_id || !/^(POST|PUT|PATCH|DELETE)$/.test(method) || !/^\/[A-Za-z0-9._~:/{}-]{1,280}$/.test(route_shape) ||
    !['authentication','update','add','create','transaction','write'].includes(side_effect_class)) return undefined;
  return { operation_id, method, route_shape, side_effect_class: side_effect_class as NormalBusinessObjectiveOperation['side_effect_class'] };
}

export function newBusinessFlow(input: Record<string, any>, taskId?: string): BusinessFlow {
  if (typeof input.name !== 'string' || !input.name.trim() || typeof input.goal !== 'string' || !input.goal.trim()) {
    throw new Error('A business flow requires a name and an observable normal business goal.');
  }
  const objectiveOperation = objectiveOperationFromInput(input.objective_operation);
  const completionPaths = input.objective_completion && typeof input.objective_completion === 'object' &&
    Array.isArray(input.objective_completion.required_response_paths)
    ? [...new Set((input.objective_completion.required_response_paths as unknown[])
      .filter((path): path is string => typeof path === 'string' && /^body\.[^\s]{1,280}$/.test(path.trim()))
      .map(path => path.trim()))].slice(0, 20)
    : [];
  return { id: uuidv4(), revision: 0, name: input.name.trim(), goal: input.goal.trim(),
    objective_id: typeof input.objective_id === 'string' ? input.objective_id : undefined,
    objective_name: typeof input.objective_name === 'string' ? input.objective_name : undefined,
    ...(completionPaths.length ? { objective_completion: { required_response_paths: completionPaths } } : {}),
    ...(objectiveOperation ? { objective_operation: objectiveOperation } : {}),
    ...(input.requires_prepared_identity === true ? { requires_prepared_identity: true } : {}),
    role: String(input.role || 'anonymous'), feature_id: input.feature_id, feature_name: input.feature_name, start_state: input.start_state,
    status: 'discovered', prerequisites: Array.isArray(input.prerequisites) ? input.prerequisites.map(String) : [],
    blockers: [], steps: [], assertions: [], evidence_artifact_ids: [], owner_task_id: taskId };
}

export function validateBusinessAssertions(assertions: unknown, options: { requireSemantic?: boolean; purposes?: string[]; allowValueRef?: boolean } = {}): BusinessAssertion[] {
  if (!Array.isArray(assertions) || !assertions.length) {
    throw new BusinessAssertionValidationError('Provide nonempty executable business assertions.', [{ malformed_assertion: true }]);
  }
  const ops = new Set(['equals', 'not_equals', 'contains', 'not_contains', 'regex', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal']);
  const result = assertions.map((a: any, i) => {
    const validPath = /^(status|body\.[^\s]+|headers\.[^\s]+)$/.test(String(a?.left?.path || ''));
    if (!a || !Number.isInteger(a.step_order) || a.step_order < 1 || a.left?.type !== 'response' ||
      !validPath || !ops.has(a.op) ||
      !['literal', 'workflow_variable', 'workflow_context', 'value_ref', 'captured_baseline'].includes(a.right?.type) ||
      (a.right.type === 'value_ref' && options.allowValueRef !== true) ||
      (a.right.type === 'literal' ? a.right.value === undefined : a.right.type === 'value_ref'
        ? typeof a.right.handle_id !== 'string' || !a.right.handle_id
        : a.right.type === 'captured_baseline'
          ? a.op !== 'equals' || Object.keys(a.right).some(key => key !== 'type')
          : typeof a.right.key !== 'string' || !a.right.key)) {
      throw new BusinessAssertionValidationError(`Assertion ${i + 1} must address an actual step response and a supported comparison.`, [{
        assertion_index: i + 1,
        ...(Number.isInteger(a?.step_order) ? { step_order: a.step_order } : {}),
        ...(validPath ? { malformed_assertion: true } : { invalid_path: true }),
      }]);
    }
    if (!['goal', 'identity', 'state', 'control', 'impact'].includes(a.purpose) || !String(a.description || '').trim()) {
      throw new BusinessAssertionValidationError(`Assertion ${i + 1} requires a business purpose and explanation.`, [{
        assertion_index: i + 1, step_order: a.step_order, malformed_assertion: true,
      }]);
    }
    if (a.missing_behavior && a.missing_behavior !== 'fail') {
      throw new BusinessAssertionValidationError('Missing business evidence must fail the assertion.', [{
        assertion_index: i + 1, step_order: a.step_order, malformed_assertion: true,
      }]);
    }
    return { id: String(a.id || `assertion-${i + 1}`), step_order: a.step_order, description: String(a.description), purpose: a.purpose,
      left: { type: 'response', path: String(a.left.path) }, op: a.op,
      right: { ...a.right, ...(a.right.type === 'literal' ? { value: String(a.right.value) } : {}) }, missing_behavior: 'fail' } as BusinessAssertion;
  });
  const seenIds = new Set<string>();
  for (const assertion of result) {
    if (seenIds.has(assertion.id)) {
      throw new BusinessAssertionValidationError('Business assertion IDs must be unique within one normal validation.', [{
        step_order: assertion.step_order,
        malformed_assertion: true,
      }]);
    }
    seenIds.add(assertion.id);
  }
  if (options.requireSemantic && !result.some(a => a.left.path.startsWith('body.') &&
    (options.purposes || ['goal', 'identity', 'state', 'impact']).includes(a.purpose))) {
    throw new BusinessAssertionValidationError('HTTP status alone cannot verify a business goal. Include an identity, object or state assertion.', [{ semantic_body_required: true }]);
  }
  return result;
}

/**
 * Experiments are allowed to be imaginative, but their proof language cannot
 * depend on an unrecorded secret or a transient value the executor cannot
 * later account for. Bind dynamic values through workflow mappings or a
 * scan-owned opaque value_ref; use a literal/regular-expression assertion
 * for an independently observable business outcome.
 */
export function validateExperimentAssertions(assertions: unknown, kind: 'impact' | 'control'): BusinessAssertion[] {
  const validated = validateBusinessAssertions(assertions, { requireSemantic: true, allowValueRef: true,
    purposes: kind === 'impact' ? ['impact', 'identity', 'state'] : ['control', 'goal', 'identity', 'state'] });
  if (validated.some(assertion => !['literal','value_ref'].includes(assertion.right.type))) {
    throw new Error(`${kind === 'impact' ? 'Experiment' : 'Control'} assertions must use literal or scan-owned opaque value_ref values so native evidence remains reproducible.`);
  }
  if (kind === 'impact' && !validated.some(assertion => assertion.purpose === 'impact' && assertion.left.path.startsWith('body.'))) {
    throw new Error('An experiment requires at least one response-body impact assertion; HTTP status alone cannot establish a business impact.');
  }
  if (kind === 'control' && !validated.some(assertion => assertion.left.path.startsWith('body.'))) {
    throw new Error('A control requires at least one response-body assertion; HTTP status alone is not a business control.');
  }
  return validated;
}
