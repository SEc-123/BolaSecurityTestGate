import { randomUUID } from 'node:crypto';
export const now = Date.parse('2026-09-18T01:00:00.000Z');
export const time = new Date(now).toISOString();
export const snapshot = (n = 1) => ({
  run: { id:'run-a',name:'授权业务测试',base_url:'https://user:secret@example.test/login?token=secret#password',status:'running',scan_config:{surface:'web',accounts:{password:'secret'},learning:{enabled:true}},selected_vuln_types:[],created_at:time,updated_at:time },
  tasks: Array.from({length:n},(_,i)=>({id:`task-${i}`,scan_run_id:'run-a',task_type:'test_vulnerability',vuln_type:'bola_idor',feature_id:`feature-${i}`,endpoint_ids:[`endpoint-${i}`],status:'pending',execution_plan:{candidate_id:`candidate-${i}`,mutation:'internal'},created_at:time,updated_at:time})),
  candidates: Array.from({length:n},(_,i)=>({id:`candidate-${i}`,feature_id:`feature-${i}`,vuln_type:'bola_idor',endpoint_ids:[`endpoint-${i}`],status:'selected',title:'登录',created_at:time})),
  features: Array.from({length:n},(_,i)=>({id:`feature-${i}`,name:i===0?'login':`业务功能 ${i}`,endpoint_ids:[`endpoint-${i}`],created_at:time})),
  endpoints:[],artifacts:[],agent_memories:[{content:'secret learning'}],tool_invocations:[{tool_name:'mutation',result:'secret'}],shared_resources:[],planner_decisions:[],browser_contexts:[],
});
export function judge(index=0, verdict='not_vulnerable', extra={}) {
  return {id:randomUUID(),task_id:`task-${index}`,scan_run_id:'run-a',source_ref:`endpoint-${index}`,artifact_type:'ai_judgement',title:'跨账号访问问题',created_at:time,updated_at:time,
    content_json:{verdict,severity:'high',native_evidence_gate:{baseline_verified:true,mutation_executed:true,template_executed:true,native_api_mode_executed:true,native_test_run_ids:[`result-${index}`],missing_evidence:[],preconditions_satisfied:true,verdict:verdict==='vulnerable'?'confirmed':'inconclusive'},...extra}};
}
export function frame(index=0, options={}) {return {id:`frame-${index}`,task_id:`task-${index}`,artifact_type:'assessment_live_frame',content_text:'available',created_at:time,content_json:{surface:'web',observing:true,observed_at:time,...options}};}
export const testsOf = state => state.business_functions.flatMap(f=>f.tests);
