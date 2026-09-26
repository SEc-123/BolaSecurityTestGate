#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const targetPort = Number(process.env.AI_SCAN_E2E_TARGET_PORT || 3320);
const serverPort = Number(process.env.AI_SCAN_E2E_SERVER_PORT || 3321);
const aiProviderPort = Number(process.env.AI_SCAN_E2E_AI_PROVIDER_PORT || (serverPort + 20));
const dataDir = process.env.AI_SCAN_E2E_DATA_DIR || path.join('/tmp', `bstg-ai-scan-e2e-${Date.now()}`);
const reportPath = process.env.AI_SCAN_E2E_REPORT || path.join(repoRoot, 'tests/ai-scan/reports/latest-ai-scan-e2e-report.json');
const selectedVulnTypes = ['file_upload', 'file_download', 'path_traversal', 'bola_idor', 'bfla', 'business_logic', 'xss', 'command_injection', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'];

function log(message, data) {
  const line = data === undefined ? message : `${message} ${JSON.stringify(data)}`;
  console.log(`[ai-scan-e2e] ${line}`);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || lastError}`);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { data: null, error: text }; }
  if (!res.ok || json.error) {
    throw new Error(`${method} ${url} failed: HTTP ${res.status} ${json.error || text}`);
  }
  return json.data;
}

function ensureServerBuild() {
  const entry = path.join(repoRoot, 'server/dist/index.js');
  if (fs.existsSync(entry)) return;
  log('server/dist missing; compiling server TypeScript');
  const tsc = path.join(repoRoot, 'server/node_modules/typescript/lib/tsc.js');
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(repoRoot, 'server/tsconfig.json')], { stdio: 'inherit', cwd: repoRoot });
  if (result.status !== 0) throw new Error('server TypeScript compilation failed');
}

function summarize(snapshot) {
  const tasksByStatus = {};
  const tasksByVuln = {};
  for (const task of snapshot.tasks || []) {
    tasksByStatus[task.status] = (tasksByStatus[task.status] || 0) + 1;
    if (task.vuln_type) tasksByVuln[task.vuln_type] = (tasksByVuln[task.vuln_type] || 0) + 1;
  }
  const candidatesByType = {};
  for (const candidate of snapshot.candidates || []) candidatesByType[candidate.vuln_type] = (candidatesByType[candidate.vuln_type] || 0) + 1;
  const artifactsByType = {};
  for (const artifact of snapshot.artifacts || []) artifactsByType[artifact.artifact_type] = (artifactsByType[artifact.artifact_type] || 0) + 1;
  const toolsByName = {};
  for (const invocation of snapshot.tool_invocations || []) toolsByName[invocation.tool_name] = (toolsByName[invocation.tool_name] || 0) + 1;
  return { tasksByStatus, tasksByVuln, candidatesByType, artifactsByType, toolsByName };
}

function businessLogicDomain(text) {
  const value = String(text || '').toLowerCase();
  if (/admin|manage|role|permission|后台|管理|权限/.test(value)) return 'admin_privileged';
  if (/withdraw|提现/.test(value)) return 'withdrawal';
  if (/transfer|funds|资金|转账/.test(value)) return 'transfer';
  if (/wallet|balance|address|钱包|余额|地址/.test(value)) return 'wallet';
  if (/refund|退款/.test(value)) return 'refund';
  if (/cancel|cancelorder|cancelentrust|bulkcancellation|撤单|取消/.test(value)) return 'cancellation';
  if (/payment|\bpay\b|支付/.test(value)) return 'payment';
  if (/cart|quantity|amount|price|购物车|数量|金额/.test(value)) return 'amount_quantity';
  if (/order|entrust|commission|exchange|contract|option|otc|订单|委托|交易/.test(value)) return 'order_exchange';
  if (/login|register|send.*code|verify.*code|sms|email|mail|otp|captcha|password|passcode|paypwd|验证码|短信|邮箱|登录|注册|密码/.test(value)) return 'auth_only';
  return 'other';
}

function businessLogicTaskTargets(snapshot) {
  return (snapshot.tasks || [])
    .filter(task => task.task_type === 'test_generic_vuln' && task.vuln_type === 'business_logic')
    .map(task => {
      const plan = task.execution_plan?.workflow_execution_plan || {};
      const target = (plan.nodes || []).at(-1) || {};
      const text = [
        task.title,
        task.execution_plan?.function_name,
        target.method,
        target.path,
        target.url,
      ].filter(Boolean).join(' ');
      return {
        title: task.title,
        function_name: task.execution_plan?.function_name,
        target_path: target.path,
        target_kind: plan.target_kind,
        access_phase: plan.access_phase,
        domain: businessLogicDomain(text),
      };
    });
}

function countWorkflowNodeRequirement(db, pathPattern, requirement) {
  const rows = db.prepare("SELECT content_json FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan')").all();
  let total = 0;
  for (const row of rows) {
    let plan;
    try { plan = JSON.parse(row.content_json || '{}'); } catch { continue; }
    for (const node of plan.nodes || []) {
      if (pathPattern.test(String(node.path || '')) && (node.requires || []).includes(requirement)) total += 1;
    }
  }
  return total;
}

function getDatabaseMetrics() {
  const require = createRequire(path.join(repoRoot, 'server/package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dataDir, 'app.db'));
  const findings = db.prepare('SELECT title, severity, response_status, response_body, request_evidence, response_evidence, ai_analysis FROM findings ORDER BY created_at').all();
  const count = (sql) => db.prepare(sql).get().c;
  const assetCounts = {
    api_templates: count('SELECT COUNT(*) AS c FROM api_templates'),
    workflows: count('SELECT COUNT(*) AS c FROM workflows'),
    workflow_steps: count('SELECT COUNT(*) AS c FROM workflow_steps'),
    workflow_variable_configs: count('SELECT COUNT(*) AS c FROM workflow_variable_configs'),
    workflow_extractors: count('SELECT COUNT(*) AS c FROM workflow_extractors'),
    workflow_variables: count('SELECT COUNT(*) AS c FROM workflow_variables'),
    workflow_mappings: count('SELECT COUNT(*) AS c FROM workflow_mappings'),
    security_rules: count('SELECT COUNT(*) AS c FROM security_rules'),
    checklists: count('SELECT COUNT(*) AS c FROM checklists'),
    accounts: count('SELECT COUNT(*) AS c FROM accounts'),
    test_runs: count('SELECT COUNT(*) AS c FROM test_runs'),
    findings: findings.length,
  };
  const nativeMetrics = {
    native_bstg_execution_artifacts: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='native_bstg_execution'"),
    native_api_test_run_artifacts: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='native_api_test_run'"),
    native_workflow_verification_artifacts: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='native_workflow_verification'"),
    native_unverified_baselines: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='native_workflow_verification' AND content_json LIKE '%\"baseline_verified\":false%'"),
    native_backed_findings: count("SELECT COUNT(*) AS c FROM findings WHERE source_type='ai_scan' AND request_evidence LIKE '%native_bstg%' AND response_evidence LIKE '%native_evidence_gate%'"),
    guarded_local_decisions: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='agent_decision' AND content_json LIKE '%\"source\":\"local_policy\"%'"),
    fallback_decisions: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='agent_decision' AND content_json LIKE '%\"source\":\"fallback\"%'"),
    ai_provider_judgements: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='ai_judgement' AND content_json LIKE '%\"source\":\"ai_provider\"%'"),
    shared_resources: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources"),
    shared_identity_pool_resources: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='identity_pool'"),
    shared_login_blueprints: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='workflow_blueprint'"),
    shared_payload_plans: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='payload_plan'"),
    shared_reuse_records: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='execution_reuse_record'"),
    used_shared_resources: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE usage_count > 0 AND resource_type != 'execution_reuse_record'"),
    identity_acquisition_plans: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='identity_acquisition_plan'"),
    raw_request_accounts: count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='identity_pool' AND content_json LIKE '%raw_request_accounts%'"),
    visual_browser_agent_states: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='browser_agent_state'"),
    human_input_requests: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='human_input_request'"),
    advanced_mutation_plans: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='advanced_mutation_plan'"),
    advanced_mutation_executions: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='advanced_mutation_execution'"),
    workflows_with_concurrent_replay: count("SELECT COUNT(*) AS c FROM workflows WHERE mutation_profile LIKE '%concurrent_replay%'"),
    workflows_with_parallel_groups: count("SELECT COUNT(*) AS c FROM workflows WHERE mutation_profile LIKE '%parallel_groups%'"),
    workflows_with_state_skip: count("SELECT COUNT(*) AS c FROM workflows WHERE mutation_profile LIKE '%skip_steps%'"),
    workflows_with_repeat_steps: count("SELECT COUNT(*) AS c FROM workflows WHERE mutation_profile LIKE '%repeat_steps%'"),
    workflow_dependency_plan_artifacts: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='workflow_dependency_plan'"),
    workflow_dependency_execution_plan_artifacts: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='workflow_dependency_execution_plan'"),
    post_auth_dependency_plans: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"access_phase\":\"post_auth\"%'"),
    plans_with_session_precondition: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"session\"%'"),
    plans_with_object_state_capability: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%object_state_setup%'"),
    plans_with_order_precondition: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"order_id\"%'"),
    plans_with_paid_order_precondition: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"paid_order_id\"%'"),
    plans_with_settled_state_precondition: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"settled_state\"%'"),
    plans_with_passcode_precondition: count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"passcode_verified\"%'"),
    plans_with_create_wallet_object_self_dependency: countWorkflowNodeRequirement(db, /createWalletAddress/i, 'object_id'),
    plans_with_wallet_image_object_self_dependency: countWorkflowNodeRequirement(db, /walletImage/i, 'object_id'),
    plans_with_wallet_payment_method_order_precondition: countWorkflowNodeRequirement(db, /walletPaymentMethod/i, 'order_id'),
    multi_step_native_workflows: count("SELECT COUNT(*) AS c FROM (SELECT workflow_id, COUNT(*) steps FROM workflow_steps GROUP BY workflow_id HAVING COUNT(*) > 1)"),
  };
  db.close();
  return { findings, assetCounts, nativeMetrics };
}

async function main() {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  ensureServerBuild();

  const target = spawn(process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/vulnerable-target.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(targetPort) },
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
    await waitFor(targetBase, 30000);
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
    log('target, AI provider and BSTG server ready', { targetBase, serverBase });

    const created = await api('POST', `${serverBase}/api/ai-scans`, {
      base_url: targetBase,
      user_prompt: 'Deeply understand this application, infer its features and test selected security vulnerabilities end-to-end.',
      scan_config: { max_pages: 1000, timeout_ms: 30000, max_tasks_per_vuln_type: 2, max_parallel_agents: 4, accounts: { attacker: { username: 'alice', password: 'AlicePass123', role: 'user' }, victim: { username: 'bob', password: 'BobPass123', role: 'user' }, admin: { username: 'admin', password: 'AdminPass123', role: 'admin' } }, account_raw_requests: `POST /api/user/getUserInfo HTTP/1.1\r\nHost: target\r\nAuthorization: Bearer token-attacker\r\nCookie: laravel_session=session-attacker\r\nContent-Type: application/json\r\n\r\n{"username":"alice","email":"alice@example.test","mobile":"13800000000","user_id":"attacker-alice","role":"user","token":"token-attacker"}`, enable_human_assisted_registration: true, enable_autonomous_account_discovery: true },
    });
    const scanId = created.run.id;
    log('created scan', { scanId });

    const discoveryRun = await api('POST', `${serverBase}/api/ai-scans/${scanId}/run`, {});
    let snapshot = discoveryRun.snapshot;
    const discoverySummary = summarize(snapshot);
    log('discovery completed', { status: snapshot.run.status, endpoints: snapshot.endpoints.length, candidatesByType: discoverySummary.candidatesByType });

    assert(snapshot.run.status === 'awaiting_selection', 'scan should wait for user vulnerability selection after discovery', { status: snapshot.run.status });
    assert(snapshot.endpoints.length >= 10, 'expected automated browser/http discovery to find at least 10 endpoints', { endpoints: snapshot.endpoints.length });
    for (const type of ['file_upload', 'file_download', 'path_traversal', 'bola_idor', 'bfla', 'business_logic', 'xss', 'command_injection', 'auth_otp', 'email_sms_bypass', 'passcode_bypass']) {
      assert(discoverySummary.candidatesByType[type] > 0, `expected candidate for ${type}`, discoverySummary.candidatesByType);
    }

    snapshot = await api('POST', `${serverBase}/api/ai-scans/${scanId}/select-vulns`, { selected_vuln_types: selectedVulnTypes });
    const afterSelection = summarize(snapshot);
    log('selection expanded tasks', { tasks: snapshot.tasks.length, tasksByVuln: afterSelection.tasksByVuln });
    const businessLogicTargets = businessLogicTaskTargets(snapshot);
    const businessLogicDomains = Array.from(new Set(businessLogicTargets.map(target => target.domain)));
    assert(businessLogicTargets.length >= 2, 'business_logic should expand into multiple real business feature tasks', { businessLogicTargets });
    assert(businessLogicTargets.every(target => target.domain !== 'auth_only'), 'business_logic task slots must not be spent on pure login/register/code endpoints', { businessLogicTargets });
    assert(businessLogicTargets.every(target => target.domain !== 'other'), 'business_logic task slots must resolve to concrete business domains', { businessLogicTargets });
    assert(businessLogicDomains.length >= 2, 'business_logic selection should cover multiple independent business domains instead of one endpoint family', { businessLogicTargets, businessLogicDomains });
    const campaignTasks = snapshot.tasks.filter(task => task.task_type === 'vulnerability_campaign');
    const summaryTasks = snapshot.tasks.filter(task => task.task_type === 'summarize_vulnerability_campaign');
    assert(campaignTasks.length >= selectedVulnTypes.length - 1, 'selected vulnerability types should create persistent parent campaign tasks', { campaignTasks: campaignTasks.map(t => ({ title: t.title, vuln_type: t.vuln_type, status: t.status })) });
    assert(summaryTasks.length >= selectedVulnTypes.length - 1, 'selected vulnerability campaigns should create summary/collection tasks', { summaryTasks: summaryTasks.map(t => ({ title: t.title, vuln_type: t.vuln_type, dependencies: t.dependencies })) });
    const bolaCampaign = campaignTasks.find(task => task.vuln_type === 'bola_idor');
    assert(Boolean(bolaCampaign), 'BOLA/IDOR should have a parent campaign task', { campaignTasks: campaignTasks.map(t => t.vuln_type) });
    const bolaChildren = bolaCampaign ? snapshot.tasks.filter(task => task.parent_task_id === bolaCampaign.id && task.task_type.startsWith('test_')) : [];
    assert(bolaChildren.length >= 2, 'BOLA/IDOR campaign should be decomposed into multiple feature/sub-feature sub-agent tasks, not one coarse task', { bolaChildren: bolaChildren.map(t => ({ title: t.title, endpoint_ids: t.endpoint_ids })) });
    assert(bolaChildren.every(task => task.execution_plan?.campaign_task_id === bolaCampaign?.id && task.execution_plan?.workflow_execution_plan && task.execution_plan?.precondition_policy?.enforce_before_target), 'BOLA children must retain campaign linkage and explicit workflow precondition plans', bolaChildren.map(t => t.execution_plan));
    for (const type of selectedVulnTypes) {
      assert(afterSelection.tasksByVuln[type] > 0, `selected vuln type ${type} should create executable tasks`, afterSelection.tasksByVuln);
    }

    const execution = await api('POST', `${serverBase}/api/ai-scans/${scanId}/run`, { max_steps: 500, max_parallel_agents: 4 });
    snapshot = execution.snapshot;
    const executionSummary = summarize(snapshot);
    const dbMetrics = getDatabaseMetrics();
    log('execution completed', { status: snapshot.run.status, tasksByStatus: executionSummary.tasksByStatus, findings: dbMetrics.assetCounts.findings });

    assert(snapshot.run.status === 'completed', 'scan run should complete after selected vulnerability tasks execute', { status: snapshot.run.status });
    assert(!executionSummary.tasksByStatus.failed, 'no AI scan task should fail', executionSummary.tasksByStatus);
    assert((executionSummary.tasksByStatus.completed || 0) === snapshot.tasks.length, 'all tasks should be completed', executionSummary.tasksByStatus);
    assert((executionSummary.artifactsByType.ai_judgement || 0) >= 8, 'expected judgement artifacts for executed vulnerability tasks', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.agent_decision || 0) >= 20, 'expected autonomous Agent decision artifacts', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.parallel_agent_batch_started || 0) >= 1, 'expected parallel Agent batch start artifacts', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.parallel_agent_batch_completed || 0) >= 1, 'expected parallel Agent batch completion artifacts', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.subagent_spawned || 0) >= 4, 'expected independent vulnerability tasks to be executed by sub-agent workers', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.vulnerability_campaign_plan || 0) >= selectedVulnTypes.length - 1, 'expected persistent vulnerability campaign plan artifacts', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.vulnerability_campaign_summary || 0) >= selectedVulnTypes.length - 1, 'expected campaign summary artifacts after child sub-agents finish', executionSummary.artifactsByType);
    assert(dbMetrics.nativeMetrics.guarded_local_decisions >= 20, 'guarded workflow orchestration decisions should be deterministic local policy, not provider-overridable', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.ai_provider_judgements >= 8, 'configured AI provider should participate in evidence judgement artifacts', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.fallback_decisions === 0, 'guarded orchestration should not rely on failed provider decision fallback', dbMetrics.nativeMetrics);
    assert((executionSummary.artifactsByType.bstg_capability_inventory || 0) >= 1, 'expected BSTG capability inventory artifact', executionSummary.artifactsByType);
    assert((executionSummary.artifactsByType.agent_shared_context_inventory || 0) >= 1, 'expected shared cross-agent context inventory artifact', executionSummary.artifactsByType);
    assert(executionSummary.toolsByName['agent.shared_context.prepare'] > 0, 'expected shared context preparation tool invocation', executionSummary.toolsByName);
    assert(dbMetrics.nativeMetrics.shared_resources >= 10, 'expected persisted shared resources for cross-agent reuse', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.shared_identity_pool_resources >= 1, 'expected reusable identity pool resource', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.shared_login_blueprints >= 1, 'expected reusable login/session workflow blueprint', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.shared_payload_plans >= 6, 'expected vulnerability payload plans to be shared across sub-agents', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.shared_reuse_records >= 4, 'expected sub-agent execution reuse records', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.used_shared_resources >= 3, 'expected shared resources to be used by executable sub-agents', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.identity_acquisition_plans >= 1, 'expected persisted identity acquisition plan for manual/raw/autonomous account modes', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.raw_request_accounts >= 1, 'expected raw request account material to be parsed into identity pool', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.visual_browser_agent_states >= 4, 'expected visual browser/sub-agent state artifacts for right-side multi-browser panel', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.human_input_requests >= 1, 'expected human input request artifact for OTP/SMS/passcode assisted registration mode', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.advanced_mutation_plans >= 8, 'expected advanced mutation plans for workflow/stateful tests', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.advanced_mutation_executions >= 8, 'expected advanced native mutation execution artifacts', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.workflows_with_concurrent_replay >= 4, 'expected native mutation_profile concurrent_replay for same-packet race/replay tests', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.workflows_with_parallel_groups >= 2, 'expected native mutation_profile parallel_groups for cross-packet race/state-machine tests', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.workflows_with_state_skip >= 2, 'expected native mutation_profile skip_steps for state transition bypass tests', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.workflows_with_repeat_steps >= 4, 'expected native mutation_profile repeat_steps for idempotency/replay tests', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.workflow_dependency_plan_artifacts >= 8, 'expected task-level workflow dependency plans for executable vulnerability tasks', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.workflow_dependency_execution_plan_artifacts >= 8, 'expected native execution to consume workflow dependency plans', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.post_auth_dependency_plans >= 4, 'expected post-login workflow dependency plans for authenticated features', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_session_precondition >= 4, 'expected session/login preconditions to be explicit in workflow plans', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_object_state_capability >= 2, 'expected object/order state setup to be explicit for business/BOLA workflows', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_order_precondition >= 2, 'expected order/payment/refund workflows to require an order before target execution', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_paid_order_precondition >= 1, 'expected refund/state-machine workflows to require a paid order before target execution', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_settled_state_precondition >= 1, 'expected stateful trade workflows to require settled/confirmed state before terminal actions', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_passcode_precondition >= 1, 'expected withdrawal/transfer workflows to require passcode verification before target execution', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_create_wallet_object_self_dependency === 0, 'object creation endpoints must not require the object_id they are supposed to create', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_wallet_image_object_self_dependency === 0, 'wallet image/setup endpoints must not require the object_id they are supposed to establish', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.plans_with_wallet_payment_method_order_precondition === 0, 'wallet payment method workflows must not be misclassified as order-payment flows requiring order_id', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.multi_step_native_workflows >= 4, 'expected native workflows to include prerequisite steps instead of only target endpoints', dbMetrics.nativeMetrics);
    assert((executionSummary.artifactsByType.bstg_learning_repair || 0) >= 8, 'expected BSTG learning repair artifacts for native workflow executions', executionSummary.artifactsByType);
    for (const tool of ['bstg.capabilities.inventory', 'browser.navigate', 'browser.discover_target', 'feature.extract_tree', 'vuln.generate_candidates', 'task.expand_selected_vulnerabilities', 'bstg.file_upload.run_test', 'bstg.generic_vuln.run_test']) {
      assert(executionSummary.toolsByName[tool] > 0, `expected tool invocation ${tool}`, executionSummary.toolsByName);
    }
    for (const [asset, count] of Object.entries(dbMetrics.assetCounts)) {
      assert(count > 0, `expected ${asset} to be created`, dbMetrics.assetCounts);
    }
    assert(dbMetrics.nativeMetrics.native_bstg_execution_artifacts >= 8, 'expected native BSTG execution artifacts for executed tasks', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.native_api_test_run_artifacts >= 8, 'expected native BSTG API test-run artifacts for single-interface execution mode', dbMetrics.nativeMetrics);
    assert((executionSummary.artifactsByType.native_api_test_run || 0) >= 8, 'expected native_api_test_run artifacts from API-mode test runs', executionSummary.artifactsByType);
    assert(dbMetrics.nativeMetrics.native_workflow_verification_artifacts >= 8, 'expected native baseline workflow verification artifacts', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.native_unverified_baselines === 0, 'all native baseline workflows that reached finding gate should be verified', dbMetrics.nativeMetrics);
    assert(dbMetrics.nativeMetrics.native_backed_findings === dbMetrics.assetCounts.findings, 'every confirmed finding must be backed by native BSTG evidence', dbMetrics.nativeMetrics);
    assert(dbMetrics.findings.every(f => String(f.response_evidence || '').includes('native_api_mode_executed')), 'every confirmed finding evidence must include API-mode native test-run gate state', dbMetrics.findings.map(f => f.title));
    const findingText = dbMetrics.findings.map(f => `${f.title}\n${f.response_body}`).join('\n');
    const requiredFindingPatterns = {
      file_upload: /文件上传点|file upload|svg-xss|uploads\/bstg-svg/i,
      path_traversal: /path_traversal|file_download|root:x:0:0/i,
      command_injection: /command_injection|uid=1000/i,
      xss: /xss|<script>alert\(1337\)<\/script>/i,
      bola_idor: /bola_idor|victim|other user|owner/i,
      bfla: /bfla|admin@example\.com|admin function/i,
      business_logic: /business_logic|negative quantity|total":-100/i,
      email_sms_bypass: /email_sms_bypass|otp|sms|verified|login_success|token/i,
      passcode_bypass: /passcode_bypass|passcode|passcode_verified|withdraw|accepted/i,
    };
    for (const [name, pattern] of Object.entries(requiredFindingPatterns)) {
      assert(pattern.test(findingText), `expected confirmed finding evidence for ${name}`, { findings: dbMetrics.findings.map(f => f.title) });
    }

    const report = {
      ok: true,
      scanId,
      targetBase,
      serverBase,
      run: snapshot.run,
      summary: executionSummary,
      endpoints: snapshot.endpoints.map(e => ({ method: e.method, path: e.path, url: e.url, source_type: e.source_type, content_type: e.content_type, request_summary: e.request_summary })).slice(0, 100),
      candidateTypes: executionSummary.candidatesByType,
      taskCount: snapshot.tasks.length,
      artifactCount: snapshot.artifacts.length,
      toolInvocationCount: snapshot.tool_invocations.length,
      assetCounts: dbMetrics.assetCounts,
      nativeMetrics: dbMetrics.nativeMetrics,
      findings: dbMetrics.findings.map(f => ({ title: f.title, severity: f.severity, status: f.response_status, body_preview: String(f.response_body || '').slice(0, 300) })),
      logs,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log('report written', { reportPath });
    console.log(JSON.stringify({ ok: true, reportPath, scanId, assetCounts: dbMetrics.assetCounts }, null, 2));
  } finally {
    server.kill('SIGTERM');
    target.kill('SIGTERM');
    aiProvider.kill('SIGTERM');
  }
}

main().catch(error => {
  console.error('[ai-scan-e2e] FAILED:', error.message);
  if (error.details) console.error(JSON.stringify(error.details, null, 2));
  process.exit(1);
});
