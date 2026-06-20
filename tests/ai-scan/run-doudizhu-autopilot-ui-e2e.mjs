#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const requireFromServer = createRequire(path.join(repoRoot, 'server/package.json'));
const { chromium } = requireFromServer('playwright');
const Database = requireFromServer('better-sqlite3');

const targetSourceDir = process.env.TARGET_SOURCE_DIR || path.join(os.homedir(), 'Downloads', '\u6597\u5730\u4e3b\u5c0f\u6e38\u620f\u6e90\u7801');
const targetPort = Number(process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_TARGET_PORT || 3460);
const serverPort = Number(process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_SERVER_PORT || 3461);
const aiProviderPort = Number(process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_AI_PROVIDER_PORT || (serverPort + 20));
const frontendPort = Number(process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_FRONTEND_PORT || 3462);
const dataDir = process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_DATA_DIR || path.join('/tmp', `bstg-doudizhu-autopilot-ui-${Date.now()}`);
const artifactDir = process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_ARTIFACT_DIR || path.join(repoRoot, 'artifacts', `doudizhu-autopilot-ui-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const reportPath = process.env.AI_SCAN_DOUDIZHU_AUTOPILOT_REPORT || path.join(repoRoot, 'tests/ai-scan/reports/latest-doudizhu-autopilot-ui-report.json');
const expectedAllVulns = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
];
const rawAccountRequest = [
  'POST /index.php/index/sign HTTP/1.1',
  'Host: target',
  'Cookie: member=session-attacker',
  'Authorization: Bearer token-attacker',
  'Content-Type: application/json',
  '',
  '{"name":"alice","password":"AlicePass123","captcha":"123456","token":"token-attacker"}',
].join('\r\n');

function log(message, data) {
  console.log(`[doudizhu-autopilot-ui-e2e] ${data === undefined ? message : `${message} ${JSON.stringify(data)}`}`);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { data: null, error: text }; }
  if (!response.ok || json.error) throw new Error(`${method} ${url} failed: ${response.status} ${json.error || text}`);
  return json.data;
}

function newestMtime(dir) {
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const itemPath = path.join(dir, entry.name);
    max = Math.max(max, entry.isDirectory() ? newestMtime(itemPath) : fs.statSync(itemPath).mtimeMs);
  }
  return max;
}

function ensureServerBuild() {
  const entry = path.join(repoRoot, 'server/dist/index.js');
  const srcNewest = newestMtime(path.join(repoRoot, 'server/src'));
  if (fs.existsSync(entry) && fs.statSync(entry).mtimeMs > srcNewest) return;
  log('compiling server TypeScript');
  const tsc = path.join(repoRoot, 'server/node_modules/typescript/lib/tsc.js');
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(repoRoot, 'server/tsconfig.json')], { stdio: 'inherit', cwd: repoRoot });
  if (result.status !== 0) throw new Error('server TypeScript compilation failed');
}

function summarizeSnapshot(snapshot) {
  const countBy = (items, key) => items.reduce((memo, item) => {
    const value = item[key] || 'none';
    memo[value] = (memo[value] || 0) + 1;
    return memo;
  }, {});
  const toolsByName = {};
  for (const item of snapshot.tool_invocations || []) toolsByName[item.tool_name] = (toolsByName[item.tool_name] || 0) + 1;
  const artifactsByType = {};
  for (const item of snapshot.artifacts || []) artifactsByType[item.artifact_type] = (artifactsByType[item.artifact_type] || 0) + 1;
  return {
    tasksByStatus: countBy(snapshot.tasks || [], 'status'),
    tasksByVuln: countBy((snapshot.tasks || []).filter(task => task.vuln_type), 'vuln_type'),
    candidatesByType: countBy(snapshot.candidates || [], 'vuln_type'),
    artifactsByType,
    toolsByName,
  };
}

function readDbMetrics() {
  const db = new Database(path.join(dataDir, 'app.db'));
  const scalar = sql => db.prepare(sql).get().c;
  const assetCounts = {
    api_templates: scalar('SELECT COUNT(*) c FROM api_templates'),
    workflows: scalar('SELECT COUNT(*) c FROM workflows'),
    workflow_steps: scalar('SELECT COUNT(*) c FROM workflow_steps'),
    security_rules: scalar('SELECT COUNT(*) c FROM security_rules'),
    checklists: scalar('SELECT COUNT(*) c FROM checklists'),
    accounts: scalar('SELECT COUNT(*) c FROM accounts'),
    test_runs: scalar('SELECT COUNT(*) c FROM test_runs'),
    findings: scalar('SELECT COUNT(*) c FROM findings'),
  };
  const nativeMetrics = {
    native_bstg_execution_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_bstg_execution'"),
    native_api_test_run_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_api_test_run'"),
    native_workflow_verification_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_workflow_verification'"),
    native_backed_findings: scalar("SELECT COUNT(*) c FROM findings WHERE source_type='ai_scan' AND request_evidence LIKE '%native_bstg%' AND response_evidence LIKE '%native_evidence_gate%'"),
    fallback_decisions: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='agent_decision' AND content_json LIKE '%\"source\":\"fallback\"%'"),
    ai_provider_judgements: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='ai_judgement' AND content_json LIKE '%\"source\":\"ai_provider\"%'"),
    shared_resources: scalar('SELECT COUNT(*) c FROM ai_scan_shared_resources'),
    shared_identity_pool_resources: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='identity_pool'"),
    autopilot_coverage_matrices: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='autopilot_vulnerability_coverage_matrix'"),
    account_bootstrap_results: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='account_auto_bootstrap_result'"),
  };
  const coverageRows = db.prepare("SELECT content_json FROM ai_scan_artifacts WHERE artifact_type='autopilot_vulnerability_coverage_matrix' ORDER BY created_at DESC LIMIT 1").all();
  const coverage = coverageRows[0] ? JSON.parse(coverageRows[0].content_json || '{}') : null;
  const findings = db.prepare('SELECT title,severity,response_status,response_body,request_evidence,response_evidence,ai_analysis FROM findings ORDER BY created_at').all();
  db.close();
  return { assetCounts, nativeMetrics, coverage, findings };
}

function spawnProcess(name, command, args, options) {
  const child = spawn(command, args, options);
  child.stdout?.on('data', chunk => { logs[name] += chunk.toString(); });
  child.stderr?.on('data', chunk => { logs[name] += chunk.toString(); });
  return child;
}

function chromiumExecutablePath() {
  const candidates = [
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

async function pollRun(serverBase, scanId, timeoutMs = 600000) {
  const started = Date.now();
  let latest;
  while (Date.now() - started < timeoutMs) {
    latest = await api('GET', `${serverBase}/api/ai-scans/${scanId}`);
    if (['completed', 'failed', 'awaiting_selection'].includes(latest.run.status)) return latest;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for autopilot run ${scanId}; last status=${latest?.run?.status || 'unknown'}`);
}

const logs = { target: '', server: '', aiProvider: '', frontend: '' };

async function main() {
  assert(fs.existsSync(targetSourceDir), 'TARGET_SOURCE_DIR does not exist', { targetSourceDir });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  ensureServerBuild();

  const target = spawnProcess('target', process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/doudizhu-blackbox-target.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(targetPort), TARGET_SOURCE_DIR: targetSourceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = spawnProcess('server', process.execPath, [path.join(repoRoot, 'server/dist/index.js')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(serverPort), BSTG_DATA_DIR: dataDir, SERVE_FRONTEND: 'false', CLEANUP_INTERVAL_HOURS: '999999' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const aiProvider = spawnProcess('aiProvider', process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/local-autonomous-ai-provider.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(aiProviderPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const frontend = spawnProcess('frontend', 'npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(frontendPort), '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, VITE_API_URL: `http://127.0.0.1:${serverPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let browser;
  try {
    const targetBase = `http://127.0.0.1:${targetPort}/`;
    const serverBase = `http://127.0.0.1:${serverPort}`;
    const frontendBase = `http://127.0.0.1:${frontendPort}`;
    const health = JSON.parse(await waitFor(`${targetBase}health`, 30000));
    await waitFor(`${serverBase}/health`, 30000);
    await waitFor(`http://127.0.0.1:${aiProviderPort}/health`, 30000);
    await waitFor(frontendBase, 30000);
    await api('POST', `${serverBase}/api/ai/providers`, {
      name: 'Local Autonomous AI Driver',
      provider_type: 'openai_compat',
      base_url: `http://127.0.0.1:${aiProviderPort}/v1`,
      api_key: 'local-test-key',
      model: 'local-autonomous-ai-provider',
      is_enabled: true,
      is_default: true,
    });
    log('target, provider, server and frontend ready', { route_count: health.route_count, targetBase, serverBase, frontendBase });

    const executablePath = chromiumExecutablePath();
    assert(Boolean(executablePath), 'No Chromium/Chrome executable found for browser UI E2E');
    browser = await chromium.launch({ headless: true, executablePath });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    page.setDefaultTimeout(30000);
    await page.goto(frontendBase, { waitUntil: 'networkidle' });
    await page.getByPlaceholder('https://target.example.com').fill(targetBase);
    await page.getByRole('button', { name: /Requests/ }).click();
    await page.locator('textarea[placeholder="Paste HTTP requests"]').fill(rawAccountRequest);
    await page.screenshot({ path: path.join(artifactDir, '01-before-start.png'), fullPage: true });

    await page.getByRole('button', { name: /Start autopilot/ }).click();
    await page.waitForSelector('text=/Completed|Failed|Awaiting selection/', { timeout: 600000 });
    await page.screenshot({ path: path.join(artifactDir, '02-after-autopilot-run.png'), fullPage: true });

    const runs = await api('GET', `${serverBase}/api/ai-scans`);
    assert(Array.isArray(runs) && runs.length === 1, 'UI should create exactly one autopilot scan in a fresh data dir', { runs: runs?.map(run => ({ id: run.id, status: run.status, base_url: run.base_url })) });
    const scanId = runs[0].id;
    const snapshot = await pollRun(serverBase, scanId);
    const summary = summarizeSnapshot(snapshot);
    const metrics = readDbMetrics();
    const pageText = await page.locator('body').innerText();

    log('autopilot run finished', { status: snapshot.run.status, tasksByStatus: summary.tasksByStatus, endpoints: snapshot.endpoints.length, assetCounts: metrics.assetCounts, nativeMetrics: metrics.nativeMetrics });

    assert(snapshot.run.status === 'completed', 'autopilot run must complete from the UI Start flow', { status: snapshot.run.status, tasksByStatus: summary.tasksByStatus });
    assert(snapshot.run.scan_config?.driving_mode === 'autopilot', 'run must be an autopilot scan', snapshot.run.scan_config);
    assert(snapshot.run.scan_config?.selected_scope_strategy === 'all_vulnerability_types', 'autopilot must use all-vulnerability scope strategy', snapshot.run.scan_config);
    assert(snapshot.run.scan_config?.account_mode === 'raw', 'UI account mode selection should persist as raw request mode', snapshot.run.scan_config);
    assert(new Set(snapshot.run.selected_vuln_types || []).size === expectedAllVulns.length, 'autopilot should select all vulnerability types', snapshot.run.selected_vuln_types);
    for (const type of expectedAllVulns) {
      assert((snapshot.run.selected_vuln_types || []).includes(type), `autopilot scope missing ${type}`, snapshot.run.selected_vuln_types);
      assert((summary.tasksByVuln[type] || 0) > 0, `autopilot did not create executable tasks for ${type}`, summary.tasksByVuln);
    }
    assert(!summary.tasksByStatus.failed, 'no autopilot task should fail', summary.tasksByStatus);
    assert((summary.tasksByStatus.completed || 0) === snapshot.tasks.length, 'all autopilot tasks should complete', summary.tasksByStatus);
    assert(snapshot.endpoints.length >= 35, 'autopilot should discover the source-derived Doudizhu project attack surface', { endpoints: snapshot.endpoints.length, route_count: health.route_count });
    assert(metrics.nativeMetrics.autopilot_coverage_matrices >= 1, 'autopilot coverage matrix artifact is required', metrics.nativeMetrics);
    assert(metrics.coverage?.all_selected_types_covered === true, 'coverage matrix must prove all selected types are covered', metrics.coverage);
    assert((metrics.coverage?.missing_vuln_types || []).length === 0, 'coverage matrix must have no missing types', metrics.coverage);
    assert(metrics.nativeMetrics.shared_identity_pool_resources >= 1, 'raw account material should become shared identity pool context', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.fallback_decisions === 0, 'guarded orchestration should not rely on failed provider fallback', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.ai_provider_judgements >= 8, 'AI provider judgement artifacts should be present', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.native_bstg_execution_artifacts >= 8, 'native BSTG execution artifacts should be present', metrics.nativeMetrics);
    assert(metrics.assetCounts.api_templates > 0 && metrics.assetCounts.workflows > 0 && metrics.assetCounts.test_runs > 0, 'autopilot must create native BSTG executable assets', metrics.assetCounts);
    assert(metrics.assetCounts.findings >= 8, 'Doudizhu autopilot run should produce confirmed evidence-backed findings', metrics.assetCounts);
    assert(metrics.nativeMetrics.native_backed_findings === metrics.assetCounts.findings, 'every confirmed finding must be backed by native evidence', metrics.nativeMetrics);
    assert(/Completed\s*\//.test(pageText) && /100%/.test(pageText) && /0 failed/.test(pageText), 'UI should render completed state, full progress and zero failures', { pageText: pageText.slice(0, 1000) });

    const findingText = metrics.findings.map(finding => `${finding.title}\n${finding.response_body}\n${finding.ai_analysis}`).join('\n');
    const requiredEvidence = {
      file_upload: /uploaded|file_upload/i,
      path_traversal: /root:x:0:0|path_traversal|file_download/i,
      command_injection: /uid=1000|command_injection/i,
      bola_idor: /victim-bob|other user|bola/i,
      bfla: /admin@example\.com|admin function|bfla/i,
      business_logic: /negative quantity|total":-100|business_logic/i,
      xss: /<script>alert\(1337\)<\/script>|xss/i,
      passcode_or_auth: /passcode|otp|login_success|token-attacker|verified/i,
    };
    for (const [name, pattern] of Object.entries(requiredEvidence)) {
      assert(pattern.test(findingText), `missing confirmed finding evidence for ${name}`, { findings: metrics.findings.map(finding => finding.title) });
    }

    const report = {
      ok: true,
      mode: 'browser_ui_autopilot',
      targetSourceDir,
      routeCount: health.route_count,
      scanId,
      targetBase,
      serverBase,
      frontendBase,
      artifactDir,
      run: snapshot.run,
      summary,
      endpointsCount: snapshot.endpoints.length,
      endpointsSample: snapshot.endpoints.slice(0, 100).map(endpoint => ({ method: endpoint.method, path: endpoint.path, url: endpoint.url, source_type: endpoint.source_type, content_type: endpoint.content_type })),
      candidatesByType: summary.candidatesByType,
      coverage: metrics.coverage,
      assetCounts: metrics.assetCounts,
      nativeMetrics: metrics.nativeMetrics,
      findings: metrics.findings.map(finding => ({ title: finding.title, severity: finding.severity, status: finding.response_status, body_preview: String(finding.response_body || '').slice(0, 260) })),
      screenshots: ['01-before-start.png', '02-after-autopilot-run.png'].map(name => path.join(artifactDir, name)),
      logs: {
        target: logs.target.slice(-6000),
        server: logs.server.slice(-6000),
        aiProvider: logs.aiProvider.slice(-6000),
        frontend: logs.frontend.slice(-6000),
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log('report written', { reportPath, artifactDir });
    console.log(JSON.stringify({ ok: true, reportPath, artifactDir, scanId, routeCount: health.route_count, endpoints: snapshot.endpoints.length, assetCounts: metrics.assetCounts }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    frontend.kill('SIGTERM');
    server.kill('SIGTERM');
    target.kill('SIGTERM');
    aiProvider.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error('[doudizhu-autopilot-ui-e2e] FAILED:', error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
