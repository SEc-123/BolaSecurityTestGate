import { androidTool } from './android-sdk.js';
import { isOfflineProfile } from './mobile-target-contract.js';
import { randomUUID as uuidv4 } from 'node:crypto';
import type { DbProvider } from '../../types/index.js';
import { dbAll, dbGet, dbRun } from '../../db/sql-helpers.js';
import type { MobileLabProfile } from './mobile-types.js';

function jsonParse(value: unknown, fallback: Record<string, any> = {}): Record<string, any> {
  if (!value) return fallback;
  if (typeof value === 'object') return value as Record<string, any>;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function normalize(row: any): MobileLabProfile {
  return {
    ...row,
    android_api_level: row.android_api_level === null || row.android_api_level === undefined ? undefined : Number(row.android_api_level),
    proxy_port: row.proxy_port === null || row.proxy_port === undefined ? undefined : Number(row.proxy_port),
    config_json: jsonParse(row.config_json, {}),
    is_enabled: bool(row.is_enabled),
  } as MobileLabProfile;
}

export function defaultMobileProfile(): MobileLabProfile {
  return {
    id: 'android-burp-ready-default',
    name: 'Android real-device / target manifest required',
    description: 'Generic Android lab profile. The target manifest supplies the APK, package identity, launch entry, capture source, certificate mode and declared business flow. No sample App identity is treated as a valid target.',
    runtime_type: (process.env.BSTG_MOBILE_RUNTIME_TYPE as any) || (process.env.BSTG_MOBILE_LAB_PROFILE === 'offline-simulator-v0.2.0' ? 'remote' : 'local_avd'),
    android_api_level: Number(process.env.BSTG_MOBILE_API_LEVEL || 34),
    device_name: process.env.BSTG_MOBILE_DEVICE_NAME || process.env.BSTG_MOBILE_LAB_PROFILE || 'bstg-api34-burp-ready',
    adb_serial: process.env.BSTG_MOBILE_ADB_SERIAL || '',
    appium_server_url: process.env.BSTG_MOBILE_APPIUM_URL || process.env.BSTG_APPIUM_URL || '',
    proxy_type: (process.env.BSTG_MOBILE_PROXY_TYPE as any) || 'mitmproxy',
    proxy_host: process.env.BSTG_MOBILE_PROXY_HOST || process.env.BSTG_BURP_HOST || '127.0.0.1',
    proxy_port: Number(process.env.BSTG_MOBILE_PROXY_PORT || process.env.BSTG_BURP_PORT || 8080),
    certificate_mode: (process.env.BSTG_MOBILE_CERTIFICATE_MODE as any) || 'preinstalled_system_ca',
    config_json: {
      adb_path: androidTool('adb', process.env.BSTG_MOBILE_ADB_PATH || process.env.BSTG_ADB_PATH),
      emulator_path: androidTool('emulator', process.env.BSTG_EMULATOR_PATH),
      emulator_start_command: process.env.BSTG_EMULATOR_START_COMMAND || '',
      allow_software_emulation: process.env.BSTG_MOBILE_ALLOW_SOFTWARE_EMULATION === 'true',
      burp_start_command: process.env.BSTG_BURP_START_COMMAND || '',
      burp_flow_export_path: process.env.BSTG_BURP_FLOW_EXPORT_PATH || '',
      burp_capture_url: process.env.BSTG_BURP_CAPTURE_URL || (process.env.BSTG_MOBILE_APPIUM_URL ? `${process.env.BSTG_MOBILE_APPIUM_URL.replace(/\/$/, '')}/bstg/mobile/capture` : ''),
      managed_proxy: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true' && process.env.BSTG_MOBILE_MANAGED_PROXY !== 'false',
      capture_allowed_hosts: (process.env.BSTG_MOBILE_CAPTURE_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean),
      proxy_listen_host: process.env.BSTG_MOBILE_PROXY_LISTEN_HOST || '127.0.0.1',
      mitm_proxy_mode: process.env.BSTG_MOBILE_MITM_PROXY_MODE || 'regular',
      aapt_path: androidTool('aapt', process.env.BSTG_MOBILE_AAPT_PATH),
      apksigner_path: androidTool('apksigner', process.env.BSTG_MOBILE_APKSIGNER_PATH),
      mitmdump_path: process.env.BSTG_MITMDUMP_PATH || 'mitmdump',
      mitm_reverse_upstream: process.env.BSTG_MOBILE_MITM_REVERSE_UPSTREAM || '',
      managed_proxy_confdir: process.env.BSTG_MOBILE_PROXY_CONFDIR || '',
      mitm_capture_addon: process.env.BSTG_MOBILE_MITM_CAPTURE_ADDON || '',
      certificate_provisioning: process.env.BSTG_MOBILE_CERTIFICATE_PROVISIONING || 'managed_mitmproxy',
      proxy_ca_certificate_path: process.env.BSTG_MOBILE_PROXY_CA_CERTIFICATE_PATH || '',
      proxy_ca_sha256: process.env.BSTG_MOBILE_PROXY_CA_SHA256 || '',
      allow_system_ca_install: process.env.BSTG_MOBILE_ALLOW_SYSTEM_CA_INSTALL === 'true',
      manual_certificate_verified: process.env.BSTG_MOBILE_MANUAL_CERTIFICATE_VERIFIED === 'true',
      manual_certificate_evidence: process.env.BSTG_MOBILE_MANUAL_CERTIFICATE_EVIDENCE || '',
      appium_server_url: process.env.BSTG_MOBILE_APPIUM_URL || process.env.BSTG_APPIUM_URL || '',
      app_package: process.env.BSTG_MOBILE_APP_PACKAGE || process.env.BSTG_MOBILE_ALLOWED_PACKAGE || '',
      app_activity: process.env.BSTG_MOBILE_APP_ACTIVITY || '',
      offline_simulator: process.env.BSTG_MOBILE_LAB_PROFILE === 'offline-simulator-v0.2.0' || process.env.BSTG_MOBILE_OFFLINE_SIMULATOR === 'true',
      strict_real_e2e: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      require_apk_install: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      require_explicit_app_identity: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      require_explicit_tls_evidence: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      require_capture_app_identity: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      require_flow_steps: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      require_flow_assertions: process.env.BSTG_MOBILE_OFFLINE_SIMULATOR !== 'true',
      minimum_decrypted_flows: Number(process.env.BSTG_MOBILE_MIN_DECRYPTED_FLOWS || 1),
      minimum_workflow_drafts: Number(process.env.BSTG_MOBILE_MIN_WORKFLOW_DRAFTS || 1),
      https_probe_url: process.env.BSTG_MOBILE_HTTPS_PROBE_URL || 'https://example.com/',
      proxy_probe_url: process.env.BSTG_MOBILE_PROXY_PROBE_URL || 'http://burpsuite/',
      screen_stream_url: process.env.BSTG_SCREEN_STREAM_URL || process.env.BSTG_MOBILE_SCREEN_STREAM_URL || '',
      action_delay_ms: Number(process.env.BSTG_MOBILE_ACTION_DELAY_MS || 700),
    },
    is_enabled: true,
  };
}

export async function ensureDefaultMobileProfile(db: DbProvider): Promise<MobileLabProfile> {
  const existing = await dbGet<any>(db, 'SELECT * FROM mobile_lab_profiles WHERE id = ?', ['android-burp-ready-default']).catch(() => null);
  if (existing) return normalize(existing);
  const profile = defaultMobileProfile();
  await dbRun(db, `INSERT INTO mobile_lab_profiles (id, name, description, runtime_type, android_api_level, device_name, adb_serial, appium_server_url, proxy_type, proxy_host, proxy_port, certificate_mode, config_json, is_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    profile.id,
    profile.name,
    profile.description || null,
    profile.runtime_type,
    profile.android_api_level || null,
    profile.device_name || null,
    profile.adb_serial || null,
    profile.appium_server_url || null,
    profile.proxy_type,
    profile.proxy_host || null,
    profile.proxy_port || null,
    profile.certificate_mode,
    JSON.stringify(profile.config_json || {}),
    db.kind === 'sqlite' ? 1 : true,
  ]).catch(() => undefined);
  const row = await dbGet<any>(db, 'SELECT * FROM mobile_lab_profiles WHERE id = ?', [profile.id]).catch(() => null);
  return row ? normalize(row) : profile;
}

export async function listMobileProfiles(db: DbProvider): Promise<MobileLabProfile[]> {
  await ensureDefaultMobileProfile(db).catch(() => undefined);
  const rows = await dbAll<any>(db, 'SELECT * FROM mobile_lab_profiles ORDER BY is_enabled DESC, created_at DESC').catch(() => []);
  return rows.length ? rows.map(normalize) : [defaultMobileProfile()];
}

export async function getMobileProfile(db: DbProvider, id?: string): Promise<MobileLabProfile> {
  if (!id) return ensureDefaultMobileProfile(db);
  const row = await dbGet<any>(db, 'SELECT * FROM mobile_lab_profiles WHERE id = ?', [id]).catch(() => null);
  if (row) return normalize(row);
  const fallback = await ensureDefaultMobileProfile(db);
  if (id === fallback.id) return fallback;
  throw new Error(`Mobile lab profile not found: ${id}`);
}

export async function upsertMobileProfile(db: DbProvider, input: Partial<MobileLabProfile> & { name: string }): Promise<MobileLabProfile> {
  if (!input || typeof input !== 'object' || !String(input.name || '').trim()) throw new Error('Mobile profile name is required.');
  if (input.config_json !== undefined && (!input.config_json || typeof input.config_json !== 'object' || Array.isArray(input.config_json))) throw new Error('config_json must be an object.');
  if (input.is_enabled !== undefined && typeof input.is_enabled !== 'boolean') throw new Error('is_enabled must be boolean.');
  if (input.proxy_port !== undefined && (!Number.isInteger(input.proxy_port) || input.proxy_port < 1 || input.proxy_port > 65535)) throw new Error('proxy_port must be 1–65535.');
  if (input.runtime_type && !['local_avd','docker','redroid','remote','manual'].includes(input.runtime_type)) throw new Error('Unsupported mobile runtime.');
  if (input.proxy_type && !['internal_burp','external_burp','mitmproxy','none'].includes(input.proxy_type)) throw new Error('Unsupported mobile proxy.');
  const config = input.config_json || {};
  const appiumEndpoint = input.appium_server_url || config.appium_server_url;
  if (appiumEndpoint) {
    let endpoint: URL; try { endpoint = new URL(String(appiumEndpoint)); } catch { throw new Error('Invalid Appium server URL.'); }
    if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Appium URL must be HTTP(S) without embedded credentials, query or fragment.');
  }
  if (config.appium_system_port !== undefined && (!Number.isInteger(config.appium_system_port) || config.appium_system_port < 1024 || config.appium_system_port > 65535)) throw new Error('appium_system_port must be 1024–65535.');
  for (const key of ['appium_session_timeout_ms','appium_command_timeout_ms','appium_health_timeout_ms','appium_find_timeout_ms']) if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 100 || config[key] > 180000)) throw new Error(`${key} must be an integer in 100–180000 ms.`);
  for (const key of ['offline_simulator','strict_real_e2e','managed_proxy','require_apk_install','require_explicit_app_identity','require_explicit_tls_evidence','require_capture_app_identity','require_flow_steps','require_flow_assertions','require_apk_attestation','require_proxy_certificate','proxy_use_adb_reverse','allow_system_ca_install','allow_insecure_upstream','manual_certificate_verified']) {
    if (config[key] !== undefined && typeof config[key] !== 'boolean') throw new Error(`${key} must be boolean, not a string.`);
  }
  if (config.use_simulator !== undefined) throw new Error('Use the explicit offline_simulator flag, not use_simulator.');
  if (config.capture_allowed_hosts !== undefined && (!Array.isArray(config.capture_allowed_hosts) || config.capture_allowed_hosts.some((host: unknown) => typeof host !== 'string' || !/^[a-z0-9.-]+$/i.test(host) || host.includes('..')))) throw new Error('capture_allowed_hosts must contain exact hostnames, not URLs or wildcards.');
  for (const key of ['device_wait_timeout_ms','apk_install_timeout_ms','action_delay_ms','capture_timeout_ms','proxy_start_grace_ms','burp_start_grace_ms']) if (config[key] !== undefined && (!Number.isFinite(config[key]) || config[key] < 0 || config[key] > 300000)) throw new Error(`${key} must be between 0 and 300000 ms.`);
  for (const key of ['minimum_decrypted_flows','minimum_workflow_drafts']) if (config[key] !== undefined && (!Number.isInteger(config[key]) || config[key] < 1)) throw new Error(`${key} must be a positive integer.`);
  const id = input.id || uuidv4();
  const existing = await dbGet<any>(db, 'SELECT * FROM mobile_lab_profiles WHERE id = ?', [id]).catch(() => null);
  const merged: MobileLabProfile = {
    ...defaultMobileProfile(),
    ...(existing ? normalize(existing) : {}),
    ...input,
    id,
    is_enabled: input.is_enabled ?? (existing ? normalize(existing).is_enabled : true),
    config_json: { ...defaultMobileProfile().config_json, ...(existing ? normalize(existing).config_json : {}), ...(input.config_json || {}) },
  };
  // Do not persist a physical-device profile that can later be switched to a
  // plaintext capture path.  Session preparation repeats this check because
  // old persisted profiles may predate the contract.
  if (!isOfflineProfile(merged) && merged.config_json.capture_http_only === true) {
    throw new Error('Physical Android profiles require decrypted HTTPS capture; capture_http_only is reserved for the explicitly simulated offline profile.');
  }
  const captureOrigin = String(merged.config_json.capture_origin || '').trim();
  if (!isOfflineProfile(merged) && captureOrigin) {
    let parsed: URL;
    try { parsed = new URL(captureOrigin); } catch { throw new Error('Physical Android profiles require a valid HTTPS capture_origin.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Physical Android profiles require an HTTPS capture_origin without embedded credentials.');
  }
  if (merged.config_json.offline_simulator === true || merged.id === 'offline-simulator-v0.2.0') {
    merged.config_json.strict_real_e2e = false;
    merged.config_json.managed_proxy = false;
    for (const key of ['require_apk_install','require_apk_attestation','require_proxy_certificate','require_explicit_app_identity','require_explicit_tls_evidence','require_capture_app_identity','require_flow_steps','require_flow_assertions']) merged.config_json[key] = config[key] === true;
  }
  if (existing) {
    await dbRun(db, `UPDATE mobile_lab_profiles SET name = ?, description = ?, runtime_type = ?, android_api_level = ?, device_name = ?, adb_serial = ?, appium_server_url = ?, proxy_type = ?, proxy_host = ?, proxy_port = ?, certificate_mode = ?, config_json = ?, is_enabled = ?, updated_at = ${db.kind === 'postgres' ? 'now()' : "datetime('now')"} WHERE id = ?`, [
      merged.name, merged.description || null, merged.runtime_type, merged.android_api_level || null, merged.device_name || null, merged.adb_serial || null, merged.appium_server_url || null, merged.proxy_type, merged.proxy_host || null, merged.proxy_port || null, merged.certificate_mode, JSON.stringify(merged.config_json || {}), db.kind === 'sqlite' ? (merged.is_enabled ? 1 : 0) : merged.is_enabled, id,
    ]);
  } else {
    await dbRun(db, `INSERT INTO mobile_lab_profiles (id, name, description, runtime_type, android_api_level, device_name, adb_serial, appium_server_url, proxy_type, proxy_host, proxy_port, certificate_mode, config_json, is_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id, merged.name, merged.description || null, merged.runtime_type, merged.android_api_level || null, merged.device_name || null, merged.adb_serial || null, merged.appium_server_url || null, merged.proxy_type, merged.proxy_host || null, merged.proxy_port || null, merged.certificate_mode, JSON.stringify(merged.config_json || {}), db.kind === 'sqlite' ? (merged.is_enabled ? 1 : 0) : merged.is_enabled,
    ]);
  }
  return getMobileProfile(db, id);
}
