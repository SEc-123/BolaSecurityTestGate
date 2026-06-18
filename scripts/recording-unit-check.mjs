import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const serverDistRoot = path.join(repoRoot, 'server', 'dist');

if (!fs.existsSync(serverDistRoot)) {
  throw new Error('Missing server/dist. Run "npm run build" in the server directory before running this check.');
}

async function loadDistModule(relativePath) {
  const absolutePath = path.join(serverDistRoot, relativePath);
  return import(pathToFileURL(absolutePath).href);
}

const [
  extractorModule,
  generatorModule,
  dictionaryModule,
] = await Promise.all([
  loadDistModule(path.join('services', 'recording-field-extractor.js')),
  loadDistModule(path.join('services', 'recording-generator.js')),
  loadDistModule(path.join('services', 'field-dictionary.js')),
]);

const {
  normalizeRecordingFieldTargets,
  prepareRecordingArtifacts,
} = extractorModule;
const {
  generateWorkflowDraftArtifacts,
  generateApiDraftArtifacts,
} = generatorModule;
const { FieldDictionary } = dictionaryModule;

const dictionaryRules = [
  {
    id: 'dict_auth',
    scope: 'global',
    scope_id: null,
    pattern: '(?i)^(authorization|access_token|token|session|cookie)$',
    category: 'AUTH',
    priority: 100,
    is_enabled: 1,
    notes: 'Auth fields',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'dict_object',
    scope: 'global',
    scope_id: null,
    pattern: '(?i)^(user_id|userid|order_id|orderid)$',
    category: 'OBJECT_ID',
    priority: 90,
    is_enabled: 1,
    notes: 'Object identifiers',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'dict_noise',
    scope: 'global',
    scope_id: null,
    pattern: '(?i)^(status|progress)$',
    category: 'NOISE',
    priority: 10,
    is_enabled: 1,
    notes: 'Polling noise',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

const dictionary = new FieldDictionary({
  runRawQuery: async () => dictionaryRules,
});
await dictionary.load();

function buildSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'session-doc10',
    name: 'Doc10 Session',
    mode: 'workflow',
    status: 'recording',
    source_tool: 'burp_montoya',
    environment_id: 'env-doc10',
    account_id: 'account-doc10',
    role: 'attacker',
    target_fields: [],
    event_count: 0,
    field_hit_count: 0,
    runtime_context_count: 0,
    generated_result_count: 0,
    published_result_count: 0,
    summary: {},
    started_at: now,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function materializePreparedArtifacts(sessionId, preparedArtifacts) {
  const events = [];
  const fieldHits = [];
  const runtimeContexts = [];

  preparedArtifacts.forEach((artifact, artifactIndex) => {
    const now = new Date().toISOString();
    const eventId = `${sessionId}_event_${String(artifactIndex + 1).padStart(2, '0')}`;
    events.push({
      id: eventId,
      ...artifact.event,
      created_at: now,
      updated_at: now,
    });

    artifact.fieldHits.forEach((hit, hitIndex) => {
      fieldHits.push({
        id: `${eventId}_hit_${String(hitIndex + 1).padStart(2, '0')}`,
        ...hit,
        event_id: eventId,
        created_at: now,
        updated_at: now,
      });
    });

    artifact.runtimeContexts.forEach((context, contextIndex) => {
      runtimeContexts.push({
        id: `${eventId}_ctx_${String(contextIndex + 1).padStart(2, '0')}`,
        ...context,
        event_id: eventId,
        created_at: now,
        updated_at: now,
      });
    });
  });

  return {
    events,
    fieldHits,
    runtimeContexts,
  };
}

const normalizedTargets = normalizeRecordingFieldTargets('session-doc10', [
  {
    name: 'access_token',
    aliases: ['token', 'access_token', 'authorization'],
    from: ['response.body'],
    from_sources: ['request.header', 'response.body'],
    bind_to_account_field: 'access_token',
    category: 'AUTH',
  },
  {
    name: 'user_id',
    aliases: ['userId', 'user_id'],
    from_sources: ['request.query', 'request.body', 'response.body'],
    bind_to_account_field: 'user_id',
    category: 'OBJECT_ID',
  },
  {
    name: 'order_id',
    aliases: ['orderId', 'order_id'],
    from_sources: ['request.path', 'response.body'],
    bind_to_account_field: 'order_id',
    category: 'OBJECT_ID',
  },
]);

assert.equal(normalizedTargets.length, 3, 'Expected three normalized field targets');
assert.deepEqual(
  normalizedTargets[0].aliases,
  ['access_token', 'token', 'authorization'],
  'Expected aliases to be de-duplicated while preserving order'
);
assert.deepEqual(
  normalizedTargets[0].from_sources,
  ['request.header', 'response.body'],
  'Expected from/from_sources to be merged and de-duplicated'
);

const workflowPrepared = await Promise.all([
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-workflow',
    input: {
      sequence: 1,
      method: 'POST',
      url: 'http://app.test/api/login',
      requestHeaders: {
        'content-type': 'application/json',
      },
      requestBodyText: '{"username":"alice","password":"super-secret"}',
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"access_token":"token-live-doc10","userId":"user-live-doc10"}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-workflow',
    input: {
      sequence: 2,
      method: 'GET',
      url: 'http://app.test/api/orders?userId=user-live-doc10',
      requestHeaders: {
        authorization: 'Bearer token-live-doc10',
        accept: 'application/json',
      },
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"orders":[{"orderId":"order-live-doc10"}]}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-workflow',
    input: {
      sequence: 3,
      method: 'GET',
      url: 'http://app.test/api/orders/order-live-doc10/status',
      requestHeaders: {
        authorization: 'Bearer token-live-doc10',
        accept: 'application/json',
      },
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"status":"processing"}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-workflow',
    input: {
      sequence: 4,
      method: 'POST',
      url: 'http://app.test/api/orders/order-live-doc10/submit',
      requestHeaders: {
        authorization: 'Bearer token-live-doc10',
        'content-type': 'application/json',
      },
      requestBodyText: '{"userId":"user-live-doc10","confirm":true}',
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"ok":true,"orderId":"order-live-doc10"}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
]);

assert.match(
  workflowPrepared[0].event.request_body_text || '',
  /\[REDACTED\]/,
  'Expected request body secrets to be masked during preparation'
);
assert(
  workflowPrepared[0].runtimeContexts.some(context =>
    context.context_key === 'access_token' &&
    context.source_location === 'response.body'
  ),
  'Expected response access token to be promoted into runtime context'
);
assert(
  workflowPrepared[3].fieldHits.some(hit =>
    hit.source_location === 'request.path' &&
    hit.bind_to_account_field === 'order_id'
  ),
  'Expected request.path order_id hit to be extracted for submit step'
);

const workflowSession = buildSession({
  id: 'session-doc10-workflow',
  name: 'Doc10 Workflow Recording',
  mode: 'workflow',
});
const workflowMaterialized = materializePreparedArtifacts(workflowSession.id, workflowPrepared);
const workflowArtifacts = generateWorkflowDraftArtifacts({
  session: workflowSession,
  events: workflowMaterialized.events,
  fieldHits: workflowMaterialized.fieldHits,
  runtimeContexts: workflowMaterialized.runtimeContexts,
  dictionary,
});

assert(workflowArtifacts, 'Expected workflow artifacts to be generated');
assert.deepEqual(
  workflowArtifacts.steps.map(step => step.sequence),
  [1, 2, 3],
  'Expected workflow draft steps to be re-sequenced after polling events are removed'
);
assert.equal(
  workflowArtifacts.draft.summary.filtered_event_count,
  1,
  'Expected a single polling event to be filtered out'
);
assert(
  workflowArtifacts.variableCandidates.some(candidate =>
    candidate.data_source === 'workflow_context' &&
    candidate.name === 'access_token' &&
    candidate.json_path === 'headers.authorization'
  ),
  'Expected access_token workflow context injection into Authorization header'
);
assert(
  workflowArtifacts.variableCandidates.some(candidate =>
    candidate.data_source === 'workflow_context' &&
    candidate.name === 'order_id' &&
    candidate.json_path === 'path.order_id' &&
    candidate.source_location === 'request.path'
  ),
  'Expected order_id workflow context injection into request.path'
);
assert(
  workflowArtifacts.extractorCandidates.some(candidate => candidate.name === 'access_token'),
  'Expected workflow extractor candidates to include access_token'
);

const apiPrepared = await Promise.all([
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-api',
    input: {
      sequence: 3,
      method: 'POST',
      url: 'http://app.test/api/orders/order-live-doc10/submit',
      requestHeaders: {
        'content-type': 'application/json',
      },
      requestBodyText: '{"userId":"user-live-doc10","confirm":true}',
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"ok":true,"orderId":"order-live-doc10"}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-api',
    input: {
      sequence: 1,
      method: 'GET',
      url: 'http://app.test/api/users?userId=user-live-doc10',
      requestHeaders: {
        accept: 'application/json',
      },
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"userId":"user-live-doc10","displayName":"Alice"}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
  prepareRecordingArtifacts({
    sessionId: 'session-doc10-api',
    input: {
      sequence: 2,
      method: 'GET',
      url: 'http://app.test/api/orders/order-live-doc10',
      requestHeaders: {
        accept: 'application/json',
      },
      responseStatus: 200,
      responseHeaders: {
        'content-type': 'application/json',
      },
      responseBodyText: '{"orderId":"order-live-doc10","state":"ready"}',
    },
    targets: normalizedTargets,
    dictionary,
  }),
]);

const apiSession = buildSession({
  id: 'session-doc10-api',
  name: 'Doc10 API Recording',
  mode: 'api',
});
const apiMaterialized = materializePreparedArtifacts(apiSession.id, apiPrepared);
const apiArtifacts = generateApiDraftArtifacts({
  session: apiSession,
  events: apiMaterialized.events,
  fieldHits: apiMaterialized.fieldHits,
});

assert.deepEqual(
  apiArtifacts.drafts.map(draft => draft.sequence),
  [1, 2, 3],
  'Expected API draft generation to sort events by sequence'
);

const submitDraft = apiArtifacts.drafts.find(draft => draft.sequence === 3);
assert(submitDraft, 'Expected submit API draft to exist');
assert(
  submitDraft.draft_payload.template.field_candidates.some(candidate =>
    candidate.json_path === 'path.order_id'
  ),
  'Expected API field candidates to include request.path order_id'
);
assert(
  submitDraft.draft_payload.template.field_candidates.some(candidate =>
    candidate.json_path === 'body.userId'
  ),
  'Expected API field candidates to include request body userId'
);

const summary = {
  normalized_target_count: normalizedTargets.length,
  workflow: {
    filtered_event_count: workflowArtifacts.draft.summary.filtered_event_count,
    step_count: workflowArtifacts.steps.length,
    extractor_candidate_count: workflowArtifacts.extractorCandidates.length,
    variable_candidate_count: workflowArtifacts.variableCandidates.length,
  },
  api: {
    draft_count: apiArtifacts.drafts.length,
    ordered_sequences: apiArtifacts.drafts.map(draft => draft.sequence),
    submit_field_candidate_count: submitDraft.draft_payload.template.field_candidates.length,
  },
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
