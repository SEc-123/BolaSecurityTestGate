import type { AgentToolContext, AgentToolResult, AgentToolSpec } from '../tool-types.js';
import { CoverageRetryEventSelectionError, ObjectiveCompletionCandidateRequiredError, ObjectiveOperationCandidateRequiredError, SemanticBodyCandidateRequiredError, TransactionPrerequisiteEventSelectionError, WorkflowEligibleEventSelectionError, inspectBusinessCapture, inspectBusinessWorkflow, isAuthorizedBusinessCoverageRetryTask, prepareBusinessWorkflow, repairBusinessWorkflow, requireCurrentBusinessLearningRecording, resolveCurrentBusinessLearningRecording, reviseBusinessWorkflow, startBusinessCapture, stopBusinessCapture, validateBusinessWorkflow } from '../../services/ai-scan/agent-business-capture.js';
import { BusinessAssertionValidationError, getBusinessFlow, saveBusinessFlow } from '../../services/ai-scan/agent-business-contract.js';
import { resolvePreparedBrowserIdentity } from '../../services/ai-scan/browser/prepared-identity.js';
import { applyPreparedIdentityBrowserLogin } from '../../services/ai-scan/browser/prepared-identity-login.js';
import { invalidatePersistentBrowserObservationRefs, withPersistentBrowserPage } from '../../services/ai-scan/browser/persistent-browser-runtime.js';
import { requireCurrentBusinessExperimentWorkflow } from '../../services/ai-scan/agent-business-experiment.js';
import { BUSINESS_COVERAGE_ARTIFACT, BUSINESS_EXPERIMENT_INTENT, BUSINESS_LEARNING_INTENT, BUSINESS_PLAN_INTENT, businessCoverageKey, businessCoverageTargets, isNormalBusinessBlockerEvidence, latestBusinessCoverage,
  type BusinessCoverageEntry } from '../business-task-lifecycle.js';
import { normalObjectiveManifestForTask, requiresNormalObjectiveManifest } from '../normal-business-objectives.js';

const id={type:'string',minLength:1,maxLength:200};
const workflow={workflow_id:id};
const assertion={type:'object',required:['step_order','description','purpose','left','op','right'],additionalProperties:false,properties:{
  id,step_order:{type:'integer',minimum:1},description:{type:'string',minLength:1,maxLength:1000},
  purpose:{enum:['goal','identity','state','control','impact']},
  left:{type:'object',required:['type','path'],additionalProperties:false,properties:{type:{const:'response'},path:{type:'string',minLength:1,maxLength:400,
    pattern:'^(status|body\\.[^\\s]+|headers\\.[^\\s]+)$',description:'Use an exact assertion_paths entry from bstg.business.workflow.inspect for this step: status, headers.<observed-header>, or body.<observed-json-field>. Bare body, page HTML, and text responses are not executable assertion paths.'}}},
  op:{enum:['equals','not_equals','contains','not_contains','regex','greater_than','less_than','greater_or_equal','less_or_equal']},
  right:{type:'object',required:['type'],additionalProperties:false,properties:{type:{enum:['literal','workflow_variable','workflow_context','captured_baseline']},value:{type:'string',maxLength:4000},key:id}},
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
      } catch(error:any){
        if(name==='bstg.business.workflow.validate'&&error instanceof BusinessAssertionValidationError){
          const data=await assertionRevisionRecovery(context,input,error);
          return {ok:true,data,summary:String(data.summary)};
        }
        if((name==='bstg.business.capture.stop'||name==='bstg.business.workflow.prepare')&&error instanceof SemanticBodyCandidateRequiredError){
          const data={status:'semantic_body_candidate_required',retryable:true,
            candidate_event_ids:error.candidate_event_ids,
            candidate_event_count:error.candidate_event_ids.length,
            capture_remains_active:name==='bstg.business.capture.stop',
            summary:name==='bstg.business.capture.stop'
              ? 'The active capture has no successful semantic JSON response yet. Keep it active and choose a browser action that reaches a normal result with an observable body field.'
              : 'The selected events contain no successful semantic JSON response. Choose at least one listed opaque candidate event ID and prepare again; no Workflow was published.'};
          return {ok:false,error:error.message,data,summary:data.summary};
        }
        if((name==='bstg.business.capture.stop'||name==='bstg.business.workflow.prepare'||name==='bstg.business.workflow.revise')&&error instanceof ObjectiveCompletionCandidateRequiredError){
          const data={status:'objective_completion_candidate_required',retryable:true,
            candidate_event_ids:error.candidate_event_ids,
            candidate_event_count:error.candidate_event_ids.length,
            required_response_paths:error.required_response_paths,
            capture_remains_active:name==='bstg.business.capture.stop',
            summary:name==='bstg.business.capture.stop'
              ? 'The active capture has not yet observed the server-sealed final outcome for this objective. Keep it active, use the current visible controls to reach that outcome, then inspect again.'
              : name==='bstg.business.workflow.revise'
                ? 'The revised event selection omits the server-sealed final outcome for this objective. Choose at least one listed opaque completion event ID and revise again; no Workflow was published.'
                : 'The selected events omit the server-sealed final outcome for this objective. Choose at least one listed opaque completion event ID and prepare again; no Workflow was published.'};
          return {ok:false,error:error.message,data,summary:data.summary};
        }
        if((name==='bstg.business.capture.stop'||name==='bstg.business.workflow.prepare'||name==='bstg.business.workflow.revise')&&error instanceof ObjectiveOperationCandidateRequiredError){
          const data={status:'objective_operation_candidate_required',retryable:true,candidate_event_ids:error.candidate_event_ids,
            candidate_event_count:error.candidate_event_ids.length,operation_id:error.operation_id,side_effect_class:error.side_effect_class,
            capture_remains_active:name==='bstg.business.capture.stop',summary:name==='bstg.business.capture.stop'
              ? 'The active capture has not observed the server-sealed state-changing operation for this objective. Keep it active and use a visible browser action that reaches the stated business effect.'
              : name==='bstg.business.workflow.revise'
                ? 'The revised event selection omits the server-sealed state-changing operation for this objective. Choose one listed opaque operation event ID and revise again; no Workflow was published.'
                : 'The selected events omit the server-sealed state-changing operation for this objective. Choose one listed opaque operation event ID and prepare again; no Workflow was published.'};
          return {ok:false,error:error.message,data,summary:data.summary};
        }
        if((name==='bstg.business.workflow.prepare'||name==='bstg.business.workflow.revise')&&error instanceof WorkflowEligibleEventSelectionError){
          const data={status:'workflow_eligible_event_selection_required',retryable:true,
            candidate_event_ids:error.candidate_event_ids,candidate_event_count:error.candidate_event_count,
            summary:'The selected capture subset included a background, static, or otherwise non-replayable event. Choose only the listed current action-bound Workflow event IDs; BSTG will not silently drop or substitute an event.'};
          return {ok:false,error:error.message,data,summary:data.summary};
        }
        if((name==='bstg.business.workflow.prepare'||name==='bstg.business.workflow.revise')&&error instanceof TransactionPrerequisiteEventSelectionError){
          const data={status:'transaction_prerequisite_event_selection_required',retryable:true,
            missing_prerequisites:error.missing_prerequisites,
            summary:'The selected transaction omitted an observed action-bound prerequisite stage. For every listed finite intent, choose at least one listed opaque event ID yourself before compiling the Workflow; BSTG will not auto-add it.'};
          return {ok:false,error:error.message,data,summary:data.summary};
        }
        if(name==='bstg.business.workflow.prepare'&&error instanceof CoverageRetryEventSelectionError){
          const data={status:'coverage_retry_event_selection_required',retryable:true,
            missing_scheduled_targets:error.missing_scheduled_targets,
            no_executable_candidate:error.no_executable_candidate,
            summary:error.no_executable_candidate
              ? 'The stopped retry recording has no executable candidate for one or more scheduled targets. Do not compile an unprovable Workflow; record a target-reaching browser action before sealing a retry capture.'
              : 'The stopped retry recording already contains one or more scheduled target events, but the model-selected subset omitted them. Inspect the current capture and choose the listed event IDs explicitly; BSTG will not add them automatically.'};
          return {ok:false,error:error.message,data,summary:data.summary};
        }
        return {ok:false,error:error?.message||String(error),summary:'The business learning operation did not complete; inspect the current flow and execution evidence before retrying.'};}
    }};
}

async function inspectableBusinessWorkflow(context:AgentToolContext,workflowId:string):Promise<Record<string,any>>{
  const taskId=String(context.taskId||'');
  const task=taskId?await context.repo.getTask(taskId):undefined;
  if(task?.execution_plan?.intent===BUSINESS_EXPERIMENT_INTENT||task?.task_type==='model_business_experiment'){
    await requireCurrentBusinessExperimentWorkflow(context,workflowId);
  }
  return inspectBusinessWorkflow(context,workflowId);
}

/** A rejected assertion shape must not manufacture a Test Run or terminally
 * fail the normal-flow task. Return only server-derived, value-free paths so
 * the next model turn can repair its own assertion choice. */
async function assertionRevisionRecovery(context:AgentToolContext,input:Record<string,any>,error:BusinessAssertionValidationError):Promise<Record<string,any>> {
  const workflowId=typeof input.workflow_id==='string'?input.workflow_id:'';
  let workflowAssertionPaths:Array<Record<string,any>>=[];
  let retryTargetAssertionRequirements:Array<Record<string,any>>=[];
  if(workflowId){
    try {
      const inspection=await inspectBusinessWorkflow(context,workflowId);
      workflowAssertionPaths=(inspection.steps||[]).map((step:any)=>({step_id:step.step_id,step_order:step.step_order,
        assertion_paths:Array.isArray(step.assertion_paths)?step.assertion_paths:[],
        semantic_body_path_available:step.semantic_body_path_available===true}));
      retryTargetAssertionRequirements=Array.isArray(inspection.retry_target_assertion_requirements)
        ? inspection.retry_target_assertion_requirements.map((requirement:any)=>({target_type:requirement?.target_type,target_id:requirement?.target_id,
          source_step_orders:Array.isArray(requirement?.source_step_orders)?requirement.source_step_orders:[],
          semantic_body_assertion_required:requirement?.semantic_body_assertion_required===true}))
        : [];
    } catch {
      // The original structural rejection remains useful even if the source
      // Workflow is no longer available for a detailed path projection.
    }
  }
  const objectiveCompletionAssertionRequirements=[...new Map(error.issues.filter(issue=>
    typeof issue.required_response_path==='string'&&issue.required_response_path&&Number.isInteger(issue.step_order)&&Number(issue.step_order)>0
  ).map(issue=>[`${issue.step_order}:${issue.required_response_path}`,{
    source_step_order:Number(issue.step_order),required_response_path:issue.required_response_path,
    allowed_assertion_purposes:['goal','state'],
  }])).values()];
  return {workflow_id:workflowId,status:'assertion_revision_required',assertion_input_rejected:true,retryable:true,
    native_execution_started:false,rejected_assertions:error.issues.map(issue=>({assertion_index:issue.assertion_index,step_order:issue.step_order,
      invalid_path:issue.invalid_path===true,malformed_assertion:issue.malformed_assertion===true,
      semantic_body_required:issue.semantic_body_required===true,unobserved_path:issue.unobserved_path===true})),
    ...(objectiveCompletionAssertionRequirements.length?{objective_completion_assertion_requirements:objectiveCompletionAssertionRequirements}:{}),
    required_path_forms:[{path:'status',semantic:false},{path:'headers.<observed-header>',semantic:false},{path:'body.<observed-json-field>',semantic:true}],
    workflow_assertion_paths:workflowAssertionPaths,
    ...(retryTargetAssertionRequirements.length?{retry_target_assertion_requirements:retryTargetAssertionRequirements}:{}),
    summary:objectiveCompletionAssertionRequirements.length
      ? 'No native Test Run was created. Inspect the same Workflow, then add one goal or state semantic assertion for every listed final-outcome path at its exact source step before retrying.'
      : retryTargetAssertionRequirements.length
        ? 'No native Test Run was created. For every listed scheduled retry target, choose a goal, identity, or state body assertion on one of its exact source_step_orders, then retry the same Workflow.'
        : 'No native Test Run was created. Inspect the current workflow assertion_paths and retry with exact observed response fields; bare body, HTML, and text are not semantic assertions.'};
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

/** Complete current objective coverage before scheduling normal learning. The
 * manifest lives on the planning task, so later scan-config edits cannot add,
 * remove, or relabel requirements mid-run. */
function strictObjectiveCoverageGap(task:any, artifacts:any[]):string|undefined {
  if (!requiresNormalObjectiveManifest(task)) return undefined;
  const manifest = normalObjectiveManifestForTask(task);
  const latest = new Map<string, any>();
  for (const artifact of artifacts.filter(item => item.artifact_type === 'business_flow')) {
    const flowId = String(artifact.content_json?.id || artifact.source_ref || '');
    if (!flowId) continue;
    const prior = latest.get(flowId);
    const revision = Number(artifact.content_json?.revision || 0);
    if (!prior || revision > Number(prior.content_json?.revision || 0) ||
      revision === Number(prior.content_json?.revision || 0) && String(artifact.created_at) > String(prior.created_at)) latest.set(flowId, artifact);
  }
  const byObjective = new Map<string, string[]>();
  for (const artifact of latest.values()) {
    const objectiveId = String(artifact.content_json?.objective_id || '');
    if (!objectiveId) continue;
    byObjective.set(objectiveId, [...(byObjective.get(objectiveId) || []), String(artifact.content_json?.id || artifact.source_ref || '')]);
  }
  for (const objective of manifest) {
    const flows = byObjective.get(objective.id) || [];
    if (flows.length !== 1) return `Immutable normal-business objective ${objective.id} requires exactly one saved Flow before coverage can be accepted.`;
  }
  return undefined;
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
  const objectiveGap = strictObjectiveCoverageGap(task, artifacts);
  if (objectiveGap) throw new Error(objectiveGap);
  const prior=latestBusinessCoverage(artifacts,taskId)?.content_json as any;
  const revision=Number(prior?.revision||0)+1;
  const artifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:taskId,artifact_type:BUSINESS_COVERAGE_ARTIFACT,
    title:'模型业务覆盖清单',source_ref:taskId,content_json:{revision,plan_task_id:taskId,target_manifest:targets,entries:savedEntries,
      ...(requiresNormalObjectiveManifest(task)?{normal_objective_manifest:normalObjectiveManifestForTask(task)}:{})}});
  return {coverage_artifact_id:artifact.id,plan_task_id:taskId,coverage_revision:revision,
    targets:coverageSummary(targets,savedEntries),planned_flow_ids:[...new Set(savedEntries.filter(entry=>entry.disposition==='planned').map(entry=>entry.flow_id))],
    summary:'Business coverage is saved for every currently discovered feature/operation. Planned flows may now be scheduled; deferred and blocked targets remain visible with their stated reason.'};
}

/** Apply an exact scan-bound prepared identity only inside the current normal
 * business browser. The model sees neither the credential nor session material.
 * A login transition must use a fresh task context: an existing identity context
 * may already be authenticated from discovery and would not prove the login flow. */
async function applyPreparedIdentityLogin(context:AgentToolContext,input:Record<string,any>):Promise<Record<string,any>>{
  const taskId=String(context.taskId||'');
  if(!taskId)throw new Error('Prepared browser login requires an owned normal business task.');
  const task=await context.repo.getTask(taskId);
  const flowId=String(input.flow_id||'');
  if(!task||task.execution_plan?.intent!==BUSINESS_LEARNING_INTENT||String(task.execution_plan?.flow_id||'')!==flowId){
    throw new Error('Prepared browser login belongs only to its current normal business learning flow.');
  }
  const flow=await getBusinessFlow(context.repo,context.scanRunId,flowId);
  if(!flow.role||flow.role==='anonymous'){
    return {flow_id:flowId,status:'identity_key_required',authenticated:false,
      summary:'This flow has no configured execution identity. Define an observed authentication flow with an exact prepared identity key before applying login.'};
  }
  if(!flow.recording_session_id){
    return {flow_id:flowId,identity_key:flow.role,status:'recording_required',authenticated:false,
      summary:'Start this flow recording before navigating and applying the prepared identity.'};
  }
  const session=await requireCurrentBusinessLearningRecording(context,flow.recording_session_id);
  const filters=session.capture_filters||{};
  if(filters.task_id!==taskId)throw new Error('Only the current capture owner can apply its prepared identity.');
  if(filters.capture_status!=='recording'){
    return {flow_id:flowId,recording_session_id:session.id,identity_key:flow.role,status:'recording_not_active',authenticated:false,
      summary:'This recording is no longer active. Start a fresh task-scoped capture before applying the prepared identity.'};
  }
  if(filters.scope_type!=='task'){
    return {flow_id:flowId,recording_session_id:session.id,identity_key:flow.role,status:'fresh_task_context_required',authenticated:false,
      required_capture_scope:'task',
      recovery:'Stop this capture, start the same flow again with scope_type "task", navigate that returned context to the observed login page, then call this tool. Reusing an identity context can skip the login transition because discovery may already be authenticated.',
      summary:'A login transition must begin in a fresh task browser context; no credentials were applied.'};
  }
  if(String(filters.identity_key||'')!==flow.role)throw new Error('Capture identity does not match this business flow role.');
  const run=await context.repo.getRun(context.scanRunId);
  if(!run)throw new Error('Assessment not found.');
  const boundAccountId=String(session.account_id||'');
  const storedBindingId=String(filters.identity_account_id||'');
  const resolution=!boundAccountId||storedBindingId!==boundAccountId
    ? undefined
    : await resolvePreparedBrowserIdentity({db:context.db,scan_run_id:context.scanRunId,identity_key:flow.role,account_id:boundAccountId});
  if(!resolution || resolution.status!=='resolved'){
    const data={flow_id:flowId,recording_session_id:session.id,identity_key:flow.role,context_key:String(filters.context_key||''),
      status:'identity_binding_unavailable',authenticated:false};
    const evidenceArtifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:taskId,artifact_type:'business_identity_login',source_ref:session.id,
      title:'Prepared identity browser login',content_json:data});
    return {...data,evidence_artifact_id:evidenceArtifact.id,
      summary:'The exact scan-bound account recorded for this Flow is no longer uniquely usable for browser login. Retain the normal-flow blocker and repair that account binding; no credential fallback was used.'};
  }
  let result:Awaited<ReturnType<typeof applyPreparedIdentityBrowserLogin>>;
  try {
    result=await withPersistentBrowserPage({repo:context.repo,scanRunId:context.scanRunId,taskId,scope_base_url:run.base_url,
      scope_type:'task',identity_key:flow.role,context_key:String(filters.context_key||''),action:'identity_apply_login',signal:context.signal},
      (page,browserContext,armTrustedAction)=>applyPreparedIdentityBrowserLogin({page,browser_context:browserContext,base_url:run.base_url,
        authentication_origins:run.scan_config?.authentication_origins,identity:resolution.binding.identity,
        before_submit:()=>armTrustedAction?.('click') ?? Promise.resolve()}));
  } catch(error) {
    if(context.signal?.aborted)throw error;
    result={authenticated:false,status:'login_failed',login_submitted:false,session_changed:false,storage_token_observed:false};
  }
  await invalidatePersistentBrowserObservationRefs({scanRunId:context.scanRunId,taskId,scope_type:'task',identity_key:flow.role,context_key:String(filters.context_key||'')});
  const data={flow_id:flowId,recording_session_id:session.id,identity_key:flow.role,context_key:String(filters.context_key||''),...result};
  const evidenceArtifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:taskId,artifact_type:'business_identity_login',source_ref:session.id,
    title:'Prepared identity browser login',content_json:data});
  return {...data,evidence_artifact_id:evidenceArtifact.id,summary:result.authenticated
    ? 'Prepared identity completed a real browser login inside the active recording; inspect the captured requests before stopping the flow.'
    : 'Prepared identity login did not establish an authenticated browser state. Inspect the safe status and retain a concrete normal-flow blocker; do not guess or expose credentials.'};
}

/**
 * A normal-flow block is a persisted, reviewable fact. The model may choose
 * the reason, but it must point at a current-task server observation that the
 * lifecycle recognizes as a hard blocker. Assertion mismatches and arbitrary
 * decision artifacts remain adaptation feedback and cannot use this route.
 */
async function blockBusinessFlow(context:AgentToolContext,input:Record<string,any>):Promise<Record<string,any>>{
  const taskId=String(context.taskId||'');
  const flowId=String(input.flow_id||'');
  const reason=String(input.reason||'').trim();
  if(!taskId||!flowId||!reason)throw new Error('A current normal-learning task, flow_id, and concrete blocker reason are required.');
  const task=await context.repo.getTask(taskId);
  if(!task||task.execution_plan?.intent!==BUSINESS_LEARNING_INTENT||String(task.execution_plan?.flow_id||'')!==flowId){
    throw new Error('A normal business flow can be blocked only by its current learning task.');
  }
  const flow=await getBusinessFlow(context.repo,context.scanRunId,flowId);
  if(flow.owner_task_id&&flow.owner_task_id!==taskId&&!await isAuthorizedBusinessCoverageRetryTask(context,task,flow)){
    throw new Error('The current task does not own this normal business flow.');
  }
  const evidenceId=String(input.evidence_artifact_id||'');
  const artifacts=await context.repo.listArtifacts(context.scanRunId);
  const evidence=artifacts.find(artifact=>artifact.id===evidenceId);
  if(!evidence||!isNormalBusinessBlockerEvidence(evidence,taskId,flowId)){
    throw new Error('The supplied evidence_artifact_id is not a current-task server blocker for this normal business flow. Inspect/adapt the flow instead.');
  }
  const blocker=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:taskId,artifact_type:'business_flow_blocker',source_ref:evidence.id,
    title:'Normal business flow blocker',content_json:{flow_id:flowId,status:'blocked',reason,evidence_artifact_id:evidence.id,evidence_artifact_type:evidence.artifact_type}});
  const evidenceArtifactIds=[...new Set([...(flow.evidence_artifact_ids||[]),evidence.id,blocker.id])];
  await saveBusinessFlow(context.repo,context.scanRunId,taskId,{...flow,status:'blocked',blockers:[reason],evidence_artifact_ids:evidenceArtifactIds});
  return {flow_id:flowId,status:'blocked',reason,blocker_artifact_id:blocker.id,evidence_artifact_ids:evidenceArtifactIds,
    summary:'A server-evidenced normal-flow blocker was persisted for human follow-up.'};
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
      'Start complete task/action/identity-bound browser request-response recording for a defined normal business flow, before its first navigation. Operate the returned context with browser.navigate/interact. For an observed sign-in transition, keep the intended exact flow identity; BSTG itself creates the fresh unauthenticated task context, then navigate it and use bstg.identity.apply_login. Every repeated request is retained. A server-created coverage_retry task may start a new fresh capture after prior native evidence; its listed targets must be proven by this new task and callers cannot enable that retry through tool arguments. This does not execute or verify the business goal.',
      {flow_id:id,name:{type:'string',maxLength:200},identity_key:id,account_id:id,
        field_names:{type:'array',maxItems:50,items:{type:'string',minLength:1,maxLength:100}}},['flow_id'],
      (input,context)=>startBusinessCapture(context,input as any),['creates a recording session','attaches capture to an owned browser context']),
    tool('bstg.identity.apply_login',
      'Apply the exact scan-bound identity for an observed normal sign-in flow without revealing any credential to the model. First start this flow capture and navigate BSTG\'s returned fresh task context to the login page. This tool fills and submits the observed standard login form in that same browser, records the actual requests, and returns only safe authentication facts. It never guesses credentials, injects a session, bypasses OTP/captcha/MFA, or reuses a discovery-authenticated identity context as login evidence.',
      {flow_id:id},['flow_id'],(input,context)=>applyPreparedIdentityLogin(context,input),['uses a prepared scan identity only inside the current captured browser context','creates safe login evidence']),
    tool('bstg.business.capture.stop',
      'Stop this task-owned recording only after it contains a successful JSON response with an observable semantic body field and, when the Flow exposes objective_operation, an action-produced state-changing response matching its server-sealed operation; objective_completion.required_response_paths also requires its final response shapes. If it reports semantic_body_candidate_required or objective_completion_candidate_required, keep the capture active and choose the next browser action yourself. For an active final-outcome recovery, do not stop, prepare, or repeatedly inspect unchanged evidence: first choose a browser navigation or interaction; after it completes, refresh capture.inspect once and then decide again. Requests alone cannot establish that the business succeeded.',
      {},[],async(_input,context)=>{
        const session=await resolveCurrentBusinessLearningRecording(context);
        return stopBusinessCapture(context,session.id);
      },['finishes browser capture']),
    tool('bstg.business.capture.inspect',
      'Inspect the exact ordered normal-flow requests and responses, repeated calls, task/action/identity attribution and capture gaps. Values of credentials and verification material are redacted. Only events with workflow_eligible=true expose a selectable opaque event_id: they have current task-bound causal browser provenance and satisfy the native replay predicate; background/static/poll evidence has no selectable ID. Each eligible event may include server-derived observed_coverage_targets. When the Flow has a server-sealed operation contract, objective_operation lists only an opaque operation ID/class and opaque operation_candidate_event_ids; final-outcome objective_completion separately lists response-field shapes and opaque completion_candidate_event_ids. For an observed transaction chain, transaction_prerequisite_event_candidates groups replayable opaque IDs by the finite add/review/confirm intent that the model previously selected in the browser; select one per listed group yourself when it precedes the final operation. A coverage retry also returns retry_target_event_candidates; choose its exact event IDs yourself when preparing the Workflow. Use observed response fields to design business assertions.',
      {},[],async(_input,context)=>{
        const session=await resolveCurrentBusinessLearningRecording(context);
        return inspectBusinessCapture(context,session.id);
      }),
    tool('bstg.business.flow.block',
      'Persist a hard normal-flow blocker only after inspecting a current-task server artifact that proves it. Use this for credentials_unavailable, additional_verification_required, or interrupted/incomplete capture evidence. Supply the exact flow_id, evidence_artifact_id, and a concrete reason. Do not use it for a failed assertion, stale workflow, or an arbitrary model conclusion; inspect and adapt those instead.',
      {flow_id:id,evidence_artifact_id:id,reason:{type:'string',minLength:1,maxLength:1200}},['flow_id','evidence_artifact_id','reason'],
      (input,context)=>blockBusinessFlow(context,input),['persists a concrete normal-flow blocker and linked server evidence']),
    tool('bstg.business.workflow.prepare',
      'Promote one model-selected, causally complete normal transaction from a complete stopped recording into API templates and a normal Workflow. First inspect that stopped recording, then supply one or more exact workflow_eligible event_ids in their desired business sequence. event_ids are mandatory: BSTG never silently substitutes every captured event or drops an ineligible one. When objective_operation lists operation_candidate_event_ids, include at least one of those state-changing events; when objective_completion lists completion_candidate_event_ids, include at least one final-action event or BSTG publishes no Workflow. When transaction_prerequisite_event_candidates lists an observed add/review/confirm stage before that final event, explicitly include one opaque event ID from every listed stage; BSTG rejects an omission but never auto-adds it. When a coverage retry inspection lists target candidate event_ids, explicitly include one candidate for every scheduled target that appears in that recording. Include only the prerequisites, intended operation, and verification state needed for this normal transaction; do not retain a repeated one-time state-changing request after its successful occurrence unless you explicitly judge it required. The selected IDs must include an event whose inspection reports semantic_body_path_available; otherwise BSTG returns only opaque candidate event IDs and publishes no Workflow. Native replay preserves any task-scoped prepared-login prerequisite. Return dependency/mapping candidates; do not claim they are verified.',
      {event_ids:{type:'array',minItems:1,maxItems:200,uniqueItems:true,items:id},name:{type:'string',maxLength:200}},['event_ids'],
      async(input,context)=>{
        const session=await resolveCurrentBusinessLearningRecording(context);
        return prepareBusinessWorkflow(context,{recording_session_id:session.id,event_ids:input.event_ids,name:input.name});
      },['publishes native templates and a workflow from recording drafts']),
    tool('bstg.business.workflow.inspect',
      'Inspect normal workflow steps, safe request structure, source recording, observed identity, extracted values and candidate parameter dependencies. If objective_completion is present, it identifies the exact native source step order(s) that must carry its goal/state semantic assertion. Decide which mappings and session propagation are justified by the actual flow.',
      workflow,['workflow_id'],(input,context)=>inspectableBusinessWorkflow(context,input.workflow_id)),
    tool('bstg.business.workflow.repair',
      'Apply server-side execution learning only to the current Flow\'s latest failed native normal Workflow and its task-bound private trace. Use this after workflow.validate reports an execution error, then inspect the repaired workflow and choose a fresh validation. It rejects other tasks, flows, runs, and semantic-only assertion mismatches; it never exposes trace values.',
      {workflow_id:id,test_run_id:id},['workflow_id','test_run_id'],(input,context)=>repairBusinessWorkflow(context,input as {workflow_id:string;test_run_id:string}),
      ['applies scoped execution learning to current normal workflow mappings/extractors/session handling','creates safe repair evidence']),
    tool('bstg.business.workflow.revise',
      'Create a new task-bound normal Workflow from a model-selected subset of exact workflow_eligible event IDs in the current stopped recording. Use it only after the current normal validation failed and a scoped repair cannot make the selected path executable. Choose the event_ids yourself from bstg.business.capture.inspect or the current workflow coverage bindings; background/static/poll events are not candidates, and BSTG never silently removes a failing step or current observed coverage. If transaction_prerequisite_event_candidates lists observed add/review/confirm stages before the selected final operation, retain one opaque event from each listed stage yourself. The broader model-owned coverage plan remains intact: a separately planned target not present in this recording becomes a fresh task-scoped retry only after this revised Workflow validates. The previous Workflow/Test Run and trace remain immutable evidence, while the new revision must be inspected and validated afresh.',
      {workflow_id:id,test_run_id:id,event_ids:{type:'array',minItems:1,maxItems:200,uniqueItems:true,items:id},name:{type:'string',minLength:1,maxLength:200},rationale:{type:'string',minLength:1,maxLength:1600}},['workflow_id','test_run_id','event_ids','rationale'],
      (input,context)=>reviseBusinessWorkflow(context,input as {workflow_id:string;test_run_id:string;event_ids:string[];name?:string;rationale:string}),
      ['creates an append-only normal Workflow revision from model-selected observed events','retains prior native evidence and resets only the active Flow validation state']),
    tool('bstg.business.workflow.validate',
      'Run a new native Test Run for this normal Workflow. First inspect it and select each left.path exactly from that step\'s assertion_paths: status, headers.<observed-header>, or body.<observed-json-field>. Bare body, HTML, and text are invalid. At least one goal/identity/state assertion must use an observed body.<field>; HTTP status alone is insufficient. When objective_operation is present, it requires a goal/state body assertion on one of its exact source steps; when objective_completion is present, every required response path needs a goal/state assertion on one of its exact completion_source_step_orders; a prerequisite, review, or later unrelated step cannot prove it. For a coverage retry, each scheduled target needs a goal/identity/state body assertion on one of that target\'s exact source_step_order values in coverage_bindings; an assertion on another replayed step cannot prove the target. When the expected normal value is private and stable, use right.type "captured_baseline" with equals. For an opaque fresh identifier, use a safe shape predicate such as regex ".+" rather than inventing a literal. Any inspect candidate marked required_for_replay is a narrow recording-proved transport prerequisite and is applied server-side; choose mapping IDs only for additional business mappings and decide session propagation yourself. Invalid assertion input returns value-free revision feedback and starts no Test Run. Return actual verified or failed outcome and fresh evidence; the model cannot self-report a pass.',
      {...workflow,assertions:{type:'array',minItems:1,maxItems:50,items:assertion},mapping_ids:{type:'array',maxItems:100,uniqueItems:true,items:id},apply_session_jar:{type:'boolean'}},
      ['workflow_id','assertions'],(input,context)=>validateBusinessWorkflow(context,input as any),['creates a native normal Test Run','evaluates business assertions','persists normal flow evidence']),
  ];
}
