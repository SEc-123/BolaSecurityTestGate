#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const targetSourceDir = process.env.TARGET_SOURCE_DIR || '/mnt/data/work/target';
const targetPort = Number(process.env.AI_SCAN_LARAVEL_TARGET_PORT || 3350);
const serverPort = Number(process.env.AI_SCAN_LARAVEL_SERVER_PORT || 3351);
const aiProviderPort = Number(process.env.AI_SCAN_LARAVEL_AI_PROVIDER_PORT || (serverPort + 20));
const dataDir = process.env.AI_SCAN_LARAVEL_DATA_DIR || path.join('/tmp', `bstg-ai-scan-laravel-${Date.now()}`);
const reportPath = process.env.AI_SCAN_LARAVEL_REPORT || path.join(repoRoot, 'tests/ai-scan/reports/latest-laravel-exchange-blackbox-report.json');
const selectedVulnTypes = ['file_upload', 'file_download', 'path_traversal', 'bola_idor', 'bfla', 'business_logic', 'xss', 'command_injection', 'auth_otp', 'email_sms_bypass', 'passcode_bypass', 'replay_race', 'state_machine_race'];

function log(message, data) { console.log(`[laravel-blackbox-e2e] ${data === undefined ? message : `${message} ${JSON.stringify(data)}`}`); }
function assert(condition, message, details = {}) { if (!condition) { const e = new Error(message); e.details = details; throw e; } }
async function sleep(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(url, timeoutMs = 30000) { const start = Date.now(); let last; while (Date.now() - start < timeoutMs) { try { const r = await fetch(url); if (r.ok) return await r.text(); last = new Error(`HTTP ${r.status}`); } catch(e) { last = e; } await sleep(250); } throw new Error(`Timed out waiting for ${url}: ${last?.message || last}`); }
async function api(method, url, body) { const r = await fetch(url, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = { data: null, error: text }; } if (!r.ok || j.error) throw new Error(`${method} ${url} failed: ${r.status} ${j.error || text}`); return j.data; }
function ensureServerBuild() { const entry = path.join(repoRoot, 'server/dist/index.js'); const srcNewest = newestMtime(path.join(repoRoot, 'server/src')); if (fs.existsSync(entry) && fs.statSync(entry).mtimeMs > srcNewest) return; log('compiling server TypeScript'); const tsc = path.join(repoRoot, 'server/node_modules/typescript/lib/tsc.js'); const r = spawnSync(process.execPath, [tsc, '-p', path.join(repoRoot, 'server/tsconfig.json')], { stdio: 'inherit', cwd: repoRoot }); if (r.status !== 0) throw new Error('server TypeScript compilation failed'); }
function newestMtime(dir) { let max = 0; if (!fs.existsSync(dir)) return 0; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, entry.name); if (entry.isDirectory()) max = Math.max(max, newestMtime(p)); else max = Math.max(max, fs.statSync(p).mtimeMs); } return max; }
function summarize(snapshot) { const by = (items, key) => items.reduce((m, i) => (m[i[key] || 'none'] = (m[i[key] || 'none'] || 0) + 1, m), {}); const tools = {}; for (const i of snapshot.tool_invocations || []) tools[i.tool_name] = (tools[i.tool_name] || 0) + 1; const artifacts = {}; for (const a of snapshot.artifacts || []) artifacts[a.artifact_type] = (artifacts[a.artifact_type] || 0) + 1; return { tasksByStatus: by(snapshot.tasks || [], 'status'), tasksByVuln: by((snapshot.tasks || []).filter(t => t.vuln_type), 'vuln_type'), candidatesByType: by(snapshot.candidates || [], 'vuln_type'), toolsByName: tools, artifactsByType: artifacts }; }
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
      const text = [task.title, task.execution_plan?.function_name, target.method, target.path, target.url].filter(Boolean).join(' ');
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
  let count = 0;
  for (const row of rows) {
    let plan;
    try { plan = JSON.parse(row.content_json || '{}'); } catch { continue; }
    for (const node of plan.nodes || []) {
      if (pathPattern.test(String(node.path || '')) && (node.requires || []).includes(requirement)) count += 1;
    }
  }
  return count;
}
function dbMetrics() {
  const require = createRequire(path.join(repoRoot, 'server/package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dataDir, 'app.db'));
  const scalar = (sql) => db.prepare(sql).get().c;
  const assetCounts = {
    api_templates: scalar('SELECT COUNT(*) c FROM api_templates'),
    workflows: scalar('SELECT COUNT(*) c FROM workflows'),
    workflow_steps: scalar('SELECT COUNT(*) c FROM workflow_steps'),
    workflow_variable_configs: scalar('SELECT COUNT(*) c FROM workflow_variable_configs'),
    workflow_extractors: scalar('SELECT COUNT(*) c FROM workflow_extractors'),
    workflow_variables: scalar('SELECT COUNT(*) c FROM workflow_variables'),
    workflow_mappings: scalar('SELECT COUNT(*) c FROM workflow_mappings'),
    security_rules: scalar('SELECT COUNT(*) c FROM security_rules'),
    checklists: scalar('SELECT COUNT(*) c FROM checklists'),
    accounts: scalar('SELECT COUNT(*) c FROM accounts'),
    test_runs: scalar('SELECT COUNT(*) c FROM test_runs'),
    findings: scalar('SELECT COUNT(*) c FROM findings'),
  };
  const findings = db.prepare('SELECT title,severity,response_status,response_body,request_evidence,response_evidence,ai_analysis FROM findings ORDER BY created_at').all();
  const nativeArtifacts = scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_bstg_execution'");
  const nativeMetrics = {
    native_bstg_execution_artifacts: nativeArtifacts,
    native_api_test_run_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_api_test_run'"),
    native_workflow_verification_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_workflow_verification'"),
    native_unverified_baselines: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='native_workflow_verification' AND content_json LIKE '%\"baseline_verified\":false%'"),
    native_backed_findings: scalar("SELECT COUNT(*) c FROM findings WHERE source_type='ai_scan' AND request_evidence LIKE '%native_bstg%' AND response_evidence LIKE '%native_evidence_gate%'"),
    guarded_local_decisions: scalar("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='agent_decision' AND content_json LIKE '%\"source\":\"local_policy\"%'"),
    fallback_decisions: scalar("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='agent_decision' AND content_json LIKE '%\"source\":\"fallback\"%'"),
    ai_provider_judgements: scalar("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='ai_judgement' AND content_json LIKE '%\"source\":\"ai_provider\"%'"),
    shared_resources: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources"),
    shared_identity_pool_resources: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='identity_pool'"),
    shared_login_blueprints: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='workflow_blueprint'"),
    shared_payload_plans: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='payload_plan'"),
    shared_reuse_records: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='execution_reuse_record'"),
    used_shared_resources: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE usage_count > 0 AND resource_type != 'execution_reuse_record'"),
    identity_acquisition_plans: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='identity_acquisition_plan'"),
    raw_request_accounts: scalar("SELECT COUNT(*) c FROM ai_scan_shared_resources WHERE resource_type='identity_pool' AND content_json LIKE '%raw_request_accounts%'"),
    visual_browser_agent_states: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='browser_agent_state'"),
    human_input_requests: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='human_input_request'"),
    advanced_mutation_plans: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='advanced_mutation_plan'"),
    advanced_mutation_executions: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='advanced_mutation_execution'"),
    workflows_with_concurrent_replay: scalar("SELECT COUNT(*) c FROM workflows WHERE mutation_profile LIKE '%concurrent_replay%'"),
    workflows_with_parallel_groups: scalar("SELECT COUNT(*) c FROM workflows WHERE mutation_profile LIKE '%parallel_groups%'"),
    workflows_with_state_skip: scalar("SELECT COUNT(*) c FROM workflows WHERE mutation_profile LIKE '%skip_steps%'"),
    workflows_with_repeat_steps: scalar("SELECT COUNT(*) c FROM workflows WHERE mutation_profile LIKE '%repeat_steps%'"),
    workflow_dependency_plan_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='workflow_dependency_plan'"),
    workflow_dependency_execution_plan_artifacts: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type='workflow_dependency_execution_plan'"),
    post_auth_dependency_plans: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"access_phase\":\"post_auth\"%'"),
    plans_with_session_precondition: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"session\"%'"),
    plans_with_object_state_capability: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%object_state_setup%'"),
    plans_with_order_precondition: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"order_id\"%'"),
    plans_with_paid_order_precondition: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"paid_order_id\"%'"),
    plans_with_settled_state_precondition: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"settled_state\"%'"),
    plans_with_passcode_precondition: scalar("SELECT COUNT(*) c FROM ai_scan_artifacts WHERE artifact_type IN ('workflow_dependency_plan','workflow_dependency_execution_plan') AND content_json LIKE '%\"name\":\"passcode_verified\"%'"),
    plans_with_create_wallet_object_self_dependency: countWorkflowNodeRequirement(db, /createWalletAddress/i, 'object_id'),
    plans_with_wallet_image_object_self_dependency: countWorkflowNodeRequirement(db, /walletImage/i, 'object_id'),
    plans_with_wallet_payment_method_order_precondition: countWorkflowNodeRequirement(db, /walletPaymentMethod/i, 'order_id'),
    multi_step_native_workflows: scalar("SELECT COUNT(*) c FROM (SELECT workflow_id, COUNT(*) steps FROM workflow_steps GROUP BY workflow_id HAVING COUNT(*) > 1)"),
  };
  const nativeToolRuns = db.prepare("SELECT status, execution_type, COUNT(*) c FROM test_runs GROUP BY status, execution_type ORDER BY execution_type,status").all();
  db.close();
  return { assetCounts, findings, nativeArtifacts, nativeMetrics, nativeToolRuns };
}

async function main() {
  assert(fs.existsSync(targetSourceDir), 'TARGET_SOURCE_DIR does not exist', { targetSourceDir });
  fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }); fs.mkdirSync(path.dirname(reportPath), { recursive: true }); ensureServerBuild();
  const target = spawn(process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/laravel-exchange-blackbox-target.mjs')], { cwd: repoRoot, env: { ...process.env, PORT: String(targetPort), TARGET_SOURCE_DIR: targetSourceDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = spawn(process.execPath, [path.join(repoRoot, 'server/dist/index.js')], { cwd: repoRoot, env: { ...process.env, PORT: String(serverPort), BSTG_DATA_DIR: dataDir, SERVE_FRONTEND: 'false', CLEANUP_INTERVAL_HOURS: '999999' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const aiProvider = spawn(process.execPath, [path.join(repoRoot, 'tests/ai-scan/fixtures/local-autonomous-ai-provider.mjs')], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(aiProviderPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = { target: '', server: '', aiProvider: '' }; target.stdout.on('data', c => logs.target += c.toString()); target.stderr.on('data', c => logs.target += c.toString()); server.stdout.on('data', c => logs.server += c.toString()); server.stderr.on('data', c => logs.server += c.toString()); aiProvider.stdout.on('data', c => logs.aiProvider += c.toString()); aiProvider.stderr.on('data', c => logs.aiProvider += c.toString());
  try {
    const targetBase = `http://127.0.0.1:${targetPort}/`; const serverBase = `http://127.0.0.1:${serverPort}`;
    const health = JSON.parse(await waitFor(`${targetBase}health`, 30000)); await waitFor(`${serverBase}/health`, 30000); await waitFor(`http://127.0.0.1:${aiProviderPort}/health`, 30000); await api('POST', `${serverBase}/api/ai/providers`, { name: 'Local Autonomous AI Driver', provider_type: 'openai_compat', base_url: `http://127.0.0.1:${aiProviderPort}/v1`, api_key: 'local-test-key', model: 'local-autonomous-ai-provider', is_enabled: true, is_default: true }); log('target, AI provider and BSTG ready', { route_count: health.route_count, targetBase, serverBase, aiProviderPort });
    const created = await api('POST', `${serverBase}/api/ai-scans`, { base_url: targetBase, user_prompt: 'Perform a full black-box AI security test against this Laravel exchange target. Infer functions/sub-functions, generate vulnerability candidates, let selected vulnerabilities become persistent tasks, and run them through native BSTG template/workflow/test-run assets.', scan_config: { max_pages: 120, timeout_ms: 30000, max_tasks_per_vuln_type: 2, max_parallel_agents: 4, accounts: { attacker: { username: 'alice', password: 'AlicePass123', role: 'user' }, victim: { username: 'bob', password: 'BobPass123', role: 'user' }, admin: { username: 'admin', password: 'AdminPass123', role: 'admin' } }, account_raw_requests: `POST /api/user/getUserInfo HTTP/1.1\r\nHost: target\r\nAuthorization: Bearer token-attacker\r\nCookie: laravel_session=session-attacker\r\nContent-Type: application/json\r\n\r\n{"username":"alice","email":"alice@example.test","mobile":"13800000000","user_id":"attacker-alice","role":"user","token":"token-attacker"}`, enable_human_assisted_registration: true, enable_autonomous_account_discovery: true } });
    const scanId = created.run.id;
    let runResult = await api('POST', `${serverBase}/api/ai-scans/${scanId}/run`, { max_steps: 10 });
    let snapshot = runResult.snapshot;
    let summary = summarize(snapshot);
    log('discovery finished', { status: snapshot.run.status, endpoints: snapshot.endpoints.length, candidates: summary.candidatesByType });
    assert(snapshot.run.status === 'awaiting_selection', 'scanner must reach vulnerability selection phase', { status: snapshot.run.status });
    assert(snapshot.endpoints.length >= 80, 'scanner should discover a large route-derived attack surface', { endpoints: snapshot.endpoints.length });
    for (const type of selectedVulnTypes) assert((summary.candidatesByType[type] || 0) > 0, `missing candidate type ${type}`, summary.candidatesByType);
    snapshot = await api('POST', `${serverBase}/api/ai-scans/${scanId}/select-vulns`, { selected_vuln_types: selectedVulnTypes });
    summary = summarize(snapshot); log('vulnerabilities selected and tasks expanded', { totalTasks: snapshot.tasks.length, tasksByVuln: summary.tasksByVuln });
    const businessLogicTargets = businessLogicTaskTargets(snapshot);
    const businessLogicDomains = Array.from(new Set(businessLogicTargets.map(target => target.domain)));
    assert(businessLogicTargets.length >= 2, 'business_logic should expand into multiple real exchange business feature tasks', { businessLogicTargets });
    assert(businessLogicTargets.every(target => target.domain !== 'auth_only'), 'business_logic task slots must not be spent on pure login/register/code endpoints', { businessLogicTargets });
    assert(businessLogicTargets.every(target => target.domain !== 'other'), 'business_logic task slots must resolve to concrete exchange business domains', { businessLogicTargets });
    assert(businessLogicDomains.length >= 2, 'business_logic selection should cover multiple independent exchange business domains instead of one endpoint family', { businessLogicTargets, businessLogicDomains });
    const campaignTasks = snapshot.tasks.filter(task => task.task_type === 'vulnerability_campaign');
    const summaryTasks = snapshot.tasks.filter(task => task.task_type === 'summarize_vulnerability_campaign');
    assert(campaignTasks.length >= selectedVulnTypes.length - 1, 'selected vulnerability types should create persistent parent campaign tasks', { campaignTasks: campaignTasks.map(t => ({ title: t.title, vuln_type: t.vuln_type, status: t.status })) });
    assert(summaryTasks.length >= selectedVulnTypes.length - 1, 'selected vulnerability campaigns should create summary tasks', { summaryTasks: summaryTasks.map(t => ({ title: t.title, vuln_type: t.vuln_type, dependencies: t.dependencies })) });
    const bolaCampaign = campaignTasks.find(task => task.vuln_type === 'bola_idor');
    const bolaChildren = bolaCampaign ? snapshot.tasks.filter(task => task.parent_task_id === bolaCampaign.id && task.task_type.startsWith('test_')) : [];
    assert(Boolean(bolaCampaign) && bolaChildren.length >= 2, 'BOLA/IDOR should be decomposed under one parent campaign into multiple functional sub-agent jobs', { campaign: bolaCampaign, children: bolaChildren.map(t => ({ title: t.title, endpoint_ids: t.endpoint_ids })) });
    for (const type of selectedVulnTypes) assert((summary.tasksByVuln[type] || 0) > 0, `selected type ${type} did not generate tasks`, summary.tasksByVuln);
    runResult = await api('POST', `${serverBase}/api/ai-scans/${scanId}/run`, { max_steps: 1200, max_parallel_agents: 4 }); snapshot = runResult.snapshot; summary = summarize(snapshot); const metrics = dbMetrics();
    log('execution finished', { status: snapshot.run.status, tasksByStatus: summary.tasksByStatus, assets: metrics.assetCounts, nativeArtifacts: metrics.nativeArtifacts });
    assert(snapshot.run.status === 'completed', 'scan must complete after selected tasks execute', { status: snapshot.run.status, tasksByStatus: summary.tasksByStatus });
    assert(!summary.tasksByStatus.failed, 'no AI task should fail', summary.tasksByStatus);
    assert((summary.artifactsByType.agent_decision || 0) >= 20, 'autonomous Agent decision artifacts must be present', summary.artifactsByType); assert((summary.artifactsByType.parallel_agent_batch_started || 0) >= 1, 'parallel Agent batches must be started for independent vulnerability tasks', summary.artifactsByType); assert((summary.artifactsByType.parallel_agent_batch_completed || 0) >= 1, 'parallel Agent batches must complete', summary.artifactsByType); assert((summary.artifactsByType.subagent_spawned || 0) >= 4, 'sub-agent workers must execute independent vulnerability tasks', summary.artifactsByType); assert((summary.artifactsByType.vulnerability_campaign_plan || 0) >= selectedVulnTypes.length - 1, 'persistent vulnerability campaign plan artifacts must exist', summary.artifactsByType); assert((summary.artifactsByType.vulnerability_campaign_summary || 0) >= selectedVulnTypes.length - 1, 'campaign summary artifacts must exist after child sub-agents complete', summary.artifactsByType); assert(metrics.nativeMetrics.guarded_local_decisions >= 20, 'guarded workflow orchestration decisions should be deterministic local policy, not provider-overridable', metrics.nativeMetrics); assert(metrics.nativeMetrics.ai_provider_judgements >= 8, 'configured AI provider should participate in evidence judgement artifacts', metrics.nativeMetrics); assert(metrics.nativeMetrics.fallback_decisions === 0, 'guarded orchestration should not rely on failed provider decision fallback', metrics.nativeMetrics); assert((summary.artifactsByType.native_bstg_execution || 0) >= 8, 'native BSTG execution artifacts must be present', summary.artifactsByType);
    assert((summary.artifactsByType.native_api_test_run || 0) >= 8, 'native API test-run artifacts must be present', summary.artifactsByType);
    assert((summary.artifactsByType.bstg_capability_inventory || 0) >= 1, 'BSTG capability inventory artifact must be present', summary.artifactsByType);
    assert((summary.artifactsByType.agent_shared_context_inventory || 0) >= 1, 'shared cross-agent context inventory artifact must be present', summary.artifactsByType);
    assert((summary.toolsByName['agent.shared_context.prepare'] || 0) >= 1, 'shared context preparation tool must run', summary.toolsByName);
    assert(metrics.nativeMetrics.shared_resources >= 10, 'shared resources must be persisted for cross-agent reuse', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.shared_identity_pool_resources >= 1, 'shared identity pool resource must exist', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.shared_login_blueprints >= 1, 'shared login/session workflow blueprint must exist', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.shared_payload_plans >= 6, 'shared payload plans must exist', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.shared_reuse_records >= 4, 'sub-agent shared reuse records must exist', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.used_shared_resources >= 3, 'executable sub-agents must actually reuse shared resources', metrics.nativeMetrics);
    assert((summary.artifactsByType.bstg_learning_repair || 0) >= 8, 'BSTG learning repair artifacts must be present', summary.artifactsByType);
    assert(metrics.nativeMetrics.advanced_mutation_plans >= 8, 'expected advanced mutation plans for workflow/stateful tests', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.advanced_mutation_executions >= 8, 'expected advanced native mutation execution artifacts', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.workflows_with_concurrent_replay >= 4, 'expected native mutation_profile concurrent_replay for same-packet race/replay tests', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.workflows_with_parallel_groups >= 2, 'expected native mutation_profile parallel_groups for cross-packet race/state-machine tests', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.workflows_with_state_skip >= 2, 'expected native mutation_profile skip_steps for state transition bypass tests', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.workflows_with_repeat_steps >= 4, 'expected native mutation_profile repeat_steps for idempotency/replay tests', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.workflow_dependency_plan_artifacts >= 8, 'expected task-level workflow dependency plans for executable vulnerability tasks', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.workflow_dependency_execution_plan_artifacts >= 8, 'expected native execution to consume workflow dependency plans', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.post_auth_dependency_plans >= 4, 'expected post-login workflow dependency plans for authenticated features', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_session_precondition >= 4, 'expected session/login preconditions to be explicit in workflow plans', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_object_state_capability >= 2, 'expected object/order state setup to be explicit for business/BOLA workflows', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_order_precondition >= 2, 'expected order/payment/refund workflows to require an order before target execution', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_settled_state_precondition >= 1, 'expected exchange state-machine workflows to require settled/confirmed trade or balance state before terminal actions', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_passcode_precondition >= 1, 'expected withdrawal/transfer workflows to require passcode verification before target execution', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_create_wallet_object_self_dependency === 0, 'object creation endpoints must not require the object_id they are supposed to create', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_wallet_image_object_self_dependency === 0, 'wallet image/setup endpoints must not require the object_id they are supposed to establish', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.plans_with_wallet_payment_method_order_precondition === 0, 'wallet payment method workflows must not be misclassified as order-payment flows requiring order_id', metrics.nativeMetrics);
    assert(metrics.nativeMetrics.multi_step_native_workflows >= 4, 'expected native workflows to include prerequisite steps instead of only target endpoints', metrics.nativeMetrics);
    assert((summary.toolsByName['bstg.capabilities.inventory'] || 0) >= 1, 'capability inventory tool must run', summary.toolsByName);
    assert(metrics.assetCounts.test_runs >= 60, 'native BSTG test_runs must be created/executed', metrics.assetCounts);
    for (const asset of ['api_templates','workflows','workflow_steps','workflow_variable_configs','workflow_extractors','workflow_variables','workflow_mappings','security_rules','checklists','accounts']) assert(metrics.assetCounts[asset] > 0, `missing native BSTG asset ${asset}`, metrics.assetCounts);
    assert(metrics.assetCounts.findings >= 6 && metrics.assetCounts.findings < 200, 'AI/evidence gate should create confirmed findings without native auto-finding flood', metrics.assetCounts); assert(metrics.nativeMetrics.native_api_test_run_artifacts >= 8, 'native API-mode test-run artifacts must be present', metrics.nativeMetrics); assert(metrics.nativeMetrics.native_workflow_verification_artifacts >= 8, 'native baseline workflow verification artifacts must be present', metrics.nativeMetrics); assert(metrics.nativeMetrics.native_unverified_baselines === 0, 'all native baseline workflows reaching finding gate must be verified', metrics.nativeMetrics); assert(metrics.nativeMetrics.native_backed_findings === metrics.assetCounts.findings, 'every confirmed finding must be backed by native BSTG evidence', metrics.nativeMetrics); assert(metrics.findings.every(f => String(f.response_evidence || '').includes('native_api_mode_executed')), 'every confirmed finding evidence must include API-mode native test-run gate state', metrics.findings.map(f => f.title));
    const findingText = metrics.findings.map(f => `${f.title}\n${f.response_body}\n${f.ai_analysis}`).join('\n');
    const required = { file_upload: /upload|uploaded|svg|html/i, path_traversal: /root:x:0:0|passwd|path_traversal|file_download/i, command_injection: /uid=1000|command_injection/i, bola_idor: /victim-bob|other user|bola/i, bfla: /admin@example\.com|admin function|bfla/i, business_logic: /negative quantity|total":-100|business_logic/i, xss: /<script>alert\(1337\)<\/script>|xss/i };
    for (const [k, re] of Object.entries(required)) assert(re.test(findingText), `missing confirmed finding evidence for ${k}`, { findings: metrics.findings.map(f => f.title) });
    const report = { ok: true, targetSourceDir, routeCount: health.route_count, scanId, targetBase, serverBase, run: snapshot.run, summary, endpointsCount: snapshot.endpoints.length, endpointsSample: snapshot.endpoints.slice(0, 80).map(e => ({ method:e.method,path:e.path,url:e.url,source_type:e.source_type,content_type:e.content_type })), candidatesByType: summary.candidatesByType, assetCounts: metrics.assetCounts, nativeArtifacts: metrics.nativeArtifacts, nativeMetrics: metrics.nativeMetrics, nativeToolRuns: metrics.nativeToolRuns, findings: metrics.findings.map(f => ({ title:f.title,severity:f.severity,status:f.response_status,body_preview:String(f.response_body||'').slice(0,260) })), logs };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); log('report written', { reportPath }); console.log(JSON.stringify({ ok: true, reportPath, scanId, routeCount: health.route_count, endpoints: snapshot.endpoints.length, assetCounts: metrics.assetCounts }, null, 2));
  } finally { server.kill('SIGTERM'); target.kill('SIGTERM'); aiProvider.kill('SIGTERM'); }
}
main().catch(e => { console.error('[laravel-blackbox-e2e] FAILED:', e.message); if (e.details) console.error(JSON.stringify(e.details, null, 2)); process.exit(1); });
