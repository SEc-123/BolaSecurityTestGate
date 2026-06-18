import type { Request } from 'express';

interface EventWindowEntry {
  at: number;
  count: number;
}

export class RecordingGuardError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const WINDOW_MS = 60_000;
const batchWindows = new Map<string, number[]>();
const eventWindows = new Map<string, EventWindowEntry[]>();

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pruneBatchWindow(subject: string, now: number): number[] {
  const next = (batchWindows.get(subject) || []).filter(timestamp => now - timestamp < WINDOW_MS);
  batchWindows.set(subject, next);
  return next;
}

function pruneEventWindow(subject: string, now: number): EventWindowEntry[] {
  const next = (eventWindows.get(subject) || []).filter(entry => now - entry.at < WINDOW_MS);
  eventWindows.set(subject, next);
  return next;
}

function parseApiKey(req: Request): string | null {
  const apiKeyHeader = req.header('x-api-key') || req.header('X-API-Key');
  if (apiKeyHeader?.trim()) {
    return apiKeyHeader.trim();
  }

  const authHeader = req.header('authorization') || req.header('Authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  return null;
}

function parseAdminKey(req: Request): string | null {
  const adminKeyHeader =
    req.header('x-recording-admin-key') ||
    req.header('X-Recording-Admin-Key') ||
    req.header('x-admin-key') ||
    req.header('X-Admin-Key');

  return adminKeyHeader?.trim() || null;
}

export function getRecordingIngressConfig(): {
  api_key_required: boolean;
  max_batch_size: number;
  max_batches_per_minute: number;
  max_events_per_minute: number;
} {
  return {
    api_key_required: !!(process.env.RECORDING_API_KEY || process.env.BSTG_RECORDING_API_KEY),
    max_batch_size: readPositiveInt(process.env.RECORDING_MAX_BATCH_SIZE, 50),
    max_batches_per_minute: readPositiveInt(process.env.RECORDING_MAX_BATCHES_PER_MINUTE, 120),
    max_events_per_minute: readPositiveInt(process.env.RECORDING_MAX_EVENTS_PER_MINUTE, 3000),
  };
}

export function getRecordingPrivilegeConfig(): {
  admin_key_required: boolean;
  privileged_actions: string[];
} {
  return {
    admin_key_required: !!(process.env.RECORDING_ADMIN_API_KEY || process.env.BSTG_RECORDING_ADMIN_API_KEY),
    privileged_actions: [
      'recording_publish_workflow',
      'recording_publish_test_run_preset',
      'recording_promote_test_run',
      'recording_publish_api_template',
      'recording_apply_account_write_back',
      'recording_dead_letter_retry',
      'recording_dead_letter_discard',
      'recording_ops_view',
    ],
  };
}

export function ensureRecordingAuthorized(req: Request): string {
  const expectedApiKey = process.env.RECORDING_API_KEY || process.env.BSTG_RECORDING_API_KEY;
  const actualApiKey = parseApiKey(req);

  if (expectedApiKey && actualApiKey !== expectedApiKey) {
    throw new RecordingGuardError(401, 'Invalid recording API key');
  }

  return actualApiKey || 'anonymous';
}

export function ensureRecordingPrivileged(req: Request, action = 'recording_privileged_action'): string {
  const expectedAdminKey = process.env.RECORDING_ADMIN_API_KEY || process.env.BSTG_RECORDING_ADMIN_API_KEY;
  const actualAdminKey = parseAdminKey(req);

  if (expectedAdminKey && actualAdminKey !== expectedAdminKey) {
    throw new RecordingGuardError(403, `Recording admin key required for ${action}`);
  }

  return actualAdminKey || 'recording-admin';
}

export function enforceRecordingIngressLimits(params: {
  apiKey: string;
  sessionId: string;
  batchSize: number;
}): void {
  const config = getRecordingIngressConfig();
  if (params.batchSize <= 0) {
    throw new RecordingGuardError(400, 'events must be a non-empty array');
  }
  if (params.batchSize > config.max_batch_size) {
    throw new RecordingGuardError(413, `Batch size ${params.batchSize} exceeds recording limit ${config.max_batch_size}`);
  }

  const subject = `${params.apiKey}::${params.sessionId}`;
  const now = Date.now();
  const batches = pruneBatchWindow(subject, now);
  const events = pruneEventWindow(subject, now);
  const eventsInWindow = events.reduce((sum, entry) => sum + entry.count, 0);

  if (batches.length >= config.max_batches_per_minute) {
    throw new RecordingGuardError(429, `Too many recording batches for session ${params.sessionId}; retry in a moment`);
  }

  if (eventsInWindow + params.batchSize > config.max_events_per_minute) {
    throw new RecordingGuardError(429, `Recording event rate exceeded for session ${params.sessionId}; reduce batch frequency`);
  }

  batches.push(now);
  events.push({ at: now, count: params.batchSize });
  batchWindows.set(subject, batches);
  eventWindows.set(subject, events);
}
