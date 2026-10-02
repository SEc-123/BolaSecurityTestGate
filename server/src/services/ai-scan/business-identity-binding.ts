import { createHash, randomUUID } from 'node:crypto';
import { parseRawRequest } from '../execution-utils.js';
import type { DebugTrace } from '../debug-trace.js';
import type { WorkflowStep } from '../../types/index.js';

type Scalar=string|number|boolean;

export interface TrustedAccountIdentityRequirement {
  role:string;
  account_id:string;
  auth_context_generation:string;
  auth_context_fingerprint:string;
  source_workflow_id:string;
  probe_source_step_order:number;
  subject_path:string;
  expected_subject_sha256:string;
  tenant_path?:string;
  expected_tenant_sha256?:string;
  role_path?:string;
  expected_role_sha256?:string;
  probe_workflow_id?:string;
}

export interface TrustedAccountIdentityEvidence {
  role:string;
  /** The probe must bracket the execution phase it is meant to certify. */
  execution_kind:'control'|'experiment';
  account_id:string;
  auth_context_generation:string;
  auth_context_fingerprint:string;
  source_workflow_id:string;
  probe_source_step_order:number;
  probe_workflow_id?:string;
  probe_test_run_id?:string;
  phase:'pre'|'post';
  verified:boolean;
  subject_sha256?:string;
  tenant_sha256?:string;
  role_sha256?:string;
  trace_artifact_id?:string;
  diagnostic?:string;
}

const sha=(value:unknown)=>createHash('sha256').update(String(value??'')).digest('hex');

function stable(value:unknown):string {
  if(value===null||value===undefined)return String(value);
  if(typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value as Record<string,unknown>).sort().map(key=>`${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;
}

function scalar(value:unknown):value is Scalar { return ['string','number','boolean'].includes(typeof value); }

function pathParts(path:string):string[] {
  if(!/^body\.[A-Za-z_$][\w$]*(?:\.(?:[A-Za-z_$][\w$]*|\d+))*$/.test(path)) throw new Error('A trusted account identity probe must use a bounded response body path.');
  return path.slice('body.'.length).split('.');
}

export function readIdentityProbeScalar(body:string|undefined,path:string):Scalar|undefined {
  let value:any;
  try { value=JSON.parse(body||''); } catch { return undefined; }
  for(const part of pathParts(path)) {
    if(!value||typeof value!=='object'||!(part in value)) return undefined;
    value=value[part];
  }
  return scalar(value)?value:undefined;
}

function probeProfile(account:any):Record<string,any> {
  const profile=(account?.auth_profile||{}) as Record<string,any>;
  const probe=profile.identity_probe??profile.identityProbe;
  if(!probe||typeof probe!=='object'||Array.isArray(probe)) throw new Error('Cross-identity execution requires a server-provisioned auth_profile.identity_probe for every participating account.');
  return probe as Record<string,any>;
}

function expected(value:unknown,label:string):Scalar {
  if(!scalar(value)||String(value).length>4000) throw new Error(`The server-provisioned identity probe needs a bounded ${label}.`);
  return value;
}

/** This fingerprint is private evidence. It covers the complete selected
 * account context, so a probe cannot bless a request run under a later or
 * different auth_profile. */
export function accountAuthContextFingerprint(account:any):string {
  return sha(stable({ fields:account?.fields||{}, auth_profile:account?.auth_profile||{}, variables:account?.variables||{} }));
}

/** Create a requirement solely from operator-provisioned account configuration
 * and a fixed native GET/HEAD snapshot. Model plans never define probe URL,
 * response path or expected subject. */
export function buildTrustedAccountIdentityRequirement(input:{role:string;account:any;sourceWorkflowId:string;sourceSteps:WorkflowStep[]}):TrustedAccountIdentityRequirement {
  const probe=probeProfile(input.account);
  const stepOrder=Number(probe.source_step_order??probe.step_order);
  if(!Number.isInteger(stepOrder)||stepOrder<1) throw new Error('The server-provisioned identity probe must name an observed positive source step order.');
  const step=input.sourceSteps.find(candidate=>candidate.step_order===stepOrder);
  if(!step) throw new Error('The server-provisioned identity probe does not belong to the verified source workflow.');
  const parsed=parseRawRequest(step.request_snapshot_raw||'');
  if(!parsed||!['GET','HEAD'].includes(parsed.method.toUpperCase())||parsed.body) throw new Error('The server-provisioned identity probe must use an immutable observed GET or HEAD snapshot without a body.');
  const subjectPath=String(probe.subject_path??probe.response_path??'');
  pathParts(subjectPath);
  const requirement:TrustedAccountIdentityRequirement={role:input.role,account_id:String(input.account.id),auth_context_generation:randomUUID(),
    auth_context_fingerprint:accountAuthContextFingerprint(input.account),source_workflow_id:input.sourceWorkflowId,probe_source_step_order:stepOrder,
    subject_path:subjectPath,expected_subject_sha256:sha(expected(probe.expected_subject,'expected_subject'))};
  const tenantPath=probe.tenant_path===undefined?undefined:String(probe.tenant_path);
  const rolePath=probe.role_path===undefined?undefined:String(probe.role_path);
  if(tenantPath!==undefined){ pathParts(tenantPath); requirement.tenant_path=tenantPath; requirement.expected_tenant_sha256=sha(expected(probe.expected_tenant,'expected_tenant')); }
  if(rolePath!==undefined){ pathParts(rolePath); requirement.role_path=rolePath; requirement.expected_role_sha256=sha(expected(probe.expected_role,'expected_role')); }
  return requirement;
}

/** Verify a trace produced by the server-owned identity probe. A model-created
 * `purpose: identity` assertion is deliberately irrelevant here. */
export function verifyTrustedAccountIdentityProbe(requirement:TrustedAccountIdentityRequirement,trace:DebugTrace|null|undefined):Omit<TrustedAccountIdentityEvidence,'role'|'execution_kind'|'probe_test_run_id'|'phase'|'probe_workflow_id'|'trace_artifact_id'>{
  const matching=(trace?.records||[]).filter(record=>Number(record.meta?.step_order)===requirement.probe_source_step_order&&
    record.meta?.account_id===requirement.account_id&&record.meta?.auth_context_generation===requirement.auth_context_generation);
  const latest=[...matching].reverse().find(record=>!record.error&&record.response&&record.response.status>=200&&record.response.status<300);
  const base={account_id:requirement.account_id,auth_context_generation:requirement.auth_context_generation,auth_context_fingerprint:requirement.auth_context_fingerprint,
    source_workflow_id:requirement.source_workflow_id,probe_source_step_order:requirement.probe_source_step_order};
  if(!latest?.response) return {...base,verified:false,diagnostic:'No successful server-bound identity probe response was recorded.'};
  const subject=readIdentityProbeScalar(latest.response.body,requirement.subject_path);
  const tenant=requirement.tenant_path?readIdentityProbeScalar(latest.response.body,requirement.tenant_path):undefined;
  const role=requirement.role_path?readIdentityProbeScalar(latest.response.body,requirement.role_path):undefined;
  const subjectHash=subject===undefined?undefined:sha(subject),tenantHash=tenant===undefined?undefined:sha(tenant),roleHash=role===undefined?undefined:sha(role);
  const verified=subjectHash===requirement.expected_subject_sha256&&
    (!requirement.expected_tenant_sha256||tenantHash===requirement.expected_tenant_sha256)&&
    (!requirement.expected_role_sha256||roleHash===requirement.expected_role_sha256);
  return {...base,verified,...(subjectHash?{subject_sha256:subjectHash}:{}),...(tenantHash?{tenant_sha256:tenantHash}:{}),...(roleHash?{role_sha256:roleHash}:{}),
    ...(verified?{}:{diagnostic:'The server-bound identity probe response did not match the provisioned account subject.'})};
}
