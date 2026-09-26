// LEGACY capture/replay harness, NOT the Appium HTTPS acceptance entry.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verifyRealAndroidEvidence } from '../../tests/mobile-lab/assert-real-emulator-e2e.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runId = `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
const dir = path.resolve(process.env.BSTG_E2E_ARTIFACT_DIR || path.join(root,'artifacts','real-android-e2e',runId));
const base = (process.env.BSTG_E2E_BSTG_API_URL || 'http://127.0.0.1:3101').replace(/\/$/,'');
const report = { format_version: 1, run_id: runId, started_at: new Date().toISOString(), ok: false, evidence_level: 'not_verified', gate_scope: 'mobile_acquisition_replay_not_comprehensive_security_assessment', ids: {}, errors: [], files: {}, requests: [], expected_gate: process.env.BSTG_E2E_EXPECT_GATE || 'PASS' };
let sessionId;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const required = name => { const value=process.env[name]?.trim();assert(value,`Missing required environment variable ${name}`);return value; };
async function save(name,data,binary=false) { await fs.writeFile(path.join(dir,name),binary?data:JSON.stringify(data,null,2)+'\n',{mode:0o600}); }
async function api(name,route,method='GET',body) {
  const started=Date.now();
  const response=await fetch(base+route,{method,signal:AbortSignal.timeout(360000),headers:{'Content-Type':'application/json',...(process.env.BSTG_E2E_API_TOKEN?{Authorization:`Bearer ${process.env.BSTG_E2E_API_TOKEN}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let envelope;try{envelope=JSON.parse(text);}catch{envelope={error:`Non-JSON HTTP ${response.status}`,body_preview:text.slice(0,200)};}
  if(name)await save(name,envelope);
  report.requests.push({route,method,status:response.status,duration_ms:Date.now()-started});
  assert(response.ok&&!envelope.error,`${method} ${route}: ${envelope.error||response.status}`);
  return envelope.data;
}
async function main() {
  await fs.mkdir(path.dirname(dir), { recursive: true, mode: 0o700 });
  try { await fs.mkdir(dir,{recursive:false,mode:0o700}); }
  catch(error) { if(error.code!=='EEXIST')throw error;assert((await fs.readdir(dir)).length===0,'Artifact directory must be new/empty; stale evidence is not reusable.'); }
  try {
    assert(process.env.BSTG_E2E_AUTHORIZED==='true','Set BSTG_E2E_AUTHORIZED=true only for an authorized APK, isolated device and backend.');
    assert(!process.env.BSTG_E2E_TRIGGER_ADB_SHELL,'Direct ADB trigger shortcuts are not accepted. Supply BSTG_E2E_FLOW_JSON_FILE and run the product flow API.');
    const profileInput=JSON.parse(await fs.readFile(required('BSTG_E2E_PROFILE_JSON_FILE'),'utf8'));
    const stepsInput=JSON.parse(await fs.readFile(required('BSTG_E2E_FLOW_JSON_FILE'),'utf8'));
    const steps=Array.isArray(stepsInput)?stepsInput:stepsInput.steps;
    assert(Array.isArray(steps)&&steps.length>0&&steps.some(s=>(s.action||s.type)!=='wait'),'A nonempty business flow, not wait-only, is required.');
    const config=profileInput.config_json||{};
    assert(profileInput.id&&profileInput.is_enabled!==false,'Profile must have an explicit ID and be enabled.');
    assert(profileInput.id!=='offline-simulator-v0.2.0'&&config.offline_simulator!==true&&config.offline_simulator!=='true'&&config.strict_real_e2e!==false,'Simulator/non-strict profiles cannot pass real-device acceptance.');
    assert(Array.isArray(config.capture_allowed_hosts)&&config.capture_allowed_hosts.length,'Profile must declare capture_allowed_hosts.');
    if(process.env.BSTG_E2E_PROFILE_ID)assert(profileInput.id===process.env.BSTG_E2E_PROFILE_ID,'Profile ID does not match JSON.');
    const apkPath=path.resolve(required('BSTG_E2E_APK_PATH'));
    const bytes=await fs.readFile(apkPath);assert(bytes.length<=64*1024*1024,'This upload-driven harness supports APKs up to 64 MiB.');
    const source=required('BSTG_E2E_APK_SOURCE');
    const executionBase=required('BSTG_E2E_EXECUTION_BASE_URL');assert(['http:','https:'].includes(new URL(executionBase).protocol),'Execution base must be an HTTP(S) authorized backend.');
    const device=process.env.BSTG_E2E_DEVICE_ID||profileInput.adb_serial;assert(device,'An explicit device serial is required.');
    const profile=await api('profile-upsert.json','/api/mobile/profiles','POST',profileInput);
    const app=await api('apk-upload.json','/api/mobile/apps/import','POST',{profile_id:profile.id,filename:path.basename(apkPath),base64:bytes.toString('base64'),apk_source:source});
    assert(app.sha256===hash(bytes),'Uploaded APK digest does not match local bytes.');
    const session=await api('mobile-session.json','/api/mobile/sessions','POST',{profile_id:profile.id,device_id:device,apk_path:app.apk_path,apk_source:source,apk_sha256:app.sha256,app_package:process.env.BSTG_E2E_APP_PACKAGE||app.package_name,app_activity:process.env.BSTG_E2E_APP_ACTIVITY||app.launch_activity});
    sessionId=session.id;assert(sessionId,'Missing session ID');report.ids.mobile_session_id=sessionId;
    assert(/^[a-f0-9]{64}$/i.test(session.apk_signer_sha256||''),'APK signer was not verified.');
    const route=`/api/mobile/sessions/${encodeURIComponent(sessionId)}`;
    const prepared=await api('mobile-prepare.json',route+'/start','POST',{});assert(prepared.health.status!=='blocked','Lab preparation blocked.');
    const install=await api('apk-install.json',route+'/install-apk','POST',{});assert(install.ok===true&&!install.skipped,'APK installation was not performed successfully.');
    const launch=await api('apk-launch.json',route+'/launch','POST',{});assert(launch.ok===true,'Target launch failed.');
    await save('flow-input.json',{steps});
    const flow=await api('mobile-flow.json',route+'/flow','POST',{steps});assert(flow.ok===true&&flow.steps_executed===steps.length,'Not all mobile flow steps passed.');
    const observed=await api('mobile-observe.json',route+'/observe');assert(observed.package===session.app_package&&observed.ui_tree?.length&&observed.screenshot_base64,'Fresh target screen/UI evidence missing.');
    await save('app-screen.png',Buffer.from(observed.screenshot_base64,'base64'),true);await save('ui-tree.json',observed.ui_tree);
    const deadline=Date.now()+60000;let health;
    do { health=await api('mobile-health.json',route+'/health');if(health.status!=='blocked'&&['https_decrypted','imported'].includes(health.capture_status))break;await new Promise(r=>setTimeout(r,500)); } while(Date.now()<deadline);
    assert(health&&health.status!=='blocked'&&['https_decrypted','imported'].includes(health.capture_status),'No verified current-session HTTPS capture before deadline.');
    const imported=await api('capture-import.json',route+'/import-capture','POST',{regenerate:true});assert(imported.workflow_draft_count>=1,'Capture did not generate a workflow draft.');
    report.ids.recording_session_id=imported.recording_session_id;
    await api('capture-evidence.json',route+'/capture-evidence');
    const detail=await api('recording-detail.json',`/api/recordings/sessions/${encodeURIComponent(imported.recording_session_id)}`);
    const draft=detail.workflow_drafts?.[0];assert(draft?.id,'No publishable workflow draft');report.ids.workflow_draft_id=draft.id;
    const published=await api('workflow-publish.json',`/api/recordings/workflow-drafts/${encodeURIComponent(draft.id)}/publish`,'POST',{published_by:'real-android-e2e-replay'});
    const workflowId=published.workflow?.id;assert(workflowId,'No published workflow ID');report.ids.workflow_id=workflowId;
    const environment=await api('environment.json','/api/environments','POST',{name:`Mobile E2E ${runId}`,base_url:executionBase,is_active:true});report.ids.environment_id=environment.id;
    const executed=await api('workflow-run.json','/api/run/workflow','POST',{workflow_id:workflowId,account_ids:[],environment_id:environment.id});
    report.ids.test_run_id=executed.test_run_id;assert(executed.success===true&&executed.has_execution_error===false&&executed.errors_count===0,'Native replay failed or contains execution errors.');
    await api('test-run.json',`/api/test-runs/${encodeURIComponent(executed.test_run_id)}`);
    await api('findings.json',`/api/findings?test_run_id=${encodeURIComponent(executed.test_run_id)}`);
    const gate=await api('gate-run.json','/api/run/gate','POST',{workflow_ids:[workflowId],template_ids:[],account_ids:[],environment_id:environment.id,metadata:{source:'real-android-e2e-replay',mobile_session_id:sessionId,recording_session_id:imported.recording_session_id}});
    report.ids.security_run_id=gate.security_run_id;assert(gate.success===true,'Gate had execution errors.');
    await api('security-run.json',`/api/security-runs/${encodeURIComponent(gate.security_run_id)}`);
    report.ok=true;
  } catch(error) { report.errors.push(error.message||String(error));report.ok=false; }
  finally {
    if(sessionId) {
      try { const stopped=await api('stop.json',`/api/mobile/sessions/${encodeURIComponent(sessionId)}/stop`,'POST',{});assert(stopped.ok===true,'Runtime cleanup failed.');await api('final-session.json',`/api/mobile/sessions/${encodeURIComponent(sessionId)}`); }
      catch(error){report.ok=false;report.errors.push(`Cleanup: ${error.message}`);}
    }
    report.finished_at=new Date().toISOString();
    for(const name of (await fs.readdir(dir)).sort())if(name!=='report.json')report.files[name]=hash(await fs.readFile(path.join(dir,name)));
    await save('report.json',report);
    if(report.ok){const verification=await verifyRealAndroidEvidence(dir);report.verification=verification;report.ok=verification.ok;if(!verification.ok)report.errors.push(...verification.errors);else report.evidence_level='real_device_api_chain_verified';await save('report.json',report);}
  }
  console.log(JSON.stringify({ok:report.ok,artifact_dir:dir,evidence_level:report.evidence_level,errors:report.errors},null,2));
  process.exitCode=report.ok?0:1;
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
