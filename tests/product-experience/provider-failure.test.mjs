import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {AIClient} from '../../server/src/services/ai/ai-client.ts';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';

async function providerServer(t,handler){
 let calls=0;const server=http.createServer((req,res)=>{calls++;handler(req,res,calls);});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
 return {provider:{id:'contract-provider',name:'Explicit protocol test provider',provider_type:'openai_compat',base_url:`http://127.0.0.1:${server.address().port}/v1`,api_key:'contract-key',model:'contract-model',is_enabled:true,is_default:true},calls:()=>calls};
}
const denied='This content was flagged for possible cybersecurity risk. Apply for Daybreak access before retrying.';
for(const [status,body] of [[401,'Authentication required'],[403,denied],[502,denied],[413,'Input exceeds the maximum length of 1048576 characters.'],[502,'Input exceeds the maximum length of 1048576 characters.']])test(`provider ${status} permanent failure is not retried: ${body.slice(0,20)}`,async t=>{
 const f=await providerServer(t,(_,res)=>{res.writeHead(status);res.end(JSON.stringify({error:{message:body}}));});
 await assert.rejects(new AIClient(f.provider).chat({model:'contract-model',messages:[{role:'user',content:'Protocol test'}],max_retries:3}),new RegExp(String(status)));
 assert.equal(f.calls(),1);
});
test('transient provider outage can recover without changing model or input',async t=>{
 const bodies=[];const f=await providerServer(t,async(req,res,n)=>{let body='';for await(const part of req)body+=part;bodies.push(body);
  res.writeHead(n===1?503:200,{'content-type':'application/json'});res.end(n===1?'temporary outage':JSON.stringify({id:'upstream-receipt',model:'contract-model',choices:[{message:{role:'assistant',content:'OK'}}]}));});
 assert.equal((await new AIClient(f.provider).chat({model:'contract-model',messages:[{role:'user',content:'Protocol test'}]})).id,'upstream-receipt');
 assert.equal(f.calls(),2);assert.equal(bodies[0],bodies[1]);
});
test('provider refusal ends the actual scheduler before any target tool executes',async t=>{
 const f=await providerServer(t,(_,res)=>{res.writeHead(403);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:denied}}));});
 const db=await database();t.after(()=>db.disconnect());
 await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',[f.provider.id,f.provider.name,f.provider.provider_type,f.provider.base_url,f.provider.api_key,f.provider.model,1,1]);
 const repo=new AIScanRepository(db),run=await repo.createRun({base_url:'https://authorized.example.test',selected_vuln_types:['bola_idor'],scan_config:{surface:'web',driving_mode:'autopilot',max_parallel_agents:3}});
 await new AIScanAgentRuntime(db).run(run.id);
 const snapshot=await repo.getSnapshot(run.id),state=buildProductAssessmentState(snapshot);
 assert.equal(state.run.status,'failed');assert.equal(f.calls(),1);
 assert.equal(snapshot.endpoints.length,0);assert.equal(state.totals.confirmed_risks,0);assert.equal(state.totals.completed,0);
 assert.ok(state.diagnostics.some(item=>item.message.includes('整轮安全分析已停止')));
 assert.ok(!snapshot.artifacts.some(item=>['browser_state','endpoint_request','generic_mutation_attempt','agent_decision'].includes(item.artifact_type)));
});

test('policy denial cannot trigger the JSON compatibility retry',async t=>{
 const f=await providerServer(t,(_,res)=>{res.writeHead(400);res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'Daybreak access required; unsupported response_format request'}}));});
 await assert.rejects(new AIClient(f.provider).chat({model:'contract-model',messages:[{role:'user',content:'Protocol test'}],response_format:{type:'json_object'},max_retries:3}),/400/);
 assert.equal(f.calls(),1);
});
test('successful HTTP response with a model refusal is a permanent failure',async t=>{
 const f=await providerServer(t,(_,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'denied',model:'contract-model',choices:[{message:{role:'assistant',content:null,refusal:'Access denied'}}]}));});
 await assert.rejects(new AIClient(f.provider).chat({model:'contract-model',messages:[{role:'user',content:'Protocol test'}],max_retries:3}),/403/);
 assert.equal(f.calls(),1);
});
