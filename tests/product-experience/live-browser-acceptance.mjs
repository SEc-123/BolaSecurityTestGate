#!/usr/bin/env node
/** Read-only verification of an already authorized, currently executing deployment.
 * No network mocks, synthetic frames, TLS bypass, modified browser policy or automatic PASS on skips.
 * This verifies the USER VIEW of a real run; it does not provision a device or replace device acceptance. */
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const out=path.resolve(process.env.BSTG_UX_ARTIFACT_DIR||path.join(root,'artifacts',`product-live-${Date.now()}`));
const result={mode:'deployed browser acceptance; no fixtures',started_at:new Date().toISOString(),ok:false,checks:[],observations:[]};
let browser,page,ownsDirectory=false;
try {
 await mkdir(path.dirname(out),{recursive:true}); await mkdir(out,{recursive:false}); ownsDirectory=true;
 assert.equal(process.env.BSTG_UX_AUTHORIZED,'true','Set BSTG_UX_AUTHORIZED=true only for an authorized isolated test run.');
 const front=new URL(process.env.BSTG_UX_FRONTEND_URL||'');const api=new URL(process.env.BSTG_UX_API_URL||front.origin);
 assert.ok(['http:','https:'].includes(front.protocol)&&['http:','https:'].includes(api.protocol));
 const runId=process.env.BSTG_UX_RUN_ID;assert.match(runId||'',/^[a-zA-Z0-9_-]{1,100}$/,'An existing authorized run ID is required.');
 const surface=process.env.BSTG_UX_SURFACE;assert.ok(['web','android'].includes(surface),'Set BSTG_UX_SURFACE=web or android.');
 const timeout=Number(process.env.BSTG_UX_TIMEOUT_MS||180000);assert.ok(Number.isFinite(timeout)&&timeout>=1000&&timeout<=1800000);
 const require=createRequire(path.join(root,'server/package.json'));const {chromium}=require('playwright');
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000},...(process.env.BSTG_UX_STORAGE_STATE?{storageState:process.env.BSTG_UX_STORAGE_STATE}:{})});
 page=await context.newPage();const errors=[];let liveSocketBytes=0,liveSocketConnections=0;page.on('pageerror',error=>errors.push(String(error)));
 page.on('websocket',socket=>{if(!socket.url().includes(`/api/ai-scans/${runId}/live-browser/`))return;liveSocketConnections++;socket.on('framereceived',({payload})=>{liveSocketBytes+=typeof payload==='string'?Buffer.byteLength(payload):payload.length;});});
 front.searchParams.set('run',runId);front.searchParams.delete('test');await page.goto(front.href,{waitUntil:'domcontentloaded'});
 await page.getByTestId('business-assessment-workspace').waitFor({timeout:30000});
 const read=async()=>{const response=await context.request.get(new URL(`/api/ai-scans/${encodeURIComponent(runId)}/product-state`,api).href);assert.ok(response.ok(),`State endpoint returned ${response.status()}`);const json=await response.json();assert.equal(json.data.run.id,runId);return json.data;};
 const first=await read();assert.equal(first.active_surface,surface);assert.ok(!['completed','failed'].includes(first.run.status),'A finished record cannot prove live execution. Start this check while a real run is executing.');
 let latest=first,sawRunning=false,sawChecked=false,sawAdvance=false,refreshed=false;const frames=new Set(),runningCases=new Set();const until=Date.now()+timeout;
 while(Date.now()<until){
   latest=await read();const tests=latest.business_functions.flatMap(f=>f.tests);
   for(const test of tests){if(test.status==='running'){sawRunning=true;runningCases.add(test.id);}if(test.checked){sawChecked=true;if(runningCases.has(test.id))sawAdvance=true;}}
   const frame=latest.live_surface;
   if(surface==='web'){
     const canvas=await page.locator('[data-state="connected"] .live-canvas canvas').first();
     if(await canvas.count()){const data=await canvas.evaluate(c=>c.width&&c.height?c.toDataURL():null);if(data)frames.add(createHash('sha256').update(data).digest('hex'));}
   } else if(frame?.state==='live'){
     assert.notEqual(frame.source,'simulated','Simulated screen cannot satisfy real acceptance.');
     assert.equal(frame.surface,surface);assert.ok(Date.now()-Date.parse(frame.captured_at)<15000);
     const response=await context.request.get(new URL(frame.image_url,api).href);assert.ok(response.ok());const bytes=await response.body();assert.ok(bytes.length>8,'Empty screenshot');
     frames.add(`${frame.id}:${frame.captured_at}`);
   }
   const body=await page.locator('body').innerText();assert.ok(!/\b(mutation|learning|workflow|tool_name|native_evidence_gate|agent_memories)\b/i.test(body),'Internal engine labels are visible.');
   result.observations.push({at:new Date().toISOString(),run_status:latest.run.status,completed:latest.totals.completed,running:latest.totals.running,confirmed:latest.totals.confirmed_risks,frame_id:surface==='android'?frame?.id:undefined,frame_at:surface==='android'?frame?.captured_at:undefined,live_socket_connections:liveSocketConnections,live_socket_bytes:liveSocketBytes});
   if(sawRunning && !refreshed){await page.reload({waitUntil:'domcontentloaded'});await page.getByTestId('business-assessment-workspace').waitFor();refreshed=true;result.checks.push('Browser refresh reconnects to the actual running record');}
   if(['completed','failed'].includes(latest.run.status))break;
   await new Promise(resolve=>setTimeout(resolve,1000));
 }
 assert.ok(sawRunning,'No executing business test was observed');assert.ok(frames.size>=2,'Observe actual changing noVNC pixels for Web or fresh App frames; static history cannot prove execution');
 if(surface==='web'){assert.ok(liveSocketConnections>=2,'Native WebSocket must reconnect after browser refresh');assert.ok(liveSocketBytes>10000,'No substantial RFB framebuffer traffic');result.checks.push('Native same-origin noVNC WebSocket, real changing canvas and refresh reconnect observed');}
 assert.ok(sawAdvance,'No observed running case reached verified completion');assert.ok(sawChecked);
 assert.equal(latest.run.status,'completed','The run did not finish successfully within this observation window.');
 assert.equal(latest.totals.completed,latest.totals.tests,'Failed/skipped/review/not-run cases do not satisfy full acceptance');
 await page.getByRole('button',{name:'刷新测试状态'}).click();
 await page.waitForFunction(n=>document.querySelectorAll('[data-testid="business-test"][data-checked="true"]').length===n,latest.totals.completed);
 assert.equal(await page.locator('[data-testid="business-test"][data-checked="true"] .line-through').count(),latest.totals.completed);
 assert.equal(await page.locator('[data-testid="confirmed-issues"] article').count(),latest.totals.confirmed_risks);
 assert.deepEqual(errors,[]);result.checks.push('Real execution, changing frames, verified completion, strikethrough and retained issue counts agree');
 await page.screenshot({path:path.join(out,'final-user-view.png'),fullPage:true});await writeFile(path.join(out,'final-state.json'),JSON.stringify(latest,null,2));
 result.ok=true;
} catch(error){result.error=String(error?.stack||error);process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'failure-user-view.png'),fullPage:true}).catch(()=>{});}
finally{await browser?.close();result.completed_at=new Date().toISOString();if(ownsDirectory)await writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2)).catch(error=>{console.error(error);process.exitCode=1;});console.log(JSON.stringify(result,null,2));}
