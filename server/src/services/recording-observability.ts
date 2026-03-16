import type {
  DbProvider,
  RecordingAuditLog,
  RecordingDeadLetter,
} from '../types/index.js';
import {
  getRecordingIngressConfig,
  getRecordingPrivilegeConfig,
} from './recording-guard.js';
import { getRecordingTelemetrySnapshot } from './recording-telemetry.js';

function nowIso(): string {
  return new Date().toISOString();
}

function toTime(value?: string): number {
  return value ? new Date(value).getTime() : 0;
}

export async function appendRecordingAuditLog(
  db: DbProvider,
  params: {
    session_id?: string;
    action: string;
    actor?: string;
    target_type?: string;
    target_id?: string;
    status?: 'success' | 'failed';
    message?: string;
    details?: Record<string, any>;
  }
): Promise<RecordingAuditLog> {
  const created = await db.repos.recordingAuditLogs.create({
    session_id: params.session_id,
    action: params.action,
    actor: params.actor,
    target_type: params.target_type,
    target_id: params.target_id,
    status: params.status || 'success',
    message: params.message,
    details: params.details || {},
  } as any);

  console.info('[recording-audit]', JSON.stringify({
    at: created.created_at || nowIso(),
    session_id: created.session_id,
    action: created.action,
    actor: created.actor,
    target_type: created.target_type,
    target_id: created.target_id,
    status: created.status,
    message: created.message,
    details: created.details || {},
  }));

  return created;
}

export async function listRecordingAuditLogs(
  db: DbProvider,
  filters?: {
    session_id?: string;
    action?: string;
    status?: 'success' | 'failed';
    target_type?: string;
    limit?: number;
  }
): Promise<RecordingAuditLog[]> {
  const logs = await db.repos.recordingAuditLogs.findAll();
  const limit = Math.max(1, Math.min(200, Number(filters?.limit) || 50));

  return logs
    .filter(log => {
      if (filters?.session_id && log.session_id !== filters.session_id) return false;
      if (filters?.action && log.action !== filters.action) return false;
      if (filters?.status && log.status !== filters.status) return false;
      if (filters?.target_type && log.target_type !== filters.target_type) return false;
      return true;
    })
    .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))
    .slice(0, limit);
}

export async function createRecordingDeadLetter(
  db: DbProvider,
  params: {
    session_id?: string;
    failure_stage: string;
    error_message: string;
    batch_size?: number;
    payload?: Record<string, any>;
  }
): Promise<RecordingDeadLetter> {
  return db.repos.recordingDeadLetters.create({
    session_id: params.session_id,
    failure_stage: params.failure_stage,
    status: 'pending',
    error_message: params.error_message,
    batch_size: Math.max(0, params.batch_size || 0),
    retry_count: 0,
    payload: params.payload || {},
    last_retried_at: undefined,
    resolved_at: undefined,
  } as any);
}

export async function listRecordingDeadLetters(
  db: DbProvider,
  filters?: {
    session_id?: string;
    status?: 'pending' | 'replayed' | 'discarded';
    failure_stage?: string;
    limit?: number;
  }
): Promise<RecordingDeadLetter[]> {
  const deadLetters = await db.repos.recordingDeadLetters.findAll();
  const limit = Math.max(1, Math.min(200, Number(filters?.limit) || 50));

  return deadLetters
    .filter(item => {
      if (filters?.session_id && item.session_id !== filters.session_id) return false;
      if (filters?.status && item.status !== filters.status) return false;
      if (filters?.failure_stage && item.failure_stage !== filters.failure_stage) return false;
      return true;
    })
    .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))
    .slice(0, limit);
}

export async function markRecordingDeadLetterRetried(
  db: DbProvider,
  deadLetterId: string,
  params?: {
    actor?: string;
    details?: Record<string, any>;
  }
): Promise<RecordingDeadLetter> {
  const deadLetter = await db.repos.recordingDeadLetters.findById(deadLetterId);
  if (!deadLetter) {
    throw new Error(`Recording dead letter not found: ${deadLetterId}`);
  }

  const updated = await db.repos.recordingDeadLetters.update(deadLetterId, {
    status: 'replayed',
    retry_count: (deadLetter.retry_count || 0) + 1,
    last_retried_at: nowIso(),
    resolved_at: nowIso(),
    payload: {
      ...(deadLetter.payload || {}),
      last_retry_result: params?.details || {},
    },
  } as any);

  if (!updated) {
    throw new Error(`Failed to update recording dead letter ${deadLetterId}`);
  }

  await appendRecordingAuditLog(db, {
    session_id: deadLetter.session_id,
    action: 'recording_dead_letter_retried',
    actor: params?.actor,
    target_type: 'recording_dead_letter',
    target_id: deadLetterId,
    status: 'success',
    message: `Replayed dead letter for ${deadLetter.failure_stage}`,
    details: {
      failure_stage: deadLetter.failure_stage,
      retry_count: updated.retry_count,
      ...(params?.details || {}),
    },
  });

  return updated;
}

export async function markRecordingDeadLetterRetryFailed(
  db: DbProvider,
  deadLetterId: string,
  params: {
    actor?: string;
    error_message: string;
    details?: Record<string, any>;
  }
): Promise<RecordingDeadLetter> {
  const deadLetter = await db.repos.recordingDeadLetters.findById(deadLetterId);
  if (!deadLetter) {
    throw new Error(`Recording dead letter not found: ${deadLetterId}`);
  }

  const updated = await db.repos.recordingDeadLetters.update(deadLetterId, {
    status: 'pending',
    retry_count: (deadLetter.retry_count || 0) + 1,
    last_retried_at: nowIso(),
    error_message: params.error_message,
    payload: {
      ...(deadLetter.payload || {}),
      last_retry_error: params.error_message,
      last_retry_details: params.details || {},
    },
  } as any);

  if (!updated) {
    throw new Error(`Failed to update recording dead letter ${deadLetterId}`);
  }

  await appendRecordingAuditLog(db, {
    session_id: deadLetter.session_id,
    action: 'recording_dead_letter_retry_failed',
    actor: params.actor,
    target_type: 'recording_dead_letter',
    target_id: deadLetterId,
    status: 'failed',
    message: params.error_message,
    details: {
      failure_stage: deadLetter.failure_stage,
      retry_count: updated.retry_count,
      ...(params.details || {}),
    },
  });

  return updated;
}

export async function discardRecordingDeadLetter(
  db: DbProvider,
  deadLetterId: string,
  params?: {
    actor?: string;
    reason?: string;
  }
): Promise<RecordingDeadLetter> {
  const deadLetter = await db.repos.recordingDeadLetters.findById(deadLetterId);
  if (!deadLetter) {
    throw new Error(`Recording dead letter not found: ${deadLetterId}`);
  }

  const updated = await db.repos.recordingDeadLetters.update(deadLetterId, {
    status: 'discarded',
    resolved_at: nowIso(),
    payload: {
      ...(deadLetter.payload || {}),
      discard_reason: params?.reason,
    },
  } as any);

  if (!updated) {
    throw new Error(`Failed to discard recording dead letter ${deadLetterId}`);
  }

  await appendRecordingAuditLog(db, {
    session_id: deadLetter.session_id,
    action: 'recording_dead_letter_discarded',
    actor: params?.actor,
    target_type: 'recording_dead_letter',
    target_id: deadLetterId,
    status: 'success',
    message: params?.reason || `Discarded dead letter for ${deadLetter.failure_stage}`,
    details: {
      failure_stage: deadLetter.failure_stage,
      discard_reason: params?.reason,
    },
  });

  return updated;
}

export async function getRecordingOpsSummary(db: DbProvider): Promise<{
  ingress: ReturnType<typeof getRecordingIngressConfig>;
  privilege: ReturnType<typeof getRecordingPrivilegeConfig>;
  metrics: ReturnType<typeof getRecordingTelemetrySnapshot>;
  totals: {
    audit_logs: number;
    dead_letters: number;
    pending_dead_letters: number;
    replayed_dead_letters: number;
    discarded_dead_letters: number;
  };
  audit_logs: RecordingAuditLog[];
  dead_letters: RecordingDeadLetter[];
}> {
  const [allAuditLogs, allDeadLetters] = await Promise.all([
    db.repos.recordingAuditLogs.findAll(),
    db.repos.recordingDeadLetters.findAll(),
  ]);

  const auditLogs = [...allAuditLogs]
    .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))
    .slice(0, 20);
  const deadLetters = [...allDeadLetters]
    .sort((left, right) => toTime(right.created_at) - toTime(left.created_at))
    .slice(0, 20);

  return {
    ingress: getRecordingIngressConfig(),
    privilege: getRecordingPrivilegeConfig(),
    metrics: getRecordingTelemetrySnapshot(),
    totals: {
      audit_logs: allAuditLogs.length,
      dead_letters: allDeadLetters.length,
      pending_dead_letters: allDeadLetters.filter(item => item.status === 'pending').length,
      replayed_dead_letters: allDeadLetters.filter(item => item.status === 'replayed').length,
      discarded_dead_letters: allDeadLetters.filter(item => item.status === 'discarded').length,
    },
    audit_logs: auditLogs,
    dead_letters: deadLetters,
  };
}
