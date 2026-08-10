import { getScanTrafficAbortSignal, withScanTrafficPermit, type ScanTrafficClass } from './scan-traffic-governor.js';
export class TargetScopeError extends Error {
  readonly code = 'TARGET_SCOPE_VIOLATION';

  constructor(message: string) {
    super(message);
    this.name = 'TargetScopeError';
  }
}

export interface TargetScope {
  base_url: string;
  origin: string;
}

export interface ScopedFetchOptions {
  max_redirects?: number;
  on_response?: (response: Response, requestUrl: string, redirectIndex: number) => void | Promise<void>;
  traffic_class?: ScanTrafficClass;
}

function requireHttpProtocol(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetScopeError(`Unsupported target protocol: ${url.protocol || 'unknown'}. Only http/https targets are allowed.`);
  }
}

export function normalizeTargetBaseUrl(value: string): string {
  const raw = String(value || '').trim();
  if (!raw) throw new TargetScopeError('base_url is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetScopeError('base_url must be an absolute http/https URL');
  }
  requireHttpProtocol(url);
  if (url.username || url.password) {
    throw new TargetScopeError('Credentials embedded in base_url are not allowed; configure authentication through BSTG account/session features instead.');
  }
  url.hash = '';
  return url.toString();
}

export function createTargetScope(baseUrl: string): TargetScope {
  const normalized = normalizeTargetBaseUrl(baseUrl);
  const parsed = new URL(normalized);
  return { base_url: normalized, origin: parsed.origin };
}

export function assertUrlInTargetScope(candidate: string, scopeBaseUrl: string): URL {
  const scope = createTargetScope(scopeBaseUrl);
  let parsed: URL;
  try {
    parsed = new URL(candidate, scope.base_url);
  } catch {
    throw new TargetScopeError(`Invalid target URL: ${candidate}`);
  }
  requireHttpProtocol(parsed);
  if (parsed.username || parsed.password) {
    throw new TargetScopeError(`Target URL contains embedded credentials: ${parsed.origin}`);
  }
  if (parsed.origin !== scope.origin) {
    throw new TargetScopeError(`Out-of-scope target URL blocked: ${parsed.origin}; allowed origin is ${scope.origin}`);
  }
  return parsed;
}

export function isUrlInTargetScope(candidate: string, scopeBaseUrl: string): boolean {
  try {
    assertUrlInTargetScope(candidate, scopeBaseUrl);
    return true;
  } catch {
    return false;
  }
}

export function isBrowserResourceInTargetScope(candidate: string, scopeBaseUrl: string): boolean {
  try {
    const parsed = new URL(candidate, scopeBaseUrl);
    if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return true;
    return isUrlInTargetScope(parsed.toString(), scopeBaseUrl);
  } catch {
    return false;
  }
}

function mergedAbortSignal(requestSignal?: AbortSignal | null): AbortSignal | undefined {
  const toolSignal = getScanTrafficAbortSignal();
  if (!requestSignal) return toolSignal;
  if (!toolSignal || requestSignal === toolSignal) return requestSignal;
  return AbortSignal.any([requestSignal, toolSignal]);
}

function redirectMethodAndBody(status: number, method: string, body: BodyInit | null | undefined): { method: string; body: BodyInit | null | undefined; stripContentHeaders: boolean } {
  const upper = method.toUpperCase();
  if (status === 303 && upper !== 'HEAD') return { method: 'GET', body: undefined, stripContentHeaders: true };
  if ((status === 301 || status === 302) && upper === 'POST') return { method: 'GET', body: undefined, stripContentHeaders: true };
  return { method: upper, body, stripContentHeaders: false };
}

export async function fetchInTargetScope(
  candidate: string,
  init: RequestInit = {},
  scopeBaseUrl: string = candidate,
  options: ScopedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = Math.max(0, Number(options.max_redirects ?? 8));
  let currentUrl = assertUrlInTargetScope(candidate, scopeBaseUrl).toString();
  let currentMethod = String(init.method || 'GET').toUpperCase();
  let currentBody = init.body;
  let currentHeaders = new Headers(init.headers || {});

  for (let redirectIndex = 0; ; redirectIndex += 1) {
    const response = await withScanTrafficPermit({
      url: currentUrl,
      method: currentMethod,
      traffic_class: options.traffic_class,
    }, () => fetch(currentUrl, {
      ...init,
      method: currentMethod,
      headers: currentHeaders,
      body: ['GET', 'HEAD'].includes(currentMethod) ? undefined : currentBody,
      redirect: 'manual',
      signal: mergedAbortSignal(init.signal),
    }));
    await options.on_response?.(response, currentUrl, redirectIndex);

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectIndex >= maxRedirects) {
      throw new TargetScopeError(`Too many redirects while requesting ${candidate}; maximum is ${maxRedirects}`);
    }

    const nextUrl = assertUrlInTargetScope(new URL(location, currentUrl).toString(), scopeBaseUrl).toString();
    const redirectState = redirectMethodAndBody(response.status, currentMethod, currentBody);
    currentMethod = redirectState.method;
    currentBody = redirectState.body;
    if (redirectState.stripContentHeaders) {
      currentHeaders = new Headers(currentHeaders);
      currentHeaders.delete('content-length');
      currentHeaders.delete('content-type');
      currentHeaders.delete('content-encoding');
    }
    currentUrl = nextUrl;
  }
}
