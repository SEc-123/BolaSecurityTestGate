import { Router, Request, Response } from 'express';
import {
  getLastTrace,
  clearLastTrace,
  exportTraceAsJSON,
  exportTraceAsTXT,
} from '../services/debug-trace.js';

const router = Router();

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

    res.json({ data: trace, error: null });
  } catch (error: any) {
    console.error('Get last trace error:', error);
    res.status(500).json({ data: null, error: error.message });
  }
});

router.delete('/last/:kind', async (req: Request, res: Response) => {
  try {
    const kind = req.params.kind as 'workflow' | 'template';
    if (kind !== 'workflow' && kind !== 'template') {
      return res.status(400).json({ data: null, error: 'Invalid kind. Must be "workflow" or "template"' });
    }

    clearLastTrace(kind);
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

    if (format !== 'json' && format !== 'txt') {
      return res.status(400).json({ data: null, error: 'Invalid format. Must be "json" or "txt"' });
    }

    const trace = getLastTrace(kind);
    if (!trace) {
      return res.status(404).json({ data: null, error: `No trace found for ${kind}` });
    }

    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const filename = `debug-trace-${kind}-${timestamp}.${format}`;

    if (format === 'json') {
      const content = exportTraceAsJSON(trace);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    } else {
      const content = exportTraceAsTXT(trace);
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(content);
    }
  } catch (error: any) {
    console.error('Export trace error:', error);
    res.status(500).json({ data: null, error: error.message });
  }
});

export default router;
