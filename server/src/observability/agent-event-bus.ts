/* BSTG style: evidence-first observability; never expose API keys or raw prompts/responses to the browser. */
import { createHash, randomUUID } from 'node:crypto';

export type AgentEventKind =
  | 'agent_request_started'
  | 'agent_request_succeeded'
  | 'agent_request_failed'
  | 'agent_tool_started'
  | 'agent_tool_completed'
  | 'agent_state_changed'
  | 'agent_finding_created'
  | 'agent_gate_completed';

export interface AgentEvent {
  id: string;
  at: string;
  kind: AgentEventKind;
  scan_run_id?: string;
  task_id?: string;
  tool_name?: string;
  provider_id?: string;
  model?: string;
  status: 'running' | 'completed' | 'failed' | 'blocked' | 'info';
  duration_ms?: number;
  request_id?: string;
  input?: { message_count?: number; input_hash?: string; bytes?: number };
  output?: { finish_reason?: string; output_hash?: string; bytes?: number; tokens_in?: number; tokens_out?: number };
  error?: string;
  summary?: string;
}

type Listener = (event: AgentEvent) => void;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function compactError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return text.slice(0, 500);
}

class AgentEventBus {
  private readonly history: AgentEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly maxHistory = 2000;

  publish(input: Omit<AgentEvent, 'id' | 'at'>): AgentEvent {
    const event: AgentEvent = { id: randomUUID(), at: new Date().toISOString(), ...input };
    this.history.push(event);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* observers must never interrupt the Agent */ }
    }
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(scanRunId?: string, afterId?: string): AgentEvent[] {
    const start = afterId ? Math.max(0, this.history.findIndex(event => event.id === afterId) + 1) : 0;
    return this.history.slice(start).filter(event => !scanRunId || event.scan_run_id === scanRunId);
  }

  beginLLM(input: { scan_run_id?: string; task_id?: string; provider_id?: string; model?: string; request: unknown; message_count?: number }) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    this.publish({
      kind: 'agent_request_started', status: 'running', request_id: requestId,
      scan_run_id: input.scan_run_id, task_id: input.task_id, provider_id: input.provider_id, model: input.model,
      input: { message_count: input.message_count, input_hash: digest(input.request), bytes: Buffer.byteLength(JSON.stringify(input.request ?? null)) },
      summary: `真实 Agent LLM 请求已发出：${input.model || 'configured-model'}`,
    });
    return {
      requestId,
      succeed: (response: any) => this.publish({
        kind: 'agent_request_succeeded', status: 'completed', request_id: requestId,
        scan_run_id: input.scan_run_id, task_id: input.task_id, provider_id: input.provider_id, model: response?.model || input.model,
        duration_ms: Date.now() - startedAt,
        output: { finish_reason: response?.choices?.[0]?.finish_reason, output_hash: digest(response), bytes: Buffer.byteLength(JSON.stringify(response ?? null)), tokens_in: response?.usage?.prompt_tokens, tokens_out: response?.usage?.completion_tokens },
        summary: '真实 Agent LLM 响应已收到并进入决策解析。',
      }),
      fail: (error: unknown) => this.publish({
        kind: 'agent_request_failed', status: 'failed', request_id: requestId,
        scan_run_id: input.scan_run_id, task_id: input.task_id, provider_id: input.provider_id, model: input.model,
        duration_ms: Date.now() - startedAt, error: compactError(error), summary: '真实 Agent LLM 请求失败，已进入 fail-closed/fallback 路径。',
      }),
    };
  }
}

export const agentEventBus = new AgentEventBus();
