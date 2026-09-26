import assert from 'node:assert/strict';
import http from 'node:http';
import {
  TargetScopeError,
  fetchInTargetScope,
  normalizeTargetBaseUrl,
} from '../../server/dist/services/ai-scan/target-scope.js';
import {
  isCorsOriginAllowed,
  resolveBindHost,
} from '../../server/dist/services/local-access-policy.js';
import { sanitizeForAIModel } from '../../server/dist/agent/model-context-sanitizer.js';
import { AIClient } from '../../server/dist/services/ai/ai-client.js';
import {
  finishDebugTrace,
  getTraceByRunId,
  recordRequest,
  startDebugTrace,
} from '../../server/dist/services/debug-trace.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const externalServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('external');
});
await listen(externalServer);
const externalPort = externalServer.address().port;

let providerRequestBody = '';
let providerAuthorization = '';
const providerServer = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    providerRequestBody = body;
    providerAuthorization = String(req.headers.authorization || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'test', object: 'chat.completion', created: 1, model: 'test-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
    }));
  });
});
await listen(providerServer);
const providerPort = providerServer.address().port;

const targetServer = http.createServer((req, res) => {
  if (req.url === '/same-origin-redirect') {
    res.writeHead(302, { location: '/final' });
    res.end();
    return;
  }
  if (req.url === '/cross-origin-redirect') {
    res.writeHead(302, { location: `http://127.0.0.1:${externalPort}/secret` });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('ok');
});
await listen(targetServer);
const targetPort = targetServer.address().port;
const targetBase = `http://127.0.0.1:${targetPort}/`;

try {
  assert.equal(normalizeTargetBaseUrl(targetBase), targetBase);
  assert.throws(() => normalizeTargetBaseUrl('file:///etc/passwd'), TargetScopeError);
  assert.throws(() => normalizeTargetBaseUrl('http://user:pass@127.0.0.1/'), TargetScopeError);

  const sameOrigin = await fetchInTargetScope(`${targetBase}same-origin-redirect`, {}, targetBase);
  assert.equal(sameOrigin.status, 200);
  assert.equal(await sameOrigin.text(), 'ok');

  await assert.rejects(
    () => fetchInTargetScope(`${targetBase}cross-origin-redirect`, {}, targetBase),
    error => error instanceof TargetScopeError && /Out-of-scope (active )?target URL blocked/.test(error.message),
  );

  assert.equal(resolveBindHost({}), '127.0.0.1');
  assert.equal(resolveBindHost({ BSTG_HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(isCorsOriginAllowed('http://127.0.0.1:5173', {}), true);
  assert.equal(isCorsOriginAllowed('http://localhost:3000', {}), true);
  assert.equal(isCorsOriginAllowed('https://evil.example', {}), false);
  assert.equal(isCorsOriginAllowed('https://trusted.example', { CORS_ORIGIN: 'https://trusted.example' }), true);
  assert.equal(isCorsOriginAllowed('https://evil.example', { CORS_ORIGIN: '*' }), true);

  const secretInput = {
    scan_config: {
      accounts: {
        attacker: { username: 'alice', password: 'AlicePass123', token: 'token-attacker' },
      },
      account_raw_requests: 'POST /login HTTP/1.1\r\nAuthorization: Bearer super-secret-token\r\nCookie: sid=secret-cookie\r\n\r\n{"password":"raw-secret","otp":"123456"}',
    },
    session_strategy: { mode: 'cookie_then_bearer', available: true },
    evidence: {
      headers: { 'set-cookie': 'sid=response-secret', 'content-type': 'application/json' },
      body: 'access_token=body-secret&message=kept',
    },
  };
  const sanitized = sanitizeForAIModel(secretInput);
  const serialized = JSON.stringify(sanitized);
  for (const forbidden of ['AlicePass123', 'token-attacker', 'super-secret-token', 'secret-cookie', 'raw-secret', '123456', 'response-secret', 'body-secret']) {
    assert.equal(serialized.includes(forbidden), false, `model context leaked ${forbidden}`);
  }
  assert.equal(serialized.includes('alice'), true);
  assert.equal(serialized.includes('message=kept'), true);
  assert.equal(serialized.includes('cookie_then_bearer'), true, 'non-secret session strategy metadata should remain available to the Agent');

  const aiClient = new AIClient({
    id: 'provider-test',
    name: 'provider-test',
    provider_type: 'openai_compat',
    base_url: `http://127.0.0.1:${providerPort}/v1`,
    api_key: 'provider-auth-key',
    model: 'test-model',
    is_enabled: true,
    is_default: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  await aiClient.chat({
    model: 'test-model',
    messages: [{ role: 'user', content: 'Authorization: Bearer outbound-secret\npassword=outbound-pass\nkeep=this-text' }],
    max_retries: 0,
  });
  assert.equal(providerAuthorization, 'Bearer provider-auth-key', 'provider credential must remain in the provider Authorization header');
  assert.equal(providerRequestBody.includes('outbound-secret'), false, 'AIClient must redact bearer credentials before model transport');
  assert.equal(providerRequestBody.includes('outbound-pass'), false, 'AIClient must redact password values before model transport');
  assert.equal(providerRequestBody.includes('keep=this-text'), true, 'AIClient redaction must preserve non-secret context');

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function createTrace(runId, delay) {
    startDebugTrace('workflow', runId, { test_run_id: runId });
    await sleep(delay);
    recordRequest('GET', `${targetBase}${runId}`, {}, undefined);
    await sleep(5);
    finishDebugTrace('workflow');
  }
  await Promise.all([createTrace('trace-a', 25), createTrace('trace-b', 5)]);
  const traceA = getTraceByRunId('workflow', 'trace-a');
  const traceB = getTraceByRunId('workflow', 'trace-b');
  assert.equal(traceA?.run_meta.run_id, 'trace-a');
  assert.equal(traceB?.run_meta.run_id, 'trace-b');
  assert.equal(traceA?.records[0]?.url.endsWith('/trace-a'), true);
  assert.equal(traceB?.records[0]?.url.endsWith('/trace-b'), true);

  console.log('P0 security boundary regression: PASS');
} finally {
  await Promise.all([close(targetServer), close(externalServer), close(providerServer)]);
}
