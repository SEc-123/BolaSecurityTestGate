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
import {startBusinessCapture,stopBusinessCapture,inspectBusinessCapture,prepareBusinessWorkflow,inspectBusinessWorkflow,validateBusinessWorkflow,publicBusinessCaptureTarget} from '../../server/src/services/ai-scan/agent-business-capture.ts';
import {navigatePersistentBrowser,interactPersistentBrowser,closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {buildBusinessLearningToolSpecs} from '../../server/src/agent/tools/business-learning-tools.ts';
import {createBusinessLearningFixture} from '../product-experience/business-learning-fixture.mjs';

async function fixture(){
  const tickets=new Set(),events=[],customNonce=`opaque-${randomUUID()}`;let counter=0,completed=0;
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://fixture.invalid'),chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    const raw=Buffer.concat(chunks).toString(),data=raw?JSON.parse(raw):{};
    const send=(status,body)=>{events.push({path:url.pathname,status,data});res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    if(url.pathname==='/portal'){
      res.writeHead(200,{'content-type':'text/html'});
      res.end(`<title>Business integration fixture</title><button id="run">Run normal operation</button><button id="break">Failed operation</button><div id="result"></div>
        <script>document.querySelector('#run').onclick=async()=>{
          const first=await(await fetch('/r/a1')).json();
          await fetch('/status');
          const result=await(await fetch('/r/a2',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ticket:first.ticket,amount:7})})).json();
          await fetch('/r/a3');await fetch('/r/a3');
          document.querySelector('#result').textContent=JSON.stringify({...result,echo_custom:first.custom.nonce_custom});
        };document.querySelector('#break').onclick=()=>fetch('/r/fail').catch(()=>{document.querySelector('#result').textContent='failed';});</script>`);return;
    }
    if(url.pathname==='/r/a1'){const ticket=`fresh-ticket-${++counter}-${randomUUID()}`;tickets.add(ticket);send(200,{ticket,phase:'prepared',custom:{nonce_custom:customNonce}});return;}
    if(url.pathname==='/status'){send(200,{status:'ready'});return;}
    if(url.pathname==='/r/a2'){
      if(!tickets.delete(data.ticket)){send(409,{state:'rejected',applied:false});return;}
      completed++;send(200,{state:'completed',amount:7,applied:true});return;
    }
    if(url.pathname==='/r/a3'){send(200,{same:true});return;}
    if(url.pathname==='/r/fail'){req.socket.destroy();return;}
    res.writeHead(404);res.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {baseUrl:`http://127.0.0.1:${server.address().port}`,events,customNonce,completed:()=>completed,
    close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

test('business capture target exposes a route shape and never an object pathname value',()=>{
  const target=publicBusinessCaptureTarget('https://example.test/orders/customer-123?view=full&ticket=private-ticket');
  assert.deepEqual(target,{origin:'https://example.test',path:'/orders/:value',query_fields:[{name:'view',sensitive:false},{name:'ticket',sensitive:true}]});
  assert.equal(JSON.stringify(target).includes('customer-123'),false);
  assert.equal(JSON.stringify(target).includes('private-ticket'),false);
});

test('complete correlated capture → established recording generator → dynamic native normal validation',{timeout:120000},async t=>{
  const target=await fixture();
  const db=new SqliteProvider('business-capture-integration',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl,name:'Actual capture integration'});
  const task=await repo.createTask({scan_run_id:run.id,title:'Learn ordinary business',task_type:'autonomous_agent_task',execution_plan:{intent:'learn_normal_flow'}});
  const context={db,repo,scanRunId:run.id,taskId:task.id};
  process.env.BSTG_BROWSER_MODE='headless';
  const flow=newBusinessFlow({name:'Prepare and apply',goal:'The operation is applied for amount seven',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id,field_names:['ticket','nonce_custom']});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    const action=await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#run'}});assert.equal(action.ok,true);
    const visible=await interactPersistentBrowser({...browser,operation:{action:'assert',selector:'#result',text:'completed'}});
    assert.equal(visible.ok,true);assert.equal(JSON.stringify(visible).includes(target.customNonce),false,'Model-visible rendered aliases must also hide custom sensitive fields');
    assert.equal(target.completed(),1,'Actual browser business request changed the target state');
    await assert.rejects(stopBusinessCapture({...context,taskId:'other-task'},capture.recording_session_id),/owner/);
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    assert.equal(captured.status,'stopped');assert.equal(captured.events.length,6);
    assert.deepEqual(captured.events[0].target,{origin:target.baseUrl,path:'/:value',query_fields:[]},'Capture exposes a route shape instead of a raw URL');
    assert.deepEqual(captured.events.slice(-2).map(event=>event.target),[captured.events.at(-1).target,captured.events.at(-1).target],'Repeated requests retain the same safe route shape');
    assert.ok(captured.events.every(event=>event.task_id===task.id&&event.identity_key==='anonymous'&&event.action_id&&event.event_id));
    // The model selects opaque recorded-event references after seeing action,
    // method, field shapes and order; the test must not rely on the private
    // captured path to construct its replay selection.
    const operationEvents=captured.events.filter(event=>![captured.events[0].event_id,captured.events[2].event_id].includes(event.event_id));
    assert.equal(operationEvents.length,4);
    assert.ok(operationEvents.every(event=>event.action_id===action.action_id),'Requests are associated with the action that issued them');
    const privateEvents=(await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_capture_event');
    const issued=privateEvents.find(artifact=>new URL(artifact.content_json.url).pathname==='/r/a1').content_json;
    assert.match(issued.response_body_text,/fresh-ticket-/,'Private recording keeps complete dynamic response values');
    assert.equal(JSON.stringify(captured).includes('fresh-ticket-'),false,'Model inspection redacts dynamic credentials');
    assert.equal(JSON.stringify(captured).includes(target.customNonce),false,'Configured custom field names are redacted recursively');
    const recordEvents=await db.repos.recordingEvents.findAll({where:{session_id:capture.recording_session_id}});
    assert.equal(recordEvents.length,6,'The existing canonical recording subsystem receives every event');

    const selected=operationEvents.map(event=>event.event_id);
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id,event_ids:selected});
    assert.equal(JSON.stringify(prepared).includes(target.customNonce),false,'Learning candidate previews also redact custom secret values');
    assert.equal(prepared.steps.length,4,'Model-selected steps retain both repeated requests in the native workflow');
    const candidates=prepared.learning_candidates.suggestions.mappings;
    const ticketMapping=candidates.find(candidate=>candidate.fromStepOrder===1&&candidate.toStepOrder===2&&candidate.fromPath.includes('ticket'));
    assert.ok(ticketMapping,'Learning uses explicit source-event provenance after event selection and polling removal');
    assert.equal(prepared.steps[0].structure.path,'/:value/:value');assert.equal(prepared.steps[1].structure.path,'/:value/:value');
    assert.equal(JSON.stringify(prepared).includes('/r/a1'),false,'Workflow inspection never exposes captured pathname values');
    const assertion={id:'goal-applied',step_order:2,description:'The target applied the requested operation',purpose:'goal',
      left:{type:'response',path:'body.state'},op:'equals',right:{type:'literal',value:'completed'}};
    await assert.rejects(validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[{...assertion,left:{type:'response',path:'status'},right:{type:'literal',value:'200'}}]}),/HTTP status alone/);
    const stale=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[assertion]});
    assert.equal(stale.verified,false,'Reusing the consumed captured ticket must fail normal validation');
    const validated=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,assertions:[assertion],mapping_ids:[ticketMapping.id]});
    assert.equal(validated.verified,true,JSON.stringify(validated));
    assert.equal(target.completed(),2,'Native workflow actually propagates the new ticket and changes the target');
    assert.notEqual(stale.workflow_id,validated.workflow_id,'Every execution uses its own immutable workflow snapshot');
    assert.notEqual(stale.test_run_id,validated.test_run_id);
    const latest=await getBusinessFlow(repo,run.id,flow.id);
    assert.equal(latest.status,'verified');assert.equal(latest.normal_run_id,validated.test_run_id);
    const findings=await db.repos.findings.findAll();assert.equal(findings.length,0,'Normal success must not create a security finding');
    const artifacts=await repo.listArtifacts(run.id);
    assert.ok(artifacts.some(artifact=>artifact.artifact_type==='business_native_trace'&&artifact.source_ref===validated.test_run_id&&artifact.content_json.trace.records.length===4));
    assert.equal((await inspectBusinessWorkflow(context,prepared.workflow_id)).steps[1].assertions.length,0,'Validation cannot rewrite the prepared source workflow');
    const other=await repo.createRun({base_url:target.baseUrl});
    await assert.rejects(inspectBusinessCapture({...context,scanRunId:other.id},capture.recording_session_id),/not owned/);
    const learningTools=buildBusinessLearningToolSpecs();
    for(const name of ['bstg.business.coverage.inspect','bstg.business.coverage.save','bstg.business.capture.start','bstg.business.capture.stop','bstg.business.capture.inspect','bstg.business.workflow.prepare','bstg.business.workflow.inspect','bstg.business.workflow.validate']){
      assert.ok(learningTools.some(tool=>tool.name===name),`${name} is registered by the business-learning tool builder`);
    }
    t.diagnostic(`Recorded ${captured.events.length} original HTTP calls; native dynamic replay verified in ${validated.test_run_id}.`);
  }finally{
    await closePersistentBrowserContextsForScan(repo,run.id);dbManager.getActive=originalDb;await db.disconnect();await target.close();
  }
});

test('failed network capture and interrupted desktop cannot become verified normal workflows',{timeout:60000},async()=>{
  const target=await fixture(),db=new SqliteProvider('business-capture-negative',{file:':memory:'});await db.connect();await db.migrate();
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl}),task=await repo.createTask({scan_run_id:run.id,title:'Capture failure',task_type:'autonomous_agent_task'});
  const context={db,repo,scanRunId:run.id,taskId:task.id},flow=newBusinessFlow({name:'Failed business',goal:'No invented success',role:'anonymous'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);process.env.BSTG_BROWSER_MODE='headless';
  try{
    const capture=await startBusinessCapture(context,{flow_id:flow.id});
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,identity_key:'anonymous',context_key:capture.context_key};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/portal'})).ok,true);
    await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#break'}});
    await interactPersistentBrowser({...browser,operation:{action:'assert',selector:'#result',text:'failed'}});
    const broken=await stopBusinessCapture(context,capture.recording_session_id);
    assert.equal(broken.status,'incomplete');assert.ok(broken.events.some(event=>event.complete===false));
    await assert.rejects(prepareBusinessWorkflow(context,{recording_session_id:capture.recording_session_id}),/complete recording/);
    const again=await startBusinessCapture(context,{flow_id:flow.id});
    await closePersistentBrowserContextsForScan(repo,run.id);
    const interrupted=await inspectBusinessCapture(context,again.recording_session_id);
    assert.equal(interrupted.status,'interrupted');assert.equal((await getBusinessFlow(repo,run.id,flow.id)).status,'blocked');
  }finally{await closePersistentBrowserContextsForScan(repo,run.id);await db.disconnect();await target.close();}
});

test('actual login, profile, cart, purchase and identity state use changing CSRF and session propagation',{timeout:120000},async t=>{
  const target=await createBusinessLearningFixture({mode:'secure'}),db=new SqliteProvider('business-form-integration',{file:':memory:'});await db.connect();await db.migrate();
  const originalDb=dbManager.getActive;dbManager.getActive=()=>db;
  const repo=new AIScanRepository(db),run=await repo.createRun({base_url:target.baseUrl}),task=await repo.createTask({scan_run_id:run.id,title:'Observe several normal functions',task_type:'autonomous_agent_task'});
  const context={db,repo,scanRunId:run.id,taskId:task.id},flow=newBusinessFlow({name:'Normal workspace operations',goal:'A profile update and purchase are applied for the signed-in user',role:'attacker'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);process.env.BSTG_BROWSER_MODE='headless';
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
    await navigate('/r/k40');
    await action({action:'observe'});
    const captured=await stopBusinessCapture(context,capture.recording_session_id);
    assert.equal(captured.status,'stopped',JSON.stringify({capture_error_count:captured.capture_error_count,events:captured.events.map(event=>({target:event.target,complete:event.complete,diagnostic:event.diagnostic}))}));
    const finalObserved=captured.events.at(-1);
    const selection=captured.events.filter(event=>event.method==='POST'||event.event_id===finalObserved?.event_id);
    assert.equal(selection.length,6);
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
    const mappings=prepared.learning_candidates.suggestions.mappings;
    assert.ok(mappings.some(item=>item.fromPath.includes('csrf')&&item.toPath.includes('_g')),'Real response CSRF can map to differently-named form input');
    assert.ok(mappings.some(item=>item.fromPath.includes('ticket')),'Purchase ticket dependence is learned from observed values');
    const dynamicMappings=mappings.filter(item=>item.fromPath==='csrf'&&item.toPath==='_g'||item.fromPath==='ticket'&&item.toPath==='ticket');
    const validated=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,mapping_ids:dynamicMappings.map(item=>item.id),apply_session_jar:true,
      assertions:[{id:'actual-purchase',step_order:6,description:'An order is present in the authoritative account state',purpose:'state',left:{type:'response',path:'body.orders.0.status'},op:'equals',right:{type:'literal',value:'recorded'}},
        {id:'actual-actor',step_order:6,description:'The state belongs to the authenticated test user',purpose:'identity',left:{type:'response',path:'body.username'},op:'equals',right:{type:'literal',value:target.credentials.attacker.username}},
        {id:'actual-profile',step_order:6,description:'The display name actually changed',purpose:'goal',left:{type:'response',path:'body.alias'},op:'equals',right:{type:'literal',value:'Verified display name'}}]});
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
