import { v4 as uuidv4 } from 'uuid';
import type { DbProvider } from '../../types/index.js';
import { buildExecutionLearningSuggestions } from '../learning-source-execution.js';
import { createMapping, createVariable } from '../variable-pool.js';
import type { DebugTrace } from '../debug-trace.js';
import type { StepSnapshot } from '../learning-engine.js';
import type { LearningSuggestionPayload } from '../learning-v2-types.js';

function safeJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function parseUrlParts(url: string): { path: string; query: Record<string, string> } {
  try {
    const u = new URL(url, 'http://placeholder.local');
    const query: Record<string, string> = {};
    for (const [key, value] of u.searchParams.entries()) query[key] = value;
    return { path: `${u.pathname}${u.search}`, query };
  } catch {
    return { path: url || '/', query: {} };
  }
}

function parseCookiesFromSetCookie(setCookie?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!setCookie) return cookies;
  for (const part of String(setCookie).split(/,(?=\s*[a-zA-Z0-9_-]+=)/)) {
    const first = part.split(';')[0]?.trim();
    const eq = first?.indexOf('=') ?? -1;
    if (first && eq > 0) cookies[first.slice(0, eq)] = first.slice(eq + 1);
  }
  return cookies;
}

function parseRequestBody(body: string | undefined): any {
  if (!body) return null;
  try { return JSON.parse(body); } catch { return body; }
}

function parseResponseBody(body: string | undefined): any {
  if (!body) return null;
  try { return JSON.parse(body); } catch { return body; }
}

export function traceToStepSnapshots(trace: DebugTrace | null | undefined): StepSnapshot[] {
  if (!trace?.records?.length) return [];
  return trace.records.map((record, index) => {
    const { path, query } = parseUrlParts(record.url);
    const stepOrder = Number(record.meta?.step_order || index + 1);
    return {
      stepOrder,
      templateId: record.meta?.template_id || `trace_template_${stepOrder}`,
      templateName: record.meta?.template_name || record.meta?.label || `Trace Step ${stepOrder}`,
      request: {
        method: record.method,
        url: record.url,
        path,
        headers: record.headers || {},
        cookies: {},
        query,
        body: parseRequestBody(record.body),
      },
      response: {
        status: record.response?.status || 0,
        headers: record.response?.headers || {},
        cookies: parseCookiesFromSetCookie((record.response?.headers || {})['set-cookie'] || (record.response?.headers || {})['Set-Cookie']),
        body: parseResponseBody(record.response?.body),
      },
    };
  });
}

async function storeSuggestion(db: DbProvider, workflowId: string, payload: LearningSuggestionPayload, sourceExecutionRunId?: string): Promise<string> {
  const suggestionId = uuidv4();
  const now = new Date().toISOString();
  await db.runRawQuery(
    `INSERT INTO workflow_learning_suggestions (id, workflow_id, source_type, source_recording_session_id, source_execution_run_id, suggestion_payload, status, learning_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [suggestionId, workflowId, payload.sourceType, payload.sourceRecordingSessionId || null, sourceExecutionRunId || payload.sourceExecutionRunId || null, JSON.stringify(payload), 'generated', payload.learningVersion || 1, now, now]
  );
  for (const evidence of payload.evidence || []) {
    await db.runRawQuery(
      `INSERT INTO workflow_learning_evidence (id, suggestion_id, from_step_order, to_step_order, evidence_type, evidence_payload, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), suggestionId, evidence.fromStepOrder ?? null, evidence.toStepOrder ?? null, evidence.evidenceType, JSON.stringify(evidence.payload || {}), evidence.confidence ?? 0, now, now]
    );
  }
  return suggestionId;
}

export async function applyLearningPayload(db: DbProvider, workflowId: string, payload: LearningSuggestionPayload, options: {
  applyMode?: 'merge_keep_manual' | 'replace_all';
  applySessionJar?: boolean;
  applyAssertions?: boolean;
  minConfidence?: number;
} = {}): Promise<Record<string, any>> {
  const applyMode = options.applyMode || 'merge_keep_manual';
  const minConfidence = options.minConfidence ?? 0.65;

  const variables = (payload.suggestions?.workflowVariables || []).filter((item: any) => Number(item.confidence || 0) >= minConfidence);
  const mappings = (payload.suggestions?.mappings || []).filter((item: any) => item.selectedByDefault !== false && Number(item.confidence || 0) >= minConfidence);
  const extractors = (payload.suggestions?.extractors || []).filter((item: any) => Number(item.confidence || 0) >= minConfidence);
  const hasStructuralSuggestions = variables.length > 0 || mappings.length > 0 || extractors.length > 0;

  // Do not destroy heuristic Agent-compiled variables/mappings when the execution learner has no
  // higher-confidence replacement. In production this keeps initial AI workflow compilation usable
  // while still allowing learned values to replace it when evidence exists.
  if (hasStructuralSuggestions) {
    if (applyMode === 'replace_all') {
      await db.runRawQuery(`DELETE FROM workflow_variables WHERE workflow_id = ?`, [workflowId]);
      await db.runRawQuery(`DELETE FROM workflow_mappings WHERE workflow_id = ?`, [workflowId]);
      await db.runRawQuery(`DELETE FROM workflow_extractors WHERE workflow_id = ?`, [workflowId]);
    } else {
      await db.runRawQuery(`DELETE FROM workflow_variables WHERE workflow_id = ? AND source != 'manual' AND (is_locked = 0 OR is_locked IS NULL)`, [workflowId]);
      await db.runRawQuery(`DELETE FROM workflow_mappings WHERE workflow_id = ? AND reason != 'manual'`, [workflowId]);
      await db.runRawQuery(`DELETE FROM workflow_extractors WHERE workflow_id = ?`, [workflowId]);
    }
  }

  const createdVariables: any[] = [];
  for (const variable of variables) {
    createdVariables.push(await createVariable(db, workflowId, {
      name: variable.variableName,
      type: variable.predictedType || 'GENERIC',
      source: 'extracted',
      write_policy: variable.writePolicySuggestion || 'overwrite',
      is_locked: !!variable.lockSuggestion,
      description: variable.reason || 'AI execution learning suggestion',
      current_value: undefined,
    } as any));
  }

  const createdMappings: any[] = [];
  for (const mapping of mappings) {
    createdMappings.push(await createMapping(db, workflowId, {
      from_step_order: mapping.fromStepOrder,
      from_location: mapping.fromLocation,
      from_path: mapping.fromPath,
      to_step_order: mapping.toStepOrder,
      to_location: mapping.toLocation,
      to_path: mapping.toPath,
      variable_name: mapping.variableName,
      confidence: mapping.confidence,
      reason: mapping.reason === 'recording_factual_evidence' ? 'heuristic' : (mapping.reason || 'heuristic'),
      is_enabled: true,
    } as any));
  }

  const createdExtractors: any[] = [];
  for (const extractor of extractors) {
    const id = uuidv4();
    await db.runRawQuery(
      `INSERT INTO workflow_extractors (id, workflow_id, step_order, name, source, expression, transform, required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        workflowId,
        extractor.stepOrder,
        extractor.targetVariableName,
        extractor.extractorType === 'header' ? 'response_header' : extractor.extractorType === 'cookie' ? 'response_cookie' : 'response_body_jsonpath',
        extractor.sourcePath,
        extractor.source === 'hybrid' ? JSON.stringify({ hint: 'hybrid_learned' }) : null,
        extractor.required ? 1 : 0,
      ]
    );
    createdExtractors.push({ id, workflow_id: workflowId, step_order: extractor.stepOrder, name: extractor.targetVariableName });
  }

  let sessionJarApplied = false;
  if (options.applySessionJar !== false && payload.suggestions?.sessionJar) {
    const sessionJar = payload.suggestions.sessionJar;
    await db.runRawQuery(
      `UPDATE workflows SET enable_session_jar = ?, session_jar_config = ?, updated_at = ? WHERE id = ?`,
      [1, JSON.stringify({ cookie_mode: sessionJar.cookieMode, header_keys: sessionJar.headerKeys || [], body_json_paths: sessionJar.bodyJsonPaths || [] }), new Date().toISOString(), workflowId]
    );
    sessionJarApplied = true;
  }

  if (options.applyAssertions && Array.isArray(payload.suggestions?.assertions)) {
    for (const assertion of payload.suggestions.assertions) {
      const stepRows = await db.runRawQuery<any>(`SELECT * FROM workflow_steps WHERE workflow_id = ? AND step_order = ?`, [workflowId, assertion.stepOrder]);
      const step = stepRows?.[0];
      if (!step) continue;
      const existingAssertions = safeJson<any[]>(step.step_assertions, []);
      existingAssertions.push(assertion.config);
      await db.runRawQuery(`UPDATE workflow_steps SET step_assertions = ?, assertions_mode = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(existingAssertions), 'all', new Date().toISOString(), step.id]);
    }
  }

  const now = new Date().toISOString();
  await db.runRawQuery(`UPDATE workflows SET learning_status = 'learned', learning_version = ?, learning_source_preference = ?, last_learning_mode = ?, updated_at = ? WHERE id = ?`, [payload.learningVersion || 1, payload.sourceType, payload.sourceType, now, workflowId]);

  return {
    variables_created: createdVariables.length,
    mappings_created: createdMappings.length,
    extractors_created: createdExtractors.length,
    session_jar_applied: sessionJarApplied,
    variables: createdVariables,
    mappings: createdMappings,
    extractors: createdExtractors,
  };
}

export async function generateAndApplyExecutionLearning(db: DbProvider, workflowId: string, trace: DebugTrace | null | undefined, options: {
  sourceExecutionRunId?: string;
  includeAssertions?: boolean;
  minConfidence?: number;
  applyMode?: 'merge_keep_manual' | 'replace_all';
} = {}): Promise<Record<string, any>> {
  const stepSnapshots = traceToStepSnapshots(trace);
  if (stepSnapshots.length === 0) {
    return { ok: false, reason: 'no_debug_trace_records', step_snapshots: 0 };
  }
  const payload = await buildExecutionLearningSuggestions(db, workflowId, stepSnapshots, {
    includeExtractors: true,
    includeSessionJar: true,
    includeAssertions: options.includeAssertions !== false,
  });
  const suggestionId = await storeSuggestion(db, workflowId, payload, options.sourceExecutionRunId);
  const applied = await applyLearningPayload(db, workflowId, payload, {
    applyMode: options.applyMode || 'merge_keep_manual',
    applySessionJar: true,
    applyAssertions: options.includeAssertions !== false,
    minConfidence: options.minConfidence ?? 0.55,
  });
  return {
    ok: true,
    suggestion_id: suggestionId,
    learning_version: payload.learningVersion,
    summary: payload.summary,
    conflicts: payload.conflicts,
    step_snapshots: stepSnapshots.length,
    applied,
  };
}
