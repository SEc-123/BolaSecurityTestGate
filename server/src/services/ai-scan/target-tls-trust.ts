import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Private target CAs are execution-environment configuration, never Agent
 * input.  The browser worker and native replay process use the same immutable
 * bundle fingerprint for a run.  There is deliberately no insecure fallback
 * such as ignoreHTTPSErrors or rejectUnauthorized=false.
 */
export interface TargetTlsTrustMetadata {
  mode: 'platform_trust_store' | 'configured_ca';
  ca_bundle_sha256?: string;
}

export interface ResolvedTargetTlsTrust extends TargetTlsTrustMetadata {
  ca_pem?: string;
}

const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

function configuredCaPath(): string | undefined {
  const value = process.env.BSTG_TARGET_CA_FILE?.trim();
  return value || undefined;
}

function configuredBundle(): { pem: string; fingerprint: string } | undefined {
  const configured = configuredCaPath();
  if (!configured) return undefined;
  if (!path.isAbsolute(configured)) {
    throw new Error('BSTG_TARGET_CA_FILE must be an absolute path to an operator-provisioned CA bundle.');
  }
  try {
    const status = statSync(configured);
    if (!status.isFile()) throw new Error('not a regular file');
    const pem = readFileSync(configured, 'utf8');
    const certificates = pem.match(certificatePattern) || [];
    if (certificates.length === 0) throw new Error('no certificates');
    const hashes = certificates
      .map(certificate => createHash('sha256').update(new X509Certificate(certificate).raw).digest('hex'))
      .sort();
    return { pem, fingerprint: createHash('sha256').update(hashes.join(':')).digest('hex') };
  } catch (error: any) {
    if (error?.message?.includes('must be')) throw error;
    // Do not expose an operator filesystem path through an Agent-visible
    // execution failure. The deployment owner can inspect its own service log.
    throw new Error('BSTG_TARGET_CA_FILE is unreadable or does not contain a valid certificate bundle.');
  }
}

export function resolveTargetTlsTrust(): ResolvedTargetTlsTrust {
  const bundle = configuredBundle();
  return bundle
    ? { mode: 'configured_ca', ca_bundle_sha256: bundle.fingerprint, ca_pem: bundle.pem }
    : { mode: 'platform_trust_store' };
}

/** Public-safe provenance. CA paths and PEM material remain local-only. */
export function targetTlsTrustMetadata(): TargetTlsTrustMetadata {
  const trust = resolveTargetTlsTrust();
  return trust.ca_pem
    ? { mode: trust.mode, ca_bundle_sha256: trust.ca_bundle_sha256 }
    : { mode: trust.mode };
}

function exactFingerprint(expected: string, actual: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(expected)) return false;
  const left = Buffer.from(expected.toLowerCase(), 'hex');
  const right = Buffer.from(actual.toLowerCase(), 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Chromium cannot be supplied an arbitrary CA through Playwright context
 * options without disabling certificate verification. A private CA therefore
 * requires either an isolated worker that has imported that exact CA into its
 * own trust store, or an operator-provisioned system trust store. Both paths
 * must declare the bundle fingerprint; a navigation still fails closed if the
 * browser has not actually trusted it.
 */
export function assertBrowserTargetTlsTrust(): TargetTlsTrustMetadata {
  const trust = targetTlsTrustMetadata();
  if (trust.mode !== 'configured_ca') return trust;
  const declared = process.env.BSTG_BROWSER_TRUSTED_CA_SHA256?.trim() || '';
  if (!trust.ca_bundle_sha256 || !exactFingerprint(declared, trust.ca_bundle_sha256)) {
    throw new Error('Private HTTPS target CA fingerprint is not attested for this browser runtime. Configure BSTG_BROWSER_TRUSTED_CA_SHA256 from the worker or trusted system store.');
  }
  const endpoint = process.env.BSTG_BROWSER_WS_ENDPOINT?.trim();
  const mode = process.env.BSTG_BROWSER_TRUSTED_CA_MODE?.trim();
  if (endpoint) return trust;
  if (mode === 'system') return trust;
  throw new Error('Private HTTPS targets require an isolated browser worker with the CA installed, or an operator-provisioned system trust store (BSTG_BROWSER_TRUSTED_CA_MODE=system).');
}
