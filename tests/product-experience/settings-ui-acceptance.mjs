#!/usr/bin/env node
/** Real frontend/backend/SQLite. Local provider is an explicit protocol fixture,
 * not evidence of an external model's intelligence or availability. */
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),require=createRequire(path.join(root,'server/package.json')),{chromium}=require('playwright');
const out=path.resolve('artifacts',`settings-ui-${Date.now()}`);await mkdir(out,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let target,backend,browser,page,logs='',reject=false,calls=0;
const result={ok:false,scope:'Provider settings and transport contract, not real model inference'};
try{
 target=http.createServer(async(req,res)=>{
  for await(const chunk of req){}calls++;
  assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer acceptance-credential-only');
  res.setHeader('content-type','application/json');
  if(reject){res.writeHead(401);res.end(JSON.stringify({error:'fixture credential rejected'}));return;}
  res.end(JSON.stringify({id:'fixture',model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));
 });target.listen(0,'127.0.0.1');await once(target,'listening');
 const api='http://127.0.0.1:19447';
 backend=spawn(process.execPath,['scripts/start-server.mjs'],{cwd:root,env:{...process.env,PORT:'19447',BSTG_DATA_DIR:path.join(out,'data'),BUILT_IN_FORGE_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
 backend.stdout.on('data',b=>logs+=b);backend.stderr.on('data',b=>logs+=b);
 for(let i=0;;i++){try{if((await fetch(api+'/health')).ok)break;}catch{}if(i>100||backend.exitCode!==null)throw Error('Backend unavailable');await sleep(100);}
 browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1080}});await page.goto(api+'/settings?lang=en');
 await page.getByRole('button',{name:'Add Provider',exact:true}).click();
 let dialog=page.getByRole('dialog');
 await dialog.getByLabel('Name *',{exact:true}).fill('Local transport acceptance');
 await dialog.getByLabel('Provider Type *',{exact:true}).selectOption('openai_compat');
 await dialog.getByLabel('Base URL *',{exact:true}).fill(`http://127.0.0.1:${target.address().port}/v1`);
 await dialog.getByLabel('API Key *',{exact:true}).fill('acceptance-credential-only');
 await dialog.getByLabel('Model *',{exact:true}).fill('fixture-model');await dialog.getByLabel('Set as default',{exact:true}).check();
 await dialog.getByRole('button',{name:'Create',exact:true}).click();await dialog.waitFor({state:'hidden'});
 let row=page.getByRole('row').filter({hasText:'Local transport acceptance'});await row.waitFor();
 const providers=await(await fetch(api+'/api/ai/providers')).json();assert.equal(providers.length,1);assert.equal(providers[0].is_default,true);assert.doesNotMatch(JSON.stringify(providers),/acceptance-credential-only|api_key/);
 let response=page.waitForResponse(r=>r.url().endsWith('/test')&&r.request().method()==='POST');await row.getByRole('button',{name:'Test',exact:true}).click();assert.equal((await(await response).json()).ok,true);await row.getByText(/^\d+ms$/).waitFor();assert.ok(calls>0);
 await row.getByRole('button',{name:'Edit Local transport acceptance',exact:true}).click();dialog=page.getByRole('dialog');assert.equal(await dialog.locator('#provider-key').inputValue(),'');
 await dialog.getByLabel('Name *',{exact:true}).fill('Edited transport acceptance');await dialog.getByRole('button',{name:'Update',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.reload();
 row=page.getByRole('row').filter({hasText:'Edited transport acceptance'});await row.waitFor();
 response=page.waitForResponse(r=>r.url().endsWith('/test')&&r.request().method()==='POST');await row.getByRole('button',{name:'Test',exact:true}).click();assert.equal((await(await response).json()).ok,true);await row.getByText(/^\d+ms$/).waitFor();
 reject=true;response=page.waitForResponse(r=>r.url().endsWith('/test')&&r.request().method()==='POST');await row.getByRole('button',{name:'Test',exact:true}).click();assert.equal((await(await response).json()).ok,false);
 await row.getByRole('alert').getByText(/fixture credential rejected/).waitFor();await page.screenshot({path:path.join(out,'failure-diagnostic.png'),fullPage:true});
 page.once('dialog',d=>d.accept());await row.getByRole('button',{name:'Delete Edited transport acceptance',exact:true}).click();await row.waitFor({state:'hidden'});assert.deepEqual(await(await fetch(api+'/api/ai/providers')).json(),[]);
 result.ok=true;result.calls=calls;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
 await browser?.close();if(backend){backend.kill('SIGTERM');await Promise.race([once(backend,'exit'),sleep(5000)]);if(backend.exitCode===null)backend.kill('SIGKILL');}
 if(target){target.closeAllConnections();await new Promise(r=>target.close(r));}
 await writeFile(path.join(out,'backend.log'),logs);await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,...result},null,2));
}
