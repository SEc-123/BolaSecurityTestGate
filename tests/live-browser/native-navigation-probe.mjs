/** Native headed runtime probe against an owned loopback fixture. No browser policy changes.
 * Repository persistence below is a test fixture; Playwright, desktop and navigation are real. */
import {createServer} from 'node:http';import {once} from 'node:events';import {mkdir,writeFile} from 'node:fs/promises';
import {navigatePersistentBrowser,closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
let hits=0;const server=createServer((req,res)=>{hits++;res.setHeader('Content-Type','text/html');res.end('<h1>Owned native navigation fixture</h1>');});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`,records=new Map();const repo={getBrowserContext:async(_,key)=>records.get(key)||null,upsertBrowserContext:async value=>{const row={...value,id:'probe-record'};records.set(value.context_key,row);return row;},listBrowserContexts:async()=>[...records.values()],closeBrowserContextRecord:async()=>{}};
let result;
try{result=await navigatePersistentBrowser({repo,scanRunId:'native-probe',taskId:'native-navigation',scope_base_url:base,url:base,timeout_ms:10000});if(!result?.ok)process.exitCode=1;}
catch(error){result={ok:false,error:String(error)};process.exitCode=1;}
finally{await closePersistentBrowserContextsForScan(repo,'native-probe');server.closeAllConnections();await new Promise(r=>server.close(r));await mkdir('validation/live-browser',{recursive:true});const report={mode:'Native Playwright + actual desktop; owned loopback HTTP fixture; repository adapter only; browser policy unchanged',result,fixture_http_requests:hits};await writeFile('validation/live-browser/native-navigation-probe.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
