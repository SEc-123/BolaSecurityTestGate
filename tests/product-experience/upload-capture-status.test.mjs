import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanAgentRuntime } from '../../server/src/agent/agent-runtime.ts';
import { AgentToolRegistry } from '../../server/src/agent/tool-registry.ts';
import { buildAIScanToolSpecs } from '../../server/src/agent/tools/ai-scan-tools.ts';
import { buildWorkflowExecutionPlan } from '../../server/src/services/ai-scan/workflow-context.ts';
import { CaptureRequiredError } from '../../server/src/services/ai-scan/captured-request.ts';
import { runFileUploadTask } from '../../server/src/services/ai-scan/file-upload-runner.ts';
import { buildProductAssessmentState } from '../../server/src/services/ai-scan/product-state-service.ts';
import { judge } from './fixtures.mjs';

// Production tool/runner/runtime and in-memory SQLite; only the planner and
// HTTP boundary are doubles. No browser, model, saved target or network is used.
async function fixture(t, { observed, authRequired = false, method = 'POST' } = {}) {
  const db = await database();
  t.after(() => db.disconnect());
  const runtime = new AIScanAgentRuntime(db), repo = runtime.getRepository();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected transport in upload fixture'); });
  const run = await repo.createRun({ base_url: 'https://authorized.example.test', selected_vuln_types: ['file_upload'],
    scan_config: { surface: 'web', driving_mode: 'autopilot' } });
  const endpoint = await repo.upsertEndpoint({ scan_run_id: run.id, method, path: '/api/upload',
    url: `${run.base_url}/api/upload`, source_type: 'browser_js_reference', auth_required: authRequired,
    content_type: 'multipart/form-data' });
  if (observed === 'form') await repo.createArtifact({ scan_run_id: run.id, artifact_type: 'browser_form', source_ref: endpoint.id,
    content_json: { rendered: true, identity_role: 'attacker', form: { inputs: [
      { name: 'attachment', type: 'file' }, { name: 'description', type: 'text', value: 'fixture' },
    ] } } });
  if (observed === 'multipart') {
    const body = new FormData();
    body.append('description', 'fixture');
    body.append('attachment', new Blob(['observed file'], { type: 'text/plain' }), 'observed.txt');
    const request = new Request(endpoint.url, { method, body });
    await repo.saveCapturedRequest(endpoint, { method, url: endpoint.url, headers: Object.fromEntries(request.headers),
      body: await request.text(), source: 'browser', captured_at: new Date().toISOString() });
  }
  const plan = buildWorkflowExecutionPlan({ allEndpoints: [endpoint], selectedEndpointIds: [endpoint.id],
    targetEndpointId: endpoint.id, vulnType: 'file_upload' });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Upload capture status fixture', task_type: 'test_file_upload',
    vuln_type: 'file_upload', endpoint_ids: [endpoint.id], execution_plan: { workflow_execution_plan: plan } });
  const registry = new AgentToolRegistry();
  for (const tool of buildAIScanToolSpecs()) registry.register(tool);
  let decisions = 0;
  t.mock.method(runtime.planner, 'decide', async () => ++decisions === 1
    ? { action: 'tool_call', tool_name: 'bstg.file_upload.run_test', arguments: { endpoint_id: endpoint.id }, source: 'local_policy' }
    : { action: 'complete_task', summary: 'Upload fixture completed.', source: 'local_policy' });
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
  assert.equal(artifacts.some(a => ['upload_execution_plan', 'upload_request', 'upload_attempt', 'upload_attempt_error', 'ai_judgement'].includes(a.artifact_type)), false);
  assert.deepEqual(await f.repo.getCapturedRequest(f.run.id, f.endpoint.id), f.capturedBefore);
  for (const artifact of f.artifactsBefore) assert.deepEqual(artifacts.find(a => a.id === artifact.id), artifact);
}

test('missing observed upload contract throws a typed prerequisite before execution', async t => {
  const f = await fixture(t), before = await f.repo.getTask(f.task.id);
  await assert.rejects(runFileUploadTask({ db: f.db, repo: f.repo, task: f.task, endpoint: f.endpoint }), error =>
    error instanceof CaptureRequiredError && error.reason === 'upload_request_not_observed');
  await assertNoExecution(f);
  assert.deepEqual(await f.repo.getTask(f.task.id), before);
  assert.deepEqual(await f.repo.listArtifacts(f.run.id), []);
});

for (const max_parallel_agents of [1, 2]) {
  test(`unobserved upload stays blocked and inconclusive through runtime (${max_parallel_agents} workers)`, async t => {
    const f = await fixture(t);
    await f.runtime.run(f.run.id, { max_parallel_agents });
    const snapshot = await f.repo.getSnapshot(f.run.id), task = snapshot.tasks.find(item => item.id === f.task.id);
    assert.equal(f.decisions(), 1, 'the planner cannot complete a prerequisite-blocked test');
    assert.equal(task.status, 'blocked');
    assert.equal(task.phase, 'capture_required');
    assert.ok(task.completed_at);
    assert.match(task.result_summary, /触发对应页面上传功能或导入实际流量/);
    assert.equal(snapshot.tool_invocations.length, 1);
    assert.equal(snapshot.tool_invocations[0].status, 'blocked');
    assert.deepEqual(snapshot.tool_invocations[0].output_json, { blocked: true, error_code: 'capture_required',
      reason_code: 'upload_request_not_observed', failure_phase: 'pre_action', action_performed: false });
    assert.equal(snapshot.run.summary.tasks_failed, 0);
    assert.equal(snapshot.run.summary.tasks_completed, 0);
    assert.equal(snapshot.run.summary.tasks_blocked, 1);
    assert.equal(snapshot.agent_memories.find(memory => memory.memory_type === 'task_outcome').content_json.status, 'blocked');
    assert.deepEqual(await f.repo.findRunnablePendingTasks(f.run.id, 20), []);
    await assertNoExecution(f);

    // Earlier clear evidence cannot promote the interrupted test to a pass.
    snapshot.artifacts.push({ ...judge(), scan_run_id: f.run.id, task_id: f.task.id, source_ref: f.endpoint.id });
    const product = buildProductAssessmentState(snapshot), [projected] = product.business_functions.flatMap(feature => feature.tests);
    assert.equal(projected.status, 'blocked');
    assert.equal(projected.outcome, 'inconclusive');
    assert.equal(projected.checked, false);
    assert.equal(product.totals.completed, 0);
    assert.equal(product.totals.blocked, 1);
  });
}

for (const options of [{ authRequired: true }, { method: 'DELETE' }]) {
  test(`unrelated upload guard keeps its failure classification (${JSON.stringify(options)})`, async t => {
    const f = await fixture(t, { observed: 'form', ...options });
    await f.runtime.run(f.run.id);
    const snapshot = await f.repo.getSnapshot(f.run.id);
    assert.equal(snapshot.tasks[0].status, 'failed');
    assert.equal(snapshot.tasks[0].phase, 'failed');
    assert.equal(snapshot.tool_invocations[0].status, 'failed');
    assert.deepEqual(snapshot.tool_invocations[0].output_json, {});
    await assertNoExecution(f);
  });
}

test('ordinary runtime failure after an upload request stays failed even with the prerequisite message', async t => {
  const f = await fixture(t, { observed: 'form' });
  f.fetch.mock.mockImplementation(async () => new Response('invalid file', { status: 400 }));
  const createArtifact = f.repo.createArtifact.bind(f.repo);
  t.mock.method(f.repo, 'createArtifact', async input => {
    if (input.artifact_type === 'upload_attempt') throw new Error(new CaptureRequiredError('upload_request_not_observed').message);
    return createArtifact(input);
  });
  await f.runtime.run(f.run.id);
  const snapshot = await f.repo.getSnapshot(f.run.id);
  assert.equal(f.fetch.mock.callCount(), 1, 'the failure must follow a real upload transport attempt');
  assert.equal(snapshot.artifacts.filter(a => a.artifact_type === 'upload_request').length, 1);
  assert.equal(f.decisions(), 1);
  assert.equal(snapshot.tasks[0].status, 'failed');
  assert.equal(snapshot.tasks[0].phase, 'failed');
  assert.equal(snapshot.tool_invocations[0].status, 'failed');
  assert.deepEqual(snapshot.tool_invocations[0].output_json, {});
  assert.equal(snapshot.run.status, 'failed');
  assert.equal(buildProductAssessmentState(snapshot).business_functions.flatMap(feature => feature.tests)[0].status, 'failed');
});

test('upload transport failure remains attempt error evidence without a prerequisite block', async t => {
  const f = await fixture(t, { observed: 'form' });
  const result = await f.registry.call('bstg.file_upload.run_test', { endpoint_id: f.endpoint.id }, f.context);
  assert.equal(f.fetch.mock.callCount(), 1);
  assert.equal(result.ok, true, 'the existing runner returns transport failures as inconclusive evidence');
  assert.equal(result.data.attempts.length, 1);
  assert.match(result.data.attempts[0].error, /Unexpected transport/);
  assert.equal(result.data.upload_evidence_gate.verdict, 'inconclusive');
  assert.equal((await f.repo.listToolInvocations(f.run.id))[0].status, 'completed');
  assert.equal((await f.repo.listArtifacts(f.run.id)).filter(a => a.artifact_type === 'upload_attempt_error').length, 1);
});

for (const observed of ['form', 'multipart']) {
  test(`observed ${observed} preserves upload, mutation and readback execution`, async t => {
    const f = await fixture(t, { observed });
    let uploads = 0, readbacks = 0, stored;
    f.fetch.mock.mockImplementation(async (url, init) => {
      if (init.method === 'GET') {
        readbacks += 1;
        assert.equal(url, `${f.run.base_url}/files/fixture.png`);
        return new Response(stored, { status: 200, headers: { 'content-type': 'image/png' } });
      }
      uploads += 1;
      assert.equal(init.method, 'POST');
      const body = await new Response(init.body, { headers: init.headers }).formData();
      assert.equal(body.get('description'), 'fixture');
      const file = body.get('attachment');
      assert.equal(typeof file, 'object');
      if (!file.name.endsWith('.png')) return new Response('invalid file', { status: 415 });
      stored = await file.arrayBuffer();
      return Response.json({ url: '/files/fixture.png' }, { status: 201 });
    });
    const result = await f.registry.call('bstg.file_upload.run_test', { endpoint_id: f.endpoint.id }, f.context);
    assert.equal(result.ok, true);
    assert.equal(result.data.field_name, 'attachment');
    assert.deepEqual(result.data.attempts.map(a => a.label), ['normal', 'svg_xss', 'html_xss', 'double_extension', 'mime_bypass', 'normal_control']);
    assert.equal(uploads, 6);
    assert.equal(readbacks, 2);
    assert.equal(result.data.judge.verdict, 'not_vulnerable');
    assert.equal(result.data.upload_evidence_gate.baseline_verified, true);
    assert.equal(result.data.upload_evidence_gate.mutation_executed, true);
    assert.deepEqual(result.data.upload_evidence_gate.missing_evidence, []);
    assert.equal((await f.repo.listToolInvocations(f.run.id))[0].status, 'completed');
    assert.equal((await f.repo.listArtifacts(f.run.id)).filter(a => a.artifact_type === 'upload_request').length, 6);
    assert.equal((await f.db.runRawQuery('SELECT count(*) AS n FROM findings'))[0].n, 0);
    assert.deepEqual(await f.repo.getCapturedRequest(f.run.id, f.endpoint.id), f.capturedBefore);
  });
}
