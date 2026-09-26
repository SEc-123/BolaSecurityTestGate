import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProductAssessmentState } from './product-state-types.js';

/** Subscribe before the first read; coalesce invalidations, and resync from the database after reconnect.
 * Slow readers never accumulate screenshots/events in a per-client buffer. SSE contains image URLs only. */
export function streamProductState(input: {
  req: IncomingMessage; res: ServerResponse;
  read: () => Promise<ProductAssessmentState>;
  subscribe: (listener: () => void) => () => void;
  pollMs?: number; heartbeatMs?: number;
}): () => void {
  const { req, res } = input;
  let closed = false, reading = false, dirty = true, backpressure = false;
  let previous = '', first = true;
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
  res.flushHeaders();
  res.write('retry: 1500\n\n');
  async function flush() {
    if (closed || reading || backpressure || !dirty) return;
    reading = true; dirty = false;
    try {
      const state = await input.read();
      if (closed) return;
      const payload = JSON.stringify(state);
      const revision = createHash('sha256').update(payload).digest('hex');
      if (first || previous !== revision) {
        backpressure = !res.write(`id: ${revision}\nevent: assessment\ndata: ${payload}\n\n`);
        previous = revision; first = false;
      }
    } catch {
      first = true; // The next successful read must recover the client connection state.
      if (!closed && !backpressure) backpressure = !res.write('event: unavailable\ndata: {"message":"暂时无法读取测试状态，正在重新连接。"}\n\n');
    } finally {
      reading = false;
      if (dirty && !closed && !backpressure) queueMicrotask(() => void flush());
    }
  }
  const refresh = () => { dirty = true; void flush(); };
  const unsubscribe = input.subscribe(refresh);
  const poll = setInterval(refresh, input.pollMs ?? 1500);
  const heartbeat = setInterval(() => {
    if (!closed && !backpressure) backpressure = !res.write(': heartbeat\n\n');
  }, input.heartbeatMs ?? 15000);
  poll.unref?.(); heartbeat.unref?.();
  const drain = () => { backpressure = false; refresh(); };
  const close = () => {
    if (closed) return;
    closed = true; unsubscribe(); clearInterval(poll); clearInterval(heartbeat);
    res.off('drain', drain); res.off('close', close); req.off('aborted', close);
  };
  res.on('drain', drain); res.on('close', close); req.on('aborted', close);
  void flush();
  return close;
}
