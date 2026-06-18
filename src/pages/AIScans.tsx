import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Brain, CheckCircle2, Circle, FileUp, Loader2, Play, RefreshCw, ShieldCheck, Square, XCircle, Activity, Camera } from 'lucide-react';
import { aiScansService } from '../lib/api-client';
import type { AIScanRun, AIScanSnapshot, AIScanTask, AIScanVulnerabilityCandidate } from '../types';

const VULN_OPTIONS = [
  { id: 'file_upload', label: '文件上传漏洞' },
  { id: 'file_download', label: '文件下载漏洞' },
  { id: 'path_traversal', label: '目录/路径穿越' },
  { id: 'bola_idor', label: 'BOLA / 横向越权' },
  { id: 'bfla', label: 'BFLA / 纵向越权' },
  { id: 'business_logic', label: '业务逻辑漏洞' },
  { id: 'xss', label: 'XSS' },
  { id: 'command_injection', label: '命令执行' },
  { id: 'auth_otp', label: '认证/验证码/OTP' },
  { id: 'email_sms_bypass', label: '邮箱/短信验证码绕过' },
  { id: 'passcode_bypass', label: 'Passcode/支付密码绕过' },
  { id: 'replay_race', label: '重放/并发' },
];

function taskIcon(status: AIScanTask['status']) {
  if (status === 'completed') return <CheckCircle2 size={18} className="text-slate-900" />;
  if (status === 'running') return <Loader2 size={18} className="animate-spin text-blue-600" />;
  if (status === 'failed') return <XCircle size={18} className="text-red-600" />;
  if (status === 'waiting_selection') return <AlertCircle size={18} className="text-amber-600" />;
  if (status === 'blocked') return <Square size={18} className="text-slate-400" />;
  return <Circle size={18} className="text-slate-400" />;
}

function uniqueCandidateTypes(candidates: AIScanVulnerabilityCandidate[]): string[] {
  return [...new Set(candidates.map(candidate => candidate.vuln_type))].sort();
}

export function AIScans() {
  const [runs, setRuns] = useState<AIScanRun[]>([]);
  const [snapshot, setSnapshot] = useState<AIScanSnapshot | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [prompt, setPrompt] = useState('分析这个系统的功能和子功能，生成漏洞类型列表，并在我选择漏洞类型后自动执行测试。');
  const [selectedVulns, setSelectedVulns] = useState<string[]>(['file_upload']);
  const [maxParallelAgents, setMaxParallelAgents] = useState(4);
  const [accountMode, setAccountMode] = useState<'manual' | 'raw' | 'autonomous'>('manual');
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
  const totalTasks = snapshot?.tasks.length || 0;
  const candidateTypes = useMemo(() => uniqueCandidateTypes(snapshot?.candidates || []), [snapshot?.candidates]);
  const currentEndpoint = snapshot?.endpoints.find(endpoint => endpoint.content_type === 'multipart/form-data') || snapshot?.endpoints[0];
  const latestArtifact = snapshot?.artifacts[0];
  const browserArtifact = snapshot?.artifacts.find(artifact => artifact.artifact_type === 'browser_state');
  const browserArtifacts = (snapshot?.artifacts || []).filter(artifact => ['browser_state', 'browser_agent_state'].includes(artifact.artifact_type)).slice(0, 8);
  const sharedResources = snapshot?.shared_resources || [];
  const judgementArtifacts = snapshot?.artifacts.filter(artifact => artifact.artifact_type === 'ai_judgement').slice(0, 6) || [];
  const recentToolCalls = snapshot?.tool_invocations.slice(0, 8) || [];

  async function loadRuns() {
    const data = await aiScansService.list();
    setRuns(data);
  }

  async function loadSnapshot(id: string) {
    const data = await aiScansService.get(id);
    setSnapshot(data);
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
        try { parsedManualAccounts = JSON.parse(manualAccountsJson); } catch { throw new Error('手动测试账号 JSON 格式不正确'); }
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

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <div className="border-b border-slate-200 px-8 py-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <Brain size={16} /> AI Agent Driver
            </div>
            <h1 className="text-2xl font-semibold tracking-tight">AI Security Scan</h1>
            <p className="text-sm text-slate-500 mt-1">AI 接管功能发现、漏洞候选、任务生成、BSTG 资产配置、执行与 finding 前判断。</p>
          </div>
          <button
            onClick={() => snapshot && loadSnapshot(snapshot.run.id)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50"
            disabled={!snapshot || loading}
          >
            <RefreshCw size={16} /> 刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(420px,540px)_1fr] gap-0">
        <div className="border-r border-slate-200 min-h-[calc(100vh-86px)] p-6 space-y-6">
          <section className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
            <h2 className="font-medium mb-3">1. 输入目标 URL</h2>
            <input
              value={baseUrl}
              onChange={event => setBaseUrl(event.target.value)}
              placeholder="https://target.example.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <textarea
              value={prompt}
              onChange={event => setPrompt(event.target.value)}
              className="mt-3 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
              rows={3}
            />
            <button
              onClick={handleCreate}
              disabled={loading || !baseUrl.trim()}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {loading ? <Loader2 size={16} className="animate-spin" /> : <Brain size={16} />} 创建 AI Scan
            </button>
          </section>

          <section className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
            <h2 className="font-medium mb-3">1.1 测试账号 / 登录材料</h2>
            <div className="grid grid-cols-3 gap-2 mb-3">
              {[['manual', '手动账号'], ['raw', '请求包识别'], ['autonomous', 'AI 自主注册']].map(([id, label]) => (
                <button key={id} onClick={() => setAccountMode(id as any)} className={`rounded-lg border px-2 py-2 text-xs ${accountMode === id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 hover:bg-slate-50'}`}>{label}</button>
              ))}
            </div>
            {accountMode === 'manual' && (
              <textarea value={manualAccountsJson} onChange={event => setManualAccountsJson(event.target.value)} rows={8} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-blue-500" />
            )}
            {accountMode === 'raw' && (
              <textarea value={rawAccountRequests} onChange={event => setRawAccountRequests(event.target.value)} rows={8} placeholder={"粘贴一个或多个 HTTP 请求包，AI 会提取 Authorization/Cookie/username/email/mobile/user_id/role/token/passcode 等字段"} className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs outline-none focus:border-blue-500" />
            )}
            {accountMode === 'autonomous' && (
              <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">AI 会通过右侧浏览器探索登录/注册流程；遇到手机号、邮箱、短信验证码、OTP 或 passcode 时，会创建 human_input_request 并等待你协助输入。</div>
            )}
            <label className="mt-3 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={enableHumanAssist} onChange={event => setEnableHumanAssist(event.target.checked)} /> 允许 AI 在验证码/手机号/passcode 步骤请求人工协助</label>
            <label className="mt-3 block text-sm text-slate-600">并行子 Agent 数</label>
            <input type="number" min={1} max={16} value={maxParallelAgents} onChange={event => setMaxParallelAgents(Number(event.target.value || 1))} className="mt-1 w-24 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </section>

          <section className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
            <h2 className="font-medium mb-3">历史扫描</h2>
            <div className="space-y-2 max-h-52 overflow-auto">
              {runs.map(run => (
                <button
                  key={run.id}
                  onClick={() => loadSnapshot(run.id)}
                  className={`w-full text-left rounded-lg border px-3 py-2 text-sm ${snapshot?.run.id === run.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 hover:bg-slate-50'}`}
                >
                  <div className="font-medium truncate">{run.name || run.base_url}</div>
                  <div className="text-xs text-slate-500 truncate">{run.base_url} · {run.status}</div>
                </button>
              ))}
              {runs.length === 0 && <div className="text-sm text-slate-500">暂无扫描。</div>}
            </div>
          </section>

          {snapshot && (
            <section className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-medium">2. Agent 任务</h2>
                <div className="text-sm text-slate-500">已完成 {completedTasks}/{totalTasks} 项任务</div>
              </div>
              <button
                onClick={handleRunAll}
                disabled={loading}
                className="mb-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />} 运行/继续 Agent
              </button>
              <div className="space-y-2 max-h-80 overflow-auto">
                {snapshot.tasks.map(task => (
                  <div key={task.id} className="flex gap-3 rounded-lg border border-slate-100 px-3 py-2">
                    <div className="pt-0.5">{taskIcon(task.status)}</div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{task.title}</div>
                      <div className="text-xs text-slate-500 truncate">{task.task_type} · {task.status} · {task.phase || 'created'}</div>
                      {task.result_summary && <div className="text-xs text-slate-600 mt-1">{task.result_summary}</div>}
                      {task.error_message && <div className="text-xs text-red-600 mt-1">{task.error_message}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {snapshot && (
            <section className="rounded-2xl border border-slate-200 p-4 bg-white shadow-sm">
              <h2 className="font-medium mb-3">3. 选择要测试的漏洞类型</h2>
              <div className="grid grid-cols-2 gap-2">
                {VULN_OPTIONS.map(option => {
                  const discovered = candidateTypes.includes(option.id);
                  const selected = selectedVulns.includes(option.id);
                  return (
                    <button
                      key={option.id}
                      onClick={() => toggleVuln(option.id)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 hover:bg-slate-50'} ${discovered ? '' : 'opacity-70'}`}
                    >
                      <div className="font-medium">{option.label}</div>
                      <div className={`text-xs ${selected ? 'text-slate-200' : 'text-slate-500'}`}>{discovered ? '已发现候选' : '可选'}</div>
                    </button>
                  );
                })}
              </div>
              <button
                onClick={handleSelectVulns}
                disabled={loading || selectedVulns.length === 0}
                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                <ShieldCheck size={16} /> 生成任务并执行选中漏洞
              </button>
            </section>
          )}

          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
        </div>

        <div className="p-6 space-y-6 bg-slate-50 min-h-[calc(100vh-86px)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-2 mb-3">
              <FileUp size={18} />
              <h2 className="font-medium">内置浏览器 / 自动发现视图</h2>
            </div>
            {snapshot ? (
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="text-xs uppercase text-slate-500 mb-2">Current target</div>
                  <div className="font-mono text-sm break-all">{snapshot.run.base_url}</div>
                  <div className="mt-3 text-xs uppercase text-slate-500 mb-2">Current endpoint</div>
                  <div className="rounded-lg bg-slate-100 p-3 font-mono text-sm break-all">
                    {currentEndpoint ? `${currentEndpoint.method} ${currentEndpoint.path}` : '尚未发现 endpoint'}
                  </div>
                  {currentEndpoint?.request_summary && <p className="mt-2 text-sm text-slate-600">{currentEndpoint.request_summary}</p>}
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex items-center gap-2 text-xs uppercase text-slate-500 mb-2"><Camera size={14} /> 多浏览器 / 子 Agent 可视化</div>
                  {browserArtifacts.length > 0 ? (
                    <div className="grid grid-cols-2 gap-2 max-h-72 overflow-auto">
                      {browserArtifacts.map(artifact => (
                        <div key={artifact.id} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                          <div className="text-[11px] font-medium truncate">{artifact.title || artifact.artifact_type}</div>
                          <div className="text-[10px] text-slate-500 truncate">{artifact.content_json?.agent_role || artifact.artifact_type} · {artifact.content_json?.action || artifact.content_json?.mode || 'observe'}</div>
                          {artifact.content_text ? <img alt="browser screenshot" className="mt-2 h-24 w-full rounded border border-slate-200 object-contain bg-white" src={`data:image/png;base64,${artifact.content_text}`} /> : <pre className="mt-2 h-24 overflow-auto rounded bg-slate-950 p-2 text-[10px] text-slate-100">{JSON.stringify(artifact.content_json, null, 2)}</pre>}
                        </div>
                      ))}
                    </div>
                  ) : browserArtifact?.content_text ? (
                    <img alt="browser screenshot" className="max-h-72 w-full rounded-lg border border-slate-200 object-contain bg-slate-100" src={`data:image/png;base64,${browserArtifact.content_text}`} />
                  ) : browserArtifact ? (
                    <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(browserArtifact.content_json, null, 2)}</pre>
                  ) : latestArtifact ? (
                    <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(latestArtifact.content_json, null, 2)}</pre>
                  ) : (
                    <div className="text-sm text-slate-500">暂无 browser artifact。</div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-12 text-center text-slate-500">创建扫描后，这里显示自动浏览、接口发现、上传测试和证据。</div>
            )}
          </section>


          {snapshot && (
            <section className="grid grid-cols-2 gap-6">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-3"><Activity size={18} /><h2 className="font-medium">工具调用</h2></div>
                <div className="space-y-2 max-h-72 overflow-auto">
                  {recentToolCalls.map(call => (
                    <div key={call.id} className="rounded-lg border border-slate-100 px-3 py-2 text-xs">
                      <div className="font-mono font-medium">{call.tool_name}</div>
                      <div className="text-slate-500">{call.status} · {call.completed_at || call.started_at}</div>
                      {call.error_message && <div className="text-red-600 mt-1">{call.error_message}</div>}
                    </div>
                  ))}
                  {recentToolCalls.length === 0 && <div className="text-sm text-slate-500">暂无工具调用。</div>}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-medium mb-3">AI 判定 / Finding 前证据</h2>
                <div className="space-y-2 max-h-72 overflow-auto">
                  {judgementArtifacts.map(artifact => (
                    <div key={artifact.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                      <div className="font-medium">{artifact.title || 'AI judgement'}</div>
                      <div className="text-xs text-slate-500">{artifact.content_json?.verdict || 'unknown'} · confidence {Math.round(Number(artifact.content_json?.confidence || 0) * 100)}%</div>
                      <p className="text-xs text-slate-600 mt-1">{String(artifact.content_json?.reason || '').slice(0, 300)}</p>
                    </div>
                  ))}
                  {judgementArtifacts.length === 0 && <div className="text-sm text-slate-500">暂无 AI 判定。</div>}
                </div>
              </div>
            </section>
          )}

          {snapshot && (
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="font-medium mb-3">跨 Agent 共享资源</h2>
              <div className="grid grid-cols-3 gap-2 max-h-60 overflow-auto">
                {sharedResources.slice(0, 18).map(resource => (
                  <div key={resource.id} className="rounded-lg border border-slate-100 px-3 py-2 text-xs">
                    <div className="font-medium truncate">{resource.resource_type}</div>
                    <div className="text-slate-500 truncate">{resource.resource_key}</div>
                    <div className="mt-1 text-slate-400">used {resource.usage_count || 0}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {snapshot && (
            <section className="grid grid-cols-2 gap-6">
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-medium mb-3">功能 / 子功能</h2>
                <div className="space-y-2 max-h-80 overflow-auto">
                  {snapshot.features.map(feature => (
                    <div key={feature.id} className={`rounded-lg border border-slate-100 px-3 py-2 text-sm ${feature.parent_id ? 'ml-5' : ''}`}>
                      <div className="font-medium">{feature.name}</div>
                      <div className="text-xs text-slate-500">{feature.node_type} · endpoints {feature.endpoint_ids.length}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="font-medium mb-3">漏洞候选</h2>
                <div className="space-y-2 max-h-80 overflow-auto">
                  {snapshot.candidates.map(candidate => (
                    <div key={candidate.id} className="rounded-lg border border-slate-100 px-3 py-2 text-sm">
                      <div className="flex justify-between gap-3">
                        <div className="font-medium truncate">{candidate.title}</div>
                        <div className="text-xs text-slate-500">{Math.round(candidate.confidence * 100)}%</div>
                      </div>
                      <div className="text-xs text-slate-500">{candidate.vuln_type}</div>
                      {candidate.reason && <p className="text-xs text-slate-600 mt-1">{candidate.reason}</p>}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
