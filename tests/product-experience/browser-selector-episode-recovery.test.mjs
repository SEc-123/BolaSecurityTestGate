import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Native SQLite, real local Chromium, scheduler and model-context projection.
// Only model decisions are a loopback protocol fixture; no saved target is used.
async function executeSequence(t,operations) {
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 let mutations=0;
 const target=http.createServer((req,res)=>{
  if(req.url==='/mutation'){mutations++;res.end('ok');return;}
  res.setHeader('content-type','text/html');
  res.end('<html><body><button id="unique" class="duplicate" onclick="fetch(\'/mutation\',{method:\'POST\'})">Continue</button><button class="duplicate">Other</button></body></html>');
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');
 t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
 const url=`http://127.0.0.1:${target.address().port}/`,contexts=[];
 const provider=http.createServer(async(req,res)=>{
  try {
   let raw='';for await(const chunk of req)raw+=chunk;
   contexts.push(JSON.parse(JSON.parse(raw).messages.find(message=>message.role==='user').content).context);
   const step=contexts.length-2,operation=operations[step];
   const decision=step<0?{action:'tool_call',tool_name:'browser.navigate',arguments:{url}}
    :operation?{action:'tool_call',tool_name:operation.action==='navigate'?'browser.navigate':'browser.interact',
      arguments:operation.action==='navigate'?{url}:{timeout_ms:500,operation}}
    :{action:'complete_task',summary:'All local selector recovery episodes completed.'};
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({id:`episode-fixture-${contexts.length}`,model:'contract-model',choices:[{message:{role:'assistant',content:JSON.stringify(decision)}}]}));
  }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{message:String(error)}}));}
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 t.after(()=>new Promise(resolve=>{provider.closeAllConnections();provider.close(resolve);}));
 const db=await database(),repo=new AIScanRepository(db);
 await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
  ['episode-fixture','Explicit local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot'}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 await repo.createTask({scan_run_id:run.id,title:'Local independent selector episodes',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 await new AIScanAgentRuntime(db).run(run.id);
 return {snapshot:await repo.getSnapshot(run.id),contexts,mutations};
}

const click=selector=>({action:'click',selector});
test('two selector rejections followed by ten successful actions do not exhaust a later independent recovery',{timeout:60000},async t=>{
 const operations=[click('#unique'),click('#unique'),click('.duplicate'),click('#absent'),
  ...Array.from({length:10},()=>click('#unique')),click('.duplicate'),click('#unique')];
 const {snapshot,contexts,mutations}=await executeSequence(t,operations);
 assert.equal(snapshot.run.status,'completed');assert.equal(snapshot.tasks[0].status,'completed');
 assert.equal(contexts.length,18);assert.equal(mutations,13);
 const attempts=snapshot.tool_invocations.filter(invocation=>invocation.tool_name==='browser.interact');
 assert.equal(attempts.length,16);assert.equal(attempts.filter(invocation=>invocation.status==='completed').length,13);
 const failures=attempts.filter(invocation=>invocation.status==='failed');
 assert.deepEqual(failures.map(invocation=>invocation.output_json.error_code).sort(),['selector_ambiguous','selector_ambiguous','selector_no_match']);
 assert.ok(failures.every(invocation=>invocation.output_json.failure_phase==='pre_action'&&invocation.output_json.action_performed===false&&invocation.output_json.retryable===true));
 const nextDecision=contexts[16];assert.equal(nextDecision.task.phase,'awaiting_selector_correction');
 // Snapshot rows are newest-first and can share a timestamp. Identify the
 // newly persisted failure by ID instead of assuming an incidental row order.
 const previousIds=new Set(contexts[15].task_tool_invocations.map(invocation=>invocation.id));
 const feedback=nextDecision.task_tool_invocations.find(invocation=>!previousIds.has(invocation.id)&&invocation.status==='failed');
 assert.ok(failures.some(invocation=>invocation.id===feedback?.id));
 assert.equal(feedback.output_json.error_code,'selector_ambiguous');assert.equal(feedback.output_json.match_count,2);
 assert.ok(feedback.output_json.observation.controls.some(control=>control.id==='unique'));
 assert.equal(snapshot.artifacts.find(artifact=>artifact.artifact_type==='agent_task_budget').content_json.task_decision_limit,80);
});

for(const interlude of [{action:'observe'},{action:'scroll',y:1},{action:'navigate'}]) {
 test(`successful ${interlude.action} does not replenish the two-correction episode budget`,{timeout:30000},async t=>{
  const {snapshot,contexts,mutations}=await executeSequence(t,[click('#absent-1'),interlude,click('#absent-2'),interlude,click('#absent-3')]);
  assert.equal(snapshot.run.status,'failed');assert.equal(contexts.length,6);assert.equal(mutations,0);
  const failures=snapshot.tool_invocations.filter(invocation=>invocation.status==='failed');
  assert.equal(failures.length,3);
  assert.ok(failures.every(invocation=>invocation.output_json.error_code==='selector_no_match'&&invocation.output_json.action_performed===false));
 });
}
