import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  Camera,
  CheckCircle2,
  Circle,
  Clock3,
  Crosshair,
  ExternalLink,
  Loader2,
  MousePointerClick,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  TerminalSquare,
  XCircle,
} from 'lucide-react';
import { aiScansService } from '../lib/api-client';
import type { AIScanArtifact, AIScanRun, AIScanSnapshot, AIScanTask, AIScanVulnerabilityCandidate } from '../types';

const VULN_OPTIONS = [
  { id: 'file_upload', label: '文件上传' },
  { id: 'file_download', label: '文件下载' },
  { id: 'path_traversal', label: '路径穿越' },
  { id: 'bola_idor', label: 'BOLA / IDOR' },
  { id: 'bfla', label: 'BFLA' },
  { id: 'business_logic', label: '业务逻辑' },
  { id: 'xss', label: 'XSS' },
  { id: 'command_injection', label: '命令执行' },
  { id: 'auth_otp', label: '认证 / OTP' },
  { id: 'email_sms_bypass', label: '验证码绕过' },
  { id: 'passcode_bypass', label: '支付密码绕过' },
  { id: 'replay_race', label: '重放 / 并发' },
  { id: 'state_machine_race', label: '状态机 / 跨包竞态' },
];

const RUN_STATUS_LABEL: Record<AIScanRun['status'], string> = {
  created: 'Created',
  discovering: 'Discovering',
  awaiting_selection: 'Review',
  planning: 'Planning',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

function taskIcon(status: AIScanTask['status']) {
  if (status === 'completed') return <CheckCircle2 size={17} className="text-emerald-600" />;
  if (status === 'running') return <Loader2 size={17} className="animate-spin text-slate-950" />;
  if (status === 'failed') return <XCircle size={17} className="text-red-600" />;
  if (status === 'waiting_selection') return <AlertCircle size={17} className="text-amber-600" />;
  if (status === 'blocked') return <Square size={17} className="text-slate-400" />;
  return <Circle size={17} className="text-slate-300" />;
}

function uniqueCandidateTypes(candidates: AIScanVulnerabilityCandidate[]): string[] {
  return [...new Set(candidates.map(candidate => candidate.vuln_type))].sort();
}

function formatTime(value?: string) {
  if (!value) return 'Pending';
  return new Date(value).toLocaleString();
}

function statusClass(status?: string) {
  if (status === 'completed') return 'bg-emerald-50 text-emerald-700';
  if (status === 'failed') return 'bg-red-50 text-red-700';
  if (status === 'running' || status === 'discovering' || status === 'planning') return 'bg-slate-950 text-white';
  if (status === 'awaiting_selection' || status === 'waiting_selection') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-600';
}

function statusIcon(status?: string) {
  if (status === 'running' || status === 'discovering' || status === 'planning') {
    return <Activity size={14} className="animate-pulse" />;
  }
  if (status === 'completed') return <CheckCircle2 size={14} />;
  if (status === 'failed') return <XCircle size={14} />;
  return <Clock3 size={14} />;
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-w-0 border-r border-slate-200 px-3 py-3 last:border-r-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</div>
      <div className="mt-1 truncate text-lg font-semibold tabular-nums text-slate-950">{value}</div>
    </div>
  );
}

function ArtifactPreview({ artifact, emptyTarget }: { artifact?: AIScanArtifact; emptyTarget: string }) {
  if (!artifact) {
    return (
      <div className="flex h-full min-h-[420px] flex-col bg-[#fbfbfa]">
        <div className="flex h-9 items-center gap-2 border-b border-slate-200 bg-white px-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
          <div className="ml-2 flex-1 truncate rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500">
            {emptyTarget || 'about:blank'}
          </div>
        </div>
        <div className="grid flex-1 place-items-center">
          <div className="w-full max-w-md px-8">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded border border-slate-200 bg-white text-slate-500">
                <Crosshair size={18} />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">{emptyTarget ? 'Target staged' : 'No target loaded'}</div>
                <div className="mt-0.5 text-xs text-slate-500">Frames and evidence appear as the run progresses.</div>
              </div>
            </div>
            <div className="space-y-2 border-l border-slate-200 pl-4 text-xs text-slate-500">
              <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-slate-300" /> Browser session</div>
              <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-slate-300" /> Routes and forms</div>
              <div className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-slate-300" /> Evidence capture</div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (artifact.content_text) {
    return (
      <div className="flex h-full min-h-[420px] items-center justify-center bg-white">
        <img
          alt="AI agent browser state"
          className="h-full max-h-[calc(100vh-270px)] w-full object-contain"
          src={`data:image/png;base64,${artifact.content_text}`}
        />
      </div>
    );
  }

  return (
    <pre className="h-full min-h-[420px] overflow-auto bg-slate-950 p-4 text-xs leading-5 text-slate-100">
      {JSON.stringify(artifact.content_json, null, 2)}
    </pre>
  );
}

export function AIScans() {
  const [runs, setRuns] = useState<AIScanRun[]>([]);
  const [snapshot, setSnapshot] = useState<AIScanSnapshot | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [prompt, setPrompt] = useState('Discover key workflows, map authorization boundaries, and verify exploitable access-control issues.');
  const [selectedVulns, setSelectedVulns] = useState<string[]>([]);
  const [maxParallelAgents, setMaxParallelAgents] = useState(4);
  const [accountMode, setAccountMode] = useState<'manual' | 'raw' | 'autonomous'>('autonomous');
  const [manualAccountsJson, setManualAccountsJson] = useState(`{
  "attacker": { "username": "alice", "password": "AlicePass123", "role": "user" },
  "victim": { "username": "bob", "password": "BobPass123", "role": "user" },
  "admin": { "username": "admin", "password": "AdminPass123", "role": "admin" }
}`);
  const [rawAccountRequests, setRawAccountRequests] = useState('');
  const [enableHumanAssist, setEnableHumanAssist] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const completedTasks = snapshot?.tasks.filter(task => task.status === 'completed').length || 0;
  const runningTasks = snapshot?.tasks.filter(task => task.status === 'running').length || 0;
  const failedTasks = snapshot?.tasks.filter(task => task.status === 'failed').length || 0;
  const totalTasks = snapshot?.tasks.length || 0;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const candidateTypes = useMemo(() => uniqueCandidateTypes(snapshot?.candidates || []), [snapshot?.candidates]);
  const vulnerabilitySelectionReady = snapshot?.run.status === 'awaiting_selection' || candidateTypes.length > 0;
  const currentEndpoint = snapshot?.endpoints.find(endpoint => endpoint.content_type === 'multipart/form-data') || snapshot?.endpoints[0];
  const browserArtifacts = (snapshot?.artifacts || []).filter(artifact => ['browser_state', 'browser_agent_state'].includes(artifact.artifact_type));
  const primaryBrowserArtifact = browserArtifacts[0];
  const judgementArtifacts = snapshot?.artifacts.filter(artifact => artifact.artifact_type === 'ai_judgement').slice(0, 4) || [];
  const recentToolCalls = snapshot?.tool_invocations.slice(0, 8) || [];
  const sharedResources = snapshot?.shared_resources.slice(0, 12) || [];
  const recentRuns = runs.slice(0, 6);

  async function loadRuns() {
    const data = await aiScansService.list();
    if (Array.isArray(data)) {
      setRuns(data);
      return;
    }
    setRuns([]);
  }

  async function loadSnapshot(id: string) {
    const data = await aiScansService.get(id);
    setSnapshot(data);
    setBaseUrl(data.run.base_url);
  }

  useEffect(() => {
    void loadRuns().catch(err => setError(err.message));
  }, []);

  async function handleCreate() {
    setLoading(true);
    setError('');
    try {
      let parsedManualAccounts: Record<string, any> = {};
      if (accountMode === 'manual' && manualAccountsJson.trim()) {
        try {
          parsedManualAccounts = JSON.parse(manualAccountsJson);
        } catch {
          throw new Error('测试账号 JSON 格式不正确');
        }
      }
      const created = await aiScansService.create({
        base_url: baseUrl,
        user_prompt: prompt,
        scan_config: {
          max_parallel_agents: maxParallelAgents,
          accounts: accountMode === 'manual' ? parsedManualAccounts : {},
          account_raw_requests: accountMode === 'raw' ? rawAccountRequests : '',
          enable_autonomous_account_discovery: accountMode === 'autonomous',
          enable_human_assisted_registration: enableHumanAssist,
        },
      });
      setSnapshot(created);
      await loadRuns();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleRunAll() {
    if (!snapshot) return;
    setLoading(true);
    setError('');
    try {
      const result = await aiScansService.run(snapshot.run.id, undefined, maxParallelAgents);
      setSnapshot(result.snapshot);
      await loadRuns();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectVulns() {
    if (!snapshot) return;
    setLoading(true);
    setError('');
    try {
      const updated = await aiScansService.selectVulnerabilities(snapshot.run.id, selectedVulns);
      setSnapshot(updated);
      const result = await aiScansService.run(snapshot.run.id, undefined, maxParallelAgents);
      setSnapshot(result.snapshot);
      await loadRuns();
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  function toggleVuln(id: string) {
    setSelectedVulns(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  function selectRecommendedVulns() {
    const recommended = candidateTypes.length > 0 ? candidateTypes : VULN_OPTIONS.map(option => option.id);
    setSelectedVulns(recommended);
  }

  return (
    <div className="min-h-screen bg-[#f4f5f4] text-slate-950">
      <header className="border-b border-slate-200 bg-white px-5 py-3">
        <div className="space-y-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-[220px]">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                <Activity size={14} />
                Operation
              </div>
              <h1 className="mt-1 text-xl font-semibold tracking-tight">Live assessment</h1>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={loading || !baseUrl.trim()}
                className="inline-flex h-9 items-center gap-2 rounded bg-[#111827] px-4 text-sm font-medium text-white disabled:bg-slate-200 disabled:text-slate-400"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                Start
              </button>
              <button
                onClick={handleRunAll}
                disabled={loading || !snapshot}
                className="inline-flex h-9 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
              >
                <MousePointerClick size={16} />
                Resume
              </button>
              <button
                onClick={() => snapshot && loadSnapshot(snapshot.run.id)}
                className="inline-flex h-9 items-center justify-center rounded border border-slate-300 bg-white px-3 text-slate-700 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                disabled={!snapshot || loading}
                aria-label="Refresh mission"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>

          <div className="grid gap-3 lg:grid-cols-[minmax(240px,0.9fr)_minmax(280px,1.3fr)_100px]">
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">Target</span>
              <input
                value={baseUrl}
                onChange={event => setBaseUrl(event.target.value)}
                placeholder="https://target.example.com"
                className="h-9 w-full rounded border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-950"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">Assessment brief</span>
              <input
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                className="h-9 w-full rounded border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-950"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">Workers</span>
              <input
                type="number"
                min={1}
                max={16}
                value={maxParallelAgents}
                onChange={event => setMaxParallelAgents(Number(event.target.value || 1))}
                className="h-9 w-full rounded border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-950"
              />
            </label>
          </div>
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
      </header>

      <main className="grid min-h-[calc(100vh-81px)] grid-cols-1 xl:grid-cols-[minmax(540px,61vw)_minmax(360px,1fr)]">
        <section className="flex min-h-[560px] flex-col border-r border-slate-200 bg-white">
          <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Camera size={16} className="text-slate-500" />
                <span className="text-sm font-semibold">Controlled browser</span>
                {snapshot && (
                  <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${statusClass(snapshot.run.status)}`}>
                    {statusIcon(snapshot.run.status)}
                    {RUN_STATUS_LABEL[snapshot.run.status]}
                  </span>
                )}
              </div>
              <div className="mt-1 truncate font-mono text-xs text-slate-500">
                {currentEndpoint ? `${currentEndpoint.method} ${currentEndpoint.path}` : snapshot?.run.base_url || baseUrl || 'No active target'}
              </div>
            </div>
            <div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
              <Search size={14} />
              <span>{snapshot?.endpoints.length || 0} endpoints</span>
              {snapshot?.run.base_url && <ExternalLink size={14} />}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <ArtifactPreview artifact={primaryBrowserArtifact} emptyTarget={snapshot?.run.base_url || baseUrl} />
          </div>

          <div className="border-t border-slate-200 bg-[#fafafa] px-4 py-2">
            {browserArtifacts.length > 0 ? (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                {browserArtifacts.slice(0, 4).map(artifact => (
                  <div key={artifact.id} className="min-w-0 rounded border border-slate-200 bg-white p-2">
                    <div className="truncate text-xs font-medium text-slate-700">{artifact.title || artifact.artifact_type}</div>
                    <div className="truncate text-[11px] text-slate-400">
                      {artifact.content_json?.agent_role || artifact.content_json?.action || 'observe'}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <Circle size={8} />
                Waiting for first captured frame
              </div>
            )}
          </div>
        </section>

        <aside className="min-w-0 overflow-auto bg-[#f4f5f4]">
          <div className="border-b border-slate-200 bg-white">
            <div className="grid grid-cols-4">
              <Metric label="Progress" value={`${progress}%`} />
              <Metric label="Tasks" value={totalTasks} />
              <Metric label="Signals" value={snapshot?.candidates.length || 0} />
              <Metric label="Running" value={runningTasks} />
            </div>
            <div className="h-1 bg-slate-100">
              <div className="h-full bg-slate-950 transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="space-y-3 p-3">
            <section className="border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
                <div>
                  <h2 className="text-sm font-semibold">Execution queue</h2>
                  <div className="text-xs text-slate-500">
                    {completedTasks} complete · {failedTasks} failed
                  </div>
                </div>
                <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{snapshot?.run.current_phase || 'Idle'}</span>
              </div>
              <div className="max-h-[300px] overflow-auto">
                {snapshot?.tasks.length ? snapshot.tasks.map(task => (
                  <div key={task.id} className="grid grid-cols-[24px_1fr] gap-2 border-b border-slate-100 px-3 py-2.5 last:border-b-0">
                    <div className="pt-0.5">{taskIcon(task.status)}</div>
                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-3">
                        <div className="truncate text-sm font-medium text-slate-900">{task.title}</div>
                        <span className="shrink-0 text-xs tabular-nums text-slate-400">P{task.priority}</span>
                      </div>
                      <div className="mt-1 truncate text-xs text-slate-500">
                        {task.task_type} · {task.phase || task.status}
                      </div>
                      {task.result_summary && <p className="mt-2 text-sm leading-5 text-slate-600">{task.result_summary}</p>}
                      {task.error_message && <p className="mt-2 text-sm leading-5 text-red-600">{task.error_message}</p>}
                    </div>
                  </div>
                )) : (
                  <div className="px-3 py-7 text-sm text-slate-500">No active run.</div>
                )}
              </div>
            </section>

            <section className="border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
                <div>
                  <h2 className="text-sm font-semibold">Attack surface</h2>
                  <div className="text-xs text-slate-500">{snapshot?.features.length || 0} features · {candidateTypes.length} types</div>
                </div>
                <button
                  onClick={selectRecommendedVulns}
                  disabled={!snapshot}
                  className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                >
                  Select
                </button>
              </div>
              <div className="max-h-[300px] overflow-auto">
                {(snapshot?.candidates || []).slice(0, 8).map(candidate => (
                  <button
                    key={candidate.id}
                    onClick={() => toggleVuln(candidate.vuln_type)}
                    className={`block w-full border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 ${
                      selectedVulns.includes(candidate.vuln_type) ? 'bg-slate-50' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-slate-900">{candidate.title}</span>
                      <span className="text-xs tabular-nums text-slate-500">{Math.round(candidate.confidence * 100)}%</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-600">{candidate.vuln_type}</span>
                      <span className="text-[11px] text-slate-400">{candidate.status}</span>
                    </div>
                    {candidate.reason && <p className="mt-2 max-h-10 overflow-hidden text-xs leading-5 text-slate-500">{candidate.reason}</p>}
                  </button>
                ))}
                {snapshot && snapshot.candidates.length === 0 && (
                  <div className="px-3 py-7 text-sm text-slate-500">No candidates yet.</div>
                )}
                {!snapshot && (
                  <div className="px-3 py-3">
                    {recentRuns.map(run => (
                      <button
                        key={run.id}
                        onClick={() => loadSnapshot(run.id)}
                        className="w-full border-b border-slate-100 py-2 text-left last:border-b-0 hover:bg-slate-50"
                      >
                        <div className="truncate text-sm font-medium">{run.name || run.base_url}</div>
                        <div className="truncate text-xs text-slate-500">{run.base_url} · {RUN_STATUS_LABEL[run.status]}</div>
                      </button>
                    ))}
                    {recentRuns.length === 0 && <div className="py-4 text-sm text-slate-500">No previous runs.</div>}
                  </div>
                )}
              </div>
              <div className="border-t border-slate-200 px-3 py-2.5">
                <button
                  onClick={handleSelectVulns}
                  disabled={loading || !vulnerabilitySelectionReady || selectedVulns.length === 0}
                  className="inline-flex h-8 items-center gap-2 rounded bg-[#111827] px-3 text-sm font-medium text-white disabled:bg-slate-200 disabled:text-slate-400"
                >
                  <ShieldCheck size={15} />
                  Run selected
                </button>
                {selectedVulns.length > 0 && (
                  <span className="ml-3 text-xs text-slate-500">{selectedVulns.length} selected</span>
                )}
              </div>
            </section>

            <section className="grid gap-4 2xl:grid-cols-2">
              <div className="border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
                  <TerminalSquare size={16} className="text-slate-500" />
                  <h2 className="text-sm font-semibold">Tools</h2>
                </div>
                <div className="max-h-64 overflow-auto">
                  {recentToolCalls.map(call => (
                    <div key={call.id} className="border-b border-slate-100 px-3 py-2.5 last:border-b-0">
                      <div className="truncate font-mono text-xs font-medium text-slate-800">{call.tool_name}</div>
                      <div className="mt-1 text-xs text-slate-500">{call.status} · {formatTime(call.completed_at || call.started_at)}</div>
                      {call.error_message && <div className="mt-1 text-xs text-red-600">{call.error_message}</div>}
                    </div>
                  ))}
                  {recentToolCalls.length === 0 && <div className="px-3 py-7 text-sm text-slate-500">No tool calls.</div>}
                </div>
              </div>

              <div className="border border-slate-200 bg-white">
                <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2.5">
                  <ShieldCheck size={16} className="text-slate-500" />
                  <h2 className="text-sm font-semibold">Evidence review</h2>
                </div>
                <div className="max-h-64 overflow-auto">
                  {judgementArtifacts.map(artifact => (
                    <div key={artifact.id} className="border-b border-slate-100 px-3 py-2.5 last:border-b-0">
                      <div className="truncate text-sm font-medium text-slate-800">{artifact.title || 'AI judgement'}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {artifact.content_json?.verdict || 'unknown'} · {Math.round(Number(artifact.content_json?.confidence || 0) * 100)}%
                      </div>
                      {artifact.content_json?.reason && (
                        <p className="mt-2 max-h-16 overflow-hidden text-xs leading-5 text-slate-500">{String(artifact.content_json.reason)}</p>
                      )}
                    </div>
                  ))}
                  {judgementArtifacts.length === 0 && <div className="px-3 py-7 text-sm text-slate-500">No evidence reviews.</div>}
                </div>
              </div>
            </section>

            <details className="border border-slate-200 bg-white">
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Launch settings</summary>
              <div className="space-y-4 border-t border-slate-200 px-4 py-4">
                <div className="grid grid-cols-3 gap-2">
                  {[
                    ['autonomous', 'Autonomous'],
                    ['raw', 'Requests'],
                    ['manual', 'Accounts'],
                  ].map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => setAccountMode(id as any)}
                      className={`rounded-md border px-3 py-2 text-sm ${
                        accountMode === id ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {accountMode === 'manual' && (
                  <textarea
                    value={manualAccountsJson}
                    onChange={event => setManualAccountsJson(event.target.value)}
                    rows={7}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-950"
                  />
                )}
                {accountMode === 'raw' && (
                  <textarea
                    value={rawAccountRequests}
                    onChange={event => setRawAccountRequests(event.target.value)}
                    rows={7}
                    placeholder="Paste HTTP requests"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-950"
                  />
                )}

                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={enableHumanAssist}
                    onChange={event => setEnableHumanAssist(event.target.checked)}
                  />
                  Human assist for OTP and passcode
                </label>

                <div className="flex flex-wrap gap-2">
                  {VULN_OPTIONS.map(option => (
                    <button
                      key={option.id}
                      onClick={() => toggleVuln(option.id)}
                      className={`rounded-full border px-3 py-1 text-xs ${
                        selectedVulns.includes(option.id)
                          ? 'border-slate-950 bg-slate-950 text-white'
                          : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </details>

            {sharedResources.length > 0 && (
              <section className="rounded-md border border-slate-200 bg-white">
                <div className="border-b border-slate-200 px-4 py-3">
                  <h2 className="text-sm font-semibold">Shared memory</h2>
                </div>
                <div className="grid grid-cols-2 gap-px bg-slate-100">
                  {sharedResources.map(resource => (
                    <div key={resource.id} className="min-w-0 bg-white px-4 py-3">
                      <div className="truncate text-xs font-medium text-slate-800">{resource.title || resource.resource_type}</div>
                      <div className="mt-1 truncate text-[11px] text-slate-500">{resource.resource_key}</div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
