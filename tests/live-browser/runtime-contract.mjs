/** Real runtime methods and real desktop lifecycle; Playwright is an EXPLICIT protocol double. */
import assert from 'node:assert/strict';import {writeFile,mkdir} from 'node:fs/promises';
import {navigatePersistentBrowser,interactPersistentBrowser,closePersistentBrowserContextsForScan,closeTaskBrowserContexts,getLiveBrowserContextCount} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {desktopSessions} from '../../server/src/services/live-browser/desktop-runtime.ts';
import * as double from './browser-double.mjs';
process.env.BSTG_PLAYWRIGHT_MODULE=new URL('./browser-double.mjs',import.meta.url).href;
const records=new Map(),artifacts=[];const checks=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push({name,passed:true});console.log('PASS',name);};
const repo={getBrowserContext:async(_,key)=>records.get(key)||null,upsertBrowserContext:async value=>{const row={...records.get(value.context_key),...value,id:'context-record'};records.set(value.context_key,row);return row;},createArtifact:async value=>{artifacts.push(value);return {...value,id:'evidence'};},listBrowserContexts:async()=>[...records.values()],closeBrowserContextRecord:async(_,key,status)=>{if(records.has(key))records.get(key).status=status;}};
const common={repo,scanRunId:'runtime-fixture',taskId:'login',scope_base_url:'https://authorized.example'};
try{
 const nav=await navigatePersistentBrowser({...common,url:'https://authorized.example/login'});check('headed browser navigation succeeds in explicit contract double',nav.ok);
 check('browser launch uses the owned display and Xauthority',double.launchOptions.headless===false && Boolean(double.launchOptions.env.DISPLAY) && Boolean(double.launchOptions.env.XAUTHORITY));
 check('same task owns exactly one live desktop',desktopSessions(common.scanRunId).length===1 && desktopSessions(common.scanRunId)[0].task_id==='login');
 for(const operation of [{action:'fill',selector:'#user',value:'fixture'},{action:'click',selector:'#login'},{action:'select',selector:'#role',value:'user'},{action:'press',selector:'#user',key:'Enter'},{action:'scroll',y:9999},{action:'assert',selector:'#result',text:'business outcome'},{action:'observe'}]){const result=await interactPersistentBrowser({...common,operation});check(`runtime executes ${operation.action} in the existing context`,result.ok);}
 check('actions do not create replacement browser sessions',desktopSessions(common.scanRunId).length===1 && getLiveBrowserContextCount(common.scanRunId)===1);
 check('scroll input is bounded',double.calls.some(c=>c[0]==='scroll' && c[2]===3000));
 check('ambiguous selector fails rather than clicking another control',!(await interactPersistentBrowser({...common,operation:{action:'click',selector:'ambiguous'}})).ok);
 check('unsupported key cannot reach browser',!(await interactPersistentBrowser({...common,operation:{action:'press',selector:'#user',key:'Control+L'}})).ok);
 const cancelled=new AbortController();cancelled.abort();check('cancelled action does not execute',!(await interactPersistentBrowser({...common,signal:cancelled.signal,operation:{action:'click',selector:'#login'}})).ok);
 let decision='';await double.routing({request:()=>({isNavigationRequest:()=>true,url:()=> 'https://outside.example'}),abort:async()=>decision='abort',continue:async()=>decision='continue'});check('out-of-scope document navigation blocked before execution',decision==='abort');
 await double.routing({request:()=>({isNavigationRequest:()=>false,url:()=> 'https://cdn.example/script.js'}),abort:async()=>decision='abort',continue:async()=>decision='continue'});check('passive page resources remain supported',decision==='continue');
 check('a different run cannot operate this context',!(await interactPersistentBrowser({...common,scanRunId:'other',operation:{action:'observe'}})).ok);
 check('audit evidence is separate and includes actual session binding',artifacts.length===7 && artifacts.every(a=>a.content_json.live_session_id===desktopSessions(common.scanRunId)[0].id));
 check('same run cannot steal another task-scoped context',!(await interactPersistentBrowser({...common,taskId:'other-task',context_key:'task:login',operation:{action:'observe'}})).ok);
 await closeTaskBrowserContexts(repo,common.scanRunId,'login');check('scan completion closes its desktop and browser',desktopSessions(common.scanRunId).length===0 && getLiveBrowserContextCount(common.scanRunId)===0);
 check('interaction after close fails',!(await interactPersistentBrowser({...common,operation:{action:'observe'}})).ok);
 await mkdir('validation/live-browser',{recursive:true});await writeFile('validation/live-browser/runtime-contract.json',JSON.stringify({mode:'Explicit Playwright protocol double + real runtime methods and Xvfb/VNC lifecycle; NOT browser network acceptance',checks},null,2));
}finally{await closePersistentBrowserContextsForScan(repo,common.scanRunId);}
