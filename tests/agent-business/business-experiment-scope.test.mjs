import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { newBusinessFlow, saveBusinessFlow } from '../../server/src/services/ai-scan/agent-business-contract.ts';
import { assessBusinessExperiment, compileBusinessExperiment, executeBusinessExperiment, inspectBusinessExperiment, planBusinessExperiment } from '../../server/src/services/ai-scan/agent-business-experiment.ts';
import { buildBusinessFlowToolSpecs } from '../../server/src/agent/tools/business-agent-tools.ts';
import { buildBusinessLearningToolSpecs } from '../../server/src/agent/tools/business-learning-tools.ts';
import { buildNativeAssetToolSpecs } from '../../server/src/agent/tools/native-asset-tools.ts';
import { BUSINESS_EXPERIMENT_INTENT } from '../../server/src/agent/business-task-lifecycle.ts';

async function fixture(t){
  const db=await database();t.after(()=>db.disconnect());
  const repo=new AIScanRepository(db);
  const run=await repo.createRun({base_url:'https://authorized.example.test'});
  const normalTask=await repo.createTask({scan_run_id:run.id,title:'Normal owner',task_type:'learn_business_flow'});
  const [currentWorkflow,otherWorkflow]=await Promise.all(['Current','Sibling'].map(name=>db.repos.workflows.create({name:`${name} workflow`,is_active:true,
    assertion_strategy:'all_steps_pass',account_binding_strategy:'independent',enable_baseline:false,baseline_config:{capture_replay_only:true},
    enable_extractor:false,enable_session_jar:false,session_jar_config:{cookie_mode:true},workflow_type:'baseline',learning_status:'learned',learning_version:1,template_mode:'snapshot'})));
  const [currentRun,otherRun]=await Promise.all([currentWorkflow,otherWorkflow].map(workflow=>db.repos.testRuns.create({name:`${workflow.name} run`,status:'completed',execution_type:'workflow',trigger_type:'fixture',
    workflow_id:workflow.id,rule_ids:[],template_ids:[],account_ids:[],progress_percent:100,execution_params:{scan_run_id:run.id}})));
  const current=newBusinessFlow({name:'Current flow',goal:'Current saved state is visible'},normalTask.id);
  const other=newBusinessFlow({name:'Sibling flow',goal:'Sibling saved state is visible'},normalTask.id);
  Object.assign(current,{status:'verified',assertions_verified:true,workflow_id:currentWorkflow.id,normal_run_id:currentRun.id});
  Object.assign(other,{status:'verified',assertions_verified:true,workflow_id:otherWorkflow.id,normal_run_id:otherRun.id});
  await saveBusinessFlow(repo,run.id,normalTask.id,current);
  await saveBusinessFlow(repo,run.id,normalTask.id,other);
  await repo.updateTask(normalTask.id,{execution_plan:{intent:'learn_business_flow',flow_id:current.id}});
  const task=await repo.createTask({scan_run_id:run.id,title:'Bound security experiment',task_type:'model_business_experiment',
    execution_plan:{intent:BUSINESS_EXPERIMENT_INTENT,flow_id:current.id}});
  await repo.createArtifact({scan_run_id:run.id,task_id:normalTask.id,artifact_type:'agent_experiment_plan',source_ref:'sibling-plan',title:'Sibling plan',content_json:{
    id:'sibling-plan',revision:1,flow_id:other.id,source_flow_revision:1,status:'planned',evidence_artifact_ids:[],
  }});
  return {db,repo,run,task,normalTask,current,other,currentWorkflow,otherWorkflow,context:{db,repo,scanRunId:run.id,taskId:task.id}};
}

test('security experiment tools cannot cross the scheduler-bound flow or plan boundary',async t=>{
  const f=await fixture(t);
  const denied=/different task flow/;
  await assert.rejects(planBusinessExperiment(f.context,{flow_id:f.other.id}),denied);
  await assert.rejects(compileBusinessExperiment(f.context,{plan_id:'sibling-plan'}),denied);
  await assert.rejects(executeBusinessExperiment(f.context,{plan_id:'sibling-plan'}),denied);
  await assert.rejects(inspectBusinessExperiment(f.context,'sibling-plan'),denied);
  await assert.rejects(assessBusinessExperiment(f.context,{plan_id:'sibling-plan'}),denied);

  const flowInspect=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.flow.inspect');
  const handlesInspect=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.object_handles.inspect');
  const workflowInspect=buildBusinessLearningToolSpecs().find(tool=>tool.name==='bstg.business.workflow.inspect');
  const nativeWorkflowInspect=buildNativeAssetToolSpecs().find(tool=>tool.name==='bstg.workflow.inspect');
  const assetsSearch=buildNativeAssetToolSpecs().find(tool=>tool.name==='bstg.assets.search');
  assert.ok(flowInspect&&handlesInspect&&workflowInspect&&nativeWorkflowInspect&&assetsSearch);
  const [flowResult,handlesResult,workflowResult,nativeWorkflowResult]=await Promise.all([
    flowInspect.handler({flow_id:f.other.id},f.context),
    handlesInspect.handler({flow_id:f.other.id},f.context),
    workflowInspect.handler({workflow_id:f.otherWorkflow.id},f.context),
    nativeWorkflowInspect.handler({workflow_id:f.otherWorkflow.id},f.context),
  ]);
  for(const result of [flowResult,handlesResult,workflowResult,nativeWorkflowResult]){
    assert.equal(result.ok,false);
    assert.match(String(result.error),/(different task flow|current task flow workflow|current task flow)/);
  }

  const own=await flowInspect.handler({flow_id:f.current.id},f.context);
  assert.equal(own.ok,true,JSON.stringify(own));
  assert.deepEqual(own.data.prepared_identity_roles,['normal'],'model experiments receive the exact executable identity roles available to this flow');
  const ownWorkflow=await nativeWorkflowInspect.handler({workflow_id:f.currentWorkflow.id},f.context);
  assert.equal(ownWorkflow.ok,true,JSON.stringify(ownWorkflow));
  const assets=await assetsSearch.handler({kind:'all'},f.context);
  assert.equal(assets.ok,true,JSON.stringify(assets));
  const serialized=JSON.stringify(assets.data);
  assert.equal(serialized.includes(f.otherWorkflow.id),false,'security asset search cannot list a sibling workflow');
  assert.equal(serialized.includes('sibling-plan'),false,'security asset search cannot list a sibling plan');
  const learningAssets=await assetsSearch.handler({kind:'all'},{...f.context,taskId:f.normalTask.id});
  assert.equal(learningAssets.ok,true,JSON.stringify(learningAssets));
  const learningSerialized=JSON.stringify(learningAssets.data);
  assert.equal(learningSerialized.includes(f.otherWorkflow.id),false,'normal learning asset search cannot list a sibling workflow');
  assert.equal(learningSerialized.includes('sibling-plan'),false,'normal learning asset search cannot list a sibling plan');
});
