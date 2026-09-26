import type { AIScanRepository } from '../repository.js';
import { assertUrlInTargetScope } from '../target-scope.js';
import { openDesktop, type DesktopSession } from '../../live-browser/desktop-runtime.js';
import { launchAssessmentBrowser } from './browser-provider.js';
import { assertBrowserNavigationUrl, normalizeAuthenticationOrigins } from './authentication-scope.js';
import { installNavigationGuard } from './navigation-guard.js';
import { assertScanActive, scanAbortSignal } from '../run-control.js';

export type PersistentBrowserScope = 'scan' | 'task' | 'identity';

export interface PersistentBrowserNavigationResult {
  ok: boolean;
  current_url?: string;
  title?: string;
  screenshot_base64?: string;
  dom_summary?: Record<string, any>;
  network_events?: Array<Record<string, any>>;
  context_key: string;
  context_id?: string;
  context_scope: PersistentBrowserScope;
  identity_key?: string;
  recovered_from_storage_state?: boolean;
  error?: string;
}

interface LiveBrowserContext {
  scanRunId: string;
  contextKey: string;
  scopeType: PersistentBrowserScope;
  identityKey: string;
  taskOwnerId?: string;
  browserContext: any;
  browser: any;
  desktop?: DesktopSession;
  page: any;
  networkEvents: Record<string, any>[];
  lastUsedAt: number;
  operationTail: Promise<void>;
  pendingCaptures: Set<Promise<unknown>>;
  authenticationOrigins: string[];
  navigationError?: string;
  operationSignal?: AbortSignal;
}

const liveContexts = new Map<string, LiveBrowserContext>();
const contextCreationPromises = new Map<string, Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null>>();
const closingContextKeys = new Set<string>();
async function chromiumBrowser(scanRunId: string, taskId?: string): Promise<{browser: any; desktop?: DesktopSession}> {
  const mode = process.env.BSTG_BROWSER_MODE || 'headless';
  if (!['headless', 'headed', 'novnc'].includes(mode)) throw new Error('BSTG_BROWSER_MODE must be headless, headed or novnc.');
  const desktop = mode === 'novnc' ? await openDesktop({runId: scanRunId, taskId}) : undefined;
  try {
    const browser = await launchAssessmentBrowser({
      headless: mode === 'headless',
      chromiumSandbox: process.env.BSTG_BROWSER_ALLOW_NO_SANDBOX !== '1',
      ...(process.env.BSTG_CHROMIUM_EXECUTABLE ? {executablePath:process.env.BSTG_CHROMIUM_EXECUTABLE} : {}),
      ...(desktop ? {env: {...process.env, DISPLAY: desktop.display, XAUTHORITY: desktop.authority}} : {}),
      args: ['--window-size=1440,1000', '--window-position=0,0'],
    });
    browser.on('disconnected', () => { if (desktop && !desktop.closed) void desktop.close(); });
    return {browser, desktop};
  } catch (error) { await desktop?.close(); throw error; }
}

function liveKey(scanRunId: string, contextKey: string): string {
  return `${scanRunId}:${contextKey}`;
}

function assertContextBinding(input: { contextKey: string; scopeType: PersistentBrowserScope; identityKey: string }, actual: { scopeType: PersistentBrowserScope; identityKey: string }): void {
  if (actual.scopeType !== input.scopeType || actual.identityKey !== input.identityKey) {
    throw new Error(`Browser context binding mismatch for ${input.contextKey}: existing ${actual.scopeType}:${actual.identityKey || '-'} cannot be reused as ${input.scopeType}:${input.identityKey || '-'}`);
  }
}

export function isRecoverableBrowserContextRecord(record: { status?: string; expires_at?: string | null } | null | undefined, nowMs = Date.now()): boolean {
  if (!record || record.status !== 'active') return false;
  if (!record.expires_at) return true;
  return new Date(record.expires_at).getTime() > nowMs;
}

export function browserContextKey(input: {
  scope_type?: PersistentBrowserScope;
  task_id?: string;
  identity_key?: string;
  context_key?: string;
}): { key: string; scope: PersistentBrowserScope; identity: string } {
  const scope = input.scope_type || (input.identity_key ? 'identity' : input.task_id ? 'task' : 'scan');
  const identity = String(input.identity_key || '');
  if (input.context_key) return { key: String(input.context_key), scope, identity };
  if (scope === 'identity') {
    if (!identity) throw new Error('identity_key is required for identity-scoped browser context');
    return { key: `identity:${identity}`, scope, identity };
  }
  if (scope === 'task') {
    if (!input.task_id) throw new Error('task_id is required for task-scoped browser context');
    return { key: `task:${input.task_id}`, scope, identity };
  }
  return { key: 'scan:default', scope: 'scan', identity };
}

async function closeLiveEntry(entry: LiveBrowserContext): Promise<void> {
  liveContexts.delete(liveKey(entry.scanRunId, entry.contextKey));
  await Promise.allSettled([...entry.pendingCaptures]);
  await entry.browserContext.close().catch(() => undefined);
  await entry.browser.close().catch(() => undefined);
  await entry.desktop?.close();
}

async function createLiveContext(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  scopeBaseUrl: string;
  contextKey: string;
  scopeType: PersistentBrowserScope;
  identityKey: string;
}): Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null> {
  const run = await input.repo.getRun(input.scanRunId);
  const authenticationOrigins = normalizeAuthenticationOrigins(run?.scan_config?.authentication_origins);
  const persisted = await input.repo.getBrowserContext(input.scanRunId, input.contextKey);
  if (persisted) {
    assertContextBinding(input, { scopeType: persisted.scope_type, identityKey: String(persisted.identity_key || '') });
    if(input.scopeType==='task' && persisted.task_id && persisted.task_id!==input.taskId)throw new Error('Browser task owner binding mismatch');
  }
  const recoverable = isRecoverableBrowserContextRecord(persisted);
  const expired = Boolean(persisted?.status === 'active' && !recoverable);
  if (expired && persisted) await input.repo.closeBrowserContextRecord(input.scanRunId, input.contextKey, 'expired').catch(() => undefined);
  const storageState = recoverable && persisted?.storage_state_json && Object.keys(persisted.storage_state_json).length > 0 ? persisted.storage_state_json : undefined;
  const {browser, desktop} = await chromiumBrowser(input.scanRunId, input.taskId);
  let browserContext: any; let page: any;
  try {
    browserContext = await browser.newContext({viewport:{width:desktop?.view.width || 1440, height:(desktop?.view.height || 1000) - 100}, ...(storageState ? {storageState} : {})});
    page = await browserContext.newPage();
  } catch (error) { await browser.close().catch(() => undefined); await desktop?.close(); throw error; }
  const entry: LiveBrowserContext = {
    scanRunId: input.scanRunId,
    contextKey: input.contextKey,
    scopeType: input.scopeType,
    identityKey: input.identityKey,
    taskOwnerId: input.taskId,
    browserContext, browser, desktop,
    page,
    networkEvents: [],
    lastUsedAt: Date.now(),
    operationTail: Promise.resolve(),
    pendingCaptures:new Set(),
    authenticationOrigins,
  };
  try {await installNavigationGuard(browserContext,page,input.scopeBaseUrl,authenticationOrigins,message=>{entry.navigationError=message;},()=>entry.operationSignal);}
  catch(error){await closeLiveEntry(entry);throw error;}
  const captureTask = input.taskId ? await input.repo.getTask(input.taskId) : null;
  const captureRequests = captureTask?.execution_plan?.intent === 'discover_target';
  function observePage(observed: any): void {
    const push = (event: Record<string, any>) => {
      entry.networkEvents.push({...event, at:new Date().toISOString()});
      if(entry.networkEvents.length>500)entry.networkEvents.splice(0,entry.networkEvents.length-500);
    };
    observed.on('request', (request:any)=>push({type:'request',method:request.method(),url:request.url(),resource_type:request.resourceType()}));
    observed.on('response', (response:any)=>push({type:'response',status:response.status(),url:response.url(),content_type:response.headers()?.['content-type']}));
    observed.on('response',(response:any)=>{
      if(!captureRequests || !['document','xhr','fetch'].includes(response.request().resourceType()))return;
      try{assertUrlInTargetScope(response.url(),input.scopeBaseUrl);}catch{return;}
      const save=(async()=>{
        const request=response.request(),url=new URL(request.url());
        const rawBody=request.postDataBuffer();
        const body=rawBody?.toString('utf8')??null;
        if(rawBody && !Buffer.from(body!,'utf8').equals(rawBody))return;
        if(body && Buffer.byteLength(body)>1024*1024)return;
        const headers=await request.allHeaders();
        const endpoint=await input.repo.upsertEndpoint({scan_run_id:input.scanRunId,method:request.method(),path:url.pathname,url:url.toString(),
          source_type:'browser_network',auth_required:!!(headers.authorization||headers.cookie),content_type:headers['content-type'],
          request_summary:`Observed ${request.method()} request`,response_summary:`HTTP ${response.status()}`});
        await input.repo.saveCapturedRequest(endpoint,{method:request.method(),url:url.toString(),headers,body:body??null,response_status:response.status(),captured_at:new Date().toISOString(),source:'browser'});
      })();
      entry.pendingCaptures.add(save);
      void save.catch(()=>undefined).finally(()=>entry.pendingCaptures.delete(save));
    });
    observed.on('requestfailed',(request:any)=>push({type:'request_failed',method:request.method(),url:request.url(),failure:request.failure()?.errorText||'unknown'}));
    observed.on('close',()=>{
      if(entry.page===observed){const remaining=browserContext.pages().filter((p:any)=>!p.isClosed());if(remaining.length){entry.page=remaining[remaining.length-1];void entry.page.bringToFront().catch(()=>undefined);}}
    });
  }
  observePage(page);
  desktop?.onClose(async () => {
    if (liveContexts.get(liveKey(entry.scanRunId, entry.contextKey)) === entry) liveContexts.delete(liveKey(entry.scanRunId, entry.contextKey));
    await browser.close().catch(() => undefined);
  });
  // Popups are real pages in this same isolated desktop, never another tenant's browser.
  browserContext.on('page', (opened: any) => { observePage(opened); entry.page = opened; void opened.bringToFront().catch(() => undefined); });
  liveContexts.set(liveKey(input.scanRunId, input.contextKey), entry);
  return { entry, recovered: Boolean(storageState), recordId: persisted?.id };
}

async function getOrCreateLiveContext(input: {
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  scopeBaseUrl: string;
  contextKey: string;
  scopeType: PersistentBrowserScope;
  identityKey: string;
}): Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null> {
  const key = liveKey(input.scanRunId, input.contextKey);
  if (closingContextKeys.has(key)) throw new Error(`Browser context is closing: ${input.contextKey}`);
  const existing = liveContexts.get(key);
  if (existing) {
    assertContextBinding(input, existing);
    if(input.scopeType==='task' && existing.taskOwnerId!==input.taskId)throw new Error('Browser task owner binding mismatch');
    // Do not evaluate TTL here: another Sub-Agent may currently be refreshing the
    // same context. Expiry is checked only after acquiring the per-context operation
    // lock so a queued caller can never close a page underneath an active navigation.
    existing.lastUsedAt = Date.now();
    const persisted = await input.repo.getBrowserContext(input.scanRunId, input.contextKey);
    return { entry: existing, recovered: false, recordId: persisted?.id };
  }
  const pending = contextCreationPromises.get(key);
  if (pending) {
    const result = await pending;
    if (result) {assertContextBinding(input, result.entry);if(input.scopeType==='task' && result.entry.taskOwnerId!==input.taskId)throw new Error('Browser task owner binding mismatch');}
    return result;
  }
  const creation = createLiveContext(input).finally(() => {
    if (contextCreationPromises.get(key) === creation) contextCreationPromises.delete(key);
  });
  contextCreationPromises.set(key, creation);
  return creation;
}

export async function navigatePersistentBrowser(input: {
  url: string;
  repo: AIScanRepository;
  scanRunId: string;
  taskId?: string;
  timeout_ms?: number;
  scope_base_url: string;
  signal?: AbortSignal;
  scope_type?: PersistentBrowserScope;
  identity_key?: string;
  context_key?: string;
  ttl_seconds?: number;
}): Promise<PersistentBrowserNavigationResult | null> {
  input={...input,signal:scanAbortSignal(input.signal)};
  assertUrlInTargetScope(input.url, input.scope_base_url);
  const context = browserContextKey({ scope_type: input.scope_type, task_id: input.taskId, identity_key: input.identity_key, context_key: input.context_key });
  const contextLiveKey = liveKey(input.scanRunId, context.key);
  if (closingContextKeys.has(contextLiveKey)) {
    return { ok: false, context_key: context.key, context_scope: context.scope, identity_key: context.identity || undefined, error: 'Persistent browser context is closing' };
  }
  let acquired: Awaited<ReturnType<typeof getOrCreateLiveContext>>;
  try {
    acquired = await getOrCreateLiveContext({ repo: input.repo, scanRunId: input.scanRunId, taskId: input.taskId, scopeBaseUrl: input.scope_base_url, contextKey: context.key, scopeType: context.scope, identityKey: context.identity });
  } catch (error: any) {
    assertScanActive();
    const message = error?.message || String(error);
    if (/binding mismatch|context is closing/i.test(message)) {
      return { ok: false, context_key: context.key, context_scope: context.scope, identity_key: context.identity || undefined, error: message };
    }
    throw error;
  }
  if (!acquired) return null;
  if (closingContextKeys.has(contextLiveKey)) {
    return { ok: false, context_key: context.key, context_scope: context.scope, identity_key: context.identity || undefined, error: 'Persistent browser context is closing' };
  }
  let { entry } = acquired;
  const previousOperation = entry.operationTail;
  let releaseOperation!: () => void;
  entry.operationTail = new Promise<void>(resolve => { releaseOperation = resolve; });
  await previousOperation;
  if (input.signal?.aborted) {
    releaseOperation();
    return { ok: false, context_key: context.key, context_scope: context.scope, identity_key: context.identity || undefined, error: 'Persistent browser navigation aborted before execution' };
  }
  // A previous queued operation may have closed/expired this context. Reacquire a fresh
  // context before touching its page; do not continue on a stale Playwright object.
  if (liveContexts.get(liveKey(input.scanRunId, context.key)) !== entry) {
    releaseOperation();
    return navigatePersistentBrowser(input);
  }
  // TTL is deliberately checked inside the operation lock. The preceding operation
  // may have just refreshed expires_at; checking before the lock could close an active
  // shared scan/identity context and cross-contaminate parallel Agent evidence.
  const persistedAfterWait = await input.repo.getBrowserContext(input.scanRunId, context.key);
  const expiredAfterWait = Boolean(persistedAfterWait?.status === 'active' && !isRecoverableBrowserContextRecord(persistedAfterWait));
  if (expiredAfterWait) {
    await closeLiveEntry(entry).catch(() => undefined);
    await input.repo.closeBrowserContextRecord(input.scanRunId, context.key, 'expired').catch(() => undefined);
    releaseOperation();
    return navigatePersistentBrowser(input);
  }
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    void entry.browserContext.close().catch(() => undefined);
  };
  entry.operationSignal=input.signal;
  input.signal?.addEventListener('abort', onAbort, { once: true });
  entry.desktop?.activity(input.taskId, true);
  try {
    entry.navigationError=undefined;
    const navigationStart=entry.networkEvents.length;
    await entry.page.bringToFront();
    await entry.page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: input.timeout_ms || 45000 });
    if (aborted) throw new Error('Persistent browser navigation aborted');
    await entry.page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>undefined);
    if(entry.navigationError)throw new Error(entry.navigationError);
    if(entry.page.url().startsWith('chrome-error:')){
      const failure=entry.networkEvents.slice(navigationStart).filter(event=>event.type==='request_failed').at(-1);
      throw new Error(`浏览器未能加载目标页面：${failure?.failure || 'Chromium navigation failed'}`);
    }
    assertBrowserNavigationUrl(entry.page.url(), input.scope_base_url, entry.authenticationOrigins);
    await Promise.allSettled([...entry.pendingCaptures]);
    assertScanActive();
    const title = await entry.page.title();
    const screenshot = await entry.page.screenshot({ type: 'png', fullPage: false, mask: [entry.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive]')] }).catch(() => null);
    const domSummary = await entry.page.evaluate(() => {
      const doc = (globalThis as any).document;
      const loc = (globalThis as any).location;
      return {
        title: doc.title,
        url: loc.href,
        links: Array.from(doc.querySelectorAll('a[href]')).slice(0, 100).map((a: any) => a.href),
        forms: Array.from(doc.querySelectorAll('form')).map((form: any) => ({ method: form.method, action: form.action, enctype: form.enctype, inputs: Array.from(form.querySelectorAll('input,textarea,select')).map((i: any) => ({ name: i.name, type: i.type, placeholder: i.placeholder })) })),
        buttons: Array.from(doc.querySelectorAll('button,input[type=button],input[type=submit]')).slice(0, 80).map((b: any) => b.innerText || b.value || b.getAttribute('aria-label')),
        local_storage_keys: Object.keys((globalThis as any).localStorage || {}),
        session_storage_keys: Object.keys((globalThis as any).sessionStorage || {}),
      };
    });
    const storageState = await entry.browserContext.storageState();
    const ttlSeconds = Math.max(60, Number(input.ttl_seconds || 3600));
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const record = await input.repo.upsertBrowserContext({
      scan_run_id: input.scanRunId,
      task_id: input.taskId,
      context_key: context.key,
      scope_type: context.scope,
      identity_key: context.identity,
      status: 'active',
      storage_state_json: storageState,
      current_url: domSummary.url || input.url,
      title,
      dom_summary_json: domSummary,
      network_summary_json: { recent_events: entry.networkEvents.slice(-120), total_buffered: entry.networkEvents.length },
      ttl_seconds: ttlSeconds,
      expires_at: expiresAt,
    });
    entry.lastUsedAt = Date.now();
    return {
      ok: true,
      current_url: domSummary.url || input.url,
      title,
      screenshot_base64: screenshot?.toString('base64'),
      dom_summary: domSummary,
      network_events: entry.networkEvents.slice(-300),
      context_key: context.key,
      context_id: record.id,
      context_scope: context.scope,
      identity_key: context.identity || undefined,
      recovered_from_storage_state: acquired.recovered,
    };
  } catch (error: any) {
    assertScanActive();
    const failureStorageState = await entry.browserContext.storageState().catch(() => ({}));
    await input.repo.upsertBrowserContext({
      scan_run_id: input.scanRunId,
      task_id: input.taskId,
      context_key: context.key,
      scope_type: context.scope,
      identity_key: context.identity,
      status: aborted ? 'failed' : 'active',
      storage_state_json: failureStorageState,
      last_error: entry.navigationError || error.message || String(error),
    }).catch(() => undefined);
    if (aborted) await closeLiveEntry(entry).catch(() => undefined);
    return { ok: false, context_key: context.key, context_scope: context.scope, identity_key: context.identity || undefined, error: entry.navigationError || error.message || String(error), network_events: entry.networkEvents.slice(-120) };
  } finally {
    entry.desktop?.activity(input.taskId, false);
    input.signal?.removeEventListener('abort', onAbort);
    releaseOperation();
  }
}

export async function closePersistentBrowserContext(repo: AIScanRepository, scanRunId: string, contextKey: string, markStatus: 'closed' | 'expired' | 'failed' = 'closed'): Promise<void> {
  const key = liveKey(scanRunId, contextKey);
  closingContextKeys.add(key);
  try {
    const pending = contextCreationPromises.get(key);
    if (pending) await pending.catch(() => null);
    const entry = liveContexts.get(key);
    if (entry) {
      await entry.operationTail.catch(() => undefined);
      const current = liveContexts.get(key);
      if (current) await closeLiveEntry(current);
    }
    await repo.closeBrowserContextRecord(scanRunId, contextKey, markStatus);
  } finally {
    closingContextKeys.delete(key);
  }
}

export async function closePersistentBrowserContextsForScan(repo: AIScanRepository, scanRunId: string, markStatus: 'closed' | 'expired' | 'failed' = 'closed'): Promise<number> {
  const prefix = `${scanRunId}:`;
  const keys = new Set<string>([
    ...[...liveContexts.keys()].filter(key => key.startsWith(prefix)),
    ...[...contextCreationPromises.keys()].filter(key => key.startsWith(prefix)),
  ]);
  for (const key of keys) closingContextKeys.add(key);
  try {
    const pending = [...contextCreationPromises.entries()].filter(([key]) => key.startsWith(prefix)).map(([, promise]) => promise.catch(() => null));
    if (pending.length > 0) await Promise.all(pending);
    const entries = [...liveContexts.values()].filter(entry => entry.scanRunId === scanRunId);
    for (const entry of entries) await entry.operationTail.catch(() => undefined);
    const currentEntries = [...liveContexts.values()].filter(entry => entry.scanRunId === scanRunId);
    for (const entry of currentEntries) await closeLiveEntry(entry);
    const records = await repo.listBrowserContexts(scanRunId);
    for (const record of records.filter(item => item.status === 'active')) await repo.closeBrowserContextRecord(scanRunId, record.context_key, markStatus);
    return currentEntries.length;
  } finally {
    for (const key of keys) closingContextKeys.delete(key);
  }
}

/** Release completed task-owned desktops promptly. Scan/identity contexts remain
 * shared and are released at scan completion or the bounded idle timeout. */
export async function closeTaskBrowserContexts(repo:AIScanRepository, scanRunId:string, taskId:string):Promise<number> {
  const owned=[...liveContexts.values()].filter(e=>e.scanRunId===scanRunId && e.scopeType==='task' && e.taskOwnerId===taskId);
  for(const entry of owned)await closePersistentBrowserContext(repo,scanRunId,entry.contextKey,'closed');
  return owned.length;
}

export function getLiveBrowserContextCount(scanRunId?: string): number {
  return [...liveContexts.values()].filter(entry => !scanRunId || entry.scanRunId === scanRunId).length;
}

export type BrowserInteraction =
  | {action:'click'; selector:string}
  | {action:'fill' | 'select'; selector:string; value:string}
  | {action:'press'; selector:string; key:string}
  | {action:'scroll'; x?:number; y:number}
  | {action:'assert'; selector:string; text?:string}
  | {action:'observe'};
/** Actions execute inside the already-created, streamed browser, never a viewer-owned copy. */
export async function interactPersistentBrowser(input: {
  repo: AIScanRepository; scanRunId:string; taskId?:string; context_key?:string;
  scope_type?:PersistentBrowserScope; identity_key?:string; scope_base_url:string;
  operation:BrowserInteraction; signal?:AbortSignal; timeout_ms?:number;
}): Promise<{ok:boolean; context_key:string; current_url?:string; observation?:Record<string,unknown>; error?:string; error_code?:string; match_count?:number}> {
  input={...input,signal:scanAbortSignal(input.signal)};
  const context=browserContextKey({context_key:input.context_key,scope_type:input.scope_type,task_id:input.taskId,identity_key:input.identity_key}); const key=liveKey(input.scanRunId,context.key);
  const entry=liveContexts.get(key);
  if(!entry || entry.desktop?.closed || closingContextKeys.has(key))return {ok:false,context_key:context.key,error:'Navigate this browser context before interacting.'};
  assertContextBinding({contextKey:context.key,scopeType:context.scope,identityKey:context.identity},entry);
  if(context.scope==='task' && entry.taskOwnerId!==input.taskId)return {ok:false,context_key:context.key,error:'Browser task owner binding mismatch'};
  const previous=entry.operationTail;let release!:()=>void;
  entry.operationTail=new Promise<void>(resolve=>{release=resolve;});await previous;
  const aborted=()=>{void entry.page.close().catch(()=>undefined);};
  try {
    entry.operationSignal=input.signal;
    if(input.signal?.aborted || entry.desktop?.closed || liveContexts.get(key)!==entry)throw new Error('Browser operation cancelled or context ended');
    assertUrlInTargetScope(entry.page.url(),input.scope_base_url);
    input.signal?.addEventListener('abort',aborted,{once:true});
    const op=input.operation;const timeout=Math.max(500,Math.min(30000,Number(input.timeout_ms)||10000));
    entry.desktop?.activity(input.taskId,true);await entry.page.bringToFront();
    let locator:any;
    if('selector' in op) {
      if(typeof op.selector!=='string' || !op.selector || op.selector.length>1000)throw new Error('A bounded, unique selector is required');
      locator=entry.page.locator(op.selector);await locator.first().waitFor({state:'visible',timeout});
      const matches=await locator.count();
      if(matches!==1)return {ok:false,context_key:context.key,error:'Selector must identify exactly one visible control',error_code:'selector_ambiguous',match_count:matches};
    }
    if(op.action==='click')await locator.click({timeout});
    else if(op.action==='fill' || op.action==='select') {
      if(typeof op.value!=='string' || op.value.length>10000)throw new Error('Invalid input length');
      if(op.action==='fill')await locator.fill(op.value,{timeout});else await locator.selectOption(op.value,{timeout});
    } else if(op.action==='press') {
      if(!['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Space'].includes(op.key))throw new Error('Unsupported business key');
      await locator.press(op.key,{timeout});
    } else if(op.action==='scroll') {
      if(!Number.isFinite(op.y) || (op.x!==undefined && !Number.isFinite(op.x)))throw new Error('Invalid scroll amount');
      await entry.page.mouse.wheel(Math.max(-3000,Math.min(3000,op.x||0)),Math.max(-3000,Math.min(3000,op.y)));
    } else if(op.action==='assert') {
      if(op.text!==undefined) {
        // Retry the assertion; a successful click alone is not a successful business test.
        const deadline=Date.now()+timeout;let matched=false;
        while(Date.now()<deadline && !input.signal?.aborted) {
          if((await locator.innerText()).includes(op.text)){matched=true;break;}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        if(!matched)throw new Error('Expected page text was not observed');
      }
    } else if(op.action!=='observe')throw new Error('Unsupported browser action');
    if(input.signal?.aborted)throw new Error('Browser operation cancelled');
    assertUrlInTargetScope(entry.page.url(),input.scope_base_url);
    const currentUrl=entry.page.url();const title=await entry.page.title();
    const observation = await entry.page.evaluate(() => {
      const doc=(globalThis as any).document;
      return {title:doc.title,url:(globalThis as any).location.href,visible_text:(doc.body?.innerText||'').slice(0,12000),
        controls:Array.from(doc.querySelectorAll('button,a[href],input,textarea,select,[role="button"]')).filter((e:any)=>e.getClientRects().length).slice(0,100).map((e:any)=>({
          tag:e.tagName.toLowerCase(),id:e.id,name:e.getAttribute('name'),role:e.getAttribute('role'),label:e.getAttribute('aria-label'),
          text:(e.tagName==='INPUT'?'':e.innerText||'').slice(0,160),placeholder:e.getAttribute('placeholder'),type:e.getAttribute('type'),
        }))}; // Never return input values, cookies or credentials as observation metadata.
    });
    await input.repo.upsertBrowserContext({scan_run_id:input.scanRunId,task_id:input.taskId,context_key:context.key,
      scope_type:context.scope,identity_key:context.identity,status:'active',current_url:currentUrl,title,
      storage_state_json:await entry.browserContext.storageState(),expires_at:new Date(Date.now()+3600000).toISOString()});
    const screenshot=await entry.page.screenshot({type:'png',fullPage:false,mask:[entry.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive]')]}).catch(()=>null);
    await input.repo.createArtifact({scan_run_id:input.scanRunId,task_id:input.taskId,artifact_type:'browser_state',title:'Business browser action evidence',
      content_json:{mode:'playwright',ok:true,action:op.action,current_url:currentUrl,observed_at:new Date().toISOString(),live_session_id:entry.desktop?.view.id},
      content_text:screenshot?.toString('base64'),source_ref:currentUrl});
    return {ok:true,context_key:context.key,current_url:currentUrl,observation};
  } catch(error:any) {assertScanActive();return {ok:false,context_key:context.key,error:error?.message||'Browser action failed'};}
  finally {entry.desktop?.activity(input.taskId,false);input.signal?.removeEventListener('abort',aborted);release();}
}

/** Serialize discovery actions against the same real page used by navigation.
 * The callback is trusted application code, never page-provided JavaScript. */
export async function withPersistentDiscoveryPage<T>(input: {
  repo:AIScanRepository;scanRunId:string;taskId?:string;scope_base_url:string;identity_key?:string;
}, operation:(page:any,context:any)=>Promise<T>):Promise<T> {
  assertScanActive();
  const signal=scanAbortSignal();
  const key=browserContextKey({task_id:input.taskId,identity_key:input.identity_key});
  const entry=liveContexts.get(liveKey(input.scanRunId,key.key));
  if(!entry)throw new Error('Navigate before interacting with the discovery browser.');
  const previous=entry.operationTail;
  let release!:()=>void;entry.operationTail=new Promise<void>(resolve=>{release=resolve;});
  await previous;
  const aborted=()=>{void entry.browserContext.close().catch(()=>undefined);};
  try {
    assertScanActive();
    entry.operationSignal=signal;
    signal?.addEventListener('abort',aborted,{once:true});
    if(liveContexts.get(liveKey(input.scanRunId,key.key))!==entry)throw new Error('Discovery browser was closed.');
    assertBrowserNavigationUrl(entry.page.url(),input.scope_base_url,entry.authenticationOrigins);
    const value=await operation(entry.page,entry.browserContext);
    assertScanActive();
    assertBrowserNavigationUrl(entry.page.url(),input.scope_base_url,entry.authenticationOrigins);
    await entry.page.waitForLoadState('networkidle',{timeout:2000}).catch(()=>undefined);
    await Promise.allSettled([...entry.pendingCaptures]);
    const frame=await entry.page.screenshot({type:'png',mask:[entry.page.locator('input[type="password"],input[autocomplete="one-time-code"],[data-sensitive]')]}).catch(()=>null);
    if(frame)await input.repo.createArtifact({scan_run_id:input.scanRunId,task_id:input.taskId,artifact_type:'browser_state',title:'Observed browser interaction',content_text:frame.toString('base64'),content_json:{current_url:entry.page.url(),observed_at:new Date().toISOString(),mode:'playwright'}});
    await input.repo.upsertBrowserContext({scan_run_id:input.scanRunId,task_id:input.taskId,context_key:key.key,scope_type:key.scope,identity_key:key.identity,status:'active',storage_state_json:await entry.browserContext.storageState(),current_url:entry.page.url(),ttl_seconds:3600,expires_at:new Date(Date.now()+3600000).toISOString()});
    return value;
  } catch(error) {assertScanActive();throw error;}
  finally {signal?.removeEventListener('abort',aborted);entry.lastUsedAt=Date.now();release();}
}
