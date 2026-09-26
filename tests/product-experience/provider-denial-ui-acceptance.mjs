#!/usr/bin/env node
/** Exercises failure presentation through real UI, API, scheduler and SQLite.
 * The model server is deliberately a denial fixture, never real AI acceptance. */
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {launchAssessmentBrowser} from '../../server/dist/services/ai-scan/browser/browser-provider.js';
const out=path.resolve('artifacts',`provider-denial-ui-${Date.now()}`);await mkdir(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const availablePort=async()=>{const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const servers=[];let backend,browser,page,logs='',calls=0,targetRequests=0;
const result={ok:false,scope:'Real product failure presentation using an explicit provider denial fixture; no live model acceptance'};
try{
 const provider=http.createServer(async(req,res)=>{for await(const chunk of req){}calls++;res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'provider_policy_denied',message:'Daybreak access is required by the provider (acceptance fixture).'}}));});
 provider.listen(0,'127.0.0.1');await once(provider,'listening');servers.push(provider);
 const target=http.createServer((req,res)=>{targetRequests++;res.end('This target must not be reached after a provider denial');});target.listen(0,'127.0.0.1');await once(target,'listening');servers.push(target);
 const api=`http://127.0.0.1:${await availablePort()}`;
 backend=spawn(process.execPath,['scripts/start-server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:new URL(api).port,BSTG_DATA_DIR:path.join(out,'data'),SERVE_FRONTEND:'true',BUILT_IN_FORGE_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
 backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
 for(let i=0;;i++){if(backend.exitCode!==null)throw Error('Backend exited');try{if((await fetch(api+'/health')).ok)break;}catch{}if(i>100)throw Error('Backend health timeout');await sleep(100);}
 const configured=await fetch(api+'/api/ai/providers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Explicit denial fixture',provider_type:'openai_compat',base_url:`http://127.0.0.1:${provider.address().port}/v1`,api_key:'fixture-only',model:'fixture-model',is_enabled:true,is_default:true})});assert.equal(configured.status,201);
 browser=await launchAssessmentBrowser({headless:true});page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
 await page.goto(api+'?lang=zh',{waitUntil:'domcontentloaded'});
 await page.getByLabel('测试名称',{exact:true}).fill('Provider 拒绝必须明确失败');
 await page.getByLabel('网站地址',{exact:true}).fill(`http://127.0.0.1:${target.address().port}`);
 await page.getByText('我已获得目标、安装包与账号的测试授权',{exact:false}).click();
 const created=page.waitForResponse(r=>r.url().includes('/api/ai-scans?view=product')&&r.request().method()==='POST');await page.getByRole('button',{name:'开始测试',exact:true}).click();
 const response=await created;assert.equal(response.status(),201);result.run_id=(await response.json()).data.run.id;
 let state;for(let i=0;i<150;i++){state=(await(await fetch(`${api}/api/ai-scans/${result.run_id}/product-state`)).json()).data;if(['failed','completed'].includes(state.run.status))break;await sleep(100);}
 assert.equal(state.run.status,'failed');assert.equal(calls,1);assert.equal(targetRequests,0);assert.equal(state.totals.completed,0);assert.equal(state.totals.confirmed_risks,0);
 await page.getByTestId('business-assessment-workspace').waitFor();await page.getByRole('heading',{name:state.phase_label,exact:true}).waitFor();await page.getByText(/Daybreak access is required/).first().waitFor();
 await page.screenshot({path:path.join(out,'provider-denial.png'),fullPage:true});await page.reload();await page.getByText(/Daybreak access is required/).first().waitFor();
 result.ok=true;result.provider_calls=calls;result.target_requests=targetRequests;result.state=state.run.status;result.completed=state.totals.completed;result.confirmed_risks=state.totals.confirmed_risks;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
 await browser?.close();if(backend){backend.kill('SIGTERM');await Promise.race([once(backend,'exit'),sleep(5000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 for(const server of servers){server.closeAllConnections();await new Promise(r=>server.close(r));}
 await writeFile(path.join(out,'backend.log'),logs);await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,...result},null,2));
}
