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

interface GenericAttempt {
  label: string;
  payload: string;
  target: string;
  normal: HttpResponseEvidence;
  mutated: HttpResponseEvidence;
  comparison: ReturnType<typeof compareResponses>;
}

function configuredAttackerSession(task: AIScanTask, endpointIds: string[]): { headers: Record<string, string>; cookies: Record<string, string>; preconditions: Record<string, any> } {
  const plan = task.execution_plan?.workflow_execution_plan || {};
  const policy = task.execution_plan?.precondition_policy || {};
  const postAuth = plan.access_phase === 'post_auth' || policy.access_phase === 'post_auth' || Boolean(task.execution_plan?.requires_identity_context);
  const missing = Array.isArray(policy.missing_preconditions) ? policy.missing_preconditions : [];
  const headers: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  if (postAuth) {
    headers.Authorization = 'Bearer token-attacker';
    cookies.laravel_session = 'session-attacker';
  }
  return {
    headers,
    cookies,
    preconditions: {
      access_phase: plan.access_phase || policy.access_phase || 'unknown',
      target_kind: plan.target_kind || policy.target_kind || 'unknown',
      endpoint_ids: endpointIds,
      required_capabilities: plan.required_capabilities || [],
      missing_preconditions: missing,
      direct_http_reuses_auth_context: postAuth,
      block_finding_when_missing: policy.block_finding_when_missing !== false,
    },
  };
}

function guessMutableTargets(endpoint: AIDiscoveredEndpoint): string[] {
  const text = [endpoint.path, endpoint.url, endpoint.request_summary, endpoint.response_summary].filter(Boolean).join(' ');
  const targets = new Set<string>();
  const url = endpoint.url ? new URL(endpoint.url) : null;
  for (const [key] of url?.searchParams || []) targets.add(`query:${key}`);
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

async function createAssets(db: DbProvider, task: AIScanTask, endpoint: AIDiscoveredEndpoint, payloads: AttackPayload[], targets: string[]) {
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

async function createFinding(db: DbProvider, input: {
  task: AIScanTask;
  endpoint: AIDiscoveredEndpoint;
  assets: Record<string, any>;
  judge: Awaited<ReturnType<typeof judgeGenericAttempts>>;
  attempts: GenericAttempt[];
  native: NativeBstgRunResult;
}) {
  const existing = await dbGet<any>(
    db,
    `SELECT id FROM findings
     WHERE source_type = ? AND title = ? AND request_raw = ? AND notes LIKE ?
     ORDER BY created_at ASC LIMIT 1`,
    ['ai_scan', input.judge.title, `${input.endpoint.method} ${input.endpoint.path}`, `%${input.task.scan_run_id}%`]
  );
  if (existing?.id) return { id: existing.id, deduplicated: true };

  const findingId = uuidv4();
  const strongest = input.attempts.find(item => /root:|uid=|gid=|<script|onerror=|onload=|victim|other user|secret|admin|admin@example|negative|total\s*[:=]\s*-|accepted|refunded|cancelled|race_window/i.test(`${item.mutated?.body_preview || ''} ${JSON.stringify(item.mutated?.headers || {})}`)) || input.attempts.find(item => item.comparison.security_signal === 'positive') || input.attempts[0];
  await dbRun(
    db,
    `INSERT INTO findings (
      id, source_type, api_template_id, template_id, workflow_id, severity, status, title, description, template_name,
      request_raw, response_status, response_headers, response_body, request_evidence, response_evidence, ai_analysis,
      baseline_response, mutated_response, response_diff, notes, discovered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      findingId,
      'ai_scan',
      input.assets.template_id,
      input.assets.template_id,
      input.assets.native_bstg?.mutation_workflow_id || input.assets.workflow_id,
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
      JSON.stringify({ judgement: input.judge, native_evidence_gate: evaluateNativeEvidence(input.native), strongest }),
      JSON.stringify(input.judge),
      JSON.stringify(strongest?.normal || null),
      JSON.stringify(strongest?.mutated || null),
      JSON.stringify(strongest?.comparison || null),
      `Created by AI Scan run ${input.task.scan_run_id} task ${input.task.id}`,
      new Date().toISOString(),
    ]
  );
  return { id: findingId, deduplicated: false };
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
  const targets = guessMutableTargets(endpoint);
  const assets = await createAssets(db, task, endpoint, payloads, targets);
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
  const authContext = configuredAttackerSession(task, nativeEndpoints.map(item => item.id));
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
  const normal = await executeHttpRequest(endpointToRequest(endpoint, method === 'GET'
    ? { query: baselineParams, headers: authContext.headers, cookies: authContext.cookies, timeout_ms: task.execution_plan?.timeout_ms || 30000 }
    : { body: baselineParams, body_type: 'json', headers: authContext.headers, cookies: authContext.cookies, timeout_ms: task.execution_plan?.timeout_ms || 30000 }
  ));
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
      const mutated = await executeHttpRequest(endpointToRequest(endpoint, method === 'GET'
        ? { query: mutationParams, headers: authContext.headers, cookies: authContext.cookies, timeout_ms: task.execution_plan?.timeout_ms || 30000 }
        : { body: mutationParams, body_type: 'json', headers: authContext.headers, cookies: authContext.cookies, timeout_ms: task.execution_plan?.timeout_ms || 30000 }
      ));
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

  let judge: Awaited<ReturnType<typeof judgeGenericAttempts>>;
  try {
    judge = await judgeGenericAttempts(db, { vuln_type: vulnType, endpoint, normal, attempts });
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
  const nativeGate = canCreateFindingFromNativeAndJudge(native, judge);
  await repo.createArtifact({
    scan_run_id: task.scan_run_id,
    task_id: task.id,
    artifact_type: 'ai_judgement',
    title: judge.title,
    content_json: { ...judge, native_evidence_gate: nativeGate } as unknown as Record<string, any>,
    source_ref: endpoint.id,
  });
  let findingId: string | undefined;
  const preconditionsSatisfied = !authContext.preconditions.block_finding_when_missing || authContext.preconditions.missing_preconditions.length === 0;
  if (judge.verdict === 'vulnerable' && nativeGate.verdict === 'confirmed' && preconditionsSatisfied) {
    const finding = await createFinding(db, { task, endpoint, assets: { ...assets, native_bstg: native.assets }, judge, attempts, native });
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
  } else if (judge.verdict === 'vulnerable' && !preconditionsSatisfied) {
    await repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'finding_blocked_by_workflow_preconditions',
      title: `Workflow preconditions blocked ${vulnType} finding`,
      content_json: authContext.preconditions as unknown as Record<string, any>,
      source_ref: endpoint.id,
    });
  } else if (judge.verdict === 'vulnerable') {
    await repo.createArtifact({
      scan_run_id: task.scan_run_id,
      task_id: task.id,
      artifact_type: 'finding_blocked_by_native_evidence_gate',
      title: `Native evidence gate blocked ${vulnType} finding`,
      content_json: nativeGate as unknown as Record<string, any>,
      source_ref: endpoint.id,
    });
  }
  return { endpoint, vuln_type: vulnType, targets, assets: { ...assets, native_bstg: native.assets }, native_bstg: native, baseline: normal, attempts, judge, finding_id: findingId };
}
