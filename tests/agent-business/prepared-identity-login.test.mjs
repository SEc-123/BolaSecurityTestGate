/** Real Chromium + SQLite coverage for the normal-stage prepared-login bridge.
 * The test owns the fixture and writes the UI actions; the production Agent
 * only receives the safe capability and never receives its credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {SqliteProvider} from '../../server/src/db/sqlite-provider.ts';
import {dbManager} from '../../server/src/db/db-manager.ts';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {newBusinessFlow,saveBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {inspectBusinessCapture,prepareBusinessWorkflow,validateBusinessWorkflow} from '../../server/src/services/ai-scan/agent-business-capture.ts';
import {closePersistentBrowserContextsForScan,navigatePersistentBrowser,interactPersistentBrowser} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {createAgentToolRegistry} from '../../server/src/agent/index.ts';
import {createBusinessLearningFixture} from '../product-experience/business-learning-fixture.mjs';

async function learningTask(repo, run, title, flowId = 'pending') {
  return repo.createTask({scan_run_id:run.id,title,task_type:'learn_business_flow',
    execution_plan:{intent:'learn_business_flow',flow_id:flowId}});
}

async function attachFlow(repo, run, task, name) {
  const flow=newBusinessFlow({name,goal:'The supplied member can sign in through the observed normal form.',role:'victim',start_state:'signed out'},task.id);
  await saveBusinessFlow(repo,run.id,task.id,flow);
  await repo.updateTask(task.id,{execution_plan:{intent:'learn_business_flow',flow_id:flow.id,identity_key:'victim'}});
  return flow;
}

test('normal learning applies a prepared identity only in a fresh task capture and keeps credentials private',{timeout:120000},async t=>{
  let target,db,repo,run,priorActive,activeProviderReplaced=false;
  const priorBrowserMode=process.env.BSTG_BROWSER_MODE;
  let browserModeReplaced=false;
  let cleanupPromise;
  const cleanup=()=>cleanupPromise??=(async()=>{
    if(repo&&run)await closePersistentBrowserContextsForScan(repo,run.id).catch(()=>undefined);
    if(activeProviderReplaced)dbManager.getActive=priorActive;
    if(browserModeReplaced){
      if(priorBrowserMode===undefined)delete process.env.BSTG_BROWSER_MODE;
      else process.env.BSTG_BROWSER_MODE=priorBrowserMode;
    }
    // Both independent harness resources must be attempted. In particular, a
    // database-close error must not strand the fixture HTTP listener.
    const outcomes=await Promise.allSettled([
      db ? db.disconnect() : Promise.resolve(),
      target ? target.close() : Promise.resolve(),
    ]);
    const failed=outcomes.find(outcome=>outcome.status==='rejected');
    if(failed?.status==='rejected')throw failed.reason;
  })();
  // Register teardown before the first asynchronous setup step. A setup
  // assertion must never strand the real fixture's HTTP listener or Chromium.
  t.after(cleanup);
  let phase='fixture setup';
  try {
    target=await createBusinessLearningFixture({mode:'secure'});
    phase='database setup';
    db=new SqliteProvider('prepared-identity-login',{file:':memory:'});await db.connect();await db.migrate();
    priorActive=dbManager.getActive;dbManager.getActive=()=>db;activeProviderReplaced=true;
    phase='registry setup';
    repo=new AIScanRepository(db);const registry=createAgentToolRegistry();
    phase='run and flow setup';
    run=await repo.createRun({base_url:target.baseUrl+'/',name:'Prepared login bridge',scan_config:{account_mode:'manual',accounts:target.credentials}});
    const boundAccount=await db.repos.accounts.create({name:'Prepared victim',username:target.credentials.victim.username,status:'active',
      tags:['ai_scan',`scan:${run.id}`,'role:victim'],fields:{...target.credentials.victim},variables:{},auth_profile:{}});
    const task=await learningTask(repo,run,'Learn actual sign-in');
    const flow=await attachFlow(repo,run,task,'Sign in to workspace');
    const context={db,repo,scanRunId:run.id,taskId:task.id};
    process.env.BSTG_BROWSER_MODE='headless';browserModeReplaced=true;
    phase='fresh task capture';
    const capture=await registry.call('bstg.business.capture.start',{flow_id:flow.id},context);
    assert.equal(capture.ok,true,JSON.stringify(capture));
    const contextKey=capture.data.context_key;
    assert.match(contextKey,/^task:/,'the login proof begins in a task-isolated browser context');
    assert.equal(capture.data.prepared_identity_login_required,true);
    assert.equal(capture.data.identity_account_bound,true);
    const session=await db.repos.recordingSessions.findById(capture.data.recording_session_id);
    assert.equal(session?.account_id,boundAccount.id,'the Flow role binds to its exact active scan account without exposing its material');

    phase='fresh task navigation';
    const navigation=await registry.call('browser.navigate',{url:target.baseUrl,context_scope:'task',identity_key:'victim',context_key:contextKey},context);
    assert.equal(navigation.ok,true,JSON.stringify(navigation));
    const preLoginRef=navigation.data?.observation?.controls?.[0]?.control_ref;
    assert.equal(typeof preLoginRef,'string','the unauthenticated page publishes only an opaque live control handle');
    phase='prepared login application';
    const applied=await registry.call('bstg.identity.apply_login',{flow_id:flow.id},context);
    assert.equal(applied.ok,true,JSON.stringify(applied));
    assert.equal(applied.data.authenticated,true,JSON.stringify(applied.data));
    assert.equal(applied.data.status,'authenticated');
    assert.equal(applied.data.login_submitted,true);
    assert.equal(typeof applied.data.evidence_artifact_id,'string','the safe login outcome exposes an opaque evidence reference for a later Flow decision');
    const loginEvidence=(await repo.listArtifacts(run.id)).find(artifact=>artifact.id===applied.data.evidence_artifact_id);
    assert.equal(loginEvidence?.artifact_type,'business_identity_login');
    assert.equal(target.snapshot().metrics.logins,1,'the real page received exactly one credential submission');
    const safe=JSON.stringify(applied.data);
    assert.ok(!safe.includes(target.credentials.victim.username),'model-facing tool result omits username');
    assert.ok(!safe.includes(target.credentials.victim.password),'model-facing tool result omits password');
    const stale=await registry.call('browser.interact',{context_scope:'task',identity_key:'victim',context_key:contextKey,
      operation:{action:'click',control_ref:preLoginRef}},context);
    assert.equal(stale.ok,false);assert.equal(stale.data.error_code,'observation_reference_expired');
    assert.equal(stale.data.action_performed,false,'a pre-login handle cannot dispatch in the authenticated document');
    const refreshed=await registry.call('browser.interact',{context_scope:'task',identity_key:'victim',context_key:contextKey,
      operation:{action:'observe'}},context);
    assert.equal(refreshed.ok,true);assert.ok(refreshed.data.observation?.controls?.some(control=>typeof control.control_ref==='string'));

    phase='authenticated normal action';
    const browser={repo,scanRunId:run.id,taskId:task.id,scope_base_url:target.baseUrl,scope_type:'task',identity_key:'victim',context_key:contextKey};
    assert.equal((await navigatePersistentBrowser({...browser,url:target.baseUrl+'/r/k11'})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'fill',selector:'input[name="alias"]',value:'Prepared replay alias'}})).ok,true);
    assert.equal((await interactPersistentBrowser({...browser,operation:{action:'click',selector:'#details button'}})).ok,true);

    phase='fresh task capture stop';
    const stopped=await registry.call('bstg.business.capture.stop',{recording_session_id:capture.data.recording_session_id},context);
    assert.equal(stopped.ok,true,JSON.stringify(stopped));
    assert.equal(stopped.data.status,'stopped');
    const raw=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_capture_event'&&new URL(artifact.content_json.url).pathname==='/r/k01');
    assert.ok(raw,'the login POST is retained in the private capture');
    assert.equal(raw.content_json.action,'identity_apply_login','the real login POST keeps its trusted action attribution');
    const invocation=(await repo.getSnapshot(run.id)).tool_invocations.find(item=>item.tool_name==='bstg.identity.apply_login');
    assert.ok(invocation);
    assert.ok(!JSON.stringify(invocation.output_json).includes(target.credentials.victim.password),'stored model invocation projection omits password');

    phase='native replay from prepared login';
    const inspected=await inspectBusinessCapture(context,capture.data.recording_session_id);
    const eligible=inspected.events.filter(event=>event.workflow_eligible===true&&typeof event.event_id==='string');
    const loginEvent=eligible.find(event=>event.action==='identity_apply_login');
    const selectedEventIds=eligible.filter(event=>event.event_id!==loginEvent?.event_id&&event.semantic_body_path_available===true).map(event=>event.event_id);
    assert.equal(selectedEventIds.length,1,'the model-visible selection contains only the replayable authenticated submit; direct navigation remains capture context');
    assert.ok(loginEvent?.event_id,'the trusted prepared login is retained as a server-owned prerequisite rather than a model-selected business action');
    const prepared=await prepareBusinessWorkflow(context,{recording_session_id:capture.data.recording_session_id,event_ids:selectedEventIds});
    const nativeSteps=await db.repos.workflowSteps.findAll({where:{workflow_id:prepared.workflow_id}});
    const draftSteps=await db.repos.workflowDraftSteps.findAll({where:{session_id:capture.data.recording_session_id}});
    const sourceEventIdForStep=async step=>{
      const template=await db.repos.apiTemplates.findById(step.api_template_id);
      const draft=draftSteps.find(item=>item.id===template?.advanced_config?.source_workflow_draft_step_id);
      return draft?.source_event_id;
    };
    const sourceSteps=new Map((await Promise.all(nativeSteps.map(async step=>[await sourceEventIdForStep(step),step]))).filter(([eventId])=>typeof eventId==='string'));
    const loginStep=sourceSteps.get(loginEvent.event_id);
    const submitStep=sourceSteps.get(selectedEventIds[0]);
    assert.ok(loginStep&&submitStep,'the server auto-includes the prepared login before the model-selected authenticated submit');
    assert.ok(loginStep.step_order<submitStep.step_order,'the native replay preserves the prepared-login prerequisite order');
    const csrfMappings=prepared.learning_candidates.suggestions.mappings.filter(item=>item.fromPath==='csrf'&&item.toPath==='_g');
    assert.ok(csrfMappings.length>0,'the login response supplies a dynamic form-token mapping for the later normal operation');
    const validated=await validateBusinessWorkflow(context,{workflow_id:prepared.workflow_id,mapping_ids:csrfMappings.map(item=>item.id),apply_session_jar:true,
      assertions:[
        {id:'prepared-replay-alias',step_order:submitStep.step_order,description:'The selected authenticated submit preserves the saved profile state',purpose:'goal',left:{type:'response',path:'body.alias'},op:'equals',right:{type:'captured_baseline'}},
        {id:'prepared-replay-owner',step_order:loginStep.step_order,description:'The auto-included login response belongs to the prepared test identity',purpose:'identity',left:{type:'response',path:'body.username'},op:'equals',right:{type:'captured_baseline'}},
      ]});
    assert.equal(validated.verified,true,JSON.stringify(validated));
    const replayWorkflow=await db.repos.workflows.findById(validated.workflow_id);
    assert.equal(replayWorkflow?.session_jar_config?.cookie_mode,true,'the native replay uses the fresh login session jar');
    const traceArtifact=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_native_trace'&&artifact.source_ref===validated.test_run_id);
    const trace=traceArtifact?.content_json?.trace?.records||[];
    const loginIndex=trace.findIndex(record=>Number(record.meta?.step_order)===loginStep.step_order);
    const submitIndex=trace.findIndex(record=>Number(record.meta?.step_order)===submitStep.step_order);
    assert.ok(loginIndex>=0&&submitIndex>loginIndex&&Number(trace[submitIndex]?.response?.status)>=200&&Number(trace[submitIndex]?.response?.status)<300,
      'the prepared login remains before the succeeding model-selected authenticated request');
    assert.ok(target.snapshot().csrf_values.length>=2,'the browser capture and native replay both consumed fresh rotating form tokens');

    phase='shared identity canonicalization';
    const secondTask=await learningTask(repo,run,'Canonicalize shared identity input');
    const secondFlow=await attachFlow(repo,run,secondTask,'Attempt shared-context sign-in');
    const secondContext={db,repo,scanRunId:run.id,taskId:secondTask.id};
    const canonicalized=await registry.call('bstg.business.capture.start',{flow_id:secondFlow.id,scope_type:'identity',context_key:'identity:victim'},secondContext);
    assert.equal(canonicalized.ok,true,JSON.stringify(canonicalized));
    assert.match(canonicalized.data.context_key,/^task:/,'a model-supplied shared identity context is replaced by the task-owned capture context');
    assert.notEqual(canonicalized.data.context_key,'identity:victim');
    assert.equal(canonicalized.data.context_scope,'task');
    const canonicalSession=await db.repos.recordingSessions.findById(canonicalized.data.recording_session_id);
    assert.equal(canonicalSession?.capture_filters?.scope_type,'task');
    assert.equal(canonicalSession?.capture_filters?.context_key,canonicalized.data.context_key);
    assert.equal(canonicalSession?.capture_filters?.prepared_identity_login_required,true);
    assert.equal(target.snapshot().metrics.logins,2,'canonicalizing the capture start adds no login beyond the browser capture and native replay');
    t.diagnostic(`Recorded actual login action in ${capture.data.recording_session_id} without exposing the supplied credential.`);
  } catch(error) {
    if(error instanceof Error)error.message=`Prepared identity login regression failed during ${phase}: ${error.message}`;
    throw error;
  } finally {
    await cleanup();
  }
});
