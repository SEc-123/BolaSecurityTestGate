import { v4 as uuidv4 } from 'uuid';
import type { DbProvider } from '../../types/index.js';
import { dbGet, dbRun } from '../../db/sql-helpers.js';
import type { AIScanRepository } from './repository.js';
import type { AIHistoricalVulnMatch, AIPocExecution, AIScanRun, AIScanTask, AITechFingerprint } from './types.js';
import { endpointToRequest, executeHttpRequest, type HttpResponseEvidence } from './http-executor.js';

interface PocRequestStep {
  method?: string;
  path?: string;
  url?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: any;
  body_type?: 'json' | 'form' | 'raw' | 'none';
  timeout_ms?: number;
}

interface PocSignal {
  type: 'status' | 'body_contains' | 'body_regex' | 'header_contains' | 'body_not_contains';
  value: string | number;
  header?: string;
}

export interface HistoricalPocTemplate {
  preconditions: string[];
  request_sequence: PocRequestStep[];
  success_signals: PocSignal[];
  failure_signals: PocSignal[];
  risk_level: 'read_only' | 'write' | 'command_execution' | 'sensitive_read' | 'destructive';
  requires_lab_mode: boolean;
  notes?: string;
}

function normalizeSeverity(value?: string): 'critical' | 'high' | 'medium' | 'low' | 'info' {
  const severity = String(value || '').toLowerCase();
  if (['critical', 'high', 'medium', 'low', 'info'].includes(severity)) return severity as any;
  return 'medium';
}

function now(): string {
  return new Date().toISOString();
}

function safeJson(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function templateFromRaw(match: AIHistoricalVulnMatch): HistoricalPocTemplate | null {
  const raw = safeJson(match.raw_json);
  const template = safeJson(raw.poc_template || raw.poc || raw.safe_poc);
  if (!Object.keys(template).length) return null;
  return {
    preconditions: Array.isArray(template.preconditions) ? template.preconditions.map(String) : [],
    request_sequence: Array.isArray(template.request_sequence) ? template.request_sequence : [],
    success_signals: Array.isArray(template.success_signals) ? template.success_signals : [],
    failure_signals: Array.isArray(template.failure_signals) ? template.failure_signals : [],
    risk_level: ['read_only', 'write', 'command_execution', 'sensitive_read', 'destructive'].includes(String(template.risk_level))
      ? template.risk_level
      : 'read_only',
    requires_lab_mode: Boolean(template.requires_lab_mode),
    notes: template.notes ? String(template.notes) : undefined,
  };
}

function genericTemplate(match: AIHistoricalVulnMatch, fingerprint?: AITechFingerprint): HistoricalPocTemplate {
  return {
    preconditions: [
      'High-confidence technology fingerprint exists.',
      'Historical vulnerability intelligence matches the observed product and version range.',
      'Only read-only confirmation probes are allowed unless poc_lab_mode is explicitly enabled.',
    ],
    request_sequence: [
      { method: 'GET', path: '/', timeout_ms: 12000 },
      { method: 'GET', path: `/.bstg-poc-probe/${encodeURIComponent(match.cve_id || match.ghsa_id || match.osv_id || match.source_id)}`, timeout_ms: 12000 },
    ],
    success_signals: [],
    failure_signals: [
      { type: 'status', value: 401 },
      { type: 'status', value: 403 },
    ],
    risk_level: 'read_only',
    requires_lab_mode: false,
    notes: `Generic non-destructive exposure check for ${fingerprint?.component_name || match.source_id}. It does not prove exploitation without vulnerability-specific success signals.`,
  };
}

function shouldPlanPoc(match: AIHistoricalVulnMatch, fingerprint?: AITechFingerprint): { allowed: boolean; status: string; reason: string; only_read_only: boolean } {
  const fingerprintConfidence = Number(fingerprint?.confidence || 0);
  const versionKnown = Boolean(fingerprint?.version || match.raw_json?.component_version);
  if (fingerprintConfidence >= 0.85 && versionKnown && match.match_confidence >= 0.85) {
    return { allowed: true, status: 'planned', reason: 'high-confidence fingerprint and affected version match', only_read_only: false };
  }
  if (fingerprintConfidence >= 0.55 && match.match_confidence >= 0.55) {
    return { allowed: true, status: 'planned_read_only', reason: 'medium-confidence match; restricted to read-only confirmation', only_read_only: true };
  }
  return { allowed: false, status: 'inventory_only', reason: 'confidence below POC threshold', only_read_only: true };
}

export async function planHistoricalVulnPocs(input: {
  repo: AIScanRepository;
  scanRunId: string;
}): Promise<{ planned: AIPocExecution[]; skipped: Array<{ historical_vuln_id: string; reason: string }> }> {
  const [matches, fingerprints] = await Promise.all([
    input.repo.listHistoricalVulns(input.scanRunId),
    input.repo.listTechFingerprints(input.scanRunId),
  ]);
  const byId = new Map(fingerprints.map(item => [item.id, item]));
  const planned: AIPocExecution[] = [];
  const skipped: Array<{ historical_vuln_id: string; reason: string }> = [];
  for (const match of matches) {
    const fingerprint = match.fingerprint_id ? byId.get(match.fingerprint_id) : undefined;
    const decision = shouldPlanPoc(match, fingerprint);
    if (!decision.allowed) {
      skipped.push({ historical_vuln_id: match.id, reason: decision.reason });
      continue;
    }
    const rawTemplate = templateFromRaw(match);
    const template = rawTemplate || genericTemplate(match, fingerprint);
    const restrictedTemplate: HistoricalPocTemplate = decision.only_read_only && template.risk_level !== 'read_only'
      ? { ...template, requires_lab_mode: true }
      : template;
    const execution = await input.repo.createPocExecution({
      scan_run_id: input.scanRunId,
      historical_vuln_id: match.id,
      template_json: {
        ...restrictedTemplate,
        planning_reason: decision.reason,
        component: fingerprint ? {
          id: fingerprint.id,
          name: fingerprint.component_name,
          version: fingerprint.version,
          confidence: fingerprint.confidence,
        } : undefined,
      },
      status: decision.status,
      safety_level: restrictedTemplate.risk_level,
      requires_lab_mode: restrictedTemplate.requires_lab_mode,
      evidence_json: { planned_at: now(), planning_reason: decision.reason },
    });
    planned.push(execution);
  }
  return { planned, skipped };
}

function absoluteUrl(baseUrl: string, step: PocRequestStep): string {
  if (step.url) return new URL(step.url, baseUrl).toString();
  return new URL(step.path || '/', baseUrl).toString();
}

function signalMatches(signal: PocSignal, response: HttpResponseEvidence): boolean {
  if (signal.type === 'status') return response.status === Number(signal.value);
  if (signal.type === 'body_contains') return String(response.body_preview || '').includes(String(signal.value));
  if (signal.type === 'body_not_contains') return !String(response.body_preview || '').includes(String(signal.value));
  if (signal.type === 'body_regex') {
    try {
      return new RegExp(String(signal.value), 'i').test(response.body_preview || '');
    } catch {
      return false;
    }
  }
  if (signal.type === 'header_contains') {
    const value = response.headers[String(signal.header || '').toLowerCase()] || '';
    return String(value).toLowerCase().includes(String(signal.value).toLowerCase());
  }
  return false;
}

function evaluatePoc(template: HistoricalPocTemplate, responses: HttpResponseEvidence[]): { status: string; evidence_level: string; reason: string; success_signals_hit: PocSignal[]; failure_signals_hit: PocSignal[] } {
  const finalResponse = responses[responses.length - 1] || responses[0];
  const successSignals = template.success_signals || [];
  const failureSignals = template.failure_signals || [];
  const successHits = successSignals.filter(signal => signalMatches(signal, finalResponse));
  const failureHits = failureSignals.filter(signal => signalMatches(signal, finalResponse));
  if (failureHits.length > 0) {
    return { status: 'not_vulnerable', evidence_level: 'negative', reason: 'failure signal matched', success_signals_hit: successHits, failure_signals_hit: failureHits };
  }
  if (successSignals.length > 0 && successHits.length === successSignals.length) {
    return { status: 'confirmed', evidence_level: 'poc_signal', reason: 'all success signals matched', success_signals_hit: successHits, failure_signals_hit: failureHits };
  }
  if (successSignals.length > 0 && successHits.length > 0) {
    return { status: 'probable', evidence_level: 'partial_poc_signal', reason: 'partial success signals matched', success_signals_hit: successHits, failure_signals_hit: failureHits };
  }
  return { status: 'probable', evidence_level: 'exposure_only', reason: 'read-only exposure check completed without vulnerability-specific success signals', success_signals_hit: [], failure_signals_hit: failureHits };
}

async function createKnownVulnFinding(db: DbProvider, input: {
  run: AIScanRun;
  task?: AIScanTask;
  execution: AIPocExecution;
  match: AIHistoricalVulnMatch;
  fingerprint?: AITechFingerprint;
  responses: HttpResponseEvidence[];
  evaluation: ReturnType<typeof evaluatePoc>;
}): Promise<{ id: string; deduplicated: boolean }> {
  const findingKey = `${input.match.cve_id || input.match.ghsa_id || input.match.osv_id || input.match.source_id}:${input.fingerprint?.component_name || input.match.source_id}`;
  const existing = await dbGet<any>(
    db,
    `SELECT id FROM findings WHERE source_type = ? AND notes LIKE ? ORDER BY created_at ASC LIMIT 1`,
    ['ai_scan', `%known_vulnerable_component:${findingKey}%`]
  );
  if (existing?.id) return { id: existing.id, deduplicated: true };

  const strongest = input.responses[input.responses.length - 1] || input.responses[0];
  const id = uuidv4();
  const status = input.evaluation.status === 'confirmed' ? 'confirmed' : 'new';
  const title = `${input.match.cve_id || input.match.ghsa_id || input.match.osv_id || input.match.source_id}: ${input.fingerprint?.component_name || input.match.title}${input.fingerprint?.version ? ` ${input.fingerprint.version}` : ''}`;
  await dbRun(
    db,
    `INSERT INTO findings (
      id, source_type, severity, status, title, description, template_name, workflow_name, request_raw,
      response_status, response_headers, response_body, request_evidence, response_evidence, ai_analysis,
      baseline_response, mutated_response, response_diff, notes, discovered_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    [
      id,
      'ai_scan',
      normalizeSeverity(input.match.severity),
      status,
      title,
      input.match.title,
      'AI known vulnerable component POC',
      input.task?.title || 'Historical vulnerability POC',
      `${String(input.execution.template_json?.request_sequence?.[0]?.method || 'GET').toUpperCase()} ${absoluteUrl(input.run.base_url, input.execution.template_json?.request_sequence?.[0] || { path: '/' })}`,
      strongest?.status || null,
      JSON.stringify(strongest?.headers || {}),
      strongest?.body_preview || '',
      JSON.stringify({
        endpoint: { method: input.execution.template_json?.request_sequence?.[0]?.method || 'GET', url: absoluteUrl(input.run.base_url, input.execution.template_json?.request_sequence?.[0] || { path: '/' }) },
        task: input.task ? { id: input.task.id, title: input.task.title, task_type: input.task.task_type, vuln_type: input.task.vuln_type, execution_plan: input.task.execution_plan } : { vuln_type: 'known_vulnerable_component' },
        tech_fingerprint: input.fingerprint,
        historical_vuln: input.match,
        poc_execution_id: input.execution.id,
      }),
      JSON.stringify({ evaluation: input.evaluation, poc_template: input.execution.template_json, responses: input.responses }),
      JSON.stringify({
        verdict: input.evaluation.status === 'confirmed' ? 'vulnerable' : 'probable',
        confidence: input.evaluation.status === 'confirmed' ? Math.max(input.match.match_confidence, input.fingerprint?.confidence || 0) : input.match.match_confidence,
        severity: normalizeSeverity(input.match.severity),
        reason: input.evaluation.reason,
        evidence: input.evaluation.success_signals_hit.map(signal => `${signal.type}:${signal.value}`),
        source: 'historical_vulnerability_poc',
      }),
      JSON.stringify(input.responses[0] || null),
      JSON.stringify(strongest || null),
      JSON.stringify(input.evaluation),
      `known_vulnerable_component:${findingKey}; scan_run=${input.run.id}; poc_execution=${input.execution.id}; task=${input.task?.id || 'direct'}`,
      now(),
    ]
  );
  return { id, deduplicated: false };
}

export async function executeHistoricalVulnPoc(input: {
  db: DbProvider;
  repo: AIScanRepository;
  run: AIScanRun;
  task?: AIScanTask;
  poc_execution_id?: string;
}): Promise<Record<string, any>> {
  const executions = input.poc_execution_id
    ? [await input.repo.getPocExecution(input.poc_execution_id)].filter(Boolean) as AIPocExecution[]
    : (await input.repo.listPocExecutions(input.run.id)).filter(item => ['planned', 'planned_read_only'].includes(item.status));
  const matches = await input.repo.listHistoricalVulns(input.run.id);
  const fingerprints = await input.repo.listTechFingerprints(input.run.id);
  const matchesById = new Map(matches.map(item => [item.id, item]));
  const fingerprintsById = new Map(fingerprints.map(item => [item.id, item]));
  const results: any[] = [];

  for (const execution of executions) {
    const match = matchesById.get(execution.historical_vuln_id);
    if (!match) {
      await input.repo.updatePocExecution(execution.id, { status: 'failed', result_summary: 'Historical vulnerability match no longer exists', completed_at: now() });
      continue;
    }
    const fingerprint = match.fingerprint_id ? fingerprintsById.get(match.fingerprint_id) : undefined;
    const template = execution.template_json as HistoricalPocTemplate;
    const risk = String(template.risk_level || execution.safety_level || 'read_only');
    const requiresLabMode = Boolean(template.requires_lab_mode || execution.requires_lab_mode || ['write', 'command_execution', 'sensitive_read', 'destructive'].includes(risk));
    if (requiresLabMode && input.run.scan_config?.poc_lab_mode !== true) {
      const evidence = {
        blocked_at: now(),
        reason: 'poc_lab_mode_required',
        risk_level: risk,
        policy: 'write, command execution, sensitive-read, persistence and destructive POCs require scan_config.poc_lab_mode=true',
      };
      await input.repo.updatePocExecution(execution.id, {
        task_id: input.task?.id,
        status: 'blocked',
        requires_lab_mode: true,
        evidence_json: evidence,
        result_summary: 'POC requires lab mode and was not executed',
        completed_at: now(),
      });
      await input.repo.createArtifact({
        scan_run_id: input.run.id,
        task_id: input.task?.id,
        artifact_type: 'historical_poc_blocked',
        title: `${match.source_id} POC blocked by lab-mode policy`,
        content_json: evidence,
        source_ref: execution.id,
      });
      results.push({ execution_id: execution.id, status: 'blocked', reason: evidence.reason });
      continue;
    }

    await input.repo.updatePocExecution(execution.id, { task_id: input.task?.id, status: 'running', started_at: now() });
    const responses: HttpResponseEvidence[] = [];
    const requestSequence = Array.isArray(template.request_sequence) && template.request_sequence.length ? template.request_sequence : [{ method: 'GET', path: '/' }];
    for (const step of requestSequence) {
      const url = absoluteUrl(input.run.base_url, step);
      const response = await executeHttpRequest(endpointToRequest({
        id: `historical-poc:${execution.id}`,
        scan_run_id: input.run.id,
        method: String(step.method || 'GET').toUpperCase(),
        path: new URL(url).pathname || '/',
        url,
        content_type: step.body_type === 'json' ? 'application/json' : undefined,
        source_type: 'historical_poc',
        created_at: now(),
        updated_at: now(),
      }, {
        method: String(step.method || 'GET').toUpperCase(),
        url,
        query: step.query || {},
        headers: step.headers || {},
        body: step.body,
        body_type: step.body_type || 'none',
        timeout_ms: Number(step.timeout_ms || input.run.scan_config?.historical_poc_timeout_ms || 15000),
      }));
      responses.push(response);
    }
    const evaluation = evaluatePoc(template, responses);
    const confirmedAllowed = Boolean(fingerprint?.version) && Number(fingerprint?.confidence || 0) >= 0.85 && match.match_confidence >= 0.85;
    const finalStatus = evaluation.status === 'confirmed' && confirmedAllowed ? 'confirmed' : evaluation.status === 'not_vulnerable' ? 'not_vulnerable' : 'probable';
    const evidence: Record<string, any> = {
      completed_at: now(),
      evaluation: { ...evaluation, status: finalStatus, confirmed_allowed: confirmedAllowed },
      responses,
      component: fingerprint,
      historical_vuln: match,
      policy: {
        confirmed_requires: ['high-confidence technology fingerprint', 'affected product/version match', 'POC success signal'],
      },
    };
    let findingId: string | undefined;
    if (['confirmed', 'probable'].includes(finalStatus) && evaluation.evidence_level !== 'exposure_only') {
      const finding = await createKnownVulnFinding(input.db, { run: input.run, task: input.task, execution, match, fingerprint, responses, evaluation: { ...evaluation, status: finalStatus } });
      findingId = finding.id;
      evidence.finding = finding;
    }
    await input.repo.updatePocExecution(execution.id, {
      task_id: input.task?.id,
      status: finalStatus,
      evidence_json: evidence,
      result_summary: `${match.source_id} POC ${finalStatus}: ${evaluation.reason}`,
      completed_at: now(),
    });
    await input.repo.createArtifact({
      scan_run_id: input.run.id,
      task_id: input.task?.id,
      artifact_type: 'historical_poc_execution',
      title: `${match.source_id} ${finalStatus}`,
      content_json: { ...evidence, finding_id: findingId },
      source_ref: execution.id,
    });
    results.push({ execution_id: execution.id, historical_vuln_id: match.id, status: finalStatus, finding_id: findingId, reason: evaluation.reason });
  }

  return { executed_count: results.length, results };
}
