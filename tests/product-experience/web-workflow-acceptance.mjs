#!/usr/bin/env node
/** Real browser + product API + SQLite + scanner against a disposable local target.
 * The target is intentionally vulnerable; no product HTTP response or browser API is mocked. */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {loadAcceptanceProvider,configureAcceptanceProvider,verifyModelDecisions} from './live-provider.mjs';
const actualProvider=await loadAcceptanceProvider();
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'server/package.json'));
const {chromium}=require('playwright');
const out=path.resolve(process.env.BSTG_WEB_CLOSURE_OUT||path.join(root,'artifacts',`web-closure-${Date.now()}`));
await mkdir(out,{recursive:true});
const report={scope:'Real Web UI creation, discovery, upload/XSS execution, live state, findings and report export',started_at:new Date().toISOString(),ok:false,observations:[]};
const files=new Map();let server,browser,page,backend,logs='',targetRequests=0;
const port=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tlsDirectory=process.env.BSTG_WEB_TLS_DIR;
const allCategories=process.env.BSTG_WEB_ALL_CATEGORIES==='1';
const categoryPaths=['/api/download?file=normal.txt','/api/ping?host=localhost','/api/documents?object_id=101','/api/admin/manage?role=member','/api/cart?quantity=1','/api/verify-otp?code=654321','/api/passcode?passcode=654321','/api/order/refund?object_id=101&amount=1'];
try{
const handle=async(req,res)=>{
  targetRequests++;
  if(/\{\{|%7b%7b/i.test(req.url))report.unresolved_payload_requests=(report.unresolved_payload_requests||0)+1;
  const url=new URL(req.url,'http://localhost');
  if(req.method==='POST'&&url.pathname==='/upload'){
   const chunks=[];for await(const c of req)chunks.push(c);
   const form=await new Response(Buffer.concat(chunks),{headers:{'content-type':req.headers['content-type']}}).formData();const file=form.get('attachment');
   if(!file||typeof file==='string'){res.writeHead(400);res.end('missing upload');return;}
   files.set(file.name,{type:file.type,body:Buffer.from(await file.arrayBuffer())});
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({url:`/files/${encodeURIComponent(file.name)}`}));return;
  }
  if(url.pathname.startsWith('/files/')){const file=files.get(decodeURIComponent(url.pathname.slice(7)));res.writeHead(file?200:404,{'content-type':file?.type||'text/plain'});res.end(file?.body||'missing');return;}
  res.setHeader('content-type','text/html; charset=utf-8');
  if(url.pathname==='/search'){res.end(`<title>站内搜索</title><h1>搜索结果</h1><div>${url.searchParams.get('q')||''}</div>`);return;}
  // These endpoints deliberately return a generic successful JSON response.
  // They exercise discovery/execution and MUST NOT become confirmed business
  // or authorization vulnerabilities merely because the response says success.
  if(allCategories&&url.pathname.startsWith('/api/')){res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,received:Object.fromEntries(url.searchParams),message:'accepted admin verified paid'}));return;}
  if(url.pathname==='/'){res.end('<!doctype html><title>授权验收靶场</title><h1>文档中心</h1><a href="/search?q=baseline">站内搜索</a>'+(allCategories?categoryPaths.map(p=>`<a href="${p.replaceAll('&','&amp;')}">${p.split('?')[0]}</a>`).join(' '):'')+'<form method="POST" action="/upload" enctype="multipart/form-data"><label>上传文件<input type="file" name="attachment"></label><input type="hidden" name="folder" value="acceptance"><button type="submit">上传</button></form>');return;}
  res.writeHead(404);res.end('not found');
 };
 server=tlsDirectory?https.createServer({key:await readFile(path.join(tlsDirectory,'key.pem')),cert:await readFile(path.join(tlsDirectory,'cert.pem'))},handle):http.createServer(handle);
 server.listen(0,'127.0.0.1');await once(server,'listening');const target=`${tlsDirectory?'https':'http'}://127.0.0.1:${server.address().port}`;
 report.target_protocol=new URL(target).protocol;
 const api=`http://127.0.0.1:${await port()}`;
 backend=spawn(process.execPath,['scripts/start-server.mjs'],{cwd:root,env:{...process.env,PORT:new URL(api).port,BSTG_DATA_DIR:path.join(out,'data'),BSTG_BROWSER_MODE:'headless',BUILT_IN_FORGE_API_KEY:'',OPENAI_API_KEY:'',SERVE_FRONTEND:'true',...(tlsDirectory?{NODE_EXTRA_CA_CERTS:path.resolve(tlsDirectory,'ca.pem')}:{})},stdio:['ignore','pipe','pipe']});
 backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
 for(let i=0;;i++){if(backend.exitCode!==null)throw Error('Backend exited: '+logs.slice(-2000));try{if((await fetch(api+'/health')).ok)break;}catch{}if(i>100)throw Error('Backend health timeout');await sleep(100);}
 await configureAcceptanceProvider(api,actualProvider);
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(api+'?lang=zh',{waitUntil:'domcontentloaded'});
 await page.getByLabel('测试名称',{exact:true}).fill('Web 端到端验收');await page.getByLabel('网站地址',{exact:true}).fill(target);
 await page.getByLabel('测试目标',{exact:false}).fill('检查上传文件是否能在浏览器执行脚本，以及站内搜索的反射脚本注入。');
 const scope=page.getByRole('group',{name:'安全检查范围'});
 const boxes=scope.getByRole('checkbox');for(let i=0;i<await boxes.count();i++)await boxes.nth(i).uncheck();
 await scope.getByLabel('文件上传',{exact:true}).check();await scope.getByLabel('页面脚本注入',{exact:true}).check();
 if(allCategories){for(let i=0;i<await boxes.count();i++)await boxes.nth(i).check();}
 await page.getByText('我已获得目标、安装包与账号的测试授权', {exact:false}).click();
 const created=page.waitForResponse(r=>r.url().includes('/api/ai-scans?view=product')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'开始测试',exact:true}).click();const response=await created;assert.equal(response.status(),201);const creation=await response.json();report.run_id=creation.data.run.id;
 await page.getByTestId('business-assessment-workspace').waitFor();
 const until=Date.now()+1200000;let latest,frames=new Set();
 while(Date.now()<until){
  latest=(await(await fetch(`${api}/api/ai-scans/${report.run_id}/product-state`)).json()).data;
  report.observations.push({at:new Date().toISOString(),status:latest.run.status,totals:latest.totals,frame:latest.live_surface?.captured_at});
  if(latest.live_surface){const image=await fetch(api+latest.live_surface.image_url);assert.equal(image.status,200);frames.add(latest.live_surface.captured_at);}
  if(['completed','failed'].includes(latest.run.status))break;
  await sleep(200);
 }
 report.target_requests=targetRequests;report.frame_versions=frames.size;
 await writeFile(path.join(out,'final-state.json'),JSON.stringify(latest,null,2));
 const technical=(await(await fetch(`${api}/api/ai-scans/${report.run_id}`)).json()).data;await writeFile(path.join(out,'technical-state.json'),JSON.stringify(technical,null,2));
 report.model_evidence=verifyModelDecisions(technical,actualProvider);
 // Verify user-visible state, not only the JSON projection. A DOM translation
 // observer used to overwrite these changing labels with their initial values.
 await page.getByRole('heading',{name:latest.phase_label,exact:true}).waitFor();
 await page.getByText(`已完成 ${latest.totals.completed} / ${latest.totals.tests} 项 · 已确认 ${latest.totals.confirmed_risks} 个问题`,{exact:true}).waitFor();
 assert.equal(await page.getByTestId('business-test').count(),latest.totals.tests);
 for(const test of latest.business_functions.flatMap(f=>f.tests)){
   const row=page.locator(`[data-test-id="${test.id}"]`);
   assert.equal(await row.getAttribute('data-status'),test.status);
   await row.getByText(test.status_label,{exact:true}).waitFor();
 }
 await page.screenshot({path:path.join(out,'workspace.png'),fullPage:true});
 await page.locator(`[data-test-id="${latest.risk_evidence[0].test_id}"]`).click();
 await page.getByTestId('evidence-review').locator('article').first().waitFor();
 assert.ok(await page.getByTestId('evidence-review').locator('article').count()>0);
 await page.screenshot({path:path.join(out,'evidence-review.png'),fullPage:true});
 assert.equal(latest.run.status,'completed');assert.ok(targetRequests>5);assert.ok(frames.size>=2,'Actual browser frames should advance');
 assert.ok(latest.totals.confirmed_risks>=2,'Both actual reflected and uploaded script execution must be confirmed');
 if(allCategories){
   assert.equal(report.unresolved_payload_requests||0,0,'Unresolved catalog requirements must not be sent as literal OTP/passcode values');
   const selected=['file_upload','file_download','path_traversal','bola_idor','bfla','business_logic','xss','command_injection','auth_otp','email_sms_bypass','passcode_bypass','replay_race','state_machine_race'];
   report.category_matrix=selected.map(type=>{const tasks=technical.tasks.filter(t=>t.vuln_type===type&&['test_generic_vuln','test_file_upload'].includes(t.task_type));const ids=new Set(tasks.map(t=>t.id));return {type,tasks:tasks.map(t=>({id:t.id,type:t.task_type,status:t.status,result:t.result_summary})),attempts:technical.artifacts.filter(a=>ids.has(a.task_id)&&['generic_mutation_attempt','upload_attempt'].includes(a.artifact_type)).length};});
   for(const item of report.category_matrix){assert.ok(item.tasks.length>0,`Selected category must have a visible task: ${item.type}`);assert.ok(item.attempts>0,`Category must execute actual requests: ${item.type}`);assert.ok(item.tasks.every(t=>!['pending','running'].includes(t.status)),`Category must reach an explicit terminal status: ${item.type}`);}
   const allowed=new Set(technical.candidates.filter(c=>['xss','file_upload'].includes(c.vuln_type)).map(c=>`test:${c.id}`));
   assert.equal(latest.risk_evidence.length,latest.totals.confirmed_risks);
   assert.ok(latest.risk_evidence.every(f=>allowed.has(f.test_id)), 'Success/admin/paid strings are not confirmed business vulnerability evidence');
 }else{
   assert.equal(latest.totals.failed,0,'No failed test should be hidden by completed run state');
   assert.equal(latest.totals.not_run,0,'Every candidate must have an explicit executed or sampled outcome');
   assert.equal(latest.totals.review,0,'Unresolved judgements cannot count as acceptance');
   assert.equal(latest.totals.completed+latest.totals.skipped,latest.totals.tests,
     'Only completed representative tests and explicitly skipped candidates may remain');
   const planned=new Set(technical.artifacts.filter(a=>a.artifact_type==='vulnerability_campaign_plan')
     .flatMap(a=>(a.content_json.selected_candidates||[]).map(candidate=>candidate.id)));
   for(const test of latest.business_functions.flatMap(f=>f.tests).filter(t=>t.status==='skipped')){
     assert.ok(test.id.startsWith('test:')&&!planned.has(test.id.slice(5)),
       'A planned candidate cannot be reported as a sampled-out test');
   }
   assert.ok(technical.tasks.filter(t=>['test_file_upload','test_generic_vuln'].includes(t.task_type))
     .every(t=>t.status==='completed'),'Every dispatched security test must complete');
 }
 await page.getByRole('button',{name:'发现问题',exact:false}).click();
 await page.getByRole('heading',{name:'测试发现的问题',exact:true}).waitFor();
 if(allCategories){const reviewLink=page.getByRole('link',{name:'核对本项测试证据',exact:true}).first();await reviewLink.click();await page.getByTestId('evidence-review').locator('article').first().waitFor();await page.getByRole('button',{name:'发现问题',exact:false}).click();}
 const link=page.getByRole('link',{name:'查看对应测试与实际画面',exact:true}).first();
 const destination=new URL(await link.getAttribute('href'),api);await link.click();
 await page.locator(`[data-test-id="${destination.searchParams.get('test')}"]`).waitFor();
 await page.getByTestId('evidence-review').locator('article').first().waitFor();
 // A refresh must retain the chosen run/test and load its actual evidence again.
 await page.reload();await page.getByTestId('evidence-review').locator('article').first().waitFor();
 await page.context().setOffline(true);
 await page.getByTestId('assessment-connection').getByText(/离线|重连/).waitFor({timeout:15000});
 assert.equal(await page.getByTestId('business-test').count(),latest.totals.tests,'Offline view retains the actual last snapshot');
 await page.context().setOffline(false);
 await page.getByTestId('assessment-connection').getByText('已连接',{exact:true}).waitFor({timeout:15000});
 await page.getByText(`已完成 ${latest.totals.completed} / ${latest.totals.tests} 项 · 已确认 ${latest.totals.confirmed_risks} 个问题`,{exact:true}).waitFor();
 await page.getByRole('button',{name:'测试报告',exact:false}).click();await page.getByRole('heading',{name:'业务测试报告',exact:true}).waitFor();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'导出报告',exact:true}).click();const download=await downloadPromise;await download.saveAs(path.join(out,'report.md'));
 assert.match(await readFile(path.join(out,'report.md'),'utf8'),/已确认的问题/);
 const evidence=await fetch(`${api}/api/ai-scans/${report.run_id}/evidence-export`);assert.equal(evidence.status,200);await writeFile(path.join(out,'evidence.json'),await evidence.text());
 assert.deepEqual(errors,[]);report.ok=true;
}catch(error){if(page)await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});report.error=String(error.stack||error);process.exitCode=1;}
finally{
 await browser?.close();if(backend){backend.kill('SIGTERM');await Promise.race([once(backend,'exit'),sleep(5000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(server)await new Promise(r=>{server.closeAllConnections();server.close(r);});
 await writeFile(path.join(out,'backend.log'),logs);report.completed_at=new Date().toISOString();await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,output:out,error:report.error},null,2));
}
