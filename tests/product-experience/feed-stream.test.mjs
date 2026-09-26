import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { connectAssessment } from '../../src/lib/assessment-feed.ts';
import { ProductEventHub } from '../../server/src/services/ai-scan/product-event-hub.ts';
import { streamProductState } from '../../server/src/services/ai-scan/product-stream.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';
import { snapshot, now } from './fixtures.mjs';
const tick = () => new Promise(r=>setTimeout(r,12));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};}
class Source { listeners={};onopen=null;onerror=null;closed=false;addEventListener(type,fn){this.listeners[type]=fn;}close(){this.closed=true;}emit(data){this.listeners.assessment({data:JSON.stringify(data)});} }
const state = id => {const s=buildProductAssessmentState(snapshot(),now);s.run.id=id;return s;};
function client(t,opts={}){const source=new Source(),values=[],connections=[];const api=connectAssessment({runId:'a',url:'/events',read:async()=>state('a'),createSource:()=>source,onState:s=>values.push(s),onConnection:c=>connections.push(c),pollMs:20,...opts});t.after(()=>api.close());return {api,source,values,connections};}
test('subscribes before initial HTTP snapshot is ready',async t=>{const d=deferred();const c=client(t,{read:()=>d.promise});c.source.emit(state('a'));assert.equal(c.values.length,1);d.resolve(state('a'));await tick();assert.equal(c.values.length,1);});
test('slow HTTP read cannot overwrite a newer event',async t=>{const d=deferred();const c=client(t,{read:()=>d.promise});const fresh=state('a');fresh.run.name='new';c.source.emit(fresh);const old=state('a');old.run.name='old';d.resolve(old);await tick();assert.equal(c.values.at(-1).run.name,'new');});
test('wrong-run SSE payload is ignored',async t=>{const c=client(t);await tick();const before=c.values.length;c.source.emit(state('b'));assert.equal(c.values.length,before);});
test('wrong-run HTTP payload is ignored',async t=>{const c=client(t,{read:async()=>state('b')});await tick();assert.equal(c.values.length,0);});
test('close aborts fetch and ignores late events and reads',async t=>{const d=deferred();let signal;const c=client(t,{read:s=>{signal=s;return d.promise;}});c.api.close();assert.equal(signal.aborted,true);assert.equal(c.source.closed,true);d.resolve(state('a'));c.source.emit(state('a'));await tick();assert.equal(c.values.length,0);});
test('polling fallback is active when event stream is unavailable',async t=>{let reads=0;const c=client(t,{createSource:undefined,read:async()=>{reads++;return state('a');}});await new Promise(r=>setTimeout(r,70));assert.ok(reads>=2);assert.ok(c.connections.includes('polling'));});
test('disconnection recovers via HTTP, then rejoins SSE',async t=>{let reads=0;const c=client(t,{read:async()=>{reads++;return state('a');}});await tick();c.source.onopen();c.source.onerror();await tick();assert.ok(reads>=2);assert.ok(c.connections.includes('reconnecting'));c.source.emit(state('a'));assert.equal(c.connections.at(-1),'live');});
test('concurrent refreshes do not overlap',async t=>{const d=deferred();let calls=0;const c=client(t,{read:()=>{calls++;return d.promise;}});c.api.refresh();c.api.refresh();assert.equal(calls,1);d.resolve(state('a'));await tick();});
test('server read failures show offline rather than a success state',async t=>{const c=client(t,{createSource:undefined,read:async()=>{throw new Error('password=raw');}});await tick();assert.equal(c.values.length,0);assert.ok(c.connections.includes('offline'));assert.ok(!JSON.stringify(c.connections).includes('raw'));});
test('hub isolates runs and subscriber exceptions',()=>{const hub=new ProductEventHub();let a=0,b=0;const off=hub.subscribe('a',()=>{a++;});hub.subscribe('a',()=>{throw new Error('ignore viewer');});hub.subscribe('b',()=>{b++;});hub.publish('a');assert.equal(a,1);assert.equal(b,0);off();assert.equal(hub.count('a'),1);});
class Response extends EventEmitter {chunks=[];blocked=false;headers={};writeHead(code,headers){this.status=code;this.headers=headers;}flushHeaders(){}write(c){this.chunks.push(c);return !this.blocked;} }
function stream(t,{read=async()=>state('a'),...overrides}={}){const req=new EventEmitter(),res=new Response(),hub=new ProductEventHub();const close=streamProductState({req,res,read,subscribe:fn=>hub.subscribe('a',fn),pollMs:60000,heartbeatMs:60000,...overrides});t.after(close);return{req,res,hub,close};}
test('SSE sends an initial authoritative snapshot and deduplicates unchanged state',async t=>{const s=stream(t);await tick();const count=()=>s.res.chunks.filter(c=>c.includes('event: assessment')).length;assert.equal(count(),1);s.hub.publish('a');await tick();assert.equal(count(),1);assert.equal(s.res.headers['X-Accel-Buffering'],'no');assert.ok(s.res.chunks.join('').includes('id: '));});
test('invalidation during initial read is not lost',async t=>{const d=deferred();let reads=0;const s=stream(t,{read:()=>++reads===1?d.promise:Promise.resolve({...state('a'),phase_label:'新阶段'})});s.hub.publish('a');d.resolve(state('a'));await tick();assert.equal(reads,2);assert.match(s.res.chunks.at(-1),/新阶段/);});
test('backpressure bounds event writes and coalesces latest state',async t=>{let name='first';const s=stream(t,{read:async()=>({...state('a'),phase_label:name})});s.res.blocked=true;await tick();const n=s.res.chunks.length;for(let i=0;i<40;i++){name=String(i);s.hub.publish('a');}await tick();assert.equal(s.res.chunks.length,n);s.res.blocked=false;s.res.emit('drain');await tick();assert.match(s.res.chunks.at(-1),/"phase_label":"39"/);});
test('SSE disconnect releases subscriber, timers and listeners',async t=>{const s=stream(t);await tick();assert.equal(s.hub.count('a'),1);s.res.emit('close');assert.equal(s.hub.count('a'),0);const n=s.res.chunks.length;s.hub.publish('a');await tick();assert.equal(s.res.chunks.length,n);assert.equal(s.req.listenerCount('aborted'),0);});
test('SSE never exposes raw errors',async t=>{const s=stream(t,{read:async()=>{throw new Error('password=private SQL failure');}});await tick();assert.match(s.res.chunks.join(''),/event: unavailable/);assert.doesNotMatch(s.res.chunks.join(''),/SQL|password|private/);});
test('real HTTP SSE connection receives state, survives invalidation and disconnects cleanly',async t=>{
 const hub=new ProductEventHub();let name='first';const server=http.createServer((req,res)=>streamProductState({req,res,read:async()=>({...state('a'),phase_label:name}),subscribe:f=>hub.subscribe('a',f)}));
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const abort=new AbortController();const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal:abort.signal});assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
 const reader=response.body.getReader();let text='';while(!text.includes('event: assessment'))text+=new TextDecoder().decode((await reader.read()).value);assert.match(text,/first/);
 name='second';hub.publish('a');while(!text.includes('second'))text+=new TextDecoder().decode((await reader.read()).value);assert.match(text,/second/);abort.abort();await tick();assert.equal(hub.count('a'),0);
});
