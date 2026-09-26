import { assertUrlInTargetScope, TargetScopeError } from '../target-scope.js';

/** Login destinations are a separate navigation allowlist, never mutation targets. */
export function normalizeAuthenticationOrigins(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('统一登录地址最多支持 8 个 HTTPS 来源。');
  return [...new Set(value.map(raw => {
    let url: URL;
    try { url = new URL(String(raw)); } catch { throw new Error('统一登录地址必须为完整的 HTTPS 地址。'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('统一登录地址必须使用 HTTPS，且不能包含账号密码。');
    return url.origin;
  }))];
}

export function assertBrowserNavigationUrl(candidate: string, baseUrl: string, authenticationOrigins: string[]): URL {
  try { return assertUrlInTargetScope(candidate, baseUrl); } catch (error) {
    const url = new URL(candidate, baseUrl);
    if (url.protocol === 'https:' && !url.username && !url.password && authenticationOrigins.includes(url.origin)) return url;
    if (['http:', 'https:'].includes(url.protocol)) throw new TargetScopeError(`浏览器跳转到未配置的来源 ${url.origin}。若它是目标的统一登录服务，请将其加入统一登录地址；该地址不会加入漏洞测试范围。`);
    throw error;
  }
}
