/** Synthetic artifact protocol fixtures only. Passing these is NOT device acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { verifyRealAndroidEvidence } from '../mobile-lab/assert-real-emulator-e2e.mjs';
import { PNG } from './fixtures.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function artifactFixture(t, mutate=()=>{}) {
 const dir=await mkdtemp(path.join(os.tmpdir(),'bstg-verifier-protocol-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const start='2026-01-01T00:00:00.000Z',when='2026-01-01T00:00:01.000Z';
 const ids={mobile_session_id:'m',recording_session_id:'r',workflow_draft_id:'d',workflow_id:'w',environment_id:'e',test_run_id:'t',security_run_id:'g'};
 const flow={method:'GET',url:'https://api.example.test/orders',response_status:200,tls_decrypted:true,app_package:'fixture.app',device_id:'fixture-device',capture_session_id:'c',started_at:when};
 const actions=[{id:'a',session_id:'m',status:'completed'}];
 const data={
  'profile-upsert':{id:'p',config_json:{strict_real_e2e:true,capture_allowed_hosts:['api.example.test']}},
  'apk-upload':{sha256:'a'.repeat(64)},
  'mobile-session':{id:'m',profile_id:'p',device_id:'fixture-device',app_package:'fixture.app',apk_package_name:'fixture.app',apk_sha256:'a'.repeat(64),apk_signer_sha256:'b'.repeat(64),apk_source:'synthetic protocol test'},
  'mobile-prepare':{health:{status:'ready'},session:{certificate_evidence:{install_verified:true}}},
  'apk-install':{ok:true},'apk-launch':{ok:true},
  'mobile-flow':{ok:true,steps_executed:1,results:[{ok:true,action_id:'a'}]},
  'mobile-observe':{package:'fixture.app',observed_at:when,ui_tree:[{text:'fixture'}],screenshot_base64:PNG},
  'mobile-health':{status:'ready',capture_status:'https_decrypted'},
  'capture-import':{recording_session_id:'r',accepted_flows:1,workflow_draft_count:1,evidence_sha256:sha(JSON.stringify([flow]))},
  'capture-evidence':{session_id:'m',capture_session_id:'c',evidence_level:'session_bound_device_capture',flows:[flow],sha256:sha(JSON.stringify([flow]))},
  'recording-detail':{session:{id:'r'},events:[{}],workflow_drafts:[{id:'d'}]},
  'workflow-publish':{published_from_draft_id:'d',workflow:{id:'w',source_recording_session_id:'r',baseline_config:{capture_replay_only:true}}},
  'environment':{id:'e'},'workflow-run':{success:true,has_execution_error:false,errors_count:0,test_run_id:'t',findings_count:0},
  'test-run':{id:'t',workflow_id:'w',environment_id:'e',status:'completed',progress:{completed:1}},'findings':[],
  'gate-run':{success:true,security_run_id:'g',gate_result:'PASS',exit_code:0},'security-run':{id:'g',gate_result:'PASS',exit_code:0,status:'completed'},
  'stop':{ok:true},'final-session':{session:{id:'m',status:'stopped',health_json:{capture:{id:'c',started_at:start},cleanup:{ok:true}}},actions},
 };
 const extra={'flow-input.json':JSON.stringify({steps:[{action:'tap',target:{text:'fixture'},expect:{text:'fixture'}}]}),'ui-tree.json':JSON.stringify(data['mobile-observe'].ui_tree),'app-screen.png':Buffer.from(PNG,'base64')};
 mutate(data,extra);
 const report={fixture_only:true,ok:true,started_at:start,finished_at:'2026-01-01T00:00:02.000Z',expected_gate:'PASS',ids,files:{}};
 for(const [key,value] of Object.entries(data))extra[key+'.json']=JSON.stringify({data:value,error:null});
 for(const [name,bytes] of Object.entries(extra)){await writeFile(path.join(dir,name),bytes);report.files[name]=sha(bytes);}
 await writeFile(path.join(dir,'report.json'),JSON.stringify(report));return dir;
}
test('verifier accepts a consistent SYNTHETIC protocol fixture (not hardware proof)',async t=>{const dir=await artifactFixture(t);const r=await verifyRealAndroidEvidence(dir);assert.equal(r.ok,true,JSON.stringify(r.errors));assert.ok(r.checks_passed>40);});
for(const [name,mutate] of [
 ['simulator',d=>d['profile-upsert'].config_json.offline_simulator=true],
 ['empty flow',(d,e)=>{e['flow-input.json']='{"steps":[]}';d['mobile-flow']={ok:true,steps_executed:0,results:[]};}],
 ['wrong device',d=>d['capture-evidence'].flows[0].device_id='other-device'],
 ['old nonce',d=>d['capture-evidence'].flows[0].capture_session_id='old'],
 ['stale request',d=>d['capture-evidence'].flows[0].started_at='2025-01-01T00:00:00Z'],
 ['fake vulnerability',d=>d.findings.push({id:'not-an-actual-vulnerability'})],
 ['cleanup failure',d=>d.stop.ok=false],
 ['foreign published workflow',d=>d['workflow-publish'].workflow.source_recording_session_id='other-recording'],
]) test(`verifier rejects ${name}, even when manifest hashes are recomputed`,async t=>{const dir=await artifactFixture(t,mutate);assert.equal((await verifyRealAndroidEvidence(dir)).ok,false);});
test('verifier detects post-run evidence tampering',async t=>{const dir=await artifactFixture(t);await writeFile(path.join(dir,'app-screen.png'),'tampered');assert.equal((await verifyRealAndroidEvidence(dir)).ok,false);});
test('real-device CLI refuses unauthorized execution; writes failed report, including nested new artifact path',async t=>{
 const parent=await mkdtemp(path.join(os.tmpdir(),'bstg-real-preflight-'));t.after(()=>rm(parent,{recursive:true,force:true}));const dir=path.join(parent,'nested','run');
 const child=spawnSync(process.execPath,['scripts/mobile-lab/run-real-android-e2e.mjs'],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8',env:{...process.env,BSTG_E2E_AUTHORIZED:'false',BSTG_E2E_ARTIFACT_DIR:dir},timeout:10000});
 assert.equal(child.status,1);const report=JSON.parse(await readFile(path.join(dir,'report.json'),'utf8'));assert.equal(report.ok,false);assert.equal(report.evidence_level,'not_verified');assert.match(report.errors[0],/AUTHORIZED/);assert.equal(report.requests.length,0);
});
