/** Invalidation only; authoritative state is in the database. No tool payloads on this bus. */
export class ProductEventHub {
  private listeners = new Map<string, Set<() => void>>();
  publish(runId: string): void {
    for (const fn of [...(this.listeners.get(runId) || [])]) { try { fn(); } catch { /* a broken viewer must not break a test */ } }
  }
  subscribe(runId: string, fn: () => void): () => void {
    const listeners = this.listeners.get(runId) || new Set<() => void>();
    listeners.add(fn); this.listeners.set(runId, listeners);
    return () => { listeners.delete(fn); if (!listeners.size) this.listeners.delete(runId); };
  }
  count(runId: string): number { return this.listeners.get(runId)?.size || 0; }
}
export const productEventHub = new ProductEventHub();
