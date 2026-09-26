import dns from 'dns/promises';
import net from 'net';

export class TargetPolicyError extends Error {
  status = 400;
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function csv(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function ipv4InCidr(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost');
}

export function isBlockedAddress(address: string): boolean {
  const ipVersion = net.isIP(address);
  if (ipVersion === 4) {
    return (
      ipv4InCidr(address, '0.0.0.0', 8) ||
      ipv4InCidr(address, '10.0.0.0', 8) ||
      ipv4InCidr(address, '127.0.0.0', 8) ||
      ipv4InCidr(address, '169.254.0.0', 16) ||
      ipv4InCidr(address, '172.16.0.0', 12) ||
      ipv4InCidr(address, '192.168.0.0', 16) ||
      ipv4InCidr(address, '100.64.0.0', 10) ||
      ipv4InCidr(address, '198.18.0.0', 15) ||
      address === '169.254.169.254'
    );
  }
  if (ipVersion === 6) {
    const ip = address.toLowerCase();
    return (
      ip === '::' ||
      ip === '::1' ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe80:') ||
      ip.startsWith('::ffff:127.') ||
      ip.startsWith('::ffff:10.') ||
      ip.startsWith('::ffff:192.168.') ||
      /^::ffff:172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
    );
  }
  return false;
}

function allowPrivateTargets(): boolean {
  return envFlag('BSTG_TARGET_ALLOW_PRIVATE') || envFlag('BSTG_ALLOW_PRIVATE_TARGETS');
}

function allowLocalhostTargets(): boolean {
  return allowPrivateTargets() || envFlag('BSTG_TARGET_ALLOW_LOCALHOST');
}

function targetAllowlist(): string[] {
  return csv(process.env.BSTG_TARGET_ALLOWLIST || process.env.BSTG_ALLOWED_TARGETS);
}

function isAllowlisted(parsed: URL): boolean {
  const origin = parsed.origin.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  return targetAllowlist().some(entry => entry === origin || entry === hostname || entry === `${hostname}:${parsed.port}`);
}

async function resolveAddresses(hostname: string): Promise<string[]> {
  if (net.isIP(hostname)) return [hostname];
  const results = await dns.lookup(hostname, { all: true, verbatim: true });
  return results.map(result => result.address);
}

export async function assertSafeHttpTarget(input: string, label = 'target URL'): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new TargetPolicyError(`${label} must be an absolute URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TargetPolicyError(`${label} must use http or https`);
  }

  if (isAllowlisted(parsed)) {
    return parsed.toString();
  }

  if (isLocalHostname(parsed.hostname) && !allowLocalhostTargets()) {
    throw new TargetPolicyError(`${label} points to localhost, which is blocked by target policy`);
  }

  let addresses: string[];
  try {
    addresses = await resolveAddresses(parsed.hostname);
  } catch (error: any) {
    throw new TargetPolicyError(`${label} host could not be resolved: ${error.message || String(error)}`);
  }

  if (!allowPrivateTargets()) {
    const blocked = addresses.find(isBlockedAddress);
    if (blocked) {
      throw new TargetPolicyError(`${label} resolves to a private or metadata address (${blocked})`);
    }
  }

  return parsed.toString();
}

function redirectTarget(baseUrl: string, response: Response): string | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get('location');
  if (!location) return null;
  return new URL(location, baseUrl).toString();
}

function redirectInit(init: RequestInit, status: number): RequestInit {
  if (status === 303 || ((status === 301 || status === 302) && String(init.method || 'GET').toUpperCase() === 'POST')) {
    const headers = new Headers(init.headers || undefined);
    headers.delete('content-type');
    headers.delete('content-length');
    return {
      ...init,
      method: 'GET',
      body: undefined,
      headers,
    };
  }
  return init;
}

export async function safeFetch(input: string, init: RequestInit = {}, label = 'outbound request'): Promise<Response> {
  let currentUrl = await assertSafeHttpTarget(input, label);
  let currentInit = init;
  const maxRedirects = Number.parseInt(process.env.BSTG_TARGET_MAX_REDIRECTS || '5', 10);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      ...currentInit,
      redirect: 'manual',
    });
    const nextUrl = redirectTarget(currentUrl, response);
    if (!nextUrl) {
      return response;
    }
    if (redirectCount === maxRedirects) {
      throw new TargetPolicyError(`${label} exceeded redirect limit`);
    }
    currentUrl = await assertSafeHttpTarget(nextUrl, `${label} redirect`);
    currentInit = redirectInit(currentInit, response.status);
  }

  throw new TargetPolicyError(`${label} exceeded redirect limit`);
}
