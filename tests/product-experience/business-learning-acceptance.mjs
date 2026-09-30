#!/usr/bin/env node
/** Real-model acceptance infrastructure. No canned model decisions, scenario
 * steps, opaque routes, fault modes, or oracle assertions enter the model prompt. */
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createBusinessLearningFixture} from './business-learning-fixture.mjs';
import {loadAcceptanceProvider,configureAcceptanceProvider,verifyModelDecisions} from './live-provider.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(path.join(root,'server/package.json'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const freePort=async()=>{const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));return port;};
const DEFAULT_GOAL='Understand the business functions visible on this site. Use the supplied accounts to complete and verify their normal business flows, learn the actual requests and data dependencies, then investigate security weaknesses using specific experiments and real effects. Keep evidence of completed flows, experiments, inconclusive results, and reproducible findings.';

export function assertBusinessLearningOracle({fixtureState,productState,requirePositive=false}){
  const {metrics}=fixtureState;
  for(const metric of ['logins','profile_updates','cart_additions','tickets_created','normal_orders','notes_created']){
    assert.ok(metrics[metric]>0,`The Agent must execute the normal business operation: ${metric}`);
  }
  assert.equal(fixtureState.unresolved_values,0,'Symbolic values cannot masquerade as executed requests');
  assert.ok(fixtureState.csrf_values.length>=3,'Normal actions must use actual changing state');
  const confirmed=Number(productState?.totals?.confirmed_risks||0);
  if(['secure','misleading-response'].includes(fixtureState.mode)){
    assert.equal(metrics.unauthorized_reads,0);assert.equal(metrics.unauthorized_updates,0);assert.equal(metrics.invalid_orders,0);
    assert.equal(confirmed,0,'A secure/misleading-success site must not produce a confirmed risk');
  }else if(requirePositive){
    const actualViolation=fixtureState.mode==='object-boundary'?metrics.unauthorized_reads+metrics.unauthorized_updates:metrics.invalid_orders;
    assert.ok(actualViolation>0,'A positive result requires an actual server-side boundary violation');
    assert.ok(confirmed>0,'A reproduced fault must be backed by a product finding');
  }
  return {normal_flows_verified:true,confirmed_risks:confirmed,actual_violations:{reads:metrics.unauthorized_reads,writes:metrics.unauthorized_updates,orders:metrics.invalid_orders}};
}

export async function createBusinessLearningAcceptance({mode='secure',outputDirectory,api:existingAPI,provider:providedProvider}={}){
  const provider=providedProvider||await loadAcceptanceProvider();
  const out=path.resolve(outputDirectory||process.env.BSTG_BUSINESS_LEARNING_OUT||path.join(root,'artifacts',`business-learning-${mode}-${Date.now()}`));
  await mkdir(out,{recursive:true,mode:0o700});
  const fixture=await createBusinessLearningFixture({mode});
  const report={started_at:new Date().toISOString(),mode,scope:'Actual model, BSTG backend/native execution, real Chromium, and independent fixture state',ok:false,observations:[]};
  let backend,logs='',browser,page,closed=false;
  const redact=value=>String(value).split(provider.api_key).join('[provider credential redacted]');
  try{
    const api=existingAPI||`http://127.0.0.1:${await freePort()}`;
    if(!existingAPI){
      backend=spawn(process.execPath,['scripts/start-server.mjs'],{cwd:root,env:{...process.env,PORT:new URL(api).port,
        BSTG_DATA_DIR:path.join(out,'data'),BSTG_BROWSER_MODE:process.env.BSTG_BUSINESS_BROWSER_MODE||'headless',BUILT_IN_FORGE_API_KEY:'',OPENAI_API_KEY:'',SERVE_FRONTEND:'true'},stdio:['ignore','pipe','pipe']});
      backend.stdout.on('data',chunk=>logs+=chunk);backend.stderr.on('data',chunk=>logs+=chunk);
      const until=Date.now()+45000;
      for(;;){
        if(backend.exitCode!==null)throw Error('Backend exited: '+redact(logs.slice(-2000)));
        try{if((await fetch(api+'/health')).ok)break;}catch{}
        if(Date.now()>until)throw Error('Backend health timeout');await sleep(100);
      }
    }
    await configureAcceptanceProvider(api,provider);
    const {chromium}=require('playwright');browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:1440,height:1080}});
    const browserErrors=[];page.on('pageerror',error=>browserErrors.push(error.message));await page.goto(api+'?lang=zh',{waitUntil:'domcontentloaded'});
    const context={api,provider,out,fixture,browser,page,report,browserErrors,
      async createScan({userPrompt=DEFAULT_GOAL,scanConfig={},selectedVulnTypes=['bola_idor','business_logic','replay_race','state_machine_race']}={}){
        const response=await fetch(api+'/api/ai-scans?view=product',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          name:'Business learning real-model acceptance',base_url:fixture.baseUrl,user_prompt:userPrompt,language:'en',selected_vuln_types:selectedVulnTypes,
          scan_config:{surface:'web',driving_mode:'autopilot',auto_start:true,authorization_acknowledged:true,account_mode:'manual',accounts:fixture.credentials,max_pages:12,request_evidence_required:true,...scanConfig},
        })});
        const body=await response.json();assert.equal(response.status,201,'Create the scan through the actual product API: '+JSON.stringify(body.error||null));
        const run=body.data?.run||body.data;assert.ok(run?.id,'Created run must have an ID');report.run_id=run.id;return run;
      },
      async waitForRun(runId,{timeoutMs=1200000,intervalMs=250,onObservation}={}){
        const until=Date.now()+timeoutMs;let state;
        while(Date.now()<until){
          const response=await fetch(`${api}/api/ai-scans/${runId}/product-state`);assert.equal(response.status,200);state=(await response.json()).data;
          const observation={at:new Date().toISOString(),status:state.run.status,phase:state.run.current_phase,totals:state.totals,metrics:fixture.snapshot().metrics};
          const last=report.observations.at(-1);if(!last||last.status!==observation.status||last.phase!==observation.phase||JSON.stringify(last.metrics)!==JSON.stringify(observation.metrics))report.observations.push(observation);
          if(onObservation)await onObservation({state,fixture,context});
          if(['completed','failed','cancelled'].includes(state.run.status))return state;
          await sleep(intervalMs);
        }
        throw Error(`Real-model business-learning run did not reach a terminal status within ${timeoutMs}ms (last: ${state?.run?.status})`);
      },
      async collect(runId){
        const technicalResponse=await fetch(`${api}/api/ai-scans/${runId}`);assert.equal(technicalResponse.status,200);const technical=(await technicalResponse.json()).data;
        const stateResponse=await fetch(`${api}/api/ai-scans/${runId}/product-state`);assert.equal(stateResponse.status,200);const productState=(await stateResponse.json()).data;
        const fixtureState=fixture.snapshot();
        await writeFile(path.join(out,'technical-state.json'),JSON.stringify(technical,null,2),{mode:0o600});
        await writeFile(path.join(out,'product-state.json'),JSON.stringify(productState,null,2),{mode:0o600});
        await writeFile(path.join(out,'fixture-state.json'),JSON.stringify(fixtureState,null,2),{mode:0o600});
        await page.screenshot({path:path.join(out,'workspace.png'),fullPage:true}).catch(()=>{});
        report.model_evidence=verifyModelDecisions(technical,provider);report.metrics=fixtureState.metrics;report.target_requests=fixtureState.request_count;
        return {technical,productState,fixtureState};
      },
      async close(error){
        if(closed)return;closed=true;if(error){report.error=redact(error.stack||error);report.ok=false;await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});}
        await browser?.close();
        if(backend){backend.kill('SIGTERM');await Promise.race([once(backend,'exit'),sleep(5000)]);if(backend.exitCode===null){backend.kill('SIGKILL');await Promise.race([once(backend,'exit'),sleep(1000)]);}}
        await fixture.close();report.completed_at=new Date().toISOString();await writeFile(path.join(out,'backend.log'),redact(logs),{mode:0o600});await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2),{mode:0o600});
      },
    };
    return context;
  }catch(error){
    await browser?.close();if(backend)backend.kill('SIGKILL');await fixture.close();report.error=redact(error.stack||error);report.completed_at=new Date().toISOString();await writeFile(path.join(out,'backend.log'),redact(logs),{mode:0o600});await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2),{mode:0o600});throw error;
  }
}

export async function runBusinessLearningAcceptance(options={}){
  const context=await createBusinessLearningAcceptance(options);
  try{
    const run=options.createRun?await options.createRun(context):await context.createScan(options);
    await context.waitForRun(run.id,options);const result=await context.collect(run.id);
    assert.equal(result.productState.run.status,'completed','Acceptance requires a completed product run');
    const verify=options.verify||assertBusinessLearningOracle;
    context.report.verification=await verify({...result,context,requirePositive:options.requirePositive===true});
    assert.deepEqual(context.browserErrors,[]);context.report.ok=true;await context.close();return {report:context.report,out:context.out,...result};
  }catch(error){await context.close(error);throw error;}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const result=await runBusinessLearningAcceptance({mode:process.env.BSTG_BUSINESS_FIXTURE_MODE||'secure',requirePositive:process.env.BSTG_BUSINESS_REQUIRE_POSITIVE==='1',
    timeoutMs:Number(process.env.BSTG_BUSINESS_ACCEPTANCE_TIMEOUT_MS||1200000),scanConfig:JSON.parse(process.env.BSTG_BUSINESS_SCAN_CONFIG||'{}')});console.log(JSON.stringify({ok:true,output:result.out,model_evidence:result.report.model_evidence,verification:result.report.verification},null,2));}
  catch(error){console.error(error.stack||error);process.exitCode=1;}
}
