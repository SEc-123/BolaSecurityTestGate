import type { NextFunction, Request, Response } from 'express';

export type AuthRole = 'viewer' | 'operator' | 'admin' | 'ci-runner' | 'recording-ingest';

export interface AuthPrincipal {
  subject: string;
  roles: AuthRole[];
  source: string;
  devOpen?: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthPrincipal;
  }
}

class AuthError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function csv(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function configuredAuthKeys(): Array<{ value: string; roles: AuthRole[]; source: string }> {
  const keys: Array<{ value: string; roles: AuthRole[]; source: string }> = [];
  const add = (value: string | undefined, roles: AuthRole[], source: string) => {
    if (value?.trim()) keys.push({ value: value.trim(), roles, source });
  };

  add(process.env.BSTG_ADMIN_API_KEY || process.env.ADMIN_API_KEY, ['admin', 'operator', 'viewer'], 'admin-api-key');
  add(process.env.BSTG_OPERATOR_API_KEY || process.env.OPERATOR_API_KEY, ['operator', 'viewer'], 'operator-api-key');
  add(process.env.BSTG_VIEWER_API_KEY || process.env.VIEWER_API_KEY, ['viewer'], 'viewer-api-key');
  add(process.env.BSTG_CI_RUNNER_API_KEY || process.env.SEC_RUNNER_API_KEY, ['ci-runner'], 'ci-runner-api-key');
  add(process.env.BSTG_RECORDING_API_KEY || process.env.RECORDING_API_KEY, ['recording-ingest'], 'recording-api-key');
  add(process.env.BSTG_RECORDING_ADMIN_API_KEY || process.env.RECORDING_ADMIN_API_KEY, ['admin', 'recording-ingest'], 'recording-admin-api-key');

  for (const item of csv(process.env.BSTG_ADDITIONAL_ADMIN_API_KEYS)) {
    add(item, ['admin', 'operator', 'viewer'], 'additional-admin-api-key');
  }
  for (const item of csv(process.env.BSTG_ADDITIONAL_OPERATOR_API_KEYS)) {
    add(item, ['operator', 'viewer'], 'additional-operator-api-key');
  }
  return keys;
}

function authRequired(): boolean {
  return envFlag('BSTG_REQUIRE_AUTH') || process.env.NODE_ENV === 'production';
}

function devOpenAllowed(): boolean {
  return !authRequired() && !envFlag('BSTG_DISABLE_DEV_OPEN_AUTH');
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization') || req.header('Authorization');
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  return header.slice(7).trim() || null;
}

function tokenFromRequest(req: Request): string | null {
  return (
    bearerToken(req) ||
    req.header('x-bstg-api-key') ||
    req.header('X-BSTG-API-Key') ||
    req.header('x-api-key') ||
    req.header('X-API-Key') ||
    req.header('x-recording-admin-key') ||
    req.header('X-Recording-Admin-Key') ||
    null
  );
}

function principalFromToken(req: Request): AuthPrincipal {
  const keys = configuredAuthKeys();
  const token = tokenFromRequest(req);

  if (token) {
    const match = keys.find(key => key.value === token);
    if (match) {
      return {
        subject: match.source,
        roles: match.roles,
        source: match.source,
      };
    }
    throw new AuthError(401, 'Invalid API key');
  }

  if (keys.length > 0 || authRequired()) {
    if (authRequired() && keys.length === 0) {
      throw new AuthError(503, 'Authentication is required but no BSTG API key is configured');
    }
    throw new AuthError(401, 'Authentication required');
  }

  if (devOpenAllowed()) {
    return {
      subject: 'dev-open',
      roles: ['admin', 'operator', 'viewer', 'ci-runner', 'recording-ingest'],
      source: 'dev-open',
      devOpen: true,
    };
  }

  throw new AuthError(401, 'Authentication required');
}

function hasRole(principal: AuthPrincipal, allowedRoles: AuthRole[]): boolean {
  return allowedRoles.some(role => principal.roles.includes(role));
}

export function requireAuth(allowedRoles: AuthRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const principal = principalFromToken(req);
      if (!hasRole(principal, allowedRoles)) {
        res.status(403).json({ data: null, error: 'Insufficient role for this operation' });
        return;
      }
      req.auth = principal;
      next();
    } catch (error: any) {
      const status = error instanceof AuthError ? error.status : 500;
      res.status(status).json({ data: null, error: error.message || 'Authentication failed' });
    }
  };
}

export function requireDebugApiEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!envFlag('BSTG_DEBUG_API_ENABLED')) {
    res.status(404).json({ data: null, error: 'Debug API is disabled' });
    return;
  }
  next();
}

export function authRuntimeStatus(): {
  required: boolean;
  configured_keys: string[];
  dev_open: boolean;
} {
  return {
    required: authRequired(),
    configured_keys: configuredAuthKeys().map(key => key.source),
    dev_open: devOpenAllowed() && configuredAuthKeys().length === 0 && !authRequired(),
  };
}
