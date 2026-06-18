import type { AIDiscoveredEndpoint } from './types.js';

export type WorkflowAccessPhase = 'pre_auth' | 'auth_transition' | 'post_auth';
export type WorkflowDependencyKind =
  | 'captcha_or_code'
  | 'register'
  | 'login'
  | 'session_check'
  | 'cart'
  | 'order_create'
  | 'payment'
  | 'object_lookup'
  | 'verification'
  | 'passcode'
  | 'target';

export interface WorkflowDependencyNode {
  id: string;
  endpoint_id: string;
  method: string;
  path: string;
  kind: WorkflowDependencyKind;
  access_phase: WorkflowAccessPhase;
  provides: string[];
  requires: string[];
  reason: string;
  can_parallel_after: string[];
  must_precede: string[];
}

export interface WorkflowExecutionPlan {
  target_endpoint_id?: string;
  target_kind: WorkflowDependencyKind;
  access_phase: WorkflowAccessPhase;
  endpoint_ids: string[];
  nodes: WorkflowDependencyNode[];
  required_capabilities: string[];
  missing_preconditions: string[];
  preconditions: Array<{ name: string; satisfied_by?: string; required: boolean; reason: string }>;
  schedule: Array<{ stage: number; mode: 'serial' | 'parallel'; endpoint_ids: string[]; reason: string }>;
  parallel_capable: boolean;
  serial_reason?: string;
  mermaid: string;
}

function text(e: AIDiscoveredEndpoint): string {
  return `${e.method || ''} ${e.path || ''} ${e.url || ''} ${e.request_summary || ''} ${e.response_summary || ''} ${e.feature_guess || ''}`.toLowerCase();
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function hasAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

function endpointKind(endpoint: AIDiscoveredEndpoint): WorkflowDependencyKind {
  const t = text(endpoint);
  if (/captcha|imagecode|send.*code|send.*sms|send.*email|smscode|emailcode|otp/.test(t)) return 'captcha_or_code';
  if (/register|signup|create.*account/.test(t)) return 'register';
  if (/login|signin|auth\/token|\/token|session/.test(t) && !/confirm|verify/.test(t)) return 'login';
  if (/me\b|userinfo|profile|current.?user/.test(t)) return 'session_check';
  if (/cart|basket|quantity|购物车/.test(t)) return 'cart';
  if (/pay|payment|checkout|paid|支付/.test(t)) return 'payment';
  if (/refund|cancel|order|entrust|commission|withdraw|transfer|wallet|otc|legal|option|contract|exchange|订单|退款|取消|提现|转账/.test(t)) return 'order_create';
  if (/verify|confirm|otp|sms|email|code|bind|unbind|password|google|验证码|验证/.test(t)) return 'verification';
  if (/passcode|paypwd|pay_password|payment.*password|trade.*password|fund.*password|pin|支付密码|交易密码/.test(t)) return 'passcode';
  if (/detail|info|list|get|query|search|history|record|download|file/.test(t)) return 'object_lookup';
  return 'target';
}

export function classifyEndpointAccessPhase(endpoint: AIDiscoveredEndpoint): WorkflowAccessPhase {
  const t = text(endpoint);
  const kind = endpointKind(endpoint);
  if (kind === 'captcha_or_code' || kind === 'register' || kind === 'login') return 'auth_transition';
  if (hasAny(t, [/login|register|signin|captcha|send.*code|sms|email|otp|forgot|reset/])) return 'auth_transition';
  if (endpoint.auth_required) return 'post_auth';
  if (hasAny(t, [
    /user\/(get|update|security|profile|address|bank|wallet)/,
    /order|cart|checkout|pay|payment|refund|withdraw|transfer|wallet|coupon|address|bind|unbind/,
    /admin|manage|role|permission/,
    /passcode|paypwd|otp|verify|confirm/,
    /订单|购物车|支付|退款|提现|转账|绑定|验证码|支付密码/,
  ])) return 'post_auth';
  return 'pre_auth';
}

function providesFor(kind: WorkflowDependencyKind): string[] {
  switch (kind) {
    case 'captcha_or_code': return ['otp_ticket', 'verification_code'];
    case 'register': return ['account', 'auth_token', 'user_id'];
    case 'login': return ['session', 'auth_token', 'user_id'];
    case 'session_check': return ['session_verified', 'user_id'];
    case 'cart': return ['cart_id', 'quantity'];
    case 'order_create': return ['order_id', 'object_id'];
    case 'payment': return ['paid_order_id', 'payment_state'];
    case 'object_lookup': return ['object_id'];
    case 'verification': return ['verified_state', 'otp_ticket'];
    case 'passcode': return ['passcode_verified'];
    default: return [];
  }
}

function requirementsFor(kind: WorkflowDependencyKind, accessPhase: WorkflowAccessPhase, vulnType: string): string[] {
  const requirements: string[] = [];
  if (accessPhase === 'post_auth') requirements.push('session');
  if (kind === 'login') {
    if (/otp|sms|email|code|captcha/.test(vulnType)) requirements.push('verification_code');
  }
  if (kind === 'session_check') requirements.push('session');
  if (kind === 'cart') requirements.push('session');
  if (kind === 'order_create') requirements.push('session');
  if (kind === 'payment') requirements.push('session', 'order_id');
  if (kind === 'object_lookup' && ['bola_idor', 'business_logic', 'replay_race', 'state_machine_race'].includes(vulnType)) requirements.push('session', 'object_id');
  if (kind === 'verification') requirements.push('session');
  if (kind === 'passcode') requirements.push('session');
  if (['bola_idor', 'bfla'].includes(vulnType) && !requirements.includes('session')) requirements.push('session');
  if (['replay_race', 'state_machine_race'].includes(vulnType) && !requirements.includes('object_id')) requirements.push('object_id');
  return uniq(requirements);
}

function priorityFor(endpoint: AIDiscoveredEndpoint, target: AIDiscoveredEndpoint | undefined, vulnType: string): number {
  const t = text(endpoint);
  const kind = endpointKind(endpoint);
  let score = 0;
  if (kind === 'captcha_or_code') score += 1000;
  if (kind === 'register') score += 900;
  if (kind === 'login') score += 850;
  if (kind === 'session_check') score += 800;
  if (kind === 'cart') score += 700;
  if (kind === 'order_create') score += 650;
  if (kind === 'payment') score += 620;
  if (kind === 'verification') score += 600;
  if (kind === 'passcode') score += 580;
  if (kind === 'object_lookup') score += 500;
  if (/post/i.test(endpoint.method || '')) score += 20;
  if (/business_logic|bola_idor|replay_race|state_machine_race/.test(vulnType) && /order|cart|pay|wallet|transfer|withdraw|refund|cancel/.test(t)) score += 80;
  if (/auth_otp|email_sms_bypass/.test(vulnType) && /send.*code|verify|confirm|login/.test(t)) score += 100;
  if (/passcode_bypass/.test(vulnType) && /passcode|paypwd|payment.*password/.test(t)) score += 100;
  if (target && sameFunctionalArea(endpoint, target)) score += 40;
  return score;
}

function sameFunctionalArea(a: AIDiscoveredEndpoint, b: AIDiscoveredEndpoint): boolean {
  const pa = (a.path || '').split('/').filter(Boolean).slice(0, 2).join('/');
  const pb = (b.path || '').split('/').filter(Boolean).slice(0, 2).join('/');
  if (pa && pb && pa === pb) return true;
  const fa = (a.feature_guess || '').toLowerCase();
  const fb = (b.feature_guess || '').toLowerCase();
  return Boolean(fa && fb && fa === fb);
}

function findProviders(allEndpoints: AIDiscoveredEndpoint[], target: AIDiscoveredEndpoint, requirement: string, vulnType: string): AIDiscoveredEndpoint[] {
  const candidates = allEndpoints
    .filter(endpoint => endpoint.id !== target.id)
    .filter(endpoint => providesFor(endpointKind(endpoint)).includes(requirement))
    .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
  if (requirement === 'object_id') {
    const objectProviders = allEndpoints
      .filter(endpoint => endpoint.id !== target.id)
      .filter(endpoint => /cart|order|checkout|pay|payment|wallet|transfer|withdraw|detail|list|info|otc|exchange|contract|option/i.test(text(endpoint)))
      .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
    return uniq([...candidates, ...objectProviders]).slice(0, 3);
  }
  return candidates.slice(0, requirement === 'session' ? 4 : 2);
}

function nodeFor(endpoint: AIDiscoveredEndpoint, vulnType: string, reason: string): WorkflowDependencyNode {
  const kind = endpointKind(endpoint);
  const accessPhase = classifyEndpointAccessPhase(endpoint);
  return {
    id: endpoint.id,
    endpoint_id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    kind,
    access_phase: accessPhase,
    provides: providesFor(kind),
    requires: requirementsFor(kind, accessPhase, vulnType),
    reason,
    can_parallel_after: [],
    must_precede: [],
  };
}

function buildMermaid(nodes: WorkflowDependencyNode[]): string {
  if (nodes.length === 0) return 'sequenceDiagram\n  participant Agent\n  participant Target\n';
  const lines = ['sequenceDiagram', '  participant Agent', '  participant Target'];
  for (const node of nodes) {
    lines.push(`  Agent->>Target: ${node.method} ${node.path} (${node.kind})`);
    if (node.provides.length) lines.push(`  Target-->>Agent: provides ${node.provides.join(', ')}`);
  }
  return lines.join('\n');
}

export function buildWorkflowExecutionPlan(input: {
  allEndpoints: AIDiscoveredEndpoint[];
  selectedEndpointIds: string[];
  vulnType: string;
  sharedLoginEndpointIds?: string[];
  hasConfiguredIdentity?: boolean;
  maxPreSteps?: number;
}): WorkflowExecutionPlan {
  const selected = input.selectedEndpointIds
    .map(id => input.allEndpoints.find(endpoint => endpoint.id === id))
    .filter(Boolean) as AIDiscoveredEndpoint[];
  const target = selected[selected.length - 1];
  const vulnType = input.vulnType || 'generic';
  if (!target) {
    return {
      target_kind: 'target',
      access_phase: 'pre_auth',
      endpoint_ids: [],
      nodes: [],
      required_capabilities: [],
      missing_preconditions: ['target_endpoint'],
      preconditions: [{ name: 'target_endpoint', required: true, reason: 'No target endpoint was selected.' }],
      schedule: [],
      parallel_capable: true,
      mermaid: buildMermaid([]),
    };
  }

  const selectedSet = new Set(selected.map(endpoint => endpoint.id));
  const targetKind = endpointKind(target);
  const targetPhase = classifyEndpointAccessPhase(target);
  const targetRequirements = requirementsFor(targetKind, targetPhase, vulnType);
  const chosen = new Map<string, AIDiscoveredEndpoint>();
  const addEndpoint = (endpoint: AIDiscoveredEndpoint | undefined) => {
    if (endpoint) chosen.set(endpoint.id, endpoint);
  };

  for (const id of input.sharedLoginEndpointIds || []) addEndpoint(input.allEndpoints.find(endpoint => endpoint.id === id));
  for (const requirement of targetRequirements) {
    for (const provider of findProviders(input.allEndpoints, target, requirement, vulnType)) addEndpoint(provider);
  }

  const precursorLimit = input.maxPreSteps ?? 8;
  const semanticallyUseful = input.allEndpoints
    .filter(endpoint => !selectedSet.has(endpoint.id))
    .filter(endpoint => priorityFor(endpoint, target, vulnType) >= 500)
    .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType))
    .slice(0, precursorLimit);
  for (const endpoint of semanticallyUseful) addEndpoint(endpoint);
  for (const endpoint of selected.slice(0, -1)) addEndpoint(endpoint);
  addEndpoint(target);

  const ordered = [...chosen.values()].sort((a, b) => {
    const aIsTarget = a.id === target.id ? 1 : 0;
    const bIsTarget = b.id === target.id ? 1 : 0;
    if (aIsTarget !== bIsTarget) return aIsTarget - bIsTarget;
    return priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType);
  });

  const nodes = ordered.map((endpoint, index) => nodeFor(
    endpoint,
    vulnType,
    endpoint.id === target.id ? 'target vulnerability action' : `workflow prerequisite step ${index + 1}`,
  ));
  const targetNode = nodes.find(node => node.endpoint_id === target.id);
  if (targetNode) targetNode.requires = uniq([...targetNode.requires, ...targetRequirements]);

  const provided = new Map<string, string>();
  for (const node of nodes) {
    for (const requirement of node.requires) {
      const providerId = provided.get(requirement);
      if (providerId) node.must_precede.push(providerId);
    }
    for (const capability of node.provides) {
      if (!provided.has(capability)) provided.set(capability, node.endpoint_id);
    }
  }

  const missing = targetRequirements.filter(requirement => {
    if (requirement === 'session' && input.hasConfiguredIdentity) return false;
    return !provided.has(requirement) && !targetNode?.provides.includes(requirement);
  });
  const preconditions = targetRequirements.map(requirement => ({
    name: requirement,
    satisfied_by: provided.get(requirement) || (requirement === 'session' && input.hasConfiguredIdentity ? 'configured_identity_pool' : undefined),
    required: true,
    reason: requirement === 'session'
      ? 'Target is a post-login or account-bound function and must run after login/session setup.'
      : `Target needs ${requirement} before the vulnerability action is meaningful.`,
  }));
  const endpointIds = uniq(nodes.map(node => node.endpoint_id));
  const requiredCapabilities = uniq([
    targetPhase === 'post_auth' ? 'login_session_workflow' : '',
    targetRequirements.includes('object_id') ? 'object_state_setup' : '',
    ['business_logic', 'replay_race', 'state_machine_race'].includes(vulnType) ? 'state_machine_sequence' : '',
    ['auth_otp', 'email_sms_bypass', 'passcode_bypass'].includes(vulnType) ? 'verification_chain' : '',
    'baseline_must_satisfy_preconditions',
  ].filter(Boolean));
  const hasSequentialState = nodes.length > 1 || targetPhase === 'post_auth' || targetRequirements.length > 0;
  const schedule = nodes.map((node, index) => ({
    stage: index + 1,
    mode: 'serial' as const,
    endpoint_ids: [node.endpoint_id],
    reason: index === nodes.length - 1 ? 'execute target action after all prerequisites' : `satisfy ${node.provides.join(', ') || node.kind} before later steps`,
  }));

  return {
    target_endpoint_id: target.id,
    target_kind: targetKind,
    access_phase: targetPhase,
    endpoint_ids: endpointIds,
    nodes,
    required_capabilities: requiredCapabilities,
    missing_preconditions: missing,
    preconditions,
    schedule,
    parallel_capable: missing.length === 0 && !hasSequentialState,
    serial_reason: hasSequentialState ? 'This task has in-workflow prerequisites; steps must run serially inside the task even if sibling tasks run in parallel.' : undefined,
    mermaid: buildMermaid(nodes),
  };
}

export function buildWorkflowEndpointContext(input: {
  allEndpoints: AIDiscoveredEndpoint[];
  selectedEndpointIds: string[];
  vulnType: string;
  maxPreSteps?: number;
  sharedLoginEndpointIds?: string[];
}): AIDiscoveredEndpoint[] {
  const plan = buildWorkflowExecutionPlan(input);
  return plan.endpoint_ids
    .map(id => input.allEndpoints.find(endpoint => endpoint.id === id))
    .filter(Boolean) as AIDiscoveredEndpoint[];
}
