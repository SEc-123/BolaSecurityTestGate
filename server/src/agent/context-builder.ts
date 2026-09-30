import { compactModelEvidence } from './model-evidence-context.js';
import type { AgentToolSpec } from './tool-types.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { AIScanTask } from '../services/ai-scan/types.js';
import { retrieveRelevantAgentMemories } from '../services/ai-scan/agent-memory.js';
import { sanitizeForAIModel } from './model-context-sanitizer.js';
import { latestBusinessFlows } from './business-task-lifecycle.js';

const privateContainers = /^(?:raw_request|raw_response|request_body_text|response_body_text|request_body_base64|response_body_base64|request_snapshot_raw|snapshot_request_raw|trace|debug_trace|native_trace|captured_request)$/i;
const secretField = /password|passwd|^pwd$|secret|authorization|cookie|(?:^|_)token(?:$|_)|csrf|xsrf|ticket|otp|passcode|session_id|verification_code|^_g$/i;

function compactBusinessAssertion(assertion: any): Record<string, any> {
  return {
    id: assertion?.id, step_order: assertion?.step_order, description: assertion?.description, purpose: assertion?.purpose,
    left: assertion?.left ? { type: assertion.left.type, path: assertion.left.path } : undefined, op: assertion?.op,
    right: assertion?.right ? {
      type: assertion.right.type,
      key: assertion.right.type === 'literal' ? undefined : assertion.right.key,
      value_present: assertion.right.type === 'literal' && assertion.right.value !== undefined,
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
    if (/^(?:flow_id|workflow_id|source_workflow_id|recording_session_id|test_run_id|event_id|action_id|step_id|template_id|plan_id|id|fromPath|toPath|from_path|to_path|sourcePath|sourceLocation|fromLocation|toLocation|variableName|variable_name|targetVariableName|predictedType|data_source|writePolicySuggestion|transformHint|path|method|status|purpose|op|type|role|name|reason|origin|description|summary)$/i.test(key)) return value.slice(0, 500);
    return { type: 'string', length: value.length, omitted: true };
  }
  if (Array.isArray(value)) return value.slice(0, 120).map(item => compactBusinessInvocationValue(item, key, depth + 1));
  if (typeof value === 'object') {
    if (key === 'right') return { type: value.type, key: value.type === 'literal' ? undefined : value.key, value_present: value.type === 'literal' && value.value !== undefined };
    return Object.fromEntries(Object.entries(value).slice(0, 120).map(([name, item]) => [name, compactBusinessInvocationValue(item, name, depth + 1)]));
  }
  return '[business value omitted]';
}

function compactBusinessFlow(flow: any): Record<string, any> {
  return {
    id: flow.id, revision: flow.revision, name: flow.name, goal: flow.goal, role: flow.role, status: flow.status,
    feature_id: flow.feature_id, feature_name: flow.feature_name, prerequisites: flow.prerequisites, blockers: flow.blockers,
    steps: (flow.steps || []).map((step: any) => ({ id: step.id, description: step.description, step_order: step.step_order, endpoint_id: step.endpoint_id, event_id: step.event_id })),
    assertions: (flow.assertions || []).map(compactBusinessAssertion), workflow_id: flow.workflow_id, normal_run_id: flow.normal_run_id,
    assertions_verified: flow.assertions_verified === true, evidence_artifact_ids: flow.evidence_artifact_ids,
  };
}

/** Private sources stay in the canonical recorder/native evidence. Tool outputs
 * may retain safe field structure and business outcomes for model adaptation. */
export function modelFacingEvidence(value: any, depth = 0): any {
  if (depth > 24) return '[nested evidence omitted]';
  if (value === null || typeof value !== 'object') return sanitizeForAIModel(value);
  if (Array.isArray(value)) return value.map(item => modelFacingEvidence(item, depth + 1));
  if (value.private === true) return Object.fromEntries(['flow_id', 'workflow_id', 'source_workflow_id', 'recording_session_id',
    'test_run_id', 'id', 'status', 'summary'].filter(key => value[key] !== undefined).map(key => [key, modelFacingEvidence(value[key], depth + 1)])
    .concat([['private_evidence', 'Inspect using the registered business tools; raw sources are retained privately.']]));
  const fieldIsSecret = secretField.test(String(value.name || value.field_name || ''));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    privateContainers.test(key) ? '[Private evidence retained in the originating record]' :
      secretField.test(key) || (fieldIsSecret && ['value', 'original_value', 'current_value', 'valuePreview'].includes(key))
        ? '[REDACTED]' : modelFacingEvidence(item, depth + 1)]));
}

function privateSecretValues(snapshot: any): string[] {
  const values = new Set<string>();
  const inspect = (value: any, key = '', depth = 0): void => {
    if (depth > 24 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      if (secretField.test(key) && value.length >= 4) values.add(value);
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
    ['business_capture_event', 'business_native_trace', 'captured_request'].includes(artifact.artifact_type)) inspect(artifact.content_json);
  return [...values].sort((a, b) => b.length - a.length);
}

function redactKnownSecrets(value: any, secrets: string[]): any {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value);
  if (Array.isArray(value)) return value.map(item => redactKnownSecrets(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownSecrets(item, secrets)]));
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
    path: endpoint.path,
    url: endpoint.url,
    content_type: endpoint.content_type,
    feature_guess: endpoint.feature_guess,
    request_summary: endpoint.request_summary,
    response_summary: endpoint.response_summary,
  };
}

function compactArtifact(artifact: any): Record<string, any> {
  return {
    id: artifact.id,
    type: artifact.artifact_type,
    title: artifact.title,
    source_ref: artifact.source_ref,
    created_at: artifact.created_at,
    content_json: compactModelEvidence(modelFacingEvidence(artifact.content_json), 8000),
    content_text: artifact.content_json?.private === true || ['business_capture_event', 'business_native_trace', 'captured_request'].includes(artifact.artifact_type)
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

function compactInvocation(invocation: any): Record<string, any> {
  const businessTool = /^(?:bstg\.business\.|bstg\.workflow\.|bstg\.native\.|bstg\.test_plan\.)/.test(String(invocation.tool_name || ''));
  return {
    id: invocation.id,
    tool_name: invocation.tool_name,
    status: invocation.status,
    input_json: compactModelEvidence(businessTool ? compactBusinessInvocationValue(invocation.input_json) : modelFacingEvidence(invocation.input_json), 2000),
    output_summary: invocation.output_json?.summary || invocation.output_json?.message || undefined,
    output_json: compactModelEvidence(businessTool ? compactBusinessInvocationValue(invocation.output_json) : modelFacingEvidence(invocation.output_json), 12000),
    error_message: businessTool ? (invocation.error_message ? 'Business tool reported a private diagnostic.' : undefined) : invocation.error_message,
    created_at: invocation.created_at,
  };
}

export interface AutonomousAgentContext {
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
  const taskInvocations = snapshot.tool_invocations
    .filter(invocation => invocation.task_id === task.id)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-30)
    .map(compactInvocation);
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
  const tokenUsage = (item: any) => Number(item.decision_json?.ai_usage?.total_tokens || 0);
  const taskAiTokens = plannerDecisions.reduce((sum, item) => sum + tokenUsage(item), 0);
  const scanAiTokens = (snapshot.planner_decisions || []).reduce((sum, item) => sum + tokenUsage(item), 0);
  const signatureCounts: Record<string, number> = {};
  for (const item of plannerDecisions) if (item.decision_signature) signatureCounts[item.decision_signature] = (signatureCounts[item.decision_signature] || 0) + 1;

  const context: AutonomousAgentContext = {
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
      contexts: browserContexts.slice(0, 16).map(item => ({ id: item.id, context_key: item.context_key, scope_type: item.scope_type, identity_key: item.identity_key, current_url: item.current_url, last_used_at: item.last_used_at })),
    },
    planner_state: {
      decisions_total: plannerDecisions.length,
      ai_provider_decisions: plannerDecisions.filter(item => item.decision_json?.ai_provider_attempted === true || item.source === 'ai_provider' || Object.keys(item.proposal_json || {}).length > 0).length,
      scan_ai_provider_decisions: (snapshot.planner_decisions || []).filter(item => item.decision_json?.ai_provider_attempted === true || item.source === 'ai_provider' || Object.keys(item.proposal_json || {}).length > 0).length,
      ai_tokens_total: taskAiTokens,
      scan_ai_tokens_total: scanAiTokens,
      rejected: plannerDecisions.filter(item => item.validation_status === 'rejected').length,
      fallbacks: plannerDecisions.filter(item => item.validation_status === 'fallback').length,
      signature_counts: signatureCounts,
      recent_signatures: plannerDecisions.slice(-8).map(item => item.decision_signature).filter(Boolean),
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
      'A business flow is verified only when its stored assertions_verified is true and a normal_run_id references real native execution. A successful HTTP response, captured requests, or your completion sentence cannot replace this evidence.',
      'Failed normal validation is feedback: inspect its assertion outcomes and learning candidates, repair the flow or create an explicit repair child task. Do not fabricate verified state or dispatch dependent mutations from an unverified baseline.',
      'A verified business flow releases its own model experiment even if another normal flow is blocked. For each model_business_experiment, inspect native structure and let the model choose exact steps, patches, bindings, identity changes, sequence/replay/concurrency and semantic assertions; compile and execute the resulting native control and experiment Test Runs before assessment.',
      'An experiment may establish a secure counterexample or an inconclusive result. Record that fact and revise when the evidence gap is actionable; never promote a vulnerable verdict unless native control, execution and business-impact proofs all pass.',
      'If a browser interaction reports action_or_after, treat the write as potentially dispatched: do not repeat it blindly. Navigate or observe authoritative state before deciding whether another action is needed.',
      'Private capture, native traces and credentials remain in server-side sources. Use inspection tools and private value references rather than asking for raw trace or copying secret values into plans.',
    ],
  };
  return redactKnownSecrets(modelFacingEvidence(context), privateSecretValues(snapshot));
}
