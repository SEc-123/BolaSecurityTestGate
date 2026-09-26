import { randomUUID as uuidv4 } from 'node:crypto';
import type { DbProvider } from '../../types/index.js';
import { dbAll, dbGet, dbRun } from '../../db/sql-helpers.js';
import type { MobileActionRecord, MobileCaptureStatus, MobileSession, MobileSessionStatus } from './mobile-types.js';

function jsonParse(value: unknown, fallback: Record<string, any> = {}): Record<string, any> {
  if (!value) return fallback;
  if (typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function normalizeSession(row: any): MobileSession {
  return {
    ...row,
    health_json: jsonParse(row.health_json, {}),
    certificate_evidence: jsonParse(row.certificate_evidence, {}),
    apk_native_abis: Array.isArray(row.apk_native_abis) ? row.apk_native_abis : Object.values(jsonParse(row.apk_native_abis, {})).map(String),
  } as MobileSession;
}

function normalizeAction(row: any): MobileActionRecord {
  return {
    ...row,
    sequence: Number(row.sequence || 0),
    input_json: jsonParse(row.input_json, {}),
    result_json: jsonParse(row.result_json, {}),
  } as MobileActionRecord;
}

function nowExpr(db: DbProvider): string {
  return db.kind === 'postgres' ? 'now()' : "datetime('now')";
}

export async function createMobileSession(db: DbProvider, input: {
  scan_run_id?: string;
  profile_id: string;
  device_id?: string;
  app_package?: string;
  app_activity?: string;
  apk_path?: string;
  apk_source?: string;
  apk_sha256?: string;
  apk_signer_sha256?: string;
  apk_package_name?: string;
  apk_launch_activity?: string;
  apk_native_abis?: string[];
  certificate_evidence?: Record<string, any>;
  screen_stream_url?: string;
}): Promise<MobileSession> {
  const id = uuidv4();
  await dbRun(db, `INSERT INTO mobile_sessions (id, scan_run_id, profile_id, device_id, app_package, app_activity, apk_path, apk_source, apk_sha256, apk_signer_sha256, apk_package_name, apk_launch_activity, apk_native_abis, certificate_evidence, status, capture_status, screen_stream_url, health_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id,
    input.scan_run_id || null,
    input.profile_id,
    input.device_id || null,
    input.app_package || null,
    input.app_activity || null,
    input.apk_path || null,
    input.apk_source || null,
    input.apk_sha256 || null,
    input.apk_signer_sha256 || null,
    input.apk_package_name || null,
    input.apk_launch_activity || null,
    JSON.stringify(input.apk_native_abis || []),
    JSON.stringify(input.certificate_evidence || {}),
    'created',
    'not_started',
    input.screen_stream_url || null,
    JSON.stringify({}),
  ]);
  const session = await getMobileSession(db, id);
  if (!session) throw new Error('Failed to create mobile session');
  return session;
}

export async function getMobileSession(db: DbProvider, id: string): Promise<MobileSession | null> {
  const row = await dbGet<any>(db, 'SELECT * FROM mobile_sessions WHERE id = ?', [id]);
  return row ? normalizeSession(row) : null;
}

export async function getLatestMobileSessionForScan(db: DbProvider, scanRunId: string): Promise<MobileSession | null> {
  const row = await dbGet<any>(db, 'SELECT * FROM mobile_sessions WHERE scan_run_id = ? ORDER BY created_at DESC LIMIT 1', [scanRunId]).catch(() => null);
  return row ? normalizeSession(row) : null;
}

export async function listMobileSessions(db: DbProvider, scanRunId?: string): Promise<MobileSession[]> {
  const rows = scanRunId
    ? await dbAll<any>(db, 'SELECT * FROM mobile_sessions WHERE scan_run_id = ? ORDER BY created_at DESC', [scanRunId])
    : await dbAll<any>(db, 'SELECT * FROM mobile_sessions ORDER BY created_at DESC LIMIT 200');
  return rows.map(normalizeSession);
}

export async function updateMobileSession(db: DbProvider, id: string, patch: Partial<MobileSession>): Promise<MobileSession> {
  const allowed = new Set(['scan_run_id','profile_id','device_id','app_package','app_activity','apk_path','apk_source','apk_sha256','apk_signer_sha256','apk_package_name','apk_launch_activity','apk_native_abis','certificate_evidence','status','capture_status','screen_stream_url','recording_session_id','health_json']);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw new Error('Unsupported mobile session update field.');
  if (patch.health_json) {
    const current = await getMobileSession(db, id);
    patch = { ...patch, health_json: { ...(current?.health_json || {}), ...patch.health_json,
      details: { ...(current?.health_json?.details || {}), ...(patch.health_json.details || {}) } } };
  }
  const fields: string[] = [];
  const values: any[] = [];
  const jsonFields = new Set(['health_json', 'certificate_evidence', 'apk_native_abis']);
  for (const [key, value] of Object.entries(patch)) {
    if (['id', 'created_at', 'updated_at'].includes(key)) continue;
    fields.push(`${key} = ?`);
    values.push(jsonFields.has(key) ? JSON.stringify(value || {}) : value ?? null);
  }
  if (fields.length > 0) {
    fields.push(`updated_at = ${nowExpr(db)}`);
    values.push(id);
    await dbRun(db, `UPDATE mobile_sessions SET ${fields.join(', ')} WHERE id = ?`, values);
  }
  const session = await getMobileSession(db, id);
  if (!session) throw new Error(`Mobile session not found: ${id}`);
  return session;
}

export async function setMobileSessionStatus(db: DbProvider, id: string, status: MobileSessionStatus, captureStatus?: MobileCaptureStatus, health?: Record<string, any>): Promise<MobileSession> {
  return updateMobileSession(db, id, {
    status,
    ...(captureStatus ? { capture_status: captureStatus } : {}),
    ...(health ? { health_json: health } : {}),
  } as any);
}

export async function createMobileAction(db: DbProvider, input: {
  session_id: string;
  scan_run_id?: string;
  task_id?: string;
  action_type: string;
  input_json?: Record<string, any>;
  result_json?: Record<string, any>;
  screenshot_artifact_id?: string;
  status?: string;
}): Promise<MobileActionRecord> {
  const latest = await dbGet<any>(db, 'SELECT MAX(sequence) AS max_sequence FROM mobile_actions WHERE session_id = ?', [input.session_id]);
  const sequence = Number(latest?.max_sequence || 0) + 1;
  const id = uuidv4();
  await dbRun(db, `INSERT INTO mobile_actions (id, session_id, scan_run_id, task_id, sequence, action_type, input_json, result_json, screenshot_artifact_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    id,
    input.session_id,
    input.scan_run_id || null,
    input.task_id || null,
    sequence,
    input.action_type,
    JSON.stringify(input.input_json || {}),
    JSON.stringify(input.result_json || {}),
    input.screenshot_artifact_id || null,
    input.status || 'completed',
  ]);
  const row = await dbGet<any>(db, 'SELECT * FROM mobile_actions WHERE id = ?', [id]);
  return normalizeAction(row);
}

export async function listMobileActions(db: DbProvider, sessionId: string): Promise<MobileActionRecord[]> {
  const rows = await dbAll<any>(db, 'SELECT * FROM mobile_actions WHERE session_id = ? ORDER BY sequence ASC', [sessionId]);
  return rows.map(normalizeAction);
}
