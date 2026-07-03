import crypto from 'crypto';
import type { DbProvider } from '../types/index.js';
import { dbAll, dbGet, dbRun } from '../db/sql-helpers.js';
import { parseRawRequest } from './execution-utils.js';
import { AIClient } from './ai/ai-client.js';
import type { AIProvider } from './ai/types.js';
import { computeInputHash } from './ai/hash.js';
import { localText, normalizeOutputLanguage, outputLanguageInstruction, type OutputLanguage } from './i18n/language.js';

type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface EvidenceView {
  finding_id: string;
  issue_key: string;
  issue_title: string;
  duplicate_count: number;
  duplicate_finding_ids: string[];
  severity: Severity;
  status: string;
  source_type: string;
  endpoint: {
    method?: string;
    path?: string;
    url?: string;
    feature_guess?: string;
    auth_required?: boolean;
    content_type?: string;
  };
  task: {
    id?: string;
    title?: string;
    task_type?: string;
    vuln_type?: string;
    function_name?: string;
    semantic_dedupe_key?: string;
    strategy?: string;
  };
  summary: {
    what_happened: string;
    how_found: string[];
    why_vulnerable: string[];
    false_positive_checks: string[];
    remediation: string[];
    business_impact_review_required: boolean;
    confidence?: number;
  };
  parsed_request: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: any;
    query?: Record<string, string>;
    raw?: string;
    target?: string;
  };
  parsed_response: {
    status?: number;
    headers?: Record<string, any>;
    body?: any;
    body_text?: string;
    key_values: Record<string, any>;
  };
  workflow: {
    stages: Array<{
      stage: number;
      mode?: string;
      endpoint_ids?: string[];
      reason?: string;
    }>;
    nodes: Array<{
      index: number;
      method?: string;
      path?: string;
      kind?: string;
      reason?: string;
      is_target: boolean;
    }>;
    target_step?: number;
    native_api_test_run_ids: string[];
    native_workflow_ids: string[];
    native_template_ids: string[];
  };
  ai_judgement: {
    verdict?: string;
    confidence?: number;
    severity?: string;
    reason?: string;
    evidence: string[];
    source?: string;
    provider_id?: string;
    model?: string;
  };
  native_gate: {
    verdict?: string;
    baseline_verified?: boolean;
    mutation_executed?: boolean;
    template_executed?: boolean;
    native_api_mode_executed?: boolean;
    evidence_summary?: string;
    missing_evidence?: string[];
  };
  raw: {
    request_evidence?: any;
    response_evidence?: any;
    ai_analysis?: any;
  };
}

export interface FindingIssue {
  id: string;
  title: string;
  severity: Severity;
  status: string;
  raw_count: number;
  affected_endpoint_count: number;
  affected_endpoints: string[];
  evidence_strength: 'confirmed' | 'ai_only' | 'needs_review';
  business_impact_review_required: boolean;
  root_cause: string;
  judgement: string;
  representative_finding_id: string;
  finding_ids: string[];
  latest_created_at?: string;
  summary: string;
}

export interface AssistantResult {
  cached: boolean;
  language?: OutputLanguage;
  provider_used?: {
    id: string;
    model: string;
  };
  mode: string;
  answer: {
    summary: string;
    why_vulnerable: string[];
    false_positive_checks: string[];
    attack_path: string[];
    remediation: string[];
    confidence?: number;
  };
}

function safeParse(value: any): any {
  if (!value) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseMaybeJsonBody(value: any): any {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function truncate(value: string, limit = 1800): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

function normalizeSeverity(value: any): Severity {
  const severity = String(value || 'medium').toLowerCase();
  if (['critical', 'high', 'medium', 'low', 'info'].includes(severity)) return severity as Severity;
  return 'medium';
}

function severityRank(severity: Severity): number {
  return { critical: 5, high: 4, medium: 3, low: 2, info: 1 }[severity] || 0;
}

function lowerJoin(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ').toLowerCase();
}

function endpointLabel(view: EvidenceView): string {
  const method = view.endpoint.method || view.parsed_request.method || '';
  const path = view.endpoint.path || view.parsed_request.path || view.parsed_request.target || '';
  return `${method} ${path}`.trim() || 'unknown endpoint';
}

function classifyRoot(row: any, req: any, res: any, ai: any): {
  issue_key: string;
  issue_title: string;
  root_cause: string;
  business_impact_review_required: boolean;
} {
  const endpoint = req?.endpoint || {};
  const task = req?.task || {};
  const plan = task?.execution_plan || {};
  const path = String(endpoint.path || parseRawRequest(row.request_raw || '')?.path || row.request_raw || '').toLowerCase();
  const vuln = String(task.vuln_type || plan.vuln_type || plan.campaign_vuln_type || '').toLowerCase();
  const title = String(row.title || '');
  const haystack = lowerJoin(title, row.description, ai?.reason, vuln, path, plan.function_name);

  if (haystack.includes('path traversal') || haystack.includes('file download') || path.includes('/api/download')) {
    return {
      issue_key: 'path_traversal:/api/download',
      issue_title: '任意文件读取 / Path Traversal',
      root_cause: '文件下载参数未做路径规范化和根目录限制',
      business_impact_review_required: false,
    };
  }

  if (haystack.includes('command injection') || path.includes('/api/dataoperate')) {
    return {
      issue_key: 'command_injection:/api/dataoperate:host',
      issue_title: '命令注入 / Command Injection',
      root_cause: '用户可控 host 参数进入命令执行上下文',
      business_impact_review_required: false,
    };
  }

  if (haystack.includes('broken function') || haystack.includes('bfla') || path.includes('/admin/users')) {
    return {
      issue_key: 'bfla:/admin/users',
      issue_title: '后台功能越权 / BFLA',
      root_cause: '管理端接口缺少角色/权限校验',
      business_impact_review_required: false,
    };
  }

  if (path.includes('/api/user/setorresetpaypwd')) {
    return {
      issue_key: 'auth_bypass:/api/user/setOrResetPaypwd',
      issue_title: '支付密码/OTP 重置绕过',
      root_cause: '支付密码重置流程未验证 passcode/OTP 真实性',
      business_impact_review_required: false,
    };
  }

  if (path.includes('/api/user/forgetpassword')) {
    return {
      issue_key: 'auth_otp:/api/user/forgetPassword',
      issue_title: '忘记密码 OTP 绕过',
      root_cause: '找回密码流程对空/弱/缺失验证码返回成功',
      business_impact_review_required: false,
    };
  }

  if (haystack.includes('upload') || haystack.includes('stored xss') || path.includes('upload') || path.includes('walletimage')) {
    return {
      issue_key: 'stored_xss:unrestricted_upload:svg_html',
      issue_title: '上传 SVG/HTML 导致 Stored XSS',
      root_cause: '上传接口允许可执行内容并按可执行 Content-Type 对外提供',
      business_impact_review_required: false,
    };
  }

  if (haystack.includes('negative') || vuln.includes('business_logic')) {
    const functionName = String(plan.function_name || '').toLowerCase();
    if (functionName.includes('提现') || path.includes('withdrawalrecord') || /\/withdraw$/.test(path)) {
      return {
        issue_key: 'business_logic:negative_amount:withdrawal',
        issue_title: '负数金额：提现',
        root_cause: '提现相关接口未拒绝负数/超大金额',
        business_impact_review_required: false,
      };
    }
    if (functionName.includes('资金划转') || path.includes('fundstransfer') || path.includes('transferrecord')) {
      return {
        issue_key: 'business_logic:negative_amount:transfer',
        issue_title: '负数金额：资金划转/转账记录',
        root_cause: '资金划转相关接口未拒绝负数金额',
        business_impact_review_required: false,
      };
    }
    return {
      issue_key: 'business_logic:negative_amount:orders_logs_management',
      issue_title: '负数金额：订单/撤单/日志/管理类接口',
      root_cause: '订单、撤单、日志或管理类接口接受负数金额参数',
      business_impact_review_required: true,
    };
  }

  const fallbackKey = [
    plan.semantic_dedupe_key,
    vuln,
    endpoint.method,
    endpoint.path,
    plan.function_name,
  ].filter(Boolean).join(':');

  return {
    issue_key: fallbackKey || `finding:${row.id}`,
    issue_title: title || 'Security finding',
    root_cause: plan.function_name ? `${plan.function_name} 功能点存在异常安全行为` : '需要根据证据进一步确认根因',
    business_impact_review_required: false,
  };
}

function extractQuery(path?: string): Record<string, string> {
  if (!path) return {};
  try {
    const url = new URL(path, 'http://bstg.local');
    return Object.fromEntries(url.searchParams.entries());
  } catch {
    return {};
  }
}

function extractKeyValues(body: any): Record<string, any> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const keys = ['code', 'ok', 'message', 'amount', 'total', 'passcode_verified', 'admin', 'verified', 'url', 'path', 'filename'];
  const result: Record<string, any> = {};
  for (const key of keys) {
    if (body[key] !== undefined) result[key] = body[key];
    if (body.data && typeof body.data === 'object' && body.data[key] !== undefined) result[`data.${key}`] = body.data[key];
  }
  return result;
}

function buildNarrative(row: any, classification: ReturnType<typeof classifyRoot>, req: any, res: any, ai: any, responseBody: any): EvidenceView['summary'] {
  const endpoint = req?.endpoint || {};
  const task = req?.task || {};
  const plan = task?.execution_plan || {};
  const path = endpoint.path || parseRawRequest(row.request_raw || '')?.path || row.request_raw || '目标接口';
  const method = endpoint.method || parseRawRequest(row.request_raw || '')?.method || '';
  const evidence = Array.isArray(ai?.evidence) ? ai.evidence : [];
  const haystack = lowerJoin(row.title, row.description, ai?.reason, task.vuln_type, classification.issue_key);
  const lines = evidence.slice(0, 4).map(String);

  const howFound = lines.length > 0 ? lines : [
    ai?.reason || row.description || 'AI Scan 子 Agent 执行 baseline/mutation 后给出 vulnerable 判定。',
  ];
  const why: string[] = [];
  const falsePositive: string[] = [];
  const remediation: string[] = [];

  if (classification.issue_key.startsWith('path_traversal')) {
    why.push('同一个文件下载接口在正常文件名之外，也接受了目录穿越 payload。');
    why.push('响应体出现 `/etc/passwd` 内容，说明服务端读取了下载目录之外的系统文件。');
    falsePositive.push('如果这是靶场专门模拟的固定响应，生产影响需要结合真实文件读取逻辑确认。');
    remediation.push('对 file 参数做白名单映射，只允许下载服务端登记过的文件 ID。');
    remediation.push('使用路径规范化后校验 resolved path 必须位于允许目录内。');
  } else if (classification.issue_key.startsWith('command_injection')) {
    why.push('host 参数注入 shell 分隔符后，响应包含 `id`/`whoami` 这类命令输出。');
    why.push('这证明用户输入进入了系统命令执行上下文。');
    falsePositive.push('确认响应中的命令输出不是测试桩硬编码文本。');
    remediation.push('避免拼接 shell 命令；使用参数化系统调用或纯库函数实现。');
    remediation.push('对 host 做严格格式校验，并隔离命令执行权限。');
  } else if (classification.issue_key.startsWith('bfla')) {
    why.push('普通访问上下文可以读取 `/admin/users` 管理数据。');
    why.push('role 参数不同取值返回相同管理员数据，说明权限判断缺失或未生效。');
    falsePositive.push('确认测试账号是否确实不是管理员角色。');
    remediation.push('在服务端按会话身份做强制角色校验，不信任客户端 role 参数。');
  } else if (classification.issue_key.startsWith('auth_bypass') || classification.issue_key.startsWith('auth_otp')) {
    why.push('空验证码、弱验证码或缺失验证码仍返回成功状态。');
    why.push('响应包含验证成功标记或 token，说明敏感流程可以绕过校验。');
    falsePositive.push('确认测试环境是否故意关闭了 OTP/passcode 校验。');
    remediation.push('服务端必须校验 OTP/passcode 与一次性 ticket 的绑定关系、过期时间和使用状态。');
    remediation.push('对失败次数做限制，并在缺失字段时返回明确失败。');
  } else if (classification.issue_key.startsWith('stored_xss')) {
    why.push('上传接口接受 SVG/HTML，文件中包含 JavaScript。');
    why.push('文件被持久化并以 `image/svg+xml` 或 `text/html` 对外访问，直接访问可执行脚本。');
    falsePositive.push('确认业务是否允许用户上传并公开访问 HTML/SVG；即便允许，也应隔离域名和 Content-Disposition。');
    remediation.push('限制上传扩展名、MIME 和文件魔数，拒绝 HTML/SVG 等可执行内容。');
    remediation.push('用户上传内容使用独立静态域名、强 CSP、`Content-Disposition: attachment`。');
  } else if (classification.issue_key.startsWith('business_logic')) {
    why.push('amount=-1 等负数输入被服务端接受，并返回负数 total 或成功消息。');
    why.push('金额类参数缺少下限和上限校验，可能导致余额、订单或流水状态异常。');
    falsePositive.push('只读历史/日志接口返回异常体不一定等于真实资金变更，需要确认是否写入状态。');
    falsePositive.push('靶场可能用统一响应模拟负数漏洞，生产系统需要看交易落库和账务流水。');
    remediation.push('金额字段使用服务端统一数值校验：必须为正、精度受限、不能超过余额/额度。');
    remediation.push('交易类接口在账务层增加不可为负的约束和幂等校验。');
  } else {
    why.push(ai?.reason || row.description || 'AI 判定该请求/响应对体现出异常安全行为。');
    falsePositive.push('需要确认测试账号、业务前置条件和响应是否来自真实业务逻辑。');
    remediation.push('按证据中被变异的参数和服务端信任边界补充校验。');
  }

  return {
    what_happened: `${method ? `${method} ` : ''}${path} 被归类为「${classification.issue_title}」：${ai?.reason || row.description || classification.root_cause}`,
    how_found: howFound,
    why_vulnerable: why,
    false_positive_checks: falsePositive,
    remediation,
    business_impact_review_required: classification.business_impact_review_required,
    confidence: typeof ai?.confidence === 'number' ? ai.confidence : undefined,
  };
}

export function buildEvidenceView(row: any, allRows: any[] = []): EvidenceView {
  const requestEvidence = safeParse(row.request_evidence) || {};
  const responseEvidence = safeParse(row.response_evidence) || {};
  const aiAnalysis = safeParse(row.ai_analysis) || responseEvidence.judgement || {};
  const endpoint = requestEvidence.endpoint || {};
  const task = requestEvidence.task || {};
  const plan = task.execution_plan || {};
  const gate = responseEvidence.native_evidence_gate || {};
  const parsedRaw = parseRawRequest(row.request_raw || '') || undefined;
  const responseHeaders = safeParse(row.response_headers) || row.response_headers || {};
  const responseBody = parseMaybeJsonBody(row.response_body);
  const classification = classifyRoot(row, requestEvidence, responseEvidence, aiAnalysis);
  const duplicateRows = allRows
    .map(candidate => {
      const req = safeParse(candidate.request_evidence) || {};
      const res = safeParse(candidate.response_evidence) || {};
      const ai = safeParse(candidate.ai_analysis) || res.judgement || {};
      return { candidate, key: classifyRoot(candidate, req, res, ai).issue_key };
    })
    .filter(item => item.key === classification.issue_key)
    .map(item => item.candidate);
  const nodes = Array.isArray(plan.workflow_execution_plan?.nodes)
    ? plan.workflow_execution_plan.nodes.map((node: any, index: number) => ({
      index: index + 1,
      method: node.method,
      path: node.path,
      kind: node.kind,
      reason: node.reason,
      is_target: node.reason === 'target vulnerability action' || node.endpoint_id === plan.workflow_execution_plan?.target_endpoint_id,
    }))
    : [];
    const targetStep = nodes.find((node: { is_target: boolean; index: number }) => node.is_target)?.index;
  const rawPath = endpoint.path || parsedRaw?.path || '';

  return {
    finding_id: row.id,
    issue_key: classification.issue_key,
    issue_title: classification.issue_title,
    duplicate_count: duplicateRows.length || 1,
    duplicate_finding_ids: (duplicateRows.length ? duplicateRows : [row]).map(f => f.id),
    severity: normalizeSeverity(row.severity),
    status: row.status,
    source_type: row.source_type,
    endpoint: {
      method: endpoint.method || parsedRaw?.method,
      path: endpoint.path || parsedRaw?.path,
      url: endpoint.url,
      feature_guess: endpoint.feature_guess,
      auth_required: endpoint.auth_required,
      content_type: endpoint.content_type,
    },
    task: {
      id: task.id,
      title: task.title,
      task_type: task.task_type,
      vuln_type: task.vuln_type || plan.vuln_type || plan.campaign_vuln_type,
      function_name: plan.function_name,
      semantic_dedupe_key: plan.semantic_dedupe_key,
      strategy: plan.strategy,
    },
    summary: buildNarrative(row, classification, requestEvidence, responseEvidence, aiAnalysis, responseBody),
    parsed_request: {
      method: endpoint.method || parsedRaw?.method,
      path: endpoint.path || parsedRaw?.path,
      headers: parsedRaw?.headers,
      body: parseMaybeJsonBody(parsedRaw?.body),
      query: extractQuery(endpoint.url || rawPath),
      raw: row.request_raw,
      target: endpoint.path ? `${endpoint.method || ''} ${endpoint.path}`.trim() : row.request_raw,
    },
    parsed_response: {
      status: row.response_status,
      headers: responseHeaders,
      body: responseBody,
      body_text: typeof row.response_body === 'string' ? truncate(row.response_body) : undefined,
      key_values: extractKeyValues(responseBody),
    },
    workflow: {
      stages: Array.isArray(plan.workflow_execution_plan?.schedule) ? plan.workflow_execution_plan.schedule : [],
      nodes,
      target_step: targetStep,
      native_api_test_run_ids: gate.native_api_test_run_ids || [],
      native_workflow_ids: gate.native_workflow_ids || [],
      native_template_ids: gate.native_template_ids || [],
    },
    ai_judgement: {
      verdict: aiAnalysis.verdict,
      confidence: aiAnalysis.confidence,
      severity: aiAnalysis.severity,
      reason: aiAnalysis.reason || row.description,
      evidence: Array.isArray(aiAnalysis.evidence) ? aiAnalysis.evidence : [],
      source: aiAnalysis.source,
      provider_id: aiAnalysis.provider_id,
      model: aiAnalysis.model,
    },
    native_gate: {
      verdict: gate.verdict,
      baseline_verified: gate.baseline_verified,
      mutation_executed: gate.mutation_executed,
      template_executed: gate.template_executed,
      native_api_mode_executed: gate.native_api_mode_executed,
      evidence_summary: gate.evidence_summary,
      missing_evidence: gate.missing_evidence || [],
    },
    raw: {
      request_evidence: requestEvidence,
      response_evidence: responseEvidence,
      ai_analysis: aiAnalysis,
    },
  };
}

export function buildIssues(rows: any[], language: OutputLanguage = 'en'): FindingIssue[] {
  const views = rows.map(row => buildEvidenceView(row, rows));
  const grouped = new Map<string, EvidenceView[]>();
  for (const view of views) {
    const current = grouped.get(view.issue_key) || [];
    current.push(view);
    grouped.set(view.issue_key, current);
  }

  return Array.from(grouped.entries()).map(([key, group]) => {
    const sorted = [...group].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    const representative = sorted[0];
    const endpoints = Array.from(new Set(group.map(endpointLabel).filter(Boolean)));
    const confirmed = group.every(view => view.native_gate.verdict === 'confirmed');
    const needsReview = group.some(view => view.summary.business_impact_review_required);
    const statuses = group.map(view => view.status);
    const status = statuses.includes('new') ? 'new' : statuses[0] || 'new';

    const evidenceStrength: FindingIssue['evidence_strength'] = needsReview ? 'needs_review' : confirmed ? 'confirmed' : 'ai_only';

    return {
      id: key,
      title: representative.issue_title,
      severity: sorted[0].severity,
      status,
      raw_count: group.length,
      affected_endpoint_count: endpoints.length,
      affected_endpoints: endpoints,
      evidence_strength: evidenceStrength,
      business_impact_review_required: needsReview,
      root_cause: representative.summary.why_vulnerable[0] || representative.issue_title,
      judgement: needsReview
        ? localText(language, 'Behavior confirmed; business impact requires manual review', '行为被确认，业务影响需要人工确认')
        : localText(language, 'Confirmed vulnerability', '确认漏洞'),
      representative_finding_id: representative.finding_id,
      finding_ids: group.map(view => view.finding_id),
      latest_created_at: rows
        .filter(row => group.some(view => view.finding_id === row.id))
        .map(row => row.created_at)
        .sort()
        .reverse()[0],
      summary: representative.summary.what_happened,
    };
  }).sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.raw_count - a.raw_count);
}

export async function listFindingIssues(db: DbProvider, language: OutputLanguage = 'en'): Promise<FindingIssue[]> {
  const rows = await dbAll<any>(db, 'SELECT * FROM findings ORDER BY created_at DESC');
  return buildIssues(rows, language);
}

export async function getFindingEvidenceView(db: DbProvider, findingId: string): Promise<EvidenceView | null> {
  const rows = await dbAll<any>(db, 'SELECT * FROM findings ORDER BY created_at DESC');
  const row = rows.find(finding => finding.id === findingId);
  if (!row) return null;
  return buildEvidenceView(row, rows);
}

function localAssistantAnswer(view: EvidenceView, mode: string, question: string | undefined, language: OutputLanguage): AssistantResult['answer'] {
  const attackPath = [
    localText(language, `Target endpoint: ${endpointLabel(view)}`, `定位目标：${endpointLabel(view)}`),
    ...(view.workflow.target_step ? [localText(language, `Workflow step ${view.workflow.target_step} is the target action; previous steps satisfy login, verification code, object ID, or similar prerequisites.`, `工作流第 ${view.workflow.target_step} 步是目标动作，前置步骤用于满足登录/验证码/对象 ID 等条件。`)] : []),
    ...view.summary.how_found.slice(0, 3),
  ];

  const suffix = question ? localText(language, ` User question: ${question}`, ` 用户问题：${question}`) : '';
  const modeIntro: Record<string, string> = {
    explain: localText(language, 'This explanation is generated from structured evidence.', '这是基于结构化证据生成的解释。'),
    false_positive: localText(language, 'This explains the issue from a false-positive review angle.', '下面按误报排查角度解释。'),
    attack_path: localText(language, 'This explains the issue from an attack-path angle.', '下面按攻击路径角度解释。'),
    remediation: localText(language, 'This explains the issue from a remediation angle.', '下面按修复角度解释。'),
    custom_question: localText(language, 'This answers your question using the available evidence.', '下面结合你的问题解释。'),
  };

  return {
    summary: `${modeIntro[mode] || modeIntro.explain}${suffix} ${view.summary.what_happened}`,
    why_vulnerable: view.summary.why_vulnerable,
    false_positive_checks: view.summary.false_positive_checks,
    attack_path: attackPath,
    remediation: view.summary.remediation,
    confidence: view.summary.confidence,
  };
}

function parseAssistantJson(content: string, fallback: AssistantResult['answer']): AssistantResult['answer'] {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { ...fallback, summary: content.trim() || fallback.summary };
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: String(parsed.summary || fallback.summary),
      why_vulnerable: Array.isArray(parsed.why_vulnerable) ? parsed.why_vulnerable.map(String) : fallback.why_vulnerable,
      false_positive_checks: Array.isArray(parsed.false_positive_checks) ? parsed.false_positive_checks.map(String) : fallback.false_positive_checks,
      attack_path: Array.isArray(parsed.attack_path) ? parsed.attack_path.map(String) : fallback.attack_path,
      remediation: Array.isArray(parsed.remediation) ? parsed.remediation.map(String) : fallback.remediation,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : fallback.confidence,
    };
  } catch {
    return fallback;
  }
}

function buildAssistantPrompt(view: EvidenceView, mode: string, question: string | undefined, language: OutputLanguage): string {
  const evidencePack = {
    mode,
    question,
    issue: {
      title: view.issue_title,
      duplicate_count: view.duplicate_count,
      severity: view.severity,
    },
    endpoint: view.endpoint,
    task: view.task,
    request: view.parsed_request,
    response: view.parsed_response,
    workflow: view.workflow,
    ai_judgement: view.ai_judgement,
    native_gate: view.native_gate,
    deterministic_summary: view.summary,
  };

  return [
    localText(language, 'You are an application-security finding explanation assistant for product and engineering readers who may not know security details.', '你是一个应用安全 finding 解释助手，解释对象是不熟悉安全细节的产品/研发同学。'),
    'Only use the provided evidence. Do not invent requests, accounts, or business states that are not present.',
    'If the evidence may only show a fixed training-target response or a read-only endpoint, write that clearly in false_positive_checks.',
    'Return strict JSON with fields summary, why_vulnerable, false_positive_checks, attack_path, remediation, confidence.',
    outputLanguageInstruction(language),
    '',
    JSON.stringify(evidencePack, null, 2),
  ].join('\n');
}

export async function explainFindingWithAssistant(
  db: DbProvider,
  findingId: string,
  options: { mode?: string; question?: string; provider_id?: string; language?: string }
): Promise<AssistantResult | null> {
  const view = await getFindingEvidenceView(db, findingId);
  if (!view) return null;

  const language = normalizeOutputLanguage(options.language);
  const mode = options.mode || (options.question ? 'custom_question' : 'explain');
  const fallback = localAssistantAnswer(view, mode, options.question, language);
  const providerId = options.provider_id || view.ai_judgement.provider_id;
  const input = { view, mode, question: options.question || '', language };
  const inputHash = computeInputHash(input);
  const runId = `finding-assistant:${findingId}:${mode}`;

  if (!providerId) {
    return { cached: false, mode, language, answer: fallback };
  }

  const cached = await dbGet<any>(
    db,
    'SELECT result_json, model FROM ai_analyses WHERE finding_id = ? AND provider_id = ? AND input_hash = ? AND COALESCE(language, ?) = ?',
    [findingId, providerId, inputHash, language, language]
  );

  if (cached?.result_json) {
    return {
      cached: true,
      mode,
      language,
      provider_used: { id: providerId, model: cached.model },
      answer: safeParse(cached.result_json) || fallback,
    };
  }

  const provider = await dbGet<any>(
    db,
    `SELECT * FROM ai_providers WHERE id = ?`,
    [providerId]
  );

  if (!provider) {
    return { cached: false, mode, language, answer: fallback };
  }

  const normalizedProvider: AIProvider = {
    ...provider,
    is_enabled: db.kind === 'sqlite' ? provider.is_enabled === 1 : !!provider.is_enabled,
    is_default: db.kind === 'sqlite' ? provider.is_default === 1 : !!provider.is_default,
  };

  if (!normalizedProvider.is_enabled) {
    return { cached: false, mode, language, answer: fallback };
  }

  const client = new AIClient(normalizedProvider);
  const prompt = buildAssistantPrompt(view, mode, options.question, language);
  const started = Date.now();

  try {
    const request: any = {
      model: normalizedProvider.model,
      messages: [
        { role: 'system', content: localText(language, 'You are a security finding explanation assistant. Output only valid JSON.', '你是安全发现项解释助手。只输出有效 JSON。') },
        { role: 'user', content: prompt },
      ],
      temperature: 0.2,
      max_tokens: 1800,
      timeout_ms: 120000,
    };
    if (['openai', 'deepseek'].includes(normalizedProvider.provider_type)) {
      request.response_format = { type: 'json_object' };
    }

    const response = await client.chat(request);
    const content = response.choices[0]?.message?.content || '';
    const answer = parseAssistantJson(content, fallback);
    const id = crypto.randomUUID();

    await dbRun(
      db,
      `INSERT INTO ai_analyses (id, run_id, finding_id, provider_id, model, prompt_version, language, input_hash, result_json, tokens_in, tokens_out, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        runId,
        findingId,
        normalizedProvider.id,
        normalizedProvider.model,
        'finding_assistant_v1',
        language,
        inputHash,
        JSON.stringify(answer),
        response.usage?.prompt_tokens || null,
        response.usage?.completion_tokens || null,
        Date.now() - started,
      ]
    );

    return {
      cached: false,
      mode,
      language,
      provider_used: { id: normalizedProvider.id, model: normalizedProvider.model },
      answer,
    };
  } catch {
    return { cached: false, mode, language, provider_used: { id: normalizedProvider.id, model: normalizedProvider.model }, answer: fallback };
  }
}
