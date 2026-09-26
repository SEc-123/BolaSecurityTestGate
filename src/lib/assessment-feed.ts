import type { ProductAssessmentState } from '../types/assessment';
export type ConnectionState = 'connecting' | 'live' | 'polling' | 'reconnecting' | 'offline';
export interface AssessmentEventSource {
  onopen: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  addEventListener(type: string, listener: (event: {data: string}) => void): void;
  close(): void;
}
/** Testable lifecycle: no old-run results, overlapping polls, or slow HTTP snapshots overwriting newer SSE. */
export function connectAssessment(input: {
  runId: string; url: string;
  read: (signal: AbortSignal) => Promise<ProductAssessmentState>;
  createSource?: (url: string) => AssessmentEventSource;
  onState: (state: ProductAssessmentState) => void;
  onConnection: (state: ConnectionState) => void;
  pollMs?: number;
}): { refresh: () => Promise<void>; close: () => void } {
  let closed = false, busy = false, eventVersion = 0, connected = false;
  const abort = new AbortController();
  let source: AssessmentEventSource | undefined;
  const valid = (value: ProductAssessmentState) => value?.version === 2 && value.run?.id === input.runId && Array.isArray(value.business_functions);
  async function refresh() {
    if (closed || busy) return;
    busy = true; const before = eventVersion;
    try {
      const state = await input.read(abort.signal);
      if (!closed && before === eventVersion && valid(state)) {
        input.onState(state);
        if (!connected) input.onConnection('polling');
      }
    } catch { if (!closed && !connected) input.onConnection('offline'); }
    finally { busy = false; }
  }
  input.onConnection('connecting');
  if (input.createSource) {
    try {
      source = input.createSource(input.url);
      source.onopen = () => { if (!closed) { connected = true; input.onConnection('live'); } };
      source.onerror = () => { if (!closed) { connected = false; input.onConnection('reconnecting'); void refresh(); } };
      source.addEventListener('assessment', event => {
        if (closed) return;
        try {
          const state = JSON.parse(event.data) as ProductAssessmentState;
          if (!valid(state)) return;
          eventVersion++; connected = true; input.onConnection('live'); input.onState(state);
        } catch { connected = false; input.onConnection('reconnecting'); }
      });
      source.addEventListener('unavailable', () => { if (!closed) { connected = false; input.onConnection('reconnecting'); void refresh(); } });
    } catch { input.onConnection('reconnecting'); }
  }
  void refresh();
  const timer = setInterval(() => { if (!connected) void refresh(); }, input.pollMs ?? 3000);
  return { refresh, close: () => { closed = true; abort.abort(); clearInterval(timer); source?.close(); } };
}
