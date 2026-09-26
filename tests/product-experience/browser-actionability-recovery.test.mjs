import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {closePersistentBrowserContextsForScan, interactPersistentBrowser, navigatePersistentBrowser} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Real Chromium + native SQLite + real scheduler; only the planner uses a local
// protocol fixture. No external target, account, upload or device is accessed.
async function fixture(t,{scenario='overlay',taskType='autonomous_agent_task',intent='discover_target',badSelector}={}) {
  const mode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
  t.after(()=>{if(mode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=mode;});
  let mutations=0,dismissals=0;
  const target=http.createServer((req,res)=>{
    if(req.url==='/mutation'){mutations++;if(scenario==='post_action_timeout')return;res.end('ok');return;}
    if(req.url==='/dismiss'){dismissals++;res.end('ok');return;}
    res.setHeader('content-type','text/html');
    const button=scenario==='post_action_timeout'?'<form method="post" action="/mutation"><button id="target">Continue</button></form>':
      '<button id="target" onclick="fetch(\'/mutation\',{method:\'POST\'})">Continue</button>';
    res.end(`<html><body>${button}${Array.from({length:30},(_,i)=>`<button id="extra-${i}">Extra ${i}</button>`).join('')}
      <input value="PRIVATE_INPUT"><input type="password" value="PRIVATE_PASSWORD"><textarea>PRIVATE_TEXTAREA</textarea>
      <div data-sensitive><button>PRIVATE_SENSITIVE</button></div><button><span data-sensitive>PRIVATE_NESTED</span></button>
      ${scenario.startsWith('overlay')?'<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:white;z-index:999"><button id="dismiss" onclick="this.parentElement.remove();fetch(\'/dismiss\',{method:\'POST\'})">Close dialog</button></div>':''}
      </body></html>`);
  });
  target.listen(0,'127.0.0.1');await once(target,'listening');
  t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
  const url=`http://127.0.0.1:${target.address().port}/`,contexts=[];
  const provider=http.createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const context=JSON.parse(JSON.parse(raw).messages.find(x=>x.role==='user').content).context;
      contexts.push(context);const n=contexts.length;
      let decision;
      if(n===1)decision={action:'tool_call',tool_name:'browser.navigate',arguments:{url}};
      else if(scenario==='overlay_denied'&&n===3){res.writeHead(403);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'Local fixture refusal'}}));return;}
      else if(n===2 || scenario==='overlay_repeated' || scenario==='bounded') {
        decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action:'click',
          selector:scenario==='malformed'?badSelector:scenario==='missing'?'button:has-text("W")':scenario==='bounded'?`#absent-${n}`:'#target'}}};
      } else if(scenario==='overlay'&&n===3)decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action:'click',selector:'#dismiss'}}};
      else if((scenario==='overlay'&&n===4)||(['missing','malformed'].includes(scenario)&&n===3))decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action:'click',selector:'#target'}}};
      else decision={action:'complete_task',summary:'Local corrected interaction completed.'};
      res.setHeader('content-type','application/json');res.end(JSON.stringify({id:`readiness-fixture-${n}`,model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:String(error)}}));}
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
  const db=await database(),repo=new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['readiness-fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
  const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});
  t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
  const task=await repo.createTask({scan_run_id:run.id,title:'Local readiness regression',task_type:taskType,execution_plan:{intent}});
  return {repo,run,task,contexts,url,get mutations(){return mutations;},get dismissals(){return dismissals;},
    execute:async()=>{await new AIScanAgentRuntime(db).run(run.id);return repo.getSnapshot(run.id);}};
}

for(const taskType of ['autonomous_agent_task','test_generic_vuln'])test(`overlay failure reaches planner and safely closes dialog: ${taskType}`,{timeout:30000},async t=>{
  const f=await fixture(t,{taskType,intent:taskType==='autonomous_agent_task'?'discover_target':'execute_test'}),snapshot=await f.execute();
  assert.equal(snapshot.run.status,'completed');assert.equal(f.contexts.length,5);
  assert.equal(f.mutations,1);assert.equal(f.dismissals,1);
  const failed=f.contexts[2].task_tool_invocations.at(-1);
  assert.equal(failed.status,'failed');assert.equal(failed.output_json.error_code,'selector_actionability_timeout');
  assert.equal(failed.output_json.failure_phase,'pre_action');assert.equal(failed.output_json.action_performed,false);
  assert.equal(failed.output_json.retryable,true);assert.match(failed.output_json.recovery_hint,/No click was dispatched/);
  const controls=failed.output_json.observation.controls;
  assert.ok(controls.some(x=>x.id==='dismiss'&&x.in_dialog&&x.receives_pointer));
  assert.ok(!JSON.stringify(failed.output_json).includes('PRIVATE_'));
  assert.equal(snapshot.artifacts.filter(x=>x.artifact_type==='browser_state'&&x.content_json.action==='click').length,2);
});

for(const scenario of ['overlay_repeated','overlay_denied','bounded'])test(`readiness corrections terminate safely: ${scenario}`,{timeout:30000},async t=>{
  const f=await fixture(t,{scenario}),snapshot=await f.execute();
  assert.equal(snapshot.run.status,'failed');assert.equal(f.contexts.length,scenario==='bounded'?4:3);
  assert.equal(f.mutations,0);assert.equal(f.dismissals,0);
  const attempts=snapshot.tool_invocations.filter(x=>x.tool_name==='browser.interact');
  assert.equal(attempts.length,{overlay_repeated:2,overlay_denied:1,bounded:3}[scenario]);
  assert.ok(attempts.every(x=>x.status==='failed'&&x.output_json.failure_phase==='pre_action'&&x.output_json.action_performed===false));
  if(scenario==='overlay_repeated'){
    // Snapshots are newest-first, with no chronology guaranteed for same-second
    // timestamps. Assert both rejection outcomes without relying on row order.
    const initial=attempts.filter(x=>x.output_json.error_code==='selector_actionability_timeout');
    const repeated=attempts.filter(x=>x.output_json.error_code==='selector_correction_repeated');
    assert.equal(initial.length,1);assert.equal(repeated.length,1);
    assert.equal(initial[0].output_json.retryable,true);
    assert.equal(repeated[0].output_json.retryable,false);
  }
  if(scenario==='overlay_denied')assert.equal(snapshot.artifacts.filter(x=>x.artifact_type==='provider_policy_denial').length,1);
});

for(const taskType of ['test_generic_vuln','test_file_upload'])test(`unobserved W selector gets actionable correction: ${taskType}`,{timeout:30000},async t=>{
  const f=await fixture(t,{scenario:'missing',taskType,intent:'execute_test'}),snapshot=await f.execute();
  assert.equal(snapshot.run.status,'completed');assert.equal(f.contexts.length,4);assert.equal(f.mutations,1);
  const failed=f.contexts[2].task_tool_invocations.at(-1).output_json;
  assert.equal(failed.error_code,'selector_no_match');assert.equal(failed.action_performed,false);assert.equal(failed.retryable,true);
  assert.match(failed.recovery_hint,/do not repeat/);assert.ok(failed.observation.controls.some(x=>x.id==='target'));
});

test('navigation timeout after a dispatched click is terminal and never marked action_performed:false',{timeout:30000},async t=>{
  const f=await fixture(t,{scenario:'post_action_timeout'}),snapshot=await f.execute();
  assert.equal(snapshot.run.status,'failed');assert.equal(f.contexts.length,2);assert.equal(f.mutations,1);
  const attempt=snapshot.tool_invocations.find(x=>x.tool_name==='browser.interact');
  assert.equal(attempt.status,'failed');assert.equal(attempt.output_json.failure_phase,'action_or_after');
  assert.notEqual(attempt.output_json.action_performed,false);assert.equal(attempt.output_json.retryable,false);
  assert.match(attempt.output_json.recovery_hint,/may have occurred/);
});

for(const badSelector of ['xpath=//*[','role=button[foo=bar]','text=/[/'])test(`malformed selector engine gets safe actionable correction: ${badSelector}`,{timeout:30000},async t=>{
  const f=await fixture(t,{scenario:'malformed',badSelector}),snapshot=await f.execute();
  assert.equal(snapshot.run.status,'completed');assert.equal(f.contexts.length,4);assert.equal(f.mutations,1);
  const failed=f.contexts[2].task_tool_invocations.at(-1).output_json;
  assert.equal(failed.error_code,'selector_invalid');assert.equal(failed.failure_phase,'pre_action');
  assert.equal(failed.action_performed,false);assert.equal(failed.retryable,true);
  assert.ok(failed.observation.controls.some(x=>x.id==='target'));
});

test('cancellation during trial does not become retryable',{timeout:30000},async t=>{
  const f=await fixture(t),input={repo:f.repo,scanRunId:f.run.id,taskId:f.task.id,scope_base_url:f.url};
  const navigated=await navigatePersistentBrowser({...input,url:f.url});assert.equal(navigated.ok,true);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),200);t.after(()=>clearTimeout(timer));
  const result=await interactPersistentBrowser({...input,signal:controller.signal,timeout_ms:1000,operation:{action:'click',selector:'#target'}});
  assert.equal(result.ok,false);assert.equal(result.retryable,false);assert.equal(f.mutations,0);
});
