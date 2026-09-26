const SENSITIVE_KEYS = new Set([
  'body_base64',
  'authorization', 'proxy_authorization', 'cookie_header', 'cookie', 'cookies', 'set_cookie', 'x_api_key', 'api_key', 'apikey',
  'token', 'access_token', 'refresh_token', 'session', 'sessionid', 'session_id', 'password', 'passwd', 'pwd',
  'secret', 'client_secret', 'credential', 'credentials', 'passcode', 'otp', 'captcha', 'csrf', 'xsrf',
]);

const MAX_DEPTH = 24;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-\s]/g, '_');
  if (SENSITIVE_KEYS.has(normalized)) return true;
  return /(?:^|_)(?:authorization|cookie|password|passwd|passcode|token|secret|api_key)$/.test(normalized);
}

export function sanitizeModelString(input: string): string {
  let value = String(input);
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
  return value;
}

export function sanitizeForAIModel<T>(input: T, depth = 0, seen = new WeakSet<object>()): T {
  if (input === null || input === undefined) return input;
  if (depth > MAX_DEPTH) return '[TRUNCATED_DEPTH]' as T;
  if (typeof input === 'string') return sanitizeModelString(input) as T;
  if (typeof input !== 'object') return input;
  if (seen.has(input as object)) return '[CIRCULAR]' as T;
  seen.add(input as object);

  if (Array.isArray(input)) {
    return input.map(item => sanitizeForAIModel(item, depth + 1, seen)) as T;
  }

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input as Record<string, any>)) {
    out[key] = isSensitiveKey(key) ? '[REDACTED]' : sanitizeForAIModel(value, depth + 1, seen);
  }
  return out as T;
}
