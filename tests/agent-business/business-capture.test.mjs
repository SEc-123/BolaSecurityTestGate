/** Real Chromium, HTTP sockets and SQLite. This is execution integration, not
 * an LLM benchmark: the page actions here are deliberately authored by the test. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {SqliteProvider} from '../../server/src/db/sqlite-provider.ts';
import {dbManager} from '../../server/src/db/db-manager.ts';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {newBusinessFlow,saveBusinessFlow,getBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {CoverageRetryEventSelectionError,SemanticBodyCandidateRequiredError,coverageRetryTargetAssertionIssuesForBindings,coverageRetryTargetAssertionRequirementsForBindings,startBusinessCapture,stopBusinessCapture,inspectBusinessCapture,prepareBusinessWorkflow,repairBusinessWorkflow,reviseBusinessWorkflow,inspectBusinessWorkflow,validateBusinessWorkflow,publicBusinessCaptureTarget,interruptBusinessCapturesForTask} from '../../server/src/services/ai-scan/agent-business-capture.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {navigatePersistentBrowser,interactPersistentBrowser,closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {buildBusinessLearningToolSpecs} from '../../server/src/agent/tools/business-learning-tools.ts';
import {createRecordingSession,ingestRecordingEventsBatch} from '../../server/src/services/recording-service.ts';
import {isWorkflowReplayCandidate} from '../../server/src/services/recording-generator.ts';
import {BUSINESS_LEARNING_INTENT,BUSINESS_PLAN_INTENT,BUSINESS_REVIEW_INTENT,businessCompletionGap,latestBusinessFlows,scheduleBusinessCoverageRetry} from '../../server/src/agent/business-task-lifecycle.ts';
import {createBusinessLearningFixture} from '../product-experience/business-learning-fixture.mjs';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';

async function fixture({backgroundPolling=false}={}){
  const tickets=new Set(),events=[],customNonce=`opaque-${randomUUID()}`;let counter=0,completed=0;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture.invalid'),chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString(),data=raw?JSON.parse(raw):{};
    const send=(status,body,headers={})=>{events.push({path:url.pathname,status,data});res.writeHead(status,{'content-type':'application/json',...headers});res.end(JSON.stringify(body));};
    if(url.pathname==='/portal'){
      res.writeHead(200,{'content-type':'text/html'});
      res.end(`<title>Business integration fixture</title><button id="run">Run normal operation</button><button id="repeat">Repeat consumed operation</button><button id="statusOnly">Read independent status</button><button id="semanticAction">Run semantic action</button><button id="parentTarget">Run independent parent target</button><button id="retryTarget">Run independent retry target</button><button id="backgroundRace">Run direct action</button><button id="continuations">Run continuations</button><button id="error">Return business error</button><button id="break">Failed operation</button><button id="opaque">Load opaque bodies</button><form id="nativeSubmit"><input id="nativeSubmitInput" value="seven"><button id="nativeSubmitButton" type="submit">Submit native form</button></form><form id="unrelatedNativeSubmit"><input value="other"><button type="submit">Submit unrelated form</button></form><button id="deferredUnrelatedSubmit" type="button">Submit unrelated form later</button><div id="result"></div>
        <script>let lastTicket;document.querySelector('#run').onclick=async()=>{
          const first=await(await fetch('/r/a1')).json();
          lastTicket=first.ticket;
          await fetch('/status');
          const result=await(await fetch('/r/a2',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:first.ticket,amount:7})})).json();
          await fetch('/r/a3');await fetch('/r/a3');
          document.querySelector('#result').textContent=JSON.stringify({...result,echo_custom:first.custom.nonce_custom});
        };document.querySelector('#repeat').onclick=async()=>{
          const result=await(await fetch('/r/a2',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:lastTicket,amount:7})})).json();
          document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#statusOnly').onclick=async()=>{
          const result=await(await fetch('/status')).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#semanticAction').onclick=async()=>{
          const result=await(await fetch('/r/semantic-action',{method:'POST'})).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#parentTarget').onclick=async()=>{
          const result=await(await fetch('/r/parent-target')).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#retryTarget').onclick=async()=>{
          const result=await(await fetch('/r/retry-target')).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#nativeSubmit').onsubmit=async(event)=>{event.preventDefault();const result=await(await fetch('/r/form-submit',{method:'POST'})).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#unrelatedNativeSubmit').onsubmit=async(event)=>{event.preventDefault();const result=await(await fetch('/r/unrelated-form-submit',{method:'POST'})).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#deferredUnrelatedSubmit').onclick=()=>setTimeout(()=>document.querySelector('#unrelatedNativeSubmit').requestSubmit(),300);
        document.querySelector('#continuations').onclick=()=>{
          fetch('/r/continuation-sync');
          Promise.resolve().then(()=>fetch('/r/continuation-promise'));
          queueMicrotask(()=>fetch('/r/continuation-microtask'));
          requestAnimationFrame(()=>fetch('/r/continuation-raf'));
          setTimeout(()=>fetch('/r/continuation-timeout'),20);
        };document.querySelector('#error').onclick=async()=>{
          const result=await(await fetch('/r/error',{method:'POST'})).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };document.querySelector('#backgroundRace').onclick=async()=>{
          const result=await(await fetch('/r/direct-action')).json();document.querySelector('#result').textContent=JSON.stringify(result);
        };${backgroundPolling?"setInterval(()=>fetch('/r/poll').catch(()=>{}),25);":''}document.querySelector('#opaque').onclick=async()=>{
          await fetch('/r/text');await fetch('/r/binary');document.querySelector('#result').textContent='opaque loaded';
        };document.querySelector('#break').onclick=()=>fetch('/r/fail').catch(()=>{document.querySelector('#result').textContent='failed';});</script>`);return;
    }
    if(url.pathname==='/r/a1'){const ticket=`fresh-ticket-${++counter}-${randomUUID()}`;tickets.add(ticket);send(200,{ticket,phase:'prepared',custom:{nonce_custom:customNonce}});return;}
    if(url.pathname==='/status'){send(200,{status:'ready'});return;}
    if(url.pathname==='/r/semantic-action'){send(200,{state:'semantic'});return;}
    if(url.pathname==='/r/form-submit'){send(200,{state:'form-submitted',applied:true});return;}
    if(url.pathname==='/r/unrelated-form-submit'){send(200,{state:'unrelated-form-submitted',applied:true});return;}
    if(url.pathname==='/r/parent-target'){send(200,{state:'parented'});return;}
    if(url.pathname==='/r/retry-target'){send(200,{state:'retried'});return;}
    if(url.pathname==='/r/direct-action'){send(200,{state:'direct'});return;}
    if(url.pathname.startsWith('/r/continuation-')){send(200,{state:'continuation'});return;}
    if(url.pathname==='/r/poll'){send(200,{state:'poll'});return;}
    if(url.pathname==='/r/a2'){
      if(!tickets.delete(data.ticket)){send(409,{state:'rejected',applied:false});return;}
      completed++;send(200,{state:'completed',amount:7,applied:true});return;
    }
    if(url.pathname==='/r/a3'){send(200,JSON.parse('{"same":true,"__proto__":"prototype-sentinel","__PROTO__":"prototype-sentinel","prototype":"prototype-sentinel","Constructor":"prototype-sentinel","123456":"numeric-key","-123":"numeric-key","550e8400-e29b-41d4-a716-446655440000":"uuid-key","{550e8400-e29b-41d4-a716-446655440000}":"uuid-key","0123456789abcdef0123456789abcdef":"hex-token-key","AbC1dE2fG3hI4jK5lM6nO7pQ":"random-key","opaqueKey_7Qm2Vx9Lr4Np8Ts6Wz1Ha5Kd":"random-key","YWJjZGVmZ2hpamtsbW5vcA==":"base64-key","alice@internal":"email-key"}'),{'content-security-policy-report-only':'default-src \'none\''});return;}
    if(url.pathname==='/r/error'){send(422,{state:'rejected',error:'expected business failure'});return;}
    if(url.pathname==='/r/text'){res.writeHead(200,{'content-type':'text/plain'});res.end('one-time-code=123456');return;}
    if(url.pathname==='/r/binary'){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(Buffer.from([0xff,0x00,0xfe,0x01]));return;}
    if(url.pathname==='/r/fail'){req.socket.destroy();return;}
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,events,customNonce,completed:()=>completed,
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

test('coverage retry candidates use the same executable-event predicate as Workflow generation',()=>{
  const base={id:'candidate',sequence:1,method:'POST',path:'/normal-operation',url:'http://fixture.invalid/normal-operation',
    request_headers:{},response_headers:{},response_status:200,request_body_text:'{}',parsed_response_body:{state:'completed'}};
  assert.equal(isWorkflowReplayCandidate(base,[],[]),true,'an ordinary observed operation can become a Workflow source step');
  assert.equal(isWorkflowReplayCandidate({...base,id:'options',method:'OPTIONS'},[],[]),false,
    'a preflight request cannot be advertised as a retry target candidate');
  assert.equal(isWorkflowReplayCandidate({...base,id:'static',method:'GET',path:'/assets/app.js',url:'http://fixture.invalid/assets/app.js',request_body_text:''},[],[]),false,
    'an empty static asset cannot be advertised as a retry target candidate');
});

test('business capture target exposes a route shape and never an object pathname value',()=>{
  const target=publicBusinessCaptureTarget('https://example.test/orders/customer-123?view=full&ticket=private-ticket');
  assert.deepEqual(target,{origin:'https://example.test',path:'/orders/:value',query_fields:[{name:'view',sensitive:false},{name:'ticket',sensitive:true}]});
  assert.equal(JSON.stringify(target).includes('customer-123'),false);
  assert.equal(JSON.stringify(target).includes('private-ticket'),false);
});

test('strict normal-business learning rejects an HTTP recording before it can become a native workflow',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('strict-https-business-capture',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,
    scan_config:{business_learning:{require_verified_https:true}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Strict HTTPS normal learning',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Strict HTTPS normal flow',goal:'Capture a normal action through verified transport',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#semanticAction'}})).ok,true);
    await stopBusinessCapture(context,capture.recording_session_id);
    const inspected=await inspectBusinessCapture(context,capture.recording_session_id);
    assert.ok(inspected.events.length>0,'the HTTP fixture supplied an observed action for the strict policy gate');
    await assert.rejects(
      prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:inspected.events.map(event=>event.event_id)}),
      /certificate-verified HTTPS target/,
    );
    assert.equal((await db.repos.workflows.findAll({where:{source_recording_session_id:capture.recording_session_id}})).length,0,
      'an unverified transport recording must not create a replayable native Workflow');
    const learningArtifacts=(await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_workflow_learning');
    assert.equal(learningArtifacts.length,0,'the policy rejects before emitting a workflow-learning success receipt');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('strict normal-business learning rejects an HTTPS-shaped recording without request-level Chromium security evidence',async()=>{
  const db=new SqliteProvider('strict-https-cdp-evidence',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:'https://fixture.invalid',
    scan_config:{business_learning:{require_verified_https:true}}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Strict Chromium TLS evidence',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Strict Chromium TLS evidence',goal:'A request needs CDP secure state',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const eventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:task.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:1,url:'https://fixture.invalid/normal-operation',actionId:'captured-browser-action',method:'POST',responseBody:{state:'completed'},
      tls:{scheme:'https',certificate_verified:true,trust_mode:'platform_trust_store'}});
    await stopBusinessCapture(context,capture.recording_session_id);
    await assert.rejects(
      prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:[eventId]}),
      /certificate-verified HTTPS target/,
      'a URL scheme and legacy boolean cannot substitute for the same response\'s CDP secure state',
    );
    assert.equal((await db.repos.workflows.findAll({where:{source_recording_session_id:capture.recording_session_id}})).length,0,
      'the incomplete TLS provenance never produces a Workflow');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();}
});

test('only a request dispatched by the browser interaction receives causal action evidence',{timeout:60000},async()=>{
  const target=await fixture({backgroundPolling:true}),db=new SqliteProvider('causal-action-capture',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Causal capture',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow'}});
  const flow=newBusinessFlow({name:'Causal capture',goal:'Direct browser action',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    await new Promise(resolve=>setTimeout(resolve,80));
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#backgroundRace'}});assert.equal(action.ok,true);
    const actionCompletedAt=new Date().toISOString();
    await new Promise(resolve=>setTimeout(resolve,80));
    try { await stopBusinessCapture(context,capture.recording_session_id); }
    catch(error) { throw new Error(`${error.message}: ${JSON.stringify((await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_capture_event').map(item=>({path:new URL(item.content_json.url).pathname,action_id:item.content_json.action_id,causal_proof:item.content_json.causal_proof})))}`); }
    const artifacts=(await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_capture_event').map(item=>item.content_json);
    const polling=artifacts.filter(event=>new URL(event.url).pathname==='/r/poll');
    const direct=artifacts.filter(event=>new URL(event.url).pathname==='/r/direct-action');
    const pollingAfterAction=polling.filter(event=>event.started_at>=actionCompletedAt);
    assert.ok(pollingAfterAction.length>0,'the fixture generated background transport after the input dispatch completed');
    assert.ok(pollingAfterAction.every(event=>!event.action_id&&!event.causal_proof),'post-dispatch periodic transport never inherits the click action');
    assert.equal(direct.length,1,'the explicit interaction issued one direct request');
    assert.equal(direct[0].action_id,action.action_id);
    assert.equal(direct[0].causal_proof,'trusted_browser_interaction_dispatch');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('real Chromium retains causal proof only through action-derived async continuations',{timeout:60000},async()=>{
  const target=await fixture({backgroundPolling:true}),db=new SqliteProvider('causal-continuation-capture',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Causal continuations',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow'}});
  const flow=newBusinessFlow({name:'Causal continuations',goal:'Action-derived requests',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    await new Promise(resolve=>setTimeout(resolve,80));
    const asyncAction=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#run'}});assert.equal(asyncAction.ok,true);
    const continuationAction=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#continuations'}});assert.equal(continuationAction.ok,true);
    await new Promise(resolve=>setTimeout(resolve,100));
    await stopBusinessCapture(context,capture.recording_session_id);
    const artifacts=(await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_capture_event').map(item=>item.content_json);
    const asyncPaths=['/r/a1','/status','/r/a2','/r/a3'];
    const asyncRequests=artifacts.filter(event=>asyncPaths.includes(new URL(event.url).pathname));
    assert.equal(asyncRequests.length,5,'the async handler made every expected request');
    assert.ok(asyncRequests.every(event=>event.action_id===asyncAction.action_id&&event.causal_proof==='trusted_browser_interaction_dispatch'),
      `await response/json continuations retain only their originating click proof: ${JSON.stringify(asyncRequests.map(event=>({path:new URL(event.url).pathname,action_id:event.action_id,causal_proof:event.causal_proof})))}`);
    const continuationPaths=['/r/continuation-sync','/r/continuation-promise','/r/continuation-microtask','/r/continuation-raf','/r/continuation-timeout'];
    const continuationRequests=artifacts.filter(event=>continuationPaths.includes(new URL(event.url).pathname));
    assert.equal(continuationRequests.length,continuationPaths.length,'the action scheduled every bounded continuation');
    assert.ok(continuationRequests.every(event=>event.action_id===continuationAction.action_id&&event.causal_proof==='trusted_browser_interaction_dispatch'),
      'sync, Promise, microtask, rAF and short one-shot timer work retain the exact action proof');
    const polling=artifacts.filter(event=>new URL(event.url).pathname==='/r/poll');
    assert.ok(polling.length>0);
    assert.ok(polling.every(event=>!event.action_id&&!event.causal_proof),'pre-existing setInterval polling never inherits a proof');
    assert.ok(artifacts.every(event=>!Object.keys(event.request_headers||{}).some(name=>name.toLowerCase()==='x-bstg-causal-request')),
      'the causal rendezvous marker never reaches persisted capture headers');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('real Chromium carries a submit-control action only into its immediate trusted form submit',{timeout:60000},async()=>{
  const target=await fixture({backgroundPolling:true}),db=new SqliteProvider('causal-form-submit-capture',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Causal native form submit',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow'}});
  const flow=newBusinessFlow({name:'Causal native form submit',goal:'Native submit action',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    await new Promise(resolve=>setTimeout(resolve,60));
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#nativeSubmitButton'}});assert.equal(action.ok,true);
    await new Promise(resolve=>setTimeout(resolve,80));
    await stopBusinessCapture(context,capture.recording_session_id);
    const artifacts=(await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_capture_event').map(item=>item.content_json);
    const submitted=artifacts.filter(event=>new URL(event.url).pathname==='/r/form-submit');
    assert.equal(submitted.length,1,'the form handler sent exactly one semantic request');
    assert.equal(submitted[0].action_id,action.action_id);
    assert.equal(submitted[0].causal_proof,'trusted_browser_interaction_dispatch');
    const polling=artifacts.filter(event=>new URL(event.url).pathname==='/r/poll');
    assert.ok(polling.length>0);
    assert.ok(polling.every(event=>!event.action_id&&!event.causal_proof),'background polling cannot consume the one-shot submit proof');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('a delayed trusted submit for another form cannot consume a submit-control action proof',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('causal-unrelated-form-submit',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Unrelated native form submit',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow'}});
  const flow=newBusinessFlow({name:'Unrelated native form submit',goal:'Reject delayed submit inheritance',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#deferredUnrelatedSubmit'}});assert.equal(action.ok,true);
    await new Promise(resolve=>setTimeout(resolve,430));
    const artifacts=(await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_capture_event').map(item=>item.content_json);
    const submitted=artifacts.filter(event=>new URL(event.url).pathname==='/r/unrelated-form-submit');
    assert.equal(submitted.length,1);
    assert.equal(submitted[0].action_id,undefined,'a distinct form is not an immediate continuation of the clicked control');
    assert.equal(submitted[0].causal_proof,undefined);
    await assert.rejects(stopBusinessCapture(context,capture.recording_session_id),error=>error instanceof SemanticBodyCandidateRequiredError);
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('coverage-retry validation requires a semantic assertion on every scheduled target source step',()=>{
  const targets=[
    {target_type:'operation',target_id:'opaque-operation-a'},
    {target_type:'operation',target_id:'opaque-operation-b'},
  ];
  const bindings=[
    {target_type:'operation',target_id:'opaque-operation-a',source_workflow_id:'opaque-workflow',source_step_order:2},
    {target_type:'operation',target_id:'opaque-operation-b',source_workflow_id:'opaque-workflow',source_step_order:4},
  ];
  assert.deepEqual(coverageRetryTargetAssertionRequirementsForBindings(targets,bindings),[
    {target_type:'operation',target_id:'opaque-operation-a',source_step_orders:[2],semantic_body_assertion_required:true},
    {target_type:'operation',target_id:'opaque-operation-b',source_step_orders:[4],semantic_body_assertion_required:true},
  ],'the model receives only opaque target IDs and exact source-step proof requirements');
  const semantic=(step_order,id)=>({id,step_order,description:'Observed state',purpose:'goal',left:{type:'response',path:'body.state'},op:'equals',right:{type:'captured_baseline'}});
  const unrelated=coverageRetryTargetAssertionIssuesForBindings(targets,bindings,[semantic(1,'unrelated')]);
  assert.deepEqual(unrelated.map(issue=>issue.step_order),[2,4]);
  assert.ok(unrelated.every(issue=>issue.semantic_body_required===true));
  const partial=coverageRetryTargetAssertionIssuesForBindings(targets,bindings,[semantic(2,'first-target')]);
  assert.deepEqual(partial.map(issue=>issue.step_order),[4],
    'a retry with two scheduled opaque targets cannot borrow the first target assertion for the second');
  assert.deepEqual(coverageRetryTargetAssertionIssuesForBindings(targets,bindings,[semantic(2,'first-target'),semantic(4,'second-target')]),[]);
});

test('retry assertion revision feedback names every opaque target requirement before a native Test Run',{timeout:120000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-retry-assertion-feedback',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,name:'Retry assertion feedback'});
  const parent=await repo.createTask({scan_run_id:run.id,title:'Parent normal proof',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Retry two observed operations',goal:'Each scheduled operation has its own native semantic proof',role:'anonymous'},parent.id);
  await saveBusinessFlow(repo,run.id,parent.id,{...flow,status:'verified',workflow_id:'prior-workflow',normal_run_id:'prior-run',assertions_verified:true,evidence_artifact_ids:['prior-proof']});
  await repo.updateTask(parent.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const [firstTarget,secondTarget]=await Promise.all([
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/parent-target'}),
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/retry-target'}),
  ]);
  const retryTargets=[
    {key:`operation:${firstTarget.id}`,target_type:'operation',target_id:firstTarget.id},
    {key:`operation:${secondTarget.id}`,target_type:'operation',target_id:secondTarget.id},
  ];
  const retry=await repo.createTask({scan_run_id:run.id,parent_task_id:parent.id,title:'Retry two observed operations',task_type:'learn_business_flow',dependencies:[parent.id],execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id,
    coverage_retry:{origin_task_id:parent.id,attempt:1,targets:retryTargets}}});
  await repo.createArtifact({scan_run_id:run.id,task_id:parent.id,artifact_type:'business_coverage_retry_scheduled',source_ref:retry.id,title:'Scheduled retry proof',
    content_json:{flow_id:flow.id,source_task_id:parent.id,retry_task_id:retry.id,targets:retryTargets}});
  const context={db,repo,scanRunId:run.id,taskId:retry.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:retry.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#parentTarget'}})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#retryTarget'}})).ok,true);
    await stopBusinessCapture(context,capture.recording_session_id);
    const inspected=await inspectBusinessCapture(context,capture.recording_session_id);
    const workflow=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:inspected.events.map(event=>event.event_id)});
    const requirements=workflow.retry_target_assertion_requirements;
    assert.equal(requirements.length,2);
    const firstRequirement=requirements.find(requirement=>requirement.target_id===firstTarget.id);
    const secondRequirement=requirements.find(requirement=>requirement.target_id===secondTarget.id);
    assert.ok(firstRequirement?.source_step_orders?.length&&secondRequirement?.source_step_orders?.length,
      'the inspect result maps each scheduled opaque target to its exact proof step(s)');
    const registry=new AgentToolRegistry();for(const spec of buildBusinessLearningToolSpecs())registry.register(spec);
    const before=(await db.repos.testRuns.findAll()).length;
    const rejected=await registry.call('bstg.business.workflow.validate',{workflow_id:workflow.workflow_id,assertions:[{
      id:'only-first-target',step_order:firstRequirement.source_step_orders[0],description:'Only the first scheduled operation is semantically asserted',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'captured_baseline'},
    }]},context);
    assert.equal(rejected.ok,true,'a retry assertion mismatch remains non-terminal model revision feedback');
    assert.equal(rejected.data.status,'assertion_revision_required');assert.equal(rejected.data.native_execution_started,false);
    assert.deepEqual(rejected.data.retry_target_assertion_requirements,requirements,
      'the correction response retains every server-derived opaque target-to-step requirement');
    assert.ok(rejected.data.rejected_assertions.some(issue=>issue.step_order===secondRequirement.source_step_orders[0]&&issue.semantic_body_required===true));
    assert.equal((await db.repos.testRuns.findAll()).length,before,'the rejected partial retry assertion cannot create a native Test Run');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('only a scheduler-created coverage retry can replace prior native normal evidence with a fresh task capture',{timeout:60000},async t=>{
 const target=await fixture();
 const db=new SqliteProvider('business-coverage-retry',{file:':memory:'});await db.connect();await db.migrate();
 const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
 const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
 const original=await repo.createTask({scan_run_id:run.id,title:'Original normal learning',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
 const flow=newBusinessFlow({name:'Create private note',goal:'The member sees the created note',role:'anonymous'},original.id);
 await saveBusinessFlow(repo,run.id,original.id,{...flow,status:'verified',workflow_id:'prior-workflow',normal_run_id:'prior-run',assertions_verified:true,evidence_artifact_ids:['prior-proof']});
 await repo.updateTask(original.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
 await repo.createArtifact({scan_run_id:run.id,task_id:original.id,artifact_type:'business_workflow_validation',source_ref:'prior-run',title:'Prior native validation',content_json:{flow_id:flow.id,workflow_id:'prior-workflow',test_run_id:'prior-run'}});
 const retryTargets=[{key:'operation:notes',target_type:'operation',target_id:'notes'}];
 const forged=await repo.createTask({scan_run_id:run.id,parent_task_id:original.id,title:'Forged coverage retry',task_type:'learn_business_flow',dependencies:[original.id],execution_plan:{intent:'learn_business_flow',flow_id:flow.id,
   coverage_retry:{origin_task_id:original.id,attempt:1,targets:retryTargets,completion_recovery:{attempt:1,status:'capture_required'}}}});
 const retry=await repo.createTask({scan_run_id:run.id,parent_task_id:original.id,title:'Coverage retry',task_type:'learn_business_flow',dependencies:[original.id],execution_plan:{intent:'learn_business_flow',flow_id:flow.id,
   coverage_retry:{origin_task_id:original.id,attempt:1,targets:retryTargets}}});
 await repo.createArtifact({scan_run_id:run.id,task_id:original.id,artifact_type:'business_coverage_retry_scheduled',source_ref:retry.id,title:'Scheduler coverage retry',
   content_json:{flow_id:flow.id,source_task_id:original.id,retry_task_id:retry.id,targets:retryTargets}});
 process.env.BSTG_BROWSER_MODE='headless';
 try{
   await assert.rejects(startBusinessCapture({db,repo,scanRunId:run.id,taskId:original.id},{flow_id:flow.id}),/already has native workflow\/Test Run evidence/);
   await assert.rejects(startBusinessCapture({db,repo,scanRunId:run.id,taskId:forged.id},{flow_id:flow.id}),/owned by a different normal-learning task/);
   assert.equal((await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_coverage_retry_context_reset').length,0,
     'a malformed retry cannot reset any browser context');
   const retryContext={db,repo,scanRunId:run.id,taskId:retry.id};
   const initialCapture=await startBusinessCapture(retryContext,{flow_id:flow.id});
   assert.equal(initialCapture.coverage_retry,true);
   assert.equal((await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_coverage_retry_context_reset').length,0,
     'the retry\'s normal initial capture must not reset its task context');
   const initialRetryBrowser={repo,scanRunId:run.id,taskId:retry.id,scope_base_url:target.baseUrl,context_key:initialCapture.context_key};
   assert.equal((await navigatePersistentBrowser({...initialRetryBrowser,url:target.baseUrl+'/portal'})).ok,true);
   assert.equal((await interactPersistentBrowser({...initialRetryBrowser,operation:{action:'click',selector:'#statusOnly'}})).ok,true);
   await stopBusinessCapture(retryContext,initialCapture.recording_session_id);
   await repo.upsertBrowserContext({scan_run_id:run.id,task_id:retry.id,context_key:`task:${retry.id}`,scope_type:'task',identity_key:'anonymous',status:'active',
     storage_state_json:{cookies:[{name:'session',value:'private-task-state'}]}});
   await repo.upsertBrowserContext({scan_run_id:run.id,task_id:retry.id,context_key:'identity:shared-member',scope_type:'identity',identity_key:'shared-member',status:'active'});
   await assert.rejects(startBusinessCapture(retryContext,{flow_id:flow.id}),/existing business capture.*server-authorized completion recovery/i,
     'a model cannot start a second retry capture merely because the first recording stopped');
   assert.equal((await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_coverage_retry_context_reset').length,0,
     'a rejected model recapture must not close or reset the retry task context');
   await repo.updateTask(retry.id,{execution_plan:{...retry.execution_plan,coverage_retry:{...retry.execution_plan.coverage_retry,
     completion_recovery:{attempt:1,status:'capture_required'}}}});
   const originalCloseBrowserContextRecord=repo.closeBrowserContextRecord.bind(repo);let recoveryCloseCalls=0;
   repo.closeBrowserContextRecord=async(...args)=>{
     recoveryCloseCalls++;
     return originalCloseBrowserContextRecord(...args);
   };
   const concurrentStarts=await Promise.allSettled([
     startBusinessCapture(retryContext,{flow_id:flow.id}),
     startBusinessCapture(retryContext,{flow_id:flow.id}),
   ]);
   repo.closeBrowserContextRecord=originalCloseBrowserContextRecord;
   const fulfilledStarts=concurrentStarts.filter(result=>result.status==='fulfilled');
   const rejectedStarts=concurrentStarts.filter(result=>result.status==='rejected');
   assert.equal(fulfilledStarts.length,1,'exactly one concurrent recovery capture owns the task browser recording');
   assert.equal(rejectedStarts.length,1,'the competing capture may fail after the winner owns the active recording');
   assert.match(String(rejectedStarts[0].reason),/active recording|existing business capture/i);
   assert.equal(recoveryCloseCalls,1,'the concurrent completion recovery closes its task context once');
   const capture=fulfilledStarts[0].value;
   assert.equal(capture.coverage_retry,true);
   assert.equal(capture.context_scope,'task','anonymous completion recovery is forced into a fresh task context');
   const resets=(await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_coverage_retry_context_reset');
   assert.equal(resets.length,1,'the scheduler-authorized completion recovery resets exactly once');
   assert.deepEqual(resets[0].content_json,{flow_id:flow.id,recovery_attempt:1,scope_type:'task',
     reset_reason:'coverage_retry_completion_gap',closed_task_context_count:1});
   assert.equal(JSON.stringify(resets[0].content_json).includes('private-task-state'),false,'the reset audit record contains no persisted browser state');
   assert.equal((await repo.getBrowserContext(run.id,'identity:shared-member'))?.status,'active',
     'the recovery leaves shared identity contexts alone');
   await assert.rejects(startBusinessCapture(retryContext,{flow_id:flow.id}),/already has an active recording/);
   assert.equal((await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_coverage_retry_context_reset').length,1,
     'a failed duplicate capture start cannot repeat the reset');
   const reset=await getBusinessFlow(repo,run.id,flow.id);
   assert.equal(reset.status,'learning');assert.equal(reset.workflow_id,undefined);assert.equal(reset.normal_run_id,undefined);assert.equal(reset.assertions_verified,false);
   await interruptBusinessCapturesForTask({db,repo,scanRunId:run.id,taskId:retry.id});

   const memberParent=await repo.createTask({scan_run_id:run.id,title:'Member parent normal learning',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
   const memberFlow=newBusinessFlow({name:'Member retry',goal:'The supplied member reaches the retried operation',role:'member'},memberParent.id);
   await db.repos.accounts.create({name:'Retry member',username:'member',status:'active',tags:['ai_scan',`scan:${run.id}`,'role:member'],
     fields:{username:'member',password:'private-member-password'},variables:{},auth_profile:{}});
   await saveBusinessFlow(repo,run.id,memberParent.id,{...memberFlow,status:'verified',workflow_id:'member-prior-workflow',normal_run_id:'member-prior-run',assertions_verified:true});
   await repo.updateTask(memberParent.id,{execution_plan:{intent:'learn_business_flow',flow_id:memberFlow.id}});
   const memberTargets=[{key:'operation:member-retry',target_type:'operation',target_id:'member-retry'}];
   const memberRetry=await repo.createTask({scan_run_id:run.id,parent_task_id:memberParent.id,title:'Member coverage retry',task_type:'learn_business_flow',dependencies:[memberParent.id],execution_plan:{intent:'learn_business_flow',flow_id:memberFlow.id,
     coverage_retry:{origin_task_id:memberParent.id,attempt:1,targets:memberTargets,completion_recovery:{attempt:1,status:'capture_required'}}}});
   await repo.createArtifact({scan_run_id:run.id,task_id:memberParent.id,artifact_type:'business_coverage_retry_scheduled',source_ref:memberRetry.id,title:'Member scheduler coverage retry',
     content_json:{flow_id:memberFlow.id,source_task_id:memberParent.id,retry_task_id:memberRetry.id,targets:memberTargets}});
   await repo.upsertBrowserContext({scan_run_id:run.id,task_id:memberRetry.id,context_key:`task:${memberRetry.id}`,scope_type:'task',identity_key:'member',status:'active',
     storage_state_json:{cookies:[{name:'session',value:'private-member-state'}]}});
   const memberCapture=await startBusinessCapture({db,repo,scanRunId:run.id,taskId:memberRetry.id},{flow_id:memberFlow.id});
   assert.equal(memberCapture.context_scope,'task');assert.equal(memberCapture.prepared_identity_login_required,true,
     'prepared-identity completion recovery also starts in a blank task context');
   const memberReset=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_coverage_retry_context_reset'&&artifact.content_json.flow_id===memberFlow.id);
   assert.deepEqual(memberReset?.content_json,{flow_id:memberFlow.id,recovery_attempt:1,scope_type:'task',
     reset_reason:'coverage_retry_completion_gap',closed_task_context_count:1});
   assert.equal(JSON.stringify(memberReset?.content_json).includes('private-member-state'),false);
   await interruptBusinessCapturesForTask({db,repo,scanRunId:run.id,taskId:memberRetry.id});
 }finally{
   await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();
 }
});

test('a coverage retry preserves parent native proof, proves only its scheduled target, and closes the aggregate coverage gate',{timeout:120000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-coverage-proof-ledger',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,name:'Coverage retry proof ledger'});
  const parent=await repo.createTask({scan_run_id:run.id,title:'Learn first coverage target',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Read independent parent target and retry target',goal:'Both independent normal operations are natively proven',role:'anonymous'},parent.id);
  await saveBusinessFlow(repo,run.id,parent.id,flow);await repo.updateTask(parent.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const [parentEndpoint,retryEndpoint]=await Promise.all([
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/parent-target'}),
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/retry-target'}),
  ]);
  const feature=await repo.createFeature({scan_run_id:run.id,name:'Independent normal operations',node_type:'feature',endpoint_ids:[parentEndpoint.id,retryEndpoint.id]});
  const plan=await repo.createTask({scan_run_id:run.id,title:'Plan coverage ledger',task_type:'plan_business_flows',status:'completed',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const review=await repo.createTask({scan_run_id:run.id,title:'Review coverage ledger',task_type:'review_business_flows',execution_plan:{intent:BUSINESS_REVIEW_INTENT}});
  const coverageTool=buildBusinessLearningToolSpecs().find(tool=>tool.name==='bstg.business.coverage.save');assert.ok(coverageTool);
  const saved=await coverageTool.handler({entries:[
    {target_type:'feature',target_id:feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:parentEndpoint.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:retryEndpoint.id,disposition:'planned',flow_id:flow.id},
  ]},{db,repo,scanRunId:run.id,taskId:plan.id});
  assert.equal(saved.ok,true,JSON.stringify(saved));process.env.BSTG_BROWSER_MODE='headless';
  const parentContext={db,repo,scanRunId:run.id,taskId:parent.id};
  try{
    const parentCapture=await startBusinessCapture(parentContext,{flow_id:flow.id});
    const parentBrowser={repo,scanRunId:run.id,taskId:parent.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:parentCapture.context_key};
    assert.equal((await navigatePersistentBrowser({...parentBrowser,url:target.baseUrl+'/portal'})).ok,true);
    assert.equal((await interactPersistentBrowser({...parentBrowser,operation:{action:'click',selector:'#parentTarget'}})).ok,true);
    await stopBusinessCapture(parentContext,parentCapture.recording_session_id);
    const parentSelection=(await inspectBusinessCapture(parentContext,parentCapture.recording_session_id)).events.map(event=>event.event_id);
    const parentWorkflow=await prepareBusinessWorkflow(parentContext,{recording_session_id:parentCapture.recording_session_id,event_ids:parentSelection});
    const parentStateStep=parentWorkflow.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.state'));
    assert.ok(parentStateStep,'the parent captures only the independent parent operation');
    const parentValidation=await validateBusinessWorkflow(parentContext,{workflow_id:parentWorkflow.workflow_id,assertions:[{
      id:'parent-target',step_order:parentStateStep.step_order,description:'The independent parent target is reached',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'parented'},
    }]});
    assert.equal(parentValidation.verified,true,JSON.stringify(parentValidation));
    const parentFlow=await getBusinessFlow(repo,run.id,flow.id);
    assert.ok(parentFlow.coverage_proof_ledger?.some(proof=>proof.target_id===parentEndpoint.id&&proof.validated_task_id===parent.id),
      'the parent seals its successful target in an immutable native proof ledger');
    let artifacts=await repo.listArtifacts(run.id),flows=latestBusinessFlows(artifacts);
    const currentParent=await repo.getTask(parent.id);assert.ok(currentParent);
    const retry=await scheduleBusinessCoverageRetry(repo,currentParent,flows,artifacts);assert.ok(retry);
    assert.deepEqual(retry.execution_plan.coverage_retry?.targets.map(item=>item.key),[`operation:${retryEndpoint.id}`],
      'the child is scheduled only for the planned target absent from the parent capture');
    assert.match(String(await businessCompletionGap(repo,retry,flows,artifacts,db)),/Coverage retry has not yet proved its required target/,
      'a parent proof cannot complete a child retry before that child has native evidence');

    const retryContext={db,repo,scanRunId:run.id,taskId:retry.id};
    const retryCapture=await startBusinessCapture(retryContext,{flow_id:flow.id});assert.equal(retryCapture.coverage_retry,true);
    const afterReset=await getBusinessFlow(repo,run.id,flow.id);
    assert.deepEqual(afterReset.coverage_bindings,[],'the child receives a fresh mutable binding set');
    assert.ok(afterReset.coverage_proof_ledger?.some(proof=>proof.target_id===parentEndpoint.id&&proof.validated_task_id===parent.id),
      'starting the child does not erase the parent proof ledger');
    const retryBrowser={repo,scanRunId:run.id,taskId:retry.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:retryCapture.context_key};
    assert.equal((await navigatePersistentBrowser({...retryBrowser,url:target.baseUrl+'/portal'})).ok,true);
    assert.equal((await interactPersistentBrowser({...retryBrowser,operation:{action:'click',selector:'#semanticAction'}})).ok,true);
    assert.equal((await interactPersistentBrowser({...retryBrowser,operation:{action:'click',selector:'#retryTarget'}})).ok,true);
    await stopBusinessCapture(retryContext,retryCapture.recording_session_id);
    const childRaw=(await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_capture_event'&&artifact.source_ref===retryCapture.recording_session_id);
    const childPaths=childRaw.map(artifact=>new URL(artifact.content_json.url).pathname);
    assert.ok(childPaths.includes('/r/retry-target'));
    assert.ok(!childPaths.includes('/r/parent-target'),'the child capture does not replay the parent target operation');
    const retryInspection=await inspectBusinessCapture(retryContext,retryCapture.recording_session_id);
    const targetEvent=retryInspection.events.find(event=>event.observed_coverage_targets?.some(target=>
      target.target_type==='operation'&&target.target_id===retryEndpoint.id));
    assert.ok(targetEvent,'capture inspection projects the opaque scheduled operation onto its exact observed event');
    assert.ok(targetEvent.observed_coverage_targets.every(target=>
      Object.keys(target).sort().join(',')==='target_id,target_type'),
      'the event-to-target projection reveals only opaque target references, never a path, payload, or business value');
    assert.deepEqual(retryInspection.retry_target_event_candidates,[{
      target_type:'operation',target_id:retryEndpoint.id,event_ids:[targetEvent.event_id],
    }], 'the retry receives only server-derived target/event references; the model still chooses its event subset');
    const omittedSelection=retryInspection.events.filter(event=>event.workflow_eligible&&event.event_id&&event.event_id!==targetEvent.event_id).map(event=>event.event_id);
    assert.ok(omittedSelection.length,'the fixture has a valid non-target event subset for the omission guard');
    await assert.rejects(prepareBusinessWorkflow(retryContext,{recording_session_id:retryCapture.recording_session_id,event_ids:omittedSelection}),error=>{
      assert.ok(error instanceof CoverageRetryEventSelectionError);
      assert.deepEqual(error.missing_scheduled_targets,[{target_type:'operation',target_id:retryEndpoint.id,event_ids:[targetEvent.event_id]}]);
      return true;
    },'the server rejects omission of a target event already present in the retry recording instead of silently adding it');
    assert.equal((await db.repos.workflows.findAll({where:{source_recording_session_id:retryCapture.recording_session_id}})).length,0,
      'the rejected model subset creates no Workflow side effect');
    const retrySelection=retryInspection.events.filter(event=>event.workflow_eligible&&event.event_id).map(event=>event.event_id);
    const retryWorkflow=await prepareBusinessWorkflow(retryContext,{recording_session_id:retryCapture.recording_session_id,event_ids:retrySelection});
    const retryBinding=retryWorkflow.coverage_bindings.find(binding=>binding.target_type==='operation'&&binding.target_id===retryEndpoint.id);
    const retryStateStep=retryWorkflow.steps.find(step=>step.step_order===retryBinding?.source_step_order&&step.assertion_paths.some(path=>path.path==='body.state'));
    assert.ok(retryStateStep,'the child binds its scheduled target to its own semantic source step, even when another selected observation also has a state field');
    const retryValidation=await validateBusinessWorkflow(retryContext,{workflow_id:retryWorkflow.workflow_id,assertions:[{
      id:'retry-target',step_order:retryStateStep.step_order,description:'The independent retry target reaches retried state',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'retried'},
    }]});
    assert.equal(retryValidation.verified,true,JSON.stringify(retryValidation));
    artifacts=await repo.listArtifacts(run.id);flows=latestBusinessFlows(artifacts);
    const finalFlow=flows.find(item=>item.id===flow.id);assert.ok(finalFlow);
    assert.ok(finalFlow.coverage_proof_ledger?.some(proof=>proof.target_id===parentEndpoint.id&&proof.validated_task_id===parent.id&&proof.normal_run_id===parentValidation.test_run_id),
      "the final Flow retains the parent's original native proof");
    assert.ok(finalFlow.coverage_proof_ledger?.some(proof=>proof.target_id===retryEndpoint.id&&proof.validated_task_id===retry.id&&proof.normal_run_id===retryValidation.test_run_id),
      'the final Flow appends a distinct child native proof for the scheduled target');
    assert.ok(finalFlow.coverage_bindings?.every(binding=>binding.source_workflow_id===retryWorkflow.workflow_id),
      'the active bindings describe only the child workflow while the ledger retains parent history');
    assert.equal(await businessCompletionGap(repo,retry,flows,artifacts,db),undefined,
      'A+B proof ledger satisfies the child completion gate without replaying A');
    assert.equal(await businessCompletionGap(repo,review,flows,artifacts,db),undefined,
      'the aggregate review gate accepts both immutable native proofs');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('complete correlated capture → established recording generator → dynamic native normal validation',{timeout:120000},async t=>{
  const target=await fixture();
  const db=new SqliteProvider('business-capture-integration',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,name:'Actual capture integration'});
  const task=await repo.createTask({scan_run_id:run.id,title:'Learn ordinary business',task_type:'autonomous_agent_task',execution_plan:{intent:'learn_business_flow'}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  process.env.BSTG_BROWSER_MODE='headless';
  const flow=newBusinessFlow({name:'Prepare and apply',goal:'The operation is applied for amount seven',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const observedEndpoints=await Promise.all([
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/a1'}),
    repo.upsertEndpoint({scan_run_id:run.id,method:'POST',path:'/r/a2'}),
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/a3'}),
  ]);
  const observedFeature=await repo.createFeature({scan_run_id:run.id,name:'Apply operation',node_type:'feature',endpoint_ids:observedEndpoints.map(endpoint=>endpoint.id)});
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id,field_names:['ticket','nonce_custom']});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#run'}});assert.equal(action.ok,true);
    const visible=await interactPersistentBrowser({...browser,operation:{action:'assert',selector:'#result',text:'completed'}});
    assert.equal(visible.ok,true);assert.equal(JSON.stringify(visible).includes(target.customNonce),false,'Model-visible rendered aliases must also hide custom sensitive fields');
    assert.equal(target.completed(),1,'Actual browser business request changed the target state');
    await assert.rejects(stopBusinessCapture({...context,taskId:'other-task'},capture.recording_session_id),/current normal-learning task flow/);
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    assert.equal(captured.status,'stopped');assert.equal(captured.events.length,6);
    assert.deepEqual(captured.events[0].target,{origin:target.baseUrl,path:'/:value',query_fields:[]},'Capture exposes a route shape instead of a raw URL');
    assert.deepEqual(captured.events.slice(-2).map(event=>event.target),[captured.events.at(-1).target,captured.events.at(-1).target],'Repeated requests retain the same safe route shape');
    assert.ok(captured.events.every(event=>event.task_id===task.id&&event.identity_key==='anonymous'));
    assert.ok(captured.events.filter(event=>event.workflow_eligible).every(event=>event.event_id),
      'only task-bound replayable events receive model-selectable IDs');
    assert.ok(captured.events.some(event=>!event.action_id&&event.action==='background'),
      'navigation/loading traffic is retained privately but has no business-action attribution');
    // The model selects opaque recorded-event references after seeing action,
    // method, field shapes and order; the test must not rely on the private
    // captured path to construct its replay selection.
    const operationEvents=captured.events.filter(event=>![captured.events[0].event_id,captured.events[2].event_id].includes(event.event_id));
    assert.equal(operationEvents.length,4);
    assert.ok(operationEvents.every(event=>event.workflow_eligible&&event.action_id===action.action_id),'Requests are associated with the action that issued them');
    const privateEvents=(await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_capture_event');
    const issued=privateEvents.find(artifact=>new URL(artifact.content_json.url).pathname==='/r/a1').content_json;
    assert.match(issued.response_body_text,/fresh-ticket-/,'Private recording keeps complete dynamic response values');
    assert.equal(JSON.stringify(captured).includes('fresh-ticket-'),false,'Model inspection redacts dynamic credentials');
    assert.equal(JSON.stringify(captured).includes(target.customNonce),false,'Configured custom field names are redacted recursively');
    const recordEvents=await db.repos.recordingEvents.findAll({where:{session_id:capture.recording_session_id}});
    assert.equal(recordEvents.length,6,'The existing canonical recording subsystem receives every event');

    await assert.rejects(prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:[]}),/explicitly select one or more observed events/,
      'A stopped normal recording cannot silently compile every captured request when the model omitted its selection.');
    assert.equal((await db.repos.workflows.findAll({where:{source_recording_session_id:capture.recording_session_id}})).length,0,
      'Rejected initial selection leaves no published workflow side effect.');

    const selected=operationEvents.map(event=>event.event_id);
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:selected});
    assert.equal(JSON.stringify(prepared).includes(target.customNonce),false,'Learning candidate previews also redact custom secret values');
    assert.equal(JSON.stringify(prepared.steps.map(step=>step.structure)).includes('sha256'),false,
      'Private template values never cross the model boundary as deterministic hashes');
    assert.equal(JSON.stringify(prepared.steps.map(step=>step.structure)).includes('"bytes"'),false,
      'Private template values never cross the model boundary as length metadata');
    assert.equal(prepared.steps.length,4,'Model-selected steps retain both repeated requests in the native workflow');
    const learningArtifact=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_workflow_learning'&&artifact.source_ref===prepared.workflow_id);
    assert.deepEqual(learningArtifact?.content_json.requested_event_ids,selected,'The native learning artifact records the explicit observed-event decision for audit.');
    assert.deepEqual(learningArtifact?.content_json.effective_event_ids,selected,'The anonymous Flow has no executor-added identity prerequisite.');
    assert.equal(learningArtifact?.content_json.selection_origin,'explicit_observed_event_ids');
    const candidates=prepared.learning_candidates.suggestions.mappings;
    const ticketMapping=candidates.find(candidate=>candidate.fromStepOrder===1&&candidate.toStepOrder===2&&candidate.fromPath.includes('ticket'));
    assert.ok(ticketMapping,'Learning uses explicit source-event provenance after event selection and polling removal');
    assert.equal(ticketMapping.required_for_replay,true,
      'A successful observed one-time ticket propagation is retained by native replay without asking the model to repeat a mechanical mapping choice.');
    assert.equal(prepared.steps[0].structure.path,'/:value/:value');assert.equal(prepared.steps[1].structure.path,'/:value/:value');
    assert.equal(JSON.stringify(prepared).includes('/r/a1'),false,'Workflow inspection never exposes captured pathname values');
    assert.ok(prepared.steps[1].assertion_paths.some(path=>path.path==='body.state'&&path.semantic===true),'Workflow inspection projects the same-step, value-free semantic response path');
    assert.equal(prepared.steps[0].assertion_paths.some(path=>path.path==='body.ticket'),false,'Requested secret fields never become model-selectable assertion paths');
    for(const reserved of ['__proto__','__PROTO__','prototype','Constructor']){
      assert.equal(prepared.steps.some(step=>step.assertion_paths.some(path=>path.path===`body.${reserved}`)),false,
        `A captured ${reserved} key must never become a model-selectable prototype path`);
      assert.equal(prepared.steps.some(step=>Object.prototype.hasOwnProperty.call(step.response_summary?.response_shape||{},reserved)),false,
        `A captured ${reserved} key must never enter the model response shape`);
    }
    for(const dynamic of ['123456','-123','550e8400-e29b-41d4-a716-446655440000','{550e8400-e29b-41d4-a716-446655440000}','0123456789abcdef0123456789abcdef','AbC1dE2fG3hI4jK5lM6nO7pQ','opaqueKey_7Qm2Vx9Lr4Np8Ts6Wz1Ha5Kd','YWJjZGVmZ2hpamtsbW5vcA==','alice@internal']){
      assert.equal(captured.events.some(event=>event.assertion_paths.some(path=>path.path===`body.${dynamic}`)),false,
        `Capture inspection must not expose the data-like key ${dynamic} as an assertion path`);
      assert.equal(captured.events.some(event=>Object.prototype.hasOwnProperty.call(event.response_summary?.response_shape||{},dynamic)),false,
        `Capture inspection must not expose the data-like key ${dynamic} in its response shape`);
      assert.equal(prepared.steps.some(step=>step.assertion_paths.some(path=>path.path===`body.${dynamic}`)),false,
        `A captured data-like key ${dynamic} must never become a model-selectable assertion path`);
      assert.equal(prepared.steps.some(step=>Object.prototype.hasOwnProperty.call(step.response_summary?.response_shape||{},dynamic)),false,
        `A captured data-like key ${dynamic} must never enter the model response shape`);
    }
    assert.ok(prepared.steps.some(step=>step.assertion_paths.some(path=>path.path==='body.same')),
      'Ordinary stable business-schema fields remain available for normal semantic assertions');
    assert.ok(prepared.steps.some(step=>step.assertion_paths.some(path=>path.path==='headers.content-security-policy-report-only')),
      'A legitimate long response header remains selectable despite JSON dynamic-key filtering');
    const foreignTask=await repo.createTask({scan_run_id:run.id,title:'Other normal flow',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
    const foreignFlow=newBusinessFlow({name:'Other normal flow',goal:'An unrelated state is observed',role:'anonymous'},foreignTask.id);
    await saveBusinessFlow(repo,run.id,foreignTask.id,foreignFlow);
    await repo.updateTask(foreignTask.id,{execution_plan:{intent:'learn_business_flow',flow_id:foreignFlow.id}});
    const foreignContext={...context,taskId:foreignTask.id};
    await assert.rejects(inspectBusinessCapture(foreignContext,capture.recording_session_id),/current normal-learning task flow/,
      'A task cannot inspect another flow\'s private assertion-path projection');
    await assert.rejects(inspectBusinessWorkflow(foreignContext,prepared.workflow_id),/current normal-learning task flow/,
      'A task cannot inspect or later validate another flow\'s workflow');
    const registry=new AgentToolRegistry();for(const spec of buildBusinessLearningToolSpecs())registry.register(spec);
    const captureInspection=await registry.call('bstg.business.capture.inspect',{recording_session_id:capture.recording_session_id},context);
    assert.equal(captureInspection.ok,true);
    const persistedCapture=(await repo.listToolInvocations(run.id,task.id)).find(invocation=>invocation.tool_name==='bstg.business.capture.inspect');
    const persistedStateEvent=persistedCapture.output_json.events.find(event=>event.assertion_paths?.some(path=>path.path==='body.state'));
    assert.equal(persistedStateEvent.response,'[business value omitted]','Generic audit redaction still removes the complete response object');
    assert.ok(persistedStateEvent.response_summary&&persistedStateEvent.assertion_paths.some(path=>path.path==='body.state'),'The model-facing invocation retains only safe response shape and exact assertion paths');
    assert.ok(persistedStateEvent.observed_coverage_targets.some(target=>target.target_type==='operation'&&target.target_id===observedEndpoints[1].id),
      'the persisted model-safe capture projection retains the server-derived opaque event-to-operation link');
    assert.ok(persistedStateEvent.observed_coverage_targets.every(target=>Object.keys(target).sort().join(',')==='target_id,target_type'),
      'the persisted coverage link contains no route, request, response, or captured value');
    assert.equal(JSON.stringify(persistedCapture.output_json).includes('fresh-ticket-'),false,'Persisted assertion guidance contains no captured values');
    const validateSpec=buildBusinessLearningToolSpecs().find(tool=>tool.name==='bstg.business.workflow.validate');
    assert.equal(validateSpec.input_schema.properties.assertions.items.properties.left.properties.path.pattern,'^(status|body\\.[^\\s]+|headers\\.[^\\s]+)$');
    assert.match(validateSpec.description,/bare body, HTML, and text are invalid/i);
    const runsBeforeRecovery=(await db.repos.testRuns.findAll()).length;
    const invalidAssertion={id:'invalid-root-body',step_order:2,description:'The model selected a whole HTTP body instead of an observed field',purpose:'goal',
      left:{type:'response',path:'body'},op:'contains',right:{type:'literal',value:'completed'}};
    const recovery=await registry.call('bstg.business.workflow.validate',{workflow_id:prepared.workflow_id,assertions:[invalidAssertion]},context);
    assert.equal(recovery.ok,true,'Malformed model assertion returns structured revision feedback instead of terminating normal learning');
    assert.equal(recovery.data.status,'assertion_revision_required');assert.equal(recovery.data.native_execution_started,false);
    assert.ok(recovery.data.rejected_assertions.some(issue=>issue.invalid_path===true));
    assert.ok(recovery.data.workflow_assertion_paths.find(step=>step.step_order===2).assertion_paths.some(path=>path.path==='body.state'));
    assert.equal((await db.repos.testRuns.findAll()).length,runsBeforeRecovery,'Rejected assertion input creates no native Test Run');
    const persistedRecovery=(await repo.listToolInvocations(run.id,task.id)).find(invocation=>invocation.tool_name==='bstg.business.workflow.validate');
    assert.equal(persistedRecovery.status,'completed');assert.equal(persistedRecovery.output_json.native_execution_started,false);
    assert.ok(persistedRecovery.output_json.workflow_assertion_paths.find(step=>step.step_order===2).assertion_paths.some(path=>path.path==='body.state'));
    const afterPrepare=await getBusinessFlow(repo,run.id,flow.id);
    const operationBinding=afterPrepare.coverage_bindings.find(binding=>binding.target_type==='operation'&&binding.target_id===observedEndpoints[1].id);
    const featureBinding=afterPrepare.coverage_bindings.find(binding=>binding.target_type==='feature'&&binding.target_id===observedFeature.id&&binding.endpoint_id===observedEndpoints[1].id);
    assert.ok(operationBinding?.source_event_id&&operationBinding?.action_id,'Recorded endpoint coverage has concrete browser action/event provenance');
    assert.ok(featureBinding,'Feature coverage is derived from its actually observed endpoint, not only the planned flow name');
    const assertion={id:'goal-applied',step_order:2,description:'The target applied the requested operation',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'completed'}};
    await assert.rejects(validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[
      assertion,{...assertion,description:'A duplicate ID must not overwrite the private execution resolver.'},
    ]}),/IDs must be unique/,
      'Each normal validation has unique assertion IDs so a private in-memory baseline cannot be overwritten by another step.');
    await assert.rejects(validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[{...assertion,left:{type:'response',path:'status'},right:{type:'literal',value:'200'}}]}),/HTTP status alone/);
    const semanticVariableFailure=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,mapping_ids:[],assertions:[{
      ...assertion,id:'unbound-variable-is-not-a-normal-proof',description:'A missing workflow variable cannot prove the selected business state',
      right:{type:'workflow_variable',key:'unbound_normal_business_value'},
    }]});
    assert.equal(semanticVariableFailure.verified,false,'A selected workflow-variable assertion is evaluated by the native normal run.');
    assert.equal(semanticVariableFailure.execution.success,true,'A false business assertion is semantic feedback, not a transport or replay failure.');
    assert.equal(semanticVariableFailure.execution.has_execution_error,false);
    assert.equal(semanticVariableFailure.assertions[0].passed,false);
    const semanticVariableRun=await db.repos.testRuns.findById(semanticVariableFailure.test_run_id);
    assert.equal(semanticVariableRun?.status,'completed');
    assert.equal(semanticVariableRun?.progress?.evidence_mode,'normal_business_evidence');
    assert.deepEqual(semanticVariableRun?.execution_params?.requested_mapping_ids,[],
      'The normal Flow keeps model-selected optional mappings empty for its already-proved ticket prerequisite.');
    assert.ok(semanticVariableRun?.execution_params?.required_replay_mapping_ids?.includes(ticketMapping.id),
      'The native run itself carries the private recording-proved ticket mapping.');
    await assert.rejects(startBusinessCapture(context,{flow_id:flow.id}),/already has native workflow\/Test Run evidence/,
      'A normal Flow with native evidence cannot erase its evidence chain by starting a new recording.');
    const capturedBaselineAssertion={...assertion,right:{type:'captured_baseline'}};
    await assert.rejects(validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[{...capturedBaselineAssertion,op:'contains'}]}),/supported comparison/,
      'A private captured baseline is an equality-only same-field comparison, never a general value oracle.');
    const validated=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[capturedBaselineAssertion],mapping_ids:[]});
    assert.equal(validated.verified,true,JSON.stringify(validated));
    const normalEvidenceRun=await db.repos.testRuns.findById(validated.test_run_id);
    assert.equal(normalEvidenceRun?.progress?.evidence_mode,'normal_business_evidence',
      'The normal-flow adapter uses semantic fresh-transaction evidence rather than literal capture replay.');
    assert.equal(normalEvidenceRun?.findings_count_effective,0,
      'A normal business validation cannot create an automatic security finding.');
    const normalSnapshot=await db.repos.workflows.findById(validated.workflow_id);
    assert.equal(normalSnapshot?.baseline_config?.capture_replay_only,true,
      'The immutable normal-validation snapshot remains strict if a generic runner executes it later.');
    assert.equal(normalSnapshot?.baseline_config?.agent_business_normal_validation,true,
      'Only the task-bound validation call may enable semantic fresh-transaction evidence.');
    assert.equal(validated.assertions[0].right.type,'captured_baseline','The model-facing validation result retains the private-baseline marker instead of a literal.');
    assert.equal(JSON.stringify(validated).includes('completed'),false,'The model-facing validation result contains no private captured comparison value.');
    assert.equal(target.completed(),3,'Native workflow actually propagates the new ticket and changes the target');
    assert.notEqual(semanticVariableFailure.workflow_id,validated.workflow_id,'Every execution uses its own immutable workflow snapshot');
    assert.notEqual(semanticVariableFailure.test_run_id,validated.test_run_id);
    const latest=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(latest.status,'verified');assert.equal(latest.normal_run_id,validated.test_run_id);
    assert.equal(latest.assertions[0].right.type,'captured_baseline','The append-only Flow keeps only the safe captured-baseline marker.');
    assert.equal(Object.prototype.hasOwnProperty.call(latest.assertions[0].right,'value'),false,'The Flow artifact never stores the private comparison value.');
    const inspectedValidationSnapshot=await inspectBusinessWorkflow(context,validated.workflow_id);
    const snapshotAssertion=inspectedValidationSnapshot.steps.flatMap(step=>step.assertions).find(item=>item.id==='goal-applied');
    assert.equal(snapshotAssertion,undefined,'A captured baseline is evaluated from the private trace in-process and is never written to a generic Workflow step.');
    const storedSnapshotSteps=await db.repos.workflowSteps.findAll({where:{workflow_id:validated.workflow_id}});
    assert.equal(JSON.stringify(storedSnapshotSteps).includes('completed'),false,'The generic Workflow row contains no captured baseline literal for its broad REST views to disclose.');
    const validatedBinding=latest.coverage_bindings.find(binding=>binding.target_type==='operation'&&binding.target_id===observedEndpoints[1].id);
    assert.equal(validatedBinding?.validated,true,'The target mapping is marked validated only after the fresh native normal run');
    assert.equal(validatedBinding?.normal_run_id,validated.test_run_id);
    assert.deepEqual(validatedBinding?.validation_assertion_ids,['goal-applied'],'Only assertions for the binding source step prove this endpoint');
    for(const binding of latest.coverage_bindings.filter(binding=>binding.source_workflow_id===prepared.workflow_id&&binding.source_step_order!==assertion.step_order)){
      assert.deepEqual(binding.validation_assertion_ids,[],`A step-${binding.source_step_order} binding cannot inherit the step-${assertion.step_order} assertion`);
      assert.equal(binding.validated,false,`A step-${binding.source_step_order} binding needs its own semantic assertion`);
    }
    const findings=await db.repos.findings.findAll();assert.equal(findings.length,0,'Normal success must not create a security finding');
    const artifacts=await repo.listArtifacts(run.id);
    assert.ok(artifacts.some(artifact=>artifact.artifact_type==='business_native_trace'&&artifact.source_ref===validated.test_run_id&&artifact.content_json.trace.records.length===4));
    assert.equal((await inspectBusinessWorkflow(context,prepared.workflow_id)).steps[1].assertions.length,0,'Validation cannot rewrite the prepared source workflow');
    const other=await repo.createRun({base_url:target.baseUrl});
    await assert.rejects(inspectBusinessCapture({...context,scanRunId:other.id},capture.recording_session_id),/not owned/);
    const learningTools=buildBusinessLearningToolSpecs();
    for(const name of ['bstg.business.coverage.inspect','bstg.business.coverage.save','bstg.business.capture.start','bstg.business.capture.stop','bstg.business.capture.inspect','bstg.business.workflow.prepare','bstg.business.workflow.inspect','bstg.business.workflow.repair','bstg.business.workflow.validate']){
      assert.ok(learningTools.some(tool=>tool.name===name),`${name} is registered by the business-learning tool builder`);
    }
    t.diagnostic(`Recorded ${captured.events.length} original HTTP calls; native dynamic replay verified in ${validated.test_run_id}.`);
  }finally{
    await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();
  }
});

test('model-selected current-recording event subset reconstructs a failed normal workflow, preserves observed coverage, and defers an unobserved planned target',{timeout:120000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-workflow-revision',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,name:'Model-selected workflow revision'});
  const task=await repo.createTask({scan_run_id:run.id,title:'Reconstruct failed normal flow',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Prepare, apply, and inspect',goal:'The operation reaches its completed state',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const endpoints=await Promise.all([
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/a1'}),
    repo.upsertEndpoint({scan_run_id:run.id,method:'POST',path:'/r/a2'}),
    repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/a3'}),
  ]);
  const feature=await repo.createFeature({scan_run_id:run.id,name:'Apply operation',node_type:'feature',endpoint_ids:endpoints.map(item=>item.id)});
  // The coverage plan intentionally includes one observed-inventory target that
  // this stopped recording never reaches. A revision must preserve the current
  // observed source coverage without deleting that plan entry; after a verified
  // revised run the normal scheduler owns a fresh capture retry for it.
  const missingEndpoint=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/missing'});
  const plan=await repo.createTask({scan_run_id:run.id,title:'Plan revision coverage',task_type:'plan_business_flows',status:'completed',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const coverageTool=buildBusinessLearningToolSpecs().find(tool=>tool.name==='bstg.business.coverage.save');
  assert.ok(coverageTool);
  const coverageSaved=await coverageTool.handler({entries:[
    // Only the outcome poll is a planned proof in this test. The prerequisites
    // remain observed Flow bindings but are deliberately deferred here, so the
    // retry contract isolates the one inventory target absent from this capture.
    {target_type:'feature',target_id:feature.id,disposition:'deferred',reason:'The regression isolates operation-level retry proof.'},
    {target_type:'operation',target_id:endpoints[0].id,disposition:'deferred',reason:'The regression treats this request as a prerequisite.'},
    {target_type:'operation',target_id:endpoints[1].id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:endpoints[2].id,disposition:'deferred',reason:'The regression treats this request as a poll prerequisite.'},
    {target_type:'operation',target_id:missingEndpoint.id,disposition:'planned',flow_id:flow.id},
  ]},{db,repo,scanRunId:run.id,taskId:plan.id});
  assert.equal(coverageSaved.ok,true,JSON.stringify(coverageSaved));
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id,field_names:['ticket']});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#run'}});assert.equal(action.ok,true);
    const repeated=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#repeat'}});assert.equal(repeated.ok,true);
    const stopped=await stopBusinessCapture(context,capture.recording_session_id);assert.equal(stopped.status,'stopped');
    const captureArtifacts=await repo.listArtifacts(run.id);
    const linkedEvents=captureArtifacts.filter(artifact=>artifact.artifact_type==='business_capture_event').map(raw=>{
      const link=captureArtifacts.find(artifact=>artifact.artifact_type==='business_capture_event_link'&&artifact.content_json.raw_artifact_id===raw.id);
      assert.ok(link,`captured ${new URL(raw.content_json.url).pathname} has a canonical event link`);
      return {path:new URL(raw.content_json.url).pathname,status:raw.content_json.response_status,event_id:link.content_json.recording_event_id,sequence:raw.content_json.sequence};
    }).sort((left,right)=>left.sequence-right.sequence);
    const eventsForPath=path=>linkedEvents.filter(item=>item.path===path);
    const [a1]=eventsForPath('/r/a1'),[status]=eventsForPath('/status'),a2s=eventsForPath('/r/a2'),a3s=eventsForPath('/r/a3');
    assert.equal(a2s.length,2,'the stopped recording preserves the deliberately repeated consumer request');
    assert.equal(a2s[0].status,200);assert.equal(a2s[1].status,409,'the repeated captured consumer is the observed non-idempotent path');
    assert.equal(a3s.length,2);
    assert.ok(a1&&status&&a2s[0]&&a2s[1],'the fixture recorded every prerequisite and both consumer attempts');
    const eventIds={a1:a1.event_id,status:status.event_id,a2:a2s[0].event_id,repeatedA2:a2s[1].event_id,a3:a3s.map(item=>item.event_id)};
    const originalSelection=[eventIds.a1,eventIds.a2,...eventIds.a3,eventIds.repeatedA2];
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:originalSelection});
    const sourceStateStep=prepared.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.state'));
    assert.ok(sourceStateStep,'the captured consumer retains a safe semantic state path');
    const initialFailed=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[{
      id:'initial-state',step_order:sourceStateStep.step_order,description:'The replayed operation reaches completed state',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'completed'},
    }]});
    assert.equal(initialFailed.verified,false);assert.equal(initialFailed.execution.has_execution_error,true);
    assert.ok(initialFailed.execution.execution_failures.some(failure=>failure.status===409&&failure.error_kind==='non_success_response'),
      'A failed native normal run gives the model a value-free failing step/status class for its later revision choice.');
    assert.equal(JSON.stringify(initialFailed.execution.execution_failures).includes('fresh-ticket-'),false,
      'The structured execution failure channel never exposes captured request or response values.');
    const repaired=await repairBusinessWorkflow(context,{workflow_id:initialFailed.workflow_id,test_run_id:initialFailed.test_run_id});
    const repairedInspection=await inspectBusinessWorkflow(context,repaired.workflow_id);
    const repairedStateStep=repairedInspection.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.state'));
    const repairedTicketMappings=repairedInspection.learning_candidates.suggestions.mappings.filter(mapping=>mapping.fromPath.includes('ticket'));
    assert.ok(repairedStateStep,'repair retains a semantic state path for the captured consumers');
    assert.ok(repairedTicketMappings.length,'repair restores the dynamic ticket for both captured consumers');
    const failed=await validateBusinessWorkflow(context,{workflow_id:repaired.workflow_id,mapping_ids:repairedTicketMappings.map(mapping=>mapping.id),assertions:[{
      id:'repaired-state',step_order:repairedStateStep.step_order,description:'The repaired replay reaches completed state before the repeated operation',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'completed'},
    }]});
    assert.equal(failed.verified,false);assert.equal(failed.execution.has_execution_error,true,'the repeated observed consumer still fails after mapping repair');
    assert.ok(failed.execution.execution_failures.some(failure=>failure.status===409&&failure.error_kind==='non_success_response'));
    const failedRun=await db.repos.testRuns.findById(failed.test_run_id);assert.equal(failedRun?.has_execution_error,true);
    const flowBeforeRevision=await getBusinessFlow(repo,run.id,flow.id);
    const coverageBefore=new Set(flowBeforeRevision.coverage_bindings.map(binding=>`${binding.target_type}:${binding.target_id}`));
    const oldSourceSteps=await db.repos.workflowSteps.findAll({where:{workflow_id:prepared.workflow_id}});
    const oldEvidenceIds=[...(flowBeforeRevision.evidence_artifact_ids||[])];
    const foreignSession=await createRecordingSession(db,{name:'Independent unrelated recording',source_tool:'revision-test'});
    await ingestRecordingEventsBatch(db,foreignSession.id,[{sequence:1,source_tool:'revision-test',method:'GET',url:target.baseUrl+'/portal',request_headers:{},response_headers:{},response_status:200}]);
    const [foreignEvent]=await db.repos.recordingEvents.findAll({where:{session_id:foreignSession.id}});
    const revisionInput={workflow_id:failed.workflow_id,test_run_id:failed.test_run_id,rationale:'Keep the successful observed transaction and remove the repeated consumed operation.'};
    await assert.rejects(reviseBusinessWorkflow(context,{...revisionInput,event_ids:[eventIds.a1,eventIds.a1]}),/unique observed events/,
      'duplicate event IDs cannot be used to alter a failed Flow');
    await assert.rejects(reviseBusinessWorkflow(context,{...revisionInput,event_ids:[foreignEvent.id]}),/only observed events from the current recording/,
      'an event from a real second recording is not selectable for the current task Flow');
    await assert.rejects(reviseBusinessWorkflow(context,{...revisionInput,event_ids:[eventIds.a1,...eventIds.a3]}),/would remove .*current observed coverage target/i,
      'the model cannot remove the unique currently observed operation target to make a failing path disappear');

    const selected=[eventIds.a1,eventIds.a2,...eventIds.a3];
    const revised=await reviseBusinessWorkflow(context,{...revisionInput,event_ids:selected});
    assert.equal(revised.status,'revised');assert.notEqual(revised.workflow_id,prepared.workflow_id);assert.notEqual(revised.workflow_id,failed.workflow_id);
    assert.equal(JSON.stringify(revised).includes('fresh-ticket-'),false,'revision output preserves opaque IDs without private request values');
    const afterRevision=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(afterRevision.status,'learning');assert.equal(afterRevision.workflow_id,revised.workflow_id);assert.equal(afterRevision.normal_run_id,undefined);
    assert.equal(afterRevision.assertions_verified,false);assert.equal(afterRevision.baseline_verified,false);
    assert.equal(Object.prototype.hasOwnProperty.call(afterRevision,'object_handle_catalog_id'),false,'a new selected source cannot retain a previous normal-run handle catalog');
    assert.ok(oldEvidenceIds.every(id=>afterRevision.evidence_artifact_ids.includes(id)),'the active Flow retains links to failed native evidence after revision');
    const revisionArtifact=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_workflow_revision'&&artifact.source_ref===revised.workflow_id);
    assert.ok(revisionArtifact);assert.equal(Object.prototype.hasOwnProperty.call(revisionArtifact.content_json,'rationale'),false);
    assert.deepEqual(revisionArtifact.content_json.effective_event_ids,selected);
    const revisedLearning=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_workflow_learning'&&artifact.source_ref===revised.workflow_id);
    assert.ok(revisedLearning,'the revised source retains its own opaque learning receipt');
    assert.equal(revisedLearning.content_json.selection_origin,'explicit_observed_event_ids');
    assert.equal(revisedLearning.content_json.selection_tool_name,'bstg.business.workflow.revise');
    assert.deepEqual(revisedLearning.content_json.requested_event_ids,selected);
    assert.deepEqual(revisedLearning.content_json.auto_included_event_ids,[]);
    assert.deepEqual(revisedLearning.content_json.effective_event_ids,selected);
    const unobservedPlannedKey=`operation:${missingEndpoint.id}`;
    assert.deepEqual(revisionArtifact.content_json.unresolved_planned_coverage_keys,[unobservedPlannedKey],
      'the revision retains, rather than deletes, a separately planned target that this stopped recording never reached');
    assert.deepEqual(revised.unresolved_planned_coverage_keys,[unobservedPlannedKey]);
    assert.equal(JSON.stringify(revisionArtifact.content_json).includes('fresh-ticket-'),false);
    const sourceEventIds=await Promise.all((await db.repos.workflowSteps.findAll({where:{workflow_id:revised.workflow_id}}))
      .sort((left,right)=>left.step_order-right.step_order).map(async step=>{
        const template=await db.repos.apiTemplates.findById(step.api_template_id);
        const draft=await db.repos.workflowDraftSteps.findById(template.advanced_config.source_workflow_draft_step_id);
        return draft.source_event_id;
      }));
    const generatedSelected=[eventIds.a1,eventIds.a2,...eventIds.a3];
    assert.deepEqual(sourceEventIds,generatedSelected,'the new source preserves the model-selected successful consumer and omits only the selected repeated 409 event; static polling is not emitted as a workflow step');
    assert.ok(sourceEventIds.includes(eventIds.a2),'the first successful consumer remains in the revision');
    assert.ok(!sourceEventIds.includes(eventIds.repeatedA2),'the model-selected revision explicitly removes the second observed consumer that generated 409');
    assert.ok((await db.repos.workflowSteps.findAll({where:{workflow_id:prepared.workflow_id}})).every(step=>oldSourceSteps.some(old=>old.id===step.id)),
      'the original published source Workflow remains immutable');
    assert.ok(await db.repos.workflows.findById(failed.workflow_id),'the failed immutable execution snapshot remains available');
    const failureTrace=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_native_trace'&&artifact.source_ref===failed.test_run_id);
    assert.ok(failureTrace?.content_json.trace.records.some(record=>record.response?.status===409),'the old native 409 evidence remains available');
    assert.deepEqual(new Set(afterRevision.coverage_bindings.map(binding=>`${binding.target_type}:${binding.target_id}`)),coverageBefore,
      'excluding a non-target poll preserves every existing coverage target binding');
    const revisedStateStep=revised.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.state'));
    assert.ok(revisedStateStep,'the selected successful consumer retains a safe semantic state path');
    const revisedMapping=revised.learning_candidates.suggestions.mappings.find(mapping=>mapping.toStepOrder===revisedStateStep.step_order&&mapping.fromPath.includes('ticket'));
    assert.ok(revisedMapping,'the new native Workflow re-derives mapping candidates only from selected source events');
    const verified=await validateBusinessWorkflow(context,{workflow_id:revised.workflow_id,mapping_ids:[revisedMapping.id],assertions:[{
      id:'revised-state',step_order:revisedStateStep.step_order,description:'The selected normal transaction reaches completed state',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'completed'},
    }]});
    assert.equal(verified.verified,true,JSON.stringify(verified));
    const finalFlow=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(finalFlow.workflow_id,verified.workflow_id);assert.equal(finalFlow.normal_run_id,verified.test_run_id);
    assert.ok(afterRevision.evidence_artifact_ids.every(id=>finalFlow.evidence_artifact_ids.includes(id)),
      'fresh validation appends evidence instead of severing the revision and failed-run chain');
    const allArtifacts=await repo.listArtifacts(run.id);
    const currentFlows=latestBusinessFlows(allArtifacts);
    // The task was updated after Flow creation; completion and retry scheduling
    // must receive its persisted execution plan, not the deliberately stale
    // creation snapshot whose flow_id is still "pending".
    const currentTask=await repo.getTask(task.id);
    assert.equal(currentTask?.execution_plan?.flow_id,flow.id);
    const gap=await businessCompletionGap(repo,currentTask,currentFlows,allArtifacts,db);
    assert.match(String(gap),new RegExp(missingEndpoint.id),
      'the verified revised Workflow does not erase the separately planned target from the coverage plan');
    const retry=await scheduleBusinessCoverageRetry(repo,currentTask,currentFlows,allArtifacts);
    assert.ok(retry,'the retained but unexercised plan entry creates a fresh task-scoped coverage retry only after revised native validation');
    assert.equal(retry.execution_plan.coverage_retry?.origin_task_id,task.id);
    assert.deepEqual(retry.execution_plan.coverage_retry?.targets.map(target=>target.key),[unobservedPlannedKey]);
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('normal semantic assertions cannot be sourced from a captured non-2xx response',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-capture-non-success-source',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Reject error response as normal proof',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Error response is not normal business',goal:'A successful normal operation is observed',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const errorEndpoint=await repo.upsertEndpoint({scan_run_id:run.id,method:'POST',path:'/r/error',source_type:'browser_network'});
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const semanticAction=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#semanticAction'}});assert.equal(semanticAction.ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#error'}});assert.equal(action.ok,true);
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    const errorEvents=captured.events.filter(event=>event.action_id===action.action_id);
    assert.equal(errorEvents.length,1);assert.equal(errorEvents[0].status,422);
    const inspected=await inspectBusinessCapture(context,capture.recording_session_id);
    const inspectedError=inspected.events.find(event=>event.event_id===errorEvents[0].event_id);
    assert.deepEqual(inspectedError?.observed_coverage_targets,[],
      'A captured non-success response cannot become a coverage target candidate even when its endpoint is known at runtime');
    assert.ok(errorEndpoint.id,'the negative proof check exercises a real endpoint inventory record');
    const semanticEvent=captured.events.find(event=>event.action_id===semanticAction.action_id&&event.semantic_body_path_available===true);
    assert.ok(semanticEvent?.event_id,'the selected normal sequence includes a successful semantic event');
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:[semanticEvent.event_id,errorEvents[0].event_id]});
    assert.equal(prepared.steps.some(step=>step.assertion_paths.some(path=>path.path==='body.error')),false,
      'An observed 4xx error field must never become a selectable normal semantic assertion');
    const runsBefore=(await db.repos.testRuns.findAll()).length;
    await assert.rejects(validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[{
      id:'error-body-is-not-goal',step_order:1,description:'An error body is incorrectly claimed as a goal',purpose:'goal',
      left:{type:'response',path:'body.error'},op:'equals',right:{type:'literal',value:'expected business failure'},
    }]}),/observed executable response path/);
    assert.equal((await db.repos.testRuns.findAll()).length,runsBefore,'A non-success source is rejected before native execution');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('a static JavaScript route hint cannot become normal-flow coverage proof',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-capture-static-route-hint',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Reject static route hint as normal proof',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Static route hint is not normal proof',goal:'A browser-observed normal operation is proven',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const hint=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/parent-target',source_type:'browser_js_reference'});
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#parentTarget'}});assert.equal(action.ok,true);
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    const observed=captured.events.find(event=>event.action_id===action.action_id);
    assert.ok(observed,'the successful browser operation was captured');
    const inspected=await inspectBusinessCapture(context,capture.recording_session_id);
    const inspectedObserved=inspected.events.find(event=>event.event_id===observed.event_id);
    assert.deepEqual(inspectedObserved?.observed_coverage_targets,[],
      'A static route hint is kept for later security modeling but never advertises an executable normal-flow coverage target');
    assert.equal((await repo.listEndpoints(run.id)).find(endpoint=>endpoint.id===hint.id)?.source_type,'browser_js_reference');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('model-visible capture body summaries omit deterministic body hashes',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-capture-opaque-bodies',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const task=await repo.createTask({scan_run_id:run.id,title:'Inspect opaque captured bodies',task_type:'learn_business_flow',execution_plan:{intent:'learn_business_flow',flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Opaque response projection',goal:'A normal response shape is safely visible',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#statusOnly'}})).ok,true);
    const opaque=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#opaque'}});assert.equal(opaque.ok,true);
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    const bodies=captured.events.filter(event=>event.action_id===opaque.action_id).map(event=>event.response.body);
    assert.deepEqual(bodies.map(body=>body.kind).sort(),['binary','text']);
    for(const body of bodies){
      assert.equal(Object.prototype.hasOwnProperty.call(body,'sha256'),false,'Model-visible opaque body summaries must not expose a deterministic digest');
      assert.equal(JSON.stringify(body).includes('123456'),false,'Opaque summary must not expose the captured text body value');
    }
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('failed network capture and interrupted desktop cannot become verified normal workflows',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-capture-negative',{file:':memory:'});await db.connect();await db.migrate();
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl}),task=await repo.createTask({scan_run_id:run.id,title:'Capture failure',task_type:'autonomous_agent_task'});
  const context={db,repo,scanRunId:run.id,taskId:task.id},flow=newBusinessFlow({name:'Failed business',goal:'No invented success',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#statusOnly'}})).ok,true);
    await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#break'}});
    await interactPersistentBrowser({...browser,operation:{action:'assert',selector:'#result',text:'failed'}});
    const broken=await stopBusinessCapture(context,capture.recording_session_id);
    assert.equal(broken.status,'incomplete');assert.ok(broken.events.some(event=>event.complete===false));
    const incompleteEventIds=(await db.repos.recordingEvents.findAll({where:{session_id:capture.recording_session_id}})).map(event=>event.id);
    await assert.rejects(prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:incompleteEventIds}),/complete recording/);
    const again=await startBusinessCapture(context,{flow_id:flow.id});
    await closePersistentBrowserContextsForScan(repo,run.id);
    const interrupted=await inspectBusinessCapture(context,again.recording_session_id);
    assert.equal(interrupted.status,'interrupted');assert.equal((await getBusinessFlow(repo,run.id,flow.id)).status,'blocked');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();await target.close();}
});

test('actual login, profile, cart, purchase and identity state use changing CSRF and session propagation',{timeout:120000},async t=>{
  const target=await createBusinessLearningFixture({mode:'secure'}),db=new SqliteProvider('business-form-integration',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl+'/'}),task=await repo.createTask({scan_run_id:run.id,title:'Observe several normal functions',task_type:'autonomous_agent_task'});
  await db.repos.accounts.create({name:'Prepared attacker',username:target.credentials.attacker.username,status:'active',
    tags:['ai_scan',`scan:${run.id}`,'role:attacker'],fields:{...target.credentials.attacker},variables:{},auth_profile:{}});
  const context={db,repo,scanRunId:run.id,taskId:task.id},flow=newBusinessFlow({name:'Normal workspace operations',goal:'A profile update and purchase are applied for the signed-in user',role:'attacker'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id}});process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'attacker',context_key:capture.context_key};
    const navigate=async path=>assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+path})).ok,true);
    const observations=[];
    const action=async operation=>{const result=await interactPersistentBrowser({...browser,operation});assert.equal(result.ok,true,JSON.stringify(result));observations.push(result);};
    await navigate('/');
    await action({action:'fill',selector:'input[name="username"]',value:target.credentials.attacker.username});
    await action({action:'fill',selector:'input[name="password"]',value:target.credentials.attacker.password});
    const login=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#entry button'}});
    assert.ok(login.ok||login.failure_phase==='action_or_after','A login navigation may invalidate the immediate observation; do not repeat the write');
    await navigate('/');
    await action({action:'assert',selector:'h1',text:'Workspace'});
    await navigate('/r/k11');await action({action:'fill',selector:'input[name="alias"]',value:'Verified display name'});
    await action({action:'click',selector:'#details button'});await action({action:'assert',selector:'#current',text:'Verified display name'});
    await navigate('/r/k21');await action({action:'click',selector:'#basket button'});await action({action:'assert',selector:'#basket-state',text:'1 pack'});
    await action({action:'click',selector:'#review button'});await action({action:'assert',selector:'#confirmation',text:'Confirm purchase'});
    await action({action:'click',selector:'#finish button'});await action({action:'assert',selector:'#confirmation',text:'Purchase recorded'});
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    assert.equal(captured.status,'stopped',JSON.stringify({capture_error_count:captured.capture_error_count,events:captured.events.map(event=>({target:event.target,complete:event.complete,diagnostic:event.diagnostic}))}));
    const finalObserved=captured.events.at(-1);
    const selection=captured.events.filter(event=>event.workflow_eligible&&(event.method==='POST'||event.event_id===finalObserved?.event_id));
    assert.equal(selection.length,5,'only action-bound XHR/fetch operations become native Workflow steps; document navigation remains browser evidence');
    assert.equal(JSON.stringify(captured).includes(target.credentials.attacker.password),false,'Actual password remains private');
    assert.equal(JSON.stringify(captured).includes('Verified display name'),false,'Neutral business values stay private too');
    const rawEvents=(await repo.listArtifacts(run.id)).filter(item=>item.artifact_type==='business_capture_event');
    const csrfValues=rawEvents.flatMap(item=>{
      try{const body=JSON.parse(item.content_json.response_body_text);return body.csrf?[body.csrf]:[];}catch{return [];}
    });
    assert.ok(csrfValues.length>=4);
    for(const value of csrfValues){
      assert.equal(JSON.stringify(captured).includes(value),false,'A differently-named _g field must not expose the actual CSRF value');
      assert.equal(JSON.stringify(observations).includes(value),false,'Visible JSON and hidden field aliases must not expose dynamic CSRF to the model');
    }
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:selection.map(event=>event.event_id)});
    assert.equal(JSON.stringify(prepared).includes('Verified display name'),false,'Workflow inspection exposes field shape rather than neutral business values');
    for(const value of csrfValues)assert.equal(JSON.stringify(prepared).includes(value),false,'Native workflow inspection must redact custom-named sensitive values');
    const promoted=(await repo.listEndpoints(run.id)).filter(endpoint=>endpoint.source_type==='normal_business_capture');
    assert.ok(promoted.some(endpoint=>endpoint.method==='POST'&&endpoint.path==='/r/k24'),
      'only model-selected generated normal Workflow operations are promoted into the later endpoint inventory');
    assert.equal(promoted.some(endpoint=>endpoint.method==='GET'&&endpoint.path==='/r/k40'),false,
      'a selected main-document navigation remains flow context and is never promoted as an operation');
    assert.ok(promoted.every(endpoint=>!endpoint.url?.includes('?')&&endpoint.request_summary?.startsWith('Observed model-selected normal Workflow')&&
      endpoint.response_summary?.startsWith('Observed normal Workflow HTTP')),
      'promotion retains only bounded method/path/status metadata');
    assert.ok((await Promise.all(promoted.map(endpoint=>repo.getCapturedRequest(run.id,endpoint.id)))).every(request=>request===undefined),
      'normal-flow endpoint promotion never creates a reusable raw endpoint_request baseline');
    assert.doesNotMatch(JSON.stringify(promoted),new RegExp(`${target.credentials.attacker.password}|Verified display name`),
      'normal-flow endpoint metadata never copies credentials or business field values');
    const mappings=prepared.learning_candidates.suggestions.mappings;
    assert.ok(mappings.some(item=>item.fromPath.includes('csrf')&&item.toPath.includes('_g')),'Real response CSRF can map to differently-named form input');
    assert.ok(mappings.some(item=>item.fromPath.includes('ticket')),'Purchase ticket dependence is learned from observed values');
    const dynamicMappings=mappings.filter(item=>item.fromPath==='csrf'&&item.toPath==='_g'||item.fromPath==='ticket'&&item.toPath==='ticket');
    const purchaseStep=prepared.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.status'));
    const identityStep=prepared.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.username'));
    const profileStep=prepared.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.alias'));
    assert.ok(purchaseStep&&identityStep&&profileStep,'the observed write responses retain independent state, identity, and goal assertion paths');
    const validated=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,mapping_ids:dynamicMappings.map(item=>item.id),apply_session_jar:true,
      assertions:[{id:'actual-purchase',step_order:purchaseStep.step_order,description:'The final purchase response confirms the recorded state',purpose:'state',left:{type:'response',path:'body.status'},op:'equals',right:{type:'literal',value:'recorded'}},
        {id:'actual-actor',step_order:identityStep.step_order,description:'The authenticated response belongs to the supplied test user',purpose:'identity',left:{type:'response',path:'body.username'},op:'equals',right:{type:'literal',value:target.credentials.attacker.username}},
        {id:'actual-profile',step_order:profileStep.step_order,description:'The profile-update response confirms the display name changed',purpose:'goal',left:{type:'response',path:'body.alias'},op:'equals',right:{type:'literal',value:'Verified display name'}}]});
    if(!validated.verified){
      const artifact=(await repo.listArtifacts(run.id)).find(item=>item.artifact_type==='business_native_trace'&&item.source_ref===validated.test_run_id);
      const trace=artifact?.content_json.trace.records||[];
      const learned=await db.runRawQuery('SELECT name, type, write_policy, is_locked FROM workflow_variables WHERE workflow_id = ?',[validated.workflow_id]);
      const nativeWorkflow=await db.repos.workflows.findById(validated.workflow_id);
      const canonicalCookies=(await db.repos.recordingEvents.findAll({where:{session_id:capture.recording_session_id}})).map(item=>({path:new URL(item.url).pathname,request:Object.keys(item.request_cookies||{}),response:Object.keys(item.response_cookies||{})}));
      t.diagnostic(JSON.stringify({learned,rawLoginHeaderNames:Object.keys(rawEvents.find(item=>new URL(item.content_json.url).pathname==='/r/k01').content_json.response_headers),sessionJar:prepared.learning_candidates.suggestions.sessionJar,nativeConfig:{enabled:nativeWorkflow.enable_session_jar,cookie_mode:nativeWorkflow.session_jar_config?.cookie_mode},canonicalCookies,native:trace.map((item,index)=>({path:new URL(item.url).pathname,status:item.response?.status,error:item.error,
        content_type:item.headers['content-type'],request_fields:[...new URLSearchParams(item.body||'').keys()],
        csrf_matches_previous:(()=>{try{return new URLSearchParams(item.body||'').get('_g')===JSON.parse(trace[index-1]?.response?.body||'{}').csrf;}catch{return false;}})(),
        response_fields:(()=>{try{return Object.keys(JSON.parse(item.response?.body||'{}'));}catch{return [];}})()})),
        mapping_sources:dynamicMappings.map(item=>({from:item.fromStepOrder,to:item.toStepOrder,fromPath:item.fromPath,toPath:item.toPath}))}));
    }
    assert.equal(validated.verified,true,JSON.stringify(validated));
    const state=target.snapshot();assert.equal(state.metrics.normal_orders,2);assert.equal(state.metrics.profile_updates,2);
    assert.ok(state.csrf_values.length>=6,'Observed and replayed requests use fresh rotating CSRF state');
    assert.equal((await db.repos.findings.findAll()).length,0);
    t.diagnostic(`Real browser capture ${captured.events.length} requests; native replay ${selection.length} steps, ${dynamicMappings.length} explicitly selected observed parameter dependencies.`);
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('a strict completion binding survives a failed semantic assertion and revalidates only its current native snapshot',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-objective-completion-revalidation',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl}),task=await repo.createTask({scan_run_id:run.id,title:'Revalidate final semantic outcome',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Complete semantic action',goal:'The final semantic response is observed and replayed',role:'anonymous',
    objective_completion:{required_response_paths:['body.state']}},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});process.env.BSTG_BROWSER_MODE='headless';
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#semanticAction'}});assert.equal(action.ok,true);
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:captured.events.map(event=>event.event_id)});
    const completionStep=prepared.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.state'));
    assert.ok(completionStep);
    const first=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[{
      id:'wrong-final-state',step_order:completionStep.step_order,description:'An intentionally wrong semantic assertion fails native validation',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'not-the-observed-state'},
    }]});
    assert.equal(first.verified,false);
    const failed=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(failed.status,'failed');assert.notEqual(failed.workflow_id,prepared.workflow_id,
      'the first native validation uses an immutable normal snapshot');
    assert.equal(failed.objective_completion_binding?.source_workflow_id,prepared.workflow_id);
    assert.equal(failed.objective_completion_binding?.normal_workflow_id,failed.workflow_id);
    const retryInspection=await inspectBusinessWorkflow(context,failed.workflow_id);
    const retryCompletionStep=retryInspection.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.state'));
    assert.ok(retryCompletionStep);
    const second=await validateBusinessWorkflow(context,{workflow_id:failed.workflow_id,assertions:[{
      id:'observed-final-state',step_order:retryCompletionStep.step_order,description:'The current native snapshot reproduces its captured final state',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'captured_baseline'},
    }]});
    assert.equal(second.verified,true,'a semantic retry may validate the current immutable snapshot without weakening source provenance');
    const verified=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(verified.status,'verified');assert.equal(verified.objective_completion_binding?.validated,true);
    assert.equal(verified.objective_completion_binding?.source_workflow_id,prepared.workflow_id,
      'the final proof retains the original captured source Workflow');
    assert.equal(verified.objective_completion_binding?.normal_workflow_id,second.workflow_id,
      'the final proof advances only its native normal snapshot/run edge');
    const validations=(await repo.listArtifacts(run.id)).filter(artifact=>
      artifact.artifact_type==='business_workflow_validation'&&artifact.content_json?.flow_id===flow.id);
    assert.equal(validations.length,2,'each native validation produces one immutable validation receipt');
    const finalValidation=validations.find(artifact=>artifact.source_ref===second.test_run_id);
    assert.ok(finalValidation,'the revalidation has its matching immutable validation receipt');
    assert.equal(finalValidation.content_json?.workflow_id,second.workflow_id,
      'the receipt names the newly executed normal snapshot');
    assert.equal(finalValidation.content_json?.source_workflow_id,prepared.workflow_id,
      'a retry may execute a later snapshot, but its receipt must retain the captured Workflow that owns the learning evidence');
    assert.equal(finalValidation.content_json?.replay_workflow_id,failed.workflow_id,
      'the receipt separately records the immutable snapshot that was replayed');
    const finalTrace=(await repo.listArtifacts(run.id)).find(artifact=>
      artifact.artifact_type==='business_native_trace'&&artifact.source_ref===second.test_run_id);
    assert.equal(finalTrace?.content_json?.source_workflow_id,prepared.workflow_id,
      'the native trace keeps the same learned-workflow provenance as its validation receipt');
    assert.equal(finalTrace?.content_json?.replay_workflow_id,failed.workflow_id);
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('a strict operation contract cannot claim verified status before its native receipt is sealed',async()=>{
  const db=new SqliteProvider('strict-operation-unsealed-save',{file:':memory:'});await db.connect();await db.migrate();
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:'https://example.test'}),task=await repo.createTask({scan_run_id:run.id,title:'Strict operation seal',task_type:'learn_business_flow'});
  try {
    const flow=newBusinessFlow({name:'Create protected record',goal:'The record is created and observed',role:'anonymous',
      objective_operation:{operation_id:'operation:aaaaaaaaaaaaaaaaaaaaaaaa',method:'POST',route_shape:'/r/create',side_effect_class:'create'}},task.id);
    await saveBusinessFlow(repo,run.id,task.id,flow);
    await assert.rejects(saveBusinessFlow(repo,run.id,task.id,{...flow,status:'verified',workflow_id:'workflow-1',normal_run_id:'run-1',assertions_verified:true,
      assertions:[{id:'state',step_order:1,description:'Created state',purpose:'state',op:'equals',left:{type:'response',path:'body.state'},right:{type:'captured_baseline'},passed:true}],
      objective_operation_binding:{operation_id:'operation:aaaaaaaaaaaaaaaaaaaaaaaa',side_effect_class:'create',source_event_ids:['event-1'],action_ids:['action-1'],
        source_workflow_id:'workflow-source',source_step_orders:[1],normal_workflow_id:'workflow-1',normal_run_id:'run-1',validation_assertion_ids:['state'],validated:false}}),
      /cannot be verified before every declared completion and state-changing operation binding is sealed/i);
  } finally { await db.disconnect(); }
});

test('a strict final-outcome contract requires authoritative order readback and seals native proof',{timeout:120000},async()=>{
  const target=await createBusinessLearningFixture({mode:'secure',postWriteReadbacks:'manual'}),db=new SqliteProvider('business-objective-completion-contract',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl+'/'}),task=await repo.createTask({scan_run_id:run.id,title:'Verify final purchase completion',task_type:'autonomous_agent_task'});
  await db.repos.accounts.create({name:'Prepared attacker',username:target.credentials.attacker.username,status:'active',
    tags:['ai_scan',`scan:${run.id}`,'role:attacker'],fields:{...target.credentials.attacker},variables:{},auth_profile:{}});
  const flow=newBusinessFlow({name:'Final purchase completion',goal:'A normal purchase reaches accepted order state',role:'attacker',objective_id:'objective:bbbbbbbbbbbbbbbbbbbbbbbb',
    objective_completion:{required_response_paths:['body.orders.0.status']},
    objective_operation:{operation_id:'operation:0123456789abcdef01234567',method:'POST',route_shape:'/r/k24',side_effect_class:'transaction'}},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});process.env.BSTG_BROWSER_MODE='headless';
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'attacker',context_key:capture.context_key};
    const navigate=async path=>assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+path})).ok,true);
    const action=async operation=>{const result=await interactPersistentBrowser({...browser,operation});assert.equal(result.ok,true,JSON.stringify({action:operation.action,failure_phase:result.failure_phase,error_code:result.error_code}));return result;};
    await navigate('/');
    await action({action:'fill',selector:'input[name="username"]',value:target.credentials.attacker.username});
    await action({action:'fill',selector:'input[name="password"]',value:target.credentials.attacker.password});
    const login=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#entry button'}});
    assert.ok(login.ok||login.failure_phase==='action_or_after');
    await navigate('/r/k21');await action({action:'click',selector:'#basket button'});await action({action:'assert',selector:'#basket-state',text:'1 pack'});
    await action({action:'click',selector:'#review button'});await action({action:'assert',selector:'#confirmation',text:'Confirm purchase'});
    const registry=new AgentToolRegistry();for(const spec of buildBusinessLearningToolSpecs())registry.register(spec);
    const premature=await registry.call('bstg.business.capture.stop',{recording_session_id:capture.recording_session_id},context);
    assert.equal(premature.ok,false);assert.equal(premature.data?.status,'objective_completion_candidate_required');
    assert.equal(premature.data?.retryable,true);assert.equal(premature.data?.capture_remains_active,true);
    assert.deepEqual(premature.data?.required_response_paths,['body.orders.0.status']);assert.equal(premature.data?.candidate_event_count,0);
    assert.equal(JSON.stringify(premature).includes(target.credentials.attacker.password),false,'completion feedback never includes a credential or captured response');
    await action({action:'click',selector:'#finish button'});await action({action:'assert',selector:'#refresh-account',text:'Read account state'});
    const writeOnly=await registry.call('bstg.business.capture.stop',{recording_session_id:capture.recording_session_id},context);
    assert.equal(writeOnly.ok,false,'a successful state-changing response alone cannot prove the accepted state');
    assert.equal(writeOnly.data?.status,'objective_completion_candidate_required');assert.equal(writeOnly.data?.capture_remains_active,true);
    assert.equal(writeOnly.data?.candidate_event_count,0,'the order write response is not an authoritative readback candidate');
    assert.equal(JSON.stringify(writeOnly).includes(target.credentials.attacker.password),false);
    await action({action:'click',selector:'#refresh-account'});
    await action({action:'assert',selector:'#confirmation',text:'Purchase recorded'});
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    const inspected=await inspectBusinessCapture(context,capture.recording_session_id);
    const completionIds=inspected.objective_completion?.completion_candidate_event_ids||[];
    const operationIds=inspected.objective_operation?.operation_candidate_event_ids||[];
    assert.equal(completionIds.length,1,'only the authoritative order readback satisfies the final-outcome contract');
    assert.equal(operationIds.length,1,'the operation proof identifies the final state-changing purchase request');
    assert.notDeepEqual(operationIds,completionIds,'write evidence and authoritative readback remain distinct events');
    const selected=captured.events;
    assert.ok(selected.some(event=>completionIds.includes(event.event_id)),'the authoritative readback remains available as an opaque selected event');
    const workflowsBefore=(await db.repos.workflows.findAll()).length;
    const omitted=await registry.call('bstg.business.workflow.prepare',{recording_session_id:capture.recording_session_id,
      event_ids:selected.filter(event=>!completionIds.includes(event.event_id)).map(event=>event.event_id)},context);
    assert.equal(omitted.ok,false);assert.equal(omitted.data?.status,'objective_completion_candidate_required');
    assert.deepEqual(omitted.data?.candidate_event_ids,completionIds);assert.equal((await db.repos.workflows.findAll()).length,workflowsBefore,
      'omitting the final completion event must not publish a partial Workflow');
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:selected.map(event=>event.event_id)});
    const completionStep=prepared.steps.find(step=>step.assertion_paths.some(path=>path.path==='body.orders.0.status'));
    const earlierStep=prepared.steps.find(step=>step.step_order!==completionStep?.step_order&&step.assertion_paths.some(path=>path.path==='body.quantity'));
    assert.ok(completionStep&&earlierStep,'the server maps the final completion event and an earlier transaction event to distinct native steps');
    assert.deepEqual(prepared.objective_completion?.required_response_paths,['body.orders.0.status']);
    assert.deepEqual(prepared.objective_completion?.completion_source_step_orders,[completionStep.step_order]);
    const runsBefore=(await db.repos.testRuns.findAll()).length;
    const wrongStep=await registry.call('bstg.business.workflow.validate',{workflow_id:prepared.workflow_id,assertions:[{
      id:'premature-cart-check',step_order:earlierStep.step_order,description:'An earlier cart state cannot prove final purchase completion',purpose:'goal',
      left:{type:'response',path:'body.quantity'},op:'equals',right:{type:'captured_baseline'},
    }]},context);
    assert.equal(wrongStep.ok,true);assert.equal(wrongStep.data?.status,'assertion_revision_required');assert.equal(wrongStep.data?.native_execution_started,false);
    assert.deepEqual(wrongStep.data?.objective_completion_assertion_requirements,[{
      source_step_order:completionStep.step_order,required_response_path:'body.orders.0.status',allowed_assertion_purposes:['goal','state'],
    }],'missing strict final state yields one exact, value-free correction requirement');
    const completionRequirement=wrongStep.data?.objective_completion_assertion_requirements?.[0];
    const operationStepOrder=prepared.objective_operation?.operation_source_step_orders?.[0];
    assert.ok(Number.isInteger(operationStepOrder),'the server identifies the selected write step separately from its readback');
    assert.deepEqual(wrongStep.data?.objective_operation_assertion_requirements,[{
      source_step_order:operationStepOrder,operation_id:'operation:0123456789abcdef01234567',
      required_path_form:'body.<observed-json-field>',allowed_assertion_purposes:['goal','state'],
    }],'revision feedback separately identifies the missing semantic assertion for the state-changing write');
    assert.equal(JSON.stringify(wrongStep.data).includes(target.credentials.attacker.password),false,
      'structured completion correction does not disclose credentials');
    assert.equal(JSON.stringify(wrongStep.data).includes('o_'),false,
      'structured completion correction does not disclose the captured response identifier');
    assert.equal((await db.repos.testRuns.findAll()).length,runsBefore,'a missing final completion assertion starts no native Test Run');
    const mappings=prepared.learning_candidates.suggestions.mappings.filter(item=>
      item.fromPath==='csrf'&&item.toPath==='_g'||item.fromPath==='ticket'&&item.toPath==='ticket');
    const validated=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,mapping_ids:mappings.map(item=>item.id),apply_session_jar:true,assertions:[{
      id:'purchase-operation-recorded',step_order:operationStepOrder,description:'The state-changing purchase operation reports a recorded order',purpose:'state',
      left:{type:'response',path:'body.status'},op:'equals',right:{type:'literal',value:'recorded'},
    },{
      id:'final-order-state-present',step_order:completionRequirement.source_step_order,description:'The authoritative account readback contains the recorded order state',purpose:completionRequirement.allowed_assertion_purposes[0],
      left:{type:'response',path:completionRequirement.required_response_path},op:'equals',right:{type:'literal',value:'recorded'},
    }]});
    assert.equal(validated.verified,true);assert.equal(validated.objective_completion_binding?.validated,true);
    assert.equal(validated.objective_operation_binding?.validated,true,'a selected write event plus its native semantic assertion seals the operation proof');
    assert.equal(validated.objective_operation_binding?.operation_id,'operation:0123456789abcdef01234567');
    assert.equal(validated.objective_completion_binding?.normal_run_id,validated.test_run_id);
    const saved=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(saved.objective_completion_binding?.validated,true);assert.equal(saved.objective_completion_binding?.source_step_orders?.[0],completionStep.step_order);
    assert.equal(saved.objective_operation_binding?.validation_artifact_id && typeof saved.objective_operation_binding.validation_artifact_id,'string',
      'a validated strict operation stores the immutable native validation receipt');
    const state=buildProductAssessmentState(await repo.getProductSnapshot(run.id));
    const productFlow=state.business_functions.flatMap(feature=>feature.normal_flows||[]).find(item=>item.id===flow.id);
    assert.equal(productFlow?.objective_id,flow.objective_id,'product state preserves the opaque strict objective reference');
    assert.equal(productFlow?.objective_operation_receipt?.operation_id,'operation:0123456789abcdef01234567');
    assert.equal(productFlow?.objective_operation_receipt?.validated,true);
    assert.equal(productFlow?.objective_operation_receipt?.validation_artifact_id,saved.objective_operation_binding?.validation_artifact_id);
    const publicFlow=JSON.stringify(productFlow);
    assert.doesNotMatch(publicFlow,/route_shape|\"method\"|response_body|\/r\/k24/,'product receipt excludes method, route, and response evidence');
    assert.equal(target.snapshot().metrics.normal_orders,2,'the final order action executes once in capture and once in native verification');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('real Chromium keeps an HTML-only normal capture active until a semantic XHR is observed, and exposes only replayable event IDs',{timeout:120000},async()=>{
  const target=await fixture(),db=new SqliteProvider('semantic-candidate-capture',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl}),task=await repo.createTask({scan_run_id:run.id,title:'Semantic capture prerequisite',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Observe semantic normal state',goal:'A successful JSON state can support a semantic assertion',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,flow.owner_task_id,{...flow});await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});process.env.BSTG_BROWSER_MODE='headless';
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const registry=new AgentToolRegistry();for(const spec of buildBusinessLearningToolSpecs())registry.register(spec);
    const captureStopTool=registry.list().find(tool=>tool.name==='bstg.business.capture.stop');
    const captureInspectTool=registry.list().find(tool=>tool.name==='bstg.business.capture.inspect');
    const workflowPrepareTool=registry.list().find(tool=>tool.name==='bstg.business.workflow.prepare');
    assert.deepEqual(captureStopTool?.input_schema.properties,{},'the current capture handle is not a model-selected stop argument');
    assert.deepEqual(captureStopTool?.input_schema.required,[]);
    assert.deepEqual(captureInspectTool?.input_schema.properties,{},'the current capture handle is not a model-selected inspection argument');
    assert.deepEqual(captureInspectTool?.input_schema.required,[]);
    assert.equal(Object.hasOwn(workflowPrepareTool?.input_schema.properties||{},'recording_session_id'),false,
      'workflow preparation exposes event selection, not a mutable capture-session handle');
    assert.deepEqual(workflowPrepareTool?.input_schema.required,['event_ids']);
    const staleRecordingReference='stale-recording-reference';
    const inspectedActive=await registry.call('bstg.business.capture.inspect',{recording_session_id:staleRecordingReference},context);
    assert.equal(inspectedActive.ok,true);
    assert.equal(inspectedActive.data?.recording_session_id,capture.recording_session_id,
      'capture inspection resolves the current task/Flow capture instead of trusting a stale caller reference');
    const rejectedStop=await registry.call('bstg.business.capture.stop',{recording_session_id:staleRecordingReference},context);
    assert.equal(rejectedStop.ok,false);assert.equal(rejectedStop.data?.status,'semantic_body_candidate_required');
    assert.equal(rejectedStop.data?.retryable,true);assert.equal(rejectedStop.data?.capture_remains_active,true);
    assert.deepEqual(rejectedStop.data?.candidate_event_ids,[]);
    assert.equal(JSON.stringify(rejectedStop).includes('/portal'),false);
    assert.equal((await inspectBusinessCapture(context,capture.recording_session_id)).status,'recording',
      'HTML-only navigation rejection must preserve the active capture context');

    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#semanticAction'}})).ok,true);
    const stopped=await stopBusinessCapture(context,capture.recording_session_id);assert.equal(stopped.status,'stopped');
    const semantic=stopped.events.find(event=>event.workflow_eligible&&event.semantic_body_path_available===true&&event.action_id);
    const nonreplayable=stopped.events.find(event=>event.workflow_eligible===false&&event.semantic_body_path_available===false);
    assert.ok(semantic?.event_id&&nonreplayable,'inspection retains non-replayable facts while exposing an opaque ID only for a usable semantic Workflow source');
    assert.equal(nonreplayable.event_id,undefined);assert.equal(nonreplayable.action_id,undefined);
    assert.equal((await db.repos.workflows.findAll({where:{source_recording_session_id:capture.recording_session_id}})).length,0,
      'an invalid selected set must not publish a Workflow');
    const prepared=await registry.call('bstg.business.workflow.prepare',{recording_session_id:staleRecordingReference,event_ids:[semantic.event_id]},context);
    assert.equal(prepared.ok,true);
    assert.equal(prepared.data?.recording_session_id,capture.recording_session_id,
      'workflow preparation binds the current task/Flow capture even when a stale reference is supplied');
    assert.ok(prepared.data?.workflow_id,'a selected successful JSON event can publish the normal Workflow');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

async function seedLinkedCapturedJson({db,repo,runId,taskId,sessionId,flowId,sequence,url,actionId,actionIntent,linkActionId=actionId,causalProof=actionId?'trusted_browser_interaction_dispatch':undefined,method='GET',responseBody={state:'ready'},tls}){
  const event={sequence,task_id:taskId,action_id:actionId,action:actionId?'click':'background',identity_key:'anonymous',context_key:'fixture-context',
    ...(causalProof?{causal_proof:causalProof}:{}),...(actionIntent?{action_intent:actionIntent}:{}),
    method,url,resource_type:'fetch',started_at:new Date().toISOString(),completed_at:new Date().toISOString(),
    request_headers:{},response_headers:{'content-type':'application/json'},response_status:200,response_body_text:JSON.stringify(responseBody),...(tls?{tls}:{}),complete:true};
  const raw=await repo.createArtifact({scan_run_id:runId,task_id:taskId,artifact_type:'business_capture_event',source_ref:sessionId,
    title:`Seeded capture ${sequence}`,content_json:{...event,flow_id:flowId,recording_session_id:sessionId,private:true}});
  await ingestRecordingEventsBatch(db,sessionId,[{sequence,source_tool:'bstg.business.capture',method:event.method,url:event.url,
    request_headers:event.request_headers,response_status:event.response_status,response_headers:event.response_headers,response_body_text:event.response_body_text}]);
  const recording=(await db.repos.recordingEvents.findAll({where:{session_id:sessionId,sequence}}))[0];assert.ok(recording);
  await repo.createArtifact({scan_run_id:runId,task_id:taskId,artifact_type:'business_capture_event_link',source_ref:sessionId,title:`Seeded link ${sequence}`,
    content_json:{flow_id:flowId,recording_session_id:sessionId,recording_event_id:recording.id,raw_artifact_id:raw.id,sequence,
      action_id:linkActionId,task_id:taskId,identity_key:'anonymous',complete:true}});
  return recording.id;
}

test('transaction workflow selection retains model-observed replayable prerequisite intents without automatic insertion',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('transaction-prerequisite-selection',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl}),task=await repo.createTask({scan_run_id:run.id,title:'Compile an observed transaction chain',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Observed transaction chain',goal:'A normal transaction reaches its final operation',role:'anonymous',
    objective_operation:{operation_id:'operation:0123456789abcdef01234567',method:'POST',route_shape:'/r/confirm',side_effect_class:'transaction'}},task.id);
  await saveBusinessFlow(repo,run.id,flow.owner_task_id,{...flow});await repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const addEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:task.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:1,url:`${target.baseUrl}/r/add`,actionId:'fixture-add-action',actionIntent:'add',method:'POST',responseBody:{state:'added'}});
    const reviewEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:task.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:2,url:`${target.baseUrl}/r/review`,actionId:'fixture-review-action',actionIntent:'review',method:'POST',responseBody:{state:'reviewed'}});
    const confirmEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:task.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:3,url:`${target.baseUrl}/r/confirm`,actionId:'fixture-confirm-action',actionIntent:'confirm',method:'POST',responseBody:{state:'confirmed'}});
    await stopBusinessCapture(context,capture.recording_session_id);
    const inspected=await inspectBusinessCapture(context,capture.recording_session_id);
    assert.deepEqual(inspected.transaction_prerequisite_event_candidates,[
      {intent:'add',event_ids:[addEventId]},
      {intent:'review',event_ids:[reviewEventId]},
      {intent:'confirm',event_ids:[confirmEventId]},
    ],'inspection exposes only the finite, task-bound replayable choices that the model may use to preserve the observed transaction chain');
    const registry=new AgentToolRegistry();for(const spec of buildBusinessLearningToolSpecs())registry.register(spec);
    const before=(await db.repos.workflows.findAll({where:{source_recording_session_id:capture.recording_session_id}})).length;
    const rejected=await registry.call('bstg.business.workflow.prepare',{event_ids:[confirmEventId]},context);
    assert.equal(rejected.ok,false);assert.equal(rejected.data?.status,'transaction_prerequisite_event_selection_required');
    assert.deepEqual(rejected.data?.missing_prerequisites,[
      {intent:'add',candidate_event_ids:[addEventId]},
      {intent:'review',candidate_event_ids:[reviewEventId]},
    ]);
    assert.equal((await db.repos.workflows.findAll({where:{source_recording_session_id:capture.recording_session_id}})).length,before,
      'the compiler rejects a partial model selection instead of silently adding business steps');
    const prepared=await registry.call('bstg.business.workflow.prepare',{event_ids:[addEventId,reviewEventId,confirmEventId]},context);
    assert.equal(prepared.ok,true);assert.ok(prepared.data?.workflow_id);
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});

test('background or time-window action IDs cannot satisfy normal semantic or coverage-retry candidates',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('action-attribution-candidates',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl});
  const parent=await repo.createTask({scan_run_id:run.id,title:'Coverage parent',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Action-attributed coverage',goal:'A browser action reaches the scheduled state',role:'anonymous'},parent.id);
  await saveBusinessFlow(repo,run.id,parent.id,{...flow,status:'verified',workflow_id:'prior-workflow',normal_run_id:'prior-run',assertions_verified:true,evidence_artifact_ids:['prior-proof']});
  await repo.updateTask(parent.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const endpoint=await repo.upsertEndpoint({scan_run_id:run.id,method:'GET',path:'/r/retry-target',source_type:'normal_business_capture'});
  const retryTarget={key:`operation:${endpoint.id}`,target_type:'operation',target_id:endpoint.id};
  const retry=await repo.createTask({scan_run_id:run.id,parent_task_id:parent.id,title:'Coverage retry',task_type:'learn_business_flow',dependencies:[parent.id],
    execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id,coverage_retry:{origin_task_id:parent.id,attempt:1,targets:[retryTarget]}}});
  await repo.createArtifact({scan_run_id:run.id,task_id:parent.id,artifact_type:'business_coverage_retry_scheduled',source_ref:retry.id,title:'Scheduled retry',
    content_json:{flow_id:flow.id,source_task_id:parent.id,retry_task_id:retry.id,targets:[retryTarget]}});
  const context={db,repo,scanRunId:run.id,taskId:retry.id};
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const backgroundEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:retry.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:1,url:`${target.baseUrl}/r/retry-target`});
    const backgroundInspection=await inspectBusinessCapture(context,capture.recording_session_id);
    const background=backgroundInspection.events.find(event=>event.sequence===1);
    assert.equal(background?.event_id,undefined);assert.equal(background?.workflow_eligible,false);assert.equal(background?.semantic_body_path_available,false);assert.equal(background?.action_id,undefined);
    assert.deepEqual(backgroundInspection.retry_target_event_candidates,[{target_type:'operation',target_id:endpoint.id,event_ids:[]}],
      'an actionless JSON poll is never advertised as an executable coverage candidate');
    await assert.rejects(stopBusinessCapture(context,capture.recording_session_id),error=>error instanceof SemanticBodyCandidateRequiredError,
      'an actionless JSON poll cannot seal a normal capture');

    const timedWindowEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:retry.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:2,url:`${target.baseUrl}/r/retry-target`,actionId:'stale-time-window-action',causalProof:null});
    const timedWindowInspection=await inspectBusinessCapture(context,capture.recording_session_id);
    const timedWindow=timedWindowInspection.events.find(event=>event.sequence===2);
    assert.equal(timedWindow?.event_id,undefined);assert.equal(timedWindow?.workflow_eligible,false);assert.equal(timedWindow?.action_id,undefined,
      'an action ID without recorder-proved interaction dispatch remains background evidence');
    assert.deepEqual(timedWindowInspection.retry_target_event_candidates,[{target_type:'operation',target_id:endpoint.id,event_ids:[]}],
      'a delayed poll that inherited an action ID cannot become coverage evidence');

    const actionEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:retry.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:3,url:`${target.baseUrl}/r/retry-target`,actionId:'fixture-browser-action'});
    const mismatchedEventId=await seedLinkedCapturedJson({db,repo,runId:run.id,taskId:retry.id,sessionId:capture.recording_session_id,flowId:flow.id,
      sequence:4,url:`${target.baseUrl}/r/retry-target`,actionId:'raw-action-must-win',linkActionId:'forged-link-action'});
    const attributedInspection=await inspectBusinessCapture(context,capture.recording_session_id);
    const mismatched=attributedInspection.events.find(event=>event.sequence===4);
    assert.equal(mismatched?.event_id,undefined);assert.equal(mismatched?.workflow_eligible,false);assert.equal(mismatched?.semantic_body_path_available,false,
      'a link whose action ID disagrees with its private raw source is not a semantic candidate');
    assert.deepEqual(attributedInspection.retry_target_event_candidates,[{target_type:'operation',target_id:endpoint.id,event_ids:[actionEventId]}],
      'the same JSON response becomes usable only with concrete browser-action provenance from the linked raw capture');
    await stopBusinessCapture(context,capture.recording_session_id);
    const workflow=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:[actionEventId]});
    assert.ok(workflow.coverage_bindings?.length);
    assert.ok(workflow.coverage_bindings.every(binding=>binding.action_id==='fixture-browser-action'),
      'final coverage bindings retain action provenance instead of binding a background source');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();}
});
