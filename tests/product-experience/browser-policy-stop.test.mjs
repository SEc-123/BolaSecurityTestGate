import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {withScanControl,stopScanForPolicyDenial} from '../../server/src/services/ai-scan/run-control.ts';
import {discoverWebPages} from '../../server/src/services/ai-scan/browser/web-discovery.ts';
import {verifyReflectedXss} from '../../server/src/services/ai-scan/browser/xss-verifier.ts';
import {navigatePersistentBrowser,withPersistentDiscoveryPage,closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
// Actual Chromium and a disposable loopback target; no model or saved target.
for(const scenario of ['discovery','xss','resumed_context'])test(`run refusal aborts real browser ${scenario}`,{timeout:20000},async t=>{
 const seen=deferred();let afterRequests=0;
 const target=http.createServer((req,res)=>{
  if(req.url==='/after')afterRequests++;
  if(req.url==='/hold'){seen.resolve();return;}
  res.setHeader('content-type','text/html');res.end('<html><body>Local fixture</body></html>');
 });
 target.listen(0,'127.0.0.1');await once(target,'listening');
 t.after(()=>new Promise(r=>{target.closeAllConnections();target.close(r);}));
 const base=`http://127.0.0.1:${target.address().port}`,db=await database(),repo=new AIScanRepository(db);
 const run=await repo.createRun({base_url:base+'/hold',scan_config:{max_browser_pages:2}});
 t.after(async()=>{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();});
 const input={repo,scanRunId:run.id,scope_base_url:base};
 if(scenario==='resumed_context')await withScanControl(run.id,()=>navigatePersistentBrowser({...input,url:base+'/'}));
 await withScanControl(run.id,async()=>{
  const work=scenario==='discovery'?discoverWebPages(db,repo,run):scenario==='xss'
   ?verifyReflectedXss({url:base+'/hold',method:'GET'},'unused')
   :withPersistentDiscoveryPage(input,async page=>{await page.goto(base+'/hold');await page.goto(base+'/after');});
  const result=work.then(()=>({completed:true}),error=>({error}));
  await seen.promise;stopScanForPolicyDenial({provider_id:'local-fixture',model:'contract-model'});
  const settled=await result;
  assert.equal(settled.completed,undefined);assert.equal(settled.error?.code,'provider_policy_denied');
 });
 assert.equal(afterRequests,0);
 assert.equal((await repo.listArtifacts(run.id)).some(a=>a.artifact_type==='web_discovery_coverage'),false);
});
