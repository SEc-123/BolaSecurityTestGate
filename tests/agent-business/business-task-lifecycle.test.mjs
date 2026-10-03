/** Scheduler/contract tests with native in-memory SQLite and explicit inert
 * tool/planner doubles. No target, browser, provider, or network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {database} from '../mobile-closure/fixtures.mjs';
import {SqliteProvider} from '../../server/src/db/sqlite-provider.ts';
import {dbGet,dbRun} from '../../server/src/db/sql-helpers.ts';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {recoverInterruptedScans} from '../../server/src/services/ai-scan/scan-execution.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {blockFailedDependencies} from '../../server/src/agent/dependency-finalization.ts';
import {AgentProviderDecisionUnavailableError,localPolicy} from '../../server/src/agent/autonomous-planner.ts';
import {buildAutonomousAgentContext} from '../../server/src/agent/context-builder.ts';
import {getBusinessFlow,saveBusinessFlow,newBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {interruptBusinessCapturesForTask,startBusinessCapture} from '../../server/src/services/ai-scan/agent-business-capture.ts';
import {closePersistentBrowserContextsForScan,getLiveBrowserContextCount} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import {createRecordingSession} from '../../server/src/services/recording-service.ts';
import {buildBusinessLearningToolSpecs} from '../../server/src/agent/tools/business-learning-tools.ts';
import {BUSINESS_PLAN_INTENT,BUSINESS_LEARNING_INTENT,BUSINESS_REVIEW_INTENT,BUSINESS_EXPERIMENT_INTENT,businessCoverageBindingGap,businessCoverageTargets,scheduleBusinessLearning,scheduleBusinessCoverageRetry,scheduleBusinessExperiments,latestBusinessFlows,businessCompletionGap,businessExperimentCompletionGap,businessPlanningCompletionGap,businessExperimentTerminalDisposition,businessLearningTerminalDisposition,coverageRetryTaskId} from '../../server/src/agent/business-task-lifecycle.ts';
import {RunDecisionBudget} from '../../server/src/agent/decision-budget.ts';

async function fixture(t,config={}){
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'http://127.0.0.1:9/unused-scheduler',scan_config:{surface:'web',...config}});
  return {db,repo,run,runtime:new AIScanAgentRuntime(db)};
}

async function coverageTarget(f,name,path){
  const endpoint=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'POST',path});
  const feature=await f.repo.createFeature({scan_run_id:f.run.id,name,node_type:'feature',endpoint_ids:[endpoint.id]});
  return {feature,endpoint};
}

async function saveCoverage(f,plan,entries){
  const tool=buildBusinessLearningToolSpecs().find(item=>item.name==='bstg.business.coverage.save');
  assert.ok(tool,'coverage save tool is registered');
  return tool.handler({entries},{db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:plan.id});
}

async function terminalNativeRun(f,execution_params,workflow_id){
  return f.db.repos.testRuns.create({name:'Native lifecycle proof fixture',status:'completed',execution_type:'workflow',trigger_type:'ai_scan',
    rule_ids:[],template_ids:[],account_ids:[],progress_percent:100,has_execution_error:false,completed_at:new Date().toISOString(),workflow_id,execution_params});
}

/** Minimal server-written evidence chain used by lifecycle gates. It mirrors
 * the public validation binding and the private trace created by the real
 * normal-workflow validator without putting fixture traffic into these tests. */
async function nativeCoverageProofArtifacts(f,{taskId,flowId,workflowId,runId,bindings}){
  const assertionIds=[...new Set(bindings.flatMap(binding=>binding.validation_assertion_ids||[]))];
  const validation=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:taskId,artifact_type:'business_workflow_validation',source_ref:runId,
    title:'Native coverage validation fixture',content_json:{flow_id:flowId,workflow_id:workflowId,test_run_id:runId,assertions_verified:true,
      assertions:assertionIds.map(id=>({id,passed:true})),coverage_bindings:bindings}});
  const trace=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:taskId,artifact_type:'business_native_trace',source_ref:runId,
    title:'Private native coverage trace fixture',content_json:{flow_id:flowId,workflow_id:workflowId,test_run_id:runId,private:true}});
  return {validation,trace};
}

test('Web bootstrap inserts formal business plan and review stages; normal-only scope ends before candidate work',async t=>{
  for(const [config,enabled,hasModeling] of [[{},true,true],[{business_learning:{mode:'normal_only'}},true,false],[{business_learning:false},false,true],[{surface:'android'},false,true]]){
    const f=await fixture(t,config);await f.runtime.bootstrapRun(f.run);await f.runtime.bootstrapRun(f.run);const tasks=await f.repo.listTasks(f.run.id);
    const planning=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
    const discovery=tasks.find(task=>task.execution_plan.intent==='discover_target'),modeling=tasks.find(task=>task.execution_plan.intent==='model_features_and_candidates');
    assert.equal(Boolean(planning),enabled);assert.equal(Boolean(review),enabled);
    assert.equal(Boolean(modeling),hasModeling);
    if(modeling)assert.deepEqual(modeling.dependencies,[enabled?review.id:discovery.id]);
    assert.equal(tasks.filter(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT).length,enabled?1:0);
  }
});

test('normal-then-model-experiment mode retains candidates without a selection pause and releases verified-flow experiments',async t=>{
  const f=await fixture(t,{business_learning:{mode:'normal_then_model_experiment',normal_objectives:['Update the member profile and observe the saved state']}});
  await f.runtime.bootstrapRun(f.run);
  const bootstrapped=await f.repo.listTasks(f.run.id);
  const modeling=bootstrapped.find(task=>task.execution_plan?.intent==='model_features_and_candidates');
  const review=bootstrapped.find(task=>task.execution_plan?.intent===BUSINESS_REVIEW_INTENT);
  assert.ok(modeling,'the explicit mode still records the optional candidate inventory');
  assert.ok(review,'the business review remains the experiment fan-out point');
  const plan=bootstrapped.find(task=>task.execution_plan?.intent===BUSINESS_PLAN_INTENT);
  assert.equal(plan.execution_plan.strict_normal_objectives,true);
  assert.equal(plan.execution_plan.normal_objectives_required,true);

  const candidateContext={scan:{base_url:'http://unused',scan_config:f.run.scan_config},task:{id:modeling.id,task_type:modeling.task_type,execution_plan:modeling.execution_plan},
    selected_vuln_types:[],vulnerability_candidates:[{id:'candidate'}],task_tool_invocations:[
      {tool_name:'feature.extract_tree',status:'completed'},{tool_name:'vuln.generate_candidates',status:'completed'},{tool_name:'agent.shared_context.prepare',status:'completed'},
    ],feature_tree:[],business_flows:[]};
  const candidateDecision=localPolicy(candidateContext);
  assert.equal(candidateDecision.action,'complete_task');
  assert.doesNotMatch(candidateDecision.summary,/selected generic/i,'the mode never fabricates a generic candidate choice');

  const verified=newBusinessFlow({name:'Profile',goal:'The saved profile belongs to the signed-in user',role:'attacker'},review.id);
  await saveBusinessFlow(f.repo,f.run.id,review.id,{...verified,status:'verified',assertions_verified:true,workflow_id:'native-profile',normal_run_id:'profile-run'});
  const experiments=await scheduleBusinessExperiments(f.repo,review);
  assert.equal(experiments.length,1,'a verified normal flow receives an independent evidence-gated experiment');

  f.runtime.planner.decide=async()=>({action:'wait_for_user_selection',source:'local_policy',summary:'Unexpected generic selection request.'});
  await f.runtime.executeTask(await f.repo.getTask(modeling.id));
  const stored=await f.repo.getTask(modeling.id),run=await f.repo.getRun(f.run.id);
  assert.equal(stored.status,'completed');
  assert.equal(stored.phase,'candidate_selection_deferred_for_business_experiments');
  assert.notEqual(run.status,'awaiting_selection');
  assert.equal((await f.repo.getTask(experiments[0].id)).status,'pending','the candidate lane cannot freeze the already scheduled experiment');
});

test('normal-then-model-experiment mode fails closed when no server-owned normal objective exists',async t=>{
  const f=await fixture(t,{business_learning:{mode:'normal_then_model_experiment'}});
  await f.runtime.bootstrapRun(f.run);
  const plan=(await f.repo.listTasks(f.run.id)).find(task=>task.execution_plan?.intent===BUSINESS_PLAN_INTENT);
  assert.equal(plan.execution_plan.normal_objectives_required,true);
  assert.equal(plan.execution_plan.strict_normal_objectives,false,'an empty manifest must not pretend to be a satisfiable strict plan');
  const saved=await saveCoverage(f,plan,[]);
  assert.equal(saved.ok,true,saved.error);
  const artifacts=await f.repo.listArtifacts(f.run.id);
  await assert.rejects(()=>scheduleBusinessLearning(f.repo,plan),/requires at least one immutable server-owned normal-business objective/);
  assert.match(await businessPlanningCompletionGap(f.repo,plan,latestBusinessFlows(artifacts),artifacts),/requires at least one immutable server-owned normal-business objective/);
  assert.equal((await f.repo.listTasks(f.run.id)).filter(task=>task.execution_plan?.intent===BUSINESS_LEARNING_INTENT).length,0);
});

test('planning schedules each defined business once and review waits for its native learning task',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT);
  const coverage=[];
  for(const [index,[name,goal]] of [['Details','The saved display name is visible'],['Desk purchase','An owned purchase with expected line items exists'],['Notebook','A newly created private note belongs to this member']].entries()){
    const target=await coverageTarget(f,name,`/normal-${index}`);
    const flow=newBusinessFlow({name,goal,role:'attacker',feature_id:target.feature.id},plan.id);
    await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
    coverage.push(
      {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
      {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
    );
  }
  const persisted=await saveCoverage(f,plan,coverage);assert.equal(persisted.ok,true,JSON.stringify(persisted));
  await scheduleBusinessLearning(f.repo,plan);await scheduleBusinessLearning(f.repo,plan);
  const after=await f.repo.listTasks(f.run.id),learn=after.filter(task=>task.execution_plan.intent===BUSINESS_LEARNING_INTENT),review=after.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  assert.equal(learn.length,3);assert.deepEqual(new Set(review.dependencies),new Set([plan.id,...learn.map(task=>task.id)]));
  assert.ok(learn.every(task=>task.execution_plan.parallel_capable===false&&task.dependencies.includes(plan.id)));
});

test('planning coverage keeps executable reads and writes while excluding browser navigation and page-only features',async t=>{
  const f=await fixture(t);
  const navigation=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/workspace',source_type:'browser_navigation'});
  const crawlerPage=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/catalog',source_type:'browser_page'});
  const networkRead=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/api/orders',source_type:'browser_network'});
  const formRead=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/search',source_type:'browser_form'});
  const jsRead=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/api/status',source_type:'browser_js_reference'});
  const formSubmit=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'POST',path:'/workspace',source_type:'browser_navigation'});
  const navigationFeature=await f.repo.createFeature({scan_run_id:f.run.id,name:'Workspace page',node_type:'page',endpoint_ids:[navigation.id]});
  const apiFeature=await f.repo.createFeature({scan_run_id:f.run.id,name:'Orders API',node_type:'feature',endpoint_ids:[networkRead.id]});
  const targets=await businessCoverageTargets(f.repo,f.run.id);
  const keys=new Set(targets.map(target=>target.key));
  assert.equal(keys.has(`operation:${navigation.id}`),false,'document navigation remains model context, not a coverage obligation');
  assert.equal(keys.has(`operation:${crawlerPage.id}`),false,'HTTP-crawled pages remain navigation context');
  assert.equal(keys.has(`feature:${navigationFeature.id}`),false,'a page-only feature cannot force a coverage retry');
  assert.equal(keys.has(`operation:${networkRead.id}`),true,'legacy/browser XHR network GET remains an actionable read');
  assert.equal(keys.has(`operation:${formRead.id}`),true,'a declared GET form remains an operation');
  assert.equal(keys.has(`operation:${jsRead.id}`),false,'a static JS API reference remains a later security-modeling lead until browser execution confirms it');
  assert.equal(keys.has(`operation:${formSubmit.id}`),true,'a non-GET document form submission remains an operation');
  assert.equal(keys.has(`feature:${apiFeature.id}`),true);

  const observedJsRead=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/api/status',source_type:'browser_network'});
  const observedKeys=new Set((await businessCoverageTargets(f.repo,f.run.id)).map(target=>target.key));
  assert.equal(observedJsRead.id,jsRead.id);
  assert.equal(observedJsRead.source_type,'browser_network','a real browser API observation upgrades an earlier static JS reference');
  assert.equal(observedKeys.has(`operation:${jsRead.id}`),true,'the upgraded JS API read becomes a normal-flow planning operation');

  const staticThenDocument=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/static-then-page',source_type:'browser_js_reference'});
  const documentObservation=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/static-then-page',source_type:'browser_navigation'});
  const afterDocumentKeys=new Set((await businessCoverageTargets(f.repo,f.run.id)).map(target=>target.key));
  assert.equal(documentObservation.id,staticThenDocument.id);
  assert.equal(documentObservation.source_type,'browser_navigation','a real document observation still upgrades a static source hint');
  assert.equal(afterDocumentKeys.has(`operation:${staticThenDocument.id}`),false,'a document navigation never becomes a normal-flow coverage target');

  const upgraded=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/same-route',source_type:'browser_navigation'});
  const apiRepresentation=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/same-route',source_type:'browser_network'});
  const navigationAgain=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'GET',path:'/same-route',source_type:'browser_navigation'});
  assert.equal(apiRepresentation.id,upgraded.id);
  assert.equal(apiRepresentation.source_type,'browser_network','an executable network representation upgrades a prior navigation record');
  assert.equal(navigationAgain.source_type,'browser_network','a later navigation cannot downgrade the executable representation');
});

test('every planning-defined normal flow is scheduled once even without an initial coverage association',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const plan=(await f.repo.listTasks(f.run.id)).find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT);
  const target=await coverageTarget(f,'Profile','/profile');
  const mapped=newBusinessFlow({name:'Save profile',goal:'The signed-in member sees the saved profile',role:'attacker',feature_id:target.feature.id},plan.id);
  const independent=newBusinessFlow({name:'Complete purchase',goal:'The signed-in member sees a completed normal purchase',role:'attacker'},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,mapped);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,independent);
  const persisted=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:mapped.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:mapped.id},
  ]);
  assert.equal(persisted.ok,true,JSON.stringify(persisted));
  const coverageArtifact=(await f.repo.listArtifacts(f.run.id)).find(artifact=>artifact.artifact_type==='business_flow_coverage');
  assert.equal(businessCoverageBindingGap(coverageArtifact.content_json,latestBusinessFlows(await f.repo.listArtifacts(f.run.id)),independent.id),undefined,
    'an independently model-defined Flow relies on its own native proof rather than an invented coverage target');
  const first=await scheduleBusinessLearning(f.repo,plan);
  const second=await scheduleBusinessLearning(f.repo,plan);
  assert.deepEqual(new Set(first.map(task=>task.execution_plan.flow_id)),new Set([mapped.id,independent.id]));
  assert.deepEqual(new Set(second.map(task=>task.execution_plan.flow_id)),new Set([mapped.id,independent.id]),
    'historical plan provenance keeps an unassociated Flow schedulable after owner_task_id moves to its learning task');
});

test('selected normal-capture endpoint metadata does not silently stale the current model-owned coverage plan',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const plan=(await f.repo.listTasks(f.run.id)).find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT);
  const target=await coverageTarget(f,'Profile','/profile');
  const flow=newBusinessFlow({name:'Save profile',goal:'The signed-in member sees the saved profile',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);
  assert.equal(saved.ok,true,JSON.stringify(saved));
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessPlanningCompletionGap(f.repo,plan,latestBusinessFlows(artifacts),artifacts),undefined);
  const promoted=await f.repo.upsertEndpoint({scan_run_id:f.run.id,method:'POST',path:'/later-normal-operation',source_type:'normal_business_capture',
    request_summary:'Observed model-selected normal Workflow POST operation',response_summary:'Observed normal Workflow HTTP 200'});
  await f.repo.createFeature({scan_run_id:f.run.id,name:'Later observed business operation',node_type:'feature',endpoint_ids:[promoted.id]});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessPlanningCompletionGap(f.repo,plan,latestBusinessFlows(artifacts),artifacts),undefined,
    'runtime-selected normal evidence feeds later modeling without mutating the already-saved planning manifest');
});

test('planning requires a model-saved current coverage decision for every discovered feature and operation',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const plan=(await f.repo.listTasks(f.run.id)).find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT);
  const profile=await coverageTarget(f,'Profile','/profile');
  const exportTarget=await coverageTarget(f,'Export','/export');
  const flow=newBusinessFlow({name:'Save profile',goal:'The signed-in member sees the saved profile',role:'attacker',feature_id:profile.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessPlanningCompletionGap(f.repo,plan,latestBusinessFlows(artifacts),artifacts),/No model-saved business coverage list/);
  const partial=await saveCoverage(f,plan,[{target_type:'feature',target_id:profile.feature.id,disposition:'planned',flow_id:flow.id}]);
  assert.equal(partial.ok,false);assert.match(partial.error,/omits/);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:profile.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:profile.endpoint.id,disposition:'planned',flow_id:flow.id},
    {target_type:'feature',target_id:exportTarget.feature.id,disposition:'deferred',reason:'The observed export action needs operator-provided account access.'},
    {target_type:'operation',target_id:exportTarget.endpoint.id,disposition:'blocked',reason:'The endpoint returned an explicit prerequisite requirement during discovery.'},
  ]);
  assert.equal(saved.ok,true,JSON.stringify(saved));
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessPlanningCompletionGap(f.repo,plan,latestBusinessFlows(artifacts),artifacts),undefined);
  const scheduled=await scheduleBusinessLearning(f.repo,plan);
  assert.deepEqual(scheduled.map(task=>task.execution_plan.flow_id),[flow.id],'only model-planned coverage creates a learning task');
  const late=await coverageTarget(f,'Late discovered operation','/late');
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessPlanningCompletionGap(f.repo,plan,latestBusinessFlows(artifacts),artifacts),new RegExp(late.endpoint.id));
});

test('a fully deferred coverage inventory is reviewable without inventing a normal flow',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const target=await coverageTarget(f,'Partner export','/partner-export');
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'deferred',reason:'The only observed path requires a partner tenant that is outside this assessment.'},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'blocked',reason:'Discovery recorded an explicit prerequisite instead of a reachable normal operation.'},
  ]);
  assert.equal(saved.ok,true,JSON.stringify(saved));
  const artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),undefined);
  assert.deepEqual(await scheduleBusinessLearning(f.repo,plan),[]);
});

test('planned coverage requires a server-derived browser action → source step → native validation chain',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const target=await coverageTarget(f,'Account profile','/profile');
  const flow=newBusinessFlow({name:'Save profile',goal:'The current account retains its profile change',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const incomplete={...flow,status:'verified',assertions_verified:true,workflow_id:'normal-workflow',normal_run_id:'normal-run',evidence_artifact_ids:['normal-proof'],
    coverage_bindings:[{target_type:'feature',target_id:target.feature.id,endpoint_id:target.endpoint.id,source_event_id:'event-1',
      source_step_order:1,source_workflow_id:'source-workflow',normal_workflow_id:'normal-workflow',normal_run_id:'normal-run',validation_assertion_ids:['profile-state'],validated:true}]};
  await saveBusinessFlow(f.repo,f.run.id,plan.id,incomplete);
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),/no captured browser action and native validated workflow step/);
  const completeBindings=[
    {...incomplete.coverage_bindings[0],action_id:'browser-action-1'},
    {target_type:'operation',target_id:target.endpoint.id,endpoint_id:target.endpoint.id,source_event_id:'event-1',action_id:'browser-action-1',
      source_step_order:1,source_workflow_id:'source-workflow',normal_workflow_id:'normal-workflow',normal_run_id:'normal-run',validation_assertion_ids:['profile-state'],validated:true},
  ];
  await saveBusinessFlow(f.repo,f.run.id,plan.id,{...incomplete,coverage_bindings:completeBindings});
  await nativeCoverageProofArtifacts(f,{taskId:plan.id,flowId:flow.id,workflowId:'normal-workflow',runId:'normal-run',bindings:completeBindings});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),undefined);
});

test('a sealed coverage ledger cannot borrow a native validation for a different target or source edge',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const target=await coverageTarget(f,'Account profile','/profile');
  const flow=newBusinessFlow({name:'Save profile',goal:'The current account retains its profile change',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'deferred',reason:'This ledger fixture isolates the feature provenance edge.'},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const [learning]=await scheduleBusinessLearning(f.repo,plan);
  const binding={target_type:'feature',target_id:target.feature.id,endpoint_id:target.endpoint.id,source_event_id:'profile-event',action_id:'profile-action',
    source_step_order:1,source_workflow_id:'captured-profile-workflow',normal_workflow_id:'normal-profile-workflow',normal_run_id:'normal-profile-run',
    validation_assertion_ids:['profile-state'],validated:true};
  const {validation,trace}=await nativeCoverageProofArtifacts(f,{taskId:learning.id,flowId:flow.id,workflowId:binding.normal_workflow_id,runId:binding.normal_run_id,bindings:[binding]});
  const current=latestBusinessFlows(await f.repo.listArtifacts(f.run.id)).find(item=>item.id===flow.id);
  const proof={...binding,source_event_id:'forged-event',validated_task_id:learning.id,validation_artifact_id:validation.id,trace_artifact_id:trace.id};
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...current,status:'verified',assertions_verified:true,workflow_id:binding.normal_workflow_id,
    normal_run_id:binding.normal_run_id,evidence_artifact_ids:[validation.id,trace.id],coverage_proof_ledger:[proof]});
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),/no captured browser action and native validated workflow step/,
    'a forged source edge cannot borrow the matching workflow/run validation');
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...current,status:'verified',assertions_verified:true,workflow_id:binding.normal_workflow_id,
    normal_run_id:binding.normal_run_id,evidence_artifact_ids:[validation.id,trace.id],coverage_proof_ledger:[{...binding,validated_task_id:learning.id,validation_artifact_id:validation.id,trace_artifact_id:trace.id}]});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),undefined);
});

test('failed normal flows stay uncovered, and blocked flows require their linked native blocker evidence',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const target=await coverageTarget(f,'Account profile','/profile');
  const flow=newBusinessFlow({name:'Save profile',goal:'The current account retains its profile change',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'deferred',reason:'This blocker fixture isolates the feature terminal state.'},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const [learning]=await scheduleBusinessLearning(f.repo,plan);
  const current=latestBusinessFlows(await f.repo.listArtifacts(f.run.id)).find(item=>item.id===flow.id);
  const arbitrary=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:learning.id,artifact_type:'business_workflow_validation',title:'Unrelated failure artifact',content_json:{flow_id:flow.id,assertions_verified:false}});
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...current,status:'failed',blockers:['A normal assertion did not pass.'],evidence_artifact_ids:[arbitrary.id]});
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),/has failed normal validation and remains unproven/);
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...current,status:'blocked',blockers:['The browser capture was interrupted.'],evidence_artifact_ids:[arbitrary.id]});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),/stopped without persisted native blocker evidence/);
  const blocker=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:learning.id,artifact_type:'business_capture_session',title:'Interrupted native capture',
    content_json:{flow_id:flow.id,status:'interrupted'}});
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...current,status:'blocked',blockers:['The browser capture was interrupted.'],evidence_artifact_ids:[blocker.id]});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(await businessCompletionGap(f.repo,review,latestBusinessFlows(artifacts),artifacts),undefined);
});

test('a verified learning task proves only its own planned bindings while review retains the global coverage gate',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const firstTarget=await coverageTarget(f,'Account profile','/profile');
  const secondTarget=await coverageTarget(f,'Notebook','/notes');
  const firstFlow=newBusinessFlow({name:'Save profile',goal:'The member sees the saved profile',role:'attacker',feature_id:firstTarget.feature.id},plan.id);
  const secondFlow=newBusinessFlow({name:'Create note',goal:'The member sees the created private note',role:'attacker',feature_id:secondTarget.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,firstFlow);await saveBusinessFlow(f.repo,f.run.id,plan.id,secondFlow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:firstTarget.feature.id,disposition:'planned',flow_id:firstFlow.id},
    {target_type:'operation',target_id:firstTarget.endpoint.id,disposition:'planned',flow_id:firstFlow.id},
    {target_type:'feature',target_id:secondTarget.feature.id,disposition:'planned',flow_id:secondFlow.id},
    {target_type:'operation',target_id:secondTarget.endpoint.id,disposition:'planned',flow_id:secondFlow.id},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const learning=await scheduleBusinessLearning(f.repo,plan);
  const firstTask=learning.find(task=>task.execution_plan.flow_id===firstFlow.id);
  const verified={...firstFlow,status:'verified',assertions_verified:true,workflow_id:'profile-workflow',normal_run_id:'profile-run',evidence_artifact_ids:['profile-proof'],coverage_bindings:[
    {target_type:'feature',target_id:firstTarget.feature.id,endpoint_id:firstTarget.endpoint.id,source_event_id:'profile-event',action_id:'profile-action',source_step_order:1,source_workflow_id:'profile-source',normal_workflow_id:'profile-workflow',normal_run_id:'profile-run',validation_assertion_ids:['profile-assertion'],validated:true},
    {target_type:'operation',target_id:firstTarget.endpoint.id,endpoint_id:firstTarget.endpoint.id,source_event_id:'profile-event',action_id:'profile-action',source_step_order:1,source_workflow_id:'profile-source',normal_workflow_id:'profile-workflow',normal_run_id:'profile-run',validation_assertion_ids:['profile-assertion'],validated:true},
  ]};
  await saveBusinessFlow(f.repo,f.run.id,firstTask.id,verified);
  await nativeCoverageProofArtifacts(f,{taskId:firstTask.id,flowId:firstFlow.id,workflowId:'profile-workflow',runId:'profile-run',bindings:verified.coverage_bindings});
  const artifacts=await f.repo.listArtifacts(f.run.id),flows=latestBusinessFlows(artifacts);
  assert.equal(await businessCompletionGap(f.repo,firstTask,flows,artifacts),undefined,'the completed profile task must not wait for the unrelated note task');
  assert.match(await businessCompletionGap(f.repo,review,flows,artifacts),/has not reached a verified native normal flow/,'review remains responsible for the unverified sibling binding');
});

test('a verified Flow that missed its assigned operation receives one fresh coverage-retry task with only the unresolved references',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const target=await coverageTarget(f,'Private note','/notes');
  const flow=newBusinessFlow({name:'Create note',goal:'The member sees the new private note',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const [learning]=await scheduleBusinessLearning(f.repo,plan);
  const verifiedElsewhere={...flow,status:'verified',assertions_verified:true,workflow_id:'wrong-workflow',normal_run_id:'wrong-run',evidence_artifact_ids:['prior-proof'],coverage_bindings:[
    {target_type:'operation',target_id:'other-operation',endpoint_id:'other-operation',source_event_id:'other-event',action_id:'other-action',source_step_order:1,source_workflow_id:'wrong-workflow',normal_workflow_id:'wrong-workflow',normal_run_id:'wrong-run',validation_assertion_ids:['other-assertion'],validated:true},
  ]};
  await saveBusinessFlow(f.repo,f.run.id,learning.id,verifiedElsewhere);
  let artifacts=await f.repo.listArtifacts(f.run.id),flows=latestBusinessFlows(artifacts);
  assert.match(await businessCompletionGap(f.repo,learning,flows,artifacts),/no captured browser action/);
  const [retry,concurrentRetry]=await Promise.all([
    scheduleBusinessCoverageRetry(f.repo,learning,flows,artifacts),
    scheduleBusinessCoverageRetry(f.repo,learning,flows,artifacts),
  ]);
  assert.ok(retry,'missing planned coverage must produce a bounded retry task');
  assert.equal(concurrentRetry?.id,retry.id,'concurrent terminal reconciliation shares one retry creation');
  assert.equal((await f.repo.listTasks(f.run.id)).filter(task=>task.execution_plan?.coverage_retry?.origin_task_id===learning.id).length,1,
    'one parent Flow cannot create competing retry children');
  assert.equal(retry.parent_task_id,learning.id);assert.equal(retry.execution_plan.intent,BUSINESS_LEARNING_INTENT);
  assert.equal(retry.execution_plan.flow_id,flow.id);assert.equal(retry.execution_plan.coverage_retry.attempt,1);
  assert.deepEqual(retry.execution_plan.coverage_retry.targets.map(item=>item.key).sort(),[
    `feature:${target.feature.id}`,`operation:${target.endpoint.id}`,
  ].sort());
  assert.ok((await f.repo.getTask(review.id)).dependencies.includes(retry.id),'review must wait for the fresh retry evidence');
  artifacts=await f.repo.listArtifacts(f.run.id);flows=latestBusinessFlows(artifacts);
  assert.equal((await scheduleBusinessCoverageRetry(f.repo,learning,flows,artifacts)).id,retry.id,'retry scheduling is idempotent and cannot recurse indefinitely');
});

test('an evidence-less retry completion cannot manufacture a fresh capture recovery',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:1}});await f.runtime.bootstrapRun(f.run);
  const plan=await f.repo.createTask({scan_run_id:f.run.id,title:'Business plan',task_type:'plan_business_flows',status:'completed',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const target=await coverageTarget(f,'Private note','/notes');
  const retry=await f.repo.createTask({scan_run_id:f.run.id,parent_task_id:plan.id,title:'Retry missing note target',task_type:'learn_business_flow',execution_plan:{
    intent:BUSINESS_LEARNING_INTENT,flow_id:'pending',coverage_retry:{origin_task_id:plan.id,attempt:1,targets:[{
      key:`operation:${target.endpoint.id}`,target_type:'operation',target_id:target.endpoint.id,target_name:'POST /notes',
    }]},
  }});
  const flow=newBusinessFlow({name:'Create note',goal:'The member sees the saved private note',role:'anonymous',feature_id:target.feature.id},retry.id);
  await saveBusinessFlow(f.repo,f.run.id,retry.id,{...flow,status:'verified',assertions_verified:true,workflow_id:'wrong-workflow',normal_run_id:'wrong-run',evidence_artifact_ids:['prior-proof']});
  await f.repo.updateTask(retry.id,{execution_plan:{...retry.execution_plan,flow_id:flow.id}});
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));

  const localContext={scan:{base_url:'http://unused',scan_config:{}},task:{phase:'coverage_retry_completion_gap_requires_fresh_capture',task_type:'learn_business_flow',execution_plan:{
    intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id,coverage_retry:{attempt:1,targets:[{key:`operation:${target.endpoint.id}`,target_type:'operation',target_id:target.endpoint.id}],completion_recovery:{attempt:1,status:'capture_required'},
  }}},selected_vuln_types:[],task_tool_invocations:[],feature_tree:[],business_flows:[{...flow,status:'verified',assertions_verified:true,normal_run_id:'wrong-run'}]};
  const forced=localPolicy(localContext);
  assert.equal(forced.tool_name,'bstg.business.capture.start');assert.deepEqual(forced.arguments,{flow_id:flow.id,identity_key:'anonymous'});

  const registry=new AgentToolRegistry();let captures=0;
  registry.register({name:'bstg.business.capture.start',description:'Inert fresh native capture fixture.',input_schema:{},handler:async args=>{
    captures++;assert.deepEqual(args,{flow_id:flow.id,identity_key:'anonymous'});
    return {ok:true,data:{recording_session_id:'fresh-retry-capture'},summary:'Fresh task capture started'};
  }});f.runtime.registry=registry;
  const contexts=[];f.runtime.planner.decide=async context=>{
    contexts.push(context);
    return {action:'complete_task',source:'local_policy',summary:'The Flow looks verified.'};
  };
  await f.runtime.executeTask(await f.repo.getTask(retry.id));
  const stored=await f.repo.getTask(retry.id);
  assert.equal(captures,0,'a generic completion proposal cannot invent a recovery capture without a fresh verified native validation');
  assert.equal(contexts.length,1,'the bounded evidence-less completion is not allowed to spend a second turn starting capture recovery');
  assert.equal(stored.status,'failed');assert.equal(stored.phase,'coverage_retry_target_not_reached_before_budget_exhaustion');
  assert.equal(stored.execution_plan.coverage_retry.completion_recovery,undefined);
});

test('a successful retry validation reconciles coverage immediately without a provider completion turn',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const plan=await f.repo.createTask({scan_run_id:f.run.id,title:'Business plan',task_type:'plan_business_flows',status:'completed',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const target=await coverageTarget(f,'Saved note','/saved-note');
  const retry=await f.repo.createTask({scan_run_id:f.run.id,parent_task_id:plan.id,title:'Retry saved note',task_type:'learn_business_flow',execution_plan:{
    intent:BUSINESS_LEARNING_INTENT,flow_id:'pending',coverage_retry:{origin_task_id:plan.id,attempt:1,targets:[{
      key:`operation:${target.endpoint.id}`,target_type:'operation',target_id:target.endpoint.id,
    }]},
  }});
  const flow=newBusinessFlow({name:'Save note',goal:'The saved note is visible',role:'anonymous',feature_id:target.feature.id},retry.id);
  await saveBusinessFlow(f.repo,f.run.id,retry.id,flow);
  await f.repo.updateTask(retry.id,{execution_plan:{...retry.execution_plan,flow_id:flow.id}});
  const coverage=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'deferred',reason:'This fixture verifies the independently scheduled operation only.'},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(coverage.ok,true,JSON.stringify(coverage));

  const registry=new AgentToolRegistry();let captures=0,validations=0,plannerTurns=0;
  registry.register({name:'bstg.business.capture.start',description:'Fresh retry capture fixture.',input_schema:{},handler:async()=>{
    captures+=1;return {ok:true,data:{recording_session_id:'fresh-retry-capture'},summary:'Fresh retry capture started'};
  }});
  registry.register({name:'bstg.business.workflow.validate',description:'Native validation fixture.',input_schema:{},handler:async()=>{
    validations+=1;const current=await getBusinessFlow(f.repo,f.run.id,flow.id);
    assert.ok(current);
    if(validations===1){
      const firstRun=await terminalNativeRun(f,{scan_run_id:f.run.id,ai_scan_task_id:retry.id,flow_id:flow.id,business_normal_run:true},'first-workflow');
      const firstProof=await nativeCoverageProofArtifacts(f,{taskId:retry.id,flowId:flow.id,workflowId:'first-workflow',runId:firstRun.id,bindings:[]});
      await saveBusinessFlow(f.repo,f.run.id,retry.id,{...current,status:'verified',assertions_verified:true,
        workflow_id:'first-workflow',normal_run_id:firstRun.id,evidence_artifact_ids:[firstProof.validation.id,firstProof.trace.id]});
      return {ok:true,data:{verified:true,workflow_id:'first-workflow',test_run_id:firstRun.id}};
    }
    const bindings=[{target_type:'operation',target_id:target.endpoint.id,endpoint_id:target.endpoint.id,
      source_event_id:'retry-event',action_id:'retry-action',source_step_order:1,source_workflow_id:'second-workflow',
      normal_workflow_id:'second-workflow',normal_run_id:'second-native-run',validation_assertion_ids:['retry-state'],validated:true}];
    const secondRun=await terminalNativeRun(f,{scan_run_id:f.run.id,ai_scan_task_id:retry.id,flow_id:flow.id,business_normal_run:true},'second-workflow');
    const validatedBindings=bindings.map(binding=>({...binding,normal_run_id:secondRun.id}));
    const proof=await nativeCoverageProofArtifacts(f,{taskId:retry.id,flowId:flow.id,workflowId:'second-workflow',runId:secondRun.id,bindings:validatedBindings});
    await saveBusinessFlow(f.repo,f.run.id,retry.id,{...current,status:'verified',assertions_verified:true,
      workflow_id:'second-workflow',normal_run_id:secondRun.id,evidence_artifact_ids:[proof.validation.id],coverage_proof_ledger:[{
        ...validatedBindings[0],validation_artifact_id:proof.validation.id,trace_artifact_id:proof.trace.id,validated_task_id:retry.id,
      }]});
    return {ok:true,data:{verified:true,workflow_id:'second-workflow',test_run_id:secondRun.id}};
  }});
  f.runtime.registry=registry;
  f.runtime.planner.decide=async()=>{
    plannerTurns+=1;
    return {action:'tool_call',tool_name:'bstg.business.workflow.validate',arguments:{},source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(retry.id));

  const stored=await f.repo.getTask(retry.id);
  assert.equal(validations,2);
  assert.equal(captures,1,'the first verified validation creates the bounded fresh capture immediately');
  assert.equal(plannerTurns,2,'neither verified validation needs a provider complete_task decision');
  assert.equal(stored?.status,'completed');
  assert.equal(stored?.phase,'completed');
});

test('the same normal Workflow has a bounded assertion-revision loop before any native run exists',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:5}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Bound assertion revision',task_type:'learn_business_flow',execution_plan:{
    intent:BUSINESS_LEARNING_INTENT,flow_id:'pending',
  }});
  const flow=newBusinessFlow({name:'Bound assertion revision',goal:'A valid semantic result is observed',role:'anonymous'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,workflow_id:'revision-workflow'});
  await f.repo.updateTask(task.id,{execution_plan:{...task.execution_plan,flow_id:flow.id}});
  const registry=new AgentToolRegistry();let revisions=0;
  registry.register({name:'bstg.business.workflow.validate',description:'Structured rejected assertion fixture.',input_schema:{},handler:async()=>{
    revisions+=1;
    return {ok:true,data:{workflow_id:'revision-workflow',status:'assertion_revision_required',native_execution_started:false,
      objective_completion_assertion_requirements:[{source_step_order:2,required_response_path:'body.order_id',allowed_assertion_purposes:['goal','state']}]},
      summary:'No native Test Run was created.'};
  }});
  f.runtime.registry=registry;
  const seenPhases=[];
  f.runtime.planner.decide=async context=>{seenPhases.push(context.task.phase);return {action:'tool_call',tool_name:'bstg.business.workflow.validate',arguments:{workflow_id:'revision-workflow'},source:'ai_provider'};};

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const stored=await f.repo.getTask(task.id);
  assert.equal(revisions,3,'the runtime permits bounded model-led correction attempts before terminalizing the same rejected Workflow');
  assert.ok(seenPhases.includes('normal_objective_completion_assertion_requires_inspection'),
    'a value-free strict final-outcome requirement moves the task into its dedicated inspect-before-retry phase');
  assert.equal(stored?.status,'failed');assert.equal(stored?.phase,'normal_assertion_revision_limit_exceeded');
  assert.equal((await f.repo.listArtifacts(f.run.id)).filter(artifact=>artifact.artifact_type==='business_assertion_revision_limit'&&artifact.task_id===task.id).length,1);
  assert.equal((await f.db.repos.testRuns.findAll()).length,0,'structurally rejected assertions never manufacture a native run');
});

test('coverage retry recovers an external primary-key race and repairs its scheduler audit record',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
  const target=await coverageTarget(f,'Private note','/notes');
  const flow=newBusinessFlow({name:'Create note',goal:'The member sees the new private note',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const [learning]=await scheduleBusinessLearning(f.repo,plan);
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...flow,status:'verified',assertions_verified:true,workflow_id:'wrong-workflow',normal_run_id:'wrong-run',coverage_bindings:[
    {target_type:'operation',target_id:'other-operation',endpoint_id:'other-operation',source_event_id:'other-event',action_id:'other-action',source_step_order:1,source_workflow_id:'wrong-workflow',normal_workflow_id:'wrong-workflow',normal_run_id:'wrong-run',validation_assertion_ids:['other-assertion'],validated:true},
  ]});
  let artifacts=await f.repo.listArtifacts(f.run.id),flows=latestBusinessFlows(artifacts);
  const originalCreateTask=f.repo.createTask.bind(f.repo);let injected=false,stableId='';
  f.repo.createTask=async input=>{
    if(!injected&&input.id){
      injected=true;stableId=input.id;
      await originalCreateTask(input);
      throw new Error('UNIQUE constraint failed: ai_scan_tasks.id');
    }
    return originalCreateTask(input);
  };
  const retry=await scheduleBusinessCoverageRetry(f.repo,learning,flows,artifacts);
  assert.ok(retry);assert.equal(injected,true);assert.equal(retry.id,stableId);
  assert.match(retry.id,/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal((await f.repo.listTasks(f.run.id)).filter(task=>task.execution_plan?.coverage_retry?.origin_task_id===learning.id).length,1);
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(artifacts.filter(artifact=>artifact.artifact_type==='business_coverage_retry_scheduled'&&artifact.source_ref===retry.id).length,1);
  assert.ok((await f.repo.getTask(review.id)).dependencies.includes(retry.id));
  flows=latestBusinessFlows(artifacts);
  await scheduleBusinessCoverageRetry(f.repo,learning,flows,artifacts);
  assert.equal((await f.repo.listArtifacts(f.run.id)).filter(artifact=>artifact.artifact_type==='business_coverage_retry_scheduled'&&artifact.source_ref===retry.id).length,1,
    'a recovery retry remains idempotent after the original scheduler crashed before its audit write');
});

test('coverage retry rejects a stable-ID collision that is not its exact persisted child',async t=>{
  const f=await fixture(t);await f.runtime.bootstrapRun(f.run);
  const tasks=await f.repo.listTasks(f.run.id),plan=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT);
  const target=await coverageTarget(f,'Private note','/notes');
  const flow=newBusinessFlow({name:'Create note',goal:'The member sees the new private note',role:'attacker',feature_id:target.feature.id},plan.id);
  await saveBusinessFlow(f.repo,f.run.id,plan.id,flow);
  const saved=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(saved.ok,true,JSON.stringify(saved));
  const [learning]=await scheduleBusinessLearning(f.repo,plan);
  await saveBusinessFlow(f.repo,f.run.id,learning.id,{...flow,status:'verified',assertions_verified:true,workflow_id:'wrong-workflow',normal_run_id:'wrong-run',coverage_bindings:[
    {target_type:'operation',target_id:'other-operation',endpoint_id:'other-operation',source_event_id:'other-event',action_id:'other-action',source_step_order:1,source_workflow_id:'wrong-workflow',normal_workflow_id:'wrong-workflow',normal_run_id:'wrong-run',validation_assertion_ids:['other-assertion'],validated:true},
  ]});
  const collisionId=coverageRetryTaskId(f.run.id,learning.id);
  await f.repo.createTask({id:collisionId,scan_run_id:f.run.id,title:'Unrelated task',task_type:'autonomous_agent_task',execution_plan:{intent:'unrelated'}});
  const artifacts=await f.repo.listArtifacts(f.run.id),flows=latestBusinessFlows(artifacts);
  await assert.rejects(()=>scheduleBusinessCoverageRetry(f.repo,learning,flows,artifacts),/unique|constraint|duplicate/i);
  assert.equal((await f.repo.listTasks(f.run.id)).filter(task=>task.execution_plan?.coverage_retry?.origin_task_id===learning.id).length,0,
    'an unrelated task must never be treated as a server-authorized retry child');
});

test('review remains runnable after normal validation failure without releasing its dependent stage',async t=>{
  const f=await fixture(t);
  const failed=await f.repo.createTask({scan_run_id:f.run.id,title:'Normal flow',task_type:'learn_business_flow',status:'failed',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const review=await f.repo.createTask({scan_run_id:f.run.id,title:'Review',task_type:'review_business_flows',dependencies:[failed.id],execution_plan:{intent:BUSINESS_REVIEW_INTENT}});
  const dependent=await f.repo.createTask({scan_run_id:f.run.id,title:'Later stage',task_type:'autonomous_agent_task',dependencies:[review.id]});
  await blockFailedDependencies(f.repo,f.run.id);const ready=await f.repo.findRunnablePendingTasks(f.run.id,10);
  assert.deepEqual(ready.map(task=>task.id),[review.id]);assert.equal((await f.repo.getTask(dependent.id)).status,'pending');
});

test('review releases a native-verified flow to its own model experiment without making a blocked flow a global gate',async t=>{
  const f=await fixture(t);
  const review=await f.repo.createTask({scan_run_id:f.run.id,title:'Review normal flows',task_type:'review_business_flows',execution_plan:{intent:BUSINESS_REVIEW_INTENT}});
  const model=await f.repo.createTask({scan_run_id:f.run.id,title:'Later modeling',task_type:'autonomous_agent_task',dependencies:[review.id]});
  const verified=newBusinessFlow({name:'Profile','goal':'The saved profile belongs to the signed-in user',role:'attacker'},review.id);
  const blocked=newBusinessFlow({name:'Refund','goal':'A refund reaches its final state',role:'attacker'},review.id);
  await saveBusinessFlow(f.repo,f.run.id,review.id,{...verified,status:'verified',assertions_verified:true,workflow_id:'native-profile',normal_run_id:'profile-run',evidence_artifact_ids:['profile-proof']});
  await saveBusinessFlow(f.repo,f.run.id,review.id,{...blocked,status:'blocked',blockers:['The payment fixture rejected the prerequisite'],evidence_artifact_ids:[]});
  const experiments=await scheduleBusinessExperiments(f.repo,review);
  assert.equal(experiments.length,1);assert.equal(experiments[0].execution_plan.intent,BUSINESS_EXPERIMENT_INTENT);assert.equal(experiments[0].execution_plan.flow_id,verified.id);
  assert.deepEqual(experiments[0].dependencies,[review.id]);
  await f.repo.updateTask(review.id,{status:'completed',completed_at:new Date().toISOString()});
  const ready=await f.repo.findRunnablePendingTasks(f.run.id,10);
  assert.ok(ready.some(task=>task.id===model.id),'general modeling is released once review records the blocker');
  assert.ok(ready.some(task=>task.id===experiments[0].id),'verified flow experiment runs independently');
  assert.ok(!experiments.some(task=>task.execution_plan.flow_id===blocked.id));
});

test('model experiment completion requires same-plan native control/experiment runs and an assessment, but not a vulnerability verdict',async t=>{
  const f=await fixture(t);
  const normalWorkflow=await f.db.repos.workflows.create({name:'Verified normal snapshot',is_active:true,workflow_type:'baseline',template_mode:'snapshot'});
  const controlWorkflow=await f.db.repos.workflows.create({name:'Current control mutation',is_active:true,workflow_type:'mutation',base_workflow_id:normalWorkflow.id,
    mutation_profile:{model_directed:true,plan_id:'plan-a',plan_revision:2}});
  const experimentWorkflow=await f.db.repos.workflows.create({name:'Current experiment mutation',is_active:true,workflow_type:'mutation',base_workflow_id:normalWorkflow.id,
    mutation_profile:{model_directed:true,plan_id:'plan-a',plan_revision:2}});
  const foreignWorkflow=await f.db.repos.workflows.create({name:'Foreign mutation',is_active:true,workflow_type:'mutation',base_workflow_id:normalWorkflow.id,
    mutation_profile:{model_directed:true,plan_id:'plan-a',plan_revision:2}});
  const normal=await terminalNativeRun(f,{scan_run_id:f.run.id,flow_id:'flow-a',business_normal_run:true},normalWorkflow.id);
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Profile experiment',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow-a',normal_run_id:normal.id}});
  await f.repo.createArtifact({scan_run_id:f.run.id,artifact_type:'business_workflow_validation',source_ref:normal.id,title:'Normal validation',content_json:{flow_id:'flow-a',test_run_id:normal.id,workflow_id:normalWorkflow.id,assertions_verified:true}});
  await f.repo.createArtifact({scan_run_id:f.run.id,artifact_type:'business_native_trace',source_ref:normal.id,title:'Normal trace',content_json:{flow_id:'flow-a',test_run_id:normal.id,workflow_id:normalWorkflow.id,private:true}});
  const compilation=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_compilation',source_ref:'plan-a',title:'Compilation',content_json:{plan_id:'plan-a',plan_revision:2,flow_id:'flow-a',source_workflow_id:normalWorkflow.id,control_workflow_id:controlWorkflow.id,experiment_workflow_id:experimentWorkflow.id,private:true}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'plan-a',title:'Plan',content_json:{id:'plan-a',flow_id:'flow-a',revision:2,status:'compiled',evidence_artifact_ids:[compilation.id]}});
  const control=await terminalNativeRun(f,{scan_run_id:f.run.id,ai_scan_task_id:task.id,plan_id:'plan-a',plan_revision:2,model_directed:true,kind:'control'},controlWorkflow.id);
  const experiment=await terminalNativeRun(f,{scan_run_id:f.run.id,ai_scan_task_id:task.id,plan_id:'plan-a',plan_revision:2,model_directed:true,kind:'experiment'},experimentWorkflow.id);
  const [controlTrace,experimentTrace]=await Promise.all([
    f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_native_trace',source_ref:control.id,title:'Control trace',content_json:{plan_id:'plan-a',plan_revision:2,kind:'control',test_run_id:control.id,private:true}}),
    f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_native_trace',source_ref:experiment.id,title:'Experiment trace',content_json:{plan_id:'plan-a',plan_revision:2,kind:'experiment',test_run_id:experiment.id,private:true}}),
  ]);
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_result',source_ref:'plan-a',title:'Result',content_json:{plan_id:'plan-a',plan_revision:2,revision:1,status:'executed',native_test_run_ids:[control.id,experiment.id],control_test_run_id:control.id,experiment_test_run_id:experiment.id,execution_verified:false,counterexample_verified:true,evidence_ready:false,evidence_artifact_ids:[controlTrace.id,experimentTrace.id]}});
  let artifacts=await f.repo.listArtifacts(f.run.id);assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/not inspected and assessed/);
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_assessment',source_ref:'plan-a',title:'Counterexample assessment',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:1,verdict:'not_vulnerable',native_evidence_gate:{verdict:'counterexample',counterexample_verified:true,evidence_artifact_ids:[controlTrace.id,experimentTrace.id]}}});
  await f.db.repos.testRuns.update(control.id,{execution_params:{...control.execution_params,scan_run_id:'foreign-assessment'}});
  artifacts=await f.repo.listArtifacts(f.run.id);assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/control Test Run.*not owned/,'artifact IDs cannot substitute for a same-scan native Test Run');
  await f.db.repos.testRuns.update(control.id,{execution_params:control.execution_params});
  await f.db.repos.testRuns.update(control.id,{workflow_id:foreignWorkflow.id});
  artifacts=await f.repo.listArtifacts(f.run.id);assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/Test Runs do not reference.*current normal, control, and experiment Workflows/,'matching Test Run parameters cannot substitute for the compiler-owned control Workflow');
  await f.db.repos.testRuns.update(control.id,{workflow_id:controlWorkflow.id});
  artifacts=await f.repo.listArtifacts(f.run.id);assert.equal(await businessExperimentCompletionGap(task,artifacts,f.db),undefined,'a securely refuted hypothesis is a completed evidence loop');
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'plan-a',title:'Revised plan',content_json:{id:'plan-a',flow_id:'flow-a',revision:3,status:'compiled'}});
  artifacts=await f.repo.listArtifacts(f.run.id);assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/no completed native control-and-experiment result/,'a stale result cannot complete a revised plan');
});

test('an insufficient experiment assessment cannot complete until it is replaced by a fresh child-plan loop',async t=>{
  const f=await fixture(t);
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Revision-required experiment',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow-a'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'plan-a',title:'Insufficient plan',content_json:{id:'plan-a',flow_id:'flow-a',revision:2,status:'compiled'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_result',source_ref:'plan-a',title:'Insufficient result',content_json:{plan_id:'plan-a',plan_revision:2,flow_id:'flow-a',revision:1,status:'executed'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_assessment',source_ref:'plan-a',title:'Inconclusive assessment',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:1,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}}});
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/parent_plan_id plan-a/,'a model completion claim cannot close an evidence-insufficient assessment');
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'plan-a',title:'Incorrect same-plan revision',content_json:{id:'plan-a',flow_id:'flow-a',revision:3,status:'planned'}});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/parent_plan_id plan-a/,'reusing the old plan id does not close the required revision lineage');
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'plan-b',title:'Child correction plan',content_json:{id:'plan-b',parent_plan_id:'plan-a',flow_id:'flow-a',revision:1,status:'planned'}});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/has not been compiled/,'a valid child plan enters a fresh compile/execute/inspect/assess loop');

  const terminal=await f.repo.createTask({scan_run_id:f.run.id,title:'Blocked experiment',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow-b'}});
  const blocker=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:terminal.id,artifact_type:'business_experiment_blocker',source_ref:'blocked-plan',title:'Native prerequisite blocker',content_json:{reason:'The prepared identity is missing a required tenant entitlement.'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:terminal.id,artifact_type:'agent_experiment_plan',source_ref:'blocked-plan',title:'Blocked plan',content_json:{id:'blocked-plan',flow_id:'flow-b',revision:1,status:'blocked',blocked_reason:'The prepared identity is missing a required tenant entitlement.',evidence_artifact_ids:[blocker.id]}});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(businessExperimentTerminalDisposition(terminal,artifacts)?.kind,'blocked');
  assert.match(await businessExperimentCompletionGap(terminal,artifacts,f.db),/explicitly blocked with persisted evidence/,'a valid block remains human-visible instead of completing the experiment');
});

test('unsupported negative labels, failed experiments, and evidence-free blocks cannot complete a business experiment',async t=>{
  const f=await fixture(t);
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Negative-proof gate',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow-a'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'plan-a',title:'Plan',content_json:{id:'plan-a',flow_id:'flow-a',revision:2,status:'compiled'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_result',source_ref:'plan-a',title:'Result',content_json:{plan_id:'plan-a',plan_revision:2,revision:1,status:'executed',counterexample_verified:false}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_assessment',source_ref:'plan-a',title:'Unsupported negative label',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:1,verdict:'not_vulnerable',native_evidence_gate:{verdict:'counterexample',counterexample_verified:true,evidence_artifact_ids:['invented-proof']}}});
  let artifacts=await f.repo.listArtifacts(f.run.id);
  assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/parent_plan_id plan-a/,'not_vulnerable without a verified persisted counterexample must create a child revision');

  const failed=await f.repo.createTask({scan_run_id:f.run.id,title:'Failed experiment',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow-b'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:failed.id,artifact_type:'agent_experiment_plan',source_ref:'failed-plan',title:'Failed plan',content_json:{id:'failed-plan',flow_id:'flow-b',revision:1,status:'failed',reason:'The native compiler rejected the unavailable source snapshot.'}});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(businessExperimentTerminalDisposition(failed,artifacts)?.kind,'failed');
  assert.match(await businessExperimentCompletionGap(failed,artifacts,f.db),/failed.*cannot be completed/i);

  const unprovenBlock=await f.repo.createTask({scan_run_id:f.run.id,title:'Unproven block',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow-c'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:unprovenBlock.id,artifact_type:'agent_experiment_plan',source_ref:'unproven-block',title:'Unproven blocked plan',content_json:{id:'unproven-block',flow_id:'flow-c',revision:1,status:'blocked',blocked_reason:'The model says the target is unavailable.'}});
  artifacts=await f.repo.listArtifacts(f.run.id);
  assert.equal(businessExperimentTerminalDisposition(unprovenBlock,artifacts)?.kind,'failed');
  assert.match(await businessExperimentCompletionGap(unprovenBlock,artifacts,f.db),/without both a concrete persisted reason and linked evidence/);
});

test('runtime turns an evidenced business-experiment block into a human-visible blocked task',async t=>{
  const f=await fixture(t,{agent_task_budgets:{model_business_experiment:3}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Blocked native experiment',task_type:'model_business_experiment',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow'}});
  const proof=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'business_experiment_blocker',source_ref:'blocked-plan',title:'Captured prerequisite denial',content_json:{reason:'The prepared test account lacks a tenant entitlement.'}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_plan',source_ref:'blocked-plan',title:'Blocked plan',content_json:{id:'blocked-plan',flow_id:'flow',revision:1,status:'blocked',blocked_reason:'The prepared test account lacks a tenant entitlement.',evidence_artifact_ids:[proof.id]}});
  f.runtime.planner.decide=async()=>({action:'complete_task',source:'ai_provider',summary:'Unsupported completion proposal'});
  const result=await f.runtime.run(f.run.id,{max_steps:3});
  const saved=result.snapshot.tasks.find(item=>item.id===task.id);
  assert.equal(saved.status,'blocked');assert.equal(saved.phase,'experiment_blocked_with_evidence');
  const outcome=result.snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_experiment_blocked');
  assert.deepEqual(outcome.content_json.evidence_artifact_ids,[proof.id]);
});

test('a bare model block fails normal learning, while terminal capture cleanup persists linked Flow evidence',async t=>{
  const priorModule=process.env.BSTG_PLAYWRIGHT_MODULE,priorMode=process.env.BSTG_BROWSER_MODE;
  process.env.BSTG_PLAYWRIGHT_MODULE=new URL('../live-browser/browser-double.mjs',import.meta.url).href;
  process.env.BSTG_BROWSER_MODE='headless';
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  try {
    const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Interrupted normal flow',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
    const flow=newBusinessFlow({name:'Interrupted normal flow',goal:'A saved record is visible to the signed-in member',role:'member'},task.id);
    await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
    await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
    await f.db.repos.accounts.create({name:'Prepared member',username:'member@example.test',status:'active',
      tags:['ai_scan',`scan:${f.run.id}`,'role:member'],fields:{username:'member@example.test',password:'fixture-member-password'},variables:{},auth_profile:{}});
    const registry=new AgentToolRegistry();
    registry.register({name:'bstg.business.capture.start',description:'Real capture fixture.',input_schema:{},handler:async(input,context)=>({ok:true,data:await startBusinessCapture(context,input)})});
    f.runtime.registry=registry;
    let decisions=0;
    f.runtime.planner.decide=async()=>++decisions===1
      ? {action:'tool_call',tool_name:'bstg.business.capture.start',arguments:{flow_id:flow.id,identity_key:'member'},source:'ai_provider'}
      : {action:'block_task',reason:'The model cannot establish the next normal-flow action.',source:'ai_provider'};

    await f.runtime.executeTask(task);

    const saved=await f.repo.getTask(task.id);
    const session=(await f.db.repos.recordingSessions.findAll()).find(item=>item.capture_filters?.flow_id===flow.id);
    const savedFlow=await getBusinessFlow(f.repo,f.run.id,flow.id);
    const artifacts=await f.repo.listArtifacts(f.run.id);
    assert.equal(saved.status,'failed');
    assert.equal(saved.phase,'normal_flow_block_without_evidence');
    assert.equal(session?.capture_filters?.capture_status,'interrupted');
    assert.equal(session?.status,'failed');
    assert.equal(savedFlow.status,'blocked');
    assert.equal(getLiveBrowserContextCount(f.run.id),0,'terminal cleanup closes the isolated task context used for reproducible prepared-login capture');
    const cleanup=artifacts.find(item=>item.artifact_type==='business_capture_cleanup'&&item.task_id===task.id);
    const captureEvidence=artifacts.find(item=>item.artifact_type==='business_capture_session'&&item.source_ref===session?.id);
    const rejected=artifacts.find(item=>item.artifact_type==='business_flow_block_rejected'&&item.task_id===task.id);
    assert.equal(cleanup?.content_json.live_interrupted,1);
    assert.deepEqual(cleanup?.content_json.unresolved_recording_ids,[]);
    assert.ok(captureEvidence?.id&&savedFlow.evidence_artifact_ids.includes(captureEvidence.id),'interrupted capture evidence must be linked on the Flow');
    assert.equal(rejected?.content_json.required_tool,'bstg.business.flow.block');
  } finally {
    await closePersistentBrowserContextsForScan(f.repo,f.run.id);
    if(priorModule===undefined)delete process.env.BSTG_PLAYWRIGHT_MODULE;else process.env.BSTG_PLAYWRIGHT_MODULE=priorModule;
    if(priorMode===undefined)delete process.env.BSTG_BROWSER_MODE;else process.env.BSTG_BROWSER_MODE=priorMode;
  }
});

test('a rejected evidenced-block tool call remains a normal-learning adaptation instead of ending the Flow',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Recover rejected normal blocker',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Recover rejected normal blocker',goal:'The observed normal operation remains repairable',role:'anonymous'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const registry=new AgentToolRegistry();
  const calls=[];
  registry.register({name:'bstg.business.flow.block',description:'Evidence-gated normal flow blocker fixture.',input_schema:{},handler:async()=>{
    calls.push('block');return {ok:false,error:'The supplied evidence artifact is not a current Flow blocker.'};
  }});
  registry.register({name:'bstg.business.flow.inspect',description:'Safe normal flow inspection fixture.',input_schema:{},handler:async()=>{
    calls.push('inspect');return {ok:true,data:{flow_id:flow.id,status:'learning'}};
  }});
  f.runtime.registry=registry;
  let turn=0,adaptationPhase='';
  f.runtime.planner.decide=async context=>{
    turn+=1;
    if(turn===1)return {action:'tool_call',tool_name:'bstg.business.flow.block',arguments:{flow_id:flow.id,evidence_artifact_id:'stale-artifact',reason:'The model has no current blocker evidence.'},source:'ai_provider'};
    if(turn===2){adaptationPhase=String(context.task.phase||'');return {action:'tool_call',tool_name:'bstg.business.flow.inspect',arguments:{flow_id:flow.id},source:'ai_provider'};}
    return {action:'fail_task',reason:'Stop fixture after verifying the adaptation turn.',source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const saved=await f.repo.getTask(task.id);
  const invocations=(await f.repo.getSnapshot(f.run.id)).tool_invocations.filter(item=>item.task_id===task.id);
  assert.equal(adaptationPhase,'normal_flow_block_requires_adaptation');
  assert.deepEqual(calls,['block','inspect'],'the next bounded turn inspects persisted Flow evidence instead of terminalizing the rejected blocker');
  assert.equal(invocations.find(item=>item.tool_name==='bstg.business.flow.block')?.status,'failed');
  assert.equal(invocations.find(item=>item.tool_name==='bstg.business.flow.inspect')?.status,'completed');
  assert.equal(saved?.phase,'failed','the fixture ends only through its explicit third decision, not the rejected blocker');
});

test('a retry Workflow omission is an explicit event-selection adaptation, never an automatic server selection',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Recover retry event selection',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Recover retry event selection',goal:'The scheduled normal operation is selected from current capture evidence',role:'anonymous'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,recording_session_id:'stopped-retry-recording'});
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const registry=new AgentToolRegistry(),calls=[];
  registry.register({name:'bstg.business.workflow.prepare',description:'Explicit retry subset guard fixture.',input_schema:{},handler:async()=>{
    calls.push('prepare');return {ok:false,error:'The selected event subset omits a scheduled retry target.',data:{
      status:'coverage_retry_event_selection_required',retryable:true,
      missing_scheduled_targets:[{target_type:'operation',target_id:'scheduled-operation',event_ids:['scheduled-event']}],
    }};
  }});
  registry.register({name:'bstg.business.capture.inspect',description:'Safe stopped capture fixture.',input_schema:{},handler:async()=>{
    calls.push('inspect');return {ok:true,data:{recording_session_id:'stopped-retry-recording',status:'stopped',
      retry_target_event_candidates:[{target_type:'operation',target_id:'scheduled-operation',event_ids:['scheduled-event']}]}};
  }});
  f.runtime.registry=registry;
  let turn=0,adaptationPhase='';
  f.runtime.planner.decide=async context=>{
    turn+=1;
    if(turn===1)return {action:'tool_call',tool_name:'bstg.business.workflow.prepare',arguments:{recording_session_id:'stopped-retry-recording',event_ids:['other-event']},source:'ai_provider'};
    if(turn===2){adaptationPhase=String(context.task.phase||'');return {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'stopped-retry-recording'},source:'ai_provider'};}
    return {action:'fail_task',reason:'Fixture ends after preserving model-owned retry selection.',source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const saved=await f.repo.getTask(task.id),snapshot=await f.repo.getSnapshot(f.run.id);
  assert.equal(adaptationPhase,'normal_workflow_selection_requires_adaptation');
  assert.deepEqual(calls,['prepare','inspect']);
  const failed=snapshot.tool_invocations.find(item=>item.tool_name==='bstg.business.workflow.prepare');
  assert.equal(failed?.status,'failed');
  assert.deepEqual(failed?.output_json.missing_scheduled_targets,[{target_type:'operation',target_id:'scheduled-operation',event_ids:['scheduled-event']}]);
  assert.equal(saved?.phase,'failed','only the fixture\'s explicit terminal decision ends the task');
  const policy=localPolicy({scan:{base_url:'http://unused',scan_config:{}},task:{phase:'normal_workflow_selection_requires_adaptation',task_type:'learn_business_flow',
    execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}},selected_vuln_types:[],task_tool_invocations:[],feature_tree:[],business_flows:[{
      ...flow,recording_session_id:'stopped-retry-recording',status:'learning',
    }]});
  assert.equal(policy.tool_name,'bstg.business.capture.inspect');
  assert.deepEqual(policy.arguments,{recording_session_id:'stopped-retry-recording'});
});

test('a normal Workflow semantic-event omission is a bounded model selection correction, not a task failure',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Recover semantic event selection',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Recover semantic event selection',goal:'A normal Workflow selects observed semantic evidence',role:'anonymous'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,recording_session_id:'stopped-semantic-recording'});
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const registry=new AgentToolRegistry(),calls=[];
  registry.register({name:'bstg.business.workflow.prepare',description:'Semantic subset guard fixture.',input_schema:{},handler:async()=>{
    calls.push('prepare');return {ok:false,error:'Selected events omit semantic response evidence.',data:{
      status:'semantic_body_candidate_required',retryable:true,candidate_event_ids:['semantic-event'],candidate_event_count:1,
    }};
  }});
  registry.register({name:'bstg.business.capture.inspect',description:'Safe stopped semantic capture fixture.',input_schema:{},handler:async()=>{
    calls.push('inspect');return {ok:true,data:{recording_session_id:'stopped-semantic-recording',status:'stopped',
      events:[{event_id:'context-event',semantic_body_path_available:false},{event_id:'semantic-event',semantic_body_path_available:true}]}};
  }});
  f.runtime.registry=registry;
  let turn=0,adaptationPhase='';
  f.runtime.planner.decide=async context=>{
    turn+=1;
    if(turn===1)return {action:'tool_call',tool_name:'bstg.business.workflow.prepare',arguments:{recording_session_id:'stopped-semantic-recording',event_ids:['context-event']},source:'ai_provider'};
    if(turn===2){adaptationPhase=String(context.task.phase||'');return {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'stopped-semantic-recording'},source:'ai_provider'};}
    return {action:'fail_task',reason:'Fixture ends after checking the semantic selection recovery.',source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const saved=await f.repo.getTask(task.id),snapshot=await f.repo.getSnapshot(f.run.id);
  assert.equal(adaptationPhase,'normal_workflow_selection_requires_adaptation');
  assert.deepEqual(calls,['prepare','inspect'],'the rejected selection must be followed by safe stopped-capture inspection before the next model-owned subset');
  const failed=snapshot.tool_invocations.find(item=>item.tool_name==='bstg.business.workflow.prepare');
  assert.equal(failed?.status,'failed');
  assert.equal(failed?.output_json.status,'semantic_body_candidate_required');
  assert.deepEqual(failed?.output_json.candidate_event_ids,['semantic-event'],'only opaque candidate IDs enter the recovery loop');
  assert.equal(saved?.phase,'failed','only the fixture’s explicit terminal decision ends the task');
});

for(const errorCode of ['assertion_not_observed','observation_reference_expired'])test(`a normal Flow preserves ${errorCode} no-action feedback for one bounded model correction`,async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Correct normal page assertion',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Correct normal page assertion',goal:'The current normal UI state is observed before workflow capture closes',role:'anonymous'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const registry=new AgentToolRegistry(),calls=[];
  registry.register({name:'browser.interact',description:'No-action page assertion fixture.',input_schema:{},handler:async input=>{
    calls.push(input.operation.action);
    if(calls.length===1)return {ok:false,error:'The expected page text was not observed.',data:{
      error_code:errorCode,failure_phase:'pre_action',action_performed:false,retryable:true,
      recovery_hint:'No browser action was dispatched.',observation:{assertion_targets:[{assertion_ref:'assertion_11111111-1111-4111-8111-111111111111',tag:'main'}]},
    }};
    return {ok:true,data:{observation:{assertion_targets:[{assertion_ref:'assertion_11111111-1111-4111-8111-111111111111',tag:'main'}]}}};
  }});
  f.runtime.registry=registry;
  let turn=0,correctionPhase='';
  f.runtime.planner.decide=async context=>{
    turn+=1;
    if(turn===1)return {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'assert',assertion_ref:'assertion_11111111-1111-4111-8111-111111111111',text:'stale state'}},source:'ai_provider'};
    if(turn===2){correctionPhase=String(context.task.phase||'');return {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'observe'}},source:'ai_provider'};}
    return {action:'fail_task',reason:'Fixture ends after a bounded page-state correction.',source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const snapshot=await f.repo.getSnapshot(f.run.id),saved=await f.repo.getTask(task.id);
  assert.equal(correctionPhase,'awaiting_selector_correction');
  assert.deepEqual(calls,['assert','observe']);
  const missed=snapshot.tool_invocations.find(item=>item.tool_name==='browser.interact'&&item.status==='failed');
  assert.equal(missed?.output_json.error_code,errorCode);
  assert.equal(saved?.phase,'failed','the fixture only ends through its explicit final decision');
});

test('a potentially dispatched normal browser action uses the persisted inspect-observe-inspect recovery before model resolution',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:5}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Recover dispatched normal action evidence',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Recover dispatched normal action evidence',goal:'The captured normal request is inspected before any repeat action',role:'anonymous'},task.id);
  flow.recording_session_id='post-action-recording';flow.recording_context_key=`task:${task.id}`;flow.recording_context_scope='task';flow.recording_identity_key='anonymous';
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const registry=new AgentToolRegistry(),calls=[];
  registry.register({name:'browser.interact',description:'Dispatched-action fixture.',input_schema:{},handler:async input=>{
    const action=String(input.operation?.action||'');calls.push(action);
    if(action==='observe')return {ok:true,data:{observation:{controls:[]}}};
    return {ok:false,error:'The operation was dispatched but the post-action page observation was unavailable.',data:{
      failure_phase:'action_or_after',action_performed:undefined,retryable:false,
      post_action_replay_guard:{fingerprint:'a'.repeat(64)},
    }};
  }});
  registry.register({name:'bstg.business.capture.inspect',description:'Existing capture inspection fixture.',input_schema:{},handler:async input=>{
    calls.push('inspect');assert.deepEqual(input,{},'the task-bound recorder session is resolved server-side, never supplied by recovery arguments');return {ok:true,data:{recording_session_id:'post-action-recording',status:'recording',events:[]}};
  }});
  f.runtime.registry=registry;
  const nativeDecide=f.runtime.planner.decide.bind(f.runtime.planner);let turn=0;const forced=[];
  f.runtime.planner.decide=async context=>{
    const phase=String(context.task.phase||'');
    if(phase.startsWith('normal_post_action_capture_requires_')){
      const decision=await nativeDecide(context);forced.push({phase,tool:decision.tool_name,arguments:decision.arguments,source:decision.source});return decision;
    }
    turn+=1;
    if(turn===1)return {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:'current-control'}},source:'ai_provider'};
    return {action:'fail_task',reason:'Fixture ends after verifying the capture-only recovery.',source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const snapshot=await f.repo.getSnapshot(f.run.id),saved=await f.repo.getTask(task.id);
  assert.deepEqual(forced,[
    {phase:'normal_post_action_capture_requires_inspection',tool:'bstg.business.capture.inspect',arguments:{},source:'local_policy'},
    {phase:'normal_post_action_capture_requires_authoritative_observation',tool:'browser.interact',arguments:{operation:{action:'observe'}},source:'local_policy'},
    {phase:'normal_post_action_capture_requires_post_observation_inspection',tool:'bstg.business.capture.inspect',arguments:{},source:'local_policy'},
  ]);
  assert.deepEqual(calls,['click','inspect','observe','inspect'],'post-action recovery must inspect, observe, and re-inspect before any model resolution without replaying the dispatched action');
  assert.equal(turn,2,'the three fixed recovery steps run through local policy without a provider decision');
  assert.equal(snapshot.tool_invocations.filter(item=>item.tool_name==='browser.interact').length,2);
  const failed=snapshot.tool_invocations.find(item=>item.tool_name==='browser.interact');
  assert.equal(failed?.output_json.action_performed,undefined,'an unknown dispatch outcome is treated as potentially dispatched');
  assert.equal(failed?.output_json.failure_phase,'action_or_after');
  assert.equal('post_action_replay_guard' in (failed?.output_json||{}),false,'private replay fingerprints never enter model-facing invocation history');
  const guard=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_post_action_replay_guard');
  assert.equal(guard?.content_json.private,true);assert.equal(guard?.content_json.recording_session_id,'post-action-recording');
  assert.match(String(guard?.content_json.operation_fingerprint),/^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(guard?.content_json).includes('current-control'),false,'the durable guard never stores a model control reference or selector');
  assert.equal(saved?.phase,'failed','only the fixture’s explicit terminal proposal ends the task; the post-action feedback itself is recoverable');
});

test('post-action capture-only recovery has a persisted two-attempt ceiling',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:5}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Bound post-action capture recovery',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Bound post-action capture recovery',goal:'Repeated observation loss remains unverified',role:'anonymous'},task.id);
  flow.recording_session_id='bounded-post-action-recording';flow.recording_context_key=`task:${task.id}`;flow.recording_context_scope='task';flow.recording_identity_key='anonymous';
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const registry=new AgentToolRegistry(),calls=[];
  registry.register({name:'browser.interact',description:'Repeated dispatched-action fixture.',input_schema:{},handler:async()=>{
    calls.push('interact');return {ok:false,error:'Post-action observation unavailable.',data:{failure_phase:'action_or_after',action_performed:true,retryable:false}};
  }});
  registry.register({name:'bstg.business.capture.inspect',description:'Repeated capture inspection fixture.',input_schema:{},handler:async()=>{
    calls.push('inspect');return {ok:true,data:{recording_session_id:'bounded-post-action-recording',status:'recording',events:[]}};
  }});
  f.runtime.registry=registry;
  let turn=0;
  f.runtime.planner.decide=async()=>{
    turn+=1;
    return turn===2||turn===4
      ? {action:'tool_call',tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'bounded-post-action-recording'},source:'local_policy'}
      : {action:'tool_call',tool_name:'browser.interact',arguments:{operation:{action:'click',control_ref:'current-control'}},source:'ai_provider'};
  };

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const snapshot=await f.repo.getSnapshot(f.run.id),saved=await f.repo.getTask(task.id);
  const limit=snapshot.artifacts.find(item=>item.task_id===task.id&&item.artifact_type==='business_post_action_capture_recovery_limit');
  assert.deepEqual(calls,['interact','inspect','interact','inspect','interact']);
  assert.equal(saved?.status,'failed');assert.equal(saved?.phase,'normal_post_action_capture_recovery_limit');
  assert.equal(limit?.content_json.attempts,3);assert.equal(limit?.content_json.limit,2);
  assert.equal(snapshot.tool_invocations.filter(item=>item.tool_name==='bstg.business.capture.inspect').length,2,
    'the third dispatched action terminates on the persisted ceiling instead of creating an unbounded capture-inspection loop');
  assert.equal(snapshot.artifacts.some(item=>item.task_id===task.id&&item.artifact_type==='business_workflow_validation'),false,
    'capture-only recovery never upgrades an action-or-after browser result into normal-business proof');
});

test('an evidenced normal Flow blocker settles the task through the dedicated tool',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Credential-blocked normal flow',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Credential-blocked normal flow',goal:'A member can view the secured dashboard',role:'member'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const evidence=await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'business_identity_login',source_ref:'recording-fixture',title:'Prepared identity unavailable',
    content_json:{flow_id:flow.id,status:'credentials_unavailable',authenticated:false}});
  const blockerTool=buildBusinessLearningToolSpecs().find(item=>item.name==='bstg.business.flow.block');
  assert.ok(blockerTool,'normal learning must register its evidenced Flow blocker tool');
  const registry=new AgentToolRegistry();registry.register(blockerTool);f.runtime.registry=registry;
  f.runtime.planner.decide=async()=>({action:'tool_call',tool_name:'bstg.business.flow.block',arguments:{flow_id:flow.id,evidence_artifact_id:evidence.id,
    reason:'The prepared member identity has no credentials for this assessment.'},source:'ai_provider'});

  await f.runtime.executeTask(await f.repo.getTask(task.id));

  const savedTask=await f.repo.getTask(task.id);
  const artifacts=await f.repo.listArtifacts(f.run.id);
  const savedFlow=await getBusinessFlow(f.repo,f.run.id,flow.id);
  const blocker=artifacts.find(item=>item.artifact_type==='business_flow_blocker'&&item.task_id===task.id);
  assert.equal(savedTask?.status,'blocked');
  assert.equal(savedTask?.phase,'normal_flow_blocked_with_evidence');
  assert.equal(savedFlow.status,'blocked');
  assert.ok(savedFlow.evidence_artifact_ids.includes(evidence.id));
  assert.ok(blocker?.id&&savedFlow.evidence_artifact_ids.includes(blocker.id));
  assert.deepEqual(businessLearningTerminalDisposition(savedTask,artifacts),{
    kind:'blocked',reason:'The prepared member identity has no credentials for this assessment.',evidence_artifact_ids:[evidence.id],
  });
});

test('terminal cleanup recovers an orphaned persisted recording after the live browser process is gone',async t=>{
  const f=await fixture(t);
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Restarted capture owner',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flow=newBusinessFlow({name:'Restarted normal flow',goal:'A saved record remains visible',role:'member'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  const session=await createRecordingSession(f.db,{name:'Orphaned normal capture',mode:'workflow',intent:'learning_seed',source_tool:'bstg.business.capture',role:'member',
    capture_filters:{source:'agent_business',scan_run_id:f.run.id,task_id:task.id,flow_id:flow.id,identity_key:'member',context_key:'identity:member',capture_status:'recording'}});

  const cleanup=await interruptBusinessCapturesForTask({db:f.db,repo:f.repo,scanRunId:f.run.id,taskId:task.id});

  const saved=await f.db.repos.recordingSessions.findById(session.id);
  const savedFlow=await getBusinessFlow(f.repo,f.run.id,flow.id);
  assert.deepEqual(cleanup,{live_interrupted:0,recovered_recordings:1,errors:[],unresolved_recording_ids:[]});
  assert.equal(saved?.status,'failed');
  assert.equal(saved?.capture_filters?.capture_status,'interrupted');
  assert.equal(savedFlow.status,'blocked');
  const recovery=(await f.repo.listArtifacts(f.run.id)).find(item=>item.artifact_type==='business_capture_session'&&item.source_ref===session.id);
  assert.equal(recovery?.content_json.recovered_after_task_terminal,true);
  assert.ok(recovery?.id&&savedFlow.evidence_artifact_ids.includes(recovery.id),'recovered capture evidence must be linked on the blocked Flow');
});

test('durable execution lease rejects a second deployment before it can enter an agent runtime',async t=>{
  // Separate ESM module instances model two service processes: each gets its
  // own module-scoped owner/active map, while both contend on the same SQLite
  // database lease. This is the product boundary that serializes the native
  // completion-recovery context reset; its local Map only handles reentrancy
  // inside the winning runtime.
  const file=`/tmp/bstg-execution-lease-${randomUUID()}.sqlite`;
  const primary=new SqliteProvider(`execution-lease-primary-${randomUUID()}`,{file});
  const competing=new SqliteProvider(`execution-lease-competing-${randomUUID()}`,{file});
  await primary.connect();await primary.migrate();await competing.connect();
  t.after(async()=>{
    await Promise.all([primary.disconnect(),competing.disconnect()]);
    await Promise.all([file,`${file}-wal`,`${file}-shm`].map(candidate=>rm(candidate,{force:true})));
  });
  const repo=new AIScanRepository(primary),run=await repo.createRun({base_url:'http://127.0.0.1:9/lease-fixture'});
  const first=await import(`../../server/src/services/ai-scan/scan-execution.ts?deployment=${randomUUID()}`);
  const second=await import(`../../server/src/services/ai-scan/scan-execution.ts?deployment=${randomUUID()}`);

  const attempts=await Promise.allSettled([
    first.startManagedScan(primary,run.id,{max_steps:1}),
    second.startManagedScan(competing,run.id,{max_steps:1}),
  ]);
  const admitted=attempts.filter(result=>result.status==='fulfilled');
  const rejected=attempts.filter(result=>result.status==='rejected');
  assert.equal(admitted.length,1,'exactly one deployment owns this run before agent tools execute');
  assert.equal(rejected.length,1,'a competing deployment must never join a live run');
  assert.match(String(rejected[0].reason),/已有执行进程/);
  await admitted[0].value.promise.catch(()=>undefined);
  const lease=await dbGet(primary,'SELECT owner FROM ai_scan_execution_leases WHERE scan_run_id = ?',[run.id]);
  assert.equal(lease,null,'the winning runtime releases the durable lease after it reaches a terminal outcome');
});

test('dead local lease recovery closes the failed scan and recovers its persisted business capture',async t=>{
  const f=await fixture(t);
  await f.repo.updateRun(f.run.id,{status:'running',current_phase:'executing'});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Dead worker capture owner',task_type:'learn_business_flow',status:'running',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flow=newBusinessFlow({name:'Dead worker normal flow',goal:'A saved record remains visible',role:'member'},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  const session=await createRecordingSession(f.db,{name:'Dead worker capture',mode:'workflow',intent:'learning_seed',source_tool:'bstg.business.capture',role:'member',
    capture_filters:{source:'agent_business',scan_run_id:f.run.id,task_id:task.id,flow_id:flow.id,identity_key:'member',context_key:'identity:member',capture_status:'recording'}});
  const terminalTask=await f.repo.createTask({scan_run_id:f.run.id,title:'Already terminal capture owner',task_type:'learn_business_flow',status:'completed',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const terminalFlow=newBusinessFlow({name:'Already terminal normal flow',goal:'A saved record remains visible',role:'member'},terminalTask.id);
  await saveBusinessFlow(f.repo,f.run.id,terminalTask.id,terminalFlow);
  const terminalSession=await createRecordingSession(f.db,{name:'Already terminal capture',mode:'workflow',intent:'learning_seed',source_tool:'bstg.business.capture',role:'member',
    capture_filters:{source:'agent_business',scan_run_id:f.run.id,task_id:terminalTask.id,flow_id:terminalFlow.id,identity_key:'member',context_key:'identity:member',capture_status:'recording'}});
  const brokenTerminalTask=await f.repo.createTask({scan_run_id:f.run.id,title:'Terminal capture with missing flow',task_type:'learn_business_flow',status:'failed',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const brokenTerminalSession=await createRecordingSession(f.db,{name:'Terminal capture with missing flow',mode:'workflow',intent:'learning_seed',source_tool:'bstg.business.capture',role:'member',
    capture_filters:{source:'agent_business',scan_run_id:f.run.id,task_id:brokenTerminalTask.id,flow_id:'missing-flow',identity_key:'member',context_key:'identity:member',capture_status:'recording'}});
  await f.repo.upsertBrowserContext({scan_run_id:f.run.id,task_id:task.id,context_key:`task:${task.id}`,scope_type:'task',status:'active'});
  await f.repo.upsertBrowserContext({scan_run_id:f.run.id,task_id:task.id,context_key:'identity:member',scope_type:'identity',identity_key:'member',status:'active'});
  await dbRun(f.db,'CREATE TABLE IF NOT EXISTS ai_scan_execution_leases (scan_run_id TEXT PRIMARY KEY, owner TEXT NOT NULL, hostname TEXT NOT NULL, pid INTEGER NOT NULL, updated_at TEXT NOT NULL)');
  await dbRun(f.db,'INSERT INTO ai_scan_execution_leases (scan_run_id,owner,hostname,pid,updated_at) VALUES (?,?,?,?,?)',[f.run.id,'dead-worker-test',os.hostname(),2147483647,new Date().toISOString()]);

  await recoverInterruptedScans(f.db);

  const savedTask=await f.repo.getTask(task.id);
  const savedTerminalTask=await f.repo.getTask(terminalTask.id);
  const savedBrokenTerminalTask=await f.repo.getTask(brokenTerminalTask.id);
  const savedRun=await f.repo.getRun(f.run.id);
  const savedSession=await f.db.repos.recordingSessions.findById(session.id);
  const savedTerminalSession=await f.db.repos.recordingSessions.findById(terminalSession.id);
  const savedBrokenTerminalSession=await f.db.repos.recordingSessions.findById(brokenTerminalSession.id);
  const savedFlow=await getBusinessFlow(f.repo,f.run.id,flow.id);
  const savedTerminalFlow=await getBusinessFlow(f.repo,f.run.id,terminalFlow.id);
  const artifacts=await f.repo.listArtifacts(f.run.id);
  const contexts=await f.repo.listBrowserContexts(f.run.id);
  const lease=await dbGet(f.db,'SELECT scan_run_id FROM ai_scan_execution_leases WHERE scan_run_id = ?',[f.run.id]);
  assert.equal(savedRun?.status,'failed');
  assert.equal(lease,null);
  assert.equal(savedTask?.status,'failed');
  assert.equal(savedTask?.phase,'interrupted');
  assert.equal(savedTerminalTask?.status,'completed','the recovery must find captures whose task wrote terminal state before its finally block ran');
  assert.equal(savedBrokenTerminalTask?.phase,'interrupted_capture_cleanup_failed');
  assert.equal(savedSession?.status,'failed');
  assert.equal(savedSession?.capture_filters?.capture_status,'interrupted');
  assert.equal(savedTerminalSession?.capture_filters?.capture_status,'interrupted');
  assert.equal(savedBrokenTerminalSession?.capture_filters?.capture_status,'interrupted');
  assert.equal(savedFlow.status,'blocked');
  assert.equal(savedTerminalFlow.status,'blocked');
  const cleanup=artifacts.find(item=>item.artifact_type==='business_capture_cleanup'&&item.task_id===task.id);
  const terminalCleanup=artifacts.find(item=>item.artifact_type==='business_capture_cleanup'&&item.task_id===terminalTask.id);
  const brokenTerminalCleanup=artifacts.find(item=>item.artifact_type==='business_capture_cleanup'&&item.task_id===brokenTerminalTask.id);
  assert.equal(cleanup?.content_json.ok,true);
  assert.equal(cleanup?.content_json.recovered_after_process_interruption,true);
  assert.equal(cleanup?.content_json.recovered_recordings,1);
  assert.deepEqual(cleanup?.content_json.unresolved_recording_ids,[]);
  assert.equal(terminalCleanup?.content_json.recovered_recordings,1);
  assert.equal(brokenTerminalCleanup?.content_json.ok,false);
  assert.ok(brokenTerminalCleanup?.content_json.errors?.length);
  assert.deepEqual(brokenTerminalCleanup?.content_json.unresolved_recording_ids,[]);
  assert.equal(contexts.find(item=>item.context_key===`task:${task.id}`)?.status,'failed');
  assert.equal(contexts.find(item=>item.context_key==='identity:member')?.status,'failed','a dead worker ends the whole scan, including its shared identity context');
});

test('terminal capture cleanup errors fail closed even after the recording row is no longer active',async t=>{
  const f=await fixture(t);
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Broken persisted flow capture',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const session=await createRecordingSession(f.db,{name:'Broken flow capture',mode:'workflow',intent:'learning_seed',source_tool:'bstg.business.capture',role:'member',
    capture_filters:{source:'agent_business',scan_run_id:f.run.id,task_id:task.id,flow_id:'missing-flow',identity_key:'member',context_key:'identity:member',capture_status:'recording'}});
  f.runtime.planner.decide=async()=>({action:'fail_task',reason:'The task cannot continue.',source:'ai_provider'});

  await f.runtime.executeTask(task);

  const savedTask=await f.repo.getTask(task.id);
  const savedSession=await f.db.repos.recordingSessions.findById(session.id);
  const cleanup=(await f.repo.listArtifacts(f.run.id)).find(item=>item.artifact_type==='business_capture_cleanup'&&item.task_id===task.id);
  assert.equal(savedSession?.capture_filters?.capture_status,'interrupted');
  assert.equal(savedTask?.status,'failed');
  assert.equal(savedTask?.phase,'business_capture_cleanup_failed');
  assert.equal(cleanup?.content_json.ok,false);
  assert.ok(cleanup?.content_json.errors?.length,'the persisted flow update error must be retained as cleanup evidence');
  assert.deepEqual(cleanup?.content_json.unresolved_recording_ids,[],'the task must still fail when the row itself was transitioned out of recording');
});

test('normal task cannot complete by model claim, adapts after a failed validation, and settles a final native proof at the task budget boundary',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:3}});
  const target=await coverageTarget(f,'Details','/details');
  const plan=await f.repo.createTask({scan_run_id:f.run.id,title:'Business plan',task_type:'plan_business_flows',status:'completed',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const flow=newBusinessFlow({name:'Details',goal:'Saved display name matches the submitted value',role:'anonymous',feature_id:target.feature.id},plan.id);
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Normal learning',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  const coverage=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(coverage.ok,true,JSON.stringify(coverage));
  const registry=new AgentToolRegistry();let validations=0;
  registry.register({name:'bstg.business.workflow.validate',description:'Explicit inert native-validation result fixture.',input_schema:{},handler:async()=>{
    validations++;const verified=validations===2;
    const coverage_bindings=verified?[{target_type:'feature',target_id:target.feature.id,endpoint_id:target.endpoint.id,source_event_id:'fixture-event',action_id:'fixture-action',source_step_order:1,source_workflow_id:'fixture-source-workflow',normal_workflow_id:'fixture-normal-workflow',normal_run_id:'fixture-native-result',validation_assertion_ids:['fixture-assertion'],validated:true},
      {target_type:'operation',target_id:target.endpoint.id,endpoint_id:target.endpoint.id,source_event_id:'fixture-event',action_id:'fixture-action',source_step_order:1,source_workflow_id:'fixture-source-workflow',normal_workflow_id:'fixture-normal-workflow',normal_run_id:'fixture-native-result',validation_assertion_ids:['fixture-assertion'],validated:true}]:[];
    await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,status:verified?'verified':'failed',workflow_id:'fixture-normal-workflow',normal_run_id:'fixture-native-result',assertions_verified:verified,evidence_artifact_ids:['fixture-result'],blockers:verified?[]:['Observed state mismatch'],coverage_bindings});
    if(verified)await nativeCoverageProofArtifacts(f,{taskId:task.id,flowId:flow.id,workflowId:'fixture-normal-workflow',runId:'fixture-native-result',bindings:coverage_bindings});
    // This matches the real wrapper: native execution completed, but its
    // semantic business result is false. Runtime must adapt on the fact, not
    // only when a transport wrapper reports ok:false.
    return {ok:true,data:{verified,test_run_id:'fixture-native-result',assertions:[{passed:verified}],summary:verified?'Fixture verifier passed':'Fixture verifier observed a mismatch'}};
  }});
  f.runtime.registry=registry;const phases=[];const runtimeRepo=f.runtime.getRepository(),updateTask=runtimeRepo.updateTask.bind(runtimeRepo);
  runtimeRepo.updateTask=async(id,patch)=>{if(id===task.id&&patch.phase)phases.push(patch.phase);return updateTask(id,patch);};let decisions=0;
  f.runtime.planner.decide=async()=>{decisions++;return decisions===1?{action:'complete_task',source:'local_policy'}:{action:'tool_call',tool_name:'bstg.business.workflow.validate',arguments:{},source:'local_policy'};};
  const result=await f.runtime.run(f.run.id,{max_steps:8});assert.equal(validations,2);assert.equal(decisions,3);
  assert.equal(result.steps_executed,3,'the server closes the last native proof without reserving a fourth model decision');
  assert.equal(result.snapshot.tasks.find(item=>item.id===task.id).status,'completed');
  assert.ok(phases.includes('normal_validation_semantic_requires_inspection'),'a semantic verified:false result must enter same-workflow inspection even when the tool call itself completed');
  assert.equal(result.snapshot.artifacts.filter(item=>item.artifact_type==='business_completion_gap').length,1);
  assert.equal(latestBusinessFlows(result.snapshot.artifacts)[0].assertions_verified,true);
});

test('runtime escalates a repeated native execution error to a model-selected Workflow revision without manufacturing event choices',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:8}});
  const target=await coverageTarget(f,'Apply once','/apply-once');
  const plan=await f.repo.createTask({scan_run_id:f.run.id,title:'Business plan',task_type:'plan_business_flows',status:'completed',execution_plan:{intent:BUSINESS_PLAN_INTENT}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Repeated native execution error',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'pending'}});
  const flow=newBusinessFlow({name:'Apply once',goal:'The selected operation reaches completed state',role:'anonymous',feature_id:target.feature.id},task.id);
  await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,status:'learning',recording_session_id:'recording-current',workflow_id:'workflow-initial',normal_run_id:'native-initial'});
  await f.repo.updateTask(task.id,{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  const coverage=await saveCoverage(f,plan,[
    {target_type:'feature',target_id:target.feature.id,disposition:'planned',flow_id:flow.id},
    {target_type:'operation',target_id:target.endpoint.id,disposition:'planned',flow_id:flow.id},
  ]);assert.equal(coverage.ok,true,JSON.stringify(coverage));
  const registry=new AgentToolRegistry(),toolCalls=[],phases=[];let validations=0;
  const runtimeRepo=f.runtime.getRepository(),updateTask=runtimeRepo.updateTask.bind(runtimeRepo);
  runtimeRepo.updateTask=async(id,patch)=>{if(id===task.id&&patch.phase)phases.push(patch.phase);return updateTask(id,patch);};
  registry.register({name:'bstg.business.workflow.validate',description:'Native validation test double.',input_schema:{type:'object'},handler:async(args)=>{
    toolCalls.push({tool:'validate',args});validations++;
    const failed=validations<3;
    const workflowId=failed?(validations===1?'workflow-initial':'workflow-repaired'):'workflow-revised';
    const testRunId=failed?(validations===1?'native-initial':'native-repaired'):'native-revised';
    const current=await getBusinessFlow(f.repo,f.run.id,flow.id);
    const coverage_bindings=failed?[]:[
      {target_type:'feature',target_id:target.feature.id,endpoint_id:target.endpoint.id,source_event_id:'event-first',action_id:'action-first',source_step_order:1,source_workflow_id:'workflow-revised',normal_workflow_id:'workflow-revised',normal_run_id:'native-revised',validation_assertion_ids:['state-applied'],validated:true},
      {target_type:'operation',target_id:target.endpoint.id,endpoint_id:target.endpoint.id,source_event_id:'event-first',action_id:'action-first',source_step_order:1,source_workflow_id:'workflow-revised',normal_workflow_id:'workflow-revised',normal_run_id:'native-revised',validation_assertion_ids:['state-applied'],validated:true},
    ];
    await saveBusinessFlow(f.repo,f.run.id,task.id,{...current,status:failed?'failed':'verified',workflow_id:workflowId,normal_run_id:testRunId,
      assertions_verified:!failed,baseline_verified:!failed,evidence_artifact_ids:failed?['native-failure-1','native-failure-2']:['native-success'],blockers:[],coverage_bindings});
    if(failed)await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'business_workflow_validation',source_ref:testRunId,title:'Native validation fixture',content_json:{flow_id:flow.id,workflow_id:workflowId,test_run_id:testRunId,assertions_verified:false,
      execution:{has_execution_error:true}}});
    else await nativeCoverageProofArtifacts(f,{taskId:task.id,flowId:flow.id,workflowId,runId:testRunId,bindings:coverage_bindings});
    return {ok:true,data:{verified:!failed,workflow_id:workflowId,test_run_id:testRunId,execution:{has_execution_error:failed}}};
  }});
  registry.register({name:'bstg.business.workflow.repair',description:'Repair test double.',input_schema:{type:'object'},handler:async(args)=>{
    toolCalls.push({tool:'repair',args});assert.deepEqual(args,{workflow_id:'workflow-initial',test_run_id:'native-initial'});
    const current=await getBusinessFlow(f.repo,f.run.id,flow.id);
    await saveBusinessFlow(f.repo,f.run.id,task.id,{...current,status:'failed',workflow_id:'workflow-repaired',normal_run_id:'native-repaired',assertions_verified:false,baseline_verified:false,blockers:[]});
    return {ok:true,data:{status:'repaired',workflow_id:'workflow-repaired',test_run_id:'native-repaired'}};
  }});
  registry.register({name:'bstg.business.workflow.inspect',description:'Workflow inspection test double.',input_schema:{type:'object'},handler:async(args)=>{
    toolCalls.push({tool:'workflow.inspect',args});return {ok:true,data:{workflow_id:args.workflow_id,steps:[]}};
  }});
  registry.register({name:'bstg.business.capture.inspect',description:'Capture inspection test double.',input_schema:{type:'object'},handler:async(args)=>{
    toolCalls.push({tool:'capture.inspect',args});assert.deepEqual(args,{recording_session_id:'recording-current'});
    return {ok:true,data:{recording_session_id:'recording-current',status:'stopped',events:[{event_id:'event-first'},{event_id:'event-third'}]}};
  }});
  registry.register({name:'bstg.business.workflow.revise',description:'Explicit model revision test double.',input_schema:{type:'object'},handler:async(args)=>{
    toolCalls.push({tool:'revise',args});assert.deepEqual(args,{workflow_id:'workflow-repaired',test_run_id:'native-repaired',event_ids:['event-first','event-third'],rationale:'Keep the successful transaction and remove the repeated consumer.'});
    const current=await getBusinessFlow(f.repo,f.run.id,flow.id);
    await saveBusinessFlow(f.repo,f.run.id,task.id,{...current,status:'learning',workflow_id:'workflow-revised',normal_run_id:undefined,assertions:[],assertions_verified:false,baseline_verified:false,blockers:[]});
    return {ok:true,data:{status:'revised',workflow_id:'workflow-revised'}};
  }});
  f.runtime.registry=registry;
  const expected=[
    {tool_name:'bstg.business.workflow.validate',arguments:{workflow_id:'workflow-initial'}},
    {tool_name:'bstg.business.workflow.repair',arguments:{workflow_id:'workflow-initial',test_run_id:'native-initial'}},
    {tool_name:'bstg.business.workflow.inspect',arguments:{workflow_id:'workflow-repaired'}},
    {tool_name:'bstg.business.workflow.validate',arguments:{workflow_id:'workflow-repaired'}},
    {tool_name:'bstg.business.capture.inspect',arguments:{recording_session_id:'recording-current'}},
    {tool_name:'bstg.business.workflow.revise',arguments:{workflow_id:'workflow-repaired',test_run_id:'native-repaired',event_ids:['event-first','event-third'],rationale:'Keep the successful transaction and remove the repeated consumer.'}},
    {tool_name:'bstg.business.workflow.inspect',arguments:{workflow_id:'workflow-revised'}},
    {tool_name:'bstg.business.workflow.validate',arguments:{workflow_id:'workflow-revised'}},
  ];
  const seenPhases=[];
  f.runtime.planner.decide=async context=>{
    seenPhases.push(context.task.phase);
    const next=expected.shift();assert.ok(next,'runtime must not request an extra model decision after the final native proof');
    return {action:'tool_call',...next,source:'ai_provider',model:'gpt-5.6-terra'};
  };
  const result=await f.runtime.run(f.run.id,{max_steps:12});
  assert.equal(expected.length,0);assert.equal(validations,3);
  const savedTask=result.snapshot.tasks.find(item=>item.id===task.id);
  assert.equal(savedTask.status,'completed');
  assert.ok(phases.includes('normal_validation_repeated_execution_error_requires_workflow_revision'));
  assert.ok(phases.includes('normal_validation_repeated_execution_error_requires_model_revision'));
  assert.ok(phases.includes('normal_workflow_revised_requires_inspection'));
  assert.deepEqual(toolCalls.map(call=>call.tool),['validate','repair','workflow.inspect','validate','capture.inspect','revise','workflow.inspect','validate']);
  assert.equal(seenPhases[5],'normal_validation_repeated_execution_error_requires_model_revision','the provider reaches the revision turn only after the server refreshed the stopped capture');
  assert.equal(toolCalls.find(call=>call.tool==='revise').args.event_ids.length,2,'only the provider decision supplies the selected event subset');
});

test('model context excludes raw capture, native trace and known secrets while retaining adaptation outcomes',async t=>{
  const f=await fixture(t,{accounts:{attacker:{username:'member-a',password:'private-credential'}}});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Normal learning',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT}});
  const flow=newBusinessFlow({name:'Details',goal:'Saved details are visible',role:'attacker'});await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,status:'failed',blockers:['State mismatch']});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'business_capture_event',title:'Private request',content_json:{private:true,flow_id:flow.id,request_body_text:'_g=private-dynamic-form-value&alias=Observed',request_headers:{cookie:'sid=private-cookie-value'},response_body_text:'{"ticket":"private-one-use-ticket"}',trace:{records:[{body:'private-trace-value'}]}}});
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'business_workflow_validation',title:'Normal validation failed',content_json:{verified:false,test_run_id:'native-result',assertions:[{passed:false,description:'State mismatch'}],execution:{success:false,raw_request:'private-raw-value',trace:{records:['private-native-record']}},message:'Known values: private-dynamic-form-value private-one-use-ticket private-cookie-value'}});
  const context=await buildAutonomousAgentContext({repo:f.repo,scanRunId:f.run.id,task,tools:[]});const wire=JSON.stringify(context);
  for(const secret of ['private-credential','private-dynamic-form-value','private-one-use-ticket','private-cookie-value','private-trace-value','private-native-record','private-raw-value'])assert.ok(!wire.includes(secret),secret);
  assert.equal(context.business_flows[0].status,'failed');assert.ok(wire.includes('State mismatch'));assert.ok(wire.includes('native-result'));assert.ok(wire.includes('"verified":false'));
});

test('ordinary planner rhythm never treats a learned request or HTTP status as normal verification',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow'},task_type:'learn_business_flow'},selected_vuln_types:[],task_tool_invocations:[],feature_tree:[],business_flows:[{id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'learning',workflow_id:'workflow'}]};
  assert.equal(localPolicy(context).tool_name,'bstg.business.workflow.inspect');
  context.task_tool_invocations.push({tool_name:'bstg.business.workflow.inspect',status:'completed',output_json:{workflow_id:'workflow'}});
  const validation=localPolicy(context);assert.equal(validation.tool_name,'bstg.business.workflow.validate');assert.deepEqual(validation.arguments,{workflow_id:'workflow'});
  assert.equal('assertions' in validation.arguments,false,'the deterministic guidance must not fabricate business assertions for the model');
  context.business_flows[0]={...context.business_flows[0],status:'verified',assertions_verified:true,normal_run_id:'native-run'};
  assert.equal(localPolicy(context).action,'complete_task');
});

test('normal planner repairs only the current failed native workflow, then re-inspects before revalidation',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{phase:'normal_validation_requires_adaptation',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow'},task_type:'learn_business_flow'},selected_vuln_types:[],task_tool_invocations:[],feature_tree:[],business_flows:[{
    id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'failed',workflow_id:'failed-workflow',normal_run_id:'failed-native-run',
  }]};
  let next=localPolicy(context);
  assert.equal(next.tool_name,'bstg.business.workflow.repair');
  assert.deepEqual(next.arguments,{workflow_id:'failed-workflow',test_run_id:'failed-native-run'});
  context.task.phase='normal_validation_repaired_requires_inspection';
  next=localPolicy(context);
  assert.equal(next.tool_name,'bstg.business.workflow.inspect');
  assert.deepEqual(next.arguments,{workflow_id:'failed-workflow'});
  context.business_flows[0].recording_session_id='recording-current';
  context.task.phase='normal_validation_repeated_execution_error_requires_workflow_revision';
  next=localPolicy(context);
  assert.equal(next.tool_name,'bstg.business.capture.inspect');
  assert.deepEqual(next.arguments,{recording_session_id:'recording-current'},'a repeated native execution error refreshes safe observed event IDs before a revision');
  context.task.phase='normal_validation_repeated_execution_error_requires_model_revision';
  next=localPolicy(context);
  assert.equal(next.tool_name,'bstg.business.workflow.revise');
  assert.deepEqual(next.arguments,{workflow_id:'failed-workflow',test_run_id:'failed-native-run'});
  assert.equal('event_ids' in next.arguments,false,'local policy may route to revision but cannot manufacture the model-selected event subset');
  context.task.phase='normal_workflow_revised_requires_inspection';
  assert.equal(localPolicy(context).tool_name,'bstg.business.workflow.inspect','a published revision is re-inspected before a fresh native validation');
  context.task.phase='normal_assertion_revision_requires_inspection';
  assert.equal(localPolicy(context).tool_name,'bstg.business.workflow.inspect','invalid assertion input stays on the same workflow instead of restarting capture');
  context.task.phase='normal_objective_completion_assertion_requires_inspection';
  assert.equal(localPolicy(context).tool_name,'bstg.business.workflow.inspect','missing final-outcome assertion stays on the same workflow and requires inspection before the model chooses its correction');
  context.task.phase='normal_validation_semantic_requires_inspection';
  assert.equal(localPolicy(context).tool_name,'bstg.business.workflow.inspect','semantic mismatch is inspected before any new validation decision');
});

test('normal planner does not let an earlier Workflow inspection authorize a newer execution snapshot',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow'},task_type:'learn_business_flow'},selected_vuln_types:[],task_tool_invocations:[
    {tool_name:'bstg.business.workflow.inspect',status:'completed',output_json:{workflow_id:'old-workflow'}},
  ],feature_tree:[],business_flows:[{id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'failed',workflow_id:'new-workflow'}]};
  const next=localPolicy(context);assert.equal(next.tool_name,'bstg.business.workflow.inspect');assert.deepEqual(next.arguments,{workflow_id:'new-workflow'});
});

test('normal capture policy requires a bound browser operation before inspection and retains stopped capture provenance',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow'},task_type:'learn_business_flow'},selected_vuln_types:[],task_tool_invocations:[
    {tool_name:'bstg.business.capture.start',status:'completed',output_json:{recording_session_id:'recording'}},
  ],feature_tree:[],business_flows:[{id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'learning',recording_session_id:'recording',
    recording_context_key:'identity:anonymous',recording_context_scope:'identity',recording_identity_key:'anonymous'}]};
  let next=localPolicy(context);
  assert.equal(next.tool_name,'browser.navigate');
  assert.deepEqual(next.arguments,{url:'http://unused',context_key:'identity:anonymous',context_scope:'identity',identity_key:'anonymous'});
  context.task_tool_invocations.push({tool_name:'browser.navigate',status:'completed',output_json:{context_key:'identity:anonymous'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.business.capture.inspect');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:'recording',status:'stopped'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.business.capture.inspect',
    'A stopped capture is inspected before the provider may choose its initial Workflow event set.');
  context.task_tool_invocations.push({tool_name:'bstg.business.capture.inspect',status:'completed',output_json:{recording_session_id:'recording',status:'stopped'}});
  next=localPolicy(context);assert.equal(next.action,'model_decision_required');assert.equal(next.tool_name,undefined,
    'Local policy cannot manufacture an initial workflow.prepare call or an all-events selection.');
  assert.match(next.rationale,/nonempty.*event IDs/i);
});

test('planning policy does not release a nonempty flow list without a persisted coverage list',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{id:'plan',execution_plan:{intent:BUSINESS_PLAN_INTENT},task_type:'plan_business_flows'},selected_vuln_types:[],task_tool_invocations:[
    {tool_name:'browser.navigate',status:'completed',output_json:{}},{tool_name:'bstg.business.coverage.inspect',status:'completed',output_json:{targets:[]}},
  ],task_artifacts:[],feature_tree:[],business_flows:[{id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'discovered'}]};
  assert.equal(localPolicy(context).tool_name,'bstg.business.coverage.inspect');
});

test('experiment planner guides tool order but leaves the concrete mutation to the model',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow'},task_type:'model_business_experiment'},selected_vuln_types:[],task_tool_invocations:[],feature_tree:[],business_flows:[{id:'flow',name:'Profile',goal:'Saved state',role:'attacker',status:'verified',assertions_verified:true,normal_run_id:'normal-run',workflow_id:'workflow'}]};
  assert.equal(localPolicy(context).tool_name,'bstg.business.flow.inspect');
  context.task_tool_invocations.push({tool_name:'bstg.business.flow.inspect',status:'completed',output_json:{}});
  assert.equal(localPolicy(context).tool_name,'bstg.workflow.inspect');
  context.task_tool_invocations.push({tool_name:'bstg.workflow.inspect',status:'completed',output_json:{}});
  const plan=localPolicy(context);assert.equal(plan.tool_name,'bstg.test_plan.create');assert.deepEqual(plan.arguments,{flow_id:'flow'});
  assert.equal('patches' in plan.arguments,false,'the lifecycle must not manufacture a fixed mutation for the model');
});

test('experiment policy derives each next stage from the current persisted plan revision, never an older invocation or result',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{id:'experiment-task',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow'},task_type:'model_business_experiment'},selected_vuln_types:[],business_flows:[{id:'flow',name:'Profile',goal:'Saved state',role:'attacker',status:'verified',assertions_verified:true,normal_run_id:'normal-run',workflow_id:'workflow'}],
    task_tool_invocations:[
      {tool_name:'bstg.business.flow.inspect',status:'completed',output_json:{}},{tool_name:'bstg.workflow.inspect',status:'completed',output_json:{}},
      {tool_name:'bstg.test_plan.compile',status:'completed',output_json:{plan_id:'plan-a',plan_revision:2,status:'compiled'}},
      {tool_name:'bstg.test_plan.execute',status:'completed',output_json:{plan_id:'plan-a',plan_revision:2,result_revision:7,status:'executed'}},
      {tool_name:'bstg.test_plan.inspect',status:'completed',output_json:{plan_id:'plan-a',plan_revision:2,result_revision:7}},
      {tool_name:'bstg.test_plan.assess',status:'completed',output_json:{plan_id:'plan-a',result_revision:7}},
    ],task_artifacts:[
      {type:'agent_experiment_plan',created_at:'2026-01-02T00:00:00.000Z',content_json:{id:'plan-a',flow_id:'flow',revision:3,status:'compiled'}},
      {type:'agent_experiment_result',created_at:'2026-01-01T00:00:00.000Z',content_json:{plan_id:'plan-a',plan_revision:2,revision:7,status:'executed'}},
      {id:'confirmed-proof',type:'business_state_proof',created_at:'2026-01-01T00:00:01.000Z',content_json:{status:'confirmed'}},
      {type:'agent_experiment_assessment',created_at:'2026-01-01T00:00:01.000Z',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:7,verdict:'vulnerable',native_evidence_gate:{verdict:'confirmed',evidence_artifact_ids:['confirmed-proof']} }},
    ]};
  let next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.execute');assert.deepEqual(next.arguments,{plan_id:'plan-a'});
  context.task_artifacts.push({type:'agent_experiment_result',created_at:'2026-01-03T00:00:00.000Z',content_json:{plan_id:'plan-a',plan_revision:3,revision:8,status:'executed'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.inspect','an old inspect invocation cannot satisfy the current execution result');
  context.task_tool_invocations.push({tool_name:'bstg.test_plan.inspect',status:'completed',output_json:{plan_id:'plan-a',plan_revision:3,result_revision:8}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.assess');assert.deepEqual(next.arguments,{plan_id:'plan-a'});
  context.task_artifacts.push({type:'agent_experiment_assessment',created_at:'2026-01-03T00:00:01.000Z',content_json:{plan_id:'plan-a',plan_revision:3,result_revision:8,verdict:'vulnerable',native_evidence_gate:{verdict:'confirmed',evidence_artifact_ids:['confirmed-proof']}}});
  assert.equal(localPolicy(context).action,'complete_task');
});

test('an inconclusive experiment assessment requires a fresh parent-linked plan before the next current-revision loop',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{id:'experiment-task',execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:'flow'},task_type:'model_business_experiment'},selected_vuln_types:[],business_flows:[{id:'flow',name:'Profile',goal:'Saved state',role:'attacker',status:'verified',assertions_verified:true,normal_run_id:'normal-run',workflow_id:'workflow'}],
    task_tool_invocations:[
      {tool_name:'bstg.business.flow.inspect',status:'completed',output_json:{}},{tool_name:'bstg.workflow.inspect',status:'completed',output_json:{}},
      {tool_name:'bstg.test_plan.inspect',status:'completed',output_json:{plan_id:'plan-a',plan_revision:2,result_revision:4}},
    ],task_artifacts:[
      {artifact_type:'agent_experiment_plan',type:'agent_experiment_plan',task_id:'experiment-task',created_at:'2026-01-01T00:00:00.000Z',content_json:{id:'plan-a',flow_id:'flow',revision:2,status:'compiled'}},
      {artifact_type:'agent_experiment_result',type:'agent_experiment_result',task_id:'experiment-task',created_at:'2026-01-01T00:00:01.000Z',content_json:{plan_id:'plan-a',plan_revision:2,flow_id:'flow',revision:4,status:'executed'}},
      {artifact_type:'agent_experiment_assessment',type:'agent_experiment_assessment',task_id:'experiment-task',created_at:'2026-01-01T00:00:02.000Z',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:4,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}}},
    ]};
  let next=localPolicy(context);
  assert.equal(next.tool_name,'bstg.test_plan.create');
  assert.deepEqual(next.arguments,{flow_id:'flow',parent_plan_id:'plan-a'},'the correction must be a new child plan, not a reuse of the inconclusive plan id');
  context.task_artifacts.push({artifact_type:'agent_experiment_plan',type:'agent_experiment_plan',task_id:'experiment-task',created_at:'2026-01-01T00:00:03.000Z',content_json:{id:'plan-b',parent_plan_id:'plan-a',flow_id:'flow',revision:1,status:'planned'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.compile');assert.deepEqual(next.arguments,{plan_id:'plan-b'});
  context.task_artifacts.push({artifact_type:'agent_experiment_plan',type:'agent_experiment_plan',task_id:'experiment-task',created_at:'2026-01-01T00:00:04.000Z',content_json:{id:'plan-b',parent_plan_id:'plan-a',flow_id:'flow',revision:2,status:'compiled'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.execute');assert.deepEqual(next.arguments,{plan_id:'plan-b'});
  context.task_artifacts.push({artifact_type:'agent_experiment_result',type:'agent_experiment_result',task_id:'experiment-task',created_at:'2026-01-01T00:00:05.000Z',content_json:{plan_id:'plan-b',plan_revision:2,flow_id:'flow',revision:5,status:'executed'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.inspect');assert.deepEqual(next.arguments,{plan_id:'plan-b'});
  context.task_tool_invocations.push({tool_name:'bstg.test_plan.inspect',status:'completed',output_json:{plan_id:'plan-b',plan_revision:2,result_revision:5}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.assess');assert.deepEqual(next.arguments,{plan_id:'plan-b'});
  context.task_artifacts.push({id:'counterexample-proof',artifact_type:'business_state_proof',type:'business_state_proof',task_id:'experiment-task',created_at:'2026-01-01T00:00:05.500Z',content_json:{status:'counterexample'}});
  context.task_artifacts.find(item=>item.artifact_type==='agent_experiment_result'&&item.content_json.plan_id==='plan-b').content_json.counterexample_verified=true;
  context.task_artifacts.push({artifact_type:'agent_experiment_assessment',type:'agent_experiment_assessment',task_id:'experiment-task',created_at:'2026-01-01T00:00:06.000Z',content_json:{plan_id:'plan-b',plan_revision:2,result_revision:5,verdict:'not_vulnerable',native_evidence_gate:{verdict:'counterexample',counterexample_verified:true,evidence_artifact_ids:['counterexample-proof']}}});
  assert.equal(localPolicy(context).action,'complete_task');

  const terminal={...context,task_artifacts:[
    {id:'blocker-proof',artifact_type:'business_experiment_blocker',type:'business_experiment_blocker',task_id:'experiment-task',created_at:'2026-01-02T00:00:00.000Z',content_json:{reason:'The target requires an operator entitlement.'}},
    {artifact_type:'agent_experiment_plan',type:'agent_experiment_plan',task_id:'experiment-task',created_at:'2026-01-02T00:00:01.000Z',content_json:{id:'blocked-plan',flow_id:'flow',revision:1,status:'blocked',blocked_reason:'The target requires an operator entitlement.',evidence_artifact_ids:['blocker-proof']}},
    {artifact_type:'agent_experiment_assessment',type:'agent_experiment_assessment',task_id:'experiment-task',created_at:'2026-01-02T00:00:01.000Z',content_json:{plan_id:'blocked-plan',plan_revision:1,result_revision:1,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}}},
  ]};
  assert.equal(localPolicy(terminal).action,'block_task','an explicit persisted blocked outcome becomes a visible blocked task');
});

test('a transient model-decision retry returns its reservation and never replays a tool',async t=>{
  const f=await fixture(t,{agent_task_budgets:{default:1},agent_provider_turn_retries:1});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Recover temporary model decision outage',task_type:'autonomous_agent_task',execution_plan:{intent:'generic_fixture'}});
  let plannerCalls=0;
  f.runtime.planner.decide=async()=>{
    plannerCalls+=1;
    if(plannerCalls===1)throw new AgentProviderDecisionUnavailableError();
    return {action:'complete_task',source:'ai_provider',summary:'A model decision arrived after the bounded recovery.'};
  };
  const budget=new RunDecisionBudget(1);
  const used=await f.runtime.executeTask(task,budget);
  const snapshot=await f.repo.getSnapshot(f.run.id),saved=await f.repo.getTask(task.id);
  const recoveries=snapshot.artifacts.filter(item=>item.task_id===task.id&&item.artifact_type==='agent_provider_recovery');
  assert.equal(plannerCalls,2);
  assert.equal(used,1);assert.equal(budget.used,1,'the failed provider turn is returned before retrying');
  assert.equal(saved?.status,'completed');
  assert.equal(snapshot.planner_decisions.filter(item=>item.task_id===task.id).length,1,'only the successful decision is persisted');
  assert.equal(snapshot.tool_invocations.filter(item=>item.task_id===task.id).length,0,'a provider retry cannot replay a registry tool');
  assert.deepEqual(recoveries.map(item=>item.content_json.status),['retrying']);
  assert.equal(recoveries[0]?.content_json.tool_replayed,false);
});

test('exhausted temporary model decisions become a safe blocked task without consuming decision budget',async t=>{
  const f=await fixture(t,{agent_task_budgets:{default:1},agent_provider_turn_retries:1});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Bound temporary model decision outage',task_type:'autonomous_agent_task',execution_plan:{intent:'generic_fixture'}});
  let plannerCalls=0;
  f.runtime.planner.decide=async()=>{plannerCalls+=1;throw new AgentProviderDecisionUnavailableError();};
  const budget=new RunDecisionBudget(1);
  const used=await f.runtime.executeTask(task,budget);
  const snapshot=await f.repo.getSnapshot(f.run.id),saved=await f.repo.getTask(task.id);
  const recoveries=snapshot.artifacts.filter(item=>item.task_id===task.id&&item.artifact_type==='agent_provider_recovery');
  assert.equal(plannerCalls,2,'one runtime-level retry follows the client-level exhaustion');
  assert.equal(used,0);assert.equal(budget.used,0,'no model decision was returned');
  assert.equal(saved?.status,'blocked');assert.equal(saved?.phase,'provider_temporarily_unavailable');
  assert.match(saved?.error_message||'',/temporarily unavailable/i);
  assert.equal(snapshot.planner_decisions.filter(item=>item.task_id===task.id).length,0);
  assert.equal(snapshot.tool_invocations.filter(item=>item.task_id===task.id).length,0);
  assert.deepEqual(new Set(recoveries.map(item=>item.content_json.status)),new Set(['retrying','exhausted']));
  assert.ok(recoveries.every(item=>item.content_json.tool_replayed===false));
});
