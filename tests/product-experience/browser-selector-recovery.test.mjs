import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Real Chromium + real scheduler. Only model replies use an explicit protocol fixture.
for(const scenario of ['corrected','repeated_ambiguity','failed_assertion','denied_correction','disabled_action','invalid_selector'])test(`real browser discovery selector handling: ${scenario}`,{timeout:30000},async t=>{
 const terminalScenario=['failed_assertion','disabled_action'].includes(scenario);
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 const target=http.createServer((_,res)=>{res.setHeader('content-type','text/html');res.end('<html><body><span id="total">Fixture total</span><span>Fixture total</span><button id="disabled" disabled>Disabled</button></body></html>');});
 target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>new Promise(r=>{target.closeAllConnections();target.close(r);}));
 const url=`http://127.0.0.1:${target.address().port}/`;
 let requests=0,feedbackObserved=false;
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),context=JSON.parse(body.messages.find(x=>x.role==='user').content).context;
  requests++;
  let decision;
  if(requests===1)decision={action:'tool_call',tool_name:'browser.navigate',arguments:{url}};
  else if(requests===2)decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action:scenario==='disabled_action'?'click':'assert',selector:scenario==='disabled_action'?'#disabled':scenario==='invalid_selector'?'[':scenario==='failed_assertion'?'#total':'text=Fixture total',text:scenario==='failed_assertion'?'Missing expected value':'Fixture total'}}};
  else if(requests===3 || scenario==='repeated_ambiguity'){
   feedbackObserved=context.task_tool_invocations.some(x=>x.status==='failed'&&x.output_json.error_code===(scenario==='invalid_selector'?'selector_invalid':'selector_ambiguous')&&(scenario==='invalid_selector'||x.output_json.match_count===2));
   if(scenario==='denied_correction'){res.writeHead(403);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'Protocol fixture refusal'}}));return;}
   decision={action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'assert',selector:scenario==='repeated_ambiguity'?'text=Fixture total':'#total',text:'Fixture total'}}};
  }else decision={action:'complete_task',summary:'Corrected unique selector assertion succeeded.'};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`protocol-fixture-${requests}`,model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');t.after(()=>new Promise(r=>{provider.closeAllConnections();provider.close(r);}));
 const db=await database();const repo=new AIScanRepository(db);
 await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',['browser-fixture','Explicit protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 await repo.createTask({scan_run_id:run.id,title:'Discover fixture',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 await new AIScanAgentRuntime(db).run(run.id);
 const snapshot=await repo.getSnapshot(run.id);
 assert.equal(feedbackObserved,!terminalScenario);
 assert.equal(requests,terminalScenario?2:['denied_correction','repeated_ambiguity'].includes(scenario)?3:4);
 assert.equal(snapshot.run.status,['corrected','invalid_selector'].includes(scenario)?'completed':'failed');
 const attempts=snapshot.tool_invocations.filter(x=>x.tool_name==='browser.interact');
 assert.equal(attempts.length,['corrected','invalid_selector','repeated_ambiguity'].includes(scenario)?2:1);
 assert.equal(attempts.filter(x=>x.status==='failed').length,scenario==='repeated_ambiguity'?2:1);
 assert.equal(attempts.filter(x=>x.status==='completed').length,['corrected','invalid_selector'].includes(scenario)?1:0);
 assert.equal(snapshot.artifacts.some(a=>a.artifact_type==='browser_state'&&a.content_json.action==='assert'&&a.content_json.ok===true),['corrected','invalid_selector'].includes(scenario));
 if(scenario==='denied_correction')assert.equal(snapshot.artifacts.filter(a=>a.artifact_type==='provider_policy_denial').length,1);
});

for (const action of ['click', 'fill']) for (const kind of ['missing', 'hidden', 'ambiguous']) {
 for (const outcome of ['corrected', 'bounded', 'denied', 'non_discovery']) {
  test(`pre-action ${action} ${kind}: ${outcome}, real Chromium and projected correction context`, {timeout:30000}, async t => {
   const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
   t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
   let mutations=0, requests=0, feedback=0;
   const target=http.createServer((req,res)=>{
    if(req.url==='/mutation'){mutations++;res.end('ok');return;}
    res.setHeader('content-type','text/html');
    res.end(`<html><body>${action==='fill' ? `<input id="visible" class="duplicate" aria-label="Customers" oninput="fetch('/mutation',{method:'POST'})"><input id="hidden" class="duplicate" style="display:none" oninput="fetch('/mutation',{method:'POST'})">` : `<button id="visible" class="duplicate" onclick="fetch('/mutation',{method:'POST'})">Customers</button>
     <button id="hidden" class="duplicate" style="display:none" onclick="fetch('/mutation',{method:'POST'})">Hidden</button>`}
     <button style="visibility:hidden">Invisible metadata</button>
     <input value="PRIVATE_INPUT_VALUE"><input type="password" value="PRIVATE_PASSWORD">
     <div data-sensitive><button>PRIVATE_SENSITIVE_TEXT</button></div>
     <button><span data-sensitive>PRIVATE_NESTED_TEXT</span></button><textarea>PRIVATE_TEXTAREA_VALUE</textarea></body></html>`);
   });
   target.listen(0,'127.0.0.1');await once(target,'listening');
   t.after(()=>new Promise(r=>{target.closeAllConnections();target.close(r);}));
   const url=`http://127.0.0.1:${target.address().port}/`;
   const selector={missing:'#absent',hidden:'#hidden',ambiguous:'.duplicate'}[kind];
   const code={missing:'selector_no_match',hidden:'selector_not_visible',ambiguous:'selector_ambiguous'}[kind];
   const provider=http.createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;
    const context=JSON.parse(JSON.parse(raw).messages.find(x=>x.role==='user').content).context;
    requests++;
    let decision;
    if(requests===1)decision={action:'tool_call',tool_name:'browser.navigate',arguments:{url}};
    else if(requests===2)decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action,selector,value:'fixture-value'}}};
    else {
     const failed=context.task_tool_invocations.filter(x=>x.status==='failed').at(-1)?.output_json;
     assert.equal(failed.error_code,code);assert.equal(failed.failure_phase,'pre_action');assert.equal(failed.action_performed,false);
     assert.equal(failed.match_count,{missing:0,hidden:1,ambiguous:2}[kind]);
     assert.ok(failed.context_key);
     assert.ok(failed.observation.controls.some(x=>x.id==='visible'&&(x.text==='Customers'||x.label==='Customers')));
     assert.ok(!failed.observation.controls.some(x=>x.id==='hidden'||x.text==='Invisible metadata'));
     assert.ok(!JSON.stringify(failed).includes('PRIVATE_'));feedback++;
     if(outcome==='denied'){res.writeHead(403);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'Fixture refusal during correction'}}));return;}
     if(outcome==='bounded'||requests===3) {
      assert.equal(mutations,0);
      decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action,selector:outcome==='bounded'?selector:'#visible',value:'fixture-value'}}};
     }else decision={action:'complete_task',summary:'Visible unique control reached.'};
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`local-${requests}`,model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
   });
   provider.listen(0,'127.0.0.1');await once(provider,'listening');
   t.after(()=>new Promise(r=>{provider.closeAllConnections();provider.close(r);}));
   const db=await database(),repo=new AIScanRepository(db);
   await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['selector-fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
   const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});
   t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
   await repo.createTask({scan_run_id:run.id,title:'Local selector regression',task_type:'autonomous_agent_task',execution_plan:{intent:outcome==='non_discovery'?'execute_test':'discover_target'}});
   await new AIScanAgentRuntime(db).run(run.id);
   const snapshot=await repo.getSnapshot(run.id),attempts=snapshot.tool_invocations.filter(x=>x.tool_name==='browser.interact');
   assert.equal(snapshot.run.status,outcome==='corrected'?'completed':'failed');
   assert.equal(requests,{corrected:4,bounded:3,denied:3,non_discovery:2}[outcome]);
   assert.equal(attempts.length,{corrected:2,bounded:2,denied:1,non_discovery:1}[outcome]);
   assert.equal(mutations,outcome==='corrected'?1:0);
   assert.equal(feedback,{corrected:2,bounded:1,denied:1,non_discovery:0}[outcome]);
   assert.equal(snapshot.artifacts.filter(x=>x.artifact_type==='provider_policy_denial').length,outcome==='denied'?1:0);
  });
 }
}
