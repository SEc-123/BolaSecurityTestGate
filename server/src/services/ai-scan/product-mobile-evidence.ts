import type { DbProvider } from '../../types/index.js';
import type { AIScanSnapshot } from './types.js';
import type { AssessmentEvidence } from './product-state-types.js';
import { evidenceText, safeEvidenceUrl } from './product-evidence.js';
import { listMobileActions, listMobileSessions } from '../mobile/mobile-session-service.js';
import { verifyEvidenceFile } from '../mobile/mobile-test-evidence.js';
import { tlsCompletenessFailure } from '../mobile/mobile-network-assertions.js';
import type { NormalizedHttpFlow } from '../mobile/mobile-types.js';

export async function appendMobileTestEvidence(db:DbProvider,snapshot:AIScanSnapshot,evidence:AssessmentEvidence):Promise<void> {
  if(!evidence.test.id.startsWith('mobile:'))return;
  evidence.steps=[];
  const key=evidence.test.id.slice(7);
  const progress=snapshot.artifacts.filter(a=>a.artifact_type==='business_test_progress'&&a.content_json?.test_key===key)
    .sort((a,b)=>String(b.updated_at||b.created_at).localeCompare(String(a.updated_at||a.created_at)))[0];
  const runId=progress?.content_json?.run_id;
  if(!runId)return;
  const sessions=(await listMobileSessions(db,snapshot.run.id)).filter(s=>s.health_json?.flow_run?.id===runId);
  for(const session of sessions){
    const actions=(await listMobileActions(db,session.id)).filter(a=>a.scan_run_id===snapshot.run.id&&a.task_id===progress.task_id&&a.input_json.business_test_id===key&&a.result_json.test_run_id===runId);
    for(const action of actions){
      const result=action.result_json,files=result.evidence?.files||{},notes:string[]=[];
      let integrity=true,flows:NormalizedHttpFlow[]=[];
      for(const name of ['screen.png','ui.json','network.json','appium.json']){
        try{
          if(!files[name])throw Error('missing');
          const bytes=await verifyEvidenceFile(files[name]);
          if(name==='ui.json'){
            const ui=JSON.parse(bytes.toString('utf8'));
            if(ui.session_id!==session.id||ui.device_id!==session.device_id||ui.package!==session.app_package||ui.health?.source!=='appium_uiautomator2'||ui.health?.appium?.session_id!==result.appium?.session_id)throw Error('identity');
          }
          if(name==='network.json'){
            const value=JSON.parse(bytes.toString('utf8'));
            if(!Array.isArray(value)||value.some(f=>f.test_run_id!==runId||f.step_id!==result.step_id||f.capture_session_id!==session.health_json?.capture?.id||f.device_id!==session.device_id||f.app_package!==session.app_package))throw Error('identity');
            flows=value;
          }
        }catch{integrity=false;notes.push(`${name} 缺失、摘要不符或不属于本步骤。`);}
      }
      const matched=new Set(result.network?.matched_flow_ids||[]);
      const networkVerified=integrity&&result.network?.ok===true&&matched.size>0&&[...matched].every(id=>flows.some(f=>f.flow_id===id&&!tlsCompletenessFailure(f)));
      const uiVerified=integrity&&result.ok===true&&!result.assertion_error&&result.source==='appium_uiautomator2'&&!!result.appium?.session_id&&result.appium.device_id===session.device_id;
      const title=String(action.input_json.test_name||action.input_json.name||`步骤 ${action.sequence}`);
      evidence.steps.push({id:action.id,title:evidenceText(title,200),status:action.status,started_at:result.started_at,completed_at:result.completed_at,
        integrity_verified:integrity,ui_verified:uiVerified,network_verified:networkVerified,
        checks:(result.network?.assertions||[]).map((a:any)=>({name:evidenceText(a.id,120),passed:networkVerified&&a.ok===true})),
        notes:[...notes,...[result.error,result.assertion_error].filter(Boolean).map(v=>evidenceText(v,1000))],
        hashes:Object.entries(files).map(([name,file]:[string,any])=>({name,sha256:String(file.sha256||'')}))});
      // Never display contents of a file whose digest or ownership failed.
      if(integrity)for(const flow of flows){
        evidence.items.push({id:`${action.id}:${flow.flow_id}`,title:evidenceText(title,200),method:flow.method,url:safeEvidenceUrl(flow.url),
          result:{status:flow.response_status,body:evidenceText(flow.response_body_text)},
          proof:networkVerified&&matched.has(flow.flow_id)?['已核对本步骤的 HTTPS 请求与响应断言，双向 TLS 和上游证书校验有效。']:[],
          notes:['页面操作完成仅表示此操作与声明断言的结果，不能替代安全检查结论。']});
      }
    }
  }
}
