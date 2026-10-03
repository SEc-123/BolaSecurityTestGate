import { createHash } from 'node:crypto';
import type { AIScanArtifact, AIScanRun, AIScanTask } from '../services/ai-scan/types.js';
import type { AIScanRepository } from '../services/ai-scan/repository.js';
import type { DbProvider, TestRun, Workflow } from '../types/index.js';
import { saveBusinessFlow, sealedStrictObjectiveBindings, type BusinessCoverageBinding, type BusinessCoverageProof, type BusinessFlow } from '../services/ai-scan/agent-business-contract.js';
import { normalObjectiveManifestForTask, strictNormalObjectiveFlowGap } from './normal-business-objectives.js';

export const BUSINESS_PLAN_INTENT = 'plan_business_flows';
export const BUSINESS_LEARNING_INTENT = 'learn_business_flow';
export const BUSINESS_REVIEW_INTENT = 'review_business_flows';
export const BUSINESS_EXPERIMENT_INTENT = 'model_business_experiment';
export const BUSINESS_COVERAGE_ARTIFACT = 'business_flow_coverage';
export const MIN_NEGATIVE_COUNTEREXAMPLE_ATTEMPTS = 3;
/** A retry may receive one server-forced fresh capture when its first native
 * validation proves the Flow but misses one of the retry's exact targets. */
export const COVERAGE_RETRY_COMPLETION_RECOVERY_PHASE = 'coverage_retry_completion_gap_requires_fresh_capture';

// A single runtime can reconcile the same terminal Flow from both the normal
// completion path and the decision-budget boundary. Serialize that narrow
// create sequence so two concurrent reconciliations share one child task.
// Subsequent calls remain idempotent through the persisted child lookup below.
const coverageRetryScheduling = new Map<string, Promise<AIScanTask | undefined>>();

async function scheduleOnce<T>(key:string,work:()=>Promise<T>):Promise<T> {
  const inFlight=coverageRetryScheduling.get(key) as Promise<T>|undefined;
  if(inFlight)return inFlight;
  const pending=work();coverageRetryScheduling.set(key,pending as Promise<AIScanTask|undefined>);
  try{return await pending;}finally{if(coverageRetryScheduling.get(key)===pending)coverageRetryScheduling.delete(key);}
}

/**
 * SQLite and PostgreSQL both store these IDs as text today, but keep the
 * scheduler's idempotency keys UUID-shaped so a future UUID migration remains
 * compatible. The namespace keeps a retry task and its audit artifact apart.
 */
function deterministicSchedulerUuid(namespace:string, scanRunId:string, originTaskId:string):string {
  const digest=createHash('sha256').update(`${namespace}\u0000${scanRunId}\u0000${originTaskId}`).digest('hex');
  const variant=((Number.parseInt(digest[16],16)&0x3)|0x8).toString(16);
  return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-${variant}${digest.slice(17,20)}-${digest.slice(20,32)}`;
}

export function coverageRetryTaskId(scanRunId:string, originTaskId:string):string {
  return deterministicSchedulerUuid('bstg:coverage-retry-task:v1',scanRunId,originTaskId);
}

function coverageRetryAuditArtifactId(scanRunId:string, originTaskId:string):string {
  return deterministicSchedulerUuid('bstg:coverage-retry-audit:v1',scanRunId,originTaskId);
}

function isUniqueConstraintError(error:unknown):boolean {
  return /unique|duplicate|constraint/i.test(String((error as any)?.message||error||''));
}

/**
 * Planning is deliberately broader than a list of happy-path flows.  Each
 * discovered operation remains visible until the model either associates it
 * with a normal flow or writes down why it is deliberately deferred/blocked.
 * This record is safe to show to the model: it contains identifiers and
 * descriptions, never captured request values.
 */
export interface BusinessCoverageTarget {
  key: string;
  target_type: 'feature' | 'operation';
  target_id: string;
  name: string;
  feature_id?: string;
}

export interface BusinessCoverageEntry {
  target_type: 'feature' | 'operation';
  target_id: string;
  disposition: 'planned' | 'deferred' | 'blocked';
  flow_id?: string;
  reason?: string;
}

export interface BusinessCoverageRecord {
  revision: number;
  plan_task_id: string;
  target_manifest: BusinessCoverageTarget[];
  entries: BusinessCoverageEntry[];
}

export function businessCoverageKey(targetType: string, targetId: string): string {
  return `${targetType}:${targetId}`;
}

/**
 * Browser discovery records both navigation context and executable operations.
 * A document/page GET tells the model how the product is reached, but it is
 * not itself a normal-business operation that a later Workflow must prove.
 * Keep legacy browser_network rows eligible: older rows do not retain a safe
 * resource-type provenance, so guessing from a route or method would discard
 * real API reads. New discovery runs write browser_navigation for documents.
 * A browser_js_reference is only a static code hint. It stays available for
 * later security modeling, but cannot force a normal-flow proof until an
 * actual browser operation upgrades the same endpoint provenance.
 */
export function isPlanningCoverageEndpoint(endpoint: { method?: string; source_type?: string }): boolean {
  const method = String(endpoint.method || '').toUpperCase();
  const sourceType = String(endpoint.source_type || '');
  if (!method || method === 'OPTIONS' || method === 'HEAD') return false;
  // This metadata is promoted only after the model chose an executable normal
  // Workflow step. It feeds proof and later security modeling, but it cannot
  // retroactively alter the already-saved planning inventory.
  if (sourceType === 'normal_business_capture') return false;
  if (sourceType === 'browser_js_reference') return false;
  if (method !== 'GET') return true;
  return !['browser_navigation', 'browser_page'].includes(sourceType);
}

/**
 * A feature node is a planning target only when it owns an actual planning
 * operation. Page-only feature nodes remain useful navigation context, but
 * must not force an unrelated business Flow into a coverage retry.
 */
export async function businessCoverageTargets(repo: AIScanRepository, scanRunId: string): Promise<BusinessCoverageTarget[]> {
  const [features, endpoints] = await Promise.all([repo.listFeatures(scanRunId), repo.listEndpoints(scanRunId)]);
  const planningEndpoints = endpoints.filter(isPlanningCoverageEndpoint);
  const planningEndpointIds = new Set(planningEndpoints.map(endpoint => endpoint.id));
  const targets: BusinessCoverageTarget[] = [];
  for (const feature of features) {
    if (!Array.isArray(feature.endpoint_ids) || !feature.endpoint_ids.some(endpointId => planningEndpointIds.has(endpointId))) continue;
    targets.push({
      key: businessCoverageKey('feature', feature.id),
      target_type: 'feature',
      target_id: feature.id,
      name: feature.name,
    });
  }
  for (const endpoint of planningEndpoints) {
    const owner = features.find(feature => (feature.endpoint_ids || []).includes(endpoint.id));
    targets.push({
      key: businessCoverageKey('operation', endpoint.id),
      target_type: 'operation',
      target_id: endpoint.id,
      name: `${endpoint.method} ${endpoint.path}`,
      ...(owner ? { feature_id: owner.id } : {}),
    });
  }
  return targets.sort((left, right) => left.key.localeCompare(right.key));
}

function artifactRevision(artifact: AIScanArtifact): number {
  return Number.isInteger(artifact.content_json?.revision) ? Number(artifact.content_json.revision) : 0;
}

function newestArtifact(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  return [...artifacts].sort((left, right) =>
    String(right.created_at).localeCompare(String(left.created_at)) || artifactRevision(right) - artifactRevision(left))[0];
}

export function latestBusinessCoverage(artifacts: AIScanArtifact[], planTaskId: string): AIScanArtifact | undefined {
  return newestArtifact(artifacts.filter(artifact => artifact.artifact_type === BUSINESS_COVERAGE_ARTIFACT &&
    artifact.task_id === planTaskId && artifact.content_json?.plan_task_id === planTaskId));
}

/** A coverage record is current only when it names every currently discovered
 * actionable feature/operation exactly once.  It is intentionally an async
 * gate because discovery may have added a target after the previous plan. */
export async function businessPlanningCompletionGap(repo: AIScanRepository, planTask: AIScanTask,
  flows: BusinessFlow[], artifacts: AIScanArtifact[] = []): Promise<string | undefined> {
  const coverageArtifact = latestBusinessCoverage(artifacts, planTask.id);
  if (!coverageArtifact) return 'No model-saved business coverage list exists. Cover every discovered feature/operation or record a deferred/blocked reason.';
  const coverage = coverageArtifact.content_json as Partial<BusinessCoverageRecord>;
  if (!Array.isArray(coverage.entries) || !Array.isArray(coverage.target_manifest)) {
    return 'The saved business coverage list is malformed; inspect the current discovery targets and save it again.';
  }
  const targets = await businessCoverageTargets(repo, planTask.scan_run_id);
  const expected = new Map(targets.map(target => [target.key, target]));
  const seen = new Set<string>();
  for (const entry of coverage.entries as BusinessCoverageEntry[]) {
    const key = businessCoverageKey(String(entry?.target_type || ''), String(entry?.target_id || ''));
    if (!expected.has(key)) return `The saved coverage list names an obsolete or unknown target (${key}); refresh it from current discovery.`;
    if (seen.has(key)) return `The saved coverage list names ${key} more than once.`;
    seen.add(key);
    if (!['planned', 'deferred', 'blocked'].includes(String(entry?.disposition || ''))) {
      return `Coverage for ${key} has no valid planned, deferred, or blocked disposition.`;
    }
    if (entry.disposition === 'planned') {
      if (!entry.flow_id || !flows.some(flow => flow.id === entry.flow_id)) {
        return `Coverage for ${key} is planned but does not reference a current saved business flow.`;
      }
    } else if (!String(entry.reason || '').trim()) {
      return `Coverage for ${key} is ${entry.disposition} without a concrete reason.`;
    }
  }
  const missing = [...expected.keys()].filter(key => !seen.has(key));
  if (missing.length) return `The model coverage list still omits ${missing.length} discovered feature/operation target(s): ${missing.slice(0, 8).join(', ')}.`;
  const objectiveGap = strictNormalObjectiveFlowGap(planTask, flows);
  if (objectiveGap) return objectiveGap;
  return undefined;
}

/**
 * Planning merely assigns a target to a proposed normal flow.  Before a
 * verified flow can release review or a security experiment, require a
 * server-derived chain: discovered target → captured browser event/action →
 * source workflow step → fresh native normal Test Run.  A flow that the
 * executor actually blocked/failed remains visible as a concrete coverage
 * gap; it is not silently counted as successful coverage.
 */
function plannedCoverageEntries(coverage: BusinessCoverageRecord, flowId?: string): BusinessCoverageEntry[] {
  const planned=(coverage.entries||[]).filter(entry=>entry.disposition==='planned');
  return flowId?planned.filter(entry=>entry.flow_id===flowId):planned;
}

function coverageProofsForFlow(flow:BusinessFlow):Array<BusinessCoverageProof|BusinessCoverageBinding> {
  // Legacy Flow artifacts predate the sealed ledger. Preserve their former
  // behavior until they are upgraded at a retry boundary; every new native
  // validation writes a ledger entry and never takes this compatibility path.
  return Array.isArray(flow.coverage_proof_ledger)?flow.coverage_proof_ledger:
    (Array.isArray(flow.coverage_bindings)?flow.coverage_bindings:[]);
}

function completedAssertionIds(validation:any):Set<string> {
  return new Set((Array.isArray(validation?.content_json?.assertions)?validation.content_json.assertions:[])
    .filter((assertion:any)=>assertion?.passed===true).map((assertion:any)=>String(assertion.id||'')));
}

function normalizedAssertionIds(value:unknown):string[] {
  return [...new Set((Array.isArray(value)?value:[]).map(item=>String(item||'').trim()).filter(Boolean))].sort();
}

/** A sealed proof is accepted only when the immutable validation artifact
 * repeats every source edge. Checking only its workflow/run would let a
 * stale or forged ledger row borrow a real validation from another target. */
function validationBindingMatchesProof(binding:any,proof:BusinessCoverageProof|BusinessCoverageBinding):boolean {
  return Boolean(binding&&typeof binding==='object'&&binding.validated===true&&
    String(binding.target_type||'')===proof.target_type&&String(binding.target_id||'')===proof.target_id&&
    String(binding.endpoint_id||'')===proof.endpoint_id&&String(binding.source_event_id||'')===proof.source_event_id&&
    String(binding.action_id||'')===proof.action_id&&Number(binding.source_step_order)===proof.source_step_order&&
    String(binding.source_workflow_id||'')===proof.source_workflow_id&&
    String(binding.normal_workflow_id||'')===proof.normal_workflow_id&&String(binding.normal_run_id||'')===proof.normal_run_id&&
    JSON.stringify(normalizedAssertionIds(binding.validation_assertion_ids))===JSON.stringify(normalizedAssertionIds(proof.validation_assertion_ids)));
}

function nativeTraceMatchesProof(flow:BusinessFlow,proof:BusinessCoverageProof|BusinessCoverageBinding,
  validation:AIScanArtifact,artifacts:AIScanArtifact[],traceArtifactId?:string):boolean {
  return artifacts.some(artifact=>(!traceArtifactId||artifact.id===traceArtifactId)&&artifact.artifact_type==='business_native_trace'&&
    String(artifact.task_id||'')===String(validation.task_id||'')&&String(artifact.source_ref||'')===proof.normal_run_id&&
    String(artifact.content_json?.flow_id||'')===flow.id&&String(artifact.content_json?.test_run_id||'')===proof.normal_run_id&&
    String(artifact.content_json?.workflow_id||'')===proof.normal_workflow_id&&artifact.content_json?.private===true);
}

function nativeValidationMatchesProof(flow:BusinessFlow,proof:BusinessCoverageProof|BusinessCoverageBinding,
  validation:AIScanArtifact,artifacts:AIScanArtifact[],requiredTaskId?:string,traceArtifactId?:string):boolean {
  if(String(validation.task_id||'')===''||requiredTaskId&&String(validation.task_id||'')!==requiredTaskId||
    validation.artifact_type!=='business_workflow_validation'||String(validation.content_json?.flow_id||'')!==flow.id||
    String(validation.content_json?.workflow_id||'')!==proof.normal_workflow_id||String(validation.content_json?.test_run_id||'')!==proof.normal_run_id||
    validation.content_json?.assertions_verified!==true)return false;
  const bindings=Array.isArray(validation.content_json?.coverage_bindings)?validation.content_json.coverage_bindings:[];
  const passed=completedAssertionIds(validation);
  return bindings.some(binding=>validationBindingMatchesProof(binding,proof))&&
    normalizedAssertionIds(proof.validation_assertion_ids).every(id=>passed.has(id))&&
    nativeTraceMatchesProof(flow,proof,validation,artifacts,traceArtifactId);
}

/** Validate the append-only ledger against the independent native artifacts.
 * The Flow's active workflow/run may move to a child coverage retry, so an old
 * proof must never be compared to those mutable current fields. */
function nativeCoverageProofValid(flow:BusinessFlow, proof:BusinessCoverageProof|BusinessCoverageBinding,
  artifacts:AIScanArtifact[], requiredTaskId?:string):boolean {
  if(proof?.validated!==true||!proof.target_type||!proof.target_id||!proof.endpoint_id||!proof.source_event_id||!proof.action_id||
    !Number.isInteger(proof.source_step_order)||!proof.source_workflow_id||!proof.normal_workflow_id||!proof.normal_run_id||
    !Array.isArray(proof.validation_assertion_ids)||!proof.validation_assertion_ids.length)return false;
  // Older Flow revisions lack the sealed artifact IDs, but they still must
  // reconstruct the complete native chain. If that historical chain is not
  // present, leave the target unproven so a fresh bounded retry can relearn it.
  if(!Array.isArray(flow.coverage_proof_ledger)){
    return artifacts.some(validation=>nativeValidationMatchesProof(flow,proof,validation,artifacts,requiredTaskId));
  }
  const sealed=proof as BusinessCoverageProof;
  if(!sealed.validation_artifact_id||!sealed.validated_task_id||!sealed.trace_artifact_id||requiredTaskId&&sealed.validated_task_id!==requiredTaskId)return false;
  const validation=artifacts.find(artifact=>artifact.id===sealed.validation_artifact_id&&artifact.artifact_type==='business_workflow_validation');
  return Boolean(validation&&String(validation.task_id||'')===sealed.validated_task_id&&
    nativeValidationMatchesProof(flow,sealed,validation,artifacts,requiredTaskId,sealed.trace_artifact_id));
}

function hasNativeFlowBlockerEvidence(flow:BusinessFlow,artifacts:AIScanArtifact[]):boolean {
  const taskId=String(flow.owner_task_id||'');
  if(!taskId)return false;
  const linked=new Set((flow.evidence_artifact_ids||[]).map(id=>String(id||'')).filter(Boolean));
  return artifacts.some(artifact=>linked.has(artifact.id)&&isNormalBusinessBlockerEvidence(artifact,taskId,flow.id));
}

function coverageEntryBindingGap(entry: BusinessCoverageEntry, flowById: Map<string, BusinessFlow>, artifacts:AIScanArtifact[], requiredTaskId?:string): string | undefined {
  const flow=entry.flow_id?flowById.get(entry.flow_id):undefined;
  const key=businessCoverageKey(entry.target_type,entry.target_id);
  if(!flow)return `Planned coverage for ${key} no longer has its assigned business flow.`;
  if(flow.status==='blocked'){
    if((flow.blockers||[]).some(item=>String(item).trim())&&hasNativeFlowBlockerEvidence(flow,artifacts))return undefined;
    return `Planned coverage for ${key} stopped without persisted native blocker evidence.`;
  }
  if(flow.status==='failed')return `Planned coverage for ${key} has failed normal validation and remains unproven.`;
  if(flow.status!=='verified'||flow.assertions_verified!==true||!flow.normal_run_id||!flow.workflow_id){
    return `Planned coverage for ${key} has not reached a verified native normal flow.`;
  }
  const matched=coverageProofsForFlow(flow).some(proof=>proof.target_type===entry.target_type&&proof.target_id===entry.target_id&&
    nativeCoverageProofValid(flow,proof,artifacts,requiredTaskId));
  if(!matched){
    return `Planned coverage for ${key} is assigned to ${flow.name}, but no captured browser action and native validated workflow step prove that target was exercised.`;
  }
  return undefined;
}

function unprovenPlannedCoverageEntries(coverage: BusinessCoverageRecord, flows: BusinessFlow[], artifacts:AIScanArtifact[], flowId?: string,
  requiredTaskId?:string): Array<{entry: BusinessCoverageEntry; reason: string}> {
  const flowById=new Map(flows.map(flow=>[flow.id,flow]));
  return plannedCoverageEntries(coverage,flowId).flatMap(entry=>{
    const reason=coverageEntryBindingGap(entry,flowById,artifacts,requiredTaskId);
    return reason?[{entry,reason}]:[];
  });
}

export function businessCoverageBindingGap(coverage: BusinessCoverageRecord, flows: BusinessFlow[], flowId?: string,
  artifacts:AIScanArtifact[]=[]): string | undefined {
  // A learning task owns one Flow. It must prove every target assigned to that
  // Flow, but model-defined flows without a pre-discovery operation still
  // receive a native validation task. Their own normal evidence is sufficient;
  // they must not be forced into a synthetic coverage retry.
  return unprovenPlannedCoverageEntries(coverage,flows,artifacts,flowId)[0]?.reason;
}

function retryCoverageTargets(task:AIScanTask):Array<{key:string;target_type:'feature'|'operation';target_id:string}>|undefined {
  const targets=task.execution_plan?.coverage_retry?.targets;
  if(!Array.isArray(targets)||!targets.length)return undefined;
  const seen=new Set<string>(),result:Array<{key:string;target_type:'feature'|'operation';target_id:string}>=[];
  for(const target of targets){
    const target_type=String(target?.target_type||'') as 'feature'|'operation',target_id=String(target?.target_id||''),key=String(target?.key||'');
    if(!['feature','operation'].includes(target_type)||!target_id||key!==businessCoverageKey(target_type,target_id)||seen.has(key))return undefined;
    seen.add(key);result.push({key,target_type,target_id});
  }
  return result;
}

/** Return only a valid retry's outstanding target proof. Malformed retry
 * metadata remains a terminal contract error in businessCompletionGap; it is
 * not safe to start a capture for an unknown target. */
export function coverageRetryTargetBindingGap(task:AIScanTask, flows:BusinessFlow[], artifacts:AIScanArtifact[]):string|undefined {
  const targets=retryCoverageTargets(task);
  if(!task.execution_plan?.coverage_retry || !targets)return undefined;
  const flow=flows.find(item=>item.id===task.execution_plan?.flow_id);
  if(!flow)return 'This coverage retry no longer has its assigned normal business flow.';
  for(const target of targets){
    const proof=coverageProofsForFlow(flow).some(item=>item.target_type===target.target_type&&item.target_id===target.target_id&&
      nativeCoverageProofValid(flow,item,artifacts,task.id));
    if(!proof)return `Coverage retry has not yet proved its required target ${target.key} in this fresh task-scoped native validation.`;
  }
  return undefined;
}

function retryCoverageBindingGap(task:AIScanTask, flows:BusinessFlow[], artifacts:AIScanArtifact[]):string|undefined {
  if(!task.execution_plan?.coverage_retry)return undefined;
  if(!retryCoverageTargets(task))return 'This coverage retry has malformed server target references and cannot complete.';
  return coverageRetryTargetBindingGap(task,flows,artifacts);
}

async function plannedCoverageBindingGap(repo: AIScanRepository, scanRunId:string, flows:BusinessFlow[], artifacts:AIScanArtifact[], flowId?: string):Promise<string|undefined>{
  const planTask=(await repo.listTasks(scanRunId)).find(task=>task.execution_plan?.intent===BUSINESS_PLAN_INTENT);
  if(!planTask)return 'No business planning task exists for coverage verification.';
  const coverageArtifact=latestBusinessCoverage(artifacts,planTask.id);
  if(!coverageArtifact)return 'No model-saved business coverage list exists for coverage verification.';
  const coverage=coverageArtifact.content_json as BusinessCoverageRecord;
  return businessCoverageBindingGap(coverage,flows,flowId,artifacts);
}

export function businessLearningEnabled(run: Pick<AIScanRun, 'scan_config'>): boolean {
  const config = run.scan_config || {};
  return ![config.surface, config.surface_type, config.mobile?.platform, config.android?.platform].includes('android') &&
    config.business_learning !== false && config.business_learning?.enabled !== false;
}

/**
 * Android has an independent, opt-in business lifecycle.  In particular, an
 * Android surface must never enter the browser-capture lifecycle merely
 * because business_learning is otherwise enabled.  The explicit flag keeps
 * existing mobile acquisition unchanged until an operator asks to bind its
 * already imported Appium/HTTPS evidence to the Agent stages.
 */
export function androidBusinessLearningEnabled(run: Pick<AIScanRun, 'scan_config'>): boolean {
  const config = run.scan_config || {};
  const android = [config.surface, config.surface_type, config.mobile?.platform, config.android?.platform].includes('android');
  return android && config.business_learning !== false && config.business_learning?.enabled !== false &&
    config.business_learning?.android_enabled === true;
}

/** A normal-flow-only run is an explicit first stage, not a hidden shortcut.
 * It proves and persists business behavior before a later assessment creates
 * any candidate or experiment work. */
export function businessLearningOnly(run: Pick<AIScanRun, 'scan_config'>): boolean {
  const config = run.scan_config || {};
  return config.business_learning?.mode === 'normal_only' || config.agent_execution_scope === 'business_flow_learning';
}

/**
 * This is a persisted execution mode for an end-to-end business run: prove
 * normal flows first, then let the model run the evidence-gated business
 * experiments.  It deliberately does not imply that any generic vulnerability
 * candidate has been selected.  Candidate generation can still leave its
 * inventory for review, but that interactive handoff must not pause the
 * business-experiment lane.
 */
export function businessLearningAutoExperiments(run: { scan_config?: Record<string, any> }): boolean {
  const config = run.scan_config || {};
  return config.business_learning?.mode === 'normal_then_model_experiment';
}

export function latestBusinessFlows(artifacts: AIScanArtifact[]): BusinessFlow[] {
  const latest = new Map<string, AIScanArtifact>();
  for (const artifact of artifacts.filter(item => item.artifact_type === 'business_flow')) {
    const id = String(artifact.content_json?.id || '');
    if (!id) continue;
    const previous = latest.get(id);
    if (!previous || Number(artifact.content_json.revision || 0) > Number(previous.content_json.revision || 0) ||
      (Number(artifact.content_json.revision || 0) === Number(previous.content_json.revision || 0) &&
        String(artifact.created_at) > String(previous.created_at))) latest.set(id, artifact);
  }
  return [...latest.values()].map(artifact => artifact.content_json as BusinessFlow);
}

/**
 * A normal-flow block is meaningful only when the server has already observed
 * an unrecoverable prerequisite or an interrupted/incomplete capture.  A
 * model's narrative, an ordinary failed assertion, or an arbitrary artifact
 * ID are not enough: those are feedback for another learning attempt.
 */
export function isNormalBusinessBlockerEvidence(artifact: Pick<AIScanArtifact, 'artifact_type' | 'task_id' | 'content_json'> | undefined,
  taskId: string, flowId: string): boolean {
  if (!artifact || String(artifact.task_id || '') !== taskId) return false;
  const content = artifact.content_json || {};
  if (String(content.flow_id || '') !== flowId) return false;
  if (artifact.artifact_type === 'business_capture_session') {
    const status = String(content.status || '');
    return status === 'interrupted' || (status === 'incomplete' && Array.isArray(content.errors) && content.errors.length > 0);
  }
  if (artifact.artifact_type === 'business_identity_login') {
    return content.authenticated === false && ['credentials_unavailable', 'additional_verification_required'].includes(String(content.status || ''));
  }
  return false;
}

export interface BusinessLearningTerminalDisposition {
  kind: 'blocked' | 'failed';
  reason: string;
  evidence_artifact_ids: string[];
}

/**
 * Flow.status is append-only state, so do not let its value alone settle the
 * task. The latest Flow must carry a concrete blocker message and point to a
 * same-task server artifact that independently proves the blocker. This also
 * catches older/corrupt Flow blocks that were written without evidence.
 */
export function businessLearningTerminalDisposition(task: Pick<AIScanTask, 'id' | 'execution_plan'>,
  artifacts: AIScanArtifact[]): BusinessLearningTerminalDisposition | undefined {
  if (task.execution_plan?.intent !== BUSINESS_LEARNING_INTENT) return undefined;
  const flowId = String(task.execution_plan?.flow_id || '');
  const flow = latestBusinessFlows(artifacts).find(item => item.id === flowId);
  if (!flow || flow.status !== 'blocked') return undefined;
  const blockers = (flow.blockers || []).map(item => String(item || '').trim()).filter(Boolean);
  const linkedIds = [...new Set((flow.evidence_artifact_ids || []).map(item => String(item || '')).filter(Boolean))];
  const linked = artifacts.filter(artifact => linkedIds.includes(artifact.id));
  const evidence = linked.filter(artifact => isNormalBusinessBlockerEvidence(artifact, task.id, flowId));
  if (blockers.length && evidence.length) {
    return { kind: 'blocked', reason: blockers[0], evidence_artifact_ids: evidence.map(artifact => artifact.id) };
  }
  return {
    kind: 'failed',
    reason: 'A normal business flow was marked blocked without both a concrete persisted reason and linked server blocker evidence.',
    evidence_artifact_ids: evidence.map(artifact => artifact.id),
  };
}

/** The scheduler owns stage/dependency construction. Business names, goals,
 * operations, mappings and assertions remain the model's observed decisions. */
export async function scheduleBusinessLearning(repo: AIScanRepository, planTask: AIScanTask): Promise<AIScanTask[]> {
  const artifacts = await repo.listArtifacts(planTask.scan_run_id);
  const flows = latestBusinessFlows(artifacts);
  const coverageGap = await businessPlanningCompletionGap(repo, planTask, flows, artifacts);
  if (coverageGap) throw new Error(coverageGap);
  const coverage = latestBusinessCoverage(artifacts, planTask.id)?.content_json as BusinessCoverageRecord;
  const plannedFlowIds = new Set((coverage.entries || []).filter(entry => entry.disposition === 'planned').map(entry => entry.flow_id).filter((id): id is string => Boolean(id)));
  // The initial business-flow artifact is durable planning provenance. A Flow
  // changes owner_task_id once its learning task is created, so reading only
  // its latest revision would make a partially completed scheduling pass lose
  // unassociated model-defined Flows on a retry.
  const planningDefinedFlowIds = new Set(artifacts
    .filter(artifact => artifact.artifact_type === 'business_flow' && artifact.task_id === planTask.id)
    .map(artifact => String(artifact.content_json?.id || artifact.source_ref || ''))
    .filter(Boolean));
  const scheduledFlowIds = new Set([...plannedFlowIds, ...planningDefinedFlowIds]);
  // A strict manifest is an explicit operator-owned sequence of normal
  // outcomes. Persist that order into task priority rather than relying on
  // artifact retrieval order (which can be reverse-chronological). This lets
  // later objectives observe the normal state created by earlier ones while
  // leaving unrelated non-strict flows independent.
  const objectiveOrder = new Map(normalObjectiveManifestForTask(planTask).map((objective, index) => [objective.id, index]));
  const scheduledFlows = flows.filter(item => scheduledFlowIds.has(item.id)).sort((left, right) => {
    const leftOrder = objectiveOrder.get(String(left.objective_id || ''));
    const rightOrder = objectiveOrder.get(String(right.objective_id || ''));
    if (leftOrder !== undefined || rightOrder !== undefined) {
      const normalizedLeft = leftOrder ?? Number.MAX_SAFE_INTEGER;
      const normalizedRight = rightOrder ?? Number.MAX_SAFE_INTEGER;
      if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
    }
    return String(left.id).localeCompare(String(right.id));
  });
  const existing = await repo.listTasks(planTask.scan_run_id);
  const learning: AIScanTask[] = [];
  for (const [flowIndex, flow] of scheduledFlows.entries()) {
    const previous = existing.find(task => task.execution_plan?.intent === BUSINESS_LEARNING_INTENT && task.execution_plan.flow_id === flow.id);
    if (previous) { learning.push(previous); continue; }
    const task = await repo.createTask({scan_run_id: planTask.scan_run_id, parent_task_id: planTask.id,
      task_type: 'learn_business_flow', title: `学习并验证正常业务：${flow.name}`, priority: 25 + Math.min(flowIndex, 50),
      dependencies: [planTask.id], agent_goal: `完成并核验“${flow.name}”的正常业务目标：${flow.goal}。先开始绑定该流程和身份的录制，再实际操作页面；检查有序请求、响应和参数依赖，复用原生录制生成器准备 Workflow，选择有证据的映射和结果断言，执行新的正常 Test Run。失败时观察原因并调整，不把录制或 HTTP 成功算作业务验证。`,
      execution_plan: {intent: BUSINESS_LEARNING_INTENT, flow_id: flow.id, identity_key: flow.role,
        feature_id: flow.feature_id, parallel_capable: false, requires_identity_context: flow.role !== 'anonymous'}});
    await saveBusinessFlow(repo, planTask.scan_run_id, task.id, {...flow, owner_task_id: task.id});
    learning.push(task);
  }
  const review = existing.find(task => task.execution_plan?.intent === BUSINESS_REVIEW_INTENT && task.status === 'pending');
  if (review) await repo.updateTask(review.id, {dependencies: [...new Set([planTask.id, ...learning.map(task => task.id)])]});
  return learning;
}

/**
 * A native validation can prove that a normal Flow works while also proving
 * that the model exercised the wrong planned target.  Preserve that immutable
 * evidence, then give the model one fresh, task-scoped capture context to
 * learn the missing target.  This scheduler never invents a business action
 * or alters the model-owned coverage list: it only carries the server-derived
 * unresolved target references into a bounded retry task.
 */
function coverageRetryTargetKeys(value:unknown):string[]|undefined {
  if(!Array.isArray(value)||!value.length)return undefined;
  const keys=new Set<string>();
  for(const target of value){
    const targetType=String(target?.target_type||''),targetId=String(target?.target_id||''),key=String(target?.key||'');
    if(!['feature','operation'].includes(targetType)||!targetId||key!==businessCoverageKey(targetType,targetId)||keys.has(key))return undefined;
    keys.add(key);
  }
  return [...keys].sort();
}

function sameCoverageRetryTargets(left:unknown,right:unknown):boolean {
  const leftKeys=coverageRetryTargetKeys(left),rightKeys=coverageRetryTargetKeys(right);
  return Boolean(leftKeys&&rightKeys&&leftKeys.length===rightKeys.length&&leftKeys.every((key,index)=>key===rightKeys[index]));
}

function isMatchingCoverageRetryTask(task:AIScanTask|undefined|null, learningTask:AIScanTask, flow:BusinessFlow,
  expectedTargets?:unknown, requireStableId=false):task is AIScanTask {
  const retry=task?.execution_plan?.coverage_retry;
  if(!task||task.scan_run_id!==learningTask.scan_run_id||task.parent_task_id!==learningTask.id||task.task_type!=='learn_business_flow'||
    task.execution_plan?.intent!==BUSINESS_LEARNING_INTENT||String(task.execution_plan?.flow_id||'')!==flow.id||
    String(retry?.origin_task_id||'')!==learningTask.id||Number(retry?.attempt)!==1||!coverageRetryTargetKeys(retry?.targets))return false;
  if(requireStableId&&task.id!==coverageRetryTaskId(learningTask.scan_run_id,learningTask.id))return false;
  return expectedTargets===undefined||sameCoverageRetryTargets(retry?.targets,expectedTargets);
}

function isMatchingCoverageRetryAudit(artifact:AIScanArtifact, learningTask:AIScanTask, flow:BusinessFlow,
  retry:AIScanTask, auditTargets:unknown):boolean {
  return artifact.artifact_type==='business_coverage_retry_scheduled'&&String(artifact.task_id||'')===learningTask.id&&
    String(artifact.source_ref||'')===retry.id&&String(artifact.content_json?.flow_id||'')===flow.id&&
    String(artifact.content_json?.source_task_id||'')===learningTask.id&&String(artifact.content_json?.retry_task_id||'')===retry.id&&
    sameCoverageRetryTargets(artifact.content_json?.targets,auditTargets);
}

async function ensureCoverageRetryAudit(repo:AIScanRepository, learningTask:AIScanTask, flow:BusinessFlow,
  retry:AIScanTask, auditTargets:unknown):Promise<void> {
  if(!coverageRetryTargetKeys(auditTargets))throw new Error('Persisted coverage retry has no valid target references.');
  const matches=(artifact:AIScanArtifact)=>isMatchingCoverageRetryAudit(artifact,learningTask,flow,retry,auditTargets);
  if((await repo.listArtifacts(learningTask.scan_run_id)).some(matches))return;
  const input={id:coverageRetryAuditArtifactId(learningTask.scan_run_id,learningTask.id),scan_run_id:learningTask.scan_run_id,
    task_id:learningTask.id,artifact_type:'business_coverage_retry_scheduled',source_ref:retry.id,title:'正常业务缺失目标重学已安排',
    content_json:{flow_id:flow.id,source_task_id:learningTask.id,retry_task_id:retry.id,prior_workflow_id:flow.workflow_id,
      prior_test_run_id:flow.normal_run_id,targets:auditTargets as any[]}};
  try { await repo.createArtifact(input); }
  catch(error){
    if(!isUniqueConstraintError(error))throw error;
    if(!(await repo.listArtifacts(learningTask.scan_run_id)).some(matches))throw error;
  }
}

export async function scheduleBusinessCoverageRetry(repo: AIScanRepository, learningTask: AIScanTask,
  flows: BusinessFlow[], artifacts: AIScanArtifact[] = []): Promise<AIScanTask | undefined> {
  return scheduleOnce(`${learningTask.scan_run_id}:${learningTask.id}`,async()=>{
  if (learningTask.execution_plan?.intent !== BUSINESS_LEARNING_INTENT || learningTask.execution_plan?.coverage_retry) return undefined;
  const flowId=String(learningTask.execution_plan?.flow_id||'');
  const flow=flows.find(item=>item.id===flowId);
  if (!flow || flow.status!=='verified' || flow.assertions_verified!==true || !flow.normal_run_id || !flow.workflow_id) return undefined;
  const tasks=await repo.listTasks(learningTask.scan_run_id);
  const planTask=tasks.find(item=>item.execution_plan?.intent===BUSINESS_PLAN_INTENT);
  if (!planTask) return undefined;
  const coverageArtifact=latestBusinessCoverage(artifacts,planTask.id);
  if (!coverageArtifact) return undefined;
  const coverage=coverageArtifact.content_json as BusinessCoverageRecord;
  const missing=unprovenPlannedCoverageEntries(coverage,flows,artifacts,flowId);
  if (!missing.length) return undefined;
  const names=new Map((coverage.target_manifest||[]).map(target=>[target.key,target.name]));
  const targets=missing.map(({entry,reason})=>{
    const key=businessCoverageKey(entry.target_type,entry.target_id);
    return {key,target_type:entry.target_type,target_id:entry.target_id,target_name:names.get(key),reason};
  });
  if(!coverageRetryTargetKeys(targets))throw new Error('Computed coverage retry has no valid target references.');
  const existing=tasks.find(task=>task.execution_plan?.coverage_retry?.origin_task_id===learningTask.id);
  let retry:AIScanTask;
  if(existing){
    // A prior version generated random task IDs. Reconcile it as long as the
    // persisted child is structurally valid; new writes use the stable ID.
    if(!isMatchingCoverageRetryTask(existing,learningTask,flow))throw new Error('Persisted coverage retry does not match its normal learning parent.');
    retry=existing;
  }else{
    const retryId=coverageRetryTaskId(learningTask.scan_run_id,learningTask.id);
    try {
      retry=await repo.createTask({
        id:retryId,scan_run_id:learningTask.scan_run_id,parent_task_id:learningTask.id,task_type:'learn_business_flow',
        title:`重新学习未覆盖目标：${flow.name}`,priority:Math.max(1,Number(learningTask.priority||25)-1),dependencies:[learningTask.id],
        agent_goal:`为正常业务“${flow.name}”建立新的隔离录制，只覆盖服务器列出的缺失目标引用。保留此前原生证据；在当前新任务中自行观察页面并选择能实际触发这些目标的业务操作，再用新的 Workflow/Test Run 和语义断言验证。`,
        execution_plan:{intent:BUSINESS_LEARNING_INTENT,flow_id:flow.id,identity_key:flow.role,feature_id:flow.feature_id,
          parallel_capable:false,requires_identity_context:flow.role!=='anonymous',coverage_retry:{origin_task_id:learningTask.id,attempt:1,targets}},
      });
    }catch(error){
      if(!isUniqueConstraintError(error))throw error;
      const raced=await repo.getTask(retryId);
      if(!isMatchingCoverageRetryTask(raced,learningTask,flow,targets,true))throw error;
      retry=raced;
    }
  }
  const auditTargets=retry.execution_plan?.coverage_retry?.targets;
  await ensureCoverageRetryAudit(repo,learningTask,flow,retry,auditTargets);
  for (const review of tasks.filter(task=>task.execution_plan?.intent===BUSINESS_REVIEW_INTENT&&['pending','running'].includes(task.status))) {
    await repo.updateTask(review.id,{dependencies:[...new Set([...(review.dependencies||[]),retry.id])]});
  }
  return retry;

  });
}

/**
 * Review is a fan-out point, not a global pass/fail gate. A blocked refund
 * flow must remain visible and repairable, but it must not prevent an already
 * verified profile/order flow from reaching a model-designed native experiment.
 */
export async function scheduleBusinessExperiments(repo: AIScanRepository, reviewTask: AIScanTask): Promise<AIScanTask[]> {
  const artifacts = await repo.listArtifacts(reviewTask.scan_run_id);
  const flows = latestBusinessFlows(artifacts).filter(flow => flow.status === 'verified' && flow.assertions_verified === true && Boolean(flow.normal_run_id) && Boolean(flow.workflow_id));
  const existing = await repo.listTasks(reviewTask.scan_run_id);
  const experiments: AIScanTask[] = [];
  for (const flow of flows) {
    const prior = existing.find(task => task.execution_plan?.intent === BUSINESS_EXPERIMENT_INTENT && task.execution_plan?.flow_id === flow.id);
    if (prior) { experiments.push(prior); continue; }
    experiments.push(await repo.createTask({
      scan_run_id: reviewTask.scan_run_id,
      parent_task_id: reviewTask.id,
      task_type: 'model_business_experiment',
      title: `模型驱动业务实验：${flow.name}`,
      priority: 42,
      dependencies: [reviewTask.id],
      agent_goal: `基于已验证的正常业务“${flow.name}”设计并执行一个精确的原生安全实验。模型必须先检查流程结构，再自行选择具体步骤、字段变化、动态绑定、身份、重放/并发和语义断言；依次调用 bstg.test_plan.create、bstg.test_plan.compile、bstg.test_plan.execute、bstg.test_plan.inspect 与 bstg.test_plan.assess。安全或未证实的结果同样要如实记录；不能把假设、HTTP 状态或旧录制当成漏洞证据。`,
      execution_plan: {
        intent: BUSINESS_EXPERIMENT_INTENT,
        flow_id: flow.id,
        feature_id: flow.feature_id,
        normal_run_id: flow.normal_run_id,
        source_flow_revision: flow.revision,
        // The experiment owns immutable workflows/Test Runs. It may be queued
        // alongside feature/candidate modeling, so a blocked unrelated flow
        // cannot become a scheduler-wide serial barrier. Native requests
        // within the experiment still follow their model-selected order.
        parallel_capable: true,
        requires_identity_context: flow.role !== 'anonymous',
      },
    }));
  }
  return experiments;
}

function newestByRevision(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  // Revisions are local to a plan/result ID. A later model may create a new
  // plan ID with revision 1, so chronology chooses the current plan first;
  // revision resolves records created in the same database timestamp tick.
  return [...artifacts].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) ||
    Number(b.content_json?.revision || 0) - Number(a.content_json?.revision || 0))[0];
}

function hasTerminalNativeRun(run: TestRun | null): boolean {
  return Boolean(run && run.completed_at && run.status === 'completed' && run.has_execution_error !== true);
}

function nativeRunOwnedBy(run: TestRun | null, expected: Record<string, unknown>): boolean {
  if (!run) return false;
  return Object.entries(expected).every(([key, value]) => run.execution_params?.[key] === value);
}

function hasNativeTrace(artifacts: AIScanArtifact[], task: AIScanTask, plan: Record<string, any>, kind: 'control' | 'experiment', testRunId: string): boolean {
  return artifacts.some(artifact => artifact.artifact_type === 'agent_experiment_native_trace' && artifact.task_id === task.id &&
    artifact.source_ref === testRunId && artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision &&
    artifact.content_json?.kind === kind && artifact.content_json?.test_run_id === testRunId && artifact.content_json?.private === true);
}

function record(value: unknown): Record<string, any> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isCurrentMutationWorkflow(workflow: Workflow | null, workflowId: string, plan: Record<string, any>): boolean {
  const profile = record(workflow?.mutation_profile);
  return Boolean(workflow && workflow.id === workflowId && workflow.workflow_type === 'mutation' && workflow.base_workflow_id &&
    profile?.model_directed === true && profile.plan_id === plan.id && profile.plan_revision === plan.revision);
}

function currentExperimentCompilation(artifacts: AIScanArtifact[], task: AIScanTask, plan: Record<string, any>): AIScanArtifact | undefined {
  return newestByRevision(artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_compilation' && artifact.task_id === task.id &&
    artifact.source_ref === plan.id && artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision &&
    artifact.content_json?.private === true));
}

function artifactKind(artifact: Partial<AIScanArtifact> & Record<string, any>): string {
  return String(artifact.artifact_type || artifact.type || '');
}

function artifactContent(artifact: Partial<AIScanArtifact> & Record<string, any>): Record<string, any> {
  const content = artifact.content_json;
  return content && typeof content === 'object' && !Array.isArray(content) ? content as Record<string, any> : {};
}

function evidenceArtifactIds(value: Record<string, any> | undefined): string[] {
  if (!value) return [];
  const gate = value.native_evidence_gate && typeof value.native_evidence_gate === 'object' ? value.native_evidence_gate : {};
  return [...new Set([
    ...(Array.isArray(value.evidence_artifact_ids) ? value.evidence_artifact_ids : []),
    ...(Array.isArray(gate.evidence_artifact_ids) ? gate.evidence_artifact_ids : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

function hasPersistedEvidence(value: Record<string, any> | undefined, artifacts: Array<Partial<AIScanArtifact> & Record<string, any>>): boolean {
  const persisted = new Set(artifacts.map(artifact => String(artifact.id || '')).filter(Boolean));
  return evidenceArtifactIds(value).some(id => persisted.has(id));
}

function blockedReason(value: Record<string, any> | undefined): string | undefined {
  if (!value) return undefined;
  const candidates = [
    value.blocked_reason,
    value.blocker,
    value.reason,
    value.error,
    ...(Array.isArray(value.blockers) ? value.blockers : []),
    ...(Array.isArray(value.missing_evidence) ? value.missing_evidence : []),
    ...(Array.isArray(value.native_evidence_gate?.missing_evidence) ? value.native_evidence_gate.missing_evidence : []),
  ];
  return candidates.map(item => typeof item === 'string' ? item.trim() : '').find(Boolean);
}

function isBlockedRecord(value: Record<string, any> | undefined): boolean {
  if (!value) return false;
  const status = String(value.status || value.terminal_status || '').trim().toLowerCase();
  return status === 'blocked' || String(value.verdict || '').trim().toLowerCase() === 'blocked';
}

function isFailedRecord(value: Record<string, any> | undefined): boolean {
  if (!value) return false;
  const status = String(value.status || value.terminal_status || '').trim().toLowerCase();
  return status === 'failed';
}

/** A secure negative conclusion must name the server-written counterexample
 * gate and at least one persisted evidence artifact.  A model-authored
 * `not_vulnerable` label alone is never completion evidence. */
function hasCredibleNegativeProof(value: Record<string, any> | undefined,
  artifacts: Array<Partial<AIScanArtifact> & Record<string, any>>): boolean {
  if (!value || String(value.verdict || '').trim().toLowerCase() !== 'not_vulnerable') return false;
  const gate = value.native_evidence_gate && typeof value.native_evidence_gate === 'object' ? value.native_evidence_gate : {};
  return String(gate.verdict || '').trim().toLowerCase() === 'counterexample' && gate.counterexample_verified === true &&
    hasPersistedEvidence(value, artifacts);
}

/**
 * Inconclusive evidence is actionable feedback, irrespective of the label
 * requested by the model.  This deliberately includes an unsupported
 * `not_vulnerable` (and a positive claim without a confirmed native gate), so
 * a free-form assessment cannot bypass the append-only correction loop.
 */
function assessmentRequiresExperimentRevision(value: Record<string, any> | undefined,
  artifacts: Array<Partial<AIScanArtifact> & Record<string, any>>, result?: Record<string, any>): boolean {
  if (!value || isBlockedRecord(value) || isFailedRecord(value)) return false;
  const verdict = String(value.verdict || '').trim().toLowerCase();
  const gate = value.native_evidence_gate && typeof value.native_evidence_gate === 'object' ? value.native_evidence_gate : {};
  const gateVerdict = String(gate.verdict || '').trim().toLowerCase();
  if (verdict === 'not_vulnerable') return !hasCredibleNegativeProof(value, artifacts) || result?.counterexample_verified !== true;
  if (verdict === 'vulnerable') return gateVerdict !== 'confirmed' || !hasPersistedEvidence(value, artifacts);
  return true;
}

function taskExperimentArtifacts(task: Pick<AIScanTask, 'id' | 'execution_plan'>,
  artifacts: Array<Partial<AIScanArtifact> & Record<string, any>>): Array<Partial<AIScanArtifact> & Record<string, any>> {
  // Context-builder intentionally projects task artifacts without task_id;
  // that list is already scoped.  A repository list does carry task IDs, so
  // never let an unscoped/global artifact influence a persisted task outcome.
  const hasTaskScope = artifacts.some(artifact => typeof artifact.task_id === 'string' && artifact.task_id.length > 0);
  return hasTaskScope ? artifacts.filter(artifact => artifact.task_id === task.id) : artifacts;
}

function latestPlanById(planArtifacts: AIScanArtifact[]): Map<string, AIScanArtifact> {
  const latest = new Map<string, AIScanArtifact>();
  for (const artifact of planArtifacts) {
    const id = String(artifact.content_json?.id || '');
    if (!id) continue;
    const previous = latest.get(id);
    if (!previous || newestByRevision([previous, artifact])?.id === artifact.id) latest.set(id, artifact);
  }
  return latest;
}

/** A corrective plan is a new child ID, so its first revision can be lower
 * than an older parent revision. Prefer the leaf of that append-only lineage
 * instead of accidentally treating a parent revision as the current plan. */
function currentExperimentPlanArtifact(planArtifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  const byId = latestPlanById(planArtifacts);
  const parents = new Set([...byId.values()].map(artifact => String(artifact.content_json?.parent_plan_id || '')).filter(Boolean));
  const leaves = [...byId.entries()].filter(([id]) => !parents.has(id)).map(([, artifact]) => artifact);
  return newestByRevision(leaves.length ? leaves : [...byId.values()]);
}

function firstPlanById(planArtifacts: AIScanArtifact[]): Map<string, AIScanArtifact> {
  const first = new Map<string, AIScanArtifact>();
  for (const artifact of planArtifacts) {
    const id = String(artifact.content_json?.id || '');
    if (!id) continue;
    const previous = first.get(id);
    if (!previous || String(artifact.created_at).localeCompare(String(previous.created_at)) < 0) first.set(id, artifact);
  }
  return first;
}

export interface VerifiedNegativeCounterexampleAttempt {
  plan_id:string;
  planArtifact:AIScanArtifact;
  resultArtifact:AIScanArtifact;
  assessmentArtifact:AIScanArtifact;
  traceArtifacts:AIScanArtifact[];
}

/** Distinct completed plan revisions in the current lineage may justify
 * stopping for human follow-up when the server-owned negative oracle is still
 * missing. These records never support a not_vulnerable conclusion. */
export function businessExperimentNegativeCounterexampleAttempts(
  task:Pick<AIScanTask,'id'|'execution_plan'>,
  artifacts:ExperimentArtifactLike[],
  currentPlanId:string,
):VerifiedNegativeCounterexampleAttempt[]{
  const scoped=taskExperimentArtifacts(task,artifacts) as AIScanArtifact[];
  const flowId=String(task.execution_plan?.flow_id||'');
  const planArtifacts=scoped.filter(artifact=>artifactKind(artifact)==='agent_experiment_plan'&&artifactContent(artifact).flow_id===flowId);
  const plansById=latestPlanById(planArtifacts);
  const lineage=new Set<string>();
  let cursor=plansById.get(currentPlanId)?.content_json;
  while(cursor?.id&&!lineage.has(String(cursor.id))){
    lineage.add(String(cursor.id));
    const parentId=String(cursor.parent_plan_id||'');
    if(!parentId)break;
    cursor=plansById.get(parentId)?.content_json;
  }
  if(!lineage.size)return [];

  const attempts=new Map<string,VerifiedNegativeCounterexampleAttempt>();
  for(const resultArtifact of scoped.filter(artifact=>artifactKind(artifact)==='agent_experiment_result')){
    const result=artifactContent(resultArtifact),planId=String(result.plan_id||'');
    if(!lineage.has(planId)||result.status!=='executed'||result.control_verified!==true||result.evidence_ready===true||result.counterexample_verified===true)continue;
    const plan=plansById.get(planId)?.content_json;
    if(!plan||Number(plan.revision)!==Number(result.plan_revision)||
      !(result.business_proof?.evidence_gaps||[]).some((gap:any)=>gap?.failure_code==='negative_counterexample_proof_missing'))continue;
    const runIds=new Set(Array.isArray(result.native_test_run_ids)?result.native_test_run_ids.filter((value:unknown)=>typeof value==='string'):[]);
    if(runIds.size<2||!result.control_test_run_id||!result.experiment_test_run_id||result.control_test_run_id===result.experiment_test_run_id||
      !runIds.has(result.control_test_run_id)||!runIds.has(result.experiment_test_run_id))continue;
    const assessmentArtifact=scoped.find(artifact=>artifactKind(artifact)==='agent_experiment_assessment'&&artifact.source_ref===planId&&
      artifactContent(artifact).plan_id===planId&&Number(artifactContent(artifact).plan_revision)===Number(result.plan_revision)&&
      Number(artifactContent(artifact).result_revision)===Number(result.revision)&&artifactContent(artifact).verdict==='inconclusive'&&
      artifactContent(artifact).native_evidence_gate?.verdict==='insufficient');
    if(!assessmentArtifact)continue;
    const traceArtifacts=scoped.filter(artifact=>artifactKind(artifact)==='agent_experiment_native_trace'&&
      artifactContent(artifact).plan_id===planId&&Number(artifactContent(artifact).plan_revision)===Number(result.plan_revision)&&
      runIds.has(String(artifactContent(artifact).test_run_id||'')));
    const traceByKind=new Map(traceArtifacts.map(artifact=>[String(artifactContent(artifact).kind||''),artifact]));
    const controlTrace=traceByKind.get('control'),experimentTrace=traceByKind.get('experiment');
    const evidenceIds=Array.isArray(result.evidence_artifact_ids)?result.evidence_artifact_ids.map(String):[];
    if(!controlTrace||!experimentTrace||artifactContent(controlTrace).test_run_id!==result.control_test_run_id||
      artifactContent(experimentTrace).test_run_id!==result.experiment_test_run_id||
      ![controlTrace.id,experimentTrace.id].every(id=>evidenceIds.includes(id))||
      evidenceIds.some(id=>!scoped.some(artifact=>artifact.id===id)))continue;
    attempts.set(planId,{plan_id:planId,planArtifact:plansById.get(planId)!,resultArtifact,assessmentArtifact,traceArtifacts:[controlTrace,experimentTrace]});
  }
  return [...attempts.values()];
}

type ExperimentArtifactLike = Partial<AIScanArtifact> & Record<string, any>;

function currentExperimentRecords(task: Pick<AIScanTask, 'id' | 'execution_plan'>,
  artifacts: ExperimentArtifactLike[]): { planArtifact?: AIScanArtifact; plan?: Record<string, any>; result?: Record<string, any>; assessment?: Record<string, any>; block?: Record<string,any> } {
  const scoped = taskExperimentArtifacts(task, artifacts);
  const flowId = String(task.execution_plan?.flow_id || '');
  const plans = scoped.filter(artifact => artifactKind(artifact) === 'agent_experiment_plan' && artifactContent(artifact).flow_id === flowId) as AIScanArtifact[];
  const planArtifact = currentExperimentPlanArtifact(plans);
  const plan = planArtifact ? artifactContent(planArtifact) : undefined;
  if (!plan?.id || !Number.isInteger(Number(plan.revision))) return { planArtifact, plan };
  const resultArtifact = newestByRevision(scoped.filter(artifact => artifactKind(artifact) === 'agent_experiment_result' &&
    artifactContent(artifact).plan_id === plan.id && Number(artifactContent(artifact).plan_revision) === Number(plan.revision)) as AIScanArtifact[]);
  const result = resultArtifact ? artifactContent(resultArtifact) : undefined;
  const assessmentArtifact = newestByRevision(scoped.filter(artifact => artifactKind(artifact) === 'agent_experiment_assessment' &&
    artifactContent(artifact).plan_id === plan.id && Number(artifactContent(artifact).plan_revision) === Number(plan.revision) &&
    (!result || Number(artifactContent(artifact).result_revision) === Number(result.revision))) as AIScanArtifact[]);
  const blockArtifact=newestByRevision(scoped.filter(artifact=>artifactKind(artifact)==='agent_experiment_block'&&
    artifactContent(artifact).plan_id===plan.id&&Number(artifactContent(artifact).plan_revision)===Number(plan.revision)&&
    (!result||Number(artifactContent(artifact).result_revision)===Number(result.revision))) as AIScanArtifact[]);
  return { planArtifact, plan, result, assessment: assessmentArtifact ? artifactContent(assessmentArtifact) : undefined,
    block:blockArtifact?artifactContent(blockArtifact):undefined };
}

export interface BusinessExperimentTerminalDisposition {
  kind: 'blocked' | 'failed';
  reason: string;
  evidence_artifact_ids: string[];
}

/**
 * Only an explicit blocked record with both a human-readable reason and a
 * persisted evidence link may turn an experiment into a visible blocked task.
 * Failed records, and synthetic/underspecified blocks, remain failures so
 * they can never be displayed as completed security work.
 */
export function businessExperimentTerminalDisposition(task: Pick<AIScanTask, 'id' | 'execution_plan'>,
  artifacts: ExperimentArtifactLike[]): BusinessExperimentTerminalDisposition | undefined {
  const { plan, result, assessment, block } = currentExperimentRecords(task, artifacts);
  const records = [block,result, assessment, plan].filter((value): value is Record<string, any> => Boolean(value));
  const failed = records.find(isFailedRecord);
  if (failed) return {
    kind: 'failed',
    reason: blockedReason(failed) || 'The current native model experiment failed and has no completion proof.',
    evidence_artifact_ids: evidenceArtifactIds(failed).filter(id => artifacts.some(artifact => String(artifact.id || '') === id)),
  };
  const blocked = records.find(isBlockedRecord);
  if (!blocked) return undefined;
  const reason = blockedReason(blocked);
  const evidence = evidenceArtifactIds(blocked).filter(id => artifacts.some(artifact => String(artifact.id || '') === id));
  if (reason && evidence.length) return { kind: 'blocked', reason, evidence_artifact_ids: evidence };
  return {
    kind: 'failed',
    reason: 'A model experiment was marked blocked without both a concrete persisted reason and linked evidence; it cannot be completed or treated as a valid block.',
    evidence_artifact_ids: evidence,
  };
}

/**
 * An inconclusive assessment is feedback for a fresh experiment, not a
 * terminal assessment. The next plan must be a new append-only child of that
 * plan. Reusing its plan_id would make an old result look like a revision and
 * lose the audit link between the failed hypothesis and its correction.
 */
export function businessExperimentRevisionRequirement(task: Pick<AIScanTask, 'id' | 'execution_plan'>,
  artifacts: AIScanArtifact[]): string | undefined {
  const scoped = taskExperimentArtifacts(task, artifacts) as AIScanArtifact[];
  const flowId = String(task.execution_plan?.flow_id || '');
  const plans = scoped.filter(artifact => artifactKind(artifact) === 'agent_experiment_plan' && artifactContent(artifact).flow_id === flowId);
  const currentArtifact = currentExperimentPlanArtifact(plans);
  const current = currentArtifact?.content_json;
  if (!current?.id || businessExperimentTerminalDisposition(task, artifacts)) return undefined;

  const byId = latestPlanById(plans);
  const firstById = firstPlanById(plans);
  const planIds = new Set([...byId.keys()]);
  const inadequateAssessments = scoped.filter(artifact => {
    if (artifactKind(artifact) !== 'agent_experiment_assessment') return false;
    const assessment = artifactContent(artifact);
    const planId = String(assessment.plan_id || artifact.source_ref || '');
    if (!planIds.has(planId)) return false;
    const result = newestByRevision(scoped.filter(candidate => artifactKind(candidate) === 'agent_experiment_result' &&
      artifactContent(candidate).plan_id === planId && Number(artifactContent(candidate).plan_revision) === Number(assessment.plan_revision)) as AIScanArtifact[]);
    return assessmentRequiresExperimentRevision(assessment, scoped, result ? artifactContent(result) : undefined);
  }).sort((left, right) =>
      String(right.created_at).localeCompare(String(left.created_at)));

  for (const assessment of inadequateAssessments) {
    const parentPlanId = String(assessment.content_json?.plan_id || assessment.source_ref || '');
    if (!parentPlanId) continue;
    const seen = new Set<string>();
    let child: Record<string, any> | undefined = current;
    let followsParent = false;
    while (child?.id && !seen.has(String(child.id))) {
      seen.add(String(child.id));
      const parentId: string = String(child.parent_plan_id || '');
      if (!parentId) break;
      if (parentId === parentPlanId) {
        const initialChild = firstById.get(String(child.id));
        followsParent = String(child.id) !== parentPlanId && Boolean(initialChild) &&
          String(initialChild!.created_at).localeCompare(String(assessment.created_at)) >= 0;
        break;
      }
      child = byId.get(parentId)?.content_json;
    }
    if (!followsParent) return parentPlanId;
  }
  return undefined;
}

/** A completed experiment can be a confirmed issue, a secure counterexample,
 * or an inconclusive native result. Completion requires the actual persisted
 * Test Runs to belong to this scan/plan and to have terminal evidence, not
 * just user-controllable IDs embedded in an artifact. */
export async function businessExperimentCompletionGap(task: AIScanTask, artifacts: AIScanArtifact[], db?: DbProvider): Promise<string | undefined> {
  const flowId = String(task.execution_plan?.flow_id || '');
  const plans = artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_plan' && artifact.task_id === task.id && artifact.content_json?.flow_id === flowId);
  const planArtifact = currentExperimentPlanArtifact(plans);
  const plan = planArtifact?.content_json;
  if (!plan?.id || !Number.isInteger(plan.revision)) return 'No model-designed experiment plan has been saved for this verified business flow.';
  const resultArtifact = newestByRevision(artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_result' && artifact.task_id === task.id &&
    artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision));
  const result = resultArtifact?.content_json;
  const assessmentArtifact = newestByRevision(artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_assessment' && artifact.task_id === task.id &&
    artifact.source_ref === plan.id && artifact.content_json?.plan_revision === plan.revision &&
    (!result || artifact.content_json?.result_revision === result.revision)));
  const terminal = businessExperimentTerminalDisposition(task, artifacts);
  if (terminal?.kind === 'blocked') {
    return `The current model experiment is explicitly blocked with persisted evidence (${terminal.evidence_artifact_ids.join(', ')}): ${terminal.reason}. Mark the task blocked for human follow-up; do not complete it.`;
  }
  if (terminal?.kind === 'failed') return `The current model experiment failed: ${terminal.reason} It cannot be completed as a security result.`;
  const parentPlanId = businessExperimentRevisionRequirement(task, artifacts);
  if (parentPlanId) {
    return `The current assessment is inconclusive or evidence-insufficient. Create a new model plan with parent_plan_id ${parentPlanId}; do not reuse that plan_id, then compile, execute, inspect, and assess the new current revision.`;
  }
  if (plan.status !== 'compiled') return 'The latest model experiment plan has not been compiled into immutable native Workflow snapshots.';
  if (!result || result.status !== 'executed') return 'The current compiled plan has no completed native control-and-experiment result.';
  const compilationArtifact = currentExperimentCompilation(artifacts, task, plan);
  const compilation = compilationArtifact?.content_json;
  if (!compilation || !Array.isArray(plan.evidence_artifact_ids) || !plan.evidence_artifact_ids.includes(compilationArtifact!.id)) {
    return 'The current compiled plan lacks its private native Workflow compilation record.';
  }
  const nativeRuns = Array.isArray(result.native_test_run_ids) ? result.native_test_run_ids.filter((id: unknown) => typeof id === 'string') : [];
  if (nativeRuns.length < 2 || !result.control_test_run_id || !result.experiment_test_run_id || result.control_test_run_id === result.experiment_test_run_id) {
    return 'The experiment result lacks distinct native control and experiment Test Runs.';
  }
  if (!nativeRuns.includes(result.control_test_run_id) || !nativeRuns.includes(result.experiment_test_run_id)) {
    return 'The experiment result does not consistently reference its control and experiment Test Runs.';
  }
  if (!db) return 'The experiment completion gate cannot verify native TestRun ownership without its repository context.';
  const normalRunId = String(task.execution_plan?.normal_run_id || '');
  if (!normalRunId) return 'The experiment task has no persisted normal baseline Test Run reference.';
  const [normalRun, controlRun, experimentRun] = await Promise.all([
    db.repos.testRuns.findById(normalRunId),
    db.repos.testRuns.findById(result.control_test_run_id),
    db.repos.testRuns.findById(result.experiment_test_run_id),
  ]);
  if (!normalRun || !controlRun || !experimentRun) {
    return 'The normal baseline, control, or experiment Test Run no longer exists.';
  }
  if (!hasTerminalNativeRun(normalRun) || !nativeRunOwnedBy(normalRun, {scan_run_id: task.scan_run_id, flow_id: flowId, business_normal_run: true})) {
    return 'The normal baseline Test Run is missing, not terminal, or is not owned by this scan and business flow.';
  }
  if (!hasTerminalNativeRun(controlRun) || !nativeRunOwnedBy(controlRun, {scan_run_id: task.scan_run_id, ai_scan_task_id: task.id,
    plan_id: plan.id, plan_revision: plan.revision, model_directed: true, kind: 'control'})) {
    return 'The control Test Run is missing, not terminal, or is not owned by the current scan/task/plan revision.';
  }
  if (!hasTerminalNativeRun(experimentRun) || !nativeRunOwnedBy(experimentRun, {scan_run_id: task.scan_run_id, ai_scan_task_id: task.id,
    plan_id: plan.id, plan_revision: plan.revision, model_directed: true, kind: 'experiment'})) {
    return 'The experiment Test Run is missing, not terminal, or is not owned by the current scan/task/plan revision.';
  }
  if (!normalRun.workflow_id || !controlRun.workflow_id || !experimentRun.workflow_id ||
    new Set([normalRun.workflow_id, controlRun.workflow_id, experimentRun.workflow_id]).size !== 3 ||
    controlRun.workflow_id !== compilation.control_workflow_id || experimentRun.workflow_id !== compilation.experiment_workflow_id) {
    return 'The native Test Runs do not reference three distinct current normal, control, and experiment Workflows.';
  }
  const [normalWorkflow, controlWorkflow, experimentWorkflow] = await Promise.all([
    db.repos.workflows.findById(normalRun.workflow_id),
    db.repos.workflows.findById(controlRun.workflow_id),
    db.repos.workflows.findById(experimentRun.workflow_id),
  ]);
  if (!normalWorkflow || compilation.flow_id !== flowId || compilation.source_workflow_id !== normalRun.workflow_id ||
    !isCurrentMutationWorkflow(controlWorkflow, compilation.control_workflow_id, plan) ||
    !isCurrentMutationWorkflow(experimentWorkflow, compilation.experiment_workflow_id, plan)) {
    return 'The current native Workflow compilation does not own the normal, control, and experiment Workflow snapshots.';
  }
  const normalEvidence = artifacts.some(artifact => artifact.artifact_type === 'business_workflow_validation' && artifact.source_ref === normalRunId &&
    artifact.content_json?.flow_id === flowId && artifact.content_json?.test_run_id === normalRunId && artifact.content_json?.workflow_id === normalRun.workflow_id &&
    artifact.content_json?.assertions_verified === true) &&
    artifacts.some(artifact => artifact.artifact_type === 'business_native_trace' && artifact.source_ref === normalRunId && artifact.content_json?.flow_id === flowId &&
      artifact.content_json?.test_run_id === normalRunId && artifact.content_json?.workflow_id === normalRun.workflow_id && artifact.content_json?.private === true);
  if (!normalEvidence) return 'The normal baseline Test Run lacks matching native validation and trace evidence.';
  if (!hasNativeTrace(artifacts, task, plan, 'control', result.control_test_run_id) || !hasNativeTrace(artifacts, task, plan, 'experiment', result.experiment_test_run_id)) {
    return 'The current control or experiment Test Run lacks matching private native trace evidence.';
  }
  const traceIds = artifacts.filter(artifact => artifact.artifact_type === 'agent_experiment_native_trace' && artifact.task_id === task.id &&
    [result.control_test_run_id, result.experiment_test_run_id].includes(String(artifact.source_ref)) && artifact.content_json?.plan_id === plan.id && artifact.content_json?.plan_revision === plan.revision).map(artifact => artifact.id);
  if (!Array.isArray(result.evidence_artifact_ids) || traceIds.some(id => !result.evidence_artifact_ids.includes(id))) {
    return 'The experiment result does not retain references to its current native trace evidence.';
  }
  if (!assessmentArtifact) return 'The model has not inspected and assessed the current native experiment result.';
  if (assessmentRequiresExperimentRevision(assessmentArtifact.content_json, artifacts, result)) {
    return `The current assessment is inconclusive or evidence-insufficient. Create a new model plan with parent_plan_id ${plan.id}; do not reuse that plan_id, then compile, execute, inspect, and assess the new current revision.`;
  }
  return undefined;
}

/** A model's completion sentence cannot substitute for persisted native proof. */
export async function businessCompletionGap(repo: AIScanRepository, task: AIScanTask, flows: BusinessFlow[], artifacts: AIScanArtifact[] = [], db?: DbProvider): Promise<string | undefined> {
  const intent = task.execution_plan?.intent;
  if (intent === BUSINESS_PLAN_INTENT) return businessPlanningCompletionGap(repo, task, flows, artifacts);
  if (intent === BUSINESS_LEARNING_INTENT) {
    const flow = flows.find(item => item.id === task.execution_plan?.flow_id);
    if(!(flow?.status === 'verified' && flow.assertions_verified === true && flow.normal_run_id && flow.evidence_artifact_ids.length && sealedStrictObjectiveBindings(flow))){
      return 'This normal business flow has no verified native Test Run with sealed strict-objective provenance. Inspect failed assertions, repair data dependencies or report a specific blocker.';
    }
    const retryGap=retryCoverageBindingGap(task,flows,artifacts);
    if(retryGap)return retryGap;
    const gap=await plannedCoverageBindingGap(repo,task.scan_run_id,flows,artifacts,String(task.execution_plan?.flow_id||''));
    return gap;
  }
  if (intent === BUSINESS_REVIEW_INTENT) {
    const planTask = (await repo.listTasks(task.scan_run_id)).find(item => item.execution_plan?.intent === BUSINESS_PLAN_INTENT);
    if (!planTask) return 'No business planning task exists for this review.';
    const coverageGap = await businessPlanningCompletionGap(repo, planTask, flows, artifacts);
    if (coverageGap) return coverageGap;
    const bindingGap=businessCoverageBindingGap(latestBusinessCoverage(artifacts,planTask.id)!.content_json as BusinessCoverageRecord,flows,undefined,artifacts);
    if(bindingGap)return bindingGap;
    // Failed/blocked normal flows are preserved in the review, but do not hold
    // independently verified flows hostage. scheduleBusinessExperiments()
    // releases only the latter and keeps the former visible as blockers.
    return undefined;
  }
  if (intent === BUSINESS_EXPERIMENT_INTENT) return businessExperimentCompletionGap(task, artifacts, db);
  return undefined;
}

export function businessTaskIntent(task: Pick<AIScanTask, 'execution_plan'>): boolean {
  return [BUSINESS_PLAN_INTENT, BUSINESS_LEARNING_INTENT, BUSINESS_REVIEW_INTENT, BUSINESS_EXPERIMENT_INTENT].includes(task.execution_plan?.intent);
}
