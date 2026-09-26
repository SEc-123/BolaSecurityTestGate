import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const kitRoot = path.join(root, 'mobile-lab', 'offline-kit');
const port = Number(process.env.BSTG_E2E_PORT || 3311);
const dataDir = path.join(root, 'artifacts', 'mobile-lab-offline-e2e-data');
const simulatorUrl = process.env.BSTG_MOBILE_APPIUM_URL || 'http://127.0.0.1:4723';
const serverLog = path.join(root, 'artifacts', 'mobile-lab-offline-e2e-server.log');

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      last = `${response.status} ${response.statusText}`;
    } catch (error) {
      last = error.message;
    }
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}`);
}

async function request(base, pathname, init = {}) {
  const response = await fetch(`${base}${pathname}`, { headers: { 'Content-Type': 'application/json' }, ...init });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(body).slice(0, 1600)}`);
  return body.data;
}

async function main() {
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });

  const startSimulator = spawnProcess(path.join(kitRoot, 'scripts', 'start-offline-lab.sh'), [], { cwd: kitRoot });
  let simOut = '';
  startSimulator.stdout.on('data', chunk => { simOut += String(chunk); });
  startSimulator.stderr.on('data', chunk => { simOut += String(chunk); });
  await new Promise((resolve, reject) => {
    startSimulator.on('exit', code => code === 0 ? resolve() : reject(new Error(`start-offline-lab failed (${code}): ${simOut}`)));
  });
  await waitForHttp(`${simulatorUrl}/status`);

  const env = {
    ...process.env,
    BSTG_DATA_DIR: dataDir,
    PORT: String(port),
    HOST: '127.0.0.1',
    SERVE_FRONTEND: 'false',
    BSTG_MOBILE_LAB_PROFILE: 'offline-simulator-v0.2.0',
    BSTG_MOBILE_OFFLINE_SIMULATOR: 'true',
    BSTG_MOBILE_ADB_PATH: path.join(kitRoot, 'simulator', 'adb'),
    BSTG_MOBILE_ADB_SERIAL: 'emulator-5554',
    BSTG_MOBILE_ALLOWED_PACKAGE: 'com.example.authorizedapp',
    BSTG_MOBILE_APP_PACKAGE: 'com.example.authorizedapp',
    BSTG_MOBILE_APP_ACTIVITY: '.LoginActivity',
    BSTG_MOBILE_APPIUM_URL: simulatorUrl,
    BSTG_MOBILE_PROXY_HOST: '127.0.0.1',
    BSTG_MOBILE_PROXY_PORT: '8080',
    BSTG_BURP_CAPTURE_URL: `${simulatorUrl}/bstg/mobile/capture`,
    BSTG_BURP_FLOW_EXPORT_PATH: path.join(kitRoot, 'simulator', 'fixtures', 'burp-history.example.jsonl'),
  };

  const server = spawnProcess('node', ['server/dist/index.js'], { cwd: root, env });
  let serverText = '';
  server.stdout.on('data', chunk => { serverText += String(chunk); });
  server.stderr.on('data', chunk => { serverText += String(chunk); });
  let stopped = false;
  const cleanup = async () => {
    if (!stopped) {
      stopped = true;
      server.kill('SIGTERM');
      const stop = spawnProcess(path.join(kitRoot, 'scripts', 'stop-offline-lab.sh'), [], { cwd: kitRoot });
      await new Promise(resolve => stop.on('exit', resolve));
    }
  };
  process.on('exit', () => { try { server.kill('SIGTERM'); } catch {} });

  try {
    await waitForHttp(`http://127.0.0.1:${port}/health`, 40000);
    const base = `http://127.0.0.1:${port}`;

    const profiles = await request(base, '/api/mobile/profiles');
    const profile = profiles.find(p => p.id === 'android-burp-ready-default');
    if (!profile) throw new Error('Default mobile profile missing');
    if (profile.config_json.adb_path !== env.BSTG_MOBILE_ADB_PATH) throw new Error('Default profile did not consume offline ADB path');

    const session = await request(base, '/api/mobile/sessions', {
      method: 'POST',
      body: JSON.stringify({ profile_id: 'android-burp-ready-default', app_package: 'com.example.authorizedapp', app_activity: '.LoginActivity' }),
    });
    const started = await request(base, `/api/mobile/sessions/${session.id}/start`, { method: 'POST', body: '{}' });
    if (started.health.status !== 'ready' || started.health.capture_status !== 'https_decrypted') throw new Error(`Mobile lab not ready: ${JSON.stringify(started.health)}`);

    const observed = await request(base, `/api/mobile/sessions/${session.id}/observe`);
    if (observed.package !== 'com.example.authorizedapp' || observed.ui_tree.length !== 3 || !observed.screenshot_base64) throw new Error('Android observe contract failed');

    const action = await request(base, `/api/mobile/sessions/${session.id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action: 'tap', target: { resourceId: 'com.example.authorizedapp:id/loginButton' } }),
    });
    if (action.result?.ok !== true || action.observation?.ui_tree?.length !== 3) throw new Error('Android action contract failed');

    const imported = await request(base, `/api/mobile/sessions/${session.id}/import-capture`, { method: 'POST', body: JSON.stringify({ regenerate: true }) });
    if (imported.accepted_flows !== 3 || !imported.recording_session_id || imported.workflow_draft_count < 1) throw new Error(`Capture import did not close recording loop: ${JSON.stringify(imported)}`);

    const stoppedApiSession = await request(base, `/api/mobile/sessions/${session.id}/stop`, { method: 'POST', body: '{}' });
    if (stoppedApiSession.ok !== true) throw new Error('API session did not clean up before Agent acquired the same device');

    const flowSteps = [
      { action: 'input', target: { resourceId: 'com.example.authorizedapp:id/email' }, value: 'victim@example.test' },
      { action: 'input', target: { resourceId: 'com.example.authorizedapp:id/password' }, value: 'CorrectHorseBatteryStaple!' },
      { action: 'tap', target: { resourceId: 'com.example.authorizedapp:id/loginButton' } },
    ];
    const created = await request(base, '/api/ai-scans', {
      method: 'POST',
      body: JSON.stringify({
        base_url: 'https://mobile-authorized.example.test',
        name: 'Offline Android Agent closed-loop E2E',
        user_prompt: 'Run Android Mobile Lab closed loop against the authorized offline simulator.',
        selected_vuln_types: [],
        scan_config: {
          surface: 'android',
          driving_mode: 'manual_review',
          account_mode: 'manual',
          mobile: {
            platform: 'android',
            lab_profile_id: 'android-burp-ready-default',
            app_package: 'com.example.authorizedapp',
            app_activity: '.LoginActivity',
            flow_steps: flowSteps,
            burp_flow_export_path: env.BSTG_BURP_FLOW_EXPORT_PATH,
          },
        },
      }),
    });
    const scanId = created.run.id;
    await request(base, `/api/ai-scans/${scanId}/run`, { method: 'POST', body: JSON.stringify({ max_steps: 14, max_parallel_agents: 1 }) });
    const snapshot = await request(base, `/api/ai-scans/${scanId}`);
    const productState = await request(base, `/api/ai-scans/${scanId}/product-state`);
    if (productState.active_surface !== 'android') throw new Error(`Product state did not expose android surface: ${productState.active_surface}`);
    if (!productState.live_surface || !productState.live_surface.screenshot_base64) throw new Error('Product state did not expose the controlled Android app frame');
    if (!Array.isArray(productState.business_functions) || productState.business_functions.length < 1) throw new Error('Product state did not expose user-facing business function plan');
    if (!Array.isArray(productState.current_work) || !productState.current_work.some(item => item.name === '导入 App 网络证据')) throw new Error('Product state did not expose user-facing current work');
    const completedTools = new Set(snapshot.tool_invocations.filter(t => t.status === 'completed').map(t => t.tool_name));
    for (const tool of ['mobile.lab.prepare', 'mobile.app.launch', 'mobile.observe', 'mobile.flow.run', 'mobile.capture.import', 'mobile.lab.stop']) {
      if (!completedTools.has(tool)) throw new Error(`Agent did not complete ${tool}`);
    }
    if (!snapshot.artifacts.some(a => a.artifact_type === 'mobile_device_state')) throw new Error('Agent did not create mobile_device_state artifact');
    if (snapshot.endpoints.length < 3) throw new Error(`Agent did not discover imported mobile endpoints: ${snapshot.endpoints.length}`);

    console.log(JSON.stringify({
      ok: true,
      evidence_level: 'simulated_not_real_device',
      mobile_api_loop: {
        session_id: session.id,
        health: started.health.capture_status,
        ui_nodes: observed.ui_tree.length,
        imported_flows: imported.accepted_flows,
        recording_session_id: imported.recording_session_id,
        workflow_draft_count: imported.workflow_draft_count,
      },
      agent_loop: {
        scan_id: scanId,
        completed_tools: Array.from(completedTools).filter(name => name.startsWith('mobile.')),
        endpoint_count: snapshot.endpoints.length,
        endpoints: snapshot.endpoints.map(e => `${e.method} ${e.path}`).sort(),
        mobile_device_artifacts: snapshot.artifacts.filter(a => a.artifact_type === 'mobile_device_state').length,
        product_functions: productState.business_functions.map(item => item.name).slice(0, 8),
        product_live_surface: productState.live_surface.artifact_type,
      },
    }, null, 2));
  } finally {
    await import('node:fs/promises').then(fs => fs.writeFile(serverLog, serverText));
    await cleanup();
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
