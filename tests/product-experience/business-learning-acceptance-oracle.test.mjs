import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBusinessLearningOracle,assertNormalOnlyRunProgress,assertProviderPreflightResult,fetchJsonWithDeadline,fetchJsonWithProgressRetry,safeFixtureStateForReport,safeProgressObservation} from './business-learning-acceptance.mjs';
import http from 'node:http';
import {providerReference} from './live-provider.mjs';

const provider={id:'provider-fixture',model:'acceptance-model'};
const fixtureState=()=>({mode:'secure',metrics:{logins:1,profile_updates:1,cart_additions:1,tickets_created:1,normal_orders:1,notes_created:1,
  unauthorized_reads:0,unauthorized_updates:0,invalid_orders:0},unresolved_values:0,csrf_values:['a','b','c']});

function evidence({flowStatus='verified',productStatus=flowStatus,accepted=true,semanticCheckPassed=true,extraProductFlow=false,executionReference=true,
  selectionOrigin='explicit_observed_event_ids',requestedEventIds=['event-1','event-2'],effectiveEventIds=requestedEventIds,
  prepareEventIds=requestedEventIds,sourceWorkflowId='workflow-1',learningWorkflowId=sourceWorkflowId,
  selectionToolName='bstg.business.workflow.prepare',decisionToolName=selectionToolName}={}){
  const flow={id:'flow-1',revision:2,status:flowStatus,assertions_verified:true,workflow_id:'workflow-1',normal_run_id:'run-1',
    evidence_artifact_ids:['validation-1']};
  const artifacts=[
    {id:'flow-artifact',task_id:'learn-1',artifact_type:'business_flow',source_ref:'flow-1',created_at:'2026-01-01T00:00:00.000Z',content_json:flow},
    {id:'validation-1',task_id:'learn-1',artifact_type:'business_workflow_validation',source_ref:'run-1',created_at:'2026-01-01T00:01:00.000Z',
      content_json:{flow_id:'flow-1',workflow_id:'workflow-1',source_workflow_id:sourceWorkflowId,test_run_id:'run-1',assertions_verified:true}},
    {id:'learning-1',task_id:'learn-1',artifact_type:'business_workflow_learning',source_ref:learningWorkflowId,created_at:'2026-01-01T00:00:20.000Z',
      content_json:{flow_id:'flow-1',workflow_id:learningWorkflowId,selection_origin:selectionOrigin,selection_tool_name:selectionToolName,
        requested_event_ids:requestedEventIds,effective_event_ids:effectiveEventIds,private:true}},
    {id:'decision-1',task_id:'learn-1',artifact_type:'agent_decision',created_at:'2026-01-01T00:00:30.000Z',content_json:{
      source:accepted?'ai_provider':'local_policy',tool_name:decisionToolName,selected_event_ids:prepareEventIds,
      model:'acceptance-model',provider_reference:providerReference(provider.id),provider_response_id:'receipt:fixture',validation_status:accepted?'accepted':'local_only'}},
  ];
  return {technical:{tasks:[{id:'learn-1',task_type:'learn_business_flow',status:'completed'}],artifacts},
    productState:{totals:{confirmed_risks:0,normal_flows:1,verified_flows:1,learning_flows:0,blocked_flows:0},business_functions:[{normal_flows:[
      {id:'flow-1',status:productStatus,checks:[{passed:semanticCheckPassed}],references:executionReference?[{id:'run-1',kind:'execution'}]:[]},
      ...(extraProductFlow?[{id:'flow-without-native-evidence',status:'verified',checks:[{passed:true}],references:[{id:'run-without-native-evidence',kind:'execution'}]}]:[]),
    ]}]}};
}

test('normal-only acceptance oracle binds each Flow to native validation, execution, semantic checks, and an accepted real-model decision',()=>{
  const {technical,productState}=evidence();
  const result=assertBusinessLearningOracle({fixtureState:fixtureState(),technical,productState,provider});
  assert.equal(result.normal_flows_verified,true);
  assert.equal(result.verified_normal_flows,1);
  assert.deepEqual(result.normal_flow_evidence,[{flow_id:'flow-1',workflow_id:'workflow-1',normal_run_id:'run-1',
    validation_artifact_id:'validation-1',workflow_learning_artifact_id:'learning-1',selected_event_count:2,
    accepted_model_decisions:1,accepted_selection_decisions:1}]);
});

test('strict HTTPS normal-only acceptance requires safe capture and native-replay transport receipts',()=>{
  const accepted=evidence();
  const strictFixture={...fixtureState(),transport:'https'};
  accepted.technical.artifacts[0].content_json.captured_transport_verified_https=true;
  accepted.technical.artifacts[1].content_json.transport_verified_https=true;
  accepted.technical.artifacts[2].content_json.captured_transport_verified_https=true;
  assert.doesNotThrow(()=>assertBusinessLearningOracle({fixtureState:strictFixture,provider,requireHttps:true,...accepted}));

  const missingReplay=evidence();
  missingReplay.technical.artifacts[0].content_json.captured_transport_verified_https=true;
  missingReplay.technical.artifacts[2].content_json.captured_transport_verified_https=true;
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:strictFixture,provider,requireHttps:true,...missingReplay}),/HTTPS native replay provenance/);

  const insecureFixture=evidence();
  insecureFixture.technical.artifacts[0].content_json.captured_transport_verified_https=true;
  insecureFixture.technical.artifacts[1].content_json.transport_verified_https=true;
  insecureFixture.technical.artifacts[2].content_json.captured_transport_verified_https=true;
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:{...fixtureState(),transport:'http'},provider,requireHttps:true,...insecureFixture}),/fixture must run over HTTPS/);
});

test('normal-only acceptance oracle requires matching explicit model-selected capture-event evidence without reading raw captures',()=>{
  const accepted=evidence();
  accepted.technical.artifacts.push({artifact_type:'business_capture_event',get content_json(){
    throw Error('The acceptance oracle must not read raw capture data.');
  }});
  assert.doesNotThrow(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...accepted}));

  const wrongOrigin=evidence({selectionOrigin:'server_default'});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...wrongOrigin}),/explicit model-owned event selection/);
  const missingRequested=evidence({requestedEventIds:[]});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...missingRequested}),/nonempty requested capture-event selection/);
  const missingEffective=evidence({effectiveEventIds:[]});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...missingEffective}),/nonempty effective capture-event selection/);
  const mismatchedDecision=evidence({prepareEventIds:['event-2','event-1']});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...mismatchedDecision}),/workflow\.prepare decision matching its explicit capture-event selection/);
});

test('normal-only acceptance oracle joins learning evidence through the validation source Workflow',()=>{
  const sourceBound=evidence({sourceWorkflowId:'captured-workflow',learningWorkflowId:'captured-workflow'});
  assert.doesNotThrow(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...sourceBound}));

  const snapshotBound=evidence({sourceWorkflowId:'captured-workflow',learningWorkflowId:'workflow-1'});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...snapshotBound}),/lacks matching business workflow learning evidence/);
});

test('normal-only acceptance oracle accepts a model-selected source Workflow revision',()=>{
  const revised=evidence({sourceWorkflowId:'captured-workflow',learningWorkflowId:'captured-workflow',
    selectionToolName:'bstg.business.workflow.revise',decisionToolName:'bstg.business.workflow.revise'});
  assert.doesNotThrow(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...revised}));

  const wrongDecision=evidence({sourceWorkflowId:'captured-workflow',learningWorkflowId:'captured-workflow',
    selectionToolName:'bstg.business.workflow.revise',decisionToolName:'bstg.business.workflow.prepare'});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...wrongDecision}),/workflow\.revise decision matching its explicit capture-event selection/);
});

for (const status of ['learning','blocked','failed','awaiting_selection']) {
  test(`normal-only acceptance oracle rejects a ${status} Flow`,()=>{
    const {technical,productState}=evidence({flowStatus:status,productStatus:status});
    assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),technical,productState,provider}),/Blocked, failed, learning, or unverified normal Flows/);
  });
}

test('normal-only acceptance oracle rejects a missing native execution reference and local-only decisions',()=>{
  const missingExecution=evidence({executionReference:false});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...missingExecution}),/matching native execution reference/);
  const localOnly=evidence({accepted:false});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...localOnly}),/no accepted decision from the configured real model/);
});

test('normal-only acceptance oracle rejects a product Flow without persisted native workflow/run evidence',()=>{
  const missingNativeEvidence=evidence({extraProductFlow:true});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...missingNativeEvidence}),/Every product normal Flow must retain persisted native workflow\/run evidence/);
});

test('normal-only acceptance oracle rejects product totals that leave a normal Flow learning or blocked',()=>{
  const learningTotal=evidence();
  learningTotal.productState.totals.learning_flows=1;
  learningTotal.productState.totals.verified_flows=0;
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...learningTotal}),
    /Product normal-Flow totals must report verified_flows=1/);

  const blockedTotal=evidence();
  blockedTotal.productState.totals.blocked_flows=1;
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...blockedTotal}),
    /Product normal-Flow totals must report blocked_flows=0/);
});

test('normal-only acceptance oracle rejects a verified Flow whose semantic assertion failed',()=>{
  const failedSemanticAssertion=evidence({semanticCheckPassed:false});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...failedSemanticAssertion}),/needs passing semantic assertion checks/);
});

test('normal-only acceptance stops immediately when the backend awaits selection',()=>{
  assert.throws(()=>assertNormalOnlyRunProgress({run:{status:'awaiting_selection'}}),/entered awaiting_selection/);
  assert.doesNotThrow(()=>assertNormalOnlyRunProgress({run:{status:'running'}}));
});

test('real-model provider preflight accepts only the configured model and emits a safe projection',()=>{
  assert.deepEqual(assertProviderPreflightResult({ok:true,model:'gpt-5.6-terra',latency_ms:42},'gpt-5.6-terra'),
    {ok:true,model:'gpt-5.6-terra',latency_ms:42});
  const gatewayDetail='provider-token-must-not-escape';
  assert.throws(()=>assertProviderPreflightResult({ok:false,error_message:gatewayDetail},'gpt-5.6-terra'),error=>{
    assert.match(error.message,/did not pass its connection preflight/);
    assert.doesNotMatch(error.message,/provider-token-must-not-escape/);
    return true;
  });
  assert.throws(()=>assertProviderPreflightResult({ok:true,model:'some-other-model',latency_ms:1},'gpt-5.6-terra'),/different model during preflight/);
  assert.throws(()=>assertProviderPreflightResult({ok:true,model:'gpt-5.6-terra',latency_ms:-1},'gpt-5.6-terra'),/valid latency/);
});

test('acceptance fixture report keeps dynamic secret values out of persisted output',()=>{
  const report=safeFixtureStateForReport({...fixtureState(),csrf_values:['csrf-secret-value'],request_count:8,
    metrics:{...fixtureState().metrics,unrecognized_metric:'should-not-escape'}});
  assert.equal(report.csrf_value_count,1);
  assert.equal(report.request_count,8);
  assert.doesNotMatch(JSON.stringify(report),/csrf-secret-value|unrecognized_metric/);
});

test('progress observations retain bounded lifecycle counts without dynamic fixture or unknown API fields',()=>{
  const observation=safeProgressObservation({at:'2026-01-01T00:00:00.000Z',fixtureState:{...fixtureState(),csrf_values:['csrf-secret-value']},
    state:{run:{status:'running',current_phase:'normal_business_learning'},totals:{tests:3,normal_flows:2,unknown_total:999,confirmed_risks:-1}},
    technical:{run:{current_phase:'normal_business_learning'},tasks:[{status:'completed'},{status:'completed'},{status:'unexpected'}],artifacts:[{},{}]}});
  assert.deepEqual(observation,{at:'2026-01-01T00:00:00.000Z',status:'running',phase:'normal_business_learning',totals:{tests:3,normal_flows:2},
    task_statuses:{completed:2},artifact_count:2,metrics:fixtureState().metrics});
  assert.doesNotMatch(JSON.stringify(observation),/csrf-secret-value|unknown_total|unexpected/);
});

test('JSON reads remain inside the request deadline after response headers arrive',async t=>{
  const server=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.write('{"late":');setTimeout(()=>response.end('true}'),80);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}`;
  await assert.rejects(fetchJsonWithDeadline(url,undefined,Date.now()+25,'Delayed JSON body',25),/Delayed JSON body exceeded its acceptance deadline/);
});

test('acceptance progress polling retries one transient local connection reset inside its total deadline',async t=>{
  let requests=0;
  const server=http.createServer((request,response)=>{
    requests++;
    if(requests===1){request.socket.destroy();return;}
    response.writeHead(200,{'content-type':'application/json'});response.end('{"ok":true}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}`;
  const result=await fetchJsonWithProgressRetry(url,undefined,Date.now()+3000,'Read isolated acceptance progress',{attempts:3,requestTimeoutMs:500});
  assert.equal(result.response.status,200);assert.deepEqual(result.json,{ok:true});assert.equal(requests,2);
});

test('strict normal-only acceptance requires every immutable objective to retain a verified Flow and configured-provider objective decision',()=>{
  const accepted=evidence();
  const objective={id:'objective:0123456789abcdef01234567',label:'Server-owned normal outcome',completion:{required_response_paths:['body.order_id']},requires_prepared_identity:true};
  accepted.technical.tasks.unshift({id:'plan-1',task_type:'plan_business_flows',status:'completed',execution_plan:{
    strict_normal_objectives:true,normal_objective_manifest:[objective],
  }});
  accepted.technical.artifacts[0].content_json.objective_id=objective.id;
  accepted.technical.artifacts[0].content_json.objective_completion=objective.completion;
  accepted.technical.artifacts[0].content_json.requires_prepared_identity=true;
  accepted.technical.artifacts[0].content_json.role='test_role';
  accepted.technical.artifacts[0].content_json.objective_completion_binding={required_response_paths:['body.order_id'],source_event_ids:['event-2'],action_ids:['action-2'],
    source_workflow_id:'workflow-source-1',source_step_orders:[2],normal_workflow_id:'workflow-1',normal_run_id:'run-1',validation_assertion_ids:['assertion-2'],validated:true};
  accepted.technical.artifacts[1].content_json.objective_completion_binding={...accepted.technical.artifacts[0].content_json.objective_completion_binding};
  accepted.technical.artifacts.push(
    {id:'flow-plan-artifact',task_id:'plan-1',artifact_type:'business_flow',source_ref:'flow-1',created_at:'2025-12-31T23:59:00.000Z',
      content_json:{id:'flow-1',revision:1,objective_id:objective.id,status:'discovered'}},
    {id:'plan-decision',task_id:'plan-1',artifact_type:'agent_decision',created_at:'2025-12-31T23:59:10.000Z',content_json:{
      source:'ai_provider',tool_name:'bstg.business.flow.define',selected_objective_id:objective.id,
      model:provider.model,provider_reference:providerReference(provider.id),provider_response_id:'receipt:plan',validation_status:'accepted'}},
  );
  accepted.productState.business_functions[0].normal_flows[0].objective_id=objective.id;
  assert.doesNotThrow(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...accepted}));

  accepted.technical.artifacts[0].content_json.role='anonymous';
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...accepted}),/used anonymous despite its server-owned prepared-identity prerequisite/);
  accepted.technical.artifacts[0].content_json.role='test_role';
  accepted.technical.artifacts[0].content_json.objective_completion_binding.validated=false;
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...accepted}),/did not validate the final-objective completion proof/);

  const missing=evidence();
  missing.technical.tasks.unshift({id:'plan-1',task_type:'plan_business_flows',status:'completed',execution_plan:{
    strict_normal_objectives:true,normal_objective_manifest:[objective],
  }});
  assert.throws(()=>assertBusinessLearningOracle({fixtureState:fixtureState(),provider,...missing}),/exactly one current Flow|one-to-one/);
});
