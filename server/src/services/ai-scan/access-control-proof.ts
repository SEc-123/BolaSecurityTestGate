import type { HttpRequestSpec, HttpResponseEvidence } from './http-executor.js';
import { executeHttpRequest } from './http-executor.js';

function owner(text:string):string|undefined {
  try {
    const data=JSON.parse(text);
    for(const value of [data,data?.data,data?.order,data?.data?.order,data?.file,data?.data?.file]) {
      const id=value?.owner_id ?? value?.ownerId ?? value?.user_id ?? value?.userId ?? value?.owner?.id;
      if(['string','number'].includes(typeof id))return String(id);
    }
  }catch{}
  return undefined;
}
function session(fields:Record<string,any>):{headers:Record<string,string>;cookies:Record<string,string>}|undefined {
  const token=fields.auth_token||fields.authorization||fields.access_token||fields.token;
  const cookies=fields.cookies && typeof fields.cookies==='object'?fields.cookies:{};
  if(!token&&!Object.keys(cookies).length)return undefined;
  return {headers:token?{authorization:/^(Bearer|Basic) /i.test(String(token))?String(token):`Bearer ${token}`}:{},cookies};
}
/** Confirmation requires observed ownership, distinct identities and an owner-session control.
 * Success text, reflected identifiers and response differences alone are never BOLA proof. */
export async function verifyObjectAuthorization(input:{request:HttpRequestSpec;baseline:HttpResponseEvidence;mutated:HttpResponseEvidence;attacker:Record<string,any>;victim:Record<string,any>}):Promise<Record<string,any>>{
  if(!['GET','HEAD'].includes(input.request.method.toUpperCase()))return {verified:false,reason:'write_operation_requires_explicit_business_control'};
  const attackerId=input.attacker.user_id??input.attacker.id, victimId=input.victim.user_id??input.victim.id;
  const victimSession=session(input.victim), attackerSession=session(input.attacker);
  if(attackerId==null||victimId==null||String(attackerId)===String(victimId)||!victimSession||!attackerSession) return {verified:false,reason:'distinct_authenticated_identities_and_owner_ids_required'};
  if(JSON.stringify(victimSession)===JSON.stringify(attackerSession))return {verified:false,reason:'identities_share_session'};
  if(owner(input.baseline.body_preview)!==String(attackerId)||owner(input.mutated.body_preview)!==String(victimId))return {verified:false,reason:'object_ownership_not_proven'};
  if(!input.baseline.ok||!input.mutated.ok)return {verified:false,reason:'baseline_or_variant_rejected'};
  const headers={...input.request.headers};delete headers.authorization;delete headers.Authorization;delete headers.cookie;delete headers.Cookie;
  const control=await executeHttpRequest({...input.request,headers:{...headers,...victimSession.headers},cookies:victimSession.cookies,traffic_class:'read'});
  return {verified:control.ok&&owner(control.body_preview)===String(victimId)&&control.body_hash===input.mutated.body_hash,
    reason:'owner_session_control',owner_response:control};
}
