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
function currentControlRef(context,index=0) {
 const invocation=[...(context.task_tool_invocations||[])].reverse().find(item=>
  item.tool_name==='browser.interact'||item.tool_name==='browser.navigate');
 const refs=invocation?.output_json?.observation?.controls||[];
 const ref=refs[index]?.control_ref;
 assert.equal(typeof ref,'string','the model fixture may select only a current observed opaque control reference');
 return ref;
}

async function executeSequence(t,operations) {
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 let mutations=0;
 const target=http.createServer((req,res)=>{
  if(req.url==='/mutation'){mutations++;res.end('ok');return;}
  res.setHeader('content-type','text/html');
  res.end('<html><body><p id="state">Current state</p><button id="unique" class="duplicate" onclick="fetch(\'/mutation\',{method:\'POST\'})">Continue</button><button class="duplicate">Other</button></body></html>');
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');
 t.after(()=>new Promise(resolve=>{target.closeAllConnections();target.close(resolve);}));
 const url=`http://127.0.0.1:${target.address().port}/`,contexts=[];
 const provider=http.createServer(async(req,res)=>{
  try {
   let raw='';for await(const chunk of req)raw+=chunk;
   contexts.push(JSON.parse(JSON.parse(raw).messages.find(message=>message.role==='user').content).context);
   const step=contexts.length-2,planned=operations[step];
   const operation=typeof planned==='function'?planned(context):planned;
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
 const run=await repo.createRun({base_url:url,scan_config:{surface:'web',driving_mode:'autopilot',authorization_acknowledged:true}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 await repo.createTask({scan_run_id:run.id,title:'Local independent selector episodes',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
 await new AIScanAgentRuntime(db).run(run.id);
 return {snapshot:await repo.getSnapshot(run.id),contexts,mutations};
}

const clickCurrent=context=>({action:'click',control_ref:currentControlRef(context)});
test('model browser episode reuses only current observed opaque control references',{timeout:30000},async t=>{
 const operations=[clickCurrent,clickCurrent];
 const {snapshot,contexts}=await executeSequence(t,operations);
 assert.equal(snapshot.run.status,'completed');assert.equal(snapshot.tasks[0].status,'completed');
 assert.equal(contexts.length,4);
 const attempts=snapshot.tool_invocations.filter(invocation=>invocation.tool_name==='browser.interact');
 // This generic discovery fixture intentionally has no execution authority:
 // it verifies the provider-facing episode only. Normal-business execution
 // and `action_performed` are exercised by the normal-business companion test.
 assert.equal(attempts.length,0);
 assert.equal(/"selector"\s*:/.test(JSON.stringify(contexts)),false,'model context retains opaque control references only');
 assert.equal(JSON.stringify(contexts).includes('Current state'),false,'page text stays private to the browser runtime');
 assert.equal(snapshot.artifacts.find(artifact=>artifact.artifact_type==='agent_task_budget').content_json.task_decision_limit,80);
});
