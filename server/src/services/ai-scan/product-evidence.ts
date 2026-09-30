import { buildProductAssessmentState } from './product-state-service.js';
import { publicTechnicalUrl } from './public-technical-snapshot.js';
import type { AIScanSnapshot } from './types.js';
import type { AssessmentEvidence } from './product-state-types.js';

export const evidenceText = (value: unknown, _limit = 8000) => {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return raw ? `Private response material retained (${Buffer.byteLength(raw)} bytes).` : 'No response body captured.';
};
function evidenceBody(value: unknown) {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
  return { body: evidenceText(value), body_present: Boolean(raw), body_bytes: Buffer.byteLength(raw) };
}
function privateDiagnostic(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : 'Private execution diagnostic retained.';
}
export function safeEvidenceUrl(value: string): string {
  return publicTechnicalUrl(value);
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
      items.push({id:artifact.id,title:'参数检查',method:endpoint?.method||'',url:safeUrl(endpoint?.url||endpoint?.path||''),
        baseline:{status:normal.status,...evidenceBody(normal.body_preview),hash:normal.body_hash},result:{status:mutated.status,...evidenceBody(mutated.body_preview),hash:mutated.body_hash},
        proof,notes:[normal.error,mutated.error,...(value.comparison?.reasons||[])].filter(Boolean).map(privateDiagnostic).filter((note):note is string=>Boolean(note))});
    }else if(['upload_attempt','upload_attempt_error'].includes(artifact.artifact_type)){
      const proof:string[]=[];
      if(value.uploaded_bytes_verified===true)proof.push('上传文件与回访内容的摘要一致。');
      if(value.impact_verified===true)proof.push(value.impact_proof?.kind==='server_side_marker_execution'?'服务端返回了本次上传文件的唯一执行标记。':'在实际目标浏览器中观察到上传文件的唯一脚本执行标记。');
      items.push({id:artifact.id,title:value.label==='normal'?'正常文件对照':value.label==='normal_control'?'拒绝变体后的正常对照':'上传检查',
        method:endpoint?.method||'POST',url:safeUrl(endpoint?.url||endpoint?.path||''),result:{status:value.status,...evidenceBody(value.response_body_preview),hash:value.response_body_sha256},
        followup:value.location?{url:safeUrl(value.location),status:value.fetch_status,...evidenceBody(value.fetched_body_preview),hash:value.fetched_body_sha256}:undefined,
        proof,notes:privateDiagnostic(value.error)?['Private execution diagnostic retained.']:[]});
    }
  }
  const decisions=artifacts.filter(a=>a.artifact_type==='ai_judgement').map(a=>({id:a.id,verdict:String(a.content_json.verdict||'inconclusive'),reason:'Assessment rationale is retained in protected evidence.'}));
  for(const a of artifacts.filter(a=>a.artifact_type==='generic_payload_coverage'))decisions.push({id:a.id,verdict:'inconclusive',reason:'Assessment rationale is retained in protected evidence.'});
  return {test:{id:test.id,name:test.name,status:test.status,status_label:test.status_label,summary:test.summary},decisions,items,
    notice:'以下为本次测试实际保存的对照状态、摘要和证据引用。响应正文与私有诊断保留在受保护的执行存储中；响应差异、成功状态或文件被接受本身不等于确认漏洞。'};
}
