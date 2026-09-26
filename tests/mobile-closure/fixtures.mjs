import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { defaultMobileProfile, upsertMobileProfile } from '../../server/src/services/mobile/mobile-profile-service.ts';
import { createMobileSession, updateMobileSession } from '../../server/src/services/mobile/mobile-session-service.ts';
import { SqliteProvider } from '../../server/src/db/sqlite-provider.ts';
export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9eEAAAAASUVORK5CYII=';
export const pkg = 'test.authorized.app';
export const profile = () => ({ ...defaultMobileProfile(), id: randomUUID(), name: 'Unit-test device adapter; NOT Android', adb_serial: 'test-device', appium_server_url: 'http://127.0.0.1:9', runtime_type: 'manual', config_json: { strict_real_e2e: true, capture_allowed_hosts: ['api.example.test'], device_abis: ['x86_64'], managed_proxy: true } });
export const session = () => ({ id: randomUUID(), profile_id: 'profile', device_id: 'test-device', app_package: pkg, app_activity: '.MainActivity', apk_path: '/test/signed.apk', apk_source: 'test-fixture', apk_sha256: 'a'.repeat(64), apk_signer_sha256: 'b'.repeat(64), apk_package_name: pkg, apk_launch_activity: pkg+'.MainActivity', apk_native_abis: [], certificate_evidence: { ok: true, install_verified: true }, status: 'ready', capture_status: 'not_started', health_json: { apk_install: { ok: true }, app_launch: { ok: true }, flow_run: { id: 'fixture-run-not-device', driver: 'appium_uiautomator2', ok: true, network_assertions_passed: true, matched_flow_ids: [] }, capture: { id: 'capture-test', path: path.resolve(process.env.BSTG_DATA_DIR || '/tmp/bstg-unit-fixtures', randomUUID()+'.jsonl'), started_at: new Date(Date.now()-2000).toISOString() } } });
export const observation = () => ({ session_id: '', device_id: 'test-device', health: {source:'appium_uiautomator2',appium:{session_id:'fixture-appium-not-device',device_id:'test-device'}}, observed_at: new Date().toISOString(), package: pkg, activity: pkg+'.MainActivity', screenshot_base64: PNG, ui_tree: [{ index: 0, resourceId: pkg+':id/login', text: 'Login', enabled: true, clickable: true, bounds: [0,0,100,100] }], suggested_actions: [] });
export const flow = (s = session()) => ({ flow_id: randomUUID(), capture_session_id: s.health_json.capture.id, device_id: s.device_id, app_package: s.app_package, method: 'GET', url: 'https://api.example.test/orders', test_run_id: s.health_json.flow_run?.id || 'fixture-run-not-device', step_id: 'fixture-step-not-device', request_body_text: '', request_complete: true, response_complete: true, tls: {client_version:'TLSv1.3',server_version:'TLSv1.3',upstream_verified:true}, request_headers: {}, response_headers: { 'content-type': 'application/json' }, response_body_text: '{"orders":[]}', response_status: 200, tls_decrypted: true, started_at: new Date().toISOString(), source_tool: 'test_fixture_not_device', attribution: 'operator_isolated_device_and_host_allowlist' });
export async function database() { const db = new SqliteProvider('closure-test',{file:':memory:'}); await db.connect(); await db.migrate(); return db; }
export async function readySession(db, overrides = {}) {
  const p = { ...profile(), ...overrides }; await upsertMobileProfile(db, p);
  const raw = session(); await mkdir(path.dirname(raw.health_json.capture.path),{recursive:true}); await writeFile(raw.health_json.capture.path,''); const s = await createMobileSession(db, {...raw, profile_id:p.id});
  return { profile:p, session: await updateMobileSession(db,s.id,{ status:'ready', health_json:raw.health_json, certificate_evidence:raw.certificate_evidence }) };
}

export const appiumResult = () => ({ok:true,source:'appium_uiautomator2',appium:{session_id:'fixture-appium-not-device',device_id:'test-device'}});
export const networkExpected = () => [{id:'orders',method:'GET',url:'https://api.example.test/orders',response:{status:200}}];
