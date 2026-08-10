import type { AIScanRepository } from '../repository.js';
import { assertUrlInTargetScope, isBrowserResourceInTargetScope } from '../target-scope.js';
import { acquireScanTrafficPermit, type ScanTrafficLease } from '../scan-traffic-governor.js';

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;

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
  browserContext: any;
  page: any;
  trafficLeases: Map<any, ScanTrafficLease>;
  networkEvents: Record<string, any>[];
  lastUsedAt: number;
  operationTail: Promise<void>;
}

const liveContexts = new Map<string, LiveBrowserContext>();
const contextCreationPromises = new Map<string, Promise<{ entry: LiveBrowserContext; recovered: boolean; recordId?: string } | null>>();
const closingContextKeys = new Set<string>();
let browserPromise: Promise<any> | null = null;

async function chromiumBrowser(): Promise<any | null> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const playwright = await dynamicImport('playwright').catch(() => null);
    if (!playwright?.chromium) return null;
    return playwright.chromium.launch({ headless: true });
  })();
  const browser = await browserPromise;
  if (!browser) browserPromise = null;
  return browser;
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

async function releaseLease(entry: LiveBrowserContext, request: any): Promise<void> {
  const lease = entry.trafficLeases.get(request);
  if (!lease) return;
  entry.trafficLeases.delete(request);
  await lease.release().catch(() => undefined);
}

async function closeLiveEntry(entry: LiveBrowserContext): Promise<void> {
  for (const lease of entry.trafficLeases.values()) await lease.release().catch(() => undefined);
  entry.trafficLeases.clear();
  await entry.browserContext.close().catch(() => undefined);
  liveContexts.delete(liveKey(entry.scanRunId, entry.contextKey));
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
  const browser = await chromiumBrowser();
  if (!browser) return null;
  const persisted = await input.repo.getBrowserContext(input.scanRunId, input.contextKey);
  if (persisted) {
    assertContextBinding(input, { scopeType: persisted.scope_type, identityKey: String(persisted.identity_key || '') });
  }
  const recoverable = isRecoverableBrowserContextRecord(persisted);
  const expired = Boolean(persisted?.status === 'active' && !recoverable);
  if (expired && persisted) await input.repo.closeBrowserContextRecord(input.scanRunId, input.contextKey, 'expired').catch(() => undefined);
  const storageState = recoverable && persisted?.storage_state_json && Object.keys(persisted.storage_state_json).length > 0 ? persisted.storage_state_json : undefined;
  const browserContext = await browser.newContext(storageState ? { storageState } : {});
  const page = await browserContext.newPage();
  const entry: LiveBrowserContext = {
    scanRunId: input.scanRunId,
    contextKey: input.contextKey,
    scopeType: input.scopeType,
    identityKey: input.identityKey,
    browserContext,
    page,
    trafficLeases: new Map(),
    networkEvents: [],
    lastUsedAt: Date.now(),
    operationTail: Promise.resolve(),
  };
  await browserContext.route('**/*', async (route: any) => {
    const request = route.request();
    const requestUrl = request.url();
    if (!isBrowserResourceInTargetScope(requestUrl, input.scopeBaseUrl)) {
      await route.abort('blockedbyclient');
      return;
    }
    const protocol = (() => { try { return new URL(requestUrl).protocol; } catch { return ''; } })();
    if (['data:', 'blob:', 'about:'].includes(protocol)) {
      await route.continue();
      return;
    }
    let lease: ScanTrafficLease;
    try {
      lease = await acquireScanTrafficPermit({ url: requestUrl, method: request.method(), traffic_class: 'browser' });
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    entry.trafficLeases.set(request, lease);
    try {
      await route.continue();
    } catch (error) {
      await releaseLease(entry, request);
      throw error;
    }
  });
  page.on('request', (request: any) => {
    entry.networkEvents.push({ type: 'request', method: request.method(), url: request.url(), resource_type: request.resourceType(), at: new Date().toISOString() });
    if (entry.networkEvents.length > 500) entry.networkEvents.splice(0, entry.networkEvents.length - 500);
  });
  page.on('response', (response: any) => {
    entry.networkEvents.push({ type: 'response', status: response.status(), url: response.url(), content_type: response.headers()?.['content-type'], at: new Date().toISOString() });
    if (entry.networkEvents.length > 500) entry.networkEvents.splice(0, entry.networkEvents.length - 500);
    void releaseLease(entry, response.request());
  });
  page.on('requestfailed', (request: any) => { void releaseLease(entry, request); });
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
    if (result) assertContextBinding(input, result.entry);
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
    void entry.page.evaluate(() => { try { (globalThis as any).stop?.(); } catch {} }).catch(() => undefined);
  };
  input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await entry.page.goto(input.url, { waitUntil: 'networkidle', timeout: input.timeout_ms || 45000 });
    if (aborted) throw new Error('Persistent browser navigation aborted');
    const title = await entry.page.title();
    const screenshot = await entry.page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
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
    const failureStorageState = await entry.browserContext.storageState().catch(() => ({}));
    await input.repo.upsertBrowserContext({
      scan_run_id: input.scanRunId,
      task_id: input.taskId,
      context_key: context.key,
      scope_type: context.scope,
      identity_key: context.identity,
      status: aborted ? 'failed' : 'active',
      storage_state_json: failureStorageState,
      last_error: error.message || String(error),
    }).catch(() => undefined);
    if (aborted) await closeLiveEntry(entry).catch(() => undefined);
    return { ok: false, context_key: context.key, context_scope: context.scope, identity_key: context.identity || undefined, error: error.message || String(error) };
  } finally {
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

export function getLiveBrowserContextCount(scanRunId?: string): number {
  return [...liveContexts.values()].filter(entry => !scanRunId || entry.scanRunId === scanRunId).length;
}
