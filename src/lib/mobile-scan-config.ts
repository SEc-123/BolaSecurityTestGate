import type { MobileAppImportResult } from '../types';

export interface MobileProfileOption {
  id: string; name: string; is_enabled: boolean; adb_serial?: string;
  certificate_mode: string; appium_server_url?: string; proxy_host?: string; proxy_port?: number;
  config_json: Record<string, any>;
}

/** UI preflight only. The backend independently enforces the device contract. */
export function buildMobileScanConfig(input: {
  profile?: MobileProfileOption; app: MobileAppImportResult | null;
  flowJson: string; authorized: boolean; deviceId?: string;
}): Record<string, any> {
  const { profile, app } = input;
  if (!input.authorized) throw new Error('请确认 APK、设备和 API 域名均在你的授权测试范围内。');
  if (!profile?.is_enabled) throw new Error('请选择已启用的 Android 测试环境。');
  const simulated = profile.config_json?.offline_simulator === true || profile.id === 'offline-simulator-v0.2.0';
  const strict = !simulated && profile.config_json?.strict_real_e2e !== false;
  if (!app?.apk_path) throw new Error('请先上传授权测试 APK。');
  if (strict && (!app.signature_verified || !app.signer_sha256 || !app.package_name || !app.launch_activity)) throw new Error('APK 签名、包名或启动入口尚未验证。请配置服务端 aapt/apksigner 后重新上传，不能把上传成功当作可测试。');
  const deviceId = input.deviceId?.trim() || profile.adb_serial?.trim();
  if (strict && !(profile.appium_server_url || profile.config_json?.appium_server_url)) throw new Error('严格移动测试必须配置 Appium Server URL；ADB 抓包或点击不构成 Appium 验收。');
  if (strict && !deviceId) throw new Error('环境缺少 ADB serial，请配置明确的目标设备。');
  if (strict && !profile.config_json?.capture_allowed_hosts?.length) throw new Error('环境缺少授权 API 域名 capture_allowed_hosts，请先配置抓包范围。');
  let steps: Array<Record<string, any>>;
  try { steps = JSON.parse(input.flowJson); } catch { throw new Error('操作流程必须是有效 JSON 数组。'); }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 200) throw new Error('操作流程需要 1–200 个步骤，不能留空。');
  if (strict && !steps.some(step => step && (step.action || step.type) !== 'wait')) throw new Error('仅等待不构成业务流程，请配置真实操作及 expect 断言。');
  if (strict && !steps.some(step => (step?.action || step?.type) !== 'wait' && Array.isArray(step?.expect_network) && step.expect_network.length)) throw new Error('至少一个业务操作需要 expect_network：实际 HTTPS 地址、方法及响应断言；只有 UI 或只有抓包不能通过。');
  for (const [index, step] of steps.entries()) {
    const action = step?.action || step?.type;
    if (!['tap','click','input','type','fill','swipe','back','wait'].includes(action)) throw new Error(`第 ${index + 1} 步的 action 不受支持。`);
    if (step.expect_network !== undefined) {
      if (!Array.isArray(step.expect_network) || !step.expect_network.length) throw new Error(`第 ${index + 1} 步 expect_network 必须是非空数组。`);
      for (const expected of step.expect_network) {
        let url: URL; try { url = new URL(expected.url); } catch { throw new Error('HTTPS 断言需要完整、有效的 URL。'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('业务接口必须使用 HTTPS，不允许 HTTP 降级或 URL 凭据。');
        if (!expected.id || !expected.method || !expected.response?.status) throw new Error('HTTPS 断言必须包含 id、method、response.status。');
      }
    }
    if (strict && action !== 'wait' && (!step.expect || typeof step.expect !== 'object' || !['package','activity','min_ui_nodes','resourceId','resource_id','text','contentDesc','content_desc'].some(key => step.expect[key] !== undefined))) throw new Error(`第 ${index + 1} 步需要可观察的 expect 断言。`);
  }
  return {
    platform: 'android', lab_profile_id: profile.id, device_id: deviceId,
    app_package: app.package_name || '', app_activity: app.launch_activity || '',
    apk_path: app.apk_path, apk_source: app.apk_source, apk_sha256: app.sha256,
    apk_signer_sha256: app.signer_sha256, app_asset_id: app.id,
    app_label: app.app_label || app.original_filename, flow_steps: steps,
    evidence_mode: simulated ? 'simulated' : strict ? 'strict_device' : 'non_strict',
    authorization_acknowledged: true,
  };
}
