/** Real React/Chromium component acceptance using the production projection.
 * The business artifacts are controlled fixtures; this is not an Agent execution acceptance. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '../../server/node_modules/playwright/index.mjs';
import { buildProductAssessmentState as project } from '../../server/src/services/ai-scan/product-state-service.ts';
import { snapshot, now, time } from './fixtures.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const s=snapshot(0);
const add=(type,id,data)=>s.artifacts.push({id,scan_run_id:s.run.id,artifact_type:type,content_json:data,created_at:time,updated_at:time});
const cases=[
 ['login','正常登录','verified',{normal_run_id:'normal-login-run',assertions_verified:true,assertions:[{name:'登录后身份正确',passed:true}]}],
 ['profile','编辑资料','learning',{}],
 ['order','正常下单','blocked',{blockers:['测试账号没有可用库存']}],
 ['cart','加入购物车','failed',{blockers:['页面未保存购物车结果']}],
 ['reset','找回账号','discovered',{}],
 ['upload','上传附件','verified',{normal_run_id:'unproven-run'}],
];
for(const [id,name,status,extra] of cases)add('business_flow',`flow-artifact-${id}`,{id,name,goal:`核对${name}的正常结果`,status,role:'user',steps:[{id:'step-1',name:'观察并执行页面操作'}],...extra});
add('agent_experiment_plan','plan-record',{id:'experiment-1',flow_id:'login',hypothesis:'其他账号能否读取当前账号的资料',status:'pending'});
add('agent_experiment_result','result-record',{plan_id:'experiment-1',flow_id:'login',status:'completed',native_test_run_ids:['actual-experiment-run'],evidence_artifact_ids:['proof']});
add('business_state_proof','proof',{});
const initial=project(s,now);
const out=path.join(root,'.runtime','business-flow-ui');await fs.mkdir(out,{recursive:true});
const bundle=await build({stdin:{contents:`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {AssessmentWorkspace} from './src/components/assessment/AssessmentWorkspace';
 function Fixture(){const [state,setState]=useState(window.__initial);window.__publish=setState;return React.createElement(AssessmentWorkspace,{state,connection:'live',onRefresh:()=>{}});}
 createRoot(document.getElementById('root')).render(React.createElement(Fixture));`,loader:'tsx',resolveDir:root},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"','import.meta.env':'{}'}});
const cssFiles=await fs.readdir(path.join(root,'dist','assets')).catch(()=>[]);
const css=cssFiles.find(name=>name.endsWith('.css'));
if(!css)throw new Error('Build the production frontend before accepting its business-flow layout.');
const style=await fs.readFile(path.join(root,'dist','assets',css),'utf8');
const server=http.createServer((req,res)=>{
 if(req.url==='/bundle.js'){res.writeHead(200,{'content-type':'application/javascript'});res.end(bundle.outputFiles[0].text);return;}
 if(req.url==='/style.css'){res.writeHead(200,{'content-type':'text/css'});res.end(style);return;}
 res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="padding:16px"></div><script>window.__initial=${JSON.stringify(initial).replace(/</g,'\\u003c')}</script><script src="/bundle.js"></script></body></html>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
const checks=[];
try{
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1080},locale:'zh-CN'});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 await page.getByTestId('business-normal-flow').first().waitFor({timeout:6000}).catch(error=>{throw new Error(`${error.message}; page errors: ${errors.join('; ')}`);});
 assert.equal(await page.getByTestId('business-normal-flow').count(),6);
 assert.match(await page.getByTestId('normal-flow-progress').innerText(),/已验证 1 \/ 6/);
 assert.equal(await page.locator('[data-test-id="flow:login"]').getAttribute('data-status'),'verified');
 assert.equal(await page.locator('[data-test-id="flow:upload"]').getAttribute('data-status'),'review');
 assert.equal(await page.getByTestId('business-test').count(),0);checks.push('Normal baseline counts and states do not inherit candidate checks or model claims');
 await page.locator('[data-test-id="flow:order"]').click();
 assert.match(await page.getByTestId('business-stage-detail').innerText(),/测试账号没有可用库存/);checks.push('Actual condition gaps are visible for the selected normal flow');
 await page.locator('[data-test-id="experiment:experiment-1"]').click();
 assert.match(await page.getByTestId('business-stage-detail').innerText(),/其他账号能否读取当前账号的资料/);
 assert.match(await page.getByTestId('business-stage-detail').innerText(),/是否构成漏洞仍需核对业务证据/);
 await page.getByText('执行与证据引用 · 2 条',{exact:true}).click();
 assert.match(await page.getByTestId('business-stage-detail').innerText(),/actual-experiment-run/);
 assert.match(await page.getByTestId('confirmed-issues').innerText(),/暂未发现已确认的问题/);checks.push('Experimental hypotheses, actual execution references and confirmed issues stay distinct');
 await page.getByLabel('筛选测试项').selectOption('completed');assert.equal(await page.getByTestId('business-normal-flow').count(),1);assert.equal(await page.getByTestId('business-experiment').count(),1);
 await page.getByLabel('筛选测试项').selectOption('unfinished');assert.equal(await page.getByTestId('business-normal-flow').count(),5);assert.equal(await page.getByTestId('business-experiment').count(),0);
 await page.getByLabel('筛选测试项').selectOption('all');await page.getByLabel('搜索业务或测试项').fill('购物车');assert.equal(await page.getByTestId('business-normal-flow').count(),1);
 await page.getByLabel('搜索业务或测试项').fill('');checks.push('Filters and search include normal-flow learning and experiments');
 await page.screenshot({path:path.join(out,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),true);await page.screenshot({path:path.join(out,'narrow.png'),fullPage:true});checks.push('390 px layout has no horizontal overflow');
 s.run.id='another-run';s.artifacts=[];const switched=project(s,now);await page.evaluate(state=>window.__publish(state),switched);
 await page.getByTestId('business-stage-detail').waitFor({state:'detached'});assert.equal(await page.getByTestId('business-normal-flow').count(),0);checks.push('Switching runs clears selected baseline and experimental evidence');
 assert.deepEqual(errors,[]);
 const report={ok:true,scope:'Real React and Chromium component rendering with controlled artifact fixtures; not Agent execution',checks,page_errors:errors,screenshots:[path.join(out,'desktop.png'),path.join(out,'narrow.png')]};
 await fs.writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
