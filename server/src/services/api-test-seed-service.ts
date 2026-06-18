import { executeTemplateRun } from './template-runner.js';
import { appendRecordingAuditLog } from './recording-observability.js';
import { generateApiDraftArtifacts } from './recording-generator.js';
import { getRecordingSessionAccountDraft } from './recording-suggestion-engine.js';
import {
  createApiTemplateFromTestRunDraft,
  promoteTestRunDraftToTestRun,
  publishTestRunDraft,
} from './recording-service.js';
import type {
  Account,
  DbProvider,
  RecordingEvent,
  RecordingFieldHit,
  RecordingRuntimeContext,
  RecordingSession,
  TestRunDraft,
} from '../types/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKey(value: string): string {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function titleCase(value: string): string {
  return String(value || '')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function inferReasonForVariable(variable: Record<string, any>): string {
  const bindingKey = variable.account_field_name || variable.checklist_id || variable.security_rule_id || variable.runtime_context_key || variable.data_source;
  if (variable.account_field_name) return 'Detected as account-bound value from captured traffic';
  if (variable.checklist_id) return 'Looks like an object or checklist-driven identifier';
  if (variable.security_rule_id) return 'Looks like a mutation or security-rule candidate';
  if ((variable.json_path || '').includes('header') || (variable.json_path || '').includes('cookie')) return 'Appears in auth-sensitive request location';
  if ((variable.json_path || '').includes('path') || /(^|_)(id|user_id|order_id|org_id|tenant_id)(_|$)/.test(normalizeKey(variable.name || ''))) return 'Appears to be an object identifier suitable for parameterization';
  return `Suggested from recorded request structure${bindingKey ? ` and mapped to ${bindingKey}` : ''}`;
}

function inferConfidenceForVariable(variable: Record<string, any>): number {
  let base = 0.62;
  if (variable.account_field_name) base += 0.16;
  if ((variable.json_path || '').includes('path')) base += 0.08;
  if ((variable.json_path || '').includes('header') || (variable.json_path || '').includes('cookie')) base += 0.06;
  if (/(^|_)(id|token|cookie|authorization|csrf|session)(_|$)/.test(normalizeKey(variable.name || ''))) base += 0.06;
  return Math.min(0.97, Number(variable.confidence ?? base));
}

function summarizeResponse(event: RecordingEvent) {
  const body = event.parsed_response_body;
  const responseText = typeof event.response_body_text === 'string' ? event.response_body_text : '';
  const schemaKeys = body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body).slice(0, 20)
    : [];
  return {
    status: event.response_status || null,
    body_preview: responseText.slice(0, 600),
    schema_keys: schemaKeys,
    content_type: (event.response_headers?.['content-type'] || event.response_headers?.['Content-Type'] || '').toString(),
    body_kind: Array.isArray(body) ? 'array' : body && typeof body === 'object' ? 'object' : typeof body,
  };
}

function buildAssertionSuggestions(event: RecordingEvent, rawCandidates: Array<Record<string, any>>) {
  const suggestions: Array<Record<string, any>> = rawCandidates.map((candidate, index) => ({
    id: `assertion-${event.id}-${index}`,
    selected: true,
    confidence: index === 0 ? 0.92 : 0.72,
    reason:
      candidate.kind === 'status'
        ? 'Derived from the successful recorded response status'
        : candidate.kind === 'header'
          ? 'Derived from a stable response header in the recorded exchange'
          : 'Derived from a stable scalar field found in the recorded response body',
    ...candidate,
  }));

  if (suggestions.length === 0 && event.response_status) {
    suggestions.push({
      id: `assertion-status-${event.id}`,
      selected: true,
      confidence: 0.84,
      reason: 'Fallback assertion generated from successful response status',
      kind: 'status',
      label: `HTTP status should remain ${event.response_status}`,
      path: 'status',
      operator: 'equals',
      value: String(event.response_status),
    });
  }

  return suggestions;
}

function buildFailurePatternSuggestions(event: RecordingEvent, assertionSuggestions: Array<Record<string, any>>) {
  const suggestions: Array<Record<string, any>> = [];
  if (event.response_status) {
    suggestions.push({
      id: `failure-status-${event.id}`,
      selected: true,
      confidence: 0.9,
      reason: 'Negating the successful recorded status is the most reliable first failure signal',
      type: 'http_status',
      operator: 'not_equals',
      value: String(event.response_status),
    });
  }

  const parsedBody = event.parsed_response_body;
  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    const bodyKeys = Object.keys(parsedBody);
    for (const key of bodyKeys.slice(0, 5)) {
      if (/success|ok|message|code|status/i.test(key)) {
        suggestions.push({
          id: `failure-body-${event.id}-${key}`,
          selected: true,
          confidence: 0.7,
          reason: 'This response field often distinguishes successful and failed API calls',
          type: 'body_path',
          path: `body.${key}`,
          operator: key.toLowerCase().includes('success') ? 'not_equals' : 'exists',
          value: key.toLowerCase().includes('success') ? String((parsedBody as any)[key]) : undefined,
        });
      }
    }
  }

  if (suggestions.length === 0) {
    for (const assertion of assertionSuggestions.slice(0, 1)) {
      suggestions.push({
        id: `failure-from-assertion-${event.id}`,
        selected: true,
        confidence: 0.66,
        reason: 'Fallback failure suggestion mirrored from baseline assertion',
        type: assertion.kind || 'status',
        path: assertion.path,
        operator: assertion.kind === 'status' ? 'not_equals' : 'missing',
        value: assertion.kind === 'status' ? assertion.value : undefined,
      });
    }
  }

  return suggestions;
}

function buildAccountBindingSuggestions(params: {
  event: RecordingEvent;
  variables: Array<Record<string, any>>;
  runtimeContexts: RecordingRuntimeContext[];
  session: RecordingSession;
  accounts: Account[];
  accountDraft?: Record<string, any> | null;
}) {
  const { event, variables, runtimeContexts, session, accounts, accountDraft } = params;
  const suggestions: Array<Record<string, any>> = [];
  const suggestedAccountId = session.account_id || accountDraft?.summary?.suggested_existing_account_id;
  const linkedAccount = suggestedAccountId ? accounts.find((item) => item.id === suggestedAccountId) : undefined;

  const authContexts = runtimeContexts.filter((context) => /header|cookie/i.test(String(context.source_location || '')));
  for (const context of authContexts.slice(0, 12)) {
    suggestions.push({
      id: `binding-${event.id}-${context.id}`,
      target_path: context.source_location?.includes('cookie')
        ? `cookies.${normalizeKey(context.context_key)}`
        : `headers.${normalizeKey(context.context_key)}`,
      binding_type: 'account_auth_profile',
      binding_key: normalizeKey(context.bind_to_account_field || context.context_key),
      confidence: 0.88,
      selected: true,
      reason: 'Captured runtime auth material should bind to account auth profile instead of hardcoded request text',
      source_location: context.source_location,
      value_preview: context.value_preview,
    });
  }

  for (const variable of variables.filter((item) => item.account_field_name).slice(0, 12)) {
    suggestions.push({
      id: `binding-variable-${event.id}-${variable.name}`,
      target_path: variable.json_path,
      binding_type: 'account_field',
      binding_key: variable.account_field_name,
      confidence: inferConfidenceForVariable(variable),
      selected: true,
      reason: 'The request variable already maps cleanly to an account field',
      source_location: variable.json_path,
      value_preview: variable.original_value,
    });
  }

  const bindingStrategy = linkedAccount ? 'per_account' : 'independent';
  return {
    binding_strategy_suggestion: bindingStrategy,
    suggested_account_id: linkedAccount?.id,
    suggested_account_name: linkedAccount?.name,
    suggestions,
  };
}

function enrichApiDraft(params: {
  draft: TestRunDraft;
  session: RecordingSession;
  event: RecordingEvent;
  runtimeContexts: RecordingRuntimeContext[];
  accounts: Account[];
  accountDraft?: Record<string, any> | null;
}): TestRunDraft {
  const { draft, session, event, runtimeContexts, accounts, accountDraft } = params;
  const payload = draft.draft_payload || {};
  const templatePayload = payload.template || {};
  const responseSummary = summarizeResponse(event);
  const variables = Array.isArray(templatePayload.variables) ? templatePayload.variables : [];
  const variableSuggestions = variables.map((item: Record<string, any>) => ({
    selected: item.selected ?? true,
    confidence: inferConfidenceForVariable(item),
    reason: item.reason || inferReasonForVariable(item),
    source: item.account_field_name ? 'account_field' : item.data_source || 'recorded_request',
    target_location: item.json_path,
    ...item,
  }));
  const assertionSuggestions = buildAssertionSuggestions(event, Array.isArray(templatePayload.assertion_candidates) ? templatePayload.assertion_candidates : []);
  const failureSuggestions = buildFailurePatternSuggestions(event, assertionSuggestions);
  const accountBinding = buildAccountBindingSuggestions({
    event,
    variables: variableSuggestions,
    runtimeContexts,
    session,
    accounts,
    accountDraft,
  });

  const nextPayload = {
    ...payload,
    context: {
      ...(payload.context || {}),
      session_id: session.id,
      source_event_id: event.id,
      sequence: event.sequence,
      environment_id: session.environment_id || '',
      account_id: session.account_id || accountBinding.suggested_account_id || '',
      method: event.method,
      path: event.path,
      intent: 'api_test_seed',
    },
    template: {
      ...templatePayload,
      variables: variableSuggestions,
      field_candidates: Array.isArray(templatePayload.field_candidates) ? templatePayload.field_candidates : [],
      assertion_candidates: assertionSuggestions,
      failure_patterns: failureSuggestions,
      failure_logic: templatePayload.failure_logic || 'OR',
      response_snapshot: {
        ...(templatePayload.response_snapshot || {}),
        ...responseSummary,
      },
      response_fingerprint_summary: responseSummary,
      account_binding_suggestions: accountBinding.suggestions,
    },
    preset: {
      ...(payload.preset || {}),
      environment_id: '',
      default_account_id: '',
      preset_config: {
        ...((payload.preset || {}).preset_config || {}),
        source_recording_session_id: session.id,
        source_event_id: event.id,
        source_event_sequence: event.sequence,
        suggestion_origin: 'api_test_seed',
      },
    },
  };

  const suggestionSummary = {
    confidence: Number(([
      ...variableSuggestions.map((item: any) => Number(item.confidence || 0)),
      ...assertionSuggestions.map((item: any) => Number(item.confidence || 0)),
      ...failureSuggestions.map((item: any) => Number(item.confidence || 0)),
    ].reduce((sum, item) => sum + item, 0) / Math.max(1, variableSuggestions.length + assertionSuggestions.length + failureSuggestions.length)).toFixed(2)),
    variable_suggestion_count: variableSuggestions.length,
    assertion_suggestion_count: assertionSuggestions.length,
    failure_pattern_suggestion_count: failureSuggestions.length,
    account_binding_suggestion_count: accountBinding.suggestions.length,
    response_fingerprint_summary: responseSummary,
    suggested_account_id: accountBinding.suggested_account_id,
    suggested_account_name: accountBinding.suggested_account_name,
    binding_strategy_suggestion: accountBinding.binding_strategy_suggestion,
    source_event_id: event.id,
  };

  return {
    ...draft,
    status: 'reviewing',
    intent: 'api_test_seed',
    draft_status: 'generated',
    suggestion_summary: suggestionSummary,
    review_decisions: draft.review_decisions || {},
    draft_payload: nextPayload,
    summary: {
      ...(draft.summary || {}),
      method: event.method,
      path: event.path,
      response_status: event.response_status,
      variable_suggestion_count: variableSuggestions.length,
      assertion_candidate_count: assertionSuggestions.length,
      failure_pattern_count: failureSuggestions.length,
      account_binding_suggestion_count: accountBinding.suggestions.length,
      draft_confidence: suggestionSummary.confidence,
      binding_strategy_suggestion: accountBinding.binding_strategy_suggestion,
    },
  };
}

export async function createApiTestDrafts(
  db: DbProvider,
  sessionId: string,
  options?: {
    eventIds?: string[];
    generatePreset?: boolean;
    generateTemplate?: boolean;
    generateAssertions?: boolean;
    generateFailurePatterns?: boolean;
  }
): Promise<{ session: RecordingSession; drafts: TestRunDraft[] }> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) throw new Error(`Recording session not found: ${sessionId}`);
  if (session.mode !== 'api') throw new Error('API test drafts can only be generated from API recording sessions');

  const [events, fieldHits, runtimeContexts, existingDrafts, accounts] = await Promise.all([
    db.repos.recordingEvents.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingFieldHits.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingRuntimeContext.findAll({ where: { session_id: sessionId } as any }),
    db.repos.testRunDrafts.findAll({ where: { session_id: sessionId } as any }),
    db.repos.accounts.findAll(),
  ]);
  const accountDraft = await getRecordingSessionAccountDraft(db, sessionId).catch(() => null);

  const selectedEventIds = new Set((options?.eventIds || []).map(String).filter(Boolean));
  const selectedEvents = selectedEventIds.size > 0
    ? events.filter((event) => selectedEventIds.has(event.id))
    : [...events].sort((a, b) => a.sequence - b.sequence).slice(0, 1);

  if (selectedEvents.length === 0) {
    throw new Error('No matching recording events found for API test seed generation');
  }

  const eventHitSet = new Set(selectedEvents.map((event) => event.id));
  const selectedHits = fieldHits.filter((hit) => eventHitSet.has(hit.event_id));
  const generated = generateApiDraftArtifacts({
    session: { ...session, intent: 'api_test_seed' },
    events: selectedEvents,
    fieldHits: selectedHits,
  });

  const eventById = new Map(selectedEvents.map((event) => [event.id, event]));
  const existingByEventId = new Map(existingDrafts.filter((item) => item.source_event_id).map((item) => [String(item.source_event_id), item]));
  const results: TestRunDraft[] = [];

  for (const rawDraft of generated.drafts) {
    const event = rawDraft.source_event_id ? eventById.get(rawDraft.source_event_id) : undefined;
    if (!event) continue;
    const eventContexts = runtimeContexts.filter((item) => item.event_id === event.id || !item.event_id);
    const enriched = enrichApiDraft({
      draft: rawDraft as TestRunDraft,
      session,
      event,
      runtimeContexts: eventContexts,
      accounts,
      accountDraft,
    });

    const existing = rawDraft.source_event_id ? existingByEventId.get(rawDraft.source_event_id) : undefined;
    if (existing && !['published', 'run_created', 'archived'].includes(existing.status || '')) {
      const updated = await db.repos.testRunDrafts.update(existing.id, {
        name: enriched.name,
        status: enriched.status,
        intent: enriched.intent,
        draft_status: enriched.draft_status,
        sequence: enriched.sequence,
        source_event_id: enriched.source_event_id,
        summary: enriched.summary,
        suggestion_summary: enriched.suggestion_summary,
        review_decisions: enriched.review_decisions,
        draft_payload: enriched.draft_payload,
      } as any) as TestRunDraft;
      results.push(updated);
      continue;
    }

    const created = await db.repos.testRunDrafts.create({
      ...(enriched as any),
      published_template_id: undefined,
      published_preset_id: undefined,
      published_test_run_id: undefined,
    });
    results.push(created as TestRunDraft);
  }

  await db.repos.recordingSessions.update(sessionId, {
    summary: {
      ...(session.summary || {}),
      api_test_seed_generated_at: nowIso(),
      api_test_seed_event_count: selectedEvents.length,
      api_test_seed_draft_ids: results.map((item) => item.id),
    },
  } as any);

  await appendRecordingAuditLog(db, {
    session_id: sessionId,
    action: 'recording_api_test_drafts_generated',
    actor: 'recording_api',
    target_type: 'recording_session',
    target_id: sessionId,
    status: 'success',
    message: `Generated ${results.length} API test draft(s) from recording session ${session.name}`,
    details: {
      event_count: selectedEvents.length,
      draft_ids: results.map((item) => item.id),
    },
  });

  return { session, drafts: results };
}

export async function listApiTestDraftsBySession(db: DbProvider, sessionId: string): Promise<TestRunDraft[]> {
  const drafts = await db.repos.testRunDrafts.findAll({ where: { session_id: sessionId } as any });
  return drafts.sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
}

export async function getApiTestDraftById(db: DbProvider, draftId: string): Promise<TestRunDraft> {
  const draft = await db.repos.testRunDrafts.findById(draftId);
  if (!draft) throw new Error(`API test draft not found: ${draftId}`);
  return draft;
}

export async function publishApiTestDraft(
  db: DbProvider,
  draftId: string,
  params?: {
    createPreset?: boolean;
    preset_name?: string;
    template_name?: string;
    published_by?: string;
  }
) {
  if (params?.createPreset === false) {
    return createApiTemplateFromTestRunDraft(db, draftId, {
      template_name: params?.template_name,
      published_by: params?.published_by,
    });
  }

  return publishTestRunDraft(db, draftId, {
    preset_name: params?.preset_name,
    published_by: params?.published_by,
  });
}

export async function publishAndRunApiTestDraft(
  db: DbProvider,
  draftId: string,
  params?: {
    test_run_name?: string;
    published_by?: string;
    environment_id?: string;
    account_ids?: string[];
  }
) {
  const promotion = await promoteTestRunDraftToTestRun(db, draftId, {
    test_run_name: params?.test_run_name,
    published_by: params?.published_by,
  });
  const testRun = promotion.test_run;
  const accountIds = (Array.isArray(params?.account_ids) && params?.account_ids.length > 0)
    ? params?.account_ids
    : Array.isArray(testRun.account_ids) ? testRun.account_ids : [];
  const environmentId = params?.environment_id || testRun.environment_id;
  const templateIds = Array.isArray(testRun.template_ids) ? testRun.template_ids : [];

  const execution = await executeTemplateRun({
    test_run_id: testRun.id,
    template_ids: templateIds,
    account_ids: accountIds,
    environment_id: environmentId,
  });

  await db.repos.testRunDrafts.update(draftId, {
    status: 'run_created',
    draft_status: 'run_created',
  } as any);

  return {
    ...promotion,
    execution,
  };
}
