import { safeFetch } from '../security/target-policy.js';

export interface DetectedTechComponent {
  component_name: string;
  component_type?: string;
  version?: string;
  confidence: number;
  evidence_source?: string;
  evidence_detail?: Record<string, any>;
  cpe_candidates?: string[];
  purl_candidates?: string[];
}

export interface TechFingerprintResult {
  components: DetectedTechComponent[];
  observations: Array<{
    url: string;
    status?: number;
    content_type?: string;
    title?: string;
    headers: Record<string, string>;
  }>;
  warnings: string[];
}

const TEXT_LIMIT = 120000;

const PACKAGE_HINTS: Record<string, { type: string; ecosystem?: string; package?: string; cpe?: string }> = {
  express: { type: 'framework', ecosystem: 'npm', package: 'express', cpe: 'cpe:2.3:a:expressjs:express:*:*:*:*:*:node.js:*:*' },
  react: { type: 'frontend_framework', ecosystem: 'npm', package: 'react', cpe: 'cpe:2.3:a:facebook:react:*:*:*:*:*:node.js:*:*' },
  vue: { type: 'frontend_framework', ecosystem: 'npm', package: 'vue', cpe: 'cpe:2.3:a:vuejs:vue.js:*:*:*:*:*:node.js:*:*' },
  angular: { type: 'frontend_framework', ecosystem: 'npm', package: '@angular/core', cpe: 'cpe:2.3:a:angular:angular:*:*:*:*:*:node.js:*:*' },
  jquery: { type: 'javascript_library', ecosystem: 'npm', package: 'jquery', cpe: 'cpe:2.3:a:jquery:jquery:*:*:*:*:*:*:*:*' },
  bootstrap: { type: 'frontend_framework', ecosystem: 'npm', package: 'bootstrap', cpe: 'cpe:2.3:a:getbootstrap:bootstrap:*:*:*:*:*:*:*:*' },
  vite: { type: 'build_tool', ecosystem: 'npm', package: 'vite' },
  nextjs: { type: 'framework', ecosystem: 'npm', package: 'next', cpe: 'cpe:2.3:a:vercel:next.js:*:*:*:*:*:node.js:*:*' },
  nuxt: { type: 'framework', ecosystem: 'npm', package: 'nuxt' },
  laravel: { type: 'framework', ecosystem: 'Packagist', package: 'laravel/framework', cpe: 'cpe:2.3:a:laravel:laravel:*:*:*:*:*:*:*:*' },
  django: { type: 'framework', ecosystem: 'PyPI', package: 'django', cpe: 'cpe:2.3:a:djangoproject:django:*:*:*:*:*:*:*:*' },
  rails: { type: 'framework', ecosystem: 'RubyGems', package: 'rails', cpe: 'cpe:2.3:a:rubyonrails:rails:*:*:*:*:*:*:*:*' },
  wordpress: { type: 'cms', ecosystem: 'Packagist', package: 'wordpress/core', cpe: 'cpe:2.3:a:wordpress:wordpress:*:*:*:*:*:*:*:*' },
  drupal: { type: 'cms', ecosystem: 'Packagist', package: 'drupal/core', cpe: 'cpe:2.3:a:drupal:drupal:*:*:*:*:*:*:*:*' },
  nginx: { type: 'web_server', cpe: 'cpe:2.3:a:nginx:nginx:*:*:*:*:*:*:*:*' },
  apache: { type: 'web_server', cpe: 'cpe:2.3:a:apache:http_server:*:*:*:*:*:*:*:*' },
  php: { type: 'runtime', ecosystem: 'Packagist', package: 'php', cpe: 'cpe:2.3:a:php:php:*:*:*:*:*:*:*:*' },
  tomcat: { type: 'application_server', cpe: 'cpe:2.3:a:apache:tomcat:*:*:*:*:*:*:*:*' },
  aspnet: { type: 'framework', cpe: 'cpe:2.3:a:microsoft:asp.net:*:*:*:*:*:*:*:*' },
};

function normalizeName(value: string): string {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'next.js' || key === 'next') return 'nextjs';
  if (key === 'vue.js') return 'vue';
  if (key === 'angularjs') return 'angular';
  if (key === 'apache httpd' || key === 'apache http server') return 'apache';
  if (key === 'asp.net') return 'aspnet';
  return key.replace(/\s+/g, '-');
}

function cleanVersion(value?: string): string | undefined {
  const version = String(value || '').trim().replace(/^v/i, '');
  if (!version) return undefined;
  const match = version.match(/\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0];
}

function hintFor(name: string, version?: string): Pick<DetectedTechComponent, 'component_type' | 'cpe_candidates' | 'purl_candidates'> {
  const hint = PACKAGE_HINTS[name] || PACKAGE_HINTS[normalizeName(name)];
  if (!hint) return {};
  const purl = hint.ecosystem && hint.package
    ? `pkg:${hint.ecosystem.toLowerCase()}/${hint.package}${version ? `@${version}` : ''}`
    : undefined;
  return {
    component_type: hint.type,
    cpe_candidates: hint.cpe ? [hint.cpe.replace('*', version || '*')] : [],
    purl_candidates: purl ? [purl] : [],
  };
}

function component(
  name: string,
  version: string | undefined,
  confidence: number,
  evidence_source: string,
  evidence_detail: Record<string, any> = {},
  type?: string
): DetectedTechComponent {
  const normalized = normalizeName(name);
  const cleanedVersion = cleanVersion(version);
  const hints = hintFor(normalized, cleanedVersion);
  return {
    component_name: normalized,
    component_type: type || hints.component_type || 'component',
    version: cleanedVersion,
    confidence: Math.max(0, Math.min(1, confidence)),
    evidence_source,
    evidence_detail,
    cpe_candidates: hints.cpe_candidates || [],
    purl_candidates: hints.purl_candidates || [],
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

async function fetchText(url: string, timeoutMs: number): Promise<{ status?: number; headers: Record<string, string>; text: string; final_url?: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    const response = await safeFetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': 'BSTG-Tech-Fingerprint/1.0' },
    }, 'tech fingerprint request');
    const headers = headersToObject(response.headers);
    const contentType = headers['content-type'] || '';
    const text = /text|html|javascript|ecmascript|json|xml|css/i.test(contentType)
      ? (await response.text()).slice(0, TEXT_LIMIT)
      : '';
    return { status: response.status, headers, text, final_url: response.url };
  } catch (error: any) {
    return { headers: {}, text: '', error: error?.name === 'AbortError' ? 'request_timeout' : (error?.message || String(error)) };
  } finally {
    clearTimeout(timeout);
  }
}

function titleFromHtml(html: string): string | undefined {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
}

function extractAssetUrls(html: string, sourceUrl: string): string[] {
  const urls = new Set<string>();
  const add = (raw?: string) => {
    if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) return;
    try {
      const absolute = new URL(raw, sourceUrl);
      if (absolute.origin !== new URL(sourceUrl).origin) return;
      if (!/\.(?:js|mjs|css)(?:$|[?#])/i.test(absolute.pathname)) return;
      absolute.hash = '';
      urls.add(absolute.toString());
    } catch {
    }
  };
  const scriptRegex = /<script\b[^>]*src\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const linkRegex = /<link\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) add(match[2] ?? match[3] ?? match[4]);
  while ((match = linkRegex.exec(html)) !== null) add(match[2] ?? match[3] ?? match[4]);
  return [...urls].slice(0, 16);
}

function detectFromHeaders(url: string, headers: Record<string, string>): DetectedTechComponent[] {
  const found: DetectedTechComponent[] = [];
  const server = headers.server || '';
  const poweredBy = headers['x-powered-by'] || '';
  const generator = headers['x-generator'] || headers['x-drupal-cache'] || '';
  const setCookie = headers['set-cookie'] || '';

  const serverPatterns: Array<[RegExp, string, string]> = [
    [/\bnginx\/?([0-9][^\s;)]*)?/i, 'nginx', 'web_server'],
    [/\bApache\/?([0-9][^\s;)]*)?/i, 'apache', 'web_server'],
    [/\bMicrosoft-IIS\/?([0-9][^\s;)]*)?/i, 'microsoft-iis', 'web_server'],
    [/\bTomcat\/?([0-9][^\s;)]*)?/i, 'tomcat', 'application_server'],
  ];
  for (const [regex, name, type] of serverPatterns) {
    const match = server.match(regex);
    if (match) found.push(component(name, match[1], match[1] ? 0.94 : 0.78, 'response_header:server', { url, header: 'server', value: server }, type));
  }

  const poweredPatterns: Array<[RegExp, string, string]> = [
    [/\bExpress\b(?:[\/\s]+([0-9][^\s;)]*))?/i, 'express', 'framework'],
    [/\bPHP\/?([0-9][^\s;)]*)?/i, 'php', 'runtime'],
    [/\bASP\.NET\b(?:\s*([0-9][^\s;)]*))?/i, 'aspnet', 'framework'],
    [/\bNext\.js\b(?:\s*([0-9][^\s;)]*))?/i, 'nextjs', 'framework'],
  ];
  for (const [regex, name, type] of poweredPatterns) {
    const match = poweredBy.match(regex);
    if (match) found.push(component(name, match[1], match[1] ? 0.95 : 0.82, 'response_header:x-powered-by', { url, header: 'x-powered-by', value: poweredBy }, type));
  }

  if (/Drupal/i.test(generator)) found.push(component('drupal', cleanVersion(generator), 0.78, 'response_header:x-generator', { url, value: generator }, 'cms'));
  if (/laravel_session|XSRF-TOKEN/i.test(setCookie)) found.push(component('laravel', undefined, 0.7, 'response_cookie', { url, cookie_signal: 'laravel_session|XSRF-TOKEN' }, 'framework'));
  if (/connect\.sid/i.test(setCookie)) found.push(component('express', undefined, 0.68, 'response_cookie', { url, cookie_signal: 'connect.sid' }, 'framework'));
  if (/PHPSESSID/i.test(setCookie)) found.push(component('php', undefined, 0.7, 'response_cookie', { url, cookie_signal: 'PHPSESSID' }, 'runtime'));
  if (/JSESSIONID/i.test(setCookie)) found.push(component('tomcat', undefined, 0.56, 'response_cookie', { url, cookie_signal: 'JSESSIONID' }, 'application_server'));
  if (/csrftoken/i.test(setCookie)) found.push(component('django', undefined, 0.56, 'response_cookie', { url, cookie_signal: 'csrftoken' }, 'framework'));
  return found;
}

function detectFromHtml(url: string, html: string): DetectedTechComponent[] {
  const found: DetectedTechComponent[] = [];
  const generatorRegex = /<meta\b[^>]*(?:name|property)\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = generatorRegex.exec(html)) !== null) {
    const content = match[1] || '';
    const pairs: Array<[RegExp, string, string]> = [
      [/WordPress\s*([0-9][^\s]*)?/i, 'wordpress', 'cms'],
      [/Drupal\s*([0-9][^\s]*)?/i, 'drupal', 'cms'],
      [/Joomla!?\s*([0-9][^\s]*)?/i, 'joomla', 'cms'],
      [/Next\.js\s*([0-9][^\s]*)?/i, 'nextjs', 'framework'],
    ];
    for (const [regex, name, type] of pairs) {
      const hit = content.match(regex);
      if (hit) found.push(component(name, hit[1], hit[1] ? 0.96 : 0.78, 'html_meta_generator', { url, content }, type));
    }
  }

  const lower = html.toLowerCase();
  if (lower.includes('/_next/static/')) found.push(component('nextjs', undefined, 0.82, 'html_asset_path', { url, signal: '/_next/static/' }, 'framework'));
  if (lower.includes('wp-content/') || lower.includes('wp-includes/')) found.push(component('wordpress', undefined, 0.84, 'html_asset_path', { url, signal: 'wp-content|wp-includes' }, 'cms'));
  if (lower.includes('/sites/default/files/') || lower.includes('drupal-settings-json')) found.push(component('drupal', undefined, 0.78, 'html_asset_path', { url, signal: 'drupal asset path' }, 'cms'));
  if (lower.includes('csrf-token') && lower.includes('laravel')) found.push(component('laravel', undefined, 0.64, 'html_marker', { url, signal: 'csrf-token+laravel' }, 'framework'));
  if (/\bdata-reactroot\b|__REACT_DEVTOOLS_GLOBAL_HOOK__/.test(html)) found.push(component('react', undefined, 0.65, 'html_marker', { url, signal: 'react marker' }, 'frontend_framework'));
  if (/\bng-version\s*=\s*["']([^"']+)["']/.test(html)) found.push(component('angular', html.match(/\bng-version\s*=\s*["']([^"']+)["']/)?.[1], 0.92, 'html_marker', { url, signal: 'ng-version' }, 'frontend_framework'));
  return found;
}

function detectFromAssetUrl(assetUrl: string): DetectedTechComponent[] {
  const decoded = decodeURIComponent(assetUrl);
  const patterns: Array<[RegExp, string, string]> = [
    [/jquery[.-]([0-9]+(?:\.[0-9]+){1,3})/i, 'jquery', 'javascript_library'],
    [/bootstrap(?:\.bundle)?[.-]([0-9]+(?:\.[0-9]+){1,3})/i, 'bootstrap', 'frontend_framework'],
    [/react(?:\.production\.min)?[.-]([0-9]+(?:\.[0-9]+){1,3})/i, 'react', 'frontend_framework'],
    [/vue[.-]([0-9]+(?:\.[0-9]+){1,3})/i, 'vue', 'frontend_framework'],
    [/angular(?:\.min)?[.-]([0-9]+(?:\.[0-9]+){1,3})/i, 'angular', 'frontend_framework'],
    [/vite/i, 'vite', 'build_tool'],
  ];
  return patterns.flatMap(([regex, name, type]) => {
    const match = decoded.match(regex);
    return match ? [component(name, match[1], match[1] ? 0.9 : 0.58, 'static_asset_url', { asset_url: assetUrl }, type)] : [];
  });
}

function detectFromAssetText(assetUrl: string, text: string): DetectedTechComponent[] {
  const found: DetectedTechComponent[] = [];
  const patterns: Array<[RegExp, string, string]> = [
    [/jQuery JavaScript Library v([0-9]+(?:\.[0-9]+){1,3})/i, 'jquery', 'javascript_library'],
    [/Bootstrap v([0-9]+(?:\.[0-9]+){1,3})/i, 'bootstrap', 'frontend_framework'],
    [/React v([0-9]+(?:\.[0-9]+){1,3})/i, 'react', 'frontend_framework'],
    [/Vue\.js v([0-9]+(?:\.[0-9]+){1,3})/i, 'vue', 'frontend_framework'],
    [/AngularJS v([0-9]+(?:\.[0-9]+){1,3})/i, 'angular', 'frontend_framework'],
    [/@vite\/client|vite\/dist\/client/i, 'vite', 'build_tool'],
  ];
  for (const [regex, name, type] of patterns) {
    const match = text.match(regex);
    if (match) found.push(component(name, match[1], match[1] ? 0.94 : 0.72, 'static_asset_banner', { asset_url: assetUrl, snippet: match[0].slice(0, 160) }, type));
  }
  return found;
}

function dedupe(components: DetectedTechComponent[]): DetectedTechComponent[] {
  const byKey = new Map<string, DetectedTechComponent>();
  for (const item of components) {
    const key = `${item.component_name}:${item.component_type || ''}:${item.version || ''}`;
    const existing = byKey.get(key);
    if (!existing || item.confidence > existing.confidence) {
      byKey.set(key, item);
    } else if (existing) {
      existing.cpe_candidates = Array.from(new Set([...(existing.cpe_candidates || []), ...(item.cpe_candidates || [])]));
      existing.purl_candidates = Array.from(new Set([...(existing.purl_candidates || []), ...(item.purl_candidates || [])]));
    }
  }
  return [...byKey.values()].sort((a, b) => b.confidence - a.confidence || a.component_name.localeCompare(b.component_name));
}

export async function fingerprintTargetTechStack(baseUrl: string, options: { timeout_ms?: number; max_assets?: number } = {}): Promise<TechFingerprintResult> {
  const timeoutMs = Number(options.timeout_ms || 12000);
  const maxAssets = Math.max(0, Math.min(24, Number(options.max_assets ?? 12)));
  const base = new URL(baseUrl);
  const nowToken = Date.now().toString(36);
  const probeUrls = [
    base.toString(),
    new URL('/robots.txt', base).toString(),
    new URL('/sitemap.xml', base).toString(),
    new URL('/.well-known/security.txt', base).toString(),
    new URL(`/__bstg_404_probe_${nowToken}`, base).toString(),
  ];
  const components: DetectedTechComponent[] = [];
  const observations: TechFingerprintResult['observations'] = [];
  const warnings: string[] = [];
  const assetUrls = new Set<string>();

  for (const url of probeUrls) {
    const response = await fetchText(url, timeoutMs);
    if (response.error) {
      warnings.push(`${url}: ${response.error}`);
      continue;
    }
    observations.push({
      url: response.final_url || url,
      status: response.status,
      content_type: response.headers['content-type'],
      title: titleFromHtml(response.text),
      headers: response.headers,
    });
    components.push(...detectFromHeaders(url, response.headers));
    if (response.text) {
      components.push(...detectFromHtml(url, response.text));
      for (const assetUrl of extractAssetUrls(response.text, response.final_url || url)) assetUrls.add(assetUrl);
    }
  }

  for (const assetUrl of [...assetUrls].slice(0, maxAssets)) {
    components.push(...detectFromAssetUrl(assetUrl));
    const response = await fetchText(assetUrl, timeoutMs);
    if (response.error) {
      warnings.push(`${assetUrl}: ${response.error}`);
      continue;
    }
    observations.push({
      url: response.final_url || assetUrl,
      status: response.status,
      content_type: response.headers['content-type'],
      title: undefined,
      headers: response.headers,
    });
    components.push(...detectFromHeaders(assetUrl, response.headers));
    if (response.text) components.push(...detectFromAssetText(assetUrl, response.text));
  }

  return { components: dedupe(components), observations, warnings };
}
