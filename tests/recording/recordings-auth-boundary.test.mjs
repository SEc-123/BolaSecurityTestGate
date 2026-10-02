import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from '../../server/node_modules/express/index.js';
import recordingRouter from '../../server/src/routes/recordings.ts';
import { dbManager } from '../../server/src/db/db-manager.ts';
import { SqliteProvider } from '../../server/src/db/sqlite-provider.ts';

const API_KEY = 'recording-route-test-api-key';
const ADMIN_KEY = 'recording-route-test-admin-key';
const PRIVATE_VALUE = 'private-recording-route-boundary-sentinel';

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function seedRecording(db) {
  const now = new Date().toISOString();
  const session = await db.repos.recordingSessions.create({
    name: 'Route authorization fixture',
    mode: 'api',
    intent: 'api_test_seed',
    status: 'finished',
    source_tool: 'recording-route-test',
    account_label: `account-${PRIVATE_VALUE}`,
    requested_field_names: ['access_token'],
    capture_filters: { fixture_secret: PRIVATE_VALUE },
    environment_id: undefined,
    account_id: undefined,
    role: 'operator',
    target_fields: [],
    event_count: 1,
    field_hit_count: 1,
    runtime_context_count: 1,
    generated_result_count: 0,
    published_result_count: 0,
    summary: {
      account_draft: {
        auth_profile: { access_token: PRIVATE_VALUE },
      },
    },
    started_at: now,
    finished_at: now,
  });

  const event = await db.repos.recordingEvents.create({
    session_id: session.id,
    sequence: 1,
    fingerprint: 'recording-route-test-event',
    source_tool: 'recording-route-test',
    method: 'POST',
    url: `https://recording-fixture.invalid/private?token=${PRIVATE_VALUE}`,
    scheme: 'https',
    host: 'recording-fixture.invalid',
    path: '/private',
    query_params: { token: [PRIVATE_VALUE] },
    request_headers: { authorization: `Bearer ${PRIVATE_VALUE}` },
    request_body_text: JSON.stringify({ secret: PRIVATE_VALUE }),
    request_cookies: { session: PRIVATE_VALUE },
    parsed_request_body: { secret: PRIVATE_VALUE },
    response_status: 200,
    response_headers: { 'content-type': 'application/json' },
    response_body_text: JSON.stringify({ access_token: PRIVATE_VALUE }),
    response_cookies: { session: PRIVATE_VALUE },
    parsed_response_body: { access_token: PRIVATE_VALUE },
    field_hit_count: 1,
  });

  await db.repos.recordingFieldHits.create({
    session_id: session.id,
    event_id: event.id,
    field_name: 'access_token',
    matched_alias: 'access_token',
    source_location: 'response.body',
    source_key: 'access_token',
    value_preview: PRIVATE_VALUE,
    value_text: PRIVATE_VALUE,
    value_hash: 'test-value-hash',
    bind_to_account_field: 'access_token',
    confidence: 1,
  });

  await db.repos.recordingRuntimeContext.create({
    session_id: session.id,
    event_id: event.id,
    context_key: 'access_token',
    category: 'access_token',
    source_location: 'response.body',
    value_preview: PRIVATE_VALUE,
    value_text: PRIVATE_VALUE,
    bind_to_account_field: 'access_token',
  });

  return session;
}

async function startRouter(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/recordings', recordingRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/recordings`,
    async close() {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
      await db.disconnect();
    },
  };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

test('recording routes require configured API/admin keys before returning captured values', { concurrency: false }, async (t) => {
  const originalApiKey = process.env.RECORDING_API_KEY;
  const originalAdminKey = process.env.RECORDING_ADMIN_API_KEY;
  process.env.RECORDING_API_KEY = API_KEY;
  process.env.RECORDING_ADMIN_API_KEY = ADMIN_KEY;

  const db = new SqliteProvider('recording-route-boundary', { file: ':memory:' });
  await db.connect();
  await db.migrate();
  const session = await seedRecording(db);

  const originalGetActive = dbManager.getActive;
  dbManager.getActive = () => db;
  const server = await startRouter(db);
  t.after(async () => {
    dbManager.getActive = originalGetActive;
    restoreEnv('RECORDING_API_KEY', originalApiKey);
    restoreEnv('RECORDING_ADMIN_API_KEY', originalAdminKey);
    await server.close();
  });

  const apiHeaders = { 'x-api-key': API_KEY };
  const rawHeaders = { ...apiHeaders, 'x-recording-admin-key': ADMIN_KEY };
  const rawPaths = [
    `/sessions/${session.id}`,
    `/sessions/${session.id}/events`,
    `/sessions/${session.id}/candidates`,
    `/sessions/${session.id}/export/raw`,
    `/sessions/${session.id}/account-draft`,
    '/test-run-drafts',
    '/ops/summary',
  ];

  const anonymousList = await request(server.baseUrl, '/sessions');
  assert.equal(anonymousList.response.status, 401);
  assert.equal(JSON.stringify(anonymousList.body).includes(PRIVATE_VALUE), false);

  const safeList = await request(server.baseUrl, '/sessions', { headers: apiHeaders });
  assert.equal(safeList.response.status, 200);
  assert.equal(safeList.body.data.length, 1);
  assert.equal(JSON.stringify(safeList.body).includes(PRIVATE_VALUE), false);
  assert.equal('summary' in safeList.body.data[0], false);
  assert.equal('capture_filters' in safeList.body.data[0], false);
  assert.equal('requested_field_names' in safeList.body.data[0], false);

  const created = await request(server.baseUrl, '/sessions', {
    method: 'POST',
    headers: { ...apiHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Safe response projection fixture',
      mode: 'workflow',
      capture_filters: { fixture_secret: PRIVATE_VALUE },
    }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(JSON.stringify(created.body).includes(PRIVATE_VALUE), false);
  assert.equal('capture_filters' in created.body.data, false);

  const publicConfig = await request(server.baseUrl, '/config');
  assert.equal(publicConfig.response.status, 200);
  assert.equal(JSON.stringify(publicConfig.body).includes(PRIVATE_VALUE), false);

  for (const path of rawPaths) {
    const anonymous = await request(server.baseUrl, path);
    assert.equal(anonymous.response.status, 401, `${path} rejects a missing API key`);
    assert.equal(JSON.stringify(anonymous.body).includes(PRIVATE_VALUE), false);

    const apiOnly = await request(server.baseUrl, path, { headers: apiHeaders });
    assert.equal(apiOnly.response.status, 403, `${path} rejects a missing admin key`);
    assert.equal(JSON.stringify(apiOnly.body).includes(PRIVATE_VALUE), false);
  }

  const badApiWithAdmin = await request(server.baseUrl, `/sessions/${session.id}/export/raw`, {
    headers: { 'x-api-key': 'wrong-api-key', 'x-recording-admin-key': ADMIN_KEY },
  });
  assert.equal(badApiWithAdmin.response.status, 401);
  assert.equal(JSON.stringify(badApiWithAdmin.body).includes(PRIVATE_VALUE), false);

  for (const path of rawPaths.slice(0, 4)) {
    const privileged = await request(server.baseUrl, path, { headers: rawHeaders });
    assert.equal(privileged.response.status, 200, `${path} permits both configured keys`);
    assert.equal(JSON.stringify(privileged.body).includes(PRIVATE_VALUE), true);
  }

  const batch = await request(server.baseUrl, `/sessions/${session.id}/events/batch`, {
    method: 'POST',
    headers: { ...apiHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      events: [{
        sequence: 2,
        method: 'GET',
        url: 'https://recording-fixture.invalid/safe-ingest',
        response_status: 204,
      }],
    }),
  });
  assert.equal(batch.response.status, 200);
  assert.equal(JSON.stringify(batch.body).includes(PRIVATE_VALUE), false);
  assert.equal('summary' in batch.body.data.session, false);
});
