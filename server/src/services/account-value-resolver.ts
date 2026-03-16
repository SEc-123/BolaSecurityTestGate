import type { Account } from '../types/index.js';

type AccountLike = Pick<Account, 'fields' | 'auth_profile' | 'variables'>;

function normalizeLookupKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toScalarString(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getRecordValue(record: Record<string, any> | undefined, key: string): string | undefined {
  if (!record || !key) return undefined;

  if (Object.prototype.hasOwnProperty.call(record, key)) {
    return toScalarString(record[key]);
  }

  const normalizedKey = normalizeLookupKey(key);
  for (const [entryKey, value] of Object.entries(record)) {
    if (normalizeLookupKey(entryKey) === normalizedKey) {
      return toScalarString(value);
    }
  }

  return undefined;
}

function candidateKeys(fieldName: string): string[] {
  const normalized = normalizeLookupKey(fieldName);
  return Array.from(new Set([
    fieldName,
    normalized,
    fieldName.replace(/^recording\./, ''),
    normalized.replace(/^recording_/, ''),
    fieldName.replace(/^headers\./, ''),
    fieldName.replace(/^cookies\./, ''),
  ].filter(Boolean)));
}

export function getAccountFieldValue(account: AccountLike | null | undefined, fieldName?: string): string | undefined {
  if (!account || !fieldName) return undefined;

  const keys = candidateKeys(fieldName);
  const authProfile = (account.auth_profile || {}) as Record<string, any>;
  const authHeaders = (authProfile.headers || {}) as Record<string, any>;
  const authCookies = (authProfile.cookies || {}) as Record<string, any>;
  const variables = (account.variables || {}) as Record<string, any>;

  for (const key of keys) {
    const fieldValue = getRecordValue(account.fields || {}, key);
    if (fieldValue !== undefined && fieldValue !== '') return fieldValue;
  }

  for (const key of keys) {
    const authValue = getRecordValue(authProfile, key);
    if (authValue !== undefined && authValue !== '') return authValue;
  }

  for (const key of keys) {
    const headerValue = getRecordValue(authHeaders, key);
    if (headerValue !== undefined && headerValue !== '') return headerValue;
  }

  for (const key of keys) {
    const cookieValue = getRecordValue(authCookies, key);
    if (cookieValue !== undefined && cookieValue !== '') return cookieValue;
  }

  for (const key of keys) {
    const variableValue = getRecordValue(variables, `recording.${key}`)
      ?? getRecordValue(variables, key);
    if (variableValue !== undefined && variableValue !== '') return variableValue;
  }

  return undefined;
}

export function buildAccountIdentity(account: AccountLike | null | undefined): Record<string, string> {
  if (!account) return {};

  const identity: Record<string, string> = {};
  const aliases = [
    'token',
    'accessToken',
    'access_token',
    'authorization',
    'Authorization',
    'session',
    'sessionId',
    'session_id',
    'cookie',
    'apiKey',
    'api_key',
    'csrf_token',
    'refresh_token',
  ];

  for (const alias of aliases) {
    const value = getAccountFieldValue(account, alias);
    if (value !== undefined && value !== '') {
      identity[alias] = value;
    }
  }

  const authProfile = (account.auth_profile || {}) as Record<string, any>;
  const authHeaders = (authProfile.headers || {}) as Record<string, any>;
  const authCookies = (authProfile.cookies || {}) as Record<string, any>;

  for (const [key, value] of Object.entries(authHeaders)) {
    const scalar = toScalarString(value);
    if (scalar) {
      identity[key] = scalar;
      identity[normalizeLookupKey(key)] = scalar;
    }
  }

  for (const [key, value] of Object.entries(authCookies)) {
    const scalar = toScalarString(value);
    if (scalar) {
      identity[key] = scalar;
      identity[normalizeLookupKey(key)] = scalar;
    }
  }

  return identity;
}
