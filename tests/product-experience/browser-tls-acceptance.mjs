#!/usr/bin/env node
/** Real Linux Chromium + real TLS sockets, no certificate-error bypasses. */
import https from 'node:https';
import {once} from 'node:events';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {launchAssessmentBrowser} from '../../server/dist/services/ai-scan/browser/browser-provider.js';
import {executeHttpRequest} from '../../server/dist/services/ai-scan/http-executor.js';
const tls=path.resolve(process.env.BSTG_WEB_TLS_DIR||'artifacts/runtime-0.6.2/tls');
if(!process.env.BSTG_BROWSER_WS_ENDPOINT)throw Error('Configure the actual local container worker endpoint.');
// Playwright's documented local.playwright SOCKS alias reaches the same loopback
// fixture with a deliberately different TLS hostname. No DNS/hosts file changes.
process.env.BSTG_BROWSER_EXPOSE_NETWORK='<loopback>,local.playwright';
const out=path.resolve('artifacts',`browser-tls-${Date.now()}`);await mkdir(out,{recursive:true});
const temp=await mkdtemp(path.join(os.tmpdir(),'bstg-untrusted-'));
let good,bad,browser,second;
const result={ok:false,checks:[]};
try{
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=untrusted.invalid','-keyout',path.join(temp,'key.pem'),'-out',path.join(temp,'cert.pem')],{stdio:'ignore'});
 const make=async dir=>{const s=https.createServer({key:await readFile(path.join(dir,'key.pem')),cert:await readFile(path.join(dir,'cert.pem'))},(_,res)=>{res.setHeader('content-type','text/html');res.end('<title>Verified target</title><p>HTTPS response</p>');});s.listen(0,'::');await once(s,'listening');return s;};
 good=await make(tls);bad=await make(temp);
 const trusted=`https://127.0.0.1:${good.address().port}`,untrusted=`https://127.0.0.1:${bad.address().port}`,wrongHost=`https://[::1]:${good.address().port}`;
 browser=await launchAssessmentBrowser({headless:true,chromiumSandbox:true});const context=await browser.newContext();const page=await context.newPage();
 assert.equal((await page.goto(trusted)).status(),200);result.checks.push('Chromium accepts the configured CA and matching hostname');
 for(const [url,label] of [[untrusted,'untrusted CA'],[`https://local.playwright:${good.address().port}`,'wrong hostname']]){
  await assert.rejects(page.goto(url,{timeout:10000}),/ERR_CERT/);result.checks.push(`Chromium rejects ${label}`);
 }
 await context.addCookies([{name:'isolated',value:'a',url:trusted}]);
 second=await launchAssessmentBrowser({headless:true,chromiumSandbox:true});const isolated=await second.newContext();assert.deepEqual(await isolated.cookies(),[]);
 await browser.close();browser=undefined;assert.equal((await(await isolated.newPage()).goto(trusted)).status(),200);result.checks.push('Independent worker connection survives another run closing; cookies remain isolated');
 for(const [url,ok] of [[trusted,true],[untrusted,false],[wrongHost,false]]){
  const evidence=await executeHttpRequest({method:'GET',url,timeout_ms:10000});assert.equal(evidence.ok,ok,JSON.stringify(evidence));
 }
 result.checks.push('Native HTTP replay validates both CA trust and hostname');result.ok=true;
}catch(error){result.error=String(error.stack||error);process.exitCode=1;}
finally{
 await browser?.close();await second?.close();
 for(const server of [good,bad])if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 await rm(temp,{recursive:true,force:true});await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,...result},null,2));
}
