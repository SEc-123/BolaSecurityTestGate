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

test('public experiment receipts expose only finite proof gaps, assessment gates, and block reasons', () => {
  const secret = 'private-observed-value-that-must-not-leak';
  const snapshot = {
    run: {id:'run-1',base_url:'https://example.test',status:'failed',selected_vuln_types:[],scan_config:{},summary:{},created_at:time,updated_at:time},
    tasks:[],endpoints:[],features:[],candidates:[],shared_resources:[],agent_memories:[],browser_contexts:[],planner_decisions:[],tool_invocations:[],
    artifacts:[
      {id:'result-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_experiment_result',created_at:time,updated_at:time,
        content_json:{status:'executed',evidence_ready:false,business_proof:{evidence_gaps:[
          {failure_code:'authoritative_readback_unavailable',summary:secret},
          {failure_code:'arbitrary_injected_code',summary:secret},
        ]},raw_capture:secret}},
      {id:'assessment-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_experiment_assessment',created_at:time,updated_at:time,
        content_json:{verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient',missing_evidence:[secret]},reason:secret}},
      {id:'block-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_experiment_block',created_at:time,updated_at:time,
        content_json:{status:'blocked',reason_code:'authoritative_readback_unavailable',blocked_reason:secret}},
    ],
  };
  const view=buildPublicTechnicalSnapshot(snapshot);
  const wire=JSON.stringify(view);
  assert.equal(wire.includes(secret),false,'public experiment receipts must not expose captured or model-authored prose');
  assert.deepEqual(view.artifacts.find(item=>item.id==='result-1').content_json.business_proof,{evidence_gaps:[{
    failure_code:'authoritative_readback_unavailable',
    summary:'The verified Workflow has no observed GET/HEAD read-back after its state-changing request.',
  }]});
  assert.deepEqual(view.artifacts.find(item=>item.id==='assessment-1').content_json.native_evidence_gate,{verdict:'insufficient'});
  assert.equal(view.artifacts.find(item=>item.id==='block-1').content_json.reason_code,'authoritative_readback_unavailable');
});

test('public technical snapshot exposes only opaque explicit-selection provenance needed by business-learning acceptance', () => {
  const secret = 'private-captured-request-value';
  const snapshot = {
    run: {id:'run-1',base_url:'https://example.test',status:'completed',selected_vuln_types:[],scan_config:{},summary:{},created_at:time,updated_at:time},
    tasks: [], endpoints: [], features: [], candidates: [], shared_resources: [], agent_memories: [], browser_contexts: [], planner_decisions: [], tool_invocations: [],
    artifacts: [
      {id:'learning-1',scan_run_id:'run-1',task_id:'learn-1',artifact_type:'business_workflow_learning',source_ref:'workflow-1',created_at:time,updated_at:time,
        content_json:{flow_id:'flow-1',workflow_id:'workflow-1',recording_session_id:'recording-1',selection_origin:'explicit_observed_event_ids',
          selection_tool_name:'bstg.business.workflow.prepare',
          requested_event_ids:['event-1','event-2'],auto_included_event_ids:['event-login'],effective_event_ids:['event-login','event-1','event-2'],selected_event_count:3,
          captured_transport_verified_https:true,
          request:{body:secret},response:secret,credentials:secret}},
      {id:'prepare-1',scan_run_id:'run-1',task_id:'learn-1',artifact_type:'agent_decision',created_at:time,updated_at:time,
        content_json:{source:'ai_provider',model:'gpt-5.6-terra',provider_id:'provider-1',provider_response_id:'private-provider-receipt',validation_status:'accepted',
          tool_name:'bstg.business.workflow.prepare',public_selection:{event_ids:['event-1','event-2']},arguments:{event_ids:[secret],cookie:secret},raw_response:secret}},
      {id:'validation-1',scan_run_id:'run-1',task_id:'learn-1',artifact_type:'business_workflow_validation',source_ref:'run-1',created_at:time,updated_at:time,
        content_json:{flow_id:'flow-1',workflow_id:'snapshot-workflow',source_workflow_id:'source-workflow',test_run_id:'run-1',transport_verified_https:true,private_trace:secret}},
      {id:'other-1',scan_run_id:'run-1',task_id:'learn-1',artifact_type:'agent_decision',created_at:time,updated_at:time,
        content_json:{source:'ai_provider',model:'gpt-5.6-terra',validation_status:'accepted',tool_name:'browser.navigate',arguments:{url:secret}}},
      {id:'experiment-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_decision',created_at:time,updated_at:time,
        content_json:{source:'ai_provider',model:'gpt-5.6-terra',validation_status:'accepted',tool_name:'bstg.test_plan.execute',arguments:{plan_id:secret,body:secret}}},
      {id:'block-decision-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_decision',created_at:time,updated_at:time,
        content_json:{source:'ai_provider',model:'gpt-5.6-terra',validation_status:'accepted',tool_name:'bstg.test_plan.block',arguments:{plan_id:secret,reason_code:secret}}},
      {id:'compilation-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_experiment_compilation',source_ref:'plan-1',created_at:time,updated_at:time,
        content_json:{plan_id:'plan-1',mutation_profile:{model_directed:true,private_patch:secret},private:true}},
      {id:'trace-1',scan_run_id:'run-1',task_id:'experiment-task',artifact_type:'agent_experiment_native_trace',source_ref:'run-2',created_at:time,updated_at:time,
        content_json:{plan_id:'plan-1',kind:'experiment',trace:{request:secret},private:true}},
      {id:'post-action-guard-1',scan_run_id:'run-1',task_id:'learn-1',artifact_type:'business_post_action_replay_guard',created_at:time,updated_at:time,
        content_json:{private:true,recording_session_id:'private-recording-binding',operation_fingerprint:'a'.repeat(64),selector:secret}},
    ],
  };
  const view = buildPublicTechnicalSnapshot(snapshot);
  const learning = view.artifacts.find(item => item.id === 'learning-1').content_json;
  const prepare = view.artifacts.find(item => item.id === 'prepare-1').content_json;
  const validation = view.artifacts.find(item => item.id === 'validation-1').content_json;
  const other = view.artifacts.find(item => item.id === 'other-1').content_json;
  const experiment = view.artifacts.find(item => item.id === 'experiment-1').content_json;
  const blockDecision = view.artifacts.find(item => item.id === 'block-decision-1').content_json;
  const compilation = view.artifacts.find(item => item.id === 'compilation-1').content_json;
  const trace = view.artifacts.find(item => item.id === 'trace-1').content_json;
  const guard = view.artifacts.find(item => item.id === 'post-action-guard-1').content_json;
  assert.deepEqual(learning,{flow_id:'flow-1',workflow_id:'workflow-1',recording_session_id:'recording-1',selection_origin:'explicit_observed_event_ids',selection_tool_name:'bstg.business.workflow.prepare',
    requested_event_ids:['event-1','event-2'],auto_included_event_ids:['event-login'],effective_event_ids:['event-login','event-1','event-2'],
    requested_event_count:2,auto_included_event_count:1,effective_event_count:3,selected_event_count:3,captured_transport_verified_https:true});
  assert.equal(prepare.tool_name,'bstg.business.workflow.prepare');
  assert.deepEqual(prepare.selected_event_ids,['event-1','event-2']);
  assert.deepEqual(validation,{flow_id:'flow-1',workflow_id:'snapshot-workflow',source_workflow_id:'source-workflow',test_run_id:'run-1',transport_verified_https:true});
  assert.equal('arguments' in prepare,false);
  assert.equal('tool_name' in other,false);
  assert.equal('selected_event_ids' in other,false);
  assert.deepEqual(experiment,{source:'ai_provider',model:'gpt-5.6-terra',validation_status:'accepted',tool_name:'bstg.test_plan.execute'});
  assert.deepEqual(blockDecision,{source:'ai_provider',model:'gpt-5.6-terra',validation_status:'accepted',tool_name:'bstg.test_plan.block'});
  assert.deepEqual(compilation,{plan_id:'plan-1',model_directed:true});
  assert.deepEqual(trace,{plan_id:'plan-1',kind:'experiment'});
  assert.deepEqual(guard,{});
  assert.doesNotMatch(JSON.stringify(view),/private-captured-request-value|private-provider-receipt|private-recording-binding|a{64}/);
});

test('public technical snapshot retains sealed operation provenance without method or route matcher', () => {
  const privateRoute = '/private/operation-route-secret';
  const operationId = 'operation:0123456789abcdef01234567';
  const binding = {
    operation_id: operationId,
    side_effect_class: 'transaction',
    source_event_ids: ['event-1'], action_ids: ['action-1'], source_workflow_id: 'source-workflow-1',
    source_step_orders: [2], normal_workflow_id: 'workflow-1', normal_run_id: 'run-1',
    validation_assertion_ids: ['assertion-1'], validation_artifact_id: 'validation-1', validated: true,
    method: 'POST', route_shape: privateRoute, raw_response: 'private-operation-response',
  };
  const snapshot = {
    run: {id:'run-1',base_url:'https://example.test',status:'completed',selected_vuln_types:[],scan_config:{},summary:{},created_at:time,updated_at:time},
    tasks: [], endpoints: [], features: [], candidates: [], shared_resources: [], agent_memories: [], browser_contexts: [], planner_decisions: [], tool_invocations: [],
    artifacts: [
      {id:'flow-artifact-1',scan_run_id:'run-1',task_id:'task-1',artifact_type:'business_flow',source_ref:'flow-1',created_at:time,updated_at:time,
        content_json:{id:'flow-1',status:'verified',objective_id:'objective:0123456789abcdef01234567',
          objective_operation:{operation_id:operationId,method:'POST',route_shape:privateRoute,side_effect_class:'transaction'},objective_operation_binding:binding}},
      {id:'validation-1',scan_run_id:'run-1',task_id:'task-1',artifact_type:'business_workflow_validation',source_ref:'run-1',created_at:time,updated_at:time,
        content_json:{flow_id:'flow-1',workflow_id:'workflow-1',test_run_id:'run-1',assertions_verified:true,objective_operation_binding:binding}},
    ],
  };
  const view = buildPublicTechnicalSnapshot(snapshot);
  const flow = view.artifacts.find(item => item.id === 'flow-artifact-1').content_json;
  const validation = view.artifacts.find(item => item.id === 'validation-1').content_json;
  for (const receipt of [flow.objective_operation_binding, validation.objective_operation_binding]) {
    assert.equal(receipt.operation_id, operationId);
    assert.equal(receipt.side_effect_class, 'transaction');
    assert.equal(receipt.validated, true);
    assert.equal('method' in receipt, false);
    assert.equal('route_shape' in receipt, false);
  }
  assert.doesNotMatch(JSON.stringify(view),/private\/operation-route-secret|private-operation-response/);
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

test('public technical snapshot exposes only bounded experiment lifecycle linkage', () => {
  const secret = 'private-executable-plan-material';
  const snapshot = {
    run: {id:'run-1',base_url:'https://example.test',status:'completed',selected_vuln_types:[],scan_config:{},summary:{},created_at:time,updated_at:time},
    tasks: [{
      id:'experiment-task-1',scan_run_id:'run-1',title:'private title',task_type:'model_business_experiment',status:'completed',priority:1,dependencies:[],
      execution_plan:{intent:'model_business_experiment',flow_id:'flow-1',normal_run_id:'normal-run-1',source_flow_revision:3,
        selector:secret,headers:{authorization:secret},patch:{value:secret}},created_assets_json:{},created_at:time,updated_at:time,
    }],
    endpoints: [],features: [],candidates: [],shared_resources: [],agent_memories: [],browser_contexts: [],planner_decisions: [],tool_invocations: [],
    artifacts: [{
      id:'plan-artifact-1',scan_run_id:'run-1',task_id:'experiment-task-1',artifact_type:'agent_experiment_plan',source_ref:'plan-1',created_at:time,updated_at:time,
      content_json:{id:'plan-1',parent_plan_id:'parent-plan-1',plan_id:'plan-1',revision:2,flow_id:'flow-1',status:'compiled',
        private_patch:secret,request:{header:secret}},
    }],
  };
  const view=buildPublicTechnicalSnapshot(snapshot);
  assert.deepEqual(view.tasks[0].execution_plan,{intent:'model_business_experiment',flow_id:'flow-1',normal_run_id:'normal-run-1',source_flow_revision:3});
  assert.deepEqual(view.artifacts[0].content_json,{id:'plan-1',parent_plan_id:'parent-plan-1',plan_id:'plan-1',revision:2,flow_id:'flow-1',status:'compiled'});
  assert.equal(JSON.stringify(view).includes(secret),false);
});

test('public Android lifecycle receipts retain aggregate TLS proof but no session or native-run handles', () => {
  const privateBinding = 'android-private-recording-binding';
  const snapshot = {
    run: {id:'run-1',base_url:'https://example.test',status:'completed',selected_vuln_types:[],scan_config:{},summary:{},created_at:time,updated_at:time},
    tasks: [], endpoints: [], features: [], candidates: [], shared_resources: [], agent_memories: [], browser_contexts: [], planner_decisions: [], tool_invocations: [],
    artifacts: [{id:'android-receipt-1',scan_run_id:'run-1',task_id:'android-task-1',artifact_type:'android_business_normal_validation',created_at:time,updated_at:time,
      content_json:{private:true,recording_session_id:privateBinding,workflow_ids:['private-workflow-handle'],completed_test_run_ids:['private-test-run-handle'],
        workflow_count:1,completed_test_run_count:1,verified_decrypted_https:true,explicitly_decrypted_https_flows:2}}],
  };
  const view = buildPublicTechnicalSnapshot(snapshot);
  assert.deepEqual(view.artifacts[0].content_json,{workflow_count:1,completed_test_run_count:1,verified_decrypted_https:true});
  assert.equal(JSON.stringify(view).includes(privateBinding),false);
  assert.equal(JSON.stringify(view).includes('private-workflow-handle'),false);
  assert.equal(JSON.stringify(view).includes('private-test-run-handle'),false);
});
