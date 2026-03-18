import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = '/tmp/bstg_work/server/dist';
async function mod(rel) { return import(pathToFileURL(path.join(root, rel)).href); }

const [{ MemoryProvider }, suggestion, apiSeed] = await Promise.all([
  mod('db/memory-provider.js'),
  mod('services/recording-suggestion-engine.js'),
  mod('services/api-test-seed-service.js'),
]);

const { getRecordingSessionAccountDraft, publishRecordingSessionAccountDraft } = suggestion;
const { createApiTestDrafts, publishApiTestDraft } = apiSeed;

const db = new MemoryProvider('memory', {});
await db.connect();

const now = new Date().toISOString();
const session1 = await db.repos.recordingSessions.create({
  name: 'Capture Account Session',
  mode: 'api',
  intent: 'account_capture',
  status: 'recording',
  source_tool: 'burp_montoya',
  account_label: 'Alice Account',
  requested_field_names: ['user_id', 'authorization'],
  capture_filters: {},
  environment_id: undefined,
  account_id: undefined,
  role: 'primary',
  target_fields: [],
  event_count: 1,
  field_hit_count: 2,
  runtime_context_count: 1,
  generated_result_count: 0,
  published_result_count: 0,
  summary: {},
  started_at: now,
});
const event1 = await db.repos.recordingEvents.create({
  session_id: session1.id,
  sequence: 1,
  fingerprint: 'fp-account-1',
  source_tool: 'burp_montoya',
  method: 'GET',
  url: 'https://example.test/api/profile?userId=1001',
  scheme: 'https',
  host: 'example.test',
  path: '/api/profile',
  query_params: { userId: ['1001'] },
  request_headers: { authorization: 'Bearer live-token-1' },
  request_body_text: undefined,
  request_cookies: {},
  parsed_request_body: null,
  response_status: 200,
  response_headers: { 'content-type': 'application/json' },
  response_body_text: '{"userId":"1001","name":"Alice"}',
  response_cookies: {},
  parsed_response_body: { userId: '1001', name: 'Alice' },
  field_hit_count: 2,
});
await db.repos.recordingFieldHits.create({
  session_id: session1.id,
  event_id: event1.id,
  field_name: 'userId',
  matched_alias: 'user_id',
  source_location: 'response.body',
  source_key: 'userId',
  value_preview: '1001',
  value_text: '1001',
  value_hash: 'hash-user-1001',
  bind_to_account_field: 'user_id',
  confidence: 0.95,
});
await db.repos.recordingFieldHits.create({
  session_id: session1.id,
  event_id: event1.id,
  field_name: 'authorization',
  matched_alias: 'authorization',
  source_location: 'request.header',
  source_key: 'authorization',
  value_preview: 'Bearer live-token-1',
  value_text: 'Bearer live-token-1',
  value_hash: 'hash-auth-1',
  bind_to_account_field: 'authorization',
  confidence: 0.99,
});
await db.repos.recordingRuntimeContext.create({
  session_id: session1.id,
  event_id: event1.id,
  context_key: 'authorization',
  category: 'auth',
  source_location: 'request.header',
  value_preview: 'Bearer live-token-1',
  value_text: 'Bearer live-token-1',
  bind_to_account_field: 'authorization',
});

const accountDraft = await getRecordingSessionAccountDraft(db, session1.id, { regenerate: true });
assert.equal(accountDraft.intent, 'account_capture');
assert.equal(accountDraft.fields.user_id, '1001');
assert.equal(accountDraft.auth_profile.headers.authorization, 'Bearer live-token-1');
const accountPublish = await publishRecordingSessionAccountDraft(db, session1.id, {
  saveMode: 'create_new',
  actor: 'validation-script',
});
assert.equal(accountPublish.persisted, true);
assert.ok(accountPublish.account?.id);
assert.equal(accountPublish.account?.fields?.user_id, '1001');

const session2 = await db.repos.recordingSessions.create({
  name: 'API Test Seed Session',
  mode: 'api',
  intent: 'api_test_seed',
  status: 'recording',
  source_tool: 'burp_montoya',
  account_label: 'Alice Seed',
  requested_field_names: ['user_id', 'authorization'],
  capture_filters: {},
  environment_id: undefined,
  account_id: accountPublish.account?.id,
  role: 'primary',
  target_fields: [],
  event_count: 1,
  field_hit_count: 2,
  runtime_context_count: 1,
  generated_result_count: 0,
  published_result_count: 0,
  summary: {},
  started_at: now,
});
const event2 = await db.repos.recordingEvents.create({
  session_id: session2.id,
  sequence: 1,
  fingerprint: 'fp-api-1',
  source_tool: 'burp_montoya',
  method: 'POST',
  url: 'https://example.test/api/orders',
  scheme: 'https',
  host: 'example.test',
  path: '/api/orders',
  query_params: {},
  request_headers: { authorization: 'Bearer live-token-1', 'content-type': 'application/json' },
  request_body_text: '{"userId":"1001","orderId":"ORD-1","amount":99}',
  request_cookies: {},
  parsed_request_body: { userId: '1001', orderId: 'ORD-1', amount: 99 },
  response_status: 200,
  response_headers: { 'content-type': 'application/json' },
  response_body_text: '{"success":true,"code":0,"orderId":"ORD-1"}',
  response_cookies: {},
  parsed_response_body: { success: true, code: 0, orderId: 'ORD-1' },
  field_hit_count: 2,
});
await db.repos.recordingFieldHits.create({
  session_id: session2.id,
  event_id: event2.id,
  field_name: 'userId',
  matched_alias: 'user_id',
  source_location: 'request.body',
  source_key: '$.userId',
  value_preview: '1001',
  value_text: '1001',
  value_hash: 'hash-user-1001',
  bind_to_account_field: 'user_id',
  confidence: 0.96,
});
await db.repos.recordingFieldHits.create({
  session_id: session2.id,
  event_id: event2.id,
  field_name: 'authorization',
  matched_alias: 'authorization',
  source_location: 'request.header',
  source_key: 'authorization',
  value_preview: 'Bearer live-token-1',
  value_text: 'Bearer live-token-1',
  value_hash: 'hash-auth-1',
  bind_to_account_field: 'authorization',
  confidence: 0.99,
});
await db.repos.recordingRuntimeContext.create({
  session_id: session2.id,
  event_id: event2.id,
  context_key: 'authorization',
  category: 'auth',
  source_location: 'request.header',
  value_preview: 'Bearer live-token-1',
  value_text: 'Bearer live-token-1',
  bind_to_account_field: 'authorization',
});

const generated = await createApiTestDrafts(db, session2.id, {
  eventIds: [event2.id],
  generatePreset: true,
  generateAssertions: true,
  generateFailurePatterns: true,
});
assert.equal(generated.drafts.length, 1);
const draft = generated.drafts[0];
assert.equal(draft.intent, 'api_test_seed');
assert.equal(draft.status, 'reviewing');
assert.ok(draft.suggestion_summary);
assert.ok(draft.draft_payload?.template);
const publishResult = await publishApiTestDraft(db, draft.id, {
  createPreset: false,
  template_name: 'Order Create Template',
  published_by: 'validation-script',
});
assert.ok(publishResult.template?.id);
assert.equal(publishResult.template?.name, 'Order Create Template');

const template = await db.repos.apiTemplates.findById(publishResult.template.id);
assert.ok(template);
assert.equal(template?.source_recording_session_id, session2.id);

console.log(JSON.stringify({
  ok: true,
  account_capture: {
    session_id: session1.id,
    account_id: accountPublish.account?.id,
    account_name: accountPublish.account?.name,
  },
  api_test_seed: {
    session_id: session2.id,
    draft_id: draft.id,
    template_id: publishResult.template.id,
    template_name: publishResult.template.name,
  },
}, null, 2));
