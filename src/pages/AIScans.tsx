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
import { useI18n } from '../i18n';
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

type DrivingMode = 'autopilot' | 'manual';
type ScanDepth = 'quick' | 'standard' | 'deep';
type AccountMode = 'auto_execute' | 'autonomous' | 'raw' | 'manual';

const ALL_VULN_TYPES = VULN_OPTIONS.map(option => option.id);
const DEFAULT_SCAN_PROMPTS: Record<'en' | 'zh', string> = {
  en: 'Discover key workflows, map authorization boundaries, and verify exploitable access-control issues.',
  zh: '发现关键业务流程，映射授权边界，并验证可利用的访问控制问题。',
};

const SCAN_DEPTH_OPTIONS: Array<{ id: ScanDepth; label: string; description: string; config: Record<string, number> }> = [
  { id: 'quick', label: '快速', description: '每类漏洞抽样少量高置信功能点。', config: { max_tasks_per_vuln_type: 3, max_tasks_per_function_bucket: 1 } },
  { id: 'standard', label: '标准', description: '覆盖主要功能桶，控制执行规模。', config: { max_tasks_per_vuln_type: 8, max_tasks_per_function_bucket: 2 } },
  { id: 'deep', label: '深度', description: '扩大每类漏洞和功能桶覆盖面。', config: { max_tasks_per_vuln_type: 18, max_tasks_per_function_bucket: 3 } },
];

const depthConfig = (depth: ScanDepth) => SCAN_DEPTH_OPTIONS.find(option => option.id === depth)?.config || SCAN_DEPTH_OPTIONS[1].config;


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
  const { language, t } = useI18n();
  const [runs, setRuns] = useState<AIScanRun[]>([]);
  const [snapshot, setSnapshot] = useState<AIScanSnapshot | null>(null);
  const [selectedRun, setSelectedRun] = useState<AIScanRun | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [prompt, setPrompt] = useState(DEFAULT_SCAN_PROMPTS[language]);
  const [selectedVulns, setSelectedVulns] = useState<string[]>([]);
  const [drivingMode, setDrivingMode] = useState<DrivingMode>('autopilot');
  const [scanDepth, setScanDepth] = useState<ScanDepth>('standard');
  const [maxParallelAgents, setMaxParallelAgents] = useState(4);
  const [accountMode, setAccountMode] = useState<AccountMode>('auto_execute');
  const [manualAccountsJson, setManualAccountsJson] = useState(`{
  "attacker": { "username": "alice", "password": "AlicePass123", "role": "user" },
  "victim": { "username": "bob", "password": "BobPass123", "role": "user" },
  "admin": { "username": "admin", "password": "AdminPass123", "role": "admin" }
}`);
  const [rawAccountRequests, setRawAccountRequests] = useState('');
  const [enableHumanAssist, setEnableHumanAssist] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const activeRun = snapshot?.run || selectedRun || runs[0] || null;
  const activeSummary = activeRun?.summary || {};
  const completedTasks = snapshot?.tasks.filter(task => task.status === 'completed').length || Number(activeSummary.tasks_completed || 0);
  const runningTasks = snapshot?.tasks.filter(task => task.status === 'running').length || Number(activeSummary.tasks_running || 0);
  const failedTasks = snapshot?.tasks.filter(task => task.status === 'failed').length || Number(activeSummary.tasks_failed || 0);
  const totalTasks = snapshot?.tasks.length || Number(activeSummary.tasks_total || 0);
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const candidateTypes = useMemo(() => uniqueCandidateTypes(snapshot?.candidates || []), [snapshot?.candidates]);
  const vulnerabilitySelectionReady = snapshot?.run.status === 'awaiting_selection' || candidateTypes.length > 0;
  const currentEndpoint = snapshot?.endpoints.find(endpoint => endpoint.content_type === 'multipart/form-data') || snapshot?.endpoints[0];
  const endpointCount = snapshot?.endpoints.length || Number(activeSummary.endpoints_total || activeSummary.total_endpoints || 0);
  const browserArtifacts = (snapshot?.artifacts || []).filter(artifact => ['browser_state', 'browser_agent_state'].includes(artifact.artifact_type));
  const primaryBrowserArtifact = browserArtifacts[0];
  const allJudgementArtifacts = snapshot?.artifacts.filter(artifact => artifact.artifact_type === 'ai_judgement') || [];
  const judgementArtifacts = allJudgementArtifacts.slice(0, 4);
  const recentToolCalls = snapshot?.tool_invocations.slice(0, 8) || [];
  const sharedResources = snapshot?.shared_resources.slice(0, 12) || [];
  const recentRuns = runs.slice(0, 6);
  const candidateTypeSummaries = useMemo(() => {
    const groups = new Map<string, { type: string; count: number; maxConfidence: number; example?: string }>();
    for (const candidate of snapshot?.candidates || []) {
      const existing = groups.get(candidate.vuln_type) || {
        type: candidate.vuln_type,
        count: 0,
        maxConfidence: 0,
        example: candidate.title,
      };
      existing.count += 1;
      existing.maxConfidence = Math.max(existing.maxConfidence, candidate.confidence || 0);
      if (!existing.example) existing.example = candidate.title;
      groups.set(candidate.vuln_type, existing);
    }
    return [...groups.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  }, [snapshot?.candidates]);
  const evidenceGateSummary = useMemo(() => {
    const judgements = snapshot?.artifacts.filter(artifact => artifact.artifact_type === 'ai_judgement') || [];
    const preconditionBlocks = snapshot?.artifacts.filter(artifact => artifact.artifact_type === 'workflow_precondition_block' || artifact.artifact_type === 'finding_blocked_by_workflow_preconditions').length || 0;
    const nativeGateBlocks = snapshot?.artifacts.filter(artifact => artifact.artifact_type === 'finding_blocked_by_native_evidence_gate').length || 0;
    const confirmed = judgements.filter(artifact => artifact.content_json?.verdict === 'vulnerable' && artifact.content_json?.native_evidence_gate?.verdict === 'confirmed').length;
    const inconclusive = judgements.filter(artifact => artifact.content_json?.verdict === 'inconclusive' || artifact.content_json?.native_evidence_gate?.verdict === 'inconclusive').length;
    const notVulnerable = judgements.filter(artifact => artifact.content_json?.verdict === 'not_vulnerable').length;
    return { confirmed, inconclusive, notVulnerable, preconditionBlocks, nativeGateBlocks, total: judgements.length };
  }, [snapshot?.artifacts]);

  async function loadRuns() {
    const data = await aiScansService.list();
    if (Array.isArray(data)) {
      setRuns(data);
      if (!snapshot && data.length > 0) {
        const preferredRun = data.find(run => run.status === 'running' || run.status === 'discovering' || run.status === 'planning') || data[0];
        setSelectedRun(preferredRun);
        setBaseUrl(current => current || preferredRun.base_url);
        await loadSnapshot(preferredRun.id);
      }
      return;
    }
    setRuns([]);
  }

  async function loadSnapshot(id: string) {
    const data = await aiScansService.get(id);
    setSnapshot(data);
    setSelectedRun(data.run);
    setBaseUrl(data.run.base_url);
  }

  useEffect(() => {
    void loadRuns().catch(err => setError(err.message));
  }, []);

  useEffect(() => {
    setPrompt(current => {
      if (current === DEFAULT_SCAN_PROMPTS.en || current === DEFAULT_SCAN_PROMPTS.zh) {
        return DEFAULT_SCAN_PROMPTS[language];
      }
      return current;
    });
  }, [language]);

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
      const requestedVulns = drivingMode === 'autopilot' ? ALL_VULN_TYPES : selectedVulns;
      if (drivingMode === 'manual' && requestedVulns.length === 0) {
        throw new Error('手动驾驶模式下请至少选择一种漏洞类型');
      }
      const effectiveDepth = drivingMode === 'autopilot' ? 'deep' : scanDepth;
      const created = await aiScansService.create({
        base_url: baseUrl,
        user_prompt: prompt,
        selected_vuln_types: requestedVulns,
        scan_config: {
          driving_mode: drivingMode,
          scan_depth: effectiveDepth,
          auto_start: drivingMode === 'autopilot',
          selected_scope_strategy: drivingMode === 'autopilot' ? 'all_vulnerability_types' : 'manual_vulnerability_types',
          max_parallel_agents: maxParallelAgents,
          ...depthConfig(effectiveDepth),
          account_mode: accountMode,
          accounts: accountMode === 'manual' ? parsedManualAccounts : {},
          account_raw_requests: accountMode === 'raw' ? rawAccountRequests : '',
          enable_account_auto_execution: accountMode === 'auto_execute',
          enable_autonomous_account_discovery: accountMode === 'auto_execute' || accountMode === 'autonomous',
          auto_account_roles: ['attacker', 'victim', 'admin'],
          account_bootstrap_max_pages: 40,
          enable_human_assisted_registration: enableHumanAssist,
        },
      });
      if (drivingMode === 'autopilot') {
        const result = await aiScansService.run(created.run.id, undefined, maxParallelAgents);
        setSnapshot(result.snapshot);
      } else {
        setSnapshot(created);
      }
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

  const featureCount = snapshot?.features.length || Number(activeSummary.features_total || 0);
  const candidateCount = snapshot?.candidates.length || Number(activeSummary.candidates_total || 0);
  const artifactCount = snapshot?.artifacts.length || Number(activeSummary.artifacts_total || 0);
  const toolCallCount = snapshot?.tool_invocations.length || Number(activeSummary.tool_calls_total || 0);
  const statusText = t(activeRun ? RUN_STATUS_LABEL[activeRun.status] : 'No run');
  const activeDrivingMode = (activeRun?.scan_config?.driving_mode || drivingMode) as DrivingMode;
  const selectedScope = selectedVulns.length > 0
    ? selectedVulns
    : activeRun?.selected_vuln_types?.length
      ? activeRun.selected_vuln_types
      : activeDrivingMode === 'autopilot'
        ? ALL_VULN_TYPES
        : candidateTypes;

  return (
    <div className="assessment-page min-h-screen bg-slate-50 text-slate-950">
      <header className="assessment-command border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
                <Activity size={14} />
                Assessment
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <h1 className="text-2xl font-semibold tracking-tight">Security assessment</h1>
                <span className={`inline-flex h-7 items-center gap-1 rounded px-2.5 text-xs font-medium ${statusClass(activeRun?.status)}`}>
                  {statusIcon(activeRun?.status)}
                  {statusText}
                </span>
              </div>
              <div className="mt-2 truncate font-mono text-sm text-slate-500">
                {activeRun?.base_url || baseUrl || 'No target selected'}
              </div>
            </div>

            <div className="assessment-launch flex w-full flex-wrap items-end gap-2 xl:w-auto xl:justify-end">
              <label className="block min-w-0 flex-1 xl:w-[360px] xl:flex-none">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">Target</span>
                <input
                  value={baseUrl}
                  onChange={event => setBaseUrl(event.target.value)}
                  placeholder="https://target.example.com"
                  className="h-9 w-full rounded border border-slate-300 bg-white px-3 text-sm outline-none focus:border-slate-950"
                />
              </label>
              <button
                onClick={handleCreate}
                disabled={loading || !baseUrl.trim()}
                className="assessment-primary-action inline-flex h-9 items-center gap-2 rounded bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                {drivingMode === 'autopilot' ? 'Start autopilot' : 'Start manual'}
              </button>
              <button
                onClick={handleRunAll}
                disabled={loading || !snapshot}
                className="inline-flex h-9 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
              >
                <MousePointerClick size={16} />
                Resume
              </button>
              <button
                onClick={() => snapshot && loadSnapshot(snapshot.run.id)}
                className="inline-flex h-9 items-center justify-center rounded border border-slate-300 bg-white px-3 text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                disabled={!snapshot || loading}
                aria-label="Refresh assessment"
              >
                <RefreshCw size={16} />
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
        </div>
      </header>

      <main className="assessment-content mx-auto max-w-[1500px] space-y-5 px-4 py-5 sm:px-6">
        <section className="assessment-metrics border border-slate-200 bg-white">
          <div className="grid gap-px bg-slate-200 sm:grid-cols-2 lg:grid-cols-5">
            <div className="assessment-metric bg-white p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Status</div>
              <div className="mt-2 text-xl font-semibold text-slate-950">{statusText}</div>
              <div className="mt-1 text-xs text-slate-500">{activeRun?.current_phase || 'Idle'}</div>
            </div>
            <div className="assessment-metric bg-white p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Endpoints</div>
              <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950">{endpointCount}</div>
              <div className="mt-1 text-xs text-slate-500">{featureCount} {t('features')}</div>
            </div>
            <div className="assessment-metric bg-white p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Progress</div>
              <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950">{progress}%</div>
              <div className="mt-2 h-1.5 bg-slate-100">
                <div className="h-full bg-slate-950 transition-all" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="assessment-metric bg-white p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Tasks</div>
              <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950">{completedTasks}/{totalTasks || completedTasks}</div>
              <div className="mt-1 text-xs text-slate-500">{runningTasks} {t('running')}</div>
            </div>
            <div className="assessment-metric bg-white p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">Failures</div>
              <div className={`mt-2 text-xl font-semibold tabular-nums ${failedTasks > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{failedTasks}</div>
              <div className="mt-1 text-xs text-slate-500">{candidateCount} {t('candidates')}</div>
            </div>
          </div>
          <div className="border-t border-slate-200 px-4 py-3 text-sm font-medium text-slate-700">
            {activeRun ? `${statusText} / ${endpointCount} ${t('endpoints')} / ${progress}% / ${completedTasks} ${t('Completed')} / ${failedTasks} ${t('Failed')}` : t('No assessment run selected')}
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
          <div className="assessment-panel border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold">Assessment summary</h2>
            </div>
            <div className="grid gap-px bg-slate-100 md:grid-cols-2">
              <div className="bg-white px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Run</div>
                <div className="mt-2 truncate text-sm font-medium text-slate-900">{activeRun?.name || activeRun?.id || 'No active run'}</div>
                <div className="mt-1 truncate font-mono text-xs text-slate-500">{activeRun?.id || '-'}</div>
              </div>
              <div className="bg-white px-4 py-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Coverage</div>
                <div className="mt-2 text-sm font-medium text-slate-900">
                  {endpointCount} {t('endpoints')} · {featureCount} {t('features')} · {artifactCount} {t('artifacts')}
                </div>
                <div className="mt-1 text-xs text-slate-500">{toolCallCount} {t('tool calls captured')}</div>
              </div>
            </div>
            <div className="px-4 py-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-400">Scope</div>
              <div className="flex flex-wrap gap-2">
                {(selectedScope.length ? selectedScope : ['No vulnerability scope selected']).slice(0, 12).map(type => (
                  <span key={type} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
                    {t(type)}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="assessment-panel border border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold">Recent runs</h2>
              <span className="text-xs text-slate-500">{recentRuns.length}</span>
            </div>
            <div className="max-h-64 overflow-auto">
              {recentRuns.map(run => (
                <button
                  key={run.id}
                  onClick={() => loadSnapshot(run.id)}
                  className={`block w-full border-b border-slate-100 px-4 py-3 text-left last:border-b-0 hover:bg-slate-50 ${activeRun?.id === run.id ? 'bg-slate-50' : 'bg-white'}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-slate-900">{run.name || run.base_url}</div>
                      <div className="mt-1 truncate text-xs text-slate-500">{run.base_url}</div>
                    </div>
                    <span className={`shrink-0 rounded px-2 py-1 text-xs font-medium ${statusClass(run.status)}`}>{t(RUN_STATUS_LABEL[run.status])}</span>
                  </div>
                </button>
              ))}
              {recentRuns.length === 0 && <div className="px-4 py-8 text-sm text-slate-500">No previous runs.</div>}
            </div>
          </div>
        </section>

        <details open={!activeRun} className="assessment-panel border border-slate-200 bg-white">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="inline-flex items-center gap-2">
                <TerminalSquare size={16} className="text-slate-500" />
                Launch settings
              </span>
              <span className="text-xs font-normal text-slate-500">{drivingMode} · {accountMode} · {maxParallelAgents} {t('workers')} · {drivingMode === 'autopilot' ? ALL_VULN_TYPES.length : selectedVulns.length || selectedScope.length} {t('selected')}</span>
            </div>
          </summary>
          <div className="space-y-4 border-t border-slate-200 px-4 py-4">
            <div className="grid gap-3 lg:grid-cols-[minmax(280px,1fr)_120px]">
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

            <div className="grid gap-3 lg:grid-cols-2">
              {[
                { id: 'autopilot' as DrivingMode, label: '自动驾驶模式', description: '输入目标后自动选择全部漏洞类型、跳过人工选择，并立即进入发现/建模/测试链路。' },
                { id: 'manual' as DrivingMode, label: '手动驾驶模式', description: '输入目标后由你指定漏洞类型和测试深度，再执行所选范围。' },
              ].map(option => (
                <button
                  key={option.id}
                  onClick={() => setDrivingMode(option.id)}
                  className={`rounded border px-3 py-3 text-left ${
                    drivingMode === option.id ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="text-sm font-semibold">{t(option.label)}</div>
                  <div className={`mt-1 break-words text-xs leading-5 ${drivingMode === option.id ? 'text-slate-200' : 'text-slate-500'}`}>{t(option.description)}</div>
                </button>
              ))}
            </div>

            {drivingMode === 'manual' && (
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Scan depth</div>
                <div className="grid gap-2 md:grid-cols-3">
                  {SCAN_DEPTH_OPTIONS.map(option => (
                    <button
                      key={option.id}
                      onClick={() => setScanDepth(option.id)}
                      className={`rounded border px-3 py-2 text-left text-sm ${
                        scanDepth === option.id ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-medium">{t(option.label)}</div>
                      <div className={`mt-1 break-words text-xs leading-5 ${scanDepth === option.id ? 'text-slate-200' : 'text-slate-500'}`}>{t(option.description)}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {drivingMode === 'autopilot' && (
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
                {t('自动驾驶会默认启用全部')} {ALL_VULN_TYPES.length} {t('类漏洞，并使用深度覆盖；不会再要求人工选择漏洞范围。')}
              </div>
            )}

            <div>
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Account mode</div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                {[
                  { id: 'auto_execute' as AccountMode, label: '自动执行', description: '默认：自动发现注册/登录表单，生成测试账号，提交注册并登录，保存 cookie/token。' },
                  { id: 'autonomous' as AccountMode, label: '自动发现', description: '只发现账号入口和生成获取计划；遇到注册/验证码由用户协助。' },
                  { id: 'raw' as AccountMode, label: 'Requests', description: '粘贴登录/注册 HTTP 请求，由系统提取账号和会话字段。' },
                  { id: 'manual' as AccountMode, label: 'Accounts', description: '手工输入 attacker/victim/admin 账号字段。' },
                ].map(option => (
                  <button
                    key={option.id}
                    onClick={() => setAccountMode(option.id)}
                    className={`rounded border px-3 py-2 text-left text-sm ${
                      accountMode === option.id ? 'border-slate-950 bg-slate-950 text-white' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="font-medium">{t(option.label)}</div>
                    <div className={`mt-1 break-words text-xs leading-5 ${accountMode === option.id ? 'text-slate-200' : 'text-slate-500'}`}>{t(option.description)}</div>
                  </button>
                ))}
              </div>
            </div>

            {accountMode === 'manual' && (
              <textarea
                value={manualAccountsJson}
                onChange={event => setManualAccountsJson(event.target.value)}
                rows={7}
                className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-950"
              />
            )}
            {accountMode === 'raw' && (
              <textarea
                value={rawAccountRequests}
                onChange={event => setRawAccountRequests(event.target.value)}
                rows={7}
                placeholder="Paste HTTP requests"
                className="w-full rounded border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-slate-950"
              />
            )}

            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={enableHumanAssist}
                onChange={event => setEnableHumanAssist(event.target.checked)}
              />
              Human assist for OTP, captcha and passcode
            </label>

            {drivingMode === 'manual' ? (
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Vulnerability scope</div>
                <div className="flex flex-wrap gap-2">
                  {VULN_OPTIONS.map(option => (
                    <button
                      key={option.id}
                      onClick={() => toggleVuln(option.id)}
                      className={`rounded border px-3 py-1.5 text-xs ${
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
            ) : (
              <div className="flex flex-wrap gap-2">
                {VULN_OPTIONS.map(option => (
                  <span key={option.id} className="rounded border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
                    {option.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </details>

        <section className="assessment-panel border border-slate-200 bg-white">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">Attack surface</h2>
              <div className="mt-1 text-xs text-slate-500">{candidateCount} candidates · {candidateTypes.length} types</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectRecommendedVulns}
                disabled={!snapshot || activeDrivingMode === 'autopilot'}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
              >
                Select
              </button>
              <button
                onClick={handleSelectVulns}
                disabled={loading || activeDrivingMode === 'autopilot' || !vulnerabilitySelectionReady || selectedVulns.length === 0}
                className="inline-flex h-8 items-center gap-2 rounded bg-slate-950 px-3 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400"
              >
                <ShieldCheck size={15} />
                Run selected
              </button>
            </div>
          </div>
          <div className="grid gap-px bg-slate-100 md:grid-cols-2 xl:grid-cols-4">
            {candidateTypeSummaries.map(summary => (
              <button
                key={summary.type}
                onClick={() => toggleVuln(summary.type)}
                className={`min-h-[104px] bg-white px-4 py-3 text-left hover:bg-slate-50 ${
                  selectedVulns.includes(summary.type) ? 'ring-1 ring-inset ring-slate-950' : ''
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-slate-900">{summary.type}</span>
                  <span className="text-xs tabular-nums text-slate-500">{Math.round(summary.maxConfidence * 100)}%</span>
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums text-slate-950">{summary.count}</div>
                <div className="mt-1 truncate text-xs text-slate-500">{summary.example || 'candidate type'}</div>
              </button>
            ))}
            {snapshot && snapshot.candidates.length === 0 && (
              <div className="bg-white px-4 py-8 text-sm text-slate-500">No candidates yet.</div>
            )}
            {!snapshot && (
              <div className="bg-white px-4 py-8 text-sm text-slate-500">Select a run to inspect attack surface.</div>
            )}
          </div>
          {snapshot && (
            <div className="grid gap-px border-t border-slate-200 bg-slate-100 sm:grid-cols-2 xl:grid-cols-5">
              <Metric label="Confirmed" value={evidenceGateSummary.confirmed} />
              <Metric label="Inconclusive" value={evidenceGateSummary.inconclusive} />
              <Metric label="Not vulnerable" value={evidenceGateSummary.notVulnerable} />
              <Metric label="Preconditions" value={evidenceGateSummary.preconditionBlocks} />
              <Metric label="Native gate" value={evidenceGateSummary.nativeGateBlocks} />
            </div>
          )}
          {snapshot && snapshot.candidates.length > 0 && (
            <details className="border-t border-slate-200">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900">
                Candidate queue
                <span className="ml-2 text-xs font-normal text-slate-500">{snapshot.candidates.length} raw candidates</span>
              </summary>
              <div className="grid gap-px bg-slate-100 md:grid-cols-2 xl:grid-cols-4">
                {snapshot.candidates.slice(0, 16).map(candidate => (
                  <button
                    key={candidate.id}
                    onClick={() => toggleVuln(candidate.vuln_type)}
                    className={`min-h-[112px] bg-white px-4 py-3 text-left hover:bg-slate-50 ${
                      selectedVulns.includes(candidate.vuln_type) ? 'ring-1 ring-inset ring-slate-950' : ''
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
                    {candidate.reason && <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{candidate.reason}</p>}
                  </button>
                ))}
              </div>
            </details>
          )}
        </section>

        <details open={Boolean(snapshot)} className="assessment-panel border border-slate-200 bg-white">
          <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900">
            <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
              <span className="inline-flex items-center gap-2">
                <Camera size={16} className="text-slate-500" />
                Execution trace
              </span>
              <span className="text-xs font-normal text-slate-500">
                {totalTasks || 0} tasks · {toolCallCount} tool calls · {artifactCount} artifacts · {sharedResources.length} shared resources
              </span>
            </div>
          </summary>

          <div className="border-t border-slate-200">
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(540px,1.1fr)_minmax(360px,0.9fr)]">
              <section className="flex min-h-[560px] flex-col border-b border-slate-200 bg-white xl:border-b-0 xl:border-r">
                <div className="flex min-h-12 items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Camera size={16} className="text-slate-500" />
                      <span className="text-sm font-semibold">Controlled browser</span>
                      {activeRun && (
                        <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${statusClass(activeRun.status)}`}>
                          {statusIcon(activeRun.status)}
                          {RUN_STATUS_LABEL[activeRun.status]}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-slate-500">
                      {currentEndpoint ? `${currentEndpoint.method} ${currentEndpoint.path}` : activeRun?.base_url || baseUrl || 'No active target'}
                    </div>
                  </div>
                  <div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
                    <Search size={14} />
                    <span>{endpointCount} endpoints</span>
                    {activeRun?.base_url && <ExternalLink size={14} />}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden">
                  <ArtifactPreview artifact={primaryBrowserArtifact} emptyTarget={activeRun?.base_url || baseUrl} />
                </div>

                <div className="border-t border-slate-200 bg-slate-50 px-4 py-2">
                  {browserArtifacts.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                      {browserArtifacts.slice(0, 4).map(artifact => (
                        <div key={artifact.id} className="min-w-0 border border-slate-200 bg-white p-2">
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

              <aside className="min-w-0 bg-slate-50">
                <div className="border-b border-slate-200 bg-white">
                  <div className="grid grid-cols-2 sm:grid-cols-4">
                    <Metric label="Progress" value={`${progress}%`} />
                    <Metric label="Tasks" value={totalTasks} />
                    <Metric label="Signals" value={candidateCount} />
                    <Metric label="Running" value={runningTasks} />
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
                      <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{activeRun?.current_phase || 'Idle'}</span>
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

                  <section className="grid gap-3 2xl:grid-cols-2">
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

                  {sharedResources.length > 0 && (
                    <section className="border border-slate-200 bg-white">
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
            </div>
          </div>
        </details>
      </main>
    </div>
  );
}
