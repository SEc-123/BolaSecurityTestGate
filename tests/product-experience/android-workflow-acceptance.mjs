#!/usr/bin/env node
/** Requires a real booted emulator, Appium UiAutomator2, mitmproxy and a locally built signed APK. */
import https from 'node:https';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),runtime=path.resolve(process.env.BSTG_ANDROID_RUNTIME||'artifacts/runtime-0.6.2');
const require=createRequire(path.join(root,'server/package.json'));const {chromium}=require('playwright');
const out=path.join(root,'artifacts',`android-closure-${Date.now()}`);await mkdir(out,{recursive:true});
const report={ok:false,scope:'Actual APK upload, real device operations/live display, verified HTTPS acquisition, BOLA execution, UI evidence and report export',observations:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let target,backend,browser,page,logs='',requests=0;
const negativeTls=process.env.BSTG_ANDROID_BAD_UPSTREAM_TLS==='1';
const scenario=negativeTls||process.env.BSTG_ANDROID_SCENARIO==='1';
try{
 target=https.createServer({key:await readFile(path.join(runtime,'tls/key.pem')),cert:await readFile(path.join(runtime,'tls/cert.pem'))},(req,res)=>{
  requests++;const url=new URL(req.url,'https://localhost');res.setHeader('content-type','application/json');
  if(url.pathname!='/api/documents'){res.writeHead(404);res.end('{}');return;}
  if(!['Bearer acceptance-owner-a','Bearer acceptance-owner-b'].includes(req.headers.authorization)){res.writeHead(401);res.end('{"error":"authentication required"}');return;}
  const id=url.searchParams.get('object_id');res.end(JSON.stringify({id,owner_id:id==='202'?'2':'1',content:id==='202'?'private document B':'private document A'}));
 });target.listen(19443);await once(target,'listening');
 const api='http://127.0.0.1:19444';
 let upstreamCA=path.join(runtime,'tls/ca.pem');
 if(negativeTls){
  upstreamCA=path.join(out,'unrelated-ca.pem');const key=path.join(out,'unrelated-key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=Unrelated acceptance CA','-keyout',key,'-out',upstreamCA],{stdio:'ignore'});await rm(key);
 }
 backend=spawn(process.execPath,['scripts/start-server.mjs'],{cwd:root,env:{...process.env,PORT:'19444',BSTG_DATA_DIR:path.join(out,'data'),BSTG_BROWSER_MODE:'headless',BUILT_IN_FORGE_API_KEY:'',OPENAI_API_KEY:'',NODE_EXTRA_CA_CERTS:path.join(runtime,'tls/ca.pem'),JAVA_HOME:'/Applications/Android Studio.app/Contents/jbr/Contents/Home',ANDROID_HOME:path.join(runtime,'android-sdk'),BSTG_MITMDUMP_PATH:path.join(runtime,'mitmproxy-venv/bin/mitmdump')},stdio:['ignore','pipe','pipe']});backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
 for(let i=0;;i++){if(backend.exitCode!==null)throw Error(logs.slice(-2000));try{if((await fetch(api+'/health')).ok)break;}catch{}if(i>100)throw Error('Backend timeout');await sleep(100);}
 // Lab provisioning is real persisted configuration. The APK and scan still enter through the product UI.
 const expectNetwork=[{id:'own-document',method:'GET',url:'https://localhost:19443/api/documents?object_id=101',response:{status:200,json:[{pointer:'/owner_id',equals:'1'}]}}];
 const scenarios=scenario?[{id:'view-document',business_name:'文档业务',test_name:'查看与刷新文档',app_package:'com.bstg.acceptance',steps:[
  {action:'tap',target:{contentDesc:'view-document'},expect:{text:'HTTP 200',match:'contains'},expect_network:expectNetwork,timeout_ms:5000},
  {action:'tap',target:{contentDesc:'refresh-document'},expect:{text:'HTTP 200',match:'contains'},expect_network:expectNetwork,timeout_ms:5000}]}]:[];
 const profileResponse=await fetch(api+'/api/mobile/profiles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'real-acceptance-avd',name:'真实 Android 验收设备',device_name:'Android API 30 验收设备',runtime_type:'local_avd',adb_serial:'emulator-5566',android_api_level:30,appium_server_url:'http://127.0.0.1:14723',proxy_type:'mitmproxy',proxy_host:'127.0.0.1',proxy_port:19445,certificate_mode:'preinstalled_system_ca',is_enabled:true,config_json:{business_scenarios:scenarios,allow_system_ca_install:true,upstream_ca_certificate_path:upstreamCA,device_wait_timeout_ms:90000,managed_proxy:true,mitm_proxy_mode:'regular'}})});
 assert.equal(profileResponse.status,201,await profileResponse.text());
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(api+'?lang=zh');
 await page.getByRole('button',{name:'Android App',exact:true}).click();
 await page.getByLabel('测试设备',{exact:true}).selectOption('real-acceptance-avd');
 await page.locator('input[type=file]').setInputFiles(path.join(runtime,'fixture-app/bstg-acceptance.apk'));
 await page.getByText('已准备：bstg-acceptance.apk',{exact:true}).waitFor();
 if(scenario)await page.getByLabel('文档业务 · 查看与刷新文档',{exact:true}).check();
 await page.getByLabel('测试名称',{exact:true}).fill('Android 真实闭环验收');await page.getByLabel('App 业务服务地址',{exact:true}).fill('https://localhost:19443');
 const scope=page.getByRole('group',{name:'安全检查范围'});const boxes=scope.getByRole('checkbox');for(let i=0;i<await boxes.count();i++)await boxes.nth(i).uncheck();await scope.getByLabel('跨账号越权',{exact:true}).check();
 await page.getByText('提供隔离测试账号（越权验证需要不同身份）',{exact:true}).click();
 await page.getByText('使用已授权的两个测试账号',{exact:false}).click();
 // Resolve account fields from their visible business labels; no API-injected scan identities.
 for(const [group,letter,id,object] of [['账号 A','a','1','101'],['账号 B','b','2','202']]){
  const fieldset=page.getByRole('group',{name:group,exact:true});
  await fieldset.getByLabel(`${group}用户名`,{exact:true}).fill('acceptance-'+letter);await fieldset.getByLabel(`${group}密码`,{exact:true}).fill('acceptance-test-only');
  await fieldset.getByText('越权测试材料（可选）',{exact:true}).click();
  await fieldset.getByLabel(`${group} user_id`,{exact:true}).fill(id);await fieldset.getByLabel(`${group} object_id`,{exact:true}).fill(object);await fieldset.getByLabel(`${group} authorization`,{exact:true}).fill('Bearer acceptance-owner-'+letter);
 }
 await page.getByText('我已获得目标、安装包与账号的测试授权',{exact:false}).click();
 const created=page.waitForResponse(r=>r.url().includes('/api/ai-scans?view=product')&&r.request().method()==='POST');await page.getByRole('button',{name:'开始测试',exact:true}).click();const response=await created;assert.equal(response.status(),201);report.run_id=(await response.json()).data.run.id;
 let state;const until=Date.now()+300000,frames=new Set();let activeFrame=false;
 while(Date.now()<until){state=(await(await fetch(`${api}/api/ai-scans/${report.run_id}/product-state`)).json()).data;
  report.observations.push({at:new Date().toISOString(),status:state.run.status,operations:state.operations,frame:state.live_surface});
  if(state.live_surface){const frame=state.live_surface;frames.add(frame.captured_at);assert.equal((await fetch(api+frame.image_url)).status,200);if(frame.state==='live'&&state.operations.some(o=>o.id===frame.operation_id&&o.status==='running'))activeFrame=true;}
  if(['completed','failed'].includes(state.run.status))break;await sleep(300);
 }
 await writeFile(path.join(out,'final-state.json'),JSON.stringify(state,null,2));const technical=(await(await fetch(`${api}/api/ai-scans/${report.run_id}`)).json()).data;await writeFile(path.join(out,'technical-state.json'),JSON.stringify(technical,null,2));
 report.requests=requests;report.frame_versions=frames.size;report.live_frame_during_operation=activeFrame;
 if(negativeTls){
  assert.equal(state.run.status,'failed');assert.equal(requests,0,'Untrusted upstream must never receive an HTTP application request');
  assert.equal(state.totals.confirmed_risks,0);assert.equal(state.totals.completed,0);assert.ok(state.operations.some(o=>o.status==='failed'));
  await page.getByRole('heading',{name:state.phase_label,exact:true}).waitFor();await page.screenshot({path:path.join(out,'tls-rejected.png'),fullPage:true});
  report.negative_case='Real APK HTTPS request rejected by proxy upstream certificate validation';
  const failedRun=report.run_id;
  const profile=(await(await fetch(api+'/api/mobile/profiles')).json()).data.find(p=>p.id==='real-acceptance-avd');
  profile.config_json.upstream_ca_certificate_path=path.join(runtime,'tls/ca.pem');
  const repair=await fetch(api+'/api/mobile/profiles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(profile)});
  assert.equal(repair.status,201,await repair.text());
  const retried=page.waitForResponse(r=>r.url().endsWith(`/api/ai-scans/${failedRun}/retry`)&&r.request().method()==='POST');
  await page.getByRole('button',{name:'重新测试',exact:true}).click();const retryResponse=await retried;assert.equal(retryResponse.status(),201);
  const retry=(await retryResponse.json()).data;report.retry_run_id=retry.run.id;assert.notEqual(retry.run.id,failedRun);
  let recovered;const retryUntil=Date.now()+300000;
  while(Date.now()<retryUntil){
    recovered=(await(await fetch(`${api}/api/ai-scans/${retry.run.id}/product-state`)).json()).data;
    if(['completed','failed'].includes(recovered.run.status))break;await sleep(500);
  }
  await writeFile(path.join(out,'retry-state.json'),JSON.stringify(recovered,null,2));
  assert.equal(recovered.run.status,'completed');assert.equal(recovered.totals.failed,0);assert.equal(recovered.totals.completed,recovered.totals.tests);assert.ok(recovered.totals.confirmed_risks>=1);assert.ok(requests>0);
  const prior=(await(await fetch(`${api}/api/ai-scans/${failedRun}/product-state`)).json()).data;
  assert.equal(prior.run.status,'failed');assert.equal(prior.totals.completed,0);assert.equal(prior.totals.confirmed_risks,0);
  await page.getByRole('heading',{name:recovered.phase_label,exact:true}).waitFor();
  await page.getByText(`已完成 ${recovered.totals.completed} / ${recovered.totals.tests} 项 · 已确认 ${recovered.totals.confirmed_risks} 个问题`,{exact:true}).waitFor();
  await page.locator('[data-test-id="mobile:view-document"]').click();await page.getByTestId('mobile-step-evidence').nth(1).waitFor();
  const review=(await(await fetch(`${api}/api/ai-scans/${retry.run.id}/tests/${encodeURIComponent('mobile:view-document')}/evidence`)).json()).data;
  assert.ok(review.steps.every(s=>s.integrity_verified&&s.ui_verified&&s.network_verified));
  await page.screenshot({path:path.join(out,'retry-recovered.png'),fullPage:true});assert.deepEqual(errors,[]);
  report.ok=true;report.retry_recovery=true;report.requests_after_recovery=requests;
 }else{
 assert.equal(state.run.status,'completed');assert.ok(requests>=5);assert.ok(frames.size>=2);assert.ok(activeFrame,'Display must advance while a real device command is running');assert.ok(state.operations.length>=(scenario?2:3));assert.ok(state.operations.every(o=>o.status==='completed'));assert.ok(state.totals.confirmed_risks>=1);assert.equal(state.totals.failed,0);assert.equal(state.totals.completed,state.totals.tests);
 await page.getByRole('heading',{name:state.phase_label,exact:true}).waitFor();await page.getByTestId('mobile-operation-list').waitFor();await page.screenshot({path:path.join(out,'workspace.png'),fullPage:true});
 await page.getByTestId('business-test').first().click();await page.getByTestId('evidence-review').locator('article').first().waitFor();await page.screenshot({path:path.join(out,'evidence.png'),fullPage:true});
 if(scenario){
  await page.locator('[data-test-id="mobile:view-document"]').click();
  await page.getByTestId('mobile-step-evidence').nth(1).waitFor();
  const review=(await(await fetch(`${api}/api/ai-scans/${report.run_id}/tests/${encodeURIComponent('mobile:view-document')}/evidence`)).json()).data;
  assert.equal(review.steps.length,2);assert.ok(review.steps.every(s=>s.integrity_verified&&s.ui_verified));assert.equal(review.steps.filter(s=>s.network_verified).length,2);
  await writeFile(path.join(out,'scenario-evidence.json'),JSON.stringify(review,null,2));await page.screenshot({path:path.join(out,'scenario-evidence.png'),fullPage:true});
 }
 await page.getByRole('button',{name:'测试报告',exact:false}).click();const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出报告',exact:true}).click();await(await downloadPromise).saveAs(path.join(out,'report.md'));
 assert.deepEqual(errors,[]);report.ok=true;
 }
}catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});report.error=String(error.stack||error);process.exitCode=1;}
finally{await browser?.close();if(backend){backend.kill('SIGTERM');await Promise.race([once(backend,'exit'),sleep(5000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}if(target)await new Promise(r=>{target.closeAllConnections();target.close(r);});await writeFile(path.join(out,'backend.log'),logs);await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,out,error:report.error},null,2));}
