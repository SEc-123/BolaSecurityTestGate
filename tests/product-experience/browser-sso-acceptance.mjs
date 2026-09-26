import https from 'node:https';
import {once} from 'node:events';
import {readFile,mkdir,writeFile,appendFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {SqliteProvider} from '../../server/dist/db/sqlite-provider.js';
import {AIScanRepository} from '../../server/dist/services/ai-scan/repository.js';
import {navigatePersistentBrowser,interactPersistentBrowser,closePersistentBrowserContextsForScan} from '../../server/dist/services/ai-scan/browser/persistent-browser-runtime.js';
import {launchAssessmentBrowser} from '../../server/dist/services/ai-scan/browser/browser-provider.js';
import {installNavigationGuard} from '../../server/dist/services/ai-scan/browser/navigation-guard.js';
const out=path.resolve('artifacts',`sso-closure-${Date.now()}`);await mkdir(out,{recursive:true});
const traceEvent=event=>{console.log(JSON.stringify(event));void appendFile(path.join(out,'trace.jsonl'),JSON.stringify(event)+'\n');};
const watchdog=setTimeout(()=>{console.error('SSO regression exceeded its 90 second deadline');process.exit(1);},90000);
const tls=path.resolve(process.env.BSTG_WEB_TLS_DIR||'artifacts/runtime-0.6.2/tls');
const options={key:await readFile(path.join(tls,'key.pem')),cert:await readFile(path.join(tls,'cert.pem'))};
const db=new SqliteProvider('sso-contract',{file:path.join(out,'state.sqlite')});await db.connect();await db.migrate();const repo=new AIScanRepository(db);
const servers=[],runs=[];let identityRequests=0,forbiddenRequests=0;const received=[];const result={ok:false,scope:'Real Chromium SSO navigation, target-only capture, denied mutation scope and error provenance'};
const serve=async fn=>{const s=https.createServer(options,fn);s.listen(0,'127.0.0.1');await once(s,'listening');servers.push(s);return `https://127.0.0.1:${s.address().port}`;};
try{
 const forbidden=await serve((_,res)=>{forbiddenRequests++;res.end('Must never be requested');});
 const identity=await serve((req,res)=>{identityRequests++;received.push({path:req.url,method:req.method});if(req.url==='/escape'){res.writeHead(302,{location:forbidden+'/outside'});res.end();return;}res.setHeader('content-type','text/html');res.end('<title>SSO</title><form><input type="password"><button>Log in</button></form>');});
 const target=await serve((req,res)=>{if(req.url==='/popups'){res.setHeader('content-type','text/html');res.end(`<a id="allowed" target="_blank" href="${identity}/signin">Login</a><a id="blocked" target="_blank" href="${identity}/escape">Blocked chain</a>`);return;}res.writeHead(302,{location:identity+(req.url==='/escape'?'/escape':'/signin')});res.end();});
 for(const allowed of [false,true]){
  traceEvent({phase:'managed-navigation',allowed});
  const run=await repo.createRun({base_url:target,scan_config:{authentication_origins:allowed?[identity]:[]},selected_vuln_types:[]});runs.push(run.id);
  const task=await repo.createTask({scan_run_id:run.id,title:'SSO navigation regression',task_type:'autonomous_agent_task',execution_plan:{intent:'discover_target'}});
  const input={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target,url:target,timeout_ms:15000};
  const before=identityRequests,nav=await navigatePersistentBrowser(input);
  if(!allowed){assert.equal(nav.ok,false);assert.match(nav.error,/统一登录/);assert.doesNotMatch(nav.error,/chrome-error/);assert.equal(identityRequests,before,JSON.stringify({received,network:nav.network_events}));result.blocked_error=nav.error;}
  else{
   assert.equal(nav.ok,true,nav.error);assert.equal(new URL(nav.current_url).origin,identity);assert.ok(identityRequests>before);
   assert.equal((await interactPersistentBrowser({...input,operation:{action:'fill',selector:'input',value:'must-not-be-filled'}})).ok,false,'Generic test tools must not operate on an authentication-only origin');
   const snapshot=await repo.getSnapshot(run.id);assert.ok(snapshot.endpoints.length>0);assert.ok(snapshot.endpoints.every(e=>new URL(e.url).origin===target));
   result.captured_target_endpoints=snapshot.endpoints.length;result.identity_only_navigation=true;
   traceEvent({phase:'redirect-chain'});const escaped=await navigatePersistentBrowser({...input,url:target+'/escape'});assert.equal(escaped.ok,false);assert.equal(forbiddenRequests,0);result.redirect_chain_blocked=true;
  }
 }
 const browser=await launchAssessmentBrowser({headless:true,chromiumSandbox:true});
 try{
  const context=await browser.newContext(),page=await context.newPage(),blocked=[];
  context.setDefaultTimeout(10000);context.setDefaultNavigationTimeout(10000);traceEvent({phase:'popup-fail-closed'});
  await installNavigationGuard(context,page,target,[identity],message=>blocked.push(message));
  await page.goto(target+'/popups');
  for(const selector of ['#allowed','#blocked']){
   const before=identityRequests,opened=context.waitForEvent('page');await page.locator(selector).click();const popup=await opened;
   await popup.waitForLoadState('domcontentloaded').catch(()=>{});
   assert.equal(identityRequests,before,'Unsupported popup must not dispatch even its initial request');
   assert.equal(forbiddenRequests,0);assert.ok(blocked.some(message=>message.includes('不支持弹窗')));await popup.close();
  }
  result.popup_initial_navigation='explicitly_unsupported_and_blocked_before_dispatch';
 }finally{await browser.close();}
 result.ok=true;
}catch(error){traceEvent({phase:'error',error:String(error)});result.error=String(error.stack||error);process.exitCode=1;}
finally{
 for(const run of runs)await closePersistentBrowserContextsForScan(repo,run);
 for(const s of servers){s.closeAllConnections();await new Promise(resolve=>s.close(resolve));}
 await db.disconnect();clearTimeout(watchdog);await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({out,...result},null,2));
}
