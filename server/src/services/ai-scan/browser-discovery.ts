import { createHash } from 'crypto';

export interface BrowserObservation {
  url: string;
  status?: number;
  content_type?: string;
  title?: string;
  html?: string;
  links: string[];
  forms: BrowserFormObservation[];
  scripts: string[];
}

export interface BrowserFormObservation {
  method: string;
  action: string;
  enctype?: string;
  inputs: BrowserInputObservation[];
  label?: string;
  source_url: string;
}

export interface BrowserInputObservation {
  name?: string;
  type?: string;
  value?: string;
  placeholder?: string;
}

export interface DiscoveredHttpEndpoint {
  method: string;
  url: string;
  path: string;
  content_type?: string;
  feature_guess?: string;
  request_summary?: string;
  response_summary?: string;
  source_type: string;
  source_id?: string;
  has_file_input?: boolean;
  form?: BrowserFormObservation;
}

export interface DiscoveryResult {
  observations: BrowserObservation[];
  endpoints: DiscoveredHttpEndpoint[];
  warnings: string[];
}

function normalizeUrl(baseUrl: string, value: string): string | null {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function stripHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.toString();
}

function extractAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tag)) !== null) {
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    attrs[match[1].toLowerCase()] = value;
  }
  return attrs;
}

function textFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, ' ').trim() : undefined;
}

function extractLinks(html: string, sourceUrl: string): string[] {
  const links = new Set<string>();
  const regexes = [
    /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    /<link\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  ];
  for (const regex of regexes) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const raw = match[2] ?? match[3] ?? match[4] ?? '';
      if (!raw || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
      const normalized = normalizeUrl(sourceUrl, raw);
      if (normalized && sameOrigin(sourceUrl, normalized)) links.add(stripHash(normalized));
    }
  }
  return [...links];
}

function extractScripts(html: string, sourceUrl: string): string[] {
  const scripts = new Set<string>();
  const regex = /<script\b[^>]*src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    const normalized = normalizeUrl(sourceUrl, raw);
    if (normalized && sameOrigin(sourceUrl, normalized)) scripts.add(stripHash(normalized));
  }
  return [...scripts];
}

function extractForms(html: string, sourceUrl: string): BrowserFormObservation[] {
  const forms: BrowserFormObservation[] = [];
  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let match: RegExpExecArray | null;
  while ((match = formRegex.exec(html)) !== null) {
    const attrs = extractAttributes(`<form ${match[1]}>`);
    const body = match[2] || '';
    const inputs: BrowserInputObservation[] = [];
    const inputRegex = /<(input|textarea|select)\b([^>]*)>/gi;
    let inputMatch: RegExpExecArray | null;
    while ((inputMatch = inputRegex.exec(body)) !== null) {
      const inputAttrs = extractAttributes(`<${inputMatch[1]} ${inputMatch[2]}>`);
      inputs.push({
        name: inputAttrs.name,
        type: inputAttrs.type || inputMatch[1].toLowerCase(),
        value: inputAttrs.value,
        placeholder: inputAttrs.placeholder,
      });
    }
    const action = normalizeUrl(sourceUrl, attrs.action || sourceUrl) || sourceUrl;
    const label = textFromHtml(body).slice(0, 180);
    forms.push({
      method: (attrs.method || 'GET').toUpperCase(),
      action,
      enctype: attrs.enctype,
      inputs,
      label,
      source_url: sourceUrl,
    });
  }
  return forms;
}


function extractStandaloneFileInputs(html: string, sourceUrl: string): BrowserFormObservation[] {
  const forms: BrowserFormObservation[] = [];
  const inputRegex = /<input\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = inputRegex.exec(html)) !== null) {
    const attrs = extractAttributes(`<input ${match[1]}>`);
    if ((attrs.type || '').toLowerCase() !== 'file') continue;
    index += 1;
    const actionGuess = normalizeUrl(sourceUrl, attrs['data-url'] || attrs['data-action'] || attrs.action || `/upload`) || sourceUrl;
    forms.push({
      method: 'POST',
      action: actionGuess,
      enctype: 'multipart/form-data',
      inputs: [{ name: attrs.name || `file${index}`, type: 'file', value: attrs.value, placeholder: attrs.placeholder }],
      label: `Standalone file input ${attrs.name || index}`,
      source_url: sourceUrl,
    });
  }
  return forms;
}

function extractInlineApiEndpoints(text: string, sourceUrl: string): DiscoveredHttpEndpoint[] {
  const endpoints: DiscoveredHttpEndpoint[] = [];
  const seen = new Set<string>();
  const patterns = [
    /\b(?:fetch|axios\.(?:get|post|put|delete|patch)|request)\s*\(\s*[`"']([^`"']+)[`"']/gi,
    /\burl\s*[:=]\s*[`"']([^`"']+)[`"']/gi,
    /\baction\s*[:=]\s*[`"']([^`"']+)[`"']/gi,
    /[`"']((?:\/api\/|\/v\d+\/|\/graphql|\/upload|\/download|\/admin|\/user|\/order|\/cart|\/file|\/media)[^`"'\s<>]*)[`"']/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const raw = match[1];
      if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) continue;
      const absolute = normalizeUrl(sourceUrl, raw);
      if (!absolute || !sameOrigin(sourceUrl, absolute)) continue;
      const parsed = new URL(absolute);
      const methodHint = /post|create|upload|delete|update|patch|put|submit|pay|order|cart|admin/i.test(raw) ? 'POST' : 'GET';
      const key = `${methodHint} ${parsed.pathname}`;
      if (seen.has(key)) continue;
      seen.add(key);
      endpoints.push({
        method: methodHint,
        url: absolute,
        path: parsed.pathname || '/',
        content_type: /upload|file|media|avatar|image|import/i.test(raw) ? 'multipart/form-data' : undefined,
        feature_guess: guessFeature(absolute),
        request_summary: `Inline JS/API reference discovered from ${sourceUrl}`,
        response_summary: `${raw}; query_params: ${[...parsed.searchParams.keys()].join(', ')}`,
        source_type: 'browser_js_reference',
      });
    }
  }
  return endpoints;
}

function guessFeature(url: string, form?: BrowserFormObservation): string {
  const lower = `${url} ${form?.label || ''} ${form?.inputs.map(i => `${i.name || ''} ${i.type || ''}`).join(' ') || ''}`.toLowerCase();
  if (/(avatar|profile|account|user|用户|头像)/.test(lower)) return '用户中心 / 个人资料';
  if (/(upload|file|image|media|attachment|excel|import|上传|附件|图片|导入)/.test(lower)) return '文件处理 / 上传导入';
  if (/(cart|order|checkout|payment|coupon|refund|订单|购物车|支付|退款|优惠)/.test(lower)) return '交易 / 订单';
  if (/(login|signin|register|password|otp|captcha|验证码|登录|注册|密码)/.test(lower)) return '认证 / 账号';
  if (/(admin|manage|dashboard|后台|管理)/.test(lower)) return '后台管理';
  if (/(post|comment|article|community|forum|评论|帖子|社区)/.test(lower)) return '内容 / 社区';
  return '通用功能';
}

function endpointFingerprint(method: string, url: string): string {
  return createHash('sha1').update(`${method.toUpperCase()} ${url}`).digest('hex').slice(0, 12);
}

export async function discoverTargetFromHttp(baseUrl: string, options: { max_pages?: number } = {}): Promise<DiscoveryResult> {
  const startUrl = stripHash(new URL(baseUrl).toString());
  const maxPages = Math.max(1, Number(options.max_pages ?? 1000));
  const queue: string[] = [startUrl];
  const seen = new Set<string>();
  const observations: BrowserObservation[] = [];
  const endpointsByKey = new Map<string, DiscoveredHttpEndpoint>();
  const warnings: string[] = [];
  const cookieJar = new Map<string, string>();

  async function fetchPage(url: string): Promise<BrowserObservation | null> {
    const cookieHeader = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    const response = await fetch(url, {
      method: 'GET',
      headers: cookieHeader ? { Cookie: cookieHeader, 'User-Agent': 'BSTG-AI-Agent/1.0' } : { 'User-Agent': 'BSTG-AI-Agent/1.0' },
      redirect: 'follow',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      for (const part of setCookie.split(',')) {
        const first = part.split(';')[0];
        const eq = first.indexOf('=');
        if (eq > 0) cookieJar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
      }
    }
    const contentType = response.headers.get('content-type') || '';
    const html = contentType.includes('text/html') || contentType.includes('application/xhtml') || contentType.includes('javascript') || contentType.includes('ecmascript') || contentType.includes('text/plain')
      ? await response.text()
      : '';
    const links = html ? extractLinks(html, url) : [];
    const forms = html ? [...extractForms(html, url), ...extractStandaloneFileInputs(html, url)] : [];
    const scripts = html ? extractScripts(html, url) : [];
    return {
      url,
      status: response.status,
      content_type: contentType,
      title: html ? extractTitle(html) : undefined,
      html,
      links,
      forms,
      scripts,
    };
  }

  while (queue.length > 0 && seen.size < maxPages) {
    const url = queue.shift();
    if (!url || seen.has(url) || !sameOrigin(startUrl, url)) continue;
    seen.add(url);
    try {
      const observation = await fetchPage(url);
      if (!observation) continue;
      observations.push(observation);
      endpointsByKey.set(`GET ${new URL(url).pathname}`, {
        method: 'GET',
        url,
        path: new URL(url).pathname || '/',
        content_type: observation.content_type,
        feature_guess: guessFeature(url),
        response_summary: `${observation.status || ''} ${observation.title || ''}`.trim(),
        source_type: 'browser_page',
      });

      for (const form of observation.forms) {
        const parsed = new URL(form.action);
        const hasFileInput = form.inputs.some(input => (input.type || '').toLowerCase() === 'file');
        const contentType = hasFileInput || /multipart\/form-data/i.test(form.enctype || '')
          ? 'multipart/form-data'
          : 'application/x-www-form-urlencoded';
        const key = `${form.method} ${parsed.pathname}`;
        endpointsByKey.set(key, {
          method: form.method,
          url: form.action,
          path: parsed.pathname || '/',
          content_type: contentType,
          feature_guess: guessFeature(form.action, form),
          request_summary: `HTML form with ${form.inputs.length} input(s)${hasFileInput ? ', file input' : ''}; fields: ${form.inputs.map(input => `field:${input.name || 'unnamed'} type:${input.type || 'text'} value:${input.value || ''}`).join(', ')}`,
          response_summary: form.label || '',
          source_type: 'browser_form',
          has_file_input: hasFileInput,
          form,
        });
      }

      for (const endpoint of extractInlineApiEndpoints(observation.html || '', observation.url)) {
        endpointsByKey.set(`${endpoint.method} ${endpoint.path}`, endpoint);
      }

      for (const scriptUrl of observation.scripts.slice(0, 25)) {
        try {
          const script = await fetchPage(scriptUrl);
          const scriptText = script?.html || '';
          for (const endpoint of extractInlineApiEndpoints(scriptText, scriptUrl)) {
            endpointsByKey.set(`${endpoint.method} ${endpoint.path}`, endpoint);
          }
        } catch (error: any) {
          warnings.push(`${scriptUrl}: script endpoint extraction failed: ${error.message || String(error)}`);
        }
      }

      for (const next of [...observation.links, ...observation.scripts]) {
        if (!seen.has(next) && sameOrigin(startUrl, next) && queue.length < maxPages * 2) queue.push(next);
      }
    } catch (error: any) {
      warnings.push(`${url}: ${error.message || String(error)}`);
    }
  }

  const endpoints = [...endpointsByKey.values()].map(endpoint => ({
    ...endpoint,
    source_id: endpointFingerprint(endpoint.method, endpoint.url),
  } as DiscoveredHttpEndpoint));

  return { observations, endpoints, warnings };
}
