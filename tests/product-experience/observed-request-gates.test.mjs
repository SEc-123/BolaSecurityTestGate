import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {buildWorkflowExecutionPlan} from '../../server/src/services/ai-scan/workflow-context.ts';
import {runFileUploadTask} from '../../server/src/services/ai-scan/file-upload-runner.ts';
import {buildAIScanToolSpecs} from '../../server/src/agent/tools/ai-scan-tools.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';

// Real tools, runners and native in-memory SQLite; transport is forbidden at
// the HTTP boundary so no model, browser, target or external service is used.
async function fixture(t, vulnType, pathname) {
  const db = await database();
  t.after(() => db.disconnect());
  let transportCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    transportCalls += 1;
    throw new Error('HTTP must not execute before the observed-request gate.');
  });
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({base_url:'http://127.0.0.1:9', selected_vuln_types:[vulnType]});
  const endpoint = await repo.upsertEndpoint({scan_run_id:run.id, method:'POST', path:pathname,
    url:`${run.base_url}${pathname}`, source_type:'browser_js_reference'});
  const plan = buildWorkflowExecutionPlan({allEndpoints:[endpoint], selectedEndpointIds:[endpoint.id], targetEndpointId:endpoint.id, vulnType});
  const task = await repo.createTask({scan_run_id:run.id, title:'Observed request gate fixture',
    task_type:vulnType === 'file_upload' ? 'test_file_upload' : 'autonomous_agent_task',
    vuln_type:vulnType, endpoint_ids:[endpoint.id], execution_plan:{workflow_execution_plan:plan}});
  const registry = new AgentToolRegistry();
  for (const tool of buildAIScanToolSpecs()) registry.register(tool);
  return {db, repo, run, endpoint, task, registry, transportCalls:() => transportCalls,
    context:{db, repo, scanRunId:run.id, taskId:task.id}};
}

async function assertNoExecution(f) {
  assert.equal(f.transportCalls(), 0);
  for (const table of ['api_templates', 'workflows', 'test_runs', 'findings']) {
    assert.equal((await f.db.runRawQuery(`SELECT count(*) AS n FROM ${table}`))[0].n, 0, `${table} must remain empty`);
  }
  const artifacts = await f.repo.listArtifacts(f.run.id);
  assert.deepEqual(artifacts.filter(artifact => ['upload_execution_plan', 'upload_request', 'upload_attempt', 'upload_attempt_error', 'generic_mutation_attempt', 'ai_judgement'].includes(artifact.artifact_type)), []);
}

test('upload endpoint name alone cannot invent a file field or produce upload evidence', async t => {
  const f = await fixture(t, 'file_upload', '/api/upload');
  const before = await f.repo.getTask(f.task.id);
  await assert.rejects(f.registry.call('bstg.file_upload.run_test', {endpoint_id:f.endpoint.id}, f.context), /上传需要已观察到的单文件表单或完整 multipart 请求；无法从接口名称猜测文件字段/);
  await assertNoExecution(f);
  assert.deepEqual(await f.repo.getTask(f.task.id), before);
  assert.deepEqual(await f.repo.listArtifacts(f.run.id), []);
  const invocations = await f.repo.listToolInvocations(f.run.id);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].status, 'blocked');
  assert.deepEqual(invocations[0].output_json, {blocked:true, error_code:'capture_required', reason_code:'upload_request_not_observed', failure_phase:'pre_action', action_performed:false});
  assert.match(invocations[0].error_message, /无法从接口名称猜测文件字段/);
});

test('malformed multipart and an observed text field named file cannot authorize an upload', async t => {
  const f = await fixture(t, 'file_upload', '/api/upload');
  await f.repo.saveCapturedRequest(f.endpoint, {method:'POST', url:f.endpoint.url,
    headers:{'content-type':'multipart/form-data; boundary=fixture-boundary'}, body:'incomplete multipart fixture',
    response_status:200, source:'browser', captured_at:new Date().toISOString()});
  await f.repo.createArtifact({scan_run_id:f.run.id, artifact_type:'browser_form', source_ref:f.endpoint.id,
    content_json:{rendered:true, identity_role:'attacker', form:{inputs:[{name:'file', type:'text', value:'fixture.txt'}]}}});
  const before = await f.repo.listArtifacts(f.run.id);
  await assert.rejects(runFileUploadTask({db:f.db, repo:f.repo, task:f.task, endpoint:f.endpoint}), /无法从接口名称猜测文件字段/);
  await assertNoExecution(f);
  assert.deepEqual(await f.repo.listArtifacts(f.run.id), before);
  assert.deepEqual((await f.repo.getTask(f.task.id)).created_assets_json, {});
});

for (const capturedWithoutInputs of [false, true]) {
  test(`generic campaign requires ${capturedWithoutInputs ? 'observed business input fields' : 'a complete captured business request'}`, async t => {
    const f = await fixture(t, 'business_logic', '/api/orders');
    // Suggestive metadata never supplies the actual request body or fields.
    await f.repo.upsertEndpoint({scan_run_id:f.run.id, method:'POST', path:f.endpoint.path,
      url:f.endpoint.url, request_summary:'Order amount and quantity request reference'});
    if (capturedWithoutInputs) {
      await f.repo.saveCapturedRequest(f.endpoint, {method:'POST', url:f.endpoint.url,
        headers:{'content-type':'application/json'}, body:'{}', response_status:200,
        source:'browser', captured_at:new Date().toISOString()});
    }
    const capturedBefore = await f.repo.getCapturedRequest(f.run.id, f.endpoint.id);
    await f.repo.createCandidate({scan_run_id:f.run.id, vuln_type:'business_logic',
      title:'Order amount and quantity', endpoint_ids:[f.endpoint.id], confidence:0.9});
    await f.repo.updateTask(f.task.id, {status:'completed'});
    const result = await f.registry.call('task.expand_selected_vulnerabilities', {selected_vuln_types:['business_logic']}, f.context);
    assert.equal(result.ok, true);
    const children = (await f.repo.listTasks(f.run.id)).filter(task => task.task_type === 'test_generic_vuln');
    assert.equal(children.length, 1);
    assert.equal(children[0].status, 'blocked');
    assert.equal(children[0].phase, 'capture_required');
    assert.match(children[0].result_summary, capturedWithoutInputs ? /尚无可验证的输入字段/ : /尚未采集本项所需的完整业务请求/);
    assert.deepEqual(children[0].created_assets_json, {});
    assert.ok(!(await f.repo.findRunnablePendingTasks(f.run.id, 20)).some(task => task.id === children[0].id));
    assert.deepEqual(await f.repo.getCapturedRequest(f.run.id, f.endpoint.id), capturedBefore);
    await assertNoExecution(f);
  });
}
