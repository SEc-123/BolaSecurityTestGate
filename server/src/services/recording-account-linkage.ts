import type {
  Account,
  DbProvider,
  RecordingAccountApplyChange,
  RecordingAccountApplyLog,
  RecordingFieldHit,
  RecordingRuntimeContext,
  RecordingSession,
} from '../types/index.js';
import { recordAccountOverwrite } from './recording-telemetry.js';
import { appendRecordingAuditLog } from './recording-observability.js';

export interface RecordingSessionAccountPreview {
  session_id: string;
  account_id: string;
  account_name: string;
  mode: 'session_only' | 'write_back';
  summary: Record<string, any>;
  changes: RecordingAccountApplyChange[];
  field_changes: RecordingAccountApplyChange[];
  auth_profile_changes: RecordingAccountApplyChange[];
  variable_changes: RecordingAccountApplyChange[];
  account_patch: {
    fields: Record<string, any>;
    auth_profile: Record<string, any>;
    variables: Record<string, any>;
  };
  session_overlay: {
    account_id: string;
    account_name: string;
    fields: Record<string, any>;
    auth_profile: Record<string, any>;
    variables: Record<string, any>;
  };
  target_snapshot: Record<string, any>;
}

export interface RecordingSessionAccountApplyResult {
  mode: 'session_only' | 'write_back';
  persisted: boolean;
  account: Account;
  preview: RecordingSessionAccountPreview;
  log: RecordingAccountApplyLog;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKey(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function getHitValue(hit: Pick<RecordingFieldHit, 'value_text' | 'value_preview'>): string | undefined {
  return hit.value_text || hit.value_preview;
}

function getContextValue(context: Pick<RecordingRuntimeContext, 'value_text' | 'value_preview'>): string | undefined {
  return context.value_text || context.value_preview;
}

function isAuthLike(fieldName?: string): boolean {
  const normalized = normalizeKey(fieldName || '');
  return normalized.includes('token') ||
    normalized.includes('auth') ||
    normalized.includes('session') ||
    normalized.includes('csrf') ||
    normalized.includes('cookie') ||
    normalized.includes('refresh') ||
    normalized.includes('bearer') ||
    normalized.includes('nonce');
}

function setNestedObjectValue(target: Record<string, any>, path: string, value: string): void {
  const segments = path.split('.').filter(Boolean);
  if (segments.length === 0) return;

  let cursor: Record<string, any> = target;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }

  cursor[segments[segments.length - 1]] = value;
}

function cloneRecord<T extends Record<string, any>>(value: T | undefined): T {
  return JSON.parse(JSON.stringify(value || {}));
}

function deepMerge(target: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const result = cloneRecord(target);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = deepMerge((result[key] || {}) as Record<string, any>, value as Record<string, any>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function resolveSessionAndAccount(
  db: DbProvider,
  sessionId: string,
  accountId?: string
): Promise<{ session: RecordingSession; account: Account }> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  const targetAccountId = accountId || session.account_id;
  if (!targetAccountId) {
    throw new Error('account_id is required because the session is not bound to a default account');
  }

  const account = await db.repos.accounts.findById(targetAccountId);
  if (!account) {
    throw new Error(`Account not found: ${targetAccountId}`);
  }

  return { session, account };
}

function registerChange(
  changeMap: Map<string, RecordingAccountApplyChange>,
  change: RecordingAccountApplyChange
): void {
  const key = `${change.target_section}:${change.target_path}`;
  const current = changeMap.get(key);
  const currentPriority = (current?.source_type === 'runtime_context' ? 20 : 10) + (current?.confidence || 0);
  const nextPriority = (change.source_type === 'runtime_context' ? 20 : 10) + (change.confidence || 0);

  if (!current || nextPriority >= currentPriority) {
    changeMap.set(key, change);
  }
}

function applyChangeToPatch(
  patch: RecordingSessionAccountPreview['account_patch'],
  change: RecordingAccountApplyChange
): void {
  const value = change.value_text ?? change.value_preview ?? '';
  if (change.target_section === 'fields') {
    patch.fields[change.target_path] = value;
    return;
  }

  if (change.target_section === 'variables') {
    patch.variables[change.target_path] = value;
    return;
  }

  setNestedObjectValue(patch.auth_profile, change.target_path, value);
}

function buildTargetSnapshot(account: Account): Record<string, any> {
  return {
    account_id: account.id,
    account_name: account.name,
    fields: cloneRecord(account.fields || {}),
    auth_profile: cloneRecord(account.auth_profile || {}),
    variables: cloneRecord(account.variables || {}),
  };
}

export async function getRecordingSessionAccountPreview(
  db: DbProvider,
  sessionId: string,
  params?: {
    account_id?: string;
    field_map?: Record<string, string>;
    mode?: 'session_only' | 'write_back';
  }
): Promise<RecordingSessionAccountPreview> {
  const { session, account } = await resolveSessionAndAccount(db, sessionId, params?.account_id);
  const [fieldHits, runtimeContexts] = await Promise.all([
    db.repos.recordingFieldHits.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingRuntimeContext.findAll({ where: { session_id: sessionId } as any }),
  ]);

  const changeMap = new Map<string, RecordingAccountApplyChange>();
  const mode = params?.mode || 'session_only';

  for (const hit of fieldHits) {
    const fieldName = params?.field_map?.[hit.field_name] || hit.bind_to_account_field;
    const value = getHitValue(hit);
    if (!fieldName || !value) continue;

    if (isAuthLike(fieldName)) {
      registerChange(changeMap, {
        source_type: 'field_hit',
        source_name: hit.field_name,
        source_location: hit.source_location,
        source_key: hit.source_key,
        bind_to_account_field: fieldName,
        target_section: 'auth_profile',
        target_path: fieldName,
        value_preview: hit.value_preview,
        value_text: value,
        confidence: hit.confidence,
      });
    } else {
      registerChange(changeMap, {
        source_type: 'field_hit',
        source_name: hit.field_name,
        source_location: hit.source_location,
        source_key: hit.source_key,
        bind_to_account_field: fieldName,
        target_section: 'fields',
        target_path: fieldName,
        value_preview: hit.value_preview,
        value_text: value,
        confidence: hit.confidence,
      });
    }

    registerChange(changeMap, {
      source_type: 'field_hit',
      source_name: hit.field_name,
      source_location: hit.source_location,
      source_key: hit.source_key,
      bind_to_account_field: fieldName,
      target_section: 'variables',
      target_path: `recording.${fieldName}`,
      value_preview: hit.value_preview,
      value_text: value,
      confidence: hit.confidence,
    });
  }

  for (const context of runtimeContexts) {
    const fieldName = params?.field_map?.[context.context_key] || context.bind_to_account_field || normalizeKey(context.context_key);
    const value = getContextValue(context);
    if (!fieldName || !value) continue;

    registerChange(changeMap, {
      source_type: 'runtime_context',
      source_name: context.context_key,
      source_location: context.source_location,
      bind_to_account_field: fieldName,
      target_section: 'auth_profile',
      target_path: fieldName,
      value_preview: context.value_preview,
      value_text: value,
      confidence: 1,
    });

    if (context.source_location?.includes('header')) {
      registerChange(changeMap, {
        source_type: 'runtime_context',
        source_name: context.context_key,
        source_location: context.source_location,
        bind_to_account_field: fieldName,
        target_section: 'auth_profile',
        target_path: `headers.${context.context_key}`,
        value_preview: context.value_preview,
        value_text: value,
        confidence: 1,
      });
    }

    if (context.source_location?.includes('cookie')) {
      registerChange(changeMap, {
        source_type: 'runtime_context',
        source_name: context.context_key,
        source_location: context.source_location,
        bind_to_account_field: fieldName,
        target_section: 'auth_profile',
        target_path: `cookies.${context.context_key}`,
        value_preview: context.value_preview,
        value_text: value,
        confidence: 1,
      });
    }

    registerChange(changeMap, {
      source_type: 'runtime_context',
      source_name: context.context_key,
      source_location: context.source_location,
      bind_to_account_field: fieldName,
      target_section: 'variables',
      target_path: `recording.${fieldName}`,
      value_preview: context.value_preview,
      value_text: value,
      confidence: 1,
    });
  }

  const changes = Array.from(changeMap.values()).sort((left, right) => {
    if (left.target_section !== right.target_section) {
      return left.target_section.localeCompare(right.target_section);
    }
    return left.target_path.localeCompare(right.target_path);
  });

  const preview: RecordingSessionAccountPreview = {
    session_id: session.id,
    account_id: account.id,
    account_name: account.name,
    mode,
    summary: {},
    changes,
    field_changes: changes.filter(change => change.target_section === 'fields'),
    auth_profile_changes: changes.filter(change => change.target_section === 'auth_profile'),
    variable_changes: changes.filter(change => change.target_section === 'variables'),
    account_patch: {
      fields: {},
      auth_profile: {},
      variables: {},
    },
    session_overlay: {
      account_id: account.id,
      account_name: account.name,
      fields: {},
      auth_profile: {},
      variables: {},
    },
    target_snapshot: buildTargetSnapshot(account),
  };

  for (const change of changes) {
    applyChangeToPatch(preview.account_patch, change);
  }

  preview.session_overlay.fields = cloneRecord(preview.account_patch.fields);
  preview.session_overlay.auth_profile = cloneRecord(preview.account_patch.auth_profile);
  preview.session_overlay.variables = cloneRecord(preview.account_patch.variables);
  preview.summary = {
    mode,
    total_changes: changes.length,
    field_change_count: preview.field_changes.length,
    auth_profile_change_count: preview.auth_profile_changes.length,
    variable_change_count: preview.variable_changes.length,
    runtime_context_change_count: changes.filter(change => change.source_type === 'runtime_context').length,
    field_hit_change_count: changes.filter(change => change.source_type === 'field_hit').length,
    generated_at: nowIso(),
  };

  return preview;
}

async function updateSessionLinkageSummary(
  db: DbProvider,
  session: RecordingSession,
  preview: RecordingSessionAccountPreview,
  log: RecordingAccountApplyLog,
  persisted: boolean,
  appliedBy?: string
): Promise<void> {
  await db.repos.recordingSessions.update(session.id, {
    summary: {
      ...(session.summary || {}),
      account_linkage: {
        account_id: preview.account_id,
        account_name: preview.account_name,
        mode: preview.mode,
        persisted,
        applied_by: appliedBy || 'system',
        last_applied_at: nowIso(),
        last_log_id: log.id,
        summary: preview.summary,
        overlay: preview.session_overlay,
      },
    },
  } as any);
}

export async function applyRecordingSessionToAccount(
  db: DbProvider,
  sessionId: string,
  params?: {
    account_id?: string;
    field_map?: Record<string, string>;
    mode?: 'session_only' | 'write_back';
    applied_by?: string;
  }
): Promise<RecordingSessionAccountApplyResult> {
  const { session, account } = await resolveSessionAndAccount(db, sessionId, params?.account_id);
  const preview = await getRecordingSessionAccountPreview(db, sessionId, params);
  const persisted = preview.mode === 'write_back';

  const nextFields = persisted
    ? { ...(account.fields || {}), ...preview.account_patch.fields }
    : { ...(account.fields || {}) };
  const nextAuthProfile = persisted
    ? deepMerge(account.auth_profile || {}, preview.account_patch.auth_profile)
    : cloneRecord(account.auth_profile || {});
  const nextVariables = persisted
    ? { ...(account.variables || {}), ...preview.account_patch.variables }
    : { ...(account.variables || {}) };

  const updatedAccount = persisted
    ? await db.repos.accounts.update(account.id, {
        fields: nextFields,
        auth_profile: nextAuthProfile,
        variables: nextVariables,
      } as any)
    : account;

  if (!updatedAccount) {
    throw new Error(`Failed to update account ${account.name}`);
  }

  const log = await db.repos.recordingAccountApplyLogs.create({
    session_id: session.id,
    account_id: account.id,
    mode: preview.mode,
    persisted,
    applied_by: params?.applied_by,
    target_snapshot: preview.target_snapshot,
    field_changes: preview.field_changes,
    auth_profile_changes: preview.auth_profile_changes,
    variable_changes: preview.variable_changes,
    summary: preview.summary,
  } as any);

  await updateSessionLinkageSummary(db, session, preview, log, persisted, params?.applied_by);

  await appendRecordingAuditLog(db, {
    session_id: sessionId,
    action: persisted ? 'recording_account_overwrite' : 'recording_account_linked',
    actor: params?.applied_by,
    target_type: 'account',
    target_id: account.id,
    status: 'success',
    message: persisted
      ? `Applied recording values to account ${account.name}`
      : `Linked recording values to account ${account.name} without persistence`,
    details: {
      mode: preview.mode,
      persisted,
      total_changes: preview.summary.total_changes,
      field_change_count: preview.summary.field_change_count,
      auth_profile_change_count: preview.summary.auth_profile_change_count,
      variable_change_count: preview.summary.variable_change_count,
    },
  });

  if (persisted) {
    recordAccountOverwrite({
      session_id: sessionId,
      account_id: account.id,
      mapped_field_count: preview.summary.total_changes,
      mode: preview.mode,
    });
  }

  return {
    mode: preview.mode,
    persisted,
    account: updatedAccount,
    preview,
    log,
  };
}

export async function listRecordingAccountApplyLogs(
  db: DbProvider,
  params?: { account_id?: string; session_id?: string }
): Promise<RecordingAccountApplyLog[]> {
  const logs = await db.repos.recordingAccountApplyLogs.findAll();
  return logs.filter(log => {
    if (params?.account_id && log.account_id !== params.account_id) return false;
    if (params?.session_id && log.session_id !== params.session_id) return false;
    return true;
  });
}
