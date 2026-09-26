import { hydrateRequests, capturedRaw, capturedParameters, parameterLocation, parameterBodyType } from './captured-request.js';
import { v4 as uuidv4 } from 'uuid';
import type { DbProvider } from '../../types/index.js';
import { dbAll, dbGet, dbRun } from '../../db/sql-helpers.js';
import { executeTemplateRun } from '../template-runner.js';
import { executeWorkflowRun } from '../workflow-runner.js';
import { getTraceByRunId } from '../debug-trace.js';
import { generateAndApplyExecutionLearning } from './bstg-learning-automation.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint, AIScanTask } from './types.js';
import type { AttackPayload } from './payload-catalog.js';
import { buildWorkflowExecutionPlan, type WorkflowExecutionPlan } from './workflow-context.js';

export interface NativeBstgAssetBundle {
  environment_id?: string;
  account_ids: string[];
  attacker_account_id?: string;
  victim_account_id?: string;
  admin_account_id?: string;
  template_ids: string[];
  api_mode_template_ids: string[];
  api_mode_baseline_test_run_id?: string;
  api_mode_mutation_test_run_id?: string;
  api_mode_security_rule_id?: string;
  api_mode_checklist_id?: string;
  baseline_workflow_id: string;
  mutation_workflow_id: string;
  template_test_run_id: string;
  baseline_workflow_test_run_id: string;
  mutation_workflow_test_run_id: string;
  security_rule_ids: string[];
  checklist_ids: string[];
  workflow_variable_ids: string[];
  workflow_mapping_ids: string[];
  workflow_extractor_ids: string[];
  workflow_variable_config_ids: string[];
}

export interface NativeBstgRunResult {
  assets: NativeBstgAssetBundle;
  template_run: Awaited<ReturnType<typeof executeTemplateRun>>;
  baseline_workflow_run: Awaited<ReturnType<typeof executeWorkflowRun>>;
  mutation_workflow_run: Awaited<ReturnType<typeof executeWorkflowRun>>;
  advanced_mutation?: { plan: Record<string, any>; profile: Record<string, any> };
  api_mode?: {
    baseline_template_id: string;
    mutation_template_id: string;
    baseline_test_run_id: string;
    mutation_test_run_id: string;
    security_rule_id: string;
    checklist_id: string;
    baseline_run: Awaited<ReturnType<typeof executeTemplateRun>>;
    mutation_run: Awaited<ReturnType<typeof executeTemplateRun>>;
  };
  native_counts: Record<string, number>;
}

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function pathWithQuery(path: string, params: Record<string, string>): string {
  const u = new URL(path || '/', 'http://target.local');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

function hostFor(endpoint: AIDiscoveredEndpoint): string {
  try { return endpoint.url ? new URL(endpoint.url).host : 'target.local'; } catch { return 'target.local'; }
}

function methodFor(endpoint: AIDiscoveredEndpoint): string {
  const m = (endpoint.method || 'GET').toUpperCase();
  return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m) ? m : 'GET';
}

function bodyFor(method: string, params: Record<string, string>): { body: string; headers: string[]; bodyType: string } {
  if (method === 'GET' || method === 'HEAD') return { body: '', headers: [], bodyType: 'none' };
  return {
    body: JSON.stringify(params),
    headers: ['Content-Type: application/json'],
    bodyType: 'json',
  };
}

function rawRequest(endpoint: AIDiscoveredEndpoint, params: Record<string, string>, headers: Record<string, string> = {}): string {
  if(endpoint.captured_request)return capturedRaw(endpoint,params,headers);
  const method = methodFor(endpoint);
  const path = method === 'GET' ? pathWithQuery(endpoint.path || '/', params) : (endpoint.path || '/');
  const bodySpec = bodyFor(method, params);
  const lines = [
    `${method} ${path} HTTP/1.1`,
    `Host: ${hostFor(endpoint)}`,
    'User-Agent: BSTG-AI-Agent/1.0',
    ...bodySpec.headers,
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    bodySpec.body,
  ];
  return lines.join('\r\n');
}

function failurePatternsForEndpoint(endpoint: AIDiscoveredEndpoint, isPrerequisite: boolean): any[] {
  const patterns: any[] = [
    { type: 'http_status', path: 'status', operator: 'equals', value: '0' },
    { type: 'http_status', path: 'status', operator: 'equals', value: '401' },
    { type: 'http_status', path: 'status', operator: 'equals', value: '403' },
    { type: 'response_message', path: 'message', operator: 'regex', value: 'unauth|forbidden|denied|token required|session expired|csrf|expired|invalid session|未登录|请登录|无权限' },
    { type: 'response_code', path: 'code', operator: 'equals', value: '401' },
    { type: 'response_code', path: 'code', operator: 'equals', value: '403' },
  ];
  if (isPrerequisite && /login|signin|auth|token/i.test(endpointSemanticText(endpoint))) {
    patterns.push({ type: 'response_message', path: 'message', operator: 'regex', value: 'failed|error|invalid|bad|失败|错误' });
  }
  return patterns;
}

function assertionsForStep(endpoint: AIDiscoveredEndpoint, stepOrder: number, isTarget: boolean, workflowPlan?: WorkflowExecutionPlan): any[] {
  const semantic = endpointSemanticText(endpoint);
  const assertions: any[] = [
    { op: 'not_equals', left: { type: 'response', path: 'status' }, right: { type: 'literal', value: '0' } },
    { op: 'not_equals', left: { type: 'response', path: 'status' }, right: { type: 'literal', value: '401' } },
    { op: 'not_equals', left: { type: 'response', path: 'status' }, right: { type: 'literal', value: '403' } },
  ];
  if (/login|signin|auth|token/.test(semantic)) {
    assertions.push({ op: 'not_contains', left: { type: 'response', path: 'body.message' }, right: { type: 'literal', value: 'failed' }, missing_behavior: 'skip' });
  }
  if (isTarget && workflowPlan?.access_phase === 'post_auth') {
    assertions.push({ op: 'not_contains', left: { type: 'response', path: 'body.message' }, right: { type: 'literal', value: 'login' }, missing_behavior: 'skip' });
  }
  if (workflowPlan?.missing_preconditions?.length && stepOrder === workflowPlan.nodes.length) {
    assertions.push({ op: 'equals', left: { type: 'response', path: 'status' }, right: { type: 'literal', value: '__missing_precondition__' } });
  }
  return assertions;
}

function inferParamName(endpoint: AIDiscoveredEndpoint, vulnType: string): string {
  if(endpoint.captured_request){const keys=Object.keys(capturedParameters(endpoint));if(!keys.length)throw new Error('接口缺少可测试的真实参数。');return keys.find(k=>/id|file|path|query|amount|price|quantity|code|role|status/i.test(k))||keys[0];}
  const url = endpoint.url ? new URL(endpoint.url) : null;
  for (const [k] of url?.searchParams || []) {
    if (/id|uid|order|file|path|q|query|search|cmd|host|amount|price|quantity|code|role|status/i.test(k)) return k;
  }
  const text = `${endpoint.path} ${endpoint.request_summary || ''}`;
  const nameMatch = text.match(/(?:name|field)["'\s:=]+([a-zA-Z0-9_.-]+)/i);
  if (nameMatch) return nameMatch[1];
  if (/command|cmd|ping|host/i.test(vulnType + text)) return 'host';
  if (/xss|search|query|comment|content/i.test(vulnType + text)) return 'q';
  if (/download|path|traversal|file/i.test(vulnType + text)) return 'file';
  if (/logic|amount|price|quantity|cart|order/i.test(vulnType + text)) return 'amount';
  if (/auth|otp|code|verify/i.test(vulnType + text)) return 'code';
  return 'id';
}

function baselineValueFor(vulnType: string, param: string): string {
  if (/file|path/i.test(param) || /download|traversal/i.test(vulnType)) return 'report.txt';
  if (/host|cmd/i.test(param) || vulnType === 'command_injection') return '127.0.0.1';
  if (/amount|price|quantity/i.test(param) || vulnType === 'business_logic') return '1';
  if (/code|otp/i.test(param) || vulnType === 'auth_otp') return '123456';
  if (/q|query|search|comment|content/i.test(param) || vulnType === 'xss') return 'hello';
  return '1001';
}


function endpointSemanticText(endpoint: AIDiscoveredEndpoint): string {
  return `${endpoint.method || ''} ${endpoint.path || ''} ${endpoint.url || ''} ${endpoint.request_summary || ''} ${endpoint.response_summary || ''} ${endpoint.feature_guess || ''}`.toLowerCase();
}

function workflowPlanFromTask(task: AIScanTask, endpoints: AIDiscoveredEndpoint[], vulnType: string): WorkflowExecutionPlan {
  const embedded = task.execution_plan?.workflow_execution_plan;
  if (embedded && Array.isArray(embedded.endpoint_ids) && Array.isArray(embedded.nodes)) {
    return embedded as WorkflowExecutionPlan;
  }
  return buildWorkflowExecutionPlan({
    allEndpoints: endpoints,
    selectedEndpointIds: endpoints.map(endpoint => endpoint.id),
    vulnType,
  });
}

function statefulActionKind(endpoint: AIDiscoveredEndpoint): string {
  const t = endpointSemanticText(endpoint);
  if (/refund|退款/.test(t)) return 'refund';
  if (/cancel|取消/.test(t)) return 'cancel';
  if (/pay|payment|paid|支付/.test(t)) return 'pay';
  if (/withdraw|提现/.test(t)) return 'withdraw';
  if (/transfer|转账/.test(t)) return 'transfer';
  if (/cart|quantity|购物车/.test(t)) return 'cart';
  if (/order|checkout|订单/.test(t)) return 'order';
  if (/verify|otp|sms|email|code|passcode|paypwd|验证码|短信|邮箱|支付密码/.test(t)) return 'verify';
  return 'generic_state_action';
}

function paramsForAdvancedState(endpoint: AIDiscoveredEndpoint, vulnType: string): Record<string, string> {
  if(endpoint.captured_request)return capturedParameters(endpoint);
  const t = endpointSemanticText(endpoint);
  const params: Record<string, string> = {};
  const name = inferParamName(endpoint, vulnType);
  params[name] = baselineValueFor(vulnType, name);
  if (/cart|quantity/.test(t)) params.quantity = '-1';
  if (/refund|cancel|order|pay|payment|withdraw|transfer|amount/.test(t)) {
    params.order_id = params.order_id || '1001';
    params.amount = params.amount || '10';
  }
  if (/refund/.test(t)) params.status = 'refund_requested';
  if (/cancel/.test(t)) params.status = 'cancelled';
  if (/pay|payment/.test(t)) params.status = 'paid';
  if (/otp|sms|email|code|verify/.test(t)) params.code = params.code || '123456';
  if (/passcode|paypwd|pin/.test(t)) params.passcode = params.passcode || '123456';
  return params;
}

function paramsForWorkflowStep(endpoint: AIDiscoveredEndpoint, vulnType: string, isAction: boolean, paramName: string, baselineValue: string, configuredAccounts: Record<string, any>): Record<string, string> {
  if(endpoint.captured_request)return {...capturedParameters(endpoint),...(isAction?{[paramName]:baselineValue}:{})};
  const t = endpointSemanticText(endpoint);
  const attacker = configuredAccounts.attacker || {};
  const username = String(attacker.username || attacker.email || attacker.account || 'attacker@example.test');
  const password = String(attacker.password || attacker.passcode || 'Password123!');
  if (/send.*code|sms|email|otp|captcha|imagecode/.test(t)) return { account: username, email: username, phone: String(attacker.phone || attacker.mobile || '13800000000') };
  if (/register|signup/.test(t)) return { account: username, username, email: username, password, code: '123456' };
  if (/login|signin|auth|token/.test(t) && !/confirm|verify/.test(t)) return { account: username, username, email: username, password };
  if (/confirm|verify|bind|unbind|otp|code/.test(t)) return { account: username, email: username, code: '123456', otp: '123456' };
  if (/passcode|paypwd|pay_password|payment.*password|trade.*password|pin/.test(t)) return { passcode: '123456', paypwd: '123456', amount: '10', order_id: '1001' };
  if (/cart|quantity/.test(t)) return { id: '1001', quantity: '1', amount: '1' };
  if (/pay|payment|checkout/.test(t)) return { id: '1001', order_id: '1001', amount: '10', status: 'paid' };
  if (/refund|cancel|order|entrust|commission|withdraw|transfer|wallet|otc|legal|option|contract|exchange/.test(t)) return { id: '1001', order_id: '1001', amount: isAction && vulnType === 'business_logic' ? baselineValue : '1', quantity: '1' };
  if (/download|file|export/.test(t)) return { file: 'report.txt', path: 'report.txt' };
  if (/search|article|contact|notice|help|college|category|service/.test(t)) return { q: 'hello', content: 'hello', id: '1001' };
  return isAction ? { [paramName]: baselineValue } : { id: '1001', q: 'bstg' };
}

function buildParallelExtraRequests(endpoints: AIDiscoveredEndpoint[], action: AIDiscoveredEndpoint, vulnType: string): any[] {
  const candidates = endpoints
    .filter(endpoint => endpoint.id !== action.id)
    .filter(endpoint => /refund|cancel|pay|payment|withdraw|transfer|cart|quantity|order|verify|otp|sms|email|code|passcode|paypwd/i.test(endpointSemanticText(endpoint)));
  const source = candidates.length ? candidates : [action];
  return source.slice(0, 3).map((endpoint, index) => ({
    kind: 'extra',
    name: `cross_packet_${statefulActionKind(endpoint)}_${index + 1}`,
    snapshot_template_id: `ai_parallel_${endpoint.id}_${index + 1}`,
    snapshot_template_name: `${methodFor(endpoint)} ${endpoint.path}`,
    request_snapshot_raw: rawRequest(endpoint, paramsForAdvancedState(endpoint, vulnType), {}),
    repeat: /refund|pay|payment|withdraw|transfer|cart|quantity|order/i.test(endpointSemanticText(endpoint)) ? 2 : 1,
    injection_overrides: [
      { target: 'headers.Authorization', data_source: 'account_field', account_field_name: 'auth_token', role: 'attacker' },
      { target: 'body.order_id', data_source: 'workflow_context', variable: 'object_id' },
      { target: 'query.order_id', data_source: 'workflow_context', variable: 'object_id' },
    ],
  }));
}

function planAdvancedMutationProfile(input: {
  vulnType: string;
  endpoints: AIDiscoveredEndpoint[];
  action: AIDiscoveredEndpoint;
  accountIds: { attackerId: string; victimId: string; adminId: string };
  workflowPlan?: WorkflowExecutionPlan;
}): { mutationProfile: Record<string, any>; plan: Record<string, any> } {
  const { vulnType, endpoints, action, accountIds, workflowPlan } = input;
  const actionStep = endpoints.length;
  const endpointKinds = endpoints.map(endpoint => ({ id: endpoint.id, method: endpoint.method, path: endpoint.path, kind: statefulActionKind(endpoint) }));
  const isStateful = ['business_logic', 'replay_race', 'state_machine_race', 'auth_otp', 'email_sms_bypass', 'passcode_bypass'].includes(vulnType);
  const isAccessControl = ['bola_idor', 'bfla'].includes(vulnType);
  const mutationProfile: Record<string, any> = {
    ai_strategy: 'native_bstg_baseline_then_mutation',
    strategy_version: 2,
    lock_variables: ['auth_token', 'native_baseline_value', 'csrf_token', 'otp_ticket', 'object_id'],
    reuse_tickets: true,
    static_conditions: [
      { name: 'baseline_must_execute_before_mutation', type: 'precondition', expected: 'baseline_verified' },
      { name: 'session_or_token_must_be_reused', type: 'precondition', expected: 'session_jar_or_auth_token' },
      ...(workflowPlan?.preconditions || []).map(item => ({
        name: `workflow_precondition_${item.name}`,
        type: 'precondition',
        expected: item.satisfied_by || item.name,
        required: item.required,
        reason: item.reason,
      })),
      { name: 'stateful_action_result_must_be_rechecked', type: 'postcondition', expected: 'state_query_or_response_diff' },
    ],
    workflow_dependency_plan: workflowPlan ? {
      access_phase: workflowPlan.access_phase,
      target_kind: workflowPlan.target_kind,
      required_capabilities: workflowPlan.required_capabilities,
      missing_preconditions: workflowPlan.missing_preconditions,
      schedule: workflowPlan.schedule,
    } : undefined,
    state_machine: {
      action_step: actionStep,
      action_kind: statefulActionKind(action),
      endpoint_kinds: endpointKinds,
      state_variables: ['order_id', 'user_id', 'amount', 'quantity', 'status', 'otp_ticket', 'passcode_verified'],
      test_dimensions: [] as string[],
    },
  };
  const dimensions: string[] = [];

  if (isAccessControl) {
    mutationProfile.swap_account_at_steps = { [String(actionStep)]: vulnType === 'bola_idor' ? 'attacker' : accountIds.adminId };
    dimensions.push(vulnType === 'bola_idor' ? 'anchor_attacker_object_swap' : 'vertical_privilege_role_swap');
  }

  if (vulnType === 'business_logic' || vulnType === 'auth_otp' || vulnType === 'email_sms_bypass' || vulnType === 'passcode_bypass') {
    if (endpoints.length > 1) {
      mutationProfile.skip_steps = [Math.max(1, actionStep - 1)];
      dimensions.push('state_transition_skip');
    }
    mutationProfile.repeat_steps = { [String(actionStep)]: 2 };
    dimensions.push('idempotency_replay');
  }

  if (vulnType === 'replay_race' || isStateful) {
    mutationProfile.concurrent_replay = {
      step_order: actionStep,
      concurrency: (vulnType === 'replay_race' || vulnType === 'state_machine_race') ? 8 : 4,
      barrier: true,
      timeout_ms: 10000,
      pick_primary: 'first_success',
      semantics: 'same_packet_concurrent_race',
    };
    dimensions.push('same_packet_concurrent_replay');
  }

  if (vulnType === 'replay_race' || vulnType === 'state_machine_race' || vulnType === 'business_logic') {
    const extras = buildParallelExtraRequests(endpoints, action, vulnType);
    if (extras.length) {
      mutationProfile.parallel_groups = [{
        anchor_step_order: actionStep,
        barrier: true,
        timeout_ms: 10000,
        pick_primary: 'anchor_first_success',
        writeback_policy: 'primary_only',
        semantics: 'cross_packet_parallel_state_race',
        extras,
      }];
      dimensions.push('cross_packet_parallel_group');
    }
  }

  mutationProfile.state_machine.test_dimensions = dimensions;
  const plan = {
    strategy: 'advanced_state_machine_and_race_mutation',
    vuln_type: vulnType,
    action_step: actionStep,
    action_endpoint: { id: action.id, method: action.method, path: action.path, kind: statefulActionKind(action) },
    endpoint_kinds: endpointKinds,
    dimensions,
    uses_same_packet_concurrency: Boolean(mutationProfile.concurrent_replay),
    uses_cross_packet_parallel_group: Boolean(mutationProfile.parallel_groups?.length),
    uses_state_transition_skip: Boolean(mutationProfile.skip_steps?.length),
    uses_idempotency_replay: Boolean(mutationProfile.repeat_steps && Object.keys(mutationProfile.repeat_steps).length),
    uses_account_swap: Boolean(mutationProfile.swap_account_at_steps),
    static_conditions: mutationProfile.static_conditions,
    workflow_dependency_plan: mutationProfile.workflow_dependency_plan,
    native_bstg_features: ['mutation_profile', 'concurrent_replay', 'parallel_groups', 'skip_steps', 'repeat_steps', 'reuse_tickets', 'lock_variables', 'session_jar'],
  };
  return { mutationProfile, plan };
}

function accountFields(_kind: string, override: Record<string,any>):Record<string,any> {
  // Identity material must come from supplied credentials or an observed login, never sample tokens.
  const fields={...override};
  if(!fields.auth_token && fields.authorization)fields.auth_token=fields.authorization;
  if(!fields.auth_token && fields.token)fields.auth_token=`Bearer ${fields.token}`;
  return fields;
}

interface EnsuredAccount {
  id: string;
  created: boolean;
  kind: 'attacker' | 'victim' | 'admin';
}

async function ensureAccount(db: DbProvider, scanRunId: string, kind: 'attacker' | 'victim' | 'admin', override: Record<string, any> = {}): Promise<EnsuredAccount> {
  const name = override.name || `AI ${kind} account ${scanRunId.slice(0, 8)}`;
  const accounts=await db.repos.accounts.findAll();
  const bound=accounts.find(a=>Array.isArray(a.tags) && a.tags.includes(`scan:${scanRunId}`) && a.tags.includes(`role:${kind}`));
  if(bound)return {id:bound.id,created:false,kind};
  const existing = await dbGet<any>(db, 'SELECT id FROM accounts WHERE name = ?', [name]);
  if (existing?.id) return { id: String(existing.id), created: false, kind };
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO accounts (id, name, username, display_name, status, tags, auth_profile, variables, fields, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      name,
      String(override.username || kind),
      name,
      'active',
      json(['ai_scan', `scan:${scanRunId}`, `role:${kind}`]),
      json({ type: 'bearer', header: 'Authorization', value_field: 'auth_token' }),
      json([]),
      json({ ...accountFields(kind, override), ...override }),
      `Auto-created for AI Scan ${scanRunId}.`,
    ]
  );
  return { id, created: true, kind };
}


async function recordSharedExecutionUse(input: {
  repo: AIScanRepository;
  task: AIScanTask;
  accountIds?: string[];
  loginEndpointIds?: string[];
  workflowIds?: string[];
  templateIds?: string[];
  securityRuleIds?: string[];
  checklistIds?: string[];
}): Promise<void> {
  const refs = input.task.execution_plan?.shared_resource_refs || {};
  const usedRefs = Object.values(refs).filter(Boolean).map(String);
  await input.repo.upsertSharedResource({
    scan_run_id: input.task.scan_run_id,
    resource_type: 'execution_reuse_record',
    resource_key: input.task.id,
    title: `Shared resources reused by task ${input.task.id}`,
    owner_task_id: input.task.id,
    increment_usage: false,
    content_json: {
      task_id: input.task.id,
      vuln_type: input.task.vuln_type,
      used_shared_resource_refs: usedRefs,
      account_ids: input.accountIds || [],
      login_endpoint_ids: input.loginEndpointIds || [],
      workflow_ids: input.workflowIds || [],
      template_ids: input.templateIds || [],
      security_rule_ids: input.securityRuleIds || [],
      checklist_ids: input.checklistIds || [],
      reuse_semantics: 'This task/sub-agent consumed scan-wide shared identity/login/session/payload/object context instead of rediscovering it in isolation.',
    },
  });
  for (const ref of usedRefs) {
    const [resourceType, ...rest] = ref.split(':');
    const resourceKey = rest.join(':');
    if (resourceType && resourceKey) await input.repo.touchSharedResource(input.task.scan_run_id, resourceType, resourceKey).catch(() => undefined);
  }
}

async function ensureSecurityRule(db: DbProvider, name: string, payloads: string[], description: string): Promise<string> {
  const id = uuidv4();
  await dbRun(db, `INSERT INTO security_rules (id, name, payloads, description) VALUES (?, ?, ?, ?)`, [id, name, json(payloads), description]);
  return id;
}

async function ensureChecklist(db: DbProvider, name: string, values: string[], description: string): Promise<string> {
  const id = uuidv4();
  await dbRun(db, `INSERT INTO checklists (id, name, config, description) VALUES (?, ?, ?, ?)`, [id, name, json({ values }), description]);
  return id;
}

function payloadValues(payloads: AttackPayload[]): string[] {
  return payloads.map(p => p.value || p.label).filter(Boolean);
}

async function createTemplate(db: DbProvider, input: {
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
  name: string;
  group: string;
  raw: string;
  variables?: any[];
  accountBindingStrategy?: string;
  attackerAccountId?: string;
  enableBaseline?: boolean;
  baselineConfig?: Record<string, any>;
}): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO api_templates (
      id, name, group_name, description, raw_request, parsed_structure, variables, failure_patterns, failure_logic,
      is_active, account_binding_strategy, attacker_account_id, enable_baseline, baseline_config, advanced_config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.group,
      `Native BSTG asset generated by AI Scan task ${input.task.id}`,
      input.raw,
      json({ method: methodFor(input.endpoint), path: input.endpoint.path, endpoint_id: input.endpoint.id, native_bstg: true }),
      json(input.variables || []),
      json([{ type: 'http_status', path: 'status', operator: 'equals', value: '0' }]),
      'OR',
      1,
      input.accountBindingStrategy || 'independent',
      input.attackerAccountId || null,
      input.enableBaseline ? 1 : 0,
      json(input.baselineConfig || { compare_status: true, compare_body: true, min_body_diff_ratio: 0.05 }),
      json({ ai_scan_task_id: input.task.id, endpoint_id: input.endpoint.id, native_bstg: true }),
    ]
  );
  return id;
}

async function createWorkflow(db: DbProvider, input: {
  task: AIScanTask;
  name: string;
  type: 'baseline' | 'mutation';
  baseWorkflowId?: string;
  accountBindingStrategy?: string;
  attackerAccountId?: string;
  mutationProfile?: Record<string, any>;
  enableExtractor?: boolean;
  enableSessionJar?: boolean;
  criticalStepOrders?: number[];
  assertionStrategy?: 'any_step_pass' | 'all_steps_pass' | 'last_step_pass' | 'specific_steps';
}): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO workflows (
      id, name, description, is_active, assertion_strategy, critical_step_orders, account_binding_strategy,
      attacker_account_id, enable_baseline, baseline_config, enable_extractor, enable_session_jar, session_jar_config,
      workflow_type, base_workflow_id, template_mode, mutation_profile, learning_status, learning_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      `Native BSTG workflow generated by AI Scan task ${input.task.id}`,
      1,
      input.assertionStrategy || 'any_step_pass',
      json(input.criticalStepOrders || []),
      input.accountBindingStrategy || 'independent',
      input.attackerAccountId || null,
      1,
      json({ compare_steps: true, min_body_diff_ratio: 0.05 }),
      input.enableExtractor ? 1 : 0,
      input.enableSessionJar === false ? 0 : 1,
      json({ cookie_mode: true, header_mode: true }),
      input.type,
      input.baseWorkflowId || null,
      'reference',
      json(input.mutationProfile || {}),
      'learned',
      1,
    ]
  );
  return id;
}

async function addStep(db: DbProvider, workflowId: string, templateId: string, order: number, assertions: any[] = []): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO workflow_steps (id, workflow_id, api_template_id, step_order, step_assertions, assertions_mode) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, workflowId, templateId, order, json(assertions), 'all']
  );
  return id;
}

async function addWorkflowVariableConfig(db: DbProvider, input: {
  workflowId: string;
  name: string;
  mappings: any[];
  dataSource: string;
  checklistId?: string;
  securityRuleId?: string;
  accountFieldName?: string;
  bindingStrategy?: string;
  attackerAccountId?: string;
  role?: string;
  isAttackerField?: boolean;
  advancedConfig?: Record<string, any>;
  accountScopeIds?: string[];
}): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO workflow_variable_configs (
      id, workflow_id, name, step_variable_mappings, data_source, checklist_id, security_rule_id, account_field_name,
      binding_strategy, attacker_account_id, role, is_attacker_field, advanced_config, account_scope_mode, account_scope_ids
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workflowId,
      input.name,
      json(input.mappings),
      input.dataSource,
      input.checklistId || null,
      input.securityRuleId || null,
      input.accountFieldName || null,
      input.bindingStrategy || null,
      input.attackerAccountId || null,
      input.role || null,
      input.isAttackerField ? 1 : 0,
      json(input.advancedConfig || {}),
      input.accountScopeIds?.length ? 'only_selected' : 'all',
      json(input.accountScopeIds || []),
    ]
  );
  return id;
}

async function addExtractor(db: DbProvider, workflowId: string, stepOrder: number, name: string, source: string, expression: string, required = false): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO workflow_extractors (id, workflow_id, step_order, name, source, expression, transform, required) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workflowId, stepOrder, name, source, expression, null, required ? 1 : 0]
  );
  return id;
}

async function addVariablePoolItem(db: DbProvider, workflowId: string, name: string, type: 'IDENTITY' | 'FLOW_TICKET' | 'OBJECT_ID' | 'GENERIC', source: 'account_injected' | 'extracted' | 'manual', description: string): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT OR IGNORE INTO workflow_variables (id, workflow_id, name, type, source, write_policy, is_locked, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workflowId, name, type, source, 'overwrite', 1, description]
  );
  const row = await dbGet<any>(db, 'SELECT id FROM workflow_variables WHERE workflow_id = ? AND name = ?', [workflowId, name]);
  return row?.id || id;
}

async function addWorkflowMapping(db: DbProvider, workflowId: string, fromStep: number, fromPath: string, toStep: number, toLocation: string, toPath: string, variableName: string, reason = 'heuristic'): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO workflow_mappings (
      id, workflow_id, from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workflowId, fromStep, 'response.body', fromPath, toStep, toLocation, toPath, variableName, 0.87, reason, 1]
  );
  return id;
}

function sortEndpointsForWorkflow(endpoints: AIDiscoveredEndpoint[]): AIDiscoveredEndpoint[] {
  const score = (e: AIDiscoveredEndpoint) => {
    const t = `${e.path} ${e.request_summary || ''}`.toLowerCase();
    if (/sendsms|sendemail|send.*code|captcha|verify/i.test(t)) return 10;
    if (/register/.test(t)) return 20;
    if (/login(?!confirm)/.test(t)) return 30;
    if (/loginconfirm|confirm|verify/.test(t)) return 40;
    if (/upload|avatar|image|file|import/.test(t)) return 50;
    if (/store|create|order|entrust|bet|transfer|withdraw|pay|cancel/.test(t)) return 60;
    if (/detail|info|list|get|query/.test(t)) return 70;
    return 80;
  };
  return [...endpoints].sort((a, b) => score(a) - score(b));
}


const TOKEN_EXTRACTOR_PATHS = ['data.token', 'data.access_token', 'token', 'access_token', 'result.token'];

const CSRF_EXTRACTOR_PATHS = ['data.csrf_token', 'csrf_token', '_token'];

const OBJECT_EXTRACTOR_PATHS = ['data.id', 'data.user_id', 'data.order_id', 'id', 'order_id'];

const FILE_URL_EXTRACTOR_PATHS = ['data.url', 'data.path', 'url', 'path'];

async function addProductionExtractors(db: DbProvider, workflowId: string, stepOrder: number): Promise<string[]> {
  const ids: string[] = [];
  ids.push(await addExtractor(db, workflowId, stepOrder, `status_${stepOrder}`, 'response_status', 'status'));
  ids.push(await addExtractor(db, workflowId, stepOrder, `set_cookie_${stepOrder}`, 'response_header', 'set-cookie'));
  ids.push(await addExtractor(db, workflowId, stepOrder, `location_${stepOrder}`, 'response_header', 'location'));
  for (const path of TOKEN_EXTRACTOR_PATHS) ids.push(await addExtractor(db, workflowId, stepOrder, `token_${stepOrder}_${path.replace(/[^a-z0-9]+/gi, '_')}`, 'response_body_jsonpath', path));
  for (const path of CSRF_EXTRACTOR_PATHS) ids.push(await addExtractor(db, workflowId, stepOrder, `csrf_${stepOrder}_${path.replace(/[^a-z0-9]+/gi, '_')}`, 'response_body_jsonpath', path));
  for (const path of OBJECT_EXTRACTOR_PATHS) ids.push(await addExtractor(db, workflowId, stepOrder, `object_${stepOrder}_${path.replace(/[^a-z0-9]+/gi, '_')}`, 'response_body_jsonpath', path));
  for (const path of FILE_URL_EXTRACTOR_PATHS) ids.push(await addExtractor(db, workflowId, stepOrder, `file_url_${stepOrder}_${path.replace(/[^a-z0-9]+/gi, '_')}`, 'response_body_jsonpath', path));
  return ids;
}

async function addProductionCrossStepMappings(db: DbProvider, workflowId: string, fromStep: number, toStep: number): Promise<{ variableIds: string[]; configIds: string[]; mappingIds: string[] }> {
  const variableIds: string[] = [];
  const configIds: string[] = [];
  const mappingIds: string[] = [];
  const defs = [
    { name: `auth_token_from_${fromStep}`, type: 'FLOW_TICKET' as const, paths: TOKEN_EXTRACTOR_PATHS, to: [{ loc: 'request.header', path: 'Authorization', json: 'headers.Authorization', template: 'Bearer {{value}}' }] },
    { name: `csrf_from_${fromStep}`, type: 'FLOW_TICKET' as const, paths: CSRF_EXTRACTOR_PATHS, to: [{ loc: 'request.header', path: 'X-CSRF-TOKEN', json: 'headers.X-CSRF-TOKEN' }, { loc: 'request.body', path: '_token', json: 'body._token' }] },
    { name: `object_id_from_${fromStep}`, type: 'OBJECT_ID' as const, paths: OBJECT_EXTRACTOR_PATHS, to: [{ loc: 'request.body', path: 'id', json: 'body.id' }, { loc: 'request.query', path: 'id', json: 'query.id' }] },
    { name: `file_url_from_${fromStep}`, type: 'OBJECT_ID' as const, paths: FILE_URL_EXTRACTOR_PATHS, to: [{ loc: 'request.body', path: 'url', json: 'body.url' }, { loc: 'request.query', path: 'url', json: 'query.url' }] },
  ];
  for (const def of defs) {
    variableIds.push(await addVariablePoolItem(db, workflowId, def.name, def.type, 'manual', `Auto-learnable value from step ${fromStep} reused by step ${toStep}.`));
    for (const destination of def.to) {
      configIds.push(await addWorkflowVariableConfig(db, {
        workflowId,
        name: def.name,
        dataSource: 'workflow_context',
        mappings: [{ step_order: toStep, json_path: destination.json, original_value: '' }],
        advancedConfig: { operation_type: 'replace', value_template: (destination as any).template || '{{value}}' },
      }));
      mappingIds.push(await addWorkflowMapping(db, workflowId, fromStep, def.paths[0], toStep, destination.loc, destination.path, def.name, 'manual'));
    }
  }
  return { variableIds, configIds, mappingIds };
}

async function recordBaselineVerificationArtifact(repo: AIScanRepository, input: {
  scanRunId: string;
  taskId: string;
  actionEndpointId: string;
  baselineRun: any;
  mutationRun?: any;
  repaired: boolean;
}): Promise<void> {
  await repo.createArtifact({
    scan_run_id: input.scanRunId,
    task_id: input.taskId,
    artifact_type: 'native_workflow_verification',
    title: input.repaired ? 'Native BSTG baseline workflow verified after repair pass' : 'Native BSTG baseline workflow verification',
    content_json: {
      baseline_verified: Boolean(input.baselineRun?.success && !input.baselineRun?.has_execution_error),
      mutation_executed: Boolean(input.mutationRun?.success),
      repaired: input.repaired,
      baseline_run: input.baselineRun,
      mutation_run: input.mutationRun,
    },
    source_ref: input.actionEndpointId,
  });
}

async function createTemplateRun(db: DbProvider, task: AIScanTask, templateIds: string[], accountIds: string[], environmentId?: string): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO test_runs (id, name, status, execution_type, trigger_type, rule_ids, template_ids, account_ids, environment_id, execution_params)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `AI Native Template ${task.title}`, 'pending', 'template', 'ai_scan', json([]), json(templateIds), json(accountIds), environmentId || null, json({ ai_scan_task_id: task.id, native_bstg: true })]
  );
  return id;
}

async function createWorkflowRun(db: DbProvider, task: AIScanTask, workflowId: string, accountIds: string[], environmentId?: string, label = 'Workflow'): Promise<string> {
  const id = uuidv4();
  await dbRun(
    db,
    `INSERT INTO test_runs (id, name, status, execution_type, trigger_type, rule_ids, workflow_id, account_ids, environment_id, execution_params)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, `AI Native ${label} ${task.title}`, 'pending', 'workflow', 'ai_scan', json([]), workflowId, json(accountIds), environmentId || null, json({ ai_scan_task_id: task.id, native_bstg: true })]
  );
  return id;
}


async function runNativeApiTestMode(input: {
  db: DbProvider;
  repo: AIScanRepository;
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
  vulnType: string;
  payloads: AttackPayload[];
  paramName: string;
  baselineValue: string;
  securityRuleId: string;
  checklistId: string;
  accountIds: string[];
  attackerId: string;
  victimId: string;
  adminId: string;
  environmentId?: string;
}): Promise<NativeBstgRunResult['api_mode']> {
  const { db, repo, task, endpoint, vulnType, payloads, paramName, baselineValue, securityRuleId, checklistId, accountIds, attackerId, victimId, adminId, environmentId } = input;
  const method = methodFor(endpoint);
  const jsonPath = parameterLocation(endpoint,paramName);
  const bodyType = parameterBodyType(endpoint);
  const baselineRaw = rawRequest(endpoint, { [paramName]: baselineValue }, {});
  const mutationRaw = rawRequest(endpoint, { [paramName]: baselineValue }, {});
  const baselineVariables: any[] = [
    {
      name: 'api_baseline_value',
      json_path: jsonPath,
      operation_type: 'replace',
      original_value: baselineValue,
      data_source: 'checklist',
      checklist_id: checklistId,
      body_content_type: bodyType,
    },
  ];
  const mutationVariables: any[] = [];

  if (vulnType === 'bola_idor') {
    mutationVariables.push(
      {
        name: 'api_attacker_auth',
        json_path: 'headers.Authorization',
        operation_type: 'replace',
        original_value: endpoint.captured_request?.headers.authorization || '',
        data_source: 'account_field',
        account_field_name: 'auth_token',
        binding_strategy: 'anchor_attacker',
        attacker_account_id: attackerId,
        role: 'attacker',
        is_attacker_field: true,
        account_scope_mode: 'only_selected',
        account_scope_ids: [attackerId],
      },
      {
        name: 'api_victim_object_id',
        json_path: jsonPath,
        operation_type: 'replace',
        original_value: baselineValue,
        data_source: 'account_field',
        account_field_name: 'object_id',
        binding_strategy: 'anchor_attacker',
        attacker_account_id: attackerId,
        role: 'victim',
        account_scope_mode: 'only_selected',
        account_scope_ids: [victimId],
        body_content_type: bodyType,
      },
    );
  } else if (vulnType === 'bfla') {
    baselineVariables.push({
      name: 'api_admin_auth',
      json_path: 'headers.Authorization',
      operation_type: 'replace',
      original_value: endpoint.captured_request?.headers.authorization || '',
      data_source: 'account_field',
      account_field_name: 'auth_token',
      role: 'admin',
      account_scope_mode: 'only_selected',
      account_scope_ids: [adminId],
    });
    mutationVariables.push({
      name: 'api_low_privilege_auth',
      json_path: 'headers.Authorization',
      operation_type: 'replace',
      original_value: endpoint.captured_request?.headers.authorization || '',
      data_source: 'account_field',
      account_field_name: 'auth_token',
      role: 'attacker',
      is_attacker_field: true,
      account_scope_mode: 'only_selected',
      account_scope_ids: [attackerId],
    });
  } else {
    mutationVariables.push({
      name: 'api_mutation_payload',
      json_path: jsonPath,
      operation_type: 'replace',
      original_value: baselineValue,
      data_source: 'security_rule',
      security_rule_id: securityRuleId,
      body_content_type: bodyType,
    });
  }

  const baselineTemplateId = await createTemplate(db, {
    task,
    endpoint,
    name: `AI Native API Baseline ${vulnType} ${endpoint.method} ${endpoint.path}`,
    group: `AI Scan / Native API Test / ${vulnType}`,
    raw: baselineRaw,
    variables: baselineVariables,
    accountBindingStrategy: vulnType === 'bola_idor' ? 'anchor_attacker' : 'independent',
    attackerAccountId: vulnType === 'bola_idor' ? attackerId : undefined,
    enableBaseline: false,
  });
  const mutationTemplateId = await createTemplate(db, {
    task,
    endpoint,
    name: `AI Native API Mutation ${vulnType} ${endpoint.method} ${endpoint.path}`,
    group: `AI Scan / Native API Test / ${vulnType}`,
    raw: mutationRaw,
    variables: mutationVariables,
    accountBindingStrategy: vulnType === 'bola_idor' ? 'anchor_attacker' : 'independent',
    attackerAccountId: vulnType === 'bola_idor' ? attackerId : undefined,
    enableBaseline: vulnType === 'bola_idor',
    baselineConfig: { compare_status: true, compare_body: true, min_body_diff_ratio: 0.03 },
  });

  const baselineRunId = await createTemplateRun(db, task, [baselineTemplateId], accountIds, environmentId);
  const mutationRunId = await createTemplateRun(db, task, [mutationTemplateId], accountIds, environmentId);
  const baselineRun = await executeTemplateRun({ test_run_id: baselineRunId, template_ids: [baselineTemplateId], account_ids: accountIds, environment_id: environmentId });
  const mutationRun = await executeTemplateRun({ test_run_id: mutationRunId, template_ids: [mutationTemplateId], account_ids: accountIds, environment_id: environmentId });

  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'native_api_test_run',
    title: `Native BSTG API-mode test run for ${vulnType}`,
    content_json: {
      mode: 'api_test_run',
      endpoint,
      param_name: paramName,
      payload_count: payloads.length,
      baseline_template_id: baselineTemplateId,
      mutation_template_id: mutationTemplateId,
      baseline_test_run_id: baselineRunId,
      mutation_test_run_id: mutationRunId,
      security_rule_id: securityRuleId,
      checklist_id: checklistId,
      baseline_run: baselineRun,
      mutation_run: mutationRun,
    },
    source_ref: endpoint.id,
  });

  return {
    baseline_template_id: baselineTemplateId,
    mutation_template_id: mutationTemplateId,
    baseline_test_run_id: baselineRunId,
    mutation_test_run_id: mutationRunId,
    security_rule_id: securityRuleId,
    checklist_id: checklistId,
    baseline_run: baselineRun,
    mutation_run: mutationRun,
  };
}


async function cleanupNativeAutofindings(db: DbProvider, ids: { testRunIds: string[]; templateIds: string[]; workflowIds: string[] }): Promise<number> {
  const before = await dbGet<any>(db, 'SELECT COUNT(*) as c FROM findings', []);
  const clauses: string[] = [];
  const params: string[] = [];
  if (ids.testRunIds.length) {
    clauses.push(`test_run_id IN (${ids.testRunIds.map(() => '?').join(',')})`);
    params.push(...ids.testRunIds);
  }
  if (ids.templateIds.length) {
    clauses.push(`api_template_id IN (${ids.templateIds.map(() => '?').join(',')})`);
    clauses.push(`template_id IN (${ids.templateIds.map(() => '?').join(',')})`);
    params.push(...ids.templateIds, ...ids.templateIds);
  }
  if (ids.workflowIds.length) {
    clauses.push(`workflow_id IN (${ids.workflowIds.map(() => '?').join(',')})`);
    params.push(...ids.workflowIds);
  }
  if (!clauses.length) return 0;
  await dbRun(db, `DELETE FROM findings WHERE (${clauses.join(' OR ')}) AND (source_type = 'template' OR source_type = 'workflow' OR title LIKE 'Potential vulnerability in AI Native%' OR title LIKE 'Workflow vulnerability:%')`, params);
  const after = await dbGet<any>(db, 'SELECT COUNT(*) as c FROM findings', []);
  return Math.max(0, Number(before?.c || 0) - Number(after?.c || 0));
}

async function countNativeAssets(db: DbProvider, taskId: string): Promise<Record<string, number>> {
  const tables: Array<[string, string]> = [
    ['api_templates', 'advanced_config'],
    ['workflows', 'description'],
    ['workflow_steps', 'id'],
    ['workflow_variable_configs', 'id'],
    ['workflow_extractors', 'id'],
    ['workflow_variables', 'id'],
    ['workflow_mappings', 'id'],
    ['security_rules', 'description'],
    ['checklists', 'description'],
    ['accounts', 'notes'],
    ['test_runs', 'execution_params'],
  ];
  const out: Record<string, number> = {};
  for (const [table, column] of tables) {
    const row = await dbGet<any>(db, `SELECT COUNT(*) as c FROM ${table} WHERE ${column} LIKE ?`, [`%${taskId}%`]);
    out[table] = Number(row?.c || 0);
  }
  return out;
}

export async function runNativeBstgOrchestration(input: {
  db: DbProvider;
  repo: AIScanRepository;
  task: AIScanTask;
  endpoints: AIDiscoveredEndpoint[];
  payloads: AttackPayload[];
  paramName?: string;
  mode?: 'generic' | 'file_upload';
}): Promise<NativeBstgRunResult> {
  const { db, repo, task } = input;
  const initialEndpoints = await hydrateRequests(repo,input.endpoints);
  const vulnType = task.vuln_type || 'generic';
  const workflowPlan = workflowPlanFromTask(task, initialEndpoints, vulnType);
  const planEndpointMap = new Map(initialEndpoints.map(endpoint => [endpoint.id, endpoint]));
  const plannedEndpoints = workflowPlan.endpoint_ids
    .map(id => planEndpointMap.get(id))
    .filter(Boolean) as AIDiscoveredEndpoint[];
  const endpoints = plannedEndpoints.length ? plannedEndpoints : sortEndpointsForWorkflow(initialEndpoints);
  if (endpoints.length === 0) throw new Error('Native BSTG orchestration requires at least one endpoint');
  const run = await repo.getRun(task.scan_run_id);
  if(run?.scan_config?.request_evidence_required && initialEndpoints.some(e=>!e.captured_request))throw new Error('缺少已观察的完整业务请求，不能用猜测参数执行测试。请先触发对应页面功能或导入实际流量。');
  const environmentId = run?.environment_id;
  const action = endpoints[endpoints.length - 1];
  const paramName = input.paramName || inferParamName(action, vulnType);
  const baselineValue = action.captured_request ? String(capturedParameters(action)[paramName]) : baselineValueFor(vulnType, paramName);
  const payloadList = payloadValues(input.payloads).slice(0, 3);
  const securityRuleId = await ensureSecurityRule(db, `AI Native Payloads ${vulnType} ${task.id.slice(0, 8)}`, payloadList, `Native BSTG payload dictionary for AI Scan task ${task.id}`);
  const checklistId = await ensureChecklist(db, `AI Native Baseline ${vulnType} ${task.id.slice(0, 8)}`, [baselineValue], `Native BSTG checklist for AI Scan task ${task.id}`);

  const configuredAccounts = (run?.scan_config?.accounts || run?.scan_config?.identities || {}) as Record<string, any>;
  const attackerAccount = await ensureAccount(db, task.scan_run_id, 'attacker', configuredAccounts.attacker || {});
  const victimAccount = await ensureAccount(db, task.scan_run_id, 'victim', configuredAccounts.victim || {});
  const adminAccount = await ensureAccount(db, task.scan_run_id, 'admin', configuredAccounts.admin || {});
  const generatedAccounts = [attackerAccount, victimAccount, adminAccount].filter(account => account.created);
  const attackerId = attackerAccount.id;
  const victimId = victimAccount.id;
  const adminId = adminAccount.id;
  const accountIds = [attackerId, victimId, adminId];

  const apiMode = await runNativeApiTestMode({
    db,
    repo,
    task,
    endpoint: action,
    vulnType,
    payloads: input.payloads,
    paramName,
    baselineValue,
    securityRuleId,
    checklistId,
    accountIds,
    attackerId,
    victimId,
    adminId,
    environmentId,
  });

  const templateIds: string[] = [];
  const extractorIds: string[] = [];
  const variableConfigIds: string[] = [];
  const workflowVariableIds: string[] = [];
  const mappingIds: string[] = [];

  const rawByStep: Array<{ endpoint: AIDiscoveredEndpoint; raw: string; variables: any[] }> = [];
  endpoints.forEach((endpoint, idx) => {
    const isAction = idx === endpoints.length - 1;
    const method = methodFor(endpoint);
    const p = isAction ? paramName : (/code/i.test(endpoint.path) ? 'account' : 'q');
    const params = paramsForWorkflowStep(endpoint, vulnType, isAction, p, baselineValue, configuredAccounts);
    rawByStep.push({
      endpoint,
      raw: rawRequest(endpoint, params, {}),
      variables: isAction ? [
        {
          name: 'native_payload',
          json_path: parameterLocation(endpoint,p),
          operation_type: 'replace',
          original_value: baselineValue,
          data_source: 'security_rule',
          security_rule_id: securityRuleId,
          body_content_type: parameterBodyType(endpoint),
        },
      ] : [],
    });
  });

  for (let i = 0; i < rawByStep.length; i++) {
    const item = rawByStep[i];
    const templateId = await createTemplate(db, {
      task,
      endpoint: item.endpoint,
      name: `AI Native ${vulnType} step ${i + 1} ${item.endpoint.method} ${item.endpoint.path}`,
      group: `AI Scan / Native / ${vulnType}`,
      raw: item.raw,
      variables: item.variables,
      accountBindingStrategy: vulnType === 'bola_idor' ? 'anchor_attacker' : 'independent',
      attackerAccountId: vulnType === 'bola_idor' ? attackerId : undefined,
      enableBaseline: true,
    });
    await dbRun(db, `UPDATE api_templates SET failure_patterns = ?, failure_logic = ? WHERE id = ?`, [
      json(failurePatternsForEndpoint(item.endpoint, i < rawByStep.length - 1)),
      'OR',
      templateId,
    ]);
    templateIds.push(templateId);
  }

  const baselineWorkflowId = await createWorkflow(db, {
    task,
    name: `AI Native Baseline ${vulnType} ${task.title}`,
    type: 'baseline',
    accountBindingStrategy: vulnType === 'bola_idor' ? 'anchor_attacker' : 'independent',
    attackerAccountId: vulnType === 'bola_idor' ? attackerId : undefined,
    enableExtractor: true,
    enableSessionJar: true,
    criticalStepOrders: workflowPlan.access_phase === 'post_auth' ? Array.from({ length: endpoints.length }, (_, index) => index + 1) : [endpoints.length],
    assertionStrategy: workflowPlan.access_phase === 'post_auth' ? 'all_steps_pass' : 'specific_steps',
  });

  for (let i = 0; i < templateIds.length; i++) {
    await addStep(db, baselineWorkflowId, templateIds[i], i + 1, assertionsForStep(endpoints[i], i + 1, i === templateIds.length - 1, workflowPlan));
  }

  for (let i = 0; i < endpoints.length; i++) {
    const order = i + 1;
    extractorIds.push(...await addProductionExtractors(db, baselineWorkflowId, order));
  }

  if (endpoints.length > 1) {
    for (let from = 1; from < endpoints.length; from++) {
      const generated = await addProductionCrossStepMappings(db, baselineWorkflowId, from, endpoints.length);
      workflowVariableIds.push(...generated.variableIds);
      variableConfigIds.push(...generated.configIds);
      mappingIds.push(...generated.mappingIds);
    }
  } else {
    // Even single-interface workflow tests still need VariablePool/Mapping artifacts so that
    // Agent sub-tasks can share learned auth/object/file values consistently with API test-run mode.
    const generated = await addProductionCrossStepMappings(db, baselineWorkflowId, 1, 1);
    workflowVariableIds.push(...generated.variableIds);
    variableConfigIds.push(...generated.configIds);
    mappingIds.push(...generated.mappingIds);
  }

  const actionMethod = methodFor(action);
  variableConfigIds.push(await addWorkflowVariableConfig(db, {
    workflowId: baselineWorkflowId,
    name: 'native_payload',
    dataSource: 'security_rule',
    securityRuleId,
    mappings: [{ step_order: endpoints.length, json_path: parameterLocation(action,paramName), original_value: baselineValue }],
    advancedConfig: { operation_type: 'replace', body_content_type: parameterBodyType(action) },
  }));
  variableConfigIds.push(await addWorkflowVariableConfig(db, {
    workflowId: baselineWorkflowId,
    name: 'native_baseline_value',
    dataSource: 'checklist',
    checklistId,
    mappings: [{ step_order: endpoints.length, json_path: parameterLocation(action,paramName), original_value: baselineValue }],
    advancedConfig: { operation_type: 'replace', body_content_type: parameterBodyType(action) },
  }));

  if (vulnType === 'bola_idor') {
    variableConfigIds.push(await addWorkflowVariableConfig(db, {
      workflowId: baselineWorkflowId,
      name: 'attacker_auth',
      dataSource: 'account_field',
      accountFieldName: 'auth_token',
      bindingStrategy: 'anchor_attacker',
      attackerAccountId: attackerId,
      role: 'attacker',
      isAttackerField: true,
      mappings: [{ step_order: endpoints.length, json_path: 'headers.Authorization', original_value: action.captured_request?.headers.authorization || '' }],
      advancedConfig: { operation_type: 'replace' },
      accountScopeIds: [attackerId],
    }));
    variableConfigIds.push(await addWorkflowVariableConfig(db, {
      workflowId: baselineWorkflowId,
      name: 'victim_object_id',
      dataSource: 'account_field',
      accountFieldName: /file/i.test(paramName) ? 'file_id' : 'order_id',
      bindingStrategy: 'anchor_attacker',
      attackerAccountId: attackerId,
      role: 'victim',
      mappings: [{ step_order: endpoints.length, json_path: parameterLocation(action,paramName), original_value: baselineValue }],
      advancedConfig: { operation_type: 'replace', body_content_type: parameterBodyType(action) },
      accountScopeIds: [victimId],
    }));
  }

  const advancedMutation = planAdvancedMutationProfile({
    vulnType,
    endpoints,
    action,
    accountIds: { attackerId, victimId, adminId },
    workflowPlan,
  });
  const mutationProfile: Record<string, any> = advancedMutation.mutationProfile;
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'advanced_mutation_plan',
    title: `Advanced native BSTG mutation plan for ${vulnType}`,
    content_json: advancedMutation.plan,
    source_ref: action.id,
  });

  const mutationWorkflowId = await createWorkflow(db, {
    task,
    name: `AI Native Mutation ${vulnType} ${task.title}`,
    type: 'mutation',
    baseWorkflowId: baselineWorkflowId,
    accountBindingStrategy: vulnType === 'bola_idor' ? 'anchor_attacker' : 'independent',
    attackerAccountId: vulnType === 'bola_idor' ? attackerId : undefined,
    mutationProfile,
    enableExtractor: true,
    enableSessionJar: true,
    criticalStepOrders: workflowPlan.access_phase === 'post_auth' ? Array.from({ length: endpoints.length }, (_, index) => index + 1) : [endpoints.length],
    assertionStrategy: workflowPlan.access_phase === 'post_auth' ? 'all_steps_pass' : 'specific_steps',
  });

  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'workflow_dependency_execution_plan',
    title: `Executable workflow dependency plan for ${vulnType}`,
    content_json: {
      ...workflowPlan,
      actual_endpoint_ids: endpoints.map(endpoint => endpoint.id),
      action_endpoint_id: action.id,
      critical_step_orders: workflowPlan.access_phase === 'post_auth' ? Array.from({ length: endpoints.length }, (_, index) => index + 1) : [endpoints.length],
    } as unknown as Record<string, any>,
    content_text: workflowPlan.mermaid,
    source_ref: action.id,
  });

  const templateRunId = await createTemplateRun(db, task, templateIds, accountIds, environmentId);
  const baselineRunId = await createWorkflowRun(db, task, baselineWorkflowId, accountIds, environmentId, 'Baseline Workflow');
  const mutationRunId = await createWorkflowRun(db, task, mutationWorkflowId, accountIds, environmentId, 'Mutation Workflow');

  const templateRun = await executeTemplateRun({ test_run_id: templateRunId, template_ids: templateIds, account_ids: accountIds, environment_id: environmentId });
  let baselineWorkflowRun = await executeWorkflowRun({ test_run_id: baselineRunId, workflow_id: baselineWorkflowId, account_ids: accountIds, environment_id: environmentId });
  const baselineTrace = getTraceByRunId('workflow', baselineRunId);
  let learningRepair: Record<string, any> | undefined;
  let repairedBaseline = false;

  // Native AI repair loop: turn the real workflow execution trace into BSTG learning suggestions,
  // apply extractor/mapping/session-jar updates, and rerun the baseline before mutation.
  // This makes learning-engine, VariablePool, workflow_mappings, workflow_extractors and session jar
  // part of the Agent-controlled execution path rather than unused UI-only features.
  if (baselineTrace?.records?.length) {
    learningRepair = await generateAndApplyExecutionLearning(db, baselineWorkflowId, baselineTrace, {
      sourceExecutionRunId: baselineRunId,
      includeAssertions: false,
      minConfidence: 0.5,
      applyMode: 'merge_keep_manual',
    });
    if (learningRepair?.ok && (learningRepair.applied?.mappings_created || learningRepair.applied?.extractors_created || learningRepair.applied?.session_jar_applied || !baselineWorkflowRun.success || baselineWorkflowRun.has_execution_error)) {
      repairedBaseline = true;
      const repairRunId = await createWorkflowRun(db, task, baselineWorkflowId, accountIds, environmentId, 'Baseline Workflow Learning Repair');
      baselineWorkflowRun = await executeWorkflowRun({ test_run_id: repairRunId, workflow_id: baselineWorkflowId, account_ids: accountIds, environment_id: environmentId });
    }
  }

  const mutationWorkflowRun = await executeWorkflowRun({ test_run_id: mutationRunId, workflow_id: mutationWorkflowId, account_ids: accountIds, environment_id: environmentId });
  const mutationTrace = getTraceByRunId('workflow', mutationRunId);
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'advanced_mutation_execution',
    title: `Advanced native mutation execution for ${vulnType}`,
    content_json: {
      mutation_profile: mutationProfile,
      plan: advancedMutation.plan,
      mutation_workflow_id: mutationWorkflowId,
      mutation_test_run_id: mutationRunId,
      mutation_run: mutationWorkflowRun,
      native_trace_summary: mutationTrace ? {
        records: mutationTrace.records?.length || 0,
        has_concurrent: JSON.stringify(mutationTrace).includes('concurrent'),
        has_parallel: JSON.stringify(mutationTrace).includes('parallel_'),
      } : null,
      same_packet_concurrent_configured: Boolean(mutationProfile.concurrent_replay),
      cross_packet_parallel_configured: Boolean(mutationProfile.parallel_groups?.length),
      state_skip_configured: Boolean(mutationProfile.skip_steps?.length),
      idempotency_repeat_configured: Boolean(mutationProfile.repeat_steps && Object.keys(mutationProfile.repeat_steps).length),
    },
    source_ref: mutationWorkflowId,
  });
  await recordBaselineVerificationArtifact(repo, { scanRunId: task.scan_run_id, taskId: task.id, actionEndpointId: action.id, baselineRun: baselineWorkflowRun, mutationRun: mutationWorkflowRun, repaired: repairedBaseline });
  if (learningRepair) {
    await repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'bstg_learning_repair',
      title: learningRepair.ok ? 'BSTG execution learning applied to baseline workflow' : 'BSTG execution learning skipped',
      content_json: learningRepair,
      source_ref: baselineWorkflowId,
    });
  }
  const cleanedNativeAutofindings = await cleanupNativeAutofindings(db, {
    testRunIds: [templateRunId, baselineRunId, mutationRunId, apiMode?.baseline_test_run_id, apiMode?.mutation_test_run_id].filter(Boolean) as string[],
    templateIds: [...templateIds, apiMode?.baseline_template_id, apiMode?.mutation_template_id].filter(Boolean) as string[],
    workflowIds: [baselineWorkflowId, mutationWorkflowId],
  });

  const assets: NativeBstgAssetBundle = {
    environment_id: environmentId,
    account_ids: accountIds,
    attacker_account_id: attackerId,
    victim_account_id: victimId,
    admin_account_id: adminId,
    template_ids: templateIds,
    api_mode_template_ids: [apiMode?.baseline_template_id, apiMode?.mutation_template_id].filter(Boolean) as string[],
    api_mode_baseline_test_run_id: apiMode?.baseline_test_run_id,
    api_mode_mutation_test_run_id: apiMode?.mutation_test_run_id,
    api_mode_security_rule_id: apiMode?.security_rule_id,
    api_mode_checklist_id: apiMode?.checklist_id,
    baseline_workflow_id: baselineWorkflowId,
    mutation_workflow_id: mutationWorkflowId,
    template_test_run_id: templateRunId,
    baseline_workflow_test_run_id: baselineRunId,
    mutation_workflow_test_run_id: mutationRunId,
    security_rule_ids: [securityRuleId],
    checklist_ids: [checklistId],
    workflow_variable_ids: workflowVariableIds,
    workflow_mapping_ids: mappingIds,
    workflow_extractor_ids: extractorIds,
    workflow_variable_config_ids: variableConfigIds,
  };
  await recordSharedExecutionUse({ repo, task, accountIds, loginEndpointIds: endpoints.slice(0, Math.max(0, endpoints.length - 1)).map(endpoint => endpoint.id), workflowIds: [baselineWorkflowId, mutationWorkflowId], templateIds: [...templateIds, ...(apiMode ? [apiMode.baseline_template_id, apiMode.mutation_template_id] : [])], securityRuleIds: [securityRuleId], checklistIds: [checklistId] });
  const nativeCounts = await countNativeAssets(db, task.id);
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'native_bstg_execution',
    title: `Native BSTG execution for ${vulnType}`,
    content_json: { assets, api_mode: apiMode, advanced_mutation: { plan: advancedMutation.plan, profile: mutationProfile }, template_run: templateRun, baseline_workflow_run: baselineWorkflowRun, mutation_workflow_run: mutationWorkflowRun, native_counts: nativeCounts, cleaned_native_autofindings: cleanedNativeAutofindings, learning_repair: learningRepair || null },
    source_ref: action.id,
  });

  return { assets, api_mode: apiMode, advanced_mutation: { plan: advancedMutation.plan, profile: mutationProfile }, template_run: templateRun, baseline_workflow_run: baselineWorkflowRun, mutation_workflow_run: mutationWorkflowRun, native_counts: nativeCounts };
}

export async function runNativeApiTestRun(input: {
  db: DbProvider;
  repo: AIScanRepository;
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
  payloads: AttackPayload[];
  paramName?: string;
}): Promise<{ api_mode: NonNullable<NativeBstgRunResult['api_mode']>; native_counts: Record<string, number>; assets: Partial<NativeBstgAssetBundle> }> {
  const {db,repo,task}=input;
  const [endpoint]=await hydrateRequests(repo,[input.endpoint]);
  const run = await repo.getRun(task.scan_run_id);
  if(run?.scan_config?.request_evidence_required&&!endpoint.captured_request)throw new Error('当前接口没有已捕获的真实请求，无法建立测试基线。');
  const environmentId = run?.environment_id;
  const vulnType = task.vuln_type || 'generic';
  const paramName = input.paramName || inferParamName(endpoint, vulnType);
  const baselineValue = endpoint.captured_request ? String(capturedParameters(endpoint)[paramName]) : baselineValueFor(vulnType, paramName);
  const payloadList = payloadValues(input.payloads).slice(0, 3);
  const securityRuleId = await ensureSecurityRule(db, `AI API Payloads ${vulnType} ${task.id.slice(0, 8)}`, payloadList, `Native API-mode payload dictionary for AI Scan task ${task.id}`);
  const checklistId = await ensureChecklist(db, `AI API Baseline ${vulnType} ${task.id.slice(0, 8)}`, [baselineValue], `Native API-mode checklist for AI Scan task ${task.id}`);
  const configuredAccounts = (run?.scan_config?.accounts || run?.scan_config?.identities || {}) as Record<string, any>;
  const attackerAccount = await ensureAccount(db, task.scan_run_id, 'attacker', configuredAccounts.attacker || {});
  const victimAccount = await ensureAccount(db, task.scan_run_id, 'victim', configuredAccounts.victim || {});
  const adminAccount = await ensureAccount(db, task.scan_run_id, 'admin', configuredAccounts.admin || {});
  const generatedAccounts = [attackerAccount, victimAccount, adminAccount].filter(account => account.created);
  const attackerId = attackerAccount.id;
  const victimId = victimAccount.id;
  const adminId = adminAccount.id;
  const accountIds = [attackerId, victimId, adminId];
  const apiMode = await runNativeApiTestMode({
    db,
    repo,
    task,
    endpoint,
    vulnType,
    payloads: input.payloads,
    paramName,
    baselineValue,
    securityRuleId,
    checklistId,
    accountIds,
    attackerId,
    victimId,
    adminId,
    environmentId,
  });
  if (!apiMode) throw new Error('Native API-mode test run did not produce a result');
  const cleanedNativeAutofindings = await cleanupNativeAutofindings(db, {
    testRunIds: [apiMode.baseline_test_run_id, apiMode.mutation_test_run_id],
    templateIds: [apiMode.baseline_template_id, apiMode.mutation_template_id],
    workflowIds: [],
  });
  const nativeCounts = await countNativeAssets(db, task.id);
  const assets = {
    environment_id: environmentId,
    account_ids: accountIds,
    attacker_account_id: attackerId,
    victim_account_id: victimId,
    admin_account_id: adminId,
    api_mode_template_ids: [apiMode.baseline_template_id, apiMode.mutation_template_id],
    api_mode_baseline_test_run_id: apiMode.baseline_test_run_id,
    api_mode_mutation_test_run_id: apiMode.mutation_test_run_id,
    api_mode_security_rule_id: apiMode.security_rule_id,
    api_mode_checklist_id: apiMode.checklist_id,
  };
  await recordSharedExecutionUse({ repo, task, accountIds, templateIds: [apiMode.baseline_template_id, apiMode.mutation_template_id], securityRuleIds: [apiMode.security_rule_id], checklistIds: [apiMode.checklist_id] });
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'native_api_test_run_summary',
    title: `Native BSTG API-mode standalone summary for ${vulnType}`,
    content_json: { assets, api_mode: apiMode, native_counts: nativeCounts, cleaned_native_autofindings: cleanedNativeAutofindings },
    source_ref: endpoint.id,
  });
  return { api_mode: apiMode, native_counts: nativeCounts, assets };
}

export async function listNativeTestRunEvidence(db: DbProvider, testRunIds: string[]): Promise<any[]> {
  if (!testRunIds.length) return [];
  const placeholders = testRunIds.map(() => '?').join(',');
  return dbAll<any>(db, `SELECT id, name, status, execution_type, progress, validation_report, error_message, findings_count_effective, has_execution_error FROM test_runs WHERE id IN (${placeholders})`, testRunIds);
}
