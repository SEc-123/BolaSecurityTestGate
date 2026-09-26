/** Appium endpoint and capture writer below are EXPLICIT TEST DOUBLES.
 * HTTPS backend sockets and certificate validation really run. No Android or
 * mitmproxy execution is claimed by this integration suite. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { tlsLab, httpsCall } from './https-fixture.mjs';
import { profile, session, flow, pkg, PNG, database, readySession } from './fixtures.mjs';
import { AndroidDeviceManager,parseUiAutomatorXml } from '../../server/src/services/mobile/android-device-manager.ts';
import { validateNetworkExpectations,evaluateNetworkExpectations } from '../../server/src/services/mobile/mobile-network-assertions.ts';
import { runConfiguredMobileFlow,launchMobileApp,stopMobileLab,getMobileTestReport,runMobileAppTest } from '../../server/src/services/mobile/mobile-lab-service.ts';
import { updateMobileSession,getMobileSession } from '../../server/src/services/mobile/mobile-session-service.ts';
import { withMobileOperation,withMobileTestRun } from '../../server/src/services/mobile/mobile-runtime-state.ts';

const scope=()=>({run_id:'run',step_id:'step',capture_session_id:'capture',device_id:'test-device',app_package:pkg,started_at:new Date(Date.now()-1000).toISOString()});
const expected=()=>[{id:'profile',method:'GET',url:'https://api.example.test/orders',response:{status:200,json:[{pointer:'/orders',equals:[]}]}}];
const wire=(s)=>({...flow(),test_run_id:s.run_id,step_id:s.step_id,capture_session_id:s.capture_session_id});

test('HTTPS validator accepts explicit JSON Pointer, status and exact host',()=>assert.deepEqual(validateNetworkExpectations(expected(),['api.example.test']),[]));
for(const [label,change] of [
 ['HTTP URL',e=>e.url='http://api.example.test/orders'],['credentials',e=>e.url='https://a:b@api.example.test/orders'],['fragment',e=>e.url+='\u0023fragment'],['outside allowlist',e=>e.url='https://other.example.test/orders'],['missing response',e=>delete e.response],['bad status',e=>e.response.status=999],['lowercase method',e=>e.method='get'],['misspelled assertion',e=>e.response.json_path='orders'],['bad pointer',e=>e.response.json=[{pointer:'$.orders',equals:[]}]],['unknown match',e=>e.match='whatever'],['zero maximum',e=>e.max_count=0],
])test(`HTTPS plan rejects ${label}`,()=>{const e=expected();change(e[0]);assert.ok(validateNetworkExpectations(e,['api.example.test']).length);});

test('same-step complete HTTPS response satisfies business assertion',()=>{const s=scope();assert.equal(evaluateNetworkExpectations(expected(),[wire(s)],s).ok,true);});
for(const [label,change] of [
 ['other run',f=>f.test_run_id='other'],['other step',f=>f.step_id='other'],['other capture',f=>f.capture_session_id='other'],['other device',f=>f.device_id='other'],['other App',f=>f.app_package='other'],['stale',f=>f.started_at='2000-01-01T00:00:00Z'],['HTTP downgrade',f=>f.url='http://api.example.test/orders'],['no client TLS',f=>f.tls.client_version=null],['no server TLS',f=>f.tls.server_version=null],['unverified upstream',f=>f.tls.upstream_verified=false],['incomplete request',f=>f.request_complete=false],['incomplete response',f=>f.response_complete=false],['missing body',f=>delete f.response_body_text],['wrong status',f=>f.response_status=403],['wrong JSON value',f=>f.response_body_text='{"orders":[1]}'],['bad JSON',f=>f.response_body_text='not json'],['wrong method',f=>f.method='POST'],['missing flow ID',f=>delete f.flow_id],
])test(`HTTPS evidence rejects ${label}`,()=>{const s=scope(),f=wire(s);change(f);assert.equal(evaluateNetworkExpectations(expected(),[f],s).ok,false);});
test('wrong-status response is not hidden by a later success for the same endpoint',()=>{const s=scope();assert.equal(evaluateNetworkExpectations(expected(),[{...wire(s),response_status:500},wire(s)],s).ok,false);});
test('negative test accepts expected 401 instead of treating every non-2xx as failure',()=>{const s=scope(),e=expected();e[0].response={status:401,json:[{pointer:'/error',equals:'unauthorized'}]};assert.equal(evaluateNetworkExpectations(e,[{...wire(s),response_status:401,response_body_text:'{"error":"unauthorized"}'}],s).ok,true);});
test('request identity and case-insensitive response headers are asserted',()=>{const s=scope(),e=expected();e[0].request={json:[{pointer:'/user',equals:'alice'}]};e[0].response.headers={'CONTENT-TYPE':'application/json'};const f={...wire(s),request_body_text:'{"user":"bob"}'};assert.equal(evaluateNetworkExpectations(e,[f],s).ok,false);f.request_body_text='{"user":"alice"}';assert.equal(evaluateNetworkExpectations(e,[f],s).ok,true);});
test('JSON Pointer escaping works and missing keys are not null',()=>{const s=scope(),e=expected();e[0].response.json=[{pointer:'/a~1b/~0key',equals:null},{pointer:'/absent',exists:false}];const f={...wire(s),response_body_text:'{"a/b":{"~key":null}}'};assert.equal(evaluateNetworkExpectations(e,[f],s).ok,true);e[0].response.json.push({pointer:'/absent',equals:null});assert.equal(evaluateNetworkExpectations(e,[f],s).ok,false);});
test('count constraints deduplicate same flow ID and reject real duplicate requests',()=>{const s=scope(),e=expected(),f=wire(s);e[0].max_count=1;assert.equal(evaluateNetworkExpectations(e,[f,f],s).ok,true);assert.equal(evaluateNetworkExpectations(e,[f,wire(s)],s).ok,false);});
test('Appium XML uses native class tags, and is not mistaken for empty UIAutomator hierarchy',()=>{const nodes=parseUiAutomatorXml(`<hierarchy><android.widget.TextView resource-id="${pkg}:id/status" text="Signed in" enabled="true" bounds="[0,0][100,80]"/></hierarchy>`);assert.equal(nodes.length,1);assert.equal(nodes[0].text,'Signed in');});

test('real HTTPS: certificate validation, failed/successful login, session revocation, wrong hostname and plaintext failure',async t=>{
 const lab=await tlsLab(t),req=(p,o={})=>httpsCall(lab.url+p,{ca:lab.cert,...o});
 assert.equal((await req('/profile')).status,401);
 assert.equal((await req('/login',{method:'POST',body:'{"username":"alice","password":"wrong"}'})).status,401);
 const login=await req('/login',{method:'POST',body:'{"username":"alice","password":"test-only-password"}'});assert.equal(login.status,200);assert.equal(login.tls.authorized,true);assert.match(login.tls.version,/TLS/);
 const token=JSON.parse(login.body).token,headers={Authorization:`Bearer ${token}`};assert.equal(JSON.parse((await req('/profile',{headers})).body).user.id,'alice');
 assert.equal((await req('/logout',{method:'POST',headers,body:'{}'})).status,200);assert.equal((await req('/profile',{headers})).status,401);
 await assert.rejects(httpsCall(lab.url+'/profile'));await assert.rejects(req('/profile',{servername:'wrong.example.test'}));
 await assert.rejects(new Promise((resolve,reject)=>{const q=http.get(lab.url.replace('https:','http:')+'/profile',r=>resolve(r.statusCode));q.on('error',reject);}));
});

const esc=s=>String(s).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
async function protocolFixture(t,lab,options={}) {
 const state={calls:[],username:'alice',password:'test-only-password',status:'Ready',token:null,session:null};
 const server=http.createServer(async(req,res)=>{
  try {
   let raw='';for await(const c of req)raw+=c;const body=raw?JSON.parse(raw):{};state.calls.push({url:req.url,method:req.method,body});let value=null;
   if(req.url==='/status')value={ready:true,build:{version:'TEST_DOUBLE_NOT_APPIUM'}};
   else if(req.url==='/session')value={sessionId:'protocol-fixture-session',capabilities:{...body.capabilities.alwaysMatch,...(options.wrongDevice?{'appium:udid':'WRONG'}:{})}};
   else if(req.url.endsWith('/execute/sync'))value=body.script==='mobile: getCurrentPackage'?pkg:body.script==='mobile: getCurrentActivity'?pkg+'.MainActivity':'started';
   else if(req.url.endsWith('/elements')){const id=/@resource-id='[^']*:id\/([^']+)'/.exec(body.value)?.[1];value=id?[{'element-6066-11e4-a52e-4f735466cecf':id}]:[];}
   else if(req.url.endsWith('/displayed'))value=true;
   else if(req.url.endsWith('/clear'))state[req.url.split('/').at(-2)]='';
   else if(req.url.endsWith('/value'))state[req.url.split('/').at(-2)]=body.text;
   else if(req.url.endsWith('/click')) {
     const id=req.url.split('/').at(-2);const endpoint='/'+id;const method=id==='profile'?'GET':'POST';
     const requestBody=id==='login'?JSON.stringify({username:state.username,password:state.password}):id==='logout'?'{}':undefined;
     const headers=state.token?{Authorization:`Bearer ${state.token}`}:{}, capture=state.session.health_json.capture;
     const scope=JSON.parse(await readFile(capture.path+'.step.json','utf8'));
     const result=await httpsCall(lab.url+endpoint,{ca:lab.cert,method,body:requestBody,headers});
     if(!options.dropCapture)await appendFile(capture.path,JSON.stringify({...flow(state.session),flow_id:randomUUID(),test_run_id:scope.run_id,step_id:scope.step_id,method,url:lab.url+endpoint,request_headers:headers,request_body_text:requestBody||'',response_headers:result.headers,response_status:result.status,response_body_text:result.body,started_at:result.started_at,completed_at:new Date().toISOString(),source_tool:'EXPLICIT_TEST_DOUBLE_NOT_MITMPROXY'})+'\n');
     if(id==='login'){state.token=result.status===200?JSON.parse(result.body).token:null;state.status=state.token?'Signed in':'Login rejected';}
     if(id==='profile')state.status=result.status===200?'Profile: alice':'Unauthorized';
     if(id==='logout'){state.status=result.status===200?'Signed out':'Unauthorized';if(result.status===200)state.token=null;}
   }
   else if(req.url.endsWith('/screenshot'))value=PNG;
   else if(req.url.endsWith('/source')){if(options.sourceError)throw Error('source unavailable');value='<hierarchy>'+['username','password','login','profile','logout','status'].map(id=>`<android.widget.TextView resource-id="${pkg}:id/${id}" text="${esc(id==='status'?state.status:id==='username'?state.username:id==='password'?'':id)}" enabled="true" bounds="[0,0][100,100]"/>`).join('')+'</hierarchy>';}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({value:{error:'unknown error',message:e.message}}));}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 state.url=`http://127.0.0.1:${server.address().port}`;return state;
}
async function integrated(t,options={}) {
 const lab=await tlsLab(t),f=await protocolFixture(t,lab,options),db=await database();t.after(()=>db.disconnect());
 const initial=profile();initial.appium_server_url=f.url;initial.config_json.capture_allowed_hosts=['127.0.0.1'];initial.config_json.appium_find_timeout_ms=100;
 const {session:s}=await readySession(db,initial);f.session=s;
 t.mock.method(AndroidDeviceManager.prototype,'runAdb',async()=>{throw Error('ADB UI fallback must NEVER run in Appium test');});
 await launchMobileApp(db,s.id);
 const step=(id,status,text,json)=>({action:'tap',target:{resource_id:id},expect:{resource_id:`${pkg}:id/status`,text},timeout_ms:300,expect_network:[{id,method:id==='profile'?'GET':'POST',url:lab.url+'/'+id,response:{status,...(json?{json}: {})}}]});
 return {lab,f,db,s,step};
}
test('PROTOCOL FIXTURE + real HTTPS + SQL: native driver business flow, UI+network evidence, cleanup-gated PASS and tamper BLOCK',async t=>{
 const {db,s,f,step}=await integrated(t);
 const steps=[{action:'fill',target:{resource_id:'password'},value:'wrong',expect:{resource_id:`${pkg}:id/password`},timeout_ms:100},step('login',401,'Login rejected',[{pointer:'/error',equals:'invalid_credentials'}]),{action:'fill',target:{resource_id:'password'},value:'test-only-password',expect:{resource_id:`${pkg}:id/password`},timeout_ms:100},step('login',200,'Signed in',[{pointer:'/token',exists:true}]),step('profile',200,'Profile: alice',[{pointer:'/user/id',equals:'alice'}]),step('logout',200,'Signed out',[{pointer:'/logged_out',equals:true}]),step('profile',401,'Unauthorized',[{pointer:'/error',equals:'unauthorized'}])];
 const result=await runConfiguredMobileFlow(db,s.id,steps);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.network_assertion_count,5);
 const pending=await getMobileTestReport(db,s.id);assert.equal(pending.gate_result,'BLOCK');assert.equal(pending.execution_passed,true,JSON.stringify(pending.integrity_errors));
 assert.equal(f.calls.filter(c=>c.url.endsWith('/click')).length,5);assert.equal(f.calls.some(c=>c.url.endsWith('/clear')),true);
 await stopMobileLab(db,s.id);const report=await getMobileTestReport(db,s.id);assert.equal(report.acceptance_complete,true,JSON.stringify(report));assert.equal(report.gate_result,'PASS');
 assert.equal(report.actions.some(a=>JSON.stringify(a.input_json).includes('test-only-password')),false);
 const file=report.actions[0].result_json.evidence.files['ui.json'].path;await writeFile(file,'{}');assert.equal((await getMobileTestReport(db,s.id)).gate_result,'BLOCK');
});
for(const [label,options,status,text] of [['no capture',{dropCapture:true},200,'Signed in'],['wrong HTTPS status',{},201,'Signed in'],['wrong UI',{},200,'Dashboard'],['broken Appium source',{sourceError:true},200,'Signed in']])test(`PROTOCOL FIXTURE: ${label} blocks; mutating click not retried`,async t=>{
 const {db,s,f,step}=await integrated(t,options);const result=await runConfiguredMobileFlow(db,s.id,[step('login',status,text)]);assert.equal(result.ok,false);assert.equal(f.calls.filter(c=>c.url.endsWith('/click')).length,1);await stopMobileLab(db,s.id);assert.equal((await getMobileTestReport(db,s.id)).gate_result,'BLOCK');
});
test('Strict real driver rejects wrong returned UDID and does not fall back to ADB',async t=>{const lab=await tlsLab(t),f=await protocolFixture(t,lab,{wrongDevice:true}),p=profile();p.appium_server_url=f.url;p.config_json.app_package=pkg;const driver=new AndroidDeviceManager(p);driver.runAdb=async()=>{throw Error('MUST NOT RUN');};await assert.rejects(driver.launchApp(pkg,'.MainActivity'),/mismatched UDID/);assert.equal(f.calls.filter(c=>c.url==='/session').length,1);assert.ok(f.calls.some(c=>c.method==='DELETE'));});
test('Strict driver taps/swipes/back exclusively through W3C Appium and releases pointer state',async t=>{const lab=await tlsLab(t),f=await protocolFixture(t,lab),p=profile();p.appium_server_url=f.url;const driver=new AndroidDeviceManager(p);driver.runAdb=async()=>{throw Error('MUST NOT RUN');};assert.equal((await driver.tap({x:1,y:2})).source,'appium_uiautomator2');assert.equal((await driver.swipe({x1:1,y1:2,x2:3,y2:4})).ok,true);assert.equal((await driver.back()).ok,true);assert.equal(f.calls.filter(c=>c.url.endsWith('/actions')&&c.method==='DELETE').length,2);assert.equal(f.calls.filter(c=>c.url.endsWith('/back')).length,1);await driver.closeAppiumSessions();});
test('Server test reservation excludes outside operations between lifecycle steps, but admits its own operations',async()=>{let release,inside;const started=new Promise(r=>inside=r);const task=withMobileTestRun('owned',async()=>{assert.equal(await withMobileOperation('owned',async()=>42),42);inside();await new Promise(r=>release=r);});await started;await assert.rejects(withMobileOperation('owned',async()=>{}),/MOBILE_BUSY/);await assert.rejects(withMobileTestRun('owned',async()=>{}),/MOBILE_BUSY/);release();await task;assert.equal(await withMobileOperation('owned',async()=>1),1);});
test('Server-owned test failure still stops session and persists BLOCK without creating any Appium success',async t=>{const db=await database();t.after(()=>db.disconnect());const{s,session:record}=await readySession(db);t.mock.method(AndroidDeviceManager.prototype,'closeAppiumSessions',async()=>({ok:true}));const report=await runMobileAppTest(db,record.id,[]);assert.equal(report.gate_result,'BLOCK');assert.equal(report.cleanup.ok,true);assert.equal((await getMobileSession(db,record.id)).status,'stopped');assert.ok(report.orchestration.errors.length);await assert.rejects(runMobileAppTest(db,record.id,[]),/fresh session/);});
test('UI-only flow is explicitly rejected as Appium HTTPS acceptance before any tap',async t=>{const db=await database();t.after(()=>db.disconnect());const {session:s}=await readySession(db);let taps=0;t.mock.method(AndroidDeviceManager.prototype,'tap',async()=>{taps++;return {ok:true};});await assert.rejects(runConfiguredMobileFlow(db,s.id,[{action:'tap',target:{resource_id:'login'},expect:{text:'Login'}}]),/expect_network/);assert.equal(taps,0);assert.equal((await getMobileSession(db,s.id)).health_json.flow_run.gate_result,'BLOCK');});
test('strict Appium requires explicit endpoint: no hidden ADB fallback',async()=>{const p=profile();p.appium_server_url=undefined;const d=new AndroidDeviceManager(p);let adb=0;d.runAdb=async()=>{adb++;return {ok:true};};await assert.rejects(d.tap({x:1,y:2}),/Appium|appium/);assert.equal(adb,0);});
test('strict proxy refuses HTTP reverse upstream and ssl_insecure before starting a process',async()=>{const {BurpCaptureService}=await import('../../server/src/services/mobile/burp-capture-service.ts');const p=profile();p.proxy_type='mitmproxy';p.config_json.mitm_proxy_mode='reverse';p.config_json.mitm_reverse_upstream='http://127.0.0.1:9000';await assert.rejects(new BurpCaptureService(p).startIfConfigured(),/downgrade/);p.config_json.mitm_reverse_upstream='https://127.0.0.1:9000';p.config_json.allow_insecure_upstream=true;await assert.rejects(new BurpCaptureService(p).startIfConfigured(),/ssl_insecure/);});
