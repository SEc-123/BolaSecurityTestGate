import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Real Chromium + real scheduler. Only model replies use an explicit protocol fixture.
for(const scenario of ['corrected','repeated_ambiguity','failed_assertion','denied_correction'])test(`real browser discovery selector handling: ${scenario}`,{timeout:30000},async t=>{
 const priorMode=process.env.BSTG_BROWSER_MODE;process.env.BSTG_BROWSER_MODE='headless';
 t.after(()=>{if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;});
 const target=http.createServer((_,res)=>{res.setHeader('content-type','text/html');res.end('<html><body><span id="total">Fixture total</span><span>Fixture total</span></body></html>');});
 target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>new Promise(r=>{target.closeAllConnections();target.close(r);}));
 const url=`http://127.0.0.1:${target.address().port}/`;
 let requests=0,feedbackObserved=false;
 const provider=http.createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),context=JSON.parse(body.messages.find(x=>x.role==='user').content).context;
  requests++;
  let decision;
  if(requests===1)decision={action:'tool_call',tool_name:'browser.navigate',arguments:{url}};
  else if(requests===2)decision={action:'tool_call',tool_name:'browser.interact',arguments:{timeout_ms:500,operation:{action:'assert',selector:scenario==='failed_assertion'?'#total':'text=Fixture total',text:scenario==='failed_assertion'?'Missing expected value':'Fixture total'}}};
  else if(requests===3 || scenario==='repeated_ambiguity'){
   feedbackObserved=context.task_tool_invocations.some(x=>x.status==='failed'&&x.output_json.error_code==='selector_ambiguous'&&x.output_json.match_count===2);
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
 assert.equal(feedbackObserved,scenario!=='failed_assertion');
 assert.equal(requests,scenario==='failed_assertion'?2:scenario==='denied_correction'?3:4);
 assert.equal(snapshot.run.status,scenario==='corrected'?'completed':'failed');
 const attempts=snapshot.tool_invocations.filter(x=>x.tool_name==='browser.interact');
 assert.equal(attempts.length,scenario==='corrected'?2:scenario==='repeated_ambiguity'?3:1);
 assert.equal(attempts.filter(x=>x.status==='failed').length,scenario==='repeated_ambiguity'?3:1);
 assert.equal(attempts.filter(x=>x.status==='completed').length,scenario==='corrected'?1:0);
 assert.equal(snapshot.artifacts.some(a=>a.artifact_type==='browser_state'&&a.content_json.action==='assert'&&a.content_json.ok===true),scenario==='corrected');
 if(scenario==='denied_correction')assert.equal(snapshot.artifacts.filter(a=>a.artifact_type==='provider_policy_denial').length,1);
});
