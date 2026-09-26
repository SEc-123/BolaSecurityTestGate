import type { MobileLabProfile } from './mobile-types.js';
import type { ImportedMobileApp } from './mobile-app-service.js';
import { validateFlowSteps } from './mobile-target-contract.js';
import { validateNetworkExpectations } from './mobile-network-assertions.js';
import { businessName, businessText } from '../ai-scan/product-state-service.js';

type Scenario = { id: string; business_name: string; test_name: string; app_package: string; description?: string;
  depends_on?: string[]; steps: Array<Record<string, any>> };
function scenarios(profile: MobileLabProfile): Scenario[] {
  const values = profile.config_json?.business_scenarios;
  return Array.isArray(values) ? values.filter((s: any) => s && typeof s.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(s.id)) : [];
}
export function publicMobileProfile(profile: MobileLabProfile) {
  return { id: profile.id, name: businessText(profile.name, 'Android 测试设备'),
    device_label: businessText(profile.device_name, '授权测试设备'), enabled: profile.is_enabled,
    simulated: profile.config_json?.offline_simulator === true,
    scenarios: scenarios(profile).map(s => ({ id: s.id, business_name: businessName(s.business_name), test_name: businessText(s.test_name, '业务检查'),
      // Package names are binding identifiers, not prose. Applying the product
      // language filter can erase legitimate names such as com.bstg.acceptance.
      app_package: typeof s.app_package==='string'&&/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(s.app_package)?s.app_package:'',
      description: businessText(s.description, ''), depends_on: Array.isArray(s.depends_on) ? s.depends_on : [] })) };
}
/** Operator-authored, application-bound action recipes remain server-side. Users select business checks. */
export function resolveMobileBusinessSelection(input: {
  profile: MobileLabProfile; app: ImportedMobileApp; scenarioIds?: unknown; authorized: boolean; baseUrl: string;
}): Record<string, any> {
  const { profile, app } = input;
  if (!input.authorized) throw new Error('请确认目标应用、设备与业务操作已获测试授权。');
  if (!profile.is_enabled || profile.config_json?.offline_simulator || profile.config_json?.strict_real_e2e === false) throw new Error('请选择已配置的真实 Android 测试环境。');
  if (!app.signature_verified || !app.package_name || !app.launch_activity || !app.signer_sha256) throw new Error('应用签名或启动信息尚未验证，请联系环境管理员后重新上传。');
  if (!profile.adb_serial || !(profile.appium_server_url || profile.config_json?.appium_server_url)) throw new Error('测试设备尚未准备好，请联系环境管理员。');
  const target = new URL(input.baseUrl);
  const allowed: string[] = profile.config_json?.capture_allowed_hosts || [];
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password || (allowed.length && !allowed.includes(target.hostname))) throw new Error('请选择当前设备环境授权范围内的 业务服务地址。');
  const common = {platform:'android',lab_profile_id:profile.id,device_id:profile.adb_serial,
    app_package:app.package_name,app_activity:app.launch_activity,apk_path:app.apk_path,
    apk_source:app.apk_source,apk_sha256:app.sha256,apk_signer_sha256:app.signer_sha256,
    app_asset_id:app.id,app_label:app.app_label || app.original_filename,
    authorized_base_url:target.origin,authorization_acknowledged:true};
  if (input.scenarioIds === undefined || Array.isArray(input.scenarioIds) && !input.scenarioIds.length) {
    return {...common, acquisition_mode:'explore', max_exploration_steps:30, evidence_mode:'device_discovery', flow_steps:[]};
  }
  if (!Array.isArray(input.scenarioIds) || input.scenarioIds.length > 100 || !input.scenarioIds.every(id => typeof id === 'string')) throw new Error('业务测试选择无效。');
  if(target.protocol!=='https:')throw new Error('声明 HTTPS 断言的回归场景必须使用 HTTPS 服务地址。');
  const values = scenarios(profile), map = new Map(values.map(s => [s.id, s]));
  if (map.size !== values.length) throw new Error('测试环境存在重复场景标识，请联系环境管理员。');
  const selected: Scenario[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('业务测试前置关系存在循环，请联系环境管理员。');
    if (visited.has(id)) return;
    const scenario = map.get(id);
    if (!scenario || scenario.app_package !== app.package_name) throw new Error('所选业务测试与此应用不匹配，请重新选择。');
    visiting.add(id);
    for (const dep of scenario.depends_on || []) visit(dep);
    visiting.delete(id); visited.add(id); selected.push(scenario);
  };
  for (const id of input.scenarioIds) visit(id);
  const flowSteps: Array<Record<string, any>> = [];
  for (const scenario of selected) {
    const errors = validateFlowSteps(scenario.steps, true);
    if (!scenario.steps?.some(step => String(step.action || step.type).toLowerCase() !== 'wait' && step.expect_network?.length)) errors.push('missing network check');
    for (const step of scenario.steps || []) if (step.expect_network) errors.push(...validateNetworkExpectations(step.expect_network, allowed.length?allowed:[target.hostname]));
    if (errors.length) throw new Error('业务测试缺少有效的页面或加密通信检查，请联系环境管理员补齐场景。');
    for (const step of scenario.steps) flowSteps.push({ ...step, business_test_id: scenario.id,
      business_name: businessName(scenario.business_name), test_name: businessText(scenario.test_name, '业务检查') });
  }
  if (flowSteps.length > 200) throw new Error('所选业务测试超过本轮操作上限，请减少测试范围。');
  return {...common, acquisition_mode:'scenario',flow_steps:flowSteps,
    scenario_ids:selected.map(s=>s.id),evidence_mode:'strict_device'};
}
