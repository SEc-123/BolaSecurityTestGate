import type {
  DbProvider,
  DraftPublishLog,
  RecordingEvent,
  RecordingExtractorCandidate,
  RecordingFieldHit,
  RecordingFieldTarget,
  RecordingRuntimeContext,
  RecordingSession,
  RecordingVariableCandidate,
  TestRunDraft,
  TestRunPreset,
  WorkflowDraft,
  WorkflowDraftStep,
} from '../types/index.js';
import {
  normalizeRecordingFieldTargets,
  type IncomingRecordingEvent,
  type IncomingRecordingFieldTarget,
} from './recording-field-extractor.js';
import {
  generateApiDraftArtifacts,
  generateWorkflowDraftArtifacts,
} from './recording-generator.js';
import { FieldDictionary } from './field-dictionary.js';
import { processRecordingEventsBatch } from './recording-processor.js';
import {
  incrementPromotionSuccess,
  incrementRecordingEventsIngested,
  incrementRecordingSessionsCreated,
  recordDraftGeneration,
  recordRecordingFinish,
  recordRecordingGenerationFailure,
} from './recording-telemetry.js';
import { listRecordingAccountApplyLogs } from './recording-account-linkage.js';
import {
  appendRecordingAuditLog,
  createRecordingDeadLetter,
} from './recording-observability.js';

interface SessionArtifacts {
  session: RecordingSession;
  targets: RecordingFieldTarget[];
  events: RecordingEvent[];
  fieldHits: RecordingFieldHit[];
  runtimeContexts: RecordingRuntimeContext[];
  workflowDrafts: WorkflowDraft[];
  workflowDraftSteps: WorkflowDraftStep[];
  testRunDrafts: TestRunDraft[];
  presets: TestRunPreset[];
}

function ensureArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function nowIso(): string {
  return new Date().toISOString();
}

function groupPublishLogsByDraftId(logs: DraftPublishLog[]): Map<string, DraftPublishLog[]> {
  const grouped = new Map<string, DraftPublishLog[]>();
  for (const log of logs) {
    const bucket = grouped.get(log.source_draft_id) || [];
    bucket.push(log);
    grouped.set(log.source_draft_id, bucket);
  }
  return grouped;
}

function buildDraftPublishLogPayload(params: {
  draft_type: 'workflow' | 'test_run';
  source_draft_id: string;
  source_recording_session_id?: string;
  target_asset_type: string;
  target_asset_id: string;
  published_by?: string;
}): Omit<DraftPublishLog, 'id' | 'created_at' | 'updated_at'> {
  return {
    draft_type: params.draft_type,
    source_draft_id: params.source_draft_id,
    source_recording_session_id: params.source_recording_session_id,
    target_asset_type: params.target_asset_type,
    target_asset_id: params.target_asset_id,
    published_by: params.published_by,
    published_at: nowIso(),
  };
}

function getLatestPublishTargetId(logs: DraftPublishLog[], targetAssetType: string): string | undefined {
  const matchingLogs = logs
    .filter(log => log.target_asset_type === targetAssetType)
    .sort((a, b) => {
      const aTime = new Date(a.published_at || a.created_at).getTime();
      const bTime = new Date(b.published_at || b.created_at).getTime();
      return bTime - aTime;
    });
  return matchingLogs[0]?.target_asset_id;
}

async function recomputeSessionMetrics(db: DbProvider, sessionId: string): Promise<RecordingSession> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  const [
    eventCount,
    fieldHitCount,
    runtimeContextCount,
    workflowDrafts,
    testRunDrafts,
    draftPublishLogs,
  ] = await Promise.all([
    db.repos.recordingEvents.count({ session_id: sessionId } as any),
    db.repos.recordingFieldHits.count({ session_id: sessionId } as any),
    db.repos.recordingRuntimeContext.count({ session_id: sessionId } as any),
    db.repos.workflowDrafts.findAll({ where: { session_id: sessionId } as any }),
    db.repos.testRunDrafts.findAll({ where: { session_id: sessionId } as any }),
    db.repos.draftPublishLogs.findAll(),
  ]);

  const relevantDraftIds = new Set([
    ...workflowDrafts.map(item => item.id),
    ...testRunDrafts.map(item => item.id),
  ]);
  const relevantLogs = draftPublishLogs.filter(log => relevantDraftIds.has(log.source_draft_id));
  const draftIdsWithPromotions = new Set(relevantLogs.map(log => log.source_draft_id));
  const publishedPresetCount = relevantLogs.filter(log => log.target_asset_type === 'test_run_preset').length;
  const publishedTemplateCount = relevantLogs.filter(log => log.target_asset_type === 'api_template').length;
  const publishedTestRunCount = relevantLogs.filter(log => log.target_asset_type === 'test_run').length;
  const promotedDraftCount =
    workflowDrafts.filter(item => item.status === 'published' || draftIdsWithPromotions.has(item.id)).length +
    testRunDrafts.filter(item => item.status === 'published' || draftIdsWithPromotions.has(item.id)).length;
  const publishedResultCount = relevantLogs.length;
  const generatedResultCount = workflowDrafts.length + testRunDrafts.length;

  const summary = {
    ...(session.summary || {}),
    last_metrics_refresh_at: nowIso(),
    workflow_draft_count: workflowDrafts.length,
    test_run_draft_count: testRunDrafts.length,
    promoted_draft_count: promotedDraftCount,
    published_preset_count: publishedPresetCount,
    published_template_count: publishedTemplateCount,
    published_test_run_count: publishedTestRunCount,
  };

  const updated = await db.repos.recordingSessions.update(sessionId, {
    event_count: eventCount,
    field_hit_count: fieldHitCount,
    runtime_context_count: runtimeContextCount,
    generated_result_count: generatedResultCount,
    published_result_count: publishedResultCount,
    status: promotedDraftCount > 0 && promotedDraftCount >= generatedResultCount
      ? 'published'
      : session.status,
    summary,
  } as any);

  if (!updated) {
    throw new Error(`Failed to update recording session metrics: ${sessionId}`);
  }

  return updated;
}

async function loadSessionArtifacts(db: DbProvider, sessionId: string): Promise<SessionArtifacts> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  const [
    targets,
    events,
    fieldHits,
    runtimeContexts,
    workflowDrafts,
    workflowDraftSteps,
    testRunDrafts,
    presets,
  ] = await Promise.all([
    db.repos.recordingFieldTargets.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingEvents.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingFieldHits.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingRuntimeContext.findAll({ where: { session_id: sessionId } as any }),
    db.repos.workflowDrafts.findAll({ where: { session_id: sessionId } as any }),
    db.repos.workflowDraftSteps.findAll({ where: { session_id: sessionId } as any }),
    db.repos.testRunDrafts.findAll({ where: { session_id: sessionId } as any }),
    db.repos.testRunPresets.findAll(),
  ]);

  const relevantDraftIds = new Set(testRunDrafts.map(item => item.id));

  return {
    session: {
      ...session,
      target_fields: targets,
    },
    targets,
    events: [...events].sort((a, b) => a.sequence - b.sequence),
    fieldHits,
    runtimeContexts,
    workflowDrafts,
    workflowDraftSteps: [...workflowDraftSteps].sort((a, b) => a.sequence - b.sequence),
    testRunDrafts: [...testRunDrafts].sort((a, b) => (a.sequence || 0) - (b.sequence || 0)),
    presets: presets.filter(item => !item.source_draft_id || relevantDraftIds.has(item.source_draft_id)),
  };
}

async function clearGeneratedDraftArtifacts(db: DbProvider, sessionId: string): Promise<void> {
  const workflowDrafts = await db.repos.workflowDrafts.findAll({ where: { session_id: sessionId } as any });
  for (const draft of workflowDrafts) {
    if (draft.status === 'published') continue;

    const draftSteps = await db.repos.workflowDraftSteps.findAll({ where: { workflow_draft_id: draft.id } as any });
    const variableCandidates = await db.repos.recordingVariableCandidates.findAll({ where: { workflow_draft_id: draft.id } as any });
    const extractorCandidates = await db.repos.recordingExtractorCandidates.findAll({ where: { workflow_draft_id: draft.id } as any });

    for (const candidate of variableCandidates) {
      await db.repos.recordingVariableCandidates.delete(candidate.id);
    }
    for (const candidate of extractorCandidates) {
      await db.repos.recordingExtractorCandidates.delete(candidate.id);
    }
    for (const step of draftSteps) {
      await db.repos.workflowDraftSteps.delete(step.id);
    }
    await db.repos.workflowDrafts.delete(draft.id);
  }

  const testRunDrafts = await db.repos.testRunDrafts.findAll({ where: { session_id: sessionId } as any });
  const draftPublishLogs = await db.repos.draftPublishLogs.findAll();
  const promotedDraftIds = new Set(draftPublishLogs.map(log => log.source_draft_id));
  for (const draft of testRunDrafts) {
    if (draft.status === 'published' || promotedDraftIds.has(draft.id)) continue;
    await db.repos.testRunDrafts.delete(draft.id);
  }
}

function groupByEventId<T extends { event_id?: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    if (!item.event_id) continue;
    const bucket = map.get(item.event_id) || [];
    bucket.push(item);
    map.set(item.event_id, bucket);
  }
  return map;
}

function buildRuntimeContextSummary(runtimeContexts: RecordingRuntimeContext[]): {
  values: Record<string, string>;
  cookies: Record<string, string>;
  headers: Record<string, string>;
} {
  const summary = {
    values: {} as Record<string, string>,
    cookies: {} as Record<string, string>,
    headers: {} as Record<string, string>,
  };

  for (const context of runtimeContexts) {
    if (!context.value_text) continue;

    if (context.source_location?.includes('cookie')) {
      summary.cookies[context.context_key] = context.value_text;
      continue;
    }

    if (context.source_location?.includes('header')) {
      summary.headers[context.context_key] = context.value_text;
      continue;
    }

    summary.values[context.context_key] = context.value_text;
  }

  return summary;
}

function buildVariableCandidateBindingLabel(candidate: RecordingVariableCandidate): string {
  switch (candidate.data_source) {
    case 'workflow_context':
      return `${candidate.json_path || candidate.source_location || 'request'} <- workflow_context.${candidate.runtime_context_key || candidate.name}`;
    case 'account_field':
      return `${candidate.json_path || candidate.source_location || 'request'} <- account.${candidate.account_field_name || candidate.name}`;
    case 'checklist':
      return `${candidate.json_path || candidate.source_location || 'request'} <- checklist.${candidate.checklist_id || candidate.name}`;
    case 'security_rule':
      return `${candidate.json_path || candidate.source_location || 'request'} <- security_rule.${candidate.security_rule_id || candidate.name}`;
    default:
      return `${candidate.json_path || candidate.source_location || 'request'} <- ${candidate.name}`;
  }
}

function rebuildWorkflowDraftArtifacts(
  draft: WorkflowDraft,
  steps: WorkflowDraftStep[],
  extractorCandidates: RecordingExtractorCandidate[],
  variableCandidates: RecordingVariableCandidate[]
): {
  summary: Record<string, any>;
  draft_payload: Record<string, any>;
} {
  const orderedSteps = [...steps].sort((a, b) => a.sequence - b.sequence);
  const workflowConfig = {
    ...((draft.draft_payload || {}).workflow || {}),
    name: draft.name.replace(/ Draft$/, ''),
    enable_extractor: extractorCandidates.length > 0,
  };

  return {
    summary: {
      ...(draft.summary || {}),
      step_count: orderedSteps.length,
      enabled_step_count: orderedSteps.filter(step => step.enabled).length,
      disabled_step_count: orderedSteps.filter(step => !step.enabled).length,
      variable_candidate_count: variableCandidates.length,
      extractor_candidate_count: extractorCandidates.length,
    },
    draft_payload: {
      ...(draft.draft_payload || {}),
      workflow: workflowConfig,
      steps: orderedSteps.map(step => ({
        sequence: step.sequence,
        method: step.method,
        path: step.path,
        enabled: step.enabled,
        step_name: step.request_template_payload?.name || step.summary?.step_name || `Step ${step.sequence}`,
        response_status: step.summary?.response_status || step.response_signature?.status || null,
        merged_event_sequences: step.summary?.merged_event_sequences || [step.sequence],
        merged_event_count: step.summary?.merged_event_count || 1,
        business_action: step.summary?.business_action || 'request',
        request_template: step.request_template_payload,
        field_hits: (step.summary?.field_hits || []).map((fieldName: string) => ({
          field_name: fieldName,
        })),
        extractor_candidates: extractorCandidates
          .filter(candidate => candidate.workflow_draft_step_id === step.id)
          .map(candidate => ({
            name: candidate.name,
            source: candidate.source,
            expression: candidate.expression,
            confidence: candidate.confidence,
            required: candidate.required,
          })),
        variable_injections: variableCandidates
          .filter(candidate => candidate.workflow_draft_step_id === step.id)
          .map(candidate => ({
            name: candidate.name,
            data_source: candidate.data_source,
            json_path: candidate.json_path,
            account_field_name: candidate.account_field_name,
            runtime_context_key: candidate.runtime_context_key,
            binding_label: buildVariableCandidateBindingLabel(candidate),
            confidence: candidate.confidence,
          })),
      })),
      variable_candidates: variableCandidates.map(candidate => ({
        name: candidate.name,
        data_source: candidate.data_source,
        json_path: candidate.json_path,
        account_field_name: candidate.account_field_name,
        runtime_context_key: candidate.runtime_context_key,
        source_location: candidate.source_location,
        checklist_id: candidate.checklist_id,
        security_rule_id: candidate.security_rule_id,
        step_variable_mappings: candidate.step_variable_mappings,
        advanced_config: candidate.advanced_config,
        confidence: candidate.confidence,
      })),
      extractor_candidates: extractorCandidates.map(candidate => ({
        name: candidate.name,
        source: candidate.source,
        expression: candidate.expression,
        confidence: candidate.confidence,
        required: candidate.required,
        value_preview: candidate.value_preview,
      })),
    },
  };
}

async function refreshWorkflowDraftMaterialization(db: DbProvider, draftId: string): Promise<WorkflowDraft> {
  const draft = await db.repos.workflowDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Workflow draft not found: ${draftId}`);
  }

  const [steps, extractorCandidates, variableCandidates] = await Promise.all([
    db.repos.workflowDraftSteps.findAll({ where: { workflow_draft_id: draft.id } as any }),
    db.repos.recordingExtractorCandidates.findAll({ where: { workflow_draft_id: draft.id } as any }),
    db.repos.recordingVariableCandidates.findAll({ where: { workflow_draft_id: draft.id } as any }),
  ]);

  const rebuilt = rebuildWorkflowDraftArtifacts(
    draft,
    steps,
    extractorCandidates,
    variableCandidates
  );
  const updated = await db.repos.workflowDrafts.update(draft.id, rebuilt as any);
  if (!updated) {
    throw new Error(`Failed to refresh workflow draft payload: ${draft.id}`);
  }

  return updated;
}

function rebuildTestRunDraftArtifacts(
  draft: TestRunDraft,
  publishLogs: DraftPublishLog[]
): {
  summary: Record<string, any>;
  draft_payload: Record<string, any>;
} {
  const payload = draft.draft_payload || {};
  const context = payload.context || {};
  const templatePayload = payload.template || {};
  const presetPayload = payload.preset || {};
  const variables = ensureArray(templatePayload.variables);
  const fieldCandidates = ensureArray(templatePayload.field_candidates);
  const assertionCandidates = ensureArray(templatePayload.assertion_candidates);
  const failurePatterns = ensureArray(templatePayload.failure_patterns);
  const responseSnapshot = templatePayload.response_snapshot || {};
  const templatePromotionIds = Array.from(new Set([
    ...publishLogs
      .filter(log => log.target_asset_type === 'api_template')
      .map(log => log.target_asset_id),
    ...ensureArray<string>(payload.published_assets?.api_template_ids),
  ]));
  const presetPromotionIds = Array.from(new Set([
    ...publishLogs
      .filter(log => log.target_asset_type === 'test_run_preset')
      .map(log => log.target_asset_id),
    draft.published_preset_id || '',
    ...ensureArray<string>(payload.published_assets?.test_run_preset_ids),
  ].filter(Boolean)));
  const testRunPromotionIds = Array.from(new Set([
    ...publishLogs
      .filter(log => log.target_asset_type === 'test_run')
      .map(log => log.target_asset_id),
    draft.published_test_run_id || '',
    ...ensureArray<string>(payload.published_assets?.test_run_ids),
  ].filter(Boolean)));
  const method = templatePayload.parsed_structure?.method || context.method || draft.summary?.method || 'GET';
  const path = templatePayload.parsed_structure?.path || context.path || draft.summary?.path || '/';

  return {
    summary: {
      ...(draft.summary || {}),
      method,
      path,
      environment_id: presetPayload.environment_id || context.environment_id || draft.summary?.environment_id,
      account_id: presetPayload.default_account_id || context.account_id || draft.summary?.account_id,
      response_status: responseSnapshot.status ?? draft.summary?.response_status ?? null,
      field_candidate_count: fieldCandidates.length,
      assertion_candidate_count: assertionCandidates.length,
      variable_suggestion_count: variables.length,
      failure_pattern_count: failurePatterns.length,
      published_template_count: templatePromotionIds.length,
      published_preset_count: presetPromotionIds.length,
      published_test_run_count: testRunPromotionIds.length,
      latest_published_template_id: templatePromotionIds[templatePromotionIds.length - 1],
      latest_published_preset_id: presetPromotionIds[presetPromotionIds.length - 1],
      latest_published_test_run_id: testRunPromotionIds[testRunPromotionIds.length - 1],
    },
    draft_payload: {
      ...payload,
      context: {
        ...context,
        method,
        path,
      },
      template: {
        ...templatePayload,
        name: templatePayload.name || draft.name.replace(/ Draft$/, ''),
        description: templatePayload.description || `Recorded from ${method} ${path}`,
        variables,
        field_candidates: fieldCandidates,
        assertion_candidates: assertionCandidates,
        failure_patterns: failurePatterns,
        failure_logic: templatePayload.failure_logic || 'OR',
        response_snapshot: responseSnapshot,
      },
      preset: {
        ...presetPayload,
        name: presetPayload.name || `${draft.name.replace(/ Draft$/, '')} Preset`,
        description: presetPayload.description || `Published from recording session ${draft.session_id}`,
        environment_id: presetPayload.environment_id || context.environment_id || draft.summary?.environment_id,
        default_account_id: presetPayload.default_account_id || context.account_id || draft.summary?.account_id,
        preset_config: {
          ...(presetPayload.preset_config || {}),
          source_recording_session_id: context.session_id || draft.session_id,
          source_event_id: context.source_event_id || draft.source_event_id,
          source_event_sequence: context.sequence || draft.sequence,
          recorded_response_status: responseSnapshot.status ?? draft.summary?.response_status ?? null,
        },
      },
      published_assets: {
        api_template_ids: templatePromotionIds,
        latest_api_template_id: templatePromotionIds[templatePromotionIds.length - 1],
        test_run_preset_ids: presetPromotionIds,
        latest_test_run_preset_id: presetPromotionIds[presetPromotionIds.length - 1],
        test_run_ids: testRunPromotionIds,
        latest_test_run_id: testRunPromotionIds[testRunPromotionIds.length - 1],
      },
    },
  };
}

async function refreshTestRunDraftMaterialization(db: DbProvider, draftId: string): Promise<TestRunDraft> {
  const draft = await db.repos.testRunDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Test run draft not found: ${draftId}`);
  }

  const publishLogs = await db.repos.draftPublishLogs.findAll({ where: { source_draft_id: draft.id } as any });
  const rebuilt = rebuildTestRunDraftArtifacts(draft, publishLogs);
  const updated = await db.repos.testRunDrafts.update(draft.id, rebuilt as any);
  if (!updated) {
    throw new Error(`Failed to refresh test run draft payload: ${draft.id}`);
  }

  return updated;
}

export async function createRecordingSession(db: DbProvider, data: {
  name: string;
  mode: 'workflow' | 'api';
  source_tool?: string;
  environment_id?: string;
  account_id?: string;
  role?: string;
  target_fields?: IncomingRecordingFieldTarget[];
}): Promise<RecordingSession> {
  if (!data.name?.trim()) {
    throw new Error('Recording session name is required');
  }

  if (!['workflow', 'api'].includes(data.mode)) {
    throw new Error('Recording session mode must be workflow or api');
  }

  if (data.environment_id) {
    const environment = await db.repos.environments.findById(data.environment_id);
    if (!environment) {
      throw new Error(`Environment not found: ${data.environment_id}`);
    }
  }

  if (data.account_id) {
    const account = await db.repos.accounts.findById(data.account_id);
    if (!account) {
      throw new Error(`Account not found: ${data.account_id}`);
    }
  }

  const session = await db.repos.recordingSessions.create({
    name: data.name.trim(),
    mode: data.mode,
    status: 'recording',
    source_tool: data.source_tool,
    environment_id: data.environment_id,
    account_id: data.account_id,
    role: data.role,
    target_fields: [],
    event_count: 0,
    field_hit_count: 0,
    runtime_context_count: 0,
    generated_result_count: 0,
    published_result_count: 0,
    summary: {
      created_from: data.source_tool || 'manual',
      last_ingest_at: null,
      last_generated_at: null,
    },
    started_at: nowIso(),
    finished_at: undefined,
  } as any);

  const normalizedTargets = normalizeRecordingFieldTargets(session.id, data.target_fields || []);
  const createdTargets: RecordingFieldTarget[] = [];

  for (const target of normalizedTargets) {
    const created = await db.repos.recordingFieldTargets.create({
      session_id: session.id,
      name: target.name,
      aliases: target.aliases,
      from_sources: target.from_sources,
      bind_to_account_field: target.bind_to_account_field,
      category: target.category,
    } as any);
    createdTargets.push(created);
  }

  const updated = await db.repos.recordingSessions.update(session.id, {
    target_fields: createdTargets,
  } as any);

  if (!updated) {
    throw new Error(`Failed to finalize recording session: ${session.id}`);
  }

  incrementRecordingSessionsCreated({
    session_id: session.id,
    mode: session.mode,
    source_tool: session.source_tool,
  });

  await appendRecordingAuditLog(db, {
    session_id: session.id,
    action: 'recording_session_created',
    actor: data.source_tool || 'recording_api',
    target_type: 'recording_session',
    target_id: session.id,
    status: 'success',
    message: `Created recording session ${session.name}`,
    details: {
      mode: session.mode,
      environment_id: session.environment_id,
      account_id: session.account_id,
      target_field_count: createdTargets.length,
    },
  });

  return {
    ...updated,
    target_fields: createdTargets,
  };
}

export async function listRecordingSessions(db: DbProvider): Promise<RecordingSession[]> {
  const sessions = await db.repos.recordingSessions.findAll();
  return sessions;
}

export async function getRecordingSessionDetail(db: DbProvider, sessionId: string): Promise<any> {
  const artifacts = await loadSessionArtifacts(db, sessionId);
  const fieldHitsByEvent = groupByEventId(artifacts.fieldHits);
  const contextsByEvent = groupByEventId(artifacts.runtimeContexts);
  const stepMap = new Map(artifacts.workflowDraftSteps.map(step => [step.source_event_id, step]));
  const extractorCandidates = await db.repos.recordingExtractorCandidates.findAll();
  const variableCandidates = await db.repos.recordingVariableCandidates.findAll();
  const draftPublishLogs = (await db.repos.draftPublishLogs.findAll())
    .filter(log => log.draft_type === 'workflow' || log.draft_type === 'test_run');
  const draftIds = new Set([
    ...artifacts.workflowDrafts.map(item => item.id),
    ...artifacts.testRunDrafts.map(item => item.id),
  ]);
  const relevantDraftPublishLogs = draftPublishLogs.filter(log => draftIds.has(log.source_draft_id));
  const publishLogsByDraftId = groupPublishLogsByDraftId(relevantDraftPublishLogs);
  const publishedPresetCount = relevantDraftPublishLogs.filter(log => log.target_asset_type === 'test_run_preset').length;
  const publishedTemplateCount = relevantDraftPublishLogs.filter(log => log.target_asset_type === 'api_template').length;
  const publishedTestRunCount = relevantDraftPublishLogs.filter(log => log.target_asset_type === 'test_run').length;
  const accountApplyLogs = await listRecordingAccountApplyLogs(db, { session_id: sessionId });

  return {
    session: artifacts.session,
    runtime_context_summary: buildRuntimeContextSummary(artifacts.runtimeContexts),
    account_linkage: artifacts.session.summary?.account_linkage || null,
    account_apply_logs: accountApplyLogs,
    targets: artifacts.targets,
    events: artifacts.events.map(event => ({
      ...event,
      field_hits: fieldHitsByEvent.get(event.id) || [],
      runtime_contexts: contextsByEvent.get(event.id) || [],
    })),
    field_hits: artifacts.fieldHits,
    runtime_contexts: artifacts.runtimeContexts,
    workflow_drafts: artifacts.workflowDrafts.map(draft => ({
      ...draft,
      steps: artifacts.workflowDraftSteps
        .filter(step => step.workflow_draft_id === draft.id)
        .sort((a, b) => a.sequence - b.sequence),
      extractor_candidates: extractorCandidates
        .filter(item => item.workflow_draft_id === draft.id)
        .sort((a, b) => (a.step_sequence || 0) - (b.step_sequence || 0)),
      variable_candidates: variableCandidates
        .filter(item => item.workflow_draft_id === draft.id)
        .sort((a, b) => (a.step_variable_mappings?.[0]?.step_order || 0) - (b.step_variable_mappings?.[0]?.step_order || 0)),
    })),
    workflow_draft_steps: artifacts.workflowDraftSteps,
    test_run_drafts: artifacts.testRunDrafts.map(draft => ({
      ...draft,
      ...rebuildTestRunDraftArtifacts(draft, publishLogsByDraftId.get(draft.id) || []),
    })),
    test_run_presets: artifacts.presets,
    draft_publish_logs: relevantDraftPublishLogs,
    generated: {
      workflow_draft_count: artifacts.workflowDrafts.length,
      test_run_draft_count: artifacts.testRunDrafts.length,
      published_preset_count: artifacts.presets.length,
      published_template_count: publishedTemplateCount,
      published_test_run_count: publishedTestRunCount,
      promoted_asset_count: relevantDraftPublishLogs.length,
      step_map_size: stepMap.size,
    },
  };
}

export async function getRecordingSessionEvents(
  db: DbProvider,
  sessionId: string,
  params?: { limit?: number; offset?: number }
): Promise<{
  session: RecordingSession;
  events: Array<RecordingEvent & {
    field_hits: RecordingFieldHit[];
    runtime_contexts: RecordingRuntimeContext[];
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
  };
}> {
  const artifacts = await loadSessionArtifacts(db, sessionId);
  const fieldHitsByEvent = groupByEventId(artifacts.fieldHits);
  const contextsByEvent = groupByEventId(artifacts.runtimeContexts);
  const requestedLimit = Number(params?.limit);
  const requestedOffset = Number(params?.offset);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.min(200, requestedLimit))
    : 50;
  const offset = Number.isFinite(requestedOffset) && requestedOffset >= 0
    ? requestedOffset
    : 0;
  const pageEvents = artifacts.events.slice(offset, offset + limit);

  return {
    session: artifacts.session,
    events: pageEvents.map(event => ({
      ...event,
      field_hits: fieldHitsByEvent.get(event.id) || [],
      runtime_contexts: contextsByEvent.get(event.id) || [],
    })),
    pagination: {
      total: artifacts.events.length,
      limit,
      offset,
    },
  };
}

export async function listTestRunDrafts(db: DbProvider): Promise<TestRunDraft[]> {
  const [drafts, draftPublishLogs] = await Promise.all([
    db.repos.testRunDrafts.findAll(),
    db.repos.draftPublishLogs.findAll(),
  ]);
  const publishLogsByDraftId = groupPublishLogsByDraftId(
    draftPublishLogs.filter(log => log.draft_type === 'test_run')
  );

  return [...drafts]
    .map(draft => ({
      ...draft,
      ...rebuildTestRunDraftArtifacts(draft, publishLogsByDraftId.get(draft.id) || []),
    }))
    .sort((a, b) => {
      const aTime = new Date(a.updated_at).getTime();
      const bTime = new Date(b.updated_at).getTime();
      return bTime - aTime;
    });
}

export async function ingestRecordingEventsBatch(db: DbProvider, sessionId: string, events: IncomingRecordingEvent[]): Promise<{
  session: RecordingSession;
  inserted: number;
  skipped: number;
  accepted: number;
  deduplicated: number;
  field_hits_created: number;
  runtime_contexts_created: number;
}> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  if (session.status === 'published') {
    throw new Error(`Recording session ${session.name} has already been published and cannot accept new events`);
  }

  const targets = await db.repos.recordingFieldTargets.findAll({ where: { session_id: sessionId } as any });
  const dictionary = new FieldDictionary(db);
  await dictionary.load('global');

  const processed = await processRecordingEventsBatch(db, {
    sessionId,
    events,
    targets,
    dictionary,
  });

  const updatedSession = await recomputeSessionMetrics(db, sessionId);
  const mergedSummary = {
    ...(updatedSession.summary || {}),
    last_ingest_at: nowIso(),
    last_ingest_result: {
      inserted: processed.inserted,
      skipped: processed.skipped,
      accepted: processed.accepted,
      deduplicated: processed.deduplicated,
      field_hits_created: processed.fieldHitsCreated,
      runtime_contexts_created: processed.runtimeContextsCreated,
    },
  };

  const finalSession = await db.repos.recordingSessions.update(sessionId, {
    summary: mergedSummary,
  } as any);

  if (!finalSession) {
    throw new Error(`Failed to update recording session summary: ${sessionId}`);
  }

  incrementRecordingEventsIngested(processed.inserted, processed.skipped);

  return {
    session: finalSession,
    inserted: processed.inserted,
    skipped: processed.skipped,
    accepted: processed.accepted,
    deduplicated: processed.deduplicated,
    field_hits_created: processed.fieldHitsCreated,
    runtime_contexts_created: processed.runtimeContextsCreated,
  };
}

export async function regenerateRecordingSessionArtifacts(db: DbProvider, sessionId: string): Promise<any> {
  const startedAt = Date.now();
  const artifacts = await loadSessionArtifacts(db, sessionId);
  const draftPublishLogs = await db.repos.draftPublishLogs.findAll();
  const publishLogsByDraftId = groupPublishLogsByDraftId(draftPublishLogs);
  const retainedTestRunDraftsBySourceEventId = new Map<string, TestRunDraft>();

  for (const draft of artifacts.testRunDrafts) {
    if (!draft.source_event_id) continue;
    const hasPromotions = (publishLogsByDraftId.get(draft.id) || []).length > 0;
    if (draft.status === 'published' || hasPromotions) {
      retainedTestRunDraftsBySourceEventId.set(draft.source_event_id, draft);
    }
  }

  try {
    if (artifacts.session.status === 'published') {
      return getRecordingSessionDetail(db, sessionId);
    }

    if (artifacts.events.length === 0) {
      throw new Error(`Recording session "${artifacts.session.name}" does not have any events yet`);
    }

    await clearGeneratedDraftArtifacts(db, sessionId);
    await db.repos.recordingSessions.update(sessionId, {
      status: 'processing',
      summary: {
        ...(artifacts.session.summary || {}),
        processing_started_at: nowIso(),
      },
    } as any);

    const dictionary = new FieldDictionary(db);
    await dictionary.load('global');

    if (artifacts.session.mode === 'workflow') {
      const generated = generateWorkflowDraftArtifacts({
        session: artifacts.session,
        events: artifacts.events,
        fieldHits: artifacts.fieldHits,
        runtimeContexts: artifacts.runtimeContexts,
        dictionary,
      });

      if (!generated) {
        throw new Error(`Failed to generate workflow draft for session ${artifacts.session.name}`);
      }

      const createdDraft = await db.repos.workflowDrafts.create(generated.draft as any);
      const eventToStep = new Map<string, WorkflowDraftStep>();

      for (const step of generated.steps) {
        const createdStep = await db.repos.workflowDraftSteps.create({
          ...step,
          workflow_draft_id: createdDraft.id,
        } as any);
        eventToStep.set(createdStep.source_event_id, createdStep);
      }

      for (const candidate of generated.extractorCandidates) {
        const step = candidate.source_event_id ? eventToStep.get(candidate.source_event_id) : null;
        await db.repos.recordingExtractorCandidates.create({
          ...candidate,
          workflow_draft_id: createdDraft.id,
          workflow_draft_step_id: step?.id,
        } as any);
      }

      for (const candidate of generated.variableCandidates) {
        const step = candidate.source_event_id ? eventToStep.get(candidate.source_event_id) : null;
        await db.repos.recordingVariableCandidates.create({
          ...candidate,
          workflow_draft_id: createdDraft.id,
          workflow_draft_step_id: step?.id,
        } as any);
      }

      await refreshWorkflowDraftMaterialization(db, createdDraft.id);
    } else {
      const generated = generateApiDraftArtifacts({
        session: artifacts.session,
        events: artifacts.events,
        fieldHits: artifacts.fieldHits,
      });

      for (const draft of generated.drafts) {
        const retainedDraft = draft.source_event_id
          ? retainedTestRunDraftsBySourceEventId.get(draft.source_event_id)
          : undefined;

        if (retainedDraft) {
          await db.repos.testRunDrafts.update(retainedDraft.id, {
            name: draft.name,
            sequence: draft.sequence,
            source_event_id: draft.source_event_id,
            summary: draft.summary,
            draft_payload: draft.draft_payload,
          } as any);
          await refreshTestRunDraftMaterialization(db, retainedDraft.id);
          continue;
        }

        await db.repos.testRunDrafts.create(draft as any);
      }
    }

    const refreshed = await recomputeSessionMetrics(db, sessionId);
    const finalSession = await db.repos.recordingSessions.update(sessionId, {
      status: refreshed.status === 'published' ? 'published' : 'finished',
      finished_at: refreshed.finished_at || nowIso(),
      summary: {
        ...(refreshed.summary || {}),
        last_generated_at: nowIso(),
        last_generation_mode: artifacts.session.mode,
        completed_at: nowIso(),
      },
    } as any);

    if (finalSession && finalSession.status === 'finished') {
      await db.repos.recordingSessions.update(sessionId, {
        status: 'completed',
      } as any);
    }
    const resolvedStatus = finalSession?.status === 'finished' ? 'completed' : (finalSession?.status || 'completed');

    recordDraftGeneration(Date.now() - startedAt, {
      session_id: sessionId,
      mode: artifacts.session.mode,
      status: resolvedStatus,
    });

    await appendRecordingAuditLog(db, {
      session_id: sessionId,
      action: 'recording_generation_completed',
      actor: 'recording_service',
      target_type: 'recording_session',
      target_id: sessionId,
      status: 'success',
      message: `Generated recording artifacts for ${artifacts.session.name}`,
      details: {
        mode: artifacts.session.mode,
        status: resolvedStatus,
      },
    });

    return getRecordingSessionDetail(db, finalSession?.id || sessionId);
  } catch (error: any) {
    await db.repos.recordingSessions.update(sessionId, {
      status: 'failed',
      summary: {
        ...(artifacts.session.summary || {}),
        last_generation_error: error.message,
        last_generation_failed_at: nowIso(),
      },
    } as any);

    recordRecordingGenerationFailure({
      session_id: sessionId,
      mode: artifacts.session.mode,
      error: error.message,
    });

    await createRecordingDeadLetter(db, {
      session_id: sessionId,
      failure_stage: 'draft_generation',
      error_message: error.message,
      batch_size: artifacts.events.length,
      payload: {
        session_id: sessionId,
        mode: artifacts.session.mode,
        retry_action: 'regenerate_recording_session_artifacts',
      },
    });

    await appendRecordingAuditLog(db, {
      session_id: sessionId,
      action: 'recording_generation_failed',
      actor: 'recording_service',
      target_type: 'recording_session',
      target_id: sessionId,
      status: 'failed',
      message: error.message,
      details: {
        mode: artifacts.session.mode,
        event_count: artifacts.events.length,
      },
    });
    throw error;
  }
}

export async function finishRecordingSession(db: DbProvider, sessionId: string): Promise<any> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  if (session.status === 'processing') {
    return getRecordingSessionDetail(db, sessionId);
  }

  if (['completed', 'finished', 'published'].includes(session.status) && session.generated_result_count > 0) {
    return getRecordingSessionDetail(db, sessionId);
  }

  await db.repos.recordingSessions.update(sessionId, {
    status: session.status === 'published' ? 'published' : 'processing',
    finished_at: nowIso(),
    summary: {
      ...(session.summary || {}),
      processing_started_at: nowIso(),
    },
  } as any);

  recordRecordingFinish({
    session_id: sessionId,
    mode: session.mode,
  });

  await appendRecordingAuditLog(db, {
    session_id: sessionId,
    action: 'recording_session_finished',
    actor: 'recording_api',
    target_type: 'recording_session',
    target_id: sessionId,
    status: 'success',
    message: `Finish requested for ${session.name}`,
    details: {
      mode: session.mode,
      generated_result_count: session.generated_result_count,
    },
  });

  return regenerateRecordingSessionArtifacts(db, sessionId);
}

export async function updateWorkflowDraft(db: DbProvider, draftId: string, params?: {
  name?: string;
  steps?: Array<{
    id: string;
    sequence?: number;
    enabled?: boolean;
    name?: string;
    description?: string;
  }>;
  extractor_candidates?: Array<{
    workflow_draft_step_id: string;
    name: string;
    source: string;
    expression: string;
    required?: boolean;
    transform?: Record<string, any>;
    value_preview?: string;
    confidence?: number;
  }>;
  variable_candidates?: Array<{
    workflow_draft_step_id: string;
    name: string;
    data_source: string;
    source_location: string;
    json_path?: string;
    checklist_id?: string;
    security_rule_id?: string;
    account_field_name?: string;
    runtime_context_key?: string;
    step_variable_mappings?: any[];
    advanced_config?: Record<string, any>;
    role?: string;
    confidence?: number;
  }>;
}): Promise<any> {
  const draft = await db.repos.workflowDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Workflow draft not found: ${draftId}`);
  }

  if (draft.status === 'published') {
    throw new Error(`Workflow draft ${draft.name} has already been published and cannot be edited`);
  }

  const session = await db.repos.recordingSessions.findById(draft.session_id);
  if (!session) {
    throw new Error(`Recording session not found for draft ${draftId}`);
  }

  const [existingSteps, existingExtractors, existingVariables] = await Promise.all([
    db.repos.workflowDraftSteps.findAll({ where: { workflow_draft_id: draft.id } as any }),
    db.repos.recordingExtractorCandidates.findAll({ where: { workflow_draft_id: draft.id } as any }),
    db.repos.recordingVariableCandidates.findAll({ where: { workflow_draft_id: draft.id } as any }),
  ]);

  const stepById = new Map(existingSteps.map(step => [step.id, step]));
  const requestedSteps = (params?.steps && params.steps.length > 0)
    ? [...params.steps]
    : existingSteps.map(step => ({
      id: step.id,
      sequence: step.sequence,
      enabled: step.enabled,
      name: step.request_template_payload?.name || step.summary?.step_name || `${draft.name} Step ${step.sequence}`,
      description: step.request_template_payload?.description,
    }));

  if (requestedSteps.length === 0) {
    throw new Error(`Workflow draft ${draft.name} does not have any editable steps`);
  }

  const normalizedSteps = requestedSteps
    .map((step, index) => ({
      ...step,
      sequence: Number.isFinite(Number(step.sequence)) ? Number(step.sequence) : index + 1,
    }))
    .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
    .map((step, index) => ({
      ...step,
      sequence: index + 1,
    }));

  for (const step of normalizedSteps) {
    const existing = stepById.get(step.id);
    if (!existing) {
      throw new Error(`Workflow draft step not found in draft ${draft.name}: ${step.id}`);
    }

    const nextTemplatePayload = {
      ...(existing.request_template_payload || {}),
      name: step.name?.trim() || existing.request_template_payload?.name || existing.summary?.step_name || `${draft.name} Step ${step.sequence}`,
      description: step.description?.trim() || existing.request_template_payload?.description,
    };
    const nextSummary = {
      ...(existing.summary || {}),
      step_name: nextTemplatePayload.name,
      sequence: step.sequence,
    };

    await db.repos.workflowDraftSteps.update(existing.id, {
      sequence: step.sequence,
      enabled: step.enabled ?? existing.enabled,
      summary: nextSummary,
      request_template_payload: nextTemplatePayload,
    } as any);
  }

  const refreshedSteps = await db.repos.workflowDraftSteps.findAll({ where: { workflow_draft_id: draft.id } as any });
  const refreshedStepById = new Map(refreshedSteps.map(step => [step.id, step]));

  const extractorInputs = params?.extractor_candidates ?? existingExtractors.map(candidate => ({
    workflow_draft_step_id: candidate.workflow_draft_step_id || '',
    name: candidate.name,
    source: candidate.source,
    expression: candidate.expression,
    required: candidate.required,
    transform: candidate.transform,
    value_preview: candidate.value_preview,
    confidence: candidate.confidence,
  }));

  for (const extractor of existingExtractors) {
    await db.repos.recordingExtractorCandidates.delete(extractor.id);
  }

  for (const extractor of extractorInputs) {
    const step = refreshedStepById.get(extractor.workflow_draft_step_id);
    if (!step) {
      throw new Error(`Extractor candidate step not found: ${extractor.workflow_draft_step_id}`);
    }

    await db.repos.recordingExtractorCandidates.create({
      workflow_draft_id: draft.id,
      workflow_draft_step_id: step.id,
      session_id: draft.session_id,
      source_event_id: step.source_event_id,
      step_sequence: step.sequence,
      name: extractor.name.trim(),
      source: extractor.source.trim(),
      expression: extractor.expression.trim(),
      transform: extractor.transform,
      required: !!extractor.required,
      confidence: extractor.confidence ?? 0.9,
      value_preview: extractor.value_preview,
    } as any);
  }

  const variableInputs = params?.variable_candidates ?? existingVariables.map(candidate => ({
    workflow_draft_step_id: candidate.workflow_draft_step_id || '',
    name: candidate.name,
    data_source: candidate.data_source,
    source_location: candidate.source_location,
    json_path: candidate.json_path,
    checklist_id: candidate.checklist_id,
    security_rule_id: candidate.security_rule_id,
    account_field_name: candidate.account_field_name,
    runtime_context_key: candidate.runtime_context_key,
    step_variable_mappings: candidate.step_variable_mappings,
    advanced_config: candidate.advanced_config,
    role: candidate.role,
    confidence: candidate.confidence,
  }));

  for (const variable of existingVariables) {
    await db.repos.recordingVariableCandidates.delete(variable.id);
  }

  for (const variable of variableInputs) {
    const step = refreshedStepById.get(variable.workflow_draft_step_id);
    if (!step) {
      throw new Error(`Variable candidate step not found: ${variable.workflow_draft_step_id}`);
    }

    if (variable.data_source === 'checklist' && variable.checklist_id) {
      const checklist = await db.repos.checklists.findById(variable.checklist_id);
      if (!checklist) throw new Error(`Checklist not found: ${variable.checklist_id}`);
    }

    if (variable.data_source === 'security_rule' && variable.security_rule_id) {
      const rule = await db.repos.securityRules.findById(variable.security_rule_id);
      if (!rule) throw new Error(`Security rule not found: ${variable.security_rule_id}`);
    }

    const mappings = ensureArray(variable.step_variable_mappings);
    const normalizedMappings = (mappings.length > 0 ? mappings : [{
      step_order: step.sequence,
      json_path: variable.json_path,
    }]).map(mapping => ({
      ...mapping,
      step_order: step.sequence,
      json_path: variable.json_path ?? mapping.json_path,
    }));

    await db.repos.recordingVariableCandidates.create({
      workflow_draft_id: draft.id,
      workflow_draft_step_id: step.id,
      session_id: draft.session_id,
      source_event_id: step.source_event_id,
      name: variable.name.trim(),
      data_source: variable.data_source,
      source_location: variable.source_location,
      json_path: variable.json_path,
      checklist_id: variable.checklist_id,
      security_rule_id: variable.security_rule_id,
      account_field_name: variable.account_field_name,
      runtime_context_key: variable.runtime_context_key,
      step_variable_mappings: normalizedMappings,
      advanced_config: variable.advanced_config || {},
      role: variable.role,
      confidence: variable.confidence ?? 0.9,
    } as any);
  }

  const updatedDraft = await db.repos.workflowDrafts.update(draft.id, {
    name: params?.name?.trim() || draft.name,
  } as any);
  if (!updatedDraft) {
    throw new Error(`Failed to update workflow draft ${draft.name}`);
  }

  await refreshWorkflowDraftMaterialization(db, draft.id);
  await recomputeSessionMetrics(db, session.id);
  return getRecordingSessionDetail(db, session.id);
}

async function createApiTemplateAssetFromTestRunDraft(
  db: DbProvider,
  draft: TestRunDraft,
  session: RecordingSession,
  params?: {
    template_name?: string;
    template_description?: string;
  }
): Promise<any> {
  const payload = draft.draft_payload || {};
  const templatePayload = payload.template || {};

  if (!templatePayload.raw_request) {
    throw new Error(`Test run draft ${draft.name} does not have a request template to publish`);
  }

  return db.repos.apiTemplates.create({
    name: params?.template_name || templatePayload.name || draft.name.replace(/ Draft$/, ''),
    group_name: 'Recorded API',
    description: params?.template_description || templatePayload.description || `Published from recording session ${session.name}`,
    raw_request: templatePayload.raw_request,
    parsed_structure: templatePayload.parsed_structure || {},
    variables: templatePayload.variables || [],
    failure_patterns: templatePayload.failure_patterns || [],
    failure_logic: templatePayload.failure_logic || 'OR',
    is_active: true,
    account_binding_strategy: 'per_account',
    attacker_account_id: undefined,
    enable_baseline: false,
    baseline_config: {},
    advanced_config: {
      ...(templatePayload.advanced_config || {}),
      recording_session_id: session.id,
      source_test_run_draft_id: draft.id,
    },
    rate_limit_override: undefined,
    source_recording_session_id: session.id,
  } as any);
}

export async function updateTestRunDraft(db: DbProvider, draftId: string, params?: {
  name?: string;
  template?: {
    name?: string;
    description?: string;
    raw_request?: string;
    parsed_structure?: Record<string, any>;
    variables?: Array<Record<string, any>>;
    failure_patterns?: Array<Record<string, any>>;
    failure_logic?: 'OR' | 'AND';
    field_candidates?: Array<Record<string, any>>;
    assertion_candidates?: Array<Record<string, any>>;
    response_snapshot?: Record<string, any>;
  };
  preset?: {
    name?: string;
    description?: string;
    environment_id?: string;
    default_account_id?: string;
    preset_config?: Record<string, any>;
  };
}): Promise<any> {
  const draft = await db.repos.testRunDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Test run draft not found: ${draftId}`);
  }

  if (draft.status === 'published') {
    throw new Error(`Published test run draft ${draft.name} is read-only`);
  }

  const session = await db.repos.recordingSessions.findById(draft.session_id);
  if (!session) {
    throw new Error(`Recording session not found for draft ${draftId}`);
  }

  const nextEnvironmentId = params?.preset?.environment_id;
  if (nextEnvironmentId) {
    const environment = await db.repos.environments.findById(nextEnvironmentId);
    if (!environment) {
      throw new Error(`Environment not found: ${nextEnvironmentId}`);
    }
  }

  const nextAccountId = params?.preset?.default_account_id;
  if (nextAccountId) {
    const account = await db.repos.accounts.findById(nextAccountId);
    if (!account) {
      throw new Error(`Account not found: ${nextAccountId}`);
    }
  }

  const payload = draft.draft_payload || {};
  const nextPayload = {
    ...payload,
    template: {
      ...(payload.template || {}),
      ...(params?.template || {}),
      variables: params?.template?.variables
        ? ensureArray(params.template.variables)
        : ensureArray((payload.template || {}).variables),
      failure_patterns: params?.template?.failure_patterns
        ? ensureArray(params.template.failure_patterns)
        : ensureArray((payload.template || {}).failure_patterns),
      field_candidates: params?.template?.field_candidates
        ? ensureArray(params.template.field_candidates)
        : ensureArray((payload.template || {}).field_candidates),
      assertion_candidates: params?.template?.assertion_candidates
        ? ensureArray(params.template.assertion_candidates)
        : ensureArray((payload.template || {}).assertion_candidates),
    },
    preset: {
      ...(payload.preset || {}),
      ...(params?.preset || {}),
      preset_config: {
        ...((payload.preset || {}).preset_config || {}),
        ...(params?.preset?.preset_config || {}),
      },
    },
  };

  const updatedDraft = await db.repos.testRunDrafts.update(draft.id, {
    name: params?.name?.trim() || draft.name,
    status: 'preconfigured',
    draft_payload: nextPayload,
  } as any);
  if (!updatedDraft) {
    throw new Error(`Failed to update test run draft ${draft.name}`);
  }

  await refreshTestRunDraftMaterialization(db, draft.id);
  await recomputeSessionMetrics(db, session.id);
  return getRecordingSessionDetail(db, session.id);
}

export async function createApiTemplateFromTestRunDraft(db: DbProvider, draftId: string, params?: {
  template_name?: string;
  published_by?: string;
}): Promise<any> {
  const draft = await db.repos.testRunDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Test run draft not found: ${draftId}`);
  }

  const session = await db.repos.recordingSessions.findById(draft.session_id);
  if (!session) {
    throw new Error(`Recording session not found for draft ${draftId}`);
  }

  const template = await createApiTemplateAssetFromTestRunDraft(db, draft, session, {
    template_name: params?.template_name,
  });

  await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    source_recording_session_id: session.id,
    target_asset_type: 'api_template',
    target_asset_id: template.id,
    published_by: params?.published_by,
  }) as any);

  await refreshTestRunDraftMaterialization(db, draft.id);
  await recomputeSessionMetrics(db, session.id);
  incrementPromotionSuccess({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    target_asset_id: template.id,
    session_id: session.id,
  });

  await appendRecordingAuditLog(db, {
    session_id: session.id,
    action: 'recording_api_template_published',
    actor: params?.published_by,
    target_type: 'api_template',
    target_id: template.id,
    status: 'success',
    message: `Published API template from draft ${draft.name}`,
    details: {
      source_draft_id: draft.id,
      source_recording_session_id: session.id,
    },
  });

  return {
    template,
    published_from_draft_id: draft.id,
  };
}

export async function promoteTestRunDraftToTestRun(db: DbProvider, draftId: string, params?: {
  test_run_name?: string;
  published_by?: string;
}): Promise<any> {
  const draft = await db.repos.testRunDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Test run draft not found: ${draftId}`);
  }

  const session = await db.repos.recordingSessions.findById(draft.session_id);
  if (!session) {
    throw new Error(`Recording session not found for draft ${draftId}`);
  }

  const existingLogs = await db.repos.draftPublishLogs.findAll({ where: { source_draft_id: draft.id } as any });
  const existingRunId = draft.published_test_run_id || getLatestPublishTargetId(existingLogs, 'test_run');
  if (existingRunId) {
    const existingRun = await db.repos.testRuns.findById(existingRunId);
    if (existingRun) {
      const existingTemplateId = getLatestPublishTargetId(existingLogs, 'api_template');
      const existingTemplate = existingTemplateId
        ? await db.repos.apiTemplates.findById(existingTemplateId)
        : null;

      return {
        template: existingTemplate,
        test_run: existingRun,
        published_from_draft_id: draft.id,
        reused_existing: true,
      };
    }
  }

  const payload = draft.draft_payload || {};
  const context = payload.context || {};
  const templatePayload = payload.template || {};
  const presetPayload = payload.preset || {};
  const template = await createApiTemplateAssetFromTestRunDraft(db, draft, session, {
    template_name: templatePayload.name,
    template_description: templatePayload.description,
  });

  await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    source_recording_session_id: session.id,
    target_asset_type: 'api_template',
    target_asset_id: template.id,
    published_by: params?.published_by,
  }) as any);

  const defaultAccountId = presetPayload.default_account_id || context.account_id || session.account_id;
  const accountIds = defaultAccountId ? [defaultAccountId] : [];
  const environmentId = presetPayload.environment_id || context.environment_id || session.environment_id;

  const testRun = await db.repos.testRuns.create({
    name: params?.test_run_name?.trim() || presetPayload.name || templatePayload.name || draft.name.replace(/ Draft$/, ''),
    status: 'pending',
    execution_type: 'template',
    trigger_type: 'recording_promotion',
    rule_ids: [],
    template_ids: [template.id],
    account_ids: accountIds,
    environment_id: environmentId,
    workflow_id: undefined,
    execution_params: {
      source: 'recording_promotion',
      recording_promotion: {
        source_recording_session_id: session.id,
        source_draft_id: draft.id,
        source_event_id: context.source_event_id || draft.source_event_id,
        source_event_sequence: context.sequence || draft.sequence,
        created_from: 'test_run_draft',
        template_id: template.id,
      },
      promoted_template: {
        id: template.id,
        name: template.name,
      },
    },
    source_recording_session_id: session.id,
    progress: { total: 0, completed: 0, findings: 0 },
    progress_percent: 0,
  } as any);

  await db.repos.testRunDrafts.update(draft.id, {
    status: 'published',
    published_test_run_id: testRun.id,
  } as any);

  await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    source_recording_session_id: session.id,
    target_asset_type: 'test_run',
    target_asset_id: testRun.id,
    published_by: params?.published_by,
  }) as any);

  await refreshTestRunDraftMaterialization(db, draft.id);
  await recomputeSessionMetrics(db, session.id);
  incrementPromotionSuccess({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    target_asset_id: testRun.id,
    session_id: session.id,
  });

  await appendRecordingAuditLog(db, {
    session_id: session.id,
    action: 'recording_test_run_promoted',
    actor: params?.published_by,
    target_type: 'test_run',
    target_id: testRun.id,
    status: 'success',
    message: `Promoted formal test run from draft ${draft.name}`,
    details: {
      source_draft_id: draft.id,
      template_id: template.id,
    },
  });

  return {
    template,
    test_run: testRun,
    published_from_draft_id: draft.id,
  };
}

export async function publishWorkflowDraft(db: DbProvider, draftId: string, params?: {
  workflow_name?: string;
  published_by?: string;
}): Promise<any> {
  const draft = await db.repos.workflowDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Workflow draft not found: ${draftId}`);
  }

  const session = await db.repos.recordingSessions.findById(draft.session_id);
  if (!session) {
    throw new Error(`Recording session not found for draft ${draftId}`);
  }

  const draftSteps = await db.repos.workflowDraftSteps.findAll({ where: { workflow_draft_id: draft.id } as any });
  const variableCandidates = await db.repos.recordingVariableCandidates.findAll({ where: { workflow_draft_id: draft.id } as any });
  const extractorCandidates = await db.repos.recordingExtractorCandidates.findAll({ where: { workflow_draft_id: draft.id } as any });
  if (draftSteps.length === 0) {
    throw new Error(`Workflow draft ${draft.name} does not have any steps to publish`);
  }

  const enabledDraftSteps = [...draftSteps]
    .filter(step => step.enabled)
    .sort((a, b) => a.sequence - b.sequence);
  if (enabledDraftSteps.length === 0) {
    throw new Error(`Workflow draft ${draft.name} does not have any enabled steps to publish`);
  }

  const publishedStepOrderBySequence = new Map<number, number>(
    enabledDraftSteps.map((step, index) => [step.sequence, index + 1])
  );
  const enabledStepById = new Map(enabledDraftSteps.map(step => [step.id, step]));

  const payload = draft.draft_payload || {};
  const workflowPayload = payload.workflow || {};

  const workflow = await db.repos.workflows.create({
    name: params?.workflow_name || workflowPayload.name || draft.name.replace(/ Draft$/, ''),
    description: workflowPayload.description || `Published from recording session ${session.name}`,
    is_active: true,
    assertion_strategy: workflowPayload.assertion_strategy || 'any_step_pass',
    critical_step_orders: [],
    account_binding_strategy: 'per_account',
    attacker_account_id: undefined,
    enable_baseline: false,
    baseline_config: {},
    enable_extractor: extractorCandidates.length > 0,
    enable_session_jar: !!workflowPayload.enable_session_jar,
    session_jar_config: workflowPayload.session_jar_config || { cookie_mode: true, header_keys: [], body_json_paths: [] },
    workflow_type: 'baseline',
    base_workflow_id: undefined,
    learning_status: 'unlearned',
    learning_version: 0,
    template_mode: workflowPayload.template_mode || 'snapshot',
    mutation_profile: undefined,
    source_recording_session_id: session.id,
  } as any);

  for (const step of enabledDraftSteps) {
    const templatePayload = step.request_template_payload || {};
    const template = await db.repos.apiTemplates.create({
      name: templatePayload.name || `${workflow.name} Step ${step.sequence}`,
      group_name: 'Recorded Workflow',
      description: templatePayload.description || `Published from recording session ${session.name}`,
      raw_request: templatePayload.raw_request,
      parsed_structure: templatePayload.parsed_structure || {},
      variables: templatePayload.variables || [],
      failure_patterns: templatePayload.failure_patterns || [],
      failure_logic: templatePayload.failure_logic || 'OR',
      is_active: true,
      account_binding_strategy: 'per_account',
      attacker_account_id: undefined,
      enable_baseline: false,
      baseline_config: {},
      advanced_config: {
        ...(templatePayload.advanced_config || {}),
        recording_session_id: session.id,
        source_workflow_draft_id: draft.id,
        source_workflow_draft_step_id: step.id,
      },
      rate_limit_override: undefined,
      source_recording_session_id: session.id,
    } as any);

    await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
      draft_type: 'workflow',
      source_draft_id: draft.id,
      source_recording_session_id: session.id,
      target_asset_type: 'api_template',
      target_asset_id: template.id,
      published_by: params?.published_by,
    }) as any);

    await db.repos.workflowSteps.create({
      workflow_id: workflow.id,
      api_template_id: template.id,
      step_order: publishedStepOrderBySequence.get(step.sequence) || step.sequence,
      step_assertions: [],
      assertions_mode: 'all',
      failure_patterns_override: [],
      request_snapshot_raw: template.raw_request,
      failure_patterns_snapshot: template.failure_patterns,
      snapshot_template_name: template.name,
      snapshot_template_id: template.id,
      snapshot_created_at: nowIso(),
    } as any);
  }

  const groupedVariables = new Map<string, {
    name: string;
    data_source: string;
    step_variable_mappings: any[];
    checklist_id?: string;
    security_rule_id?: string;
    account_field_name?: string;
    advanced_config?: Record<string, any>;
    role?: string;
  }>();
  for (const candidate of variableCandidates) {
    const mappedStep = candidate.workflow_draft_step_id
      ? enabledStepById.get(candidate.workflow_draft_step_id)
      : enabledDraftSteps.find(step => step.source_event_id === candidate.source_event_id);
    if (!mappedStep) continue;

    const remappedVariableMappings = ensureArray(candidate.step_variable_mappings)
      .map(mapping => {
        const sourceSequence = Number(mapping.step_order);
        const publishedStepOrder = publishedStepOrderBySequence.get(sourceSequence);
        if (!publishedStepOrder) {
          return null;
        }

        return {
          ...mapping,
          step_order: publishedStepOrder,
          json_path: candidate.json_path ?? mapping.json_path,
        };
      })
      .filter(Boolean) as any[];

    if (remappedVariableMappings.length === 0) {
      remappedVariableMappings.push({
        step_order: publishedStepOrderBySequence.get(mappedStep.sequence) || mappedStep.sequence,
        json_path: candidate.json_path,
      });
    }

    const key = [
      candidate.name,
      candidate.data_source,
      candidate.account_field_name || '',
      candidate.checklist_id || '',
      candidate.security_rule_id || '',
    ].join('::');
    const existing = groupedVariables.get(key) || {
      name: candidate.name,
      data_source: candidate.data_source,
      step_variable_mappings: [],
      checklist_id: candidate.checklist_id,
      security_rule_id: candidate.security_rule_id,
      account_field_name: candidate.account_field_name,
      advanced_config: candidate.advanced_config,
      role: candidate.role,
    };
    existing.step_variable_mappings.push(...remappedVariableMappings);
    existing.advanced_config = {
      ...(existing.advanced_config || {}),
      ...(candidate.advanced_config || {}),
    };
    groupedVariables.set(key, existing);
  }

  for (const item of groupedVariables.values()) {
    await db.repos.workflowVariableConfigs.create({
      workflow_id: workflow.id,
      name: item.name,
      step_variable_mappings: item.step_variable_mappings,
      data_source: item.data_source,
      checklist_id: item.checklist_id,
      security_rule_id: item.security_rule_id,
      account_field_name: item.account_field_name,
      binding_strategy: 'per_account',
      attacker_account_id: undefined,
      role: item.role,
      is_attacker_field: item.role === 'attacker',
      advanced_config: item.advanced_config || {},
      account_scope_mode: 'all',
      account_scope_ids: [],
    } as any);
  }

  for (const candidate of extractorCandidates) {
    const step = enabledDraftSteps.find(item => item.id === candidate.workflow_draft_step_id || item.source_event_id === candidate.source_event_id);
    if (!step) continue;

    await db.repos.workflowExtractors.create({
      workflow_id: workflow.id,
      step_order: publishedStepOrderBySequence.get(step.sequence) || step.sequence,
      name: candidate.name,
      source: candidate.source,
      expression: candidate.expression,
      transform: candidate.transform,
      required: candidate.required,
    } as any);
  }

  await db.repos.workflowDrafts.update(draft.id, {
    status: 'published',
    published_workflow_id: workflow.id,
  } as any);

  await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
    draft_type: 'workflow',
    source_draft_id: draft.id,
    source_recording_session_id: session.id,
    target_asset_type: 'workflow',
    target_asset_id: workflow.id,
    published_by: params?.published_by,
  }) as any);

  await recomputeSessionMetrics(db, session.id);
  incrementPromotionSuccess({
    draft_type: 'workflow',
    source_draft_id: draft.id,
    target_asset_id: workflow.id,
    session_id: session.id,
  });

  await appendRecordingAuditLog(db, {
    session_id: session.id,
    action: 'recording_workflow_published',
    actor: params?.published_by,
    target_type: 'workflow',
    target_id: workflow.id,
    status: 'success',
    message: `Published workflow from draft ${draft.name}`,
    details: {
      source_draft_id: draft.id,
      step_count: enabledDraftSteps.length,
    },
  });

  return {
    workflow,
    published_from_draft_id: draft.id,
  };
}

export async function publishTestRunDraft(db: DbProvider, draftId: string, params?: {
  preset_name?: string;
  published_by?: string;
}): Promise<any> {
  const draft = await db.repos.testRunDrafts.findById(draftId);
  if (!draft) {
    throw new Error(`Test run draft not found: ${draftId}`);
  }

  const session = await db.repos.recordingSessions.findById(draft.session_id);
  if (!session) {
    throw new Error(`Recording session not found for draft ${draftId}`);
  }

  const payload = draft.draft_payload || {};
  const presetPayload = payload.preset || {};
  const template = await createApiTemplateAssetFromTestRunDraft(db, draft, session);

  await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    source_recording_session_id: session.id,
    target_asset_type: 'api_template',
    target_asset_id: template.id,
    published_by: params?.published_by,
  }) as any);

  const preset = await db.repos.testRunPresets.create({
    name: params?.preset_name || presetPayload.name || draft.name.replace(/ Draft$/, ''),
    description: presetPayload.description || `Published from recording session ${session.name}`,
    source_draft_id: draft.id,
    template_id: template.id,
    environment_id: presetPayload.environment_id || session.environment_id,
    default_account_id: presetPayload.default_account_id || session.account_id,
    preset_config: {
      ...(presetPayload.preset_config || {}),
      template_id: template.id,
    },
  } as any);

  await db.repos.testRunDrafts.update(draft.id, {
    status: 'published',
    published_preset_id: preset.id,
  } as any);

  await db.repos.draftPublishLogs.create(buildDraftPublishLogPayload({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    source_recording_session_id: session.id,
    target_asset_type: 'test_run_preset',
    target_asset_id: preset.id,
    published_by: params?.published_by,
  }) as any);

  await refreshTestRunDraftMaterialization(db, draft.id);
  await recomputeSessionMetrics(db, session.id);
  incrementPromotionSuccess({
    draft_type: 'test_run',
    source_draft_id: draft.id,
    target_asset_id: preset.id,
    session_id: session.id,
  });

  await appendRecordingAuditLog(db, {
    session_id: session.id,
    action: 'recording_test_run_preset_published',
    actor: params?.published_by,
    target_type: 'test_run_preset',
    target_id: preset.id,
    status: 'success',
    message: `Published reusable preset from draft ${draft.name}`,
    details: {
      source_draft_id: draft.id,
      template_id: template.id,
    },
  });

  return {
    template,
    preset,
    published_from_draft_id: draft.id,
  };
}

export async function listDraftPublishLogs(db: DbProvider, filters?: {
  draft_type?: 'workflow' | 'test_run';
  source_draft_id?: string;
  source_recording_session_id?: string;
  target_asset_type?: string;
  target_asset_id?: string;
}): Promise<DraftPublishLog[]> {
  const where: Record<string, any> = {};

  if (filters?.draft_type) where.draft_type = filters.draft_type;
  if (filters?.source_draft_id) where.source_draft_id = filters.source_draft_id;
  if (filters?.source_recording_session_id) {
    where.source_recording_session_id = filters.source_recording_session_id;
  }
  if (filters?.target_asset_type) where.target_asset_type = filters.target_asset_type;
  if (filters?.target_asset_id) where.target_asset_id = filters.target_asset_id;

  const logs = await db.repos.draftPublishLogs.findAll({
    where: Object.keys(where).length > 0 ? where as any : undefined,
  });

  return [...logs].sort((a, b) => {
    const aTime = new Date(a.published_at || a.created_at).getTime();
    const bTime = new Date(b.published_at || b.created_at).getTime();
    return bTime - aTime;
  });
}

export async function exportRecordingSessionRaw(db: DbProvider, sessionId: string): Promise<any> {
  const artifacts = await loadSessionArtifacts(db, sessionId);
  return {
    ...artifacts,
    runtime_context_summary: buildRuntimeContextSummary(artifacts.runtimeContexts),
  };
}
