import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AutonomousAgentPlanner} from '../../server/src/agent/autonomous-planner.ts';
import {BUSINESS_LEARNING_INTENT} from '../../server/src/agent/business-task-lifecycle.ts';

test('a completed prepared login is followed by one opaque observation then one capture inspection',async t=>{
 const provider=http.createServer((_,res)=>{
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'prepared-login-policy',model:'fixture',choices:[{message:{role:'assistant',content:JSON.stringify({action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:'control_00000000-0000-4000-8000-000000000001'}}})}}]}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
 const db=await database();t.after(()=>db.disconnect());
 await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',['prepared-login-policy','Prepared login policy fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'fixture-only','fixture',1,1]);
 const flowId='prepared-flow',recordingId='prepared-recording';
 const context={
  scan:{id:'prepared-run',base_url:'http://127.0.0.1:1/',scan_config:{authorization_acknowledged:true}},
  task:{id:'prepared-task',scan_run_id:'prepared-run',task_type:'learn_business_flow',title:'Observe prepared login state',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flowId},decision_budget:{limit:8,used:0,remaining:8}},
  selected_vuln_types:[],available_tools:[{name:'browser.navigate'},{name:'browser.interact'},{name:'bstg.identity.apply_login'},{name:'bstg.business.capture.inspect'}],feature_tree:[],relevant_endpoints:[],endpoint_inventory_summary:{total:0},task_artifacts:[],global_recent_artifacts:[],shared_resources:[],shared_resource_summary:{total:0},relevant_memories:[],memory_summary:{total:0},browser_context_summary:{active:1,contexts:[]},planner_state:{},recent_tasks:[],operating_rules:[],lifecycle_planner_decisions:[],
  task_tool_invocations:[
   {tool_name:'bstg.business.capture.start',status:'completed',output_json:{flow_id:flowId,recording_session_id:recordingId,capture_status:'recording'}},
   {tool_name:'browser.navigate',status:'completed',output_json:{}},
   {tool_name:'bstg.identity.apply_login',status:'completed',output_json:{recording_session_id:recordingId,authenticated:true}},
  ],
  business_flows:[{id:flowId,name:'Prepared identity',goal:'Observe the authenticated state',role:'victim',status:'learning',recording_session_id:recordingId,recording_context_key:'task:prepared-task',recording_context_scope:'task',recording_identity_key:'victim'}],
  model_scope:{stage:'normal_business_learning',purpose:'Prepared login observation',authorization:'acknowledged',allowed_tool_names:['browser.navigate','browser.interact','bstg.identity.apply_login','bstg.business.capture.inspect'],allowed_actions:['tool_call','complete_task','fail_task'],broader_assessment_context_withheld:true},
 };
 const planner=new AutonomousAgentPlanner(db);
 const observe=await planner.decide(context);
 assert.equal(observe.source,'local_policy');assert.equal(observe.tool_name,'browser.interact');assert.equal(observe.arguments.operation.action,'observe');
 context.task_tool_invocations.push({tool_name:'browser.interact',status:'completed',input_json:{operation:{action:'observe'}},output_json:{observation:{controls:[{control_ref:'control_00000000-0000-4000-8000-000000000001',tag:'a',intent:'navigation',navigation_target:'profile'}]}}});
 const inspect=await planner.decide(context);
 assert.equal(inspect.source,'local_policy');assert.equal(inspect.tool_name,'bstg.business.capture.inspect');assert.deepEqual(inspect.arguments,{recording_session_id:recordingId});
});
