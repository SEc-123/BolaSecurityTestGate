import { Router, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import {
  getLastTrace,
  clearLastTrace,
  exportTraceAsRawHTTP,
} from '../services/debug-trace.js';
import type { DebugTrace } from '../services/debug-trace.js';

const router = Router();

function publicTracePath(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.split('/').map(part => !part ? part : /^(?:\d+|[0-9a-f-]{8,}|[A-Za-z0-9_-]{20,})$/i.test(part) ? ':value' : ':segment').join('/') || '/';
  } catch { return '/'; }
}

/** Debug traces carry real HTTP material. The browser-facing endpoint exposes
 * operational facts only; raw capture stays in server memory/storage unless a
 * local operator explicitly enables its export. */
export function publicDebugTrace(trace: DebugTrace): Record<string, any> {
  return {
    run_meta: {
      kind: trace.run_meta.kind, run_id: trace.run_meta.run_id, test_run_id: trace.run_meta.test_run_id,
      started_at: trace.run_meta.started_at, finished_at: trace.run_meta.finished_at,
    },
    summary: { ...trace.summary }, truncated: trace.truncated === true,
    records: trace.records.map((record, index) => ({
      index: index + 1, timestamp: record.timestamp, method: String(record.method || 'GET').toUpperCase().slice(0, 16),
      path: publicTracePath(record.url), duration_ms: Math.max(0, Number(record.duration_ms || 0)), retry_attempt: Math.max(0, Number(record.retry_attempt || 0)),
      request: { header_names: Object.keys(record.headers || {}).map(name => name.toLowerCase()).slice(0, 80), body_present: Boolean(record.body), body_bytes: Buffer.byteLength(record.body || '') },
      response: record.response ? { status: record.response.status, header_names: Object.keys(record.response.headers || {}).map(name => name.toLowerCase()).slice(0, 80),
        body_present: Boolean(record.response.body), body_bytes: Buffer.byteLength(record.response.body || '') } : undefined,
      error: record.error ? 'Execution error; private diagnostic retained.' : undefined,
      meta: record.meta ? { step_order: record.meta.step_order, step_id: record.meta.step_id, template_id: record.meta.template_id, label: record.meta.label } : undefined,
    })),
  };
}

function rawTraceExportAuthorized(req: Request): boolean {
  if (process.env.BSTG_ENABLE_RAW_DEBUG_TRACE_EXPORT !== 'true') return false;
  const expected = process.env.BSTG_RAW_DEBUG_TRACE_EXPORT_TOKEN;
  const header = req.get('authorization');
  if (!expected || !header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expectedBytes = Buffer.from(expected);
  return supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes);
}

router.get('/last/:kind', async (req: Request, res: Response) => {
  try {
    const kind = req.params.kind as 'workflow' | 'template';
    if (kind !== 'workflow' && kind !== 'template') {
      return res.status(400).json({ data: null, error: 'Invalid kind. Must be "workflow" or "template"' });
    }

    const trace = getLastTrace(kind);
    if (!trace) {
      return res.status(404).json({ data: null, error: `No trace found for ${kind}` });
    }

    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: publicDebugTrace(trace), error: null });
  } catch (error: any) {
    console.error('Get last trace error:', error);
    res.status(500).json({ data: null, error: 'Unable to read debug trace.' });
  }
});

router.delete('/last/:kind', async (req: Request, res: Response) => {
  try {
    const kind = req.params.kind as 'workflow' | 'template';
    if (kind !== 'workflow' && kind !== 'template') {
      return res.status(400).json({ data: null, error: 'Invalid kind. Must be "workflow" or "template"' });
    }

    clearLastTrace(kind);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ data: { success: true }, error: null });
  } catch (error: any) {
    console.error('Clear last trace error:', error);
    res.status(500).json({ data: null, error: error.message });
  }
});

router.get('/last/:kind/export', async (req: Request, res: Response) => {
  try {
    const kind = req.params.kind as 'workflow' | 'template';
    const format = (req.query.format as string) || 'json';

    if (kind !== 'workflow' && kind !== 'template') {
      return res.status(400).json({ data: null, error: 'Invalid kind. Must be "workflow" or "template"' });
    }

    const validFormats = ['json', 'txt', 'raw', 'http'];
    if (!validFormats.includes(format)) {
      return res.status(400).json({ data: null, error: 'Invalid format. Must be "json", "txt", "raw", or "http"' });
    }

    const trace = getLastTrace(kind);
    if (!trace) {
      return res.status(404).json({ data: null, error: `No trace found for ${kind}` });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fileExt = (format === 'raw' || format === 'http') ? 'txt' : format;
    const filename = `debug-trace-${kind}-${timestamp}.${fileExt}`;

    if ((format === 'raw' || format === 'http') && !rawTraceExportAuthorized(req)) {
      return res.status(403).json({ data: null, error: 'Raw debug trace export is not authorized.' });
    }
    if (format === 'json') {
      const content = JSON.stringify(publicDebugTrace(trace), null, 2);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(content);
    } else if (format === 'raw' || format === 'http') {
      const content = exportTraceAsRawHTTP(trace);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(content);
    } else {
      const content = JSON.stringify(publicDebugTrace(trace), null, 2);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.send(content);
    }
  } catch (error: any) {
    console.error('Export trace error:', error);
    res.status(500).json({ data: null, error: 'Unable to export debug trace.' });
  }
});

export default router;
