import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {buildBusinessFlowToolSpecs} from '../../server/src/agent/tools/business-agent-tools.ts';
import {buildBusinessLearningToolSpecs} from '../../server/src/agent/tools/business-learning-tools.ts';
import {normalBusinessObjectiveManifest} from '../../server/src/agent/normal-business-objectives.ts';
import {BUSINESS_PLAN_INTENT} from '../../server/src/agent/business-task-lifecycle.ts';
import {DEFAULT_NORMAL_OBJECTIVES} from '../product-experience/business-learning-acceptance.mjs';

test('strict normal objectives are server-sealed, chosen by ID, and required before planning coverage saves',async t=>{
  const db=await database();t.after(()=>db.disconnect());
  const repo=new AIScanRepository(db);
  const manifest=normalBusinessObjectiveManifest({business_learning:{normal_objectives:[
    {label:'Sign in with a supplied account and observe the authenticated landing state',completion:{required_response_paths:['body.user_id']}},
    'Update the profile and observe the saved profile state',
  ]}});
  assert.equal(manifest.length,2);
  assert.ok(manifest.every(objective=>/^objective:[a-f0-9]{24}$/.test(objective.id)));
  assert.deepEqual(manifest[0].completion,{required_response_paths:['body.user_id']});
  const run=await repo.createRun({base_url:'https://authorized.example.test',scan_config:{surface:'web'}});
  const plan=await repo.createTask({scan_run_id:run.id,title:'Strict normal plan',task_type:'plan_business_flows',
    execution_plan:{intent:BUSINESS_PLAN_INTENT,strict_normal_objectives:true,normal_objective_manifest:manifest}});
  const context={db,repo,scanRunId:run.id,taskId:plan.id};
  const define=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.flow.define');
  const coverage=buildBusinessLearningToolSpecs().find(tool=>tool.name==='bstg.business.coverage.save');
  assert.ok(define&&coverage);

  const rejected=await define.handler({name:'model supplied name',goal:'model supplied goal',role:'anonymous'},context);
  assert.equal(rejected.ok,false);
  assert.match(rejected.error,/objective_id from the immutable planning manifest/i);

  const first=await define.handler({objective_id:manifest[0].id,name:'ignored renamed flow',goal:'ignored renamed goal',role:'anonymous'},context);
  assert.equal(first.ok,true,first.error);
  assert.equal(first.data.objective_id,manifest[0].id);
  const firstArtifact=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_flow');
  assert.equal(firstArtifact.content_json.name,manifest[0].label);
  assert.equal(firstArtifact.content_json.goal,manifest[0].label);
  assert.equal(firstArtifact.content_json.objective_id,manifest[0].id);
  assert.deepEqual(firstArtifact.content_json.objective_completion,manifest[0].completion,
    'flow definition copies only the server-owned completion contract selected by immutable objective ID');

  const duplicate=await define.handler({objective_id:manifest[0].id,role:'anonymous'},context);
  assert.equal(duplicate.ok,false);
  assert.match(duplicate.error,/already has a saved Flow/i);
  const incompleteCoverage=await coverage.handler({entries:[]},context);
  assert.equal(incompleteCoverage.ok,false);
  assert.match(incompleteCoverage.error,/requires exactly one saved Flow/i);

  const second=await define.handler({objective_id:manifest[1].id,role:'anonymous'},context);
  assert.equal(second.ok,true,second.error);
  const savedCoverage=await coverage.handler({entries:[]},context);
  assert.equal(savedCoverage.ok,true,savedCoverage.error);
  const coverageArtifact=(await repo.listArtifacts(run.id)).find(artifact=>artifact.artifact_type==='business_flow_coverage');
  assert.deepEqual(coverageArtifact.content_json.normal_objective_manifest,manifest,
    'coverage receipt copies the immutable task-owned manifest rather than model input');
});

test('five strict objectives survive planning, schedule five learning flows, and remain a receipt-only public projection',async t=>{
  const db=await database();t.after(()=>db.disconnect());
  const repo=new AIScanRepository(db);
  const {AIScanAgentRuntime}=await import('../../server/src/agent/agent-runtime.ts');
  const {scheduleBusinessLearning}=await import('../../server/src/agent/business-task-lifecycle.ts');
  const {buildPublicTechnicalSnapshot}=await import('../../server/src/services/ai-scan/public-technical-snapshot.ts');
  const objectives=[{label:'Log in and observe the signed-in home state',completion:{required_response_paths:['body.user_id']}},'Update profile and observe saved state','Add an item to cart','Place a normal order','Create and verify a private note'];
  const run=await repo.createRun({base_url:'https://authorized.example.test/private/hidden-route',scan_config:{surface:'web',business_learning:{mode:'normal_only',normal_objectives:objectives}}});
  await new AIScanAgentRuntime(db).bootstrapRun(run);
  const plan=(await repo.listTasks(run.id)).find(task=>task.execution_plan?.intent===BUSINESS_PLAN_INTENT);
  assert.ok(plan);
  const manifest=plan.execution_plan.normal_objective_manifest;
  assert.equal(manifest.length,5);
  assert.equal(plan.execution_plan.strict_normal_objectives,true);
  const define=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.flow.define');
  const coverage=buildBusinessLearningToolSpecs().find(tool=>tool.name==='bstg.business.coverage.save');
  assert.ok(define&&coverage);
  for(const objective of manifest){
    const result=await define.handler({objective_id:objective.id,role:'anonymous'}, {db,repo,scanRunId:run.id,taskId:plan.id});
    assert.equal(result.ok,true,result.error);
  }
  const saved=await coverage.handler({entries:[]},{db,repo,scanRunId:run.id,taskId:plan.id});
  assert.equal(saved.ok,true,saved.error);
  const learning=await scheduleBusinessLearning(repo,plan);
  assert.equal(learning.length,5);
  assert.equal(new Set(learning.map(task=>task.execution_plan.flow_id)).size,5);
  const objectiveByFlow=new Map((await repo.listArtifacts(run.id)).filter(artifact=>artifact.artifact_type==='business_flow').map(artifact=>[
    artifact.content_json?.id||artifact.source_ref,artifact.content_json?.objective_id,
  ]));
  assert.deepEqual(learning.map(task=>objectiveByFlow.get(task.execution_plan.flow_id)),manifest.map(objective=>objective.id),
    'strict normal learning follows the explicit immutable objective order instead of reverse artifact order');
  assert.deepEqual(learning.map(task=>task.priority),[25,26,27,28,29],
    'serial normal learning uses deterministic priorities so prerequisite-producing objectives run first');

  await repo.createArtifact({scan_run_id:run.id,task_id:learning[0].id,artifact_type:'business_workflow_validation',source_ref:'run-receipt',title:'Private validation',content_json:{
    flow_id:learning[0].execution_plan.flow_id,normal_run_id:'run-receipt',raw_request:'secret-request-body',response_body_text:'secret-response-body',path:'/private/hidden-route',assertions_verified:true,
  }});
  const publicSnapshot=buildPublicTechnicalSnapshot(await repo.getSnapshot(run.id));
  const publicPlan=publicSnapshot.tasks.find(task=>task.id===plan.id);
  assert.deepEqual(publicPlan.execution_plan.normal_objective_manifest.map(item=>item.id),manifest.map(item=>item.id));
  assert.deepEqual(publicPlan.execution_plan.normal_objective_manifest[0].completion,{required_response_paths:['body.user_id']},
    'the public receipt retains only the value-free completion field shape for an immutable objective');
  const wire=JSON.stringify(publicSnapshot);
  for(const privateValue of ['secret-request-body','secret-response-body','/private/hidden-route'])assert.equal(wire.includes(privateValue),false,
    'public objective/TestRun projection must keep private transport and target paths out of the acceptance envelope');
  assert.ok(wire.includes('run-receipt'),'public projection retains the opaque native run receipt.');
});

test('strict lifecycle gate rejects a directly persisted partial coverage artifact',async t=>{
  const db=await database();t.after(()=>db.disconnect());const repo=new AIScanRepository(db);
  const {newBusinessFlow,saveBusinessFlow}=await import('../../server/src/services/ai-scan/agent-business-contract.ts');
  const {businessPlanningCompletionGap,latestBusinessFlows}=await import('../../server/src/agent/business-task-lifecycle.ts');
  const manifest=normalBusinessObjectiveManifest({business_learning:{normal_objectives:['First required normal outcome','Second required normal outcome']}});
  const run=await repo.createRun({base_url:'https://authorized.example.test',scan_config:{surface:'web'}});
  const plan=await repo.createTask({scan_run_id:run.id,title:'Strict plan',task_type:'plan_business_flows',execution_plan:{
    intent:BUSINESS_PLAN_INTENT,strict_normal_objectives:true,normal_objective_manifest:manifest,
  }});
  const flow=newBusinessFlow({name:manifest[0].label,goal:manifest[0].label,objective_id:manifest[0].id,role:'anonymous'},plan.id);
  await saveBusinessFlow(repo,run.id,plan.id,flow);
  await repo.createArtifact({scan_run_id:run.id,task_id:plan.id,artifact_type:'business_flow_coverage',source_ref:plan.id,title:'Bypass attempt',content_json:{
    revision:1,plan_task_id:plan.id,target_manifest:[],entries:[],
  }});
  const artifacts=await repo.listArtifacts(run.id);
  const gap=await businessPlanningCompletionGap(repo,plan,latestBusinessFlows(artifacts),artifacts);
  assert.match(gap,/requires exactly one current saved Flow/i);
});

test('a strict prepared-identity objective rejects anonymous and unprepared roles, then seals one scan-bound prepared identity',async t=>{
  const db=await database();t.after(()=>db.disconnect());
  const repo=new AIScanRepository(db);
  const manifest=normalBusinessObjectiveManifest({business_learning:{normal_objectives:[
    {label:'Authenticate with a supplied test identity',requires_prepared_identity:true},
  ]}});
  assert.equal(manifest[0].requires_prepared_identity,true);
  const run=await repo.createRun({base_url:'https://authorized.example.test',scan_config:{surface:'web',accounts:{configured_only:{username:'configured',password:'not-persisted'}}}});
  const plan=await repo.createTask({scan_run_id:run.id,title:'Prepared identity plan',task_type:'plan_business_flows',execution_plan:{
    intent:BUSINESS_PLAN_INTENT,strict_normal_objectives:true,normal_objective_manifest:manifest,
  }});
  const context={db,repo,scanRunId:run.id,taskId:plan.id};
  const define=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.flow.define');assert.ok(define);
  const anonymous=await define.handler({objective_id:manifest[0].id,role:'anonymous'},context);
  assert.equal(anonymous.ok,true,anonymous.error);assert.equal(anonymous.data.status,'identity_key_required');
  assert.equal(anonymous.data.requires_prepared_identity,true);assert.deepEqual(anonymous.data.allowed_identity_keys,[]);
  const configured=await define.handler({objective_id:manifest[0].id,role:'configured_only'},context);
  assert.equal(configured.ok,true,configured.error);assert.equal(configured.data.status,'identity_key_required',
    'configured material alone is not a prepared scan-bound browser identity');
  await db.repos.accounts.create({name:'Prepared test role',username:'machine-user',status:'active',
    tags:['ai_scan',`scan:${run.id}`,'role:test_role'],fields:{username:'machine-user',password:'machine-password'},variables:{},auth_profile:{}});
  const accepted=await define.handler({objective_id:manifest[0].id,role:'test_role'},context);
  assert.equal(accepted.ok,true,accepted.error);assert.equal(accepted.data.requires_prepared_identity,true);
  const flow=(await repo.listArtifacts(run.id)).find(item=>item.artifact_type==='business_flow')?.content_json;
  assert.equal(flow?.requires_prepared_identity,true);assert.equal(flow?.role,'test_role');
  const {buildPublicTechnicalSnapshot}=await import('../../server/src/services/ai-scan/public-technical-snapshot.ts');
  const projected=buildPublicTechnicalSnapshot(await repo.getSnapshot(run.id));
  const publicPlan=projected.tasks.find(task=>task.id===plan.id);
  const publicFlow=projected.artifacts.find(item=>item.artifact_type==='business_flow')?.content_json;
  assert.equal(publicPlan?.execution_plan?.normal_objective_manifest?.[0]?.requires_prepared_identity,true);
  assert.equal(publicFlow?.requires_prepared_identity,true,'safe receipts retain the declarative prerequisite without exposing account material');
});

test('every protected default acceptance objective rejects anonymous planning and seals the prepared fixture identity',async t=>{
  const db=await database();t.after(()=>db.disconnect());
  const repo=new AIScanRepository(db);
  const manifest=normalBusinessObjectiveManifest({business_learning:{normal_objectives:DEFAULT_NORMAL_OBJECTIVES}});
  assert.equal(manifest.length,5);
  assert.ok(manifest.every(objective=>objective.requires_prepared_identity===true),
    'the disposable acceptance fixture exposes every normal business action only after sign-in');
  const run=await repo.createRun({base_url:'https://authorized.example.test',scan_config:{surface:'web'}});
  const plan=await repo.createTask({scan_run_id:run.id,title:'Protected acceptance objectives',task_type:'plan_business_flows',execution_plan:{
    intent:BUSINESS_PLAN_INTENT,strict_normal_objectives:true,normal_objective_manifest:manifest,
  }});
  await db.repos.accounts.create({name:'Fixture prepared identity',username:'fixture-user',status:'active',
    tags:['ai_scan',`scan:${run.id}`,'role:fixture_user'],fields:{username:'fixture-user',password:'fixture-password'},variables:{},auth_profile:{}});
  const context={db,repo,scanRunId:run.id,taskId:plan.id};
  const define=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.flow.define');assert.ok(define);
  for(const objective of manifest){
    const anonymous=await define.handler({objective_id:objective.id,role:'anonymous'},context);
    assert.equal(anonymous.ok,true,anonymous.error);
    assert.equal(anonymous.data.status,'identity_key_required',objective.label);
    assert.equal(anonymous.data.requires_prepared_identity,true,objective.label);
    assert.deepEqual(anonymous.data.allowed_identity_keys,['fixture_user'],objective.label);
    const accepted=await define.handler({objective_id:objective.id,role:'fixture_user'},context);
    assert.equal(accepted.ok,true,accepted.error);
    assert.equal(accepted.data.requires_prepared_identity,true,objective.label);
    assert.equal(accepted.data.role,'fixture_user',objective.label);
  }
});

test('sealed operation contracts reject duplicate-label conflicts and keep private route shapes out of public receipts',async t=>{
  const db=await database();t.after(()=>db.disconnect());
  assert.throws(()=>normalBusinessObjectiveManifest({business_learning:{normal_objectives:[
    {label:'Create note',operation:{method:'POST',route_shape:'/internal/create-note',side_effect_class:'create'}},
    {label:'Create note',operation:{method:'POST',route_shape:'/internal/other-note',side_effect_class:'create'}},
  ]}}),/conflicting sealed operation contracts/i);
  const repo=new AIScanRepository(db),manifest=normalBusinessObjectiveManifest({business_learning:{normal_objectives:[
    {label:'Create note',operation:{method:'POST',route_shape:'/internal/create-note',side_effect_class:'create'}},
  ]}});
  const run=await repo.createRun({base_url:'https://authorized.example.test'}),plan=await repo.createTask({scan_run_id:run.id,title:'Operation receipt',task_type:'plan_business_flows',execution_plan:{intent:BUSINESS_PLAN_INTENT,strict_normal_objectives:true,normal_objective_manifest:manifest}});
  const define=buildBusinessFlowToolSpecs().find(tool=>tool.name==='bstg.business.flow.define');assert.ok(define);
  const result=await define.handler({objective_id:manifest[0].id,role:'anonymous'},{db,repo,scanRunId:run.id,taskId:plan.id});assert.equal(result.ok,true,result.error);
  const {buildPublicTechnicalSnapshot}=await import('../../server/src/services/ai-scan/public-technical-snapshot.ts');
  const publicSnapshot=buildPublicTechnicalSnapshot(await repo.getSnapshot(run.id)),wire=JSON.stringify(publicSnapshot);
  assert.equal(wire.includes('/internal/create-note'),false,'route matcher remains server-private in public receipts');
  assert.ok(wire.includes(manifest[0].operation.operation_id),'the opaque sealed operation reference remains auditable');
  assert.ok(wire.includes('create'),'the value-free effect class remains auditable');
});
