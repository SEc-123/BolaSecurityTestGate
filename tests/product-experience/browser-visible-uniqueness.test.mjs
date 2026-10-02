import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {closePersistentBrowserContextsForScan,interactPersistentBrowser,navigatePersistentBrowser,withPersistentDiscoveryPage} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

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
 return {input,get mutations(){return mutations;},run:selector=>interactPersistentBrowser({...input,operation:{action,selector,value:'fixture-value'}})};
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
 await withPersistentDiscoveryPage(f.input,async page=>{
  const locate=page.locator.bind(page);
  page.locator=(...args)=>{
   const raw=locate(...args),intersect=raw.and.bind(raw);
   raw.and=other=>{
    const locator=intersect(other),click=locator.click.bind(locator);
    locator.click=async options=>{
     if(!options.trial){dispatchAttempts++;await page.evaluate(()=>{document.getElementById('hidden').style.display='';});}
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
