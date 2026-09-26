/** Actual production noVNC canvas connected to the actual gateway and desktop.
 * Browser HTTP/WS calls are explicitly bridged to Node due navigation policy;
 * this does NOT substitute fabricated frames and is NOT native browser-network E2E.
 */
import {createServer,request} from 'node:http';import {once} from 'node:events';import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';
import {openDesktop,getDesktop} from '../../server/src/services/live-browser/desktop-runtime.ts';import {LiveBrowserGateway} from '../../server/src/services/live-browser/gateway.ts';
const require=createRequire(import.meta.url);const {chromium}=await import(process.env.BSTG_PLAYWRIGHT_MODULE||'../../server/node_modules/playwright/index.mjs');const {ws:WebSocket}=require(process.env.BSTG_TEST_WS_MODULE||'../../server/node_modules/playwright/lib/utilsBundle.js');
const out=path.resolve(process.env.BSTG_LIVE_VIEWER_OUT||'validation/live-browser/viewer-stack');await mkdir(out,{recursive:true});const checks=[],errors=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push({name,passed:true});console.log('PASS',name);};
const gateway=new LiveBrowserGateway({BSTG_LIVE_ACCESS_MODE:'local'});const server=createServer((req,res)=>void gateway.handleHttp(req,res).then(done=>{if(!done){res.writeHead(404);res.end();}}));gateway.attach(server);server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
let desktop,targetBrowser,viewerBrowser,viewer;const sockets=new Map();let bytes=0,wsCount=0;const fetchPaths=[];
try {
 desktop=await openDesktop({runId:'viewer-fixture',taskId:'login'});
 targetBrowser=await chromium.launch({headless:false,executablePath:process.env.BSTG_CHROMIUM_EXECUTABLE||undefined,chromiumSandbox:process.env.BSTG_BROWSER_ALLOW_NO_SANDBOX!=='1',env:{...process.env,DISPLAY:desktop.display,XAUTHORITY:desktop.authority},args:[`--window-size=${desktop.view.width},${desktop.view.height}`,'--window-position=0,0']});
 const target=await targetBrowser.newPage({viewport:{width:desktop.view.width,height:desktop.view.height-100}});
 await target.setContent(`<style>body{margin:50px;font:28px sans-serif;background:#f1f5f9}main{background:white;padding:35px}button,input{font:24px sans-serif;padding:12px}#box{background:#efa72d;padding:80px;margin-top:30px}</style><main><h1>AUTHORIZED LOCAL BROWSER FIXTURE</h1><p>Actual Playwright + Xvfb + x11vnc + gateway + noVNC</p><input id="user" placeholder="Test account"><button id="action" onclick="document.querySelector('#box').style.background='#23b786';document.querySelector('#box').textContent='PLAYWRIGHT ACTION VERIFIED'">Test login</button><div id="box">WAITING FOR AI ACTION</div><p>Network bridges are test instrumentation; these pixels are not mocked.</p></main>`);await target.bringToFront();
 viewerBrowser=await chromium.launch({headless:true,executablePath:process.env.BSTG_CHROMIUM_EXECUTABLE||undefined,chromiumSandbox:process.env.BSTG_BROWSER_ALLOW_NO_SANDBOX!=='1'});
 viewer=await viewerBrowser.newPage({viewport:{width:1400,height:980}});viewer.on('pageerror',e=>errors.push(String(e)));await viewer.setContent('<meta charset="utf-8"><style>body{font:16px sans-serif;margin:24px;background:#f1f5f9}h1{font-size:24px}.note{padding:8px;background:#fff4d6}</style><h1>实时浏览器观看 · 实际 noVNC 组件验证</h1><p class="note">授权本地测试页面；浏览器 HTTP/WS 使用显式桥接，不是客户网站或生产整体验收。</p><div id="viewer"></div>');
 await viewer.addStyleTag({content:await readFile('public/live-browser/viewer.css','utf8')});
 await viewer.exposeFunction('__nodeFetch',async(url,method)=>{fetchPaths.push(new URL(url).pathname);return new Promise((resolve,reject)=>{const r=request(url,{method,headers:{Origin:origin}},res=>{let body='';res.on('data',d=>body+=d);res.on('end',()=>resolve({status:res.statusCode,body}));});r.on('error',reject);r.end();});});
 await viewer.exposeFunction('__nodeWsOpen',async(id,url)=>{const ws=new WebSocket(url,['binary'],{origin});sockets.set(id,ws);wsCount++;let chain=Promise.resolve();const emit=(kind,data)=>{chain=chain.then(()=>viewer.evaluate(({id,kind,data})=>window.__bridgeEvent(id,kind,data),{id,kind,data})).catch(()=>{});};ws.on('open',()=>emit('open',null));ws.on('message',data=>{bytes+=data.length;emit('message',Buffer.from(data).toString('base64'));});ws.on('close',()=>{sockets.delete(id);emit('close',null);});ws.on('error',()=>emit('error',null));});
 await viewer.exposeFunction('__nodeWsSend',(id,data)=>{const s=sockets.get(id);if(s?.readyState===1)s.send(Buffer.from(data,'base64'));});
 await viewer.exposeFunction('__nodeWsClose',id=>sockets.get(id)?.close());
 await viewer.evaluate(origin=>{
  window.__testLocation={origin};window.__testFetch=async(url,options)=>{const r=await window.__nodeFetch(url,options.method);return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>JSON.parse(r.body)};};
  const channels=new Map();let seq=0;window.__testWebSocket=class {constructor(url){this.id=++seq;this.readyState=0;this.protocol='binary';this.binaryType='arraybuffer';this.onerror=null;this.onopen=null;this.onclose=null;this.onmessage=null;channels.set(this.id,this);window.__nodeWsOpen(this.id,url);}send(data){const bytes=new Uint8Array(data);let s='';for(const b of bytes)s+=String.fromCharCode(b);window.__nodeWsSend(this.id,btoa(s));}close(){this.readyState=2;window.__nodeWsClose(this.id);}};
  window.__bridgeEvent=(id,kind,data)=>{const s=channels.get(id);if(!s)return;if(kind==='open'){s.readyState=1;s.onopen?.({});}else if(kind==='message'){const text=atob(data),bytes=Uint8Array.from(text,c=>c.charCodeAt(0));s.onmessage?.({data:bytes.buffer});}else if(kind==='close'){s.readyState=3;s.onclose?.({code:1000,wasClean:true});channels.delete(id);}else s.onerror?.({});};
 },origin);
 await viewer.addScriptTag({content:await readFile('validation/live-browser/viewer-fixture.js','utf8')});
 await viewer.evaluate(origin=>{window.viewerControl=window.__mountLiveViewer(document.getElementById('viewer'),{apiBase:origin,runId:'viewer-fixture',taskIds:['login']});},origin);
 await viewer.waitForSelector('[data-state="connected"] canvas',{timeout:15000});
 const green=()=>viewer.evaluate(()=>{const c=document.querySelector('.live-canvas canvas');if(!c||!c.width)return 0;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=16)if(d[i]<60&&d[i+1]>140&&d[i+2]>80&&d[i+2]<180)n++;return n;});
 check('actual production noVNC connects and renders a canvas',await viewer.locator('canvas').count()>=1);
 await viewer.waitForTimeout(500);const before=await green();await target.locator('#user').fill('authorized-account');await target.locator('#action').click();desktop.activity('login',true);
 for(let i=0;i<50 && await green()<before+3000;i++)await viewer.waitForTimeout(100);
 check('live canvas shows the real Playwright result pixels',await green()>before+3000);
 await viewer.screenshot({path:path.join(out,'actual-novnc-viewer.png'),fullPage:true});
 const firstCount=wsCount;for(const s of sockets.values())s.terminate();
 await viewer.waitForFunction(()=>document.querySelector('.bstg-live-viewer')?.dataset.state==='reconnecting');await viewer.waitForSelector('[data-state="connected"] canvas',{timeout:15000});
 check('disconnect obtains a fresh authorized connection without rerunning target',wsCount>firstCount && await target.locator('#user').inputValue()==='authorized-account');
 await viewer.getByRole('button',{name:'暂停观看'}).click();await viewer.waitForSelector('[data-state="paused"]');check('pause viewing closes only the watcher',Boolean(getDesktop(desktop.view.id)) && await viewer.locator('.live-canvas canvas').count()===0);
 await viewer.getByRole('button',{name:'恢复观看'}).click();await viewer.waitForSelector('[data-state="connected"] canvas',{timeout:15000});
 await viewer.evaluate(()=>window.viewerControl.setSelection(['unrelated-task']));await viewer.waitForSelector('[data-state="waiting"]');check('selecting another task never shows this task browser',await viewer.locator('.live-canvas canvas').count()===0);
 await viewer.evaluate(()=>window.viewerControl.setSelection(['login']));await viewer.waitForSelector('[data-state="connected"] canvas',{timeout:15000});
 await viewer.setViewportSize({width:390,height:844});await viewer.screenshot({path:path.join(out,'actual-novnc-narrow.png'),fullPage:true});check('narrow viewer fits the page horizontally',await viewer.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
 await viewer.evaluate(()=>window.viewerControl.setTerminal(true));await viewer.waitForSelector('[data-state="ended"]');check('completed run removes the live canvas',await viewer.locator('.live-canvas canvas').count()===0);
 check('viewer never fetched screenshots',fetchPaths.every(p=>p.includes('/live-browser')));
 check('substantial real RFB bytes traversed the gateway',bytes>10000);check('no browser runtime error',errors.length===0);
 await writeFile(path.join(out,'results.json'),JSON.stringify({mode:'Actual production noVNC + native backend WS/HTTP + actual Chromium desktop; browser transport/location bridge explicit; setContent fixture',checks,websocket_connections:wsCount,rfb_bytes:bytes,page_errors:errors},null,2));
}finally{if(viewer)await viewer.evaluate(()=>window.viewerControl?.dispose()).catch(()=>{});for(const s of sockets.values())s.terminate();await viewerBrowser?.close();await targetBrowser?.close();await desktop?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
