import type { AgentToolSpec } from './tool-types.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { AIScanTask } from '../services/ai-scan/types.js';
import { retrieveRelevantAgentMemories } from '../services/ai-scan/agent-memory.js';
import { sanitizeForAIModel } from './model-context-sanitizer.js';

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
    content_json: artifact.content_json,
    content_text: artifact.content_text ? String(artifact.content_text).slice(0, 1000) : undefined,
  };
}

function compactSharedResource(resource: any): Record<string, any> {
  return {
    id: resource.id,
    type: resource.resource_type,
    key: resource.resource_key,
    title: resource.title,
    usage_count: resource.usage_count,
    content_json: sanitizeForAIModel(resource.content_json),
    updated_at: resource.updated_at,
  };
}

function compactInvocation(invocation: any): Record<string, any> {
  return {
    id: invocation.id,
    tool_name: invocation.tool_name,
    status: invocation.status,
    input_json: invocation.input_json,
    output_summary: invocation.output_json?.summary || invocation.output_json?.message || undefined,
    output_json: invocation.output_json,
    error_message: invocation.error_message,
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

  return {
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
    relevant_memories: relevantMemories,
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
    operating_rules: [
      'You are the AI penetration-testing driver. Do not assume a fixed script; choose the next tool from the available tools based on evidence and task context.',
      'Use browser/discovery tools to understand the target, feature tools to model functions, vuln tools to create candidates, task tools to expand selected vulnerabilities, and BSTG native tools to execute tests.',
      'Prefer bstg.api_test.run for single-interface vulnerabilities when enough endpoint context exists; prefer bstg.generic_vuln.run_test or bstg.file_upload.run_test when workflow/native evidence and finding generation are required.',
      'Complete a task only after the required tool has produced evidence or after the task is waiting for user vulnerability selection.',
      'When evidence is insufficient, call another tool or create child tasks rather than fabricating a finding.',
      'Use tools to expand reachable functionality, authenticated state, object inventory, payload coverage, and replay evidence.',
      'Parallel versus serial execution is semantic: only tasks marked parallel_capable may run beside siblings. A task with workflow_execution_plan/precondition_policy must execute its own prerequisite chain serially before the target action.',
      'For post-auth, object-bound, payment, refund, order, passcode, OTP, BOLA/BFLA and business-logic tests, prepend and verify login/session/object-state prerequisites. Do not test a later function without satisfying the earlier workflow state.',
      'Before rebuilding accounts, login workflows, payload plans, object inventories, or session strategies, check shared_resources and reuse existing cross-agent resources whenever they match the current task.',
      'Shared resources are the scan-wide memory bus between parent Agent and sub-agents: identity pools, canonical login/session workflows, session strategies, object inventories, payload plans, and feature attack contexts.',
      'Use relevant_memories before rediscovery. Memory records carry confidence, scope, version, TTL and provenance; reference_only memories intentionally omit secret content.',
      'Reuse an active browser context when the same scan/task/identity needs continuity. Browser storage state is persisted for restart recovery; passive page resources are allowed so real applications render normally.',
      'Planner autonomy is discovery-first: prefer next actions that find more endpoints, states, object IDs, and mutation opportunities; record replay gaps instead of suppressing discoveries.',
    ],
  };
}
