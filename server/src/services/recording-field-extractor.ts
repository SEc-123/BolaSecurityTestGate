import crypto from 'node:crypto';
import type {
  RecordingEvent,
  RecordingFieldHit,
  RecordingFieldTarget,
  RecordingRuntimeContext,
} from '../types/index.js';
import { FieldDictionary } from './field-dictionary.js';

type JsonRecord = Record<string, any>;

type SourceLocation =
  | 'request.path'
  | 'request.query'
  | 'request.header'
  | 'request.cookie'
  | 'request.body'
  | 'response.header'
  | 'response.cookie'
  | 'response.body';

export interface IncomingRecordingFieldTarget {
  name: string;
  aliases?: string[];
  from?: string[];
  from_sources?: string[];
  bind_to_account_field?: string;
  category?: string;
}

export interface IncomingRecordingEvent {
  sequence: number;
  source_tool?: string;
  sourceTool?: string;
  method: string;
  url: string;
  request_headers?: Record<string, unknown>;
  requestHeaders?: Record<string, unknown>;
  request_body_text?: string;
  requestBodyText?: string;
  response_status?: number;
  responseStatus?: number;
  response_headers?: Record<string, unknown>;
  responseHeaders?: Record<string, unknown>;
  response_body_text?: string;
  responseBodyText?: string;
}

export interface PreparedRecordingArtifacts {
  event: Omit<RecordingEvent, 'id' | 'created_at' | 'updated_at'>;
  fieldHits: Array<Omit<RecordingFieldHit, 'id' | 'created_at' | 'updated_at'>>;
  runtimeContexts: Array<Omit<RecordingRuntimeContext, 'id' | 'created_at' | 'updated_at'>>;
}

interface KeyValueEntry {
  key: string;
  path: string;
  value: string;
}

const CONTEXT_KEYWORDS: Array<{ keyword: string; category: string; bind?: string }> = [
  { keyword: 'authorization', category: 'auth_header', bind: 'authorization' },
  { keyword: 'access_token', category: 'access_token', bind: 'access_token' },
  { keyword: 'auth_token', category: 'access_token', bind: 'access_token' },
  { keyword: 'bearer', category: 'access_token', bind: 'access_token' },
  { keyword: 'jwt', category: 'access_token', bind: 'access_token' },
  { keyword: 'session', category: 'session_cookie', bind: 'session_id' },
  { keyword: 'csrf', category: 'csrf', bind: 'csrf_token' },
  { keyword: 'nonce', category: 'flow_ticket', bind: 'nonce' },
  { keyword: 'state', category: 'flow_ticket', bind: 'state' },
  { keyword: 'refresh_token', category: 'refresh_token', bind: 'refresh_token' },
  { keyword: 'token', category: 'access_token', bind: 'access_token' },
];

const SENSITIVE_HEADER_KEYS = ['authorization', 'proxy_authorization', 'x_api_key', 'api_key'];
const SENSITIVE_BODY_KEYS = ['password', 'passwd', 'pwd', 'secret', 'client_secret', 'api_key'];

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function toDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateValue(value: string, max = 160): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function isSensitiveKey(normalizedKey: string, keywords: string[]): boolean {
  return keywords.some(keyword =>
    normalizedKey === keyword ||
    normalizedKey.endsWith(`_${keyword}`) ||
    normalizedKey.startsWith(`${keyword}_`)
  );
}

function redactValue(value?: string): string {
  if (!value) return '[REDACTED]';
  return '[REDACTED]';
}

function parseJsonSafely(value?: string): JsonRecord | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function parseUrlEncodedBody(value?: string): JsonRecord | null {
  if (!value?.trim() || !value.includes('=')) return null;
  const params = new URLSearchParams(value);
  const result: JsonRecord = {};
  for (const [key, raw] of params.entries()) {
    const current = result[key];
    if (current === undefined) {
      result[key] = raw;
      continue;
    }
    if (Array.isArray(current)) {
      current.push(raw);
      continue;
    }
    result[key] = [current, raw];
  }
  return Object.keys(result).length > 0 ? result : null;
}

function parseBody(value?: string): JsonRecord | null {
  return parseJsonSafely(value) || parseUrlEncodedBody(value);
}

function normalizeHeaders(input?: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  if (!input) return result;

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    result[key.toLowerCase()] = toDisplayValue(value);
  }
  return result;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = isSensitiveKey(normalizeKey(key), SENSITIVE_HEADER_KEYS)
      ? redactValue(value)
      : value;
  }

  return result;
}

function sanitizeCookies(cookies: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(cookies)) {
    const normalized = normalizeKey(key);
    const shouldRedact = normalized.includes('session') ||
      normalized.includes('token') ||
      normalized.includes('auth') ||
      normalized.includes('csrf') ||
      normalized.includes('jwt');
    result[key] = shouldRedact ? redactValue(value) : value;
  }
  return result;
}

function parseCookiesFromCookieHeader(headerValue?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headerValue) return result;

  for (const segment of headerValue.split(';')) {
    const [rawName, ...rest] = segment.split('=');
    const name = rawName?.trim();
    const value = rest.join('=').trim();
    if (name) {
      result[name] = value;
    }
  }
  return result;
}

function parseCookiesFromSetCookie(headerValue?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headerValue) return result;

  const parts = headerValue.split(/,(?=[^;,]+=)/);
  for (const part of parts) {
    const firstSegment = part.split(';')[0];
    const [rawName, ...rest] = firstSegment.split('=');
    const name = rawName?.trim();
    const value = rest.join('=').trim();
    if (name) {
      result[name] = value;
    }
  }
  return result;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function flattenObject(input: unknown, prefix = '$'): KeyValueEntry[] {
  if (input === null || input === undefined) return [];

  if (Array.isArray(input)) {
    return input.flatMap((item, index) => flattenObject(item, `${prefix}[${index}]`));
  }

  if (typeof input === 'object') {
    return Object.entries(input as JsonRecord).flatMap(([key, value]) => {
      const nextPrefix = prefix === '$' ? `$.${key}` : `${prefix}.${key}`;
      if (value !== null && typeof value === 'object') {
        return flattenObject(value, nextPrefix);
      }
      return [{
        key,
        path: nextPrefix,
        value: toDisplayValue(value),
      }];
    });
  }

  return [{
    key: prefix.replace(/^\$\./, ''),
    path: prefix,
    value: toDisplayValue(input),
  }];
}

function sanitizeStructuredValue(input: unknown, parentKey?: string): unknown {
  if (Array.isArray(input)) {
    return input.map(item => sanitizeStructuredValue(item, parentKey));
  }

  if (input && typeof input === 'object') {
    const result: JsonRecord = {};
    for (const [key, value] of Object.entries(input as JsonRecord)) {
      const normalized = normalizeKey(key);
      if (isSensitiveKey(normalized, SENSITIVE_BODY_KEYS)) {
        result[key] = redactValue(toDisplayValue(value));
        continue;
      }
      result[key] = sanitizeStructuredValue(value, key);
    }
    return result;
  }

  if (parentKey && isSensitiveKey(normalizeKey(parentKey), SENSITIVE_BODY_KEYS)) {
    return redactValue(toDisplayValue(input));
  }

  return input;
}

function serializeBodyLikeOriginal(original?: string, parsed?: unknown): string | undefined {
  if (!original?.trim()) return original;
  if (parsed === undefined || parsed === null) return original;

  if (parseJsonSafely(original)) {
    return JSON.stringify(parsed);
  }

  if (parseUrlEncodedBody(original)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(parsed as JsonRecord)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          params.append(key, toDisplayValue(item));
        }
      } else {
        params.set(key, toDisplayValue(value));
      }
    }
    return params.toString();
  }

  return original;
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function computeFingerprint(parts: unknown[]): string {
  return hashValue(JSON.stringify(parts));
}

function matchesSource(sourceLocation: SourceLocation, allowedSources: string[]): boolean {
  if (allowedSources.length === 0) return true;

  const compact = sourceLocation.replace('.', '_');
  return allowedSources.some(source => {
    const normalized = source.toLowerCase().replace(/[.\s-]+/g, '_');
    return normalized === compact ||
      compact.startsWith(`${normalized}_`) ||
      normalized === sourceLocation.split('.')[0] ||
      normalized === sourceLocation.split('.')[1];
  });
}

function classifyContextKey(key: string): { category: string; bind_to_account_field?: string } | null {
  const normalized = normalizeKey(key);
  const matched = CONTEXT_KEYWORDS.find(item => normalized.includes(item.keyword));
  if (!matched) return null;
  return {
    category: matched.category,
    bind_to_account_field: matched.bind,
  };
}

export function normalizeRecordingFieldTargets(
  sessionId: string,
  targets: IncomingRecordingFieldTarget[] = []
): Array<Omit<RecordingFieldTarget, 'created_at' | 'updated_at'>> {
  return targets
    .filter(target => target?.name)
    .map((target, index) => {
      const aliases = Array.from(new Set(
        [target.name, ...(target.aliases || [])]
          .map(item => String(item).trim())
          .filter(Boolean)
      ));

      const fromSources = Array.from(new Set(
        [...(target.from_sources || []), ...(target.from || [])]
          .map(item => String(item).trim())
          .filter(Boolean)
      ));

      return {
        id: `${sessionId}_field_${index + 1}`,
        session_id: sessionId,
        name: target.name.trim(),
        aliases,
        from_sources: fromSources,
        bind_to_account_field: target.bind_to_account_field?.trim() || undefined,
        category: target.category?.trim() || undefined,
      };
    });
}

export async function prepareRecordingArtifacts(params: {
  sessionId: string;
  input: IncomingRecordingEvent;
  targets?: Array<Omit<RecordingFieldTarget, 'created_at' | 'updated_at'>>;
  dictionary: FieldDictionary;
}): Promise<PreparedRecordingArtifacts> {
  const { sessionId, input, targets = [], dictionary } = params;
  const method = String(input.method || 'GET').toUpperCase();
  const url = String(input.url || '').trim();
  const parsedUrl = new URL(url);

  const rawRequestHeaders = normalizeHeaders(input.request_headers || input.requestHeaders);
  const rawResponseHeaders = normalizeHeaders(input.response_headers || input.responseHeaders);
  const requestCookies = parseCookiesFromCookieHeader(rawRequestHeaders.cookie || rawRequestHeaders['cookie']);
  const responseCookies = parseCookiesFromSetCookie(rawResponseHeaders['set-cookie']);
  const requestBodyText = input.request_body_text || input.requestBodyText;
  const responseBodyText = input.response_body_text || input.responseBodyText;
  const parsedRequestBody = parseBody(requestBodyText);
  const parsedResponseBody = parseBody(responseBodyText);
  const sanitizedParsedRequestBody = parsedRequestBody ? sanitizeStructuredValue(parsedRequestBody) as JsonRecord : parsedRequestBody;
  const sanitizedParsedResponseBody = parsedResponseBody ? sanitizeStructuredValue(parsedResponseBody) as JsonRecord : parsedResponseBody;
  const sanitizedRequestHeaders = sanitizeHeaders(rawRequestHeaders);
  const sanitizedResponseHeaders = sanitizeHeaders(rawResponseHeaders);
  const sanitizedRequestCookies = sanitizeCookies(requestCookies);
  const sanitizedResponseCookies = sanitizeCookies(responseCookies);
  const sanitizedRequestBodyText = serializeBodyLikeOriginal(requestBodyText, sanitizedParsedRequestBody);
  const sanitizedResponseBodyText = serializeBodyLikeOriginal(responseBodyText, sanitizedParsedResponseBody);

  const queryParams: Record<string, string[]> = {};
  for (const [key, value] of parsedUrl.searchParams.entries()) {
    if (!queryParams[key]) queryParams[key] = [];
    queryParams[key].push(value);
  }

  const fingerprint = computeFingerprint([
    input.sequence,
    method,
    url,
    rawRequestHeaders,
    requestBodyText,
    input.response_status || input.responseStatus || null,
    rawResponseHeaders,
    responseBodyText,
  ]);

  const event: Omit<RecordingEvent, 'id' | 'created_at' | 'updated_at'> = {
    session_id: sessionId,
    sequence: Number(input.sequence),
    fingerprint,
    source_tool: input.source_tool || input.sourceTool,
    method,
    url,
    scheme: parsedUrl.protocol.replace(':', ''),
    host: parsedUrl.host,
    path: parsedUrl.pathname + parsedUrl.search,
    query_params: queryParams,
    request_headers: sanitizedRequestHeaders,
    request_body_text: sanitizedRequestBodyText,
    request_cookies: sanitizedRequestCookies,
    parsed_request_body: sanitizedParsedRequestBody,
    response_status: input.response_status || input.responseStatus,
    response_headers: sanitizedResponseHeaders,
    response_body_text: sanitizedResponseBodyText,
    response_cookies: sanitizedResponseCookies,
    parsed_response_body: sanitizedParsedResponseBody,
    field_hit_count: 0,
  };

  const requestQueryEntries: KeyValueEntry[] = Object.entries(queryParams).flatMap(([key, values]) =>
    values.map(value => ({ key, path: key, value }))
  );
  const requestPathSegments = parsedUrl.pathname
    .split('/')
    .filter(Boolean)
    .map((segment, index) => ({
      key: segment,
      path: `segment.${index}`,
      value: decodePathSegment(segment),
    }));
  const requestHeaderEntries: KeyValueEntry[] = Object.entries(rawRequestHeaders).map(([key, value]) => ({ key, path: key, value }));
  const requestCookieEntries: KeyValueEntry[] = Object.entries(requestCookies).map(([key, value]) => ({ key, path: key, value }));
  const requestBodyEntries = flattenObject(parsedRequestBody);
  const responseHeaderEntries: KeyValueEntry[] = Object.entries(rawResponseHeaders).map(([key, value]) => ({ key, path: key, value }));
  const responseCookieEntries: KeyValueEntry[] = Object.entries(responseCookies).map(([key, value]) => ({ key, path: key, value }));
  const responseBodyEntries = flattenObject(parsedResponseBody);

  const searchAreas: Array<{ location: SourceLocation; entries: KeyValueEntry[] }> = [
    { location: 'request.path', entries: requestPathSegments },
    { location: 'request.query', entries: requestQueryEntries },
    { location: 'request.header', entries: requestHeaderEntries },
    { location: 'request.cookie', entries: requestCookieEntries },
    { location: 'request.body', entries: requestBodyEntries },
    { location: 'response.header', entries: responseHeaderEntries },
    { location: 'response.cookie', entries: responseCookieEntries },
    { location: 'response.body', entries: responseBodyEntries },
  ];

  const fieldHits: Array<Omit<RecordingFieldHit, 'id' | 'created_at' | 'updated_at'>> = [];
  for (const target of targets) {
    const aliases = Array.from(new Set([target.name, ...(target.aliases || [])].map(normalizeKey).filter(Boolean)));
    const allowedSources = (target.from_sources || []).map(source => source.toLowerCase());

    for (const area of searchAreas) {
      if (!matchesSource(area.location, allowedSources)) continue;

      for (const entry of area.entries) {
        const normalizedEntryKey = normalizeKey(entry.key);
        const matchedAlias = aliases.find(alias =>
          normalizedEntryKey === alias ||
          normalizedEntryKey.endsWith(`_${alias}`) ||
          alias.endsWith(`_${normalizedEntryKey}`)
        );

        if (!matchedAlias || !entry.value) continue;

        fieldHits.push({
          session_id: sessionId,
          event_id: '',
          field_name: target.name,
          matched_alias: matchedAlias,
          source_location: area.location,
          source_key: entry.path,
          value_preview: truncateValue(entry.value),
          value_text: entry.value,
          value_hash: hashValue(entry.value),
          bind_to_account_field: target.bind_to_account_field,
          confidence: entry.key === target.name ? 1 : 0.9,
        });
      }
    }

    if (matchesSource('request.path', allowedSources)) {
      const correlatedValues = new Set(
        [
          ...requestQueryEntries,
          ...requestBodyEntries,
          ...responseBodyEntries,
        ]
          .filter(entry => {
            const normalizedEntryKey = normalizeKey(entry.key);
            return aliases.some(alias =>
              normalizedEntryKey === alias ||
              normalizedEntryKey.endsWith(`_${alias}`) ||
              alias.endsWith(`_${normalizedEntryKey}`)
            );
          })
          .map(entry => entry.value)
          .filter(Boolean)
      );

      for (const segment of requestPathSegments) {
        if (!segment.value || !correlatedValues.has(segment.value)) continue;

        fieldHits.push({
          session_id: sessionId,
          event_id: '',
          field_name: target.name,
          matched_alias: target.name,
          source_location: 'request.path',
          source_key: segment.path,
          value_preview: truncateValue(segment.value),
          value_text: segment.value,
          value_hash: hashValue(segment.value),
          bind_to_account_field: target.bind_to_account_field,
          confidence: 0.95,
        });
      }
    }
  }

  const fieldHitKeys = new Set(
    fieldHits.map(hit => `${hit.source_location}::${hit.source_key || ''}::${hit.value_hash || ''}`)
  );

  const contextMap = new Map<string, Omit<RecordingRuntimeContext, 'id' | 'created_at' | 'updated_at'>>();

  for (const area of searchAreas) {
    for (const entry of area.entries) {
      if (!entry.value) continue;

      const dictionaryMatch = dictionary.match(entry.key);
      const explicitClassification = classifyContextKey(entry.key);
      const category = explicitClassification?.category || dictionaryMatch?.category?.toLowerCase();
      if (!category || category === 'noise') continue;

      const bind = explicitClassification?.bind_to_account_field ||
        ((dictionaryMatch?.category === 'IDENTITY' || dictionaryMatch?.category === 'AUTH') ? entry.key : undefined);
      const mapKey = [area.location, entry.key, truncateValue(entry.value)].join('::');

      if (!contextMap.has(mapKey)) {
        contextMap.set(mapKey, {
          session_id: sessionId,
          event_id: '',
          context_key: entry.key,
          category,
          source_location: area.location,
          value_preview: truncateValue(entry.value),
          value_text: entry.value,
          bind_to_account_field: bind,
        });
      }

      const shouldCreateImplicitFieldHit = !!bind && (
        area.location.startsWith('request.') ||
        area.location === 'response.header' ||
        area.location === 'response.body'
      );

      if (shouldCreateImplicitFieldHit) {
        const implicitValueHash = hashValue(entry.value);
        const implicitKey = `${area.location}::${entry.path || ''}::${implicitValueHash}`;
        if (!fieldHitKeys.has(implicitKey)) {
          fieldHits.push({
            session_id: sessionId,
            event_id: '',
            field_name: bind || entry.key,
            matched_alias: normalizeKey(entry.key),
            source_location: area.location,
            source_key: entry.path,
            value_preview: truncateValue(entry.value),
            value_text: entry.value,
            value_hash: implicitValueHash,
            bind_to_account_field: bind,
            confidence: explicitClassification ? 0.95 : 0.8,
          });
          fieldHitKeys.add(implicitKey);
        }
      }
    }
  }

  event.field_hit_count = fieldHits.length;

  return {
    event,
    fieldHits,
    runtimeContexts: Array.from(contextMap.values()),
  };
}
