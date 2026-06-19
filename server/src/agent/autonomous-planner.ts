import { dbGet } from '../db/sql-helpers.js';
import type { DbProvider } from '../types/index.js';
import { AIClient } from '../services/ai/ai-client.js';
import type { AIProvider } from '../services/ai/types.js';
import type { AutonomousAgentContext } from './context-builder.js';
import type { AutonomousPlannerResult } from './decision-types.js';
import { AUTONOMOUS_DECISION_SCHEMA } from './decision-types.js';

function normalizeBool(value: any): boolean {
  return value === true || value === 1 || value === '1';
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  if (!row) return null;
  return { ...row, is_enabled: normalizeBool(row.is_enabled), is_default: normalizeBool(row.is_default) } as AIProvider;
}

function safeJsonParse(text: string): any | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
  }
  return null;
}

function invoked(context: AutonomousAgentContext, toolName: string): boolean {
  return context.task_tool_invocations.some(inv => inv.tool_name === toolName && inv.status === 'completed');
}

function latestInvocation(context: AutonomousAgentContext): any | undefined {
  return context.task_tool_invocations[context.task_tool_invocations.length - 1];
}

function endpointId(context: AutonomousAgentContext, vulnType = ''): string | undefined {
  const plannedTarget = context.task.execution_plan?.workflow_execution_plan?.target_endpoint_id;
  if (plannedTarget) return String(plannedTarget);
  const relevant = context.relevant_endpoints || [];
  const find = (re: RegExp, method?: string) => relevant.find(endpoint => re.test(String(endpoint.path || endpoint.url || '')) && (!method || String(endpoint.method).toUpperCase() === method));
  if (vulnType === 'business_logic') return (find(/cart|quantity/i, 'GET') || find(/cart|quantity|order|amount|payment|withdraw|transfer/i))?.id || relevant[relevant.length - 1]?.id;
  if (vulnType === 'bfla') return (find(/admin\/users|admin|manage|role/i) || relevant[relevant.length - 1])?.id;
  if (vulnType === 'bola_idor') return (find(/order|historyorders|withdraw|transfer|wallet|user/i) || relevant[relevant.length - 1])?.id;
  const ids = Array.isArray(context.task.endpoint_ids) ? context.task.endpoint_ids : [];
  return ids[ids.length - 1] || relevant[relevant.length - 1]?.id || context.endpoint_inventory_summary.sample?.[0]?.id;
}

function normalizeDecision(input: any): AutonomousPlannerResult | null {
  if (!input || typeof input !== 'object') return null;
  const action = String(input.action || '').trim();
  if (!['tool_call', 'complete_task', 'fail_task', 'wait_for_user_selection', 'create_child_tasks'].includes(action)) return null;
  const decision: AutonomousPlannerResult = {
    action: action as any,
    tool_name: input.tool_name ? String(input.tool_name) : undefined,
    arguments: input.arguments && typeof input.arguments === 'object' ? input.arguments : {},
    tasks: Array.isArray(input.tasks) ? input.tasks : undefined,
    summary: input.summary ? String(input.summary) : undefined,
    reason: input.reason ? String(input.reason) : undefined,
    rationale: input.rationale ? String(input.rationale) : undefined,
    confidence: Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : undefined,
    stop_after_tool_call: Boolean(input.stop_after_tool_call),
  };
  if (decision.action === 'tool_call' && !decision.tool_name) return null;
  return decision;
}

function shouldCompleteAfterLastTool(context: AutonomousAgentContext): boolean {
  const last = latestInvocation(context);
  if (!last || last.status !== 'completed') return false;
  return [
    'bstg.capabilities.inventory',
    'browser.discover_target',
    'vuln.generate_candidates',
    'agent.shared_context.prepare',
    'task.expand_selected_vulnerabilities',
    'task.summarize_vulnerability_campaign',
    'bstg.file_upload.run_test',
    'bstg.generic_vuln.run_test',
  ].includes(last.tool_name);
}

function localPolicy(context: AutonomousAgentContext): AutonomousPlannerResult {
  const taskType = String(context.task.task_type || '');
  const hasExplicitVulnType = Boolean(context.task.vuln_type || context.task.execution_plan?.vuln_type);
  const vulnType = String(context.task.vuln_type || context.task.execution_plan?.vuln_type || '');
  const selected = Array.isArray(context.selected_vuln_types) ? context.selected_vuln_types : [];
  const last = latestInvocation(context);
  const isModelingTask = context.task.execution_plan?.intent === 'model_features_and_candidates' || /candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title);
  if (shouldCompleteAfterLastTool(context)) {
    if (last?.tool_name === 'vuln.generate_candidates' && isModelingTask && !invoked(context, 'agent.shared_context.prepare')) {
      // Continue to shared context preparation before waiting/completing.
    } else if (last?.tool_name === 'agent.shared_context.prepare' && isModelingTask && selected.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities')) {
      // Continue to selected vulnerability expansion when scan creation already included selected_vuln_types.
    } else if (last?.tool_name === 'bstg.capabilities.inventory' && context.task.execution_plan?.intent !== 'inventory_bstg_capabilities') {
      // Capability inventory is a reusable background capability; executable sub-agents must still run their actual test tool.
    } else {
    if ((taskType === 'generate_candidates' || context.task.execution_plan?.intent === 'model_features_and_candidates') && selected.length === 0 && context.vulnerability_candidates.length > 0 && invoked(context, 'agent.shared_context.prepare') && !invoked(context, 'task.expand_selected_vulnerabilities')) {
      return { action: 'wait_for_user_selection', summary: 'Feature tree and vulnerability candidates are ready; waiting for selected vulnerability types.', source: 'local_policy' };
    }
    return { action: 'complete_task', summary: last?.output_summary || `${last?.tool_name || 'tool'} completed.`, source: 'local_policy' };
    }
  }

  if ((context.task.execution_plan?.intent === 'inventory_bstg_capabilities' || /inventory|capabilit/i.test(taskType + ' ' + context.task.title)) && !invoked(context, 'bstg.capabilities.inventory')) {
    return { action: 'tool_call', tool_name: 'bstg.capabilities.inventory', arguments: {}, rationale: 'First load native BSTG capabilities as controllable Agent tools.', source: 'local_policy' };
  }
  if ((context.task.execution_plan?.intent === 'discover_target') || (/discover|understand|目标|发现/i.test(taskType + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title))) {
    if (!invoked(context, 'browser.navigate')) {
      return { action: 'tool_call', tool_name: 'browser.navigate', arguments: { url: context.scan.base_url, timeout_ms: context.scan.scan_config?.timeout_ms || 45000 }, rationale: 'Navigate target and capture browser state before endpoint discovery.', source: 'local_policy' };
    }
    if (!invoked(context, 'browser.discover_target')) {
      return { action: 'tool_call', tool_name: 'browser.discover_target', arguments: { max_pages: context.scan.scan_config?.max_pages || 1000 }, rationale: 'Discover endpoints, forms, upload controls, and page observations.', source: 'local_policy' };
    }
  }
  if (context.task.execution_plan?.intent === 'expand_selected_vulnerabilities') {
    const selectedForExpansion = Array.isArray(context.task.execution_plan?.selected_vuln_types) && context.task.execution_plan.selected_vuln_types.length ? context.task.execution_plan.selected_vuln_types : selected;
    if (!invoked(context, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selectedForExpansion }, rationale: 'Expand selected vulnerability types into persistent executable tasks.', source: 'local_policy' };
    return { action: 'complete_task', summary: `Expanded selected vulnerability types: ${selectedForExpansion.join(', ')}`, source: 'local_policy' };
  }

  if (isModelingTask) {
    if (!invoked(context, 'feature.extract_tree')) return { action: 'tool_call', tool_name: 'feature.extract_tree', arguments: {}, rationale: 'Build feature/sub-feature tree before vulnerability inference.', source: 'local_policy' };
    if (!invoked(context, 'vuln.generate_candidates')) return { action: 'tool_call', tool_name: 'vuln.generate_candidates', arguments: {}, rationale: 'Generate vulnerability candidates from feature and endpoint model.', source: 'local_policy' };
    if (!invoked(context, 'agent.shared_context.prepare')) return { action: 'tool_call', tool_name: 'agent.shared_context.prepare', arguments: { selected_vuln_types: selected }, rationale: 'Prepare reusable cross-agent shared context before selection/expansion.', source: 'local_policy' };
    if (selected.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selected }, rationale: 'Selected vulnerability categories exist; expand them into persistent executable tasks.', source: 'local_policy' };
    return { action: 'wait_for_user_selection', summary: 'Candidates generated; waiting for user-selected vulnerability categories.', source: 'local_policy' };
  }
  if (context.task.execution_plan?.intent === 'summarize_vulnerability_campaign' || taskType === 'summarize_vulnerability_campaign') {
    const summaryVulnType = vulnType || 'generic';
    if (!invoked(context, 'task.summarize_vulnerability_campaign')) return { action: 'tool_call', tool_name: 'task.summarize_vulnerability_campaign', arguments: { campaign_task_id: context.task.execution_plan?.campaign_task_id, child_task_ids: context.task.execution_plan?.child_task_ids || [], vuln_type: summaryVulnType }, rationale: 'All child sub-agent tasks for this vulnerability campaign have completed; summarize campaign evidence and residual gaps.', source: 'local_policy' };
    return { action: 'complete_task', summary: `${summaryVulnType} campaign summarized.`, source: 'local_policy' };
  }
  if (taskType === 'test_file_upload' || vulnType === 'file_upload') {
    return { action: 'tool_call', tool_name: 'bstg.file_upload.run_test', arguments: { endpoint_id: endpointId(context, vulnType), endpoint_ids: context.task.endpoint_ids || [] }, rationale: 'File upload requires normal upload, mutation upload, post-upload access, and native workflow/API evidence.', source: 'local_policy' };
  }
  if (taskType.startsWith('test_') || hasExplicitVulnType) {
    const simpleApiTypes = new Set(['xss', 'command_injection', 'file_download', 'path_traversal']);
    if (simpleApiTypes.has(vulnType) && !invoked(context, 'bstg.api_test.run')) {
      return { action: 'tool_call', tool_name: 'bstg.api_test.run', arguments: { endpoint_id: endpointId(context, vulnType), vuln_type: vulnType }, rationale: 'This vulnerability is single-interface suitable; execute native API test-run mode first.', source: 'local_policy' };
    }
    return { action: 'tool_call', tool_name: 'bstg.generic_vuln.run_test', arguments: { endpoint_id: endpointId(context, vulnType), endpoint_ids: context.task.endpoint_ids || [] }, rationale: 'Run native BSTG vulnerability task with workflow/API evidence and finding gate.', source: 'local_policy' };
  }
  return { action: 'complete_task', summary: 'No additional action needed for this task.', source: 'local_policy' };
}

function isStageGuardedTask(context: AutonomousAgentContext): boolean {
  const taskType = String(context.task.task_type || '');
  const title = String(context.task.title || '');
  const intent = String(context.task.execution_plan?.intent || '');
  const hasExplicitVulnType = Boolean(context.task.vuln_type || context.task.execution_plan?.vuln_type);
  const guardedIntents = new Set([
    'inventory_bstg_capabilities',
    'discover_target',
    'model_features_and_candidates',
    'expand_selected_vulnerabilities',
    'summarize_vulnerability_campaign',
  ]);

  if (guardedIntents.has(intent)) {
    return true;
  }

  if (taskType.startsWith('test_') || hasExplicitVulnType) {
    return true;
  }

  if ([
    'bstg.capabilities.inventory',
    'target.discovery',
    'vuln.generate_candidates',
    'vuln.expand_targets',
    'summarize_vulnerability_campaign',
  ].includes(taskType)) {
    return true;
  }

  return /梳理 BSTG 原生能力|自动理解目标|功能树|漏洞候选|执行总结/i.test(`${taskType} ${title}`);
}

export class AutonomousAgentPlanner {
  constructor(private readonly db: DbProvider) {}

  async decide(context: AutonomousAgentContext): Promise<AutonomousPlannerResult> {
    if (isStageGuardedTask(context)) {
      return localPolicy(context);
    }

    const provider = await getDefaultProvider(this.db).catch(() => null);
    if (!provider) return localPolicy(context);

    const client = new AIClient(provider);
    const system = [
      'You are the autonomous AI penetration-testing driver for BSTG.',
      'You are not a report assistant and not a fixed workflow. You decide the next tool call from the available tool list based on task context and evidence.',
      'Return exactly one JSON object. Do not add prose.',
      'Schema:',
      JSON.stringify(AUTONOMOUS_DECISION_SCHEMA),
      'Decision policy:',
      '- For target discovery, use browser.navigate then browser.discover_target.',
      '- For feature/vulnerability modeling, use feature.extract_tree then vuln.generate_candidates, then agent.shared_context.prepare, then wait for user selection or expand selected vulnerabilities.',
      '- For single-interface vulnerabilities, you may call bstg.api_test.run.',
      '- For file upload, call bstg.file_upload.run_test.',
      '- For complex access-control, business logic, replay/race, OTP/auth flows, call bstg.generic_vuln.run_test with endpoint_ids.',
      '- Complete a task only after the required tool evidence already exists in task_tool_invocations/artifacts.',
      '- You may create_child_tasks when a target feature contains multiple independent attack points. Each child should be executable without relying on sibling tasks.',
      '- Parallel versus serial depends on workflow semantics. If task.execution_plan.parallel_capable is false or workflow_execution_plan contains prerequisites, the current task must execute its internal prerequisite chain before the target action.',
      '- For login-gated, object-bound, order, payment, refund, passcode, OTP, BOLA/BFLA and business logic tasks, treat login/session/object creation/payment state as mandatory preconditions. Never complete a target test from an unauthenticated or missing-object response.',
      '- Reuse shared_resources. Do not rebuild attacker/victim/admin accounts, canonical login/session workflow, payload plans, object inventory, or session strategy when the shared context already contains them.',
      '- If selected_vuln_types is empty after candidate generation, wait_for_user_selection.',
    ].join('\n');
    const userPayload = {
      context,
      required_output: {
        action: 'tool_call | complete_task | fail_task | wait_for_user_selection | create_child_tasks',
        tool_name: 'required only for tool_call',
        arguments: 'object; match selected tool input_schema',
        rationale: 'why this is the next best step',
      },
    };
    try {
      const response = await client.chat({
        model: provider.model,
        temperature: 0.05,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(userPayload) },
        ],
      });
      const content = response.choices?.[0]?.message?.content || '';
      const parsed = safeJsonParse(content);
      const normalized = normalizeDecision(parsed);
      if (!normalized) throw new Error(`AI provider returned invalid decision JSON: ${content.slice(0, 400)}`);
      return { ...normalized, source: 'ai_provider', raw_response: parsed, provider_id: provider.id, model: provider.model };
    } catch (error: any) {
      const fallback = localPolicy(context);
      return { ...fallback, source: 'fallback', reason: `AI provider decision failed: ${error.message || String(error)}` };
    }
  }
}
