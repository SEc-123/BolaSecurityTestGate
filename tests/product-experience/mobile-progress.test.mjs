/** Production mobile flow + SQL + product projection. Android calls and capture writer
 * are explicit test doubles, NOT evidence of a device/Appium/mitmproxy acceptance run. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,appendFile,rm} from 'node:fs/promises';
import {database,readySession,observation,appiumResult,flow,networkExpected} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';
import {runConfiguredMobileFlow} from '../../server/src/services/mobile/mobile-lab-service.ts';
import {updateMobileSession} from '../../server/src/services/mobile/mobile-session-service.ts';
import {AndroidDeviceManager} from '../../server/src/services/mobile/android-device-manager.ts';
const cases=()=>['login','otp'].map(key=>({business_test_id:key,business_name:key==='login'?'登录':'发送验证码',test_name:'页面和加密通信检查',action:'tap',target:{text:'Login'},expect:{text:'Login'},expect_network:networkExpected(),timeout_ms:0}));
async function setup(t,options={}) {
 const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db),steps=cases();
 const run=await repo.createRun({base_url:'https://api.example.test',scan_config:{surface:'android',mobile:{flow_steps:steps}}});await repo.updateRun(run.id,{status:'running'});
 const task=await repo.createTask({scan_run_id:run.id,task_type:'mobile_capture',title:'Internal',status:'running'});
 const {session:original}=await readySession(db);const session=await updateMobileSession(db,original.id,{scan_run_id:run.id});
 t.after(()=>rm(session.health_json.capture.path,{force:true}));t.after(()=>rm(session.health_json.capture.path+'.step.json',{force:true}));
 const events=[];let taps=0,throwFrame=options.throwFrame;
 const realUpsert=repo.upsertProductArtifact.bind(repo);
 t.mock.method(repo,'upsertProductArtifact',async input=>{
   if(throwFrame && input.artifact_type==='assessment_live_frame'){throwFrame=false;throw Error('test write failure');}
   const out=await realUpsert(input);
   const state=buildProductAssessmentState(await repo.getProductSnapshot(run.id));events.push({type:input.artifact_type,value:input.content_json,state});return out;
 });
 t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{
   taps++;if(options.failTap && taps===1)throw Error('test device disconnected');
   if(options.dropCapture)return appiumResult();
   const scope=JSON.parse(await readFile(session.health_json.capture.path+'.step.json','utf8'));
   const f={...flow(session),test_run_id:scope.run_id,step_id:scope.step_id,response_status:options.status||200};
   await appendFile(session.health_json.capture.path,JSON.stringify(f)+'\n');return appiumResult();
 });
 t.mock.method(AndroidDeviceManager.prototype,'observe',async()=>{if(options.badUI)throw Error('test source lost');return {...observation(),session_id:session.id};});
 return {db,repo,steps,task,run,session,events,taps:()=>taps,execute:()=>runConfiguredMobileFlow(db,session.id,steps,repo,task.id),state:async()=>buildProductAssessmentState(await repo.getProductSnapshot(run.id))};
}
test('real producer publishes pending -> running -> completed before entire App test finishes',async t=>{
 const f=await setup(t);const result=await f.execute();assert.equal(result.ok,true,JSON.stringify(result));
 const progress=f.events.filter(e=>e.type==='business_test_progress');
 assert.deepEqual(progress.map(e=>[e.value.test_key,e.value.status]),[['login','pending'],['otp','pending'],['login','running'],['login','completed'],['otp','running'],['otp','completed']]);
 const intermediate=progress.find(e=>e.value.test_key==='login'&&e.value.status==='completed').state;
 assert.equal(intermediate.totals.completed,1);assert.equal(intermediate.totals.pending,1);
 assert.equal((await f.state()).totals.completed,2);assert.equal(f.taps(),2);
 const frames=f.events.filter(e=>e.type==='assessment_live_frame');assert.equal(frames.length,2);
 assert.deepEqual(frames.map(e=>e.state.live_surface?.test_id),['mobile:login','mobile:otp']);
});
test('App producer does not reinterpret an expected 401 as a vulnerability',async t=>{
 const f=await setup(t,{status:401});for(const step of f.steps)step.expect_network[0].response.status=401;
 assert.equal((await f.execute()).ok,true);const state=await f.state();assert.equal(state.totals.completed,2);assert.equal(state.totals.confirmed_risks,0);assert.ok(state.business_functions.flatMap(f=>f.tests).every(t=>t.outcome==='functional'));
});
for(const [label,options]of [['missing HTTPS',{dropCapture:true}],['UI failure',{badUI:true}],['action failure',{failTap:true}],['wrong status',{status:403}]])test(`real producer: ${label} leaves failed and unexecuted cases unstruck`,async t=>{
 const f=await setup(t,options);assert.equal((await f.execute()).ok,false);const state=await f.state();assert.equal(state.totals.completed,0);assert.equal(state.totals.failed,1);assert.equal(state.totals.not_run,1);assert.equal(state.totals.confirmed_risks,0);assert.equal(f.taps(),1);
});
test('retry resets every case before any new device action and does not inherit old green checks',async t=>{
 const f=await setup(t);await f.execute();f.events.length=0;await f.execute();const progress=f.events.filter(e=>e.type==='business_test_progress');
 assert.deepEqual(progress.slice(0,2).map(e=>e.value.status),['pending','pending']);assert.equal(progress[1].state.totals.completed,0);
 assert.equal((await f.state()).totals.completed,2);assert.equal(f.taps(),4);
});
test('a failed first case may continue only when explicitly allowed; next case remains independent',async t=>{
 const f=await setup(t,{failTap:true});f.steps[0].stop_on_error=false;assert.equal((await f.execute()).ok,false);const state=await f.state();assert.equal(state.totals.failed,1);assert.equal(state.totals.completed,1);assert.equal(state.totals.not_run,0);
});
