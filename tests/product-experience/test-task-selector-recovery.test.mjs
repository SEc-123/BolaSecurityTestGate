import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';

// Runtime/SQLite regressions only. The model speaks the real local HTTP protocol,
// while a registry stub supplies selector feedback; no browser or device runs.
const selectorCodes=['selector_no_match','selector_ambiguous','selector_not_visible'];
const rejectedSelector=(code='selector_ambiguous',overrides={})=>({
 ok:false,error:'Local fixture selector rejected before action.',
 data:{error_code:code,failure_phase:'pre_action',action_performed:false,
  match_count:code==='selector_no_match'?0:code==='selector_ambiguous'?2:1,
  context_key:'fixture-task-browser',observation:{controls:[{tag:'button',id:'unique',text:'Fixture control'}]},...overrides},
});

async function fixture(t,{taskType='test_generic_vuln',intent,toolName='browser.interact',results=[rejectedSelector()],denyCorrection=false}) {
 const db=await database();t.after(()=>db.disconnect());
 const repo=new AIScanRepository(db),contexts=[],handlerInputs=[];
 const provider=http.createServer(async(req,res)=>{
  try {
   let raw='';for await(const chunk of req)raw+=chunk;
   const context=JSON.parse(JSON.parse(raw).messages.find(message=>message.role==='user').content).context;
   contexts.push(context);
   if(denyCorrection&&contexts.length===2){res.writeHead(403);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'Local protocol denial'}}));return;}
   const decision=context.task_tool_invocations.some(invocation=>invocation.status==='completed')
    ? {action:'complete_task',summary:'Registry fixture corrected its selector.'}
    : {action:'tool_call',tool_name:toolName,arguments:{operation:{action:'click',selector:contexts.length===1?'.duplicate':'#unique'}}};
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({id:`selector-runtime-fixture-${contexts.length}`,model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  } catch(error) {res.writeHead(500);res.end(JSON.stringify({error:{message:String(error)}}));}
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
 await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
  ['selector-runtime-fixture','Explicit local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
 const run=await repo.createRun({base_url:'http://127.0.0.1:9/unused-fixture',scan_config:{surface:'web',driving_mode:'autopilot'}});
 const task=await repo.createTask({scan_run_id:run.id,title:'Selector runtime fixture',task_type:taskType,
  vuln_type:taskType==='test_file_upload'?'file_upload':taskType==='test_generic_vuln'?'bola_idor':undefined,
  execution_plan:intent?{intent}:{}});
 const runtime=new AIScanAgentRuntime(db),registry=new AgentToolRegistry();
 registry.register({name:toolName,description:'Explicit stub; never performs a browser/device action.',input_schema:{type:'object'},handler:async input=>{
  handlerInputs.push(input);
  return structuredClone(results[Math.min(handlerInputs.length-1,results.length-1)]);
 }});
 // TypeScript's private field is deliberately replaced only in this fixture;
 // production browser/Appium tools cannot be invoked by these protocol replies.
 runtime.registry=registry;
 await runtime.run(run.id);
 return {snapshot:await repo.getSnapshot(run.id),contexts,handlerInputs,task};
}

for(const taskType of ['test_generic_vuln','test_file_upload']) {
 for(const code of selectorCodes)test(`${taskType} sends ${code} no-action feedback to the next model decision`,{timeout:10000},async t=>{
  const f=await fixture(t,{taskType,results:[rejectedSelector(code),{ok:true,data:{action_performed:true}}]});
  assert.equal(f.snapshot.run.status,'completed');assert.equal(f.snapshot.tasks[0].status,'completed');
  assert.equal(f.contexts.length,3);assert.equal(f.handlerInputs.length,2);
  assert.equal(f.handlerInputs[1].operation.selector,'#unique');
  const next=f.contexts[1];assert.equal(next.task.phase,'awaiting_selector_correction');
  const feedback=next.task_tool_invocations.at(-1);
  assert.equal(feedback.status,'failed');assert.equal(feedback.output_json.error_code,code);
  assert.equal(feedback.output_json.failure_phase,'pre_action');assert.equal(feedback.output_json.action_performed,false);
  assert.equal(feedback.output_json.observation.controls[0].id,'unique');
  assert.deepEqual(f.snapshot.tool_invocations.map(invocation=>invocation.status).sort(),['completed','failed']);
  assert.ok(f.snapshot.planner_decisions.every(decision=>decision.source==='ai_provider'));
 });

 test(`${taskType} stops after two corrections even when selector failure codes change`,{timeout:10000},async t=>{
  const f=await fixture(t,{taskType,results:selectorCodes.map(code=>rejectedSelector(code))});
  assert.equal(f.snapshot.run.status,'failed');assert.equal(f.snapshot.tasks[0].status,'failed');
  assert.equal(f.contexts.length,3);assert.equal(f.handlerInputs.length,3);
  assert.deepEqual(f.snapshot.tool_invocations.map(invocation=>invocation.output_json.error_code).sort(),[...selectorCodes].sort());
  assert.ok(f.contexts[1].task_tool_invocations.some(invocation=>invocation.output_json.error_code===selectorCodes[0]));
  assert.ok(f.contexts[2].task_tool_invocations.some(invocation=>invocation.output_json.error_code===selectorCodes[1]));
  assert.ok(f.snapshot.tool_invocations.every(invocation=>invocation.status==='failed'));
 });

 test(`${taskType} provider denial during correction is terminal`,{timeout:10000},async t=>{
  const f=await fixture(t,{taskType,denyCorrection:true});
  assert.equal(f.snapshot.run.status,'failed');assert.equal(f.contexts.length,2);assert.equal(f.handlerInputs.length,1);
  assert.equal(f.snapshot.artifacts.filter(artifact=>artifact.artifact_type==='provider_policy_denial').length,1);
  assert.ok(!f.snapshot.planner_decisions.some(decision=>decision.source==='fallback'));
 });
}

const terminalCases=[
 ['scope failure',rejectedSelector('task_endpoint_plan_mismatch')],
 ['authentication failure',rejectedSelector('authentication_required')],
 ['provider tool failure',rejectedSelector('provider_policy_denied')],
 ['assertion failure',rejectedSelector('assertion_failed')],
 ['action already performed',rejectedSelector('selector_ambiguous',{action_performed:true})],
 ['post-action failure',rejectedSelector('selector_ambiguous',{failure_phase:'post_action'})],
 ['absent no-action proof',rejectedSelector('selector_ambiguous',{action_performed:undefined})],
 ['unknown selector failure',rejectedSelector('selector_invalid')],
];
for(const [name,result] of terminalCases)test(`test selector correction excludes ${name}`,{timeout:10000},async t=>{
 const f=await fixture(t,{results:[result]});
 assert.equal(f.snapshot.run.status,'failed');assert.equal(f.contexts.length,1);assert.equal(f.handlerInputs.length,1);
 assert.equal(f.snapshot.tool_invocations[0].status,'failed');
});

test('selector-shaped feedback from another tool remains terminal',{timeout:10000},async t=>{
 const f=await fixture(t,{taskType:'test_file_upload',toolName:'bstg.file_upload.run_test'});
 assert.equal(f.snapshot.run.status,'failed');assert.equal(f.contexts.length,1);assert.equal(f.handlerInputs.length,1);
});

test('an unclassified execute_test intent does not gain selector recovery',{timeout:10000},async t=>{
 const f=await fixture(t,{taskType:'autonomous_agent_task',intent:'execute_test'});
 assert.equal(f.snapshot.run.status,'failed');assert.equal(f.contexts.length,1);assert.equal(f.handlerInputs.length,1);
});
