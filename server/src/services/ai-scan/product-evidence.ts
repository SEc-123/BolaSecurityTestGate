import { sanitizeModelString } from '../../agent/model-context-sanitizer.js';
import { buildProductAssessmentState } from './product-state-service.js';
import type { AIScanSnapshot } from './types.js';
import type { AssessmentEvidence } from './product-state-types.js';

export const evidenceText = (value: unknown, limit=8000) => sanitizeModelString(typeof value==='string'?value:JSON.stringify(value??'')).slice(0,limit);
const text = evidenceText;
export function safeEvidenceUrl(value: string): string {
  try {
    const url=new URL(value); url.username='';url.password='';url.hash='';
    for(const key of [...url.searchParams.keys()])if(/token|password|secret|session|cookie|auth|key|otp|code/i.test(key))url.searchParams.set(key,'[REDACTED]');
    return url.toString();
  }catch{return text(value,2000);}
}
const safeUrl = safeEvidenceUrl;
/** Evidence is scoped to one public test, not a caller-supplied arbitrary artifact ID. */
export function buildProductEvidence(snapshot:AIScanSnapshot,testId:string):AssessmentEvidence|null{
  const state=buildProductAssessmentState(snapshot);
  const test=state.business_functions.flatMap(f=>f.tests).find(t=>t.id===testId);
  if(!test)return null;
  // Mobile cases share a capture task. Their action evidence is selected by
  // case AND latest flow-run identity in appendMobileTestEvidence, not task alone.
  const tasks=new Set(test.task_ids),artifacts=testId.startsWith('mobile:')?[]:snapshot.artifacts.filter(a=>a.task_id&&tasks.has(a.task_id));
  const items:AssessmentEvidence['items']=[];
  for(const artifact of artifacts){
    const value=artifact.content_json||{},endpoint=snapshot.endpoints.find(e=>e.id===artifact.source_ref);
    if(artifact.artifact_type==='generic_mutation_attempt'){
      const normal=value.normal||{},mutated=value.mutated||{};
      const proof:string[]=[];
      if(value.browser_execution_verified===true)proof.push('在实际目标浏览器中观察到本次测试的唯一脚本执行标记。');
      if(value.authorization_boundary_verified===true)proof.push('不同真实身份、对象归属和拥有者会话对照已核对。');
      items.push({id:artifact.id,title:`参数检查：${text(value.target||'',120)}`,method:endpoint?.method||'',url:safeUrl(endpoint?.url||endpoint?.path||''),
        baseline:{status:normal.status,body:text(normal.body_preview),hash:normal.body_hash},result:{status:mutated.status,body:text(mutated.body_preview),hash:mutated.body_hash},
        proof,notes:[normal.error,mutated.error,...(value.comparison?.reasons||[])].filter(Boolean).map(v=>text(v,1000))});
    }else if(['upload_attempt','upload_attempt_error'].includes(artifact.artifact_type)){
      const proof:string[]=[];
      if(value.uploaded_bytes_verified===true)proof.push('上传文件与回访内容的摘要一致。');
      if(value.impact_verified===true)proof.push(value.impact_proof?.kind==='server_side_marker_execution'?'服务端返回了本次上传文件的唯一执行标记。':'在实际目标浏览器中观察到上传文件的唯一脚本执行标记。');
      items.push({id:artifact.id,title:value.label==='normal'?'正常文件对照':value.label==='normal_control'?'拒绝变体后的正常对照':`上传检查：${text(value.filename,200)}`,
        method:endpoint?.method||'POST',url:safeUrl(endpoint?.url||endpoint?.path||''),result:{status:value.status,body:text(value.response_body_preview),hash:value.response_body_sha256},
        followup:value.location?{url:safeUrl(value.location),status:value.fetch_status,body:text(value.fetched_body_preview),hash:value.fetched_body_sha256}:undefined,
        proof,notes:value.error?[text(value.error,1000)]:[]});
    }
  }
  const decisions=artifacts.filter(a=>a.artifact_type==='ai_judgement').map(a=>({id:a.id,verdict:String(a.content_json.verdict||'inconclusive'),reason:text(a.content_json.reason,2500)}));
  for(const a of artifacts.filter(a=>a.artifact_type==='generic_payload_coverage'))decisions.push({id:a.id,verdict:'inconclusive',reason:text(a.content_json.reason,2500)});
  return {test:{id:test.id,name:test.name,status:test.status,status_label:test.status_label,summary:test.summary},decisions,items,
    notice:'以下为本次测试实际保存的对照与验证记录。响应差异、成功状态或文件被接受本身不等于确认漏洞；已知凭据字段已脱敏。'};
}
