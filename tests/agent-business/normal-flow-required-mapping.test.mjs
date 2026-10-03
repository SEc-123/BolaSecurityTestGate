/**
 * Regression for the narrow automatic replay bridge in normal business
 * learning.  The model deliberately supplies no mapping IDs here: only a
 * recording-proved response.body -> later request.body FLOW_TICKET may be
 * carried by the native compiler.  This uses local HTTP/SQLite only; no
 * model provider participates in either execution.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {SqliteProvider} from '../../server/src/db/sqlite-provider.ts';
import {dbManager} from '../../server/src/db/db-manager.ts';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {createRecordingSession,ingestRecordingEventsBatch} from '../../server/src/services/recording-service.ts';
import {newBusinessFlow,saveBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {prepareBusinessWorkflow,repairBusinessWorkflow,validateBusinessWorkflow} from '../../server/src/services/ai-scan/agent-business-capture.ts';

function json(res,status,body,headers={}) {
  res.writeHead(status,{'content-type':'application/json',...headers});
  res.end(JSON.stringify(body));
}

async function replayTarget({includeStaticState=false,flowField='nonce'}={}) {
  const pending=new Map(),consumeAttempts=[];
  // This deliberately remains static. It creates an observed OBJECT_ID
  // correlation without making it a prerequisite for the normal replay.
  const staticObjectId='550e8400-e29b-41d4-a716-446655440000';
  let failNextValidConsume=false;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture.invalid');
    if(url.pathname==='/issue'&&req.method==='GET'){
      const flowValue=`flow-${randomUUID()}`,objectId=staticObjectId;
      pending.set(flowValue,{objectId});
      json(res,200,{[flowField]:flowValue,object_id:objectId,...(includeStaticState?{state:'completed'}:{})},{'x-replay-header':'fixture-static-header'});
      return;
    }
    if(url.pathname==='/consume'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      let body={};try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{}
      const submitted=body[flowField],expected=pending.get(submitted),valid=Boolean(expected&&expected.objectId===body.object_id);
      if(!valid){
        consumeAttempts.push({status:409,used_required_mapping:false});
        json(res,409,{state:'rejected',applied:false});return;
      }
      pending.delete(submitted);
      if(failNextValidConsume){
        failNextValidConsume=false;
        consumeAttempts.push({status:503,used_required_mapping:true});
        json(res,503,{state:'temporary_failure',applied:false});return;
      }
      consumeAttempts.push({status:200,used_required_mapping:true});
      json(res,200,{state:'completed',applied:true});return;
    }
    json(res,404,{state:'missing'});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,consumeAttempts,
    failNextValidConsume:()=>{failNextValidConsume=true;},
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}),
  };
}

async function requestJson(url,options={}) {
  const response=await fetch(url,options),body=await response.text();
  return {status:response.status,headers:Object.fromEntries(response.headers.entries()),body,json:JSON.parse(body)};
}

function semanticCompletion(stepOrder,id='normal-flow-completed') {
  return [{id,step_order:stepOrder,description:'The native replay completed the observed business outcome.',purpose:'goal',
    left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'completed'}}];
}

function mappingShape(row,flowField='nonce') {
  return Number(row.from_step_order)===1&&row.from_location==='response.body'&&row.from_path===flowField&&
    Number(row.to_step_order)===2&&row.to_location==='request.body'&&row.to_path===flowField&&row.variable_name===`flow.${flowField}`;
}

async function recordedNormalFlow(t,name,{recordStaleNonce=false,includeStaticState=false,flowField='nonce'}={}) {
  const target=await replayTarget({includeStaticState,flowField});
  const db=new SqliteProvider(name,{file:':memory:'});await db.connect();await db.migrate();
  const priorActive=dbManager.getActive;dbManager.getActive=()=>db;
  t.after(async()=>{
    dbManager.getActive=priorActive;
    await Promise.allSettled([db.disconnect(),target.close()]);
  });
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,name});
  const task=await repo.createTask({scan_run_id:run.id,title:'Replay only the observed normal transaction',task_type:'learn_business_flow',
    execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Issue and consume an observed flow nonce',goal:'A new one-time business operation completes.',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  const session=await createRecordingSession(db,{name:'Recorded one-time replay',mode:'workflow',intent:'learning_seed',source_tool:'bstg.business.capture',role:'anonymous',
    capture_filters:{source:'agent_business',scan_run_id:run.id,task_id:task.id,flow_id:flow.id,capture_status:'stopped',preserve_repeated_events:true}});

  // This is the browser-observed baseline. The original one-time value is consumed
  // before native validation starts, so a native replay must use the new
  // response value emitted by its own first step.
  const issued=await requestJson(`${target.baseUrl}/issue`,{headers:{accept:'application/json'}});
  const capturedRequestNonce=recordStaleNonce?`stale-${randomUUID()}`:issued.json[flowField];
  const requestBody=JSON.stringify({[flowField]:capturedRequestNonce,object_id:issued.json.object_id,...(includeStaticState?{state:'completed'}:{})});
  const consumed=await requestJson(`${target.baseUrl}/consume`,{method:'POST',headers:{'content-type':'application/json','x-replay-header':'fixture-static-header'},body:requestBody});
  assert.equal(issued.status,200);assert.equal(consumed.status,recordStaleNonce?409:200);
  const events=[
    // These fixtures model requests captured at a trusted browser input
    // boundary.  `action_id` alone is deliberately insufficient after the
    // causal recorder hardening: retain the recorder proof carried by a real
    // persistent-browser capture as well.
    {sequence:1,action:'fixture_issue',action_id:'fixture-browser-action-1',causal_proof:'trusted_browser_interaction_dispatch',task_id:task.id,identity_key:'anonymous',method:'GET',url:`${target.baseUrl}/issue`,request_headers:{accept:'application/json'},
      request_body_text:'',response_status:issued.status,response_headers:issued.headers,response_body_text:issued.body,complete:true},
    {sequence:2,action:'fixture_consume',action_id:'fixture-browser-action-2',causal_proof:'trusted_browser_interaction_dispatch',task_id:task.id,identity_key:'anonymous',method:'POST',url:`${target.baseUrl}/consume`,request_headers:{'content-type':'application/json','x-replay-header':'fixture-static-header'},
      request_body_text:requestBody,response_status:consumed.status,response_headers:consumed.headers,response_body_text:consumed.body,complete:true},
  ];
  await ingestRecordingEventsBatch(db,session.id,events);
  for(const event of events){
    const raw=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'business_capture_event',source_ref:session.id,
      title:`Recorded normal request ${event.sequence}`,content_json:{...event,flow_id:flow.id,recording_session_id:session.id,private:true}});
    const recording=(await db.repos.recordingEvents.findAll({where:{session_id:session.id,sequence:event.sequence}}))[0];assert.ok(recording);
    await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'business_capture_event_link',source_ref:session.id,
      title:`Recorded normal link ${event.sequence}`,content_json:{flow_id:flow.id,recording_session_id:session.id,recording_event_id:recording.id,
        raw_artifact_id:raw.id,sequence:event.sequence,action_id:event.action_id,task_id:task.id,identity_key:'anonymous',complete:true}});
  }
  const selectedEventIds=(await db.repos.recordingEvents.findAll({where:{session_id:session.id}})).map(event=>event.id);
  const prepared=await prepareBusinessWorkflow(context,{recording_session_id:session.id,event_ids:selectedEventIds});
  const required=prepared.learning_candidates.suggestions.mappings.find(mapping=>mappingShape({
    from_step_order:mapping.fromStepOrder,from_location:mapping.fromLocation,from_path:mapping.fromPath,
    to_step_order:mapping.toStepOrder,to_location:mapping.toLocation,to_path:mapping.toPath,variable_name:mapping.variableName,
  },flowField));
  assert.ok(required,'the recording exposes the response.body -> request.body one-time dependency');
  assert.equal(required.predictedType,'FLOW_TICKET');
  if(recordStaleNonce){
    assert.notEqual(required.reason,'recording_factual_evidence');
    assert.equal(required.required_for_replay,false);
  }else{
    assert.equal(required.reason,'recording_factual_evidence');
    assert.ok(required.evidenceCount>=2);
    assert.equal(required.required_for_replay,true);
  }
  const headerCandidate=prepared.learning_candidates.suggestions.mappings.find(mapping=>mapping.fromLocation==='response.header'&&mapping.toLocation==='request.header'&&mapping.fromPath==='x-replay-header');
  const objectCandidate=prepared.learning_candidates.suggestions.mappings.find(mapping=>mapping.fromPath==='object_id'&&mapping.toPath==='object_id');
  assert.ok(headerCandidate,'the recording also contains a generic static header correlation');
  assert.ok(objectCandidate,'the recording also contains an OBJECT_ID correlation');
  assert.equal(headerCandidate.required_for_replay,false);
  assert.equal(objectCandidate.predictedType,'OBJECT_ID');
  assert.equal(objectCandidate.required_for_replay,false);
  if(includeStaticState){
    const staticStateCandidate=prepared.learning_candidates.suggestions.mappings.find(mapping=>mapping.fromPath==='state'&&mapping.toPath==='state');
    assert.ok(staticStateCandidate,'the recording contains an exact but low-cardinality state correlation');
    assert.equal(staticStateCandidate.predictedType,'FLOW_TICKET');
    assert.equal(staticStateCandidate.required_for_replay,false,'an exact static state literal is never a compiler-required dynamic mapping');
  }
  assert.equal(JSON.stringify(prepared).includes(issued.json[flowField]),false,'the public learning projection contains field references, never the captured one-time value');
  return {target,db,repo,run,task,flow,context,prepared,required,flowField,recordedNonce:issued.json[flowField],capturedRequestNonce};
}

test('a similarly named recorded field with a different concrete value never becomes a compiler-required replay mapping',async t=>{
  const f=await recordedNormalFlow(t,'normal-flow-mapping-name-only',{recordStaleNonce:true});
  assert.equal(f.required.required_for_replay,false);
  assert.equal(f.prepared.learning_candidates.suggestions.mappings.filter(mapping=>mapping.required_for_replay).length,0,
    'a field-name/classifier heuristic alone must remain an optional Agent mapping');
});

test('an exact low-cardinality state value remains optional even when its classifier says FLOW_TICKET',async t=>{
  const f=await recordedNormalFlow(t,'normal-flow-static-state',{includeStaticState:true});
  const state=f.prepared.learning_candidates.suggestions.mappings.find(mapping=>mapping.fromPath==='state'&&mapping.toPath==='state');
  assert.ok(state);
  assert.equal(state.predictedType,'FLOW_TICKET');
  assert.equal(state.required_for_replay,false);
});

async function nativeTrace(repo,runId,testRunId) {
  return (await repo.listArtifacts(runId)).find(artifact=>artifact.artifact_type==='business_native_trace'&&artifact.source_ref===testRunId)?.content_json?.trace;
}

test('normal validation automatically carries only a factual FLOW_TICKET mapping when model mapping_ids is empty',async t=>{
  const f=await recordedNormalFlow(t,'normal-flow-required-mapping');
  const result=await validateBusinessWorkflow(f.context,{workflow_id:f.prepared.workflow_id,mapping_ids:[],assertions:semanticCompletion(2)});
  assert.equal(result.verified,true,JSON.stringify(result));
  assert.equal(result.execution.success,true);assert.equal(result.execution.has_execution_error,false);
  const run=await f.db.repos.testRuns.findById(result.test_run_id),params=run?.execution_params;
  assert.deepEqual(params?.requested_mapping_ids,[],'the model supplied no optional mapping IDs');
  assert.deepEqual(params?.required_replay_mapping_ids,[f.required.id],'only the narrow recording-factual replay prerequisite is added');
  assert.deepEqual(params?.mapping_ids,[f.required.id]);
  assert.equal(JSON.stringify(params).includes(f.recordedNonce),false,'the persisted model-facing execution decision stores IDs, never a captured value');
  const mappings=await f.db.runRawQuery('SELECT from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name FROM workflow_mappings WHERE workflow_id = ?',[result.workflow_id]);
  assert.equal(mappings.filter(row=>mappingShape(row)).length,1,'the native snapshot retains the proved response.body -> request.body flow mapping');
  assert.equal(mappings.some(row=>row.from_location==='response.header'||row.from_path==='object_id'||row.to_path==='object_id'),false,
    'generic header and OBJECT_ID correlations are not forced into a normal replay');
  const trace=await nativeTrace(f.repo,f.run.id,result.test_run_id);
  assert.equal(trace?.records?.length,2);
  assert.ok(trace.records.every(record=>Number(record.response?.status)>=200&&Number(record.response?.status)<300),'normal validation still requires every native response to be 2xx');
  const replay=f.target.consumeAttempts.at(-1);
  assert.equal(replay?.status,200);assert.equal(replay?.used_required_mapping,true);
});

test('a factual response ticket is classified as FLOW_TICKET and retained without a model mapping choice',async t=>{
  const f=await recordedNormalFlow(t,'normal-flow-required-ticket-mapping',{flowField:'ticket'});
  assert.equal(f.required.predictedType,'FLOW_TICKET');
  assert.equal(f.required.reason,'recording_factual_evidence');
  assert.equal(f.required.required_for_replay,true);
  const sourceConfigs=await f.db.repos.workflowVariableConfigs.findAll({where:{workflow_id:f.prepared.workflow_id}});
  assert.equal(sourceConfigs.some(config=>config.data_source==='account_field'&&config.account_field_name==='ticket'),false,
    'a response-derived flow ticket remains a runtime workflow context, never a required account-profile field');
  assert.ok(sourceConfigs.some(config=>config.data_source==='workflow_context'),
    'the compiler retains the response-derived context injection for the later request');
  const result=await validateBusinessWorkflow(f.context,{workflow_id:f.prepared.workflow_id,mapping_ids:[],assertions:semanticCompletion(2,'ticket-native-goal')});
  assert.equal(result.verified,true,JSON.stringify(result));
  const run=await f.db.repos.testRuns.findById(result.test_run_id);
  assert.deepEqual(run?.execution_params?.requested_mapping_ids,[],'the model still supplies no optional dynamic mapping');
  assert.deepEqual(run?.execution_params?.required_replay_mapping_ids,[f.required.id]);
  const mappings=await f.db.runRawQuery('SELECT from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name FROM workflow_mappings WHERE workflow_id = ?',[result.workflow_id]);
  assert.equal(mappings.filter(row=>mappingShape(row,'ticket')).length,1,'the native snapshot preserves the exact private ticket binding');
  const variables=await f.db.runRawQuery('SELECT name, type, write_policy, is_locked FROM workflow_variables WHERE workflow_id = ?',[result.workflow_id]);
  assert.deepEqual(variables.find(variable=>variable.name==='flow.ticket'),
    {name:'flow.ticket',type:'FLOW_TICKET',write_policy:'on_success_only',is_locked:0},
    'the one-time ticket is refreshed only from a successful preceding response');
  const replay=f.target.consumeAttempts.at(-1);
  assert.equal(replay?.status,200);assert.equal(replay?.used_required_mapping,true);
});

test('repair retains the factual FLOW_TICKET mapping for an empty-model-mapping revalidation',async t=>{
  const f=await recordedNormalFlow(t,'normal-flow-required-mapping-repair');
  // The first native consume receives a fresh mapped nonce but fails for an
  // unrelated transient server error. It must remain an execution failure;
  // repair may not turn this 503 into a normal baseline.
  f.target.failNextValidConsume();
  const failed=await validateBusinessWorkflow(f.context,{workflow_id:f.prepared.workflow_id,mapping_ids:[],assertions:semanticCompletion(2,'first-native-goal')});
  assert.equal(failed.verified,false);assert.equal(failed.execution.has_execution_error,true);
  const failedAttempt=f.target.consumeAttempts.at(-1);
  assert.equal(failedAttempt?.status,503,'the first native failure is the injected transport-independent error, not stale nonce reuse');
  assert.equal(failedAttempt?.used_required_mapping,true);
  const failedRun=await f.db.repos.testRuns.findById(failed.test_run_id);
  assert.deepEqual(failedRun?.execution_params?.requested_mapping_ids,[]);
  assert.deepEqual(failedRun?.execution_params?.required_replay_mapping_ids,[f.required.id]);
  const repaired=await repairBusinessWorkflow(f.context,{workflow_id:failed.workflow_id,test_run_id:failed.test_run_id});
  assert.equal(repaired.status,'repaired');
  const repairedMappings=await f.db.runRawQuery('SELECT from_step_order, from_location, from_path, to_step_order, to_location, to_path, variable_name FROM workflow_mappings WHERE workflow_id = ?',[repaired.workflow_id]);
  assert.ok(repairedMappings.some(row=>mappingShape(row)),'repair keeps a usable response.body -> request.body nonce mapping on the current failed workflow');
  const retried=await validateBusinessWorkflow(f.context,{workflow_id:repaired.workflow_id,mapping_ids:[],assertions:semanticCompletion(2,'repaired-native-goal')});
  assert.equal(retried.verified,true,JSON.stringify(retried));
  assert.equal(retried.execution.success,true);assert.equal(retried.execution.has_execution_error,false);
  const retriedRun=await f.db.repos.testRuns.findById(retried.test_run_id);
  assert.deepEqual(retriedRun?.execution_params?.requested_mapping_ids,[],'repair does not require the model to rediscover the original mapping ID');
  assert.deepEqual(retriedRun?.execution_params?.required_replay_mapping_ids,[f.required.id]);
  const retriedTrace=await nativeTrace(f.repo,f.run.id,retried.test_run_id);
  assert.equal(retriedTrace?.records?.length,2);
  assert.ok(retriedTrace.records.every(record=>Number(record.response?.status)>=200&&Number(record.response?.status)<300),'the repaired normal verification remains subject to the 2xx gate');
  const repairedValidation=(await f.repo.listArtifacts(f.run.id)).find(artifact=>
    artifact.artifact_type==='business_workflow_validation'&&artifact.source_ref===retried.test_run_id);
  assert.ok(repairedValidation,'the repaired native revalidation produces its own immutable receipt');
  assert.equal(repairedValidation.content_json?.workflow_id,retried.workflow_id,
    'the repaired receipt names the current execution snapshot');
  assert.equal(repairedValidation.content_json?.source_workflow_id,f.prepared.workflow_id,
    'repair cannot replace the captured Workflow provenance that identifies the learning evidence');
  const replay=f.target.consumeAttempts.at(-1);
  assert.equal(replay?.status,200);assert.equal(replay?.used_required_mapping,true);
});
