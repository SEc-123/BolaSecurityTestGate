import { assertScanActive } from './ai-scan/run-control.js';
import { recordRequest, recordResponse, recordError } from './debug-trace.js';
import { fetchInTargetScope, TargetScopeError } from './ai-scan/target-scope.js';

const HEADERS_TO_REMOVE = ['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding', 'proxy-connection', 'upgrade', 'te'];

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADERS_TO_REMOVE.includes(key.toLowerCase())) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Join a captured origin-relative request target to an environment URL.
 *
 * Captures conventionally retain a leading slash while scan/environment URLs
 * may or may not have one. Direct string concatenation turns a perfectly
 * valid `https://target/` + `/path` pair into `https://target//path`; some
 * applications deliberately treat that as a different (or invalid) route.
 * Keep a configured base-path intact, leave query text untouched, and never
 * reinterpret a captured `//host` target as a protocol-relative URL.
 */
export function joinRequestUrl(baseUrl: string, requestPath: string): string {
  const base = String(baseUrl || '').trim();
  const path = String(requestPath || '').trim();
  if (!base) return path;
  if (!path) return base;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function normalizeRequestPath(rawPath: string): string {
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    try {
      const url = new URL(rawPath);
      return url.pathname + url.search;
    } catch {
      return rawPath;
    }
  }
  return rawPath;
}

export function parseRawRequest(rawRequest: string): {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
} | null {
  try {
    const lines = rawRequest.split('\n');
    if (lines.length === 0) return null;

    const firstLine = lines[0].trim();
    // A raw request snapshot must begin with a complete HTTP request line.
    // Treating arbitrary prose as ``METHOD path`` can turn a malformed
    // snapshot into an unintended request against the target environment.
    const requestLine = firstLine.match(/^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)\s+(\S+)\s+(HTTP\/\d+(?:\.\d+)?)$/i);
    if (!requestLine) return null;

    const method = requestLine[1].toUpperCase();
    const rawPath = requestLine[2];
    if (!(rawPath === '*' || rawPath.startsWith('/') || /^https?:\/\//i.test(rawPath) || (method === 'CONNECT' && /^[^/\s:]+:\d+$/.test(rawPath)))) return null;
    const path = normalizeRequestPath(rawPath);
    let headers: Record<string, string> = {};
    let bodyStartIndex = -1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        bodyStartIndex = i + 1;
        break;
      }
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        if (key && value) headers[key] = value;
      }
    }

    headers = sanitizeHeaders(headers);

    let body: string | undefined;
    if (bodyStartIndex > 0 && bodyStartIndex < lines.length) {
      body = lines.slice(bodyStartIndex).join('\n').trim();
      if (body === '') body = undefined;
    }

    return { method, path, headers, body };
  } catch {
    return null;
  }
}

export function detectContentType(headers: Record<string, string>, body?: string): string {
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  if (contentType.includes('application/json')) return 'json';
  if (contentType.includes('application/x-www-form-urlencoded')) return 'form_urlencoded';
  if (contentType.includes('multipart/form-data')) return 'multipart';
  if (body) {
    try {
      JSON.parse(body);
      return 'json';
    } catch {
      if (body.includes('=') && (body.includes('&') || !body.includes('\n'))) {
        return 'form_urlencoded';
      }
    }
  }
  return 'text';
}

export function applyJsonBodyReplacement(
  body: string,
  jsonPath: string,
  value: string,
  operationType: 'replace' | 'append' = 'replace',
  originalValue: string = ''
): string {
  try {
    const bodyObj = JSON.parse(body);
    const pathParts = jsonPath.replace(/^body\./, '').split('.');
    let current: any = bodyObj;

    for (let i = 0; i < pathParts.length - 1; i++) {
      if (current[pathParts[i]] === undefined) {
        current[pathParts[i]] = {};
      }
      current = current[pathParts[i]];
    }

    const lastKey = pathParts[pathParts.length - 1];
    if (operationType === 'replace') {
      const before=current[lastKey];
      current[lastKey]=typeof before==='number' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))?Number(value):typeof before==='boolean'&&['true','false'].includes(value)?value==='true':value;
    } else {
      current[lastKey] = String(current[lastKey] || originalValue) + value;
    }
    return JSON.stringify(bodyObj);
  } catch {
    return body;
  }
}

export function applyFormUrlencodedReplacement(
  body: string,
  jsonPath: string,
  value: string,
  operationType: 'replace' | 'append' = 'replace',
  originalValue: string = ''
): string {
  const fieldName = jsonPath.replace(/^body\./, '');
  const params = new URLSearchParams(body);
  if (operationType === 'replace') {
    params.set(fieldName, value);
  } else {
    params.set(fieldName, (params.get(fieldName) || originalValue) + value);
  }
  return params.toString();
}

export function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=([^;]+)/);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

export function applyMultipartReplacement(
  body: string,
  headers: Record<string, string>,
  jsonPath: string,
  value: string
): string {
  const contentType = headers['content-type'] || headers['Content-Type'] || '';
  const boundary = extractBoundary(contentType);
  if (!boundary) return body;

  const fieldName = jsonPath.replace(/^body\./, '');
  const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const updatedParts = parts.map(part => {
    if (part.includes(`name="${fieldName}"`) || part.includes(`name=${fieldName}`)) {
      const headerEnd = part.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        return part.substring(0, headerEnd) + '\r\n\r\n' + value;
      }
    }
    return part;
  });

  return updatedParts.join(`--${boundary}`);
}

export function applyTextReplacement(body: string, jsonPath: string, value: string): string {
  if (jsonPath.startsWith('regex:')) {
    try {
      return body.replace(new RegExp(jsonPath.substring(6), 'g'), value);
    } catch {
      return body;
    }
  }
  const key = jsonPath.replace(/^body\./, '');
  return body.replace(
    new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([^&\\n\\r]+)`, 'g'),
    `${key}=${value}`
  );
}

function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;

  for (const segment of cookieHeader.split(';')) {
    const [rawName, ...rest] = segment.split('=');
    const name = rawName?.trim();
    const value = rest.join('=').trim();
    if (name) {
      result[name] = value;
    }
  }

  return result;
}

function serializeCookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

export function applyPathReplacement(
  path: string,
  varName: string,
  value: string,
  mode: string = 'placeholder',
  segmentIndex?: number,
  regexPattern?: string
): string {
  switch (mode) {
    case 'placeholder':
      return path.replace(new RegExp(`{${varName}}`.replace(/[{}]/g, '\\$&'), 'g'), value);
    case 'segment_index':
      if (segmentIndex === undefined) return path;
      const [pathOnly, queryString = ''] = path.split('?');
      const segments = pathOnly.split('/').filter(segment => segment.length > 0);
      if (segmentIndex >= 0 && segmentIndex < segments.length) {
        segments[segmentIndex] = value;
      }
      return `/${segments.join('/')}${queryString ? `?${queryString}` : ''}`;
    case 'regex':
      if (!regexPattern) return path;
      try {
        return path.replace(new RegExp(regexPattern), value);
      } catch {
        return path;
      }
    default:
      return path;
  }
}

export function applyVariableToRequest(
  parsedRequest: { method: string; path: string; headers: Record<string, string>; body?: string },
  jsonPath: string,
  value: string,
  advancedConfig?: {
    body_content_type?: string;
    path_replacement_mode?: string;
    path_segment_index?: number;
    path_regex_pattern?: string;
    operation_type?: 'replace' | 'append';
    original_value?: string;
    value_template?: string;
  }
): { method: string; path: string; headers: Record<string, string>; body?: string } {
  const result = {
    ...parsedRequest,
    headers: { ...parsedRequest.headers },
    body: parsedRequest.body,
    path: parsedRequest.path,
  };

  const operationType = advancedConfig?.operation_type || 'replace';
  const originalValue = advancedConfig?.original_value || '';
  const effectiveValue = advancedConfig?.value_template
    ? advancedConfig.value_template.replace(/\{\{\s*value\s*\}\}/g, value)
    : value;

  if(jsonPath==='identity.session'){
    const identity=JSON.parse(effectiveValue);
    if(!identity||typeof identity!=='object'||Array.isArray(identity))throw new Error('Invalid identity session binding.');
    const allowed=Object.entries(identity).filter(([key])=>['authorization','cookie'].includes(key.toLowerCase()));
    if(!allowed.length||allowed.some(([,v])=>typeof v!=='string'||/[\r\n]/.test(v)))throw new Error('Missing or invalid real session material.');
    for(const key of Object.keys(result.headers))if(['authorization','cookie'].includes(key.toLowerCase()))delete result.headers[key];
    for(const [key,value] of allowed)result.headers[key.toLowerCase()]=String(value);
    return result;
  }
  if (jsonPath.startsWith('body.') && result.body) {
    const contentType = advancedConfig?.body_content_type || detectContentType(result.headers, result.body);
    switch (contentType) {
      case 'json':
        result.body = applyJsonBodyReplacement(result.body, jsonPath, effectiveValue, operationType, originalValue);
        break;
      case 'form_urlencoded':
        result.body = applyFormUrlencodedReplacement(result.body, jsonPath, effectiveValue, operationType, originalValue);
        break;
      case 'multipart':
        result.body = applyMultipartReplacement(result.body, result.headers, jsonPath, effectiveValue);
        break;
      case 'text':
        result.body = applyTextReplacement(result.body, jsonPath, effectiveValue);
        break;
      default:
        result.body = applyJsonBodyReplacement(result.body, jsonPath, effectiveValue, operationType, originalValue);
      }
    } else if (jsonPath.startsWith('path.')) {
      // Captured REST parameters address the original slash-delimited segment;
      // preserve empty segments and the query instead of inventing placeholders.
      const capturedSegment=jsonPath.match(/^path\.__bstg_segment_(\d+)$/);
      if(capturedSegment){
        const queryAt=result.path.indexOf('?');
        const pathOnly=queryAt<0?result.path:result.path.slice(0,queryAt);
        const segments=pathOnly.split('/'),index=Number(capturedSegment[1]);
        if(index>0&&index<segments.length)segments[index]=encodeURIComponent(effectiveValue);
        result.path=segments.join('/')+(queryAt<0?'':result.path.slice(queryAt));
        return result;
      }
      result.path = applyPathReplacement(
        result.path,
        jsonPath.replace('path.', ''),
        effectiveValue,
        advancedConfig?.path_replacement_mode || 'placeholder',
        advancedConfig?.path_segment_index,
        advancedConfig?.path_regex_pattern
      );
    } else if (jsonPath.startsWith('headers.')) {
      const requestedName=jsonPath.replace('headers.', '');
      const headerName=Object.keys(result.headers).find(key=>key.toLowerCase()===requestedName.toLowerCase())||requestedName;
      for(const key of Object.keys(result.headers))if(key!==headerName&&key.toLowerCase()===headerName.toLowerCase())delete result.headers[key];
      if (operationType === 'replace') {
        result.headers[headerName] = effectiveValue;
      } else {
        result.headers[headerName] = (result.headers[headerName] || originalValue) + effectiveValue;
      }
    } else if (jsonPath.startsWith('cookies.')) {
      const cookieName = jsonPath.replace('cookies.', '');
      const existingCookieHeader = result.headers['Cookie'] || result.headers['cookie'] || '';
      const cookies = parseCookieHeader(existingCookieHeader);
      if (operationType === 'replace') {
        cookies[cookieName] = effectiveValue;
      } else {
        cookies[cookieName] = (cookies[cookieName] || originalValue) + effectiveValue;
      }
      const serialized = serializeCookieHeader(cookies);
      if (serialized) {
        for(const key of Object.keys(result.headers))if(key.toLowerCase()==='cookie')delete result.headers[key];
        result.headers['Cookie'] = serialized;
      }
    } else if (jsonPath.startsWith('query.')) {
      try {
        const urlObj = new URL(result.path, 'http://placeholder');
        const paramName = jsonPath.replace('query.', '');
        if (operationType === 'replace') {
          urlObj.searchParams.set(paramName, effectiveValue);
        } else {
          urlObj.searchParams.set(paramName, (urlObj.searchParams.get(paramName) || originalValue) + effectiveValue);
        }
        result.path = urlObj.pathname + urlObj.search;
      } catch {}
  }

  return result;
}

export interface FailurePattern {
  type: 'response_code' | 'response_message' | 'http_status' | 'response_header';
  path?: string;
  operator: 'equals' | 'contains' | 'regex' | 'not_equals' | 'not_contains';
  value: string;
}

export function checkFailurePatterns(
  patterns: FailurePattern[],
  logic: 'OR' | 'AND',
  statusCode: number,
  responseBody: string,
  responseHeaders: Record<string, string>
): boolean {
  if (!patterns || patterns.length === 0) return false;

  let parsedBody: any = null;
  try {
    parsedBody = JSON.parse(responseBody);
  } catch {}

  const results = patterns.map(pattern => {
    let targetValue = '';

    if (pattern.type === 'http_status') {
      targetValue = statusCode.toString();
    } else if (pattern.type === 'response_header' && pattern.path) {
      targetValue = responseHeaders[pattern.path] || responseHeaders[pattern.path.toLowerCase()] || '';
    } else if ((pattern.type === 'response_code' || pattern.type === 'response_message') && parsedBody && pattern.path) {
      let current = parsedBody;
      for (const part of pattern.path.split('.')) {
        if (current === null || current === undefined) break;
        current = current[part];
      }
      targetValue = String(current ?? '');
    }

    switch (pattern.operator) {
      case 'equals': return targetValue === pattern.value;
      case 'not_equals': return targetValue !== pattern.value;
      case 'contains': return targetValue.includes(pattern.value);
      case 'not_contains': return !targetValue.includes(pattern.value);
      case 'regex':
        try { return new RegExp(pattern.value).test(targetValue); }
        catch { return false; }
    }

    return false;
  });

  return logic === 'OR' ? results.some(r => r) : results.every(r => r);
}

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 2,
  debugMeta?: {
    step_order?: number;
    step_id?: string;
    template_id?: string;
    template_name?: string;
    label?: string;
    account_id?: string;
    auth_context_generation?: string;
  }
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const startTime = Date.now();
    let recordIndex = -1;

    try {
      const method = (options.method || 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      if (options.headers) {
        if (options.headers instanceof Headers) {
          options.headers.forEach((value, key) => {
            headers[key] = value;
          });
        } else if (Array.isArray(options.headers)) {
          options.headers.forEach(([key, value]) => {
            headers[key] = value;
          });
        } else {
          Object.assign(headers, options.headers);
        }
      }

      let bodyStr: string | undefined;
      if (options.body) {
        if (typeof options.body === 'string') {
          bodyStr = options.body;
        } else {
          try {
            bodyStr = JSON.stringify(options.body);
          } catch {
            bodyStr = String(options.body);
          }
        }
      }

      recordIndex = recordRequest(method, url, headers, bodyStr, debugMeta);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetchInTargetScope(url, {
        ...options,
        signal: controller.signal,
      }, url);

      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody: string | undefined;
      try {
        const clonedResponse = response.clone();
        responseBody = await clonedResponse.text();
      } catch (err) {
        responseBody = '[Failed to read response body]';
      }

      if (recordIndex >= 0) {
        recordResponse(
          recordIndex,
          {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: responseBody,
          },
          duration,
          attempt
        );
      }

      assertScanActive();
      return response;
    } catch (error: any) {
      assertScanActive();
      lastError = error;
      const duration = Date.now() - startTime;

      if (recordIndex >= 0) {
        recordError(recordIndex, error.message || String(error), duration, attempt);
      }

      if (error instanceof TargetScopeError) throw error;

      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

export function extractValueByJsonPath(obj: any, jsonPath: string): any {
  const path = jsonPath.replace(/^\$\.?/, '');
  if (!path) return obj;

  let current = obj;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;

    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      current = current[arrayMatch[1]];
      if (Array.isArray(current)) {
        current = current[parseInt(arrayMatch[2])];
      } else {
        return undefined;
      }
    } else {
      current = current[part];
    }
  }

  return current;
}
