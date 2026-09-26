/** Component/integration contracts with explicit device doubles; not Android acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startMobileLiveObserver} from '../../server/src/services/mobile/mobile-live-observer.ts';
import {database,readySession,PNG,pkg,observation,appiumResult} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';
import {runDiscoveryAction} from '../../server/src/services/mobile/mobile-lab-service.ts';
import {updateMobileSession} from '../../server/src/services/mobile/mobile-session-service.ts';
import {AndroidDeviceManager} from '../../server/src/services/mobile/android-device-manager.ts';
const frame=()=>({device_id:'test-device',package:pkg,observed_at:new Date().toISOString(),screenshot_base64:PNG});
const options=sample=>({repo:{upsertProductArtifact:async()=>{}},scanRunId:'run',taskId:'task',operationId:'op',sessionId:'session',deviceId:'test-device',appPackage:pkg,sample,intervalMs:250});
test('display observer continues sampling while the control operation is pending and stops explicitly',async()=>{
 const writes=[];let samples=0;
 const stop=startMobileLiveObserver({...options(async()=>{samples++;return frame();}),repo:{upsertProductArtifact:async value=>writes.push(value)}});
 await delay(280);assert.ok(samples>=2);assert.ok(writes.every(w=>w.content_json.observing&&w.content_json.preview_only));
 await stop();const count=samples;await delay(280);assert.equal(samples,count);assert.equal(writes.at(-1).content_json.observing,false);
 assert.ok(writes.every(w=>w.content_json.operation_id==='op'&&w.content_text===PNG));
});
test('a slow display reader never overlaps and cannot write after stop',async()=>{
 let release,calls=0;const writes=[];
 const wait=new Promise(resolve=>release=resolve);
 const stop=startMobileLiveObserver({...options(async()=>{calls++;await wait;return frame();}),repo:{upsertProductArtifact:async value=>writes.push(value)}});
 await delay(280);assert.equal(calls,1);const stopped=stop();release();await stopped;assert.deepEqual(writes,[]);
});
for(const reason of ['wrong-device','wrong-package','error'])test(`display observer cannot publish ${reason}`,async()=>{
 const writes=[];const stop=startMobileLiveObserver({...options(async()=>{if(reason==='error')throw Error('lost device');return {...frame(),...(reason==='wrong-device'?{device_id:'other'}:{package:'other.app'})};}),repo:{upsertProductArtifact:async value=>writes.push(value)}});
 await delay(20);await stop();assert.deepEqual(writes,[]);
});
test('real SQL producer exposes running action and fresh display before Appium action returns; no typed secret enters public state',async t=>{
 const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:'https://api.example.test',scan_config:{surface:'android'}});await repo.updateRun(run.id,{status:'running'});
 const task=await repo.createTask({scan_run_id:run.id,task_type:'mobile_capture',title:'Acquisition',status:'running'});
 const {session:raw}=await readySession(db);
 const session=await updateMobileSession(db,raw.id,{scan_run_id:run.id,health_json:{details:{device:{ok:true}}}});
 let release,started;const entered=new Promise(resolve=>started=resolve),waiting=new Promise(resolve=>release=resolve);
 t.mock.method(AndroidDeviceManager.prototype,'inputText',async()=>{started();await waiting;return appiumResult();});
 t.mock.method(AndroidDeviceManager.prototype,'observe',async()=>observation());
 t.mock.method(AndroidDeviceManager.prototype,'observeDisplay',async()=>frame());
 const action=runDiscoveryAction(db,session.id,{action:'fill',target:{resourceId:'password'},value:'PRIVATE_PASSWORD',expect:{package:pkg}},'acquisition-run',repo,task.id);
 await entered;await delay(30);
 const current=buildProductAssessmentState(await repo.getProductSnapshot(run.id));
 assert.equal(current.operations.length,1);assert.equal(current.operations[0].status,'running');
 assert.equal(current.live_surface.state,'live');assert.equal(current.live_surface.operation_id,current.operations[0].id);
 assert.equal(current.totals.completed,0);assert.doesNotMatch(JSON.stringify(current),/PRIVATE_PASSWORD|password/);
 release();assert.equal((await action).ok,true);
 const finished=buildProductAssessmentState(await repo.getProductSnapshot(run.id));
 assert.equal(finished.operations[0].status,'completed');assert.notEqual(finished.live_surface.state,'live');assert.equal(finished.totals.completed,0);
 assert.ok(finished.frames.some(f=>f.operation_id===finished.operations[0].id));
});
test('a stopped run turns an unfinished operation into interrupted instead of a permanent spinner',async t=>{
 const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:'https://api.example.test',scan_config:{surface:'android'}});
 await repo.upsertProductArtifact({scan_run_id:run.id,key:'op',artifact_type:'mobile_action_progress',content_json:{operation_id:'op',status:'running',title:'点击控件'}});
 await repo.updateRun(run.id,{status:'failed'});const state=buildProductAssessmentState(await repo.getProductSnapshot(run.id));
 assert.equal(state.operations[0].status,'interrupted');assert.equal(state.totals.completed,0);
});
