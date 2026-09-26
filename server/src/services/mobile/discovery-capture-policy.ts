import type { MobileLabProfile,MobileSession,NormalizedHttpFlow } from './mobile-types.js';
import { captureRejectionReason } from './mobile-target-contract.js';

/** Plain HTTP can be acquired, but is never described as decrypted TLS evidence. */
export function discoveryCaptureRejection(flow:NormalizedHttpFlow,session:MobileSession,profile:MobileLabProfile):string|undefined {
  let url:URL;try{url=new URL(flow.url);}catch{return 'invalid_url';}
  if(profile.config_json.capture_origin && url.origin!==profile.config_json.capture_origin)return 'outside_authorized_origin';
  if(url.protocol==='https:')return captureRejectionReason(flow,session,profile.config_json.capture_allowed_hosts||[]);
  if(profile.config_json.acquisition_mode!=='explore'||!profile.config_json.capture_http_only||url.protocol!=='http:'||url.username||url.password)return 'unsupported_transport';
  if(!flow.flow_id||flow.app_package!==session.app_package||flow.device_id!==session.device_id||flow.capture_session_id!==session.health_json.capture?.id)return 'wrong_capture_identity';
  if(!flow.request_complete||!flow.response_complete||!Number.isInteger(flow.response_status)||(flow.response_status ?? 0)<100||(flow.response_status ?? 0)>599||typeof flow.request_body_text!=='string'||typeof flow.response_body_text!=='string')return 'incomplete_http_evidence';
  const started=Date.parse(flow.started_at||''), completed=Date.parse(flow.completed_at||''), boundary=Date.parse(session.health_json.capture?.started_at||'');
  if(!Number.isFinite(started)||!Number.isFinite(completed)||started<boundary||completed<started||completed>Date.now()+5000)return 'invalid_timestamp';
  if(!(profile.config_json.capture_allowed_hosts||[]).includes(url.hostname))return 'outside_authorized_hosts';
  return undefined;
}
