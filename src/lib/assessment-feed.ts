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
}): { refresh: () => Promise<void>; setOnline: (online: boolean) => void; close: () => void } {
  let closed = false, busy = false, eventVersion = 0, connected = false, online = true;
  let abort: AbortController | undefined;
  let source: AssessmentEventSource | undefined;
  const valid = (value: ProductAssessmentState) => value?.version === 2 && value.run?.id === input.runId && Array.isArray(value.business_functions);
  async function refresh() {
    if (closed || busy || !online) return;
    busy = true; const before = eventVersion; const requestAbort = new AbortController(); abort = requestAbort;
    try {
      const state = await input.read(requestAbort.signal);
      if (!closed && online && before === eventVersion && valid(state)) {
        input.onState(state);
        if (!connected) input.onConnection('polling');
      }
    } catch { if (!closed && !connected) input.onConnection('offline'); }
    finally { busy = false; }
  }
  input.onConnection('connecting');
  function openSource() {
    if (input.createSource && !closed && online) {
      try {
        const current = input.createSource(input.url); source = current;
        const active = () => !closed && online && source === current;
        current.onopen = () => { if (active()) { connected = true; input.onConnection('live'); } };
        current.onerror = () => { if (active()) { connected = false; input.onConnection('reconnecting'); void refresh(); } };
        current.addEventListener('assessment', event => {
          if (!active()) return;
          try {
            const state = JSON.parse(event.data) as ProductAssessmentState;
            if (!valid(state)) return;
            eventVersion++; connected = true; input.onConnection('live'); input.onState(state);
          } catch { connected = false; input.onConnection('reconnecting'); }
        });
        current.addEventListener('unavailable', () => { if (active()) { connected = false; input.onConnection('reconnecting'); void refresh(); } });
      } catch { input.onConnection('reconnecting'); }
    }
  }
  openSource();
  void refresh();
  const timer = setInterval(() => { if (!connected) void refresh(); }, input.pollMs ?? 3000);
  return { refresh, setOnline: value => {
    if (closed || online === value) return;
    online = value; connected = false; eventVersion++;
    source?.close(); source = undefined;
    if (!online) { abort?.abort(); input.onConnection('offline'); }
    else { input.onConnection('reconnecting'); openSource(); void refresh(); }
  }, close: () => { closed = true; abort?.abort(); clearInterval(timer); source?.close(); } };
}
