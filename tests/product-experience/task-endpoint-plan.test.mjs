import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {dbManager} from '../../server/src/db/db-manager.ts';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {buildWorkflowExecutionPlan} from '../../server/src/services/ai-scan/workflow-context.ts';
import {resolveTaskEndpointPlan,TaskEndpointPlanError} from '../../server/src/services/ai-scan/task-endpoint-plan.ts';
import {buildAIScanToolSpecs} from '../../server/src/agent/tools/ai-scan-tools.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {runGenericVulnerabilityTask} from '../../server/src/services/ai-scan/generic-vuln-runner.ts';
import {runNativeBstgOrchestration,runNativeApiTestRun} from '../../server/src/services/ai-scan/bstg-native-orchestrator.ts';
import {runFileUploadTask} from '../../server/src/services/ai-scan/file-upload-runner.ts';

// All transport stays on this disposable loopback server. No browser, model,
// device or saved target configuration is used by these contract regressions.
async function fixture(t,vulnType='path_traversal',paths=['/download/a','/download/b','/download/c','/download/d']) {
 const db=await database();t.after(()=>db.disconnect());t.mock.method(dbManager,'getActive',()=>db);
 const requests=[];const server=http.createServer((req,res)=>{requests.push(req.url);req.resume();res.setHeader('content-type','text/plain');res.end('public fixture document');});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 const base=`http://127.0.0.1:${server.address().port}`,repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:base,selected_vuln_types:[vulnType],scan_config:{request_evidence_required:true}});
 const endpoints=[];
 for(const pathname of paths) {
  const e=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:pathname,url:`${base}${pathname}?file=public.txt`,source_type:'browser_network'});
  await repo.saveCapturedRequest(e,{method:'GET',url:e.url,headers:{},body:null,response_status:200,source:'browser',captured_at:new Date().toISOString()});endpoints.push(e);
 }
 const [a,b,c,d]=endpoints,plan=buildWorkflowExecutionPlan({allEndpoints:endpoints,selectedEndpointIds:[a.id,b.id],targetEndpointId:a.id,vulnType});
 const resource=await repo.upsertSharedResource({scan_run_id:run.id,resource_type:'object_inventory',resource_key:'fixture',content_json:{}});
 const task=await repo.createTask({scan_run_id:run.id,title:'Scoped fixture task',task_type:vulnType==='file_upload'?'test_file_upload':'test_generic_vuln',vuln_type:vulnType,endpoint_ids:plan.endpoint_ids,execution_plan:{workflow_execution_plan:plan,shared_resource_refs:{inventory:`${resource.resource_type}:${resource.resource_key}`}}});
 const registry=new AgentToolRegistry();for(const tool of buildAIScanToolSpecs())registry.register(tool);
 const context={db,repo,scanRunId:run.id,taskId:task.id};
 return {db,repo,run,task,a,b,c,d,plan,requests,registry,context};
}
async function sideEffects(f) {
 const counts={};for(const table of ['api_templates','workflows','workflow_steps','security_rules','checklists','accounts','test_runs','findings','workflow_variable_configs','workflow_variables','workflow_mappings','workflow_extractors'])counts[table]=(await f.db.runRawQuery(`SELECT count(*) AS n FROM ${table}`))[0].n;
 return {counts,task:await f.repo.getTask(f.task.id),artifacts:await f.repo.listArtifacts(f.run.id),resources:await f.repo.listSharedResources(f.run.id)};
}
async function rejected(f,args,reason,tool='bstg.generic_vuln.run_test') {
 const before=await sideEffects(f),previousInvocations=new Set((await f.repo.listToolInvocations(f.run.id)).map(invocation=>invocation.id));
 const result=await f.registry.call(tool,args,f.context);
 assert.equal(result.ok,false);assert.equal(result.data.error_code,'task_endpoint_plan_mismatch');
 assert.equal(result.data.reason_code,reason);assert.equal(result.data.failure_phase,'pre_action');assert.equal(result.data.action_performed,false);
 assert.deepEqual(await sideEffects(f),before);assert.equal(f.requests.length,0);
 const addedInvocations=(await f.repo.listToolInvocations(f.run.id)).filter(invocation=>!previousInvocations.has(invocation.id));
 assert.equal(addedInvocations.length,1);const [invocation]=addedInvocations;assert.equal(invocation.status,'failed');assert.deepEqual(invocation.output_json,result.data);
 assert.doesNotMatch(JSON.stringify(result),/https?:|cookie|authorization|public\.txt/i);
}

test('changed model endpoint list cannot combine with the stale persisted target',async t=>{
 const f=await fixture(t);await rejected(f,{endpoint_id:f.d.id,endpoint_ids:[f.c.id,f.d.id]},'target_outside_task_scope');
});
test('including the valid target cannot smuggle an out-of-task endpoint into its list',async t=>{
 const f=await fixture(t);await rejected(f,{endpoint_id:f.a.id,endpoint_ids:[f.a.id,f.c.id]},'endpoint_scope_mismatch');
});
test('omitting a persisted prerequisite or supplying an unknown endpoint is rejected without filtering',async t=>{
 const f=await fixture(t);
 await rejected(f,{endpoint_id:f.a.id,endpoint_ids:[f.a.id]},'endpoint_scope_mismatch');
 await rejected(f,{endpoint_id:f.a.id,endpoint_ids:[f.a.id,f.b.id,'unknown']},'endpoint_scope_mismatch');
});
test('a different target inside the task still requires a persisted replan',async t=>{
 const f=await fixture(t);await rejected(f,{endpoint_id:f.b.id},'target_plan_mismatch');
});
test('API and upload tool alternatives cannot escape their task target/scope',async t=>{
 const f=await fixture(t);await rejected(f,{endpoint_id:f.c.id},'target_outside_task_scope','bstg.api_test.run');
 await rejected(f,{endpoint_id:f.a.id,vuln_type:'xss'},'vulnerability_type_mismatch','bstg.api_test.run');
 const upload=await fixture(t,'file_upload');await rejected(upload,{endpoint_id:upload.a.id,endpoint_ids:[upload.a.id,upload.b.id,upload.c.id]},'endpoint_scope_mismatch','bstg.file_upload.run_test');
});
for(const kind of ['null','outside-node','outside-schedule','missing-target','duplicate-endpoint','duplicate-node','duplicate-schedule','inconsistent-order'])test(`malformed persisted ${kind} plan does not fall back to model input`,async t=>{
 const f=await fixture(t),plan=structuredClone(f.plan);
 if(kind==='outside-node')plan.nodes[0].endpoint_id=f.c.id;
 if(kind==='outside-schedule')plan.schedule[0].endpoint_ids=[f.c.id];
 if(kind==='missing-target')delete plan.target_endpoint_id;
 if(kind==='duplicate-endpoint')plan.endpoint_ids.unshift(plan.endpoint_ids[0]);
 if(kind==='duplicate-node')plan.nodes.unshift(plan.nodes[0]);
 if(kind==='duplicate-schedule')plan.schedule.unshift(plan.schedule[0]);
 if(kind==='inconsistent-order')plan.nodes.reverse();
 await f.repo.updateTask(f.task.id,{execution_plan:{workflow_execution_plan:kind==='null'?null:plan}});
 await rejected(f,{},'invalid_persisted_plan');
});
test('task/run binding and endpoint/run binding are checked before execution',async t=>{
 const f=await fixture(t),other=await f.repo.createRun({base_url:f.run.base_url});
 const before=await sideEffects(f);
 const result=await f.registry.call('bstg.generic_vuln.run_test',{}, {...f.context,scanRunId:other.id});
 assert.equal(result.data.reason_code,'task_run_mismatch');assert.deepEqual(await sideEffects(f),before);
 const foreign=await f.repo.upsertEndpoint({scan_run_id:other.id,method:'GET',path:'/foreign',url:f.run.base_url+'/foreign'});
 await f.repo.updateTask(f.task.id,{endpoint_ids:[foreign.id],execution_plan:{}});
 await rejected(f,{},'endpoint_not_in_run');
});
test('persisted endpoint origin remains constrained by the declared run origin',async t=>{
 const f=await fixture(t);
 const outside=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/outside',url:'https://never-contact.invalid/outside'});
 await f.repo.updateTask(f.task.id,{endpoint_ids:[outside.id],execution_plan:{}});
 await rejected(f,{},'endpoint_origin_outside_run_scope');
});
test('captured request origin is checked even when the endpoint URL is in scope',async t=>{
 const f=await fixture(t);
 const endpoint=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/mismatched-capture',url:f.run.base_url+'/mismatched-capture'});
 await f.repo.saveCapturedRequest(endpoint,{method:'GET',url:'https://never-contact.invalid/download',headers:{},body:null,response_status:200,source:'browser',captured_at:new Date().toISOString()});
 await f.repo.updateTask(f.task.id,{endpoint_ids:[endpoint.id],execution_plan:{}});
 await rejected(f,{},'endpoint_origin_outside_run_scope');
});
test('omitted or reordered/duplicated arguments preserve the stored target and prerequisite order',async t=>{
 const f=await fixture(t),before=await sideEffects(f);
 for(const args of [{},{endpointId:f.a.id,endpointIds:[f.b.id,f.a.id,f.b.id]}]) {
  const resolved=await resolveTaskEndpointPlan({repo:f.repo,scanRunId:f.run.id,taskId:f.task.id,...args});
  assert.equal(resolved.endpoint.id,f.a.id);assert.deepEqual(resolved.endpoints.map(e=>e.id),f.plan.endpoint_ids);
 }
 assert.deepEqual(await sideEffects(f),before);assert.equal(f.requests.length,0);
});
test('consistent target-first legacy plans remain valid without changing native target-last semantics',async t=>{
 const f=await fixture(t),plan=structuredClone(f.plan);plan.endpoint_ids=[f.a.id,f.b.id];
 plan.nodes=plan.endpoint_ids.map(id=>plan.nodes.find(node=>node.endpoint_id===id));
 plan.schedule=plan.endpoint_ids.map((id,index)=>({...plan.schedule.find(stage=>stage.endpoint_ids.includes(id)),stage:index+1}));
 await f.repo.updateTask(f.task.id,{endpoint_ids:plan.endpoint_ids,execution_plan:{workflow_execution_plan:plan}});
 const before=await sideEffects(f),resolved=await resolveTaskEndpointPlan({repo:f.repo,scanRunId:f.run.id,taskId:f.task.id});
 assert.equal(resolved.endpoint.id,f.a.id);assert.deepEqual(resolved.plan,plan);
 assert.deepEqual(await sideEffects(f),before);assert.equal(f.requests.length,0);
});
test('an explicit persisted child can use its own new in-scan scope without inheriting the parent target',async t=>{
 const f=await fixture(t);
 const child=await f.repo.createTask({scan_run_id:f.run.id,parent_task_id:f.task.id,title:'New scoped child',task_type:'test_generic_vuln',vuln_type:'path_traversal',endpoint_ids:[f.c.id,f.d.id],execution_plan:{}});
 const resolved=await resolveTaskEndpointPlan({repo:f.repo,scanRunId:f.run.id,taskId:child.id,endpointId:f.d.id,endpointIds:[f.c.id,f.d.id]});
 assert.equal(resolved.endpoint.id,f.d.id);assert.deepEqual(new Set(resolved.plan.endpoint_ids),new Set([f.c.id,f.d.id]));
 assert.equal((await f.repo.getTask(child.id)).execution_plan.workflow_execution_plan.target_endpoint_id,f.d.id);
 assert.deepEqual(await f.repo.getTask(f.task.id),f.task);assert.equal(f.requests.length,0);
});
test('an empty legacy task scope cannot expand to the scan inventory',async t=>{
 const f=await fixture(t);await f.repo.updateTask(f.task.id,{endpoint_ids:[],execution_plan:{}});
 await rejected(f,{endpoint_id:f.c.id},'empty_or_invalid_task_scope');
});
test('legacy explicit upload child derives its missing type only from its persisted task type',async t=>{
 const f=await fixture(t),child=await f.repo.createTask({scan_run_id:f.run.id,parent_task_id:f.task.id,title:'Legacy upload child',task_type:'test_file_upload',endpoint_ids:[f.c.id],execution_plan:{}});
 const resolved=await resolveTaskEndpointPlan({repo:f.repo,scanRunId:f.run.id,taskId:child.id,endpointId:f.c.id,vulnType:'file_upload'});
 assert.equal(resolved.task.vuln_type,'file_upload');assert.equal((await f.repo.getTask(child.id)).vuln_type,'file_upload');
 assert.equal(resolved.endpoint.id,f.c.id);assert.equal(f.requests.length,0);
});
test('direct generic/native/API/upload runners reject before artifacts, assets or transport',async t=>{
 const f=await fixture(t),before=await sideEffects(f);
 const args={db:f.db,repo:f.repo,task:f.task,endpoint:f.c,endpoints:[f.a,f.c],payloads:[]};
 for(const run of [()=>runGenericVulnerabilityTask(args),()=>runNativeBstgOrchestration({...args,actionEndpointId:f.c.id}),()=>runNativeApiTestRun(args),()=>runFileUploadTask(args)]) {
  await assert.rejects(run(),e=>e instanceof TaskEndpointPlanError);assert.deepEqual(await sideEffects(f),before);assert.equal(f.requests.length,0);
 }
});
test('OTP verification heuristics cannot silently replace a saved target',{timeout:30000},async t=>{
 const f=await fixture(t,'auth_otp',['/send-code','/verify-code','/other/c','/other/d']);
 const result=await f.registry.call('bstg.generic_vuln.run_test',{},f.context);
 assert.equal(result.ok,true);assert.equal(result.data.endpoint.id,f.a.id);
 const mutations=(await f.repo.listArtifacts(f.run.id)).filter(a=>a.artifact_type==='generic_mutation_attempt');
 assert.ok(mutations.length);assert.ok(mutations.every(a=>a.source_ref===f.a.id));
});
test('direct runner ignores forged endpoint transport fields and reads the persisted endpoint',{timeout:30000},async t=>{
 const f=await fixture(t);
 const result=await runGenericVulnerabilityTask({db:f.db,repo:f.repo,task:f.task,endpoint:{...f.a,url:'https://never-contact.invalid/forged'},endpoints:[f.a,f.b]});
 assert.equal(result.endpoint.url,f.a.url);assert.ok(f.requests.length>0);
 assert.ok(f.requests.every(url=>/^\/download\/[ab](?:\?|$)/.test(url)));
});
test('valid plan executes through the real tool/SQLite/native HTTP runners using only its endpoints',{timeout:30000},async t=>{
 const f=await fixture(t);
 const result=await f.registry.call('bstg.generic_vuln.run_test',{},f.context);
 assert.equal(result.ok,true);assert.equal(result.data.endpoint.id,f.a.id);
 assert.ok(f.requests.length>0);assert.ok(f.requests.every(url=>/^\/download\/[ab](?:\?|$)/.test(url)));
 assert.ok((await f.repo.listArtifacts(f.run.id)).some(a=>a.artifact_type==='native_api_test_run'));
 assert.ok((await f.repo.listArtifacts(f.run.id)).some(a=>a.artifact_type==='generic_mutation_attempt'));
 assert.ok((await f.repo.listSharedResources(f.run.id)).find(resource=>resource.resource_key==='fixture').usage_count>0);
 assert.equal(result.data.judge.source,'heuristic_fallback','No real model acceptance is claimed by this local fixture.');
});
