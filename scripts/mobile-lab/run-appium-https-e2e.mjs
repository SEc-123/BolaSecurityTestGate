#!/usr/bin/env node
/** Product API only; a missing device/proxy/driver is failure, never skipped PASS.
 * Appium's HTTP control protocol is distinct from the App's required HTTPS API. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const runId = randomUUID();
const dir = path.resolve(process.env.BSTG_E2E_ARTIFACT_DIR || `artifacts/appium-https/${runId}`);
const base = (process.env.BSTG_E2E_BSTG_API_URL || 'http://127.0.0.1:3101').replace(/\/$/, '');
const sha = b => createHash('sha256').update(b).digest('hex');
const assert = (v, m) => { if (!v) throw new Error(m); };
const required = n => { assert(process.env[n]?.trim(), `Missing ${n}`); return process.env[n].trim(); };
const headers = { 'Content-Type': 'application/json', ...(process.env.BSTG_E2E_API_TOKEN ? { Authorization: `Bearer ${process.env.BSTG_E2E_API_TOKEN}` } : {}) };
const report = { format_version: 2, runner_id: runId, ok: false, errors: [], requests: [], files: {}, started_at: new Date().toISOString(), evidence_level: 'not_verified', scope: 'Appium native UI + complete verified HTTPS business assertions, not a whole-App vulnerability certification' };
let sessionId;
async function save(name, bytes) { await fs.writeFile(path.join(dir, name), bytes, { mode: 0o600 }); report.files[name] = { sha256: sha(bytes), bytes: Buffer.byteLength(bytes) }; }
async function saveJson(name, data) { await save(name, JSON.stringify(data, null, 2) + '\n'); }
async function api(name, route, method = 'GET', body, allowFailed = false) {
  const started = Date.now();
  const res = await fetch(base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(600000) });
  report.requests.push({method,route,status:res.status,duration_ms:Date.now()-started});
  const data = await res.json();
  await saveJson(name, data);
  if (!allowFailed || !data.data) assert(res.ok && !data.error, `${route}: ${data.error || res.status}`);
  return data.data;
}
const xml = value => String(value ?? '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
async function main() {
  await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; assert(!(await fs.readdir(dir)).length, 'Evidence directory must be new/empty.'); }
  try {
    assert(process.env.BSTG_E2E_AUTHORIZED === 'true', 'Set BSTG_E2E_AUTHORIZED=true only for your authorized APK, isolated device and test backend.');
    assert(!process.env.BSTG_E2E_TRIGGER_ADB_SHELL, 'ADB trigger shortcuts are forbidden; Appium drives the business test.');
    const input = JSON.parse(await fs.readFile(required('BSTG_E2E_PROFILE_JSON_FILE'), 'utf8'));
    const cfg = input.config_json || {};
    assert(input.id && input.is_enabled !== false && input.id !== 'offline-simulator-v0.2.0' && cfg.offline_simulator !== true && cfg.offline_simulator !== 'true' && cfg.strict_real_e2e !== false, 'An enabled strict real-device profile is required.');
    assert(input.appium_server_url || cfg.appium_server_url, 'Appium URL required; ADB-only operation is not acceptance.');
    assert(cfg.allow_insecure_upstream !== true && cfg.capture_allowed_hosts?.length, 'Verified upstream TLS and an explicit authorized host allowlist are required.');
    const parsed = JSON.parse(await fs.readFile(required('BSTG_E2E_FLOW_JSON_FILE'), 'utf8'));
    const steps = Array.isArray(parsed) ? parsed : parsed.steps;
    assert(Array.isArray(steps) && steps.length && steps.some(s => (s.action || s.type) !== 'wait' && s.expect_network?.length), 'At least one actual business action needs HTTPS assertions.');
    for (const step of steps) for (const e of step.expect_network || []) {
      const u = new URL(e.url);
      assert(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'App business URLs must be HTTPS; no HTTP downgrade.');
      assert(cfg.capture_allowed_hosts.map(h => h.toLowerCase()).includes(u.hostname.toLowerCase()), 'Business URL outside authorized host allowlist.');
    }
    const bytes = await fs.readFile(required('BSTG_E2E_APK_PATH'));
    assert(bytes.length && bytes.length <= 64 * 1024 * 1024, 'APK upload supports 1 byte–64 MiB.');
    const source = required('BSTG_E2E_APK_SOURCE');
    const profile = await api('profile.json', '/api/mobile/profiles', 'POST', input);
    const app = await api('apk.json', '/api/mobile/apps/import', 'POST', { profile_id: profile.id, filename: path.basename(process.env.BSTG_E2E_APK_PATH), base64: bytes.toString('base64'), apk_source: source });
    assert(app.sha256 === sha(bytes) && app.signature_verified && app.signer_sha256, 'Uploaded APK identity/signature mismatch.');
    const session = await api('session.json', '/api/mobile/sessions', 'POST', { profile_id: profile.id, device_id: process.env.BSTG_E2E_DEVICE_ID || profile.adb_serial, apk_path: app.apk_path, apk_source: source, apk_sha256: app.sha256, apk_signer_sha256: app.signer_sha256, app_package: app.package_name, app_activity: app.launch_activity });
    sessionId = session.id; report.mobile_session_id = sessionId;
    const route = `/api/mobile/sessions/${encodeURIComponent(sessionId)}`;
    // Server owns cleanup even if this HTTP request disconnects or times out.
    const result = await api('test-response.json', route + '/test', 'POST', { steps, authorized: true, import_capture: process.env.BSTG_E2E_IMPORT_CAPTURE !== 'false' }, true);
    assert(result.mobile_session_id === sessionId && result.apk_sha256 === app.sha256 && result.device_id === session.device_id, 'App test result identity mismatch.');
  } catch (e) { report.errors.push(e.message || String(e)); }
  finally {
    if (sessionId) {
      const route = `/api/mobile/sessions/${encodeURIComponent(sessionId)}`;
      try {
        const state = await api('state-before-final.json', route);
        if (state.session.status !== 'stopped') await api('cleanup-retry.json', route + '/stop', 'POST', {});
      } catch (e) { report.errors.push(`Cleanup: ${e.message}`); }
      try {
        const result = await api('appium-test-report.json', route + '/test-report');
        report.result = result;
        for (const action of result.actions || []) {
          for (const [kind, name] of Object.entries({ screen: 'screen.png', ui: 'ui.json', network: 'network.json', appium: 'appium.json' })) {
            const file = action.result_json?.evidence?.files?.[name]; if (!file) continue;
            const started = Date.now();
  const res = await fetch(base + route + `/actions/${encodeURIComponent(action.id)}/evidence/${kind}`, { headers, signal: AbortSignal.timeout(30000) });
            assert(res.ok, `Evidence retrieval failed: ${action.id}/${kind}`);
            const bytes = Buffer.from(await res.arrayBuffer());
            assert(sha(bytes) === file.sha256, `Evidence digest mismatch: ${action.id}/${kind}`);
            await save(`${action.id}-${name}`, bytes);
          }
        }
        assert(result.acceptance_complete === true && result.gate_result === 'PASS', `Appium HTTPS test BLOCK: ${result.blocked_reason || 'see report'}`);
        report.evidence_level = result.evidence_level;
      } catch (e) { report.errors.push(e.message || String(e)); }
    }
    report.ok = !!report.result?.acceptance_complete && report.errors.length === 0;
    report.completed_at = new Date().toISOString();
    const steps = report.result?.run?.results || [];
    const cases = steps.map((s, i) => `<testcase name="${xml(`${i+1} ${s.type}`)}">${s.ok ? '' : `<failure message="${xml(s.error || 'UI/HTTPS assertion failed')}"/>`}</testcase>`);
    cases.push(`<testcase name="final evidence and cleanup">${report.ok ? '' : `<failure message="${xml(report.errors.join('; ') || 'No complete test')}"/>`}</testcase>`);
    await save('junit.xml', `<?xml version="1.0" encoding="UTF-8"?><testsuite name="Appium HTTPS" tests="${cases.length}" failures="${steps.filter(s=>!s.ok).length+(report.ok?0:1)}">${cases.join('')}</testsuite>\n`);
    await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ ok: report.ok, evidence_dir: dir, errors: report.errors }, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
