export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.BSTG_HOST || env.HOST || '127.0.0.1').trim() || '127.0.0.1';
}

function configuredCorsOrigins(env: NodeJS.ProcessEnv): string[] | '*' {
  const raw = String(env.CORS_ORIGIN || '').trim();
  if (!raw) return [];
  if (raw === '*') return '*';
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
}

export function isCorsOriginAllowed(origin: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true;
  const configured = configuredCorsOrigins(env);
  if (configured === '*') return true;
  if (configured.length > 0) return configured.includes(origin);
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function corsOriginDelegate(env: NodeJS.ProcessEnv = process.env) {
  return (origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void): void => {
    if (isCorsOriginAllowed(origin, env)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };
}
