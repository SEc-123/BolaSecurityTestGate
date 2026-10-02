import type { DbProvider } from '../../../types/index.js';
import type { PreparedBrowserIdentity } from './prepared-identity-login.js';

const identityKeyMaxLength = 100;

function cleanText(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value);
  return text.trim() && !/[\u0000-\u001f\u007f]/.test(text) ? text : '';
}

/** Identity names are scan-owned execution keys, not user-facing account labels.
 * Keep their validation aligned with business-flow identity binding without
 * constraining legitimate @ or Unicode values. */
export function preparedIdentityKey(value: unknown): string | undefined {
  const key = typeof value === 'string' ? value : '';
  if (!key || key !== key.trim() || key.length > identityKeyMaxLength || /[\u0000-\u001f\u007f]/.test(key)) return undefined;
  return key;
}

/** The browser credential and the durable Account record must be selected as
 * one binding.  A normal Flow later records the Account ID in its native
 * Test Run, so choosing a different same-role credential here would make the
 * browser proof and replay provenance disagree. */
export interface PreparedBrowserIdentityBinding {
  account_id: string;
  identity: PreparedBrowserIdentity;
}

export type PreparedBrowserIdentityResolution =
  | { status: 'resolved'; binding: PreparedBrowserIdentityBinding }
  | { status: 'identity_invalid' }
  | { status: 'account_not_bound' }
  | { status: 'scan_bound_account_missing' }
  | { status: 'credentials_unavailable' }
  | { status: 'ambiguous_scan_bound_account'; account_count: number };

function browserCredentialCandidate(value: Record<string, any> | undefined, identityKey: string, fallbackUsername = ''): PreparedBrowserIdentity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const username = cleanText(value.username) || cleanText(value.email) || cleanText(value.phone) || cleanText(fallbackUsername);
  const password = cleanText(value.password);
  if (!username || !password) return undefined;
  return {
    identity_key: identityKey,
    username,
    email: cleanText(value.email) || undefined,
    phone: cleanText(value.phone) || undefined,
    password,
  };
}

/**
 * Resolve a login input only from one exact scan-bound Account.  This is
 * deliberately stricter than role lookup: multiple active records for a role
 * are ambiguous, and a token-only/newer record must never cause a silent
 * fallback to an older password-bearing account or scan configuration.
 *
 * The caller receives private form values to use inside Chromium; no caller
 * should put this object into a model result, artifact, invocation, or
 * diagnostic.
 */
export async function resolvePreparedBrowserIdentity(input: {
  db: DbProvider;
  scan_run_id: string;
  identity_key: string;
  /** A persisted recording may re-resolve only this exact Account. */
  account_id?: string;
}): Promise<PreparedBrowserIdentityResolution> {
  const identityKey = preparedIdentityKey(input.identity_key);
  if (!identityKey || identityKey === 'anonymous') return { status: 'identity_invalid' };

  const accounts = await input.db.repos.accounts.findAll();
  const prepared = accounts.filter(account => account.status === 'active' &&
    account.tags?.includes(`scan:${input.scan_run_id}`) && account.tags?.includes(`role:${identityKey}`));
  if (!prepared.length) return { status: 'scan_bound_account_missing' };
  // A model-visible role is not a selector for one of several credential
  // records.  Even a caller-supplied account ID cannot bypass this check: the
  // Flow's role binding would otherwise become an unstable provenance claim.
  if (prepared.length !== 1) return { status: 'ambiguous_scan_bound_account', account_count: prepared.length };

  const account = prepared[0];
  if (input.account_id && input.account_id !== account.id) return { status: 'account_not_bound' };
  const identity = browserCredentialCandidate(account.fields || {}, identityKey, account.username || '');
  if (!identity) return { status: 'credentials_unavailable' };
  return {
    status: 'resolved',
    binding: { account_id: account.id, identity },
  };
}
