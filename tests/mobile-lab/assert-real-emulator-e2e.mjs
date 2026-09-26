/** Validate the exact artifact format emitted by the API-driven real-device harness. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const requiredFiles=['profile-upsert.json','apk-upload.json','mobile-session.json','mobile-prepare.json','apk-install.json','apk-launch.json','flow-input.json','mobile-flow.json','mobile-observe.json','app-screen.png','ui-tree.json','mobile-health.json','capture-import.json','capture-evidence.json','recording-detail.json','workflow-publish.json','environment.json','workflow-run.json','test-run.json','findings.json','gate-run.json','security-run.json','stop.json','final-session.json'];
const sha = data=>createHash('sha256').update(data).digest('hex');
export async function verifyRealAndroidEvidence(dir) {
 const errors=[],checks=[];
 const check=(condition,message)=>{(condition?checks:errors).push(message);};
 const json=async name=>JSON.parse(await fs.readFile(path.join(dir,name),'utf8'));
 try{
  const report=await json('report.json');const artifacts={};
  for(const name of requiredFiles){const bytes=await fs.readFile(path.join(dir,name));check(bytes.length>0&&report.files?.[name]===sha(bytes),`${name}: fresh manifest hash`);if(name.endsWith('.json'))artifacts[name]=JSON.parse(bytes.toString('utf8'));}
  const data=name=>{const envelope=artifacts[name];check(!envelope?.error&&envelope?.data!==undefined,`${name}: successful API envelope`);return envelope?.data;};
  const profile=data('profile-upsert.json'),uploaded=data('apk-upload.json'),s=data('mobile-session.json'),prepared=data('mobile-prepare.json'),installed=data('apk-install.json'),launched=data('apk-launch.json'),flow=data('mobile-flow.json'),observed=data('mobile-observe.json'),health=data('mobile-health.json'),imported=data('capture-import.json'),captured=data('capture-evidence.json'),recording=data('recording-detail.json'),published=data('workflow-publish.json'),environment=data('environment.json'),run=data('workflow-run.json'),stored=data('test-run.json'),findings=data('findings.json'),gate=data('gate-run.json'),security=data('security-run.json'),stop=data('stop.json'),final=data('final-session.json');
  const cfg=profile.config_json||{}, ids=report.ids||{},steps=artifacts['flow-input.json'].steps;
  check(report.ok===true&&Number.isFinite(Date.parse(report.started_at))&&Date.parse(report.finished_at)>=Date.parse(report.started_at),'harness completed, with valid timestamps');
  check(profile.id!=='offline-simulator-v0.2.0'&&cfg.offline_simulator!==true&&cfg.offline_simulator!=='true'&&cfg.strict_real_e2e!==false&&prepared.details?.evidence_level!=='simulated','no simulator/non-strict acceptance');
  check(s.id===ids.mobile_session_id&&s.profile_id===profile.id&&s.device_id&&s.app_package&&s.app_package===s.apk_package_name,'session, profile, device and attested package agree');
  check(/^[a-f0-9]{64}$/i.test(s.apk_sha256||'')&&s.apk_sha256===uploaded.sha256&&/^[a-f0-9]{64}$/i.test(s.apk_signer_sha256||'')&&s.apk_source,'APK digest, signer and source present');
  check(prepared.health?.status!=='blocked'&&prepared.session?.certificate_evidence?.install_verified===true,'preparation and certificate evidence');
  check(installed.ok===true&&!installed.skipped&&launched.ok===true,'install and launch were performed');
  check(Array.isArray(steps)&&steps.length>0&&steps.some(s=>(s.action||s.type)!=='wait')&&flow.ok===true&&flow.steps_executed===steps.length&&flow.results?.every(r=>r.ok===true),'declared business flow fully executed');
  check(flow.results?.every(result=>final.actions?.some(action=>action.id===result.action_id&&action.status==='completed'&&action.session_id===s.id)),'flow action IDs agree with persisted completed actions');
  check(observed.package===s.app_package&&observed.ui_tree?.length>0&&Date.parse(observed.observed_at)>=Date.parse(report.started_at),'fresh target foreground/UI observation');
  const png=await fs.readFile(path.join(dir,'app-screen.png'));
  check(png.length>57&&png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&png.equals(Buffer.from(observed.screenshot_base64||'','base64')),'PNG bytes match the observed screen');
  check(JSON.stringify(artifacts['ui-tree.json'])===JSON.stringify(observed.ui_tree),'UI tree is the observed hierarchy, not a fabricated XML placeholder');
  check(health.status!=='blocked'&&['https_decrypted','imported'].includes(health.capture_status),'verified HTTPS health');
  const capture=final.session?.health_json?.capture;
  check(captured.session_id===s.id&&captured.capture_session_id===capture?.id&&captured.evidence_level==='session_bound_device_capture','capture is bound to this real-device session');
  check(sha(JSON.stringify(captured.flows))===captured.sha256&&captured.sha256===imported.evidence_sha256,'accepted snapshot digest matches import');
  check(Array.isArray(captured.flows)&&captured.flows.length>=Math.max(1,Number(cfg.minimum_decrypted_flows)||1)&&captured.flows.every(f=>{let url;try{url=new URL(f.url);}catch{return false;}return url.protocol==='https:'&&f.tls_decrypted===true&&typeof f.response_status==='number'&&f.response_status>=100&&f.response_status<=599&&f.method?.toUpperCase()!=='CONNECT'&&f.app_package===s.app_package&&f.device_id===s.device_id&&f.capture_session_id===capture?.id&&Date.parse(f.started_at)>=Date.parse(capture?.started_at)&&Date.parse(f.started_at)<=Date.parse(report.finished_at)+5000&&cfg.capture_allowed_hosts?.map(h=>h.toLowerCase()).includes(url.hostname.toLowerCase());}),'completed HTTPS responses match session, device, package, time and authorized hosts');
  check(imported.recording_session_id===ids.recording_session_id&&recording.session?.id===ids.recording_session_id&&recording.events?.length===imported.accepted_flows&&imported.workflow_draft_count>=1,'capture became persisted recording events and drafts');
  check(recording.workflow_drafts?.some(d=>d.id===ids.workflow_draft_id)&&published.published_from_draft_id===ids.workflow_draft_id&&published.workflow?.id===ids.workflow_id&&published.workflow?.source_recording_session_id===ids.recording_session_id,'draft → published workflow provenance');
  check(published.workflow?.baseline_config?.capture_replay_only===true,'ordinary capture replay does not claim a vulnerability');
  check(environment.id===ids.environment_id&&run.success===true&&run.has_execution_error===false&&run.errors_count===0&&run.test_run_id===ids.test_run_id&&stored.id===ids.test_run_id&&stored.workflow_id===ids.workflow_id&&stored.environment_id===environment.id&&stored.status==='completed'&&stored.progress?.completed>0,'native workflow really executed and persisted a successful nonempty run');
  check(Array.isArray(findings)&&findings.length===0&&run.findings_count===0,'successful ordinary replay creates no fake vulnerability findings');
  check(gate.success===true&&gate.security_run_id===ids.security_run_id&&security.id===ids.security_run_id&&security.gate_result===gate.gate_result&&security.exit_code===gate.exit_code&&security.status==='completed'&&gate.gate_result===report.expected_gate,'Gate result persisted and equals the declared expectation');
  check(stop.ok===true&&final.session?.id===s.id&&final.session?.status==='stopped'&&final.session?.health_json?.cleanup?.ok===true,'owned runtime cleaned and terminal state persisted');
 }catch(error){errors.push(error.message||String(error));}
 return {ok:errors.length===0,checks_passed:checks.length,checks,errors};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const result=await verifyRealAndroidEvidence(path.resolve(process.argv[2]||''));console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;}
