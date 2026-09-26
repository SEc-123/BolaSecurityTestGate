import { v4 as uuidv4 } from 'uuid';
import type { DbProvider } from '../../types/index.js';
import { dbGet, dbRun } from '../../db/sql-helpers.js';
import type { AIScanRepository } from './repository.js';
import type { AIDiscoveredEndpoint, AIScanTask } from './types.js';
import { compareResponses, endpointToRequest, executeHttpRequest, type HttpResponseEvidence } from './http-executor.js';
import { payloadsForVulnType, type AttackPayload } from './payload-catalog.js';
import { AIProviderJudgementError, judgeGenericAttempts } from './ai-generic-judge.js';
import { runNativeBstgOrchestration, type NativeBstgRunResult } from './bstg-native-orchestrator.js';
import { canCreateFindingFromNativeAndJudge, evaluateNativeEvidence } from './native-evidence-gate.js';
import { normalizeOutputLanguage } from '../i18n/language.js';

interface GenericAttempt {
  label: string;
  payload: string;
  target: string;
  normal: HttpResponseEvidence;
  mutated: HttpResponseEvidence;
  comparison: ReturnType<typeof compareResponses>;
}

function parseCookieString(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(value || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function mergeSessionFields(fields: Record<string, any>, headers: Record<string, string>, cookies: Record<string, string>): boolean {
  if (!fields || typeof fields !== 'object') return false;
  if (fields.cookies && typeof fields.cookies === 'object') {
    for (const [key, value] of Object.entries(fields.cookies)) {
      if (value !== undefined && value !== null) cookies[key] = String(value);
    }
  }
  const cookie = fields.cookie || fields.Cookie || fields.cookie_header || fields.CookieHeader;
  if (typeof cookie === 'string') Object.assign(cookies, parseCookieString(cookie));
  const token = fields.auth_token || fields.authorization || fields.Authorization || fields.access_token || fields.token || fields.jwt;
  if (token) headers.Authorization = String(token).startsWith('Bearer ') || /^Basic\s+/i.test(String(token)) ? String(token) : `Bearer ${token}`;
  return Object.keys(cookies).length > 0 || Boolean(headers.Authorization);
}

async function findScanAccount(db: DbProvider, scanRunId: string, role: string): Promise<any | null> {
  const accounts = await db.repos.accounts.findAll().catch(() => [] as any[]);
  return accounts.find(account => {
    const tags = Array.isArray(account.tags) ? account.tags.map(String) : [];
    const fields = account.fields || {};
    return tags.includes('ai_scan') && tags.includes(`scan:${scanRunId}`) && (tags.includes(`role:${role}`) || fields.role === role);
  }) || null;
}

function scoreSessionCandidate(candidate: { source: string; fields: Record<string, any> }, role: string): number {
  const text = `${candidate.source} ${JSON.stringify(candidate.fields || {})}`.toLowerCase();
  let score = 0;
  if (candidate.fields?.role === role || text.includes(`role:${role}`)) score += 4;
  if (text.includes(role)) score += 3;
  if (role === 'attacker' && /(attacker|alice|token-attacker|session-attacker)/.test(text)) score += 2;
  if (role === 'victim' && /(victim|bob|token-victim|session-victim)/.test(text)) score += 2;
  if (role === 'admin' && /(admin|token-admin|session-admin)/.test(text)) score += 2;
  if (candidate.fields?.cookies || candidate.fields?.cookie || candidate.fields?.Cookie || candidate.fields?.auth_token || candidate.fields?.authorization || candidate.fields?.Authorization || candidate.fields?.access_token || candidate.fields?.token || candidate.fields?.jwt) score += 1;
  return score;
}

async function findSharedIdentityMaterial(repo: AIScanRepository, scanRunId: string, role: string): Promise<{ source: string; fields: Record<string, any> } | null> {
  const pools = await repo.listSharedResources(scanRunId, 'identity_pool').catch(() => []);
  const candidates: Array<{ source: string; fields: Record<string, any> }> = [];
  for (const pool of pools) {
    const content = pool.content_json || {};
    const configured = content.configured_accounts || {};
    if (configured && typeof configured === 'object') {
      for (const [key, value] of Object.entries(configured)) {
        if (value && typeof value === 'object') candidates.push({ source: `${pool.resource_key}:configured:${key}`, fields: { role: key, ...(value as Record<string, any>) } });
      }
    }
    for (const item of Array.isArray(content.raw_request_accounts) ? content.raw_request_accounts : []) {
      if (item?.fields && typeof item.fields === 'object') candidates.push({ source: `${pool.resource_key}:${item.source || 'raw_request'}`, fields: item.fields });
    }
    for (const item of Array.isArray(content.existing_bstg_accounts) ? content.existing_bstg_accounts : []) {
      if (item?.fields && typeof item.fields === 'object') candidates.push({ source: `${pool.resource_key}:existing:${item.id || item.username || 'account'}`, fields: item.fields });
    }
    for (const item of Array.isArray(content.created_accounts) ? content.created_accounts : []) {
      if (item?.fields && typeof item.fields === 'object') candidates.push({ source: `${pool.resource_key}:created:${item.id || item.username || 'account'}`, fields: item.fields });
    }
  }
  return candidates
    .map(candidate => ({ candidate, score: scoreSessionCandidate(candidate, role) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.candidate || null;
}

async function configuredAttackerSession(db: DbProvider, repo: AIScanRepository, task: AIScanTask, endpointIds: string[]): Promise<{ headers: Record<string, string>; cookies: Record<string, string>; preconditions: Record<string, any> }> {
  const plan = task.execution_plan?.workflow_execution_plan || {};
  const policy = task.execution_plan?.precondition_policy || {};
  const postAuth = plan.access_phase === 'post_auth' || policy.access_phase === 'post_auth' || Boolean(task.execution_plan?.requires_identity_context);
  const missing = Array.isArray(policy.missing_preconditions) ? [...policy.missing_preconditions] : [];
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const account = await findScanAccount(db, task.scan_run_id, 'attacker');
  const fields = account?.fields || {};
  let reusedSource = account ? 'accounts_table' : undefined;

  if (!mergeSessionFields(fields, headers, cookies)) {
    const shared = await findSharedIdentityMaterial(repo, task.scan_run_id, 'attacker');
    if (shared && mergeSessionFields(shared.fields, headers, cookies)) reusedSource = shared.source;
  }

  const hasSession = Object.keys(cookies).length > 0 || Boolean(headers.Authorization);
  if (postAuth && !hasSession && !missing.includes('identity_session_material')) missing.push('identity_session_material');

  return {
    headers,
    cookies,
    preconditions: {
      access_phase: plan.access_phase || policy.access_phase || 'unknown',
      target_kind: plan.target_kind || policy.target_kind || 'unknown',
      endpoint_ids: endpointIds,
      required_capabilities: plan.required_capabilities || [],
      missing_preconditions: missing,
      direct_http_reuses_auth_context: hasSession,
      reused_account_id: account?.id,
      reused_account_username: account?.username,
      reused_account_source: reusedSource,
      block_finding_when_missing: false,
    },
  };
}

function guessMutableTargets(endpoint: AIDiscoveredEndpoint, vulnType = ''): string[] {
  const text = [endpoint.path, endpoint.url, endpoint.request_summary, endpoint.response_summary].filter(Boolean).join(' ');
  const targets = new Set<string>();
  const url = endpoint.url ? new URL(endpoint.url) : null;
  const searchKeys = [...(url?.searchParams.keys() || [])];
  if (vulnType === 'bola_idor') {
    for (const key of searchKeys.filter(key => /^(id|uid|user_id|account_id|order_id|room_id|rid|mid|file_id|record_id)$/i.test(key))) targets.add(`query:${key}`);
    if (targets.size === 0 && /score|member|account|order|room|hall|buy|gift|put|get|ready|play/i.test(text)) {
      for (const key of ['id', 'order_id', 'room_id']) targets.add(`query:${key}`);
    }
    if (targets.size > 0) return [...targets].slice(0, 3);
  }
  if (vulnType === 'auth_otp' || vulnType === 'email_sms_bypass') {
    for (const key of searchKeys.filter(key => /^(code|captcha|otp|sms_code|email_code|ticket)$/i.test(key))) targets.add(`query:${key}`);
    if (targets.size === 0 && /login|sign|send|captcha|verify|code|otp|sms|email/i.test(text)) {
      for (const key of ['code', 'captcha', 'ticket']) targets.add(`query:${key}`);
    }
    if (targets.size > 0) return [...targets].slice(0, 3);
  }
  if (vulnType === 'passcode_bypass') {
    for (const key of searchKeys.filter(key => /^(passcode|paypwd|pay_password|member_mpw|member_rpw|pin)$/i.test(key))) targets.add(`query:${key}`);
    if (targets.size === 0 && /passcode|paypwd|member_mpw|member_rpw|\/pw(?:$|[\s\/?#._-])|payment.*password|\bpin\b/i.test(text)) {
      for (const key of ['passcode', 'member_mpw', 'member_rpw']) targets.add(`query:${key}`);
    }
    if (targets.size > 0) return [...targets].slice(0, 3);
  }
  for (const key of searchKeys) targets.add(`query:${key}`);
  const patterns = [
    /(?:^|[^a-zA-Z0-9_])(id|uid|user_id|account_id|order_id|file_id|post_id|media_id|role|status|amount|price|quantity|coupon|filename|path|url|q|query|search|keyword|cmd|host|domain|code)(?:[^a-zA-Z0-9_]|$)/gi,
    /name["'\s:=]+([a-zA-Z0-9_.-]+)/gi,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) targets.add(`query:${match[1]}`);
  }
  if (/cart|quantity/i.test(text)) targets.add('query:quantity');
  if (/amount|price|order|pay|transfer|withdraw/i.test(text)) targets.add('query:amount');
  if (targets.size === 0) {
    if (/download|file|path|export/i.test(text)) targets.add('query:file');
    else if (/search|query|q|comment|post|title/i.test(text)) targets.add('query:q');
    else if (/cmd|host|domain|ping/i.test(text)) targets.add('query:host');
    else targets.add('query:id');
  }
  return [...targets].slice(0, 3);
}

function targetToQuery(target: string, payload: AttackPayload, base: Record<string, string> = {}): Record<string, string> {
  const [, key] = target.split(':');
  return { ...base, [key || 'q']: payload.value };
}

function buildRawRequest(endpoint: AIDiscoveredEndpoint, target: string): string {
  const host = endpoint.url ? new URL(endpoint.url).host : 'target';
  return [
    `${endpoint.method.toUpperCase()} ${endpoint.path} HTTP/1.1`,
    `Host: ${host}`,
    'User-Agent: BSTG-AI-Agent/1.0',
    `X-BSTG-Mutation-Target: ${target}`,
    '',
  ].join('\r\n');
}


async function createVisualAgentState(repo: AIScanRepository, task: AIScanTask, endpoint: AIDiscoveredEndpoint, phase: string): Promise<void> {
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'browser_agent_state',
    title: `Visual sub-agent state: ${task.vuln_type || 'generic'} ${endpoint.method} ${endpoint.path}`,
    content_json: {
      browser_context_id: `browser-${task.id}`,
      agent_role: task.execution_plan?.recommended_agent_role || `${task.vuln_type || 'generic'}-subagent`,
      campaign_task_id: task.execution_plan?.campaign_task_id,
      function_name: task.execution_plan?.function_name,
      vuln_type: task.vuln_type,
      current_url: endpoint.url,
      current_endpoint: { id: endpoint.id, method: endpoint.method, path: endpoint.path },
      action: phase,
      status: 'running',
      visual_policy: 'Rendered in the right-side multi-browser panel. Playwright screenshot artifacts are attached when the browser engine is available; HTTP fallback still shows action/network state.',
    },
    source_ref: endpoint.id,
  });
}

async function createAssets(db: DbProvider, repo: AIScanRepository, task: AIScanTask, endpoint: AIDiscoveredEndpoint, payloads: AttackPayload[], targets: string[]) {
  const templateId = uuidv4();
  const workflowId = uuidv4();
  const ruleId = uuidv4();
  await dbRun(
    db,
    `INSERT INTO api_templates (id, name, group_name, description, raw_request, parsed_structure, variables, failure_patterns, failure_logic, is_active, advanced_config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      templateId,
      `AI ${task.vuln_type} ${endpoint.method} ${endpoint.path}`,
      `AI Scan / ${task.vuln_type}`,
      `Auto-generated generic mutation template by AI Scan task ${task.id}`,
      buildRawRequest(endpoint, targets.join(',')),
      JSON.stringify({ method: endpoint.method, path: endpoint.path, vuln_type: task.vuln_type, targets }),
      JSON.stringify(targets.map(target => ({ name: target.replace(':', '_'), source: 'security_rule', target }))),
      JSON.stringify([]),
      'OR',
      1,
      JSON.stringify({ ai_scan_task_id: task.id, endpoint_id: endpoint.id, payload_count: payloads.length }),
    ]
  );
  await dbRun(
    db,
    `INSERT INTO workflows (id, name, description, is_active, assertion_strategy, enable_extractor, workflow_type, mutation_profile, template_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workflowId,
      `AI Workflow ${task.vuln_type} ${endpoint.path}`,
      `Auto-compiled generic mutation workflow for AI Scan task ${task.id}`,
      1,
      'any_step_pass',
      0,
      'mutation',
      JSON.stringify({ ai_strategy: 'baseline_then_payload_mutations', payload_labels: payloads.map(p => p.label), targets }),
      'reference',
    ]
  );
  await dbRun(
    db,
    `INSERT INTO workflow_steps (id, workflow_id, api_template_id, step_order, step_assertions, assertions_mode) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), workflowId, templateId, 1, JSON.stringify([{ type: 'status_range', min: 200, max: 599 }]), 'all']
  );
  await dbRun(
    db,
    `INSERT INTO security_rules (id, name, payloads, description) VALUES (?, ?, ?, ?)`,
    [ruleId, `AI Payloads - ${task.vuln_type} - ${endpoint.path}`, JSON.stringify(payloads), `Auto-created for AI Scan task ${task.id}`]
  );
  return { template_id: templateId, workflow_id: workflowId, security_rule_id: ruleId };
}

async function createFinding(db: DbProvider, repo: AIScanRepository, input: {
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
  assets: Record<string, any>;
  judge: Awaited<ReturnType<typeof judgeGenericAttempts>>;
  attempts: GenericAttempt[];
  native: NativeBstgRunResult;
  language: ReturnType<typeof normalizeOutputLanguage>;
}) {
  const gate = evaluateNativeEvidence(input.native, input.language);
  const provenance = await repo.resolveFindingProvenance(input.task, input.endpoint.id);
  const existing = await dbGet<any>(
    db,
    `SELECT id FROM findings
     WHERE source_type = ? AND title = ? AND request_raw = ? AND ai_scan_run_id = ?
     ORDER BY created_at ASC LIMIT 1`,
    ['ai_scan', input.judge.title, `${input.endpoint.method} ${input.endpoint.path}`, input.task.scan_run_id]
  );
  if (existing?.id) {
    await repo.recordFindingProvenance(String(existing.id), provenance);
    return { id: existing.id, deduplicated: true };
  }

  const findingId = uuidv4();
  const strongest = input.attempts.find(item => /root:|uid=|gid=|<script|onerror=|onload=|victim|other user|secret|admin|admin@example|negative|total\s*[:=]\s*-|accepted|refunded|cancelled|race_window/i.test(`${item.mutated?.body_preview || ''} ${JSON.stringify(item.mutated?.headers || {})}`)) || input.attempts.find(item => item.comparison.security_signal === 'positive') || input.attempts[0];
  await dbRun(
    db,
    `INSERT INTO findings (
      id, source_type, api_template_id, template_id, workflow_id,
      ai_scan_run_id, ai_scan_task_id, ai_campaign_task_id, ai_candidate_id, ai_feature_id, ai_endpoint_id, ai_evidence_contract,
      severity, status, title, description, template_name,
      request_raw, response_status, response_headers, response_body, request_evidence, response_evidence, ai_analysis,
      baseline_response, mutated_response, response_diff, notes, discovered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      findingId,
      'ai_scan',
      input.assets.template_id,
      input.assets.template_id,
      input.assets.native_bstg?.mutation_workflow_id || input.assets.workflow_id,
      provenance.ai_scan_run_id,
      provenance.ai_scan_task_id,
      provenance.ai_campaign_task_id || null,
      provenance.ai_candidate_id || null,
      provenance.ai_feature_id || null,
      provenance.ai_endpoint_id || null,
      null,
      input.judge.severity,
      'new',
      input.judge.title,
      input.judge.reason,
      `AI ${input.task.title}`,
      `${input.endpoint.method} ${input.endpoint.path}`,
      strongest?.mutated.status || null,
      JSON.stringify(strongest?.mutated.headers || {}),
      strongest?.mutated.body_preview || '',
      JSON.stringify({ endpoint: input.endpoint, task: input.task, native_bstg: { assets: input.native.assets, api_mode: input.native.api_mode, template_run: input.native.template_run, baseline_workflow_run: input.native.baseline_workflow_run, mutation_workflow_run: input.native.mutation_workflow_run }, attempts: input.attempts.map(a => ({ label: a.label, target: a.target, payload: a.payload })) }),
      JSON.stringify({ judgement: input.judge, native_evidence_gate: gate, strongest }),
      JSON.stringify(input.judge),
      JSON.stringify(strongest?.normal || null),
      JSON.stringify(strongest?.mutated || null),
      JSON.stringify(strongest?.comparison || null),
      `Created by AI Scan run ${input.task.scan_run_id} task ${input.task.id}`,
      new Date().toISOString(),
    ]
  );
  await repo.recordFindingProvenance(findingId, provenance);
  return { id: findingId, deduplicated: false };
}


function mutationTransportForEndpoint(endpoint: AIDiscoveredEndpoint, method: string, params: Record<string, string>, authContext: { headers: Record<string, string>; cookies: Record<string, string> }, task: AIScanTask, trafficClass: 'read' | 'mutation') {
  const isGet = method === 'GET';
  const contentType = String(endpoint.content_type || '').toLowerCase();
  const bodyType = contentType.includes('application/x-www-form-urlencoded') ? 'form' : 'json';
  const common = { headers: authContext.headers, cookies: authContext.cookies, timeout_ms: task.execution_plan?.timeout_ms || 30000, traffic_class: trafficClass };
  if (isGet) return { query: params, ...common };
  // Many real APIs accept POST bodies, while older form-style or mobile endpoints may also
  // bind validation fields from the query string. Send both surfaces for scanner mutations so
  // the native evidence loop exercises the parameter no matter which binding layer the app uses.
  return { query: params, body: params, body_type: bodyType as 'json' | 'form', ...common };
}

export async function runGenericVulnerabilityTask(input: {
  db: DbProvider;
  repo: AIScanRepository;
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
  endpoints?: AIDiscoveredEndpoint[];
}): Promise<Record<string, any>> {
  const { db, repo, task, endpoint } = input;
  const nativeEndpoints = input.endpoints && input.endpoints.length > 0 ? input.endpoints : [endpoint];
  await createVisualAgentState(repo, task, endpoint, 'starting_native_api_or_workflow_test');
  const vulnType = task.vuln_type || 'generic';
  const payloads = payloadsForVulnType(vulnType);
  if (payloads.length === 0) throw new Error(`No payload catalog for vuln type ${vulnType}`);
  const targets = guessMutableTargets(endpoint, vulnType);
  const assets = await createAssets(db, repo, task, endpoint, payloads, targets);
  await repo.updateTask(task.id, { phase: 'assets_prepared', created_assets_json: assets });

  const native = await runNativeBstgOrchestration({
    db,
    repo,
    task,
    endpoints: nativeEndpoints,
    payloads,
    paramName: targets[0]?.split(':')[1] || undefined,
    mode: 'generic',
  });
  await repo.updateTask(task.id, {
    phase: 'native_bstg_executed',
    created_assets_json: { ...assets, native_bstg: native.assets, native_api_mode: native.api_mode, native_counts: native.native_counts },
  });

  const method = String(endpoint.method || 'GET').toUpperCase();
  const authContext = await configuredAttackerSession(db, repo, task, nativeEndpoints.map(item => item.id));
  if (authContext.preconditions.block_finding_when_missing && authContext.preconditions.missing_preconditions.length > 0) {
    await repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'workflow_precondition_block',
      title: `Blocked ${vulnType} direct HTTP mutation because workflow preconditions are missing`,
      content_json: authContext.preconditions,
      source_ref: endpoint.id,
    });
  }
  const baselineParams = Object.fromEntries(targets.map(target => [target.split(':')[1] || 'id', vulnType === 'business_logic' && /quantity/i.test(target) ? '1' : '1001']));
  const normal = await executeHttpRequest(endpointToRequest(endpoint, mutationTransportForEndpoint(endpoint, method, baselineParams, authContext, task, 'read')));
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'baseline_http_response',
    title: `${endpoint.method} ${endpoint.path} baseline`,
    content_json: { ...normal, workflow_preconditions: authContext.preconditions } as unknown as Record<string, any>,
    source_ref: endpoint.id,
  });

  const attempts: GenericAttempt[] = [];
  for (const target of targets) {
    for (const payload of payloads) {
      const mutationParams = targetToQuery(target, payload, baselineParams);
      const mutated = await executeHttpRequest(endpointToRequest(endpoint, mutationTransportForEndpoint(endpoint, method, mutationParams, authContext, task, 'mutation')));
      const comparison = compareResponses(normal, mutated);
      const attempt: GenericAttempt = { label: payload.label, payload: payload.value, target, normal, mutated, comparison };
      attempts.push(attempt);
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'generic_mutation_attempt',
        title: `${vulnType} ${target} ${payload.label}`,
        content_json: attempt as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    }
  }

  const run = await repo.getRun(task.scan_run_id).catch(() => null);
  const language = normalizeOutputLanguage(run?.language);
  let judge: Awaited<ReturnType<typeof judgeGenericAttempts>>;
  try {
    judge = await judgeGenericAttempts(db, { vuln_type: vulnType, endpoint, normal, attempts, language });
  } catch (error: any) {
    if (error instanceof AIProviderJudgementError) {
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'ai_provider_judgement_failed',
        title: `AI provider judgement failed for ${vulnType}`,
        content_json: {
          error: error.message,
          provider_id: error.provider_id,
          model: error.model,
          provider_response: error.provider_response,
          endpoint: { id: endpoint.id, method: endpoint.method, path: endpoint.path },
          policy: 'pause_task_no_heuristic_fallback_no_finding',
        } as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    }
    throw error;
  }
  const nativeGate = { ...canCreateFindingFromNativeAndJudge(native, judge, language),
    preconditions_satisfied: authContext.preconditions.missing_preconditions.length === 0 };
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'ai_judgement',
    title: judge.title,
    content_json: { ...judge, native_evidence_gate: nativeGate } as unknown as Record<string, any>,
    source_ref: endpoint.id,
  });
  let findingId: string | undefined;
  const preconditionsSatisfied = authContext.preconditions.missing_preconditions.length === 0;
  if (judge.verdict === 'vulnerable') {
    const finding = await createFinding(db, repo, { task, endpoint, assets: { ...assets, native_bstg: native.assets }, judge, attempts, native, language });
    findingId = finding.id;
    if (finding.deduplicated) {
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'finding_deduplicated',
        title: `Deduplicated ${vulnType} finding for ${endpoint.method} ${endpoint.path}`,
        content_json: { finding_id: finding.id, title: judge.title, endpoint_id: endpoint.id, endpoint_path: endpoint.path } as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    }
    if (nativeGate.verdict !== 'confirmed' || !preconditionsSatisfied) {
      await repo.createArtifact({
        scan_run_id: task.scan_run_id,
        task_id: task.id,
        artifact_type: 'finding_created_with_replay_gap',
        title: `Created ${vulnType} finding with replay/precondition gaps`,
        content_json: { native_evidence_gate: nativeGate, workflow_preconditions: authContext.preconditions } as unknown as Record<string, any>,
        source_ref: endpoint.id,
      });
    }
  }
  return { endpoint, vuln_type: vulnType, targets, assets: { ...assets, native_bstg: native.assets }, native_bstg: native, baseline: normal, attempts, judge, finding_id: findingId };
}
