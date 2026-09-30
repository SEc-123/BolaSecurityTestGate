import type { AgentToolContext, AgentToolResult, AgentToolSpec } from '../tool-types.js';
import { inspectBusinessCapture, inspectBusinessWorkflow, prepareBusinessWorkflow, startBusinessCapture, stopBusinessCapture, validateBusinessWorkflow } from '../../services/ai-scan/agent-business-capture.js';
import { getBusinessFlow } from '../../services/ai-scan/agent-business-contract.js';
import { BUSINESS_COVERAGE_ARTIFACT, BUSINESS_PLAN_INTENT, businessCoverageKey, businessCoverageTargets, latestBusinessCoverage,
  type BusinessCoverageEntry } from '../business-task-lifecycle.js';

const id={type:'string',minLength:1,maxLength:200};
const recording={recording_session_id:id};
const workflow={workflow_id:id};
const assertion={type:'object',required:['step_order','description','purpose','left','op','right'],additionalProperties:false,properties:{
  id,step_order:{type:'integer',minimum:1},description:{type:'string',minLength:1,maxLength:1000},
  purpose:{enum:['goal','identity','state','control','impact']},
  left:{type:'object',required:['type','path'],properties:{type:{const:'response'},path:{type:'string',minLength:1,maxLength:400}}},
  op:{enum:['equals','not_equals','contains','not_contains','regex','greater_than','less_than','greater_or_equal','less_or_equal']},
  right:{type:'object',required:['type'],properties:{type:{enum:['literal','workflow_variable','workflow_context']},value:{type:'string',maxLength:4000},key:id}},
  missing_behavior:{const:'fail'},
}};

function tool(name:string,description:string,properties:Record<string,any>,required:string[],
  invoke:(input:Record<string,any>,context:AgentToolContext)=>Promise<Record<string,any>>,effects:string[]=[]):AgentToolSpec {
  return {name,description,input_schema:{type:'object',properties,required,additionalProperties:false},side_effects:effects,
    handler:async(input,context):Promise<AgentToolResult>=>{
      if(context.signal?.aborted)return {ok:false,error:'Business learning task was cancelled.'};
      try {
        const data=await invoke(input,context);
        // A completed native baseline run may refute the current learning
        // hypothesis. Keep its evidence in the agent loop so the model can
        // inspect mappings or retry the normal business action; only a tool/
        // executor failure should terminate the learning task immediately.
        const executedBaseline=name==='bstg.business.workflow.validate' && Boolean(data.test_run_id || data.execution);
        return {ok:executedBaseline || data.verified!==false,data,summary:typeof data.summary==='string'?data.summary:
          `${name}: ${data.status||data.capture_status||'completed'}; flow ${data.flow_id||''}.`};
      } catch(error:any){return {ok:false,error:error?.message||String(error),summary:'The business learning operation did not complete; inspect the current flow and execution evidence before retrying.'};}
    }};
}

const coverageEntry={type:'object',required:['target_type','target_id','disposition'],additionalProperties:false,properties:{
  target_type:{enum:['feature','operation']},target_id:id,disposition:{enum:['planned','deferred','blocked']},flow_id:id,
  reason:{type:'string',minLength:1,maxLength:1600},
}};

function coverageSummary(targets:Awaited<ReturnType<typeof businessCoverageTargets>>, entries:BusinessCoverageEntry[]){
  const byKey=new Map(entries.map(entry=>[businessCoverageKey(entry.target_type,entry.target_id),entry]));
  return targets.map(target=>{
    const entry=byKey.get(target.key);
    return {target_type:target.target_type,target_id:target.target_id,name:target.name,feature_id:target.feature_id,
      disposition:entry?.disposition||'uncovered',flow_id:entry?.flow_id,reason:entry?.reason};
  });
}

function coverageTaskId(context:AgentToolContext):string{
  const taskId=String(context.taskId||'');
  if(!taskId)throw new Error('Business coverage requires an owned planning task.');
  return taskId;
}

/** The planner cannot infer coverage from a nonempty list of flows.  This
 * explicit record makes the model state its decision for every discovered
 * operation, including ones it cannot currently exercise. */
async function inspectBusinessCoverage(context:AgentToolContext):Promise<Record<string,any>>{
  const taskId=coverageTaskId(context),task=await context.repo.getTask(taskId);
  if(!task||task.execution_plan?.intent!==BUSINESS_PLAN_INTENT)throw new Error('Business coverage inspection belongs to the normal business planning task.');
  const [targets,artifacts]=await Promise.all([businessCoverageTargets(context.repo,context.scanRunId),context.repo.listArtifacts(context.scanRunId)]);
  const saved=latestBusinessCoverage(artifacts,taskId)?.content_json as any;
  const entries=Array.isArray(saved?.entries)?saved.entries as BusinessCoverageEntry[]:[];
  return {plan_task_id:taskId,coverage_revision:Number(saved?.revision||0),targets:coverageSummary(targets,entries),
    uncovered_targets:coverageSummary(targets,entries).filter(item=>item.disposition==='uncovered').map(item=>({target_type:item.target_type,target_id:item.target_id,name:item.name})),
    notice:'For every target, save planned with a current flow_id, or deferred/blocked with a concrete observed reason. The model chooses the business grouping and does not need to create a flow for an unavailable target.'};
}

async function saveBusinessCoverage(context:AgentToolContext,input:Record<string,any>):Promise<Record<string,any>>{
  const taskId=coverageTaskId(context),task=await context.repo.getTask(taskId);
  if(!task||task.execution_plan?.intent!==BUSINESS_PLAN_INTENT)throw new Error('Only the normal business planning task can save its coverage list.');
  const [targets,artifacts]=await Promise.all([businessCoverageTargets(context.repo,context.scanRunId),context.repo.listArtifacts(context.scanRunId)]);
  const expected=new Map(targets.map(target=>[target.key,target]));
  const entries=Array.isArray(input.entries)?input.entries as BusinessCoverageEntry[]:[];
  const seen=new Set<string>();
  const savedEntries:BusinessCoverageEntry[]=[];
  for(const value of entries){
    const targetType=String(value?.target_type||'') as BusinessCoverageEntry['target_type'];
    const targetId=String(value?.target_id||'');
    const key=businessCoverageKey(targetType,targetId);
    if(!expected.has(key))throw new Error(`Coverage target ${key} is not part of this assessment's current discovery inventory.`);
    if(seen.has(key))throw new Error(`Coverage target ${key} appears more than once.`);
    seen.add(key);
    const disposition=String(value?.disposition||'') as BusinessCoverageEntry['disposition'];
    if(!['planned','deferred','blocked'].includes(disposition))throw new Error(`Coverage target ${key} needs a planned, deferred, or blocked disposition.`);
    if(disposition==='planned'){
      const flowId=String(value?.flow_id||'');
      if(!flowId)throw new Error(`Planned coverage target ${key} must reference a saved flow_id.`);
      await getBusinessFlow(context.repo,context.scanRunId,flowId);
      savedEntries.push({target_type:targetType,target_id:targetId,disposition,flow_id:flowId});
    }else{
      const reason=String(value?.reason||'').trim();
      if(!reason)throw new Error(`${disposition} coverage target ${key} must state a concrete reason.`);
      savedEntries.push({target_type:targetType,target_id:targetId,disposition,reason});
    }
  }
  const missing=[...expected.keys()].filter(key=>!seen.has(key));
  if(missing.length)throw new Error(`Coverage list omits ${missing.length} discovered feature/operation target(s): ${missing.slice(0,8).join(', ')}.`);
  const prior=latestBusinessCoverage(artifacts,taskId)?.content_json as any;
  const revision=Number(prior?.revision||0)+1;
  const artifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:taskId,artifact_type:BUSINESS_COVERAGE_ARTIFACT,
    title:'模型业务覆盖清单',source_ref:taskId,content_json:{revision,plan_task_id:taskId,target_manifest:targets,entries:savedEntries}});
  return {coverage_artifact_id:artifact.id,plan_task_id:taskId,coverage_revision:revision,
    targets:coverageSummary(targets,savedEntries),planned_flow_ids:[...new Set(savedEntries.filter(entry=>entry.disposition==='planned').map(entry=>entry.flow_id))],
    summary:'Business coverage is saved for every currently discovered feature/operation. Planned flows may now be scheduled; deferred and blocked targets remain visible with their stated reason.'};
}

/** Thin adapters to the production recorder and native executor. They expose
 * observable facts and explicit experiments rather than naming fixed attacks. */
export function buildBusinessLearningToolSpecs():AgentToolSpec[] {
  return [
    tool('bstg.business.coverage.inspect',
      'Inspect the current discovered operable features and endpoint operations for normal-business coverage. Use this before saving the model-owned coverage list; it does not invent business flows or mark anything complete.',
      {},[],(_input,context)=>inspectBusinessCoverage(context)),
    tool('bstg.business.coverage.save',
      'Save the model-owned normal-business coverage list. Every target returned by coverage.inspect must appear exactly once: planned requires a saved business flow_id; deferred or blocked requires a concrete observed reason. This is the only planning-stage completion evidence and it does not verify a business flow.',
      {entries:{type:'array',maxItems:400,items:coverageEntry}},['entries'],(input,context)=>saveBusinessCoverage(context,input),['creates an append-only business coverage record']),
    tool('bstg.business.capture.start',
      'Start complete task/action/identity-bound browser request-response recording for a defined normal business flow, before its first navigation. Operate the returned context with browser.navigate/interact. Every repeated request is retained. This does not execute or verify the business goal.',
      {flow_id:id,name:{type:'string',maxLength:200},identity_key:id,account_id:id,context_key:id,scope_type:{enum:['scan','task','identity']},
        field_names:{type:'array',maxItems:50,items:{type:'string',minLength:1,maxLength:100}}},['flow_id'],
      (input,context)=>startBusinessCapture(context,input as any),['creates a recording session','attaches capture to an owned browser context']),
    tool('bstg.business.capture.stop',
      'Stop this task-owned recording after the normal browser flow. Drain in-flight requests and retain interrupted/incomplete status. Requests alone cannot establish that the business succeeded.',
      recording,['recording_session_id'],(input,context)=>stopBusinessCapture(context,input.recording_session_id),['finishes browser capture']),
    tool('bstg.business.capture.inspect',
      'Inspect the exact ordered normal-flow requests and responses, repeated calls, task/action/identity attribution and capture gaps. Values of credentials and verification material are redacted; event IDs refer to private execution sources. Use observed response fields to design business assertions.',
      recording,['recording_session_id'],(input,context)=>inspectBusinessCapture(context,input.recording_session_id)),
    tool('bstg.business.workflow.prepare',
      'Reuse the existing recording generator to promote a complete stopped recording into API templates and a normal Workflow. Optionally select observed event IDs to separate business paths. Preserve actual order and repeated calls. Return dependency/mapping candidates; do not claim they are verified.',
      {...recording,event_ids:{type:'array',minItems:1,maxItems:200,uniqueItems:true,items:id},name:{type:'string',maxLength:200}},['recording_session_id'],
      (input,context)=>prepareBusinessWorkflow(context,input as any),['publishes native templates and a workflow from recording drafts']),
    tool('bstg.business.workflow.inspect',
      'Inspect normal workflow steps, safe request structure, source recording, observed identity, extracted values and candidate parameter dependencies. Decide which mappings and session propagation are justified by the actual flow.',
      workflow,['workflow_id'],(input,context)=>inspectBusinessWorkflow(context,input.workflow_id)),
    tool('bstg.business.workflow.validate',
      'Run a new native Test Run for this normal Workflow. Supply executable business goal/identity/state assertions derived from observed responses, and explicitly choose learning mapping IDs/session propagation. HTTP status alone is insufficient. Return actual verified or failed outcome and fresh evidence; the model cannot self-report a pass.',
      {...workflow,assertions:{type:'array',minItems:1,maxItems:50,items:assertion},mapping_ids:{type:'array',maxItems:100,uniqueItems:true,items:id},apply_session_jar:{type:'boolean'}},
      ['workflow_id','assertions'],(input,context)=>validateBusinessWorkflow(context,input as any),['creates a native normal Test Run','evaluates business assertions','persists normal flow evidence']),
  ];
}
