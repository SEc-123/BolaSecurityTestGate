import { AsyncLocalStorage } from 'node:async_hooks';

export type ScanTrafficClass = 'read' | 'mutation' | 'upload' | 'account_creation' | 'browser';

export interface ScanTrafficLimits {
  max_concurrency: number;
  requests_per_second: number;
  burst: number;
  max_total_requests: number;
  max_endpoint_requests: number;
  max_mutation_requests: number;
  max_upload_requests: number;
  max_account_creation_requests: number;
}

export interface ScanTrafficEvent {
  type: 'admitted' | 'released' | 'blocked';
  scan_run_id: string;
  traffic_class: ScanTrafficClass;
  method: string;
  url: string;
  endpoint_key: string;
  reason?: string;
  snapshot: ScanTrafficSnapshot;
}

export interface ScanTrafficSnapshot {
  scan_run_id: string;
  in_flight: number;
  total_requests: number;
  class_counts: Record<ScanTrafficClass, number>;
  endpoint_counts: Record<string, number>;
  limits: ScanTrafficLimits;
}

interface TrafficState {
  scan_run_id: string;
  limits: ScanTrafficLimits;
  in_flight: number;
  total_requests: number;
  class_counts: Record<ScanTrafficClass, number>;
  endpoint_counts: Map<string, number>;
  tokens: number;
  last_refill_ms: number;
}

interface TrafficContext {
  scan_run_id: string;
  limits: ScanTrafficLimits;
  default_class?: ScanTrafficClass;
  signal?: AbortSignal;
  on_event?: (event: ScanTrafficEvent) => void | Promise<void>;
}

export interface TrafficRequestMeta {
  url: string;
  method?: string;
  traffic_class?: ScanTrafficClass;
  endpoint_key?: string;
}

export interface ScanTrafficLease {
  release: () => Promise<void>;
}

export class ScanTrafficBudgetError extends Error {
  readonly code = 'SCAN_TRAFFIC_BUDGET_EXCEEDED';
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = 'ScanTrafficBudgetError';
  }
}

export class ScanTrafficAbortError extends Error {
  readonly code = 'SCAN_TRAFFIC_ABORTED';
  constructor(message = 'AI scan traffic request aborted') {
    super(message);
    this.name = 'ScanTrafficAbortError';
  }
}

const storage = new AsyncLocalStorage<TrafficContext>();
const states = new Map<string, TrafficState>();

const DEFAULT_LIMITS: ScanTrafficLimits = {
  max_concurrency: 8,
  requests_per_second: 12,
  burst: 12,
  max_total_requests: 5000,
  max_endpoint_requests: 250,
  max_mutation_requests: 2500,
  max_upload_requests: 80,
  max_account_creation_requests: 12,
};

function positiveNumber(value: unknown, fallback: number, min = 1, max = Number.POSITIVE_INFINITY): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function normalizeScanTrafficLimits(value: unknown): ScanTrafficLimits {
  const input = value && typeof value === 'object' ? value as Record<string, any> : {};
  const requestsPerSecond = positiveNumber(input.requests_per_second, DEFAULT_LIMITS.requests_per_second, 1, 500);
  return {
    max_concurrency: positiveNumber(input.max_concurrency, DEFAULT_LIMITS.max_concurrency, 1, 128),
    requests_per_second: requestsPerSecond,
    burst: positiveNumber(input.burst, Math.max(DEFAULT_LIMITS.burst, requestsPerSecond), 1, 1000),
    max_total_requests: positiveNumber(input.max_total_requests, DEFAULT_LIMITS.max_total_requests, 1, 1_000_000),
    max_endpoint_requests: positiveNumber(input.max_endpoint_requests, DEFAULT_LIMITS.max_endpoint_requests, 1, 100_000),
    max_mutation_requests: positiveNumber(input.max_mutation_requests, DEFAULT_LIMITS.max_mutation_requests, 1, 1_000_000),
    max_upload_requests: positiveNumber(input.max_upload_requests, DEFAULT_LIMITS.max_upload_requests, 1, 100_000),
    max_account_creation_requests: positiveNumber(input.max_account_creation_requests, DEFAULT_LIMITS.max_account_creation_requests, 1, 10_000),
  };
}

function emptyClassCounts(): Record<ScanTrafficClass, number> {
  return { read: 0, mutation: 0, upload: 0, account_creation: 0, browser: 0 };
}

function getOrCreateState(scanRunId: string, limits: ScanTrafficLimits): TrafficState {
  const existing = states.get(scanRunId);
  if (existing) {
    existing.limits = limits;
    existing.tokens = Math.min(existing.tokens, limits.burst);
    return existing;
  }
  const state: TrafficState = {
    scan_run_id: scanRunId,
    limits,
    in_flight: 0,
    total_requests: 0,
    class_counts: emptyClassCounts(),
    endpoint_counts: new Map(),
    tokens: limits.burst,
    last_refill_ms: Date.now(),
  };
  states.set(scanRunId, state);
  return state;
}

function refill(state: TrafficState): void {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, now - state.last_refill_ms) / 1000;
  state.tokens = Math.min(state.limits.burst, state.tokens + elapsedSeconds * state.limits.requests_per_second);
  state.last_refill_ms = now;
}

function endpointKey(meta: TrafficRequestMeta): string {
  if (meta.endpoint_key) return meta.endpoint_key;
  try {
    const url = new URL(meta.url);
    return `${String(meta.method || 'GET').toUpperCase()} ${url.origin}${url.pathname}`;
  } catch {
    return `${String(meta.method || 'GET').toUpperCase()} ${meta.url}`;
  }
}

function inferClass(meta: TrafficRequestMeta, defaultClass?: ScanTrafficClass): ScanTrafficClass {
  if (meta.traffic_class) return meta.traffic_class;
  if (defaultClass) return defaultClass;
  const method = String(meta.method || 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS' ? 'read' : 'mutation';
}

function snapshot(state: TrafficState): ScanTrafficSnapshot {
  return {
    scan_run_id: state.scan_run_id,
    in_flight: state.in_flight,
    total_requests: state.total_requests,
    class_counts: { ...state.class_counts },
    endpoint_counts: Object.fromEntries(state.endpoint_counts.entries()),
    limits: { ...state.limits },
  };
}

async function emit(context: TrafficContext, event: Omit<ScanTrafficEvent, 'scan_run_id' | 'snapshot'>, state: TrafficState): Promise<void> {
  if (!context.on_event) return;
  await context.on_event({ ...event, scan_run_id: context.scan_run_id, snapshot: snapshot(state) });
}


function throwIfAborted(context: TrafficContext): void {
  if (context.signal?.aborted) throw new ScanTrafficAbortError();
}

async function sleepWithAbort(ms: number, context: TrafficContext): Promise<void> {
  throwIfAborted(context);
  if (!context.signal) {
    await new Promise(resolve => setTimeout(resolve, ms));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      context.signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onAbort);
      reject(new ScanTrafficAbortError());
    };
    context.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function budgetViolation(state: TrafficState, trafficClass: ScanTrafficClass, key: string): string | null {
  if (state.total_requests >= state.limits.max_total_requests) return 'max_total_requests';
  if ((state.endpoint_counts.get(key) || 0) >= state.limits.max_endpoint_requests) return 'max_endpoint_requests';
  if (trafficClass === 'mutation' && state.class_counts.mutation >= state.limits.max_mutation_requests) return 'max_mutation_requests';
  if (trafficClass === 'upload' && state.class_counts.upload >= state.limits.max_upload_requests) return 'max_upload_requests';
  if (trafficClass === 'account_creation' && state.class_counts.account_creation >= state.limits.max_account_creation_requests) return 'max_account_creation_requests';
  return null;
}

export async function acquireScanTrafficPermit(meta: TrafficRequestMeta): Promise<ScanTrafficLease> {
  const context = storage.getStore();
  if (!context) return { release: async () => undefined };
  throwIfAborted(context);
  const state = getOrCreateState(context.scan_run_id, context.limits);
  const trafficClass = inferClass(meta, context.default_class);
  const method = String(meta.method || 'GET').toUpperCase();
  const key = endpointKey({ ...meta, method });

  const violation = budgetViolation(state, trafficClass, key);
  if (violation) {
    await emit(context, { type: 'blocked', traffic_class: trafficClass, method, url: meta.url, endpoint_key: key, reason: violation }, state);
    throw new ScanTrafficBudgetError(violation, `AI scan traffic budget exceeded: ${violation} for ${method} ${meta.url}`);
  }

  for (;;) {
    refill(state);
    if (state.in_flight < state.limits.max_concurrency && state.tokens >= 1) break;
    const tokenWait = state.tokens >= 1 ? 10 : Math.max(10, Math.ceil((1 - state.tokens) / state.limits.requests_per_second * 1000));
    await sleepWithAbort(Math.min(250, tokenWait), context);
  }

  throwIfAborted(context);
  // Re-check hard budgets after awaiting because parallel workers may have consumed them.
  const postWaitViolation = budgetViolation(state, trafficClass, key);
  if (postWaitViolation) {
    await emit(context, { type: 'blocked', traffic_class: trafficClass, method, url: meta.url, endpoint_key: key, reason: postWaitViolation }, state);
    throw new ScanTrafficBudgetError(postWaitViolation, `AI scan traffic budget exceeded: ${postWaitViolation} for ${method} ${meta.url}`);
  }

  refill(state);
  state.tokens = Math.max(0, state.tokens - 1);
  state.in_flight += 1;
  state.total_requests += 1;
  state.class_counts[trafficClass] += 1;
  state.endpoint_counts.set(key, (state.endpoint_counts.get(key) || 0) + 1);
  await emit(context, { type: 'admitted', traffic_class: trafficClass, method, url: meta.url, endpoint_key: key }, state);

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      state.in_flight = Math.max(0, state.in_flight - 1);
      await emit(context, { type: 'released', traffic_class: trafficClass, method, url: meta.url, endpoint_key: key }, state);
    },
  };
}

export async function withScanTrafficPermit<T>(meta: TrafficRequestMeta, fn: () => Promise<T>): Promise<T> {
  const lease = await acquireScanTrafficPermit(meta);
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}

export async function runWithScanTrafficContext<T>(input: {
  scan_run_id: string;
  limits?: unknown;
  default_class?: ScanTrafficClass;
  signal?: AbortSignal;
  on_event?: TrafficContext['on_event'];
}, fn: () => Promise<T>): Promise<T> {
  const limits = normalizeScanTrafficLimits(input.limits);
  return storage.run({ scan_run_id: input.scan_run_id, limits, default_class: input.default_class, signal: input.signal, on_event: input.on_event }, fn);
}

export function getScanTrafficAbortSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

export function hydrateScanTrafficState(scanRunId: string, value: unknown, limitsOverride?: unknown): ScanTrafficSnapshot | null {
  if (states.has(scanRunId)) return getScanTrafficSnapshot(scanRunId);
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<ScanTrafficSnapshot>;
  const limits = normalizeScanTrafficLimits(limitsOverride || input.limits);
  const classCounts = emptyClassCounts();
  for (const key of Object.keys(classCounts) as ScanTrafficClass[]) {
    classCounts[key] = Math.max(0, Number(input.class_counts?.[key] || 0));
  }
  const endpointCounts = new Map<string, number>();
  for (const [key, count] of Object.entries(input.endpoint_counts || {})) endpointCounts.set(key, Math.max(0, Number(count || 0)));
  const state: TrafficState = {
    scan_run_id: scanRunId,
    limits,
    in_flight: 0,
    total_requests: Math.max(0, Number(input.total_requests || 0)),
    class_counts: classCounts,
    endpoint_counts: endpointCounts,
    tokens: limits.burst,
    last_refill_ms: Date.now(),
  };
  states.set(scanRunId, state);
  return snapshot(state);
}

export function getScanTrafficSnapshot(scanRunId: string): ScanTrafficSnapshot | null {
  const state = states.get(scanRunId);
  return state ? snapshot(state) : null;
}

export function resetScanTrafficState(scanRunId?: string): void {
  if (scanRunId) states.delete(scanRunId);
  else states.clear();
}
