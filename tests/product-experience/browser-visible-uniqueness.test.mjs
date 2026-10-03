import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {closePersistentBrowserContextsForScan,interactPersistentBrowser,navigatePersistentBrowser,withPersistentBrowserPage,withPersistentDiscoveryPage} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {buildAIScanToolSpecs} from '../../server/src/agent/tools/ai-scan-tools.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {BUSINESS_LEARNING_INTENT} from '../../server/src/agent/business-task-lifecycle.ts';

async function fixture(t,{action='click',hiddenFirst=true,visibility='one'}={}) {
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 let mutations=0;
 const control=(id,hidden)=>action==='fill'
  ?`<input id="${id}" class="duplicate" ${hidden?'style="display:none"':''} oninput="fetch('/mutation',{method:'POST'})">`
  :`<button id="${id}" class="duplicate" ${hidden?'style="display:none"':''} onclick="fetch('/mutation',{method:'POST'})">Continue</button>`;
 const visible=control('target',visibility==='none'),hidden=control('hidden',visibility!=='two');
 const target=http.createServer((req,res)=>{
  if(req.url==='/mutation'){mutations++;res.end('ok');return;}
  res.setHeader('content-type','text/html');res.end(`<html><body>${hiddenFirst?hidden+visible:visible+hidden}</body></html>`);
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');
 t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
 const url=`http://127.0.0.1:${target.address().port}/`,db=await database(),repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web'}});
 const task=await repo.createTask({scan_run_id:run.id,title:'Local visible uniqueness fixture',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 const input={repo,scanRunId:run.id,taskId:task.id,scope_base_url:url,timeout_ms:500};
 assert.equal((await navigatePersistentBrowser({...input,url})).ok,true);
 return {db,repo,task,input,get mutations(){return mutations;},run:selector=>interactPersistentBrowser({...input,operation:{action,selector,value:'fixture-value'}})};
}

const selectors={css:'.duplicate',union:'#hidden, #target',xpath:'xpath=//*[@class="duplicate"]'};
for(const action of ['click','fill'])for(const hiddenFirst of [true,false])for(const [engine,selector] of Object.entries(selectors)) {
 test(`${action} uses the unique visible ${engine} match with hidden copy ${hiddenFirst?'first':'last'}`,{timeout:15000},async t=>{
  const f=await fixture(t,{action,hiddenFirst}),result=await f.run(selector);
  assert.equal(result.ok,true);assert.equal(f.mutations,1);
 });
}

for(const selector of ['text=Continue','role=button[name="Continue"][include-hidden=true]']) {
 test(`visible intersection preserves non-CSS selector semantics: ${selector}`,{timeout:15000},async t=>{
  const f=await fixture(t),result=await f.run(selector);
  assert.equal(result.ok,true);assert.equal(f.mutations,1);
 });
}

for(const visibility of ['two','none'])test(`${visibility} visible matches dispatch no action and retain a distinct selector failure`,{timeout:15000},async t=>{
 const f=await fixture(t,{visibility}),result=await f.run('.duplicate');
 assert.equal(result.ok,false);assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
 assert.equal(result.retryable,true);assert.equal(result.match_count,visibility==='two'?2:0);
 assert.equal(result.error_code,visibility==='two'?'selector_ambiguous':'selector_not_visible');assert.equal(f.mutations,0);
});

test('no DOM matches still produces selector_no_match rather than selector_not_visible',{timeout:15000},async t=>{
 const f=await fixture(t),result=await f.run('#absent');
 assert.equal(result.error_code,'selector_no_match');assert.equal(result.match_count,0);
 assert.equal(result.action_performed,false);assert.equal(f.mutations,0);
});

test('a duplicate becoming visible after trial remains strict at dispatch and is never replayed',{timeout:15000},async t=>{
 const f=await fixture(t);let dispatchAttempts=0;
 // Inject a deterministic DOM change exactly between real Playwright trial and
 // real click. The live intersected locator must resolve again at dispatch.
 await withPersistentBrowserPage({...f.input,context_key:`task:${f.input.taskId}`,scope_type:'task'},async page=>{
  const locate=page.locator.bind(page);
  page.locator=(...args)=>{
   const raw=locate(...args),intersect=raw.and.bind(raw);
   raw.and=other=>{
    const locator=intersect(other),click=locator.click.bind(locator);
    locator.click=async options=>{
     if(!options.trial){dispatchAttempts++;await page.evaluate(()=>{const hidden=document.getElementById('hidden');hidden.style.display='';hidden.id='target';});}
     return click(options);
    };
    return locator;
   };
   return raw;
  };
 });
 const result=await f.run('.duplicate');
 assert.equal(result.ok,false);assert.equal(result.error_code,'browser_action_failed');
 assert.equal(result.error,'Browser action may have failed after dispatch.');
 assert.equal(result.recovery_hint,'The browser action may have occurred. Do not retry it; verify the resulting state.');
 assert.equal(result.failure_phase,'action_or_after');assert.notEqual(result.action_performed,false);
 assert.equal(result.retryable,false);assert.equal(dispatchAttempts,1);assert.equal(f.mutations,0);
 assert.equal(JSON.stringify(result).includes('strict mode violation'),false,'page-derived renderer diagnostics stay private');
});

test('a private post-action guard rejects the same newly observed control before a second dispatch',{timeout:15000},async t=>{
 const f=await fixture(t);let dispatchAttempts=0;
 await withPersistentBrowserPage({...f.input,context_key:`task:${f.input.taskId}`,scope_type:'task'},async page=>{
  const locate=page.locator.bind(page);
  page.locator=(...args)=>{
   const raw=locate(...args),intersect=raw.and.bind(raw);
   raw.and=other=>{
    const locator=intersect(other),click=locator.click.bind(locator);
    locator.click=async options=>{
     if(!options.trial){dispatchAttempts++;await page.evaluate(()=>{const hidden=document.getElementById('hidden');hidden.style.display='';hidden.id='target';});}
     return click(options);
    };
    return locator;
   };
   return raw;
  };
 });
 const initial=await interactPersistentBrowser({...f.input,operation:{action:'observe'}});
 const initialRef=initial.observation.controls.find(control=>control.tag==='button')?.control_ref;
 assert.equal(typeof initialRef,'string');
 const failed=await interactPersistentBrowser({...f.input,operation:{action:'click',control_ref:initialRef}});
 assert.equal(failed.ok,false);assert.equal(failed.failure_phase,'action_or_after');
 const fingerprint=failed.post_action_replay_guard?.fingerprint;
 assert.match(String(fingerprint),/^[a-f0-9]{64}$/);
 await withPersistentBrowserPage({...f.input,context_key:`task:${f.input.taskId}`,scope_type:'task'},async page=>{
  await page.evaluate(()=>{const hidden=[...document.querySelectorAll('#target')].find(element=>element!==document.querySelector('#target'));if(hidden){hidden.id='hidden';hidden.style.display='none';}});
 });
 const refreshed=await interactPersistentBrowser({...f.input,operation:{action:'observe'}});
 const refreshedRef=refreshed.observation.controls.find(control=>control.tag==='button')?.control_ref;
 assert.equal(typeof refreshedRef,'string');assert.notEqual(refreshedRef,initialRef,'the guard must not depend on a stale opaque handle');
 const replay=await interactPersistentBrowser({...f.input,post_action_replay_fingerprints:[fingerprint],operation:{action:'click',control_ref:refreshedRef}});
 assert.equal(replay.ok,false);assert.equal(replay.error_code,'post_action_replay_blocked');
 assert.equal(replay.failure_phase,'pre_action');assert.equal(replay.action_performed,false);
 assert.equal(dispatchAttempts,1,'the guarded replay must be rejected before Chromium dispatch');assert.equal(f.mutations,0);
 assert.equal('post_action_replay_guard' in replay,false,'the guard is returned only for the original uncertain-dispatch result');

 // The guard identifies the private control rather than one input verb. A
 // model must not turn a failed click into Enter on the same newly observed
 // control to re-dispatch the potentially completed side effect.
 const alternate=await interactPersistentBrowser({...f.input,post_action_replay_fingerprints:[fingerprint],operation:{action:'press',key:'Enter',control_ref:refreshedRef}});
 assert.equal(alternate.ok,false);assert.equal(alternate.error_code,'post_action_replay_blocked');
 assert.equal(alternate.failure_phase,'pre_action');assert.equal(alternate.action_performed,false);
 assert.equal(dispatchAttempts,1,'an alternate input verb must also be rejected before Chromium dispatch');
});


test('a persisted post-action guard is rediscovered by a fresh AI-scan handler and blocks a new opaque handle',{timeout:20000},async t=>{
 const f=await fixture(t);let dispatchAttempts=0;
 await withPersistentBrowserPage({...f.input,context_key:`task:${f.input.taskId}`,scope_type:'task'},async page=>{
  const locate=page.locator.bind(page);
  page.locator=(...args)=>{
   const raw=locate(...args),intersect=raw.and.bind(raw);
   raw.and=other=>{
    const locator=intersect(other),click=locator.click.bind(locator);
    locator.click=async options=>{
     if(!options.trial){dispatchAttempts++;await page.evaluate(()=>{const hidden=document.getElementById('hidden');hidden.style.display='';hidden.id='target';});}
     return click(options);
    };
    return locator;
   };
   return raw;
  };
 });
 const initial=await interactPersistentBrowser({...f.input,operation:{action:'observe'}});
 const initialRef=initial.observation.controls.find(control=>control.tag==='button')?.control_ref;
 assert.equal(typeof initialRef,'string');
 const uncertain=await interactPersistentBrowser({...f.input,operation:{action:'click',control_ref:initialRef}});
 assert.equal(uncertain.failure_phase,'action_or_after');
 const fingerprint=uncertain.post_action_replay_guard?.fingerprint;
 assert.match(String(fingerprint),/^[a-f0-9]{64}$/);

 // The runtime process that created this action has no authority to keep the
 // guard in memory. Persist the same private, recording-scoped artifact that
 // the lifecycle writes, then use a newly built registry/handler to model a
 // later agent turn after recovery.
 await f.repo.updateTask(f.task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow-recovery-fixture'}});
 const session=await f.db.repos.recordingSessions.create({
  name:'Recovery guard recording',mode:'workflow',intent:'learning_seed',status:'recording',source_tool:'bstg.business.capture',
  requested_field_names:[],capture_filters:{source:'agent_business',scan_run_id:f.input.scanRunId,task_id:f.task.id,flow_id:'flow-recovery-fixture',context_key:`task:${f.task.id}`,scope_type:'task',capture_status:'recording'},
  target_fields:[],event_count:0,field_hit_count:0,runtime_context_count:0,generated_result_count:0,published_result_count:0,summary:{},started_at:new Date().toISOString(),
 });
 await f.repo.createArtifact({scan_run_id:f.input.scanRunId,task_id:f.task.id,artifact_type:'business_post_action_replay_guard',title:'Private recovery guard',content_json:{
  private:true,protocol:'capture_then_observe_then_capture',recording_session_id:session.id,potentially_dispatched:true,failure_phase:'action_or_after',operation_fingerprint:fingerprint,
 }});
 await withPersistentBrowserPage({...f.input,context_key:`task:${f.input.taskId}`,scope_type:'task'},async page=>{
  await page.evaluate(()=>{const hidden=[...document.querySelectorAll('#target')].find(element=>element!==document.querySelector('#target'));if(hidden){hidden.id='hidden';hidden.style.display='none';}});
 });
 const registry=new AgentToolRegistry();
 const browserInteract=buildAIScanToolSpecs().find(tool=>tool.name==='browser.interact');
 assert.ok(browserInteract);registry.register(browserInteract);
 const context={db:f.db,repo:f.repo,scanRunId:f.input.scanRunId,taskId:f.task.id};
 const observed=await registry.call('browser.interact',{operation:{action:'observe'}},context);
 assert.equal(observed.ok,true);
 const refreshedRef=observed.data?.observation?.controls?.find(control=>control.tag==='button')?.control_ref;
 assert.equal(typeof refreshedRef,'string');assert.notEqual(refreshedRef,initialRef,'the restarted handler must work from a current opaque handle');
 const replay=await registry.call('browser.interact',{operation:{action:'click',control_ref:refreshedRef}},context);
 assert.equal(replay.ok,false);assert.equal(replay.data?.error_code,'post_action_replay_blocked');
 assert.equal(replay.data?.failure_phase,'pre_action');assert.equal(replay.data?.action_performed,false);
 assert.equal(dispatchAttempts,1,'the artifact-resolved guard must reject before a second Chromium dispatch');assert.equal(f.mutations,0);
 assert.equal(JSON.stringify(replay).includes(String(fingerprint)),false,'the persisted digest is never returned to the model caller');
 const invocations=await f.repo.listToolInvocations(f.input.scanRunId);
 const persistedReplay=invocations.at(-1);
 assert.equal(persistedReplay?.output_json?.error_code,'post_action_replay_blocked');
 assert.equal(JSON.stringify(persistedReplay).includes(String(fingerprint)),false,'the durable digest never enters model-facing invocation history');
});
