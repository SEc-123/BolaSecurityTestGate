import { discoveryCaptureRejection } from './discovery-capture-policy.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DbProvider } from '../../types/index.js';
import type { AIScanRepository } from '../ai-scan/repository.js';
import type { MobileObservation, MobileUiNode, NormalizedHttpFlow } from './mobile-types.js';
import { runDiscoveryAction } from './mobile-lab-service.js';
import { getMobileSession, updateMobileSession, listMobileActions } from './mobile-session-service.js';
import { getMobileProfile } from './mobile-profile-service.js';
import { profileForSession, withMobileTestRun } from './mobile-runtime-state.js';
import { verifyEvidenceFile } from './mobile-test-evidence.js';

function selector(node: MobileUiNode): Record<string, any> | null {
  if (node.resourceId) return {resourceId:node.resourceId};
  if (node.contentDesc) return {contentDesc:node.contentDesc};
  if (node.text) return {text:node.text};
  return node.bounds ? {x:Math.floor((node.bounds[0]+node.bounds[2])/2), y:Math.floor((node.bounds[1]+node.bounds[3])/2)} : null;
}
const label = (node: MobileUiNode) => `${node.text || ''} ${node.contentDesc || ''} ${node.resourceId || ''}`;
const destructive = /delete|remove account|purchase|pay now|transfer|withdraw|factory reset|注销|删除|付款|支付|转账|提现|重置设备/i;
function pageKey(observation: MobileObservation): string {
  return createHash('sha256').update(JSON.stringify([observation.activity, observation.ui_tree.map(n=>[n.resourceId,(n.clickable||n.input)?n.text:undefined,n.contentDesc,n.clickable,n.input])])).digest('hex');
}

/** Generic acquisition: executes real controls; it makes no claim about business correctness.
 * Only step-bound, identity-verified wire records are promoted into the security engine. */
export async function exploreMobileApp(db: DbProvider, sessionId: string, repo: AIScanRepository, taskId: string,
  options: {max_steps?: number; account?: {username?: string; password?: string}} = {}): Promise<Record<string, any>> {
  return withMobileTestRun(sessionId, async () => {
    const session = await getMobileSession(db, sessionId);
    if (!session || session.health_json?.execution_profile?.config_json?.acquisition_mode !== 'explore') throw new Error('当前会话未配置自动探索。');
    if (session.health_json?.capture_import?.result) throw new Error('已导入的会话不可重新探索。请新建测试。');
    const profile = profileForSession(session.health_json.execution_profile, session);
    const id = randomUUID(), started_at = new Date().toISOString();
    const visited = new Set<string>(), filled = new Set<string>(), pages = new Set<string>();
    const history:string[]=[];
    const results: Record<string, any>[] = [], gaps: string[] = [], matchedFlows = new Set<string>();
    const limit = Math.max(1, Math.min(100, Math.floor(Number(options.max_steps) || 30)));
    const deadline = Date.now()+180000;
    const persist = async (status: string, error?: string) => updateMobileSession(db, sessionId, {health_json:{discovery_run:{
      id, status, ok:status==='completed', driver:'appium_uiautomator2', started_at,
      completed_at:status==='running' ? undefined : new Date().toISOString(),
      scope:'ui_exploration_and_session_bound_traffic', business_assertions_verified:false,
      pages_observed:pages.size, steps_executed:results.length, results,
      matched_flow_ids:[...matchedFlows], gaps:[...new Set(gaps)], error,
    }}});
    await persist('running');
    try {
      let observation:MobileObservation|undefined;
      for (let index=0; index<limit && Date.now()<deadline; index++) {
        const key = observation ? pageKey(observation) : '__launch__'; if(observation)pages.add(key);
        let action: Record<string, any> | undefined;
        if (index===0) action={action:'launch'};
        const inputs = (observation?.ui_tree||[]).filter(n=>n.enabled!==false && n.input);
        if (!action && inputs.some(n=>n.password)) {
          if (options.account?.username && options.account.password) {
            const node = inputs.find(n=>!filled.has(`${observation?.activity}:${n.resourceId || n.index}`) && (n.password || /user|email|phone|account|用户|邮箱|手机|账号/i.test(label(n))));
            if (node && selector(node)) {
              filled.add(`${observation?.activity}:${node.resourceId || node.index}`);
              action={action:'fill',target:selector(node),value:node.password?options.account.password:options.account.username};
            }
          } else {gaps.push('登录页面缺少测试账号；登录后页面的覆盖需要提供账号后重新测试。');if(!history.length||visited.has(`${key}:back`))break;visited.add(`${key}:back`);action={action:'back'};}
        }
        if (!action) {
          for (const node of (observation?.ui_tree||[]).filter(n=>n.clickable && n.enabled!==false && !n.input)) {
            const text = label(node), nodeKey = `${key}:${node.resourceId || node.contentDesc || node.text || node.index}`;
            if (destructive.test(text)) { gaps.push('自动探索跳过支付、删除和转账等操作；可配置业务场景明确验证。'); continue; }
            if (/captcha|verification code|验证码|人机验证/i.test(text)) { gaps.push('验证码或人工验证步骤需要提供可执行的测试场景。'); continue; }
            const target = selector(node);
            if (!target || visited.has(nodeKey)) continue;
            visited.add(nodeKey); action={action:'tap',target}; break;
          }
        }
        if (!action) {
          if (!history.length || visited.has(`${key}:back`)) break;
          visited.add(`${key}:back`); action={action:'back'};
        }
        const output = await runDiscoveryAction(db,sessionId,{...action,expect:{package:session.app_package,min_ui_nodes:1},timeout_ms:3000},id,repo,taskId);
        const result = output.result;
        results.push({action_id:output.action.id,step_id:result.step_id,ok:output.ok,error:result.error,evidence:result.evidence});
        const bytes = await verifyEvidenceFile(result.evidence?.files?.['network.json']);
        const flows = JSON.parse(bytes.toString()) as NormalizedHttpFlow[];
        for (const flow of flows) if (output.ok && flow.flow_id && flow.test_run_id===id && flow.step_id===result.step_id && !discoveryCaptureRejection(flow,session,profile)) matchedFlows.add(flow.flow_id);
        await persist('running');
        if (!output.ok) { gaps.push('部分页面操作未成功；已保留失败证据。'); break; }
        observation=output.observation;
        if(observation){const next=pageKey(observation);pages.add(next);if(action.action==='tap'&&next!==key)history.push(key);else if(action.action==='back')history.pop();}
      }
      if (results.length>=limit || Date.now()>=deadline) gaps.push('已达到本轮探索上限；报告仅覆盖已访问的页面和已捕获的接口。');
      if (!matchedFlows.size) throw new Error('未获取授权范围内的业务流量。请检查业务地址、登录状态、代理配置、HTTPS 证书或应用证书锁定；界面点击不算安全测试完成。');
      await persist('completed');
      return (await getMobileSession(db,sessionId))!.health_json.discovery_run;
    } catch (error) {
      await persist('failed',error instanceof Error ? error.message : String(error));
      throw error;
    }
  });
}

export async function mobileDiscoveryReport(db:DbProvider,sessionId:string):Promise<Record<string,any>> {
  const session=await getMobileSession(db,sessionId);
  if(!session)throw new Error('Mobile session not found.');
  const run=session.health_json.discovery_run;
  const profile=profileForSession(session.health_json.execution_profile || await getMobileProfile(db,session.profile_id),session);
  const actions=(await listMobileActions(db,sessionId)).filter(a=>a.result_json.test_run_id===run?.id);
  const errors:string[]=[], verified=new Set<string>();
  for(const action of actions){
    if(action.status!=='completed')continue;
    try {
      const files=action.result_json.evidence?.files;
      for(const name of ['screen.png','ui.json','network.json','appium.json']) await verifyEvidenceFile(files?.[name]);
      const ui=JSON.parse((await verifyEvidenceFile(files['ui.json'])).toString());
      if(ui.package!==session.app_package || ui.device_id!==session.device_id || ui.health?.source!=='appium_uiautomator2') throw new Error('Device evidence identity mismatch.');
      const flows:NormalizedHttpFlow[]=JSON.parse((await verifyEvidenceFile(files['network.json'])).toString());
      for(const flow of flows) if(action.status==='completed' && flow.flow_id && flow.test_run_id===run.id && flow.step_id===action.result_json.step_id && !discoveryCaptureRejection(flow,session,profile)) verified.add(flow.flow_id);
    }catch {errors.push(`页面证据缺失或不一致：${action.id}`);}
  }
  const ok=run?.ok===true && actions.length===run.steps_executed && !!verified.size && run.matched_flow_ids.every((id:string)=>verified.has(id)) && !errors.length;
  return {scope:'ui_exploration_and_session_bound_traffic', acquisition_complete:ok && session.health_json.cleanup?.ok===true && !!session.health_json.capture_import?.result,
    acceptance_complete:false, business_assertions_verified:false, pages_observed:run?.pages_observed||0, verified_flows:verified.size,
    gaps:run?.gaps||[], integrity_errors:errors, error:run?.error,
    notice:'自动探索已观察的页面和接口会进入安全测试；未声明的业务规则不视为已通过。'};
}
