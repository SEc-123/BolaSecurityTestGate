import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AutonomousAgentPlanner,businessExperimentAllowedToolNames,localPolicy} from '../../server/src/agent/autonomous-planner.ts';
import {buildAutonomousAgentContext} from '../../server/src/agent/context-builder.ts';
import {BUSINESS_PLAN_INTENT,BUSINESS_LEARNING_INTENT,BUSINESS_EXPERIMENT_INTENT} from '../../server/src/agent/business-task-lifecycle.ts';
import {newBusinessFlow,saveBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {buildPublicTechnicalSnapshot} from '../../server/src/services/ai-scan/public-technical-snapshot.ts';
import {verifyModelDecisions} from '../product-experience/live-provider.mjs';
import {createAgentToolRegistry} from '../../server/src/agent/index.ts';
import {buildModelContextScope} from '../../server/src/agent/model-context-profile.ts';

test('model context preserves finite safe experiment evidence gaps while omitting raw evidence prose', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Project safe experiment recovery evidence',task_type:'model_business_experiment',
    execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'safe-gap-flow'}});
  const safeSummary='The verified normal Workflow has no observed GET/HEAD read-back after its state-changing request.';
  await repo.createToolInvocation({scan_run_id:run.id,task_id:task.id,tool_name:'bstg.test_plan.inspect',status:'completed',
    input_json:{plan_id:'safe-gap-plan'},output_json:{plan_id:'safe-gap-plan',business_proof:{
      evidence_gaps:[{failure_code:'authoritative_readback_unavailable',summary:safeSummary}],
      missing_evidence:['PRIVATE_CAPTURE_VALUE_MUST_NOT_REACH_MODEL'],
    },missing_evidence:['PRIVATE_CAPTURE_VALUE_MUST_NOT_REACH_MODEL']}});
  const context=await buildAutonomousAgentContext({repo,scanRunId:run.id,task,tools:[]});
  const output=context.task_tool_invocations.find(item=>item.tool_name==='bstg.test_plan.inspect')?.output_json;
  assert.equal(output.business_proof.evidence_gaps[0].failure_code,'authoritative_readback_unavailable');
  assert.equal(output.business_proof.evidence_gaps[0].summary,safeSummary);
  assert.notEqual(output.missing_evidence[0],'PRIVATE_CAPTURE_VALUE_MUST_NOT_REACH_MODEL');
  assert.equal(JSON.stringify(context).includes('PRIVATE_CAPTURE_VALUE_MUST_NOT_REACH_MODEL'),false);
});

test('an assessed experiment with no authoritative read-back exposes only the evidence-linked block tool',()=>{
  const flowId='readback-flow',planId='readback-plan';
  const context={task:{id:'experiment-task',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:flowId}},
    business_flows:[{id:flowId,workflow_id:'native-workflow'}],
    task_artifacts:[
      {artifact_type:'agent_experiment_plan',task_id:'experiment-task',created_at:'2026-10-01T00:00:00Z',content_json:{id:planId,flow_id:flowId,revision:2,status:'compiled',steps:[{source_step_order:2}]}},
      {artifact_type:'agent_experiment_result',task_id:'experiment-task',created_at:'2026-10-01T00:00:01Z',content_json:{plan_id:planId,plan_revision:2,revision:1,status:'executed',business_proof:{evidence_gaps:[{failure_code:'authoritative_readback_unavailable'}]}}},
      {artifact_type:'agent_experiment_assessment',task_id:'experiment-task',created_at:'2026-10-01T00:00:02Z',content_json:{plan_id:planId,plan_revision:2,result_revision:1,verdict:'inconclusive'}},
    ],
    task_tool_invocations:[{status:'completed',tool_name:'bstg.workflow.inspect',output_json:{workflow_id:'native-workflow',steps:[
      {step_order:1,method:'GET'},{step_order:2,method:'POST'},
    ]}}],
  };
  const allowed=businessExperimentAllowedToolNames(context,{action:'model_decision_required'},['tool_call']);
  assert.deepEqual(allowed,['bstg.test_plan.block']);
});

// The provider deliberately confuses JSON dispatch with a missing function-call
// channel.  The runtime may refresh only the inventory; it must not invent a
// Flow, an identity, or coverage dispositions in order to get past the model.
test('normal-business planning rejects unsupported terminal proposals and feeds the executable protocol back to the model', async t => {
  const contexts=[];
  const provider=http.createServer(async (req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const wire=JSON.parse(raw);
      const system=wire.messages.find(message=>message.role==='system')?.content||'';
      const payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');
      contexts.push({system,context:payload.context,required_output:payload.required_output});
      const turn=contexts.length;
      const decision=turn===1
        ? {action:'block_task',reason:'The tools look informational rather than callable.'}
        : turn===2
          ? {action:'complete_task',summary:'No planning action is possible.'}
          : turn===3
            ? {action:'fail_task',reason:'No action channel is available.'}
            : turn===4
              ? {action:'tool_call',tool_name:'bstg.business.coverage.save',arguments:{entries:[]}}
              : {action:'complete_task',summary:'The model saved the empty fixture coverage inventory.'};
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({id:`planning-protocol-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
    } catch(error) {
      res.statusCode=500;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{message:String(error)}}));
    }
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));

  const db=await database();t.after(()=>db.disconnect());
  const repo=new AIScanRepository(db);
  // Provider IDs are UUIDs, so an opaque ID may begin with a digit. Keep this
  // regression numeric-leading to preserve real-model receipt provenance.
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    '0f59c6c9-2c1f-4d0f-a9e4-0b58cf95d4e1','Planning protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{
    surface:'web',driving_mode:'autopilot',authorization_acknowledged:true,
    agent_task_budgets:{plan_business_flows:5},
  }});
  const task=await repo.createTask({scan_run_id:run.id,title:'Plan normal product paths',task_type:'plan_business_flows',
    execution_plan:{intent:BUSINESS_PLAN_INTENT}});

  // Access is deliberate in this focused runtime regression: executeTask owns
  // the persisted planner receipt and the second enforcement layer.
  await new AIScanAgentRuntime(db).executeTask(task);
  const snapshot=await repo.getSnapshot(run.id);
  const decisions=snapshot.planner_decisions.filter(item=>item.task_id===task.id).sort((left,right)=>left.iteration-right.iteration);
  const calls=snapshot.tool_invocations.filter(item=>item.task_id===task.id);

  assert.equal(contexts.length,5);
  assert.match(contexts[0].system,/This response is the tool-dispatch protocol/);
  assert.match(contexts[0].system,/bstg\.business\.coverage\.inspect/);
  assert.match(contexts[0].required_output.tool_dispatch,/BSTG executes this response directly/);
  assert.deepEqual(contexts[0].context.model_scope.allowed_actions,['tool_call','complete_task']);
  assert.equal(Object.hasOwn(contexts[0].context,'execution_base_url'),false,
    'the server-only full navigation URL must never enter a provider payload');
  assert.ok(contexts[0].context.available_tools.some(tool=>tool.name==='bstg.business.coverage.inspect'));
  assert.ok(contexts[0].context.available_tools.some(tool=>tool.name==='bstg.business.flow.define'));
  assert.equal(contexts[1].context.planner_state.recent_rejections.at(-1)?.action,'block_task');
  assert.equal(contexts[1].context.planner_state.recent_rejections.at(-1)?.reason,'policy_rejected');

  assert.deepEqual(decisions.map(item=>item.validation_status),['rejected','rejected','rejected','accepted','accepted']);
  assert.deepEqual(decisions.filter(item=>item.validation_status==='rejected').map(item=>item.proposal_json.action),['block_task','complete_task','fail_task']);
  assert.ok(decisions.every(item=>item.decision_json.model==='fixture-model'&&item.decision_json.provider_id==='0f59c6c9-2c1f-4d0f-a9e4-0b58cf95d4e1'&&
    /^planning-protocol-[1-5]$/.test(item.decision_json.provider_response_id||'')),
    'rejected model proposals retain their bounded opaque upstream receipt ID without retaining a provider response body');
  const modelEvidence=verifyModelDecisions(buildPublicTechnicalSnapshot(snapshot),{id:'0f59c6c9-2c1f-4d0f-a9e4-0b58cf95d4e1',model:'fixture-model'});
  assert.equal(modelEvidence.decisions,2,
    'the public model-evidence view retains the two provider-owned decisions while local policy corrections stay classified as local');
  assert.equal('response_ids' in modelEvidence,false,
    'acceptance reports count provider-backed decisions but retain no per-response receipt identifiers');
  assert.equal(calls.filter(item=>item.tool_name==='bstg.business.coverage.inspect').length,3);
  assert.equal(calls.filter(item=>item.tool_name==='bstg.business.coverage.save').length,1);
  assert.equal(calls.some(item=>item.tool_name==='bstg.business.flow.define'),false,
    'recovery must not synthesize a business goal or identity when the model did not choose one');
});

test('repeated unchanged active-capture inspections terminate after three safe model corrections', async t => {
  const contexts=[];
  const privateActionMaterial={selector:'private-selector-must-not-persist',value:'private-fill-must-not-persist',url:'https://private.example/must-not-persist',dom:'private-dom-must-not-persist',digest:'private-digest-must-not-persist'};
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);
    contexts.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}').context);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`capture-loop-${contexts.length}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'active-loop-recording',...privateActionMaterial},
      rationale:'Inspect the unchanged active capture again.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'capture-loop-fixture','Capture-loop protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',driving_mode:'autopilot',authorization_acknowledged:true,
    agent_task_budgets:{learn_business_flow:80}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Bound an unchanged capture inspection',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Active capture loop',goal:'The normal action reaches a semantic result',role:'anonymous'},task.id);
  flow.recording_session_id='active-loop-recording';flow.recording_context_key=`task:${task.id}`;
  flow.recording_context_scope='task';flow.recording_identity_key='anonymous';
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  // Seed a normal active recording and one safe inspection. The fake scalar is
  // deliberately never read by the test; it verifies that the model/public
  // recovery receipts do not serialize transport material.
  await repo.createToolInvocation({scan_run_id:run.id,task_id:task.id,tool_name:'bstg.business.capture.start',status:'completed',
    output_json:{flow_id:flow.id,recording_session_id:flow.recording_session_id,capture_status:'recording'}});
  await repo.createToolInvocation({scan_run_id:run.id,task_id:task.id,tool_name:'browser.navigate',status:'completed',output_json:{}});
  await repo.createToolInvocation({scan_run_id:run.id,task_id:task.id,tool_name:'bstg.business.capture.inspect',status:'completed',
    output_json:{recording_session_id:flow.recording_session_id,status:'recording',event_count:1,
      events:[{event_id:'safe-event',semantic_body_path_available:false,response_body:'test-only-secret-must-not-escape'}]}});

  await new AIScanAgentRuntime(db).executeTask(await repo.getTask(task.id));
  const snapshot=await repo.getSnapshot(run.id);
  const savedTask=snapshot.tasks.find(item=>item.id===task.id);
  const decisions=snapshot.planner_decisions.filter(item=>item.task_id===task.id);
  const limit=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_capture_inspection_no_progress_limit');
  assert.equal(contexts.length,3,'the dedicated protocol limit must preempt the generic 80-decision budget');
  assert.equal(savedTask?.status,'failed');assert.equal(savedTask?.phase,'normal_capture_inspection_no_progress_limit');
  assert.equal(decisions.length,3);assert.ok(decisions.every(item=>item.validation_status==='rejected'&&
    item.proposal_json?.tool_name==='bstg.business.capture.inspect'&&
    item.policy_json?.rejection_code==='normal_capture_inspection_no_progress'));
  assert.equal(contexts[1].planner_state.normal_capture_inspection_recovery?.consecutive_attempts,1);
  assert.equal(contexts[2].planner_state.normal_capture_inspection_recovery?.consecutive_attempts,2);
  assert.equal(contexts[1].planner_state.normal_capture_inspection_recovery?.browser_state_progress_count,0,
    'an action without an observed post-action structure cannot manufacture a safe transition');
  assert.ok(decisions.every(item=>item.policy_json?.rejection_context?.browser_state_progress_count===0),
    'the actual planner-result persistence path retains the absence of observed structural progress');
  assert.deepEqual(Object.keys(contexts[2].planner_state.normal_capture_inspection_recovery||{}).sort(),[
    'browser_state_progress_count','capture_status','consecutive_attempts','event_count','limit','rejection_code','required_next_action_class','semantic_candidate_available',
  ]);
  assert.equal(limit?.content_json.attempts,3);assert.equal(limit?.content_json.limit,3);
  assert.equal(snapshot.tool_invocations.filter(item=>item.task_id===task.id).length,3,
    'the rejected proposals dispatch no extra inspection or automatic browser action');
  assert.equal(snapshot.artifacts.some(item=>item.artifact_type==='business_workflow_learning'||item.artifact_type==='business_workflow_validation'),false);
  const durableReceipts=[...decisions.map(item=>({proposal_json:item.proposal_json,decision_json:item.decision_json,policy_json:item.policy_json,decision_signature:item.decision_signature})),
    ...snapshot.artifacts.filter(item=>item.task_id===task.id&&item.artifact_type==='agent_decision').map(item=>item.content_json)];
  const receiptWire=JSON.stringify(durableReceipts);
  for (const value of Object.values(privateActionMaterial)) assert.equal(receiptWire.includes(value),false,
    'planner receipts retain audit metadata only, never rejected browser/model inputs');
  assert.ok(decisions.every(item=>item.proposal_json?.has_arguments===true&&!Object.hasOwn(item.proposal_json||{},'arguments')&&
    /^v1:[a-z_]+:(?:[a-z][a-z0-9_.-]*|none):(?:ai_provider|local_policy):rejected$/.test(item.decision_signature||'')),
    'the receipt signature is a value-free action/tool/status label, not an argument digest');
  assert.equal(JSON.stringify(contexts).includes('test-only-secret-must-not-escape'),false);
  assert.equal(JSON.stringify(buildPublicTechnicalSnapshot(snapshot)).includes('test-only-secret-must-not-escape'),false);
});

test('accepted flow definition persists only its strict opaque objective selection', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{plan_business_flows:4}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Persist safe flow selection',task_type:'plan_business_flows',
    execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const objectiveId='objective:0123456789abcdef01234567';
  const privateArguments={selector:'private-selector-must-not-persist',value:'private-value-must-not-persist',url:'https://private.example/must-not-persist',dom:'private-dom-must-not-persist',digest:'private-digest-must-not-persist'};
  const runtime=new AIScanAgentRuntime(db);let calls=0;
  runtime.planner.decide=async()=>{
    calls+=1;
    return calls===1
      ? {action:'tool_call',tool_name:'bstg.business.flow.define',arguments:{objective_id:objectiveId,name:'Private flow title',goal:'Private flow goal',role:'anonymous',...privateArguments},source:'ai_provider',validation_status:'accepted',provider_id:'fixture-provider',provider_response_id:'private provider response body must not persist',model:'fixture-model'}
      : {action:'complete_task',summary:'Private completion summary',source:'ai_provider',validation_status:'accepted',provider_id:'fixture-provider',model:'fixture-model'};
  };
  await runtime.executeTask(task);
  const snapshot=await repo.getSnapshot(run.id);
  const decision=snapshot.planner_decisions.find(item=>item.task_id===task.id&&item.decision_json?.tool_name==='bstg.business.flow.define');
  const artifact=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='agent_decision'&&item.content_json?.tool_name==='bstg.business.flow.define');
  assert.deepEqual(decision?.decision_json?.public_selection,{objective_id:objectiveId});
  assert.deepEqual(artifact?.content_json?.public_selection,{objective_id:objectiveId});
  const receipts=JSON.stringify({decision,artifact});
  for (const value of Object.values(privateArguments)) assert.equal(receipts.includes(value),false);
  assert.equal(receipts.includes('Private flow title'),false);
  assert.equal(receipts.includes('Private flow goal'),false);
  assert.equal(receipts.includes('private provider response body must not persist'),false);
  assert.equal(Object.hasOwn(decision?.decision_json||{},'arguments'),false);
});

test('final-outcome recovery gives the provider a browser-action turn, refreshes once after it, and never selects the completion', async t => {
  const payloads=[];let turn=0;
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);payloads.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}'));
    turn+=1;
    const decision={action:'tool_call',tool_name:'bstg.business.capture.stop',arguments:{recording_session_id:'final-outcome-recording'},
      rationale:'Attempt to seal the normal final outcome.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`final-outcome-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'final-outcome-recovery','Final outcome recovery fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='final-outcome-flow',recordingId='final-outcome-recording';
  const context={
    scan:{id:'final-outcome-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'final-outcome-task',scan_run_id:'final-outcome-run',task_type:'learn_business_flow',title:'Reach the final order outcome',
      phase:'normal_capture_objective_completion_required',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:12,used:0,remaining:12}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'},{name:'bstg.business.workflow.prepare'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:4,
        objective_completion:{completion_candidate_event_ids:[]},events:[{event_id:'opaque-noncompletion-event',semantic_body_path_available:true,action_id:'fixture-action'}]}},
    ],
    business_flows:[{id:flowId,name:'Final order',goal:'Order is accepted',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:final-outcome-task',recording_context_scope:'task',recording_identity_key:'anonymous',
      objective_completion:{required_response_paths:['body.order_id']}}],
    model_scope:{stage:'normal_business_learning',purpose:'Reach the final order outcome',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop','bstg.business.workflow.prepare'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const premature=await planner.decide(context);
  assert.equal(premature.source,'local_policy');assert.equal(premature.action,'model_decision_required');
  assert.equal(premature.proposal?.tool_name,'bstg.business.capture.stop');
  assert.equal(premature.rejection_code,'normal_capture_inspection_no_progress');
  assert.match(premature.rationale||'',/browser navigation or interaction/i);
  assert.equal(payloads[0].deterministic_next_step.action,'model_decision_required',
    'the provider receives an explicit browser-action decision instead of an automatic stop/prepare path');
  assert.equal(JSON.stringify(premature.rejection_context).includes('opaque-noncompletion-event'),false,
    'recovery feedback contains completion structure, never an event choice');
  assert.deepEqual(premature.rejection_context?.objective_completion_required_response_paths,['body.order_id']);
  assert.equal(premature.rejection_context?.objective_completion_candidate_count,0);

  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',selector:'#provider-selected-final'}},output_json:{}});
  const refresh=await planner.decide(context);
  assert.equal(refresh.source,'local_policy');assert.equal(refresh.tool_name,'bstg.business.capture.inspect');
  assert.equal(refresh.proposal?.tool_name,'bstg.business.capture.stop',
    'after the model action, the one refresh is server-owned evidence reading only');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:5,
    objective_completion:{completion_candidate_event_ids:['opaque-final-event']},events:[{event_id:'opaque-final-event',semantic_body_path_available:true,action_id:'fixture-action'}]}});
  const finalDecision=await planner.decide(context);
  assert.equal(finalDecision.source,'ai_provider');assert.equal(finalDecision.tool_name,'bstg.business.capture.stop');
  assert.equal(finalDecision.validation_status,'accepted',
    'only after model action and fresh inventory can the provider decide whether to stop');
  assert.equal(turn,3);
});

test('a current strict operation candidate seals the capture before a second model-selected write can dispatch', async t => {
  let turns=0;
  const provider=http.createServer((_,res)=>{
    turns+=1;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`strict-seal-${turns}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'browser.interact',
      arguments:{operation:{action:'click',selector:'#provider-would-repeat-write'}},
      rationale:'Repeat the write.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'strict-seal-fixture','Strict capture seal fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='strict-seal-flow',recordingId='strict-seal-recording',operationId='operation:0123456789abcdef01234567';
  const context={
    scan:{id:'strict-seal-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'strict-seal-task',scan_run_id:'strict-seal-run',task_type:'learn_business_flow',title:'Seal a captured strict effect',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:12,used:0,remaining:12}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
      {tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',selector:'#provider-selected-write'}},output_json:{}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:4,
        objective_operation:{operation_id:operationId,side_effect_class:'create',operation_candidate_event_ids:['opaque-operation-event']},
        events:[{event_id:'opaque-operation-event',semantic_body_path_available:true,action_id:'fixture-action'}]}},
    ],
    business_flows:[{id:flowId,name:'Create one item',goal:'The item is created once',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:strict-seal-task',recording_context_scope:'task',recording_identity_key:'anonymous',
      objective_operation:{operation_id:operationId,side_effect_class:'create'}}],
    model_scope:{stage:'normal_business_learning',purpose:'Seal a captured strict effect',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const decision=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(turns,1,'the model still receives the safe current inventory before the lifecycle correction');
  assert.equal(decision.source,'local_policy');
  assert.equal(decision.validation_status,'rejected');
  assert.equal(decision.tool_name,'bstg.business.capture.stop');
  assert.deepEqual(decision.arguments,{recording_session_id:recordingId});
  assert.equal(decision.proposal?.tool_name,'browser.interact');
  assert.match(decision.rejection_reason||'',/sealed before additional browser activity/i);
  assert.equal(JSON.stringify(decision.rejection_context||{}).includes('opaque-operation-event'),false,
    'the lifecycle seal does not turn an observed event into a local selection');
});

test('repeated final-outcome premature stops retain the bounded safe terminal guard', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{learn_business_flow:12}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Bound final-outcome capture recovery',task_type:'learn_business_flow',
    phase:'normal_capture_objective_completion_required',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'final-outcome-limit-flow'}});
  const runtime=new AIScanAgentRuntime(db);let calls=0;
  runtime.planner.decide=async()=>{
    calls+=1;
    return {action:'model_decision_required',source:'local_policy',validation_status:'rejected',proposal:{action:'tool_call',tool_name:'bstg.business.capture.stop'},
      rejection_code:'normal_capture_inspection_no_progress',rejection_reason:'Final outcome requires model browser progress.',
      rejection_context:{recording_session_id:'final-outcome-limit-recording',capture_status:'recording',event_count:4,
        semantic_candidate_available:true,material_progress_count:1,browser_state_progress_count:1,required_next_action_class:'model_selected_browser_action',
        objective_completion_required_response_paths:['body.order_id'],objective_completion_candidate_count:0}};
  };
  await runtime.executeTask(task);
  const snapshot=await repo.getSnapshot(run.id);const saved=await repo.getTask(task.id);
  const decisions=snapshot.planner_decisions.filter(item=>item.task_id===task.id);
  assert.equal(calls,3);assert.equal(saved?.status,'failed');assert.equal(saved?.phase,'normal_capture_inspection_no_progress_limit');
  assert.equal(decisions.length,3);assert.ok(decisions.every(item=>item.policy_json?.rejection_code==='normal_capture_inspection_no_progress'));
  assert.equal(snapshot.tool_invocations.filter(item=>item.task_id===task.id).length,0,
    'the bounded guard rejects repeated premature stop proposals without dispatching a tool or selecting evidence');
  const limit=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_capture_inspection_no_progress_limit');
  assert.equal(limit?.content_json.attempts,3);assert.equal(limit?.content_json.limit,3);
});

test('persisted strict operation-candidate corrections reach the same three-attempt evidence limit after a runtime refresh', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{learn_business_flow:12}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Bound strict operation candidate recovery',task_type:'learn_business_flow',
    phase:'normal_capture_objective_completion_required',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'operation-selection-limit-flow'}});
  const missingOperation={status:'objective_operation_candidate_required',retryable:true,candidate_event_count:0,capture_remains_active:true};
  for (let attempt=0;attempt<2;attempt+=1) await repo.createToolInvocation({scan_run_id:run.id,task_id:task.id,
    tool_name:'bstg.business.capture.stop',status:'failed',output_json:missingOperation});

  // This is a fresh runtime: the third correction must be derived from the
  // two safe persisted invocation projections above, not process-local state.
  const runtime=new AIScanAgentRuntime(db);let plannerCalls=0;
  runtime.planner.decide=async()=>{
    plannerCalls+=1;
    return {action:'tool_call',tool_name:'bstg.business.capture.stop',arguments:{recording_session_id:'operation-selection-limit-recording'},
      source:'ai_provider',validation_status:'accepted'};
  };
  runtime.registry.call=async(name,input,context)=>{
    await context.repo.createToolInvocation({scan_run_id:context.scanRunId,task_id:context.taskId,tool_name:name,
      input_json:{recording_session_id:input.recording_session_id},output_json:missingOperation,status:'failed'});
    return {ok:false,error:'Strict operation evidence is still missing.',summary:'Operation candidate required.',data:missingOperation};
  };

  await runtime.executeTask(await repo.getTask(task.id));
  const snapshot=await repo.getSnapshot(run.id);const saved=await repo.getTask(task.id);
  const limit=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_semantic_selection_limit');
  assert.equal(plannerCalls,1,'the refreshed runtime must terminalize on the persisted third correction');
  assert.equal(saved?.status,'failed');assert.equal(saved?.phase,'normal_semantic_selection_limit');
  assert.equal(limit?.content_json.attempts,3);assert.equal(limit?.content_json.candidate_event_count,0);
  assert.equal(JSON.stringify(limit?.content_json).includes('operation-selection-limit-recording'),false,
    'the durable limit artifact retains counts and safe flow metadata, never recording inputs');
});

test('runtime persistence resets a capture-inspection episode only after safe browser-state progress, not background event growth', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{learn_business_flow:8}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Reset only after persisted browser-state progress',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'state-reset-flow'}});
  const runtime=new AIScanAgentRuntime(db);const stateProgress=[0,1,1,1];const eventCounts=[2,3,4,5];const eligibleCounts=[1,2,3,4];let calls=0;
  runtime.planner.decide=async()=>{
    const browser_state_progress_count=stateProgress[calls] ?? 1;
    const eligible_count=eligibleCounts[calls] ?? 4;
    const event_count=eventCounts[calls++] ?? 5;
    return {action:'model_decision_required',source:'local_policy',validation_status:'rejected',proposal:{action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{selector:'private-selector-must-not-persist'}},
      rejection_code:'normal_capture_inspection_no_progress',rejection_reason:'Private model prose must not persist.',
      rejection_context:{recording_session_id:'state-reset-recording',capture_status:'recording',event_count,semantic_candidate_available:false,
        material_progress_count:99,browser_state_progress_count,required_next_action_class:'model_selected_browser_action',
        objective_required_control_intents:['confirm'],objective_eligible_current_control_counts:{confirm:eligible_count},
        objective_completion_candidate_count:0,objective_operation_candidate_count:0,coverage_retry_candidate_count:0,coverage_retry_all_candidates:false}};
  };
  await runtime.executeTask(task);
  const snapshot=await repo.getSnapshot(run.id);
  const decisions=snapshot.planner_decisions.filter(item=>item.task_id===task.id);
  assert.equal(calls,4,'three matching persisted browser-state episodes reach the limit after the one safe state transition resets it');
  assert.deepEqual(decisions.map(item=>item.policy_json?.rejection_context?.browser_state_progress_count),[0,1,1,1]);
  const rebuilt=await buildAutonomousAgentContext({repo,scanRunId:run.id,task:await repo.getTask(task.id),tools:[]});
  assert.equal(rebuilt.planner_state.normal_capture_inspection_recovery?.browser_state_progress_count,1);
  assert.equal(rebuilt.planner_state.normal_capture_inspection_recovery?.consecutive_attempts,3);
  assert.equal(rebuilt.planner_state.normal_capture_inspection_recovery?.event_count,5,
    'the latest event count remains visible without breaking the cross-receipt no-progress episode');
  assert.deepEqual(decisions.map(item=>item.policy_json?.rejection_context?.objective_eligible_current_control_counts),[
    {confirm:1},{confirm:2},{confirm:3},{confirm:4}
  ],'runtime persistence keeps only bounded finite candidate counts');
  assert.deepEqual(rebuilt.planner_state.normal_capture_inspection_recovery?.objective_eligible_current_control_counts,{confirm:4});
  const receipts=JSON.stringify([...decisions.map(item=>item.policy_json),...snapshot.artifacts.filter(item=>item.artifact_type==='agent_decision').map(item=>item.content_json)]);
  assert.equal(receipts.includes('private-selector-must-not-persist'),false);
  assert.equal(receipts.includes('Private model prose must not persist.'),false);
});

test('operation-missing strict capture never lets local policy drain to stop and returns browser choice to the provider', async t => {
  const payloads=[];let turn=0;
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);payloads.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}'));
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'operation-missing-recording'}}
      : {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',selector:'#second-provider-selected-effect'}}};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`operation-missing-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'operation-missing-recovery','Operation missing recovery fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='operation-missing-flow',recordingId='operation-missing-recording',operationId='operation:0123456789abcdef01234567';
  const context={
    scan:{id:'operation-missing-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'operation-missing-task',scan_run_id:'operation-missing-run',task_type:'learn_business_flow',title:'Reach required state-changing effect',
      phase:'normal_capture_objective_completion_required',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:12,used:0,remaining:12}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:4,
        objective_operation:{operation_id:operationId,side_effect_class:'transaction',operation_candidate_event_ids:[]},events:[{event_id:'ordinary-semantic-event',semantic_body_path_available:true,action_id:'fixture-action'}]}},
    ],
    business_flows:[{id:flowId,name:'Create required effect',goal:'Operation is completed',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:operation-missing-task',recording_context_scope:'task',recording_identity_key:'anonymous',
      objective_operation:{operation_id:operationId,side_effect_class:'transaction'}}],
    model_scope:{stage:'normal_business_learning',purpose:'Reach required state-changing effect',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const first=await planner.decide(context);
  assert.equal(first.source,'local_policy');assert.equal(first.action,'model_decision_required');assert.notEqual(first.tool_name,'bstg.business.capture.stop');
  assert.equal(first.proposal?.tool_name,'bstg.business.capture.inspect');
  assert.equal(first.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(payloads[0].deterministic_next_step.action,'model_decision_required');
  assert.equal(payloads[0].deterministic_next_step.tool_name,undefined);
  assert.equal(JSON.stringify(payloads[0]).includes('/private-operation-route'),false);

  const browserAction=await planner.decide(context);
  assert.equal(browserAction.source,'ai_provider');assert.equal(browserAction.tool_name,'browser.interact',
    'the provider, rather than local policy, chooses the new UI action');
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',selector:'#provider-selected-effect'}},output_json:{}});
  const oneRefresh=await planner.decide(context);
  assert.equal(oneRefresh.source,'local_policy');assert.equal(oneRefresh.tool_name,'bstg.business.capture.inspect');
  assert.equal(oneRefresh.proposal?.tool_name,'browser.interact',
    'a second provider-selected write is held behind one read-only capture refresh');
  assert.notEqual(oneRefresh.tool_name,'bstg.business.capture.stop');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:5,
    objective_operation:{operation_id:operationId,side_effect_class:'transaction',operation_candidate_event_ids:[]},events:[{event_id:'ordinary-semantic-event',semantic_body_path_available:true,action_id:'fixture-action'}]}});
  const next=localPolicy(context);
  assert.equal(next.action,'model_decision_required');assert.notEqual(next.tool_name,'bstg.business.capture.stop',
    'after the one refresh with no operation candidate, local policy returns browser-action ownership instead of draining capture');
  assert.equal(turn,3);
});

test('capture-inspection recovery keeps one unchanged evidence episode across material browser progress', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Aggregate safe inspection recovery',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const recovery=(material_progress_count,browser_state_progress_count=0,eligible_count=1)=>({recording_session_id:'recovery-recording',capture_status:'recording',event_count:2,
    semantic_candidate_available:false,material_progress_count,browser_state_progress_count,required_next_action_class:'model_selected_browser_action',
    objective_required_control_intents:['confirm'],objective_eligible_current_control_counts:{confirm:eligible_count}});
  for (const [iteration,progress,eligibleCount] of [[1,0,1],[2,0,2],[3,1,3]]) {
    await repo.createPlannerDecision({scan_run_id:run.id,task_id:task.id,iteration,source:'local_policy',validation_status:'rejected',
      proposal_json:{action:'tool_call',tool_name:'bstg.business.capture.inspect'},decision_json:{action:'model_decision_required'},
      policy_json:{rejection_code:'normal_capture_inspection_no_progress',rejection_context:recovery(progress,0,eligibleCount)},
      rejection_reason:'Value-free capture inspection protocol correction'});
  }
  const context=await buildAutonomousAgentContext({repo,scanRunId:run.id,task,tools:[]});
  assert.deepEqual(context.planner_state.normal_capture_inspection_recovery,{
    rejection_code:'normal_capture_inspection_no_progress',consecutive_attempts:3,limit:3,capture_status:'recording',event_count:2,
    semantic_candidate_available:false,browser_state_progress_count:0,required_next_action_class:'model_selected_browser_action',
    objective_required_control_intents:['confirm'],objective_eligible_current_control_counts:{confirm:3},
  });
  assert.equal(context.planner_state.normal_capture_inspection_recovery?.consecutive_attempts,3,
    'a changing candidate count is diagnostic-only and cannot replenish the bounded recovery allowance');
  assert.equal(JSON.stringify(context.planner_state.normal_capture_inspection_recovery).includes('recovery-recording'),false,
    'the provider-facing aggregate must not need to expose even an opaque recording reference');
});

test('capture-inspection recovery projects only bounded closed current-control counts', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Project finite transaction candidate counts',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  await repo.createPlannerDecision({scan_run_id:run.id,task_id:task.id,iteration:1,source:'local_policy',validation_status:'rejected',
    proposal_json:{action:'tool_call',tool_name:'browser.interact'},decision_json:{action:'model_decision_required'},
    policy_json:{rejection_code:'normal_capture_inspection_no_progress',rejection_context:{
      recording_session_id:'opaque-recovery-recording',capture_status:'recording',event_count:2,semantic_candidate_available:false,
      material_progress_count:1,browser_state_progress_count:0,required_next_action_class:'model_selected_transaction_prerequisite',
      objective_required_control_intents:['confirm','untrusted-private-intent'],
      objective_eligible_current_control_counts:{confirm:2,'untrusted-private-intent':99,add:-1,review:101},
      transaction_prerequisite_proposal_class:'unknown_control_ref',
      transaction_prerequisite_proposal_detail:'private-rejected-proposal-detail',
    }},rejection_reason:'Finite candidate-count projection'});
  const context=await buildAutonomousAgentContext({repo,scanRunId:run.id,task,tools:[]});
  assert.deepEqual(context.planner_state.normal_capture_inspection_recovery?.objective_required_control_intents,['confirm']);
  assert.deepEqual(context.planner_state.normal_capture_inspection_recovery?.objective_eligible_current_control_counts,{confirm:2});
  assert.equal(context.planner_state.normal_capture_inspection_recovery?.transaction_prerequisite_proposal_class,'unknown_control_ref');
  const wire=JSON.stringify(context.planner_state.normal_capture_inspection_recovery);
  for(const privateValue of ['opaque-recovery-recording','untrusted-private-intent','private-rejected-proposal-detail'])assert.equal(wire.includes(privateValue),false,
    'recovery counts remain a finite value-free protocol projection');
});

test('unchanged action-refresh evidence requires a bounded model retry without exposing action state', async t => {
  const db=await database();t.after(()=>db.disconnect());let turn=0;
  const provider=http.createServer((_,res)=>{
    turn+=1;res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`active-refresh-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',selector:'#fixture-control'}},
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'active-refresh-fixture','Active refresh fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='active-refresh-flow',recordingId='active-refresh-recording';
  const inspection=(created_at)=>({tool_name:'bstg.business.capture.inspect',status:'completed',created_at,output_json:{
    recording_session_id:recordingId,status:'recording',event_count:2,events:[{event_id:'opaque-event',semantic_body_path_available:false}],
  }});
  const action={tool_name:'browser.interact',status:'completed',created_at:'2026-10-01T00:00:03.000Z',input_json:{operation:{action:'click',selector:'#fixture-control'}},
    output_json:{observation:{controls:[{tag:'button',id:'fixture-control',disabled:false,in_dialog:false,receives_pointer:true}]}}};
  const context={
    scan:{id:'active-refresh-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'active-refresh-task',scan_run_id:'active-refresh-run',task_type:'learn_business_flow',title:'Refresh unchanged safe evidence',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:12,used:0,remaining:12}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',created_at:'2026-10-01T00:00:01.000Z',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',created_at:'2026-10-01T00:00:01.500Z',output_json:{}},
      inspection('2026-10-01T00:00:02.000Z'),
    ],
    business_flows:[{id:flowId,name:'Refresh active capture',goal:'Observe semantic normal evidence',role:'anonymous',status:'learning',recording_session_id:recordingId,recording_context_key:'task:active-refresh-task',recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Refresh active capture',authorization:'acknowledged',allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
    lifecycle_planner_decisions:[],
  };
  const planner=new AutonomousAgentPlanner(db);
  assert.equal((await planner.decide(context)).source,'ai_provider','the first UI action remains model-owned');
  context.task_tool_invocations.push(action);
  const forcedRefresh=await planner.decide(context);
  assert.equal(forcedRefresh.tool_name,'bstg.business.capture.inspect');
  assert.equal(forcedRefresh.rejection_code,undefined,'the action-to-refresh boundary itself is a read-only local step');
  context.task_tool_invocations.push(inspection('2026-10-01T00:00:04.000Z'));
  const recovery=await planner.decide(context);
  assert.equal(recovery.action,'model_decision_required');assert.equal(recovery.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(JSON.stringify(recovery.rejection_context).includes('fixture-control'),false,'recovery persists no selector/action-state material');
  context.lifecycle_planner_decisions.push({validation_status:'rejected',created_at:'2026-10-01T00:00:05.000Z',policy_json:{rejection_code:'normal_capture_inspection_no_progress'}});
  const retry=await planner.decide(context);
  assert.equal(retry.source,'ai_provider','one recovery receipt releases the next model-selected retry');
});

test('active normal capture bounds pre-inspection, passive, and background-event browser loops', async t => {
  let turn=0;
  const provider=http.createServer((_req,res)=>{
    turn+=1;
    const decisions=[
      {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',selector:'#first-model-choice'}}},
      {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}}},
      {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'scroll'}}},
      {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'loop-recording'}},
      {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',selector:'#second-model-choice'}}},
    ];
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`loop-guard-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decisions[turn-1])}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'loop-guard-fixture','Loop guard fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='loop-flow',recordingId='loop-recording';
  const inspection=(eventCount,created_at)=>({tool_name:'bstg.business.capture.inspect',status:'completed',created_at,output_json:{
    recording_session_id:recordingId,status:'recording',event_count:eventCount,
    events:[{event_id:'opaque-background-event',semantic_body_path_available:false}],
  }});
  const context={
    scan:{id:'loop-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'loop-task',scan_run_id:'loop-run',task_type:'learn_business_flow',title:'Bound active capture loops',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:16,used:0,remaining:16}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],lifecycle_planner_decisions:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',created_at:'2026-10-01T00:00:01.000Z',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',created_at:'2026-10-01T00:00:02.000Z',output_json:{}},
    ],
    business_flows:[{id:flowId,name:'Bound loop flow',goal:'A normal result is observed',role:'anonymous',status:'learning',recording_session_id:recordingId,recording_context_key:'task:loop-task',recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Bound active capture loops',authorization:'acknowledged',allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const initial=await planner.decide(context);
  assert.equal(initial.source,'local_policy');assert.equal(initial.tool_name,'bstg.business.capture.inspect');
  assert.equal(initial.proposal?.tool_name,'browser.interact','a second UI action cannot dispatch before the first safe inventory');
  context.task_tool_invocations.push(inspection(1,'2026-10-01T00:00:03.000Z'));
  const passive=await planner.decide(context);
  assert.equal(passive.source,'ai_provider');assert.equal(passive.tool_name,'browser.interact');
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',created_at:'2026-10-01T00:00:04.000Z',input_json:{operation:{action:'observe'}},output_json:{}});
  const repeatedPassive=await planner.decide(context);
  assert.equal(repeatedPassive.source,'local_policy');assert.equal(repeatedPassive.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(repeatedPassive.proposal?.arguments?.operation?.action,'scroll');
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',created_at:'2026-10-01T00:00:05.000Z',input_json:{operation:{action:'click',selector:'#first-model-choice'}},output_json:{}});
  const inspected=await planner.decide(context);
  assert.equal(inspected.source,'ai_provider');assert.equal(inspected.tool_name,'bstg.business.capture.inspect');
  context.task_tool_invocations.push(inspection(2,'2026-10-01T00:00:06.000Z'));
  const backgroundOnly=await planner.decide(context);
  assert.equal(backgroundOnly.source,'local_policy');assert.equal(backgroundOnly.rejection_code,'normal_capture_inspection_no_progress',
    'background-only event_count growth does not reset a strict capture-evidence episode');
  assert.equal(JSON.stringify(backgroundOnly.rejection_context).includes('first-model-choice'),false);
});

test('safe browser-state progress starts a new no-progress episode without persisting action details', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Keep multi-field browser progress distinct',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const recovery=(iteration,browser_state_progress_count)=>({recording_session_id:'multifield-recording',capture_status:'recording',event_count:2,
    semantic_candidate_available:false,material_progress_count:iteration,browser_state_progress_count,required_next_action_class:'model_selected_browser_action'});
  for (const [iteration,stateProgress] of [[1,0],[2,1]]) {
    await repo.createPlannerDecision({scan_run_id:run.id,task_id:task.id,iteration,source:'local_policy',validation_status:'rejected',
      proposal_json:{action:'tool_call',tool_name:'browser.interact'},decision_json:{action:'model_decision_required'},
      policy_json:{rejection_code:'normal_capture_inspection_no_progress',rejection_context:recovery(iteration,stateProgress)},
      rejection_reason:'Value-free active capture evidence recovery'});
  }
  const context=await buildAutonomousAgentContext({repo,scanRunId:run.id,task,tools:[]});
  assert.equal(context.planner_state.normal_capture_inspection_recovery?.consecutive_attempts,1,
    'a distinct local browser-state transition starts a fresh recovery episode for a multi-step form');
  const wire=JSON.stringify(context.planner_state.normal_capture_inspection_recovery);
  assert.equal(wire.includes('multifield-recording'),false);
  assert.equal(/selector|value|url|dom|digest/i.test(wire),false,
    'the persisted/provider-facing recovery state carries only numeric safe progress, never action-state material');
});

test('normal-business planning revises a rejected coverage reference instead of failing the model-owned planning task', async t => {
  const contexts=[];
  let targetId='',flowId='';
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);const payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');
    contexts.push(payload.context);
    const turn=contexts.length;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.coverage.save',arguments:{entries:[{target_type:'operation',target_id:'stale-model-copy',disposition:'planned',flow_id:flowId}]}}
      : turn===2
        ? {action:'tool_call',tool_name:'bstg.business.coverage.inspect',arguments:{}}
        : turn===3
          ? {action:'tool_call',tool_name:'bstg.business.coverage.save',arguments:{entries:[{target_type:'operation',target_id:targetId,disposition:'planned',flow_id:flowId}]}}
          : {action:'complete_task',summary:'The corrected current coverage inventory was saved.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`planning-revision-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));

  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'planning-revision-fixture','Planning revision fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',driving_mode:'autopilot',authorization_acknowledged:true,
    agent_task_budgets:{plan_business_flows:4}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Revise normal coverage',task_type:'plan_business_flows',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const endpoint=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/current-inventory'});targetId=endpoint.id;
  const flow=newBusinessFlow({name:'Current normal operation',goal:'The observed normal operation completes',role:'anonymous'},task.id);flowId=flow.id;
  await saveBusinessFlow(repo,run.id,task.id,flow);

  await new AIScanAgentRuntime(db).executeTask(task);
  const snapshot=await repo.getSnapshot(run.id);
  const calls=snapshot.tool_invocations.filter(item=>item.task_id===task.id);
  const savedTask=snapshot.tasks.find(item=>item.id===task.id);
  assert.equal(contexts.length,4);
  assert.equal(calls[0].tool_name,'bstg.business.coverage.save');assert.equal(calls[0].status,'failed');
  assert.equal(contexts[1].task.phase,'normal_business_planning_requires_adaptation');
  assert.ok(contexts[1].task_tool_invocations.some(item=>item.tool_name==='bstg.business.coverage.save'&&item.status==='failed'),
    'the next model turn receives its value-free failed coverage feedback');
  assert.equal(calls.filter(item=>item.tool_name==='bstg.business.coverage.inspect'&&item.status==='completed').length,1);
  assert.equal(calls.filter(item=>item.tool_name==='bstg.business.coverage.save'&&item.status==='completed').length,1);
  assert.equal(savedTask?.status,'completed');
  assert.equal(snapshot.artifacts.filter(item=>item.artifact_type==='business_flow_coverage').length,1);
});

test('a coverage-retry child starts a fresh capture before prior parent evidence can drive browser navigation', async t => {
  const provider=http.createServer(async (_req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'coverage-retry-protocol',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'complete_task',summary:'The prior normal run was already verified.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'coverage-retry-protocol','Coverage retry protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='retry-flow',parentId='retry-parent';
  const context={
    scan:{id:'retry-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'retry-child',scan_run_id:'retry-run',task_type:'learn_business_flow',title:'Coverage retry',execution_plan:{intent:'learn_business_flow',flow_id:flowId,
      coverage_retry:{origin_task_id:parentId,attempt:1,targets:[{key:'operation:current',target_type:'operation',target_id:'current'}]}},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.capture.start'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},
    task_artifacts:[],task_tool_invocations:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Prior normal flow',goal:'Verify current target',role:'attacker',status:'verified',assertions_verified:true,
      recording_session_id:'parent-recording',recording_context_key:`task:${parentId}`,recording_context_scope:'task',recording_identity_key:'attacker',workflow_id:'parent-workflow',normal_run_id:'parent-run'}],
    model_scope:{stage:'normal_business_learning',purpose:'Execute normal flow',authorization:'acknowledged',allowed_tool_names:['bstg.business.capture.start'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const decision=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(decision.source,'local_policy');assert.equal(decision.validation_status,'rejected');
  assert.equal(decision.tool_name,'bstg.business.capture.start');
  assert.deepEqual(decision.arguments,{flow_id:flowId,identity_key:'attacker'});
  assert.match(decision.rejection_reason||'',/fresh task-bound capture/i);
});

test('normal workflow preparation is a model-selected stopped-capture sequence, never an all-events fallback', async t => {
  const payloads=[];let turn=0;
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);const payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');payloads.push(payload);
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.workflow.prepare',arguments:{recording_session_id:'stopped-recording'},rationale:'Compile the recording.'}
      : {action:'tool_call',tool_name:'bstg.business.workflow.prepare',arguments:{recording_session_id:'stopped-recording',event_ids:['event-1','event-2']},rationale:'The inspected ordered events are the minimal normal transaction.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`normal-prepare-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'normal-prepare-protocol','Normal prepare protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='flow-current';
  const context={
    scan:{id:'normal-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'normal-task',scan_run_id:'normal-run',task_type:'learn_business_flow',title:'Compile an observed normal flow',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.capture.inspect'},{name:'bstg.business.workflow.prepare'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},
    task_artifacts:[],task_tool_invocations:[{tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:'stopped-recording',status:'stopped'}}],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Observed order',goal:'The normal order completes',role:'anonymous',status:'learning',recording_session_id:'stopped-recording'}],
    model_scope:{stage:'normal_business_learning',purpose:'Compile and verify the current normal flow',authorization:'acknowledged',
      allowed_tool_names:['bstg.business.capture.inspect','bstg.business.workflow.prepare'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const beforeInspection=await planner.decide(context);
  assert.equal(beforeInspection.source,'local_policy');assert.equal(beforeInspection.validation_status,'rejected');
  assert.equal(beforeInspection.tool_name,'bstg.business.capture.inspect');
  assert.match(beforeInspection.rejection_reason||'',/requires a completed inspection/i);
  assert.equal(beforeInspection.proposal?.tool_name,'bstg.business.workflow.prepare');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:'stopped-recording',status:'stopped',events:[{event_id:'event-1',sequence:1},{event_id:'event-2',sequence:2}]}});
  const selected=await planner.decide(context);
  assert.equal(selected.source,'ai_provider');assert.equal(selected.validation_status,'accepted');
  assert.equal(selected.tool_name,'bstg.business.workflow.prepare');assert.deepEqual(selected.arguments.event_ids,['event-1','event-2']);
  assert.equal(payloads[1].deterministic_next_step.action,'model_decision_required');
  assert.match(payloads[1].required_output.normal_flow_compilation,/event_ids/i);
});

test('a repeated stopped-capture inspection is rejected until the model chooses its own workflow event subset', async t => {
  const payloads=[];let turn=0;
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw),payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');payloads.push(payload);
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'sealed-recording'},rationale:'Inspect the same stopped capture again.'}
      : {action:'tool_call',tool_name:'bstg.business.workflow.prepare',arguments:{recording_session_id:'sealed-recording',event_ids:['event-1','event-2']},rationale:'Compile the model-selected normal transaction.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`stopped-inspection-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'stopped-inspection-protocol','Stopped inspection protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='sealed-flow',recordingId='sealed-recording';
  const context={
    scan:{id:'sealed-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'sealed-task',scan_run_id:'sealed-run',task_type:'learn_business_flow',title:'Compile a sealed normal capture',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.capture.inspect'},{name:'bstg.business.workflow.prepare'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},
    task_artifacts:[],task_tool_invocations:[
      {tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped'}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped',events:[{event_id:'event-1',sequence:1},{event_id:'event-2',sequence:2}]}},
      {tool_name:'agent.memory.query',status:'completed',output_json:{summary:'No additional capture evidence.'}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Sealed normal flow',goal:'The observed normal operation completes',role:'anonymous',status:'learning',recording_session_id:recordingId}],
    model_scope:{stage:'normal_business_learning',purpose:'Compile the sealed normal flow',authorization:'acknowledged',
      allowed_tool_names:['bstg.business.capture.inspect','bstg.business.workflow.prepare'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const rejected=await planner.decide(context);
  assert.equal(rejected.source,'local_policy');assert.equal(rejected.validation_status,'rejected');
  assert.equal(rejected.action,'model_decision_required');assert.equal(rejected.tool_name,undefined);
  assert.equal(rejected.proposal?.tool_name,'bstg.business.capture.inspect');
  assert.equal(rejected.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(rejected.rejection_context?.capture_status,'stopped');
  assert.match(rejected.rejection_reason||'',/Repeated stopped-capture inspection/i);
  assert.match(rejected.rationale||'',/workflow\.prepare.*event_ids/i);
  assert.equal(context.task_tool_invocations.filter(item=>item.tool_name==='bstg.business.capture.inspect').length,1,
    'the rejected proposal causes no second capture inspection dispatch');
  const selected=await planner.decide(context);
  assert.equal(selected.source,'ai_provider');assert.equal(selected.validation_status,'accepted');
  assert.equal(selected.tool_name,'bstg.business.workflow.prepare');assert.deepEqual(selected.arguments.event_ids,['event-1','event-2']);
  assert.equal(payloads.length,2);
  assert.equal(payloads[1].deterministic_next_step.action,'model_decision_required');
  assert.match(payloads[1].deterministic_next_step.rationale||'',/(?:event IDs.*workflow\.prepare|workflow\.prepare.*event IDs)/i,
    'the next provider turn receives a bounded protocol correction instead of an invented event sequence');
});

test('a repeated stopped-capture inspection in the repeated-execution revision phase requires a model-owned workflow revision', async t => {
  const payloads=[];let turn=0;
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw),payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');payloads.push(payload);
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'revision-recording'},rationale:'Inspect the already refreshed recording again.'}
      : {action:'tool_call',tool_name:'bstg.business.workflow.revise',arguments:{workflow_id:'revision-workflow',test_run_id:'revision-run',event_ids:['event-1','event-3'],rationale:'Remove the repeated failing request while retaining the normal transaction.'},rationale:'Publish the model-selected observed-event revision.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`revision-inspection-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'revision-inspection-protocol','Revision inspection protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='revision-flow',recordingId='revision-recording';
  const context={
    scan:{id:'revision-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'revision-task',scan_run_id:'revision-run',task_type:'learn_business_flow',title:'Revise a repeated native execution failure',
      phase:'normal_validation_repeated_execution_error_requires_model_revision',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.capture.inspect'},{name:'bstg.business.workflow.validate'},{name:'bstg.business.workflow.repair'},{name:'bstg.business.workflow.revise'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},
    task_artifacts:[],task_tool_invocations:[
      {tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped'}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped',events:[{event_id:'event-1',sequence:1},{event_id:'event-3',sequence:3}]}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Revision normal flow',goal:'The normal transaction completes without the repeated failed request',role:'anonymous',status:'failed',recording_session_id:recordingId,workflow_id:'revision-workflow',normal_run_id:'revision-run'}],
    model_scope:{stage:'normal_business_learning',purpose:'Revise the current normal workflow',authorization:'acknowledged',
      allowed_tool_names:['bstg.business.capture.inspect','bstg.business.workflow.validate','bstg.business.workflow.repair','bstg.business.workflow.revise'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const rejected=await planner.decide(context);
  assert.equal(rejected.source,'local_policy');assert.equal(rejected.validation_status,'rejected');
  assert.equal(rejected.action,'model_decision_required');assert.equal(rejected.tool_name,undefined);
  assert.equal(rejected.proposal?.tool_name,'bstg.business.capture.inspect');
  assert.match(rejected.rejection_reason||'',/bstg\.business\.workflow\.revise/i);
  assert.match(rejected.rationale||'',/workflow\.revise.*(?:event IDs|event_ids)/i);
  assert.equal(context.task_tool_invocations.filter(item=>item.tool_name==='bstg.business.capture.inspect').length,1,
    'the revision-phase duplicate inspection is not dispatched');
  assert.deepEqual(payloads[0].context.available_tools.map(tool=>tool.name),['bstg.business.workflow.revise'],
    'a repeated native execution failure exposes only model-owned revision, so it cannot enter another validate/repair/inspect loop');
  assert.deepEqual(payloads[0].context.model_scope.allowed_tool_names,['bstg.business.workflow.revise']);
  assert.equal(payloads[0].required_output.action,'tool_call');
  const selected=await planner.decide(context);
  assert.equal(selected.source,'ai_provider');assert.equal(selected.validation_status,'accepted');
  assert.equal(selected.tool_name,'bstg.business.workflow.revise');
  assert.deepEqual(selected.arguments.event_ids,['event-1','event-3']);
  assert.equal(payloads.length,2);
  assert.deepEqual(payloads[1].context.available_tools.map(tool=>tool.name),['bstg.business.workflow.revise']);
  assert.equal(payloads[1].deterministic_next_step.tool_name,'bstg.business.workflow.revise');
  assert.match(payloads[1].required_output.normal_flow_reconstruction||'',/workflow\.revise.*event_ids/i);
});

test('a failed coverage event selection permits one feedback-driven stopped-capture reinspection', async t => {
  const provider=http.createServer(async (_req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'selection-refresh',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'selection-recording'},rationale:'Read the target candidates after the rejected selection.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'selection-refresh-protocol','Selection refresh protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const context={
    scan:{id:'selection-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'selection-task',scan_run_id:'selection-run',task_type:'learn_business_flow',title:'Correct retry target selection',
      phase:'normal_workflow_selection_requires_adaptation',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'selection-flow'},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.capture.inspect'},{name:'bstg.business.workflow.prepare'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},
    task_artifacts:[],task_tool_invocations:[
      {tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:'selection-recording',status:'stopped'}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:'selection-recording',status:'stopped',events:[{event_id:'event-1',sequence:1}]}},
      {tool_name:'bstg.business.workflow.prepare',status:'failed',output_json:{status:'coverage_retry_event_selection_required',retryable:true}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:'selection-flow',name:'Retry target selection',goal:'The retry reaches its scheduled target',role:'anonymous',status:'learning',recording_session_id:'selection-recording'}],
    model_scope:{stage:'normal_business_learning',purpose:'Correct the selected retry event subset',authorization:'acknowledged',
      allowed_tool_names:['bstg.business.capture.inspect','bstg.business.workflow.prepare'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const selected=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(selected.source,'ai_provider');assert.equal(selected.validation_status,'accepted');
  assert.equal(selected.tool_name,'bstg.business.capture.inspect',
    'a failed model selection is new persisted feedback and authorizes exactly one refreshed inspection');
});

test('a stopped normal capture rejects new browser activity and re-anchors the model on sealed evidence', async t => {
  const provider=http.createServer(async (_req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'stopped-capture-browser-activity',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}},rationale:'Observe the page again.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'stopped-capture-browser-activity','Stopped capture protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='stopped-flow',recordingId='stopped-recording';
  const context={
    scan:{id:'stopped-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'stopped-task',scan_run_id:'stopped-run',task_type:'learn_business_flow',title:'Compile sealed normal capture',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.workflow.prepare'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped'}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped',events:[{event_id:'event-1',sequence:1}]}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Sealed normal flow',goal:'The observed normal action completes',role:'attacker',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:stopped-task',recording_context_scope:'task',recording_identity_key:'attacker'}],
    model_scope:{stage:'normal_business_learning',purpose:'Compile the sealed normal flow',authorization:'acknowledged',
      allowed_tool_names:['browser.interact','bstg.business.capture.inspect','bstg.business.workflow.prepare'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const decision=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(decision.source,'local_policy');assert.equal(decision.validation_status,'rejected');
  assert.equal(decision.tool_name,'bstg.business.capture.inspect');
  assert.deepEqual(decision.arguments,{recording_session_id:recordingId});
  assert.equal(decision.proposal?.tool_name,'browser.interact');
  assert.match(decision.rejection_reason||'',/stopped normal-business recording/i);
});

test('unchanged ordinary active-capture inspections stop recording and preserve the model-selected workflow subset', async t => {
  let turn=0;
  const provider=http.createServer(async (_req,res)=>{
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'retry-recording'},rationale:'Check whether the observed page changed.'}
      : {action:'tool_call',tool_name:'bstg.business.workflow.prepare',arguments:{recording_session_id:'retry-recording',event_ids:['retry-event']},rationale:'Compile the selected retry event.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`unchanged-capture-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'unchanged-capture-fixture','Unchanged capture fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='ordinary-flow',recordingId='retry-recording';
  const context={
    scan:{id:'retry-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'retry-task',scan_run_id:'retry-run',task_type:'learn_business_flow',title:'Capture ordinary normal flow',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:12,used:0,remaining:12}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'},{name:'bstg.business.workflow.prepare'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
      {tool_name:'browser.interact',status:'completed',output_json:{}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:2,events:[{event_id:'semantic-event',semantic_body_path_available:true,action_id:'fixture-action'}]}},
      {tool_name:'browser.interact',status:'completed',output_json:{}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:2,events:[{event_id:'semantic-event',semantic_body_path_available:true,action_id:'fixture-action'}]}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Retry target',goal:'The scheduled target completes',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:retry-task',recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Capture the scheduled retry target',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop','bstg.business.workflow.prepare'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const stopped=await planner.decide(context);
  assert.equal(stopped.source,'local_policy');assert.equal(stopped.validation_status,'rejected');
  assert.equal(stopped.tool_name,'bstg.business.capture.stop');assert.deepEqual(stopped.arguments,{recording_session_id:recordingId});
  assert.equal(stopped.proposal?.tool_name,'bstg.business.capture.inspect');
  assert.match(stopped.rejection_reason||'',/no new completed event/i);

  // The server seals the capture but does not select an event. A fresh stopped
  // inspection is required before the provider's event subset becomes runnable.
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped',event_count:2}});
  const reanchored=await planner.decide(context);
  assert.equal(reanchored.source,'local_policy');assert.equal(reanchored.tool_name,'bstg.business.capture.inspect');
  assert.equal(reanchored.proposal?.tool_name,'bstg.business.workflow.prepare');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'stopped',event_count:2}});
  const selected=await planner.decide(context);
  assert.equal(selected.source,'ai_provider');assert.equal(selected.tool_name,'bstg.business.workflow.prepare');
  assert.deepEqual(selected.arguments.event_ids,['retry-event']);
  assert.equal(turn,3,'the provider still owns the selected Workflow event subset after the capture safety stop');
});

test('active capture stop is first re-anchored to its latest inspection, and HTML-only inspections never auto-stop it', async t => {
  let calls=0;
  const provider=http.createServer(async (_req,res)=>{
    calls+=1;res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`semantic-stop-${calls}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'bstg.business.capture.stop',arguments:{recording_session_id:'semantic-recording'},rationale:'The page navigation should be enough.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'semantic-stop-fixture','Semantic stop fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const context={
    scan:{id:'semantic-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'semantic-task',scan_run_id:'semantic-run',task_type:'learn_business_flow',title:'Capture a semantic normal result',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'semantic-flow'},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:'semantic-flow',recording_session_id:'semantic-recording',capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:'semantic-flow',name:'Semantic result',goal:'The JSON result completes',role:'anonymous',status:'learning',recording_session_id:'semantic-recording',recording_context_key:'task:semantic-task',recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Capture a semantic normal result',authorization:'acknowledged',allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const refresh=await planner.decide(context);
  assert.equal(refresh.source,'local_policy');assert.equal(refresh.tool_name,'bstg.business.capture.inspect');
  assert.equal(refresh.proposal?.tool_name,'bstg.business.capture.stop');
  assert.match(refresh.rejection_reason||'',/latest safe inspection/i);
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:'semantic-recording',status:'recording',event_count:1,events:[{event_id:'navigation-only',semantic_body_path_available:false}]}});
  const keepActive=await planner.decide(context);
  assert.equal(keepActive.source,'local_policy');assert.equal(keepActive.action,'model_decision_required');assert.equal(keepActive.tool_name,undefined);
  assert.match(keepActive.rejection_reason||'',/cannot support a semantic normal-flow assertion/i);
  assert.equal(calls,2);
});

test('a complete coverage-retry candidate set permits one post-target browser action before capture is sealed', async t => {
  const provider=http.createServer(async (_req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'target-candidate-stop',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'target-recording'},rationale:'Refresh the retry evidence.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'target-candidate-stop','Target candidate stop fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='target-flow',recordingId='target-recording';
  const context={
    scan:{id:'target-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'target-task',scan_run_id:'target-run',task_type:'learn_business_flow',title:'Capture coverage retry target',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId,coverage_retry:{attempt:1,targets:[{key:'operation:target',target_type:'operation',target_id:'target'}]}},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:2,
        events:[{event_id:'semantic-target-event',semantic_body_path_available:true,action_id:'fixture-action'}],
        retry_target_event_candidates:[{target_type:'operation',target_id:'target',event_ids:['target-event']}]}},
      {tool_name:'browser.interact',status:'completed',output_json:{}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Target retry',goal:'The scheduled target completes',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:target-task',recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Capture the scheduled retry target',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const decision=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(decision.source,'local_policy');assert.equal(decision.tool_name,'bstg.business.capture.stop');
  assert.deepEqual(decision.arguments,{recording_session_id:recordingId});
  assert.equal(decision.proposal?.tool_name,'bstg.business.capture.inspect');
  assert.match(decision.rejection_reason||'',/scheduled target candidate.*post-target browser action/i);

  const partialContext={...context,task:{...context.task,execution_plan:{...context.task.execution_plan,coverage_retry:{
    ...context.task.execution_plan.coverage_retry,
    targets:[...context.task.execution_plan.coverage_retry.targets,{key:'operation:second-target',target_type:'operation',target_id:'second-target'}],
  }}}};
  const partial=await new AutonomousAgentPlanner(db).decide(partialContext);
  assert.equal(partial.source,'ai_provider');assert.equal(partial.tool_name,'bstg.business.capture.inspect');
  assert.equal(partial.validation_status,'accepted','one observed target must not seal a retry that still has another scheduled target without a candidate');
});

test('a coverage retry keeps an incomplete active capture open and returns the next browser action to the model', async t => {
  const payloads=[];let turn=0;
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);payloads.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}'));
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.capture.stop',arguments:{recording_session_id:'incomplete-retry-recording'},rationale:'The observed requests should be sufficient.'}
      : turn===2
        ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'incomplete-retry-recording'},rationale:'Check the same incomplete capture again.'}
        : turn===3
          ? {action:'tool_call',tool_name:'bstg.business.capture.stop',arguments:{recording_session_id:'incomplete-retry-recording'},rationale:'Stop despite the missing target evidence.'}
          : turn===5
            ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'incomplete-retry-recording'},rationale:'Refresh after another model-selected browser action.'}
            : {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',selector:'#model-selected-target'}},rationale:'Reach the remaining scheduled target through the observed control.'};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`incomplete-retry-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'incomplete-retry-stop','Incomplete retry stop fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const flowId='incomplete-retry-flow',recordingId='incomplete-retry-recording';
  const context={
    scan:{id:'incomplete-retry-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'incomplete-retry-task',scan_run_id:'incomplete-retry-run',task_type:'learn_business_flow',title:'Reach every scheduled retry target',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId,coverage_retry:{attempt:1,targets:[
        {key:'operation:target-a',target_type:'operation',target_id:'target-a'},
        {key:'operation:target-b',target_type:'operation',target_id:'target-b'},
      ]}},decision_budget:{limit:10,used:0,remaining:10}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'},{name:'bstg.business.capture.stop'}],
    feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{}},
    ],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:flowId,name:'Incomplete retry',goal:'Every scheduled target has captured evidence',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:'task:incomplete-retry-task',recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Reach every scheduled retry target',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect','bstg.business.capture.stop'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const first=await planner.decide(context);
  assert.equal(first.source,'local_policy');assert.equal(first.validation_status,'rejected');
  assert.equal(first.tool_name,'bstg.business.capture.inspect');assert.deepEqual(first.arguments,{recording_session_id:recordingId});
  assert.equal(first.proposal?.tool_name,'bstg.business.capture.stop','the first premature stop is converted only into a safe evidence read');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:2,
    events:[{event_id:'semantic-retry-event',semantic_body_path_available:true,action_id:'fixture-action'}],
    retry_target_event_candidates:[
      {target_type:'operation',target_id:'target-a',event_ids:[]},
      {target_type:'operation',target_id:'target-b',event_ids:[]},
    ]}});
  const repeatedInspection=await planner.decide(context);
  assert.equal(repeatedInspection.source,'local_policy');assert.equal(repeatedInspection.validation_status,'rejected');
  assert.equal(repeatedInspection.action,'model_decision_required');assert.equal(repeatedInspection.tool_name,undefined);
  assert.equal(repeatedInspection.proposal?.tool_name,'bstg.business.capture.inspect');
  assert.match(repeatedInspection.rejection_reason||'',/Repeated active-capture inspection cannot create the missing scheduled target evidence/i);
  const rejected=await planner.decide(context);
  assert.equal(rejected.source,'local_policy');assert.equal(rejected.validation_status,'rejected');
  assert.equal(rejected.action,'model_decision_required');assert.equal(rejected.tool_name,undefined);assert.equal(rejected.arguments,undefined);
  assert.equal(rejected.proposal?.tool_name,'bstg.business.capture.stop');
  assert.match(rejected.rejection_reason||'',/before every scheduled target has an observed candidate event/i);
  assert.match(rejected.rationale||'',/BSTG will not choose a control, event, or assertion/i);
  const chosen=await planner.decide(context);
  assert.equal(chosen.source,'ai_provider');assert.equal(chosen.validation_status,'accepted');
  assert.equal(chosen.tool_name,'browser.interact');assert.deepEqual(chosen.arguments,{operation:{action:'click',selector:'#model-selected-target'}});
  assert.equal(turn,4,'after the evidence rail, the provider—not the server—chooses the next browser interaction');
  // The model did interact, then a fresh inspection still found no executable
  // target candidate. The generic unchanged-capture drain must not seal this
  // retry: it would leave no source Workflow step for any later proof.
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',output_json:{}});
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:2,
    events:[{event_id:'semantic-retry-event',semantic_body_path_available:true,action_id:'fixture-action'}],
    retry_target_event_candidates:[
      {target_type:'operation',target_id:'target-a',event_ids:[]},
      {target_type:'operation',target_id:'target-b',event_ids:[]},
    ]}});
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',output_json:{}});
  const refresh=await planner.decide(context);
  assert.equal(refresh.source,'ai_provider');assert.equal(refresh.validation_status,'accepted');
  assert.equal(refresh.tool_name,'bstg.business.capture.inspect');
  assert.equal(turn,5,'an incomplete retry stays open after another model-selected interaction and fresh inspection');
  assert.equal(payloads.length,5);
});

test('capability inventory treats a model claim that its listed tool is unavailable as a rejected protocol error', async t => {
  const observed=[];
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);const payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');
    observed.push({system:wire.messages.find(message=>message.role==='system')?.content||'',payload});
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'inventory-protocol-1',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'block_task',reason:'bstg.capabilities.inventory is not callable from this response.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'inventory-protocol-fixture','Inventory protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',driving_mode:'autopilot',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Inventory native capabilities',task_type:'autonomous_agent_task',
    execution_plan:{intent:'inventory_bstg_capabilities'}});
  await new AIScanAgentRuntime(db).executeTask(task);
  const snapshot=await repo.getSnapshot(run.id);
  const decision=snapshot.planner_decisions.find(item=>item.task_id===task.id);
  assert.equal(observed.length,1);
  assert.match(observed[0].system,/JSON response is also the tool-dispatch protocol/);
  assert.deepEqual(observed[0].payload.context.model_scope.allowed_actions,['tool_call','complete_task']);
  assert.equal(observed[0].payload.required_output.tool_dispatch.includes('BSTG executes this response directly'),true);
  assert.equal(decision?.validation_status,'rejected');
  assert.equal(decision?.proposal_json.action,'block_task');
  assert.equal(decision?.rejection_reason,'policy_rejected');
  assert.equal(snapshot.tool_invocations.filter(item=>item.task_id===task.id&&item.tool_name==='bstg.capabilities.inventory').length,1);
  assert.equal(snapshot.tasks.find(item=>item.id===task.id)?.status,'completed');
});

test('an evidence-less normal Flow block forces a current Flow inspection before another model terminal proposal', async t => {
  let turn=0;
  const provider=http.createServer(async (_req,res)=>{
    turn+=1;
    const decision=turn===1
      ? {action:'complete_task',summary:'The rejected blocker means this flow is done.'}
      : {action:'tool_call',tool_name:'bstg.business.flow.block',arguments:{flow_id:'current-flow',evidence_artifact_id:'current-blocker',reason:'The inspected state now contains a concrete blocker.'}};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`flow-block-adaptation-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'flow-block-adaptation-fixture','Flow block adaptation fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const context={
    scan:{id:'flow-block-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'flow-block-task',scan_run_id:'flow-block-run',task_type:'learn_business_flow',title:'Recover rejected Flow blocker',
      phase:'normal_flow_block_requires_adaptation',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'current-flow'},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.flow.inspect'},{name:'bstg.business.flow.block'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[{tool_name:'bstg.business.flow.block',status:'failed',output_json:{}}],
    global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:'current-flow',name:'Current normal flow',goal:'The current normal action completes',role:'anonymous',status:'learning'}],
    model_scope:{stage:'normal_business_learning',purpose:'Recover the rejected normal Flow blocker',authorization:'acknowledged',
      allowed_tool_names:['bstg.business.flow.inspect','bstg.business.flow.block'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const forced=await planner.decide(context);
  assert.equal(forced.source,'local_policy');assert.equal(forced.validation_status,'rejected');
  assert.equal(forced.tool_name,'bstg.business.flow.inspect');assert.deepEqual(forced.arguments,{flow_id:'current-flow'});
  assert.equal(forced.proposal?.action,'complete_task');
  assert.match(forced.rejection_reason||'',/requires a completed inspection/i);
  context.task_tool_invocations.push({tool_name:'bstg.business.flow.inspect',status:'completed',output_json:{flow_id:'current-flow'}});
  const afterInspection=await planner.decide(context);
  assert.equal(afterInspection.source,'ai_provider');assert.equal(afterInspection.validation_status,'accepted');
  assert.equal(afterInspection.tool_name,'bstg.business.flow.block');
  assert.equal(turn,2,'only the server-mandated inspection gates the next model-owned decision');
});

test('normal-business learning reroutes a free-form model failure to current Flow inspection', async t => {
  const provider=http.createServer((_req,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'normal-failure-recovery',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'fail_task',reason:'The model cannot establish a normal-flow conclusion yet.',
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'normal-failure-recovery-fixture','Normal failure recovery fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const context={
    scan:{id:'normal-failure-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:'normal-failure-task',scan_run_id:'normal-failure-run',task_type:'learn_business_flow',title:'Recover a normal-flow failure proposal',
      execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'normal-failure-flow'},decision_budget:{limit:8,used:0,remaining:8}},
    selected_vuln_types:[],available_tools:[{name:'bstg.business.flow.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],
    task_tool_invocations:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},
    browser_context_summary:{active:0,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    business_flows:[{id:'normal-failure-flow',name:'Current normal flow',goal:'The normal action reaches verified evidence',role:'anonymous',status:'learning'}],
    model_scope:{stage:'normal_business_learning',purpose:'Recover normal-flow evidence',authorization:'acknowledged',
      allowed_tool_names:['bstg.business.flow.inspect'],allowed_actions:['tool_call','complete_task'],broader_assessment_context_withheld:true},
  };
  const decision=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(decision.source,'local_policy');assert.equal(decision.validation_status,'rejected');
  assert.equal(decision.tool_name,'bstg.business.flow.inspect');assert.deepEqual(decision.arguments,{flow_id:'normal-failure-flow'});
  assert.equal(decision.proposal?.action,'fail_task');
  assert.match(decision.rejection_reason||'',/cannot end with fail_task/i);
});

test('unchanged post-action UI structure keeps selector changes inside one bounded capture no-progress episode', async t => {
  const provider=http.createServer((_,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'observed-structure-recovery',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}},
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'observed-structure-fixture','Observed structure recovery fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Bound unchanged selector retries by observed UI state',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flowId='observed-structure-flow',recordingId='observed-structure-recording';
  const stableStructure={controls:[{tag:'button',id:'private-ui-id-must-not-persist',role:'button',type:'button',disabled:false,in_dialog:false,receives_pointer:true,
    selector:'#private-observed-selector-must-not-persist'}],assertion_targets:[]};
  const changedStructure={controls:[
    {tag:'button',id:'private-ui-id-must-not-persist',role:'button',type:'button',disabled:false,in_dialog:false,receives_pointer:true},
    {tag:'input',id:'private-next-field-must-not-persist',role:'',type:'text',disabled:false,in_dialog:false,receives_pointer:true},
  ],assertion_targets:[]};
  // These page-state classes are a finite server-side projection. They prove
  // that two otherwise identical navigation controls can mark real progress
  // without putting the link text, href, ID, or opaque ref into recovery
  // state.
  const profileNavigationStructure={controls:[{tag:'a',role:'link',type:'',intent:'navigation',navigation_target:'profile',disabled:false,in_dialog:false,receives_pointer:true}],assertion_targets:[]};
  const cartNavigationStructure={controls:[{tag:'a',role:'link',type:'',intent:'navigation',navigation_target:'cart',disabled:false,in_dialog:false,receives_pointer:true}],assertion_targets:[]};
  const inspection=(index)=>({tool_name:'bstg.business.capture.inspect',status:'completed',created_at:`2026-10-01T00:01:${String(index).padStart(2,'0')}.000Z`,output_json:{
    recording_session_id:recordingId,status:'recording',event_count:2,events:[{event_id:'opaque-event',semantic_body_path_available:false}],
  }});
  const action=(index,operation,observation)=>({tool_name:'browser.interact',status:'completed',created_at:`2026-10-01T00:00:${String(index).padStart(2,'0')}.000Z`,
    input_json:{operation},output_json:{observation}});
  const context={
    scan:{id:run.id,base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:task.id,scan_run_id:run.id,task_type:'learn_business_flow',title:task.title,execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:20,used:0,remaining:20}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',created_at:'2026-10-01T00:00:00.000Z',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',created_at:'2026-10-01T00:00:01.000Z',output_json:{observation:stableStructure}},
      inspection(2),
    ],
    business_flows:[{id:flowId,name:'Observed UI state',goal:'A normal action reaches semantic evidence',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:`task:${task.id}`,recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Bound unchanged active capture recovery',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
    lifecycle_planner_decisions:[],
  };
  const planner=new AutonomousAgentPlanner(db);
  const recoveries=[];
  for (const [index,operation] of [
    {action:'click',selector:'#private-first-selector-must-not-persist'},
    {action:'fill',selector:'#private-second-selector-must-not-persist',value:'private-value-must-not-persist'},
    {action:'press',selector:'#private-third-selector-must-not-persist',key:'Enter'},
  ].entries()) {
    context.task_tool_invocations.push(action(index + 3,operation,stableStructure));
    context.task_tool_invocations.push(inspection(index + 3));
    const recovery=await planner.decide(context);
    assert.equal(recovery.rejection_code,'normal_capture_inspection_no_progress',JSON.stringify({action:recovery.action,tool_name:recovery.tool_name,source:recovery.source,validation_status:recovery.validation_status}));
    recoveries.push(recovery);
    context.lifecycle_planner_decisions.push({validation_status:'rejected',created_at:`2026-10-01T00:00:2${index}.000Z`,
      policy_json:{rejection_code:'normal_capture_inspection_no_progress'}});
  }
  assert.deepEqual(recoveries.map(item=>item.rejection_context?.browser_state_progress_count),[1,1,1],
    'different model actions and selectors on the same observed UI cannot manufacture progress');
  for (const [index,recovery] of recoveries.entries()) await repo.createPlannerDecision({scan_run_id:run.id,task_id:task.id,iteration:index + 1,
    source:'local_policy',validation_status:'rejected',proposal_json:{action:'tool_call',tool_name:'browser.interact'},decision_json:{action:'model_decision_required'},
    policy_json:{rejection_code:'normal_capture_inspection_no_progress',rejection_context:recovery.rejection_context},rejection_reason:'Value-free active-capture recovery'});
  let rebuilt=await buildAutonomousAgentContext({repo,scanRunId:run.id,task:await repo.getTask(task.id),tools:[]});
  assert.equal(rebuilt.planner_state.normal_capture_inspection_recovery?.consecutive_attempts,3,
    'three selector/action variations with unchanged UI structure reach the normal no-progress limit');

  context.task_tool_invocations.push(action(8,{action:'click',selector:'#private-fourth-selector-must-not-persist'},changedStructure));
  context.task_tool_invocations.push(inspection(8));
  const transitioned=await planner.decide(context);
  assert.equal(transitioned.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(transitioned.rejection_context?.browser_state_progress_count,2,
    'one real post-action control-structure transition starts one new episode');
  await repo.createPlannerDecision({scan_run_id:run.id,task_id:task.id,iteration:4,source:'local_policy',validation_status:'rejected',
    proposal_json:{action:'tool_call',tool_name:'browser.interact'},decision_json:{action:'model_decision_required'},
    policy_json:{rejection_code:'normal_capture_inspection_no_progress',rejection_context:transitioned.rejection_context},rejection_reason:'Value-free active-capture recovery'});
  rebuilt=await buildAutonomousAgentContext({repo,scanRunId:run.id,task:await repo.getTask(task.id),tools:[]});
  assert.equal(rebuilt.planner_state.normal_capture_inspection_recovery?.consecutive_attempts,1);

  context.task_tool_invocations.push(action(9,{action:'click',selector:'#private-return-selector-must-not-persist'},stableStructure));
  context.task_tool_invocations.push(inspection(9));
  const returned=await planner.decide(context);
  assert.equal(returned.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(returned.rejection_context?.browser_state_progress_count,2,
    'returning from a new safe UI structure to a previously observed one cannot reopen the bounded episode');

  context.task_tool_invocations.push(action(10,{action:'click',selector:'#private-profile-navigation-selector'},profileNavigationStructure));
  context.task_tool_invocations.push(inspection(10));
  const profileTransition=await planner.decide(context);
  assert.equal(profileTransition.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(profileTransition.rejection_context?.browser_state_progress_count,3,
    'a finite profile navigation class is a safe post-action state transition');

  context.task_tool_invocations.push(action(11,{action:'click',selector:'#private-cart-navigation-selector'},cartNavigationStructure));
  context.task_tool_invocations.push(inspection(11));
  const cartTransition=await planner.decide(context);
  assert.equal(cartTransition.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(cartTransition.rejection_context?.browser_state_progress_count,4,
    'a different finite navigation target progresses even when control tag/role/type are unchanged');

  const wire=JSON.stringify([recoveries.map(item=>item.rejection_context),transitioned.rejection_context,returned.rejection_context,profileTransition.rejection_context,cartTransition.rejection_context,rebuilt.planner_state]);
  for (const privateValue of ['private-first-selector-must-not-persist','private-second-selector-must-not-persist','private-third-selector-must-not-persist','private-fourth-selector-must-not-persist','private-profile-navigation-selector','private-cart-navigation-selector','private-value-must-not-persist','private-ui-id-must-not-persist','private-next-field-must-not-persist']) {
    assert.equal(wire.includes(privateValue),false,'no action or observed DOM material enters persisted/model recovery state');
  }
});

test('a successful bounded form preparation may reach a model-selected submit before the next capture inspection', async t => {
  const provider=http.createServer((_,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'form-preparation-submit',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:'control_submit'}},
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'form-preparation-fixture','Form preparation fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Complete an observed form before inspecting capture',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flowId='form-preparation-flow',recordingId='form-preparation-recording';
  const controls={controls:[
    {control_ref:'control_field',tag:'input',role:'textbox',type:'text',intent:'generic',disabled:false,in_dialog:false,receives_pointer:true},
    {control_ref:'control_submit',tag:'button',role:'button',type:'submit',intent:'submit',disabled:false,in_dialog:false,receives_pointer:true},
  ],assertion_targets:[]};
  const context={
    scan:{id:run.id,base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:task.id,scan_run_id:run.id,task_type:'learn_business_flow',title:task.title,execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:20,used:0,remaining:20}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{observation:controls}},
      {tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count:0,events:[]}},
      {tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'fill',control_ref:'control_field'}},output_json:{ok:true,observation:controls}},
    ],
    business_flows:[{id:flowId,name:'Prepared form',goal:'The observed form reaches a semantic result',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:`task:${task.id}`,recording_context_scope:'task',recording_identity_key:'anonymous'}],
    model_scope:{stage:'normal_business_learning',purpose:'Complete a prepared form',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
    lifecycle_planner_decisions:[],
  };
  const planner=new AutonomousAgentPlanner(db);
  const submit=await planner.decide(context);
  assert.equal(submit.source,'ai_provider');assert.equal(submit.validation_status,'accepted');
  assert.equal(submit.tool_name,'browser.interact');assert.deepEqual(submit.arguments,{operation:{action:'click',control_ref:'control_submit'}});
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',control_ref:'control_submit'}},output_json:{ok:true,observation:controls}});
  const afterSubmit=await planner.decide(context);
  assert.equal(afterSubmit.source,'local_policy');assert.equal(afterSubmit.tool_name,'bstg.business.capture.inspect',
    'the submit is immediately followed by one safe capture refresh before more browser work');
});

test('capture recovery exposes only finite objective navigation hints and a coarse unsuccessful action class', async t => {
  const provider=http.createServer((_,res)=>{
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:'navigation-hint-recovery',model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}},
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'navigation-hint-fixture','Navigation hint fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Recover a navigation without private DOM data',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flowId='navigation-hint-flow',recordingId='navigation-hint-recording';
  const privateControl='control_private_home';
  const controls={controls:[{control_ref:privateControl,tag:'a',role:'link',type:'',intent:'navigation',navigation_target:'home',disabled:false,in_dialog:false,receives_pointer:true,
    label:'Private home label',href:'https://private.example/opaque'}],assertion_targets:[]};
  const inspection=(event_count)=>({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:recordingId,status:'recording',event_count,events:[{event_id:'opaque-event',semantic_body_path_available:false}]}});
  const context={
    scan:{id:run.id,base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:task.id,scan_run_id:run.id,task_type:'learn_business_flow',title:task.title,execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:20,used:0,remaining:20}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{observation:controls}},inspection(0),
      {tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',control_ref:privateControl}},output_json:{ok:true,observation:controls}},inspection(0),
    ],
    business_flows:[{id:flowId,name:'Add required state',goal:'The observed cart state is updated',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:`task:${task.id}`,recording_context_scope:'task',recording_identity_key:'anonymous',
      objective_operation:{operation_id:'operation:0123456789abcdef01234567',side_effect_class:'add'}}],
    model_scope:{stage:'normal_business_learning',purpose:'Recover an add objective',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
    lifecycle_planner_decisions:[],
  };
  const recovery=await new AutonomousAgentPlanner(db).decide(context);
  assert.equal(recovery.rejection_code,'normal_capture_inspection_no_progress');
  assert.equal(recovery.rejection_context?.last_unsuccessful_action_class,'navigation_home');
  assert.deepEqual(recovery.rejection_context?.objective_navigation_hints,['cart']);
  const wire=JSON.stringify(recovery.rejection_context);
  for(const privateValue of [privateControl,'Private home label','private.example','opaque'])assert.equal(wire.includes(privateValue),false);
});

test('transaction recovery derives ordered finite prerequisites from live controls and action-bound semantic receipts', async t => {
  let turn=0;const payloads=[];
  const refs={
    home:'control_11111111-1111-4111-8111-111111111111',
    cart:'control_22222222-2222-4222-8222-222222222222',
    quantity:'control_33333333-3333-4333-8333-333333333333',
    add:'control_44444444-4444-4444-8444-444444444444',
    review:'control_55555555-5555-4555-8555-555555555555',
    reviewNote:'control_55555555-5555-4555-8555-555555555556',
    confirm:'control_66666666-6666-4666-8666-666666666666',
    disabledConfirm:'control_77777777-7777-4777-8777-777777777777',
    obscuredConfirm:'control_88888888-8888-4888-8888-888888888888',
  };
  const assertionRef='assertion_99999999-9999-4999-8999-999999999999';
  const provider=http.createServer(async (req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);
    payloads.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}'));
    turn+=1;
    const operation=turn<=3
      ? {intent:'not_a_required_transaction_intent'}
      : turn===5
        ? {action:'click',control_ref:refs.disabledConfirm}
        : {intent:turn===4?'review':'confirm'};
    const tool_name=turn===5?'browser.interact':'bstg.transaction.trigger';
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`transaction-prerequisite-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify({
      action:'tool_call',tool_name,arguments:{operation},
    })}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'transaction-prerequisite-fixture','Transaction prerequisite fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',driving_mode:'autopilot',authorization_acknowledged:true}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Learn transaction prerequisites',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flowId='transaction-prerequisite-flow',recordingId='transaction-prerequisite-recording';
  const home={controls:[
    {control_ref:refs.home,tag:'a',role:'link',type:'',intent:'navigation',navigation_target:'home',disabled:false,in_dialog:false,receives_pointer:true,label:'Private home label'},
    {control_ref:refs.cart,tag:'a',role:'link',type:'',intent:'navigation',navigation_target:'cart',disabled:false,in_dialog:false,receives_pointer:true,label:'Private cart label'},
  ],assertion_targets:[]};
  const cart={controls:[
    ...home.controls,
    {control_ref:refs.quantity,tag:'input',role:'textbox',type:'number',intent:'generic',disabled:false,in_dialog:false,receives_pointer:true,form_index:0,label:'Private quantity'},
    {control_ref:refs.add,tag:'button',role:'button',type:'submit',intent:'add',disabled:false,in_dialog:false,receives_pointer:true,form_index:0,label:'Private add button'},
    {control_ref:refs.review,tag:'button',role:'button',type:'submit',intent:'review',disabled:false,in_dialog:false,receives_pointer:true,form_index:1,label:'Private review button'},
    {control_ref:refs.reviewNote,tag:'input',role:'textbox',type:'text',intent:'generic',disabled:false,in_dialog:false,receives_pointer:true,form_index:1,label:'Private review note'},
  ],assertion_targets:[]};
  const checkout={controls:[
    ...cart.controls,
    {control_ref:refs.confirm,tag:'button',role:'button',type:'submit',intent:'confirm',disabled:false,in_dialog:false,receives_pointer:true,form_index:2,label:'Private confirm button'},
    {control_ref:refs.disabledConfirm,tag:'button',role:'button',type:'submit',intent:'confirm',disabled:true,in_dialog:false,receives_pointer:true,form_index:2,label:'Private disabled confirm button'},
    {control_ref:refs.obscuredConfirm,tag:'button',role:'button',type:'submit',intent:'confirm',disabled:false,in_dialog:false,receives_pointer:false,form_index:2,label:'Private obscured confirm button'},
  ],assertion_targets:[{assertion_ref:assertionRef,tag:'div',role:'status',label:'Private transaction assertion'}]};
  const inspection=(event_count,events)=>({tool_name:'bstg.business.capture.inspect',status:'completed',created_at:`2026-10-01T00:00:${String(event_count).padStart(2,'0')}.000Z`,output_json:{
    recording_session_id:recordingId,status:'recording',event_count,events,
    objective_operation:{operation_id:'operation:0123456789abcdef01234567',side_effect_class:'transaction',operation_candidate_event_ids:[]},
    objective_completion:{required_response_paths:['body.order_id'],completion_candidate_event_ids:[]},
  }});
  const context={
    scan:{id:run.id,base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
    task:{id:task.id,scan_run_id:run.id,task_type:'learn_business_flow',title:task.title,execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:20,used:0,remaining:20}},
    selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],lifecycle_planner_decisions:[],
    task_tool_invocations:[
      {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
      {tool_name:'browser.navigate',status:'completed',output_json:{observation:home}},
      inspection(1,[{event_id:'opaque-login-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000001'}]),
      {tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',control_ref:refs.cart}},output_json:{ok:true,action_id:'00000000-0000-4000-8000-000000000002',observation:cart}},
      inspection(2,[{event_id:'opaque-login-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000001'}]),
    ],
    business_flows:[{id:flowId,name:'Private transaction flow',goal:'Private transaction goal',role:'anonymous',status:'learning',recording_session_id:recordingId,
      recording_context_key:`task:${task.id}`,recording_context_scope:'task',recording_identity_key:'anonymous',
      objective_operation:{operation_id:'operation:0123456789abcdef01234567',side_effect_class:'transaction'},
      objective_completion:{required_response_paths:['body.order_id']}}],
    model_scope:{stage:'normal_business_learning',purpose:'Recover a strict transaction',authorization:'acknowledged',
      allowed_tool_names:['browser.navigate','browser.interact','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
  };
  const planner=new AutonomousAgentPlanner(db);
  const beforeAdd=await planner.decide(context);
  assert.equal(beforeAdd.source,'local_policy');assert.equal(beforeAdd.validation_status,'rejected');
  assert.equal(beforeAdd.rejection_code,'normal_capture_inspection_no_progress');
  assert.deepEqual(beforeAdd.rejection_context?.objective_required_control_intents,['add']);
  assert.deepEqual(beforeAdd.rejection_context?.objective_eligible_current_control_counts,{add:1},
    'the recovery says only that one finite add candidate is currently usable, never which opaque control it is');
  assert.equal(beforeAdd.proposal?.tool_name,'browser.interact',
    'an invalid transaction candidate is converted to a non-dispatchable browser proposal rather than selecting a browser control locally');

  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',control_ref:refs.add}},output_json:{ok:true,action_id:'00000000-0000-4000-8000-000000000003',observation:cart}});
  context.task_tool_invocations.push(inspection(3,[
    {event_id:'opaque-login-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000001'},
    {event_id:'opaque-add-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000003'},
  ]));
  const beforeReview=await planner.decide(context);
  assert.equal(beforeReview.source,'local_policy');assert.equal(beforeReview.validation_status,'rejected');
  assert.deepEqual(beforeReview.rejection_context?.objective_required_control_intents,['review'],
    'only a recorder-linked semantic add response advances the local transaction prerequisite stage');
  assert.deepEqual(beforeReview.rejection_context?.objective_eligible_current_control_counts,{review:1});

  const afterAddRefresh=await planner.decide(context);
  assert.equal(afterAddRefresh.source,'local_policy');assert.equal(afterAddRefresh.validation_status,'rejected');
  assert.deepEqual(afterAddRefresh.rejection_context?.objective_required_control_intents,['review'],
    'the mandatory post-action inventory refresh retains the new finite stage without selecting a control');
  context.lifecycle_planner_decisions.push({validation_status:'rejected',created_at:'2026-10-01T00:00:04.000Z',
    policy_json:{rejection_code:'normal_capture_inspection_no_progress'}});

  const review=await planner.decide(context);
  assert.equal(review.source,'ai_provider');assert.equal(review.validation_status,'accepted');
  assert.equal(review.tool_name,'browser.interact');assert.equal(review.arguments?.operation?.control_ref,refs.review,
    'the model-owned review intent resolves to its unique current capability once the finite prerequisite is met');
  const reviewPayload=payloads.findLast(payload=>Array.isArray(payload?.current_normal_browser_requirement?.required_control_intents)&&
    payload.current_normal_browser_requirement.required_control_intents.includes('review'));
  assert.deepEqual((reviewPayload?.context?.available_tools||[]).map(tool=>tool.name),['bstg.transaction.trigger','bstg.transaction.prepare'],
    'a compatible field in the same current form exposes preparation separately from the semantic transaction trigger');
  assert.deepEqual(reviewPayload?.context?.available_tools?.[1]?.input_schema?.properties?.operation?.properties?.candidate_index?.enum,[2],
    'the optional preparation capability uses only a current short-lived field handle');
  context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'click',control_ref:refs.review}},
    output_json:{ok:true,action_id:'00000000-0000-4000-8000-000000000004',observation:checkout}});
  context.task_tool_invocations.push(inspection(4,[
    {event_id:'opaque-login-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000001'},
    {event_id:'opaque-add-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000003'},
    {event_id:'opaque-review-event',semantic_body_path_available:true,action_id:'00000000-0000-4000-8000-000000000004'},
  ]));
  const confirmNext=localPolicy(context);
  assert.equal(confirmNext.action,'model_decision_required');
  assert.equal(confirmNext.tool_name,undefined,
    'a current strict-objective gap must not make capture.inspect the deterministic next step');
  assert.match(confirmNext.rationale||'',/transaction prerequisite is confirm/i,
    'the finite local prerequisite is a model hint, not a server-selected control');
  const disabledConfirm=await planner.decide(context);
  assert.equal(disabledConfirm.source,'local_policy');assert.equal(disabledConfirm.validation_status,'rejected');
  assert.equal(disabledConfirm.rejection_code,'normal_capture_inspection_no_progress');
  assert.deepEqual(disabledConfirm.rejection_context?.objective_required_control_intents,['confirm'],
    'an unavailable confirm control cannot satisfy the model-owned transaction prerequisite');
  assert.equal(disabledConfirm.rejection_context?.transaction_prerequisite_proposal_class,'ineligible_control',
    'the rejected proposal is diagnosed with a closed value-free category, never a control reference or page detail');
  const confirm=await planner.decide(context);
  assert.equal(confirm.source,'ai_provider');assert.equal(confirm.arguments?.operation?.control_ref,refs.confirm,
    'the next provider turn owns the exact current confirmation-control selection');
  const confirmPayload=payloads.findLast(payload=>/transaction prerequisite is confirm/i.test(String(payload?.deterministic_next_step?.rationale||'')));
  assert.ok(confirmPayload,'the confirmation turn retains the server-derived finite prerequisite in its model payload');
  assert.equal(confirmPayload?.deterministic_next_step?.action,'model_decision_required');
  assert.equal(confirmPayload?.deterministic_next_step?.tool_name,undefined,
    'the provider does not receive a contradictory deterministic capture.inspect instruction');
  assert.match(confirmPayload?.deterministic_next_step?.rationale||'',/transaction prerequisite is confirm/i);
  const requirement=confirmPayload?.current_normal_browser_requirement;
  assert.deepEqual(requirement?.kind,'transaction_prerequisite');
  assert.deepEqual(requirement?.required_control_intents,['confirm']);
  assert.deepEqual(requirement?.eligible_current_control_counts,{confirm:1},
    'the current provider turn receives a value-free confirmation-candidate count adjacent to its output contract');
  assert.match(requirement?.instruction||'',/bstg\.transaction\.trigger/i,
    'the server requires a model-owned semantic transaction intent without selecting the underlying browser reference itself');
  assert.equal(confirmPayload?.required_output?.action,'tool_call');
  assert.deepEqual(confirmPayload?.context?.model_scope?.allowed_actions,['tool_call']);
  assert.deepEqual(confirmPayload?.context?.model_scope?.allowed_tool_names,['bstg.transaction.trigger']);
  assert.deepEqual((confirmPayload?.context?.available_tools||[]).map(tool=>tool.name),['bstg.transaction.trigger'],
    'the one-turn lease removes lifecycle and generic browser alternatives while leaving the model to choose the transaction intent');
  const leaseOperationSchema=confirmPayload?.context?.available_tools?.[0]?.input_schema?.properties?.operation;
  assert.deepEqual(leaseOperationSchema?.required,['intent'],
    'the finite transaction lease requires a semantic transaction intent, leaving that business decision to the provider');
  assert.deepEqual(leaseOperationSchema?.properties?.intent?.enum,['confirm'],
    'the provider chooses the currently required semantic intent rather than reproducing a browser handle');
  assert.deepEqual(leaseOperationSchema?.properties?.candidate_index?.enum,[1],
    'an optional candidate number remains available only for a real same-intent ambiguity');
  assert.equal(leaseOperationSchema?.additionalProperties,false);
  assert.equal(Object.hasOwn(leaseOperationSchema?.properties||{},'action'),false);
  assert.equal(Object.hasOwn(leaseOperationSchema?.properties||{},'control_ref'),false);
  assert.equal(Object.hasOwn(leaseOperationSchema?.properties||{},'assertion_ref'),false);
  assert.equal(Object.hasOwn(leaseOperationSchema?.properties||{},'selector'),false,
    'the narrowed transaction tool schema removes stale and non-executable selection surfaces');
  const scopedObservation=(confirmPayload?.context?.task_tool_invocations||[]).findLast(invocation=>
    Array.isArray(invocation?.output_json?.observation?.controls))?.output_json?.observation;
  assert.deepEqual((scopedObservation?.controls||[]).map(control=>control.intent),['confirm'],
    'the one-turn view retains the matching opaque candidate while hiding unrelated navigation/add/review controls');
  assert.deepEqual((scopedObservation?.controls||[]).map(control=>control.candidate_index),[1]);
  assert.equal(Object.hasOwn(scopedObservation?.controls?.[0]||{},'control_ref'),false,
    'the narrowed transaction view does not make the model reproduce a long private browser handle');
  assert.deepEqual(scopedObservation?.assertion_targets||[],[],
    'the transaction action lease excludes assertion targets because this turn needs an executable control interaction');
  const visibleBrowserSelections=(confirmPayload?.context?.task_tool_invocations||[]).flatMap(invocation=>{
    const output=invocation?.output_json||{},observation=output?.observation||{};
    const input=invocation?.input_json?.operation||{};
    return [
      ...(Array.isArray(observation.controls)?observation.controls.map(control=>control.control_ref).filter(ref=>typeof ref==='string'):[]),
      ...(Array.isArray(observation.assertion_targets)?observation.assertion_targets.map(target=>target.assertion_ref).filter(ref=>typeof ref==='string'):[]),
      ...(typeof input.control_ref==='string'?[input.control_ref]:[]),
      ...(typeof input.assertion_ref==='string'?[input.assertion_ref]:[]),
    ];
  });
  assert.deepEqual(visibleBrowserSelections,[],
    'a transaction prerequisite turn exposes no browser control reference, stale or current, to the model');
  const wire=JSON.stringify([beforeAdd.rejection_context,beforeReview.rejection_context,confirmNext]);
  for(const privateValue of [...Object.values(refs),assertionRef,'Private home label','Private cart label','Private quantity','Private add button','Private review button','Private review note','Private confirm button','Private disabled confirm button','Private obscured confirm button','Private transaction assertion','Private transaction flow','Private transaction goal'])assert.equal(wire.includes(privateValue),false);
  const requirementWire=JSON.stringify(requirement);
  for(const privateValue of [...Object.values(refs),assertionRef,'Private home label','Private cart label','Private quantity','Private add button','Private review button','Private review note','Private confirm button','Private disabled confirm button','Private obscured confirm button','Private transaction assertion'])assert.equal(requirementWire.includes(privateValue),false,
    'the structured current-turn contract carries no DOM/reference material');
});

test('a model corrects an invalid Workflow order after one bounded native workflow reinspection', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const privatePlanMaterial='private-plan-material-must-not-reach-provider';
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{model_business_experiment:5}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Correct a model-selected native experiment plan',task_type:'model_business_experiment',
    execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'pending'}});
  const workflow=await db.repos.workflows.create({name:'Experiment retry native workflow',is_active:true,assertion_strategy:'all_steps_pass',
    account_binding_strategy:'anchor_attacker',enable_baseline:false,baseline_config:{capture_replay_only:true},enable_extractor:false,
    enable_session_jar:false,session_jar_config:{cookie_mode:true},workflow_type:'baseline',learning_status:'learned',learning_version:1,template_mode:'snapshot'});
  const template=await db.repos.apiTemplates.create({name:'Native experiment source',raw_request:'GET /fixture HTTP/1.1\r\n\r\n',parsed_structure:{},variables:[],failure_patterns:[],failure_logic:'OR',is_active:true});
  const nativeStep=await db.repos.workflowSteps.create({workflow_id:workflow.id,api_template_id:template.id,step_order:1,
    request_snapshot_raw:template.raw_request,snapshot_template_id:template.id,snapshot_template_name:template.name,snapshot_created_at:new Date().toISOString(),
    step_assertions:[],assertions_mode:'all',failure_patterns_override:[]});
  const flow=newBusinessFlow({name:'Verified normal fixture flow',goal:'The native normal flow has a recorded outcome',role:'anonymous'},task.id);
  const graphStepId='business-flow-graph-step';
  Object.assign(flow,{status:'verified',workflow_id:workflow.id,normal_run_id:'native-normal-run',assertions_verified:true,
    evidence_artifact_ids:['normal-proof'],steps:[{id:graphStepId,step_order:1,description:'Business-flow graph node'}]});
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:flow.id}});

  const planFor=(stepOrder)=>({flow_id:flow.id,name:'Model-selected native-step correction',hypothesis:'The selected request mutation may change the recorded business outcome.',
    rationale:'Use the native workflow inspection and record explicit control and impact assertions.',steps:[{workflow_step_order:stepOrder,role:'normal'}],
    patches:[{workflow_step_order:stepOrder,location:'query',operation:'set',path:'amount',value:privatePlanMaterial}],
    assertions:[{id:'impact',step_order:1,description:'The mutated response carries a business outcome',purpose:'impact',left:{type:'response',path:'body.result'},op:'equals',right:{type:'literal',value:'changed'}}],
    control_assertions:[{id:'control',step_order:1,description:'The normal response carries its expected outcome',purpose:'control',left:{type:'response',path:'body.result'},op:'equals',right:{type:'literal',value:'normal'}}],
  });
  const contexts=[];let turn=0;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);contexts.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}').context);
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.flow.inspect',arguments:{flow_id:flow.id}}
      : turn===2
        ? {action:'tool_call',tool_name:'bstg.workflow.inspect',arguments:{workflow_id:workflow.id}}
        : turn===3
          ? {action:'tool_call',tool_name:'bstg.test_plan.create',arguments:planFor(99)}
          : {action:'tool_call',tool_name:'bstg.test_plan.create',arguments:planFor(nativeStep.step_order)};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`experiment-retry-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'experiment-retry-fixture','Experiment retry fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);

  await new AIScanAgentRuntime(db).executeTask(await repo.getTask(task.id));
  const snapshot=await repo.getSnapshot(run.id);
  const calls=snapshot.tool_invocations.filter(item=>item.task_id===task.id);
  const workflows=calls.filter(item=>item.tool_name==='bstg.workflow.inspect');
  const plans=calls.filter(item=>item.tool_name==='bstg.test_plan.create');
  assert.equal(contexts.length,4,'the recovery inspection is local read-only work and does not spend a provider turn');
  assert.equal(workflows.length,2,'the runtime permits only one extra native workflow reinspection for this mismatch');
  assert.deepEqual(workflows[1].input_json,{workflow_id:workflow.id},'the server refreshes evidence but never selects a step');
  assert.equal(plans.length,2);assert.equal(plans[0].status,'failed');assert.equal(plans[1].status,'completed');
  const correctedTurn=contexts.at(-1);
  const failedPlan=correctedTurn.task_tool_invocations.find(item=>item.tool_name==='bstg.test_plan.create'&&item.status==='failed');
  const refreshedInspection=correctedTurn.task_tool_invocations.filter(item=>item.tool_name==='bstg.workflow.inspect').at(-1);
  assert.equal(failedPlan?.output_json?.status,'workflow_step_binding_mismatch');
  assert.equal(failedPlan?.output_json?.retryable,true);
  assert.equal(refreshedInspection?.output_json?.steps?.[0]?.step_order,nativeStep.step_order);
  assert.equal(refreshedInspection?.output_json?.steps?.[0]?.workflow_step_id,undefined,
    'the model sees the native order needed by the plan schema without receiving opaque step handles');
  assert.equal(JSON.stringify(correctedTurn).includes(privatePlanMaterial),false);
  assert.equal(JSON.stringify(failedPlan?.output_json).includes(graphStepId),false,
    'the correction contract never echoes a rejected step reference');
});

test('repeated invalid experiment step orders fail the task after one reinspection instead of exhausting its budget', async t => {
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{model_business_experiment:8}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Bound invalid model experiment step selection',task_type:'model_business_experiment',
    execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'pending'}});
  const workflow=await db.repos.workflows.create({name:'Bounded experiment workflow',is_active:true,assertion_strategy:'all_steps_pass',
    account_binding_strategy:'anchor_attacker',enable_baseline:false,baseline_config:{capture_replay_only:true},enable_extractor:false,
    enable_session_jar:false,session_jar_config:{cookie_mode:true},workflow_type:'baseline',learning_status:'learned',learning_version:1,template_mode:'snapshot'});
  const template=await db.repos.apiTemplates.create({name:'Bounded native source',raw_request:'GET /fixture HTTP/1.1\r\n\r\n',parsed_structure:{},variables:[],failure_patterns:[],failure_logic:'OR',is_active:true});
  const nativeStep=await db.repos.workflowSteps.create({workflow_id:workflow.id,api_template_id:template.id,step_order:1,
    request_snapshot_raw:template.raw_request,snapshot_template_id:template.id,snapshot_template_name:template.name,snapshot_created_at:new Date().toISOString(),
    step_assertions:[],assertions_mode:'all',failure_patterns_override:[]});
  const flow=newBusinessFlow({name:'Bounded verified flow',goal:'The normal result was verified',role:'anonymous'},task.id);
  Object.assign(flow,{status:'verified',workflow_id:workflow.id,normal_run_id:'native-normal-run',assertions_verified:true,evidence_artifact_ids:['normal-proof']});
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:flow.id}});
  const contexts=[];let turn=0;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw);contexts.push(JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}').context);
    turn+=1;
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.flow.inspect',arguments:{flow_id:flow.id}}
      : turn===2
        ? {action:'tool_call',tool_name:'bstg.workflow.inspect',arguments:{workflow_id:workflow.id}}
        : {action:'tool_call',tool_name:'bstg.test_plan.create',arguments:{flow_id:flow.id,name:'invalid order',hypothesis:'Check a recorded outcome',
          rationale:'Use only the current inspected native Workflow',steps:[{workflow_step_order:99,role:'normal'}],
          patches:[{workflow_step_order:99,location:'query',operation:'set',path:'amount',value:'changed'}],
          assertions:[{id:'impact',step_order:1,description:'The experiment changes the result',purpose:'impact',left:{type:'response',path:'body.result'},op:'equals',right:{type:'literal',value:'changed'}}],
          control_assertions:[{id:'control',step_order:1,description:'The baseline result remains normal',purpose:'control',left:{type:'response',path:'body.result'},op:'equals',right:{type:'literal',value:'normal'}}]}};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`experiment-bounded-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'experiment-bounded-fixture','Experiment bounded fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key','fixture-model',1,1,
  ]);

  await new AIScanAgentRuntime(db).executeTask(await repo.getTask(task.id));
  const finalTask=await repo.getTask(task.id);
  const snapshot=await repo.getSnapshot(run.id);
  const calls=snapshot.tool_invocations.filter(item=>item.task_id===task.id);
  assert.equal(finalTask.status,'failed');
  assert.equal(finalTask.phase,'experiment_step_binding_limit_exceeded');
  assert.equal(contexts.length,4,'the bounded reinspection is local read-only work');
  assert.equal(calls.filter(item=>item.tool_name==='bstg.workflow.inspect').length,2);
  assert.equal(calls.filter(item=>item.tool_name==='bstg.test_plan.create'&&item.status==='failed').length,2);
  const limit=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_experiment_step_binding_limit');
  assert.equal(limit?.content_json?.attempts,2);
  assert.equal(limit?.content_json?.limit,2);
  assert.equal(calls.some(item=>item.tool_name==='bstg.test_plan.compile'||item.tool_name==='bstg.test_plan.execute'),false,
    'a plan is never compiled or run after repeated invalid step selection');
});

test('a rejected native experiment compile exposes safe feedback and permits two inspected child corrections', {timeout:60000}, async t => {
  const contexts=[],submittedSecondCorrectionParents=[];
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw),payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');
    contexts.push(payload);
    const turn=contexts.length;
    const createdPlanIds=payload.context?.task_tool_invocations?.filter(item=>item.tool_name==='bstg.test_plan.create'&&item.status==='completed')
      .map(item=>item.output_json?.plan_id).filter(Boolean)||[];
    const observedPlan=createdPlanIds.at(-1);
    const plan=(parent)=>({flow_id:flow.id,...(parent?{parent_plan_id:parent}:{}),name:'Model-owned compile correction',
      hypothesis:'An unobserved field mutation may change the verified business outcome.',
      rationale:'Use the inspected Workflow and exact compiler feedback to select a safe model-authored revision.',
      steps:[{workflow_step_order:1,role:'normal'}],
      patches:[{workflow_step_order:1,location:'query',operation:'set',path:'missing_field',value:'safe-fixture-value'}],
      assertions:[{id:'impact',step_order:1,description:'The experiment changes the observed outcome',purpose:'impact',left:{type:'response',path:'body.result'},op:'equals',right:{type:'literal',value:'changed'}}],
      control_assertions:[{id:'control',step_order:1,description:'The control retains the observed outcome',purpose:'control',left:{type:'response',path:'body.result'},op:'equals',right:{type:'literal',value:'normal'}}],
    });
    const decision=turn===1
      ? {action:'tool_call',tool_name:'bstg.business.flow.inspect',arguments:{flow_id:flow.id}}
      : turn===2
        ? {action:'tool_call',tool_name:'bstg.workflow.inspect',arguments:{workflow_id:workflow.id}}
        : turn===3
          ? {action:'tool_call',tool_name:'bstg.test_plan.create',arguments:plan()}
          : turn===4 || turn===6 || turn===8
            ? {action:'tool_call',tool_name:'bstg.test_plan.compile',arguments:{plan_id:observedPlan}}
            : {action:'tool_call',tool_name:'bstg.test_plan.create',arguments:plan(turn===7?createdPlanIds[0]:observedPlan)};
    if(turn===7)submittedSecondCorrectionParents.push(decision.arguments.parent_plan_id);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`compile-recovery-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));

  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'compile-recovery-fixture','Compile recovery fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true,
    agent_task_budgets:{model_business_experiment:24}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Recover a rejected experiment compile',task_type:'model_business_experiment',
    execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'pending'}});
  const workflow=await db.repos.workflows.create({name:'Compile recovery workflow',is_active:true,assertion_strategy:'all_steps_pass',
    account_binding_strategy:'anchor_attacker',enable_baseline:false,baseline_config:{capture_replay_only:true},enable_extractor:false,
    enable_session_jar:false,session_jar_config:{cookie_mode:true},workflow_type:'baseline',learning_status:'learned',learning_version:1,template_mode:'snapshot'});
  const template=await db.repos.apiTemplates.create({name:'Compile recovery source',raw_request:'GET /fixture HTTP/1.1\r\n\r\n',parsed_structure:{},variables:[],failure_patterns:[],failure_logic:'OR',is_active:true});
  await db.repos.workflowSteps.create({workflow_id:workflow.id,api_template_id:template.id,step_order:1,request_snapshot_raw:template.raw_request,
    snapshot_template_id:template.id,snapshot_template_name:template.name,snapshot_created_at:new Date().toISOString(),step_assertions:[],assertions_mode:'all',failure_patterns_override:[]});
  const flow=newBusinessFlow({name:'Verified compile recovery flow',goal:'The verified normal flow has a recorded outcome',role:'anonymous'},task.id);
  Object.assign(flow,{status:'verified',workflow_id:workflow.id,normal_run_id:'native-normal-run',assertions_verified:true,evidence_artifact_ids:['normal-proof'],
    steps:[{id:'normal-graph-step',step_order:1,description:'Observed normal operation'}]});
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:flow.id}});

  await new AIScanAgentRuntime(db).executeTask(await repo.getTask(task.id));
  const snapshot=await repo.getSnapshot(run.id),calls=snapshot.tool_invocations.filter(item=>item.task_id===task.id);
  const compiles=calls.filter(item=>item.tool_name==='bstg.test_plan.compile');
  const plans=calls.filter(item=>item.tool_name==='bstg.test_plan.create');
  const inspections=calls.filter(item=>item.tool_name==='bstg.test_plan.inspect');
  assert.equal(contexts.length,8,'the model sees each failed compile before creating the next bounded child plan');
  assert.equal(compiles.length,3,'the original plan and at most two corrected child plans reach native compilation');
  assert.equal(plans.length,3);
  assert.equal(inspections.length,2);
  assert.ok(plans.every(item=>item.status==='completed'));
  const savedPlans=snapshot.artifacts.filter(item=>item.task_id===task.id&&item.artifact_type==='agent_experiment_plan').map(item=>item.content_json);
  assert.ok(savedPlans.some(item=>item.id===plans[1].output_json.plan_id&&item.parent_plan_id===plans[0].output_json.plan_id),
    'the first retry is a fresh child of the inspected failed plan');
  assert.ok(savedPlans.some(item=>item.id===plans[2].output_json.plan_id&&item.parent_plan_id===plans[1].output_json.plan_id),
    'the second retry is a fresh child of the latest inspected failed plan');
  assert.equal(submittedSecondCorrectionParents[0],plans[0].output_json.plan_id,
    'the model fixture deliberately repeats a stale first-generation parent on its second correction');
  assert.equal(compiles[0].output_json.status,'experiment_compile_requires_revision');
  assert.equal(compiles[0].output_json.failure_code,'mutation_field_not_observed');
  assert.match(compiles[0].output_json.summary,/does not match an observed request field/i);
  assert.equal(compiles[1].output_json.status,'experiment_compile_requires_revision');
  assert.equal(compiles[2].output_json.status,'experiment_compile_requires_revision');
  assert.equal(calls.some(item=>item.tool_name==='bstg.test_plan.execute'),false,'no Test Run starts before a plan compiles');
  assert.equal((await repo.getTask(task.id)).status,'failed','a third rejected plan does not leave the Agent in an endless active compile loop');
  assert.equal((await repo.getTask(task.id)).phase,'experiment_compile_limit_exceeded');
  assert.equal((await db.repos.workflows.findAll()).length,1,'rejected plans leave no partially cloned native workflows behind');
  const limitArtifact=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_experiment_compile_limit');
  assert.equal(limitArtifact?.content_json?.failure_code,'mutation_field_not_observed');
  assert.equal(limitArtifact?.content_json?.attempts,3);
  assert.equal(limitArtifact?.content_json?.limit,3);
  const refreshedTurn=contexts.at(-1);
  const visibleFailure=refreshedTurn.context.task_tool_invocations.find(item=>item.tool_name==='bstg.test_plan.compile');
  const visibleInspection=refreshedTurn.context.task_tool_invocations.find(item=>item.tool_name==='bstg.test_plan.inspect');
  assert.equal(visibleFailure?.output_json?.failure_code,'mutation_field_not_observed');
  assert.equal(visibleInspection?.output_json?.compile_feedback?.failure_code,'mutation_field_not_observed');
  assert.equal(JSON.stringify(refreshedTurn).includes('Query field "missing_field" was not observed'),false,
    'the exact compiler exception remains private while the model receives a closed failure code and fixed summary');
});

test('business experiment rejects evidence-free terminal proposals and keeps model control on the tool path',async t=>{
  const payloads=[];let turn=0;
  const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const wire=JSON.parse(raw),payload=JSON.parse(wire.messages.find(message=>message.role==='user')?.content||'{}');
    payloads.push(payload);turn+=1;
    const decision=turn===1
      ? {action:'fail_task',reason:'No BSTG native lifecycle tools are available for the verified flow.'}
      : turn===2
        ? {action:'tool_call',tool_name:'bstg.workflow.inspect',arguments:{workflow_id:payloads[1]?.context?.business_flows?.[0]?.workflow_id}}
        : {action:'tool_call',tool_name:'agent.memory.remember',arguments:{}};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({id:`experiment-terminal-recovery-${turn}`,model:'fixture-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[
    'experiment-terminal-recovery','Experiment terminal recovery fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'fixture-only-key','fixture-model',1,1,
  ]);
  const run=await repo.createRun({base_url:'http://127.0.0.1:1/',scan_config:{surface:'web',authorization_acknowledged:true}});
  const workflow=await db.repos.workflows.create({name:'Verified experiment source',is_active:true,workflow_type:'baseline',template_mode:'snapshot'});
  const normalRunId='normal-baseline';
  const task=await repo.createTask({scan_run_id:run.id,title:'Continue a verified Flow experiment',task_type:'model_business_experiment',
    execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'pending',normal_run_id:normalRunId}});
  const flow=newBusinessFlow({name:'Verified normal operation',goal:'The baseline state is verified',role:'anonymous'},task.id);
  const operationId='operation:0123456789abcdef01234567';
  await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'business_capture_event',title:'Private request source',
    content_json:{private:true,request_body_text:normalRunId}});
  const operationReceipt=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'business_workflow_validation',
    title:'Verified strict operation receipt',source_ref:normalRunId,content_json:{flow_id:flow.id,workflow_id:workflow.id,test_run_id:normalRunId,assertions_verified:true,
      objective_operation_binding:{operation_id:operationId,side_effect_class:'update',source_event_ids:['event-1'],action_ids:['action-1'],
        source_workflow_id:workflow.id,source_step_orders:[1],normal_workflow_id:workflow.id,normal_run_id:normalRunId,
        validation_assertion_ids:['assertion-1'],validated:true}}});
  Object.assign(flow,{status:'verified',assertions_verified:true,workflow_id:workflow.id,normal_run_id:normalRunId,evidence_artifact_ids:['normal-proof'],
    objective_operation:{operation_id:operationId,side_effect_class:'update'},
    objective_operation_binding:{operation_id:operationId,side_effect_class:'update',source_event_ids:['event-1'],action_ids:['action-1'],
      source_workflow_id:workflow.id,source_step_orders:[1],normal_workflow_id:workflow.id,normal_run_id:normalRunId,
      validation_assertion_ids:['assertion-1'],validation_artifact_id:operationReceipt.id,validated:true},
    objective_completion:{required_response_paths:['body.state']},
    objective_completion_binding:{required_response_paths:['body.state'],source_event_ids:['event-1'],action_ids:['action-1'],source_workflow_id:workflow.id,
      source_step_orders:[1],normal_workflow_id:workflow.id,normal_run_id:normalRunId,validation_assertion_ids:['assertion-1'],validated:true}});
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:flow.id,normal_run_id:normalRunId}});
  const tools=createAgentToolRegistry().list();
  const context=await buildAutonomousAgentContext({repo,scanRunId:run.id,task:await repo.getTask(task.id),tools});
  context.model_scope=buildModelContextScope({task:context.task,scanConfig:context.scan.scan_config,tools});
  const planner=new AutonomousAgentPlanner(db);
  const first=await planner.decide(context);
  assert.equal(first.source,'local_policy');assert.equal(first.validation_status,'rejected');
  assert.equal(first.proposal?.action,'fail_task');assert.equal(first.tool_name,'bstg.business.flow.inspect');
  assert.deepEqual(payloads[0].context.model_scope.allowed_actions,['tool_call']);
  assert.deepEqual(payloads[0].context.model_scope.allowed_tool_names,['bstg.business.flow.inspect']);
  assert.deepEqual(payloads[0].context.available_tools.map(tool=>tool.name),['bstg.business.flow.inspect']);
  assert.deepEqual(payloads[0].context.business_flows[0].objective_completion_binding.required_response_paths,['body.state'],
    'the model-facing flow projection retains the safe server-sealed completion proof used by experiment admission');
  assert.equal(payloads[0].context.business_flows[0].objective_completion_binding.validated,true);
  assert.equal(payloads[0].context.business_flows[0].normal_run_id,normalRunId,
    'private request values cannot redact the opaque normal Test Run reference used by local experiment admission');
  assert.equal(payloads[0].context.business_flows[0].objective_operation_binding.normal_run_id,normalRunId,
    'the model-facing strict-operation proof retains its native Test Run reference after private-value redaction');
  assert.equal(payloads[0].context.business_flows[0].objective_completion_binding.normal_run_id,normalRunId,
    'the model-facing completion proof retains its native Test Run reference after private-value redaction');
  assert.equal(payloads[0].context.business_flows[0].objective_operation.operation_id,operationId,
    'the model-facing Flow retains the opaque strict-operation contract needed by experiment admission');
  assert.equal(payloads[0].context.business_flows[0].objective_operation_binding.validation_artifact_id,operationReceipt.id,
    'the model-facing Flow retains only the opaque reference to its native strict-operation receipt');
  assert.equal(payloads[0].context.business_flows[0].objective_operation_binding.validated,true);
  assert.equal(payloads[0].required_output.action,'tool_call');
  assert.match(payloads[0].required_output.experiment_terminal_contract,/Only tool_call is allowed/);

  const recordLifecycleInvocation=invocation=>{
    context.task_tool_invocations.push(invocation);
    if(context.lifecycle_tool_invocations!==context.task_tool_invocations)context.lifecycle_tool_invocations.push(invocation);
  };
  recordLifecycleInvocation({tool_name:'bstg.business.flow.inspect',status:'completed',output_json:{flow_id:flow.id}});
  const second=await planner.decide(context);
  assert.equal(second.source,'ai_provider');assert.equal(second.validation_status,'accepted');
  assert.equal(second.tool_name,'bstg.workflow.inspect');
  assert.deepEqual(payloads[1].context.model_scope.allowed_actions,['tool_call']);
  assert.deepEqual(payloads[1].context.model_scope.allowed_tool_names,['bstg.workflow.inspect']);
  recordLifecycleInvocation({tool_name:'bstg.workflow.inspect',status:'completed',output_json:{workflow_id:workflow.id,steps:[{workflow_step_id:'native-step',step_order:1}]}});
  const third=await planner.decide(context);
  assert.equal(third.source,'local_policy');assert.equal(third.validation_status,'rejected');
  assert.equal(third.proposal?.tool_name,'agent.memory.remember');
  const planningTools=payloads[2].context.model_scope.allowed_tool_names;
  assert.ok(planningTools.includes('bstg.test_plan.create'));
  assert.ok(planningTools.includes('bstg.business.object_handles.inspect'));
  assert.ok(!planningTools.includes('bstg.assets.search'),
    'task-bound experiments do not receive scan-wide asset IDs beside native step references');
  assert.ok(planningTools.includes('agent.memory.query'));
  assert.ok(!planningTools.includes('agent.memory.remember'));
  assert.deepEqual(payloads[2].context.available_tools.map(tool=>tool.name).sort(),[...planningTools].sort());
  assert.equal(turn,3);
});
