import { createHash, randomUUID } from 'node:crypto';
import { dbAll, dbRun } from '../../db/sql-helpers.js';
import type { AgentToolContext } from '../../agent/tool-types.js';
import type { RecordingEvent, RecordingSession } from '../../types/index.js';
import { createRecordingSession, finishRecordingSession, getRecordingSessionDetail, ingestRecordingEventsBatch, publishWorkflowDraft } from '../recording-service.js';
import { generateWorkflowDraftArtifacts } from '../recording-generator.js';
import { FieldDictionary } from '../field-dictionary.js';
import { buildRecordingLearningSuggestions } from '../learning-source-recording.js';
import { applyLearningPayload } from './bstg-learning-automation.js';
import { executeWorkflowRun, evaluateStepAssertions } from '../workflow-runner.js';
import { getTraceByRunId } from '../debug-trace.js';
import { assertUrlInTargetScope } from './target-scope.js';
import { assertScanActive } from './run-control.js';
import { getBusinessFlow, saveBusinessFlow, validateBusinessAssertions, type BusinessAssertion } from './agent-business-contract.js';
import { startPersistentBusinessCapture, stopPersistentBusinessCapture, type BusinessBrowserCaptureEvent, type PersistentBrowserScope } from './browser/persistent-browser-runtime.js';
import { publicTechnicalPath } from './public-technical-snapshot.js';

const SOURCE = 'agent_business';
const secretKey = /(?:password|passwd|^pwd$|secret|authorization|api[_-]?key|cookie|token|csrf|ticket|otp|passcode|session(?:[_-]?id)?|verification[_-]?code|^sid$|^_g$)/i;
const digest = (value: unknown): string => createHash('sha256').update(String(value ?? '')).digest('hex');

/** Schema-level context supplied by the planner; no raw network value is public. */
export interface BusinessCaptureStart {
  flow_id: string;
  name?: string;
  identity_key?: string;
  account_id?: string;
  context_key?: string;
  scope_type?: PersistentBrowserScope;
  field_names?: string[];
}

export type BusinessGoalAssertion = BusinessAssertion;

export function redactBusinessValue(value: any, key = '', depth = 0, secrets:ReadonlySet<string>=new Set(),fields:ReadonlySet<string>=new Set()): any {
  const safeConfiguration=key==='sessionJar'||['cookieMode','cookie_mode'].includes(key)&&typeof value==='boolean';
  if (!safeConfiguration&&(secretKey.test(key) || fields.has(key.toLowerCase()) || typeof value==='string' && secrets.has(value))) return {redacted:true,sha256:digest(typeof value === 'object' ? JSON.stringify(value) : value)};
  if (depth > 12) return '[nested value omitted]';
  if (Array.isArray(value)) return value.slice(0,100).map(item => redactBusinessValue(item,key,depth+1,secrets,fields));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0,200).map(([name,item]) => [name,redactBusinessValue(item,name,depth+1,secrets,fields)]));
  if(typeof value==='string'){
    let safe=value;
    for(const secret of secrets)if(secret.length>=8)safe=safe.split(secret).join('[REDACTED]');
    return safe.slice(0,4000);
  }
  return value;
}

/**
 * Browser recordings are private execution material. The model needs the
 * shape of a message and the names of fields it can bind, not any recorded
 * customer, object, query, header, or response value. Keep this projection
 * intentionally stricter than key-name redaction: an opaque field name is
 * not evidence that its value is safe to disclose.
 */
function publicValueShape(value: any, depth = 0): any {
  if (depth > 12) return { type: 'nested', truncated: true };
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) return { type: 'array', length: value.length, items: value.slice(0, 20).map(item => publicValueShape(item, depth + 1)) };
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 120)
    .map(([name, item]) => [name, publicValueShape(item, depth + 1)]));
  if (typeof value === 'string') return { type: 'string', bytes: Buffer.byteLength(value), sha256: digest(value) };
  return { type: typeof value };
}

function publicHeaders(headers: Record<string, any> | undefined): Record<string, any> {
  return Object.fromEntries(Object.keys(headers || {}).slice(0, 80).map(name => [name.toLowerCase(), {
    present: true, value_type: typeof headers?.[name] === 'string' ? 'string' : typeof headers?.[name], sensitive: secretKey.test(name),
  }]));
}

/** A browser-capture result is model-facing. Preserve a route shape for
 * planning but never an object-bearing pathname segment. Canonical raw URLs
 * stay only in the recording and private evidence artifacts. */
export function publicBusinessCaptureTarget(rawUrl: string): Record<string, any> {
  try {
    const url = new URL(rawUrl);
    return {
      origin: url.origin,
      path: publicTechnicalPath(url.pathname),
      query_fields: [...new Set([...url.searchParams.keys()])].slice(0, 80).map(name => ({ name, sensitive: secretKey.test(name) })),
    };
  } catch {
    return { path: '[unavailable]' };
  }
}

function publicDiagnostic(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  const status = text.match(/\b(?:http\s*)?(?:status|response)?\s*[:=]?\s*([1-5]\d\d)\b/i);
  if (status) return `HTTP ${status[1]} execution gap; private diagnostic retained.`;
  if (/timed?\s*out|timeout/i.test(text)) return 'Timeout execution gap; private diagnostic retained.';
  if (/network|socket|econn|fetch failed|connection/i.test(text)) return 'Transport execution gap; private diagnostic retained.';
  if (/mapping|variable|extract/i.test(text)) return 'Variable or mapping execution gap; private diagnostic retained.';
  return 'Execution gap; private diagnostic retained.';
}

function publicTemplateStructure(value: any): Record<string, any> {
  const shape = publicValueShape(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return shape;
  const out: Record<string, any> = shape;
  if (typeof value.path === 'string') {
    out.path = publicTechnicalPath(value.path);
  }
  if (typeof value.method === 'string') out.method = value.method.toUpperCase().slice(0, 16);
  if (typeof value.content_type === 'string') out.content_type = value.content_type.slice(0, 120);
  return out;
}

function publicBusinessAssertion(assertion: any): Record<string, any> {
  return {
    id: assertion?.id,
    step_order: Number(assertion?.step_order || 0),
    description: typeof assertion?.description === 'string' ? assertion.description.slice(0, 500) : undefined,
    purpose: assertion?.purpose,
    left: assertion?.left ? { type: assertion.left.type, path: assertion.left.path } : undefined,
    op: assertion?.op,
    right: assertion?.right ? {
      type: assertion.right.type,
      key: assertion.right.type === 'literal' ? undefined : assertion.right.key,
      value_shape: assertion.right.type === 'literal' && assertion.right.value !== undefined ? publicValueShape(assertion.right.value) : undefined,
    } : undefined,
    missing_behavior: assertion?.missing_behavior,
    ...(typeof assertion?.passed === 'boolean' ? { passed: assertion.passed } : {}),
  };
}

function publicLearningProjection(learning: any): Record<string, any> {
  const suggestions = learning?.suggestions || {};
  return {
    summary: publicValueShape(learning?.summary || {}),
    suggestions: {
      workflowVariables: (suggestions.workflowVariables || []).slice(0, 120).map((item: any) => ({
        id: item.id, variableName: item.variableName, predictedType: item.predictedType, sourceStepOrder: item.sourceStepOrder,
        sourceLocation: item.sourceLocation, sourcePath: item.sourcePath, confidence: item.confidence,
        writePolicySuggestion: item.writePolicySuggestion, lockSuggestion: item.lockSuggestion, source: item.source,
      })),
      mappings: (suggestions.mappings || []).slice(0, 160).map((item: any) => ({
        id: item.id, fromStepOrder: item.fromStepOrder, fromLocation: item.fromLocation, fromPath: item.fromPath,
        toStepOrder: item.toStepOrder, toLocation: item.toLocation, toPath: item.toPath, variableName: item.variableName,
        transformHint: item.transformHint, confidence: item.confidence, evidenceCount: item.evidenceCount, reason: item.reason,
        predictedType: item.predictedType, source: item.source, selectedByDefault: item.selectedByDefault,
      })),
      extractors: (suggestions.extractors || []).slice(0, 120).map((item: any) => ({
        id: item.id, stepOrder: item.stepOrder, extractorType: item.extractorType, sourceLocation: item.sourceLocation,
        sourcePath: item.sourcePath, targetVariableName: item.targetVariableName, confidence: item.confidence,
        required: item.required, source: item.source,
      })),
      sessionJar: suggestions.sessionJar ? {
        cookieMode: suggestions.sessionJar.cookieMode === true,
        headerKeys: Array.isArray(suggestions.sessionJar.headerKeys) ? suggestions.sessionJar.headerKeys.slice(0, 80) : [],
        bodyJsonPaths: Array.isArray(suggestions.sessionJar.bodyJsonPaths) ? suggestions.sessionJar.bodyJsonPaths.slice(0, 80) : [],
        confidence: suggestions.sessionJar.confidence, reason: suggestions.sessionJar.reason, source: suggestions.sessionJar.source,
      } : null,
      assertions: (suggestions.assertions || []).slice(0, 120).map((item: any) => ({
        id: item.id, stepOrder: item.stepOrder, type: item.type, confidence: item.confidence, reason: item.reason, source: item.source,
        config: item.config ? { operator: item.config.operator, expected_shape: item.config.expected === undefined ? undefined : publicValueShape(item.config.expected) } : undefined,
      })),
    },
    conflicts: publicValueShape(learning?.conflicts || {}),
  };
}

function publicExecution(execution: any): Record<string, any> {
  return {
    success: execution?.success === true,
    has_execution_error: execution?.has_execution_error === true,
    errors_count: Number(execution?.errors_count || 0),
    findings_count: Number(execution?.findings_count || 0),
    warnings_count: Array.isArray(execution?.warnings) ? execution.warnings.length : 0,
    ...(execution?.error ? { diagnostic: publicDiagnostic(execution.error) } : {}),
  };
}

function parseObservedBody(text:string|undefined,contentType:string|undefined):any {
  if(!text)return null;
  try{return JSON.parse(text);}catch{
    if(!contentType?.includes('application/x-www-form-urlencoded'))return null;
    const parsed:Record<string,any>={};
    for(const [key,value] of new URLSearchParams(text))parsed[key]=parsed[key]===undefined?value:Array.isArray(parsed[key])?[...parsed[key],value]:[parsed[key],value];
    return parsed;
  }
}

async function recordingRedaction(context:AgentToolContext,session:RecordingSession,artifacts:Awaited<ReturnType<AgentToolContext['repo']['listArtifacts']>>):Promise<{secrets:Set<string>;fields:Set<string>}> {
  const fields=new Set((session.requested_field_names||[]).map(name=>name.toLowerCase()));
  const secrets=new Set<string>();
  const add=(value:any)=>{if(typeof value==='string'&&value)secrets.add(value);else if(Array.isArray(value))value.forEach(add);else if(value&&typeof value==='object')Object.values(value).forEach(add);};
  const visit=(value:any)=>{if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){
    if(secretKey.test(key)||fields.has(key.toLowerCase())){
      add(item);
      if(typeof item==='string'&&/cookie/i.test(key))for(const match of item.matchAll(/(?:^|[;\n,])\s*([^=;,]+)=([^;,\n]*)/g))add(match[2].trim());
      if(typeof item==='string'&&/authorization/i.test(key))add(item.replace(/^Bearer\s+/i,''));
    }else visit(item);
  }};
  for(const artifact of artifacts.filter(item=>item.artifact_type==='business_capture_event'&&item.source_ref===session.id)){
    const event=artifact.content_json as BusinessBrowserCaptureEvent;
    visit(event.request_headers);visit(event.response_headers);
    visit(parseObservedBody(event.request_body_text,event.request_headers['content-type']));
    visit(parseObservedBody(event.response_body_text,event.response_headers['content-type']));
  }
  const contexts=await context.db.repos.recordingRuntimeContext.findAll({where:{session_id:session.id} as any});
  for(const item of contexts)if(secretKey.test(item.context_key)||fields.has(item.context_key.toLowerCase())||/auth|token|cookie|csrf|ticket/i.test(item.category||''))add(item.value_text);
  return {secrets,fields};
}

function bodySummary(text?:string,base64?:string,contentType?:string,redaction?:{secrets:Set<string>;fields:Set<string>}):Record<string,any> {
  if(base64)return {kind:'binary',bytes:Buffer.from(base64,'base64').length,sha256:digest(base64)};
  if(text===undefined)return {kind:'absent'};
  const parsed=parseObservedBody(text,contentType);
  return parsed?{kind:contentType?.includes('application/x-www-form-urlencoded')?'form':'json',bytes:Buffer.byteLength(text),
    structure:publicValueShape(parsed)}:{kind:'text',bytes:Buffer.byteLength(text),sha256:digest(text)};
}

export async function requireBusinessFlow(context:AgentToolContext,flowId:string):Promise<Record<string,any>> {
  if(!flowId || flowId.length>200)throw new Error('A bounded flow_id is required.');
  return getBusinessFlow(context.repo,context.scanRunId,flowId);
}

async function flowEvent(context:AgentToolContext,flowId:string,patch:Record<string,any>):Promise<void> {
  const flow=await requireBusinessFlow(context,flowId);
  await saveBusinessFlow(context.repo,context.scanRunId,context.taskId,{...flow,...patch,id:flowId} as any);
}

export async function requireBusinessRecording(context:AgentToolContext,sessionId:string):Promise<RecordingSession> {
  const session=await context.db.repos.recordingSessions.findById(sessionId);
  if(!session || session.capture_filters?.source!==SOURCE || session.capture_filters?.scan_run_id!==context.scanRunId)throw new Error('Recording session is not owned by this assessment.');
  await requireBusinessFlow(context,String(session.capture_filters.flow_id || ''));
  return session;
}

/** Raw events have a separate private artifact; the existing recorder remains
 * the canonical event/field/variable pipeline. Repeated HTTP calls retain their
 * request-start sequence even when responses arrive out of order. */
export async function startBusinessCapture(context:AgentToolContext,input:BusinessCaptureStart):Promise<Record<string,any>> {
  assertScanActive();
  const flow=await requireBusinessFlow(context,input.flow_id),run=await context.repo.getRun(context.scanRunId);
  if(!run)throw new Error('Assessment not found.');
  const identity=String(input.identity_key || flow.role || '');
  if(flow.role && identity!==flow.role)throw new Error('Capture identity must match this business flow role.');
  if(input.account_id){
    const account=await context.db.repos.accounts.findById(input.account_id);
    if(!account || !(account.tags || []).includes(`scan:${context.scanRunId}`))throw new Error('Capture account must belong to this assessment.');
  }
  const session=await createRecordingSession(context.db,{name:String(input.name||flow.name||flow.goal||'正常业务录制').slice(0,200),mode:'workflow',intent:'learning_seed',
    source_tool:'bstg.business.capture',role:identity||undefined,account_id:input.account_id,
    capture_filters:{source:SOURCE,scan_run_id:context.scanRunId,task_id:context.taskId,flow_id:input.flow_id,identity_key:identity,
      context_key:input.context_key,scope_type:input.scope_type,preserve_repeated_events:true,capture_status:'recording'},
    requested_field_names:input.field_names,target_fields:(input.field_names||[]).map(name=>({name}))});
  let tail=Promise.resolve();
  const errors:string[]=[];
  const sink={id:session.id,sensitiveFieldNames:input.field_names,
    record:(event:BusinessBrowserCaptureEvent)=>{
      const write=tail.then(async()=>{
        assertUrlInTargetScope(event.url,run.base_url);
        if(event.identity_key!==identity)throw new Error('Captured request identity mismatch.');
        const raw=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:event.task_id||context.taskId,artifact_type:'business_capture_event',
          source_ref:session.id,title:`业务请求 ${event.sequence}`,content_json:{...event,flow_id:input.flow_id,recording_session_id:session.id,private:true}});
        await ingestRecordingEventsBatch(context.db,session.id,[{sequence:event.sequence,source_tool:'bstg.business.capture',method:event.method,url:event.url,
          request_headers:event.request_headers,request_body_text:event.request_body_text,response_status:event.response_status,
          response_headers:event.response_headers,response_body_text:event.response_body_text}]);
        const row=(await context.db.repos.recordingEvents.findAll({where:{session_id:session.id,sequence:event.sequence} as any,limit:1}))[0];
        if(!row)throw new Error('Recorded request did not produce a canonical recording event.');
        await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:event.task_id||context.taskId,artifact_type:'business_capture_event_link',source_ref:session.id,
          title:`业务步骤 ${event.sequence}`,content_json:{flow_id:input.flow_id,recording_session_id:session.id,recording_event_id:row.id,raw_artifact_id:raw.id,
            sequence:event.sequence,action_id:event.action_id,task_id:event.task_id,identity_key:event.identity_key,complete:event.complete}});
      });
      tail=write.catch(error=>{errors.push(String(error?.message||error));});
      return write;
    },
    ended:async(reason:'stopped'|'context_closed',captureErrors:string[])=>{
      await tail;
      const current=await context.db.repos.recordingSessions.findById(session.id);
      if(!current)return;
      const gaps=[...captureErrors,...errors],state=reason==='context_closed'?'interrupted':gaps.length?'incomplete':'stopped';
      await context.db.repos.recordingSessions.update(session.id,{status:state==='interrupted'?'failed':'finished',finished_at:new Date().toISOString(),
        capture_filters:{...current.capture_filters,capture_status:state},summary:{...current.summary,capture_errors:gaps}} as any);
      await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:context.taskId,artifact_type:'business_capture_session',source_ref:session.id,
        title:'正常业务录制状态',content_json:{flow_id:input.flow_id,recording_session_id:session.id,status:state,event_count:current.event_count,errors:gaps}});
      if(state!=='stopped')await flowEvent(context,input.flow_id,{status:'blocked',blockers:state==='interrupted'?['浏览器关闭，正常业务录制已中断。']:gaps});
    }};
  try {
    const started=await startPersistentBusinessCapture({repo:context.repo,scanRunId:context.scanRunId,taskId:context.taskId,scope_base_url:run.base_url,
      scope_type:input.scope_type,identity_key:identity||undefined,context_key:input.context_key,sink,signal:context.signal});
    await context.db.repos.recordingSessions.update(session.id,{capture_filters:{...session.capture_filters,context_key:started.context_key}} as any);
    await flowEvent(context,input.flow_id,{status:'learning',recording_session_id:session.id,blockers:[]});
    return {recording_session_id:session.id,flow_id:input.flow_id,identity_key:identity,context_key:started.context_key,capture_status:'recording'};
  } catch(error){
    await context.db.repos.recordingSessions.update(session.id,{status:'failed',capture_filters:{...session.capture_filters,capture_status:'failed'},summary:{...session.summary,error:String(error)}} as any);
    throw error;
  }
}

export async function stopBusinessCapture(context:AgentToolContext,sessionId:string):Promise<Record<string,any>> {
  const session=await requireBusinessRecording(context,sessionId),filters=session.capture_filters!;
  if(filters.task_id!==context.taskId)throw new Error('Only the capture owner task can stop this recording.');
  if(filters.capture_status==='recording')await stopPersistentBusinessCapture({scanRunId:context.scanRunId,taskId:context.taskId,
    capture_id:session.id,context_key:filters.context_key,scope_type:filters.scope_type,identity_key:filters.identity_key||undefined});
  return inspectBusinessCapture(context,session.id);
}

export async function inspectBusinessCapture(context:AgentToolContext,sessionId:string):Promise<Record<string,any>> {
  const session=await requireBusinessRecording(context,sessionId);
  const artifacts=await context.repo.listArtifacts(context.scanRunId);
  const redaction=await recordingRedaction(context,session,artifacts);
  const events=artifacts.filter(a=>a.artifact_type==='business_capture_event' && a.source_ref===session.id)
    .sort((a,b)=>a.content_json.sequence-b.content_json.sequence).map(a=>{
      const event=a.content_json as BusinessBrowserCaptureEvent;
      const link=artifacts.find(item=>item.artifact_type==='business_capture_event_link' && item.content_json.raw_artifact_id===a.id);
      return {sequence:event.sequence,event_id:link?.content_json.recording_event_id,raw_artifact_id:a.id,action_id:event.action_id,action:event.action,
        task_id:event.task_id,identity_key:event.identity_key,method:event.method,target:publicBusinessCaptureTarget(event.url),status:event.response_status,complete:event.complete,
        request:{headers:publicHeaders(event.request_headers),body:bodySummary(event.request_body_text,event.request_body_base64,event.request_headers['content-type'],redaction)},
        response:{headers:publicHeaders(event.response_headers),body:bodySummary(event.response_body_text,event.response_body_base64,event.response_headers['content-type'],redaction)},
        diagnostic:publicDiagnostic(event.error)};
    });
  return {flow_id:session.capture_filters!.flow_id,recording_session_id:session.id,status:session.capture_filters!.capture_status,
    identity_key:session.role,event_count:events.length,events,capture_error_count:(session.summary?.capture_errors||[]).length,
    notice:'Requests are observed facts. A recorded success response does not prove the normal business goal was completed.'};
}

function restoredEvent(event:RecordingEvent,raw:BusinessBrowserCaptureEvent):RecordingEvent {
  return {...event,request_headers:raw.request_headers,request_body_text:raw.request_body_text,parsed_request_body:parseObservedBody(raw.request_body_text,raw.request_headers['content-type']),
    response_headers:raw.response_headers,response_body_text:raw.response_body_text,parsed_response_body:parseObservedBody(raw.response_body_text,raw.response_headers['content-type'])};
}

/** Finish, generate and promote through the established recording services.
 * Private captured values only restore the executor's request snapshot; the
 * model sees fields/references and chooses which learned mappings to apply. */
export async function prepareBusinessWorkflow(context:AgentToolContext,input:{recording_session_id:string;event_ids?:string[];name?:string}):Promise<Record<string,any>> {
  assertScanActive();
  const session=await requireBusinessRecording(context,input.recording_session_id);
  if(session.capture_filters!.capture_status!=='stopped')throw new Error('Stop a complete recording before preparing its workflow.');
  const existing=(await context.db.repos.workflows.findAll({where:{source_recording_session_id:session.id} as any}))[0];
  if(existing)return inspectBusinessWorkflow(context,existing.id);
  const allArtifacts=await context.repo.listArtifacts(context.scanRunId);
  const rawEvents=allArtifacts.filter(a=>a.artifact_type==='business_capture_event' && a.source_ref===session.id).map(a=>a.content_json as BusinessBrowserCaptureEvent);
  if(!rawEvents.length || rawEvents.some(event=>!event.complete))throw new Error('The recording has missing or incomplete requests.');
  if(rawEvents.some(event=>event.request_body_base64))throw new Error('This recording includes a binary request body; use the existing multipart executor instead of a text workflow snapshot.');
  await finishRecordingSession(context.db,session.id);
  let detail=await getRecordingSessionDetail(context.db,session.id);
  const draft=detail.workflow_drafts[0];
  if(!draft)throw new Error('Recording did not produce an executable workflow draft.');
  const events=await context.db.repos.recordingEvents.findAll({where:{session_id:session.id} as any});
  if(input.event_ids){
    if(!input.event_ids.length || new Set(input.event_ids).size!==input.event_ids.length || input.event_ids.some(id=>!events.some(event=>event.id===id)))throw new Error('event_ids must select unique observed events from this recording.');
  }
  const selected=input.event_ids?events.filter(event=>input.event_ids!.includes(event.id)):events;
  const rawBySequence=new Map(rawEvents.map(event=>[event.sequence,event]));
  const dictionary=new FieldDictionary(context.db);await dictionary.load('global');
  const generated=generateWorkflowDraftArtifacts({session,events:selected.map(event=>restoredEvent(event,rawBySequence.get(event.sequence)!)),
    fieldHits:await context.db.repos.recordingFieldHits.findAll({where:{session_id:session.id} as any}),
    runtimeContexts:await context.db.repos.recordingRuntimeContext.findAll({where:{session_id:session.id} as any}),dictionary});
  if(!generated)throw new Error('No business steps remain after filtering transport/static requests.');
  // Refresh the existing draft with the canonical generator's private source,
  // preserving source-event IDs and avoiding a second recorder or compiler.
  const draftSteps=await context.db.repos.workflowDraftSteps.findAll({where:{workflow_draft_id:draft.id} as any});
  for(const step of draftSteps){
    const source=generated.steps.find(item=>item.source_event_id===step.source_event_id);
    await context.db.repos.workflowDraftSteps.update(step.id,source?{...source,workflow_draft_id:draft.id}:{enabled:false} as any);
  }
  detail=await getRecordingSessionDetail(context.db,session.id);
  const published=await publishWorkflowDraft(context.db,draft.id,{workflow_name:input.name,published_by:'agent_business'});
  const workflow=published.workflow;
  await context.db.repos.workflows.update(workflow.id,{assertion_strategy:'all_steps_pass',enable_baseline:false,enable_extractor:false,enable_session_jar:false,
    baseline_config:{capture_replay_only:true,exact_captured_baseline:true},learning_status:'unlearned'} as any);
  const learning=await buildRecordingLearningSuggestions(context.db,workflow.id,session.id,{includeExtractors:true,includeSessionJar:true,includeAssertions:true});
  await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:context.taskId,artifact_type:'business_workflow_learning',source_ref:workflow.id,
    title:'正常业务参数依赖候选',content_json:{flow_id:session.capture_filters!.flow_id,recording_session_id:session.id,workflow_id:workflow.id,
      summary:learning.summary,suggestions:learning.suggestions,conflicts:learning.conflicts,private:true}});
  await flowEvent(context,String(session.capture_filters!.flow_id),{workflow_id:workflow.id,recording_session_id:session.id,status:'learning'});
  return inspectBusinessWorkflow(context,workflow.id);
}

export async function inspectBusinessWorkflow(context:AgentToolContext,workflowId:string):Promise<Record<string,any>> {
  const workflow=await context.db.repos.workflows.findById(workflowId);
  if(!workflow?.source_recording_session_id)throw new Error('Workflow has no business recording provenance.');
  const session=await requireBusinessRecording(context,workflow.source_recording_session_id);
  const steps=(await context.db.repos.workflowSteps.findAll({where:{workflow_id:workflowId} as any})).sort((a,b)=>a.step_order-b.step_order);
  const templates=await Promise.all(steps.map(step=>context.db.repos.apiTemplates.findById(step.api_template_id)));
  const learning=await buildRecordingLearningSuggestions(context.db,workflowId,session.id,{includeExtractors:true,includeSessionJar:true,includeAssertions:true});
  return {flow_id:session.capture_filters!.flow_id,goal:(await requireBusinessFlow(context,String(session.capture_filters!.flow_id))).goal,
    recording_session_id:session.id,workflow_id:workflowId,identity_key:session.role,
    steps:steps.map((step,index)=>({step_id:step.id,step_order:step.step_order,template_id:step.api_template_id,name:step.snapshot_template_name,
      structure:publicTemplateStructure(templates[index]?.parsed_structure),assertions:(step.step_assertions||[]).map(publicBusinessAssertion)})),
    learning_candidates:{...publicLearningProjection(learning),
      interpretation:'Observed correlations are candidates, not verified dependencies. Select mappings justified by business state; matching transport headers or static values alone do not establish propagation.'},
    notice:'Learning candidates are observed correlations, not verified business dependencies. Select them and verify a new native Test Run.'};
}

async function snapshotBusinessWorkflow(context:AgentToolContext,workflowId:string):Promise<string> {
  const workflow=await context.db.repos.workflows.findById(workflowId);
  if(!workflow)throw new Error('Workflow not found.');
  const {id:_id,created_at:_created,updated_at:_updated,...values}=workflow;
  const snapshot=await context.db.repos.workflows.create({...values,name:`${workflow.name} · 正常执行快照`,baseline_config:{...workflow.baseline_config,capture_replay_only:true},assertion_strategy:'all_steps_pass'} as any);
  for(const [repository,where] of [[context.db.repos.workflowSteps,{workflow_id:workflowId}],[context.db.repos.workflowVariableConfigs,{workflow_id:workflowId}],[context.db.repos.workflowExtractors,{workflow_id:workflowId}]] as const){
    for(const row of await repository.findAll({where} as any)){
      const {id,created_at,updated_at,...fields}=row as any;
      await repository.create({...fields,workflow_id:snapshot.id} as any);
    }
  }
  for(const table of ['workflow_variables','workflow_mappings']){
    const rows=await dbAll<Record<string,any>>(context.db,`SELECT * FROM ${table} WHERE workflow_id = ?`,[workflowId]);
    for(const row of rows){
      const {created_at,updated_at,...fields}=row;
      const copy={...fields,id:randomUUID(),workflow_id:snapshot.id},keys=Object.keys(copy);
      await dbRun(context.db,`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(()=>'?').join(', ')})`,Object.values(copy));
    }
  }
  return snapshot.id;
}

export async function validateBusinessWorkflow(context:AgentToolContext,input:{workflow_id:string;assertions:BusinessGoalAssertion[];mapping_ids?:string[];apply_session_jar?:boolean}):Promise<Record<string,any>> {
  assertScanActive();
  const inspected=await inspectBusinessWorkflow(context,input.workflow_id),session=await requireBusinessRecording(context,inspected.recording_session_id);
  const flowId=String(session.capture_filters!.flow_id),run=await context.repo.getRun(context.scanRunId);
  if(!run)throw new Error('Assessment not found.');
  let steps=(await context.db.repos.workflowSteps.findAll({where:{workflow_id:input.workflow_id} as any})).sort((a,b)=>a.step_order-b.step_order);
  const assertions=validateBusinessAssertions(input.assertions,{requireSemantic:true});
  if(assertions.length>50 || assertions.some(item=>!steps.some(step=>step.step_order===item.step_order)))throw new Error('A business assertion references an unobserved workflow step.');
  const learning=await buildRecordingLearningSuggestions(context.db,input.workflow_id,session.id,{includeExtractors:true,includeSessionJar:true,includeAssertions:false});
  const ids=input.mapping_ids || [];
  if(ids.some(id=>!learning.suggestions.mappings.some(item=>item.id===id)))throw new Error('A selected mapping is not an observed learning candidate.');
  const selected=learning.suggestions.mappings.filter(item=>ids.includes(item.id));
  const snapshotId=await snapshotBusinessWorkflow(context,input.workflow_id);
  await context.db.repos.workflows.update(snapshotId,{baseline_config:{capture_replay_only:true,exact_captured_baseline:selected.length===0 && !input.apply_session_jar},
    enable_extractor:selected.length>0,enable_session_jar:input.apply_session_jar===true} as any);
  steps=(await context.db.repos.workflowSteps.findAll({where:{workflow_id:snapshotId} as any})).sort((a,b)=>a.step_order-b.step_order);
  if(selected.length || input.apply_session_jar){
    const variables=new Set(selected.map(item=>item.variableName));
    const selectedLearning={...learning,suggestions:{...learning.suggestions,mappings:selected.map(item=>({...item,selectedByDefault:true})),
      workflowVariables:learning.suggestions.workflowVariables.filter(item=>variables.has(item.variableName)),
      extractors:learning.suggestions.extractors.filter(item=>variables.has(item.targetVariableName)),assertions:[],
      sessionJar:input.apply_session_jar?learning.suggestions.sessionJar:null}};
    await applyLearningPayload(context.db,snapshotId,selectedLearning,{applyMode:'merge_keep_manual',applySessionJar:input.apply_session_jar===true,applyAssertions:false,minConfidence:0});
    await context.db.repos.workflows.update(snapshotId,{enable_extractor:selected.length>0} as any);
  }
  for(const step of steps){
    const template=await context.db.repos.apiTemplates.findById(step.api_template_id);
    if(!template)throw new Error('Observed step template is missing.');
    const source=(await context.db.repos.workflowDraftSteps.findAll({where:{session_id:session.id} as any})).find(draft=>draft.id===template.advanced_config?.source_workflow_draft_step_id);
    const event=source?await context.db.repos.recordingEvents.findById(source.source_event_id):null;
    const checks=assertions.filter(item=>item.step_order===step.step_order).map(assertion=>({...assertion,missing_behavior:'fail'}));
    const status=event?.response_status;
    await context.db.repos.workflowSteps.update(step.id,{step_assertions:[...(status?[{left:{type:'response',path:'status'},op:'equals',right:{type:'literal',value:String(status)},missing_behavior:'fail'}]:[]),...checks],assertions_mode:'all'} as any);
  }
  const environment=await context.db.repos.environments.create({name:`业务验证 ${flowId}`,base_url:run.base_url,is_active:true} as any);
  const accountIds=session.account_id?[session.account_id]:[];
  const testRun=await context.db.repos.testRuns.create({name:`正常业务验证 ${session.name}`,status:'pending',execution_type:'workflow',trigger_type:'ai_scan',workflow_id:snapshotId,
    account_ids:accountIds,environment_id:environment.id,rule_ids:[],progress_percent:0,source_recording_session_id:session.id,
    execution_params:{ai_scan_task_id:context.taskId,scan_run_id:context.scanRunId,flow_id:flowId,business_normal_run:true,source_workflow_id:input.workflow_id,
      business_assertions:assertions,mapping_ids:ids,apply_session_jar:input.apply_session_jar===true}} as any);
  const execution=await executeWorkflowRun({test_run_id:testRun.id,workflow_id:snapshotId,account_ids:accountIds,environment_id:environment.id,evidence_only:true});
  const trace=getTraceByRunId('workflow',testRun.id);
  const checks=assertions.map(assertion=>{
    const records=trace?.records.filter(record=>record.meta?.step_order===assertion.step_order)||[];
    const passed=records.length>0 && execution.success && records.every(record=>!record.error && record.response &&
      (assertion.right.type!=='literal' || evaluateStepAssertions([{left:assertion.left,op:assertion.op,right:assertion.right,missing_behavior:'fail'}],'all',
      {status:record.response.status,headers:record.response.headers,body:record.response.body||''},{},{extractedValues:{},cookies:{},sessionFields:{}}).passed));
    return {...assertion,name:assertion.description,passed,verified_by:'native_workflow_assertion_evaluator'};
  });
  const verified=execution.success && !execution.has_execution_error && Boolean(trace?.records.length) && checks.every(check=>check.passed);
  const traceArtifact=trace?await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:context.taskId,artifact_type:'business_native_trace',source_ref:testRun.id,
    title:'原生正常流程执行证据',content_json:{flow_id:flowId,test_run_id:testRun.id,workflow_id:snapshotId,source_workflow_id:input.workflow_id,identity_key:session.role,trace,private:true}}):undefined;
  const validationArtifact=await context.repo.createArtifact({scan_run_id:context.scanRunId,task_id:context.taskId,artifact_type:'business_workflow_validation',source_ref:testRun.id,
    title:'正常业务执行与结果验证',content_json:{flow_id:flowId,workflow_id:snapshotId,source_workflow_id:input.workflow_id,recording_session_id:session.id,test_run_id:testRun.id,
      assertions:checks.map(publicBusinessAssertion),assertions_verified:verified,execution:publicExecution(execution),trace:trace?{total_requests:trace.summary.total_requests,errors_count:trace.summary.errors_count,
        records:trace.records.map(record=>({step_order:record.meta?.step_order,status:record.response?.status,diagnostic:publicDiagnostic(record.error)}))}:null}});
  await flowEvent(context,flowId,{status:verified?'verified':'failed',normal_run_id:testRun.id,workflow_id:snapshotId,assertions:checks,
    assertions_verified:verified,baseline_verified:verified,evidence_artifact_ids:[validationArtifact.id,...(traceArtifact?[traceArtifact.id]:[])],
    blockers:verified?[]:[execution.error||'正常执行未通过全部业务结果断言。']});
  return {flow_id:flowId,workflow_id:snapshotId,source_workflow_id:input.workflow_id,test_run_id:testRun.id,verified,assertions:checks.map(publicBusinessAssertion),execution:publicExecution(execution),
    summary:verified?'正常业务流程已由原生执行器重新执行并验证。':'流程执行或业务结果验证未通过，相关安全实验不能把此基线视为已完成。'};
}
