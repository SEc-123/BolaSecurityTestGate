/** Driver I/O here is explicit test double input, not Android hardware evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AndroidDeviceManager, shellQuote, findNode, parseUiAutomatorXml } from '../../server/src/services/mobile/android-device-manager.ts';
import { startBackgroundCommand, stopBackgroundCommand, isBackgroundCommandRunning } from '../../server/src/services/mobile/command-runner.ts';
import { installAndVerifyProxyCertificate, provisionProxyCertificate } from '../../server/src/services/mobile/android-certificate-manager.ts';
import { buildMobileScanConfig } from '../../src/lib/mobile-scan-config.ts';
import { redactMobileInvocationInput } from '../../server/src/agent/tool-registry.ts';
import { profile, pkg, observation, networkExpected } from './fixtures.mjs';

async function appiumFixture(t, options={}) {
  const calls=[];
  let count=0;
  const server=http.createServer(async (req,res)=>{
    let raw=''; for await (const chunk of req) raw+=chunk;
    const body=raw?JSON.parse(raw):undefined;
    calls.push({url:req.url,method:req.method,body});
    let value=null;
    if(req.url==='/session') value={sessionId:`fixture-session-${++count}`,capabilities:{...body.capabilities.alwaysMatch}};
    else if(req.url.endsWith('/elements')) value=Array.from({length:options.elements??1},(_,i)=>({'element-6066-11e4-a52e-4f735466cecf':`test-${i}`}));
    if(req.url.endsWith('/displayed')) value=true;
    if(options.errorAt&&req.url.endsWith(options.errorAt)) value={error:'invalid element state',message:'fixture command error'};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return { calls, url:`http://127.0.0.1:${server.address().port}` };
}
function appiumProfile(url, serial='device-a', session='session-a') {
  const p=profile();return {...p,appium_server_url:url,adb_serial:serial,config_json:{...p.config_json,app_package:pkg,mobile_session_id:session,appium_find_timeout_ms:100}};
}

test('Appium Unicode fill clears first, conjunctively selects once, and does not echo secret',async t=>{
  const f=await appiumFixture(t);const driver=new AndroidDeviceManager(appiumProfile(f.url));
  const result=await driver.inputText({resourceId:'login',text:'User',contentDesc:'Input'},'中文 secret',true);
  assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes('中文 secret'),false);
  const find=f.calls.find(c=>c.url.endsWith('/elements'));
  assert.match(find.body.value,/@resource-id='test.authorized.app:id\/login' and @content-desc='Input' and @text='User' and @enabled="true"/);
  assert.deepEqual(f.calls.slice(-2).map(c=>c.url.split('/').at(-1)),['clear','value']);
  assert.equal(f.calls.at(-1).body.text,'中文 secret');
  const caps=f.calls[0].body.capabilities.alwaysMatch;
  assert.equal(caps['appium:udid'],'device-a');assert.equal(caps['appium:noReset'],true);assert.equal(caps['appium:autoLaunch'],false);
  assert.equal((await driver.closeAppiumSessions()).ok,true);
});

test('Appium cache is separate for device AND mobile session; closing one does not close others',async t=>{
  const f=await appiumFixture(t);
  const drivers=[new AndroidDeviceManager(appiumProfile(f.url,'d1','s1')),new AndroidDeviceManager(appiumProfile(f.url,'d2','s1')),new AndroidDeviceManager(appiumProfile(f.url,'d1','s2'))];
  for(const d of drivers) await d.inputText({resourceId:'login'},'a');
  assert.equal(f.calls.filter(c=>c.url==='/session').length,3);
  await drivers[0].closeAppiumSessions();assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
  await drivers[1].inputText({resourceId:'login'},'b');assert.equal(f.calls.filter(c=>c.url==='/session').length,3);
  await drivers[1].closeAppiumSessions();await drivers[2].closeAppiumSessions();
});

test('Appium HTTP200 W3C error is a failure, not success',async t=>{
  const f=await appiumFixture(t,{errorAt:'/value'});const d=new AndroidDeviceManager(appiumProfile(f.url));
  await assert.rejects(d.inputText({resourceId:'login'},'secret'),/invalid element state/);await d.closeAppiumSessions();
});
for(const elements of [0,2]) test(`Appium selector rejects ${elements} matches`,async t=>{
  const f=await appiumFixture(t,{elements});const d=new AndroidDeviceManager(appiumProfile(f.url));
  await assert.rejects(d.inputText({resourceId:'login'},'secret'),/exactly one/);assert.equal(f.calls.some(c=>c.url.endsWith('/value')),false);await d.closeAppiumSessions();
});
test('XPath strings containing both quotation styles are encoded with concat',async t=>{
  const f=await appiumFixture(t);const d=new AndroidDeviceManager(appiumProfile(f.url));
  await d.inputText({text:`Bob's "Name"`},'v');assert.match(f.calls.find(c=>c.url.endsWith('/elements')).body.value,/concat\('Bob', "'", 's "Name"'\)/);await d.closeAppiumSessions();
});

test('ADB passes one quoted remote-shell command; metacharacters are data, device is explicit',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'bstg-adb-argv-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const executable=path.join(dir,'adb-fixture');await writeFile(executable,`#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});
  const p=profile();p.config_json.adb_path=executable;const d=new AndroidDeviceManager(p);
  const value=`hello';$(whoami) & no-execution`;
  const result=await d.runAdb(['shell','input','text',value]);assert.equal(result.ok,true);
  assert.deepEqual(JSON.parse(result.stdout),['-s','test-device','shell',`'input' 'text' ${shellQuote(value)}`]);
  assert.throws(()=>shellQuote('bad\0value'),/NUL/);
});

test('ADB refuses lossy Unicode, literal %s, and unverifiable clear without Appium',async()=>{
  const p=profile();p.config_json.strict_real_e2e=false;p.appium_server_url=undefined;const d=new AndroidDeviceManager(p);
  let calls=0;d.runAdb=async()=>{calls++;throw new Error('should not run');};
  await assert.rejects(d.inputText({text:'User'},'中文'),/Unicode/);await assert.rejects(d.inputText({text:'User'},'a%sb'),/losslessly/);await assert.rejects(d.inputText({text:'User'},'ascii',true),/requires Appium/);assert.equal(calls,0);
});
test('No implicit or ambiguous tap; invalid coordinates rejected before device I/O',async()=>{
  const nodes=observation().ui_tree;assert.throws(()=>findNode(nodes,{}),/explicit/);assert.throws(()=>findNode([...nodes,...nodes],{text:'Login'}),/ambiguous/);
  const d=new AndroidDeviceManager(profile());d.dumpUiTree=async()=>{throw new Error('should not run');};
  await assert.rejects(d.tap({x:NaN,y:2}),/coordinates/i);await assert.rejects(d.swipe({x1:0,y1:0,x2:Infinity,y2:2}),/coordinates/i);
});
test('Password UI nodes do not persist cleartext in normalized UI hierarchy',()=>{
  const [n]=parseUiAutomatorXml('<node text="secret" password="true" class="android.widget.EditText" enabled="true" resource-id="pkg:id/pass"/>');
  assert.equal(n.text,'[redacted]');assert.equal(n.password,true);
});

test('Proxy setup rejects a preexisting reverse mapping before changing settings',async()=>{
  const p=profile();p.proxy_host='127.0.0.1';p.proxy_port=18080;const d=new AndroidDeviceManager(p);const calls=[];
  d.runAdb=async args=>{calls.push(args);return {ok:true,stdout:args[0]==='reverse'?'UsbFfs tcp:18080 tcp:18081\n':'old.proxy:3128',stderr:''};};
  assert.equal((await d.configureProxy()).configured,false);assert.equal(calls.some(a=>a.includes('put')),false);
});
test('Cleanup restores previous proxy and tolerates already-absent owned reverse mapping',async()=>{
  const p=profile();p.proxy_host='127.0.0.1';p.proxy_port=18080;const d=new AndroidDeviceManager(p);const calls=[];
  d.runAdb=async args=>{calls.push(args);return {ok:true,stdout:args.includes('get')?'old.proxy:3128':'',stderr:''};};
  const result=await d.clearProxy('old.proxy:3128',true);assert.equal(result.cleared,true);assert.equal(calls.some(a=>a.includes('--remove')),false);
});
test('Cleanup refuses to delete an externally changed reverse mapping',async()=>{
  const p=profile();p.proxy_host='127.0.0.1';p.proxy_port=18080;const d=new AndroidDeviceManager(p);const calls=[];
  d.runAdb=async args=>{calls.push(args);return {ok:true,stdout:args[0]==='reverse'?'UsbFfs tcp:18080 tcp:19000\n':args.includes('get')?'null':'',stderr:''};};
  assert.equal((await d.clearProxy(undefined,true)).cleared,false);assert.equal(calls.some(a=>a.includes('--remove')),false);
});
test('Legacy non-strict ADB cold app launch retries foreground observation, not launch side effect',async()=>{
  const p=profile();p.config_json.strict_real_e2e=false;p.appium_server_url=undefined;const d=new AndroidDeviceManager(p);let starts=0,observations=0;
  d.runAdb=async()=>{starts++;return {ok:true,stdout:'Starting',stderr:''};};
  d.currentActivity=async()=>({package:++observations>1?pkg:'android',raw:''});
  assert.equal((await d.launchApp(pkg,'.MainActivity')).ok,true);assert.equal(starts,1);assert.equal(observations,2);
});
test('Legacy non-strict ADB am-start command error does not pass only because shell exit code is zero',async()=>{
  const p=profile();p.config_json.strict_real_e2e=false;p.appium_server_url=undefined;const d=new AndroidDeviceManager(p);d.runAdb=async()=>({ok:true,stdout:'Error type 3\nError: Activity class does not exist',stderr:''});
  d.currentActivity=async()=>{throw new Error('must not inspect success');};assert.equal((await d.launchApp(pkg,'.Missing')).ok,false);
});

test('Process cleanup cannot signal an unowned PID, even current process',async()=>{assert.equal((await stopBackgroundCommand(process.pid)).stopped,false);});
test('Process cleanup stops an actually owned child and is idempotent',async()=>{
  const child=await startBackgroundCommand(process.execPath,['-e','setInterval(()=>{},1000)'],{startupGraceMs:100});
  assert.equal(child.ok,true);assert.equal(isBackgroundCommandRunning(child.pid),true);
  assert.equal((await stopBackgroundCommand(child.pid)).stopped,true);assert.equal(isBackgroundCommandRunning(child.pid),false);assert.equal((await stopBackgroundCommand(child.pid)).stopped,true);
});
test('Offline certificate provisioning is explicitly simulated without spawning mitmdump',async()=>{
  const p=profile();p.config_json.offline_simulator=true;p.config_json.mitmdump_path='/no/such/executable';
  const result=await provisionProxyCertificate(p);assert.equal(result.ok,true);assert.equal(result.diagnostics.simulated,true);
});
test('Android14 verification will not accept a same-named CA in inactive /system store',async()=>{
  const p=profile();p.android_api_level=34;p.certificate_mode='preinstalled_system_ca';p.config_json.allow_system_ca_install=true;
  const calls=[];const android={runAdb:async args=>{calls.push(args);return {ok:true,stdout:'not an X509 certificate',stderr:''};}};
  const result=await installAndVerifyProxyCertificate(p,android,{ok:true,mode:p.certificate_mode,provisioning:'configured_path',sha256:'a'.repeat(64),android_ca_hash:'deadbeef'});
  assert.equal(result.ok,false);assert.equal(result.install_verified,false);assert.equal(calls.length,1);assert.match(calls[0].at(-1),/^\/apex\/com.android.conscrypt\/cacerts/);
});

function validUi() {return {profile:profile(),app:{id:'apk-id',apk_path:'/authorized.apk',sha256:'a'.repeat(64),apk_source:'owned test APK',signer_sha256:'b'.repeat(64),signature_verified:true,package_name:pkg,launch_activity:'.MainActivity'},flowJson:JSON.stringify([{action:'tap',target:{text:'Login'},expect:{text:'Orders'},expect_network:networkExpected()}]),authorized:true};}
test('UI → scan config preserves APK identity, signer, source, device and real action assertions',()=>{
  const i=validUi(),cfg=buildMobileScanConfig(i);assert.equal(cfg.apk_source,i.app.apk_source);assert.equal(cfg.apk_sha256,i.app.sha256);assert.equal(cfg.apk_signer_sha256,i.app.signer_sha256);assert.equal(cfg.lab_profile_id,i.profile.id);assert.equal(cfg.device_id,'test-device');assert.equal(cfg.evidence_mode,'strict_device');assert.deepEqual(cfg.flow_steps,JSON.parse(i.flowJson));
});
for(const [label,mutate] of [
  ['unauthorized',i=>i.authorized=false],['disabled profile',i=>i.profile.is_enabled=false],['no APK',i=>i.app=null],['unsigned APK',i=>i.app.signature_verified=false],['no device',i=>i.profile.adb_serial=''],['no host scope',i=>i.profile.config_json.capture_allowed_hosts=[]],['empty flow',i=>i.flowJson='[]'],['wait-only',i=>i.flowJson='[{"action":"wait"}]'],['no assertion',i=>i.flowJson='[{"action":"tap"}]'],['invalid JSON',i=>i.flowJson='{'],
]) test(`UI preflight blocks ${label}`,()=>{const i=validUi();mutate(i);assert.throws(()=>buildMobileScanConfig(i));});
test('Mobile tool invocation redaction does not mutate executable input',()=>{
  const input={steps:[{action:'fill',value:'test-password',target:{resourceId:'pass'}}]};
  const logged=redactMobileInvocationInput('mobile.flow.run',input);assert.equal(logged.steps[0].value,'[redacted]');assert.equal(input.steps[0].value,'test-password');assert.equal(redactMobileInvocationInput('workflow.execute',input),input);
});

test('device API level and ABIs come from actual driver reads, not profile display values',async()=>{
 const p=profile();p.android_api_level=33;const d=new AndroidDeviceManager(p);d.runAdb=async args=>({ok:true,stdout:args.at(-1)==='ro.build.version.sdk'?'34\n':'arm64-v8a,armeabi-v7a\n',stderr:''});
 assert.deepEqual(await d.deviceCapabilities(),{ok:true,api_level:34,abis:['arm64-v8a','armeabi-v7a']});
});
test('missing actual device capabilities fails closed',async()=>{
 const d=new AndroidDeviceManager(profile());d.runAdb=async()=>({ok:true,stdout:'',stderr:''});assert.equal((await d.deviceCapabilities()).ok,false);
});
