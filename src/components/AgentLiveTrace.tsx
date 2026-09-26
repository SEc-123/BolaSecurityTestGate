/* BSTG style: evidence-first live trace; show provenance and redacted metadata, never raw secrets. */
import { useEffect, useMemo, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, Radio, ShieldAlert, XCircle } from 'lucide-react';

type AgentEvent = {
  id: string;
  at: string;
  kind: string;
  scan_run_id?: string;
  task_id?: string;
  tool_name?: string;
  provider_id?: string;
  model?: string;
  status: string;
  duration_ms?: number;
  request_id?: string;
  input?: { message_count?: number; input_hash?: string; bytes?: number };
  output?: { finish_reason?: string; output_hash?: string; bytes?: number; tokens_in?: number; tokens_out?: number };
  error?: string;
  summary?: string;
};

const API_ROOT = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

function label(event: AgentEvent) {
  if (event.kind === 'agent_request_started') return 'LLM 请求';
  if (event.kind === 'agent_request_succeeded') return 'LLM 响应';
  if (event.kind === 'agent_request_failed') return 'LLM 失败';
  if (event.kind === 'agent_tool_started') return `工具开始 · ${event.tool_name || 'unknown'}`;
  if (event.kind === 'agent_tool_completed') return `工具完成 · ${event.tool_name || 'unknown'}`;
  if (event.kind === 'agent_finding_created') return 'Finding 已创建';
  if (event.kind === 'agent_gate_completed') return 'Gate 已完成';
  return 'Agent 状态';
}

function EventIcon({ status }: { status: string }) {
  if (status === 'completed') return <CheckCircle2 size={15} className="text-emerald-600" />;
  if (status === 'failed' || status === 'blocked') return <XCircle size={15} className="text-red-600" />;
  if (status === 'running') return <Activity size={15} className="animate-pulse text-slate-950" />;
  return <CircleAlert size={15} className="text-amber-600" />;
}

function shortHash(value?: string) {
  return value ? `${value.slice(0, 10)}…` : '—';
}

export function AgentLiveTrace({ runId }: { runId?: string | null }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    if (!runId) return undefined;
    const source = new EventSource(`${API_ROOT}/api/agent-observability/runs/${encodeURIComponent(runId)}/events`);
    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('error', () => setConnected(false));
    source.addEventListener('agent', (message) => {
      try {
        const next = JSON.parse((message as MessageEvent).data) as AgentEvent;
        if (!next.id) return;
        setEvents(previous => [...previous.filter(event => event.id !== next.id), next].slice(-120));
      } catch {
        // Ignore malformed observer frames; execution must remain independent.
      }
    });
    return () => source.close();
  }, [runId]);

  const stats = useMemo(() => ({
    requests: events.filter(event => event.kind === 'agent_request_started').length,
    completed: events.filter(event => event.kind === 'agent_request_succeeded').length,
    failed: events.filter(event => event.kind === 'agent_request_failed').length,
    tools: events.filter(event => event.kind === 'agent_tool_completed').length,
  }), [events]);

  return (
    <section className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <Radio size={16} className={connected ? 'text-emerald-600' : 'text-slate-400'} />
          <div>
            <h2 className="text-sm font-semibold">Agent 实时调用链</h2>
            <p className="mt-0.5 text-xs text-slate-500">后端真实执行事件 · 脱敏摘要 · 不展示密钥或原始 prompt</p>
          </div>
        </div>
        <span className={`rounded px-2 py-1 text-xs font-medium ${connected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
          {connected ? '实时已连接' : runId ? '等待连接' : '选择一个评估'}
        </span>
      </div>
      <div className="grid grid-cols-2 border-b border-slate-100 sm:grid-cols-4">
        <div className="border-r border-slate-100 px-4 py-3"><div className="text-[10px] uppercase tracking-wide text-slate-400">LLM 请求</div><div className="mt-1 text-lg font-semibold text-slate-950">{stats.requests}</div></div>
        <div className="border-r border-slate-100 px-4 py-3"><div className="text-[10px] uppercase tracking-wide text-slate-400">成功响应</div><div className="mt-1 text-lg font-semibold text-emerald-700">{stats.completed}</div></div>
        <div className="border-r border-slate-100 px-4 py-3"><div className="text-[10px] uppercase tracking-wide text-slate-400">失败/阻断</div><div className="mt-1 text-lg font-semibold text-red-700">{stats.failed}</div></div>
        <div className="px-4 py-3"><div className="text-[10px] uppercase tracking-wide text-slate-400">工具完成</div><div className="mt-1 text-lg font-semibold text-slate-950">{stats.tools}</div></div>
      </div>
      <div className="max-h-[360px] overflow-auto">
        {events.length === 0 ? (
          <div className="flex min-h-[150px] items-center justify-center gap-2 px-4 text-sm text-slate-500"><ShieldAlert size={16} />尚无该评估的真实 Agent 事件。</div>
        ) : events.slice().reverse().map(event => (
          <div key={event.id} className="border-b border-slate-100 px-4 py-3 last:border-b-0">
            <div className="flex items-start gap-2">
              <div className="pt-0.5"><EventIcon status={event.status} /></div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-medium text-slate-900">{label(event)}</span>
                  <span className="text-[11px] text-slate-400">{new Date(event.at).toLocaleTimeString()}</span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  {event.model && <span>model: {event.model}</span>}
                  {event.duration_ms !== undefined && <span>{event.duration_ms} ms</span>}
                  {event.request_id && <span>request: {shortHash(event.request_id)}</span>}
                  {event.output?.tokens_in !== undefined && <span>tokens: {event.output.tokens_in}/{event.output.tokens_out || 0}</span>}
                </div>
                {event.summary && <p className="mt-1.5 text-xs leading-5 text-slate-600">{event.summary}</p>}
                {event.error && <p className="mt-1.5 text-xs leading-5 text-red-600">{event.error}</p>}
                {event.input?.input_hash && <div className="mt-1 font-mono text-[10px] text-slate-400">input sha256 {shortHash(event.input.input_hash)} · output sha256 {shortHash(event.output?.output_hash)}</div>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
