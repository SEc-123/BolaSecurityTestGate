import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { DbProvider } from '../../types/index.js';
import { dbGet, dbRun } from '../../db/sql-helpers.js';
import type { MobileLabProfile, MobileSession } from './mobile-types.js';
import { isOfflineProfile } from './mobile-target-contract.js';

const operations = new Set<string>();
const testOwners = new Set<string>();
const testScope = new AsyncLocalStorage<string>();

/** A server-owned test keeps lifecycle ownership between individual operations.
 * This prevents interactive actions from slipping between launch and testing.
 * One backend worker is required; process death deliberately retains DB leases. */
export async function withMobileTestRun<T>(id: string, operation: () => Promise<T>): Promise<T> {
  if (testOwners.has(id) || operations.has(id)) throw new Error('MOBILE_BUSY: session already has an active operation/test.');
  testOwners.add(id);
  try { return await testScope.run(id, operation); } finally { testOwners.delete(id); }
}

export async function withMobileOperation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  if (testOwners.has(key) && testScope.getStore() !== key) throw new Error('MOBILE_BUSY: this session is owned by an Appium test.');
  if (operations.has(key)) throw new Error('MOBILE_BUSY: another operation is running for this session.');
  operations.add(key);
  try { return await operation(); } finally { operations.delete(key); }
}

export function profileForSession(profile: MobileLabProfile, session: MobileSession): MobileLabProfile {
  const capture = session.health_json?.capture || {};
  const cfg: Record<string, any> = { ...profile.config_json, app_package: session.app_package || profile.config_json?.app_package,
    app_activity: session.app_activity || profile.config_json?.app_activity, mobile_session_id: session.id };
  if (capture.id) Object.assign(cfg, { capture_session_id: capture.id, capture_started_at: capture.started_at,
    burp_flow_export_path: capture.path, capture_step_path: `${capture.path}.step.json`, burp_capture_url: isOfflineProfile(profile) ? cfg.burp_capture_url : '' });
  return { ...profile, adb_serial: session.device_id || profile.adb_serial, config_json: cfg };
}

export function newCaptureContext(sessionId: string): Record<string, any> {
  const id = randomUUID();
  return { id, started_at: new Date().toISOString(), path: path.resolve(process.env.BSTG_DATA_DIR || 'data', 'mobile', 'captures', sessionId, `${id}.jsonl`) };
}

async function ensureLeaseTable(db: DbProvider): Promise<void> {
  await dbRun(db, `CREATE TABLE IF NOT EXISTS mobile_resource_leases (resource_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, acquired_at TEXT NOT NULL)`);
}

// Database uniqueness, not an in-memory check, prevents two sessions from owning
// the same ADB selector/proxy. Leases intentionally survive a server crash: stale
// ownership must be inspected and cleaned, never silently stolen from a live lab.
export async function acquireMobileResources(db: DbProvider, session: MobileSession, profile: MobileLabProfile): Promise<void> {
  await ensureLeaseTable(db);
  const keys = [`adb:${session.device_id || profile.adb_serial || ''}`];
  if (profile.proxy_type !== 'none' && !isOfflineProfile(profile)) keys.push(`proxy:${profile.config_json?.proxy_listen_host || '127.0.0.1'}:${profile.proxy_port}`);
  if (profile.config_json?.appium_system_port !== undefined) keys.push(`appium-system:${profile.appium_server_url || profile.config_json?.appium_server_url}:${profile.config_json.appium_system_port}`);
  const acquired: string[] = [];
  try {
    for (const key of keys) {
      const before = await dbGet<{ session_id: string }>(db, 'SELECT session_id FROM mobile_resource_leases WHERE resource_key = ?', [key]);
      await dbRun(db, 'INSERT INTO mobile_resource_leases (resource_key, session_id, acquired_at) VALUES (?, ?, ?) ON CONFLICT(resource_key) DO NOTHING', [key, session.id, new Date().toISOString()]);
      const row = await dbGet<{ session_id: string }>(db, 'SELECT session_id FROM mobile_resource_leases WHERE resource_key = ?', [key]);
      if (row?.session_id !== session.id) throw new Error(`MOBILE_RESOURCE_BUSY: ${key} is owned by session ${row?.session_id || 'unknown'}. Stop that session before retrying.`);
      if (!before) acquired.push(key);
    }
  } catch (error) {
    for (const key of acquired) await dbRun(db, 'DELETE FROM mobile_resource_leases WHERE resource_key = ? AND session_id = ?', [key, session.id]);
    throw error;
  }
}

export async function releaseMobileResources(db: DbProvider, sessionId: string): Promise<void> {
  await ensureLeaseTable(db);
  await dbRun(db, 'DELETE FROM mobile_resource_leases WHERE session_id = ?', [sessionId]);
}

export function assertSessionUsable(session: MobileSession, profile: MobileLabProfile): void {
  if (!profile.is_enabled) throw new Error('Mobile profile is disabled.');
  if (!['ready', 'running'].includes(session.status)) throw new Error(`Mobile session is ${session.status}; prepare/recover the lab before executing actions.`);
}
