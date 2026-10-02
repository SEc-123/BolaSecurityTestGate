import test from 'node:test';
import assert from 'node:assert/strict';
import { database, PNG, profile, pkg, networkExpected } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { buildProductAssessmentState } from '../../server/src/services/ai-scan/product-state-service.ts';
import { productEventHub } from '../../server/src/services/ai-scan/product-event-hub.ts';
import { startBrowserLiveObserver } from '../../server/src/services/ai-scan/browser/live-observer.ts';
import { publicMobileProfile,resolveMobileBusinessSelection } from '../../server/src/services/mobile/mobile-business-scenarios.ts';
import { businessReport } from '../../src/lib/business-report.ts';
import { snapshot,judge,now } from './fixtures.mjs';
const tick=()=>new Promise(r=>setTimeout(r,20));
async function setup(t){const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);const run=await repo.createRun({base_url:'https://api.example.test',name:'登录',scan_config:{surface:'web',accounts:{password:'SECRET'}},selected_vuln_types:['bola_idor']});return{db,repo,run};}
test('real product snapshot retains only campaign sample IDs and closes unsampled candidates',async t=>{
 const {repo,run}=await setup(t);
 const selected=await repo.createCandidate({scan_run_id:run.id,vuln_type:'bola_idor',title:'Selected',endpoint_ids:['endpoint-1']});
 const unsampled=await repo.createCandidate({scan_run_id:run.id,vuln_type:'bola_idor',title:'Unsampled',endpoint_ids:['endpoint-1']});
 await repo.createArtifact({scan_run_id:run.id,artifact_type:'vulnerability_campaign_plan',title:'SECRET',content_json:{vuln_type:'bola_idor',selected_candidates:[{id:selected.id,reason:'SECRET'}],private_prompt:'SECRET'}});
 await repo.updateRun(run.id,{status:'completed'});
 const projected=await repo.getProductSnapshot(run.id);
 const plan=projected.artifacts.find(a=>a.artifact_type==='vulnerability_campaign_plan');
 assert.deepEqual(plan.content_json,{vuln_type:'bola_idor',selected_candidates:[{id:selected.id}]});
 assert.doesNotMatch(JSON.stringify(plan),/SECRET/);
 const state=buildProductAssessmentState(projected,now);
 assert.equal(state.business_functions.flatMap(f=>f.tests).find(x=>x.id===`test:${unsampled.id}`).status,'skipped');
 assert.equal(state.business_functions.flatMap(f=>f.tests).find(x=>x.id===`test:${selected.id}`).status,'not_run');
});
test('REAL repository persists bounded progress and frame slots; public state excludes private artifacts',async t=>{
 const{repo,run}=await setup(t);const task=await repo.createTask({scan_run_id:run.id,title:'Engine',task_type:'test',vuln_type:'bola_idor',status:'running'});
 for(let i=0;i<4;i++)await repo.upsertProductArtifact({scan_run_id:run.id,task_id:task.id,key:'web',artifact_type:'assessment_live_frame',content_json:{surface:'web',observed_at:new Date().toISOString()},content_text:PNG});
 await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'tool_call_result',title:'SECRET',content_json:{raw:'SECRET'},content_text:'SECRET'});
 const data=await repo.getProductSnapshot(run.id);assert.equal(data.artifacts.length,1);assert.equal(data.artifacts[0].content_text,'available');const p=buildProductAssessmentState(data);assert.equal(p.frames.length,1);assert.doesNotMatch(JSON.stringify(p),/SECRET|accounts|tool_call_result/);
 assert.equal((await repo.getProductFrame(run.id,data.artifacts[0].id)).content_text,PNG);assert.equal(await repo.getProductFrame('other-run',data.artifacts[0].id),null);
});
test('product snapshot reduces a persisted provider denial to a safe classification used by diagnostics',async t=>{
 const{repo,run}=await setup(t);const task=await repo.createTask({scan_run_id:run.id,title:'内部决策名称',task_type:'test',vuln_type:'bola_idor',status:'failed'});
 await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'agent_decision',title:'PRIVATE_DECISION_TITLE',content_text:'PRIVATE_DECISION_TEXT',content_json:{source:'fallback',reason:'This content was flagged for possible cybersecurity risk. Apply for Daybreak access before retrying.',raw_response:'PRIVATE_PROVIDER_RESPONSE',arguments:{password:'PRIVATE_PASSWORD'}}});
 await repo.updateRun(run.id,{status:'failed'});const snapshot=await repo.getProductSnapshot(run.id),decision=snapshot.artifacts.find(a=>a.artifact_type==='agent_decision');
 assert.deepEqual(decision.content_json,{source:'fallback',provider_access_denied:true});assert.equal(decision.title,undefined);assert.equal(decision.content_text,undefined);
 const state=buildProductAssessmentState(snapshot);assert.equal(state.run.status,'failed');assert.equal(state.totals.completed,0);assert.equal(state.totals.confirmed_risks,0);assert.match(state.diagnostics[0].message,/安全分析未完成/);
 assert.doesNotMatch(JSON.stringify(state),/Daybreak|PRIVATE_DECISION|PRIVATE_PROVIDER_RESPONSE|PRIVATE_PASSWORD|provider_access_denied/);
});
test('repository publishes task creation, progress changes, and durable artifacts to only that run',async t=>{
 const{repo,run}=await setup(t);let calls=0;const off=productEventHub.subscribe(run.id,()=>calls++);t.after(off);
 const task=await repo.createTask({scan_run_id:run.id,title:'登录',task_type:'test'});assert.ok(calls>0);const before=calls;
 await repo.updateTask(task.id,{status:'running'});assert.ok(calls>before);
 await repo.upsertProductArtifact({scan_run_id:run.id,task_id:task.id,key:'login',artifact_type:'business_test_progress',content_json:{test_key:'login',status:'running'}});
 assert.equal((await repo.getProductSnapshot(run.id)).artifacts[0].content_json.status,'running');
});
test('one-shot observer reads actual supplied page, masks secrets and marks stop; never invokes a UI mutation',async()=>{
 const values=[];let screenshots=0;const stop=startBrowserLiveObserver({scanRunId:'a',taskId:'t',repo:{upsertProductArtifact:async v=>values.push(v)},page:{locator:s=>s,screenshot:async options=>{screenshots++;assert.equal(options.fullPage,false);assert.match(options.mask[0],/password/);return Buffer.from(PNG,'base64');}}});
 await tick();await stop();const n=screenshots;await tick();assert.equal(screenshots,n);assert.ok(values.length>=2);assert.equal(values.at(-1).content_json.observing,false);assert.equal(values[0].content_text,PNG);
});
test('observer has at most one outstanding screenshot and closes safely',async()=>{let resolve,calls=0;const pending=new Promise(r=>resolve=r);const values=[];const stop=startBrowserLiveObserver({scanRunId:'a',intervalMs:500,repo:{upsertProductArtifact:async v=>values.push(v)},page:{screenshot:()=>{calls++;return pending;}}});await new Promise(r=>setTimeout(r,550));assert.equal(calls,1);const end=stop();resolve(Buffer.from(PNG,'base64'));await end;assert.equal(values.length,0);});
test('failed screenshot never fabricates a frame or changes execution outcome',async()=>{const frames=[];const stop=startBrowserLiveObserver({scanRunId:'a',repo:{upsertProductArtifact:async f=>frames.push(f)},page:{screenshot:async()=>{throw new Error('closed');}}});await tick();await stop();assert.equal(frames.length,0);});
function selection(){const p=profile();const step={action:'tap',target:{text:'Login'},expect:{text:'Login'},expect_network:networkExpected()};p.config_json.business_scenarios=[{id:'login',business_name:'登录',test_name:'正确密码登录',app_package:pkg,steps:[step]},{id:'logout',business_name:'退出登录',test_name:'退出后拒绝访问',app_package:pkg,depends_on:['login'],steps:[step]}];return{profile:p,app:{id:'a',signature_verified:true,package_name:pkg,launch_activity:'.MainActivity',signer_sha256:'b'.repeat(64),apk_path:'/test/app.apk',apk_source:'authorized',sha256:'a'.repeat(64)},scenarioIds:['logout'],authorized:true,baseUrl:'https://api.example.test'};}
test('business selection expands dependencies and produces server-owned executable actions',()=>{const s=selection();const p=resolveMobileBusinessSelection(s);assert.deepEqual(p.scenario_ids,['login','logout']);assert.equal(p.flow_steps[0].business_test_id,'login');assert.equal(p.flow_steps[1].business_test_id,'logout');assert.ok(p.flow_steps[0].expect_network.length);});
test('profile picker never exposes actions, selectors, secrets or device commands',()=>{const s=selection();s.profile.config_json.secret='SECRET';s.profile.config_json.business_scenarios[0].steps[0].value='SECRET';const result=publicMobileProfile(s.profile);assert.equal(result.scenarios.length,2);assert.doesNotMatch(JSON.stringify(result),/SECRET|steps|expect_network|adb_serial|appium_server_url/);});
for(const [name,mutate] of [
 ['authorization',s=>s.authorized=false],['HTTP',s=>s.baseUrl='http://api.example.test'],['wrong host',s=>s.baseUrl='https://other.test'],
 ['wrong package',s=>s.app.package_name='wrong.app'],['unknown case',s=>s.scenarioIds=['absent']],
 ['unverified APK',s=>s.app.signature_verified=false],['disabled profile',s=>s.profile.is_enabled=false],['simulator',s=>s.profile.config_json.offline_simulator=true],
 ['cycle',s=>s.profile.config_json.business_scenarios[0].depends_on=['logout']],['duplicate IDs',s=>s.profile.config_json.business_scenarios.push(s.profile.config_json.business_scenarios[0])],
 ['no network assertion',s=>delete s.profile.config_json.business_scenarios[0].steps[0].expect_network],
 ['empty UI assertion',s=>s.profile.config_json.business_scenarios[0].steps[0].expect={}],
 ])test(`business selection blocks ${name}`,()=>{const s=selection();mutate(s);assert.throws(()=>resolveMobileBusinessSelection(s));});
test('business report keeps checked vulnerable tests and uncompleted tests distinct',()=>{const s=snapshot(3);s.tasks[0].status='completed';s.artifacts.push(judge(0,'vulnerable'));s.tasks[1].status='skipped';const text=businessReport(buildProductAssessmentState(s,now));assert.match(text,/- \[x\]/);assert.match(text,/- \[ \]/);assert.match(text,/已确认的问题/);assert.match(text,/已跳过/);assert.doesNotMatch(text,/workflow|mutation|learning|SECRET/);});

test('empty scenario selection enables bounded real discovery, not fake business assertion completion',()=>{const s=selection();s.scenarioIds=[];const result=resolveMobileBusinessSelection(s);assert.equal(result.acquisition_mode,'explore');assert.equal(result.max_exploration_steps,30);assert.deepEqual(result.flow_steps,[]);assert.equal(result.evidence_mode,'device_discovery');});
test('scenario picker preserves valid package identifiers even when they resemble internal tool labels',()=>{
 const s=selection();s.profile.config_json.business_scenarios[0].app_package='com.bstg.acceptance';
 assert.equal(publicMobileProfile(s.profile).scenarios[0].app_package,'com.bstg.acceptance');
});
test('an unbound lab derives scenario host scope from the authorized URL but rejects other hosts',()=>{
 const s=selection();s.profile.config_json.capture_allowed_hosts=[];
 assert.ok(resolveMobileBusinessSelection(s).flow_steps.length);
 s.profile.config_json.business_scenarios[0].steps[0].expect_network=[{...networkExpected()[0],url:'https://outside.example/orders'}];
 assert.throws(()=>resolveMobileBusinessSelection(s));
});
test('persistent browser evidence never enters a product frame list or product-frame read path',async t=>{
 const{repo,run}=await setup(t);const task=await repo.createTask({scan_run_id:run.id,title:'页面检查',task_type:'test',status:'running'});
 const liveId=`product:${run.id}:${task.id}:assessment_live_frame:public`;
 await repo.upsertProductArtifact({scan_run_id:run.id,task_id:task.id,key:'public',artifact_type:'assessment_live_frame',content_json:{surface:'web',observing:true,observed_at:new Date().toISOString()},content_text:PNG});
 const browserState=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'browser_state',title:'Private browser state',content_json:{mode:'playwright'},content_text:PNG});
 const browserAgentState=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'browser_agent_state',title:'Private browser agent state',content_json:{mode:'playwright'},content_text:PNG});
 const browserProof=await repo.createArtifact({scan_run_id:run.id,task_id:task.id,artifact_type:'browser_execution_proof',title:'Private browser execution proof',content_json:{verified:true},content_text:PNG});
 const snapshot=await repo.getProductSnapshot(run.id);
 assert.ok(snapshot.artifacts.some(artifact=>artifact.id===liveId&&artifact.artifact_type==='assessment_live_frame'&&artifact.content_text==='available'));
 for(const artifact of [browserState,browserAgentState,browserProof]){
   assert.equal(snapshot.artifacts.some(item=>item.id===artifact.id),false);
   assert.equal(await repo.getProductFrame(run.id,artifact.id),null);
 }
 assert.equal((await repo.getProductFrame(run.id,liveId))?.content_text,PNG);
 const state=buildProductAssessmentState(snapshot,now);
 assert.deepEqual(state.frames.map(frame=>frame.id),[liveId]);
});
