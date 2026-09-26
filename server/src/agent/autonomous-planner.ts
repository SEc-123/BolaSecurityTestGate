import { dbGet } from '../db/sql-helpers.js';
import type { DbProvider } from '../types/index.js';
import { AIClient } from '../services/ai/ai-client.js';
import type { AIProvider } from '../services/ai/types.js';
import type { AutonomousAgentContext } from './context-builder.js';
import { sanitizeForAIModel } from './model-context-sanitizer.js';
import { agentEventBus } from '../observability/agent-event-bus.js';
import type { AutonomousPlannerResult } from './decision-types.js';
import { AUTONOMOUS_DECISION_SCHEMA } from './decision-types.js';

function normalizeBool(value: any): boolean {
  return value === true || value === 1 || value === '1';
}

async function getDefaultProvider(db: DbProvider): Promise<AIProvider | null> {
  const row = await dbGet<any>(db, `SELECT * FROM ai_providers WHERE is_enabled = ? ORDER BY is_default DESC, created_at DESC LIMIT 1`, [db.kind === 'sqlite' ? 1 : true]);
  if (row) return { ...row, is_enabled: normalizeBool(row.is_enabled), is_default: normalizeBool(row.is_default) } as AIProvider;

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
    is_default: true,
  } as AIProvider;
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


const ALL_VULN_TYPES = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
];

function isAutopilotContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.driving_mode === 'autopilot' || config.auto_start === true || config.selected_scope_strategy === 'all_vulnerability_types';
}

function isAccountAutoExecutionContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.account_mode === 'manual' || config.account_mode === 'auto_execute' || config.enable_account_auto_execution === true;
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

function isAndroidContext(context: AutonomousAgentContext): boolean {
  const config = context.scan?.scan_config || {};
  return config.surface === 'android' || config.surface_type === 'android' || config.mobile?.platform === 'android' || config.android?.platform === 'android';
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
    'bstg.identity.bootstrap_accounts',
    'mobile.lab.stop',
  ].includes(last.tool_name);
}

export function localPolicy(context: AutonomousAgentContext): AutonomousPlannerResult {
  const taskType = String(context.task.task_type || '');
  const hasExplicitVulnType = Boolean(context.task.vuln_type || context.task.execution_plan?.vuln_type);
  const vulnType = String(context.task.vuln_type || context.task.execution_plan?.vuln_type || '');
  const selected = Array.isArray(context.selected_vuln_types) ? context.selected_vuln_types : [];
  const selectedForPolicy = selected.length > 0 ? selected : (isAutopilotContext(context) ? ALL_VULN_TYPES : []);
  const last = latestInvocation(context);
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
      return { action: 'wait_for_user_selection', summary: 'Feature tree and vulnerability candidates are ready; waiting for selected vulnerability types.', source: 'local_policy' };
    }
    return { action: 'complete_task', summary: last?.output_summary || `${last?.tool_name || 'tool'} completed.`, source: 'local_policy' };
    }
  }

  if ((context.task.execution_plan?.intent === 'inventory_bstg_capabilities' || /inventory|capabilit/i.test(taskType + ' ' + context.task.title)) && !invoked(context, 'bstg.capabilities.inventory')) {
    return { action: 'tool_call', tool_name: 'bstg.capabilities.inventory', arguments: {}, rationale: 'First load native BSTG capabilities as controllable Agent tools.', source: 'local_policy' };
  }
  if ((context.task.execution_plan?.intent === 'discover_target') || (/discover|understand|目标|发现/i.test(taskType + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(taskType + ' ' + context.task.title))) {
    if (isAndroidContext(context)) {
      const mobileCfg = context.scan.scan_config?.mobile || context.scan.scan_config?.android || {};
      if (!invoked(context, 'mobile.lab.prepare')) {
        return { action: 'tool_call', tool_name: 'mobile.lab.prepare', arguments: { profile_id: mobileCfg.lab_profile_id, app_package: mobileCfg.app_package, app_activity: mobileCfg.app_activity, apk_path: mobileCfg.apk_path }, rationale: 'Prepare Android Mobile Lab with preconfigured Burp/proxy/certificate health gate before App automation.', source: 'local_policy' };
      }
      if (!invoked(context, 'mobile.app.install')) {
        return { action: 'tool_call', tool_name: 'mobile.app.install', arguments: { apk_path: mobileCfg.apk_path }, rationale: 'Install authorized APK when supplied, otherwise verify preinstalled App path.', source: 'local_policy' };
      }
      if (mobileCfg.acquisition_mode !== 'explore' && !invoked(context, 'mobile.app.launch')) {
        return { action: 'tool_call', tool_name: 'mobile.app.launch', arguments: { app_package: mobileCfg.app_package, app_activity: mobileCfg.app_activity }, rationale: 'Launch the Android App for UIAutomator/Appium-style observation.', source: 'local_policy' };
      }
      if (mobileCfg.acquisition_mode !== 'explore' && !invoked(context, 'mobile.observe')) {
        return { action: 'tool_call', tool_name: 'mobile.observe', arguments: {}, rationale: 'Capture Android screenshot and UIAutomator hierarchy for the right-side App panel.', source: 'local_policy' };
      }
      const acquisitionTool = mobileCfg.acquisition_mode === 'explore' ? 'mobile.app.explore' : 'mobile.flow.run';
      if (!invoked(context, acquisitionTool)) {
        return { action: 'tool_call', tool_name: acquisitionTool, arguments: mobileCfg.acquisition_mode==='explore'?{}:{ steps: mobileCfg.flow_steps || [] }, rationale: 'Run deterministic Android App flow to create authenticated state and business objects before importing traffic.', source: 'local_policy' };
      }
      if (!invoked(context, 'mobile.capture.import')) {
        return { action: 'tool_call', tool_name: 'mobile.capture.import', arguments: { export_path: mobileCfg.burp_flow_export_path, regenerate: true }, rationale: 'Import decrypted Burp mobile flows into BSTG recording, API templates and workflow drafts.', source: 'local_policy' };
      }
      if (!invoked(context, 'mobile.lab.stop')) return { action: 'tool_call', tool_name: 'mobile.lab.stop', arguments: {}, rationale: 'Release owned Android/proxy resources after persisting the capture.', source: 'local_policy' };
      return { action: 'complete_task', summary: 'Android App discovery flow completed; mobile capture has been imported for feature and vulnerability modeling.', source: 'local_policy' };
    }
    if (!invoked(context, 'browser.navigate')) {
      return { action: 'tool_call', tool_name: 'browser.navigate', arguments: { url: context.scan.base_url, timeout_ms: context.scan.scan_config?.timeout_ms || 45000 }, rationale: 'Navigate target and capture browser state before endpoint discovery.', source: 'local_policy' };
    }
    if (!invoked(context, 'browser.discover_target')) {
      return { action: 'tool_call', tool_name: 'browser.discover_target', arguments: { max_pages: context.scan.scan_config?.max_pages || 1000 }, rationale: 'Discover endpoints, forms, upload controls, and page observations.', source: 'local_policy' };
    }
    if (isAccountAutoExecutionContext(context) && !invoked(context, 'bstg.identity.bootstrap_accounts')) {
      return {
        action: 'tool_call',
        tool_name: 'bstg.identity.bootstrap_accounts',
        arguments: {
          roles: context.scan.scan_config?.auto_account_roles || ['attacker', 'victim', 'admin'],
          max_pages: context.scan.scan_config?.account_bootstrap_max_pages || 40,
          form_values: context.scan.scan_config?.auto_account_form_values || {},
        },
        rationale: 'Default account mode requires a real registration/login bootstrap before downstream authenticated testing.',
        source: 'local_policy',
      };
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
    if (!invoked(context, 'agent.shared_context.prepare')) return { action: 'tool_call', tool_name: 'agent.shared_context.prepare', arguments: { selected_vuln_types: selectedForPolicy }, rationale: 'Prepare reusable cross-agent shared context before selection/expansion.', source: 'local_policy' };
    if (selectedForPolicy.length > 0 && !invoked(context, 'task.expand_selected_vulnerabilities')) return { action: 'tool_call', tool_name: 'task.expand_selected_vulnerabilities', arguments: { selected_vuln_types: selectedForPolicy }, rationale: 'Selected vulnerability categories exist; expand them into persistent executable tasks.', source: 'local_policy' };
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

export class AutonomousAgentPlanner {
  constructor(private readonly db: DbProvider) {}

  async decide(context: AutonomousAgentContext): Promise<AutonomousPlannerResult> {
    const policyDecision = localPolicy(context);
    // The mobile acquisition contract is deterministic. An LLM may not skip
    // install/launch/assertions/capture/cleanup or pronounce this phase complete.
    const mobileDiscovery = isAndroidContext(context) && (context.task.execution_plan?.intent === 'discover_target' || (/discover|understand|目标|发现/i.test(context.task.task_type + ' ' + context.task.title) && !/candidate|feature|漏洞候选|功能树/i.test(context.task.task_type + ' ' + context.task.title)));
    if (mobileDiscovery) return policyDecision;
    let provider: AIProvider | null = null;
    let providerError: unknown = null;
    try { provider = await getDefaultProvider(this.db); } catch (error) { providerError = error; }
    if (!provider) {
      const reason=providerError instanceof Error?providerError.message:'未配置可用的模型服务。请在模型设置中启用并验证连接，再重新测试。';
      agentEventBus.publish({ kind: 'agent_state_changed', status: 'blocked', scan_run_id: context.task.scan_run_id, task_id: context.task.id, error:reason,summary:'模型服务不可用，本轮停止执行。' });
      throw new Error(reason);
    }
    agentEventBus.publish({ kind: 'agent_state_changed', status: 'info', scan_run_id: context.task.scan_run_id, task_id: context.task.id, provider_id: provider.id, model: provider.model, summary: `Agent 已选择真实 provider：${provider.id}` });

    const client = new AIClient(provider);
    const system = [
      'You are the BSTG discovery-first autonomous security testing planner.',
      'Goal: maximize useful vulnerability discovery on the operator-declared target using BSTG tools and evidence artifacts.',
      'Do not add traffic budgets, tool capability gates, or evidence-contract blockers. If evidence is incomplete, continue testing and record the replay gap rather than suppressing a finding.',
      'Prefer actions that expand reachable routes, authenticated states, object IDs, workflows, and mutation opportunities.',
      'Plan within context.task.decision_budget; its remaining allowance includes this decision. Reserve a decision to complete, hand off, or explicitly fail the task instead of exploring until the allowance is exhausted.',
      'Return strict JSON only.',
    ].join('\n');
    const userPayload = sanitizeForAIModel({
      context,
      deterministic_next_step: policyDecision,
      required_output: {
        action: 'tool_call | complete_task | fail_task | wait_for_user_selection | create_child_tasks',
        tool_name: 'required only for tool_call',
        arguments: 'object; match selected tool input_schema',
        rationale: 'why this increases vulnerability discovery or closes replay gaps',
      },
    });
    const telemetry = agentEventBus.beginLLM({
      scan_run_id: context.task.scan_run_id,
      task_id: context.task.id,
      provider_id: provider.id,
      model: provider.model,
      request: { model: provider.model, messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(userPayload) }] },
      message_count: 2,
    });
    try {
      const response = await client.chat({
        model: provider.model,
        temperature: 0.1,
        max_tokens: 1800,
        ...(provider.id === 'internal-agent-relay' ? {} : { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(userPayload) },
        ],
      }, { scan_run_id: context.task.scan_run_id, task_id: context.task.id, emit_events: false });
      telemetry.succeed(response);
      const content = response.choices?.[0]?.message?.content || '';
      const parsed = safeJsonParse(content);
      const normalized = normalizeDecision(parsed);
      if (!normalized) throw new Error(`AI provider returned invalid decision JSON: ${content.slice(0, 400)}`);
      return { ...normalized, source: 'ai_provider', raw_response: parsed, provider_id: provider.id, model: response.model, provider_response_id:response.id, ai_provider_attempted:true, ai_usage:response.usage, policy_decision: policyDecision, validation_status: 'accepted' };
    } catch (error: any) {
      telemetry.fail(error);
      agentEventBus.publish({ kind: 'agent_state_changed', status: 'failed', scan_run_id: context.task.scan_run_id, task_id: context.task.id, provider_id: provider.id, model: provider.model, error: error.message || String(error), summary: '模型决策失败，本轮停止执行。请检查服务权限或连接后重试。' });
      throw new Error(`模型服务未完成本次请求：${error.message || String(error)}`);
    }
  }
}
