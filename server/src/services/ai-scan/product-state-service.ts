import type { AIScanSnapshot, AIScanRun, AIScanTask, AIScanArtifact } from './types.js';
import type { AssessmentRun, BusinessFunction, BusinessTest, ProductAssessmentState, TestStatus, AssessmentIssue, AssessmentFrame } from './product-state-types.js';

const LABELS: Record<string, string> = {
  file_upload: '文件上传安全', file_download: '文件下载权限', path_traversal: '文件访问范围',
  bola_idor: '跨账号越权', bfla: '角色权限越权', business_logic: '业务规则校验', xss: '页面脚本注入',
  command_injection: '命令注入', auth_otp: '登录与身份验证', email_sms_bypass: '验证码校验',
  passcode_bypass: '支付密码校验', replay_race: '重复提交与并发', state_machine_race: '业务步骤顺序',
};
const STATUS: Record<string, string> = {
  created: '待开始', discovering: '识别业务功能', planning: '准备测试清单', awaiting_selection: '等待选择测试范围',
  running: '正在测试', completed: '本轮已结束', failed: '执行失败', blocked: '受阻', pending: '待测试',
  skipped: '已跳过', review: '待复核', not_run: '未执行', waiting_selection: '等待确认',
};
const INTERNAL = /\b(?:mutation|learning|workflow|campaign|subagent|execution_plan|native_evidence_gate|tool_name|provider_id|LLM|sha256)\b|变异|子\s*Agent|工作流|学习引擎|bstg\.[\w.]+|mobile\.[\w.]+|browser\.[\w.]+/i;
const HELPERS = new Set(['vulnerability_campaign', 'summarize_vulnerability_campaign', 'expand_selected_vulnerabilities']);
const terminal = (status: string) => ['completed', 'failed'].includes(status);
const byTime = (a: { created_at: string; id: string }, b: { created_at: string; id: string }) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id, 'en', { numeric: true });

/** Fail closed for technical/raw messages. These are labels, not an HTML sanitizer. React escapes labels. */
export function businessText(value: unknown, fallback: string, limit = 100): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!text || INTERNAL.test(text) || /[{}]|Bearer\s|(?:password|token|secret|authorization|cookie)\s*[:=]/i.test(text)) return fallback;
  return text.slice(0, limit);
}
export function businessName(value: unknown, fallback = '业务功能'): string {
  const name = businessText(value, fallback);
  const aliases: Record<string, string> = { login: '登录', signin: '登录', 'sign in': '登录', logout: '退出登录',
    register: '注册', signup: '注册', otp: '发送验证码', 'send otp': '发送验证码', 'send code': '发送验证码',
    'forgot password': '忘记密码', forgot_password: '忘记密码', 'reset password': '重置密码',
    reset_password: '重置密码', profile: '个人资料', orders: '订单', upload: '文件上传', download: '文件下载' };
  return aliases[name.toLowerCase()] || name;
}
export function productRun(run: AIScanRun): AssessmentRun {
  let target = ''; try { const u = new URL(run.base_url); target = `${u.origin}${u.pathname}`; } catch { target = '测试目标'; }
  return { id: run.id, name: businessText(run.name, '安全测试'), target, surface: run.scan_config?.surface === 'android' ? 'android' : 'web',
    status: run.status, status_label: STATUS[run.status] || '状态未知', created_at: run.created_at, updated_at: run.updated_at };
}
function aggregate(tests: BusinessTest[]): TestStatus {
  if (!tests.length) return 'pending';
  for (const status of ['running', 'failed', 'blocked', 'review', 'pending', 'not_run', 'skipped'] as const)
    if (tests.some(t => t.status === status)) return status;
  return 'completed';
}
function evidenceComplete(a?: AIScanArtifact): boolean {
  const gate = a?.content_json?.native_evidence_gate;
  return Boolean(gate && gate.preconditions_satisfied !== false && gate.baseline_verified === true && gate.mutation_executed === true &&
    gate.template_executed === true && gate.native_api_mode_executed === true &&
    Array.isArray(gate.native_test_run_ids) && gate.native_test_run_ids.length &&
    Array.isArray(gate.missing_evidence) && gate.missing_evidence.length === 0);
}
function newest(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  return [...artifacts].sort((a, b) => stamp(b) - stamp(a) || b.id.localeCompare(a.id))[0];
}
function stamp(a: AIScanArtifact): number {
  const value = a.content_json?.observed_at || a.content_json?.updated_at || a.updated_at || a.created_at;
  const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T') + 'Z';
  return Date.parse(iso) || 0;
}
function taskVerdict(tasks: AIScanTask[], artifacts: AIScanArtifact[], ended: boolean): {status: TestStatus; outcome: BusinessTest['outcome']} {
  if (!tasks.length) return { status: ended ? 'not_run' : 'pending', outcome: 'pending' };
  if (tasks.some(t => t.status === 'running')) return { status: 'running', outcome: 'pending' };
  if (tasks.some(t => t.status === 'failed')) return { status: 'failed', outcome: 'inconclusive' };
  if (tasks.some(t => ['blocked', 'waiting_selection'].includes(t.status))) return { status: 'blocked', outcome: 'inconclusive' };
  if (tasks.some(t => t.status === 'pending')) return { status: ended ? 'not_run' : 'pending', outcome: 'pending' };
  if (tasks.some(t => t.status === 'skipped')) return { status: 'skipped', outcome: 'inconclusive' };
  // One task can evaluate several endpoints. Its final endpoint must not hide an
  // earlier unresolved endpoint. Supersede only results with the same source.
  const judges = tasks.flatMap(t => {
    const grouped = new Map<string, AIScanArtifact[]>();
    for (const a of artifacts.filter(a => a.task_id === t.id && a.artifact_type === 'ai_judgement')) {
      const key = a.source_ref || ''; grouped.set(key, [...(grouped.get(key) || []), a]);
    }
    return grouped.size ? [...grouped.values()].map(newest) : [undefined];
  });
  if (tasks.some(t => t.status !== 'completed')) return { status: 'review', outcome: 'inconclusive' };
  const resolved = judges.every(a => evidenceComplete(a) && ['vulnerable','not_vulnerable'].includes(a!.content_json.verdict) &&
    (a!.content_json.verdict !== 'vulnerable' || a!.content_json.native_evidence_gate.verdict === 'confirmed') &&
    !artifacts.some(g => g.task_id === a!.task_id &&
      ['finding_created_with_replay_gap','finding_blocked_by_workflow_preconditions','workflow_precondition_block'].includes(g.artifact_type) && stamp(g) >= stamp(a!)));
  if (!resolved) return { status: 'review', outcome: 'inconclusive' };
  return { status: 'completed', outcome: judges.some(a => a?.content_json.verdict === 'vulnerable') ? 'issue' : 'clear' };
}
const summaryFor = (status: TestStatus, outcome: BusinessTest['outcome']) =>
  status === 'completed' ? outcome === 'issue' ? '测试已完成，确认的问题保留在问题列表。' : outcome === 'functional' ? '已完成声明的页面与加密通信检查。' : '本项检查未发现已确认问题，不代表应用不存在其他风险。'
  : status === 'failed' ? '本项执行未完成，不能据此判断是否存在漏洞。'
  : status === 'blocked' ? '测试条件不满足，请检查授权、测试身份或设备连接。'
  : status === 'review' ? '已产生测试结果，但证据不足，尚不能确认结论。'
  : status === 'skipped' ? '本项已跳过，不计入完成数量。'
  : status === 'not_run' ? '本轮未执行此项，不计入完成数量。'
  : status === 'running' ? '正在执行并核对实际结果。' : '等待执行。';

/** Deterministic product read model: one business test per candidate, not per orchestration task. */
export function buildProductAssessmentState(snapshot: AIScanSnapshot, nowMs = Date.now()): ProductAssessmentState {
  const run = productRun(snapshot.run), ended = terminal(run.status);
  const functions = new Map<string, BusinessFunction>();
  const ensure = (id: string, name: string) => {
    if (!functions.has(id)) functions.set(id, { id, name, tests: [], status: 'pending', checked: false });
    return functions.get(id)!;
  };
  const tasks = snapshot.tasks.filter(t => t.vuln_type && !HELPERS.has(t.task_type) && t.execution_plan?.role !== 'campaign_parent');
  const ownedTasks = new Set<string>();
  const testByTask = new Map<string, { test: BusinessTest; feature: BusinessFunction }>();
  const addTest = (id: string, name: string, featureId: string, featureName: string, matched: AIScanTask[]) => {
    const feature = ensure(featureId, featureName);
    const verdict = taskVerdict(matched, snapshot.artifacts, ended);
    const test: BusinessTest = { id, name, ...verdict, checked: verdict.status === 'completed', status_label: verdict.status === 'completed' ? '已完成' : STATUS[verdict.status],
      summary: summaryFor(verdict.status, verdict.outcome), issue_ids: [], task_ids: matched.map(t => t.id),
      evidence_count: snapshot.artifacts.filter(a => a.artifact_type === 'ai_judgement' && matched.some(t => a.task_id === t.id)).length };
    feature.tests.push(test);
    for (const task of matched) { ownedTasks.add(task.id); testByTask.set(task.id, { test, feature }); }
  };
  for (const candidate of [...snapshot.candidates].sort(byTime)) {
    // A direct candidate id is authoritative. Fallback only to an unclaimed task with no candidate id.
    const matched = tasks.filter(t => !ownedTasks.has(t.id) && (t.execution_plan?.candidate_id === candidate.id ||
      (!t.execution_plan?.candidate_id && t.feature_id === candidate.feature_id && t.vuln_type === candidate.vuln_type &&
       t.endpoint_ids.some(e => candidate.endpoint_ids.includes(e)))));
    const feature = snapshot.features.find(f => f.id === candidate.feature_id);
    const name = businessName(feature?.name || matched[0]?.execution_plan?.function_name || candidate.title?.split(/[:：]/)[0]);
    const fid = feature?.id || `business:${name}`;
    addTest(`test:${candidate.id}`, LABELS[candidate.vuln_type] || '安全检查', fid, name, matched);
    const test = functions.get(fid)!.tests.at(-1)!;
    if (!matched.length && (candidate.status === 'skipped' || (snapshot.run.selected_vuln_types.length && !snapshot.run.selected_vuln_types.includes(candidate.vuln_type)))) {
      test.status = 'skipped'; test.status_label = STATUS.skipped; test.summary = summaryFor('skipped','inconclusive'); test.outcome = 'inconclusive';
    }
  }
  for (const task of [...tasks].sort(byTime).filter(t => !ownedTasks.has(t.id))) {
    const feature = snapshot.features.find(f => f.id === task.feature_id);
    const name = businessName(feature?.name || task.execution_plan?.function_name);
    addTest(`task:${task.id}`, LABELS[task.vuln_type!] || '安全检查', feature?.id || `business:${name}`, name, [task]);
  }
  // App UI/HTTPS business cases exist before endpoint discovery; never replace them with internal capture tasks.
  const steps: Array<Record<string, any>> = Array.isArray(snapshot.run.scan_config?.mobile?.flow_steps) ? snapshot.run.scan_config.mobile.flow_steps : [];
  const cases = new Map<string, {name: string; feature: string; indexes: number[]}>();
  steps.forEach((step, index) => {
    const key = String(step.business_test_id || `step-${index}`);
    if (!cases.has(key)) cases.set(key, { name: businessText(step.test_name || step.name, `业务操作 ${index + 1}`), feature: businessName(step.business_name, 'App 业务操作'), indexes: [] });
    cases.get(key)!.indexes.push(index);
  });
  for (const [key, item] of cases) {
    const feature = ensure(`mobile:${item.feature}`, item.feature);
    const progress = newest(snapshot.artifacts.filter(a => a.artifact_type === 'business_test_progress' && a.content_json?.test_key === key));
    const p = progress?.content_json;
    let status: TestStatus = p?.status === 'running' ? 'running' : p?.status === 'failed' ? 'failed' : p?.status === 'completed' && p?.assertions_verified === true ? 'completed' : ended ? 'not_run' : 'pending';
    if (p && ['not_run','blocked','skipped'].includes(p.status)) status = p.status;
    if (p?.status === 'completed' && p?.assertions_verified !== true) status = 'review';
    const test: BusinessTest = { id: `mobile:${key}`, name: item.name, status, status_label: status === 'completed' ? '已完成' : STATUS[status], outcome: status === 'completed' ? 'functional' : 'pending', checked: status === 'completed',
      summary: summaryFor(status, 'functional'), task_ids: progress?.task_id ? [progress.task_id] : [], issue_ids: [], evidence_count: Number(p?.evidence_count || 0) };
    feature.tests.push(test);
  }
  // Keep observed functions visible without fabricating tests or multiplying endpoint groups.
  for (const feature of [...snapshot.features].sort(byTime)) {
    if (!feature.parent_id || feature.endpoint_ids.length) ensure(feature.id, businessName(feature.name));
  }
  const riskEvidence: AssessmentIssue[] = [], reviewEvidence: AssessmentIssue[] = [];
  // Latest judgement per task+source; repeated updates must not inflate risk counts.
  const judgementKeys = new Set<string>();
  const judgements = [...snapshot.artifacts].filter(a => a.artifact_type === 'ai_judgement').sort((a,b) => stamp(b)-stamp(a) || b.id.localeCompare(a.id));
  for (const a of judgements) {
    const key = `${a.task_id || ''}:${a.source_ref || ''}`;
    if (judgementKeys.has(key)) continue; judgementKeys.add(key);
    const value = a.content_json, test = a.task_id ? testByTask.get(a.task_id) : undefined;
    if (!test || value.verdict === 'not_vulnerable') continue;
    const hasGap = snapshot.artifacts.some(g => g.task_id === a.task_id &&
      ['finding_created_with_replay_gap','finding_blocked_by_workflow_preconditions','workflow_precondition_block'].includes(g.artifact_type) && stamp(g) >= stamp(a));
    const confirmed = value.verdict === 'vulnerable' && value.native_evidence_gate?.verdict === 'confirmed' && evidenceComplete(a) && !hasGap;
    const severity = ['critical','high','medium','low','info'].includes(value.severity) ? value.severity : 'info';
    const issue: AssessmentIssue = { id: `issue:${a.id}`, title: businessText(value.business_title, `${test.feature.name} · ${test.test.name}`),
      feature_name: test.feature.name, test_name: test.test.name, status: confirmed ? 'confirmed' : 'review',
      summary: confirmed ? businessText(value.business_impact, `${test.feature.name}的${test.test.name}发现已通过证据核对的问题。`, 500) : '检测到风险信号，但缺少充分证据，尚未确认为漏洞。',
      severity, evidence_count: value.native_evidence_gate?.native_test_run_ids?.length || 0, test_id: test.test.id, created_at: a.created_at };
    if (confirmed) { riskEvidence.push(issue); test.test.issue_ids.push(issue.id); }
    else { reviewEvidence.push(issue); if (test.test.checked) { test.test.checked = false; test.test.status = 'review'; test.test.status_label = STATUS.review; test.test.outcome = 'inconclusive'; test.test.summary = summaryFor('review','inconclusive'); } }
  }
  const businessFunctions = [...functions.values()].map(f => ({...f, status: aggregate(f.tests), checked: f.tests.length > 0 && f.tests.every(t => t.checked)}));
  const all = businessFunctions.flatMap(f => f.tests);
  const counts = Object.fromEntries(['completed','running','failed','blocked','skipped','review','not_run','pending'].map(s => [s, all.filter(t => t.status === s).length])) as Record<TestStatus, number>;
  const frames: AssessmentFrame[] = snapshot.artifacts.filter(a => ['mobile_device_state','browser_state','browser_agent_state','assessment_live_frame'].includes(a.artifact_type) && Boolean(a.content_text))
    .sort((a,b) => stamp(b)-stamp(a) || b.id.localeCompare(a.id)).map<AssessmentFrame>(a => {
      const data = a.content_json || {}, task = snapshot.tasks.find(t => t.id === a.task_id);
      const mobileKey = data.test_key ? `mobile:${data.test_key}` : null;
      const linked = all.find(t => mobileKey ? t.id === mobileKey : Boolean(a.task_id && t.task_ids.includes(a.task_id)));
      const simulated = data.evidence_level === 'simulated' || data.simulated === true;
      const surface: 'web' | 'android' = a.artifact_type === 'mobile_device_state' || data.surface === 'android' ? 'android' : 'web';
      const fresh = nowMs - stamp(a) >= -2000 && nowMs - stamp(a) < 10000;
      const taskActive = (task?.status === 'running' || (!a.task_id && !ended)) && (!mobileKey || linked?.status === 'running');
      const observing = a.artifact_type === 'assessment_live_frame' && data.observing !== false;
      const state: AssessmentFrame['state'] = ended ? 'recorded' : !taskActive || !observing ? 'reference' : fresh ? 'live' : 'stale';
      return { id: a.id, image_url: `/api/ai-scans/${encodeURIComponent(run.id)}/frames/${encodeURIComponent(a.id)}?v=${stamp(a)}`,
        captured_at: new Date(stamp(a)).toISOString(), task_id: a.task_id || null, test_id: linked?.id || null,
        test_name: linked ? `${businessFunctions.find(f => f.tests.includes(linked))?.name || ''} · ${linked.name}` : '业务页面观察',
        surface, source: simulated ? 'simulated' : surface === 'android' ? 'device' : 'browser', state };
    }).filter(f => f.surface === run.surface);
  const distinctFrames = frames.filter((f,i,allFrames) => allFrames.findIndex(g => g.task_id === f.task_id && g.test_id === f.test_id) === i);
  const currentWork = all.filter(t => t.status === 'running').map(t => ({ id: t.id, name: t.name, status: 'running', task_id: t.task_ids[0] || null }));
  return { version: 2, run, active_surface: run.surface,
    totals: { business_functions: businessFunctions.length, tests: all.length, ...counts, confirmed_risks: riskEvidence.length, review_signals: reviewEvidence.length, progress: all.length ? Math.round(counts.completed / all.length * 100) : 0 },
    business_functions: businessFunctions, current_work: currentWork, risk_evidence: riskEvidence, review_evidence: reviewEvidence,
    live_surface: distinctFrames.find(f => f.state === 'live') || distinctFrames.find(f => f.test_id && currentWork.some(t => t.id === f.test_id)) || (currentWork.length ? null : distinctFrames[0] || null), frames: distinctFrames,
    phase_label: STATUS[run.status] || '等待执行',
    notice: run.status === 'failed' && all.length > 0 && counts.completed === all.length ? '业务检查已完成，但本轮收尾或清理失败，整体测试不能视为通过。请由管理员核对测试环境。' : ended && counts.completed < all.length ? '本轮已停止，仍有测试未完成。未执行、跳过和待复核项不计入完成。' : !all.length ? '正在识别可执行的业务测试；不会把示例清单冒充实际覆盖。' : '' };
}
