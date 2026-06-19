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
const targetSourceDir = process.env.TARGET_SOURCE_DIR || path.join(os.homedir(), 'Downloads', '\u6597\u5730\u4e3b\u5c0f\u6e38\u620f\u6e90\u7801');
const targetPort = Number(process.env.AI_SCAN_DOUDIZHU_TARGET_PORT || 3360);
const serverPort = Number(process.env.AI_SCAN_DOUDIZHU_SERVER_PORT || 3361);
const aiProviderPort = Number(process.env.AI_SCAN_DOUDIZHU_AI_PROVIDER_PORT || (serverPort + 20));
const dataDir = process.env.AI_SCAN_DOUDIZHU_DATA_DIR || path.join('/tmp', `bstg-ai-scan-doudizhu-${Date.now()}`);
const reportPath = process.env.AI_SCAN_DOUDIZHU_REPORT || path.join(repoRoot, 'tests/ai-scan/reports/latest-doudizhu-blackbox-report.json');
const selectedVulnTypes = ['file_upload', 'file_download', 'path_traversal', 'bola_idor', 'bfla', 'business_logic', 'xss', 'command_injection', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'];

function log(message, data) {
  console.log(`[doudizhu-blackbox-e2e] ${data === undefined ? message : `${message} ${JSON.stringify(data)}`}`);
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
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.text();
      last = new Error(`HTTP ${response.status}`);
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${last?.message || last}`);
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

function summarize(snapshot) {
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
    toolsByName,
    artifactsByType,
  };
}

function dbMetrics() {
  const require = createRequire(path.join(repoRoot, 'server/package.json'));
  const Database = require('better-sqlite3');
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
    visual_browser_agent_states: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='browser_agent_state'"),
    shared_resources: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources"),
  };
  const findings = db.prepare('SELECT title,severity,response_status,response_body,request_evidence,response_evidence,ai_analysis FROM findings ORDER BY created_at').all();
  db.close();
  return { assetCounts, nativeMetrics, findings };
}

async function main() {
  assert(fs.existsSync(targetSourceDir), 'TARGET_SOURCE_DIR does not exist', { targetSourceDir });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  ensureServerBuild();

  const target = spawn(process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/doudizhu-blackbox-target.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(targetPort), TARGET_SOURCE_DIR: targetSourceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = spawn(process.execPath, [path.join(repoRoot, 'server/dist/index.js')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(serverPort), BSTG_DATA_DIR: dataDir, SERVE_FRONTEND: 'false', CLEANUP_INTERVAL_HOURS: '999999' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const aiProvider = spawn(process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/local-autonomous-ai-provider.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(aiProviderPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = { target: '', server: '', aiProvider: '' };
  target.stdout.on('data', chunk => { logs.target += chunk.toString(); });
  target.stderr.on('data', chunk => { logs.target += chunk.toString(); });
  server.stdout.on('data', chunk => { logs.server += chunk.toString(); });
  server.stderr.on('data', chunk => { logs.server += chunk.toString(); });
  aiProvider.stdout.on('data', chunk => { logs.aiProvider += chunk.toString(); });
  aiProvider.stderr.on('data', chunk => { logs.aiProvider += chunk.toString(); });

  try {
    const targetBase = `http://127.0.0.1:${targetPort}/`;
    const serverBase = `http://127.0.0.1:${serverPort}`;
    const health = JSON.parse(await waitFor(`${targetBase}health`, 30000));
    await waitFor(`${serverBase}/health`, 30000);
    await waitFor(`http://127.0.0.1:${aiProviderPort}/health`, 30000);
    await api('POST', `${serverBase}/api/ai/providers`, {
      name: 'Local Autonomous AI Driver',
      provider_type: 'openai_compat',
      base_url: `http://127.0.0.1:${aiProviderPort}/v1`,
      api_key: 'local-test-key',
      model: 'local-autonomous-ai-provider',
      is_enabled: true,
      is_default: true,
    });
    log('target, AI provider and BSTG ready', { route_count: health.route_count, targetBase, serverBase });

    const created = await api('POST', `${serverBase}/api/ai-scans`, {
      base_url: targetBase,
      user_prompt: 'Perform a full black-box AI security test against this local Doudizhu PHP game source target. Infer game, account, admin, upload, room, payment and state-machine functions, then run selected vulnerability classes through native BSTG evidence gates.',
      scan_config: {
        max_pages: 140,
        timeout_ms: 30000,
        max_tasks_per_vuln_type: 3,
        max_parallel_agents: 4,
        accounts: {
          attacker: { username: 'alice', password: 'AlicePass123', role: 'member', token: 'token-attacker' },
          victim: { username: 'bob', password: 'BobPass123', role: 'member', token: 'token-victim' },
          admin: { username: 'admin', password: 'AdminPass123', role: 'admin', token: 'token-admin' },
        },
        account_raw_requests: 'POST /index.php/index/sign HTTP/1.1\r\nHost: target\r\nCookie: member=session-attacker\r\nAuthorization: Bearer token-attacker\r\nContent-Type: application/json\r\n\r\n{"name":"alice","password":"AlicePass123","captcha":"123456","token":"token-attacker"}',
        enable_human_assisted_registration: true,
        enable_autonomous_account_discovery: true,
      },
    });
    const scanId = created.run.id;

    let runResult = await api('POST', `${serverBase}/api/ai-scans/${scanId}/run`, { max_steps: 12, max_parallel_agents: 4 });
    let snapshot = runResult.snapshot;
    let summary = summarize(snapshot);
    log('discovery finished', { status: snapshot.run.status, endpoints: snapshot.endpoints.length, candidates: summary.candidatesByType });

    assert(snapshot.run.status === 'awaiting_selection', 'scanner must reach vulnerability selection phase', { status: snapshot.run.status });
    assert(snapshot.endpoints.length >= 35, 'scanner should discover the source-derived Doudizhu attack surface', { endpoints: snapshot.endpoints.length, health });
    for (const type of selectedVulnTypes) {
      assert((summary.candidatesByType[type] || 0) > 0, `missing candidate type ${type}`, summary.candidatesByType);
    }

    snapshot = await api('POST', `${serverBase}/api/ai-scans/${scanId}/select-vulns`, { selected_vuln_types: selectedVulnTypes });
    summary = summarize(snapshot);
    log('vulnerabilities selected and tasks expanded', { totalTasks: snapshot.tasks.length, tasksByVuln: summary.tasksByVuln });
    for (const type of selectedVulnTypes) {
      assert((summary.tasksByVuln[type] || 0) > 0, `selected type ${type} did not generate tasks`, summary.tasksByVuln);
    }

    runResult = await api('POST', `${serverBase}/api/ai-scans/${scanId}/run`, { max_steps: 1200, max_parallel_agents: 4 });
    snapshot = runResult.snapshot;
    summary = summarize(snapshot);
    const metrics = dbMetrics();
    log('execution finished', { status: snapshot.run.status, tasksByStatus: summary.tasksByStatus, assets: metrics.assetCounts, nativeMetrics: metrics.nativeMetrics });

    assert(snapshot.run.status === 'completed', 'scan must complete after selected tasks execute', { status: snapshot.run.status, tasksByStatus: summary.tasksByStatus });
    assert(!summary.tasksByStatus.failed, 'no AI task should fail', summary.tasksByStatus);
    assert((summary.artifactsByType.subagent_spawned || 0) >= 8, 'sub-agent workers must execute independent Doudizhu vulnerability tasks', summary.artifactsByType);
    assert(metrics.nativeMetrics.fallback_decisions === 0, 'guarded orchestration should not rely on failed provider decision fallback', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.ai_provider_judgements >= 8, 'configured AI provider should participate in evidence judgement artifacts', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.native_bstg_execution_artifacts >= 8, 'native BSTG execution artifacts must be present', metrics.nativeMetrics);
    assert(metrics.assetCounts.api_templates > 0 && metrics.assetCounts.workflows > 0 && metrics.assetCounts.test_runs > 0, 'native BSTG assets must be created', metrics.assetCounts);
    assert(metrics.assetCounts.findings >= 8, 'Doudizhu scan should produce confirmed evidence-backed findings', metrics.assetCounts);
    assert(metrics.nativeMetrics.native_backed_findings === metrics.assetCounts.findings, 'every confirmed finding must be backed by native BSTG evidence', metrics.nativeMetrics);

    const findingText = metrics.findings.map(finding => `${finding.title}\n${finding.response_body}\n${finding.ai_analysis}`).join('\n');
    const requiredEvidence = {
      file_upload: /uploaded|file_upload/i,
      path_traversal: /root:x:0:0|path_traversal|file_download/i,
      command_injection: /uid=1000|command_injection/i,
      bola_idor: /victim-bob|other user|bola/i,
      bfla: /admin@example\.com|admin function|bfla/i,
      business_logic: /negative quantity|total":-100|business_logic/i,
      xss: /<script>alert\(1337\)<\/script>|xss/i,
      passcode: /passcode|token-attacker|verified/i,
    };
    for (const [name, pattern] of Object.entries(requiredEvidence)) {
      assert(pattern.test(findingText), `missing confirmed finding evidence for ${name}`, { findings: metrics.findings.map(f => f.title) });
    }

    const report = {
      ok: true,
      targetSourceDir,
      routeCount: health.route_count,
      scanId,
      targetBase,
      serverBase,
      run: snapshot.run,
      summary,
      endpointsCount: snapshot.endpoints.length,
      endpointsSample: snapshot.endpoints.slice(0, 100).map(endpoint => ({ method: endpoint.method, path: endpoint.path, url: endpoint.url, source_type: endpoint.source_type, content_type: endpoint.content_type })),
      candidatesByType: summary.candidatesByType,
      assetCounts: metrics.assetCounts,
      nativeMetrics: metrics.nativeMetrics,
      findings: metrics.findings.map(finding => ({ title: finding.title, severity: finding.severity, status: finding.response_status, body_preview: String(finding.response_body || '').slice(0, 260) })),
      logs,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log('report written', { reportPath });
    console.log(JSON.stringify({ ok: true, reportPath, scanId, routeCount: health.route_count, endpoints: snapshot.endpoints.length, assetCounts: metrics.assetCounts }, null, 2));
  } finally {
    server.kill('SIGTERM');
    target.kill('SIGTERM');
    aiProvider.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error('[doudizhu-blackbox-e2e] FAILED:', error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
