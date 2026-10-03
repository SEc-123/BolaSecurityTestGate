// Focused native-asset adapter coverage. The fixture exposes only a local
// normal-operation endpoint; this test neither probes a vulnerability nor
// reaches an external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SqliteProvider } from '../../server/src/db/sqlite-provider.ts';
import { dbManager } from '../../server/src/db/db-manager.ts';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { buildNativeAssetToolSpecs } from '../../server/src/agent/tools/native-asset-tools.ts';
import { createAgentToolRegistry } from '../../server/src/agent/index.ts';
import { newBusinessFlow, saveBusinessFlow } from '../../server/src/services/ai-scan/agent-business-contract.ts';
import { BUSINESS_EXPERIMENT_INTENT } from '../../server/src/agent/business-task-lifecycle.ts';

const nativeToolNames = [
  'bstg.assets.search',
  'bstg.template.inspect',
  'bstg.workflow.inspect',
  'bstg.workflow.prepare',
  'bstg.native.run',
  'bstg.test_run.inspect',
];

async function localTarget() {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.method === 'POST' && request.url === '/native-proof') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ completed: true, kind: 'normal_fixture' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'fixture_route_missing' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function rawNormalRequest(secrets) {
  return [
    'POST /native-proof HTTP/1.1',
    'Content-Type: application/json',
    `Authorization: Bearer ${secrets.authorization}`,
    `Cookie: session=${secrets.cookie}`,
    `X-Private-Request: ${secrets.rawRequest}`,
    '',
    JSON.stringify({ password: secrets.password, token: secrets.token, account_reference: secrets.fieldValue }),
  ].join('\r\n');
}

function assertNoSecret(value, secrets, label) {
  const serialized = JSON.stringify(value);
  for (const secret of Object.values(secrets)) {
    assert.equal(serialized.includes(secret), false, `${label} exposed a private fixture value`);
  }
}

async function createRecording(db, scanRunId, name) {
  return db.repos.recordingSessions.create({
    name,
    mode: 'workflow',
    intent: 'learning_seed',
    status: 'finished',
    source_tool: 'bstg.business.capture',
    requested_field_names: ['password', 'token'],
    capture_filters: { source: 'agent_business', scan_run_id: scanRunId, capture_status: 'stopped' },
    target_fields: [],
    event_count: 1,
    field_hit_count: 0,
    runtime_context_count: 0,
    generated_result_count: 0,
    published_result_count: 0,
    summary: {},
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
  });
}

async function createWorkflowFixture(db, recording, request, name, parsedStructure) {
  const template = await db.repos.apiTemplates.create({
    name: `${name} request template`,
    group_name: 'normal fixture',
    description: 'A normal fixture request whose private values stay in native storage.',
    raw_request: request,
    parsed_structure: parsedStructure || {
      request: {
        headers: {
          authorization: 'stored-authorization-value',
          cookie: 'stored-cookie-value',
          'x-private-request': 'stored-raw-marker',
        },
        body: {
          password: 'stored-password-value',
          token: 'stored-token-value',
          account_reference: 'stored-field-value',
          nested: { value: 'stored-value-field' },
        },
      },
      raw_request: request,
    },
    variables: [{ name: 'token', location: 'request.body', value: 'stored-variable-value' }],
    failure_patterns: [],
    failure_logic: 'OR',
    is_active: true,
    source_recording_session_id: recording.id,
  });
  const workflow = await db.repos.workflows.create({
    name: `${name} normal workflow`,
    description: 'Replay one known normal operation for private evidence only.',
    is_active: true,
    assertion_strategy: 'all_steps_pass',
    account_binding_strategy: 'independent',
    enable_baseline: false,
    baseline_config: { capture_replay_only: true },
    enable_extractor: false,
    enable_session_jar: false,
    session_jar_config: { cookie_mode: true },
    workflow_type: 'baseline',
    learning_status: 'learned',
    learning_version: 1,
    template_mode: 'snapshot',
    source_recording_session_id: recording.id,
  });
  const step = await db.repos.workflowSteps.create({
    workflow_id: workflow.id,
    api_template_id: template.id,
    step_order: 1,
    request_snapshot_raw: request,
    snapshot_template_id: template.id,
    snapshot_template_name: template.name,
    snapshot_created_at: new Date().toISOString(),
    step_assertions: [{
      id: 'normal-status',
      left: { type: 'response', path: 'status' },
      op: 'equals',
      right: { type: 'literal', value: '200' },
      missing_behavior: 'fail',
    }],
    assertions_mode: 'all',
    failure_patterns_override: [],
  });
  return { template, workflow, step };
}

test('native asset tools register, reject cross-scan assets, redact model output, and execute a local fresh run', { timeout: 30000 }, async t => {
  assert.deepEqual(buildNativeAssetToolSpecs().map(tool => tool.name), nativeToolNames, 'The native builder exposes exactly six tools');
  const registry = createAgentToolRegistry();
  assert.deepEqual(registry.list().map(tool => tool.name).filter(name => nativeToolNames.includes(name)), [...nativeToolNames].sort(),
    'All six native tools are present in the production registry');

  const target = await localTarget();
  const db = new SqliteProvider(`native-asset-tools-${randomUUID()}`, { file: ':memory:' });
  await db.connect();
  await db.migrate();
  const previousActiveDb = dbManager.getActive;
  dbManager.getActive = () => db;
  t.after(async () => {
    dbManager.getActive = previousActiveDb;
    await db.disconnect();
    await target.close();
  });

  const repo = new AIScanRepository(db);
  const scan = await repo.createRun({ base_url: target.baseUrl, name: 'Native asset local fixture' });
  const otherScan = await repo.createRun({ base_url: target.baseUrl, name: 'Other assessment fixture' });
  const task = await repo.createTask({ scan_run_id: scan.id, title: 'Run normal native evidence', task_type: 'autonomous_agent_task' });
  const context = { db, repo, scanRunId: scan.id, taskId: task.id };
  const secrets = {
    authorization: `authorization-${randomUUID()}`,
    cookie: `cookie-${randomUUID()}`,
    password: `password-${randomUUID()}`,
    token: `token-${randomUUID()}`,
    fieldValue: `field-value-${randomUUID()}`,
    rawRequest: `raw-request-${randomUUID()}`,
  };
  const request = rawNormalRequest(secrets);
  const recording = await createRecording(db, scan.id, 'Current assessment recording');
  const current = await createWorkflowFixture(db, recording, request, 'Current assessment');
  const priorRun = await db.repos.testRuns.create({
    name: 'Existing native test run',
    status: 'completed',
    execution_type: 'workflow',
    trigger_type: 'fixture',
    workflow_id: current.workflow.id,
    template_ids: [current.template.id],
    account_ids: [],
    execution_params: { scan_run_id: scan.id, token: secrets.token, model_directed: true, plan_id: 'safe-plan-id' },
    source_recording_session_id: recording.id,
    progress_percent: 100,
    error_message: `native replay diagnostic: Authorization Bearer ${secrets.authorization}; Cookie session=${secrets.cookie}; password=${secrets.password}; token=${secrets.token}; field=${secrets.fieldValue}`,
    errors_count: 1,
    has_execution_error: true,
  });

  const otherRecording = await createRecording(db, otherScan.id, 'Other assessment recording');
  const other = await createWorkflowFixture(db, otherRecording, 'GET /unreachable HTTP/1.1\r\n\r\n', 'Other assessment');
  const otherRun = await db.repos.testRuns.create({
    name: 'Other native test run',
    status: 'completed',
    execution_type: 'workflow',
    trigger_type: 'fixture',
    workflow_id: other.workflow.id,
    template_ids: [other.template.id],
    account_ids: [],
    execution_params: { scan_run_id: otherScan.id },
    source_recording_session_id: otherRecording.id,
    progress_percent: 100,
    errors_count: 0,
    has_execution_error: false,
  });

  const listed = await registry.call('bstg.assets.search', { kind: 'all' }, context);
  assert.equal(listed.ok, true);
  assertNoSecret(listed.data, secrets, 'assets.search');
  assert.equal(JSON.stringify(listed.data).includes(otherRecording.id), false, 'Asset search does not list other-scan recording IDs');
  assert.equal(JSON.stringify(listed.data).includes(other.workflow.id), false, 'Asset search does not list other-scan workflow IDs');
  assert.equal(JSON.stringify(listed.data).includes(otherRun.id), false, 'Asset search does not list other-scan Test Run IDs');

  const templateInspection = await registry.call('bstg.template.inspect', { template_id: current.template.id }, context);
  assert.equal(templateInspection.ok, true);
  assertNoSecret(templateInspection.data, secrets, 'template.inspect');
  assert.deepEqual(templateInspection.data.template.request_shape.request.body.account_reference, { type: 'string', length: 'stored-field-value'.length });

  const workflowInspection = await registry.call('bstg.workflow.inspect', { workflow_id: current.workflow.id }, context);
  assert.equal(workflowInspection.ok, true);
  assertNoSecret(workflowInspection.data, secrets, 'workflow.inspect');
  assert.equal(workflowInspection.data.steps[0].workflow_step_id, current.step.id);
  assert.equal(workflowInspection.data.steps[0].id, current.step.id);
  assert.equal(workflowInspection.data.steps[0].has_snapshot, true);
  assert.equal(Object.hasOwn(workflowInspection.data.steps[0], 'request_snapshot_raw'), false);

  const formRequest = [
    'POST /native-proof HTTP/1.1',
    'Content-Type: application/x-www-form-urlencoded',
    '',
    'alias=fixture-value',
  ].join('\r\n');
  const formRecording = await createRecording(db, scan.id, 'URL-encoded assessment recording');
  const formStructure = { request: { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: { alias: 'fixture-value' } } };
  const form = await createWorkflowFixture(db, formRecording, formRequest, 'URL-encoded assessment', formStructure);
  const formNative = await registry.call('bstg.native.run', { workflow_id: form.workflow.id }, context);
  assert.equal(formNative.ok, true, formNative.error);
  assert.equal(formNative.data.execution_success, true);
  const formTask = await repo.createTask({ scan_run_id: scan.id, title: 'Inspect URL-encoded experiment workflow',
    task_type: 'model_business_experiment', execution_plan: { intent: BUSINESS_EXPERIMENT_INTENT, flow_id: 'pending-form-flow' } });
  const formFlow = newBusinessFlow({ name: 'Current URL-encoded flow', goal: 'Inspect a supported form request shape' }, formTask.id);
  Object.assign(formFlow, { workflow_id: form.workflow.id, recording_session_id: formRecording.id, normal_run_id: formNative.data.test_run_id });
  await saveBusinessFlow(repo, scan.id, formTask.id, formFlow);
  await repo.updateTask(formTask.id, { execution_plan: { intent: BUSINESS_EXPERIMENT_INTENT, flow_id: formFlow.id } });
  const formInspection = await registry.call('bstg.workflow.inspect', { workflow_id: form.workflow.id }, { ...context, taskId: formTask.id });
  assert.equal(formInspection.ok, true, formInspection.error);
  assert.equal(formInspection.data.steps[0].request_body_format, 'form_urlencoded');
  assert.equal(formInspection.data.steps[0].body_patch_location, 'form_body');
  assert.ok(formInspection.data.steps[0].observed_patch_targets.some(target => target.location === 'form_body' && target.path === 'alias'),
    'URL-encoded request fields expose their actual native patch location');

  const runInspection = await registry.call('bstg.test_run.inspect', { test_run_id: priorRun.id }, context);
  assert.equal(runInspection.ok, true);
  assertNoSecret(runInspection.data, secrets, 'test_run.inspect');
  assert.equal(runInspection.data.test_run.plan_id, 'safe-plan-id');
  assert.equal(Object.hasOwn(runInspection.data.test_run, 'execution_params'), false);
  assert.match(runInspection.data.test_run.error_message || '', /raw diagnostic is retained in private evidence/i);

  for (const [toolName, input] of [
    ['bstg.template.inspect', { template_id: other.template.id }],
    ['bstg.workflow.inspect', { workflow_id: other.workflow.id }],
    ['bstg.workflow.prepare', { recording_session_id: otherRecording.id }],
    ['bstg.native.run', { workflow_id: other.workflow.id }],
    ['bstg.test_run.inspect', { test_run_id: otherRun.id }],
  ]) {
    const rejected = await registry.call(toolName, input, context);
    assert.equal(rejected.ok, false, `${toolName} rejects a different assessment's ID`);
    assert.match(rejected.error || '', /not attributable|not owned/i);
  }

  const nativeResult = await registry.call('bstg.native.run', { workflow_id: current.workflow.id }, context);
  assert.equal(nativeResult.ok, true, nativeResult.error);
  assertNoSecret(nativeResult.data, secrets, 'native.run');
  assert.equal(nativeResult.data.execution_success, true);
  assert.equal(nativeResult.data.has_execution_error, false);
  assert.deepEqual(nativeResult.data.executed_step_orders, [1]);
  assert.equal(target.requests.length, 2, 'The current and URL-encoded fixture Test Runs each made one local request');
  const currentRequest = target.requests.at(-1);
  assert.equal(currentRequest.method, 'POST');
  assert.equal(currentRequest.url, '/native-proof');
  assert.equal(currentRequest.headers.authorization, `Bearer ${secrets.authorization}`);
  assert.equal(currentRequest.headers.cookie, `session=${secrets.cookie}`);
  assert.equal(currentRequest.body, JSON.stringify({ password: secrets.password, token: secrets.token, account_reference: secrets.fieldValue }));

  const freshRun = await db.repos.testRuns.findById(nativeResult.data.test_run_id);
  assert.ok(freshRun, 'The native tool created a real Test Run record');
  assert.notEqual(freshRun.id, priorRun.id);
  assert.equal(freshRun.status, 'completed');
  assert.equal(freshRun.execution_params.scan_run_id, scan.id);
  assert.equal(freshRun.execution_params.native_asset_tool, true);
  assert.equal(freshRun.execution_params.evidence_only, true);
  assert.equal((await db.repos.findings.findAll()).length, 0, 'Evidence-only normal replay produces no finding');

  const experimentTask = await repo.createTask({ scan_run_id: scan.id, title: 'Inspect a bound experiment workflow',
    task_type: 'model_business_experiment', execution_plan: { intent: BUSINESS_EXPERIMENT_INTENT, flow_id: 'pending-flow' } });
  const experimentFlow = newBusinessFlow({ name: 'Current experiment flow', goal: 'Inspect the verified normal request shape' }, experimentTask.id);
  Object.assign(experimentFlow, { workflow_id: current.workflow.id, recording_session_id: recording.id, normal_run_id: freshRun.id });
  await saveBusinessFlow(repo, scan.id, experimentTask.id, experimentFlow);
  await repo.updateTask(experimentTask.id, { execution_plan: { intent: BUSINESS_EXPERIMENT_INTENT, flow_id: experimentFlow.id } });
  const experimentWorkflowInspection = await registry.call('bstg.workflow.inspect', { workflow_id: current.workflow.id },
    { ...context, taskId: experimentTask.id });
  assert.equal(experimentWorkflowInspection.ok, true, experimentWorkflowInspection.error);
  assert.equal(experimentWorkflowInspection.data.workflow_id, current.workflow.id);
  assert.equal(Object.hasOwn(experimentWorkflowInspection.data, 'id'), false,
    'the experiment view does not expose an ambiguous top-level generic ID');
  assert.equal(experimentWorkflowInspection.data.steps[0].step_order, current.step.step_order);
  assert.equal(Object.hasOwn(experimentWorkflowInspection.data.steps[0], 'workflow_step_id'), false,
    'the experiment model receives an exact order and never needs to copy the opaque native step ID');
  assert.equal(Object.hasOwn(experimentWorkflowInspection.data.steps[0], 'id'), false);
  assert.equal(Object.hasOwn(experimentWorkflowInspection.data.steps[0], 'template_id'), false);
  assert.equal(Object.hasOwn(experimentWorkflowInspection.data, 'templates'), false,
    'template metadata is attached to the canonical step instead of a second list of IDs');
  assert.ok(experimentWorkflowInspection.data.steps[0].observed_field_paths.some(field => field.path === 'request.body.password' && field.sensitive),
    'security experiments retain safe field paths needed to select a concrete mutation');
  assert.equal(experimentWorkflowInspection.data.steps[0].request_body_format, 'json');
  assert.equal(experimentWorkflowInspection.data.steps[0].body_patch_location, 'json_body');
  assert.ok(experimentWorkflowInspection.data.steps[0].observed_patch_targets.some(target =>
    target.location === 'json_body' && target.path === 'account_reference' && target.sensitive === false),
  'the experiment view maps captured JSON fields to the exact native patch location');
  assert.ok(experimentWorkflowInspection.data.steps[0].observed_response_body_fields.some(field => field.path === 'completed' && field.type === 'boolean'),
    'the experiment view exposes field paths from the actual verified normal response without its values');
  assert.ok(experimentWorkflowInspection.data.steps[0].observed_response_header_names.some(header => header.name.toLowerCase() === 'content-type'));
  assert.equal(JSON.stringify(experimentWorkflowInspection.data).includes('normal_fixture'), false,
    'normal response values never enter model experiment context');
  assert.equal(JSON.stringify(experimentWorkflowInspection.data).includes(current.template.id), false,
    'template asset IDs are not present beside request field paths');
  assertNoSecret(experimentWorkflowInspection.data, secrets, 'experiment workflow.inspect');
  assert.match(experimentWorkflowInspection.data.notice, /exact integer.*step_order/i);
  assert.equal(JSON.stringify(experimentWorkflowInspection.data).includes(current.step.id), false,
    'opaque native step IDs do not appear in the model experiment view');

  const artifacts = await repo.listArtifacts(scan.id);
  const traceArtifact = artifacts.find(artifact => artifact.id === nativeResult.data.evidence_artifact_ids[1]);
  const factArtifact = artifacts.find(artifact => artifact.id === nativeResult.data.evidence_artifact_ids[0]);
  assert.ok(traceArtifact, 'Native run stores a trace artifact');
  assert.ok(factArtifact, 'Native run stores a result artifact');
  assert.equal(traceArtifact.content_json.private, true, 'The raw trace is explicitly marked private');
  assert.equal(traceArtifact.content_json.test_run_id, freshRun.id);
  assert.equal(traceArtifact.content_json.trace.records.length, 1);
  assert.equal(traceArtifact.content_json.trace.records[0].headers.Authorization, '[REDACTED]');
  assert.equal(traceArtifact.content_json.trace.records[0].headers.Cookie, '[REDACTED]');
  assert.equal(factArtifact.content_json.trace_artifact_id, traceArtifact.id);

  const freshInspection = await registry.call('bstg.test_run.inspect', { test_run_id: freshRun.id }, context);
  assert.equal(freshInspection.ok, true);
  assertNoSecret(freshInspection.data, secrets, 'fresh test_run.inspect');
  assert.deepEqual(freshInspection.data.evidence.map(item => item.id).sort(), [factArtifact.id, traceArtifact.id].sort());
  assert.equal(freshInspection.data.evidence.find(item => item.id === traceArtifact.id).private, true);

  const invalidTemplate = await db.repos.apiTemplates.create({
    name: `Invalid request ${secrets.token}`,
    raw_request: 'not a valid HTTP request',
    parsed_structure: {},
    variables: [],
    failure_patterns: [],
    failure_logic: 'OR',
    is_active: true,
    source_recording_session_id: recording.id,
  });
  const invalidWorkflow = await db.repos.workflows.create({
    name: 'Invalid local native workflow',
    is_active: true,
    assertion_strategy: 'all_steps_pass',
    account_binding_strategy: 'independent',
    enable_baseline: false,
    baseline_config: { capture_replay_only: true },
    enable_extractor: false,
    enable_session_jar: false,
    session_jar_config: { cookie_mode: true },
    workflow_type: 'baseline',
    learning_status: 'learned',
    learning_version: 1,
    template_mode: 'snapshot',
    source_recording_session_id: recording.id,
  });
  await db.repos.workflowSteps.create({
    workflow_id: invalidWorkflow.id,
    api_template_id: invalidTemplate.id,
    step_order: 1,
    request_snapshot_raw: invalidTemplate.raw_request,
    snapshot_template_id: invalidTemplate.id,
    snapshot_template_name: invalidTemplate.name,
    snapshot_created_at: new Date().toISOString(),
    step_assertions: [],
    assertions_mode: 'all',
    failure_patterns_override: [],
  });
  const failedNativeRun = await registry.call('bstg.native.run', { workflow_id: invalidWorkflow.id }, context);
  assert.equal(failedNativeRun.ok, true, failedNativeRun.error);
  assert.equal(failedNativeRun.data.execution_success, false);
  assert.equal(failedNativeRun.data.has_execution_error, true);
  assertNoSecret(failedNativeRun.data, secrets, 'failed native.run');
  assert.match(failedNativeRun.data.errors[0] || '', /raw diagnostic is retained in private evidence/i);
});
