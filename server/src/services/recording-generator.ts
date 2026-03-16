import type {
  RecordingEvent,
  RecordingFieldHit,
  RecordingRuntimeContext,
  RecordingSession,
  WorkflowDraft,
  WorkflowDraftStep,
  RecordingExtractorCandidate,
  RecordingVariableCandidate,
  TestRunDraft,
} from '../types/index.js';
import { FieldDictionary } from './field-dictionary.js';

type JsonRecord = Record<string, any>;

interface RequestVariableSuggestion {
  name: string;
  json_path: string;
  original_value: string;
  operation_type: 'replace';
  data_source?: 'account_field';
  account_field_name?: string;
  path_replacement_mode?: 'segment_index';
  path_segment_index?: number;
  advanced_config?: Record<string, any>;
}

export interface GeneratedWorkflowArtifacts {
  draft: Omit<WorkflowDraft, 'id' | 'created_at' | 'updated_at'>;
  steps: Array<Omit<WorkflowDraftStep, 'id' | 'created_at' | 'updated_at'>>;
  extractorCandidates: Array<Omit<RecordingExtractorCandidate, 'id' | 'created_at' | 'updated_at'>>;
  variableCandidates: Array<Omit<RecordingVariableCandidate, 'id' | 'created_at' | 'updated_at'>>;
}

export interface GeneratedApiDraftArtifacts {
  drafts: Array<Omit<TestRunDraft, 'id' | 'created_at' | 'updated_at'>>;
}

interface WorkflowStepCandidate {
  sequence: number;
  representativeEvent: RecordingEvent;
  mergedEvents: RecordingEvent[];
  fieldHits: RecordingFieldHit[];
  runtimeContexts: RecordingRuntimeContext[];
  businessAction: string;
  importance: number;
}

const STATIC_RESOURCE_EXTENSIONS = [
  '.js',
  '.css',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.svg',
  '.ico',
  '.map',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.webp',
];

const POLLING_PATH_PATTERNS = [
  /\/status(?:\/|$|\?)/i,
  /\/progress(?:\/|$|\?)/i,
  /\/poll(?:\/|$|\?)/i,
  /\/heartbeat(?:\/|$|\?)/i,
  /\/health(?:\/|$|\?)/i,
  /\/ready(?:\/|$|\?)/i,
  /\/ping(?:\/|$|\?)/i,
];

const POLLING_SIGNAL_KEYS = ['state', 'status', 'progress', 'heartbeat', 'health', 'ready', 'ping'];
const AMBIENT_REQUEST_KEYS = ['authorization', 'access_token', 'refresh_token', 'session_id', 'csrf_token'];

const BUSINESS_ACTION_RULES: Array<{ action: string; patterns: RegExp[] }> = [
  { action: 'login', patterns: [/login/i, /signin/i, /authenticate/i, /token/i, /session/i, /oauth/i] },
  { action: 'initialize', patterns: [/bootstrap/i, /profile/i, /me$/i, /context/i, /config/i] },
  { action: 'list', patterns: [/list/i, /search/i, /query/i, /index/i] },
  { action: 'detail', patterns: [/detail/i, /\/\d+$/i, /\/[0-9a-f-]{8,}$/i, /orderid/i, /userid/i] },
  { action: 'modify', patterns: [/update/i, /patch/i, /edit/i, /change/i] },
  { action: 'submit', patterns: [/submit/i, /checkout/i, /create/i, /confirm/i, /complete/i] },
  { action: 'delete', patterns: [/delete/i, /remove/i, /destroy/i] },
];

function normalizeName(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function toTitleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
    .trim();
}

function sanitizePathSegment(path: string): string {
  return path
    .replace(/\?.*$/, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, ' ')
    .replace(/[{}[\]]/g, ' ')
    .trim();
}

function isAuthField(fieldName: string): boolean {
  const normalized = fieldName.toLowerCase();
  return normalized.includes('token') ||
    normalized.includes('auth') ||
    normalized.includes('session') ||
    normalized.includes('csrf') ||
    normalized.includes('nonce');
}

function stripQuery(path: string): string {
  return path.replace(/\?.*$/, '');
}

function looksStaticResource(path: string): boolean {
  const normalized = stripQuery(path || '').toLowerCase();
  return STATIC_RESOURCE_EXTENSIONS.some(ext => normalized.endsWith(ext));
}

function normalizeSignalKey(value?: string): string {
  return (value || '')
    .replace(/^\$\./, '')
    .split(/[./[\]]+/)
    .filter(Boolean)
    .pop()
    ?.toLowerCase() || '';
}

function getSignalRuntimeContexts(runtimeContexts: RecordingRuntimeContext[]): RecordingRuntimeContext[] {
  return runtimeContexts.filter(context => {
    const sourceLocation = context.source_location || '';
    return sourceLocation.startsWith('response.') ||
      sourceLocation === 'request.body' ||
      sourceLocation === 'request.query';
  });
}

function isPollingTelemetryHit(hit: RecordingFieldHit): boolean {
  const fieldName = normalizeSignalKey(hit.field_name);
  const sourceKey = normalizeSignalKey(hit.source_key);
  return POLLING_SIGNAL_KEYS.includes(fieldName) || POLLING_SIGNAL_KEYS.includes(sourceKey);
}

function isPollingTelemetryContext(context: RecordingRuntimeContext): boolean {
  return POLLING_SIGNAL_KEYS.includes(normalizeSignalKey(context.context_key));
}

function isAmbientRequestHit(hit: RecordingFieldHit): boolean {
  if (!['request.header', 'request.cookie'].includes(hit.source_location)) {
    return false;
  }

  const candidates = [
    normalizeSignalKey(hit.field_name),
    normalizeSignalKey(hit.source_key),
    normalizeSignalKey(hit.bind_to_account_field),
  ];

  return candidates.some(candidate => AMBIENT_REQUEST_KEYS.includes(candidate));
}

function getSignalFieldHits(fieldHits: RecordingFieldHit[]): RecordingFieldHit[] {
  return fieldHits.filter(hit => !isPollingTelemetryHit(hit) && !isAmbientRequestHit(hit));
}

function looksLikePollingEvent(
  event: RecordingEvent,
  fieldHits: RecordingFieldHit[],
  runtimeContexts: RecordingRuntimeContext[]
): boolean {
  if (event.method !== 'GET') {
    return false;
  }

  const normalizedPath = stripQuery(event.path || event.url || '');
  if (!POLLING_PATH_PATTERNS.some(pattern => pattern.test(normalizedPath))) {
    return false;
  }

  const meaningfulFieldHits = getSignalFieldHits(fieldHits);
  const meaningfulRuntimeContexts = getSignalRuntimeContexts(runtimeContexts)
    .filter(context => !isPollingTelemetryContext(context));

  return meaningfulFieldHits.length === 0 && meaningfulRuntimeContexts.length === 0;
}

function hasCollectionLikeResponse(event: RecordingEvent): boolean {
  const responseBody = event.parsed_response_body;
  if (!responseBody || typeof responseBody !== 'object') {
    return false;
  }

  return Object.values(responseBody).some(value => Array.isArray(value));
}

function classifyBusinessAction(event: RecordingEvent, fieldHits: RecordingFieldHit[]): string {
  const haystack = [event.method, event.path, ...fieldHits.map(hit => hit.field_name), ...fieldHits.map(hit => hit.source_key || '')]
    .filter(Boolean)
    .join(' ');

  for (const rule of BUSINESS_ACTION_RULES) {
    if (rule.patterns.some(pattern => pattern.test(haystack))) {
      return rule.action;
    }
  }

  if (event.method === 'POST') return 'submit';
  if (event.method === 'DELETE') return 'delete';
  if (event.method === 'PATCH' || event.method === 'PUT') return 'modify';
  if (event.method === 'GET' && hasCollectionLikeResponse(event)) return 'list';
  return 'request';
}

function businessActionPriority(action: string): number {
  switch (action) {
    case 'login':
      return 70;
    case 'initialize':
      return 60;
    case 'list':
      return 45;
    case 'detail':
      return 40;
    case 'modify':
      return 35;
    case 'submit':
      return 50;
    case 'delete':
      return 30;
    default:
      return 10;
  }
}

function scoreWorkflowEvent(
  event: RecordingEvent,
  fieldHits: RecordingFieldHit[],
  runtimeContexts: RecordingRuntimeContext[],
  action: string
): number {
  const signalFieldHits = getSignalFieldHits(fieldHits);
  const signalRuntimeContexts = getSignalRuntimeContexts(runtimeContexts);
  return businessActionPriority(action) +
    (signalFieldHits.length * 100) +
    (signalRuntimeContexts.length * 30) +
    (event.response_status && event.response_status >= 200 && event.response_status < 400 ? 5 : 0) +
    ((event.request_body_text || '').length > 0 ? 5 : 0);
}

function shouldSkipWorkflowEvent(
  event: RecordingEvent,
  fieldHits: RecordingFieldHit[],
  runtimeContexts: RecordingRuntimeContext[]
): boolean {
  if (event.method === 'OPTIONS' || event.method === 'HEAD') {
    return true;
  }

  if (looksStaticResource(event.path || event.url || '')) {
    return getSignalFieldHits(fieldHits).length === 0 && getSignalRuntimeContexts(runtimeContexts).length === 0;
  }

  if (looksLikePollingEvent(event, fieldHits, runtimeContexts)) {
    return true;
  }

  return false;
}

function canMergeWorkflowStepCandidate(
  previous: WorkflowStepCandidate | null,
  event: RecordingEvent,
  fieldHits: RecordingFieldHit[],
  runtimeContexts: RecordingRuntimeContext[]
): boolean {
  if (!previous) return false;

  const previousEvent = previous.representativeEvent;
  if (previousEvent.method !== event.method) return false;
  if ((previousEvent.path || '') !== (event.path || '')) return false;
  if ((previousEvent.request_body_text || '') !== (event.request_body_text || '')) return false;
  if ((previousEvent.response_status || null) !== (event.response_status || null)) return false;

  const signalRuntimeContexts = getSignalRuntimeContexts(runtimeContexts);
  const previousSignalRuntimeContexts = getSignalRuntimeContexts(previous.runtimeContexts);

  if (getSignalFieldHits(fieldHits).length === 0 && signalRuntimeContexts.length === 0) {
    return true;
  }

  return getSignalFieldHits(previous.fieldHits).length === 0 && previousSignalRuntimeContexts.length === 0;
}

function buildWorkflowStepName(sessionName: string, action: string, sequence: number, path: string): string {
  const suffix = sanitizePathSegment(path) || `step ${sequence}`;
  const prettyAction = action === 'request' ? 'Step' : toTitleCase(action);
  return `${sessionName} ${prettyAction} ${toTitleCase(suffix)}`.trim();
}

function buildWorkflowStepCandidates(params: {
  events: RecordingEvent[];
  fieldHitsByEvent: Map<string, RecordingFieldHit[]>;
  runtimeContextsByEvent: Map<string, RecordingRuntimeContext[]>;
}): {
  candidates: WorkflowStepCandidate[];
  skippedCount: number;
  mergedAwayCount: number;
} {
  const { events, fieldHitsByEvent, runtimeContextsByEvent } = params;
  const candidates: WorkflowStepCandidate[] = [];
  let skippedCount = 0;
  let mergedAwayCount = 0;

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const eventHits = fieldHitsByEvent.get(event.id) || [];
    const eventContexts = runtimeContextsByEvent.get(event.id) || [];
    if (shouldSkipWorkflowEvent(event, eventHits, eventContexts)) {
      skippedCount += 1;
      continue;
    }

    const action = classifyBusinessAction(event, eventHits);
    const importance = scoreWorkflowEvent(event, eventHits, eventContexts, action);
    const previous = candidates[candidates.length - 1] || null;

    if (canMergeWorkflowStepCandidate(previous, event, eventHits, eventContexts)) {
      previous.mergedEvents.push(event);
      previous.fieldHits = dedupeByKey(
        [...previous.fieldHits, ...eventHits],
        hit => `${hit.field_name}:${hit.source_location}:${hit.source_key || ''}:${hit.value_hash || hit.value_preview || ''}`
      );
      previous.runtimeContexts = dedupeByKey(
        [...previous.runtimeContexts, ...eventContexts],
        context => `${context.context_key}:${context.source_location || ''}:${context.value_preview || context.value_text || ''}`
      );
      mergedAwayCount += 1;

      if (importance > previous.importance) {
        previous.representativeEvent = event;
        previous.businessAction = action;
        previous.importance = importance;
      }
      continue;
    }

    candidates.push({
      sequence: event.sequence,
      representativeEvent: event,
      mergedEvents: [event],
      fieldHits: dedupeByKey(
        eventHits,
        hit => `${hit.field_name}:${hit.source_location}:${hit.source_key || ''}:${hit.value_hash || hit.value_preview || ''}`
      ),
      runtimeContexts: dedupeByKey(
        eventContexts,
        context => `${context.context_key}:${context.source_location || ''}:${context.value_preview || context.value_text || ''}`
      ),
      businessAction: action,
      importance,
    });
  }

  const normalizedCandidates = candidates.map((candidate, index) => ({
    ...candidate,
    sequence: index + 1,
  }));

  return {
    candidates: normalizedCandidates,
    skippedCount,
    mergedAwayCount,
  };
}

function buildRawRequest(event: RecordingEvent): string {
  const requestLine = `${event.method} ${event.path || '/'} HTTP/1.1`;
  const headerLines = Object.entries(event.request_headers || {})
    .map(([key, value]) => `${key}: ${value}`);

  return [
    requestLine,
    ...headerLines,
    '',
    event.request_body_text || '',
  ].join('\n').trimEnd();
}

function responseSignature(event: RecordingEvent): JsonRecord {
  return {
    status: event.response_status || null,
    header_keys: Object.keys(event.response_headers || {}),
    has_json_body: !!event.parsed_response_body,
    body_preview: event.response_body_text?.slice(0, 240),
  };
}

function buildRequestVariablePath(hit: RecordingFieldHit): string | null {
  switch (hit.source_location) {
    case 'request.path':
      return `path.${hit.bind_to_account_field || hit.field_name}`;
    case 'request.query':
      return hit.source_key ? `query.${hit.source_key}` : null;
    case 'request.header':
      return hit.source_key ? `headers.${hit.source_key.toLowerCase()}` : null;
    case 'request.cookie':
      return hit.source_key ? `cookies.${hit.source_key}` : null;
    case 'request.body':
      if (!hit.source_key || hit.source_key.includes('[')) return null;
      return `body.${hit.source_key.replace(/^\$\./, '')}`;
    default:
      return null;
  }
}

function extractPathSegmentIndex(hit: RecordingFieldHit): number | undefined {
  if (hit.source_location !== 'request.path' || !hit.source_key) {
    return undefined;
  }

  const match = hit.source_key.match(/segment\.(\d+)/);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

function buildExtractorSource(hit: RecordingFieldHit): { source: string; expression: string } | null {
  if (!hit.source_key) return null;

  switch (hit.source_location) {
    case 'response.body':
      return {
        source: 'response_body_jsonpath',
        expression: hit.source_key,
      };
    case 'response.header':
      return {
        source: 'response_header',
        expression: hit.source_key.toLowerCase(),
      };
    default:
      return null;
  }
}

function deriveCandidateName(value: string): string {
  const normalized = normalizeName(value);
  return normalized || `captured_value_${Date.now()}`;
}

function buildRole(session: RecordingSession): string | undefined {
  if (!session.role) return undefined;
  const normalized = session.role.toLowerCase();
  if (normalized.includes('attack')) return 'attacker';
  if (normalized.includes('victim') || normalized.includes('target')) return 'target';
  return 'neutral';
}

function dedupeByKey<T>(items: T[], keyBuilder: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const item of items) {
    const key = keyBuilder(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function buildValueTemplate(originalValue?: string, dynamicValue?: string): string | undefined {
  if (!originalValue || !dynamicValue || originalValue === dynamicValue) {
    return undefined;
  }

  const index = originalValue.indexOf(dynamicValue);
  if (index === -1) {
    return undefined;
  }

  const prefix = originalValue.slice(0, index);
  const suffix = originalValue.slice(index + dynamicValue.length);
  if (!prefix && !suffix) {
    return undefined;
  }

  return `${prefix}{{value}}${suffix}`;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function buildRequestPathVariableCandidates(params: {
  event: RecordingEvent;
  variableName: string;
  producerValue?: string;
}): Array<{
  event: RecordingEvent;
  jsonPath: string;
  sourceLocation: 'request.path';
  originalValue: string;
  advancedConfig: Record<string, any>;
  confidence: number;
}> {
  const { event, variableName, producerValue } = params;
  if (!producerValue || producerValue.length < 3) {
    return [];
  }

  const segments = stripQuery(event.path || event.url || '')
    .split('/')
    .filter(Boolean);

  return segments.flatMap((segment, segmentIndex) => {
    const decodedSegment = decodePathSegment(segment);
    if (decodedSegment !== producerValue && segment !== producerValue) {
      return [];
    }

    return [{
      event,
      jsonPath: `path.${variableName}`,
      sourceLocation: 'request.path' as const,
      originalValue: decodedSegment,
      advancedConfig: {
        path_replacement_mode: 'segment_index',
        path_segment_index: segmentIndex,
      },
      confidence: 0.9,
    }];
  });
}

function matchesWorkflowContextValue(producer: RecordingFieldHit, consumer: RecordingFieldHit): {
  matched: boolean;
  value_template?: string;
  confidence: number;
} {
  if (producer.bind_to_account_field && consumer.bind_to_account_field && producer.bind_to_account_field === consumer.bind_to_account_field) {
    return {
      matched: true,
      confidence: 0.95,
    };
  }

  if (producer.value_hash && consumer.value_hash && producer.value_hash === consumer.value_hash) {
    return {
      matched: true,
      confidence: 0.92,
    };
  }

  const producerValue = producer.value_preview || '';
  const consumerValue = consumer.value_preview || '';
  if (producerValue && consumerValue && consumerValue.includes(producerValue) && producerValue.length >= 8) {
    return {
      matched: true,
      value_template: buildValueTemplate(consumerValue, producerValue),
      confidence: 0.85,
    };
  }

  return {
    matched: false,
    confidence: 0,
  };
}

function buildRequestVariableSuggestions(
  hits: RecordingFieldHit[]
): RequestVariableSuggestion[] {
  return dedupeByKey(
    hits
      .filter(hit => hit.bind_to_account_field && !isAmbientRequestHit(hit))
      .map(hit => {
        const jsonPath = buildRequestVariablePath(hit);
        if (!jsonPath) return null;

        return {
          name: deriveCandidateName(hit.bind_to_account_field || hit.field_name),
          json_path: jsonPath,
          original_value: hit.value_preview || '',
          operation_type: 'replace' as const,
          data_source: 'account_field' as const,
          account_field_name: hit.bind_to_account_field,
          path_replacement_mode: hit.source_location === 'request.path' ? 'segment_index' : undefined,
          path_segment_index: extractPathSegmentIndex(hit),
        };
      })
      .filter(Boolean) as RequestVariableSuggestion[],
    item => `${item.name}:${item.json_path}:${item.account_field_name}`
  );
}

function buildWorkflowContextVariableCandidates(params: {
  session: RecordingSession;
  sortedEvents: RecordingEvent[];
  fieldHitsByEvent: Map<string, RecordingFieldHit[]>;
  extractorCandidates: Array<Omit<RecordingExtractorCandidate, 'id' | 'created_at' | 'updated_at'>>;
  role?: string;
}): Array<Omit<RecordingVariableCandidate, 'id' | 'created_at' | 'updated_at'>> {
  const { session, sortedEvents, fieldHitsByEvent, extractorCandidates, role } = params;
  const eventSequenceById = new Map(sortedEvents.map(event => [event.id, event.sequence]));

  const producers = extractorCandidates
    .map(candidate => {
      const sourceEventId = candidate.source_event_id || '';
      const hits = fieldHitsByEvent.get(sourceEventId) || [];
      const originHit = hits.find(hit => {
        const extractorSource = buildExtractorSource(hit);
        return extractorSource?.source === candidate.source &&
          extractorSource.expression === candidate.expression &&
          deriveCandidateName(hit.bind_to_account_field || hit.field_name || hit.source_key || '') === candidate.name;
      });

      if (!originHit) return null;

      return {
        candidate,
        originHit,
        sourceSequence: eventSequenceById.get(sourceEventId) || 0,
      };
    })
    .filter(Boolean) as Array<{
      candidate: Omit<RecordingExtractorCandidate, 'id' | 'created_at' | 'updated_at'>;
      originHit: RecordingFieldHit;
      sourceSequence: number;
    }>;

  const consumers = sortedEvents.flatMap(event =>
    (fieldHitsByEvent.get(event.id) || [])
      .map(hit => ({
        event,
        hit,
        jsonPath: buildRequestVariablePath(hit),
      }))
      .filter(item => item.jsonPath)
  ) as Array<{ event: RecordingEvent; hit: RecordingFieldHit; jsonPath: string }>;

  return dedupeByKey(
    producers.flatMap(producer =>
      [
        ...consumers.flatMap(consumer => {
          if (consumer.event.sequence <= producer.sourceSequence) {
            return [];
          }

          const match = matchesWorkflowContextValue(producer.originHit, consumer.hit);
          if (!match.matched) {
            return [];
          }

          return [{
            workflow_draft_id: '',
            workflow_draft_step_id: undefined,
            session_id: session.id,
            source_event_id: consumer.event.id,
            name: producer.candidate.name,
            data_source: 'workflow_context',
            source_location: consumer.hit.source_location,
            json_path: consumer.jsonPath,
            checklist_id: undefined,
            security_rule_id: undefined,
            account_field_name: undefined,
            runtime_context_key: producer.candidate.name,
            step_variable_mappings: [{
              step_order: consumer.event.sequence,
              json_path: consumer.jsonPath,
              original_value: consumer.hit.value_preview || '',
            }],
            advanced_config: match.value_template ? {
              value_template: match.value_template,
            } : undefined,
            role,
            confidence: Math.min(producer.candidate.confidence || 0.8, match.confidence),
          }];
        }),
        ...sortedEvents.flatMap(event => {
          if (event.sequence <= producer.sourceSequence) {
            return [];
          }

          return buildRequestPathVariableCandidates({
            event,
            variableName: producer.candidate.name,
            producerValue: producer.originHit.value_preview,
          }).map(pathConsumer => ({
            workflow_draft_id: '',
            workflow_draft_step_id: undefined,
            session_id: session.id,
            source_event_id: pathConsumer.event.id,
            name: producer.candidate.name,
            data_source: 'workflow_context',
            source_location: pathConsumer.sourceLocation,
            json_path: pathConsumer.jsonPath,
            checklist_id: undefined,
            security_rule_id: undefined,
            account_field_name: undefined,
            runtime_context_key: producer.candidate.name,
            step_variable_mappings: [{
              step_order: pathConsumer.event.sequence,
              json_path: pathConsumer.jsonPath,
              original_value: pathConsumer.originalValue,
            }],
            advanced_config: pathConsumer.advancedConfig,
            role,
            confidence: Math.min(producer.candidate.confidence || 0.8, pathConsumer.confidence),
          }));
        }),
      ]
    ),
    item => `${item.name}:${item.source_event_id}:${item.json_path}:${item.data_source}:${JSON.stringify(item.advanced_config || {})}`
  );
}

export function generateWorkflowDraftArtifacts(params: {
  session: RecordingSession;
  events: RecordingEvent[];
  fieldHits: RecordingFieldHit[];
  runtimeContexts: RecordingRuntimeContext[];
  dictionary: FieldDictionary;
}): GeneratedWorkflowArtifacts | null {
  const { session, events, fieldHits, runtimeContexts, dictionary } = params;
  if (events.length === 0) return null;

  const fieldHitsByEvent = new Map<string, RecordingFieldHit[]>();
  const runtimeContextsByEvent = new Map<string, RecordingRuntimeContext[]>();

  for (const hit of fieldHits) {
    const items = fieldHitsByEvent.get(hit.event_id) || [];
    items.push(hit);
    fieldHitsByEvent.set(hit.event_id, items);
  }

  for (const context of runtimeContexts) {
    if (!context.event_id) continue;
    const items = runtimeContextsByEvent.get(context.event_id) || [];
    items.push(context);
    runtimeContextsByEvent.set(context.event_id, items);
  }

  const grouped = buildWorkflowStepCandidates({
    events,
    fieldHitsByEvent,
    runtimeContextsByEvent,
  });
  if (grouped.candidates.length === 0) {
    return null;
  }

  const sortedEvents = grouped.candidates.map(candidate => ({
    ...candidate.representativeEvent,
    sequence: candidate.sequence,
  }));
  const groupedFieldHitsByEvent = new Map<string, RecordingFieldHit[]>();
  const groupedRuntimeContextsByEvent = new Map<string, RecordingRuntimeContext[]>();
  for (const candidate of grouped.candidates) {
    groupedFieldHitsByEvent.set(candidate.representativeEvent.id, candidate.fieldHits);
    groupedRuntimeContextsByEvent.set(candidate.representativeEvent.id, candidate.runtimeContexts);
  }

  const steps: Array<Omit<WorkflowDraftStep, 'id' | 'created_at' | 'updated_at'>> = [];
  const extractorCandidates: Array<Omit<RecordingExtractorCandidate, 'id' | 'created_at' | 'updated_at'>> = [];
  const variableCandidates: Array<Omit<RecordingVariableCandidate, 'id' | 'created_at' | 'updated_at'>> = [];
  const workflowPayloadSteps: JsonRecord[] = [];
  const role = buildRole(session);

  for (const candidate of grouped.candidates) {
    const event = {
      ...candidate.representativeEvent,
      sequence: candidate.sequence,
    };
    const eventHits = candidate.fieldHits;
    const eventContexts = candidate.runtimeContexts;
    const variableSuggestions = buildRequestVariableSuggestions(eventHits);
    const stepName = buildWorkflowStepName(session.name, candidate.businessAction, candidate.sequence, event.path);

    const stepSummary = {
      sequence: candidate.sequence,
      method: event.method,
      path: event.path,
      response_status: event.response_status,
      field_hit_count: eventHits.length,
      runtime_context_count: eventContexts.length,
      merged_event_count: candidate.mergedEvents.length,
      merged_event_sequences: candidate.mergedEvents.map(item => item.sequence),
      business_action: candidate.businessAction,
      step_name: stepName,
      field_hits: dedupeByKey(eventHits.map(hit => hit.field_name), value => value),
      runtime_context_keys: dedupeByKey(eventContexts.map(context => context.context_key), value => value),
    };

    steps.push({
      workflow_draft_id: '',
      session_id: session.id,
      source_event_id: event.id,
      sequence: candidate.sequence,
      method: event.method,
      path: event.path,
      enabled: true,
      summary: stepSummary,
      request_template_payload: {
        name: stepName,
        description: `Recorded from ${event.method} ${event.path}`,
        raw_request: buildRawRequest(event),
        parsed_structure: {
          method: event.method,
          path: event.path,
          headers: event.request_headers,
          body: event.parsed_request_body || event.request_body_text || '',
        },
        variables: variableSuggestions,
        failure_patterns: [],
        failure_logic: 'OR',
        is_active: true,
      },
      response_signature: responseSignature(event),
    });

    for (const hit of eventHits) {
      const dictionaryMatch = dictionary.match(hit.field_name) || (hit.source_key ? dictionary.match(hit.source_key) : null);

      const requestJsonPath = buildRequestVariablePath(hit);
      if (requestJsonPath && hit.bind_to_account_field && !isAmbientRequestHit(hit)) {
        variableCandidates.push({
          workflow_draft_id: '',
          workflow_draft_step_id: undefined,
          session_id: session.id,
          source_event_id: event.id,
          name: deriveCandidateName(hit.bind_to_account_field || hit.field_name),
          data_source: 'account_field',
          source_location: hit.source_location,
          json_path: requestJsonPath,
          account_field_name: hit.bind_to_account_field,
          runtime_context_key: undefined,
          checklist_id: undefined,
          security_rule_id: undefined,
          step_variable_mappings: [{
            step_order: event.sequence,
            json_path: requestJsonPath,
            original_value: hit.value_preview || '',
          }],
          role,
          confidence: hit.confidence || 0.9,
        });
      }

      const extractorSource = buildExtractorSource(hit);
      if (extractorSource && (dictionaryMatch?.category !== 'NOISE' || hit.bind_to_account_field)) {
        extractorCandidates.push({
          workflow_draft_id: '',
          workflow_draft_step_id: undefined,
          session_id: session.id,
          source_event_id: event.id,
          step_sequence: candidate.sequence,
          name: deriveCandidateName(hit.bind_to_account_field || hit.field_name || hit.source_key || `step_${event.sequence}`),
          source: extractorSource.source,
          expression: extractorSource.expression,
          transform: undefined,
          required: false,
          confidence: hit.confidence || 0.75,
          value_preview: hit.value_preview,
        });
      }
    }

    workflowPayloadSteps.push({
      sequence: candidate.sequence,
      method: event.method,
      path: event.path,
      enabled: true,
      response_status: event.response_status,
      step_name: stepName,
      request_template: steps[steps.length - 1].request_template_payload,
      merged_event_sequences: candidate.mergedEvents.map(item => item.sequence),
      merged_event_count: candidate.mergedEvents.length,
      business_action: candidate.businessAction,
      field_hits: eventHits.map(hit => ({
        field_name: hit.field_name,
        source_location: hit.source_location,
        source_key: hit.source_key,
        value_preview: hit.value_preview,
        bind_to_account_field: hit.bind_to_account_field,
      })),
      extractor_candidates: extractorCandidates
        .filter(candidate => candidate.source_event_id === event.id)
        .map(candidate => ({
          name: candidate.name,
          source: candidate.source,
          expression: candidate.expression,
          confidence: candidate.confidence,
        })),
      variable_injections: variableCandidates
        .filter(candidate => candidate.source_event_id === event.id)
        .map(candidate => ({
          name: candidate.name,
          data_source: candidate.data_source,
          json_path: candidate.json_path,
          account_field_name: candidate.account_field_name,
          confidence: candidate.confidence,
      })),
    });
  }

  variableCandidates.push(...buildWorkflowContextVariableCandidates({
    session,
    sortedEvents,
    fieldHitsByEvent: groupedFieldHitsByEvent,
    extractorCandidates,
    role,
  }));

  const bodyJsonPaths = dedupeByKey(
    extractorCandidates
      .filter(candidate => candidate.source === 'response_body_jsonpath')
      .map(candidate => candidate.expression),
    value => value
  );
  const headerKeys = dedupeByKey(
    runtimeContexts
      .filter(context => context.source_location === 'response.header')
      .map(context => context.context_key.toLowerCase()),
    value => value
  );
  const enableSessionJar = runtimeContexts.some(context => context.source_location === 'response.cookie');

  const workflowPayload = {
    workflow: {
      name: `${session.name} Workflow`,
      description: `Published from recording session ${session.name}`,
      is_active: true,
      assertion_strategy: 'any_step_pass',
      enable_extractor: extractorCandidates.length > 0,
      enable_session_jar: enableSessionJar,
      session_jar_config: {
        cookie_mode: enableSessionJar,
        header_keys: headerKeys,
        body_json_paths: bodyJsonPaths,
      },
      template_mode: 'snapshot',
    },
    steps: workflowPayloadSteps,
    variable_candidates: variableCandidates.map(candidate => ({
      name: candidate.name,
      data_source: candidate.data_source,
      json_path: candidate.json_path,
      account_field_name: candidate.account_field_name,
      runtime_context_key: candidate.runtime_context_key,
      source_location: candidate.source_location,
      step_variable_mappings: candidate.step_variable_mappings,
      advanced_config: candidate.advanced_config,
      confidence: candidate.confidence,
    })),
    extractor_candidates: extractorCandidates.map(candidate => ({
      name: candidate.name,
      source: candidate.source,
      expression: candidate.expression,
      confidence: candidate.confidence,
      value_preview: candidate.value_preview,
    })),
  };

  return {
    draft: {
      session_id: session.id,
      name: `${session.name} Workflow Draft`,
      status: 'generated',
      summary: {
        step_count: steps.length,
        enabled_step_count: steps.filter(step => step.enabled).length,
        filtered_event_count: grouped.skippedCount,
        merged_event_count: grouped.mergedAwayCount,
        original_event_count: events.length,
        variable_candidate_count: variableCandidates.length,
        extractor_candidate_count: extractorCandidates.length,
      },
      draft_payload: workflowPayload,
      published_workflow_id: undefined,
    },
    steps,
    extractorCandidates: dedupeByKey(
      extractorCandidates,
      item => `${item.source_event_id}:${item.name}:${item.source}:${item.expression}`
    ),
    variableCandidates: dedupeByKey(
      variableCandidates,
      item => `${item.source_event_id}:${item.name}:${item.data_source}:${item.json_path}:${item.account_field_name || item.runtime_context_key || ''}`
    ),
  };
}

export function generateApiDraftArtifacts(params: {
  session: RecordingSession;
  events: RecordingEvent[];
  fieldHits: RecordingFieldHit[];
}): GeneratedApiDraftArtifacts {
  const { session, events, fieldHits } = params;
  const fieldHitsByEvent = new Map<string, RecordingFieldHit[]>();

  for (const hit of fieldHits) {
    const items = fieldHitsByEvent.get(hit.event_id) || [];
    items.push(hit);
    fieldHitsByEvent.set(hit.event_id, items);
  }

  function buildApiResponseSnapshot(event: RecordingEvent): JsonRecord {
    return {
      status: event.response_status || null,
      headers: event.response_headers || {},
      body: event.parsed_response_body || event.response_body_text || '',
      body_preview: event.response_body_text?.slice(0, 1000) || '',
      is_json: !!event.parsed_response_body,
    };
  }

  function buildApiFieldCandidates(eventHits: RecordingFieldHit[]): JsonRecord[] {
    return dedupeByKey(
      eventHits
        .filter(hit => !isAmbientRequestHit(hit))
        .map(hit => {
          const jsonPath = buildRequestVariablePath(hit);
          if (!jsonPath) return null;

          return {
            name: deriveCandidateName(hit.bind_to_account_field || hit.field_name || hit.source_key || 'field'),
            field_name: hit.field_name,
            source_location: hit.source_location,
            source_key: hit.source_key,
            json_path: jsonPath,
            bind_to_account_field: hit.bind_to_account_field,
            value_preview: hit.value_preview,
            confidence: hit.confidence || 0.8,
          };
        })
        .filter(Boolean) as JsonRecord[],
      item => `${item.field_name}:${item.json_path}:${item.bind_to_account_field || ''}`
    );
  }

  function buildApiAssertionCandidates(event: RecordingEvent): JsonRecord[] {
    const candidates: JsonRecord[] = [];

    if (event.response_status) {
      candidates.push({
        kind: 'status',
        label: `HTTP status should remain ${event.response_status}`,
        path: 'status',
        operator: 'equals',
        value: String(event.response_status),
        recommended_failure_pattern: {
          type: 'http_status',
          operator: 'not_equals',
          value: String(event.response_status),
        },
      });
    }

    const contentType = event.response_headers?.['content-type'] || event.response_headers?.['Content-Type'];
    if (contentType) {
      candidates.push({
        kind: 'header',
        label: `Response header content-type should contain ${contentType}`,
        path: 'headers.content-type',
        operator: 'contains',
        value: contentType,
      });
    }

    const responseBody = event.parsed_response_body;
    if (responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody)) {
      for (const [key, value] of Object.entries(responseBody)) {
        if (value === null || typeof value === 'object' || isAuthField(key)) {
          continue;
        }

        candidates.push({
          kind: 'body',
          label: `Response body ${key} should equal ${String(value)}`,
          path: `body.${key}`,
          operator: 'equals',
          value: String(value),
        });
      }
    }

    return candidates.slice(0, 6);
  }

  const drafts = [...events]
    .sort((a, b) => a.sequence - b.sequence)
    .map(event => {
      const eventHits = fieldHitsByEvent.get(event.id) || [];
      const requestVariables = buildRequestVariableSuggestions(eventHits);
      const fieldCandidates = buildApiFieldCandidates(eventHits);
      const assertionCandidates = buildApiAssertionCandidates(event);
      const responseSnapshot = buildApiResponseSnapshot(event);
      const pathName = sanitizePathSegment(event.path || event.url) || `step ${event.sequence}`;
      const templateName = `${session.name} ${event.method} ${toTitleCase(pathName)}`.trim();

      return {
        session_id: session.id,
        name: `${templateName} Draft`,
        status: 'preconfigured' as const,
        sequence: event.sequence,
        source_event_id: event.id,
        summary: {
          method: event.method,
          path: event.path,
          response_status: event.response_status,
          environment_id: session.environment_id,
          account_id: session.account_id,
          field_candidate_count: fieldCandidates.length,
          assertion_candidate_count: assertionCandidates.length,
          variable_suggestion_count: requestVariables.length,
        },
        draft_payload: {
          context: {
            session_id: session.id,
            source_event_id: event.id,
            sequence: event.sequence,
            environment_id: session.environment_id,
            account_id: session.account_id,
            method: event.method,
            path: event.path,
          },
          template: {
            name: templateName,
            description: `Recorded from ${event.method} ${event.path}`,
            raw_request: buildRawRequest(event),
            parsed_structure: {
              method: event.method,
              path: event.path,
              headers: event.request_headers,
              body: event.parsed_request_body || event.request_body_text || '',
            },
            variables: requestVariables,
            response_snapshot: responseSnapshot,
            field_candidates: fieldCandidates,
            assertion_candidates: assertionCandidates,
            failure_patterns: event.response_status ? [{
              type: 'http_status',
              operator: 'not_equals',
              value: String(event.response_status),
            }] : [],
            failure_logic: 'OR',
            is_active: true,
          },
          preset: {
            name: `${templateName} Preset`,
            description: `Published from recording session ${session.name}`,
            environment_id: session.environment_id,
            default_account_id: session.account_id,
            preset_config: {
              source_recording_session_id: session.id,
              source_event_sequence: event.sequence,
              recorded_response_status: event.response_status,
            },
          },
        },
        published_test_run_id: undefined,
      };
    });

  return { drafts };
}
