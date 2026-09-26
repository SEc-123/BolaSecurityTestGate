import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { database, readySession, observation, flow, pkg, profile, appiumResult, networkExpected } from './fixtures.mjs';
import { createMobileSession, updateMobileSession, getMobileSession, listMobileActions } from '../../server/src/services/mobile/mobile-session-service.ts';
import { upsertMobileProfile, getMobileProfile } from '../../server/src/services/mobile/mobile-profile-service.ts';
import { AndroidDeviceManager } from '../../server/src/services/mobile/android-device-manager.ts';
import { runMobileAction, runConfiguredMobileFlow, exportAndImportMobileCapture, prepareMobileLab, stopMobileLab, verifyMobileLabHealth } from '../../server/src/services/mobile/mobile-lab-service.ts';
import { acquireMobileResources, releaseMobileResources, withMobileOperation, profileForSession, newCaptureContext } from '../../server/src/services/mobile/mobile-runtime-state.ts';
import { getRecordingSessionDetail, publishWorkflowDraft } from '../../server/src/services/recording-service.ts';
import { importMobileFlowsToRecording } from '../../server/src/services/mobile/mobile-traffic-importer.ts';
import { executeWorkflowRun } from '../../server/src/services/workflow-runner.ts';
import { executeGateRun } from '../../server/src/services/gate-runner.ts';
import { dbManager } from '../../server/src/db/db-manager.ts';
import { buildMobileScanToolSpecs } from '../../server/src/agent/tools/mobile-scan-tools.ts';

async function setup(t) { const db=await database();t.after(()=>db.disconnect());return {db,...await readySession(db)}; }
async function captureFile(t,db,s,flows) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'bstg-capture-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'session.jsonl');await writeFile(file,flows.map(f=>JSON.stringify(f)).join('\n')+'\n');
  await updateMobileSession(db,s.id,{health_json:{capture:{...s.health_json.capture,path:file},flow_run:{...s.health_json.flow_run,matched_flow_ids:flows.map(f=>f.flow_id)}}});return file;
}
test('health updates preserve owned process and capture state', async t=>{
 const {db,session:s}=await setup(t);await updateMobileSession(db,s.id,{health_json:{details:{burp:{pid:123},proxy:{previous_proxy:'old:8080'}}}});await updateMobileSession(db,s.id,{health_json:{details:{device:{ok:true}},checks:[]}});
 const updated=await getMobileSession(db,s.id);assert.equal(updated.health_json.details.burp.pid,123);assert.equal(updated.health_json.capture.id,s.health_json.capture.id);
});
test('unknown session update columns are rejected',async t=>{const{db,session:s}=await setup(t);await assert.rejects(updateMobileSession(db,s.id,{'status = ? --':'bad'}),/field|column|Unsupported|Unknown/i);});
test('partial profile update cannot re-enable disabled profile',async t=>{const{db,profile:p}=await setup(t);await upsertMobileProfile(db,{id:p.id,name:p.name,is_enabled:false});await upsertMobileProfile(db,{id:p.id,name:'Renamed'});assert.equal((await getMobileProfile(db,p.id)).is_enabled,false);});
for (const config of [{managed_proxy:'true'},{capture_allowed_hosts:['https://api.example.test']},{minimum_decrypted_flows:NaN},{device_wait_timeout_ms:Infinity},{use_simulator:true}]) test(`invalid profile config rejected ${JSON.stringify(config)}`,async t=>{const {db}=await setup(t);await assert.rejects(upsertMobileProfile(db,{name:'bad',config_json:config}));});
test('missing target manifest blocks before device side effects',async t=>{const{db,profile:p}=await setup(t);let count=0;t.mock.method(AndroidDeviceManager.prototype,'startEmulatorIfConfigured',async()=>{count++;return {};});const result=await prepareMobileLab(db,{profile_id:p.id,app_package:pkg});assert.equal(result.health.status,'blocked');assert.equal(count,0);});
test('a session-bound profile uses the selected device and unique capture path',async t=>{const{profile:p,session:s}=await setup(t);s.device_id='override-device';s.health_json.capture={...newCaptureContext(s.id)};const effective=profileForSession(p,s);assert.equal(effective.adb_serial,'override-device');assert.equal(effective.config_json.capture_session_id,s.health_json.capture.id);assert.notEqual(newCaptureContext(s.id).path,s.health_json.capture.path);});
test('resource lease rejects a second session on the same device; releases correctly',async t=>{const{db,profile:p,session:s}=await setup(t);const second=await createMobileSession(db,{profile_id:p.id,device_id:s.device_id});await acquireMobileResources(db,s,p);await assert.rejects(acquireMobileResources(db,second,p),/MOBILE_RESOURCE_BUSY/);await releaseMobileResources(db,s.id);await acquireMobileResources(db,second,p);});
test('single-session operation lock rejects overlapping action and is released after exception',async()=>{let resolve;const pending=withMobileOperation('lock-test',()=>new Promise(r=>resolve=r));await assert.rejects(withMobileOperation('lock-test',async()=>{}),/MOBILE_BUSY/);resolve();await pending;await assert.rejects(withMobileOperation('lock-test',async()=>{throw Error('fixture');}));assert.equal(await withMobileOperation('lock-test',async()=>42),42);});
test('post-action observation failure persists a FAILED action, never completed',async t=>{const{db,session:s}=await setup(t);t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>appiumResult());t.mock.method(AndroidDeviceManager.prototype,'observe',async()=>{throw Error('device disconnected');});const out=await runMobileAction(db,s.id,{action:'tap',target:{resource_id:'login'},timeout_ms:0,expect:{text:'Login'}});assert.equal(out.ok,false);const actions=await listMobileActions(db,s.id);assert.equal(actions.length,1);assert.equal(actions[0].status,'failed');assert.match(actions[0].result_json.error,/disconnected/);});
test('selector/action exceptions persist failure records too',async t=>{const{db,session:s}=await setup(t);t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{throw Error('Ambiguous selector');});const out=await runMobileAction(db,s.id,{action:'tap',target:{text:'Login'},timeout_ms:0,expect:{text:'Login'}});assert.equal(out.ok,false);assert.equal((await listMobileActions(db,s.id))[0].status,'failed');});
test('observation retry never repeats side-effecting tap',async t=>{const{db,session:s}=await setup(t);let taps=0,reads=0;t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{taps++;return appiumResult();});t.mock.method(AndroidDeviceManager.prototype,'observe',async()=>{reads++;return {...observation(),ui_tree:reads===1?[]:observation().ui_tree};});const out=await runMobileAction(db,s.id,{action:'tap',target:{resource_id:'login'},timeout_ms:1000,expect:{text:'Login'}});assert.equal(out.ok,true);assert.equal(taps,1);assert.equal(reads,2);});
test('empty flow invalidates previous successful flow and prevents false reuse',async t=>{const{db,session:s}=await setup(t);await assert.rejects(runConfiguredMobileFlow(db,s.id,[]),/empty flow/);assert.equal((await getMobileSession(db,s.id)).health_json.flow_run.ok,false);});
test('entire flow is validated before the first action',async t=>{const{db,session:s}=await setup(t);let count=0;t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{count++;return appiumResult();});await assert.rejects(runConfiguredMobileFlow(db,s.id,[{action:'tap',target:{text:'Login'},expect:{text:'Login'}},{action:'tap',expect:{}}]));assert.equal(count,0);});
test('flow stops on assertion failure and persists failed flow outcome',async t=>{const{db,session:s}=await setup(t);let count=0;t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{count++;return appiumResult();});t.mock.method(AndroidDeviceManager.prototype,'observe',async()=>observation());const out=await runConfiguredMobileFlow(db,s.id,[{action:'tap',target:{text:'Login'},expect:{text:'Dashboard'},expect_network:networkExpected(),timeout_ms:0},{action:'tap',target:{text:'Login'},expect:{text:'Login'}}]);assert.equal(out.ok,false);assert.equal(count,1);assert.equal((await getMobileSession(db,s.id)).health_json.flow_run.ok,false);});
test('successful action cannot overwrite declared target package',async t=>{const{db,session:s}=await setup(t);t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>appiumResult());t.mock.method(AndroidDeviceManager.prototype,'observe',async()=>({...observation(),package:'wrong.package'}));assert.equal((await runMobileAction(db,s.id,{action:'tap',target:{text:'Login'},timeout_ms:0,expect:{text:'Login'}})).ok,false);assert.equal((await getMobileSession(db,s.id)).app_package,pkg);});
test('strict capture does not trust caller-supplied flow objects',async t=>{const{db,session:s}=await setup(t);await assert.rejects(exportAndImportMobileCapture(db,s.id,{flows:[flow(s)]}),/caller-supplied/);});
test('session-owned capture cannot be redirected to another export file',async t=>{const{db,session:s}=await setup(t);await captureFile(t,db,s,[flow(s)]);await assert.rejects(exportAndImportMobileCapture(db,s.id,{export_path:'/tmp/other.jsonl'}),/session-owned/);});
test('stale/other-device capture generates zero recordings',async t=>{const{db,session:s}=await setup(t);await captureFile(t,db,s,[{...flow(s),device_id:'other'}]);await assert.rejects(exportAndImportMobileCapture(db,s.id),/Insufficient/);assert.equal((await db.repos.recordingSessions.findAll()).length,0);});
test('session capture imports, sorts, deduplicates, generates and reuses one recording',async t=>{
 const{db,session:s}=await setup(t);const f=flow(s);const second={...flow(s),url:'https://api.example.test/profile',started_at:new Date(Date.now()-500).toISOString(),sequence:900};
 await captureFile(t,db,s,[f,second,f]);const first=await exportAndImportMobileCapture(db,s.id);assert.equal(first.accepted_flows,2);assert.equal(first.duplicate_flows,1);assert.equal(first.workflow_draft_count,1);
 const detail=await getRecordingSessionDetail(db,first.recording_session_id);assert.deepEqual(detail.events.map(e=>e.sequence),[1,2]);assert.match(detail.events[0].url,/profile/);
 const again=await exportAndImportMobileCapture(db,s.id);assert.equal(again.reused,true);assert.equal(again.recording_session_id,first.recording_session_id);assert.equal((await db.repos.recordingSessions.findAll()).length,1);
});
test('minimum draft failure can retry the SAME snapshot without orphan duplicate recordings',async t=>{
 const{db,session:s}=await setup(t);const input={mobile_session_id:s.id,app_package:pkg,flows:[flow(s)],minimum_workflow_drafts:2,require_explicit_tls_evidence:true};
 await assert.rejects(importMobileFlowsToRecording(db,input),/drafts.*minimum/);assert.notEqual((await getMobileSession(db,s.id)).capture_status,'imported');
 const fixed=await importMobileFlowsToRecording(db,{...input,minimum_workflow_drafts:1});assert.equal(fixed.accepted_flows,1);assert.equal((await db.repos.recordingSessions.findAll()).length,1);assert.equal((await db.repos.recordingEvents.findAll()).length,1);
});
test('stop restores previous proxy, preserves lifecycle details and is idempotent',async t=>{
 const{db,session:s}=await setup(t);await updateMobileSession(db,s.id,{health_json:{details:{proxy:{configured:true,previous_proxy:'old.proxy:8080',reverse:{configured:true}}}}});let args;
 t.mock.method(AndroidDeviceManager.prototype,'clearProxy',async(...a)=>{args=a;return{cleared:true};});t.mock.method(AndroidDeviceManager.prototype,'closeAppiumSessions',async()=>({ok:true}));
 const result=await stopMobileLab(db,s.id);assert.equal(result.ok,true);assert.deepEqual(args,['old.proxy:8080',true]);assert.equal((await getMobileSession(db,s.id)).status,'stopped');assert.equal((await stopMobileLab(db,s.id)).reused,true);
});
test('failed cleanup retains ownership and blocked status, not stopped',async t=>{const{db,profile:p,session:s}=await setup(t);await acquireMobileResources(db,s,p);await updateMobileSession(db,s.id,{health_json:{details:{proxy:{changed:true}}}});t.mock.method(AndroidDeviceManager.prototype,'clearProxy',async()=>({cleared:false}));t.mock.method(AndroidDeviceManager.prototype,'closeAppiumSessions',async()=>({ok:true}));assert.equal((await stopMobileLab(db,s.id)).ok,false);assert.equal((await getMobileSession(db,s.id)).status,'blocked');assert.ok((await db.runRawQuery('SELECT * FROM mobile_resource_leases')).length);});
test('agent session argument cannot cross the scan boundary',async t=>{const{db,session:s}=await setup(t);const tool=buildMobileScanToolSpecs().find(t=>t.name==='mobile.observe');await assert.rejects(tool.handler({session_id:s.id},{db,repo:{},scanRunId:'different-scan'}),/belong/);});
test('agent reads persisted scan mobile config, not a nonexistent context.scan',async t=>{const{db}=await setup(t);const tool=buildMobileScanToolSpecs().find(t=>t.name==='mobile.lab.prepare');let reads=0;await assert.rejects(tool.handler({}, {db,scanRunId:'scan-id',repo:{getRun:async id=>{reads++;assert.equal(id,'scan-id');return{scan_config:{mobile:{lab_profile_id:'NONEXISTENT-PERSISTED-PROFILE'}}};}}}),/NONEXISTENT-PERSISTED-PROFILE/);assert.equal(reads,1);});

test('REAL SQL + local HTTP: mobile recording → publish → native replay → no fake finding → persisted Gate; assertion mismatch blocks',async t=>{
 const{db,session:s}=await setup(t);t.mock.method(dbManager,'getActive',()=>db);let status=200,requests=0;
 const server=http.createServer((req,res)=>{requests++;res.statusCode=status;res.setHeader('content-type','application/json');res.end(JSON.stringify({orders:[]}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port;const env=await db.repos.environments.create({name:'Local test fixture',base_url:base,is_active:true});
 const imported=await importMobileFlowsToRecording(db,{mobile_session_id:s.id,environment_id:env.id,flows:[{...flow(s),url:base+'/orders',tls_decrypted:false}],minimum_workflow_drafts:1});
 const detail=await getRecordingSessionDetail(db,imported.recording_session_id);const published=await publishWorkflowDraft(db,detail.workflow_drafts[0].id,{published_by:'automated-service-fixture'});assert.equal(published.workflow.baseline_config.capture_replay_only,true);
 const run=await db.repos.testRuns.create({name:'replay',status:'pending',execution_type:'workflow',workflow_id:published.workflow.id,account_ids:[],environment_id:env.id});
 const result=await executeWorkflowRun({test_run_id:run.id,workflow_id:published.workflow.id,account_ids:[],environment_id:env.id});assert.equal(result.success,true,JSON.stringify({result,stored:await db.repos.testRuns.findById(run.id),steps:await db.repos.workflowSteps.findAll()}));assert.equal(result.findings_count,0);assert.equal((await db.repos.findings.findAll()).length,0);assert.ok(requests>0);assert.equal((await db.repos.testRuns.findById(run.id)).status,'completed');
 const gate=await executeGateRun({workflow_ids:[published.workflow.id],account_ids:[],environment_id:env.id});assert.equal(gate.gate_result,'PASS');assert.equal((await db.repos.securityRuns.findById(gate.security_run_id)).gate_result,gate.gate_result);
 status=409;const blocked=await executeGateRun({workflow_ids:[published.workflow.id],account_ids:[],environment_id:env.id});assert.equal(blocked.gate_result,'BLOCK');assert.ok(blocked.errors?.length);assert.equal((await db.repos.findings.findAll()).length,0);
});

test('accepted capture evidence is immutable, available after stop, and detects tampering',async t=>{
 const {exportMobileCaptureEvidence}=await import('../../server/src/services/mobile/mobile-lab-service.ts');
 const{db,session:s}=await setup(t);const file=await captureFile(t,db,s,[flow(s)]);
 const imported=await exportAndImportMobileCapture(db,s.id,{});const evidence=await exportMobileCaptureEvidence(db,s.id);
 assert.equal(evidence.sha256,imported.evidence_sha256);assert.equal(evidence.flows.length,1);
 await writeFile(file,JSON.stringify(flow(s))+'\n');assert.deepEqual(await exportMobileCaptureEvidence(db,s.id),evidence);
 await stopMobileLab(db,s.id);assert.deepEqual(await exportMobileCaptureEvidence(db,s.id),evidence);
 await writeFile(file+'.accepted.json','[]');await assert.rejects(exportMobileCaptureEvidence(db,s.id),/integrity/);
});

test('strict standalone action without assertion fails before any side effect',async t=>{
 const{db,session:s}=await setup(t);let taps=0;t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{taps++;return appiumResult();});
 const result=await runMobileAction(db,s.id,{action:'tap',target:{text:'Login'},timeout_ms:0});assert.equal(result.ok,false);assert.equal(taps,0);assert.equal((await listMobileActions(db,s.id))[0].status,'failed');
});
