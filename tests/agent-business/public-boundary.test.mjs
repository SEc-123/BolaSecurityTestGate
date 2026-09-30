// Browser-facing snapshots and debug views must remain useful for progress
// and real-model receipts without serializing native traffic or operator data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicTechnicalSnapshot, publicAgentMemory, publicAgentMemoryRevision, publicBrowserContext, publicEvidenceExportRecord, publicPlannerDecision } from '../../server/src/services/ai-scan/public-technical-snapshot.ts';
import { publicDebugTrace } from '../../server/src/routes/debug.ts';
import { publicAgentEvent } from '../../server/src/routes/agent-observability.ts';

const time = '2026-01-01T00:00:00.000Z';

test('public technical snapshot preserves model receipt and execution inventory without raw capture values', () => {
  const secrets = {
    prompt: 'private-product-brief', cookie: 'sid-super-private', token: 'customer-ticket-123',
    response: 'private-response-body', name: 'Alicia Private',
  };
  const snapshot = {
    run: { id: 'run-1', name: 'Private assessment', base_url: `https://example.test/api/orders/${secrets.name}?ticket=${secrets.token}`,
      user_prompt: secrets.prompt, status: 'running', current_phase: 'native_execution', selected_vuln_types: ['business_logic'],
      scan_config: { cookie: secrets.cookie }, summary: { endpoints_total: 3, private: secrets.response }, created_at: time, updated_at: time },
    tasks: [{ id: 'task-1', scan_run_id: 'run-1', title: secrets.name, task_type: 'test_generic_vuln', vuln_type: 'business_logic', endpoint_ids: ['endpoint-1'],
      status: 'completed', priority: 1, dependencies: [], agent_goal: secrets.prompt, execution_plan: { value: secrets.token }, created_assets_json: {},
      result_summary: secrets.response, created_at: time, updated_at: time }],
    endpoints: [{ id: 'endpoint-1', scan_run_id: 'run-1', method: 'POST', path: `/api/orders/${secrets.name}?ticket=${secrets.token}`,
      url: `https://example.test/api/orders/${secrets.name}?ticket=${secrets.token}`, request_summary: secrets.cookie, response_summary: secrets.response, created_at: time, updated_at: time }],
    features: [{ id: 'feature-1', scan_run_id: 'run-1', name: secrets.name, node_type: 'feature', description: secrets.response, confidence: .9,
      evidence_artifact_ids: ['artifact-1'], endpoint_ids: ['endpoint-1'], created_at: time, updated_at: time }],
    candidates: [{ id: 'candidate-1', scan_run_id: 'run-1', feature_id: 'feature-1', vuln_type: 'business_logic', title: secrets.name,
      reason: secrets.response, confidence: .8, endpoint_ids: ['endpoint-1'], required_accounts: ['account-private'], status: 'pending', created_at: time, updated_at: time }],
    artifacts: [
      { id: 'artifact-1', scan_run_id: 'run-1', task_id: 'task-1', artifact_type: 'agent_decision', source_ref: 'task-1', created_at: time, updated_at: time,
        title: secrets.name, content_text: secrets.response, content_json: { source: 'ai_provider', model: 'gpt-6.1-sol', provider_response_id: secrets.token,
          arguments: { cookie: secrets.cookie }, raw_response: secrets.response } },
      { id: 'artifact-2', scan_run_id: 'run-1', task_id: 'task-1', artifact_type: 'generic_mutation_attempt', source_ref: 'endpoint-1', created_at: time, updated_at: time,
        content_json: { status: 'completed', success: true, request: { cookie: secrets.cookie }, response: secrets.response } },
      { id: 'artifact-3', scan_run_id: 'run-1', task_id: 'task-1', artifact_type: 'vulnerability_campaign_plan', created_at: time, updated_at: time,
        content_json: { selected_candidates: [{ id: 'candidate-1', payload: secrets.token }] } },
    ],
    shared_resources: [{ id: 'resource-1', scan_run_id: 'run-1', resource_type: 'private', resource_key: 'cookie', content_json: { cookie: secrets.cookie }, usage_count: 1, created_at: time, updated_at: time }],
    agent_memories: [], browser_contexts: [], planner_decisions: [], tool_invocations: [],
  };
  const view = buildPublicTechnicalSnapshot(snapshot);
  const wire = JSON.stringify(view);
  for (const value of Object.values(secrets)) assert.equal(wire.includes(value), false, `public snapshot leaked ${value}`);
  assert.equal(view.artifacts.filter(item => item.artifact_type === 'generic_mutation_attempt').length, 1, 'technical execution inventory remains countable');
  const decision = view.artifacts.find(item => item.artifact_type === 'agent_decision');
  assert.equal(decision.content_json.source, 'ai_provider');
  assert.equal(decision.content_json.model, 'gpt-6.1-sol');
  assert.match(decision.content_json.provider_response_id, /^receipt:/, 'the receipt is an opaque reference, not the upstream value');
  assert.deepEqual(view.artifacts.find(item => item.artifact_type === 'vulnerability_campaign_plan').content_json.selected_candidates, [{ id: 'candidate-1' }]);
  assert.equal(view.endpoints[0].path, '/api/orders/:value');
  assert.deepEqual(view.shared_resources, []);
});

test('public debug trace retains execution facts but never HTTP headers, bodies, query values, or diagnostic strings', () => {
  const trace = publicDebugTrace({
    run_meta: { kind: 'workflow', run_id: 'run-1', test_run_id: 'test-run-1', started_at: time, finished_at: time },
    summary: { total_requests: 1, errors_count: 1, total_duration_ms: 42 },
    records: [{ timestamp: time, method: 'POST', url: 'https://example.test/orders/Alicia?ticket=customer-ticket-123',
      headers: { Authorization: 'Bearer private-secret', Cookie: 'sid-super-private', 'X-Correlation': 'private-header' }, body: '{"name":"Alicia Private"}',
      response: { status: 422, statusText: 'Rejected private response', headers: { 'set-cookie': 'sid=private-cookie' }, body: '{"reason":"private-response-body"}' },
      error: 'private-diagnostic', duration_ms: 42, retry_attempt: 0, meta: { step_order: 2, template_id: 'template-1', label: 'experiment' } }],
  });
  const wire = JSON.stringify(trace);
  for (const secret of ['private-secret', 'sid-super-private', 'private-header', 'Alicia Private', 'customer-ticket-123', 'private-response-body', 'private-diagnostic', 'private-cookie']) {
    assert.equal(wire.includes(secret), false, `public debug trace leaked ${secret}`);
  }
  assert.equal(trace.records[0].response.status, 422);
  assert.equal(trace.records[0].request.body_present, true);
  assert.equal(trace.records[0].error, 'Execution error; private diagnostic retained.');
});

test('public companion APIs retain lifecycle facts without exposing memory, browser, planner, evidence, or event payload values', () => {
  const secret = 'private-customer-value';
  const value = {
    memory: publicAgentMemory({id:'memory-1',scan_run_id:'run-1',owner_task_id:'task-1',memory_type:'business_fact',memory_key:secret,scope_type:'identity',scope_ref:secret,title:secret,summary:secret,content_json:{value:secret},sensitivity:'secret_ref',llm_visibility:'hidden',confidence:.8,version:2,status:'active',provenance_json:{value:secret},depends_on_json:[secret],usage_count:3,created_at:time,updated_at:time}),
    revision: publicAgentMemoryRevision({id:'revision-1',memory_id:'memory-1',version:2,confidence:.8,summary:secret,content_json:{value:secret},provenance_json:{value:secret},created_at:time}),
    context: publicBrowserContext({id:'context-1',scan_run_id:'run-1',task_id:'task-1',context_key:secret,scope_type:'identity',identity_key:secret,status:'active',storage_state_json:{cookies:[{value:secret}]},current_url:`https://example.test/orders/${secret}?ticket=${secret}`,title:secret,dom_summary_json:{text:secret},network_summary_json:{cookie:secret},last_error:secret,created_at:time,updated_at:time}),
    decision: publicPlannerDecision({id:'decision-1',scan_run_id:'run-1',task_id:'task-1',iteration:1,source:'ai_provider',proposal_json:{value:secret},decision_json:{action:'tool_call',tool_name:'bstg.test_plan.execute',arguments:{value:secret},model:'gpt-6.1-sol'},policy_json:{value:secret},validation_status:'accepted',rejection_reason:secret,decision_signature:secret,created_at:time}),
    evidence: publicEvidenceExportRecord({id:'artifact-1',scan_run_id:'run-1',task_id:'task-1',artifact_type:'generic_mutation_attempt',source_ref:'endpoint-1',content_json:{request:{value:secret},response:secret,test_run_id:'run-1'},created_at:time,updated_at:time}),
    event: publicAgentEvent({id:'event-1',at:time,kind:'agent_tool_completed',status:'failed',scan_run_id:'run-1',task_id:'task-1',tool_name:'bstg.test_plan.execute',provider_id:secret,model:'gpt-6.1-sol',summary:secret,error:secret,input:{message_count:2,input_hash:secret,bytes:20},output:{output_hash:secret,bytes:30,tokens_in:4,tokens_out:5}}),
  };
  const wire = JSON.stringify(value);
  assert.equal(wire.includes(secret), false, 'a public companion API leaked a private value');
  assert.equal(value.context.current_path, '/orders/:value');
  assert.equal(value.decision.tool_name, 'bstg.test_plan.execute');
  assert.equal(value.event.error, 'Agent operation failed; private diagnostic retained.');
});
