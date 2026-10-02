import { createHash, randomUUID } from 'node:crypto';
import type { AIScanArtifact } from './types.js';
import type { AIScanRepository } from './repository.js';
import type { BusinessFlow } from './agent-business-contract.js';

const sha=(value:unknown)=>createHash('sha256').update(String(value)).digest('hex');
const MAX_HANDLES=120;
const MAX_VALUE_BYTES=4000;
// A value_ref is an authority to put one normal-flow value into a future
// native request.  Treat it as a narrowly-scoped object-selector capability,
// not a generic dynamic-value transport.  Tickets, CSRF values, sessions and
// credentials stay exclusively in the native Workflow mapping/session layer.
const SENSITIVE_SEGMENTS=new Set(['password','passwd','pwd','secret','authorization','auth','credential','credentials','api','apikey','cookie',
  'token','idtoken','accesstoken','refreshtoken','jwt','bearer','csrf','ticket','otp','passcode','session','sid','nonce','verification','code']);
const IDENTITY_SEGMENTS=new Set(['user','user_id','userid','account','account_id','accountid','owner','owner_id','ownerid','actor','actor_id','actorid','tenant','tenant_id','tenantid','principal','subject']);

/**
 * A handle is model-visible only as an opaque identifier and a safe field
 * shape.  The scalar itself stays in the private normal-run trace and is
 * resolved again by the server immediately before native compilation.
 */
export interface BusinessObjectHandle {
  id:string;
  flow_id:string;
  /** Exact verified-flow revision that produced this selector. */
  flow_revision:number;
  normal_run_id:string;
  normal_workflow_id:string;
  source_trace_artifact_id:string;
  producer_step_order:number;
  response_path:string;
  owner_role:string;
  /** The normal-flow identity that owns the selector.  Cross-account proof
   * requires both values; anonymous/generic handles cannot be used for BOLA. */
  owner_account_id?:string;
  owner_subject_sha256?:string;
  selector_kind:'resource_id';
  value_type:'string'|'number'|'boolean';
  value_sha256:string;
  lifecycle:'verified_normal_response';
}

function object(value:unknown):value is Record<string,any>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}

function normalizedField(value:string):string{
  return String(value||'').replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'').toLowerCase();
}

function isSensitiveField(value:string):boolean{
  const normalized=normalizedField(value);
  if(!normalized)return false;
  const compact=normalized.replace(/_/g,'');
  if(['apikey','accesstoken','refreshtoken','idtoken','sessiontoken'].includes(compact))return true;
  return normalized.split('_').some(segment=>SENSITIVE_SEGMENTS.has(segment));
}

/** Only server-recognizable resource selectors can become model-selectable
 * handles.  Values such as names, notes, display state or arbitrary response
 * fields must use native workflow data flow and cannot be injected by a plan. */
function isObjectSelectorPath(path:string):boolean{
  const parts=path.replace(/^body\./,'').split('.').filter(Boolean).filter(part=>!/^\d+$/.test(part));
  if(!parts.length||parts.some(isSensitiveField))return false;
  const normalized=parts.map(normalizedField);
  if(normalized.some(part=>IDENTITY_SEGMENTS.has(part)))return false;
  const terminal=normalized.at(-1)!;
  return terminal==='id'||terminal==='uuid'||terminal==='guid'||terminal==='resource_id'||terminal==='object_id'||
    terminal==='order_id'||terminal==='cart_id'||terminal==='item_id'||terminal==='record_id'||terminal==='entity_id'||terminal==='reference_id'||
    terminal.endsWith('_uuid')||terminal.endsWith('_guid');
}

function parseBody(value:unknown):unknown{
  if(typeof value!=='string')return value;
  try{return JSON.parse(value);}catch{return undefined;}
}

function collectScalars(value:unknown,path:string,depth=0,out:Array<{path:string;value:string|number|boolean}>=[]):Array<{path:string;value:string|number|boolean}>{
  if(out.length>=MAX_HANDLES||depth>10)return out;
  if(['string','number','boolean'].includes(typeof value)){
    if(Buffer.byteLength(String(value))<=MAX_VALUE_BYTES)out.push({path,value:value as string|number|boolean});
    return out;
  }
  if(Array.isArray(value)){
    value.slice(0,40).forEach((item,index)=>collectScalars(item,`${path}.${index}`,depth+1,out));
    return out;
  }
  if(object(value))for(const [key,item] of Object.entries(value).slice(0,80)){
    // A handle must be expressible by the same bounded dotted-path grammar
    // accepted by native assertions and mappings.
    if(!/^[A-Za-z_$][\w$]*$/.test(key)||isSensitiveField(key))continue;
    collectScalars(item,`${path}.${key}`,depth+1,out);
  }
  return out;
}

function valueAtPath(body:unknown,path:string):string|number|boolean|undefined{
  if(!path.startsWith('body.')||!isObjectSelectorPath(path))return undefined;
  let current:any=body;
  for(const part of path.slice('body.'.length).split('.')){
    if(!object(current)&&!Array.isArray(current))return undefined;
    current=(current as Record<string,any>)[part];
  }
  return ['string','number','boolean'].includes(typeof current)&&Buffer.byteLength(String(current))<=MAX_VALUE_BYTES?current:undefined;
}

function catalogs(artifacts:AIScanArtifact[]):BusinessObjectHandle[]{
  const values:BusinessObjectHandle[]=[];
  for(const artifact of artifacts.filter(item=>item.artifact_type==='business_object_handles')){
    const handles=artifact.content_json?.handles;
    if(Array.isArray(handles))for(const handle of handles)if(handle&&typeof handle.id==='string')values.push(handle as BusinessObjectHandle);
  }
  return values;
}

/** Create a private catalog after a *verified* normal run. It intentionally
 * stores no object value, only a hash and trace location. */
export async function createBusinessObjectHandles(input:{repo:AIScanRepository;scanRunId:string;taskId?:string;flow:BusinessFlow;
  normalRunId:string;normalWorkflowId:string;traceArtifactId:string;trace:any;ownerRole:string;flowRevision?:number;
  ownerAccountId?:string;ownerSubjectHash?:string;}):Promise<AIScanArtifact|undefined>{
  if(!input.flow.assertions_verified||input.flow.status!=='verified'||!input.trace)return undefined;
  const handles:BusinessObjectHandle[]=[];
  const seen=new Set<string>();
  for(const record of input.trace.records||[]){
    const stepOrder=Number(record?.meta?.step_order||0);
    if(!Number.isInteger(stepOrder)||stepOrder<1)continue;
    const body=parseBody(record?.response?.body);
    for(const scalar of collectScalars(body,'body')){
      if(!isObjectSelectorPath(scalar.path))continue;
      const key=`${stepOrder}:${scalar.path}:${sha(scalar.value)}`;
      if(seen.has(key)||handles.length>=MAX_HANDLES)continue;
      seen.add(key);
      handles.push({id:randomUUID(),flow_id:input.flow.id,flow_revision:Number.isInteger(input.flowRevision)?Number(input.flowRevision):input.flow.revision,normal_run_id:input.normalRunId,normal_workflow_id:input.normalWorkflowId,
        source_trace_artifact_id:input.traceArtifactId,producer_step_order:stepOrder,response_path:scalar.path,owner_role:input.ownerRole||'anonymous',
        ...(input.ownerAccountId?{owner_account_id:input.ownerAccountId}:{}),...(input.ownerSubjectHash?{owner_subject_sha256:input.ownerSubjectHash}:{}),
        selector_kind:'resource_id',value_type:typeof scalar.value as 'string'|'number'|'boolean',value_sha256:sha(scalar.value),lifecycle:'verified_normal_response'});
    }
  }
  if(!handles.length)return undefined;
  return input.repo.createArtifact({scan_run_id:input.scanRunId,task_id:input.taskId,artifact_type:'business_object_handles',source_ref:input.flow.id,
    title:'已验证业务对象选择器的私有句柄目录',content_json:{flow_id:input.flow.id,flow_revision:Number.isInteger(input.flowRevision)?Number(input.flowRevision):input.flow.revision,normal_run_id:input.normalRunId,normal_workflow_id:input.normalWorkflowId,
      handles,private:true}});
}

export async function listBusinessObjectHandles(repo:AIScanRepository,scanRunId:string,flowId?:string):Promise<BusinessObjectHandle[]>{
  const handles=catalogs(await repo.listArtifacts(scanRunId));
  const unique=new Map<string,BusinessObjectHandle>();
  for(const handle of handles){
    if(flowId&&handle.flow_id!==flowId)continue;
    unique.set(handle.id,handle);
  }
  return [...unique.values()].sort((left,right)=>left.producer_step_order-right.producer_step_order||left.id.localeCompare(right.id));
}

export interface BusinessObjectHandleScope {
  flow_id:string;
  flow_revision:number;
  normal_run_id:string;
  normal_workflow_id:string;
  owner_account_id?:string;
  owner_subject_sha256?:string;
}

/** Resolve only against a still-verified normal run. This blocks raw artifact
 * IDs/paths supplied by the model and turns a stale or deleted trace into a
 * compiler error rather than an implicit literal value. */
export async function resolveBusinessObjectHandle(repo:AIScanRepository,scanRunId:string,handleId:string,scope?:BusinessObjectHandleScope):Promise<{handle:BusinessObjectHandle;value:string|number|boolean}>{
  if(!/^[0-9a-f-]{16,}$/i.test(handleId))throw new Error('A bounded scan-owned opaque object handle is required.');
  const artifacts=await repo.listArtifacts(scanRunId);
  const handle=catalogs(artifacts).find(item=>item.id===handleId);
  if(!handle)throw new Error('The requested object handle does not belong to this assessment. Inspect verified business object handles first.');
  if(handle.selector_kind!=='resource_id'||!isObjectSelectorPath(handle.response_path))throw new Error('The requested handle is not a verified resource selector.');
  if(scope){
    if(handle.flow_id!==scope.flow_id||handle.flow_revision!==scope.flow_revision||handle.normal_run_id!==scope.normal_run_id||handle.normal_workflow_id!==scope.normal_workflow_id){
      throw new Error('The requested object handle belongs to an outdated or different verified business baseline. Re-inspect current-flow handles.');
    }
    if(scope.owner_account_id!==undefined&&handle.owner_account_id!==scope.owner_account_id)throw new Error('The object handle owner does not match the current verified control identity.');
    if(scope.owner_subject_sha256!==undefined&&handle.owner_subject_sha256!==scope.owner_subject_sha256)throw new Error('The object handle subject does not match the current verified control identity.');
  }
  const validation=artifacts.find(item=>item.artifact_type==='business_workflow_validation'&&item.source_ref===handle.normal_run_id&&
    item.content_json?.flow_id===handle.flow_id&&item.content_json?.workflow_id===handle.normal_workflow_id&&item.content_json?.assertions_verified===true);
  if(!validation)throw new Error('The object handle no longer has a verified normal-flow validation source.');
  const traceArtifact=artifacts.find(item=>item.id===handle.source_trace_artifact_id&&item.artifact_type==='business_native_trace'&&
    item.source_ref===handle.normal_run_id&&item.content_json?.flow_id===handle.flow_id&&item.content_json?.workflow_id===handle.normal_workflow_id&&item.content_json?.private===true);
  if(!traceArtifact)throw new Error('The object handle no longer has its private native trace source.');
  // A selected native step may legitimately repeat (for example a paginated
  // or replayable workflow). Resolve the record whose value hash matches the
  // catalog entry rather than assuming the first response at that step order
  // is the one that produced this handle.
  const value=(traceArtifact.content_json?.trace?.records||[])
    .filter((item:any)=>Number(item?.meta?.step_order)===handle.producer_step_order&&!item?.error&&item?.response)
    .map((item:any)=>valueAtPath(parseBody(item.response?.body),handle.response_path))
    .find((candidate:string|number|boolean|undefined)=>candidate!==undefined&&sha(candidate)===handle.value_sha256);
  if(value===undefined)throw new Error('The object handle value is unavailable or no longer matches its verified normal-run trace.');
  return {handle,value};
}

export function publicBusinessObjectHandle(handle:BusinessObjectHandle):Record<string,any>{
  return {handle_id:handle.id,flow_id:handle.flow_id,normal_run_id:handle.normal_run_id,producer_step_order:handle.producer_step_order,
    response_path:handle.response_path,owner_role:handle.owner_role,selector_kind:handle.selector_kind,value_type:handle.value_type,lifecycle:handle.lifecycle};
}
