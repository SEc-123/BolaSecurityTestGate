const SENSITIVE_KEYS = new Set([
  'body_base64',
  'authorization', 'proxy_authorization', 'cookie_header', 'cookie', 'cookies', 'set_cookie', 'x_api_key', 'api_key', 'apikey',
  'token', 'access_token', 'refresh_token', 'session', 'sessionid', 'session_id', 'password', 'passwd', 'pwd',
  'secret', 'client_secret', 'credential', 'credentials', 'passcode', 'otp', 'captcha', 'csrf', 'xsrf',
]);

const MAX_DEPTH = 24;

// A model can reason about a route without receiving the instance-specific
// object, tenant, callback, or authorization value embedded in it. Keep this
// deliberately small and explicit: every other path segment is an opaque
// value, even when it happens to look harmless.
const MODEL_ROUTE_WORDS = new Set([
  'api', 'v1', 'v2', 'v3', 'auth', 'login', 'logout', 'register', 'signup',
  'profile', 'account', 'accounts', 'user', 'users', 'order', 'orders',
  'cart', 'checkout', 'payment', 'payments', 'item', 'items', 'product',
  'products', 'search', 'upload', 'download', 'file', 'files', 'note',
  'notes', 'settings', 'session', 'sessions', 'health', 'status', 'callback',
  'confirm', 'verify', 'reset', 'forgot', 'me', 'self', 'create', 'update',
  'delete', 'list', 'detail', 'details', 'history', 'admin', 'management',
]);

const URL_FIELD = /^(?:url|current_url|final_url|base_url|source_url|target_url|origin_url|href|location)$/i;
const ROUTE_FIELD = /^(?:path|endpoint_path|current_path|source_ref|action)$/i;

function safeRouteSegment(segment: string): string {
  let decoded = segment;
  try { decoded = decodeURIComponent(segment); } catch { /* keep opaque */ }
  return MODEL_ROUTE_WORDS.has(decoded.toLowerCase()) ? decoded.toLowerCase() : ':value';
}

function safeQueryKey(key: string): string {
  let decoded = key;
  try { decoded = decodeURIComponent(key); } catch { return ':param'; }
  // Query names are useful schema metadata, but do not let a query name itself
  // act as an arbitrary data transport channel.
  return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(decoded) ? decoded : ':param';
}

/**
 * Projection used only on the model transport boundary. It preserves the
 * authorized origin, route shape, and query *names*, while intentionally
 * dropping every query value, fragment, and non-allowlisted path segment.
 */
export function projectModelUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const raw = value.trim();
  if (raw === 'about:blank') return raw;
  let url: URL;
  let absolute = false;
  try {
    url = new URL(raw);
    absolute = /^https?:$/i.test(url.protocol);
  } catch {
    // Endpoint paths and form actions can be relative. They need the same
    // shape projection, but must not acquire the synthetic parser origin.
    if (!raw.startsWith('/') && !raw.startsWith('?')) return '[URL omitted]';
    try { url = new URL(raw, 'https://model-url.invalid'); } catch { return '[URL omitted]'; }
  }
  if (!/^https?:$/i.test(url.protocol)) return '[URL omitted]';
  const path = url.pathname.split('/').map(part => part ? safeRouteSegment(part) : part).join('/') || '/';
  const keys = [...new Set([...url.searchParams.keys()].map(safeQueryKey))].slice(0, 32);
  return `${absolute ? url.origin : ''}${path}${keys.length ? `?${keys.map(key => encodeURIComponent(key)).join('&')}` : ''}`;
}

function looksLikeUrlOrRoute(value: unknown): value is string {
  return typeof value === 'string' && (/^https?:\/\//i.test(value) || value.startsWith('/') || value.startsWith('?'));
}

function projectEmbeddedUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/gi, candidate => projectModelUrl(candidate) || '[URL omitted]');
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return /(?:^|_)(?:authorization|cookie|password|passwd|passcode|token|secret|api_key)$/.test(normalized);
}

export function sanitizeModelString(input: string): string {
  let value = String(input);
  // Planner and judge messages often carry a JSON document as the message
  // string. Redacting that serialized text with regular expressions can leave
  // an unescaped replacement inside a quoted JSON value (for example around a
  // session_id), which makes an otherwise safe provider request unparsable.
  // Decode object/array documents first so sensitive values are redacted by
  // key, then serialize the safe structure again. Plain prose continues
  // through the bounded text redaction below.
  const trimmed = value.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return JSON.stringify(sanitizeForAIModel(parsed));
    } catch {
      // Not a complete JSON document. Treat it as prose and retain the
      // existing defensive text sanitization path.
    }
  }
  const linePatterns = [
    /^(\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)\s*:\s*).+$/gim,
  ];
  for (const pattern of linePatterns) value = value.replace(pattern, '$1[REDACTED]');
  // Native identity variables serialize header objects into scalar JSON values.
  // Those cookies must be redacted before the value reaches an AI/report context.
  value=value.replace(/("(?:authorization|cookie|cookie_header|set-cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,'$1"[REDACTED]"');

  value = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/((?:password|passwd|pwd|passcode|otp|captcha|csrf|xsrf|access_token|refresh_token|api_key|apikey|client_secret|secret|session(?:_id)?|token)\s*["']?\s*[:=]\s*["']?)[^&\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:password|passwd|pwd|passcode|otp|captcha|csrf|xsrf|access_token|refresh_token|api_key|apikey|client_secret|secret|session(?:_id)?|token)=)[^&#\s]+/gi, '$1[REDACTED]');
  return projectEmbeddedUrls(value);
}

export function sanitizeForAIModel<T>(input: T, depth = 0, seen = new WeakSet<object>(), fieldName = ''): T {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return '[TRUNCATED_DEPTH]' as T;
  const routeLike = ROUTE_FIELD.test(fieldName) && looksLikeUrlOrRoute(input);
  if (URL_FIELD.test(fieldName) || routeLike) return (projectModelUrl(input) || '[URL omitted]') as T;
  if (typeof input === 'string') return sanitizeModelString(input) as T;
  if (typeof input !== 'object') return input;
  if (seen.has(input as object)) return '[CIRCULAR]' as T;
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map(item => sanitizeForAIModel(item, depth + 1, seen, fieldName)) as T;
  }

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitizeForAIModel(value, depth + 1, seen, key);
  }
  return out as T;
}
