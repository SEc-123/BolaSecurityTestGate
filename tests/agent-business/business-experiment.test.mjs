// Native model-plan compilation/execution integration. It intentionally uses
// a local authorized HTTP fixture and direct plan objects; the separate
// browser capture suite proves the normal-flow recorder. This suite proves a
// model's selected field change survives compilation and that a rejected
// change cannot become a confirmed finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SqliteProvider } from '../../server/src/db/sqlite-provider.ts';
import { dbManager } from '../../server/src/db/db-manager.ts';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { executeWorkflowRun } from '../../server/src/services/workflow-runner.ts';
import { newBusinessFlow, saveBusinessFlow } from '../../server/src/services/ai-scan/agent-business-contract.ts';
import { assessBusinessExperiment, compileBusinessExperiment, executeBusinessExperiment, planBusinessExperiment } from '../../server/src/services/ai-scan/agent-business-experiment.ts';

async function target(mode) {
  let serial = 0;
  let latest = null;
  let appliedCount = 0;
  const tickets = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const json = body ? JSON.parse(body) : {};
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/seed') {
      const ticket = `ticket-${++serial}-${randomUUID()}`;
      tickets.add(ticket);
      return send(200, { ticket, issued: serial });
    }
    if (url.pathname === '/apply') {
      const validTicket = mode === 'concurrent' ? tickets.has(json.ticket) : tickets.delete(json.ticket);
      if (!validTicket) return send(409, { accepted: false, reason: 'stale_ticket' });
      if (mode === 'secure' && Number(json.amount) <= 0) return send(422, { accepted: false, reason: 'amount_rejected' });
      latest = { amount: Number(json.amount), order: `order-${serial}` };
      appliedCount += 1;
      return send(200, { accepted: true, ...latest, applied_count: appliedCount });
    }
    if (url.pathname === '/state') return send(200, { orders: latest ? [latest] : [], applied_count: appliedCount });
    send(404, { error: 'unknown route' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, latest: () => latest,
    appliedCount: () => appliedCount,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

function raw(method, path, body) {
  return [`${method} ${path} HTTP/1.1`, 'Content-Type: application/json', '', body || ''].join('\r\n');
}

async function setup(t, mode) {
  const service = await target(mode);
  const db = new SqliteProvider(`model-experiment-${mode}`, { file: ':memory:' });
  await db.connect(); await db.migrate();
  const previous = dbManager.getActive; dbManager.getActive = () => db;
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({ base_url: service.baseUrl, name: 'Model plan native fixture' });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Native model experiment', task_type: 'autonomous_agent_task' });
  const workflow = await db.repos.workflows.create({ name: 'Observed purchase normal flow', is_active: true, assertion_strategy: 'all_steps_pass',
    account_binding_strategy: 'anchor_attacker', enable_baseline: false, baseline_config: { capture_replay_only: true }, enable_extractor: false,
    enable_session_jar: false, session_jar_config: { cookie_mode: true }, workflow_type: 'baseline', learning_status: 'learned',
    learning_version: 1, template_mode: 'snapshot' });
  const templates = [];
  for (const [name, request] of [
    ['issue fresh ticket', raw('GET', '/seed')],
    ['apply normal purchase', raw('POST', '/apply', JSON.stringify({ ticket: 'captured-ticket', amount: 1 }))],
    ['read authoritative state', raw('GET', '/state')],
  ]) {
    templates.push(await db.repos.apiTemplates.create({ name, raw_request: request, parsed_structure: {}, variables: [], failure_patterns: [], failure_logic: 'OR', is_active: true }));
  }
  const steps = [];
  for (const [index, template] of templates.entries()) {
    steps.push(await db.repos.workflowSteps.create({ workflow_id: workflow.id, api_template_id: template.id, step_order: index + 1,
      request_snapshot_raw: template.raw_request, snapshot_template_id: template.id, snapshot_template_name: template.name, snapshot_created_at: new Date().toISOString(),
      step_assertions: [], assertions_mode: 'all', failure_patterns_override: [] }));
  }
  await db.runRawQuery(`INSERT INTO workflow_variables (id, workflow_id, name, type, source, write_policy, is_locked, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), workflow.id, 'fresh_ticket', 'FLOW_TICKET', 'extracted', 'overwrite', 0, 'Observed normal ticket dependency']);
  await db.runRawQuery(`INSERT INTO workflow_mappings (id, workflow_id, from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name, confidence, reason, is_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [randomUUID(), workflow.id, 1, 'response.body', 'ticket', 2, 'request.body', 'ticket', 'fresh_ticket', 1, 'manual', 1]);
  const environment = await db.repos.environments.create({ name: 'Native experiment fixture', base_url: service.baseUrl, is_active: true });
  const normalRun = await db.repos.testRuns.create({ name: 'Actual normal baseline', status: 'pending', execution_type: 'workflow', trigger_type: 'fixture', workflow_id: workflow.id,
    account_ids: [], environment_id: environment.id, rule_ids: [], progress_percent: 0 });
  const normal = await executeWorkflowRun({ test_run_id: normalRun.id, workflow_id: workflow.id, environment_id: environment.id, evidence_only: true });
  assert.equal(normal.success, true, normal.error);
  assert.equal(service.latest()?.amount, 1, 'A real normal native run must establish the baseline state first');
  const flow = newBusinessFlow({ name: 'Purchase a permitted quantity', goal: 'A normal order has amount one in authoritative state', role: 'anonymous' }, task.id);
  Object.assign(flow, { status: 'verified', workflow_id: workflow.id, normal_run_id: normalRun.id, assertions_verified: true, evidence_artifact_ids: ['normal-fixture-proof'] });
  await saveBusinessFlow(repo, run.id, task.id, flow);
  t.after(async () => { dbManager.getActive = previous; await db.disconnect(); await service.close(); });
  return { service, db, repo, run, task, workflow, steps, flow, context: { db, repo, scanRunId: run.id, taskId: task.id } };
}

function planInput(fixture, amount = 0) {
  return {
    flow_id: fixture.flow.id, name: 'Change observed purchase amount', category: 'model_chosen_business_experiment',
    hypothesis: 'Changing the observed amount field to zero may create an impermissible order.',
    rationale: 'The normal workflow records a server-issued ticket and an authoritative state read; test the selected field while retaining the dynamic ticket binding.',
    steps: fixture.steps.map(step => ({ id: step.id, source_step_order: step.step_order, role: 'normal' })),
    patches: [{ step_id: fixture.steps[1].id, location: 'json_body', operation: 'set', path: 'amount', value: amount }],
    bindings: [{ from_step_id: fixture.steps[0].id, from_location: 'response.body', from_path: 'ticket', to_step_id: fixture.steps[1].id,
      to_location: 'json_body', to_path: 'ticket', variable_name: 'fresh_ticket' }],
    assertions: [{ id: 'impact', step_order: 3, description: 'Authoritative state exposes the changed amount', purpose: 'impact',
      left: { type: 'response', path: 'body.orders.0.amount' }, op: 'equals', right: { type: 'literal', value: String(amount) } }],
    control_assertions: [{ id: 'control', step_order: 3, description: 'Fresh control keeps normal amount', purpose: 'control',
      left: { type: 'response', path: 'body.orders.0.amount' }, op: 'equals', right: { type: 'literal', value: '1' } }],
  };
}

test('model-selected request patch is compiled, dynamically rebound, executed and evidence-gated', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const planned = await planBusinessExperiment(f.context, planInput(f));
  assert.equal(planned.request_patch_count, 1);
  const compiled = await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(compiled.status, 'compiled');
  assert.equal(compiled.native_assets.request_patch_count, 1);
  const artifacts = await f.repo.listArtifacts(f.run.id);
  const compilation = artifacts.find(item => item.artifact_type === 'agent_experiment_compilation');
  const mutation = await f.db.repos.workflows.findById(compilation.content_json.experiment_workflow_id);
  const base = await f.db.repos.workflows.findById(mutation.base_workflow_id);
  const patched = (await f.db.repos.workflowSteps.findAll({ where: { workflow_id: base.id } })).find(step => step.step_order === 2);
  assert.match(patched.request_snapshot_raw, /"amount":0/, 'The immutable native snapshot contains the exact model-selected mutation');
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed');
  assert.equal(executed.execution_verified, true, JSON.stringify(executed));
  assert.equal(executed.control_verified, true, JSON.stringify(executed));
  assert.equal(executed.evidence_ready, true, JSON.stringify(executed));
  assert.equal(f.service.latest()?.amount, 0, 'The actual HTTP target received and stored the model-selected value');
  const assessment = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, result_revision: executed.result_revision, verdict: 'vulnerable',
    title: 'Model-selected amount invariant break', severity: 'high', reason: 'The exact changed request produced the asserted authoritative state after a successful normal control.',
    business_impact: 'The target accepted an order amount outside the normal invariant.' });
  assert.equal(assessment.confirmed, true, JSON.stringify(assessment));
  const judgement = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'ai_judgement');
  assert.equal(judgement.content_json.verdict, 'vulnerable');
  assert.equal(judgement.content_json.native_evidence_gate.verdict, 'confirmed');
  assert.equal((await f.db.repos.findings.findAll()).length, 0, 'Evidence-only model experiments do not create a speculative native finding');
});

test('a server rejection remains a completed counterexample and cannot be promoted by the model', { timeout: 60000 }, async t => {
  const f = await setup(t, 'secure');
  const planned = await planBusinessExperiment(f.context, planInput(f));
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed', JSON.stringify(executed));
  assert.equal(executed.control_verified, true, JSON.stringify(executed));
  assert.equal(executed.execution_verified, false, JSON.stringify(executed));
  assert.equal(executed.evidence_ready, false, JSON.stringify(executed));
  const assessment = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, verdict: 'vulnerable', title: 'Unproven amount issue', severity: 'high',
    reason: 'The model hypothesis was tested but the target rejection did not meet the impact assertion.', business_impact: 'No confirmed impact because the target rejected the changed value.' });
  assert.equal(assessment.confirmed, false);
  assert.equal(assessment.verdict, 'inconclusive');
  const judgement = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'ai_judgement');
  assert.equal(judgement.content_json.verdict, 'inconclusive');
  assert.equal(judgement.content_json.native_evidence_gate.verdict, 'insufficient');
  const counterexample = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, verdict: 'not_vulnerable', title: 'Observed amount rejection', severity: 'info',
    reason: 'The normal control completed, while the same bounded mutation completed and was rejected by the target.',
    business_impact: 'The observed mutation did not create the asserted impermissible order.' });
  assert.equal(counterexample.verdict, 'not_vulnerable', JSON.stringify(counterexample));
  assert.equal(counterexample.counterexample_verified, true, JSON.stringify(counterexample));
  const counterexampleJudgement = (await f.repo.listArtifacts(f.run.id)).filter(item => item.artifact_type === 'ai_judgement').at(-1);
  assert.equal(counterexampleJudgement.content_json.native_evidence_gate.verdict, 'counterexample');
});

test('a model cannot label a successful mutation not_vulnerable without a native counterexample', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const planned = await planBusinessExperiment(f.context, planInput(f));
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.evidence_ready, true, JSON.stringify(executed));
  const assessment = await assessBusinessExperiment(f.context, { plan_id: planned.plan_id, verdict: 'not_vulnerable', title: 'Unsupported secure conclusion', severity: 'info',
    reason: 'The model asks for a secure conclusion even though the exact impact assertion completed.',
    business_impact: 'The target accepted the changed state, so this is not a counterexample.' });
  assert.equal(assessment.verdict, 'inconclusive', JSON.stringify(assessment));
  assert.equal(assessment.counterexample_verified, false, JSON.stringify(assessment));
});

test('the declared control role selects that exact prepared identity for the native control run', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const victim = await f.db.repos.accounts.create({ name: 'Prepared victim control', username: 'victim-control', status: 'active',
    tags: ['ai_scan', `scan:${f.run.id}`, 'role:victim'], fields: { auth_token: 'fixture-victim-token' }, variables: {}, auth_profile: {} });
  const input = planInput(f);
  input.control_role = 'victim';
  const planned = await planBusinessExperiment(f.context, input);
  const compiled = await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(compiled.native_assets.control_role, 'victim');
  const compilation = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'agent_experiment_compilation').content_json;
  assert.equal(compilation.control_role, 'victim');
  assert.equal(compilation.control_account_id, victim.id);
  const controlWorkflow = await f.db.repos.workflows.findById(compilation.control_workflow_id);
  assert.equal(controlWorkflow.attacker_account_id, victim.id, 'Control workflow must not silently use the normal account');
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const controlRun = await f.db.repos.testRuns.findById(executed.native_test_run_ids[0]);
  assert.deepEqual(controlRun.account_ids, [victim.id]);
  assert.equal(controlRun.execution_params.control_role, 'victim');
});

test('an unobserved patch field is rejected during native compilation instead of falling back to a preset experiment', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const input = planInput(f);
  input.patches = [{ step_id: f.steps[1].id, location: 'json_body', operation: 'set', path: 'not_observed', value: '1' }];
  const planned = await planBusinessExperiment(f.context, input);
  await assert.rejects(compileBusinessExperiment(f.context, { plan_id: planned.plan_id }), /not observed/);
  assert.equal((await f.db.repos.testRuns.findAll()).length, 1, 'No experiment run is created after a rejected compiler operation');
});

test('model-selected skipped and repeated steps execute as the compiled sequence instead of failing baseline-sized completeness checks', { timeout: 60000 }, async t => {
  const f = await setup(t, 'vulnerable');
  const input = planInput(f);
  input.steps = f.steps.slice(0, 2).map(step => ({ id: step.id, source_step_order: step.step_order, role: 'normal' }));
  input.repeats = [{ step_id: f.steps[0].id, count: 1 }];
  input.assertions = [{ id: 'impact-at-action', step_order: 2, description: 'The action response contains the changed amount', purpose: 'impact',
    left: { type: 'response', path: 'body.amount' }, op: 'equals', right: { type: 'literal', value: '0' } }];
  input.control_assertions = [{ id: 'control-at-action', step_order: 2, description: 'The control response contains the normal amount', purpose: 'control',
    left: { type: 'response', path: 'body.amount' }, op: 'equals', right: { type: 'literal', value: '1' } }];
  const planned = await planBusinessExperiment(f.context, input);
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const compilation = (await f.repo.listArtifacts(f.run.id)).find(item => item.artifact_type === 'agent_experiment_compilation').content_json;
  assert.deepEqual(compilation.mutation_profile.skip_steps, [3]);
  assert.equal(compilation.mutation_profile.repeat_steps[1], 1);
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed', JSON.stringify(executed));
  assert.equal(executed.execution_verified, true, JSON.stringify(executed));
  assert.equal(executed.control_verified, true, JSON.stringify(executed));
  assert.equal(f.service.latest()?.amount, 0);
  assert.equal(f.service.appliedCount(), 3, 'The normal baseline, control, and compiled repeated-seed experiment each executed one real action');
});

test('model-selected concurrency preserves source-step attribution and proves simultaneous native requests through the authoritative state', { timeout: 60000 }, async t => {
  const f = await setup(t, 'concurrent');
  const input = planInput(f, 1);
  input.patches = [];
  input.concurrency = { step_id: f.steps[1].id, count: 2 };
  input.hypothesis = 'The observed purchase action may be applied twice when the same fresh ticket is released concurrently.';
  input.rationale = 'Keep the recorded fresh-ticket binding and use the native concurrent replay profile for the observed state-changing action.';
  input.assertions = [{ id: 'concurrent-impact', step_order: 3, description: 'Authoritative state shows both concurrent applications in addition to normal control runs', purpose: 'impact',
    left: { type: 'response', path: 'body.applied_count' }, op: 'equals', right: { type: 'literal', value: '4' } }];
  input.control_assertions = [{ id: 'concurrent-control', step_order: 3, description: 'Control applies exactly one fresh normal action after the baseline', purpose: 'control',
    left: { type: 'response', path: 'body.applied_count' }, op: 'equals', right: { type: 'literal', value: '2' } }];
  const planned = await planBusinessExperiment(f.context, input);
  await compileBusinessExperiment(f.context, { plan_id: planned.plan_id });
  const executed = await executeBusinessExperiment(f.context, { plan_id: planned.plan_id });
  assert.equal(executed.status, 'executed', JSON.stringify(executed));
  assert.equal(executed.concurrency_success_count, 2, JSON.stringify(executed));
  assert.equal(executed.execution_verified, true, JSON.stringify(executed));
  assert.equal(executed.evidence_ready, true, JSON.stringify(executed));
  assert.equal(f.service.appliedCount(), 4, 'The fixture recorded two actual concurrent state-changing requests');
  const traces = (await f.repo.listArtifacts(f.run.id)).filter(item => item.artifact_type === 'agent_experiment_native_trace' && item.content_json.kind === 'experiment');
  const concurrent = traces.flatMap(trace => trace.content_json.trace.records).filter(record => record.meta?.label === 'concurrent');
  assert.equal(concurrent.length, 2);
  assert.ok(concurrent.every(record => record.meta?.step_order === 2 && record.meta?.template_id === f.steps[1].api_template_id));
});
