import type {
  Account,
  DbProvider,
  RecordingAccountDraft,
  RecordingFieldHit,
  RecordingRuntimeContext,
  RecordingSession,
} from '../types/index.js';

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeKey(value: string): string {
  return String(value || '')
    .trim()
    .replace(/[\[\]\(\)]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function titleCase(value: string): string {
  return String(value || '')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isAuthLike(fieldName?: string): boolean {
  const normalized = normalizeKey(fieldName || '');
  return [
    'token', 'auth', 'session', 'csrf', 'cookie', 'refresh', 'bearer', 'nonce', 'authorization', 'jwt',
  ].some(keyword => normalized.includes(keyword));
}

function isLikelyVariable(fieldName?: string): boolean {
  const normalized = normalizeKey(fieldName || '');
  return [
    'user', 'tenant', 'org', 'role', 'region', 'phone', 'email', 'username', 'account', 'device', 'locale',
  ].some(keyword => normalized.includes(keyword));
}

function getPreviewValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function setNestedObjectValue(target: Record<string, any>, path: string, value: unknown): void {
  const segments = String(path || '').split('.').filter(Boolean);
  if (segments.length === 0) return;
  let cursor: Record<string, any> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, any>;
  }
  cursor[segments[segments.length - 1]] = value;
}

function flattenObject(value: any, prefix = ''): Array<{ path: string; value: unknown }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const entries: Array<{ path: string; value: unknown }> = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      entries.push(...flattenObject(child, path));
    } else if (typeof child !== 'object') {
      entries.push({ path, value: child });
    }
  }
  return entries;
}

function buildSuggestionId(section: string, targetPath: string, sourceName: string): string {
  return `${section}:${targetPath}:${normalizeKey(sourceName)}`;
}

export async function getRecordingSessionAccountDraft(
  db: DbProvider,
  sessionId: string,
  options?: { regenerate?: boolean }
): Promise<RecordingAccountDraft> {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) {
    throw new Error(`Recording session not found: ${sessionId}`);
  }

  const [fieldHits, runtimeContexts, events, accounts] = await Promise.all([
    db.repos.recordingFieldHits.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingRuntimeContext.findAll({ where: { session_id: sessionId } as any }),
    db.repos.recordingEvents.findAll({ where: { session_id: sessionId } as any }),
    db.repos.accounts.findAll(),
  ]);

  const accountNameSuggestion = session.account_label?.trim()
    || `${session.name.replace(/\s+recording$/i, '').trim()} Account`;
  const requestedFieldNames = [
    ...(session.requested_field_names || []),
    ...((session.target_fields || []).map((item: any) => item.bind_to_account_field || item.name)),
  ].map(item => normalizeKey(item)).filter(Boolean);

  const suggestionMap = new Map<string, any>();

  function registerSuggestion(input: {
    section: 'fields' | 'auth_profile' | 'variables';
    target_path: string;
    source_type: 'field_hit' | 'runtime_context' | 'event_scan';
    source_name: string;
    source_location?: string;
    source_key?: string;
    value_text?: string;
    value_preview?: string;
    confidence?: number;
    reason?: string;
  }) {
    const valueText = input.value_text || input.value_preview;
    if (!valueText || !input.target_path) return;
    const key = `${input.section}:${input.target_path}`;
    const nextConfidence = Number(input.confidence ?? 0.6);
    const current = suggestionMap.get(key);
    if (!current || nextConfidence >= Number(current.confidence || 0)) {
      suggestionMap.set(key, {
        id: buildSuggestionId(input.section, input.target_path, input.source_name),
        section: input.section,
        target_path: input.target_path,
        source_type: input.source_type,
        source_name: input.source_name,
        source_location: input.source_location,
        source_key: input.source_key,
        value_preview: input.value_preview || valueText,
        value_text: valueText,
        confidence: nextConfidence,
        selected: true,
        reason: input.reason,
      });
    }
  }

  for (const hit of fieldHits) {
    const sourceName = hit.bind_to_account_field || hit.field_name;
    const normalized = normalizeKey(sourceName);
    const valueText = hit.value_text || hit.value_preview;
    if (!normalized || !valueText) continue;

    const section = isAuthLike(normalized) ? 'auth_profile' : 'fields';
    const targetPath = section === 'auth_profile'
      ? (normalized.includes('cookie') ? `cookies.${normalized}` : normalized.includes('authorization') || normalized === 'bearer' ? 'headers.authorization' : normalized)
      : normalized;

    registerSuggestion({
      section,
      target_path: targetPath,
      source_type: 'field_hit',
      source_name: hit.field_name,
      source_location: hit.source_location,
      source_key: hit.source_key,
      value_text: valueText,
      value_preview: hit.value_preview,
      confidence: hit.confidence,
      reason: hit.bind_to_account_field ? 'Matched explicit account binding target' : 'Matched captured field hit',
    });

    if (!isAuthLike(normalized) || isLikelyVariable(normalized)) {
      registerSuggestion({
        section: 'variables',
        target_path: `recording.${normalized}`,
        source_type: 'field_hit',
        source_name: hit.field_name,
        source_location: hit.source_location,
        source_key: hit.source_key,
        value_text: valueText,
        value_preview: hit.value_preview,
        confidence: Math.max(0.45, Number(hit.confidence || 0.5) - 0.05),
        reason: 'Reusable variable derived from captured field',
      });
    }
  }

  for (const context of runtimeContexts) {
    const normalized = normalizeKey(context.bind_to_account_field || context.context_key);
    const valueText = context.value_text || context.value_preview;
    if (!normalized || !valueText) continue;

    const targetPath = context.source_location?.includes('cookie')
      ? `cookies.${normalized}`
      : context.source_location?.includes('header')
        ? `headers.${normalized}`
        : normalized;

    registerSuggestion({
      section: 'auth_profile',
      target_path: targetPath,
      source_type: 'runtime_context',
      source_name: context.context_key,
      source_location: context.source_location,
      value_text: valueText,
      value_preview: context.value_preview,
      confidence: 0.92,
      reason: 'Captured runtime context such as header, cookie, or token',
    });

    if (isLikelyVariable(normalized)) {
      registerSuggestion({
        section: 'variables',
        target_path: `context.${normalized}`,
        source_type: 'runtime_context',
        source_name: context.context_key,
        source_location: context.source_location,
        value_text: valueText,
        value_preview: context.value_preview,
        confidence: 0.74,
        reason: 'Reusable runtime context variable',
      });
    }
  }

  const commonIdentityKeys = new Set([
    'user_id', 'userid', 'username', 'email', 'phone', 'mobile', 'tenant_id', 'tenantid', 'org_id', 'orgid', 'role', 'region', 'display_name', 'nickname',
    ...requestedFieldNames,
  ]);

  for (const event of events) {
    const importantEndpoint = /(\/me|\/profile|\/current-user|\/current_user|\/session|\/auth\/refresh)/i.test(String(event.path || ''));
    if (!importantEndpoint && !event.parsed_response_body) continue;
    for (const item of flattenObject(event.parsed_response_body || {})) {
      const key = normalizeKey(item.path.split('.').pop() || item.path);
      const valueText = getPreviewValue(item.value);
      if (!valueText) continue;
      if (commonIdentityKeys.has(key)) {
        registerSuggestion({
          section: isAuthLike(key) ? 'auth_profile' : 'fields',
          target_path: isAuthLike(key) ? key : key,
          source_type: 'event_scan',
          source_name: item.path,
          source_location: 'response.body',
          value_text: valueText,
          confidence: importantEndpoint ? 0.82 : 0.68,
          reason: importantEndpoint ? 'Found on identity-style endpoint response' : 'Found in response body scan',
        });
      }
    }
  }

  const allSuggestions = Array.from(suggestionMap.values()).sort((left, right) => {
    if (left.section !== right.section) return left.section.localeCompare(right.section);
    return String(right.confidence || 0).localeCompare(String(left.confidence || 0));
  });

  const fields = {} as Record<string, any>;
  const authProfile = {} as Record<string, any>;
  const variables = {} as Record<string, any>;
  for (const suggestion of allSuggestions) {
    if (!suggestion.selected) continue;
    if (suggestion.section === 'fields') {
      fields[suggestion.target_path] = suggestion.value_text || suggestion.value_preview;
    } else if (suggestion.section === 'auth_profile') {
      setNestedObjectValue(authProfile, suggestion.target_path, suggestion.value_text || suggestion.value_preview);
    } else {
      variables[suggestion.target_path] = suggestion.value_text || suggestion.value_preview;
    }
  }

  const warnings: string[] = [];
  const missingRequested = requestedFieldNames.filter(fieldName => {
    const targetMatches = allSuggestions.some((item: any) => normalizeKey(item.target_path).includes(fieldName));
    return !targetMatches;
  });
  if (missingRequested.length > 0) {
    warnings.push(`Requested fields not confidently found: ${missingRequested.join(', ')}`);
  }
  if (Object.keys(authProfile).length === 0) {
    warnings.push('No auth profile values were confidently extracted from this session yet.');
  }
  if (Object.keys(fields).length === 0) {
    warnings.push('No account fields were confidently extracted from this session yet.');
  }

  const suggestedExistingAccount = accounts.find(account => {
    const accountFields = account.fields || {};
    const sessionUser = fields.user_id || fields.username || fields.email;
    return sessionUser && Object.values(accountFields).some(value => String(value) === String(sessionUser));
  }) as Account | undefined;

  const draft: RecordingAccountDraft = {
    session_id: session.id,
    intent: (session.intent || 'api_test_seed') as any,
    account_name_suggestion: accountNameSuggestion,
    role: session.role,
    label: session.account_label,
    requested_field_names: requestedFieldNames,
    warnings,
    summary: {
      suggested_existing_account_id: suggestedExistingAccount?.id,
      suggested_existing_account_name: suggestedExistingAccount?.name,
      field_suggestion_count: allSuggestions.filter(item => item.section === 'fields').length,
      auth_profile_suggestion_count: allSuggestions.filter(item => item.section === 'auth_profile').length,
      variable_suggestion_count: allSuggestions.filter(item => item.section === 'variables').length,
      source_event_count: events.length,
      source_field_hit_count: fieldHits.length,
      source_runtime_context_count: runtimeContexts.length,
    },
    fields,
    auth_profile: authProfile,
    variables,
    field_suggestions: allSuggestions.filter(item => item.section === 'fields'),
    auth_profile_suggestions: allSuggestions.filter(item => item.section === 'auth_profile'),
    variable_suggestions: allSuggestions.filter(item => item.section === 'variables'),
    coverage: {
      requested_field_count: requestedFieldNames.length,
      matched_requested_field_count: requestedFieldNames.length - missingRequested.length,
      identity_hint_count: Object.keys(fields).length,
      auth_hint_count: Object.keys(authProfile).length,
      variable_hint_count: Object.keys(variables).length,
    },
    generated_at: nowIso(),
  };

  await db.repos.recordingSessions.update(session.id, {
    summary: {
      ...(session.summary || {}),
      account_draft: draft,
      account_draft_generated_at: draft.generated_at,
    },
  } as any);

  return draft;
}

export async function publishRecordingSessionAccountDraft(
  db: DbProvider,
  sessionId: string,
  input: {
    saveMode: 'create_new' | 'merge' | 'replace' | 'session_only';
    existingAccountId?: string;
    selectedFields?: string[];
    selectedAuthMappings?: string[];
    selectedVariables?: string[];
    accountName?: string;
    role?: string;
    label?: string;
    actor?: string;
  }
) {
  const session = await db.repos.recordingSessions.findById(sessionId);
  if (!session) throw new Error(`Recording session not found: ${sessionId}`);
  const draft = await getRecordingSessionAccountDraft(db, sessionId, { regenerate: true });
  const saveMode = input.saveMode || 'create_new';
  const selectedFieldKeys = new Set(input.selectedFields?.length ? input.selectedFields : draft.field_suggestions.filter(item => item.selected).map(item => item.target_path));
  const selectedAuthKeys = new Set(input.selectedAuthMappings?.length ? input.selectedAuthMappings : draft.auth_profile_suggestions.filter(item => item.selected).map(item => item.target_path));
  const selectedVariableKeys = new Set(input.selectedVariables?.length ? input.selectedVariables : draft.variable_suggestions.filter(item => item.selected).map(item => item.target_path));

  const nextFields = Object.fromEntries(Object.entries(draft.fields).filter(([key]) => selectedFieldKeys.has(key)));
  const nextAuth = {} as Record<string, any>;
  for (const suggestion of draft.auth_profile_suggestions) {
    if (!selectedAuthKeys.has(suggestion.target_path)) continue;
    setNestedObjectValue(nextAuth, suggestion.target_path, suggestion.value_text || suggestion.value_preview);
  }
  const nextVariables = Object.fromEntries(Object.entries(draft.variables).filter(([key]) => selectedVariableKeys.has(key)));

  const accountPayload = {
    name: (input.accountName || draft.account_name_suggestion || session.name || 'Imported Account').trim(),
    status: 'active',
    display_name: input.label || draft.label || undefined,
    notes: `Imported from recording session ${session.name}`,
    fields: nextFields,
    auth_profile: nextAuth,
    variables: {
      ...nextVariables,
      ...(input.role || draft.role ? { role: input.role || draft.role } : {}),
      ...(input.label || draft.label ? { account_label: input.label || draft.label } : {}),
    },
  } as Partial<Account>;

  let account: Account | undefined;
  if (saveMode === 'create_new') {
    account = await db.repos.accounts.create(accountPayload as any);
  } else if (saveMode === 'merge') {
    if (!input.existingAccountId) throw new Error('existingAccountId is required for merge');
    const existing = await db.repos.accounts.findById(input.existingAccountId);
    if (!existing) throw new Error(`Account not found: ${input.existingAccountId}`);
    account = await db.repos.accounts.update(existing.id, {
      name: input.accountName?.trim() || existing.name,
      display_name: input.label || existing.display_name,
      notes: existing.notes || accountPayload.notes,
      fields: { ...(existing.fields || {}), ...nextFields },
      auth_profile: { ...(existing.auth_profile || {}), ...nextAuth },
      variables: { ...(existing.variables || {}), ...nextVariables },
    } as any) as Account;
  } else if (saveMode === 'replace') {
    if (!input.existingAccountId) throw new Error('existingAccountId is required for replace');
    const existing = await db.repos.accounts.findById(input.existingAccountId);
    if (!existing) throw new Error(`Account not found: ${input.existingAccountId}`);
    account = await db.repos.accounts.update(existing.id, {
      name: input.accountName?.trim() || existing.name,
      display_name: input.label || existing.display_name,
      notes: existing.notes || accountPayload.notes,
      fields: nextFields,
      auth_profile: nextAuth,
      variables: nextVariables,
    } as any) as Account;
  }

  const linkage = {
    save_mode: saveMode,
    account_id: account?.id || input.existingAccountId,
    account_name: account?.name || undefined,
    persisted: saveMode !== 'session_only',
    last_applied_at: nowIso(),
    summary: {
      field_change_count: Object.keys(nextFields).length,
      auth_profile_change_count: draft.auth_profile_suggestions.filter(item => selectedAuthKeys.has(item.target_path)).length,
      variable_change_count: Object.keys(nextVariables).length,
    },
    selected_fields: [...selectedFieldKeys],
    selected_auth_mappings: [...selectedAuthKeys],
    selected_variables: [...selectedVariableKeys],
  };

  await db.repos.recordingSessions.update(session.id, {
    account_id: account?.id || session.account_id,
    role: input.role || session.role,
    summary: {
      ...(session.summary || {}),
      account_linkage: linkage,
      account_draft: draft,
      published_account_id: account?.id,
    },
  } as any);

  return {
    save_mode: saveMode,
    persisted: saveMode !== 'session_only',
    account,
    session_id: session.id,
    draft,
    linkage,
  };
}
