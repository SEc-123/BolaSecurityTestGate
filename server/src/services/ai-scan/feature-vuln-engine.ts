import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint, AIFeatureNode } from './types.js';

export const VULN_TYPES = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
] as const;

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(value));
}

function endpointText(endpoint: AIDiscoveredEndpoint): string {
  return [endpoint.method, endpoint.path, endpoint.url, endpoint.content_type, endpoint.feature_guess, endpoint.request_summary, endpoint.response_summary]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function featureNameForEndpoint(endpoint: AIDiscoveredEndpoint): string {
  const text = endpointText(endpoint);
  if (includesAny(text, [/avatar/, /profile/, /account/, /user/, /用户/, /头像/])) return '用户中心';
  if (includesAny(text, [/upload/, /file/, /image/, /media/, /attachment/, /excel/, /import/, /上传/, /附件/, /图片/, /导入/])) return '文件处理';
  if (includesAny(text, [/cart/, /order/, /checkout/, /pay/, /coupon/, /refund/, /购物车/, /订单/, /支付/, /优惠/, /退款/])) return '交易订单';
  if (includesAny(text, [/login/, /signin/, /register/, /password/, /captcha/, /otp/, /sms/, /email/, /mail/, /passcode/, /paypwd/, /mfa/, /2fa/, /登录/, /注册/, /验证码/, /短信/, /邮箱/, /支付密码/])) return '认证账号';
  if (includesAny(text, [/admin/, /manage/, /dashboard/, /后台/, /管理/])) return '后台管理';
  if (includesAny(text, [/post/, /comment/, /article/, /community/, /forum/, /评论/, /帖子/, /社区/])) return '内容社区';
  return '通用功能';
}

function subFeatureNameForEndpoint(endpoint: AIDiscoveredEndpoint): string {
  const text = endpointText(endpoint);
  if (includesAny(text, [/avatar/, /头像/])) return '头像上传';
  if (includesAny(text, [/excel/, /import/, /导入/])) return '文件导入';
  if (includesAny(text, [/upload/, /attachment/, /media/, /image/, /file/, /上传/, /附件/, /图片/])) return '文件上传';
  if (includesAny(text, [/download/, /export/, /下载/, /导出/])) return '文件下载';
  if (includesAny(text, [/login/, /signin/, /登录/])) return '登录';
  if (includesAny(text, [/register/, /signup/, /注册/])) return '注册';
  if (includesAny(text, [/passcode/, /paypwd/, /payment.*password/, /支付密码/])) return '交易/支付密码';
  if (includesAny(text, [/sms/, /email/, /mail/, /otp/, /captcha/, /code/, /验证码/, /短信/, /邮箱/])) return '验证码/二次认证';
  if (includesAny(text, [/password/, /reset/, /forgot/, /密码/])) return '密码重置';
  if (includesAny(text, [/cart/, /购物车/])) return '购物车';
  if (includesAny(text, [/order/, /订单/])) return '订单';
  if (includesAny(text, [/pay/, /payment/, /支付/])) return '支付';
  if (includesAny(text, [/refund/, /退款/])) return '退款';
  if (includesAny(text, [/admin/, /manage/, /后台/, /管理/])) return '管理操作';
  if (includesAny(text, [/comment/, /评论/])) return '评论';
  if (includesAny(text, [/post/, /article/, /帖子/, /文章/])) return '内容发布';
  return endpoint.method.toUpperCase() === 'GET' ? '页面浏览' : '表单/接口操作';
}


function isActionableEndpoint(endpoint: AIDiscoveredEndpoint): boolean {
  const path = endpoint.path || '/';
  const text = endpointText(endpoint);
  if (endpoint.source_type === 'browser_form' || endpoint.source_type === 'browser_js_reference') return true;
  if (/^\/api(\/|$)/i.test(path) || /^\/admin(\/|$)/i.test(path)) return true;
  if (/[?&](id|uid|file|path|filename|q|query|search|cmd|host|role|amount|price|quantity|coupon|status)=/i.test(endpoint.url || '')) return true;
  if (includesAny(text, [/download/, /export/, /upload/, /search/, /ping/, /order/, /cart/, /pay/, /coupon/, /refund/])) return true;
  return false;
}

function endpointVulnTypes(endpoint: AIDiscoveredEndpoint): { type: string; reason: string; confidence: number }[] {
  if (!isActionableEndpoint(endpoint)) return [];
  const text = endpointText(endpoint);
  const vulns: { type: string; reason: string; confidence: number }[] = [];
  const hasObjectId = includesAny(text, [/(^|[^a-z])(id|uid|user_id|order_id|file_id|post_id|media_id|account_id)([^a-z]|$)/, /\/[0-9a-f]{6,}/]);
  const hasUpload = endpoint.content_type === 'multipart/form-data' || (endpoint.method.toUpperCase() !== 'GET' && includesAny(text, [/upload/, /avatar/, /attachment/, /media/, /image/, /file/, /excel/, /import/, /上传/, /附件/, /头像/, /导入/]));
  const hasDownload = includesAny(text, [/download/, /export/, /file/, /path/, /filename/, /下载/, /导出/]);
  const hasForm = includesAny(text, [/form/, /query/, /search/, /comment/, /post/, /content/, /message/, /title/, /body/, /评论/, /搜索/, /内容/]);
  const hasCommand = includesAny(text, [/cmd/, /command/, /exec/, /shell/, /ping/, /host/, /domain/, /命令/]);
  const hasAuth = includesAny(text, [/login/, /register/, /password/, /captcha/, /otp/, /verify/, /code/, /sms/, /email/, /mail/, /passcode/, /paypwd/, /mfa/, /2fa/, /登录/, /注册/, /验证码/, /短信/, /邮箱/, /支付密码/]);
  const hasEmailSmsOtp = includesAny(text, [/sms|send.*code|email.*code|mail.*code|otp|captcha|verify.*code|codebeforelogin|二次认证|验证码|短信|邮箱/]);
  const hasPasscode = includesAny(text, [/passcode|paypwd|pay_password|payment.*password|trade.*password|fund.*password|pin|支付密码|交易密码/]);
  const hasBusiness = includesAny(text, [/cart/, /order/, /pay/, /coupon/, /refund/, /stock/, /checkout/, /购物车/, /订单/, /支付/, /优惠/, /退款/]);
  const hasAdmin = includesAny(text, [/admin/, /manage/, /role/, /permission/, /后台/, /管理/, /权限/]);

  if (hasUpload) vulns.push({ type: 'file_upload', reason: '发现 multipart/form-data、文件字段或上传/导入语义。', confidence: endpoint.content_type === 'multipart/form-data' ? 0.95 : 0.75 });
  if (hasDownload) vulns.push({ type: 'file_download', reason: '发现下载/导出/文件读取语义。', confidence: 0.68 });
  if (hasDownload || includesAny(text, [/path/, /filename/, /dir/, /目录/, /路径/])) vulns.push({ type: 'path_traversal', reason: '接口包含文件路径、文件名或下载导出语义。', confidence: 0.62 });
  if (hasObjectId || hasBusiness || hasUpload) vulns.push({ type: 'bola_idor', reason: '接口可能操作用户或业务对象 ID。', confidence: hasObjectId ? 0.78 : 0.58 });
  if (hasAdmin) vulns.push({ type: 'bfla', reason: '发现后台管理/角色/权限语义。', confidence: 0.72 });
  if (hasBusiness || hasAuth) vulns.push({ type: 'business_logic', reason: '业务状态、交易、认证或绑定流程可能存在逻辑绕过。', confidence: 0.7 });
  if (hasForm) vulns.push({ type: 'xss', reason: '发现表单、搜索、评论或内容输入点。', confidence: 0.65 });
  if (hasCommand) vulns.push({ type: 'command_injection', reason: '发现命令/执行/主机探测语义。', confidence: 0.7 });
  if (hasAuth) vulns.push({ type: 'auth_otp', reason: '发现登录、注册、验证码、邮箱/短信验证、支付密码或二次认证流程。', confidence: 0.7 });
  if (hasEmailSmsOtp) vulns.push({ type: 'email_sms_bypass', reason: '发现短信/邮箱验证码、OTP、captcha 或发送验证码接口，应测试验证码复用、跨账号使用、票据绕过、空码/弱码和频率逻辑。', confidence: 0.78 });
  if (hasPasscode) vulns.push({ type: 'passcode_bypass', reason: '发现支付密码、交易密码、passcode、PIN 或资金密码语义，应测试空值、默认弱码、跳过字段、验证状态复用和跨流程绕过。', confidence: 0.8 });
  if (hasBusiness) vulns.push({ type: 'replay_race', reason: '交易、库存、优惠、支付流程可能存在同包重放、并发提交或幂等性缺陷。', confidence: 0.64 });
  if (hasBusiness && includesAny(text, [/refund/, /cancel/, /pay/, /withdraw/, /transfer/, /stock/, /order/, /退款/, /取消/, /支付/, /提现/, /转账/])) vulns.push({ type: 'state_machine_race', reason: '业务状态流涉及订单、支付、退款、提现、取消等状态转换，应测试乱序、跳步、跨包并发和竞争条件。', confidence: 0.7 });

  return vulns;
}

export async function rebuildFeatureTree(repo: AIScanRepository, scanRunId: string): Promise<AIFeatureNode[]> {
  const endpoints = await repo.listEndpoints(scanRunId);
  await repo.clearFeatures(scanRunId);
  const parentByName = new Map<string, AIFeatureNode>();
  const childByKey = new Map<string, AIFeatureNode>();

  for (const endpoint of endpoints) {
    const parentName = featureNameForEndpoint(endpoint);
    let parent = parentByName.get(parentName);
    if (!parent) {
      parent = await repo.createFeature({
        scan_run_id: scanRunId,
        name: parentName,
        node_type: 'module',
        description: `从 URL、表单、接口和响应语义自动归纳出的 ${parentName} 模块。`,
        confidence: 0.72,
      });
      parentByName.set(parentName, parent);
    }

    const childName = subFeatureNameForEndpoint(endpoint);
    const key = `${parent.id}:${childName}`;
    let child = childByKey.get(key);
    if (!child) {
      child = await repo.createFeature({
        scan_run_id: scanRunId,
        parent_id: parent.id,
        name: childName,
        node_type: endpoint.method === 'GET' ? 'page' : 'feature',
        description: `由 ${endpoint.method} ${endpoint.path} 归纳。`,
        confidence: 0.74,
        endpoint_ids: [endpoint.id],
      });
      childByKey.set(key, child);
    } else if (!child.endpoint_ids.includes(endpoint.id)) {
      child.endpoint_ids.push(endpoint.id);
      await repo.updateFeature(child.id, { endpoint_ids: child.endpoint_ids });
    }
  }

  return repo.listFeatures(scanRunId);
}

export async function rebuildVulnerabilityCandidates(repo: AIScanRepository, scanRunId: string): Promise<void> {
  const endpoints = await repo.listEndpoints(scanRunId);
  const features = await repo.listFeatures(scanRunId);
  await repo.clearCandidates(scanRunId);

  for (const endpoint of endpoints) {
    const feature = features.find(item => item.endpoint_ids.includes(endpoint.id)) || features.find(item => item.name === featureNameForEndpoint(endpoint));
    const vulnTypes = endpointVulnTypes(endpoint);
    for (const vuln of vulnTypes) {
      await repo.createCandidate({
        scan_run_id: scanRunId,
        feature_id: feature?.id,
        vuln_type: vuln.type,
        title: `${feature?.name || endpoint.feature_guess || endpoint.path} - ${vuln.type}`,
        reason: vuln.reason,
        confidence: vuln.confidence,
        endpoint_ids: [endpoint.id],
        required_accounts: ['auto'],
      });
    }
  }

  const featureGroups = new Map<string, { feature: AIFeatureNode; endpointIds: string[] }>();
  for (const feature of features) {
    for (const endpointId of feature.endpoint_ids) {
      const endpoint = endpoints.find(item => item.id === endpointId);
      if (!endpoint || !isActionableEndpoint(endpoint)) continue;
      const text = endpointText(endpoint);
      if (includesAny(text, [/cart/, /order/, /pay/, /coupon/, /refund/, /admin/, /bind/, /verify/, /购物车/, /订单/, /支付/, /绑定/, /验证/])) {
        const current = featureGroups.get(feature.id) || { feature, endpointIds: [] };
        current.endpointIds.push(endpoint.id);
        featureGroups.set(feature.id, current);
      }
    }
  }

  for (const { feature, endpointIds } of featureGroups.values()) {
    await repo.createCandidate({
      scan_run_id: scanRunId,
      feature_id: feature.id,
      vuln_type: 'business_logic',
      title: `${feature.name} - 业务逻辑漏洞候选`,
      reason: '功能涉及状态转换、账号绑定、交易或权限敏感操作，应生成正常流与异常流对比任务。',
      confidence: 0.76,
      endpoint_ids: endpointIds,
      required_accounts: ['auto'],
    });
  }
}

export function shouldMapCandidateToSelected(vulnType: string, selected: string[]): boolean {
  const normalized = selected.map(item => item.toLowerCase().replace(/[\s-]+/g, '_'));
  const aliases: Record<string, string[]> = {
    file_upload: ['file_upload', '文件上传', 'upload'],
    file_download: ['file_download', '文件下载', 'download'],
    path_traversal: ['path_traversal', 'directory_traversal', '目录穿越', '路径穿越'],
    bola_idor: ['bola', 'idor', 'bola_idor', '横向越权', '逻辑横向越权'],
    bfla: ['bfla', '纵向越权', '权限提升'],
    business_logic: ['business_logic', 'logic', '逻辑漏洞', '业务逻辑'],
    xss: ['xss', '跨站脚本'],
    command_injection: ['command_injection', 'rce', '命令执行'],
    auth_otp: ['auth_otp', '认证', '验证码', 'otp'],
    email_sms_bypass: ['email_sms_bypass', 'sms', 'email', '邮箱验证码', '短信验证码', '验证码绕过'],
    passcode_bypass: ['passcode_bypass', 'passcode', '支付密码', '交易密码', 'pin'],
    replay_race: ['replay_race', '并发', '重放'],
    state_machine_race: ['state_machine_race', '状态机', '竞争状态', '乱序', '跨包并发'],
  };
  const set = new Set(normalized);
  return (aliases[vulnType] || [vulnType]).some(alias => set.has(alias.toLowerCase().replace(/[\s-]+/g, '_')));
}
