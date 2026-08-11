import type { AIScanRepository } from '../repository.js';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

export interface BrowserActionResult {
  ok: boolean;
  mode: 'playwright' | 'http_fallback';
  current_url?: string;
  title?: string;
  screenshot_base64?: string;
  dom_summary?: Record<string, any>;
  network_events?: Array<Record<string, any>>;
  error?: string;
}

function summarizeHtml(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim();
  const links = [...html.matchAll(/<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)].slice(0, 100).map(m => m[2] || m[3] || m[4]);
  const forms = [...html.matchAll(/<form\b[^>]*>/gi)].length;
  const fileInputs = [...html.matchAll(/<input\b[^>]*type\s*=\s*("file"|'file'|file)/gi)].length;
  return { title, links, forms, file_inputs: fileInputs, text_preview: html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000) };
}

export async function navigateWithOptionalBrowser(input: {
  url: string;
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  timeout_ms?: number;
}): Promise<BrowserActionResult> {
  try {
    const playwright = await dynamicImport('playwright').catch(() => null);
    if (playwright?.chromium) {
      const browser = await playwright.chromium.launch({ headless: true });
      const page = await browser.newPage();
      const networkEvents: Record<string, any>[] = [];
      page.on('request', (request: any) => networkEvents.push({ type: 'request', method: request.method(), url: request.url(), resource_type: request.resourceType() }));
      page.on('response', (response: any) => networkEvents.push({ type: 'response', status: response.status(), url: response.url(), content_type: response.headers()?.['content-type'] }));
      await page.goto(input.url, { waitUntil: 'networkidle', timeout: input.timeout_ms || 45000 });
      const title = await page.title();
      const screenshot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
      const domSummary = await page.evaluate(() => {
        const doc = (globalThis as any).document;
        const loc = (globalThis as any).location;
        return {
          title: doc.title,
          url: loc.href,
          links: Array.from(doc.querySelectorAll('a[href]')).slice(0, 100).map((a: any) => a.href),
          forms: Array.from(doc.querySelectorAll('form')).map((form: any) => ({ method: form.method, action: form.action, enctype: form.enctype, inputs: Array.from(form.querySelectorAll('input,textarea,select')).map((i: any) => ({ name: i.name, type: i.type, placeholder: i.placeholder })) })),
          buttons: Array.from(doc.querySelectorAll('button,input[type=button],input[type=submit]')).slice(0, 80).map((b: any) => b.innerText || b.value || b.getAttribute('aria-label')),
        };
      });
      await browser.close();
      const result: BrowserActionResult = { ok: true, mode: 'playwright', current_url: domSummary.url || input.url, title, screenshot_base64: screenshot?.toString('base64'), dom_summary: domSummary, network_events: networkEvents.slice(-300) };
      await input.repo.createArtifact({ scan_run_id: input.scanRunId, task_id: input.taskId, artifact_type: 'browser_state', title: `Browser state ${input.url}`, content_json: { ...result, screenshot_base64: result.screenshot_base64 ? '[base64 omitted in json preview]' : undefined }, content_text: result.screenshot_base64, source_ref: input.url });
      return result;
    }
  } catch (error: any) {
    // Fall through to HTTP fallback but keep error in artifact.
    await input.repo.createArtifact({ scan_run_id: input.scanRunId, task_id: input.taskId, artifact_type: 'browser_warning', title: 'Playwright browser unavailable', content_json: { error: error.message || String(error) }, source_ref: input.url });
  }

  try {
    const response = await fetch(input.url, { headers: { 'User-Agent': 'BSTG-AI-Agent/1.0' }, redirect: 'follow' });
    const html = await response.text();
    const domSummary = summarizeHtml(html);
    const result: BrowserActionResult = { ok: true, mode: 'http_fallback', current_url: response.url, title: domSummary.title, dom_summary: domSummary, network_events: [{ type: 'response', url: response.url, status: response.status, content_type: response.headers.get('content-type') }] };
    await input.repo.createArtifact({ scan_run_id: input.scanRunId, task_id: input.taskId, artifact_type: 'browser_state', title: `HTTP browser fallback ${input.url}`, content_json: result as Record<string, any>, source_ref: input.url });
    return result;
  } catch (error: any) {
    return { ok: false, mode: 'http_fallback', error: error.message || String(error) };
  }
}
