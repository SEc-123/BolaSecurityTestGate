import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {AIClient} from '../../server/src/services/ai/ai-client.ts';
import {withScanControl,stopScanForPolicyDenial,scanPolicyDenial} from '../../server/src/services/ai-scan/run-control.ts';
import {fetchInTargetScope} from '../../server/src/services/ai-scan/target-scope.ts';
import {enhanceFeatureAndVulnModelWithAI} from '../../server/src/services/ai-scan/ai-planner.ts';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(t,handler){
 const db=await database();t.after(()=>db.disconnect());
 const server=http.createServer(async(req,res)=>{try{let raw='';for await(const b of req)raw+=b;await handler(JSON.parse(raw||'{}'),res);}catch{if(!res.destroyed){res.writeHead(500);res.end();}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const provider={id:'run-stop-fixture',name:'Protocol fixture',provider_type:'openai_compat',base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'test-only',model:'contract-model',is_enabled:true,is_default:true};
 await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[provider.id,provider.name,provider.provider_type,provider.base_url,provider.api_key,provider.model,1,1]);
 return {db,provider,repo:new AIScanRepository(db)};
}
const reply=(res,value)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'fixture-receipt',model:'contract-model',choices:[{message:{role:'assistant',content:typeof value==='string'?value:JSON.stringify(value)}}]}));};
const deny=res=>{res.writeHead(403);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'PRIVATE_REFUSAL_TEXT'}}));};
const request=content=>({model:'contract-model',messages:[{role:'user',content}],max_retries:3});

test('late parallel refusal cancels sibling fetch and prevents the next scheduler batch', {timeout:15000}, async t=>{
 const held=deferred(),closed=deferred(),counts=new Map();let first,second;
 const f=await fixture(t,async(body,res)=>{
  const id=JSON.parse(body.messages.find(m=>m.role==='user').content).context.task.id;
  counts.set(id,(counts.get(id)||0)+1);
  if(id===second){res.on('close',closed.resolve);held.resolve();return;}
  if(id===first&&counts.get(id)===1){reply(res,{action:'tool_call',tool_name:'bstg.capabilities.inventory',arguments:{}});return;}
  await held.promise;deny(res);
 });
 const run=await f.repo.createRun({base_url:'https://authorized.example.test',scan_config:{surface:'web',driving_mode:'autopilot',max_parallel_agents:2}});
 const tasks=[];for(let i=0;i<3;i++)tasks.push(await f.repo.createTask({scan_run_id:run.id,title:`Protocol task ${i}`,task_type:'autonomous_agent_task',priority:i,execution_plan:{intent:'inventory_bstg_capabilities'}}));
 [first,second]=tasks.map(x=>x.id);
 await new AIScanAgentRuntime(f.db).run(run.id);await closed.promise;
 const s=await f.repo.getSnapshot(run.id);
 assert.equal(counts.get(first),2);assert.equal(counts.get(second),1);assert.equal(counts.has(tasks[2].id),false);
 assert.equal(s.run.status,'failed');assert.ok(s.tasks.every(x=>x.status==='failed'));
 assert.equal(s.tool_invocations.length,1);assert.equal(s.tool_invocations[0].tool_name,'bstg.capabilities.inventory');
 assert.equal(s.artifacts.filter(x=>x.artifact_type==='provider_policy_denial').length,1);
 assert.equal(s.run.summary.provider_policy_denial.provider_id,f.provider.id);
 assert.doesNotMatch(JSON.stringify(s.run.summary),/PRIVATE_REFUSAL_TEXT/);
 assert.ok(!s.artifacts.some(x=>x.artifact_type==='agent_decision'&&x.content_json.source==='fallback'));
 await assert.rejects(new AIScanAgentRuntime(f.db).run(run.id),/已经结束/);
});

test('denied scope stops untagged nested requests while other runs and connection checks remain usable',{timeout:10000},async t=>{
 const slow=deferred(),closed=deferred();let blockedTargetCalls=0;
 const f=await fixture(t,async(body,res)=>{
  const name=body.messages[0].content;
  if(name==='slow'){res.on('close',closed.resolve);slow.resolve();return;}
  if(name==='deny'){await slow.promise;deny(res);return;}
  reply(res,'OK');
 });
 const client=new AIClient(f.provider);
 const results=await Promise.all([
  withScanControl('denied-run',async()=>{
   const attempts=await Promise.allSettled([client.chat(request('slow')),client.chat(request('deny'))]);
   assert.ok(attempts.every(x=>x.status==='rejected'&&x.reason.code==='provider_policy_denied'));
   await assert.rejects(client.chat(request('never-send')),e=>e.code==='provider_policy_denied');
   const registry=new AgentToolRegistry();registry.register({name:'test.action',description:'Test action',input_schema:{},handler:async()=>{blockedTargetCalls++;return {ok:true};}});
   await assert.rejects(registry.call('test.action',{},{}),e=>e.code==='provider_policy_denied');
   await assert.rejects(fetchInTargetScope(f.provider.base_url),e=>e.code==='provider_policy_denied');
   return scanPolicyDenial();
  }),
  withScanControl('independent-run',()=>client.chat(request('independent'))),
  client.testConnection(),
 ]);
 await closed.promise;assert.equal(blockedTargetCalls,0);assert.equal(results[0].code,'provider_policy_denied');assert.equal(results[1].id,'fixture-receipt');assert.equal(results[2].ok,true);
});

test('nested candidate planner cannot swallow a provider denial into heuristic success',async t=>{
 const f=await fixture(t,(_,res)=>deny(res));
 const run=await f.repo.createRun({base_url:'https://authorized.example.test'});
 await withScanControl(run.id,async()=>{
  await assert.rejects(enhanceFeatureAndVulnModelWithAI({db:f.db,repo:f.repo,scanRunId:run.id}),e=>e.code==='provider_policy_denied');
  assert.equal(scanPolicyDenial().model,'contract-model');
 });
 assert.equal((await f.repo.listCandidates(run.id)).length,0);
});

test('a swallowed nested denial cannot make a tool invocation successful',async()=>{
 await withScanControl('nested-denial',async()=>{
  const invocations=[],registry=new AgentToolRegistry();
  registry.register({name:'test.nested',description:'Test nested request',input_schema:{},handler:async()=>{
   stopScanForPolicyDenial({provider_id:'fixture',model:'contract-model'});return {ok:true,data:{result:'ignored'}};
  }});
  await assert.rejects(registry.call('test.nested',{}, {repo:{createToolInvocation:async x=>invocations.push(x)},scanRunId:'nested-denial'}),e=>e.code==='provider_policy_denied');
  assert.equal(invocations.length,1);assert.equal(invocations[0].status,'failed');
 });
});

test('independent entry points for the same run share cancellation until both have exited',{timeout:10000},async t=>{
 const slow=deferred(),closed=deferred();
 const f=await fixture(t,async(body,res)=>{
  if(body.messages[0].content==='slow'){res.on('close',closed.resolve);slow.resolve();return;}
  await slow.promise;deny(res);
 });
 const client=new AIClient(f.provider);
 const results=await Promise.allSettled([
  withScanControl('same-run',()=>client.chat(request('slow'))),
  withScanControl('same-run',()=>client.chat(request('deny'))),
 ]);
 await closed.promise;assert.ok(results.every(x=>x.status==='rejected'&&x.reason.code==='provider_policy_denied'));
});

test('cancelled HTTP execution is propagated instead of fabricated failed evidence or heuristic verdicts',{timeout:10000},async t=>{
 const {executeHttpRequest}=await import('../../server/src/services/ai-scan/http-executor.ts');
 const {judgeGenericAttempts}=await import('../../server/src/services/ai-scan/ai-generic-judge.ts');
 const {judgeUploadAttempts}=await import('../../server/src/services/ai-scan/ai-judge.ts');
 const entered=deferred(),closed=deferred();let calls=0;
 const target=http.createServer((_,res)=>{calls++;res.on('close',closed.resolve);entered.resolve();});
 target.listen(0,'127.0.0.1');await once(target,'listening');t.after(()=>new Promise(r=>{target.closeAllConnections();target.close(r);}));
 await withScanControl('target-abort',async()=>{
  const pending=executeHttpRequest({method:'GET',url:`http://127.0.0.1:${target.address().port}/fixture`,timeout_ms:5000});
  const rejected=assert.rejects(pending,e=>e.code==='provider_policy_denied');
  await entered.promise;stopScanForPolicyDenial({provider_id:'fixture',model:'contract-model'});await rejected;await closed.promise;
  await assert.rejects(judgeGenericAttempts({}, {vuln_type:'xss',endpoint:{},normal:{ok:false},attempts:[]}),e=>e.code==='provider_policy_denied');
  await assert.rejects(judgeUploadAttempts({}, '/fixture',[]),e=>e.code==='provider_policy_denied');
 });
 assert.equal(calls,1);
});
