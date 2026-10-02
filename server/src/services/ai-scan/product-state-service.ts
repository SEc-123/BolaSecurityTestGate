import { sanitizeModelString } from '../../agent/model-context-sanitizer.js';
import type { AIScanSnapshot, AIScanRun, AIScanTask, AIScanArtifact } from './types.js';
import { isPublicProductFrameArtifactType } from './product-frame-policy.js';
import { sealedStrictObjectiveBindings } from './agent-business-contract.js';
import type { AssessmentRun, BusinessFunction, BusinessTest, ProductAssessmentState, TestStatus, AssessmentIssue, AssessmentFrame, AssessmentOperation, AssessmentReference, BusinessFlow, BusinessExperiment } from './product-state-types.js';

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
function aggregate(tests: Array<{status: TestStatus}>): TestStatus {
  if (!tests.length) return 'pending';
  for (const status of ['running', 'failed', 'blocked', 'review', 'pending', 'not_run', 'skipped'] as const)
    if (tests.some(t => t.status === status)) return status;
  return 'completed';
}
function evidenceGate(a?:AIScanArtifact):any{return a?.content_json?.experiment_evidence_gate||a?.content_json?.upload_evidence_gate||a?.content_json?.native_evidence_gate;}
function evidenceComplete(a?: AIScanArtifact): boolean {
  const upload=a?.content_json?.upload_evidence_gate;
  if(upload)return upload.execution_kind==='multipart'&&upload.baseline_verified===true&&upload.mutation_executed===true&&Array.isArray(upload.evidence_artifact_ids)&&upload.evidence_artifact_ids.length>=2&&Array.isArray(upload.missing_evidence)&&upload.missing_evidence.length===0;
  const gate = a?.content_json?.native_evidence_gate;
  return Boolean(gate && gate.preconditions_satisfied !== false && gate.baseline_verified === true && gate.mutation_executed === true &&
    gate.template_executed === true && gate.native_api_mode_executed === true &&
    Array.isArray(gate.native_test_run_ids) && gate.native_test_run_ids.length &&
    Array.isArray(gate.missing_evidence) && gate.missing_evidence.length === 0);
}
function newest(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  return [...artifacts].sort((a, b) => stamp(b) - stamp(a) || b.id.localeCompare(a.id))[0];
}
function newestRevision(artifacts: AIScanArtifact[]): AIScanArtifact | undefined {
  return [...artifacts].sort((a, b) => Number(b.content_json?.revision || 0) - Number(a.content_json?.revision || 0) ||
    stamp(b) - stamp(a) || b.id.localeCompare(a.id))[0];
}
function latestExperimentResult(snapshot: AIScanSnapshot, planId: string): AIScanArtifact | undefined {
  const plan = newestRevision(snapshot.artifacts.filter(a => a.artifact_type === 'agent_experiment_plan' && a.content_json?.id === planId));
  return newestRevision(snapshot.artifacts.filter(a => a.artifact_type === 'agent_experiment_result' &&
    (a.content_json?.plan_id || a.content_json?.id || a.source_ref) === planId &&
    (!plan?.content_json?.revision || Number(a.content_json?.plan_revision) === Number(plan.content_json.revision))));
}
function matchingExperimentProof(snapshot: AIScanSnapshot, planId: string, result: Record<string, any>): AIScanArtifact | undefined {
  return newest(snapshot.artifacts.filter(a => a.artifact_type === 'business_state_proof' &&
    (!a.scan_run_id || a.scan_run_id === snapshot.run.id) &&
    (a.content_json?.plan_id || a.source_ref) === planId &&
    (!result.plan_revision || Number(a.content_json?.plan_revision) === Number(result.plan_revision)) &&
    (!result.source_flow_revision || Number(a.content_json?.source_flow_revision) === Number(result.source_flow_revision)) &&
    (a.content_json?.result_revision === undefined || Number(a.content_json.result_revision) === Number(result.revision)) &&
    (!a.content_json?.flow_id || a.content_json.flow_id === result.flow_id)));
}
function experimentalEvidenceComplete(snapshot: AIScanSnapshot, planId: string): boolean {
  const result = latestExperimentResult(snapshot, planId)?.content_json;
  if (!result || !['executed', 'completed', 'verified'].includes(result.status) || result.execution_verified !== true ||
    result.control_verified !== true || result.business_invariant_verified !== true || result.evidence_ready !== true ||
    !Array.isArray(result.missing_evidence) || result.missing_evidence.length ||
    !Array.isArray(result.native_test_run_ids) || new Set(result.native_test_run_ids).size < 2) return false;
  const flow = newestRevision(snapshot.artifacts.filter(a => a.artifact_type === 'business_flow' && a.content_json?.id === result.flow_id &&
    (!result.source_flow_revision || Number(a.content_json?.revision) === Number(result.source_flow_revision))))?.content_json;
  if (!flow || flow.status !== 'verified' || flow.assertions_verified !== true || !referenceId(flow.normal_run_id) ||
    !Array.isArray(flow.assertions) || !flow.assertions.length || flow.assertions.some((check: any) => check?.passed !== true)) return false;
  if (!Array.isArray(result.assertions) || !result.assertions.length || !Array.isArray(result.control_assertions) || !result.control_assertions.length) return false;
  const checks = [...(Array.isArray(result.assertions) ? result.assertions : []), ...(Array.isArray(result.control_assertions) ? result.control_assertions : [])];
  if (!checks.length || checks.some(check => check?.passed !== true)) return false;
  // Assessment proof is emitted after native execution. Match its immutable
  // experiment revisions rather than requiring the earlier result to cite it.
  const proof = matchingExperimentProof(snapshot, planId, result)?.content_json;
  return Boolean(proof?.execution_verified === true && proof.control_verified === true &&
    (proof.business_invariant_verified === true || proof.verified === true));
}
function providerDenialDiagnostics(artifacts: AIScanArtifact[]): Array<{task_id?:string;message:string}> {
  const denied = artifacts.filter(a => a.artifact_type === 'agent_decision' && a.content_json?.source === 'fallback' &&
    a.content_json?.provider_access_denied === true);
  const taskIds = [...new Set(denied.map(a => a.task_id).filter((id): id is string => Boolean(id)))];
  const message = '模型服务因安全策略或权限拒绝了本轮请求；安全分析未完成。请核对账号、工作区、模型和 Codex 入口的授权范围。当前结果不代表“未发现风险”。';
  return denied.length ? [{...(taskIds.length === 1 ? {task_id:taskIds[0]} : {}),message}] : [];
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
    (a!.content_json.verdict !== 'vulnerable' || evidenceGate(a)?.verdict === 'confirmed') &&
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

const referenceId = (value: unknown): string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(value) ? value : '';
const objectiveOperationReceipt = (data: Record<string, any>): BusinessFlow['objective_operation_receipt'] | undefined => {
  const contract = data.objective_operation, binding = data.objective_operation_binding;
  const operationId = referenceId(contract?.operation_id), sideEffectClass = typeof contract?.side_effect_class === 'string' &&
    ['authentication','update','add','create','transaction','write'].includes(contract.side_effect_class) ? contract.side_effect_class : '';
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(referenceId).filter(Boolean))].slice(0, 200) : [];
  const orders: number[] = Array.isArray(binding?.source_step_orders) ? [...new Set((binding.source_step_orders as unknown[]).flatMap((order: unknown) =>
    Number.isInteger(order) && Number(order) > 0 && Number(order) <= 1_000_000 ? [Number(order)] : []))].sort((a,b) => a-b) : [];
  const sourceWorkflowId=referenceId(binding?.source_workflow_id),normalWorkflowId=referenceId(binding?.normal_workflow_id),normalRunId=referenceId(binding?.normal_run_id),
    validationArtifactId=referenceId(binding?.validation_artifact_id),sourceEventIds=ids(binding?.source_event_ids),actionIds=ids(binding?.action_ids),assertionIds=ids(binding?.validation_assertion_ids);
  if (!operationId || !sideEffectClass || binding?.operation_id !== operationId || binding?.side_effect_class !== sideEffectClass || binding?.validated !== true ||
    !sourceWorkflowId || !normalWorkflowId || !normalRunId || !validationArtifactId || !sourceEventIds.length || !actionIds.length || !orders.length || !assertionIds.length) return undefined;
  return {operation_id:operationId,side_effect_class:sideEffectClass,source_event_ids:sourceEventIds,action_ids:actionIds,source_workflow_id:sourceWorkflowId,
    source_step_orders:orders,normal_workflow_id:normalWorkflowId,normal_run_id:normalRunId,validation_assertion_ids:assertionIds,validation_artifact_id:validationArtifactId,validated:true};
};


const safeList = (value: unknown, fallback: string): string[] => Array.isArray(value)
  ? value.map(item => businessText(typeof item === 'string' ? item : item?.reason || item?.message, fallback, 500)).filter(Boolean) : [];
function artifactReferences(data: Record<string, any>, snapshot: AIScanSnapshot): AssessmentReference[] {
  const references: AssessmentReference[] = [];
  const executionIds = [data.normal_run_id, ...(Array.isArray(data.native_test_run_ids) ? data.native_test_run_ids : []),
    ...(Array.isArray(data.test_run_ids) ? data.test_run_ids : [])];
  for (const value of executionIds) {
    const id = referenceId(value);
    if (id && !references.some(ref => ref.id === id)) references.push({ id, title: '实际执行记录', kind: 'execution' });
  }
  const evidenceIds = Array.isArray(data.evidence_artifact_ids) ? data.evidence_artifact_ids : Array.isArray(data.evidence) ? data.evidence : [];
  for (const value of evidenceIds) {
    const id = referenceId(typeof value === 'string' ? value : value?.artifact_id || value?.id);
    const artifact = snapshot.artifacts.find(item => item.id === id && (!item.scan_run_id || item.scan_run_id === snapshot.run.id));
    if (artifact && !references.some(ref => ref.id === id)) references.push({ id, title: businessText(artifact.title, '验证证据'), kind: 'evidence' });
  }
  return references;
}

/** Project observed normal paths independently of vulnerability candidates and campaign completion. */
function addBusinessFlows(snapshot: AIScanSnapshot, ended: boolean, ensure: (id: string, name: string) => BusinessFunction): void {
  const groupedFlows = new Map<string, AIScanArtifact[]>();
  for (const artifact of snapshot.artifacts.filter(a => a.artifact_type === 'business_flow')) {
    const id = referenceId(artifact.content_json?.id) || referenceId(artifact.source_ref) || artifact.id;
    groupedFlows.set(id, [...(groupedFlows.get(id) || []), artifact]);
  }
  const flowFeatures = new Map<string, BusinessFunction>();
  const featureFor = (data: Record<string, any>, taskId?: string | null) => {
    const task = snapshot.tasks.find(t => t.id === taskId);
    const feature = snapshot.features.find(f => f.id === (data.feature_id || task?.feature_id)) ||
      snapshot.features.find(f => businessName(f.name) === businessName(data.feature_name || data.name));
    const name = businessName(feature?.name || data.feature_name || data.name);
    return ensure(feature?.id || `business:${name}`, name);
  };
  for (const [id, artifacts] of groupedFlows) {
    const artifact = newestRevision(artifacts)!, data = artifact.content_json || {}, feature = featureFor(data, artifact.task_id);
    const checks: BusinessFlow['checks'] = (Array.isArray(data.assertions) ? data.assertions : []).map((check: any) => ({
      name: businessText(typeof check === 'string' ? check : check?.name || check?.description || check?.title, '业务结果检查'),
      passed: typeof check?.passed === 'boolean' ? check.passed : null,
    }));
    const operationReceipt = objectiveOperationReceipt(data);
    const strictBindingsSealed = sealedStrictObjectiveBindings(data as any);
    const verified = Boolean(referenceId(data.normal_run_id) && !checks.some(check => check.passed === false) && strictBindingsSealed &&
      (!data.objective_operation || operationReceipt) && (data.assertions_verified === true || !data.revision && data.baseline_verified === true));
    const task = snapshot.tasks.find(t => t.id === artifact.task_id);
    const rawStatus = String(data.status || 'discovered');
    const status: BusinessFlow['status'] = rawStatus === 'verified' ? verified ? 'verified' : 'review'
      : rawStatus === 'blocked' ? 'blocked' : rawStatus === 'failed' ? 'failed'
      : rawStatus === 'learning' ? ended || task?.status === 'failed' ? 'failed' : task?.status === 'blocked' ? 'blocked' : 'learning' : 'not_run';
    const blockers = safeList(data.blockers, '缺少完成此流程所需的测试条件。');
    if (rawStatus === 'verified' && !verified) blockers.push('缺少正常流程的执行记录或业务结果验证；严格目标还需要已封存的操作回执，尚不能确认流程已跑通。');
    if (rawStatus === 'learning' && status === 'failed') blockers.push('本轮执行已结束，未取得此正常流程的完成证据。');
    const roleLabels: Record<string, string> = { attacker: '攻击者账号', victim: '受害者账号', admin: '管理员账号', user: '测试账号', anonymous: '访客身份' };
    const flow: BusinessFlow = { id, ...(referenceId(data.objective_id) ? {objective_id: referenceId(data.objective_id)} : {}),
      ...(operationReceipt ? {objective_operation_receipt: operationReceipt} : {}),
      name: businessName(data.name, feature.name), goal: businessText(data.goal, '核对该功能的正常业务结果。', 500),
      role: roleLabels[data.role] || businessText(data.role, '', 80), status,
      status_label: { not_run: '未运行', learning: '学习中', verified: '已验证', blocked: '受阻', failed: '失败', review: '待核验' }[status],
      summary: status === 'verified' ? '正常流程已执行并核对业务结果；安全实验另行验证。'
        : status === 'learning' ? '正在观察正常操作及接口依赖。' : blockers[0] || (status === 'not_run' ? '已识别此流程，尚未完成正常运行验证。' : '正常流程尚未取得充分验证。'),
      blockers, checks, references: artifactReferences(data, snapshot), task_ids: artifact.task_id ? [artifact.task_id] : [],
      steps: (Array.isArray(data.steps) ? data.steps : []).map((step: any, index: number) => ({
        id: referenceId(step?.id) || `step-${index + 1}`, name: businessText(step?.name || step?.title || step?.description, `业务步骤 ${index + 1}`),
        status_label: step?.verified === true || step?.status === 'verified' ? '已验证' : step?.status === 'failed' ? '失败' : step?.status === 'blocked' ? '受阻' : step?.status === 'running' ? '正在执行' : '已观察',
      })) };
    (feature.normal_flows ||= []).push(flow); flowFeatures.set(id, feature);
  }
  const experiments = new Map<string, AIScanArtifact[]>();
  for (const artifact of snapshot.artifacts.filter(a => ['agent_experiment_plan', 'agent_experiment_result'].includes(a.artifact_type))) {
    const data = artifact.content_json || {}, id = referenceId(data.plan_id || data.experiment_id || data.id || artifact.source_ref) || artifact.id;
    experiments.set(id, [...(experiments.get(id) || []), artifact]);
  }
  for (const [id, artifacts] of experiments) {
    const plan = newestRevision(artifacts.filter(a => a.artifact_type === 'agent_experiment_plan'));
    const result = newestRevision(artifacts.filter(a => a.artifact_type === 'agent_experiment_result' && (!plan ||
      (plan.content_json?.revision ? Number(a.content_json?.plan_revision) === Number(plan.content_json.revision) : stamp(a) >= stamp(plan)))));
    const artifact = result || plan!, data = { ...(plan?.content_json || {}), ...(result?.content_json || {}) };
    const feature = flowFeatures.get(data.flow_id) || featureFor(data, artifact.task_id);
    // A plan can cite saved evidence, but only execution results can supply new run references.
    const proof = result ? matchingExperimentProof(snapshot, id, data) : undefined;
    const references = artifactReferences(result ? { ...data, evidence_artifact_ids: [...(data.evidence_artifact_ids || []), ...(proof ? [proof.id] : [])] }
      : { ...data, normal_run_id: undefined, native_test_run_ids: [], test_run_ids: [] }, snapshot), rawStatus = String(data.status || 'pending');
    const completed = Boolean(result && (['completed', 'verified'].includes(rawStatus) || rawStatus === 'executed' && data.execution_verified === true) && references.some(ref => ref.kind === 'execution'));
    const status: TestStatus = completed ? 'completed' : rawStatus === 'blocked' ? 'blocked' : rawStatus === 'failed' ? 'failed'
      : ['completed', 'verified', 'executed'].includes(rawStatus) && (result || rawStatus === 'executed') ? 'review' : rawStatus === 'running' ? ended ? 'failed' : 'running' : ended ? 'not_run' : 'pending';
    const experiment: BusinessExperiment = { id, flow_id: referenceId(data.flow_id), name: businessText(data.name || data.title, '模型提出的安全实验'),
      hypothesis: businessText(data.hypothesis, '实验假设尚未记录。', 700), status, status_label: status === 'completed' ? '已执行' : status === 'pending' ? rawStatus === 'compiled' ? '待执行' : '待准备' : STATUS[status],
      summary: status === 'completed' ? '实验已执行，是否构成漏洞仍需核对业务证据。' : businessText(data.summary || data.reason, summaryFor(status, 'inconclusive'), 500),
      blockers: safeList(data.blockers || data.missing_evidence, '实验缺少必要的验证证据。'), references,
      task_ids: [...new Set(artifacts.map(a => a.task_id).filter((value): value is string => Boolean(value)))] };
    (feature.experiments ||= []).push(experiment);
  }
}

/** Deterministic product read model: one business test per candidate, not per orchestration task. */
export function buildProductAssessmentState(snapshot: AIScanSnapshot, nowMs = Date.now()): ProductAssessmentState {
  const run = productRun(snapshot.run), ended = terminal(run.status);
  const functions = new Map<string, BusinessFunction>();
  const ensure = (id: string, name: string) => {
    if (!functions.has(id)) functions.set(id, { id, name, tests: [], status: 'pending', checked: false });
    return functions.get(id)!;
  };
  const tasks = snapshot.tasks.filter(t => t.vuln_type && !HELPERS.has(t.task_type) && t.execution_plan?.role !== 'campaign_parent');
  const campaignPlans = snapshot.artifacts.filter(a => a.artifact_type === 'vulnerability_campaign_plan');
  const ownedTasks = new Set<string>();
  const testByTask = new Map<string, { test: BusinessTest; feature: BusinessFunction }>();
  const addTest = (id: string, name: string, featureId: string, featureName: string, matched: AIScanTask[]) => {
    const feature = ensure(featureId, featureName);
    const verdict = taskVerdict(matched, snapshot.artifacts, ended);
    const test: BusinessTest = { id, name, ...verdict, checked: verdict.status === 'completed', status_label: verdict.status === 'completed' ? '已完成' : STATUS[verdict.status],
      summary: summaryFor(verdict.status, verdict.outcome), issue_ids: [], task_ids: matched.map(t => t.id),
      evidence_count: snapshot.artifacts.filter(a => a.artifact_type === 'ai_judgement' && matched.some(t => a.task_id === t.id)).length };
    if (verdict.status === 'blocked') {
      const reason = matched.find(t => t.status === 'blocked' && t.result_summary)?.result_summary;
      if (reason) test.summary = sanitizeModelString(reason).slice(0,1000);
    }
    feature.tests.push(test);
    for (const task of matched) { ownedTasks.add(task.id); testByTask.set(task.id, { test, feature }); }
  };
  for (const candidate of [...snapshot.candidates].sort(byTime)) {
    // A direct candidate id is authoritative. Fallback only to an unclaimed task with no candidate id.
    const matched = tasks.filter(t => !ownedTasks.has(t.id) && (t.execution_plan?.candidate_id === candidate.id ||
      (!t.execution_plan?.candidate_id && t.feature_id === candidate.feature_id && t.vuln_type === candidate.vuln_type &&
       t.endpoint_ids.some(e => candidate.endpoint_ids.includes(e)))));
    if (!matched.length && snapshot.run.selected_vuln_types.length && !snapshot.run.selected_vuln_types.includes(candidate.vuln_type)) continue;
    const feature = snapshot.features.find(f => f.id === candidate.feature_id);
    const name = businessName(feature?.name || matched[0]?.execution_plan?.function_name || candidate.title?.split(/[:：]/)[0]);
    const fid = feature?.id || `business:${name}`;
    addTest(`test:${candidate.id}`, LABELS[candidate.vuln_type] || '安全检查', fid, name, matched);
    const test = functions.get(fid)!.tests.at(-1)!;
    if (!matched.length && (candidate.status === 'skipped' || (snapshot.run.selected_vuln_types.length && !snapshot.run.selected_vuln_types.includes(candidate.vuln_type)))) {
      test.status = 'skipped'; test.status_label = STATUS.skipped; test.summary = summaryFor('skipped','inconclusive'); test.outcome = 'inconclusive';
    } else if (!matched.length && run.status === 'completed' &&
      campaignPlans.some(plan => plan.content_json?.vuln_type === candidate.vuln_type && Array.isArray(plan.content_json?.selected_candidates)) &&
      !campaignPlans.some(plan => plan.content_json?.vuln_type === candidate.vuln_type &&
        plan.content_json?.selected_candidates?.some((selected: any) => selected.id === candidate.id))) {
      // The campaign explicitly sampled another candidate. Keep this one visible,
      // but do not report it as an abandoned task or imply its risk was tested.
      test.status = 'skipped'; test.status_label = STATUS.skipped;
      test.summary = '本候选未入选执行计划，未单独测试；不计入已完成或已确认的问题。';
      test.outcome = 'inconclusive';
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
  addBusinessFlows(snapshot, ended, ensure);
  const riskEvidence: AssessmentIssue[] = [], reviewEvidence: AssessmentIssue[] = [];
  const experimentalContext = (artifact: AIScanArtifact): {test: BusinessTest; feature: BusinessFunction; planId?: string; standalone?: boolean} | undefined => {
    const value = artifact.content_json || {};
    let planId = referenceId(value.plan_id || value.experiment_id || evidenceGate(artifact)?.plan_id);
    if (!planId) {
      const linked = snapshot.artifacts.find(a => a.artifact_type === 'agent_experiment_result' &&
        (a.content_json?.judgement_artifact_id === artifact.id || value.finding_id && a.content_json?.finding_id === value.finding_id ||
          a.id === artifact.source_ref || a.source_ref === artifact.source_ref));
      planId = referenceId(linked?.content_json?.plan_id || linked?.content_json?.id);
      if (!planId && snapshot.artifacts.some(a => a.artifact_type === 'agent_experiment_plan' && a.content_json?.id === artifact.source_ref)) planId = referenceId(artifact.source_ref);
    }
    for (const feature of functions.values()) {
      const experiment = feature.experiments?.find(e => e.id === planId);
      if (!experiment) continue;
      return { feature, planId: experiment.id, test: { id: `experiment:${experiment.id}`, name: experiment.name, status: experiment.status,
        status_label: experiment.status_label, outcome: 'inconclusive', checked: false, summary: experiment.summary,
        issue_ids: [], evidence_count: experiment.references.length, task_ids: experiment.task_ids } };
    }
    const existing = artifact.task_id ? testByTask.get(artifact.task_id) : undefined;
    if (existing) return existing;
    // A saved judgment/finding is observable even when it has no old candidate task.
    const task = snapshot.tasks.find(t => t.id === artifact.task_id);
    const observed = snapshot.features.find(f => f.id === (value.feature_id || task?.feature_id));
    const flowFeature = [...functions.values()].find(f => f.normal_flows?.some(flow => flow.id === value.flow_id));
    const feature = flowFeature || ensure(observed?.id || 'business:observed-results', businessName(observed?.name, '业务安全观察'));
    const test: BusinessTest = { id: `test:${artifact.id}`, name: businessText(value.business_title, '业务安全验证'), status: 'review', status_label: STATUS.review,
      outcome: 'inconclusive', checked: false, summary: summaryFor('review', 'inconclusive'), issue_ids: [], evidence_count: 0,
      task_ids: artifact.task_id ? [artifact.task_id] : [] };
    feature.tests.push(test);
    return { test, feature, standalone: true, ...(planId ? {planId} : {}) };
  };
  // Latest judgement per task+source; repeated updates must not inflate risk counts.
  const judgementKeys = new Set<string>();
  const derivedJudgements: AIScanArtifact[] = snapshot.artifacts.filter(a => a.artifact_type === 'agent_experiment_result').flatMap(a => {
    const value = a.content_json || {}, decision = value.decision || value.judge || value.judgement;
    if (!decision || !['vulnerable', 'not_vulnerable', 'inconclusive'].includes(decision.verdict)) return [];
    return [{ ...a, id: `judgement:${a.id}`, artifact_type: 'ai_judgement', source_ref: value.plan_id || a.source_ref,
      content_json: { ...decision, plan_id: value.plan_id, flow_id: value.flow_id, finding_id: value.finding_id,
        experiment_evidence_gate: value.experiment_evidence_gate } }];
  });
  const judgements = [...snapshot.artifacts.filter(a => a.artifact_type === 'ai_judgement'), ...derivedJudgements].sort((a,b) => stamp(b)-stamp(a) || b.id.localeCompare(a.id));
  const representedFindings = new Set<string>();
  const representedSources = new Set<string>();
  for (const a of judgements) {
    const value = a.content_json;
    const planId = referenceId(value.plan_id || value.experiment_id || evidenceGate(a)?.plan_id);
    const key = planId ? `experiment:${planId}` : `${a.task_id || ''}:${a.source_ref || ''}`;
    if (judgementKeys.has(key)) continue; judgementKeys.add(key);
    if (value.finding_id) representedFindings.add(value.finding_id);
    representedSources.add(`${a.task_id || ''}:${a.source_ref || ''}`);
    if (value.verdict === 'not_vulnerable') continue;
    const test = experimentalContext(a);
    if (!test) continue;
    const hasGap = snapshot.artifacts.some(g => g.task_id === a.task_id &&
      ['finding_created_with_replay_gap','finding_blocked_by_workflow_preconditions','workflow_precondition_block'].includes(g.artifact_type) && stamp(g) >= stamp(a) &&
      (!test.planId || g.content_json?.plan_id === test.planId || g.source_ref === test.planId));
    const complete = test.planId ? experimentalEvidenceComplete(snapshot, test.planId) : evidenceComplete(a);
    const confirmed = value.verdict === 'vulnerable' && complete && !hasGap && (test.planId ? true : evidenceGate(a)?.verdict === 'confirmed');
    const severity = ['critical','high','medium','low','info'].includes(value.severity) ? value.severity : 'info';
    const issue: AssessmentIssue = { id: `issue:${a.id}`, title: businessText(value.business_title, `${test.feature.name} · ${test.test.name}`),
      feature_name: test.feature.name, test_name: test.test.name, status: confirmed ? 'confirmed' : 'review',
      summary: confirmed ? businessText(value.business_impact, `${test.feature.name}的${test.test.name}发现已通过证据核对的问题。`, 500) : '检测到风险信号，但缺少充分证据，尚未确认为漏洞。',
      severity, evidence_count: test.planId ? latestExperimentResult(snapshot, test.planId)?.content_json?.evidence_artifact_ids?.length || 0 : evidenceGate(a)?.evidence_artifact_ids?.length || evidenceGate(a)?.native_test_run_ids?.length || 0, test_id: test.test.id, created_at: a.created_at };
    if (confirmed) { riskEvidence.push(issue); test.test.issue_ids.push(issue.id);
      if (test.standalone) { test.test.status = 'completed'; test.test.checked = true; test.test.status_label = '已完成'; test.test.outcome = 'issue'; test.test.summary = summaryFor('completed', 'issue'); }
    }
    else { reviewEvidence.push(issue); if (test.test.checked) { test.test.checked = false; test.test.status = 'review'; test.test.status_label = STATUS.review; test.test.outcome = 'inconclusive'; test.test.summary = summaryFor('review','inconclusive'); } }
  }
  for (const finding of snapshot.artifacts.filter(a => a.artifact_type === 'assessment_finding')) {
    if (representedFindings.has(finding.content_json?.finding_id) || representedSources.has(`${finding.task_id || ''}:${finding.source_ref || ''}`)) continue;
    const target = experimentalContext(finding)!;
    reviewEvidence.push({ id: `issue:${finding.id}`, title: businessText(finding.content_json?.business_title, '业务安全发现'),
      feature_name: target.feature.name, test_name: target.test.name, status: 'review',
      summary: '已保存此发现，但缺少可关联的执行与业务判断证据，尚未作为确认漏洞计数。',
      severity: ['critical', 'high', 'medium', 'low', 'info'].includes(finding.content_json?.severity) ? finding.content_json.severity : 'info',
      evidence_count: 0, test_id: target.test.id, created_at: finding.created_at });
  }
  const businessFunctions = [...functions.values()].map(f => ({...f, status: aggregate([...f.tests,
    ...(f.normal_flows || []).map(flow => ({status: (flow.status === 'verified' ? 'completed' : flow.status === 'learning' ? 'running' : flow.status) as TestStatus})),
    ...(f.experiments || []).map(experiment => ({status: experiment.status})),
  ]), checked: f.tests.length > 0 && f.tests.every(t => t.checked) &&
    (!f.normal_flows?.length || f.normal_flows.every(flow => flow.status === 'verified')) && (!f.experiments?.length || f.experiments.every(experiment => experiment.status === 'completed')) }));
  const all = businessFunctions.flatMap(f => f.tests);
  const normalFlows = businessFunctions.flatMap(f => f.normal_flows || []);
  const experiments = businessFunctions.flatMap(f => f.experiments || []);
  const counts = Object.fromEntries(['completed','running','failed','blocked','skipped','review','not_run','pending'].map(s => [s, all.filter(t => t.status === s).length])) as Record<TestStatus, number>;
  const operations: AssessmentOperation[] = snapshot.artifacts.filter(a=>a.artifact_type==='mobile_action_progress').sort((a,b)=>{
    return String(a.content_json.started_at).localeCompare(String(b.content_json.started_at)) || byTime(a,b);
  }).map(a=>{
    const data=a.content_json,task=snapshot.tasks.find(t=>t.id===a.task_id);
    const status: AssessmentOperation['status']=data.status==='running'?(ended||task?.status==='failed'?'interrupted':'running'):data.status==='completed'?'completed':'failed';
    return {id:String(data.operation_id||a.id),title:businessText(data.title,'应用操作'),status,
      status_label:status==='interrupted'?'操作已中断':status==='completed'?'操作完成':status==='failed'?'操作失败':'正在操作',
      summary:status==='interrupted'?'执行已中断，未取得操作完成证据。':businessText(data.summary,'请核对本次页面操作记录。',300),
      started_at:String(data.started_at||a.created_at),updated_at:String(data.updated_at||a.updated_at),task_id:a.task_id||null};
  });
  const frames: AssessmentFrame[] = snapshot.artifacts.filter(a => isPublicProductFrameArtifactType(a.artifact_type) && Boolean(a.content_text))
    .sort((a,b) => stamp(b)-stamp(a) || b.id.localeCompare(a.id)).map<AssessmentFrame>(a => {
      const data = a.content_json || {}, task = snapshot.tasks.find(t => t.id === a.task_id);
      const mobileKey = data.test_key ? `mobile:${data.test_key}` : null;
      const linked = all.find(t => mobileKey ? t.id === mobileKey : Boolean(a.task_id && t.task_ids.includes(a.task_id)));
      const simulated = data.evidence_level === 'simulated' || data.simulated === true;
      const surface: 'web' | 'android' = a.artifact_type === 'mobile_device_state' || data.surface === 'android' ? 'android' : 'web';
      const fresh = nowMs - stamp(a) >= -2000 && nowMs - stamp(a) < 10000;
      const operation=data.operation_id?operations.find(o=>o.id===data.operation_id):undefined;
      const taskActive = (!operation||operation.status==='running') && (task?.status === 'running' || (!a.task_id && !ended)) && (!mobileKey || linked?.status === 'running');
      const observing = a.artifact_type === 'assessment_live_frame' && data.observing !== false;
      const state: AssessmentFrame['state'] = ended ? 'recorded' : !taskActive || !observing ? 'reference' : fresh ? 'live' : 'stale';
      return { id: a.id, operation_id:data.operation_id, image_url: `/api/ai-scans/${encodeURIComponent(run.id)}/frames/${encodeURIComponent(a.id)}?v=${stamp(a)}`,
        captured_at: new Date(stamp(a)).toISOString(), task_id: a.task_id || null, test_id: linked?.id || null,
        test_name: linked ? `${businessFunctions.find(f => f.tests.includes(linked))?.name || ''} · ${linked.name}` : '业务页面观察',
        surface, source: simulated ? 'simulated' : surface === 'android' ? 'device' : 'browser', state };
    }).filter(f => f.surface === run.surface);
  frames.sort((a,b)=>Number(b.state==='live')-Number(a.state==='live')||Date.parse(b.captured_at)-Date.parse(a.captured_at));
  const distinctFrames = frames.filter((f,i,allFrames) => allFrames.findIndex(g => g.task_id === f.task_id && g.test_id === f.test_id && g.operation_id === f.operation_id) === i);
  const currentWork = [
    ...normalFlows.filter(flow => flow.status === 'learning').map(flow => ({ id: `flow:${flow.id}`, name: flow.name, status: 'running', task_id: flow.task_ids[0] || null })),
    ...experiments.filter(experiment => experiment.status === 'running').map(experiment => ({ id: `experiment:${experiment.id}`, name: experiment.name, status: 'running', task_id: experiment.task_ids[0] || null })),
    ...all.filter(t => t.status === 'running').map(t => ({ id: t.id, name: t.name, status: 'running', task_id: t.task_ids[0] || null })),
  ];
  return { version: 2, browser_transport:process.env.BSTG_BROWSER_MODE==='novnc'?'novnc':'frames',
    diagnostics:[...(snapshot.run.summary?.execution_error?[{message:sanitizeModelString(String(snapshot.run.summary.execution_error))}]:[]),...snapshot.tasks.filter(t=>t.error_message).map(t=>({task_id:t.id,message:sanitizeModelString(t.error_message!).slice(0,1000)})),
      ...providerDenialDiagnostics(snapshot.artifacts),
      ...snapshot.artifacts.filter(a=>['mobile_appium_test_report','web_discovery_coverage'].includes(a.artifact_type)).flatMap(a=>(a.content_json.gaps||[]).map((g:string)=>({task_id:a.task_id,message:sanitizeModelString(g)})))],
    run, active_surface: run.surface,
    totals: { business_functions: businessFunctions.length, tests: all.length, ...counts, confirmed_risks: riskEvidence.length, review_signals: reviewEvidence.length, progress: all.length ? Math.round(counts.completed / all.length * 100) : 0,
      ...(normalFlows.length || experiments.length ? { normal_flows: normalFlows.length, verified_flows: normalFlows.filter(flow => flow.status === 'verified').length,
        learning_flows: normalFlows.filter(flow => flow.status === 'learning').length, blocked_flows: normalFlows.filter(flow => ['blocked', 'failed', 'review'].includes(flow.status)).length,
        experiments: experiments.length } : {}) },
    operations, business_functions: businessFunctions, current_work: currentWork, risk_evidence: riskEvidence, review_evidence: reviewEvidence,
    live_surface: distinctFrames.find(f => f.state === 'live') || distinctFrames.find(f => f.test_id && currentWork.some(t => t.id === f.test_id)) || (currentWork.length ? null : distinctFrames[0] || null), frames: distinctFrames,
    phase_label: STATUS[run.status] || '等待执行',
    notice: run.status === 'failed' && all.length > 0 && counts.completed === all.length ? '业务检查已完成，但本轮收尾或清理失败，整体测试不能视为通过。请由管理员核对测试环境。' : ended && counts.completed < all.length ? '本轮已停止，仍有测试未完成。未执行、跳过和待复核项不计入完成。'
      : !all.length && (normalFlows.length || experiments.length) ? '正常流程与模型实验分别记录；尚无已完成的安全检查结论，不能据此判断安全。'
      : !all.length && ended ? '本轮未能生成可执行测试，请查看下方执行诊断；没有结果不表示安全。' : !all.length ? '正在识别可执行的业务测试；不会把示例清单冒充实际覆盖。' : '' };
}
