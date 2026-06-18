import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = '/tmp/bstg_prd123/server/dist';
async function mod(rel) { return import(pathToFileURL(path.join(root, rel)).href); }

const [{ MemoryProvider }, suggestion, apiSeed, learningRecording] = await Promise.all([
  mod('db/memory-provider.js'),
  mod('services/recording-suggestion-engine.js'),
  mod('services/api-test-seed-service.js'),
  mod('services/learning-source-recording.js'),
]);

const { getRecordingSessionAccountDraft, publishRecordingSessionAccountDraft } = suggestion;
const { createApiTestDrafts, publishApiTestDraft } = apiSeed;
const { buildRecordingLearningSuggestions } = learningRecording;

const db = new MemoryProvider('memory', {});
await db.connect();
const now = new Date().toISOString();

// PRD1 account capture
const session1 = await db.repos.recordingSessions.create({
  name: 'Capture Account Session', mode: 'api', intent: 'account_capture', status: 'recording', source_tool: 'burp_montoya',
  account_label: 'Alice Account', requested_field_names: ['user_id', 'authorization'], capture_filters: {}, environment_id: undefined, account_id: undefined,
  role: 'primary', target_fields: [], event_count: 1, field_hit_count: 2, runtime_context_count: 1, generated_result_count: 0, published_result_count: 0, summary: {}, started_at: now,
});
const event1 = await db.repos.recordingEvents.create({
  session_id: session1.id, sequence: 1, fingerprint: 'fp-account-1', source_tool: 'burp_montoya', method: 'GET', url: 'https://example.test/api/profile?userId=1001', scheme: 'https', host: 'example.test', path: '/api/profile', query_params: { userId: ['1001'] }, request_headers: { authorization: 'Bearer live-token-1' }, request_body_text: undefined, request_cookies: {}, parsed_request_body: null, response_status: 200, response_headers: { 'content-type': 'application/json' }, response_body_text: '{"userId":"1001","name":"Alice"}', response_cookies: {}, parsed_response_body: { userId: '1001', name: 'Alice' }, field_hit_count: 2,
});
await db.repos.recordingFieldHits.create({ session_id: session1.id, event_id: event1.id, field_name: 'userId', matched_alias: 'user_id', source_location: 'response.body', source_key: 'userId', value_preview: '1001', value_text: '1001', value_hash: 'hash-user-1001', bind_to_account_field: 'user_id', confidence: 0.95 });
await db.repos.recordingFieldHits.create({ session_id: session1.id, event_id: event1.id, field_name: 'authorization', matched_alias: 'authorization', source_location: 'request.header', source_key: 'authorization', value_preview: 'Bearer live-token-1', value_text: 'Bearer live-token-1', value_hash: 'hash-auth-1', bind_to_account_field: 'authorization', confidence: 0.99 });
await db.repos.recordingRuntimeContext.create({ session_id: session1.id, event_id: event1.id, context_key: 'authorization', category: 'auth', source_location: 'request.header', value_preview: 'Bearer live-token-1', value_text: 'Bearer live-token-1', bind_to_account_field: 'authorization' });
const accountDraft = await getRecordingSessionAccountDraft(db, session1.id, { regenerate: true });
assert.equal(accountDraft.fields.user_id, '1001');
const accountPublish = await publishRecordingSessionAccountDraft(db, session1.id, { saveMode: 'create_new', actor: 'validation-script' });
assert.equal(accountPublish.persisted, true);

// PRD2 api test seed
const session2 = await db.repos.recordingSessions.create({
  name: 'API Test Seed Session', mode: 'api', intent: 'api_test_seed', status: 'recording', source_tool: 'burp_montoya',
  account_label: 'Alice Seed', requested_field_names: ['user_id', 'authorization'], capture_filters: {}, environment_id: undefined, account_id: accountPublish.account?.id,
  role: 'primary', target_fields: [], event_count: 1, field_hit_count: 2, runtime_context_count: 1, generated_result_count: 0, published_result_count: 0, summary: {}, started_at: now,
});
const event2 = await db.repos.recordingEvents.create({
  session_id: session2.id, sequence: 1, fingerprint: 'fp-api-1', source_tool: 'burp_montoya', method: 'POST', url: 'https://example.test/api/orders', scheme: 'https', host: 'example.test', path: '/api/orders', query_params: {}, request_headers: { authorization: 'Bearer live-token-1', 'content-type': 'application/json' }, request_body_text: '{"userId":"1001","orderId":"ORD-1","amount":99}', request_cookies: {}, parsed_request_body: { userId: '1001', orderId: 'ORD-1', amount: 99 }, response_status: 200, response_headers: { 'content-type': 'application/json' }, response_body_text: '{"success":true,"code":0,"orderId":"ORD-1"}', response_cookies: {}, parsed_response_body: { success: true, code: 0, orderId: 'ORD-1' }, field_hit_count: 2,
});
await db.repos.recordingFieldHits.create({ session_id: session2.id, event_id: event2.id, field_name: 'userId', matched_alias: 'user_id', source_location: 'request.body', source_key: '$.userId', value_preview: '1001', value_text: '1001', value_hash: 'hash-user-1001', bind_to_account_field: 'user_id', confidence: 0.96 });
await db.repos.recordingFieldHits.create({ session_id: session2.id, event_id: event2.id, field_name: 'authorization', matched_alias: 'authorization', source_location: 'request.header', source_key: 'authorization', value_preview: 'Bearer live-token-1', value_text: 'Bearer live-token-1', value_hash: 'hash-auth-1', bind_to_account_field: 'authorization', confidence: 0.99 });
await db.repos.recordingRuntimeContext.create({ session_id: session2.id, event_id: event2.id, context_key: 'authorization', category: 'auth', source_location: 'request.header', value_preview: 'Bearer live-token-1', value_text: 'Bearer live-token-1', bind_to_account_field: 'authorization' });
const generated = await createApiTestDrafts(db, session2.id, { eventIds: [event2.id], generatePreset: true, generateAssertions: true, generateFailurePatterns: true });
assert.equal(generated.drafts.length, 1);
const publishResult = await publishApiTestDraft(db, generated.drafts[0].id, { createPreset: false, template_name: 'Order Create Template', published_by: 'validation-script' });
assert.ok(publishResult.template?.id);

// PRD3 workflow learning from recording
const workflowSession = await db.repos.recordingSessions.create({
  name: 'Workflow Learn Session', mode: 'workflow', intent: 'learning_seed', status: 'finished', source_tool: 'burp_montoya',
  account_label: 'Alice Flow', requested_field_names: ['authorization', 'order_id'], capture_filters: {}, environment_id: undefined, account_id: accountPublish.account?.id,
  role: 'primary', target_fields: [], event_count: 2, field_hit_count: 4, runtime_context_count: 1, generated_result_count: 0, published_result_count: 0, summary: {}, started_at: now,
});
const template1 = await db.repos.apiTemplates.create({ name: 'Create Order', raw_request: 'POST /api/orders HTTP/1.1\nHost: example.test\nAuthorization: Bearer {{auth.authorization}}\nContent-Type: application/json\n\n{"userId":"{{auth.user_id}}"}', parsed_structure: {}, variables: [], failure_patterns: [], failure_logic: 'OR', is_active: true, enable_baseline: false, baseline_config: {}, advanced_config: {}, source_recording_session_id: workflowSession.id });
const template2 = await db.repos.apiTemplates.create({ name: 'Fetch Order', raw_request: 'GET /api/orders/{{obj.order_id}} HTTP/1.1\nHost: example.test\nAuthorization: Bearer {{auth.authorization}}\n\n', parsed_structure: {}, variables: [], failure_patterns: [], failure_logic: 'OR', is_active: true, enable_baseline: false, baseline_config: {}, advanced_config: {}, source_recording_session_id: workflowSession.id });
const workflow = await db.repos.workflows.create({ name: 'Order Flow', description: 'Validation flow', is_active: true, assertion_strategy: 'any_step_pass', critical_step_orders: [], account_binding_strategy: 'per_account', attacker_account_id: undefined, enable_baseline: false, baseline_config: {}, enable_extractor: false, enable_session_jar: false, session_jar_config: {}, workflow_type: 'baseline', base_workflow_id: undefined, learning_status: 'unlearned', learning_version: 0, learning_source_preference: 'recording_only', last_learning_session_id: undefined, last_learning_mode: undefined, template_mode: 'snapshot', mutation_profile: null, source_recording_session_id: workflowSession.id });
const ws1 = await db.repos.workflowSteps.create({ workflow_id: workflow.id, api_template_id: template1.id, step_order: 1, step_assertions: [], assertions_mode: 'all', failure_patterns_override: [], request_snapshot_raw: 'POST /api/orders HTTP/1.1\nHost: example.test\nAuthorization: Bearer live-token-1\nContent-Type: application/json\n\n{"userId":"1001"}', failure_patterns_snapshot: [], snapshot_template_name: 'Create Order', snapshot_template_id: template1.id, snapshot_created_at: now });
const ws2 = await db.repos.workflowSteps.create({ workflow_id: workflow.id, api_template_id: template2.id, step_order: 2, step_assertions: [], assertions_mode: 'all', failure_patterns_override: [], request_snapshot_raw: 'GET /api/orders/ORD-1 HTTP/1.1\nHost: example.test\nAuthorization: Bearer live-token-1\n\n', failure_patterns_snapshot: [], snapshot_template_name: 'Fetch Order', snapshot_template_id: template2.id, snapshot_created_at: now });
const event3 = await db.repos.recordingEvents.create({ session_id: workflowSession.id, sequence: 1, fingerprint: 'fp-wf-1', source_tool: 'burp_montoya', method: 'POST', url: 'https://example.test/api/orders', scheme: 'https', host: 'example.test', path: '/api/orders', query_params: {}, request_headers: { authorization: 'Bearer live-token-1', 'content-type': 'application/json' }, request_body_text: '{"userId":"1001"}', request_cookies: {}, parsed_request_body: { userId: '1001' }, response_status: 200, response_headers: { 'content-type': 'application/json' }, response_body_text: '{"order":{"id":"ORD-1"}}', response_cookies: { session: 'sess-1' }, parsed_response_body: { order: { id: 'ORD-1' } }, field_hit_count: 2 });
const event4 = await db.repos.recordingEvents.create({ session_id: workflowSession.id, sequence: 2, fingerprint: 'fp-wf-2', source_tool: 'burp_montoya', method: 'GET', url: 'https://example.test/api/orders/ORD-1', scheme: 'https', host: 'example.test', path: '/api/orders/ORD-1', query_params: {}, request_headers: { authorization: 'Bearer live-token-1' }, request_body_text: undefined, request_cookies: { session: 'sess-1' }, parsed_request_body: null, response_status: 200, response_headers: { 'content-type': 'application/json' }, response_body_text: '{"id":"ORD-1","status":"ok"}', response_cookies: {}, parsed_response_body: { id: 'ORD-1', status: 'ok' }, field_hit_count: 2 });
await db.repos.workflowDraftSteps.create({ workflow_draft_id: 'virtual', session_id: workflowSession.id, source_event_id: event3.id, sequence: 1, source_draft_id: undefined, template_id: template1.id, environment_id: undefined, default_account_id: accountPublish.account?.id, preset_config: {} });
await db.repos.workflowDraftSteps.create({ workflow_draft_id: 'virtual', session_id: workflowSession.id, source_event_id: event4.id, sequence: 2, source_draft_id: undefined, template_id: template2.id, environment_id: undefined, default_account_id: accountPublish.account?.id, preset_config: {} });
await db.repos.recordingRuntimeContext.create({ session_id: workflowSession.id, event_id: event4.id, context_key: 'order_id', category: 'object', source_location: 'request.path', value_preview: 'ORD-1', value_text: 'ORD-1', bind_to_account_field: undefined });
const learningPayload = await buildRecordingLearningSuggestions(db, workflow.id, workflowSession.id, { includeExtractors: true, includeSessionJar: true, includeAssertions: false });
assert.ok(learningPayload.suggestions.mappings.length >= 1);
assert.ok(learningPayload.suggestions.workflowVariables.some((item) => /order/i.test(item.variableName) || /obj\./.test(item.variableName)));
assert.ok(learningPayload.suggestions.extractors.length >= 1);

console.log(JSON.stringify({
  ok: true,
  account_capture: { account_id: accountPublish.account?.id },
  api_test_seed: { template_id: publishResult.template.id },
  workflow_learning: {
    workflow_id: workflow.id,
    mapping_count: learningPayload.suggestions.mappings.length,
    extractor_count: learningPayload.suggestions.extractors.length,
    session_jar: learningPayload.suggestions.sessionJar,
  },
}, null, 2));
