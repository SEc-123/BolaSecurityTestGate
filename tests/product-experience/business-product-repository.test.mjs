import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { buildProductAssessmentState as project } from '../../server/src/services/ai-scan/product-state-service.ts';

async function setup(t) {
 const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
 const run=await repo.createRun({name:'业务学习测试',base_url:'https://example.test',scan_config:{surface:'web'},selected_vuln_types:[]});
 const feature=await repo.createFeature({scan_run_id:run.id,name:'个人资料',node_type:'function'});
 const task=await repo.createTask({scan_run_id:run.id,title:'正常业务学习',task_type:'discover_business',feature_id:feature.id,status:'running'});
 const add=(artifact_type,content_json,extra={})=>repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type,content_json,...extra});
 return {db,repo,run,feature,task,add};
}
async function experiment(f,extra={}) {
 const planId=extra.planId||'experiment-one',flowId='flow-one';
 await f.add('business_flow',{id:flowId,revision:1,name:'编辑个人资料',goal:'更新后读取实际资料',feature_id:f.feature.id,role:'user',status:'verified',normal_run_id:'normal-run',assertions_verified:true,assertions:[{description:'实际资料正确',passed:true}]},{source_ref:flowId});
 await f.add('agent_experiment_plan',{id:planId,revision:2,flow_id:flowId,source_flow_revision:1,name:'跨账号资料修改',hypothesis:'其他账号是否可以修改私有资料',status:'compiled'},{source_ref:planId});
 const result={id:`result-${planId}`,revision:1,plan_id:planId,plan_revision:2,source_flow_revision:1,flow_id:flowId,status:'executed',
  native_test_run_ids:['control-run','variant-run'],execution_verified:true,control_verified:true,business_invariant_verified:true,evidence_ready:true,distinct_identity_verified:true,
  assertions:[{description:'私有资料被另一账号修改',purpose:'impact',passed:true}],control_assertions:[{description:'正常账号读取成功',purpose:'control',passed:true}],missing_evidence:[],evidence_artifact_ids:['private-native-control-trace','private-native-experiment-trace'],...extra.result};
 await f.add('agent_experiment_result',result,{source_ref:planId});
 const proof=await f.add('business_state_proof',{plan_id:planId,plan_revision:2,result_revision:result.revision,source_flow_revision:1,flow_id:flowId,business_invariant_verified:true,verified:true,execution_verified:true,control_verified:true,private_response:'PRIVATE_RESPONSE',...extra.proof},{source_ref:planId,title:'身份与修改后的资料核对'});
 return {planId,proof,result};
}

test('product SQL admits safe business summaries while excluding private captures, operands and traces',async t=>{
 const f=await setup(t);
 const privateData={headers:{authorization:'PRIVATE_HEADER'},body:'PRIVATE_BODY',trace:{request:'PRIVATE_TRACE'},patches:[{value:'PRIVATE_PATCH'}],
  assertions:[{description:'核对资料状态',passed:true,left:{path:'body.token'},right:{value:'PRIVATE_OPERAND'}}],learning_suggestions:'PRIVATE_LEARNING',raw:'PRIVATE_RAW'};
 for(const type of ['business_flow','business_capture_session','business_workflow_validation','agent_experiment_plan','agent_experiment_result','business_state_proof'])
  await f.add(type,{id:type,flow_id:'flow-one',name:'个人资料',goal:'核对结果',status:'verified',...privateData},{title:'password=PRIVATE_TITLE',content_text:'PRIVATE_TEXT'});
 for(const type of ['business_capture_event','business_native_trace','business_workflow_learning','experiment_native_trace','tool_call_result'])await f.add(type,privateData,{content_text:'PRIVATE_TEXT'});
 const snapshot=await f.repo.getProductSnapshot(f.run.id),encoded=JSON.stringify(snapshot.artifacts);
 assert.equal(snapshot.artifacts.length,6);assert.doesNotMatch(encoded,/PRIVATE_|authorization|headers|body|trace|patches|learning_suggestions|raw|right|left/);
 assert.ok(snapshot.artifacts.every(artifact=>artifact.content_text===undefined));
 assert.equal(snapshot.artifacts.find(a=>a.artifact_type==='business_flow').content_json.assertions[0].passed,true);
 const state=project(snapshot);assert.equal(state.totals.normal_flows,1);assert.equal(state.totals.verified_flows,0);
});
test('a verified model experiment appears without a legacy candidate or backward proof reference',async t=>{
 const f=await setup(t),e=await experiment(f);
 await f.add('ai_judgement',{plan_id:e.planId,flow_id:'flow-one',verdict:'vulnerable',severity:'high',business_title:'其他账号修改了私有资料',business_impact:'另一账号可以修改私有资料。',raw_model:'PRIVATE_MODEL'},{source_ref:e.planId});
 const snapshot=await f.repo.getProductSnapshot(f.run.id),state=project(snapshot);
 assert.equal(snapshot.candidates.length,0);assert.equal(state.totals.confirmed_risks,1);assert.equal(state.totals.tests,0);assert.equal(state.risk_evidence[0].test_id,`experiment:${e.planId}`);
 assert.ok(state.business_functions[0].experiments[0].references.some(ref=>ref.id===e.proof.id&&ref.kind==='evidence'));
 assert.equal(state.business_functions[0].experiments[0].status,'completed');assert.doesNotMatch(JSON.stringify(snapshot.artifacts),/PRIVATE_MODEL|PRIVATE_RESPONSE/);
});
for(const field of ['execution_verified','control_verified','business_invariant_verified','evidence_ready'])test(`missing deterministic ${field} cannot confirm an experimental finding`,async t=>{
 const f=await setup(t),e=await experiment(f,{result:{[field]:false}});
 await f.add('ai_judgement',{plan_id:e.planId,verdict:'vulnerable',experiment_evidence_gate:{verdict:'confirmed'}},{source_ref:e.planId});
 const state=project(await f.repo.getProductSnapshot(f.run.id));assert.equal(state.totals.confirmed_risks,0);assert.equal(state.review_evidence.length,1);
});
test('same-second result revisions cannot attach old proof to a revised plan',async t=>{
 const f=await setup(t),e=await experiment(f);
 await f.add('agent_experiment_plan',{id:e.planId,revision:3,flow_id:'flow-one',name:'另一个字段的检查',hypothesis:'修改新的字段',status:'planned'},{source_ref:e.planId});
 await f.add('ai_judgement',{plan_id:e.planId,verdict:'vulnerable'},{source_ref:e.planId});
 const state=project(await f.repo.getProductSnapshot(f.run.id));assert.equal(state.totals.confirmed_risks,0);assert.equal(state.business_functions[0].experiments[0].status,'pending');
});
test('separate experiments remain separate when their judgments share a task and endpoint',async t=>{
 const f=await setup(t);for(const planId of ['experiment-one','experiment-two']){await experiment(f,{planId});await f.add('ai_judgement',{plan_id:planId,verdict:'vulnerable',business_title:'账号隔离验证'},{source_ref:'same-endpoint'});}
 const state=project(await f.repo.getProductSnapshot(f.run.id));assert.equal(state.totals.confirmed_risks,2);assert.equal(new Set(state.risk_evidence.map(issue=>issue.test_id)).size,2);
});
test('a stored finding without proof remains visible for review and never leaks raw evidence',async t=>{
 const f=await setup(t);
 await f.db.repos.findings.create({id:'orphan-finding',source_type:'ai_scan',ai_scan_run_id:f.run.id,ai_scan_task_id:f.task.id,ai_feature_id:f.feature.id,
  severity:'high',status:'open',title:'资料权限异常',description:'password=PRIVATE_DESCRIPTION',request_raw:'PRIVATE_REQUEST',response_body:'PRIVATE_RESPONSE'});
 const snapshot=await f.repo.getProductSnapshot(f.run.id),state=project(snapshot);
 assert.equal(state.totals.confirmed_risks,0);assert.equal(state.review_evidence.length,1);assert.match(state.review_evidence[0].summary,/缺少可关联的执行/);assert.doesNotMatch(JSON.stringify(snapshot.artifacts),/PRIVATE_/);
});
test('a finding linked to an experimental judgment is reconciled once',async t=>{
 const f=await setup(t),e=await experiment(f);
 const finding=await f.db.repos.findings.create({source_type:'ai_scan',ai_scan_run_id:f.run.id,ai_scan_task_id:f.task.id,severity:'high',status:'open',title:'资料权限异常'});
 await f.add('ai_judgement',{plan_id:e.planId,finding_id:finding.id,verdict:'vulnerable'},{source_ref:e.planId});
 const state=project(await f.repo.getProductSnapshot(f.run.id));assert.equal(state.totals.confirmed_risks,1);assert.equal(state.review_evidence.length,0);
});
test('proof from another assessment does not satisfy experimental confirmation',async t=>{
 const f=await setup(t),e=await experiment(f,{proof:{execution_verified:false}});
 const other=await f.repo.createRun({name:'其他测试',base_url:'https://other.test',scan_config:{surface:'web'},selected_vuln_types:[]});
 const foreign=await f.repo.createArtifact({scan_run_id:other.id,artifact_type:'business_state_proof',source_ref:e.planId,content_json:{plan_id:e.planId,verified:true}});
 await f.add('agent_experiment_result',{...e.result,revision:2,evidence_artifact_ids:[foreign.id]},{source_ref:e.planId});
 await f.add('ai_judgement',{plan_id:e.planId,verdict:'vulnerable'},{source_ref:e.planId});
 const state=project(await f.repo.getProductSnapshot(f.run.id));assert.equal(state.totals.confirmed_risks,0);assert.equal(state.review_evidence.length,1);
});
for(const field of ['plan_revision','source_flow_revision','result_revision'])test(`proof must belong to the execution's ${field}`,async t=>{
 const f=await setup(t),e=await experiment(f,{proof:{[field]:field==='plan_revision'?1:2}});
 await f.add('ai_judgement',{plan_id:e.planId,verdict:'vulnerable'},{source_ref:e.planId});
 const state=project(await f.repo.getProductSnapshot(f.run.id));assert.equal(state.totals.confirmed_risks,0);assert.equal(state.review_evidence.length,1);
});
