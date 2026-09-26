import type { AIDiscoveredEndpoint } from './types.js';

export type WorkflowAccessPhase = 'pre_auth' | 'auth_transition' | 'post_auth';
export type WorkflowDependencyKind =
  | 'captcha_or_code'
  | 'register'
  | 'login'
  | 'session_check'
  | 'cart'
  | 'wallet_setup'
  | 'payment_method'
  | 'order_lookup'
  | 'order_create'
  | 'payment'
  | 'refund'
  | 'cancellation'
  | 'withdrawal'
  | 'transfer'
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

function fileReadTargetScore(endpoint: AIDiscoveredEndpoint): number {
  const t = text(endpoint);
  let pathname = String(endpoint.path || '').toLowerCase();
  let queryNames = '';
  try {
    if (endpoint.url) {
      const parsed = new URL(endpoint.url);
      pathname = `${pathname} ${parsed.pathname.toLowerCase()}`;
      queryNames = [...parsed.searchParams.keys()].join(' ').toLowerCase();
    }
  } catch {
    // Fall back to text-based signals for malformed observed URLs.
  }
  let score = 0;
  if (/(download|export|filedownload|\/down(?:$|[\s\/._-])|下载|导出)/.test(pathname)) score += 1600;
  if (/text\/plain|application\/octet-stream|attachment|content-disposition/.test(t)) score += 700;
  if (/\b(file|filename|path|dir)\b/.test(queryNames)) score += 300;
  if (score > 0 && !/(download|export|filedownload|\/down(?:$|[\s\/._-])|下载|导出)/.test(pathname)) score -= 450;
  if (/\/(?:login|account|manage|member|param|buy|hall|room)(?:\/init)?(?:$|[/?#])/.test(pathname) && /\b(file|filename|path|dir)\b/.test(queryNames)) score -= 350;
  return score;
}

function observedRequestHasObjectContext(endpoint: AIDiscoveredEndpoint, requirement: string): boolean {
  if (!['object_id', 'order_id', 'passcode_verified'].includes(requirement)) return false;
  const haystack = `${endpoint.url || ''} ${endpoint.path || ''} ${endpoint.request_summary || ''} ${endpoint.response_summary || ''}`;
  const keys = requirement === 'order_id'
    ? ['order_id', 'orderId', 'entrust_id', 'commission_id']
    : requirement === 'passcode_verified'
      ? ['passcode', 'paypwd', 'pay_password', 'payment_password', 'trade_password', 'fund_password', 'pin']
      : ['id', 'object_id', 'objectId', 'uid', 'user_id', 'account_id', 'order_id', 'orderId', 'file_id', 'record_id', 'wallet_id', 'address_id', 'entrust_id', 'commission_id'];
  try {
    if (endpoint.url) {
      const parsed = new URL(endpoint.url);
      for (const key of keys) {
        const value = parsed.searchParams.get(key);
        if (value && !/^\{\{.*\}\}$/.test(value)) return true;
      }
    }
  } catch {
    // Ignore malformed captured URLs; the textual checks below still cover summaries and paths.
  }
  if (requirement === 'object_id' && /\/(?:\d{1,12}|[0-9a-f]{8,})(?:[/?#]|$)/i.test(endpoint.path || endpoint.url || '')) return true;
  return keys.some(key => new RegExp(`(?:^|[?&\\s"'{}:,])${key}(?:=|["'\\s:]+)(?!\\{\\{)[A-Za-z0-9_-]{1,64}`, 'i').test(haystack));
}

function contextualProviderForRequirement(requirement: string, endpoint: AIDiscoveredEndpoint, hasConfiguredIdentity?: boolean): string | undefined {
  if (hasConfiguredIdentity && requirement === 'session') return 'configured_identity_pool';
  if (observedRequestHasObjectContext(endpoint, requirement)) return 'observed_request_context';
  return undefined;
}

function endpointKind(endpoint: AIDiscoveredEndpoint): WorkflowDependencyKind {
  const t = text(endpoint);
  if (/captcha|imagecode|send.*code|send.*sms|send.*email|smscode|emailcode|otp|(?:^|\/)send(?:$|[\s\/?#._-])/.test(t)) return 'captcha_or_code';
  if (/register|signup|create.*account/.test(t)) return 'register';
  if (/login|signin|auth\/token|\/token|session|(?:^|\/)sign(?:$|[\s\/?#._-])/.test(t) && !/confirm|verify/.test(t)) return 'login';
  if (/me\b|userinfo|profile|current.?user/.test(t)) return 'session_check';
  if (/walletimage|wallet.*image|createwalletaddress|create.*wallet.*address|wallet.*address.*(add|create|modify|select|management)|withdrawaladdress(add|modify|management|select)|withdrawal.*address|address(add|modify|management|select)|收款地址|提现地址/.test(t)) return 'wallet_setup';
  if (/walletpaymentmethod|paymentmethod|payment_method|paymethod|pay_method|收款方式|支付方式/.test(t)) return 'payment_method';
  if (/refund|退款|return.?order|chargeback/.test(t)) return 'refund';
  if (/cancel|取消|撤销/.test(t)) return 'cancellation';
  if (/withdraw|提现/.test(t)) return 'withdrawal';
  if (/transfer|转账/.test(t)) return 'transfer';
  if (/passcode|paypwd|pay_password|member_mpw|member_rpw|payment.*password|trade.*password|fund.*password|\bpin\b|(?:^|\/)pw(?:$|[\s\/?#._-])|支付密码|交易密码/.test(t)) return 'passcode';
  if (/cart|basket|quantity|购物车/.test(t)) return 'cart';
  if (/pay|payment|checkout|paid|支付/.test(t)) return 'payment';
  if (/create.*order|order.*create|orderplacement|place.*order|submit.*order|storeentrust|submit.*entrust|create.*entrust|create.*wallet|wallet.*create|createwalletaddress|withdrawaladdressadd|addressadd|add.*address|new.*order|buy|purchase|checkout|下单|创建订单|购买|委托下单/.test(t)) return 'order_create';
  if (/order|entrust|commission|wallet|otc|legal|option|contract|exchange|订单/.test(t)) return 'order_lookup';
  if (/verify|confirm|otp|sms|email|code|bind|unbind|password|google|验证码|验证/.test(t)) return 'verification';
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
    case 'wallet_setup': return ['wallet_address_id', 'object_id', 'settled_state'];
    case 'payment_method': return ['payment_method_id', 'settled_state'];
    case 'order_lookup': return ['object_id', 'order_id'];
    case 'order_create': return ['order_id', 'object_id'];
    case 'payment': return ['paid_order_id', 'payment_state', 'settled_state'];
    case 'refund': return ['refund_state', 'settled_state'];
    case 'cancellation': return ['cancelled_order_id'];
    case 'withdrawal': return ['withdrawal_id'];
    case 'transfer': return ['transfer_id'];
    case 'object_lookup': return ['object_id'];
    case 'verification': return ['verified_state', 'otp_ticket'];
    case 'passcode': return ['passcode_verified'];
    default: return [];
  }
}

function inferredProvidesFor(endpoint: AIDiscoveredEndpoint, kind: WorkflowDependencyKind): string[] {
  const t = text(endpoint);
  const provides = [...providesFor(kind)];
  if (/passcode|paypwd|pay_password|member_mpw|member_rpw|payment.*password|trade.*password|fund.*password|\bpin\b|(?:^|\/)pw(?:$|[\s\/?#._-])|支付密码|交易密码/.test(t)) {
    provides.push('passcode_verified');
  }
  if (/pay|payment|checkout|paid|balance|deposit|recharge|orderplacement|storeentrust|getcurrentbalance|contractposition|currentcommission|historicalcommission|option|walletpaymentmethod|wallet|legal-order-status|订单状态|余额|充值|委托|持仓|收款/.test(t)) {
    provides.push('settled_state');
  }
  return uniq(provides);
}

function requirementsFor(kind: WorkflowDependencyKind, accessPhase: WorkflowAccessPhase, vulnType: string, endpoint?: AIDiscoveredEndpoint): string[] {
  const t = endpoint ? text(endpoint) : '';
  const requirements: string[] = [];
  if (accessPhase === 'post_auth') requirements.push('session');
  if (kind === 'login') {
    if (/otp|sms|email|code|captcha/.test(vulnType)) requirements.push('verification_code');
  }
  if (kind === 'session_check') requirements.push('session');
  if (kind === 'cart') requirements.push('session');
  if (kind === 'wallet_setup') requirements.push('session');
  if (kind === 'payment_method') requirements.push('session');
  if (kind === 'order_create') {
    requirements.push('session');
    if (/checkout|submit|place|buy|purchase|下单|购买/.test(t)) requirements.push('cart_id');
  }
  if (kind === 'order_lookup') {
    requirements.push('session');
    if (['bola_idor', 'business_logic', 'replay_race', 'state_machine_race'].includes(vulnType)) requirements.push('object_id');
  }
  if (kind === 'payment') requirements.push('session', 'order_id');
  if (kind === 'refund') requirements.push('session', 'order_id', 'paid_order_id');
  if (kind === 'cancellation') {
    requirements.push('session', 'settled_state');
    requirements.push(/withdraw|提现/.test(t) ? 'withdrawal_id' : 'order_id');
  }
  if (kind === 'withdrawal') requirements.push('session', 'passcode_verified', 'settled_state');
  if (kind === 'transfer') requirements.push('session', 'passcode_verified', 'object_id', 'settled_state');
  if (kind === 'object_lookup' && ['bola_idor', 'business_logic', 'replay_race', 'state_machine_race'].includes(vulnType)) requirements.push('session', 'object_id');
  if (kind === 'verification' && accessPhase === 'post_auth') requirements.push('session');
  if (kind === 'passcode') requirements.push('session');
  if (['bola_idor', 'bfla'].includes(vulnType) && accessPhase === 'post_auth' && !requirements.includes('session')) requirements.push('session');
  if (
    ['replay_race', 'state_machine_race'].includes(vulnType) &&
    (kind === 'order_lookup' || kind === 'object_lookup' || (kind === 'target' && accessPhase === 'post_auth')) &&
    !requirements.includes('object_id')
  ) {
    requirements.push('object_id');
  }
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
  if (kind === 'wallet_setup') score += 690;
  if (kind === 'payment_method') score += 680;
  if (kind === 'order_lookup') score += 675;
  if (kind === 'order_create') score += 650;
  if (kind === 'payment') score += 620;
  if (kind === 'refund') score += 610;
  if (kind === 'cancellation') score += 610;
  if (kind === 'withdrawal') score += 610;
  if (kind === 'transfer') score += 610;
  if (kind === 'verification') score += 600;
  if (kind === 'passcode') score += 580;
  if (kind === 'object_lookup') score += 500;
  if (/post/i.test(endpoint.method || '')) score += 20;
  if (/business_logic|bola_idor|replay_race|state_machine_race/.test(vulnType) && /order|cart|pay|wallet|transfer|withdraw|refund|cancel/.test(t)) score += 80;
  if (/auth_otp|email_sms_bypass/.test(vulnType) && /send.*code|verify|confirm|login/.test(t)) score += 100;
  if (/passcode_bypass/.test(vulnType) && /passcode|paypwd|member_mpw|member_rpw|payment.*password|(?:^|\/)pw(?:$|[\s\/?#._-])/.test(t)) score += 100;
  if (target && sameFunctionalArea(endpoint, target)) score += 40;
  return score;
}

function targetPriorityFor(endpoint: AIDiscoveredEndpoint, vulnType: string): number {
  const t = text(endpoint);
  const kind = endpointKind(endpoint);
  let score = priorityFor(endpoint, undefined, vulnType);
  if (vulnType === 'state_machine_race') {
    if (kind === 'refund') score += 1400;
    if (kind === 'cancellation') score += 1300;
    if (kind === 'payment') score += 1200;
    if (kind === 'withdrawal' || kind === 'transfer') score += 1150;
    if (kind === 'order_create') score += 650;
    if (kind === 'order_lookup') score -= 250;
  }
  if (vulnType === 'replay_race') {
    if (kind === 'refund' || kind === 'cancellation') score += 1200;
    if (kind === 'payment' || kind === 'withdrawal' || kind === 'transfer') score += 1100;
    if (kind === 'cart' || kind === 'order_create') score += 700;
    if (kind === 'order_lookup' && /detail|list|history|orders?($|[/?#])/.test(t)) score -= 200;
  }
  if (vulnType === 'business_logic') {
    if (kind === 'cart' && /quantity|amount|coupon|price/.test(t)) score += 1100;
    if (kind === 'cart' && /\bget\b/.test(t) && /quantity|amount|coupon|price|query_params|fields?:/i.test(t)) score += 260;
    if (kind === 'cart' && /\bpost\b/.test(t) && /inline js\/api reference/i.test(t)) score -= 220;
    if (kind === 'payment_method') score += 1000;
    if (kind === 'refund' || kind === 'cancellation') score += 950;
    if (kind === 'payment' || kind === 'withdrawal' || kind === 'transfer') score += 900;
    if (kind === 'wallet_setup') score += 700;
    if (kind === 'order_create') score += 650;
    if (kind === 'order_lookup') score += 250;
  }
  if (vulnType === 'passcode_bypass') {
    if (kind === 'withdrawal' || kind === 'transfer' || kind === 'payment') score += 1100;
    if (kind === 'passcode') score += 900;
    if (/\/index\.php\/hall\/pw(?:$|[\/?#\s._-])|member_mpw|member_rpw/.test(t)) score += 700;
    if (/command\/exec|ping|host=/.test(t)) score -= 1200;
  }
  if (vulnType === 'auth_otp' || vulnType === 'email_sms_bypass') {
    if (/\/index\.php\/index\/(?:sign|send)(?:$|[\/?#\s._-])/.test(t)) score += 1000;
    if (/\/index\.php\/admin\/login(?:$|[\/?#\s._-])/.test(t) && /[?&](file|host)=/.test(t)) score -= 800;
  }
  if (vulnType === 'bola_idor') {
    if ((kind === 'order_lookup' || kind === 'object_lookup') && /id|order|user|wallet|file|record|detail/.test(t)) score += 900;
    if (kind === 'refund' || kind === 'payment' || kind === 'withdrawal' || kind === 'transfer') score += 500;
  }
  if (vulnType === 'bfla' && /admin|manage|role|permission/.test(t)) score += 900;
  if (vulnType === 'file_download' || vulnType === 'path_traversal') score += fileReadTargetScore(endpoint);
  if (/^get$/i.test(endpoint.method || '') && /list|index|page browse|页面浏览/.test(t) && ['state_machine_race', 'replay_race'].includes(vulnType)) score -= 500;
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
    .filter(endpoint => inferredProvidesFor(endpoint, endpointKind(endpoint)).includes(requirement))
    .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
  if (requirement === 'paid_order_id' || requirement === 'payment_state' || requirement === 'settled_state') {
    const paymentProviders = allEndpoints
      .filter(endpoint => endpoint.id !== target.id)
      .filter(endpoint => /pay|payment|checkout|paid|balance|deposit|recharge|orderplacement|getcurrentbalance|contractposition|option|commission|wallet|支付|余额|充值|委托|持仓/i.test(text(endpoint)) && !/passcode|paypwd|password|pin/i.test(text(endpoint)))
      .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
    return uniq([...candidates, ...paymentProviders]).slice(0, 3);
  }
  if (requirement === 'order_id' || requirement === 'object_id') {
    const objectProviders = allEndpoints
      .filter(endpoint => endpoint.id !== target.id)
      .filter(endpoint => /cart|order|checkout|pay|payment|wallet|transfer|withdraw|detail|list|info|otc|exchange|contract|option/i.test(text(endpoint)))
      .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
    return uniq([...candidates, ...objectProviders]).slice(0, 3);
  }
  if (requirement === 'cart_id') {
    const cartProviders = allEndpoints
      .filter(endpoint => endpoint.id !== target.id)
      .filter(endpoint => /cart|basket|quantity|购物车/i.test(text(endpoint)))
      .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
    return uniq([...candidates, ...cartProviders]).slice(0, 2);
  }
  if (requirement === 'passcode_verified') {
    const passcodeProviders = allEndpoints
      .filter(endpoint => endpoint.id !== target.id)
      .filter(endpoint => /passcode|paypwd|pay_password|payment.*password|trade.*password|fund.*password|pin|支付密码|交易密码/i.test(text(endpoint)))
      .sort((a, b) => priorityFor(b, target, vulnType) - priorityFor(a, target, vulnType));
    return uniq([...candidates, ...passcodeProviders]).slice(0, 2);
  }
  return candidates.slice(0, requirement === 'session' ? 4 : 2);
}

function endpointProvides(endpoint: AIDiscoveredEndpoint, requirement: string): boolean {
  return inferredProvidesFor(endpoint, endpointKind(endpoint)).includes(requirement);
}

function isRequirementSatisfiedByConfiguredIdentity(requirement: string, hasConfiguredIdentity?: boolean): boolean {
  return Boolean(hasConfiguredIdentity && requirement === 'session');
}

function closeWorkflowDependencyProviders(input: {
  allEndpoints: AIDiscoveredEndpoint[];
  chosen: Map<string, AIDiscoveredEndpoint>;
  target: AIDiscoveredEndpoint;
  vulnType: string;
  hasConfiguredIdentity?: boolean;
}): void {
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const endpoints = [...input.chosen.values()];
    for (const endpoint of endpoints) {
      const kind = endpointKind(endpoint);
      const accessPhase = classifyEndpointAccessPhase(endpoint);
      const requirements = requirementsFor(kind, accessPhase, input.vulnType, endpoint);
      for (const requirement of requirements) {
        if (contextualProviderForRequirement(requirement, endpoint, input.hasConfiguredIdentity)) continue;
        const alreadySatisfied = [...input.chosen.values()]
          .some(candidate => candidate.id !== endpoint.id && endpointProvides(candidate, requirement));
        if (alreadySatisfied) continue;
        const providers = findProviders(input.allEndpoints, endpoint, requirement, input.vulnType).slice(0, 1);
        for (const provider of providers) {
          if (!input.chosen.has(provider.id)) {
            input.chosen.set(provider.id, provider);
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
}

function providerForRequirement(input: {
  requirement: string;
  consumer: AIDiscoveredEndpoint;
  candidates: AIDiscoveredEndpoint[];
  vulnType: string;
  hasConfiguredIdentity?: boolean;
}): string | undefined {
  const contextualProvider = contextualProviderForRequirement(input.requirement, input.consumer, input.hasConfiguredIdentity);
  if (contextualProvider) return contextualProvider;
  return input.candidates
    .filter(candidate => candidate.id !== input.consumer.id && endpointProvides(candidate, input.requirement))
    .sort((a, b) => priorityFor(b, input.consumer, input.vulnType) - priorityFor(a, input.consumer, input.vulnType))[0]?.id;
}

function orderWorkflowEndpoints(input: {
  endpoints: AIDiscoveredEndpoint[];
  target: AIDiscoveredEndpoint;
  vulnType: string;
  hasConfiguredIdentity?: boolean;
}): AIDiscoveredEndpoint[] {
  const byId = new Map(input.endpoints.map(endpoint => [endpoint.id, endpoint]));
  const dependencyMap = new Map<string, Set<string>>();
  for (const endpoint of input.endpoints) {
    const kind = endpointKind(endpoint);
    const accessPhase = classifyEndpointAccessPhase(endpoint);
    const requirements = requirementsFor(kind, accessPhase, input.vulnType, endpoint);
    const dependencies = new Set<string>();
    for (const requirement of requirements) {
      const providerId = providerForRequirement({
        requirement,
        consumer: endpoint,
        candidates: input.endpoints,
        vulnType: input.vulnType,
        hasConfiguredIdentity: input.hasConfiguredIdentity,
      });
      if (providerId && !['configured_identity_pool', 'observed_request_context'].includes(providerId) && providerId !== endpoint.id) {
        dependencies.add(providerId);
      }
    }
    dependencyMap.set(endpoint.id, dependencies);
  }

  const scheduled = new Set<string>();
  const ordered: AIDiscoveredEndpoint[] = [];
  while (scheduled.size < input.endpoints.length) {
    const ready = input.endpoints
      .filter(endpoint => !scheduled.has(endpoint.id))
      .filter(endpoint => [...(dependencyMap.get(endpoint.id) || [])].every(id => scheduled.has(id) || !byId.has(id)))
      .sort((a, b) => {
        const aIsTarget = a.id === input.target.id ? 1 : 0;
        const bIsTarget = b.id === input.target.id ? 1 : 0;
        if (aIsTarget !== bIsTarget) return aIsTarget - bIsTarget;
        return priorityFor(b, input.target, input.vulnType) - priorityFor(a, input.target, input.vulnType);
      });
    if (ready.length === 0) {
      const fallback = input.endpoints
        .filter(endpoint => !scheduled.has(endpoint.id))
        .sort((a, b) => priorityFor(b, input.target, input.vulnType) - priorityFor(a, input.target, input.vulnType))[0];
      if (!fallback) break;
      scheduled.add(fallback.id);
      ordered.push(fallback);
      continue;
    }
    const next = ready[0];
    scheduled.add(next.id);
    ordered.push(next);
  }
  return ordered;
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
    provides: inferredProvidesFor(endpoint, kind),
    requires: requirementsFor(kind, accessPhase, vulnType, endpoint),
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
  const vulnType = input.vulnType || 'generic';
  const target = selected
    .slice()
    .sort((a, b) => targetPriorityFor(b, vulnType) - targetPriorityFor(a, vulnType))[0];
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

  const targetKind = endpointKind(target);
  const targetPhase = classifyEndpointAccessPhase(target);
  const targetRequirements = requirementsFor(targetKind, targetPhase, vulnType, target);
  const chosen = new Map<string, AIDiscoveredEndpoint>();
  const addEndpoint = (endpoint: AIDiscoveredEndpoint | undefined) => {
    if (endpoint) chosen.set(endpoint.id, endpoint);
  };

  // A high semantic score is not a dependency: adding every login, upload or
  // object endpoint can mutate unrelated state and block an otherwise replayable
  // captured request. Only declared requirements and explicit selections belong.
  if (targetRequirements.includes('session') && !input.hasConfiguredIdentity) {
    for (const id of input.sharedLoginEndpointIds || []) addEndpoint(input.allEndpoints.find(endpoint => endpoint.id === id));
  }
  for (const requirement of targetRequirements) {
    if (contextualProviderForRequirement(requirement, target, input.hasConfiguredIdentity)) continue;
    for (const provider of findProviders(input.allEndpoints, target, requirement, vulnType).slice(0, 1)) addEndpoint(provider);
  }
  for (const endpoint of selected) if (endpoint.id !== target.id) addEndpoint(endpoint);
  addEndpoint(target);
  closeWorkflowDependencyProviders({
    allEndpoints: input.allEndpoints,
    chosen,
    target,
    vulnType,
    hasConfiguredIdentity: input.hasConfiguredIdentity,
  });

  const ordered = orderWorkflowEndpoints({
    endpoints: [...chosen.values()],
    target,
    vulnType,
    hasConfiguredIdentity: input.hasConfiguredIdentity,
  });

  const nodes = ordered.map((endpoint, index) => nodeFor(
    endpoint,
    vulnType,
    endpoint.id === target.id ? 'target vulnerability action' : `workflow prerequisite step ${index + 1}`,
  ));
  const targetNode = nodes.find(node => node.endpoint_id === target.id);
  if (targetNode) targetNode.requires = uniq([...targetNode.requires, ...targetRequirements]);

  const provided = new Map<string, string>();
  const workflowPreconditions: Array<{ name: string; consumer_endpoint_id: string; satisfied_by?: string; required: boolean; reason: string }> = [];
  const workflowMissing: string[] = [];
  for (const node of nodes) {
    for (const requirement of node.requires) {
      const contextualProvider = contextualProviderForRequirement(requirement, ordered.find(endpoint => endpoint.id === node.endpoint_id) || target, input.hasConfiguredIdentity);
      const providerId = provided.get(requirement) || contextualProvider;
      if (providerId && !['configured_identity_pool', 'observed_request_context'].includes(providerId)) node.must_precede.push(providerId);
      workflowPreconditions.push({
        name: requirement,
        consumer_endpoint_id: node.endpoint_id,
        satisfied_by: providerId,
        required: true,
        reason: requirement === 'session'
          ? `${node.method} ${node.path} is post-login/account-bound and must run after login/session setup.`
          : `${node.method} ${node.path} needs ${requirement} before this workflow step is meaningful.`,
      });
      if (!providerId) workflowMissing.push(`${node.method} ${node.path}:${requirement}`);
    }
    for (const capability of node.provides) {
      if (!provided.has(capability)) provided.set(capability, node.endpoint_id);
    }
  }

  const providedBeforeTarget = new Map<string, string>();
  for (const node of nodes) {
    if (node.endpoint_id === target.id) break;
    for (const capability of node.provides) {
      if (!providedBeforeTarget.has(capability)) providedBeforeTarget.set(capability, node.endpoint_id);
    }
  }
  function contextualSatisfies(requirement: string, endpoint: AIDiscoveredEndpoint): string | undefined {
    return contextualProviderForRequirement(requirement, endpoint, input.hasConfiguredIdentity);
  }
  const missing = targetRequirements.filter(requirement => {
    if (contextualSatisfies(requirement, target)) return false;
    return !providedBeforeTarget.has(requirement);
  });
  const targetPreconditions = targetRequirements.map(requirement => ({
    name: requirement,
    consumer_endpoint_id: target.id,
    satisfied_by: providedBeforeTarget.get(requirement) || contextualSatisfies(requirement, target),
    required: true,
    reason: requirement === 'session'
      ? 'Target is a post-login or account-bound function and must run after login/session setup.'
      : `Target needs ${requirement} before the vulnerability action is meaningful.`,
  }));
  const preconditions = [
    ...workflowPreconditions,
    ...targetPreconditions,
  ].filter((item, index, items) => items.findIndex(other =>
    other.name === item.name &&
    other.consumer_endpoint_id === item.consumer_endpoint_id &&
    other.satisfied_by === item.satisfied_by
  ) === index);
  const endpointIds = uniq(nodes.map(node => node.endpoint_id));
  const requiredCapabilities = uniq([
    targetPhase === 'post_auth' ? 'login_session_workflow' : '',
    targetRequirements.some(requirement => ['object_id', 'order_id', 'cart_id', 'paid_order_id', 'payment_state', 'passcode_verified', 'settled_state'].includes(requirement)) ? 'object_state_setup' : '',
    targetRequirements.some(requirement => ['paid_order_id', 'payment_state', 'settled_state'].includes(requirement)) ? 'payment_state_setup' : '',
    ['order_create', 'payment', 'refund', 'cancellation', 'withdrawal', 'transfer', 'wallet_setup', 'payment_method'].includes(targetKind) ? 'stateful_prerequisite_sequence' : '',
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
    missing_preconditions: uniq([...workflowMissing, ...missing]),
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
