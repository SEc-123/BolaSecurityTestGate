import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProductAssessmentState as project } from '../../server/src/services/ai-scan/product-state-service.ts';
import { snapshot, judge, now, time } from './fixtures.mjs';
import { businessReport } from '../../src/lib/business-report.ts';

const artifact = (type, data, options={}) => ({id:`${type}-record`,scan_run_id:'run-a',task_id:'task-0',artifact_type:type,created_at:time,updated_at:time,content_json:data,...options});
const flow = (extra={},options={}) => artifact('business_flow',{id:'normal-1',feature_id:'feature-0',name:'正常登录',goal:'登录后核对账号身份',status:'discovered',steps:[{id:'step-1',name:'提交登录'}],...extra},options);
const flowsOf = state => state.business_functions.flatMap(feature=>feature.normal_flows||[]);
const experimentsOf = state => state.business_functions.flatMap(feature=>feature.experiments||[]);

test('verified vulnerability checks never fabricate a normal-flow baseline',()=>{
 const s=snapshot();s.tasks[0].status='completed';s.artifacts=[judge()];
 const state=project(s,now);assert.equal(state.totals.completed,1);assert.equal(flowsOf(state).length,0);assert.equal(state.totals.verified_flows,undefined);
});
test('normal-flow verification needs execution and business evidence, independent of selected tests',()=>{
 const s=snapshot();s.artifacts=[flow({status:'verified',normal_run_id:'run-normal'})];
 let state=project(s,now);assert.equal(flowsOf(state)[0].status,'review');assert.equal(state.totals.verified_flows,0);assert.match(flowsOf(state)[0].blockers[0],/执行记录或业务结果/);
 s.artifacts[0].content_json.assertions=[{name:'账号身份正确',passed:true}];s.artifacts[0].content_json.assertions_verified=true;
 state=project(s,now);assert.equal(flowsOf(state)[0].status,'verified');assert.equal(state.totals.verified_flows,1);assert.equal(state.totals.completed,0);assert.equal(state.totals.confirmed_risks,0);assert.equal(state.business_functions.length,1);
 s.artifacts[0].content_json.assertions=[{name:'账号身份正确',passed:false}];s.artifacts[0].content_json.baseline_verified=true;
 assert.equal(flowsOf(project(s,now))[0].status,'review');
});
test('append-only normal-flow revisions outrank same-second timestamps and artifact identifiers',()=>{
 const s=snapshot();s.artifacts=[flow({revision:1,status:'verified',normal_run_id:'normal-run',assertions_verified:true},{id:'zzzz'}),flow({revision:2,status:'blocked',blockers:['缺少账号']},{id:'aaaa'})];
 const [latest]=flowsOf(project(s,now));assert.equal(latest.status,'blocked');assert.deepEqual(latest.blockers,['缺少账号']);
});
test('current normal-flow revisions cannot use model assertion flags or legacy baseline flags as proof',()=>{
 const s=snapshot();s.artifacts=[flow({revision:2,status:'verified',normal_run_id:'normal-run',baseline_verified:true,assertions:[{name:'模型判断成功',passed:true}]})];
 assert.equal(flowsOf(project(s,now))[0].status,'review');
 s.artifacts[0].content_json.assertions_verified=true;assert.equal(flowsOf(project(s,now))[0].status,'verified');
});
test('newest normal-flow result supersedes earlier success and retains actual condition gaps',()=>{
 const s=snapshot();s.artifacts=[flow({status:'verified',normal_run_id:'run-normal',assertions_verified:true}),flow({status:'blocked',blockers:['测试账号缺少下单权限']},{id:'latest',updated_at:new Date(now+1000).toISOString()})];
 const state=project(s,now);assert.equal(flowsOf(state).length,1);assert.equal(flowsOf(state)[0].status,'blocked');assert.deepEqual(flowsOf(state)[0].blockers,['测试账号缺少下单权限']);assert.equal(state.totals.verified_flows,0);
 assert.equal(state.business_functions[0].status,'blocked');
});
test('learning and never-run normal flows remain separate after the run stops',()=>{
 const s=snapshot();s.artifacts=[flow({status:'learning'}),flow({id:'normal-2',name:'更新个人资料'},{id:'second'})];
 let state=project(s,now);assert.equal(state.current_work[0].id,'flow:normal-1');assert.deepEqual(flowsOf(state).map(f=>f.status),['learning','not_run']);
 s.run.status='completed';state=project(s,now);assert.deepEqual(flowsOf(state).map(f=>f.status),['failed','not_run']);assert.equal(state.totals.verified_flows,0);
});
test('an experiment plan alone cannot claim execution or confirmation',()=>{
 const s=snapshot();s.artifacts=[flow(),artifact('agent_experiment_plan',{id:'experiment-1',flow_id:'normal-1',hypothesis:'其他账号能否修改该对象',status:'completed',native_test_run_ids:['made-up-run']})];
 const state=project(s,now);assert.equal(experimentsOf(state)[0].status,'pending');assert.equal(experimentsOf(state)[0].references.length,0);assert.equal(state.totals.confirmed_risks,0);assert.equal(state.totals.experiments,1);
});
test('actual experiment result exposes execution references without inventing a vulnerability verdict',()=>{
 const s=snapshot();s.artifacts=[flow(),artifact('agent_experiment_plan',{id:'experiment-1',flow_id:'normal-1',hypothesis:'其他账号能否修改该对象'}),artifact('agent_experiment_result',{plan_id:'experiment-1',status:'completed',native_test_run_ids:['run-experiment'],evidence_artifact_ids:['proof','foreign','absent']}),artifact('business_state_proof',{}, {id:'proof',title:'修改后的对象状态'}),artifact('business_state_proof',{}, {id:'foreign',scan_run_id:'another-run'})];
 const state=project(s,now),[experiment]=experimentsOf(state);assert.equal(experiment.status,'completed');assert.equal(experiment.flow_id,'normal-1');assert.equal(experiment.hypothesis,'其他账号能否修改该对象');assert.deepEqual(experiment.references.map(ref=>ref.id),['run-experiment','proof']);assert.equal(state.totals.confirmed_risks,0);assert.equal(state.totals.completed,0);
});
test('a revised experiment cannot inherit an older execution result',()=>{
 const s=snapshot();s.artifacts=[flow(),artifact('agent_experiment_result',{plan_id:'experiment-1',status:'completed',native_test_run_ids:['old-run']}),artifact('agent_experiment_plan',{id:'experiment-1',flow_id:'normal-1',hypothesis:'修改新的字段'},{updated_at:new Date(now+1000).toISOString()})];
 const [experiment]=experimentsOf(project(s,now));assert.equal(experiment.status,'pending');assert.equal(experiment.references.length,0);
});
test('normal-flow and experiment projection strips raw request data, private fields and technical summaries',()=>{
 const s=snapshot();s.artifacts=[flow({name:'token=PRIVATE',goal:'{"password":"PRIVATE"}',role:'Bearer PRIVATE',status:'blocked',blockers:['password=PRIVATE'],raw_request:'PRIVATE',steps:[{name:'cookie=PRIVATE',request:'PRIVATE'}],assertions:[{name:'secret=PRIVATE',expected:'PRIVATE'}]}),artifact('agent_experiment_plan',{id:'experiment-1',flow_id:'normal-1',hypothesis:'token=PRIVATE',payload:'PRIVATE'})];
 const state=project(s,now);assert.doesNotMatch(JSON.stringify(state),/PRIVATE|raw_request|payload|expected/);assert.equal(flowsOf(state)[0].name,'登录');assert.equal(experimentsOf(state)[0].hypothesis,'实验假设尚未记录。');
});
test('export preserves normal-flow verification, experimental status, gaps and references separately',()=>{
 const s=snapshot(0);s.artifacts=[flow({status:'verified',normal_run_id:'normal-run',assertions_verified:true}),flow({id:'normal-2',name:'正常下单',status:'blocked',blockers:['缺少可用库存']},{id:'second'}),artifact('agent_experiment_plan',{id:'experiment-1',flow_id:'normal-1',hypothesis:'跨账号对象访问',status:'pending'})];
 const state=project(s,now),report=businessReport(state);assert.match(report,/正常流程已验证 1 \/ 2/);assert.match(report,/\[x\] 正常登录/);assert.match(report,/\[ \] 正常下单/);assert.match(report,/缺少可用库存/);assert.match(report,/normal-run/);assert.match(report,/假设：跨账号对象访问/);assert.match(report,/实验执行不等于确认漏洞/);assert.match(state.notice,/尚无已完成的安全检查结论/);
});
