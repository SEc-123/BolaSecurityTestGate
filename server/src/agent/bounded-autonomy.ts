import type { AutonomousAgentContext } from './context-builder.js';
import type { AutonomousPlannerResult } from './decision-types.js';

export type PlannerAutonomyMode = 'local_only' | 'bounded_ai';

export interface PlannerAutonomyConfig {
  mode: PlannerAutonomyMode;
  max_ai_calls_per_task: number;
  max_ai_calls_per_scan: number;
  max_ai_tokens_per_task: number;
  max_ai_tokens_per_scan: number;
  max_steps_per_task: number;
  max_repeated_decisions: number;
  max_supporting_tool_calls_before_mandatory: number;
  max_child_tasks_per_decision: number;
}

export interface PlannerValidationResult {
  decision: AutonomousPlannerResult;
  validation_status: 'accepted' | 'rejected' | 'fallback' | 'local_only';
  rejection_reason?: string;
  proposal?: AutonomousPlannerResult;
  policy_decision: AutonomousPlannerResult;
  decision_signature: string;
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function normalizePlannerAutonomyConfig(scanConfig: Record<string, any> | undefined): PlannerAutonomyConfig {
  const raw = scanConfig?.planner_autonomy && typeof scanConfig.planner_autonomy === 'object' ? scanConfig.planner_autonomy : {};
  return {
    mode: raw.mode === 'bounded_ai' ? 'bounded_ai' : 'local_only',
    max_ai_calls_per_task: boundedInt(raw.max_ai_calls_per_task, 8, 1, 40),
    max_ai_calls_per_scan: boundedInt(raw.max_ai_calls_per_scan, 120, 1, 2000),
    max_ai_tokens_per_task: boundedInt(raw.max_ai_tokens_per_task, 24000, 1000, 1000000),
    max_ai_tokens_per_scan: boundedInt(raw.max_ai_tokens_per_scan, 300000, 5000, 5000000),
    max_steps_per_task: boundedInt(raw.max_steps_per_task, 20, 2, 60),
    max_repeated_decisions: boundedInt(raw.max_repeated_decisions, 2, 1, 8),
    max_supporting_tool_calls_before_mandatory: boundedInt(raw.max_supporting_tool_calls_before_mandatory, 2, 0, 8),
    max_child_tasks_per_decision: boundedInt(raw.max_child_tasks_per_decision, 6, 1, 20),
  };
}

function stable(value: any): any {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
}

export function decisionSignature(decision: AutonomousPlannerResult): string {
  const payload = {
    action: decision.action,
    tool_name: decision.tool_name || '',
    arguments: stable(decision.arguments || {}),
    tasks: Array.isArray(decision.tasks) ? decision.tasks.map(item => ({ title: item.title, task_type: item.task_type, vuln_type: item.vuln_type, endpoint_ids: item.endpoint_ids || [] })) : [],
  };
  return JSON.stringify(payload).slice(0, 4000);
}

function stageAllowedTools(context: AutonomousAgentContext, mandatory: AutonomousPlannerResult): Set<string> {
  const intent = String(context.task.execution_plan?.intent || '');
  const vulnType = String(context.task.vuln_type || context.task.execution_plan?.vuln_type || '');
  const tools = new Set<string>(['agent.memory.query', 'agent.memory.remember']);
  if (intent === 'inventory_bstg_capabilities') tools.add('bstg.capabilities.inventory');
  else if (intent === 'discover_target') {
    tools.add('browser.navigate');
    tools.add('browser.discover_target');
    tools.add('bstg.identity.bootstrap_accounts');
  } else if (intent === 'model_features_and_candidates') {
    tools.add('feature.extract_tree');
    tools.add('vuln.generate_candidates');
    tools.add('agent.shared_context.prepare');
    tools.add('task.expand_selected_vulnerabilities');
  } else if (intent === 'expand_selected_vulnerabilities') {
    tools.add('task.expand_selected_vulnerabilities');
  } else if (intent === 'summarize_vulnerability_campaign') {
    tools.add('task.summarize_vulnerability_campaign');
  } else if (vulnType || String(context.task.task_type || '').startsWith('test_')) {
    tools.add('bstg.payload.plan');
    tools.add('browser.navigate');
    tools.add('agent.shared_context.prepare');
    tools.add('bstg.learning.repair_workflow');
    tools.add('bstg.api_test.run');
    tools.add('bstg.generic_vuln.run_test');
    if (vulnType === 'file_upload') tools.add('bstg.file_upload.run_test');
  } else {
    for (const tool of context.available_tools || []) if (tool?.name) tools.add(String(tool.name));
  }
  if (mandatory.tool_name) tools.add(mandatory.tool_name);
  return tools;
}

function supportingCallsSinceMandatory(context: AutonomousAgentContext, mandatoryTool?: string): number {
  if (!mandatoryTool) return 0;
  let count = 0;
  for (let index = context.task_tool_invocations.length - 1; index >= 0; index -= 1) {
    const invocation = context.task_tool_invocations[index];
    if (invocation.tool_name === mandatoryTool && invocation.status === 'completed') break;
    if (invocation.status === 'completed') count += 1;
  }
  return count;
}

export function validatePlannerProposal(input: {
  context: AutonomousAgentContext;
  proposal: AutonomousPlannerResult;
  policyDecision: AutonomousPlannerResult;
  config: PlannerAutonomyConfig;
}): PlannerValidationResult {
  const { context, proposal, policyDecision, config } = input;
  const fallback = (reason: string): PlannerValidationResult => ({
    decision: { ...policyDecision, source: 'fallback', reason: reason || policyDecision.reason },
    validation_status: 'rejected',
    rejection_reason: reason,
    proposal,
    policy_decision: policyDecision,
    decision_signature: decisionSignature(proposal),
  });

  const taskAiCalls = Number(context.planner_state?.ai_provider_decisions || 0);
  const scanAiCalls = Number(context.planner_state?.scan_ai_provider_decisions || 0);
  const taskAiTokens = Number(context.planner_state?.ai_tokens_total || 0);
  const scanAiTokens = Number(context.planner_state?.scan_ai_tokens_total || 0);
  if (taskAiCalls >= config.max_ai_calls_per_task) return fallback(`AI planner task call budget reached (${config.max_ai_calls_per_task})`);
  if (scanAiCalls >= config.max_ai_calls_per_scan) return fallback(`AI planner scan call budget reached (${config.max_ai_calls_per_scan})`);
  if (taskAiTokens >= config.max_ai_tokens_per_task) return fallback(`AI planner task token budget reached (${config.max_ai_tokens_per_task})`);
  if (scanAiTokens >= config.max_ai_tokens_per_scan) return fallback(`AI planner scan token budget reached (${config.max_ai_tokens_per_scan})`);

  const signature = decisionSignature(proposal);
  const repeated = Number(context.planner_state?.signature_counts?.[signature] || 0);
  if (repeated >= config.max_repeated_decisions) return fallback(`Planner loop detected: decision signature repeated ${repeated} time(s)`);

  if (proposal.action === 'tool_call') {
    if (!proposal.tool_name) return fallback('AI proposal is missing tool_name');
    const knownTools = new Set((context.available_tools || []).map(tool => String(tool.name || '')));
    if (!knownTools.has(proposal.tool_name)) return fallback(`AI proposed unknown tool ${proposal.tool_name}`);
    const allowed = stageAllowedTools(context, policyDecision);
    if (!allowed.has(proposal.tool_name)) return fallback(`Tool ${proposal.tool_name} is outside the bounded autonomy stage allowlist`);
    if (policyDecision.action === 'tool_call' && policyDecision.tool_name && proposal.tool_name !== policyDecision.tool_name) {
      const supportingCalls = supportingCallsSinceMandatory(context, policyDecision.tool_name);
      if (supportingCalls >= config.max_supporting_tool_calls_before_mandatory) {
        return fallback(`Mandatory policy tool ${policyDecision.tool_name} cannot be deferred after ${supportingCalls} supporting call(s)`);
      }
    }
    return {
      decision: { ...proposal, source: 'ai_provider' },
      validation_status: 'accepted',
      proposal,
      policy_decision: policyDecision,
      decision_signature: signature,
    };
  }

  if (proposal.action === 'create_child_tasks') {
    if (policyDecision.action === 'tool_call') return fallback(`Mandatory policy tool ${policyDecision.tool_name} must execute before child task creation`);
    const tasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
    if (tasks.length === 0) return fallback('AI proposed create_child_tasks with no tasks');
    if (tasks.length > config.max_child_tasks_per_decision) return fallback(`AI proposed ${tasks.length} child tasks; limit is ${config.max_child_tasks_per_decision}`);
    return { decision: { ...proposal, tasks: tasks.slice(0, config.max_child_tasks_per_decision), source: 'ai_provider' }, validation_status: 'accepted', proposal, policy_decision: policyDecision, decision_signature: signature };
  }

  // Completion and waiting are only valid when the deterministic policy says the stage is ready.
  if (proposal.action === 'complete_task' && policyDecision.action !== 'complete_task') return fallback(`AI cannot complete task while deterministic policy requires ${policyDecision.action}${policyDecision.tool_name ? `:${policyDecision.tool_name}` : ''}`);
  if (proposal.action === 'wait_for_user_selection' && policyDecision.action !== 'wait_for_user_selection') return fallback('AI cannot wait for selection before deterministic modeling prerequisites complete');
  if (proposal.action === 'fail_task' && policyDecision.action === 'tool_call') return fallback(`AI cannot fail task before mandatory tool ${policyDecision.tool_name} is attempted`);

  return { decision: { ...proposal, source: 'ai_provider' }, validation_status: 'accepted', proposal, policy_decision: policyDecision, decision_signature: signature };
}
