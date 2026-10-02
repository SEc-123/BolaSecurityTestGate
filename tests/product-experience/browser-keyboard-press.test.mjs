import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {closePersistentBrowserContextsForScan,interactPersistentBrowser,navigatePersistentBrowser,withPersistentDiscoveryPage} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Native SQLite, real Chromium, loopback targets only. Planner responses and
// explicitly injected post-dispatch failures are fixtures, not live acceptance.
async function fixture(t,{navigate=true,submit=false}={}) {
 const mode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(mode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=mode;});
 const events=[];let submissions=0;
 const target=http.createServer((req,res)=>{
  if(req.url==='/submit'){submissions++;return;}
  if(req.url.startsWith('/key?')){events.push(Object.fromEntries(new URL(req.url,'http://fixture').searchParams));res.end('ok');return;}
  if(req.url==='/barrier'){res.end('ok');return;}
  res.setHeader('content-type','text/html');
  if(submit){res.end('<html><body><form method="post" action="/submit"><input id="target"></form></body></html>');return;}
  res.end(`<html><body><span id="status">Waiting for key</span>
   <dialog id="dialog"><input id="other"><input id="hidden" class="selected" style="display:none"><input id="target" class="selected"></dialog>
   <script>
    for (const type of ['keydown','keyup']) document.addEventListener(type,event=>{
     fetch('/key?'+new URLSearchParams({type,key:event.key,target:event.target.id,trusted:String(event.isTrusted)}));
     if(type==='keydown')document.getElementById('status').textContent=event.key+' on '+event.target.id;
    },true);
    document.getElementById('dialog').addEventListener('close',()=>document.getElementById('status').textContent+='; dialog closed');
    document.getElementById('dialog').showModal();document.getElementById('other').focus();
   </script></body></html>`);
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');
 t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
 const url=`http://127.0.0.1:${target.address().port}/`,db=await database(),repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});
 const task=await repo.createTask({scan_run_id:run.id,title:'Local keyboard contract',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 const input={repo,scanRunId:run.id,taskId:task.id,scope_base_url:url,timeout_ms:500};
 if(navigate)assert.equal((await navigatePersistentBrowser({...input,url})).ok,true);
 return {db,repo,run,input,url,events,get submissions(){return submissions;},press:(operation,extra={})=>interactPersistentBrowser({...input,operation:{action:'press',key:'Escape',...operation},...extra})};
}

async function executePlanner(t,f,decisions) {
 const contexts=[];
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;
  contexts.push(JSON.parse(JSON.parse(raw).messages.find(x=>x.role==='user').content).context);
  const planned=decisions[contexts.length-1];
  const decision=typeof planned==='function' ? planned(contexts.at(-1)) : planned||{action:'complete_task',summary:'Local keyboard fixture assertions completed.'};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`keyboard-${contexts.length}`,model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
 await f.db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
  ['keyboard-fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
 await new AIScanAgentRuntime(f.db).run(f.run.id);
 return {snapshot:await f.repo.getSnapshot(f.run.id),contexts};
}

function assertSingleEscape(events,target) {
 assert.equal(events.length,2);
 assert.deepEqual(events.filter(x=>x.type==='keydown'),[{type:'keydown',key:'Escape',target,trusted:'true'}]);
 assert.equal(events.filter(x=>x.type==='keyup'&&x.key==='Escape'&&x.trusted==='true').length,1);
}

for(const selected of [false,true])test(`${selected?'unique visible locator':'selectorless page'} Escape executes once through the scheduler and separately verifies dialog closure`,{timeout:20000},async t=>{
 const f=await fixture(t,{navigate:false}),operation={action:'press',key:'Escape'};
 const controlRef=context=>context.task_tool_invocations.at(-1)?.output_json?.observation?.controls?.find(control=>control.tag==='input')?.control_ref;
 const assertionRef=context=>context.task_tool_invocations.at(-1)?.output_json?.observation?.assertion_targets?.[0]?.assertion_ref;
 const expectedTarget='other';
 const {snapshot,contexts}=await executePlanner(t,f,[
  {action:'tool_call',tool_name:'browser.navigate',arguments:{url:f.url}},
  context=>({action:'tool_call',tool_name:'browser.interact',arguments:{operation:{...operation,...(selected?{control_ref:controlRef(context)}:{})}}}),
  context=>({action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'assert',assertion_ref:assertionRef(context),text:`Escape on ${expectedTarget}; dialog closed`}}}),
 ]);
 const attempt=snapshot.tool_invocations.find(x=>x.input_json.operation?.action==='press');
 assert.equal(attempt.status,'completed',attempt.output_json.error);
 assert.equal(snapshot.run.status,'completed');assert.equal(contexts.length,4);
 assert.equal(attempt.output_json.ok,true);
 assert.ok(contexts[2].task_tool_invocations.some(x=>x.id===attempt.id&&x.status==='completed'));
 assert.equal(snapshot.artifacts.filter(x=>x.artifact_type==='browser_state'&&x.content_json.action==='press'&&x.content_json.ok).length,1);
 assertSingleEscape(f.events,'other');
 assert.ok(snapshot.tool_invocations.some(x=>x.input_json.operation?.action==='assert'&&x.status==='completed'));
});

for(const [selector,code] of [['#absent','selector_no_match'],['#hidden','selector_not_visible'],['input:not(#hidden)','selector_ambiguous'],['[','selector_invalid']]) {
 test(`press rejects ${code} before dispatch without falling back to page keyboard`,{timeout:15000},async t=>{
  const f=await fixture(t),result=await f.press({selector});
  assert.equal(result.ok,false);assert.equal(result.error_code,code);assert.equal(result.failure_phase,'pre_action');
  assert.equal(result.action_performed,false);assert.equal(result.retryable,true);assert.equal(f.events.length,0);
 });
}

for(const selector of ['',null,undefined])test(`an explicitly invalid selector (${String(selector)}) never becomes page keyboard input`,{timeout:15000},async t=>{
 const f=await fixture(t),result=await f.press({selector});
 assert.equal(result.ok,false);assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
 assert.equal(result.retryable,false);assert.equal(f.events.length,0);
});

for(const selected of [false,true])test(`unsupported key is rejected before ${selected?'locator':'page'} dispatch`,{timeout:15000},async t=>{
 const f=await fixture(t),result=await f.press({key:'Control+Enter',...(selected?{selector:'#target'}:{})});
 assert.equal(result.ok,false);assert.match(result.error,/Unsupported business key/);
 assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);assert.equal(result.retryable,false);assert.equal(f.events.length,0);
});

for(const selected of [false,true])test(`${selected?'locator':'page'} dispatch failure remains uncertain and is never replayed by the scheduler`,{timeout:20000},async t=>{
 const f=await fixture(t);let dispatches=0;
 await withPersistentDiscoveryPage(f.input,async page=>{
  const failAfterDispatch=press=>async(...args)=>{
   dispatches++;await press(...args);await page.evaluate(()=>fetch('/barrier'));
   const error=new Error('Injected transport failure after real key dispatch');error.name='TimeoutError';throw error;
  };
  if(!selected)page.keyboard.press=failAfterDispatch(page.keyboard.press.bind(page.keyboard));
  else {
   const locate=page.locator.bind(page);
   page.locator=(...args)=>{
    const raw=locate(...args),intersect=raw.and.bind(raw);
    raw.and=other=>{const locator=intersect(other);locator.press=failAfterDispatch(locator.press.bind(locator));return locator;};
    return raw;
   };
  }
 });
 const {snapshot,contexts}=await executePlanner(t,f,[
  {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}}},
  context=>({action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'press',key:'Escape',...(selected?{control_ref:context.task_tool_invocations.at(-1)?.output_json?.observation?.controls?.find(control=>control.tag==='input')?.control_ref}:{})}}}),
 ]);
 assert.equal(snapshot.run.status,'failed');assert.equal(contexts.length,2);assert.equal(dispatches,1);
 const attempts=snapshot.tool_invocations.filter(x=>x.tool_name==='browser.interact');assert.equal(attempts.length,2);
 const failedAttempt=attempts.find(x=>x.input_json.operation?.action==='press');const result=failedAttempt.output_json;assert.equal(failedAttempt.status,'failed');assert.equal(result.failure_phase,'action_or_after');
 assert.notEqual(result.action_performed,false);assert.equal(result.retryable,false);assert.equal(result.retryable,false);
 assert.equal(snapshot.artifacts.filter(x=>x.artifact_type==='browser_state'&&x.content_json.action==='press').length,0);
 assertSingleEscape(f.events,'other');
});

test('pre-cancelled selectorless press dispatches no keys',{timeout:15000},async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 const result=await f.press({}, {signal:controller.signal});
 assert.equal(result.ok,false);assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
 assert.equal(result.retryable,false);assert.equal(f.events.length,0);
});

test('a real Enter submission timing out after locator dispatch is terminal and submits exactly once',{timeout:20000},async t=>{
 const f=await fixture(t,{submit:true});
 const {snapshot,contexts}=await executePlanner(t,f,[{action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}}},context=>({action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action:'press',key:'Enter',control_ref:context.task_tool_invocations.at(-1)?.output_json?.observation?.controls?.find(control=>control.tag==='input')?.control_ref}}})]);
 assert.equal(snapshot.run.status,'failed');assert.equal(contexts.length,2);assert.equal(f.submissions,1);
 const attempts=snapshot.tool_invocations.filter(x=>x.tool_name==='browser.interact');assert.equal(attempts.length,2);
 const failedAttempt=attempts.find(x=>x.input_json.operation?.action==='press');const result=failedAttempt.output_json;assert.equal(result.error_code,'browser_action_failed');assert.equal(result.failure_phase,'action_or_after');
 assert.notEqual(result.action_performed,false);assert.equal(result.retryable,false);
});

test('cancellation while a selected control waits never falls back to page keyboard',{timeout:15000},async t=>{
 const f=await fixture(t),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),100);t.after(()=>clearTimeout(timer));
 const result=await f.press({selector:'#absent'}, {signal:controller.signal});
 assert.equal(result.ok,false);assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
 assert.equal(result.retryable,false);assert.equal(f.events.length,0);
});

test('cancellation after selectorless dispatch retains performed action and terminal failure',{timeout:15000},async t=>{
 const f=await fixture(t),controller=new AbortController();let dispatches=0;
 await withPersistentDiscoveryPage(f.input,async page=>{
  const press=page.keyboard.press.bind(page.keyboard);
  page.keyboard.press=async(...args)=>{dispatches++;await press(...args);await page.evaluate(()=>fetch('/barrier'));controller.abort();};
 });
 const result=await f.press({}, {signal:controller.signal});
 assert.equal(result.ok,false);assert.equal(result.failure_phase,'action_or_after');assert.equal(result.action_performed,true);
 assert.equal(result.retryable,false);assert.equal(dispatches,1);assertSingleEscape(f.events,'other');
});

test('scope is checked before selectorless keyboard dispatch',{timeout:15000},async t=>{
 const f=await fixture(t),result=await f.press({}, {scope_base_url:'http://localhost:1/'});
 assert.equal(result.ok,false);assert.equal(result.failure_phase,'pre_action');assert.equal(result.action_performed,false);
 assert.equal(result.retryable,false);assert.equal(f.events.length,0);
});
