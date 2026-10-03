#!/usr/bin/env node
/**
 * HTTPS-first, real-provider acceptance for the complete business loop.
 *
 * This is intentionally separate from business-learning-acceptance.mjs:
 * that harness proves the first, normal-only learning stage.  This one starts
 * the normal stage and permits its verified flows to release model-owned
 * security-experiment tasks.  The model never receives fixture routes,
 * credentials, captured packets, oracle state, or a canned experiment plan.
 */
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_NORMAL_OBJECTIVES,
  createBusinessLearningAcceptance,
  fetchJsonWithDeadline,
  fetchJsonWithProgressRetry,
  safeProgressObservation,
} from './business-learning-acceptance.mjs';
import {verifyModelDecisions} from './live-provider.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const REQUIRED_MODEL='gpt-5.6-terra';
const DEFAULT_TIMEOUT_MS=2_700_000;
const DEFAULT_MAX_STEPS=720;
const PROGRESS_REQUEST_TIMEOUT_MS=60_000;
const PROGRESS_POLL_INTERVAL_MS=3_000;

const REQUIRED_EXPERIMENT_TOOLS=Object.freeze([
  'bstg.business.flow.inspect',
  'bstg.workflow.inspect',
  'bstg.test_plan.create',
  'bstg.test_plan.compile',
  'bstg.test_plan.execute',
  'bstg.test_plan.inspect',
  'bstg.test_plan.assess',
]);
const READBACK_BLOCK_TOOL='bstg.test_plan.block';
const TERMINAL_RUN_STATUSES=new Set(['completed','failed','cancelled']);

function artifactContent(artifact){
  return artifact?.content_json&&typeof artifact.content_json==='object'?artifact.content_json:{};
}

function newer(left,right){
  const leftRevision=Number(artifactContent(left).revision||0);
  const rightRevision=Number(artifactContent(right).revision||0);
  if(leftRevision!==rightRevision)return rightRevision-leftRevision;
  return String(right?.created_at||'').localeCompare(String(left?.created_at||''));
}

function latestById(artifacts,key='id'){
  const values=new Map();
  for(const artifact of artifacts){
    const id=String(artifactContent(artifact)[key]||'');
    if(!id)continue;
    const previous=values.get(id);
    if(!previous||newer(previous,artifact)>0)values.set(id,artifact);
  }
  return [...values.values()];
}

function oneCurrentPlan(artifacts,taskId,flowId,selectedPlanId){
  const plans=artifacts.filter(artifact=>artifact?.artifact_type==='agent_experiment_plan'&&String(artifact?.task_id||'')===taskId&&
    String(artifactContent(artifact).flow_id||'')===flowId);
  assert.ok(plans.length>0,'Verified Flow '+flowId+' has no model-owned experiment plan in its own task.');
  const currentById=new Map(latestById(plans).map(artifact=>[String(artifactContent(artifact).id),artifact]));
  const parentIds=new Set([...currentById.values()].map(artifact=>String(artifactContent(artifact).parent_plan_id||'')).filter(Boolean));
  const leaves=[...currentById.entries()].filter(([id])=>!parentIds.has(id)).map(([,artifact])=>artifact).sort(newer);
  let current;
  if(selectedPlanId){
    current=currentById.get(selectedPlanId);
    assert.ok(current,'The executed experiment evidence must reference a plan saved by this task for Flow '+flowId+'.');
    assert.ok(leaves.includes(current),'The executed experiment must reference a terminal plan in its own lineage.');
  }else{
    assert.equal(leaves.length,1,'Verified Flow '+flowId+' must have exactly one current model experiment plan.');
    current=leaves[0];
  }
  const plan=artifactContent(current);
  assert.equal(String(plan.flow_id||''),flowId,'The current experiment plan must retain its verified Flow link.');
  assert.ok(typeof plan.id==='string'&&plan.id.length>0&&Number.isInteger(plan.revision),
    'The current experiment plan for Flow '+flowId+' must retain its opaque ID and revision.');
  assert.equal(plan.status,'compiled','The current model experiment plan for Flow '+flowId+' must be compiled.');
  return {artifact:current,plan};
}

function currentArtifact(artifacts,type,taskId,match,label){
  const matching=artifacts.filter(artifact=>artifact?.artifact_type===type&&String(artifact?.task_id||'')===taskId&&match(artifactContent(artifact)));
  assert.ok(matching.length>0,label);
  return matching.sort(newer)[0];
}

function assertTaskReceipts(technical,taskId,flowId,additionalTools=[]){
  const decisions=(technical?.artifacts||[])
    .filter(artifact=>artifact?.artifact_type==='agent_decision'&&artifact?.content_json?.source==='ai_provider');
  // A provider response which was rejected by the stage/policy boundary is
  // useful diagnostic history, but it did not direct the lifecycle.  Without
  // this filter a rejected model proposal could be followed by a local-policy
  // recovery and still make this real-model acceptance look model-owned.
  const taskDecisions=decisions.filter(decision=>String(decision.task_id||'')===taskId&&
    decision.content_json?.validation_status==='accepted');
  const invoked=new Set(taskDecisions.map(decision=>String(decision.content_json?.tool_name||'')));
  for(const tool of [...REQUIRED_EXPERIMENT_TOOLS,...additionalTools]){
    assert.ok(invoked.has(tool),'The model experiment for verified Flow '+flowId+' did not invoke '+tool+'.');
  }
  return taskDecisions.length;
}

export function assertHttpsExperimentEvidence({technical,productState,fixtureState,provider}){
  assert.equal(new URL(String(technical?.run?.base_url||'')).protocol,'https:','The model experiment must use an HTTPS target.');
  assert.equal(fixtureState?.transport,'https','The controlled target must report HTTPS transport.');
  assert.equal(productState?.run?.status,'completed','The complete business-and-experiment run must complete.');

  const artifacts=Array.isArray(technical?.artifacts)?technical.artifacts:[];
  const flows=latestById(artifacts.filter(artifact=>artifact?.artifact_type==='business_flow'));
  const verified=flows.map(artifact=>artifactContent(artifact)).filter(flow=>flow.status==='verified'&&flow.assertions_verified===true&&
    flow.captured_transport_verified_https===true&&flow.transport_verified_https===true);
  assert.ok(verified.length>0,'At least one native-verified normal Flow must retain verified HTTPS provenance.');

  const experimentTasks=(technical?.tasks||[]).filter(task=>task?.execution_plan?.intent==='model_business_experiment');
  assert.equal(experimentTasks.length,verified.length,'Every verified normal Flow must have exactly one model experiment task.');
  const matchedFlows=new Set();
  let experimentModelDecisions=0;
  for(const flow of verified){
    const flowId=String(flow.id||'');
    assert.ok(flowId,'A verified Flow must retain its opaque ID.');
    const tasks=experimentTasks.filter(task=>String(task.execution_plan?.flow_id||'')===flowId);
    assert.equal(tasks.length,1,'Verified Flow '+flowId+' must map to exactly one model experiment task.');
    const task=tasks[0],taskId=String(task.id||'');
    assert.ok(taskId,'Verified Flow '+flowId+' has an invalid experiment task identity.');
    assert.equal(task.status,'completed','The model experiment task for verified Flow '+flowId+' must complete.');
    assert.equal(matchedFlows.has(flowId),false,'A model experiment task cannot stand in for two verified Flows.');
    matchedFlows.add(flowId);

    const resultArtifact=currentArtifact(artifacts,'agent_experiment_result',taskId,
      content=>content.flow_id===flowId&&content.status==='executed',
      'The current plan for Flow '+flowId+' lacks an executed native result.');
    assert.equal(artifacts.filter(artifact=>artifact?.artifact_type==='agent_experiment_result'&&String(artifact?.task_id||'')===taskId).length,1,
      'The model experiment for Flow '+flowId+' must stop after one bounded native result.');
    const result=artifactContent(resultArtifact);
    const {artifact:planArtifact,plan}=oneCurrentPlan(artifacts,taskId,flowId,String(result.plan_id||''));
    const compilationArtifact=currentArtifact(artifacts,'agent_experiment_compilation',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.flow_id===flowId&&content.model_directed===true,
      'The current plan for Flow '+flowId+' lacks a model-directed native compilation.');
    assert.ok(Array.isArray(plan.evidence_artifact_ids)&&plan.evidence_artifact_ids.includes(compilationArtifact.id),
      'The current plan for Flow '+flowId+' must retain its compilation evidence reference.');
    assert.equal(result.plan_id,plan.id,'The current native result must reference its terminal compiled plan.');
    assert.equal(result.plan_revision,plan.revision,'The current native result must reference the compiled plan revision.');
    const nativeRuns=Array.isArray(result.native_test_run_ids)?result.native_test_run_ids:[];
    assert.equal(nativeRuns.length,2,'The current model plan for Flow '+flowId+' must execute exactly two native Test Runs.');
    assert.ok(typeof result.control_test_run_id==='string'&&typeof result.experiment_test_run_id==='string'&&
      result.control_test_run_id!==result.experiment_test_run_id&&nativeRuns.includes(result.control_test_run_id)&&nativeRuns.includes(result.experiment_test_run_id),
      'The current model plan for Flow '+flowId+' must retain distinct control and experiment Test Run ownership.');

    const controlTrace=currentArtifact(artifacts,'agent_experiment_native_trace',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.kind==='control'&&content.test_run_id===result.control_test_run_id,
      'The current control Test Run for Flow '+flowId+' lacks its matching native trace.');
    const experimentTrace=currentArtifact(artifacts,'agent_experiment_native_trace',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.kind==='experiment'&&content.test_run_id===result.experiment_test_run_id,
      'The current experiment Test Run for Flow '+flowId+' lacks its matching native trace.');
    assert.ok(Array.isArray(result.evidence_artifact_ids)&&result.evidence_artifact_ids.includes(controlTrace.id)&&result.evidence_artifact_ids.includes(experimentTrace.id),
      'The executed model result for Flow '+flowId+' must retain both native trace references.');

    const assessmentArtifact=currentArtifact(artifacts,'agent_experiment_assessment',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.result_revision===result.revision&&
        ['vulnerable','not_vulnerable'].includes(content.verdict)&&
        content.native_evidence_gate?.verdict===({vulnerable:'confirmed',not_vulnerable:'counterexample'}[content.verdict]),
      'The current native result for Flow '+flowId+' lacks a matching evidence-gated model assessment.');
    assert.equal(assessmentArtifact.source_ref,plan.id,'The assessment for Flow '+flowId+' must be sourced from its current model plan.');
    assert.equal(planArtifact.task_id,taskId,'The current plan for Flow '+flowId+' must belong to its own model task.');
    experimentModelDecisions+=assertTaskReceipts(technical,taskId,flowId);
  }
  const evidence=verifyModelDecisions(technical,provider);
  return {verified_https_normal_flows:verified.length,completed_model_experiments:matchedFlows.size,
    provider_decisions:evidence.decisions,experiment_model_decisions:experimentModelDecisions};
}

/** A verified, evidence-linked read-back block is a successful safety
 * disposition, while remaining explicitly short of a vulnerability or secure
 * conclusion. This branch lets the real-model harness verify that the Agent
 * stops when the captured Workflow cannot prove persistent state. */
export function assertHttpsExperimentBlockedEvidence({technical,productState,fixtureState,provider}){
  assert.equal(new URL(String(technical?.run?.base_url||'')).protocol,'https:','The model experiment must use an HTTPS target.');
  assert.equal(fixtureState?.transport,'https','The controlled target must report HTTPS transport.');
  const runStatus=String(productState?.run?.status||'');
  assert.ok(['completed','failed'].includes(runStatus),'The safely blocked business-and-experiment run must reach a terminal product status.');
  if(runStatus==='failed'){
    const tasks=Array.isArray(technical?.tasks)?technical.tasks:[];
    assert.ok(tasks.length>0&&tasks.every(task=>['completed','blocked','skipped'].includes(String(task.status||''))),
      'A failed scan can retain a verified safe block only when every task has a terminal disposition.');
    assert.equal(Number(productState?.totals?.failed||0),0,'A blocked-evidence acceptance cannot conceal a failed product task.');
  }
  assert.equal(Number(productState?.totals?.confirmed_risks||0),0,'An evidence block must not create a security finding.');
  for(const metric of ['unauthorized_reads','unauthorized_updates','invalid_orders']){
    if(fixtureState?.metrics&&Object.hasOwn(fixtureState.metrics,metric))assert.equal(fixtureState.metrics[metric],0,
      'A safely blocked experiment must not reproduce a target-side security violation.');
  }

  const artifacts=Array.isArray(technical?.artifacts)?technical.artifacts:[];
  const flows=latestById(artifacts.filter(artifact=>artifact?.artifact_type==='business_flow'))
    .map(artifact=>artifactContent(artifact)).filter(flow=>flow.status==='verified'&&flow.assertions_verified===true&&
      flow.captured_transport_verified_https===true&&flow.transport_verified_https===true);
  assert.ok(flows.length>0,'At least one native-verified normal Flow must retain verified HTTPS provenance.');
  const experimentTasks=(technical?.tasks||[]).filter(task=>task?.execution_plan?.intent==='model_business_experiment');
  assert.equal(experimentTasks.length,flows.length,'Every verified normal Flow must have exactly one model experiment task.');
  assert.ok(experimentTasks.length>0,'The real model did not receive a verified Flow to assess.');
  let decisions=0;
  const requiredEvidenceTools=['bstg.business.flow.inspect','bstg.workflow.inspect','bstg.test_plan.create','bstg.test_plan.compile',
    'bstg.test_plan.execute','bstg.test_plan.inspect','bstg.test_plan.assess'];
  for(const flow of flows){
    const flowId=String(flow.id||''),tasks=experimentTasks.filter(task=>String(task.execution_plan?.flow_id||'')===flowId);
    assert.equal(tasks.length,1,'Verified Flow '+flowId+' must map to exactly one model experiment task.');
    const task=tasks[0],taskId=String(task.id||'');
    assert.equal(task.status,'blocked','Missing authoritative read-back must leave the experiment explicitly blocked.');
    assert.equal(artifacts.filter(artifact=>artifact?.artifact_type==='agent_experiment_result'&&String(artifact?.task_id||'')===taskId).length,1,
      'An unavailable read-back must stop the task after its first native control/experiment pair.');
    const blockArtifact=currentArtifact(artifacts,'agent_experiment_block',taskId,
      content=>content.flow_id===flowId&&content.reason_code==='authoritative_readback_unavailable'&&content.status==='blocked',
      'The current result for Flow '+flowId+' lacks its explicit evidence-linked read-back block.');
    const blockContent=artifactContent(blockArtifact);
    const {artifact:planArtifact,plan}=oneCurrentPlan(artifacts,taskId,flowId,String(blockContent.plan_id||''));
    const compilation=currentArtifact(artifacts,'agent_experiment_compilation',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.flow_id===flowId&&content.model_directed===true,
      'The blocked model plan for Flow '+flowId+' lacks its native compilation receipt.');
    assert.ok(Array.isArray(plan.evidence_artifact_ids)&&plan.evidence_artifact_ids.includes(compilation.id),
      'The blocked plan for Flow '+flowId+' must retain its compilation evidence reference.');
    const resultArtifact=currentArtifact(artifacts,'agent_experiment_result',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.flow_id===flowId&&content.status==='executed',
      'The blocked plan for Flow '+flowId+' lacks its bounded native execution result.');
    const result=artifactContent(resultArtifact);
    assert.equal((Array.isArray(result.native_test_run_ids)?result.native_test_run_ids:[]).length,2,
      'The inconclusive plan must be backed by one native control and experiment pair.');
    assert.ok((result.business_proof?.evidence_gaps||[]).some(gap=>gap?.failure_code==='authoritative_readback_unavailable'),
      'The current native result must retain the exact safe authoritative-readback gap.');
    const assessmentArtifact=currentArtifact(artifacts,'agent_experiment_assessment',taskId,
      content=>content.plan_id===plan.id&&content.plan_revision===plan.revision&&content.result_revision===result.revision&&
        content.verdict==='inconclusive'&&content.native_evidence_gate?.verdict==='insufficient',
      'The current result for Flow '+flowId+' must remain inconclusive under the native evidence gate.');
    assert.equal(blockContent.plan_id,plan.id,'The evidence block must reference its terminal compiled plan.');
    assert.equal(blockContent.plan_revision,plan.revision,'The evidence block must reference the current plan revision.');
    assert.equal(blockContent.result_revision,result.revision,'The evidence block must reference the current native result.');
    assert.equal(assessmentArtifact.source_ref,plan.id,'The inconclusive assessment must be sourced from its current plan.');
    assert.equal(planArtifact.task_id,taskId,'The current plan must belong to its own blocked experiment task.');
    const linked=new Set(Array.isArray(artifactContent(blockArtifact).evidence_artifact_ids)?artifactContent(blockArtifact).evidence_artifact_ids:[]);
    for(const id of [planArtifact.id,resultArtifact.id,assessmentArtifact.id,...(result.evidence_artifact_ids||[])]){
      assert.ok(linked.has(id),'The block must link every current plan, result, assessment, and native trace artifact.');
    }
    decisions+=assertTaskReceipts(technical,taskId,flowId,[READBACK_BLOCK_TOOL]);
  }
  const providerEvidence=verifyModelDecisions(technical,provider);
  return {outcome:'safely_blocked',security_conclusion:'none',run_status:runStatus,scan_complete:runStatus==='completed',verified_https_normal_flows:flows.length,
    safely_blocked_model_experiments:experimentTasks.length,native_experiment_pairs:experimentTasks.length,
    provider_decisions:providerEvidence.decisions,experiment_model_decisions:decisions,confirmed_risks:0};
}

export function assertExperimentRunTerminal(status){
  assert.ok(TERMINAL_RUN_STATUSES.has(status),
    'The real-model business-experiment run did not reach a terminal product status before its acceptance deadline.');
}

/**
 * `createBusinessLearningAcceptance.collect` is the single place that writes
 * the bounded technical, product, and fixture projections for a real run.
 * Invoke it as soon as the run becomes terminal, before the strict oracle can
 * throw: failed real-provider runs then retain the same safe diagnostic state
 * as completed runs without serialising browser capabilities, credentials, or
 * private execution data into this harness report.
 */
export async function collectTerminalExperimentEvidence(context,runId,status){
  assert.ok(TERMINAL_RUN_STATUSES.has(status),'Experiment evidence can only be collected after a terminal product run status.');
  return context.collect(runId);
}

/** Run only with an explicitly configured private Terra provider.  Reports
 * contain counts and state only; raw endpoint capabilities, credentials,
 * captured values, evidence IDs and provider response IDs remain private. */
export async function runBusinessExperimentRealModelAcceptance({
  outputDirectory,
  mode='secure',
  timeoutMs=DEFAULT_TIMEOUT_MS,
  maxSteps=DEFAULT_MAX_STEPS,
  normalObjectives=DEFAULT_NORMAL_OBJECTIVES,
}={}){
  const context=await createBusinessLearningAcceptance({mode,transport:'https',outputDirectory});
  const report={started_at:new Date().toISOString(),scope:'real Terra model business discovery, HTTPS normal learning, native experiment execution, and evidence assessment',ok:false,observations:[]};
  try {
    assert.equal(context.provider?.model,REQUIRED_MODEL,'This acceptance is pinned to gpt-5.6-terra.');
    const deadline=Date.now()+timeoutMs;
    const scanConfig={
      surface:'web',driving_mode:'autopilot',authorization_acknowledged:true,account_mode:'manual',accounts:context.fixture.credentials,
      max_pages:12,request_evidence_required:true,auto_start:false,
      business_learning:{mode:'normal_then_model_experiment',strict_normal_objectives:true,require_verified_https:true,normal_objectives:normalObjectives},
      agent_task_budgets:{default:24,discover_target:80,plan_business_flows:48,review_business_flows:36,learn_business_flow:88,model_business_experiment:100},
    };
    const {response:create,json:created}=await fetchJsonWithDeadline(context.api+'/api/ai-scans?view=product',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      name:'HTTPS real-model business experiment acceptance',base_url:context.fixture.baseUrl,user_prompt:
        'Discover the authorized disposable site, prove its normal business flows, then design, execute, inspect and assess evidence-backed security experiments for each verified flow.',
      language:'en',selected_vuln_types:[],scan_config:scanConfig,
    })},deadline,'Create complete real-model business-loop scan');
    assert.equal(create.status,201,'The managed product API must create the complete business-loop run.');
    const run=created?.data?.run||created?.data;assert.ok(run?.id,'The created experiment acceptance run requires an ID.');
    const {response:started}=await fetchJsonWithDeadline(context.api+'/api/ai-scans/'+encodeURIComponent(run.id)+'/run-async?view=product',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({max_steps:maxSteps})},deadline,'Start complete real-model business-loop scan');
    assert.equal(started.status,202,'The managed product API must start the complete business-loop run.');

    let technical,productState,fixtureState;
    while(Date.now()<deadline){
      const [technicalReply,stateReply]=await Promise.all([
        fetchJsonWithProgressRetry(`${context.api}/api/ai-scans/${encodeURIComponent(run.id)}`,undefined,deadline,'Read experiment technical progress',
          {requestTimeoutMs:PROGRESS_REQUEST_TIMEOUT_MS}),
        fetchJsonWithProgressRetry(`${context.api}/api/ai-scans/${encodeURIComponent(run.id)}/product-state`,undefined,deadline,'Read experiment product progress',
          {requestTimeoutMs:PROGRESS_REQUEST_TIMEOUT_MS}),
      ]);
      assert.equal(technicalReply.response.status,200);assert.equal(stateReply.response.status,200);
      technical=technicalReply.json.data;productState=stateReply.json.data;
      const observation=safeProgressObservation({state:productState,technical,fixtureState:context.fixture.snapshot()});
      const previous=report.observations.at(-1);
      if(!previous||JSON.stringify({...previous,at:undefined})!==JSON.stringify({...observation,at:undefined}))report.observations.push(observation);
      if(TERMINAL_RUN_STATUSES.has(productState?.run?.status)){
        // Do this before the oracle.  In particular, a failed product run is
        // evidence-worthy and must not be reduced to only a generic error
        // because a later assertion rejects it.
        const collected=await collectTerminalExperimentEvidence(context,run.id,productState.run.status);
        technical=collected.technical;productState=collected.productState;fixtureState=collected.fixtureState;
        break;
      }
      await new Promise(resolve=>setTimeout(resolve,PROGRESS_POLL_INTERVAL_MS));
    }
    assert.ok(productState&&technical,'The complete business-loop run did not yield product and technical state.');
    assertExperimentRunTerminal(productState.run?.status);
    const experimentTasks=technical.tasks.filter(task=>task?.execution_plan?.intent==='model_business_experiment');
    if(experimentTasks.length&&experimentTasks.every(task=>task.status==='blocked')){
      report.verification=assertHttpsExperimentBlockedEvidence({technical,productState,fixtureState,provider:context.provider});
      report.disposition=report.verification.scan_complete?'safely_blocked_no_security_conclusion':'safely_blocked_scan_incomplete';
      if(!report.verification.scan_complete)throw Error('The model experiment safely blocked with linked evidence, but scan-level execution ended failed. No security conclusion is available.');
    }else{
      report.disposition='evidence_assessed';
      report.verification=assertHttpsExperimentEvidence({technical,productState,fixtureState,provider:context.provider});
    }
    report.ok=true;report.completed_at=new Date().toISOString();
    await mkdir(context.out,{recursive:true,mode:0o700});
    await writeFile(path.join(context.out,'business-experiment-acceptance.json'),JSON.stringify(report,null,2),{mode:0o600});
    await context.close();
    return {report,out:context.out};
  } catch(error) {
    report.error='The HTTPS real-model experiment acceptance failed; inspect the private acceptance artifacts.';
    report.completed_at=new Date().toISOString();
    await writeFile(path.join(context.out,'business-experiment-acceptance.json'),JSON.stringify(report,null,2),{mode:0o600}).catch(()=>{});
    await context.close(error);
    throw error;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try { const result=await runBusinessExperimentRealModelAcceptance({mode:process.env.BSTG_BUSINESS_FIXTURE_MODE||'secure',timeoutMs:Number(process.env.BSTG_BUSINESS_EXPERIMENT_ACCEPTANCE_TIMEOUT_MS||DEFAULT_TIMEOUT_MS),maxSteps:Number(process.env.BSTG_BUSINESS_EXPERIMENT_ACCEPTANCE_MAX_STEPS||DEFAULT_MAX_STEPS),
    normalObjectives:process.env.BSTG_BUSINESS_EXPERIMENT_NORMAL_OBJECTIVES?JSON.parse(process.env.BSTG_BUSINESS_EXPERIMENT_NORMAL_OBJECTIVES):DEFAULT_NORMAL_OBJECTIVES}); console.log(JSON.stringify({ok:true,verification:result.report.verification},null,2)); }
  catch { console.error('HTTPS real-model business experiment acceptance failed; inspect the private acceptance artifacts.');process.exitCode=1; }
}
