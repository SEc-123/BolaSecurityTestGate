import { parseRawRequest } from '../execution-utils.js';
import type { DebugTrace } from '../debug-trace.js';
import type { BusinessAssertion } from './agent-business-contract.js';
import type { TrustedAccountIdentityEvidence, TrustedAccountIdentityRequirement } from './business-identity-binding.js';

type AssertionFact=BusinessAssertion&{passed:boolean};

export interface BusinessProofInput {
  plan:Record<string,any>;
  compilation:Record<string,any>;
  sourceSteps:Array<{id:string;step_order:number;request_snapshot_raw?:string}>;
  controlAssertions:AssertionFact[];
  experimentAssertions:AssertionFact[];
  controlVerified:boolean;
  executionVerified:boolean;
  concurrentSuccess?:number;
  identity_evidence?:TrustedAccountIdentityEvidence[];
  control_trace?:DebugTrace|null;
  experiment_trace?:DebugTrace|null;
}

export interface BusinessProof {
  verified:boolean;
  authentication:{required:boolean;verified:boolean;control_role:string;experiment_roles:string[]};
  object_authorization:{required:boolean;verified:boolean;handle_count:number};
  function_authorization:{required:boolean;verified:boolean};
  write_postcondition:{required:boolean;verified:boolean;readback_step_orders:number[]};
  replay_race:{required:boolean;verified:boolean};
  /** A failed impact assertion is not a security counterexample. A future
   * server-owned immutable no-change oracle may satisfy this gate. */
  negative_proof:{required:boolean;verified:boolean};
  /** Finite, model-safe guidance. The raw prose remains private to the
   * canonical evidence record; these codes let the planner choose a repair or
   * a justified block without repeating a blind experiment. */
  evidence_gaps:Array<{failure_code:string;summary:string}>;
  missing_evidence:string[];
}

function selectedMethods(input:BusinessProofInput):Map<number,string>{
  const byId=new Map(input.sourceSteps.map(step=>[step.id,step]));
  const methods=new Map<number,string>();
  for(const selected of input.plan.steps||[]){
    const step=byId.get(selected.id);
    if(!step||Number(selected.source_step_order)!==step.step_order)continue;
    const parsed=parseRawRequest(step.request_snapshot_raw||'');
    if(parsed)methods.set(step.step_order,parsed.method.toUpperCase());
  }
  return methods;
}

function passedSemantic(facts:AssertionFact[],orders:number[],purposes:string[]):boolean{
  return facts.some(fact=>fact.passed===true&&orders.includes(fact.step_order)&&purposes.includes(fact.purpose)&&fact.left?.path?.startsWith('body.'));
}

function assertionHandleId(value:any):string|undefined{return value?.type==='value_ref'&&typeof value.handle_id==='string'?value.handle_id:undefined;}
function patchHandleId(value:any):string|undefined{return typeof value?.handle_id==='string'?value.handle_id:undefined;}
function requiredRoles(plan:Record<string,any>,controlRole=String(plan.control_role||'normal')):string[]{return [...new Set([...(plan.steps||[]).map((step:any)=>String(step.role||'normal')),controlRole])];}
function matchingEvidence(evidence:TrustedAccountIdentityEvidence[],role:string,executionKind:'control'|'experiment',phase:'pre'|'post'):TrustedAccountIdentityEvidence|undefined{return evidence.find(item=>item.role===role&&item.execution_kind===executionKind&&item.phase===phase);}

function traceBoundToRole(trace:DebugTrace|null|undefined,steps:any[],role:string,accountId:string,generation:string):boolean{
  for(const step of steps.filter(item=>String(item.role||'normal')===role)){
    const records=(trace?.records||[]).filter(record=>Number(record.meta?.step_order)===Number(step.source_step_order));
    if(!records.length||records.some(record=>record.meta?.account_id!==accountId||record.meta?.auth_context_generation!==generation))return false;
  }
  return true;
}

function traceBoundToAccount(trace:DebugTrace|null|undefined,steps:any[],accountId:string,generation:string):boolean{
  for(const step of steps){
    const records=(trace?.records||[]).filter(record=>Number(record.meta?.step_order)===Number(step.source_step_order));
    if(!records.length||records.some(record=>record.meta?.account_id!==accountId||record.meta?.auth_context_generation!==generation))return false;
  }
  return true;
}

/** Authentication facts come only from server-provisioned account probes and
 * trace metadata attached by the native overlay. Model labels/identity
 * assertions cannot bless a retained captured session. */
function trustedAuthentication(input:BusinessProofInput,experimentRoles:string[],controlRole:string):{required:boolean;verified:boolean}{
  const roles=requiredRoles(input.plan,controlRole);
  const crossRole=roles.some(role=>role!=='normal');
  if(!crossRole)return {required:false,verified:true};
  const requirements:Array<TrustedAccountIdentityRequirement>=Array.isArray(input.compilation.identity_requirements)?input.compilation.identity_requirements:[];
  const evidence=input.identity_evidence||[];
  const roleAccounts:Record<string,string>=input.compilation.role_account_ids&&typeof input.compilation.role_account_ids==='object'?input.compilation.role_account_ids:{};
  const requirementByRole=new Map(requirements.map(requirement=>[requirement.role,requirement]));
  if(roles.some(role=>{
    const requirement=requirementByRole.get(role);
    return !requirement||requirement.account_id!==roleAccounts[role];
  }))return {required:true,verified:false};
  const control=requirementByRole.get(controlRole);
  if(!control)return {required:true,verified:false};
  const controlEvidence=['pre','post'].map(phase=>matchingEvidence(evidence,controlRole,'control',phase as 'pre'|'post'));
  if(controlEvidence.some(item=>!item?.verified||item.account_id!==control.account_id||item.auth_context_generation!==control.auth_context_generation||item.auth_context_fingerprint!==control.auth_context_fingerprint))return {required:true,verified:false};
  if(!traceBoundToAccount(input.control_trace,input.plan.steps||[],control.account_id,control.auth_context_generation))return {required:true,verified:false};
  for(const role of experimentRoles){
    const requirement=requirementByRole.get(role);
    if(!requirement)return {required:true,verified:false};
    const pre=matchingEvidence(evidence,role,'experiment','pre'),post=matchingEvidence(evidence,role,'experiment','post');
    if(!pre?.verified||!post?.verified||pre.account_id!==requirement.account_id||post.account_id!==requirement.account_id||
      pre.auth_context_generation!==requirement.auth_context_generation||post.auth_context_generation!==requirement.auth_context_generation||
      pre.auth_context_fingerprint!==requirement.auth_context_fingerprint||post.auth_context_fingerprint!==requirement.auth_context_fingerprint)return {required:true,verified:false};
    if(!traceBoundToRole(input.experiment_trace,input.plan.steps||[],role,requirement.account_id,requirement.auth_context_generation))return {required:true,verified:false};
  }
  const alternateRoles=experimentRoles.filter(role=>role!==controlRole);
  const distinct=alternateRoles.length===0||alternateRoles.every(role=>{
    const requirement=requirementByRole.get(role)!;
    return requirement.account_id!==control.account_id&&requirement.expected_subject_sha256!==control.expected_subject_sha256;
  });
  return {required:true,verified:distinct};
}

function selectorPatch(patch:any):boolean{
  const terminal=String(patch.path||'').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase().split('.').at(-1)||'';
  return patch.location==='path'&&/^(?:segment\.|__bstg_segment_)\d+$/.test(String(patch.path||''))||
    ['query','json_body','form_body'].includes(String(patch.location||''))&&/(?:^|_)(?:id|uuid|guid)(?:$|_)/.test(terminal);
}

/** Evidence gate for model-directed native tests. A 2xx response alone
 * deliberately satisfies none of these facts. */
export function evaluateBusinessProof(input:BusinessProofInput):BusinessProof{
  const missing:string[]=[];
  const evidenceGaps:Array<{failure_code:string;summary:string}>=[];
  const addGap=(failure_code:string,message:string,summary:string)=>{
    missing.push(message);
    evidenceGaps.push({failure_code,summary});
  };
  const selected:any[]=Array.isArray(input.plan.steps)?input.plan.steps:[];
  const roles:string[]=[...new Set<string>(selected.map((step:any)=>String(step.role||'normal')))];
  const controlRole=String(input.compilation.control_role||input.plan.control_role||'normal');
  const auth=trustedAuthentication(input,roles,controlRole);
  const authentication={required:auth.required,verified:auth.verified,control_role:controlRole,experiment_roles:roles};
  if(authentication.required&&!authentication.verified)addGap('trusted_identity_proof_missing',
    '跨身份实验缺少服务器探针验证的主体、认证代际或原生请求绑定。',
    'The selected cross-identity experiment lacks server-probed subject, authentication-generation, or native-request binding evidence. Use only prepared identities and inspect the exact safe proof gap before revising.');

  const methods=selectedMethods(input);
  const writes=[...methods.entries()].filter(([,method])=>!['GET','HEAD','OPTIONS'].includes(method)).map(([order])=>order);
  const reads=[...methods.entries()].filter(([,method])=>['GET','HEAD'].includes(method)).map(([order])=>order);
  const lastWriteOrder=writes.length?Math.max(...writes):0;
  const readbackOrders=reads.filter(order=>order>=lastWriteOrder);
  const sourceReadbackOrders=input.sourceSteps.filter(step=>step.step_order>=lastWriteOrder&&
    ['GET','HEAD'].includes(parseRawRequest(step.request_snapshot_raw||'')?.method.toUpperCase()||'')).map(step=>step.step_order);
  const writeRequired=writes.length>0;
  const writeVerified=!writeRequired||(sourceReadbackOrders.length>0&&readbackOrders.length>0&&passedSemantic(input.experimentAssertions,readbackOrders,['impact','state'])&&
    passedSemantic(input.controlAssertions,readbackOrders,['control','goal','state']));
  const write_postcondition={required:writeRequired,verified:writeVerified,readback_step_orders:readbackOrders};
  if(writeRequired&&!writeVerified){
    if(!sourceReadbackOrders.length)addGap('authoritative_readback_unavailable',
      '当前已验证工作流在写操作后没有权威状态读回步骤。',
      'The verified normal Workflow has no observed GET/HEAD read-back after its state-changing request. This experiment stage cannot add source requests. Do not execute another plan from the same Workflow; block this experiment with the missing-readback code so the normal Flow can be extended and verified first.');
    else addGap('authoritative_readback_assertions_missing',
      '写操作没有由控制与实验中的权威读回语义断言共同验证。',
      'The verified Flow contains a read-back step, but the current plan does not prove authoritative business state on that step in both control and experiment. Inspect its observed body paths and create a child plan with matching control and impact/state assertions.');
  }

  const handles=Array.isArray(input.compilation.object_handles)?input.compilation.object_handles:[];
  const patchesByHandle=new Map<string,any[]>();
  for(const patch of input.plan.patches||[]){const id=patchHandleId(patch.value_ref);if(id)patchesByHandle.set(id,[...(patchesByHandle.get(id)||[]),patch]);}
  const assertionHandleIds=[...(input.plan.assertions||[]),...(input.plan.control_assertions||[])].map((assertion:any)=>assertionHandleId(assertion.right)).filter((id):id is string=>Boolean(id));
  const handleIds=[...new Set([...patchesByHandle.keys(),...assertionHandleIds])];
  const handleById=new Map(handles.map((handle:any)=>[String(handle.handle_id),handle]));
  const roleAccounts:Record<string,string>=input.compilation.role_account_ids&&typeof input.compilation.role_account_ids==='object'?input.compilation.role_account_ids:{};
  const requirements:Array<TrustedAccountIdentityRequirement>=Array.isArray(input.compilation.identity_requirements)?input.compilation.identity_requirements:[];
  const requirementByRole=new Map(requirements.map(requirement=>[requirement.role,requirement]));
  const objectRequired=handleIds.length>0;
  let objectVerified=!objectRequired;
  if(objectRequired){
    objectVerified=handleIds.length===handles.filter((handle:any)=>handleIds.includes(String(handle.handle_id))).length&&authentication.verified&&input.controlVerified&&input.executionVerified&&writeVerified&&handleIds.every(id=>{
      const handle=handleById.get(id);if(!handle||handle.selector_kind!=='resource_id')return false;
      if(authentication.required){
        const control=requirementByRole.get(controlRole);if(!control||handle.owner_role!==controlRole||handle.owner_account_id!==control.account_id||handle.owner_subject_sha256!==control.expected_subject_sha256)return false;
      }
      const patches=patchesByHandle.get(id)||[];
      if(!patches.length||patches.some(patch=>!selectorPatch(patch)))return false;
      const consumers=patches.map(patch=>selected.find((step:any)=>step.id===patch.step_id)?.role||'normal');
      if(authentication.required){
        const control=requirementByRole.get(controlRole)!;
        if(consumers.some((role:string)=>role===controlRole||roleAccounts[role]===control.account_id))return false;
      }
      const lastWrite=Math.max(...patches.map(patch=>Number(selected.find((step:any)=>step.id===patch.step_id)?.source_step_order||0)));
      const experimentalReadback=(input.plan.assertions||[]).some((assertion:any)=>assertion.right?.type==='value_ref'&&assertion.right.handle_id===id&&assertion.left?.path?.startsWith('body.')&&
        Number(assertion.step_order)>=lastWrite&&input.experimentAssertions.some(fact=>fact.id===assertion.id&&fact.passed));
      const controlReadback=(input.plan.control_assertions||[]).some((assertion:any)=>assertion.right?.type==='value_ref'&&assertion.right.handle_id===id&&assertion.left?.path?.startsWith('body.')&&
        Number(assertion.step_order)>=lastWrite&&input.controlAssertions.some(fact=>fact.id===assertion.id&&fact.passed));
      return experimentalReadback&&controlReadback;
    });
    if(!objectVerified)addGap('cross_account_object_proof_incomplete',
      '跨账号对象证明缺少同一资源选择键、owner 控制身份、不同攻击主体或同对象权威读回。',
      'Cross-account object proof is incomplete. Inspect the opaque object handle, owner control identity, distinct prepared attacker identity, and same-object authoritative read-back requirements; do not infer authorization from status codes.');
  }
  const object_authorization={required:objectRequired,verified:objectVerified,handle_count:handleIds.length};

  const functionRequired=authentication.required&&!objectRequired;
  const functionVerified=!functionRequired||(authentication.verified&&input.controlVerified&&input.executionVerified&&writeVerified);
  if(functionRequired&&!functionVerified)addGap('cross_role_function_proof_incomplete',
    '跨角色功能权限实验缺少服务端主体探针、控制和权威业务结果。',
    'Cross-role function proof lacks a server-probed identity, a verified control, or an authoritative business outcome. Use prepared identities and observed state evidence only.');
  const function_authorization={required:functionRequired,verified:functionVerified};

  const replayRequired=Boolean(input.plan.concurrency)||(Array.isArray(input.plan.repeats)&&input.plan.repeats.length>0)||(Array.isArray(input.plan.parallel)&&input.plan.parallel.length>0);
  const replayVerified=!replayRequired||(writeVerified&&input.executionVerified&&input.controlVerified&&(!input.plan.concurrency||Number(input.concurrentSuccess||0)>=2));
  if(replayRequired&&!replayVerified)addGap('replay_state_proof_incomplete',
    '重放或并发实验缺少足量原生请求结果与权威最终状态读回。',
    'Replay/concurrency proof lacks enough native request results or an authoritative final-state read-back. Use only the supported native execution shape and a verified post-action state assertion.');
  const replay_race={required:replayRequired,verified:replayVerified};

  const negativeRequired=!input.executionVerified;
  const negative_proof={required:negativeRequired,verified:false};
  if(negativeRequired)addGap('negative_counterexample_proof_missing',
    '影响断言未满足不构成安全反证；缺少服务端生成的同对象未变更负向证明。',
    'A failed impact assertion is not a secure counterexample. The server has not produced a same-object unchanged-state proof, so keep the assessment inconclusive.');
  const verified=input.controlVerified&&input.executionVerified&&authentication.verified&&object_authorization.verified&&function_authorization.verified&&write_postcondition.verified&&replay_race.verified;
  return {verified,authentication,object_authorization,function_authorization,write_postcondition,replay_race,negative_proof,evidence_gaps:evidenceGaps,missing_evidence:missing};
}
