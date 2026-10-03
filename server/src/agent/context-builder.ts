import { compactModelEvidence } from './model-evidence-context.js';
import type { AgentToolSpec } from './tool-types.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { AIScanTask } from '../services/ai-scan/types.js';
import { retrieveRelevantAgentMemories } from '../services/ai-scan/agent-memory.js';
import { projectModelUrl, sanitizeForAIModel } from './model-context-sanitizer.js';
import { latestBusinessFlows } from './business-task-lifecycle.js';
import { deriveSelectorRecovery } from './selector-recovery.js';
import { isBrowserObservationTool, projectBrowserToolInput, projectBrowserToolResult } from '../services/ai-scan/browser/model-observation-projection.js';

const privateContainers = /^(?:raw_request|raw_response|request_body_text|response_body_text|request_body_base64|response_body_base64|request_snapshot_raw|snapshot_request_raw|trace|debug_trace|native_trace|captured_request)$/i;
const secretField = /password|passwd|^pwd$|secret|authorization|cookie|(?:^|_)token(?:$|_)|csrf|xsrf|ticket|otp|passcode|session_id|verification_code|^_g$/i;
// A recording-session ID is an opaque, assessment-owned database reference.
// It can remain in safe historical projections for correlation, but current
// normal-learning capture lifecycle tools bind it server-side. The model
// chooses observed event IDs and business semantics, never a mutable capture
// handle; all authentication session values remain redacted.
const modelReferenceField = /^(?:recording_session_id|recording_context_key|recording_context_scope|recording_identity_key|context_key|context_scope|identity_key|flow_id|workflow_id|source_workflow_id|test_run_id|normal_run_id|event_id|event_ids|candidate_event_ids|operation_candidate_event_ids|completion_candidate_event_ids|requested_event_ids|auto_included_event_ids|effective_event_ids|action_id|step_id|template_id|plan_id|plan_task_id|validated_task_id|validation_artifact_id|trace_artifact_id|target_id|endpoint_id|operation_id|coverage_key|feature_id)$/i;
// These are finite executor protocol names and opaque graph references, not
// captured transport values.  The final defensive value-redaction pass must
// never mutate them: local policy evaluates persisted tool names/statuses
// before it builds the provider envelope, and a changed name can turn a
// completed prerequisite into an infinite recovery loop.
const executionProtocolField = /^(?:tool_name|status|action|phase|task_type|intent|stage|role|capture_status|context_scope|identity_key|recording_context_scope|recording_identity_key|disposition|target_type|method|op|type|error_kind|selection_origin|transaction_prerequisite_proposal_class)$/i;
const NORMAL_CAPTURE_INSPECTION_NO_PROGRESS = 'normal_capture_inspection_no_progress';
const MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS = 3;
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

interface CaptureInspectionRecoveryProjection {
  recording_session_id: string;
  capture_status: 'recording' | 'stopped';
  event_count: number | null;
  semantic_candidate_available: boolean;
  material_progress_count: number;
  // A count of locally detected action/state transitions. It contains no
  // selector, value, URL, DOM, or digest and exists only to distinguish a
  // multi-step browser flow from a repeated unchanged interaction cycle.
  browser_state_progress_count: number;
  required_next_action_class: string;
  last_unsuccessful_action_class?: string;
  objective_navigation_hints?: string[];
  // Closed, server-derived transaction stages. The provider receives only
  // this finite enum, never a control ref, label, route, or captured value.
  objective_required_control_intents?: string[];
  // The server can also say whether the current opaque observation actually
  // contains usable candidates for a required finite intent.  These are
  // counts keyed only by the same closed enum; references and DOM content
  // remain in the current browser observation rather than this recovery
  // receipt.
  objective_eligible_current_control_counts?: Record<string, number>;
  // A closed server-side explanation for why the previous transaction
  // proposal was not executable. It deliberately excludes all DOM and model
  // argument material, while allowing the next provider turn to correct the
  // right dimension of its choice.
  transaction_prerequisite_proposal_class?: string;
  objective_completion_required_response_paths?: string[];
  objective_completion_candidate_count?: number;
  objective_operation_id?: string;
  objective_operation_side_effect_class?: string;
  objective_operation_candidate_count?: number;
  coverage_retry_candidate_count?: number;
  coverage_retry_all_candidates?: boolean;
}

function safeCaptureInspectionRecoveryProjection(value: unknown): CaptureInspectionRecoveryProjection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const recordingSessionId = typeof source.recording_session_id === 'string' ? source.recording_session_id : '';
  const captureStatus = source.capture_status === 'recording' || source.capture_status === 'stopped' ? source.capture_status : undefined;
  const eventCount = source.event_count === null ? null : (Number.isInteger(source.event_count) && Number(source.event_count) >= 0 ? Number(source.event_count) : undefined);
  const progressCount = Number.isInteger(source.material_progress_count) && Number(source.material_progress_count) >= 0
    ? Number(source.material_progress_count) : undefined;
  const browserStateProgressCount = Number.isInteger(source.browser_state_progress_count) && Number(source.browser_state_progress_count) >= 0
    ? Number(source.browser_state_progress_count) : undefined;
  const actionClass = typeof source.required_next_action_class === 'string' && /^[a-z_]{1,96}$/.test(source.required_next_action_class)
    ? source.required_next_action_class : '';
  if (!recordingSessionId || !captureStatus || eventCount === undefined || progressCount === undefined || browserStateProgressCount === undefined || !actionClass ||
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
    semantic_candidate_available: source.semantic_candidate_available, material_progress_count: progressCount,
    browser_state_progress_count: browserStateProgressCount, required_next_action_class: actionClass,
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

/** Evidence progress is defined by the safe capture inventory, never by how
 * many UI attempts preceded it. A successful click can leave the same captured
 * evidence, so material_progress_count remains diagnostic-only. */
function sameCaptureInspectionRecovery(left: CaptureInspectionRecoveryProjection, right: CaptureInspectionRecoveryProjection): boolean {
  return left.recording_session_id === right.recording_session_id && left.capture_status === right.capture_status &&
    // Keep event_count visible for diagnosis, but never treat background or
    // unrelated capture traffic as proof that this Flow progressed.
    left.semantic_candidate_available === right.semantic_candidate_available &&
    left.browser_state_progress_count === right.browser_state_progress_count &&
    (left.objective_required_control_intents || []).join(',') === (right.objective_required_control_intents || []).join(',') &&
    // Candidate counts are a prompt-quality diagnostic snapshot. They cannot
    // replenish the bounded recovery allowance: a noisy UI may change its
    // count without creating a new browser state or semantic evidence.
    left.objective_completion_candidate_count === right.objective_completion_candidate_count &&
    left.objective_operation_candidate_count === right.objective_operation_candidate_count &&
    left.coverage_retry_candidate_count === right.coverage_retry_candidate_count &&
    left.coverage_retry_all_candidates === right.coverage_retry_all_candidates;
}

/** Model-visible recovery state is an allowlisted aggregation of persisted
 * planner receipts. It never projects a rejected proposal's arguments,
 * rationale, capture event data, or any request/response content. */
function deriveCaptureInspectionRecovery(plannerDecisions: any[]): Record<string, unknown> | undefined {
  const matching = (plannerDecisions || []).flatMap(decision => {
    if (decision?.validation_status !== 'rejected' ||
        decision?.policy_json?.rejection_code !== NORMAL_CAPTURE_INSPECTION_NO_PROGRESS) return [];
    const episode = safeCaptureInspectionRecoveryProjection(decision.policy_json?.rejection_context);
    return episode ? [{ decision, episode }] : [];
  });
  const latest = matching.at(-1);
  if (!latest) return undefined;
  const attempts = matching.filter(item => sameCaptureInspectionRecovery(item.episode, latest.episode)).length;
  return {
    rejection_code: NORMAL_CAPTURE_INSPECTION_NO_PROGRESS,
    consecutive_attempts: attempts,
    limit: MAX_NORMAL_CAPTURE_INSPECTION_NO_PROGRESS_ATTEMPTS,
    capture_status: latest.episode.capture_status,
    event_count: latest.episode.event_count,
    semantic_candidate_available: latest.episode.semantic_candidate_available,
    browser_state_progress_count: latest.episode.browser_state_progress_count,
    required_next_action_class: latest.episode.required_next_action_class,
    ...(latest.episode.last_unsuccessful_action_class ? {last_unsuccessful_action_class:latest.episode.last_unsuccessful_action_class}:{}),
    ...(latest.episode.objective_navigation_hints?.length ? {objective_navigation_hints:latest.episode.objective_navigation_hints}:{}),
    ...(latest.episode.objective_required_control_intents?.length ? {objective_required_control_intents:latest.episode.objective_required_control_intents}:{}),
    ...(latest.episode.objective_eligible_current_control_counts && Object.keys(latest.episode.objective_eligible_current_control_counts).length
      ? {objective_eligible_current_control_counts:latest.episode.objective_eligible_current_control_counts}:{}),
    ...(latest.episode.transaction_prerequisite_proposal_class
      ? {transaction_prerequisite_proposal_class:latest.episode.transaction_prerequisite_proposal_class}:{}),
    ...(latest.episode.objective_completion_required_response_paths?.length ? {
      objective_completion_required_response_paths: latest.episode.objective_completion_required_response_paths,
      objective_completion_candidate_count: latest.episode.objective_completion_candidate_count ?? 0,
    } : {}),
    ...(latest.episode.objective_operation_id && latest.episode.objective_operation_side_effect_class ? {
      objective_operation_id: latest.episode.objective_operation_id,
      objective_operation_side_effect_class: latest.episode.objective_operation_side_effect_class,
      objective_operation_candidate_count: latest.episode.objective_operation_candidate_count ?? 0,
    } : {}),
    ...(latest.episode.coverage_retry_candidate_count !== undefined ? {
      coverage_retry_candidate_count: latest.episode.coverage_retry_candidate_count,
      coverage_retry_all_candidates: latest.episode.coverage_retry_all_candidates === true,
    } : {}),
  };
}

function compactBusinessAssertion(assertion: any): Record<string, any> {
  const capturedBaseline=assertion?.right?.captured_baseline===true||assertion?.right?.type==='captured_baseline';
  return {
    id: assertion?.id, step_order: assertion?.step_order, description: assertion?.description, purpose: assertion?.purpose,
    left: assertion?.left ? { type: assertion.left.type, path: assertion.left.path } : undefined, op: assertion?.op,
    right: assertion?.right ? {
      type: capturedBaseline?'captured_baseline':assertion.right.type,
      key: capturedBaseline||['literal','value_ref'].includes(assertion.right.type) ? undefined : assertion.right.key,
      handle_id: !capturedBaseline&&assertion.right.type === 'value_ref' ? assertion.right.handle_id : undefined,
      value_present: !capturedBaseline&&assertion.right.type === 'literal' && assertion.right.value !== undefined,
    } : undefined,
    missing_behavior: assertion?.missing_behavior, ...(typeof assertion?.passed === 'boolean' ? { passed: assertion.passed } : {}),
  };
}

/** Business tool calls may contain neutral customer/object values whose field
 * names are not recognizable as secrets. Preserve the execution graph and
 * field paths, but never replay scalar request/response/assertion values into
 * a later model prompt. */
function compactBusinessInvocationValue(value: any, key = '', depth = 0): any {
  if (depth > 18) return '[nested business value omitted]';
  const privateValue = /^(?:value|value_preview|valuepreview|current_value|original_value|operand|payload|body|headers|request|response|error|errors|url)$/i;
  if (privateValue.test(key)) return '[business value retained privately]';
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // These are server-issued graph references and bounded labels, rather than
    // captured transport scalars. Keeping them lets the model connect a
    // coverage.inspect target to flow.define and coverage.save without ever
    // seeing the request/response value that produced the endpoint.
    if (/^(?:flow_id|workflow_id|workflow_step_id|source_workflow_id|recording_session_id|recording_context_key|recording_context_scope|recording_identity_key|context_key|context_scope|identity_key|test_run_id|event_id|event_ids|candidate_event_ids|operation_candidate_event_ids|completion_candidate_event_ids|requested_event_ids|auto_included_event_ids|effective_event_ids|action_id|step_id|template_id|plan_id|plan_task_id|validated_task_id|validation_artifact_id|trace_artifact_id|target_id|target_type|feature_id|feature_name|endpoint_id|operation_id|coverage_key|disposition|id|fromPath|toPath|from_path|to_path|sourcePath|sourceLocation|fromLocation|toLocation|variableName|variable_name|targetVariableName|predictedType|data_source|writePolicySuggestion|transformHint|path|method|status|purpose|op|type|role|name|reason|origin|description|summary|failure_code|error_kind|selection_origin)$/i.test(key)) return value.slice(0, 500);
    return { type: 'string', length: value.length, omitted: true };
  }
  if (Array.isArray(value)) return value.slice(0, 120).map(item => compactBusinessInvocationValue(item, key, depth + 1));
  if (typeof value === 'object') {
    if (key === 'right') {
      const capturedBaseline=value?.captured_baseline===true||value?.type==='captured_baseline';
      return { type: capturedBaseline?'captured_baseline':value.type,
        key: capturedBaseline||['literal','value_ref'].includes(value.type) ? undefined : value.key,
        handle_id:!capturedBaseline&&value.type==='value_ref'?value.handle_id:undefined,
        value_present: !capturedBaseline&&value.type === 'literal' && value.value !== undefined };
    }
    return Object.fromEntries(Object.entries(value).slice(0, 120).map(([name, item]) => [name, compactBusinessInvocationValue(item, name, depth + 1)]));
  }
  return '[business value omitted]';
}

function compactBusinessFlow(flow: any): Record<string, any> {
  return {
    id: flow.id, revision: flow.revision, ...(typeof flow.objective_id==='string'&&/^objective:[a-f0-9]{24}$/.test(flow.objective_id)?{objective_id:flow.objective_id}:{}), name: flow.name, goal: flow.goal, role: flow.role, status: flow.status,
    feature_id: flow.feature_id, feature_name: flow.feature_name, prerequisites: flow.prerequisites, blockers: flow.blockers,
    steps: (flow.steps || []).map((step: any) => ({ id: step.id, description: step.description, step_order: step.step_order, endpoint_id: step.endpoint_id, event_id: step.event_id })),
    coverage_bindings:(flow.coverage_bindings||[]).map((binding:any)=>({target_type:binding.target_type,target_id:binding.target_id,endpoint_id:binding.endpoint_id,
      source_event_id:binding.source_event_id,action_id:binding.action_id,source_step_order:binding.source_step_order,source_workflow_id:binding.source_workflow_id,
      normal_workflow_id:binding.normal_workflow_id,normal_run_id:binding.normal_run_id,validated:binding.validated===true})),
    // A retry's active bindings are intentionally fresh. This opaque ledger
    // tells the model which earlier targets have already been natively proven
    // without exposing traffic, assertion operands, or any private trace.
    coverage_proof_ledger:(flow.coverage_proof_ledger||[]).map((proof:any)=>({target_type:proof.target_type,target_id:proof.target_id,endpoint_id:proof.endpoint_id,
      source_event_id:proof.source_event_id,action_id:proof.action_id,source_step_order:proof.source_step_order,source_workflow_id:proof.source_workflow_id,
      normal_workflow_id:proof.normal_workflow_id,normal_run_id:proof.normal_run_id,validated_task_id:proof.validated_task_id,
      validation_artifact_id:proof.validation_artifact_id,validated:proof.validated===true})),
    assertions: (flow.assertions || []).map(compactBusinessAssertion),
    recording_session_id: flow.recording_session_id,
    recording_context_key: flow.recording_context_key,
    recording_context_scope: flow.recording_context_scope,
    recording_identity_key: flow.recording_identity_key,
    workflow_id: flow.workflow_id, normal_run_id: flow.normal_run_id,
    ...(Array.isArray(flow?.objective_completion?.required_response_paths) ? {objective_completion:{
      required_response_paths:[...new Set(flow.objective_completion.required_response_paths.filter((path:any)=>typeof path==='string'&&
        /^body\.[a-z0-9_.\[\]-]{1,500}$/i.test(path)))].slice(0,24),
    }} : {}),
    ...(flow?.objective_completion_binding&&typeof flow.objective_completion_binding==='object'?{objective_completion_binding:{
      required_response_paths:[...new Set((Array.isArray(flow.objective_completion_binding.required_response_paths)?flow.objective_completion_binding.required_response_paths:[])
        .filter((path:any)=>typeof path==='string'&&/^body\.[a-z0-9_.\[\]-]{1,500}$/i.test(path)))].slice(0,24),
      source_event_ids:(Array.isArray(flow.objective_completion_binding.source_event_ids)?flow.objective_completion_binding.source_event_ids:[]).slice(0,64),
      action_ids:(Array.isArray(flow.objective_completion_binding.action_ids)?flow.objective_completion_binding.action_ids:[]).slice(0,64),
      source_workflow_id:flow.objective_completion_binding.source_workflow_id,
      source_step_orders:(Array.isArray(flow.objective_completion_binding.source_step_orders)?flow.objective_completion_binding.source_step_orders:[]).slice(0,64),
      normal_workflow_id:flow.objective_completion_binding.normal_workflow_id,
      normal_run_id:flow.objective_completion_binding.normal_run_id,
      validation_assertion_ids:(Array.isArray(flow.objective_completion_binding.validation_assertion_ids)?flow.objective_completion_binding.validation_assertion_ids:[]).slice(0,64),
      validated:flow.objective_completion_binding.validated===true,
    }}:{}),
    ...(typeof flow?.objective_operation?.operation_id==='string'&&/^operation:[a-f0-9]{24}$/.test(flow.objective_operation.operation_id)?{objective_operation:{operation_id:flow.objective_operation.operation_id,side_effect_class:flow.objective_operation.side_effect_class}}:{}),
    ...(flow?.objective_operation_binding&&typeof flow.objective_operation_binding==='object'?{objective_operation_binding:{operation_id:flow.objective_operation_binding.operation_id,side_effect_class:flow.objective_operation_binding.side_effect_class,source_event_ids:flow.objective_operation_binding.source_event_ids,action_ids:flow.objective_operation_binding.action_ids,source_workflow_id:flow.objective_operation_binding.source_workflow_id,source_step_orders:flow.objective_operation_binding.source_step_orders,normal_workflow_id:flow.objective_operation_binding.normal_workflow_id,normal_run_id:flow.objective_operation_binding.normal_run_id,validation_assertion_ids:flow.objective_operation_binding.validation_assertion_ids,validation_artifact_id:flow.objective_operation_binding.validation_artifact_id,validated:flow.objective_operation_binding.validated===true}}:{}),
    assertions_verified: flow.assertions_verified === true, evidence_artifact_ids: flow.evidence_artifact_ids,
  };
}

const NORMAL_EXECUTION_FAILURE_KINDS = new Set(['non_success_response','timeout','transport','mapping_or_variable','executor']);

/** A normal validation artifact is model feedback, not a trace viewer. */
function compactNormalValidationArtifact(value: any): Record<string, any> {
  const execution = value?.execution || {};
  const executionFailures = (Array.isArray(execution.execution_failures) ? execution.execution_failures : [])
    .slice(0, 64)
    .map((failure: any) => {
      const step_order = Number(failure?.step_order || 0);
      const status = Number(failure?.status || 0);
      const error_kind = String(failure?.error_kind || '');
      if (!Number.isInteger(step_order) || step_order < 1 || !NORMAL_EXECUTION_FAILURE_KINDS.has(error_kind)) return undefined;
      return {step_order,...(status >= 100 && status <= 599 ? {status} : {}),error_kind};
    })
    .filter(Boolean);
  return {
    flow_id: value?.flow_id,
    workflow_id: value?.workflow_id,
    source_workflow_id: value?.source_workflow_id,
    recording_session_id: value?.recording_session_id,
    test_run_id: value?.test_run_id,
    assertions: (Array.isArray(value?.assertions) ? value.assertions : []).slice(0, 50).map(compactBusinessAssertion),
    verified: value?.verified === true,
    assertions_verified: value?.assertions_verified === true,
    execution: {
      success: execution.success === true,
      has_execution_error: execution.has_execution_error === true,
      errors_count: Number(execution.errors_count || 0),
      execution_failures: executionFailures,
    },
    coverage_bindings: (Array.isArray(value?.coverage_bindings) ? value.coverage_bindings : []).slice(0, 120).map((binding: any) => ({
      target_type: binding?.target_type,
      target_id: binding?.target_id,
      endpoint_id: binding?.endpoint_id,
      source_event_id: binding?.source_event_id,
      action_id: binding?.action_id,
      source_step_order: Number.isInteger(binding?.source_step_order) ? binding.source_step_order : undefined,
      source_workflow_id: binding?.source_workflow_id,
      normal_workflow_id: binding?.normal_workflow_id,
      normal_run_id: binding?.normal_run_id,
      validated: binding?.validated === true,
    })),
    object_handle_catalog_id: value?.object_handle_catalog_id,
    trace: '[Private evidence retained in the originating record]',
  };
}

/** Private sources stay in the canonical recorder/native evidence. Tool outputs
 * may retain safe field structure and business outcomes for model adaptation. */
export function modelFacingEvidence(value: any, depth = 0): any {
  if (depth > 24) return '[nested evidence omitted]';
  if (value === null || typeof value !== 'object') return sanitizeForAIModel(value);
  if (Array.isArray(value)) return value.map(item => modelFacingEvidence(item, depth + 1));
  if (value.private === true) return Object.fromEntries(['flow_id', 'workflow_id', 'source_workflow_id', 'recording_session_id', 'recording_context_key', 'recording_context_scope', 'recording_identity_key', 'context_key', 'context_scope', 'identity_key',
    'test_run_id', 'id', 'status', 'summary', 'selection_origin', 'requested_event_ids', 'auto_included_event_ids', 'effective_event_ids', 'selected_event_count'].filter(key => value[key] !== undefined).map(key => [key, modelFacingEvidence(value[key], depth + 1)])
    .concat([['private_evidence', 'Inspect using the registered business tools; raw sources are retained privately.']]));
  const fieldIsSecret = secretField.test(String(value.name || value.field_name || ''));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    privateContainers.test(key) ? '[Private evidence retained in the originating record]' :
      (secretField.test(key) && !modelReferenceField.test(key)) || (fieldIsSecret && ['value', 'original_value', 'current_value', 'valuePreview'].includes(key))
        ? '[REDACTED]' : modelFacingEvidence(item, depth + 1)]));
}

const privateTransportContainer = /^(?:url|request_headers|response_headers|request_cookies|response_cookies|query_params|parsed_request_body|parsed_response_body|request_body_text|response_body_text|request_body_base64|response_body_base64|body|headers|cookies|query|request|response|trace|native_trace)$/i;
const commonPrivateTransportText = new Set([
  'true', 'false', 'null', 'undefined', 'get', 'post', 'put', 'patch', 'delete',
  'application/json', 'application/x-www-form-urlencoded', 'text/plain', 'text/html',
]);

function addPrivateTransportValue(values: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const candidate = value.trim();
  // Short values such as "ok", HTTP method names, and status labels are too
  // ambiguous to replace globally. Bodies containing them are already omitted;
  // URL values are structurally removed by projectModelUrl.
  if (candidate.length < 4 || candidate.length > 16_384 || commonPrivateTransportText.has(candidate.toLowerCase())) return;
  values.add(candidate);
}

function collectPrivateTransportValues(values: Set<string>, value: unknown, key = '', inheritedTransport = false, depth = 0): void {
  if (depth > 24 || value === null || value === undefined) return;
  const transport = inheritedTransport || privateTransportContainer.test(key);
  if (typeof value === 'string') {
    if (!transport) return;
    if (/url$/i.test(key)) {
      // The raw URL itself might be repeated in a model-visible diagnostic.
      // Its query values are also recorded separately for encoded/prose echoes.
      addPrivateTransportValue(values, value);
      try {
        const url = new URL(value, 'https://private-capture.invalid');
        for (const queryValue of url.searchParams.values()) addPrivateTransportValue(values, queryValue);
      } catch { /* malformed private URL remains private as a whole value */ }
      return;
    }
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        collectPrivateTransportValues(values, parsed, '', true, depth + 1);
        return;
      }
    } catch { /* not JSON */ }
    if (value.includes('=')) try {
      const params = new URLSearchParams(value);
      let sawParameter = false;
      for (const [, parameterValue] of params) {
        sawParameter = true;
        addPrivateTransportValue(values, parameterValue);
      }
      if (sawParameter) {
        // A base64-like opaque value can itself contain "=". Keep the full
        // scalar too, otherwise an echoed value could be mistaken for a form
        // pair and survive the final text replacement.
        addPrivateTransportValue(values, value);
        return;
      }
    } catch { /* plain transport scalar */ }
    addPrivateTransportValue(values, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPrivateTransportValues(values, item, key, transport, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) collectPrivateTransportValues(values, item, name, transport, depth + 1);
  }
}

function privateSecretValues(snapshot: any): string[] {
  const values = new Set<string>();
  const inspect = (value: any, key = '', depth = 0): void => {
    if (depth > 24 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (secretField.test(key) && !modelReferenceField.test(key) && value.length >= 4) values.add(value);
      if (['request_body_text', 'response_body_text'].includes(key)) {
        try { inspect(JSON.parse(value), '', depth + 1); } catch { for (const [name, field] of new URLSearchParams(value)) if (secretField.test(name) && field.length >= 4) values.add(field); }
      }
      if (/cookie/i.test(key)) for (const part of value.split(/[;,]/)) {const field = part.slice(part.indexOf('=') + 1).trim(); if (part.includes('=') && field.length >= 4) values.add(field);}
      return;
    }
    if (Array.isArray(value)) {value.forEach(item => inspect(item, key, depth + 1));return;}
    if (typeof value === 'object') for (const [name, item] of Object.entries(value)) inspect(item, name, depth + 1);
  };
  inspect(snapshot.run?.scan_config);
  for (const artifact of snapshot.artifacts || []) if (artifact.content_json?.private === true ||
    ['business_capture_event', 'business_native_trace', 'captured_request'].includes(artifact.artifact_type)) {
    inspect(artifact.content_json);
    // Do not infer privacy from a field name here: a private browser capture
    // can carry custom aliases such as nonce_custom/state_custom. Preserve no
    // scalar values from its transport containers in any later provider turn.
    collectPrivateTransportValues(values, artifact.content_json);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function redactKnownSecrets(value: any, secrets: string[], key = '', parentKey = ''): any {
  if (typeof value === 'string') {
    // Tool descriptor names need to remain callable by their exact registered
    // spelling.  They are product-owned protocol identifiers, not target data.
    if (modelReferenceField.test(key) || executionProtocolField.test(key) || (key === 'name' && parentKey === 'available_tools')) return value;
    return secrets.reduce((text, secret) => {
    const encoded = encodeURIComponent(secret);
    const formEncoded = encoded.replace(/%20/g, '+');
    return text.split(secret).join('[REDACTED]').split(encoded).join('[REDACTED]').split(formEncoded).join('[REDACTED]');
    }, value);
  }
  if (Array.isArray(value)) return value.map(item => redactKnownSecrets(item, secrets, key, parentKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactKnownSecrets(item, secrets, childKey, key)]));
  return value;
}

function compactTool(tool: AgentToolSpec): Record<string, any> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    side_effects: tool.side_effects || [],
  };
}

function compactEndpoint(endpoint: any): Record<string, any> {
  return {
    id: endpoint.id,
    method: endpoint.method,
    // IDs select the native endpoint. The model needs only the route shape.
    path: projectModelUrl(endpoint.path),
    url: projectModelUrl(endpoint.url),
    content_type: endpoint.content_type,
    feature_guess: endpoint.feature_guess,
    request_summary: endpoint.request_summary,
    response_summary: endpoint.response_summary,
  };
}

function compactArtifact(artifact: any): Record<string, any> {
  // Repository rows use artifact_type, whereas safe in-memory projections
  // may carry type. Normalize first so either representation receives the
  // same type-specific redaction.
  const artifactType = String(artifact.artifact_type || artifact.type || '');
  const normalValidation = artifactType === 'business_workflow_validation'
    ? compactNormalValidationArtifact(artifact.content_json) : undefined;
  const browserObservation = artifactType === 'browser_state' || artifactType === 'browser_warning';
  return {
    id: artifact.id,
    type: artifactType,
    title: artifact.title,
    source_ref: artifact.source_ref,
    created_at: artifact.created_at,
    content_json: browserObservation ? { private_evidence: 'Browser observations are retained in the private browser boundary.' }
      : compactModelEvidence(normalValidation || modelFacingEvidence(artifact.content_json), 8000),
    content_text: browserObservation || artifact.content_json?.private === true || ['business_capture_event', 'business_native_trace', 'captured_request'].includes(artifactType)
      ? undefined : artifact.content_text ? String(sanitizeForAIModel(artifact.content_text)).slice(0, 1000) : undefined,
  };
}

function compactSharedResource(resource: any): Record<string, any> {
  return {
    id: resource.id,
    type: resource.resource_type,
    key: resource.resource_key,
    title: resource.title,
    usage_count: resource.usage_count,
    content_json: compactModelEvidence(modelFacingEvidence(resource.content_json), 2000),
    updated_at: resource.updated_at,
  };
}

/**
 * Workflow inspection is the one normal-learning response that gives the
 * model the executable assertion vocabulary for every recorded step. A
 * generic size-first object projection can retain an early step's headers
 * while dropping later `body.*` paths, leaving the model unable to choose a
 * valid semantic assertion and encouraging repeated inspections. Preserve
 * only the safe shape needed for validation: opaque graph references and
 * field paths, never response values, request structures, or learning trace
 * payloads.
 */
function compactWorkflowInspectionOutput(output: any): Record<string, any> {
  const safePath = (value: any): string | undefined => {
    const path = typeof value === 'string' ? value.trim() : '';
    return /^(?:status|headers\.[a-z0-9_-]+|body\.[a-z0-9_.\[\]-]+)$/i.test(path) ? path.slice(0, 500) : undefined;
  };
  const steps = Array.isArray(output?.steps) ? output.steps.slice(0, 32).map((step: any) => ({
    // Native asset inspection labels this explicitly. Retain the alias in the
    // provider projection so an experiment plan cannot confuse it with a
    // business-flow graph-step ID.
    workflow_step_id: typeof step?.workflow_step_id === 'string' ? step.workflow_step_id
      : typeof step?.step_id === 'string' ? step.step_id
        : typeof step?.id === 'string' ? step.id : undefined,
    step_id: typeof step?.step_id === 'string' ? step.step_id : undefined,
    step_order: Number.isInteger(step?.step_order) ? step.step_order : undefined,
    template_id: typeof step?.template_id === 'string' ? step.template_id : undefined,
    method: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(String(step?.method||'').toUpperCase())
      ? String(step.method).toUpperCase() : undefined,
    name: typeof step?.name === 'string' ? step.name.slice(0, 240) : undefined,
    assertion_paths: (Array.isArray(step?.assertion_paths) ? step.assertion_paths : [])
      .map((candidate: any) => {
        const path = safePath(candidate?.path);
        return path ? { path, semantic: candidate?.semantic === true } : undefined;
      })
      // `status` establishes execution success; semantic body paths establish
      // the business result. Header inventories add little decision value and
      // would crowd out later steps' semantic paths in a long workflow.
      .filter((candidate: any) => candidate && (candidate.semantic === true || candidate.path === 'status'))
      .slice(0, 16),
    semantic_body_path_available: step?.semantic_body_path_available === true,
  })) : [];
  const retryTargetAssertionRequirements = (Array.isArray(output?.retry_target_assertion_requirements)
    ? output.retry_target_assertion_requirements : []).slice(0, 40).map((requirement: any) => {
      const targetType = requirement?.target_type === 'feature' || requirement?.target_type === 'operation'
        ? requirement.target_type : undefined;
      const targetId = typeof requirement?.target_id === 'string' && requirement.target_id.length > 0
        ? requirement.target_id.slice(0, 500) : undefined;
      if (!targetType || !targetId) return undefined;
      return {
        target_type: targetType,
        target_id: targetId,
        source_step_orders: (Array.isArray(requirement?.source_step_orders) ? requirement.source_step_orders : [])
          .filter((stepOrder: unknown) => Number.isInteger(stepOrder) && Number(stepOrder) > 0)
          .slice(0, 20),
        semantic_body_assertion_required: requirement?.semantic_body_assertion_required === true,
      };
    }).filter(Boolean);
  return {
    flow_id: typeof output?.flow_id === 'string' ? output.flow_id : undefined,
    goal: typeof output?.goal === 'string' ? output.goal.slice(0, 500) : undefined,
    recording_session_id: typeof output?.recording_session_id === 'string' ? output.recording_session_id : undefined,
    workflow_id: typeof output?.workflow_id === 'string' ? output.workflow_id : undefined,
    identity_key: typeof output?.identity_key === 'string' ? output.identity_key : undefined,
    steps,
    coverage_bindings: (Array.isArray(output?.coverage_bindings) ? output.coverage_bindings : []).slice(0, 64).map((binding: any) => ({
      target_type: binding?.target_type,
      target_id: binding?.target_id,
      endpoint_id: binding?.endpoint_id,
      action_id: binding?.action_id,
      source_step_order: Number.isInteger(binding?.source_step_order) ? binding.source_step_order : undefined,
      source_workflow_id: binding?.source_workflow_id,
      validated: binding?.validated === true,
    })),
    ...(retryTargetAssertionRequirements.length ? { retry_target_assertion_requirements: retryTargetAssertionRequirements } : {}),
    inspection_summary: 'Use the listed assertion_paths for semantic normal-flow validation. Captured scalar values remain private and may be compared with captured_baseline.',
  };
}

function compactInvocation(invocation: any): Record<string, any> {
  const businessTool = /^(?:bstg\.business\.|bstg\.workflow\.|bstg\.native\.|bstg\.test_plan\.)/.test(String(invocation.tool_name || ''));
  const browserTool = isBrowserObservationTool(String(invocation.tool_name || ''));
  const outputSummary = invocation.output_json?.summary ?? invocation.output_json?.message;
  const outputValue = invocation.tool_name === 'bstg.business.workflow.inspect'
    ? compactWorkflowInspectionOutput(invocation.output_json)
    : browserTool ? projectBrowserToolResult(invocation.output_json)
    : businessTool ? compactBusinessInvocationValue(invocation.output_json) : modelFacingEvidence(invocation.output_json);
  return {
    id: invocation.id,
    tool_name: invocation.tool_name,
    status: invocation.status,
    input_json: compactModelEvidence(browserTool ? projectBrowserToolInput(invocation.input_json)
      : businessTool ? compactBusinessInvocationValue(invocation.input_json) : modelFacingEvidence(invocation.input_json), 2000),
    // Unlike the structured output below, a tool-provided summary used to be
    // copied directly into the provider envelope. Keep it subject to the same
    // model-facing redaction and bounded serialization contract: summaries
    // often echo browser/runner details and must never become an unbounded
    // side channel around modelFacingEvidence.
    output_summary: browserTool ? undefined : outputSummary === undefined ? undefined : compactModelEvidence(modelFacingEvidence(outputSummary), 800),
    output_json: compactModelEvidence(outputValue, 12000),
    error_message: browserTool ? undefined : businessTool ? (invocation.error_message ? 'Business tool reported a private diagnostic.' : undefined) : invocation.error_message,
    created_at: invocation.created_at,
  };
}

export interface AutonomousAgentContext {
  /** Server-only full target URL for native policy and browser dispatch. It is
   * intentionally stripped from the provider envelope; scan.base_url is
   * structurally projected at the model transport boundary instead. */
  execution_base_url?: string;
  scan: Record<string, any>;
  task: Record<string, any>;
  selected_vuln_types: string[];
  available_tools: Record<string, any>[];
  relevant_endpoints: Record<string, any>[];
  endpoint_inventory_summary: Record<string, any>;
  feature_tree: Record<string, any>[];
  vulnerability_candidates: Record<string, any>[];
  task_artifacts: Record<string, any>[];
  task_tool_invocations: Record<string, any>[];
  /** Non-enumerable server-side lifecycle history attached by the normal-stage
   * provider projection. It lets local guards retain capture provenance while
   * the provider sees only a bounded evidence window. */
  lifecycle_tool_invocations?: Record<string, any>[];
  /** Complete persisted planner receipts, attached non-enumerably only for
   * server-side recovery sequencing; never serialized to a provider. */
  lifecycle_planner_decisions?: Record<string, any>[];
  global_recent_artifacts: Record<string, any>[];
  shared_resources: Record<string, any>[];
  shared_resource_summary: Record<string, any>;
  relevant_memories: Record<string, any>[];
  memory_summary: Record<string, any>;
  browser_context_summary: Record<string, any>;
  planner_state: Record<string, any>;
  recent_tasks: Record<string, any>[];
  operating_rules: string[];
  business_flows?: Record<string, any>[];
  /** Stage-scoped model transport contract. This is absent from canonical
   * snapshots and is attached only immediately before an LLM decision. */
  model_scope?: {
    stage: string;
    purpose: string;
    authorization: 'acknowledged' | 'not_recorded';
    allowed_tool_names: string[];
    allowed_actions: string[];
    broader_assessment_context_withheld: boolean;
  };
}

export async function buildAutonomousAgentContext(input: {
  repo: AIScanRepository;
  scanRunId: string;
  task: AIScanTask;
  tools: AgentToolSpec[];
}): Promise<AutonomousAgentContext> {
  const { repo, scanRunId, task, tools } = input;
  const snapshot = await repo.getSnapshot(scanRunId);
  const relatedEndpointIds = new Set(task.endpoint_ids || []);
  const relevantEndpoints = snapshot.endpoints
    .filter(endpoint => relatedEndpointIds.size === 0 || relatedEndpointIds.has(endpoint.id))
    .map(compactEndpoint)
    .slice(0, 80);
  const endpointSummaryByMethod: Record<string, number> = {};
  const endpointSummaryBySource: Record<string, number> = {};
  for (const endpoint of snapshot.endpoints) {
    endpointSummaryByMethod[endpoint.method] = (endpointSummaryByMethod[endpoint.method] || 0) + 1;
    endpointSummaryBySource[endpoint.source_type || 'unknown'] = (endpointSummaryBySource[endpoint.source_type || 'unknown'] || 0) + 1;
  }
  const taskArtifacts = snapshot.artifacts
    .filter(artifact => artifact.task_id === task.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 30)
    .map(compactArtifact);
  const taskInvocationHistory = snapshot.tool_invocations
    .filter(invocation => invocation.task_id === task.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  // This state is calculated from the complete persisted task history before
  // the model-facing invocation list is bounded. A provider therefore cannot
  // erase a pending selector correction by consuming the prompt's recent-call
  // window with selectorless observations.
  const normalBusinessSelectorRecovery = deriveSelectorRecovery(taskInvocationHistory);
  // Compact every persisted task invocation before retaining it as local
  // lifecycle state. The provider projection below selects only a small set
  // of current turns and transition receipts, while local guards must retain
  // the capture start and strict inspection even after a long browser flow.
  // compactInvocation is value-free, so this non-enumerable server-side
  // history cannot become a raw-capture side channel.
  const lifecycleTaskInvocations = taskInvocationHistory.map(compactInvocation);
  const taskInvocations = lifecycleTaskInvocations.slice(-64);
  const globalRecentArtifacts = snapshot.artifacts
    .filter(artifact => artifact.task_id !== task.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 20)
    .map(compactArtifact);
  const sharedResources = (snapshot.shared_resources || []).map(compactSharedResource);
  const sharedByType: Record<string, number> = {};
  for (const resource of sharedResources) sharedByType[resource.type] = (sharedByType[resource.type] || 0) + 1;
  const relevantMemories = await retrieveRelevantAgentMemories({
    repo,
    scanRunId,
    task,
    query: `${task.title || ''} ${task.agent_goal || ''} ${task.vuln_type || ''}`,
    limit: Number(snapshot.run.scan_config?.agent_memory?.max_context_memories || 20),
  });
  const memoryByType: Record<string, number> = {};
  for (const memory of snapshot.agent_memories || []) memoryByType[memory.memory_type] = (memoryByType[memory.memory_type] || 0) + 1;
  const browserContexts = (snapshot.browser_contexts || []).filter(item => item.status === 'active');
  const plannerDecisions = (snapshot.planner_decisions || []).filter(item => item.task_id === task.id);
  const captureInspectionRecovery = deriveCaptureInspectionRecovery(plannerDecisions);
  const tokenUsage = (item: any) => Number(item.decision_json?.ai_usage?.total_tokens || 0);
  const taskAiTokens = plannerDecisions.reduce((sum, item) => sum + tokenUsage(item), 0);
  const scanAiTokens = (snapshot.planner_decisions || []).reduce((sum, item) => sum + tokenUsage(item), 0);
  const signatureCounts: Record<string, number> = {};
  for (const item of plannerDecisions) if (item.decision_signature) signatureCounts[item.decision_signature] = (signatureCounts[item.decision_signature] || 0) + 1;

  const context: AutonomousAgentContext = {
    execution_base_url: snapshot.run.base_url,
    scan: {
      id: snapshot.run.id,
      base_url: snapshot.run.base_url,
      status: snapshot.run.status,
      current_phase: snapshot.run.current_phase,
      user_prompt: snapshot.run.user_prompt,
      scan_config: snapshot.run.scan_config,
    },
    task: {
      id: task.id,
      title: task.title,
      task_type: task.task_type,
      vuln_type: task.vuln_type,
      feature_id: task.feature_id,
      endpoint_ids: task.endpoint_ids,
      status: task.status,
      phase: task.phase,
      agent_goal: task.agent_goal,
      execution_plan: task.execution_plan,
      workflow_execution_plan: task.execution_plan?.workflow_execution_plan,
      precondition_policy: task.execution_plan?.precondition_policy,
      created_assets_json: task.created_assets_json,
    },
    selected_vuln_types: snapshot.run.selected_vuln_types || [],
    available_tools: tools.map(compactTool),
    relevant_endpoints: relevantEndpoints,
    endpoint_inventory_summary: {
      total: snapshot.endpoints.length,
      by_method: endpointSummaryByMethod,
      by_source: endpointSummaryBySource,
      sample: snapshot.endpoints.slice(0, 40).map(compactEndpoint),
    },
    feature_tree: snapshot.features.map(feature => ({
      id: feature.id,
      parent_id: feature.parent_id,
      name: feature.name,
      node_type: feature.node_type,
      confidence: feature.confidence,
      endpoint_ids: feature.endpoint_ids,
      description: feature.description,
    })).slice(0, 80),
    vulnerability_candidates: snapshot.candidates.map(candidate => ({
      id: candidate.id,
      vuln_type: candidate.vuln_type,
      title: candidate.title,
      reason: candidate.reason,
      confidence: candidate.confidence,
      endpoint_ids: candidate.endpoint_ids,
      required_accounts: candidate.required_accounts,
      status: candidate.status,
    })).slice(0, 160),
    task_artifacts: taskArtifacts,
    task_tool_invocations: taskInvocations,
    global_recent_artifacts: globalRecentArtifacts,
    shared_resources: sharedResources.slice(0, 80),
    shared_resource_summary: { total: sharedResources.length, by_type: sharedByType },
    relevant_memories: relevantMemories.map(memory => compactModelEvidence(memory, 4000)),
    memory_summary: { total: (snapshot.agent_memories || []).length, active: (snapshot.agent_memories || []).filter(item => item.status === 'active').length, by_type: memoryByType },
    browser_context_summary: {
      active: browserContexts.length,
      contexts: browserContexts.slice(0, 16).map(item => ({ id: item.id, context_key: item.context_key, scope_type: item.scope_type, identity_key: item.identity_key, current_url: projectModelUrl(item.current_url), last_used_at: item.last_used_at })),
    },
    planner_state: {
      decisions_total: plannerDecisions.length,
      ai_provider_decisions: plannerDecisions.filter(item => item.decision_json?.ai_provider_attempted === true || item.source === 'ai_provider' || Object.keys(item.proposal_json || {}).length > 0).length,
      scan_ai_provider_decisions: (snapshot.planner_decisions || []).filter(item => item.decision_json?.ai_provider_attempted === true || item.source === 'ai_provider' || Object.keys(item.proposal_json || {}).length > 0).length,
      ai_tokens_total: taskAiTokens,
      scan_ai_tokens_total: scanAiTokens,
      rejected: plannerDecisions.filter(item => item.validation_status === 'rejected').length,
      // Rejections are execution-protocol feedback for the next provider turn.
      // Deliberately keep only action metadata and the gate reason: tool inputs
      // may contain private capture values, while hiding the reason makes a
      // model repeat an otherwise correctable malformed decision.
      recent_rejections: plannerDecisions.filter(item => item.validation_status === 'rejected').slice(-3).map(item => ({
        action: item.proposal_json?.action ?? item.decision_json?.action,
        tool_name: item.proposal_json?.tool_name ?? item.decision_json?.tool_name,
        reason: item.rejection_reason,
      })),
      fallbacks: plannerDecisions.filter(item => item.validation_status === 'fallback').length,
      signature_counts: signatureCounts,
      recent_signatures: plannerDecisions.slice(-8).map(item => item.decision_signature).filter(Boolean),
      normal_business_selector_recovery: normalBusinessSelectorRecovery || null,
      normal_capture_inspection_recovery: captureInspectionRecovery || null,
    },
    recent_tasks: snapshot.tasks.slice(-60).map(item => ({
      id: item.id,
      title: item.title,
      task_type: item.task_type,
      vuln_type: item.vuln_type,
      status: item.status,
      phase: item.phase,
      endpoint_ids: item.endpoint_ids,
      result_summary: item.result_summary,
    })),
    business_flows: latestBusinessFlows(snapshot.artifacts).map(compactBusinessFlow),
    operating_rules: [
      'You are the AI penetration-testing driver. Do not assume a fixed script; choose the next tool from the available tools based on evidence and task context.',
      'Use browser/discovery tools to understand the target, feature tools to model functions, vuln tools to create candidates, task tools to expand selected vulnerabilities, and BSTG native tools to execute tests.',
      'Prefer bstg.api_test.run for single-interface vulnerabilities when enough endpoint context exists; prefer bstg.generic_vuln.run_test or bstg.file_upload.run_test when workflow/native evidence and finding generation are required.',
      'Complete a task only after the required tool has produced evidence or after the task is waiting for user vulnerability selection.',
      'When evidence is insufficient, call another tool or create child tasks rather than fabricating a finding.',
      'Use tools to expand reachable functionality, authenticated state, object inventory, payload coverage, and replay evidence.',
      'Execution tools use the current task\'s persisted endpoint_ids and workflow target. Tool arguments cannot replace the target, remove prerequisites, or add endpoints. Omit endpoint arguments to use the stored plan. Newly discovered endpoints require an explicit persisted child task with its own endpoint_ids and workflow plan; do not reuse the current task with a different scope.',
      'Parallel versus serial execution is semantic: only tasks marked parallel_capable may run beside siblings. A task with workflow_execution_plan/precondition_policy must execute its own prerequisite chain serially before the target action.',
      'For post-auth, object-bound, payment, refund, order, passcode, OTP, BOLA/BFLA and business-logic tests, prepend and verify login/session/object-state prerequisites. Do not test a later function without satisfying the earlier workflow state.',
      'Before rebuilding accounts, login workflows, payload plans, object inventories, or session strategies, check shared_resources and reuse existing cross-agent resources whenever they match the current task.',
      'Shared resources are the scan-wide memory bus between parent Agent and sub-agents: identity pools, canonical login/session workflows, session strategies, object inventories, payload plans, and feature attack contexts.',
      'Use relevant_memories before rediscovery. Memory records carry confidence, scope, version, TTL and provenance; reference_only memories intentionally omit secret content.',
      'Reuse an active browser context when the same scan/task/identity needs continuity. Browser storage state is persisted for restart recovery; passive page resources are allowed so real applications render normally.',
      'Planner autonomy is discovery-first: prefer next actions that find more endpoints, states, object IDs, and mutation opportunities; record replay gaps instead of suppressing discoveries.',
      'Normal business learning is a separate persisted stage. Define every observed business goal, capture its actual browser actions, inspect ordered request/response structure, choose evidenced mappings and semantic assertions, and validate a new native Test Run before experimenting on that flow.',
      'For a native normal validation, select left.path only from the same Workflow step\'s assertion_paths: status, headers.<observed-header>, or body.<observed-json-field>. A bare body path, page HTML, or arbitrary text is never an executable semantic assertion; at least one goal/identity/state assertion must use an observed body field.',
      'For an observed sign-in flow, role remains the exact intended scan identity, but start the capture with scope_type "task" so it begins unauthenticated; navigate that fresh context and use bstg.identity.apply_login. This server-side capability uses only prepared credentials and returns authentication facts, never credential or session values. Do not treat a discovery-authenticated identity context as evidence of the login transition.',
      'A business flow is verified only when its stored assertions_verified is true and a normal_run_id references real native execution. A successful HTTP response, captured requests, or your completion sentence cannot replace this evidence.',
      'Failed normal validation is feedback: inspect its assertion outcomes and learning candidates, repair the flow or create an explicit repair child task. Do not fabricate verified state or dispatch dependent mutations from an unverified baseline.',
      'A verified business flow releases its own model experiment even if another normal flow is blocked. For each model_business_experiment, inspect native structure and let the model choose exact steps, patches, bindings, identity changes, sequence/replay/concurrency and semantic assertions; compile and execute the resulting native control and experiment Test Runs before assessment.',
      'An experiment may establish a secure counterexample or an inconclusive result. Record that fact and revise when the evidence gap is actionable; never promote a vulnerable verdict unless native control, execution and business-impact proofs all pass.',
      'If a browser interaction reports action_or_after, treat the write as potentially dispatched: do not repeat it blindly. Navigate or observe authoritative state before deciding whether another action is needed.',
      'Private capture, native traces and credentials remain in server-side sources. Use inspection tools and private value references rather than asking for raw trace or copying secret values into plans.',
    ],
  };
  const redacted = redactKnownSecrets(modelFacingEvidence(context), privateSecretValues(snapshot)) as AutonomousAgentContext;
  // A private recording can legitimately contain the initial target URL. It
  // must redact arbitrary echoed URLs and values, but cannot overwrite the
  // server's own execution target: local lifecycle policy needs the full URL
  // to open a fresh task capture. The provider boundary below re-projects
  // scan.base_url and excludes execution_base_url entirely.
  redacted.execution_base_url = snapshot.run.base_url;
  if (redacted.scan && context.scan?.base_url) redacted.scan.base_url = context.scan.base_url;
  Object.defineProperty(redacted, 'lifecycle_planner_decisions', {
    value: plannerDecisions,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(redacted, 'lifecycle_tool_invocations', {
    value: lifecycleTaskInvocations,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return redacted;
}
