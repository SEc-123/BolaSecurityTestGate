/** Requires real Xvfb/x11vnc/websockify/Chromium. No mocked VNC server, pixels, HTTP or WS.
 * The target HTML is an authorized local setContent fixture; not a customer website.
 * Explicit module paths can select installed Playwright and its WS utility for this test only.
 */
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {mkdir,writeFile,stat,access} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openDesktop,desktopSessions,getDesktop} from '../../server/src/services/live-browser/desktop-runtime.ts';
import {LiveBrowserGateway} from '../../server/src/services/live-browser/gateway.ts';
const require=createRequire(import.meta.url);
const playwright=await import(process.env.BSTG_PLAYWRIGHT_MODULE || '../../server/node_modules/playwright/index.mjs');
const {ws:WebSocket,PNG}=require(process.env.BSTG_TEST_WS_MODULE || '../../server/node_modules/playwright/lib/utilsBundle.js');
const out=path.resolve(process.env.BSTG_LIVE_TEST_OUT || 'validation/live-browser/real-stack');await mkdir(out,{recursive:true});
const checks=[];function check(name,condition){assert.ok(condition,name);checks.push({name,passed:true});console.log('PASS',name);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const gateway=new LiveBrowserGateway({BSTG_LIVE_ACCESS_MODE:'local'});
const server=createServer((req,res)=>void gateway.handleHttp(req,res).then(done=>{if(!done){res.writeHead(404);res.end();}}));gateway.attach(server);
server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
function http(method,url,headers={}){return new Promise((resolve,reject)=>{const r=request(origin+url,{method,headers:{Origin:origin,...headers}},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(b)}));});r.on('error',reject);r.end();});}
let desktop,browser,ws,second;
class Bytes {
  data=Buffer.alloc(0);waiters=[];ended=false;
  constructor(socket){socket.on('message',v=>{this.data=Buffer.concat([this.data,Buffer.from(v)]);for(const wake of this.waiters.splice(0))wake();});socket.on('close',()=>{this.ended=true;for(const wake of this.waiters.splice(0))wake();});}
  async read(n){const deadline=Date.now()+12000;while(this.data.length<n){if(this.ended)throw Error('RFB socket ended');if(Date.now()>deadline)throw Error(`RFB read timeout ${n} bytes`);await Promise.race([new Promise(r=>this.waiters.push(r)),sleep(100)]);}const b=this.data.subarray(0,n);this.data=this.data.subarray(n);return b;}
}
async function deniedUpgrade(url){return new Promise((resolve,reject)=>{const s=new WebSocket(url,['binary'],{origin});s.on('open',()=>{s.close();reject(Error('forbidden upgrade accepted'));});s.on('unexpected-response',(_,res)=>{res.resume();s.terminate();resolve(res.statusCode);});s.on('error',()=>{});});}
try {
 desktop=await openDesktop({runId:'live-fixture',taskId:'login'});
 check('metadata excludes Unix socket and Xauthority secrets',!JSON.stringify(desktopSessions('live-fixture')).includes('sock'));
 check('desktop Xauthority is private',((await stat(desktop.authority)).mode&0o777)===0o600);
 const url=`/api/ai-scans/live-fixture/live-browser/${desktop.view.id}`;
 check('another run cannot enumerate this desktop',(await http('GET','/api/ai-scans/another/live-browser')).body.data.sessions.length===0);
 check('cross-origin ticket issuance denied',(await http('POST',url+'/ticket',{Origin:'https://evil.invalid'})).status===403);
 check('cross-run session possession is insufficient',(await http('POST',url.replace('live-fixture','another')+'/ticket')).status===410);
 const issued=await http('POST',url+'/ticket');check('ticket created with no-store and read-only',issued.status===201 && issued.headers['cache-control']==='no-store' && issued.body.data.read_only);
 const socketUrl=origin.replace('http:','ws:')+issued.body.data.socket_path;
 ws=new WebSocket(socketUrl,['binary'],{origin});const bytes=new Bytes(ws);await once(ws,'open');
 check('real websockify gateway WebSocket is open',ws.readyState===1);
 check('ticket replay rejected',await deniedUpgrade(socketUrl)===403);
 const version=await bytes.read(12);check('real RFB server handshake',version.toString().startsWith('RFB 003.'));
 ws.send(Buffer.from('RFB 003.008\n'));const n=(await bytes.read(1))[0],methods=await bytes.read(n);assert.ok(methods.includes(1));ws.send(Buffer.from([1]));assert.equal((await bytes.read(4)).readUInt32BE(),0);ws.send(Buffer.from([1]));
 const init=await bytes.read(24),width=init.readUInt16BE(0),height=init.readUInt16BE(2),name=await bytes.read(init.readUInt32BE(20));
 check('framebuffer geometry matches this desktop',width===desktop.view.width && height===desktop.view.height);
 const pixel=Buffer.alloc(20);pixel[0]=0;pixel[4]=32;pixel[5]=24;pixel[6]=0;pixel[7]=1;pixel.writeUInt16BE(255,8);pixel.writeUInt16BE(255,10);pixel.writeUInt16BE(255,12);pixel[14]=16;pixel[15]=8;pixel[16]=0;ws.send(pixel);
 ws.send(Buffer.from([2,0,0,1,0,0,0,0])); // raw-only encoding; no image fixture substitution
 const framebuffer=Buffer.alloc(width*height*4);
 async function frame(){const q=Buffer.alloc(10);q[0]=3;q.writeUInt16BE(width,6);q.writeUInt16BE(height,8);ws.send(q);
  for(;;){const kind=(await bytes.read(1))[0];if(kind===2)continue;if(kind===3){const h=await bytes.read(7);await bytes.read(h.readUInt32BE(3));continue;}assert.equal(kind,0,'FramebufferUpdate');const h=await bytes.read(3);const count=h.readUInt16BE(1);for(let i=0;i<count;i++){const r=await bytes.read(12);const x=r.readUInt16BE(0),y=r.readUInt16BE(2),w=r.readUInt16BE(4),h=r.readUInt16BE(6),encoding=r.readInt32BE(8);assert.equal(encoding,0);const pixels=await bytes.read(w*h*4);for(let row=0;row<h;row++)pixels.copy(framebuffer,((y+row)*width+x)*4,row*w*4,(row+1)*w*4);}return Buffer.from(framebuffer);}}
 browser=await playwright.chromium.launch({headless:false,executablePath:process.env.BSTG_CHROMIUM_EXECUTABLE || undefined,chromiumSandbox:process.env.BSTG_BROWSER_ALLOW_NO_SANDBOX!=='1',env:{...process.env,DISPLAY:desktop.display,XAUTHORITY:desktop.authority},args:[`--window-size=${width},${height}`,'--window-position=0,0']});
 const page=await browser.newPage({viewport:{width,height:height-100}});
 await page.setContent(`<html><style>body{font:24px sans-serif;margin:48px;background:#eef2f7}main{padding:32px;background:white}input,button{font:24px sans-serif;padding:12px}#result{margin-top:32px;padding:60px;background:#e4a33b}</style><main><h1>REAL noVNC STACK · LOCAL AUTHORIZED FIXTURE</h1><p>Playwright drives this browser; the viewer receives RFB pixels.</p><label>Test account <input id="account"></label><button id="login" onclick="window.actionCount=(window.actionCount||0)+1;document.querySelector('#result').textContent='BUSINESS ACTION COMPLETED';document.querySelector('#result').style.background='#31b587'">Run test action</button><div id="result">WAITING FOR PLAYWRIGHT</div><p>This is not a customer-site security finding.</p></main></html>`);
 await page.bringToFront();await sleep(600);const before=await frame();
 await page.locator('#account').fill('authorized-fixture');await page.locator('#login').click();desktop.activity('login',true);await sleep(600);let after=await frame();const updateDeadline=Date.now()+5000;while(before.equals(after) && Date.now()<updateDeadline){await sleep(150);after=await frame();}
 check('real browser business action completed',await page.locator('#result').innerText()==='BUSINESS ACTION COMPLETED');
 for(const [label,raw] of [['before',before],['after',after]]){const rgba=Buffer.alloc(raw.length);for(let i=0;i<raw.length;i+=4){rgba[i]=raw[i+2];rgba[i+1]=raw[i+1];rgba[i+2]=raw[i];rgba[i+3]=255;}await writeFile(path.join(out,label+'.png'),PNG.sync.write({width,height,data:rgba}));}
 check('RFB framebuffer changed after Playwright action',createHash('sha256').update(before).digest('hex')!==createHash('sha256').update(after).digest('hex'));
 // An adversarial RFB client sends input anyway. x11vnc must reject it even without client viewOnly.
 await page.locator('#account').focus();const baseline=await page.locator('#account').inputValue();
 for(const down of [1,0]){const key=Buffer.alloc(8);key[0]=4;key[1]=down;key.writeUInt32BE(0x5a,4);ws.send(key);}await sleep(400);
 check('server-enforced view-only rejects malicious keyboard input',await page.locator('#account').inputValue()===baseline);
 const box=await page.locator('#login').boundingBox();const coordinates=await page.evaluate(({x,y})=>({x:x+window.screenX,y:y+window.screenY+window.outerHeight-window.innerHeight}),{x:box.x+box.width/2,y:box.y+box.height/2});
 const actionCount=await page.evaluate(()=>window.actionCount);
 for(const mask of [1,0]){const event=Buffer.alloc(6);event[0]=5;event[1]=mask;event.writeUInt16BE(Math.round(coordinates.x),2);event.writeUInt16BE(Math.round(coordinates.y),4);ws.send(event);}await sleep(400);
 check('server-enforced view-only rejects malicious pointer clicks',await page.evaluate(()=>window.actionCount)===actionCount);
 const rgba=Buffer.alloc(after.length);for(let i=0;i<after.length;i+=4){rgba[i]=after[i+2];rgba[i+1]=after[i+1];rgba[i+2]=after[i];rgba[i+3]=255;}await writeFile(path.join(out,'real-rfb-frame.png'),PNG.sync.write({width,height,data:rgba}));
 desktop.activity('login',false);check('task identity and activity are exposed without internal tools',desktopSessions('live-fixture')[0].task_id==='login' && desktopSessions('live-fixture')[0].state==='ready');
 second=await openDesktop({runId:'second-fixture',taskId:'other'});check('concurrent runs use separate desktops and sockets',desktop.display!==second.display && desktop.socketPath!==second.socketPath);
 const ownedPath=desktop.socketPath,ended=once(ws,'close');await desktop.close();await ended;
 check('desktop close revokes viewers',ws.readyState===3 && !getDesktop(desktop.view.id));
 check('desktop cleanup removes private Unix socket',await access(ownedPath).then(()=>false,()=>true));
 check('closing one run leaves the other alive',Boolean(getDesktop(second.view.id)));
 check('ended session cannot mint ticket',(await http('POST',url+'/ticket')).status===410);
 await writeFile(path.join(out,'results.json'),JSON.stringify({mode:'REAL Xvfb + x11vnc + websockify + HTTP/WS gateway + Chromium; authorized setContent fixture, not production website or full Express build',checks},null,2));
}finally{ws?.close();await browser?.close().catch(()=>{});await desktop?.close();await second?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
