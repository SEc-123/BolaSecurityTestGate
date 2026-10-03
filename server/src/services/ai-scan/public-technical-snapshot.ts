import { createHash } from 'node:crypto';
import { normalObjectiveManifestForTask } from '../../agent/normal-business-objectives.js';
import type {
  AIAgentMemory,
  AIBrowserContextRecord,
  AIDiscoveredEndpoint,
  AIFeatureNode,
  AIPlannerDecisionRecord,
  AIScanArtifact,
  AIScanRun,
  AIScanSnapshot,
  AIScanTask,
  AIVulnerabilityCandidate,
} from './types.js';

/**
 * The generic scan endpoint is useful for an operator and for acceptance
 * receipts, but it is still a browser-facing API. Keep its shape useful for
 * progress/model provenance while treating the canonical snapshot as private
 * execution storage. In particular, no request/response strings, cookies,
 * captured object values, model prompts, or tool arguments leave here.
 */
const ID = /^[A-Za-z0-9:_-]{1,200}$/;
const WORD = /^[a-zA-Z][a-zA-Z0-9_.:/-]{0,159}$/;
const STATUS = /^[a-z_]{1,48}$/;
const VULN_TYPES = new Set([
  'file_upload', 'file_download', 'path_traversal', 'bola_idor', 'bfla',
  'business_logic', 'xss', 'command_injection', 'auth_otp',
  'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race',
]);
const EXPLICIT_EVENT_SELECTION_ORIGINS = new Set([
  'explicit_observed_event_ids',
  'model_explicit_observed_event_ids',
]);
const EVENT_SELECTION_TOOL_NAMES = new Set([
  'bstg.business.workflow.prepare',
  'bstg.business.workflow.revise',
]);
/** These names are stable product capabilities, not request content.  Expose
 * only accepted model experiment tool provenance so a public acceptance can
 * prove the model actually drove the native experiment lifecycle without
 * disclosing its plan arguments, captured data, or private evidence. */
const EXPERIMENT_TOOL_NAMES = new Set([
  'bstg.business.flow.inspect',
  'bstg.workflow.inspect',
  'bstg.test_plan.create',
  'bstg.test_plan.compile',
  'bstg.test_plan.execute',
  'bstg.test_plan.inspect',
  'bstg.test_plan.assess',
  'bstg.test_plan.block',
]);
/** The public view normally hides execution plans because they can contain
 * credentials, selectors, binding values and request patches. These lifecycle
 * labels and opaque ownership references are deliberately the small exception:
 * they let an operator verify that a model-owned experiment remains bound to
 * its verified business flow without disclosing any executable material. */
const PUBLIC_BUSINESS_LIFECYCLE_INTENTS = new Set([
  'plan_business_flows',
  'learn_business_flow',
  'review_business_flows',
  'model_business_experiment',
  'plan_android_business_flows',
  'learn_android_business_flow',
  'model_android_business_experiment',
]);
// Business proof gap codes are a finite, server-authored vocabulary. Project
// only these codes and fixed summaries so a public receipt can explain why an
// experiment stopped without exposing assertion paths, captured values, or
// arbitrary model prose.
const PUBLIC_BUSINESS_EVIDENCE_GAPS: Record<string, string> = {
  trusted_identity_proof_missing: 'Cross-identity proof is missing trusted identity evidence.',
  authoritative_readback_unavailable: 'The verified Workflow has no observed GET/HEAD read-back after its state-changing request.',
  authoritative_readback_assertions_missing: 'The observed read-back is not asserted in both control and experiment.',
  cross_account_object_proof_incomplete: 'Cross-account object proof is incomplete.',
  cross_role_function_proof_incomplete: 'Cross-role function proof is incomplete.',
  replay_state_proof_incomplete: 'Replay or race state proof is incomplete.',
  negative_counterexample_proof_missing: 'A trusted negative counterexample is missing.',
};
const PUBLIC_EXPERIMENT_BLOCK_CODES = new Set(['authoritative_readback_unavailable']);
const PUBLIC_NATIVE_EVIDENCE_VERDICTS = new Set(['confirmed', 'counterexample', 'insufficient']);
// Android receipts carry a session-to-native-run binding which is required
// locally for execution authority.  The browser-facing technical view needs
// only aggregate proof facts, never those correlatable handles.
const PRIVATE_ANDROID_RECEIPT_TYPES = new Set([
  'android_business_normal_validation',
  'android_business_experiment_ready',
]);
const ROUTE_WORDS = new Set(['api', 'v1', 'v2', 'v3', 'auth', 'login', 'logout', 'register', 'profile', 'account', 'accounts',
  'user', 'users', 'order', 'orders', 'cart', 'checkout', 'payment', 'payments', 'item', 'items', 'product', 'products',
  'search', 'upload', 'download', 'file', 'files', 'note', 'notes', 'settings', 'session', 'sessions', 'health', 'status']);

function publicId(value: unknown): string | undefined {
  return typeof value === 'string' && ID.test(value) ? value : undefined;
}

function publicIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(publicId).filter((id): id is string => Boolean(id)))].slice(0, 200) : [];
}

function publicStatus(value: unknown): string | undefined {
  return typeof value === 'string' && STATUS.test(value) ? value : undefined;
}

export function publicTechnicalPath(value: unknown): string {
  try {
    const url = new URL(String(value), 'http://bstg.local');
    const parts = url.pathname.split('/').map(part => {
      if (!part) return part;
      if (ROUTE_WORDS.has(part.toLowerCase())) return part.toLowerCase();
      return ':value';
    });
    return parts.join('/') || '/';
  } catch {
    return '/';
  }
}

function publicBaseUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    return `${url.origin}${publicTechnicalPath(url.pathname)}`;
  } catch {
    return 'about:blank';
  }
}

export function publicTechnicalUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    return `${url.origin}${publicTechnicalPath(url.pathname)}`;
  } catch {
    return 'about:blank';
  }
}

function receiptReference(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return `receipt:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function opaqueReference(namespace: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return `${namespace}:${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function publicArtifactFacts(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of ['id', 'plan_id', 'parent_plan_id', 'experiment_id', 'flow_id', 'feature_id', 'workflow_id', 'source_workflow_id', 'test_run_id', 'normal_run_id',
    'control_test_run_id', 'experiment_test_run_id', 'recording_session_id', 'finding_id']) {
    const id = publicId(input[key]); if (id) out[key] = id;
  }
  for (const key of ['revision', 'plan_revision', 'result_revision', 'source_flow_revision', 'event_count', 'errors_count',
    'findings_count', 'request_count', 'response_count']) {
    if (Number.isInteger(input[key]) && input[key] >= 0 && input[key] <= 1_000_000) out[key] = input[key];
  }
  for (const key of ['status', 'verdict']) {
    const status = publicStatus(input[key]); if (status) out[key] = status;
  }
  if (['critical', 'high', 'medium', 'low', 'info'].includes(input.severity)) out.severity = input.severity;
  for (const key of ['success', 'verified', 'assertions_verified', 'baseline_verified', 'execution_verified', 'control_verified',
    'business_invariant_verified', 'counterexample_verified', 'evidence_ready', 'distinct_identity_verified', 'attempted', 'completed',
    'captured_transport_verified_https', 'transport_verified_https']) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  for (const key of ['native_test_run_ids', 'evidence_artifact_ids', 'test_run_ids', 'selected_candidates']) {
    const ids = publicIds(key === 'selected_candidates' ? input[key]?.map?.((item: any) => item?.id) : input[key]);
    if (ids.length) out[key] = key === 'selected_candidates' ? ids.map(id => ({ id })) : ids;
  }
  return out;
}

function publicBusinessProof(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>).evidence_gaps;
  const evidence_gaps = Array.isArray(raw)
    ? raw.flatMap((gap: any) => {
      const failure_code = typeof gap?.failure_code === 'string' ? gap.failure_code : '';
      const summary = PUBLIC_BUSINESS_EVIDENCE_GAPS[failure_code];
      return summary ? [{ failure_code, summary }] : [];
    }).slice(0, 16)
    : [];
  return { evidence_gaps };
}

/** Event IDs are opaque recording references.  These bounded provenance facts
 * let an acceptance receipt prove model-owned selection without exposing a
 * captured request, response, cookie, credential, or arbitrary artifact data. */
function publicEventSelectionFacts(input: Record<string, any>): Record<string, any> {
  const requested = publicIds(input.requested_event_ids);
  const autoIncluded = publicIds(input.auto_included_event_ids);
  const effective = publicIds(input.effective_event_ids);
  return {
    ...(EXPLICIT_EVENT_SELECTION_ORIGINS.has(input.selection_origin) ? { selection_origin: input.selection_origin } : {}),
    ...(EVENT_SELECTION_TOOL_NAMES.has(input.selection_tool_name) ? { selection_tool_name: input.selection_tool_name } : {}),
    ...(requested.length ? { requested_event_ids: requested } : {}),
    ...(autoIncluded.length ? { auto_included_event_ids: autoIncluded } : {}),
    ...(effective.length ? { effective_event_ids: effective } : {}),
    requested_event_count: requested.length,
    auto_included_event_count: autoIncluded.length,
    effective_event_count: effective.length,
    selected_event_count: effective.length,
  };
}

/** Completion contracts contain response-field shapes and opaque provenance
 * only. They let an operator or acceptance receipt verify that a declared
 * normal outcome reached its final browser action without reopening a private
 * capture, response body, or model argument. */
function publicCompletionPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap(item => {
    const path = typeof item === 'string' ? item.trim() : '';
    return /^body\.[^\s]{1,280}$/.test(path) ? [path] : [];
  }))].slice(0, 20);
}

function publicObjectiveCompletion(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const required_response_paths = publicCompletionPaths((value as Record<string, unknown>).required_response_paths);
  return required_response_paths.length ? { required_response_paths } : undefined;
}

function publicObjectiveCompletionBinding(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const required_response_paths = publicCompletionPaths(input.required_response_paths);
  if (!required_response_paths.length) return undefined;
  const source_step_orders = Array.isArray(input.source_step_orders)
    ? [...new Set(input.source_step_orders.filter(order => Number.isInteger(order) && Number(order) > 0 && Number(order) <= 1_000_000)
      .map(order => Number(order)))].sort((left, right) => left - right)
    : [];
  return {
    required_response_paths,
    source_event_ids: publicIds(input.source_event_ids),
    action_ids: publicIds(input.action_ids),
    ...(publicId(input.source_workflow_id) ? { source_workflow_id: publicId(input.source_workflow_id) } : {}),
    source_step_orders,
    ...(publicId(input.normal_workflow_id) ? { normal_workflow_id: publicId(input.normal_workflow_id) } : {}),
    ...(publicId(input.normal_run_id) ? { normal_run_id: publicId(input.normal_run_id) } : {}),
    ...(publicIds(input.validation_assertion_ids).length ? { validation_assertion_ids: publicIds(input.validation_assertion_ids) } : {}),
    ...(typeof input.validated === 'boolean' ? { validated: input.validated } : {}),
  };
}


function publicObjectiveOperation(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input=value as Record<string,unknown>,operation_id=typeof input.operation_id==='string'&&/^operation:[a-f0-9]{24}$/.test(input.operation_id)?input.operation_id:'';
  const method=typeof input.method==='string'&&/^(POST|PUT|PATCH|DELETE)$/.test(input.method)?input.method:'';
  const side_effect_class=typeof input.side_effect_class==='string'&&['authentication','update','add','create','transaction','write'].includes(input.side_effect_class)?input.side_effect_class:'';
  return operation_id&&method&&side_effect_class?{operation_id,method,side_effect_class}:undefined;
}
function publicObjectiveOperationBinding(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  // A sealed binding intentionally omits the private method and route matcher.
  // Project its own safe contract instead of reusing publicObjectiveOperation,
  // which correctly requires method for the immutable declaration.
  const operation_id = typeof input.operation_id === 'string' && /^operation:[a-f0-9]{24}$/.test(input.operation_id)
    ? input.operation_id : '';
  const side_effect_class = typeof input.side_effect_class === 'string' &&
    ['authentication', 'update', 'add', 'create', 'transaction', 'write'].includes(input.side_effect_class)
    ? input.side_effect_class : '';
  if (!operation_id || !side_effect_class) return undefined;
  const source_step_orders = Array.isArray(input.source_step_orders)
    ? [...new Set(input.source_step_orders.filter(order => Number.isInteger(order) && Number(order) > 0 && Number(order) <= 1_000_000)
      .map(Number))].sort((a, b) => a - b)
    : [];
  return { operation_id, side_effect_class, source_event_ids: publicIds(input.source_event_ids), action_ids: publicIds(input.action_ids), source_step_orders,
    ...(publicId(input.source_workflow_id)?{source_workflow_id:publicId(input.source_workflow_id)}:{}),...(publicId(input.normal_workflow_id)?{normal_workflow_id:publicId(input.normal_workflow_id)}:{}),...(publicId(input.normal_run_id)?{normal_run_id:publicId(input.normal_run_id)}:{}),...(publicIds(input.validation_assertion_ids).length?{validation_assertion_ids:publicIds(input.validation_assertion_ids)}:{}),...(publicId(input.validation_artifact_id)?{validation_artifact_id:publicId(input.validation_artifact_id)}:{}),...(typeof input.validated==='boolean'?{validated:input.validated}:{})};
}

export function publicTechnicalArtifact(artifact: AIScanArtifact): AIScanArtifact {
  const input = artifact.content_json || {};
  // A post-dispatch replay guard contains a private control-derived digest and
  // a recording binding. Its existence is useful only to the trusted browser
  // executor; even opaque identifiers must not become a public artifact API.
  let content = artifact.artifact_type === 'business_post_action_replay_guard'
    ? {} : PRIVATE_ANDROID_RECEIPT_TYPES.has(artifact.artifact_type)
      ? {
        ...(Number.isInteger(input.workflow_count) && input.workflow_count >= 0 && input.workflow_count <= 1_000_000
          ? { workflow_count: input.workflow_count } : {}),
        ...(Number.isInteger(input.completed_test_run_count) && input.completed_test_run_count >= 0 && input.completed_test_run_count <= 1_000_000
          ? { completed_test_run_count: input.completed_test_run_count } : {}),
        ...(input.verified_decrypted_https === true ? { verified_decrypted_https: true } : {}),
      }
      : publicArtifactFacts(input);
  if (artifact.artifact_type === 'agent_decision') {
    const source = ['ai_provider', 'fallback', 'local_policy', 'local_only'].includes(input.source) ? input.source : 'unknown';
    content = {
      source,
      ...(typeof input.model === 'string' && WORD.test(input.model) ? { model: input.model } : {}),
      ...(opaqueReference('provider', input.provider_id) ? { provider_reference: opaqueReference('provider', input.provider_id) } : {}),
      ...(receiptReference(input.provider_response_id) ? { provider_response_id: receiptReference(input.provider_response_id) } : {}),
      ...(input.provider_access_denied === true ? { provider_access_denied: true } : {}),
      ...(publicStatus(input.validation_status) ? { validation_status: publicStatus(input.validation_status) } : {}),
    };
    if (input.source === 'ai_provider' && input.validation_status === 'accepted' &&
      (EVENT_SELECTION_TOOL_NAMES.has(input.tool_name) || EXPERIMENT_TOOL_NAMES.has(input.tool_name))) {
      content.tool_name = input.tool_name;
      if (EVENT_SELECTION_TOOL_NAMES.has(input.tool_name)) content.selected_event_ids = publicIds(input.public_selection?.event_ids);
    }
    if (input.source === 'ai_provider' && input.validation_status === 'accepted' && input.tool_name === 'bstg.business.flow.define') {
      const objectiveId = publicId(input.public_selection?.objective_id);
      content.tool_name = 'bstg.business.flow.define';
      if (objectiveId) content.selected_objective_id = objectiveId;
    }
  }
  if (artifact.artifact_type === 'business_workflow_learning') {
    content = { ...content, ...publicEventSelectionFacts(input) };
  }
  if (artifact.artifact_type === 'business_flow') {
    const objectiveId = publicId(input.objective_id);
    if (objectiveId) content.objective_id = objectiveId;
    const completion = publicObjectiveCompletion(input.objective_completion);
    if (completion) content.objective_completion = completion;
    const operation = publicObjectiveOperation(input.objective_operation);
    if (operation) content.objective_operation = operation;
    if (input.requires_prepared_identity === true) content.requires_prepared_identity = true;
    const completionBinding = publicObjectiveCompletionBinding(input.objective_completion_binding);
    if (completionBinding) content.objective_completion_binding = completionBinding;
    const operationBinding = publicObjectiveOperationBinding(input.objective_operation_binding);
    if (operationBinding) content.objective_operation_binding = operationBinding;
  }
  if (['agent_experiment_result', 'business_state_proof'].includes(artifact.artifact_type)) {
    const proof = publicBusinessProof(input.business_proof);
    if (proof) content.business_proof = proof;
  }
  if (artifact.artifact_type === 'agent_experiment_assessment') {
    const verdict = input.native_evidence_gate?.verdict;
    if (typeof verdict === 'string' && PUBLIC_NATIVE_EVIDENCE_VERDICTS.has(verdict)) {
      content.native_evidence_gate = { verdict };
    }
  }
  if (artifact.artifact_type === 'agent_experiment_block' && PUBLIC_EXPERIMENT_BLOCK_CODES.has(input.reason_code)) {
    content.reason_code = input.reason_code;
  }
  if (artifact.artifact_type === 'business_workflow_validation') {
    const completionBinding = publicObjectiveCompletionBinding(input.objective_completion_binding);
    if (completionBinding) content.objective_completion_binding = completionBinding;
    const operationBinding = publicObjectiveOperationBinding(input.objective_operation_binding);
    if (operationBinding) content.objective_operation_binding = operationBinding;
  }
  // These are bounded lifecycle labels, so a public acceptance can establish
  // that the model's plan reached separate native control and experiment
  // executions without exposing a plan, request patch, trace, or any value
  // observed from the target.
  if (artifact.artifact_type === 'agent_experiment_compilation' && input.mutation_profile?.model_directed === true) {
    content.model_directed = true;
  }
  if (artifact.artifact_type === 'agent_experiment_native_trace' && ['control', 'experiment'].includes(input.kind)) {
    content.kind = input.kind;
  }
  return {
    id: artifact.id,
    scan_run_id: artifact.scan_run_id,
    task_id: publicId(artifact.task_id),
    artifact_type: WORD.test(artifact.artifact_type) ? artifact.artifact_type : 'private_evidence',
    source_ref: publicId(artifact.source_ref),
    content_json: content,
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
  };
}

export function publicTechnicalRun(run: AIScanRun): AIScanRun {
  return {
    id: run.id,
    base_url: publicBaseUrl(run.base_url),
    status: run.status,
    current_phase: publicStatus(run.current_phase),
    selected_vuln_types: (run.selected_vuln_types || []).filter(type => VULN_TYPES.has(type)),
    scan_config: {},
    summary: Object.fromEntries(Object.entries(run.summary || {}).filter(([key, value]) =>
      /^(?:endpoints|features|candidates|artifacts|tool_calls|tasks)_(?:total|completed|failed|running|count)$/.test(key) &&
      typeof value === 'number' && Number.isFinite(value))),
    created_at: run.created_at,
    updated_at: run.updated_at,
  } as AIScanRun;
}

/** These companion endpoints are browser-facing operational views. They keep
 * identity, storage, model arguments and memory text private while preserving
 * enough lifecycle metadata for an operator to understand progress. */
export function publicAgentMemory(memory: AIAgentMemory): Record<string, unknown> {
  return {
    id: publicId(memory.id), scan_run_id: publicId(memory.scan_run_id), owner_task_id: publicId(memory.owner_task_id),
    memory_type: publicStatus(memory.memory_type) || 'memory', scope_type: publicStatus(memory.scope_type) || 'scan',
    sensitivity: ['public', 'internal', 'secret_ref'].includes(memory.sensitivity) ? memory.sensitivity : 'internal',
    llm_visibility: ['full', 'summary', 'reference_only', 'hidden'].includes(memory.llm_visibility) ? memory.llm_visibility : 'hidden',
    confidence: Number.isFinite(memory.confidence) ? memory.confidence : 0,
    version: Number.isInteger(memory.version) ? memory.version : 0, status: publicStatus(memory.status) || 'active',
    ttl_seconds: Number.isInteger(memory.ttl_seconds) ? memory.ttl_seconds : undefined, expires_at: memory.expires_at,
    usage_count: Number.isInteger(memory.usage_count) ? memory.usage_count : 0, last_used_at: memory.last_used_at,
    created_at: memory.created_at, updated_at: memory.updated_at,
    summary: 'Memory content is retained as private execution evidence.', content_json: {}, provenance_json: {}, depends_on_json: [],
  };
}

export function publicAgentMemoryRevision(revision: Record<string, any>): Record<string, unknown> {
  return {
    id: publicId(revision.id), memory_id: publicId(revision.memory_id), version: Number.isInteger(revision.version) ? revision.version : 0,
    confidence: Number.isFinite(revision.confidence) ? revision.confidence : 0, created_at: revision.created_at,
    summary: 'Memory revision content is retained as private execution evidence.', content_json: {}, provenance_json: {},
  };
}

export function publicBrowserContext(context: AIBrowserContextRecord): Record<string, unknown> {
  return {
    id: publicId(context.id), scan_run_id: publicId(context.scan_run_id), task_id: publicId(context.task_id),
    context_ref: opaqueReference('context', context.context_key), scope_type: publicStatus(context.scope_type) || 'scan',
    status: publicStatus(context.status) || 'active', storage_state_present: context.storage_state_present === true,
    storage_cookie_count: Number.isInteger(context.storage_cookie_count) ? context.storage_cookie_count : 0,
    storage_origin_count: Number.isInteger(context.storage_origin_count) ? context.storage_origin_count : 0,
    current_path: publicTechnicalPath(context.current_url), dom_observed: Object.keys(context.dom_summary_json || {}).length > 0,
    network_observed: Object.keys(context.network_summary_json || {}).length > 0, has_error: Boolean(context.last_error),
    ttl_seconds: Number.isInteger(context.ttl_seconds) ? context.ttl_seconds : undefined, expires_at: context.expires_at,
    last_used_at: context.last_used_at, created_at: context.created_at, updated_at: context.updated_at,
  };
}

export function publicPlannerDecision(decision: AIPlannerDecisionRecord): Record<string, unknown> {
  const payload = decision.decision_json || {};
  const source = ['ai_provider', 'fallback', 'local_policy', 'local_only'].includes(decision.source) ? decision.source : 'unknown';
  return {
    id: publicId(decision.id), scan_run_id: publicId(decision.scan_run_id), task_id: publicId(decision.task_id),
    iteration: Number.isInteger(decision.iteration) ? decision.iteration : 0, source,
    action: publicStatus(payload.action), tool_name: typeof payload.tool_name === 'string' && WORD.test(payload.tool_name) ? payload.tool_name : undefined,
    model: typeof payload.model === 'string' && WORD.test(payload.model) ? payload.model : undefined,
    validation_status: publicStatus(decision.validation_status), has_rejection: Boolean(decision.rejection_reason),
    decision_receipt: opaqueReference('decision', decision.decision_signature || decision.id), created_at: decision.created_at,
    proposal_json: {}, decision_json: {}, policy_json: {},
  };
}

export function publicEvidenceExportRecord(artifact: AIScanArtifact): Record<string, unknown> {
  const publicArtifact = publicTechnicalArtifact(artifact);
  return {
    id: publicArtifact.id, task_id: publicArtifact.task_id, endpoint_id: publicArtifact.source_ref,
    type: publicArtifact.artifact_type, created_at: publicArtifact.created_at, content: publicArtifact.content_json,
  };
}

function publicTask(task: AIScanTask): AIScanTask {
  const objectiveManifest = normalObjectiveManifestForTask(task);
  const rawPlan = task.execution_plan || {};
  const intent = typeof rawPlan.intent === 'string' && PUBLIC_BUSINESS_LIFECYCLE_INTENTS.has(rawPlan.intent)
    ? rawPlan.intent
    : undefined;
  const publicExecutionPlan = {
    ...(intent ? { intent } : {}),
    ...(intent && publicId(rawPlan.flow_id) ? { flow_id: publicId(rawPlan.flow_id) } : {}),
    ...(intent && publicId(rawPlan.normal_run_id) ? { normal_run_id: publicId(rawPlan.normal_run_id) } : {}),
    ...(intent && Number.isInteger(rawPlan.source_flow_revision) && rawPlan.source_flow_revision >= 0 && rawPlan.source_flow_revision <= 1_000_000
      ? { source_flow_revision: rawPlan.source_flow_revision } : {}),
    ...(objectiveManifest.length ? {
      normal_objective_manifest: objectiveManifest.map(objective => ({ id: objective.id,
        ...(objective.completion ? { completion: { required_response_paths: objective.completion.required_response_paths } } : {}),
        ...(objective.operation ? { operation: publicObjectiveOperation(objective.operation) } : {}),
        ...(objective.requires_prepared_identity ? { requires_prepared_identity: true } : {}) })),
      strict_normal_objectives: task.execution_plan?.strict_normal_objectives === true,
    } : {}),
  };
  return {
    id: task.id, scan_run_id: task.scan_run_id, parent_task_id: publicId(task.parent_task_id),
    title: `Task: ${publicStatus(task.task_type) || 'assessment'}`,
    task_type: publicStatus(task.task_type) || 'assessment',
    vuln_type: VULN_TYPES.has(task.vuln_type || '') ? task.vuln_type : undefined,
    feature_id: publicId(task.feature_id), endpoint_ids: publicIds(task.endpoint_ids), status: task.status,
    phase: publicStatus(task.phase), priority: Number.isFinite(task.priority) ? task.priority : 0,
    dependencies: publicIds(task.dependencies), execution_plan: publicExecutionPlan, created_assets_json: {},
    result_summary: task.result_summary ? `Task ${task.status}` : undefined,
    started_at: task.started_at, completed_at: task.completed_at, created_at: task.created_at, updated_at: task.updated_at,
  } as AIScanTask;
}

function publicEndpoint(endpoint: AIDiscoveredEndpoint): AIDiscoveredEndpoint {
  return {
    id: endpoint.id, scan_run_id: endpoint.scan_run_id, method: String(endpoint.method || 'GET').toUpperCase().slice(0, 16),
    path: publicTechnicalPath(endpoint.path), auth_required: endpoint.auth_required === true,
    content_type: typeof endpoint.content_type === 'string' && WORD.test(endpoint.content_type) ? endpoint.content_type : undefined,
    source_type: publicStatus(endpoint.source_type), source_id: publicId(endpoint.source_id),
    created_at: endpoint.created_at, updated_at: endpoint.updated_at,
  };
}

function publicFeature(feature: AIFeatureNode): AIFeatureNode {
  return {
    id: feature.id, scan_run_id: feature.scan_run_id, parent_id: publicId(feature.parent_id),
    name: `Feature ${feature.id.slice(0, 8)}`, node_type: publicStatus(feature.node_type) || 'feature',
    confidence: Number.isFinite(feature.confidence) ? feature.confidence : 0,
    evidence_artifact_ids: publicIds(feature.evidence_artifact_ids), endpoint_ids: publicIds(feature.endpoint_ids),
    created_at: feature.created_at, updated_at: feature.updated_at,
  };
}

function publicCandidate(candidate: AIVulnerabilityCandidate): AIVulnerabilityCandidate {
  return {
    id: candidate.id, scan_run_id: candidate.scan_run_id, feature_id: publicId(candidate.feature_id),
    vuln_type: VULN_TYPES.has(candidate.vuln_type) ? candidate.vuln_type : 'business_logic',
    title: `Candidate ${candidate.vuln_type}`, confidence: Number.isFinite(candidate.confidence) ? candidate.confidence : 0,
    endpoint_ids: publicIds(candidate.endpoint_ids), required_accounts: [], status: publicStatus(candidate.status) || 'pending',
    created_at: candidate.created_at, updated_at: candidate.updated_at,
  };
}

export function buildPublicTechnicalSnapshot(snapshot: AIScanSnapshot): AIScanSnapshot {
  return {
    run: publicTechnicalRun(snapshot.run),
    tasks: snapshot.tasks.map(publicTask),
    endpoints: snapshot.endpoints.map(publicEndpoint),
    features: snapshot.features.map(publicFeature),
    candidates: snapshot.candidates.map(publicCandidate),
    artifacts: snapshot.artifacts.map(publicTechnicalArtifact),
    shared_resources: [], agent_memories: [], browser_contexts: [], planner_decisions: [], tool_invocations: [],
  };
}
