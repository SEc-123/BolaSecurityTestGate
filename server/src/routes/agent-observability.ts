/* BSTG style: live evidence stream; the browser sees metadata and summaries, never credentials or raw secrets. */
import { Router, type Request, type Response } from 'express';
import { agentEventBus } from '../observability/agent-event-bus.js';
import { dbManager } from '../db/db-manager.js';
import { AIScanRepository } from '../services/ai-scan/repository.js';

const router = Router();

async function loadPersistedEvents(scanRunId: string): Promise<any[]> {
  try {
    const snapshot = await new AIScanRepository(dbManager.getActive()).getSnapshot(scanRunId);
    const events: any[] = [];
    for (const decision of snapshot.planner_decisions || []) {
      const decisionJson: any = decision.decision_json || {};
      const at = decision.created_at || new Date().toISOString();
      events.push({
        id: `persisted-decision-${decision.id}`,
        at,
        kind: 'agent_state_changed',
        status: decision.validation_status === 'fallback' ? 'failed' : 'completed',
        scan_run_id: scanRunId,
        task_id: decision.task_id,
        provider_id: decisionJson.provider_id,
        model: decisionJson.model,
        summary: `已回放真实 Agent 决策：source=${decision.source}; action=${decisionJson.action || 'unknown'}${decisionJson.tool_name ? `; tool=${decisionJson.tool_name}` : ''}; validation=${decision.validation_status || 'unknown'}`,
        error: decision.rejection_reason,
      });
    }
    for (const invocation of snapshot.tool_invocations || []) {
      const startedAt = invocation.started_at || invocation.created_at || new Date().toISOString();
      const endedAt = invocation.completed_at || invocation.updated_at || startedAt;
      const duration = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
      const output: any = invocation.output_json || {};
      const failed = invocation.status === 'failed';
      events.push({
        id: `persisted-tool-${invocation.id}`,
        at: endedAt,
        kind: 'agent_tool_completed',
        status: failed ? 'failed' : 'completed',
        scan_run_id: scanRunId,
        task_id: invocation.task_id,
        tool_name: invocation.tool_name,
        duration_ms: Number.isFinite(duration) ? duration : undefined,
        summary: (typeof (output.summary || output.message) === 'string' ? (output.summary || output.message) : JSON.stringify(output.summary || output.message || `已回放真实工具调用：${invocation.tool_name}`)).slice(0, 500),
        error: failed ? String(invocation.error_message || output.error || '').slice(0, 500) : undefined,
      });
    }
    return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  } catch {
    return [];
  }
}

router.get('/runs/:runId/events/snapshot', async (req: Request, res: Response) => {
  const scanRunId = String(req.params.runId);
  const afterId = req.query.after_id ? String(req.query.after_id) : undefined;
  const live = agentEventBus.list(scanRunId, afterId);
  const persisted = afterId ? [] : await loadPersistedEvents(scanRunId);
  const merged = [...persisted, ...live].filter((event, index, all) => all.findIndex(candidate => candidate.id === event.id) === index).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  res.json({ data: merged, error: null });
});

router.get('/runs/:runId/events', async (req: Request, res: Response) => {
  const scanRunId = String(req.params.runId);
  const afterId = req.query.after_id ? String(req.query.after_id) : undefined;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event: unknown) => {
    res.write(`event: agent\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const persisted = afterId ? [] : await loadPersistedEvents(scanRunId);
  const initial = [...persisted, ...agentEventBus.list(scanRunId, afterId)].filter((event, index, all) => all.findIndex(candidate => candidate.id === event.id) === index).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const event of initial) send(event);
  send({ kind: 'agent_state_changed', status: 'info', scan_run_id: scanRunId, summary: '实时 Agent 事件中转已连接。' });
  const unsubscribe = agentEventBus.subscribe(event => {
    if (event.scan_run_id === scanRunId) send(event);
  });
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

export default router;
