import { isDeepStrictEqual } from 'node:util';
import type { NormalizedHttpFlow } from './mobile-types.js';

export interface JsonAssertion { pointer: string; equals?: unknown; exists?: boolean; }
export interface MessageExpectation { headers?: Record<string, string>; json?: JsonAssertion[]; body_contains?: string; }
export interface NetworkExpectation {
  id: string; method: string; url: string; request?: MessageExpectation;
  response: MessageExpectation & { status: number | number[] };
  min_count?: number; max_count?: number;
}
export interface StepCaptureScope { run_id: string; step_id: string; capture_session_id: string; device_id: string; app_package: string; started_at: string; }
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function messageShape(value: unknown, response = false): string[] {
  if (!object(value)) return ['Request/response expectation must be an object.'];
  const errors: string[] = [];
  if (Object.keys(value).some(key => !['headers','json','body_contains',...(response ? ['status'] : [])].includes(key))) errors.push('Unknown network message assertion field.');
  if (value.headers !== undefined && (!object(value.headers) || Object.values(value.headers).some(v => typeof v !== 'string'))) errors.push('Expected headers must be a string map.');
  if (value.body_contains !== undefined && (typeof value.body_contains !== 'string' || !value.body_contains || value.body_contains.length > 8192)) errors.push('body_contains must be a nonempty string of at most 8192 characters.');
  if (value.json !== undefined) {
    if (!Array.isArray(value.json) || !value.json.length || value.json.length > 100) errors.push('json requires 1–100 JSON Pointer assertions.');
    else for (const a of value.json) {
      if (!object(a) || typeof a.pointer !== 'string' || a.pointer !== '' && !a.pointer.startsWith('/') || /~(?![01])/u.test(a.pointer || '') || Object.keys(a).some(k => !['pointer','equals','exists'].includes(k)) || !(Object.hasOwn(a,'equals') || typeof a.exists === 'boolean') || a.exists !== undefined && typeof a.exists !== 'boolean') errors.push('Invalid JSON Pointer assertion; use pointer and equals/exists.');
    }
  }
  return errors;
}
export function validateNetworkExpectations(value: unknown, allowedHosts?: string[]): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 30) return ['expect_network must contain 1–30 explicit HTTPS expectations.'];
  const errors: string[] = [], ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const fail = (s: string) => errors.push(`Network assertion ${index + 1}: ${s}`);
    if (!object(item)) { fail('must be an object.'); continue; }
    if (Object.keys(item).some(k => !['id','method','url','request','response','min_count','max_count'].includes(k))) fail('Unknown field.');
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(item.id) || ids.has(item.id)) fail('id must be unique and contain 1–80 safe characters.');
    ids.add(item.id);
    if (!['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(item.method)) fail('method must be an explicit uppercase HTTP method.');
    try {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('url must be HTTPS without credentials or fragment.');
      if (allowedHosts && !allowedHosts.map(h => h.toLowerCase()).includes(url.hostname.toLowerCase())) fail('URL is outside capture_allowed_hosts.');
    } catch { fail('A valid absolute HTTPS URL is required.'); }
    if (item.request !== undefined) errors.push(...messageShape(item.request));
    errors.push(...messageShape(item.response, true));
    const statuses = Array.isArray(item.response?.status) ? item.response.status : [item.response?.status];
    if (!statuses.length || statuses.some((s: unknown) => !Number.isInteger(s) || Number(s) < 100 || Number(s) > 599)) fail('response.status must be an HTTP status or nonempty array.');
    for (const key of ['min_count','max_count']) if (item[key] !== undefined && (!Number.isInteger(item[key]) || item[key] < 1 || item[key] > 1000)) fail(`${key} must be an integer between 1 and 1000.`);
    if (item.max_count !== undefined && item.max_count < (item.min_count ?? 1)) fail('max_count cannot be less than min_count.');
  }
  return errors;
}
function readPointer(root: unknown, pointer: string): { exists: boolean; value?: unknown } {
  if (pointer === '') return { exists: true, value: root };
  let current: any = root;
  for (const token of pointer.slice(1).split('/').map(t => t.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) return { exists: false };
    current = current[token];
  }
  return { exists: true, value: current };
}
function messageFailure(expected: MessageExpectation | undefined, headers: Record<string, any> | undefined, text: string | undefined): string | undefined {
  if (!expected) return undefined;
  if (expected.headers) {
    const actual = Object.fromEntries(Object.entries(headers || {}).map(([k,v]) => [k.toLowerCase(),String(v)]));
    for (const [key, value] of Object.entries(expected.headers)) if (actual[key.toLowerCase()] !== value) return 'header_mismatch';
  }
  if (expected.body_contains !== undefined && (typeof text !== 'string' || !text.includes(expected.body_contains))) return 'body_assertion_failed';
  if (expected.json) {
    let json: unknown;
    try { if (typeof text !== 'string') throw new Error(); json = JSON.parse(text); } catch { return 'body_not_valid_json'; }
    for (const assertion of expected.json) {
      const result = readPointer(json, assertion.pointer);
      if (assertion.exists !== undefined && assertion.exists !== result.exists) return 'json_presence_mismatch';
      if (Object.hasOwn(assertion, 'equals') && (!result.exists || !isDeepStrictEqual(result.value, assertion.equals))) return 'json_value_mismatch';
    }
  }
  return undefined;
}
export function tlsCompletenessFailure(flow: NormalizedHttpFlow): string | undefined {
  if (flow.tls_decrypted !== true || !flow.url.startsWith('https://')) return 'not_decrypted_https';
  if (!flow.tls?.client_version || !flow.tls?.server_version || flow.tls.upstream_verified !== true) return 'tls_transport_not_verified_on_both_legs';
  if (flow.request_complete !== true || flow.response_complete !== true) return 'incomplete_request_or_response';
  if (flow.request_body_text === undefined || flow.response_body_text === undefined) return 'non_text_or_missing_body_requires_binary_test_adapter';
  return undefined;
}
export function evaluateNetworkExpectations(expectations: NetworkExpectation[], flows: NormalizedHttpFlow[], scope: StepCaptureScope) {
  const inScope = flows.filter(f => f.test_run_id === scope.run_id && f.step_id === scope.step_id && f.capture_session_id === scope.capture_session_id && f.device_id === scope.device_id && f.app_package === scope.app_package && Date.parse(f.started_at || '') >= Date.parse(scope.started_at));
  const results = expectations.map(expected => {
    const target = new URL(expected.url).href;
    const candidates = inScope.filter(f => f.method === expected.method && (() => { try { return new URL(f.url).href === target; } catch { return false; } })());
    const statuses = Array.isArray(expected.response.status) ? expected.response.status : [expected.response.status];
    const ids = new Set<string>(), matches: NormalizedHttpFlow[] = [], failures: string[] = [];
    for (const f of candidates) {
      if (!f.flow_id) { failures.push('missing_flow_id'); continue; }
      if (ids.has(f.flow_id)) continue;
      ids.add(f.flow_id);
      // A mismatched request cannot satisfy this assertion (e.g. a background
      // refresh or another account), even if its response happens to be 200.
      const reason = tlsCompletenessFailure(f) || messageFailure(expected.request, f.request_headers, f.request_body_text)
        || (!statuses.includes(f.response_status!) ? 'unexpected_response_status' : undefined)
        || messageFailure(expected.response, f.response_headers, f.response_body_text);
      if (reason) failures.push(reason); else matches.push(f);
    }
    if (ids.size < (expected.min_count ?? 1)) failures.push('expected_https_request_not_observed');
    if (expected.max_count !== undefined && ids.size > expected.max_count) failures.push('too_many_matching_requests');
    return { id: expected.id, ok: failures.length === 0 && matches.length >= (expected.min_count ?? 1), method: expected.method, url: expected.url,
      matched_flow_ids: matches.map(f => f.flow_id!), candidate_count: ids.size, failures: [...new Set(failures)] };
  });
  return { ok: results.every(r => r.ok), assertions: results, matched_flow_ids: [...new Set(results.flatMap(r => r.matched_flow_ids))], candidate_flows: inScope.length };
}
