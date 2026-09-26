import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { AIScanAgentRuntime } from '../../server/src/agent/agent-runtime.ts';
import { AgentToolRegistry } from '../../server/src/agent/tool-registry.ts';
import { buildAIScanToolSpecs } from '../../server/src/agent/tools/ai-scan-tools.ts';
import { buildWorkflowExecutionPlan } from '../../server/src/services/ai-scan/workflow-context.ts';
import { runNativeApiTestRun } from '../../server/src/services/ai-scan/bstg-native-orchestrator.ts';
import { capturedSpec, CapturedRequestFieldError } from '../../server/src/services/ai-scan/captured-request.ts';
import { buildProductAssessmentState } from '../../server/src/services/ai-scan/product-state-service.ts';
import { judge } from './fixtures.mjs';

// Real API tool, runtime and native in-memory SQLite. Only the planner is a test
// double; transport is forbidden, with no browser, model or saved target used.
async function fixture(t, { required = true, captured = false, vulnType = 'path_traversal', paramName } = {}) {
  const db = await database();
  t.after(() => db.disconnect());
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected transport in capture fixture'); });
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({ base_url: 'http://127.0.0.1:9', selected_vuln_types: [vulnType],
    scan_config: { surface: 'web', driving_mode: 'autopilot', request_evidence_required: required } });
  const endpoint = await repo.upsertEndpoint({ scan_run_id: run.id, method: captured?.method || 'GET', path: '/download',
    url: `${run.base_url}/download?file=public.txt`, source_type: 'browser_js_reference' });
  if (captured) await repo.saveCapturedRequest(endpoint, { method: endpoint.method, url: endpoint.url, headers: {}, body: null,
    ...(typeof captured === 'object' ? captured : {}), source: 'browser', captured_at: new Date().toISOString() });
  const plan = buildWorkflowExecutionPlan({ allEndpoints: [endpoint], selectedEndpointIds: [endpoint.id],
    targetEndpointId: endpoint.id, vulnType });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Capture status fixture', task_type: 'test_generic_vuln',
    vuln_type: vulnType, endpoint_ids: [endpoint.id], execution_plan: { workflow_execution_plan: plan } });
  const registry = new AgentToolRegistry();
  for (const tool of buildAIScanToolSpecs()) registry.register(tool);
  const runtime = new AIScanAgentRuntime(db);
  let decisions = 0;
  t.mock.method(runtime.planner, 'decide', async () => ++decisions === 1
    ? { action: 'tool_call', tool_name: 'bstg.api_test.run', arguments: { endpoint_id: endpoint.id, ...(paramName ? { param_name: paramName } : {}) }, source: 'local_policy' }
    : { action: 'complete_task', summary: 'Must never run after the capture guard.', source: 'local_policy' });
  return { db, repo, run, task, endpoint, registry, runtime, fetch, decisions: () => decisions,
    capturedBefore: await repo.getCapturedRequest(run.id, endpoint.id), artifactsBefore: await repo.listArtifacts(run.id),
    context: { db, repo, scanRunId: run.id, taskId: task.id } };
}

async function assertNoExecution(f) {
  assert.equal(f.fetch.mock.callCount(), 0);
  for (const table of ['api_templates', 'workflows', 'test_runs', 'findings', 'security_rules', 'checklists', 'accounts']) {
    assert.equal((await f.db.runRawQuery(`SELECT count(*) AS n FROM ${table}`))[0].n, 0, `${table} must remain empty`);
  }
  assert.deepEqual((await f.repo.getTask(f.task.id)).created_assets_json, {});
  const artifacts = await f.repo.listArtifacts(f.run.id);
  assert.equal(artifacts.some(a => ['native_api_test_run', 'native_api_test_run_summary', 'ai_judgement'].includes(a.artifact_type)), false);
  assert.deepEqual(await f.repo.getCapturedRequest(f.run.id, f.endpoint.id), f.capturedBefore);
  for (const artifact of f.artifactsBefore) assert.deepEqual(artifacts.find(a => a.id === artifact.id), artifact);
}

test('direct native API runner and tool preserve the capture guard without execution or task mutation', async t => {
  const f = await fixture(t);
  const before = await f.repo.getTask(f.task.id);
  for (const invoke of [
    () => runNativeApiTestRun({ db: f.db, repo: f.repo, task: f.task, endpoint: f.endpoint, payloads: [] }),
    () => f.registry.call('bstg.api_test.run', { endpoint_id: f.endpoint.id }, f.context),
  ]) {
    await assert.rejects(invoke(), error => error.name === 'CaptureRequiredError' && error.code === 'capture_required');
    await assertNoExecution(f);
    assert.deepEqual(await f.repo.getTask(f.task.id), before);
    assert.deepEqual(await f.repo.listArtifacts(f.run.id), []);
  }
  const [invocation] = await f.repo.listToolInvocations(f.run.id);
  assert.equal(invocation.status, 'blocked');
  assert.deepEqual(invocation.output_json, { blocked: true, error_code: 'capture_required', reason_code: 'request_missing', failure_phase: 'pre_action', action_performed: false });
  assert.match(invocation.error_message, /触发对应页面功能或导入实际流量/);
});

const unobservedField = 'unobserved_fixture_field';
test('captured request compilation rejects an unobserved field without exposing it or changing the request', async t => {
  const f = await fixture(t, { captured: true });
  const endpoint = { ...f.endpoint, captured_request: f.capturedBefore };
  const before = structuredClone(endpoint);
  for (const field of [unobservedField, `$body.${unobservedField}`, '$path.99']) {
    assert.throws(() => capturedSpec(endpoint, { [field]: 'fixture' }), error =>
      error instanceof CapturedRequestFieldError && !error.message.includes(field));
  }
  assert.deepEqual(endpoint, before);
  await assertNoExecution(f);
});

test('unobserved native API field blocks before rules, checklists, accounts or execution assets are created', async t => {
  const f = await fixture(t, { captured: true, vulnType: 'auth_otp' });
  const before = await f.repo.getTask(f.task.id);
  for (const invoke of [
    () => runNativeApiTestRun({ db: f.db, repo: f.repo, task: f.task, endpoint: f.endpoint, payloads: [], paramName: unobservedField }),
    () => f.registry.call('bstg.api_test.run', { endpoint_id: f.endpoint.id, param_name: unobservedField }, f.context),
  ]) {
    await assert.rejects(invoke(), /待测试字段没有出现在真实请求中/);
    await assertNoExecution(f);
    assert.deepEqual(await f.repo.getTask(f.task.id), before);
    assert.deepEqual(await f.repo.listArtifacts(f.run.id), f.artifactsBefore);
  }
  const [invocation] = await f.repo.listToolInvocations(f.run.id);
  assert.equal(invocation.status, 'blocked');
  assert.deepEqual(invocation.output_json, { blocked: true, error_code: 'capture_required', reason_code: 'field_unobserved', failure_phase: 'pre_action', action_performed: false });
  assert.match(invocation.error_message, /触发对应页面功能或导入实际流量/);
  assert.equal(invocation.error_message.includes(unobservedField), false);
});

for (const scenario of [
  { label: 'missing capture', options: {} },
  { label: 'unobserved requested field', options: { captured: true, vulnType: 'auth_otp', paramName: unobservedField } },
]) for (const max_parallel_agents of [1, 2]) {
  test(`native API ${scenario.label} stays blocked through runtime and projection (${max_parallel_agents} workers)`, async t => {
    const f = await fixture(t, scenario.options);
    await f.runtime.run(f.run.id, { max_parallel_agents });
    const snapshot = await f.repo.getSnapshot(f.run.id);
    const task = snapshot.tasks.find(item => item.id === f.task.id);
    assert.equal(f.decisions(), 1, 'capture prerequisite cannot be followed by model completion');
    assert.equal(task.status, 'blocked');
    assert.equal(task.phase, 'capture_required');
    assert.ok(task.completed_at);
    assert.match(task.result_summary, /触发对应页面功能或导入实际流量/);
    assert.equal(snapshot.tool_invocations.length, 1);
    assert.equal(snapshot.tool_invocations[0].status, 'blocked');
    assert.equal(snapshot.tool_invocations[0].output_json.error_code, 'capture_required');
    if (scenario.options.paramName) assert.equal(snapshot.tool_invocations[0].output_json.reason_code, 'field_unobserved');
    assert.equal(snapshot.run.summary.tasks_completed, 0);
    assert.equal(snapshot.run.summary.tasks_failed, 0);
    assert.equal(snapshot.run.summary.tasks_blocked, 1);
    const outcome = snapshot.agent_memories.find(memory => memory.memory_type === 'task_outcome');
    assert.equal(outcome.content_json.status, 'blocked');
    assert.equal(outcome.content_json.phase, 'capture_required');
    assert.deepEqual(await f.repo.findRunnablePendingTasks(f.run.id, 20), []);
    await assertNoExecution(f);

    // An earlier clear judgement cannot override the unresolved capture prerequisite.
    snapshot.artifacts.push({ ...judge(), scan_run_id: f.run.id, task_id: f.task.id, source_ref: f.endpoint.id });
    const product = buildProductAssessmentState(snapshot);
    const [projected] = product.business_functions.flatMap(feature => feature.tests);
    assert.equal(projected.status, 'blocked');
    assert.equal(projected.outcome, 'inconclusive');
    assert.equal(projected.checked, false);
    assert.equal(projected.summary, task.result_summary);
    assert.equal(projected.summary.includes(unobservedField), false);
    assert.equal(product.totals.completed, 0);
    assert.equal(product.totals.blocked, 1);
    assert.equal(product.totals.progress, 0);
  });
}

test('shared compiler errors outside native preflight remain failed without claiming no action occurred', async t => {
  const f = await fixture(t, { captured: true });
  const registry = new AgentToolRegistry();
  registry.register({ name: 'bstg.api_test.run', description: 'Later compiler failure fixture', input_schema: {},
    handler: async () => { throw new CapturedRequestFieldError(); } });
  f.runtime.registry = registry;
  await f.runtime.run(f.run.id);
  const snapshot = await f.repo.getSnapshot(f.run.id);
  assert.equal(snapshot.tasks[0].status, 'failed');
  assert.equal(snapshot.tool_invocations[0].status, 'failed');
  assert.deepEqual(snapshot.tool_invocations[0].output_json, {});
  assert.equal(buildProductAssessmentState(snapshot).business_functions.flatMap(feature => feature.tests)[0].status, 'failed');
});

for (const [label, paramName, captured] of [
  ['query', 'file', true],
  ['existing nonnumeric path', '$path.1', true],
  ['JSON field alias', '$body.value', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"value":"fixture"}' }],
  ['nested JSON array', '$body.items.0.value', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"items":[{"value":"fixture"}]}' }],
  ['URL-encoded field alias', '$body.value', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'value=fixture' }],
  ['duplicate query/body key', '$body.file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"file":"fixture"}' }],
]) {
  test(`native preflight preserves supported captured ${label} mappings`, async t => {
    const f = await fixture(t, { captured, paramName });
    const query = f.db.runRawQuery.bind(f.db);
    const sentinel = new Error('First native write reached after successful preflight');
    let writes = 0;
    t.mock.method(f.db, 'runRawQuery', async (sql, params) => {
      if (/INSERT INTO security_rules/.test(sql)) { writes += 1; throw sentinel; }
      return query(sql, params);
    });
    await assert.rejects(f.registry.call('bstg.api_test.run', { endpoint_id: f.endpoint.id, param_name: paramName }, f.context), error => error === sentinel);
    assert.equal(writes, 1);
    assert.equal((await f.repo.listToolInvocations(f.run.id))[0].status, 'failed');
    await assertNoExecution(f);
  });
}

for (const options of [{ required: true, captured: true }, { required: false, captured: false },
  { required: true, captured: true, failureMessage: '待测试字段没有出现在真实请求中：synthetic fixture' }]) {
  test(`execution error after capture gate remains failed (${JSON.stringify(options)})`, async t => {
    const f = await fixture(t, options);
    const query = f.db.runRawQuery.bind(f.db);
    let executionAttempts = 0;
    t.mock.method(f.db, 'runRawQuery', async (sql, params) => {
      if (/INSERT INTO security_rules/.test(sql)) {
        executionAttempts += 1;
        // Identical text must not turn an ordinary persistence error into a block.
        throw new Error(options.failureMessage || '当前接口没有已捕获的真实请求，无法建立测试基线。');
      }
      return query(sql, params);
    });
    await f.runtime.run(f.run.id);
    const snapshot = await f.repo.getSnapshot(f.run.id);
    assert.equal(executionAttempts, 1, 'valid capture or opt-out must get past the prerequisite guard');
    assert.equal(f.decisions(), 1);
    assert.equal(snapshot.tasks[0].status, 'failed');
    assert.equal(snapshot.tasks[0].phase, 'failed');
    assert.equal(snapshot.tool_invocations[0].status, 'failed');
    assert.deepEqual(snapshot.tool_invocations[0].output_json, {});
    assert.equal(snapshot.run.status, 'failed');
    const [projected] = buildProductAssessmentState(snapshot).business_functions.flatMap(feature => feature.tests);
    assert.equal(projected.status, 'failed');
    assert.equal(projected.checked, false);
    await assertNoExecution(f);
  });
}
