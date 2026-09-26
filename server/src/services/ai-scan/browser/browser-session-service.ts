import type { AIScanRepository } from '../repository.js';
import { assertUrlInTargetScope, fetchInTargetScope } from '../target-scope.js';
import { navigatePersistentBrowser, type PersistentBrowserScope } from './persistent-browser-runtime.js';

export interface BrowserActionResult {
  ok: boolean;
  mode: 'playwright' | 'http_fallback';
  persistent_context?: boolean;
  current_url?: string;
  title?: string;
  screenshot_base64?: string;
  dom_summary?: Record<string, any>;
  network_events?: Array<Record<string, any>>;
  context_key?: string;
  context_id?: string;
  context_scope?: PersistentBrowserScope;
  identity_key?: string;
  recovered_from_storage_state?: boolean;
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
  scope_base_url?: string;
  signal?: AbortSignal;
  context_scope?: PersistentBrowserScope;
  identity_key?: string;
  context_key?: string;
  persist_context?: boolean;
  context_ttl_seconds?: number;
}): Promise<BrowserActionResult> {
  const scopeBaseUrl = input.scope_base_url || input.url;
  assertUrlInTargetScope(input.url, scopeBaseUrl);

  if (input.persist_context !== false) {
    try {
      const persistent = await navigatePersistentBrowser({
        url: input.url,
        repo: input.repo,
        scanRunId: input.scanRunId,
        taskId: input.taskId,
        timeout_ms: input.timeout_ms,
        scope_base_url: scopeBaseUrl,
        signal: input.signal,
        scope_type: input.context_scope,
        identity_key: input.identity_key,
        context_key: input.context_key,
        ttl_seconds: input.context_ttl_seconds,
      });
      if (persistent) {
        const result: BrowserActionResult = { ...persistent, mode: 'playwright', persistent_context: true };
        await input.repo.createArtifact({
          scan_run_id: input.scanRunId,
          task_id: input.taskId,
          artifact_type: 'browser_state',
          title: `Persistent browser state ${input.url}`,
          content_json: { ...result, screenshot_base64: result.screenshot_base64 ? '[base64 omitted in json preview]' : undefined },
          content_text: result.screenshot_base64,
          source_ref: input.url,
        });
        return result;
      }
      return {ok:false,mode:'playwright',error:'LIVE_BROWSER_UNAVAILABLE'};
    } catch (error: any) {
      await input.repo.createArtifact({ scan_run_id: input.scanRunId, task_id: input.taskId, artifact_type: 'browser_warning', title: 'Live browser unavailable; no HTTP substitution', content_json: { error: error.message || String(error) }, source_ref: input.url });
      return {ok:false,mode:'playwright',error:'LIVE_BROWSER_UNAVAILABLE'};
    }
  }

  // Only an explicitly requested HTTP observation can use this non-visual path.
  try {
    const response = await fetchInTargetScope(input.url, { headers: { 'User-Agent': 'BSTG-AI-Agent/1.0' }, signal: input.signal }, scopeBaseUrl);
    const html = await response.text();
    const domSummary = summarizeHtml(html);
    const result: BrowserActionResult = { ok: true, mode: 'http_fallback', current_url: response.url, title: domSummary.title, dom_summary: domSummary, network_events: [{ type: 'response', url: response.url, status: response.status, content_type: response.headers.get('content-type') }] };
    await input.repo.createArtifact({ scan_run_id: input.scanRunId, task_id: input.taskId, artifact_type: 'browser_state', title: `HTTP browser fallback ${input.url}`, content_json: result as Record<string, any>, source_ref: input.url });
    return result;
  } catch (error: any) {
    return { ok: false, mode: 'http_fallback', error: error.message || String(error) };
  }
}
