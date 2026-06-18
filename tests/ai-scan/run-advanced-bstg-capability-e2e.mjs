#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const dataDir = process.env.ADVANCED_BSTG_CAPABILITY_DATA_DIR || path.join('/tmp', `bstg-advanced-capability-${Date.now()}`);
const baseReport = process.env.ADVANCED_BSTG_BASE_REPORT || path.join(repoRoot, 'tests/ai-scan/reports/latest-ai-scan-e2e-report.json');
const matrixJson = process.env.ADVANCED_BSTG_MATRIX_JSON || path.join(repoRoot, 'tests/ai-scan/reports/latest-advanced-bstg-capability-matrix.json');
const matrixMd = process.env.ADVANCED_BSTG_MATRIX_MD || path.join(repoRoot, 'tests/ai-scan/reports/ADVANCED_BSTG_CAPABILITY_E2E_MATRIX.md');

function run(cmd, args, env = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${result.status}`);
}

function assert(condition, message, details = {}) {
  if (!condition) {
    const err = new Error(message);
    err.details = details;
    throw err;
  }
}

function buildMatrix(dbPath) {
  const require = createRequire(path.join(repoRoot, 'server/package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  const count = (sql, ...params) => db.prepare(sql).get(...params).c;
  const wf = (pattern) => count('SELECT COUNT(*) AS c FROM workflows WHERE mutation_profile LIKE ?', `%${pattern}%`);
  const art = (type) => count('SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type=?', type);
  const inv = (tool) => count("SELECT COUNT(*) AS c FROM ai_tool_invocations WHERE tool_name=? AND status='completed'", tool);
  const totalFindings = count('SELECT COUNT(*) AS c FROM findings');
  const nativeBackedFindings = count("SELECT COUNT(*) AS c FROM findings WHERE source_type='ai_scan' AND request_evidence LIKE '%native_bstg%' AND response_evidence LIKE '%native_evidence_gate%'");
  const fallbackDecisions = count("SELECT COUNT(*) AS c FROM ai_scan_artifacts WHERE artifact_type='agent_decision' AND content_json LIKE '%\"source\":\"fallback\"%'");
  const tasksByVuln = {};
  for (const row of db.prepare('SELECT vuln_type FROM ai_scan_tasks WHERE vuln_type IS NOT NULL').all()) {
    tasksByVuln[row.vuln_type] = (tasksByVuln[row.vuln_type] || 0) + 1;
  }
  const capabilityMatrix = [
    ['AI Provider自主决策', 'Agent decision全部来自provider，无fallback', `agent_decision=${art('agent_decision')}; fallback=${fallbackDecisions}; tool_invocations=${count('SELECT COUNT(*) AS c FROM ai_tool_invocations')}`, art('agent_decision') >= 20 && fallbackDecisions === 0],
    ['API test run原生执行', 'AI可驾驶单接口api_template test_run', `native_api_test_run=${art('native_api_test_run')}; bstg.api_test.run=${inv('bstg.api_test.run')}; test_runs=${count('SELECT COUNT(*) AS c FROM test_runs')}`, art('native_api_test_run') > 0 && inv('bstg.api_test.run') > 0],
    ['Workflow baseline/mutation执行', 'AI可驾驶多接口workflow baseline和mutation', `native_workflow_verification=${art('native_workflow_verification')}; native_bstg_execution=${art('native_bstg_execution')}; workflows=${count('SELECT COUNT(*) AS c FROM workflows')}`, art('native_workflow_verification') > 0 && art('native_bstg_execution') > 0],
    ['Learning repair', 'baseline执行后自动调用学习修复', `bstg_learning_repair=${art('bstg_learning_repair')}; workflow_variables=${count('SELECT COUNT(*) AS c FROM workflow_variables')}; workflow_mappings=${count('SELECT COUNT(*) AS c FROM workflow_mappings')}`, art('bstg_learning_repair') > 0 && count('SELECT COUNT(*) AS c FROM workflow_variables') > 0 && count('SELECT COUNT(*) AS c FROM workflow_mappings') > 0],
    ['同包并发 concurrent_replay', '同一请求包并发打同一业务动作', `workflows_with_concurrent_replay=${wf('concurrent_replay')}; advanced_mutation_execution=${art('advanced_mutation_execution')}`, wf('concurrent_replay') >= 4 && art('advanced_mutation_execution') >= 8],
    ['跨包并发 parallel_groups', '退款+取消/支付+退款等不同包同步竞态', `workflows_with_parallel_groups=${wf('parallel_groups')}; barrier=${wf('barrier')}`, wf('parallel_groups') >= 2 && wf('barrier') >= 2],
    ['状态跳步 skip_steps', '跳过验证码/passcode/支付等前置状态直接执行敏感动作', `workflows_with_skip_steps=${wf('skip_steps')}`, wf('skip_steps') >= 2],
    ['重放 repeat_steps', '重复支付/退款/验证码验证/敏感动作重放', `workflows_with_repeat_steps=${wf('repeat_steps')}`, wf('repeat_steps') >= 4],
    ['Ticket/Token复用 reuse_tickets', '复用OTP ticket/CSRF/session/token检测票据复用漏洞', `workflows_with_reuse_tickets=${wf('reuse_tickets')}`, wf('reuse_tickets') >= 4],
    ['变量锁定 lock_variables', '锁定order_id/user_id/otp_ticket等跨步骤变量', `workflows_with_lock_variables=${wf('lock_variables')}`, wf('lock_variables') >= 4],
    ['静态条件 static_conditions', '把静态条件和状态变量写入mutation_profile供Agent/BSTG执行', `workflows_with_static_conditions=${wf('static_conditions')}`, wf('static_conditions') >= 4],
    ['Campaign子Agent并行', '漏洞专项拆成功能点子Agent并行执行再汇总', `campaign_plan=${art('vulnerability_campaign_plan')}; subagent_spawned=${art('subagent_spawned')}; summary=${art('vulnerability_campaign_summary')}; parallel_batches=${art('parallel_agent_batch_started')}`, art('vulnerability_campaign_plan') >= 10 && art('subagent_spawned') >= 10 && art('vulnerability_campaign_summary') >= 10],
    ['跨Agent共享资源', '账号池/登录蓝图/session策略/payload/object inventory复用', `shared_resources=${count('SELECT COUNT(*) AS c FROM ai_scan_shared_resources')}; identity_pool=${count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='identity_pool'")}; execution_reuse=${count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='execution_reuse_record'")}`, count('SELECT COUNT(*) AS c FROM ai_scan_shared_resources') >= 10 && count("SELECT COUNT(*) AS c FROM ai_scan_shared_resources WHERE resource_type='execution_reuse_record'") >= 4],
    ['Native evidence gate', 'confirmed finding必须有BSTG原生证据', `native_backed_findings=${nativeBackedFindings}; total_findings=${totalFindings}`, nativeBackedFindings === totalFindings && totalFindings > 0],
  ].map(([capability, requirement, evidence, pass]) => ({ capability, requirement, evidence, pass }));
  const sampleMutationRows = db.prepare("SELECT id, name, workflow_type, mutation_profile FROM workflows WHERE mutation_profile LIKE '%concurrent_replay%' OR mutation_profile LIKE '%parallel_groups%' OR mutation_profile LIKE '%skip_steps%' OR mutation_profile LIKE '%repeat_steps%' ORDER BY name LIMIT 12").all().map((row) => {
    let profile = {};
    try { profile = JSON.parse(row.mutation_profile || '{}'); } catch {}
    return {
      id: row.id,
      name: row.name,
      workflow_type: row.workflow_type,
      has_concurrent_replay: Boolean(profile.concurrent_replay),
      has_parallel_groups: Boolean(profile.parallel_groups?.length),
      has_skip_steps: Boolean(profile.skip_steps?.length),
      has_repeat_steps: Boolean(profile.repeat_steps && Object.keys(profile.repeat_steps).length),
      reuse_tickets: Boolean(profile.reuse_tickets),
      lock_variables: profile.lock_variables || [],
      static_conditions: profile.static_conditions || profile.conditions || null,
      state_machine: profile.state_machine ? {
        action_step: profile.state_machine.action_step,
        action_kind: profile.state_machine.action_kind,
        state_variables: profile.state_machine.state_variables,
      } : null,
    };
  });
  const report = {
    ok: capabilityMatrix.every((row) => row.pass),
    generated_at: new Date().toISOString(),
    db_path: dbPath,
    tasksByVuln,
    capabilityMatrix,
    sampleMutationRows,
  };
  db.close();
  return report;
}

fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(matrixJson), { recursive: true });

run(process.execPath, [path.join(repoRoot, 'tests/ai-scan/run-ai-scan-e2e.mjs')], {
  AI_SCAN_E2E_DATA_DIR: dataDir,
  AI_SCAN_E2E_REPORT: baseReport,
});

const report = buildMatrix(path.join(dataDir, 'app.db'));
fs.writeFileSync(matrixJson, JSON.stringify(report, null, 2));
let md = `# Advanced BSTG Capability E2E Matrix\n\nGenerated: ${report.generated_at}\n\nResult: **${report.ok ? 'PASS' : 'FAIL'}**\n\n| Capability | Requirement | Evidence | Result |\n|---|---|---|---|\n`;
for (const item of report.capabilityMatrix) {
  md += `| ${item.capability} | ${item.requirement} | ${String(item.evidence).replace(/\|/g, '/')} | ${item.pass ? 'PASS' : 'FAIL'} |\n`;
}
md += `\n## Tasks by vulnerability\n\n\`\`\`json\n${JSON.stringify(report.tasksByVuln, null, 2)}\n\`\`\`\n\n## Sample native mutation profiles\n\n\`\`\`json\n${JSON.stringify(report.sampleMutationRows, null, 2)}\n\`\`\`\n`;
fs.writeFileSync(matrixMd, md);

for (const row of report.capabilityMatrix) {
  assert(row.pass, `Capability check failed: ${row.capability}`, row);
}
console.log(JSON.stringify({ ok: report.ok, matrixJson, matrixMd, dataDir }, null, 2));
