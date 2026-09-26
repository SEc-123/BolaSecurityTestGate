import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkflowExecutionPlan} from '../../server/src/services/ai-scan/workflow-context.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';
import {snapshot,now} from './fixtures.mjs';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {buildAIScanToolSpecs} from '../../server/src/agent/tools/ai-scan-tools.ts';
import {rebuildFeatureTree,rebuildVulnerabilityCandidates} from '../../server/src/services/ai-scan/feature-vuln-engine.ts';
const endpoint=(id,method,path)=>({id,method,path,url:'https://app.example'+path,request_summary:'',response_summary:'',feature_guess:'',auth_required:false});

test('captured public search is executable without unrelated upload or login prerequisites',()=>{
 const endpoints=[endpoint('search','GET','/search?q=baseline'),endpoint('upload','POST','/upload'),endpoint('login','POST','/login'),endpoint('refund','POST','/refund')];
 const p=buildWorkflowExecutionPlan({allEndpoints:endpoints,selectedEndpointIds:['search'],vulnType:'xss',sharedLoginEndpointIds:['login']});
 assert.deepEqual(p.endpoint_ids,['search']);assert.deepEqual(p.missing_preconditions,[]);
});
test('explicitly selected prerequisite survives when the highest-ranked target is first',()=>{
 const endpoints=[endpoint('refund','POST','/refund?order_id=1'),endpoint('pay','POST','/pay?order_id=1')];
 const p=buildWorkflowExecutionPlan({allEndpoints:endpoints,selectedEndpointIds:['refund','pay'],vulnType:'state_machine_race',hasConfiguredIdentity:true});
 assert.equal(p.target_endpoint_id,'refund');assert.ok(p.endpoint_ids.includes('pay'));
});
test('unselected candidates do not add skipped tests or reduce the selected scope progress',()=>{
 const s=snapshot();s.run.selected_vuln_types=['xss'];s.tasks=[];s.candidates[0].vuln_type='bola_idor';
 assert.equal(buildProductAssessmentState(s,now).totals.tests,0);
});
test('captured object_id satisfies object lookup context while an absent object remains blocked',()=>{
 for(const hasObject of [true,false]){
  const e=endpoint('object','GET','/api/documents'+(hasObject?'?object_id=101':''));e.auth_required=true;
  const plan=buildWorkflowExecutionPlan({allEndpoints:[e],selectedEndpointIds:[e.id],vulnType:'bola_idor',hasConfiguredIdentity:true});
  assert.equal(plan.missing_preconditions.some(x=>x.includes('object_id')),!hasObject);
 }
});
test('actual planner blocks URL-only references and does not append unrelated shared login requests',async t=>{
 const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:'https://app.example',selected_vuln_types:['bola_idor'],scan_config:{accounts:{attacker:{authorization:'Bearer fixture-only',user_id:'1',object_id:'101'}}}});
 const observed=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/api/documents',url:'https://app.example/api/documents?object_id=101',source_type:'browser_network',auth_required:true});
 await repo.saveCapturedRequest(observed,{method:'GET',url:observed.url,headers:{authorization:'Bearer fixture-only'},body:null,response_status:200,source:'browser',captured_at:new Date().toISOString()});
 const missing=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/api/orders',url:'https://app.example/api/orders?object_id=202',source_type:'browser_js_reference',auth_required:true});
 const login=await repo.upsertEndpoint({scan_run_id:run.id,method:'POST',path:'/api/login',url:'https://app.example/api/login',source_type:'browser_js_reference'});
 await rebuildFeatureTree(repo,run.id);await rebuildVulnerabilityCandidates(repo,run.id);
 await buildAIScanToolSpecs().find(s=>s.name==='task.expand_selected_vulnerabilities').handler({selected_vuln_types:['bola_idor']},{db,repo,scanRunId:run.id});
 const tasks=(await repo.listTasks(run.id)).filter(t=>t.task_type==='test_generic_vuln');
 const ready=tasks.find(t=>t.execution_plan.workflow_execution_plan.target_endpoint_id===observed.id);
 const blocked=tasks.find(t=>t.execution_plan.workflow_execution_plan.target_endpoint_id===missing.id);
 assert.ok(ready);assert.equal(ready.status,'pending');assert.deepEqual(ready.endpoint_ids,[observed.id]);assert.ok(!ready.endpoint_ids.includes(login.id));
 assert.ok(blocked);assert.equal(blocked.status,'blocked');assert.match(blocked.result_summary,/完整业务请求/);
});
