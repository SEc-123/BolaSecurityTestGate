import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizeViewer,ViewerTickets,ViewerDenied} from '../../server/src/services/live-browser/access-policy.ts';
const local=()=>({socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3001',origin:'http://127.0.0.1:3001'}});
const env={BSTG_LIVE_ACCESS_MODE:'local'};
const denied=fn=>assert.throws(fn,e=>e instanceof ViewerDenied);
test('loopback same-origin operator may obtain a watch ticket',()=>assert.equal(authorizeViewer(local(),'run-1',true,env).principal,'local-operator'));
for(const [name,mutate] of [
 ['remote client',r=>r.socket.remoteAddress='192.0.2.5'],
 ['DNS rebinding',r=>r.headers.host='attacker.invalid'],
 ['cross-origin',r=>r.headers.origin='http://attacker.invalid'],
 ['missing origin on write',r=>delete r.headers.origin],
 ['cross-site fetch',r=>r.headers['sec-fetch-site']='cross-site'],
 ['forwarded client',r=>r.headers['x-forwarded-for']='192.0.2.5'],
 ['spoofed identity',r=>r.headers['x-bstg-user']='alice'],
 ['duplicate origin',r=>r.headers.origin=['http://127.0.0.1:3001','https://evil.invalid']],
]) test(`deny ${name}`,()=>{const r=local();mutate(r);denied(()=>authorizeViewer(r,'run-1',true,env));});
test('metadata can be loaded by same-origin fetch without Origin',()=>{const r=local();delete r.headers.origin;assert.ok(authorizeViewer(r,'run-1',false,env));});
const proxyEnv={BSTG_LIVE_ACCESS_MODE:'proxy',BSTG_LIVE_PROXY_IP:'127.0.0.1',BSTG_LIVE_PROXY_SECRET:'s'.repeat(48),BSTG_PUBLIC_ORIGIN:'https://bstg.example'};
function proxy(){return {socket:{remoteAddress:'127.0.0.1'},headers:{host:'backend',origin:'https://bstg.example','x-bstg-proxy-secret':'s'.repeat(48),'x-bstg-user':'alice@example','x-bstg-run-ids':'run-1,run-2'}};}
test('trusted auth proxy must explicitly grant this run',()=>assert.equal(authorizeViewer(proxy(),'run-2',true,proxyEnv).principal,'alice@example'));
for(const [name,mutate] of [
 ['untrusted proxy socket',r=>r.socket.remoteAddress='192.0.2.6'],
 ['wrong proxy secret',r=>r.headers['x-bstg-proxy-secret']='w'.repeat(48)],
 ['missing identity',r=>delete r.headers['x-bstg-user']],
 ['wildcard run grants',r=>r.headers['x-bstg-run-ids']='*'],
 ['different run grants',r=>r.headers['x-bstg-run-ids']='run-3'],
 ['proxy cross origin',r=>r.headers.origin='https://elsewhere.example'],
])test(`deny ${name}`,()=>{const r=proxy();mutate(r);denied(()=>authorizeViewer(r,'run-1',true,proxyEnv));});
test('remote mode requires an exact HTTPS public origin',()=>denied(()=>authorizeViewer(proxy(),'run-1',true,{...proxyEnv,BSTG_PUBLIC_ORIGIN:'http://bstg.example'})));
test('a short shared secret cannot authorize a proxy',()=>{const r=proxy();r.headers['x-bstg-proxy-secret']='short';denied(()=>authorizeViewer(r,'run-1',true,{...proxyEnv,BSTG_LIVE_PROXY_SECRET:'short'}));});
test('unknown access mode fails closed',()=>denied(()=>authorizeViewer(local(),'run-1',true,{BSTG_LIVE_ACCESS_MODE:'unknown'})));
const identity={principal:'alice',origin:'https://bstg.example'};
test('ticket is unpredictable, single use and 30s bounded',()=>{let now=1000;const t=new ViewerTickets(()=>now);const a=t.issue(identity,'run-1','session-1');assert.equal(a.ticket.length,43);t.consume(a.ticket,identity,'run-1','session-1');denied(()=>t.consume(a.ticket,identity,'run-1','session-1'));const b=t.issue(identity,'run-1','session-1');now+=30000;denied(()=>t.consume(b.ticket,identity,'run-1','session-1'));});
for(const [name,id,run,session] of [
 ['other principal',{...identity,principal:'bob'},'run-1','session-1'],
 ['other origin',{...identity,origin:'https://other.example'},'run-1','session-1'],
 ['other run',identity,'run-2','session-1'],
 ['other session',identity,'run-1','session-2'],
])test(`ticket denies ${name}`,()=>{const t=new ViewerTickets();const a=t.issue(identity,'run-1','session-1');denied(()=>t.consume(a.ticket,id,run,session));denied(()=>t.consume(a.ticket,identity,'run-1','session-1'));});
test('ticket quota limits an authenticated principal and expiry releases quota',()=>{let now=0;const t=new ViewerTickets(()=>now);for(let i=0;i<64;i++)t.issue(identity,'r','s');assert.throws(()=>t.issue(identity,'r','s'),e=>e.status===429);now=30001;assert.ok(t.issue(identity,'r','s'));});
