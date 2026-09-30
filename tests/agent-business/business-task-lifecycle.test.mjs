/** Scheduler/contract tests with native in-memory SQLite and explicit inert
 * tool/planner doubles. No target, browser, provider, or network is used. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {blockFailedDependencies} from '../../server/src/agent/dependency-finalization.ts';
import {localPolicy} from '../../server/src/agent/autonomous-planner.ts';
import {buildAutonomousAgentContext} from '../../server/src/agent/context-builder.ts';
import {saveBusinessFlow,newBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {buildBusinessLearningToolSpecs} from '../../server/src/agent/tools/business-learning-tools.ts';
import {BUSINESS_PLAN_INTENT,BUSINESS_LEARNING_INTENT,BUSINESS_REVIEW_INTENT,BUSINESS_EXPERIMENT_INTENT,scheduleBusinessLearning,scheduleBusinessExperiments,latestBusinessFlows,businessCompletionGap,businessExperimentCompletionGap,businessPlanningCompletionGap} from '../../server/src/agent/business-task-lifecycle.ts';

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

test('Web bootstrap inserts formal business plan and review stages; legacy opt-out and Android preserve their graph',async t=>{
  for(const [config,enabled] of [[{},true],[{business_learning:false},false],[{surface:'android'},false]]){
    const f=await fixture(t,config);await f.runtime.bootstrapRun(f.run);await f.runtime.bootstrapRun(f.run);const tasks=await f.repo.listTasks(f.run.id);
    const planning=tasks.find(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT),review=tasks.find(task=>task.execution_plan.intent===BUSINESS_REVIEW_INTENT);
    const discovery=tasks.find(task=>task.execution_plan.intent==='discover_target'),modeling=tasks.find(task=>task.execution_plan.intent==='model_features_and_candidates');
    assert.equal(Boolean(planning),enabled);assert.equal(Boolean(review),enabled);
    assert.deepEqual(modeling.dependencies,[enabled?review.id:discovery.id]);
    assert.equal(tasks.filter(task=>task.execution_plan.intent===BUSINESS_PLAN_INTENT).length,enabled?1:0);
  }
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
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_result',source_ref:'plan-a',title:'Result',content_json:{plan_id:'plan-a',plan_revision:2,revision:1,status:'executed',native_test_run_ids:[control.id,experiment.id],control_test_run_id:control.id,experiment_test_run_id:experiment.id,execution_verified:false,evidence_ready:false,evidence_artifact_ids:[controlTrace.id,experimentTrace.id]}});
  let artifacts=await f.repo.listArtifacts(f.run.id);assert.match(await businessExperimentCompletionGap(task,artifacts,f.db),/not inspected and assessed/);
  await f.repo.createArtifact({scan_run_id:f.run.id,task_id:task.id,artifact_type:'agent_experiment_assessment',source_ref:'plan-a',title:'Counterexample assessment',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:1,verdict:'not_vulnerable'}});
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

test('normal task cannot complete by model claim and can adapt after a failed validation result',async t=>{
  const f=await fixture(t,{agent_task_budgets:{learn_business_flow:8}});
  const flow=newBusinessFlow({name:'Details',goal:'Saved display name matches the submitted value',role:'anonymous'});
  const task=await f.repo.createTask({scan_run_id:f.run.id,title:'Normal learning',task_type:'learn_business_flow',execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id}});
  await saveBusinessFlow(f.repo,f.run.id,task.id,flow);
  const registry=new AgentToolRegistry();let validations=0;
  registry.register({name:'bstg.business.workflow.validate',description:'Explicit inert native-validation result fixture.',input_schema:{},handler:async()=>{
    validations++;const verified=validations===2;
    await saveBusinessFlow(f.repo,f.run.id,task.id,{...flow,status:verified?'verified':'failed',normal_run_id:'fixture-native-result',assertions_verified:verified,evidence_artifact_ids:['fixture-result'],blockers:verified?[]:['Observed state mismatch']});
    // This matches the real wrapper: native execution completed, but its
    // semantic business result is false. Runtime must adapt on the fact, not
    // only when a transport wrapper reports ok:false.
    return {ok:true,data:{verified,test_run_id:'fixture-native-result',assertions:[{passed:verified}],summary:verified?'Fixture verifier passed':'Fixture verifier observed a mismatch'}};
  }});
  f.runtime.registry=registry;const phases=[];const runtimeRepo=f.runtime.getRepository(),updateTask=runtimeRepo.updateTask.bind(runtimeRepo);
  runtimeRepo.updateTask=async(id,patch)=>{if(id===task.id&&patch.phase)phases.push(patch.phase);return updateTask(id,patch);};let decisions=0;
  f.runtime.planner.decide=async()=>{decisions++;return decisions===1||decisions===4?{action:'complete_task',source:'local_policy'}:{action:'tool_call',tool_name:'bstg.business.workflow.validate',arguments:{},source:'local_policy'};};
  const result=await f.runtime.run(f.run.id,{max_steps:8});assert.equal(validations,2);assert.equal(decisions,4);
  assert.equal(result.snapshot.tasks.find(item=>item.id===task.id).status,'completed');
  assert.ok(phases.includes('normal_validation_requires_adaptation'),'verified:false must enter adaptation even when the tool call itself completed');
  assert.equal(result.snapshot.artifacts.filter(item=>item.artifact_type==='business_completion_gap').length,1);
  assert.equal(latestBusinessFlows(result.snapshot.artifacts)[0].assertions_verified,true);
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

test('normal planner does not let an earlier Workflow inspection authorize a newer execution snapshot',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow'},task_type:'learn_business_flow'},selected_vuln_types:[],task_tool_invocations:[
    {tool_name:'bstg.business.workflow.inspect',status:'completed',output_json:{workflow_id:'old-workflow'}},
  ],feature_tree:[],business_flows:[{id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'failed',workflow_id:'new-workflow'}]};
  const next=localPolicy(context);assert.equal(next.tool_name,'bstg.business.workflow.inspect');assert.deepEqual(next.arguments,{workflow_id:'new-workflow'});
});

test('planner treats the persisted flat capture.stop status as ready for workflow preparation',()=>{
  const context={scan:{base_url:'http://unused',scan_config:{}},task:{execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:'flow'},task_type:'learn_business_flow'},selected_vuln_types:[],task_tool_invocations:[
    {tool_name:'bstg.business.capture.stop',status:'completed',output_json:{recording_session_id:'recording',status:'stopped'}},
  ],feature_tree:[],business_flows:[{id:'flow',name:'Details',goal:'Saved state',role:'anonymous',status:'learning',recording_session_id:'recording'}]};
  const next=localPolicy(context);assert.equal(next.tool_name,'bstg.business.workflow.prepare');assert.deepEqual(next.arguments,{recording_session_id:'recording'});
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
      {type:'agent_experiment_assessment',created_at:'2026-01-01T00:00:01.000Z',content_json:{plan_id:'plan-a',plan_revision:2,result_revision:7}},
    ]};
  let next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.execute');assert.deepEqual(next.arguments,{plan_id:'plan-a'});
  context.task_artifacts.push({type:'agent_experiment_result',created_at:'2026-01-03T00:00:00.000Z',content_json:{plan_id:'plan-a',plan_revision:3,revision:8,status:'executed'}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.inspect','an old inspect invocation cannot satisfy the current execution result');
  context.task_tool_invocations.push({tool_name:'bstg.test_plan.inspect',status:'completed',output_json:{plan_id:'plan-a',plan_revision:3,result_revision:8}});
  next=localPolicy(context);assert.equal(next.tool_name,'bstg.test_plan.assess');assert.deepEqual(next.arguments,{plan_id:'plan-a'});
  context.task_artifacts.push({type:'agent_experiment_assessment',created_at:'2026-01-03T00:00:01.000Z',content_json:{plan_id:'plan-a',plan_revision:3,result_revision:8}});
  assert.equal(localPolicy(context).action,'complete_task');
});
