import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {assertExperimentRunTerminal,assertHttpsExperimentEvidence,collectTerminalExperimentEvidence} from './business-experiment-real-model-acceptance.mjs';
import {fetchJsonWithProgressRetry} from './business-learning-acceptance.mjs';
import {assertHttpsExperimentBlockedEvidence} from './business-experiment-real-model-acceptance.mjs';

const model='gpt-5.6-terra';
const tools=[
  'bstg.business.flow.inspect',
  'bstg.workflow.inspect',
  'bstg.test_plan.create',
  'bstg.test_plan.compile',
  'bstg.test_plan.execute',
  'bstg.test_plan.inspect',
  'bstg.test_plan.assess',
];
const blockTool='bstg.test_plan.block';

function artifact(id,type,taskId,content,sourceRef){
  return {id,artifact_type:type,task_id:taskId,source_ref:sourceRef,created_at:'2026-01-01T00:00:00.000Z',content_json:content};
}

function receipt(){
  const taskId='experiment-task-1',flowId='flow-1',planId='plan-1';
  return {
    technical:{
      run:{base_url:'https://authorized.example.test'},
      tasks:[{id:taskId,status:'completed',execution_plan:{intent:'model_business_experiment',flow_id:flowId}}],
      artifacts:[
        artifact('flow-artifact','business_flow','normal-task',{id:flowId,revision:3,status:'verified',assertions_verified:true,captured_transport_verified_https:true,transport_verified_https:true}),
        artifact('plan-artifact','agent_experiment_plan',taskId,{id:planId,revision:2,flow_id:flowId,status:'compiled',evidence_artifact_ids:['compilation-artifact']},planId),
        artifact('compilation-artifact','agent_experiment_compilation',taskId,{plan_id:planId,plan_revision:2,flow_id:flowId,model_directed:true},planId),
        artifact('result-artifact','agent_experiment_result',taskId,{revision:4,plan_id:planId,plan_revision:2,flow_id:flowId,status:'executed',
          native_test_run_ids:['control-run','experiment-run'],control_test_run_id:'control-run',experiment_test_run_id:'experiment-run',
          evidence_artifact_ids:['control-trace','experiment-trace']},planId),
        artifact('control-trace','agent_experiment_native_trace',taskId,{plan_id:planId,plan_revision:2,kind:'control',test_run_id:'control-run'},'control-run'),
        artifact('experiment-trace','agent_experiment_native_trace',taskId,{plan_id:planId,plan_revision:2,kind:'experiment',test_run_id:'experiment-run'},'experiment-run'),
        artifact('assessment-artifact','agent_experiment_assessment',taskId,{plan_id:planId,plan_revision:2,result_revision:4,verdict:'not_vulnerable',native_evidence_gate:{verdict:'counterexample'}},planId),
        ...tools.map((tool,index)=>artifact('decision-'+index,'agent_decision',taskId,{source:'ai_provider',model,provider_response_id:'receipt-'+index,tool_name:tool,validation_status:'accepted'})),
      ],
    },
    productState:{run:{status:'completed'}},
    fixtureState:{transport:'https'},
    provider:{model},
  };
}

test('complete HTTPS experiment oracle requires one linked model lifecycle per verified Flow',()=>{
  const data=receipt();
  const result=assertHttpsExperimentEvidence(data);
  assert.deepEqual(result,{verified_https_normal_flows:1,completed_model_experiments:1,native_experiment_pairs:1,provider_decisions:7,experiment_model_decisions:7});
});

test('complete HTTPS experiment oracle accepts fresh child plans after earlier inconclusive native results',()=>{
  const data=receipt(),taskId='experiment-task-1',flowId='flow-1';
  const currentPlan=data.technical.artifacts.find(item=>item.id==='plan-artifact').content_json;
  currentPlan.parent_plan_id='plan-root';
  const currentResult=data.technical.artifacts.find(item=>item.id==='result-artifact').content_json;
  currentResult.revision=2;
  const currentAssessment=data.technical.artifacts.find(item=>item.id==='assessment-artifact').content_json;
  currentAssessment.result_revision=2;
  currentAssessment.verdict='vulnerable';
  currentAssessment.native_evidence_gate={verdict:'confirmed'};
  data.technical.artifacts.push(
    artifact('root-plan-artifact','agent_experiment_plan',taskId,{id:'plan-root',revision:1,flow_id:flowId,status:'compiled',evidence_artifact_ids:['root-compilation']},'plan-root'),
    artifact('root-compilation','agent_experiment_compilation',taskId,{plan_id:'plan-root',plan_revision:1,flow_id:flowId,model_directed:true},'plan-root'),
    artifact('root-result','agent_experiment_result',taskId,{revision:1,plan_id:'plan-root',plan_revision:1,flow_id:flowId,status:'executed',
      native_test_run_ids:['root-control-run','root-experiment-run'],control_test_run_id:'root-control-run',experiment_test_run_id:'root-experiment-run',
      evidence_artifact_ids:['root-control-trace','root-experiment-trace']},'plan-root'),
    artifact('root-control-trace','agent_experiment_native_trace',taskId,{plan_id:'plan-root',plan_revision:1,kind:'control',test_run_id:'root-control-run'},'root-control-run'),
    artifact('root-experiment-trace','agent_experiment_native_trace',taskId,{plan_id:'plan-root',plan_revision:1,kind:'experiment',test_run_id:'root-experiment-run'},'root-experiment-run'),
    artifact('root-assessment','agent_experiment_assessment',taskId,{plan_id:'plan-root',plan_revision:1,result_revision:1,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}},'plan-root'),
  );
  const result=assertHttpsExperimentEvidence(data);
  assert.equal(result.native_experiment_pairs,2);
  assert.equal(result.completed_model_experiments,1);
});

test('secure fixture outcomes cannot support a confirmed product finding',()=>{
  const data=receipt();
  data.fixtureState.mode='secure';
  data.productState.totals={confirmed_risks:1};
  assert.throws(()=>assertHttpsExperimentEvidence(data),/independent secure fixture oracle/);
});

test('terminal experiment collection persists the existing safe projections before a later oracle verdict',async()=>{
  const expected={technical:{run:{current_phase:'assessment'}},productState:{run:{status:'failed'}},fixtureState:{transport:'https',metrics:{}}};
  const calls=[];
  const context={collect:async runId=>{calls.push(runId);return expected;}};
  assert.equal(await collectTerminalExperimentEvidence(context,'opaque-run','failed'),expected);
  assert.deepEqual(calls,['opaque-run']);
  await assert.rejects(collectTerminalExperimentEvidence(context,'opaque-run','running'),/terminal product run status/);
  assert.deepEqual(calls,['opaque-run']);
});

test('real-model experiment acceptance stops before its oracle when the run is still active at deadline',()=>{
  assert.throws(()=>assertExperimentRunTerminal('running'),/did not reach a terminal product status/);
  assert.doesNotThrow(()=>assertExperimentRunTerminal('completed'));
  assert.doesNotThrow(()=>assertExperimentRunTerminal('failed'));
});

test('progress reads retry a local request timeout while the outer acceptance deadline remains',async t=>{
  let requests=0;
  const server=http.createServer((_request,response)=>{
    requests+=1;
    if(requests===1){
      // Leave enough room for local scheduling while making the first response
      // deterministically exceed the request budget.
      const timer=setTimeout(()=>{if(!response.destroyed)response.end(JSON.stringify({attempt:1}));},700);
      response.on('close',()=>clearTimeout(timer));
      return;
    }
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({attempt:requests}));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));

  const result=await fetchJsonWithProgressRetry(`http://127.0.0.1:${server.address().port}/progress`,undefined,Date.now()+2000,
    'Read acceptance progress',{attempts:2,requestTimeoutMs:250});
  assert.equal(result.response.status,200);
  assert.deepEqual(result.json,{attempt:2});
  assert.equal(requests,2);
});

test('complete HTTPS experiment oracle rejects artifacts spliced across tasks',()=>{
  const data=receipt();
  data.technical.artifacts.find(item=>item.id==='result-artifact').task_id='other-task';
  assert.throws(()=>assertHttpsExperimentEvidence(data),/lacks an executed native result/);
});

test('complete HTTPS experiment oracle does not credit a rejected model proposal as lifecycle ownership',()=>{
  const data=receipt();
  data.technical.artifacts.find(item=>item.id==='decision-2').content_json.validation_status='rejected';
  assert.throws(()=>assertHttpsExperimentEvidence(data),/did not invoke bstg\.test_plan\.create/);
});

test('complete HTTPS experiment oracle requires the production assessment verdict and its matching native gate',()=>{
  const data=receipt();
  data.technical.artifacts.find(item=>item.id==='assessment-artifact').content_json.verdict='counterexample';
  assert.throws(()=>assertHttpsExperimentEvidence(data),/matching evidence-gated model assessment/);
});

test('HTTPS real-model acceptance recognizes an evidence-linked block without calling it a security conclusion',()=>{
  const data=receipt();
  data.technical.tasks[0].status='blocked';
  const compiledPlan=data.technical.artifacts.find(item=>item.id==='plan-artifact').content_json;
  compiledPlan.parent_plan_id='root-plan';
  data.technical.artifacts.push(artifact('root-plan-artifact','agent_experiment_plan','experiment-task-1',{
    id:'root-plan',flow_id:'flow-1',revision:1,status:'planned',
  },'root-plan'));
  data.technical.artifacts.push(artifact('sibling-plan-artifact','agent_experiment_plan','experiment-task-1',{
    id:'sibling-plan',parent_plan_id:'root-plan',flow_id:'flow-1',revision:1,status:'planned',
  },'sibling-plan'));
  const result=data.technical.artifacts.find(item=>item.id==='result-artifact').content_json;
  result.evidence_ready=false;
  result.business_proof={evidence_gaps:[{failure_code:'authoritative_readback_unavailable',summary:'No observed authoritative read-back follows the selected write.'}]};
  const assessment=data.technical.artifacts.find(item=>item.id==='assessment-artifact');
  assessment.content_json={plan_id:'plan-1',plan_revision:2,result_revision:4,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}};
  data.technical.artifacts.push(artifact('block-artifact','agent_experiment_block','experiment-task-1',{
    status:'blocked',plan_id:'plan-1',flow_id:'flow-1',plan_revision:2,result_revision:4,reason_code:'authoritative_readback_unavailable',
    blocked_reason:'The verified normal Workflow has no observed GET/HEAD read-back after its state-changing request.',
    evidence_artifact_ids:['plan-artifact','result-artifact','assessment-artifact','control-trace','experiment-trace'],
  },'plan-1'));
  data.technical.artifacts.push(artifact('decision-block','agent_decision','experiment-task-1',{
    source:'ai_provider',model,provider_response_id:'receipt-block',tool_name:blockTool,validation_status:'accepted',
  }));
  const resultSummary=assertHttpsExperimentBlockedEvidence(data);
  assert.equal(resultSummary.security_conclusion,'none');
  assert.equal(resultSummary.safely_blocked_model_experiments,1);
});

test('HTTPS real-model acceptance recognizes a repeated negative-proof block only after linked child experiments',()=>{
  const data=receipt(),taskId='experiment-task-1',flowId='flow-1';
  data.technical.tasks[0].status='blocked';
  const basePlan=data.technical.artifacts.find(item=>item.id==='plan-artifact').content_json;
  const baseResult=data.technical.artifacts.find(item=>item.id==='result-artifact').content_json;
  const baseAssessment=data.technical.artifacts.find(item=>item.id==='assessment-artifact');
  baseAssessment.content_json={plan_id:'plan-1',plan_revision:2,result_revision:4,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}};
  baseResult.control_verified=true;baseResult.evidence_ready=false;
  baseResult.business_proof={evidence_gaps:[{failure_code:'negative_counterexample_proof_missing',summary:'No server-owned unchanged-state proof.'}]};
  const linked=['plan-artifact','result-artifact','assessment-artifact','control-trace','experiment-trace'];
  let parentPlanId=String(basePlan.id);
  let currentPlanId=parentPlanId;
  for(let attempt=2;attempt<=3;attempt++){
    const planId='plan-'+attempt,controlRun='control-run-'+attempt,experimentRun='experiment-run-'+attempt;
    currentPlanId=planId;
    const planArtifactId='plan-artifact-'+attempt,compileArtifactId='compilation-artifact-'+attempt;
    const resultArtifactId='result-artifact-'+attempt,controlTraceId='control-trace-'+attempt,experimentTraceId='experiment-trace-'+attempt;
    const assessmentId='assessment-artifact-'+attempt;
    data.technical.artifacts.push(
      artifact(planArtifactId,'agent_experiment_plan',taskId,{id:planId,parent_plan_id:parentPlanId,revision:2,flow_id:flowId,status:'compiled',evidence_artifact_ids:[compileArtifactId]},planId),
      artifact(compileArtifactId,'agent_experiment_compilation',taskId,{plan_id:planId,plan_revision:2,flow_id:flowId,model_directed:true},planId),
      artifact(resultArtifactId,'agent_experiment_result',taskId,{revision:attempt+3,plan_id:planId,plan_revision:2,flow_id:flowId,status:'executed',control_verified:true,evidence_ready:false,
        native_test_run_ids:[controlRun,experimentRun],control_test_run_id:controlRun,experiment_test_run_id:experimentRun,
        evidence_artifact_ids:[controlTraceId,experimentTraceId],business_proof:{evidence_gaps:[{failure_code:'negative_counterexample_proof_missing',summary:'No server-owned unchanged-state proof.'}]}},planId),
      artifact(controlTraceId,'agent_experiment_native_trace',taskId,{plan_id:planId,plan_revision:2,kind:'control',test_run_id:controlRun},controlRun),
      artifact(experimentTraceId,'agent_experiment_native_trace',taskId,{plan_id:planId,plan_revision:2,kind:'experiment',test_run_id:experimentRun},experimentRun),
      artifact(assessmentId,'agent_experiment_assessment',taskId,{plan_id:planId,plan_revision:2,result_revision:attempt+3,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'}},planId),
    );
    linked.push(planArtifactId,resultArtifactId,assessmentId,controlTraceId,experimentTraceId);
    parentPlanId=planId;
  }
  const block=artifact('block-artifact','agent_experiment_block',taskId,{status:'blocked',plan_id:currentPlanId,flow_id:flowId,plan_revision:2,result_revision:6,
    reason_code:'negative_counterexample_proof_missing',blocked_reason:'No security conclusion is available after three linked native attempts.',evidence_artifact_ids:linked},currentPlanId);
  data.technical.artifacts.push(block);
  const currentResult=data.technical.artifacts.find(item=>item.id==='result-artifact-3').content_json;
  currentResult.evidence_artifact_ids=['control-trace-3','experiment-trace-3'];
  data.technical.artifacts.find(item=>item.id==='assessment-artifact').content_json.plan_id='plan-1';
  data.technical.artifacts.push(artifact('decision-block','agent_decision',taskId,{
    source:'ai_provider',model,provider_response_id:'receipt-block',tool_name:blockTool,validation_status:'accepted',
  },'plan-3'));
  const resultSummary=assertHttpsExperimentBlockedEvidence(data);
  assert.equal(resultSummary.security_conclusion,'none');
  assert.deepEqual(resultSummary.block_reason_codes,['negative_counterexample_proof_missing']);
});

test('evidence-linked experiment block remains scan-incomplete when unrelated coverage tasks block',()=>{
  const data=receipt();
  data.technical.tasks=[
    {id:'experiment-task-1',status:'blocked',execution_plan:{intent:'model_business_experiment',flow_id:'flow-1'}},
    {id:'coverage-task-1',status:'blocked',execution_plan:{intent:'vulnerability_test'},phase:'identity_required'},
  ];
  data.productState={run:{status:'failed'},totals:{failed:0,confirmed_risks:0}};
  data.technical.artifacts.find(item=>item.id==='result-artifact').content_json.business_proof={
    evidence_gaps:[{failure_code:'authoritative_readback_unavailable',summary:'No authoritative read-back was observed.'}],
  };
  data.technical.artifacts.find(item=>item.id==='assessment-artifact').content_json={
    plan_id:'plan-1',plan_revision:2,result_revision:4,verdict:'inconclusive',native_evidence_gate:{verdict:'insufficient'},
  };
  data.technical.artifacts.push(artifact('block-artifact','agent_experiment_block','experiment-task-1',{
    status:'blocked',plan_id:'plan-1',flow_id:'flow-1',plan_revision:2,result_revision:4,reason_code:'authoritative_readback_unavailable',
    evidence_artifact_ids:['plan-artifact','result-artifact','assessment-artifact','control-trace','experiment-trace'],
  },'plan-1'));
  data.technical.artifacts.push(artifact('decision-block','agent_decision','experiment-task-1',{
    source:'ai_provider',model,provider_response_id:'receipt-block',tool_name:blockTool,validation_status:'accepted',
  }));

  const resultSummary=assertHttpsExperimentBlockedEvidence(data);
  assert.equal(resultSummary.outcome,'safely_blocked');
  assert.equal(resultSummary.security_conclusion,'none');
  assert.equal(resultSummary.run_status,'failed');
  assert.equal(resultSummary.scan_complete,false);
});
