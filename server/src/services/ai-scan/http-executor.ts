import type { AIDiscoveredEndpoint } from './types.js';
import { fetchInTargetScope } from './target-scope.js';
import type { ScanTrafficClass } from './scan-traffic-governor.js';

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string | FormData | URLSearchParams | Record<string, any> | null;
  body_type?: 'json' | 'form' | 'raw' | 'multipart' | 'none';
  cookies?: Record<string, string>;
  timeout_ms?: number;
  traffic_class?: ScanTrafficClass;
}

export interface HttpResponseEvidence {
  ok: boolean;
  status?: number;
  status_text?: string;
  headers: Record<string, string>;
  body_preview: string;
  body_hash: string;
  content_type?: string;
  location?: string;
  duration_ms: number;
  error?: string;
  final_url?: string;
}

export interface HttpPairJudgement {
  changed: boolean;
  status_delta?: string;
  body_similarity: number;
  security_signal: 'positive' | 'negative' | 'inconclusive';
  reasons: string[];
}

const TEXT_LIMIT = 8000;

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function preview(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]+/g, ' ').slice(0, TEXT_LIMIT);
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

function cookieHeader(cookies?: Record<string, string>): string | undefined {
  const pairs = Object.entries(cookies || {}).filter(([, value]) => value !== undefined && value !== null);
  return pairs.length ? pairs.map(([key, value]) => `${key}=${value}`).join('; ') : undefined;
}

function withQuery(url: string, query?: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query || {})) {
    parsed.searchParams.set(key, value);
  }
  return parsed.toString();
}

export function endpointToRequest(endpoint: AIDiscoveredEndpoint, overrides: Partial<HttpRequestSpec> = {}): HttpRequestSpec {
  const url = overrides.url || endpoint.url;
  if (!url) throw new Error(`Endpoint ${endpoint.method} ${endpoint.path} has no absolute URL`);
  return {
    method: overrides.method || endpoint.method || 'GET',
    url,
    headers: overrides.headers || {},
    query: overrides.query || {},
    body: overrides.body ?? null,
    body_type: overrides.body_type || 'none',
    cookies: overrides.cookies || {},
    timeout_ms: overrides.timeout_ms,
  };
}

export async function executeHttpRequest(spec: HttpRequestSpec): Promise<HttpResponseEvidence> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(spec.timeout_ms || 30000)));
  try {
    const headers: Record<string, string> = { ...(spec.headers || {}) };
    const cookie = cookieHeader(spec.cookies);
    if (cookie) headers.cookie = cookie;

    let body: any;
    if (spec.body_type === 'json' && spec.body && typeof spec.body === 'object' && !(spec.body instanceof FormData)) {
      headers['content-type'] = headers['content-type'] || 'application/json';
      body = JSON.stringify(spec.body);
    } else if (spec.body_type === 'form' && spec.body && typeof spec.body === 'object' && !(spec.body instanceof URLSearchParams)) {
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded';
      body = new URLSearchParams(spec.body as Record<string, string>);
    } else if (typeof spec.body === 'string') {
      body = spec.body;
    } else if (spec.body instanceof FormData || spec.body instanceof URLSearchParams) {
      body = spec.body;
    }

    const requestUrl = withQuery(spec.url, spec.query);
    const response = await fetchInTargetScope(requestUrl, {
      method: spec.method.toUpperCase(),
      headers,
      body: ['GET', 'HEAD'].includes(spec.method.toUpperCase()) ? undefined : body,
      signal: controller.signal,
    }, spec.url, { traffic_class: spec.traffic_class });
    const text = await response.text();
    const responseHeaders = headersToObject(response.headers);
    return {
      ok: response.ok,
      status: response.status,
      status_text: response.statusText,
      headers: responseHeaders,
      body_preview: preview(text),
      body_hash: fnv1a(text),
      content_type: responseHeaders['content-type'],
      location: responseHeaders.location,
      duration_ms: Date.now() - started,
      final_url: response.url,
    };
  } catch (error: any) {
    return {
      ok: false,
      headers: {},
      body_preview: '',
      body_hash: fnv1a(''),
      duration_ms: Date.now() - started,
      error: error?.name === 'AbortError' ? 'request_timeout' : (error?.message || String(error)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function compareResponses(normal: HttpResponseEvidence, mutated: HttpResponseEvidence): HttpPairJudgement {
  const reasons: string[] = [];
  const normalBody = normal.body_preview || '';
  const mutatedBody = mutated.body_preview || '';
  const max = Math.max(normalBody.length, mutatedBody.length, 1);
  let same = 0;
  for (let i = 0; i < Math.min(normalBody.length, mutatedBody.length); i += 1) {
    if (normalBody[i] === mutatedBody[i]) same += 1;
  }
  const similarity = same / max;
  const changed = normal.status !== mutated.status || normal.body_hash !== mutated.body_hash;
  if (normal.status !== mutated.status) reasons.push(`HTTP status changed ${normal.status ?? 'n/a'} -> ${mutated.status ?? 'n/a'}`);
  if (normal.body_hash !== mutated.body_hash) reasons.push('Response body changed under mutation');

  const dangerText = `${mutated.body_preview} ${JSON.stringify(mutated.headers)}`;
  if (/root:|uid=|gid=|<script|onerror=|onload=|ORA-|SQL syntax|Stack trace|Exception|Warning:|java\.lang|javax\.|cmd|command not found|No such file|Permission denied/i.test(dangerText)) {
    reasons.push('Mutated response contains sensitive error/execution/XSS signal');
    return { changed, status_delta: normal.status === mutated.status ? undefined : `${normal.status}->${mutated.status}`, body_similarity: similarity, security_signal: 'positive', reasons };
  }
  if (mutated.status && mutated.status >= 200 && mutated.status < 300 && changed) {
    reasons.push('Mutation was accepted with a 2xx response and changed output');
    return { changed, status_delta: normal.status === mutated.status ? undefined : `${normal.status}->${mutated.status}`, body_similarity: similarity, security_signal: 'inconclusive', reasons };
  }
  if (mutated.status && [400, 401, 403, 404, 405, 415, 422].includes(mutated.status)) {
    reasons.push('Mutation appears rejected by server');
    return { changed, status_delta: normal.status === mutated.status ? undefined : `${normal.status}->${mutated.status}`, body_similarity: similarity, security_signal: 'negative', reasons };
  }
  return { changed, status_delta: normal.status === mutated.status ? undefined : `${normal.status}->${mutated.status}`, body_similarity: similarity, security_signal: 'inconclusive', reasons };
}

export function absoluteUrl(baseUrl: string, candidate: string): string {
  return new URL(candidate, baseUrl).toString();
}
