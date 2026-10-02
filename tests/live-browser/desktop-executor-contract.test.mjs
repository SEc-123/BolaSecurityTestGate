// Local contract fixture only. It verifies the optional external desktop
// adapter's authentication and bridge gates; it does not run the Linux bundle
// or make any network request beyond this loopback server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DESKTOP_EXECUTOR_BRIDGE_SCHEMA,
  DesktopExecutorContractError,
  acquireBusinessEvidenceDesktopExecutor,
  loadDesktopExecutorConfigFromFile,
  parseDesktopExecutorConfig,
} from '../../server/src/services/ai-scan/browser/desktop-executor.ts';

const token = 'desktop-executor-private-test-token';
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bridge(extra = {}) {
  return {
    schema: DESKTOP_EXECUTOR_BRIDGE_SCHEMA,
    browser_instance_id: 'browser-run-1',
    cdp_ws_endpoint: 'ws://127.0.0.1:9222/devtools/browser/run-1',
    target_id: 'target-1',
    ownership: 'exclusive',
    network_capture: { mode: 'cdp_fetch', active: true, capture_id: 'capture-1', target_id: 'target-1' },
    ...extra,
  };
}

function state(extra = {}) {
  return { url: 'https://fixture.example.test/account', title: 'Fixture account', screen: [1280, 800], mouse: [20, 20], bridge: bridge(), ...extra };
}

function health(extra = {}) {
  return {
    ok: true,
    authentication: { required: true, scheme: 'bearer' },
    allowed_endpoints: ['health', 'state', 'screenshot', 'action'],
    bridge_schema: DESKTOP_EXECUTOR_BRIDGE_SCHEMA,
    ...extra,
  };
}

async function fixture(options = {}) {
  const requests = [];
  let nextState = options.state || state();
  let healthRequests = 0;
  let stateRequests = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing bearer' }));
      return;
    }
    const json = value => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    const rejected = (status, error) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error })); };
    if (req.method === 'GET' && req.url === '/health') {
      healthRequests += 1;
      if (options.failHealthAt && healthRequests >= options.failHealthAt) return rejected(503, 'health unavailable');
      return json(options.health || health());
    }
    if (req.method === 'GET' && req.url === '/state') {
      stateRequests += 1;
      if (options.failStateAt && stateRequests >= options.failStateAt) return rejected(503, 'state unavailable');
      const stateReply = Array.isArray(options.stateSequence) ? (options.stateSequence[stateRequests - 1] || nextState) : nextState;
      return json(stateReply);
    }
    if (req.method === 'GET' && req.url === '/screenshot.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(png); return;
    }
    if (req.method === 'POST' && req.url === '/action') {
      if (options.actionDelayMs) await new Promise(resolve => setTimeout(resolve, options.actionDelayMs));
      if (options.actionStatus) return rejected(options.actionStatus, 'action rejected');
      const actionState = options.actionResponseState || options.afterActionState || nextState;
      if (options.afterActionState) nextState = options.afterActionState;
      return json({ ok: true, action: JSON.parse(body).action, state: actionState });
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'route not allowlisted' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

function config(endpoint) {
  return { version: 1, endpoint, bearer_token: token, request_timeout_ms: 2_000 };
}

function attester(extra = {}) {
  return {
    async attest({ bridge: candidate }) {
      return {
        same_browser: true,
        network_capture_attached: true,
        browser_instance_id: candidate.browser_instance_id,
        target_id: candidate.target_id,
        capture_id: candidate.network_capture.capture_id,
        ...extra,
      };
    },
  };
}

async function acquire(target, overrides = {}) {
  return acquireBusinessEvidenceDesktopExecutor({
    config: config(target.endpoint),
    scope_base_url: 'https://fixture.example.test/',
    bridge_attester: attester(),
    ...overrides,
  });
}

function hasCode(code) {
  return error => error instanceof DesktopExecutorContractError && error.code === code;
}

test('business evidence desktop lease uses only the four authenticated allowlisted calls', async t => {
  const target = await fixture();
  t.after(target.close);
  const lease = await acquire(target);
  assert.equal(lease.bridge.browser_instance_id, 'browser-run-1');
  await lease.health();
  assert.deepEqual(await lease.state().then(value => value.screen), [1280, 800]);
  assert.deepEqual(await lease.screenshot(), png);
  const after = await lease.action({ action: 'click', x: 400, y: 300 });
  assert.equal(after.url, 'https://fixture.example.test/account');

  assert.ok(target.requests.length >= 5);
  assert.ok(target.requests.every(request => request.authorization === `Bearer ${token}`), 'health/state/screenshot/action all send a bearer token');
  assert.ok(target.requests.every(request => ['GET /health', 'GET /state', 'GET /screenshot.png', 'POST /action'].includes(`${request.method} ${request.path}`)),
    'the adapter never sends an arbitrary executor route');
  const action = target.requests.find(request => request.method === 'POST');
  assert.deepEqual(JSON.parse(action.body), { action: 'click', x: 400, y: 300 });
});

test('the supplied computer-use-offline health shape fails closed before it can be used', async t => {
  const target = await fixture({ health: { ok: true, scope: 'local virtual desktop', model_included: false } });
  t.after(target.close);
  await assert.rejects(() => acquire(target), hasCode('DESKTOP_EXECUTOR_HEALTH_AUTH_REQUIRED'));
  assert.deepEqual(target.requests.map(request => request.path), ['/health']);
});

test('a runtime with authenticated endpoints but no same-browser CDP/network bridge cannot enter evidence execution', async t => {
  let attested = false;
  const target = await fixture({ state: { url: 'https://fixture.example.test/account', title: 'old bundle', screen: [1280, 800] } });
  t.after(target.close);
  await assert.rejects(() => acquire(target, { bridge_attester: { async attest() { attested = true; return {}; } } }), hasCode('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_REQUIRED'));
  assert.equal(attested, false, 'the attester is never asked to bless an unbridged desktop');
  assert.deepEqual(target.requests.map(request => request.path), ['/health', '/state']);
});

test('an attestation must bind the identical browser target and Fetch capture', async t => {
  const target = await fixture();
  t.after(target.close);
  await assert.rejects(() => acquire(target, { bridge_attester: attester({ target_id: 'another-target' }) }), hasCode('DESKTOP_EXECUTOR_CDP_NETWORK_BRIDGE_UNATTESTED'));
  assert.deepEqual(target.requests.map(request => request.path), ['/health', '/state']);
});

test('desktop action payloads are bounded, cannot escape scope, and close a rejected lease', async t => {
  const target = await fixture();
  t.after(target.close);
  const lease = await acquire(target);
  await assert.rejects(() => lease.action({ action: 'press', key: 'control+l' }), hasCode('DESKTOP_EXECUTOR_INVALID_ACTION'));
  const requestsAfterFailure = target.requests.length;
  await assert.rejects(() => lease.state(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(target.requests.length, requestsAfterFailure, 'a failed local action closes the lease before any later executor request');

  const outsideLease = await acquire(target);
  await assert.rejects(() => outsideLease.action({ action: 'open', url: 'https://outside.example.test/' }), /outside|scope/i);
  await assert.rejects(() => outsideLease.health(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));

  const outOfBoundsLease = await acquire(target);
  await assert.rejects(() => outOfBoundsLease.action({ action: 'click', x: 9000, y: 1 }), hasCode('DESKTOP_EXECUTOR_INVALID_ACTION'));
  await assert.rejects(() => outOfBoundsLease.screenshot(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(target.requests.filter(request => request.path === '/action').length, 0, 'invalid visual actions stay client-side and never reach the executor');
});

test('action verifies target scope both before and after execution, then closes an out-of-scope lease', async t => {
  const preScopeTarget = await fixture({ stateSequence: [state(), state({ url: 'https://outside.example.test/before-action' })] });
  t.after(preScopeTarget.close);
  const preScopeLease = await acquire(preScopeTarget);
  await assert.rejects(() => preScopeLease.action({ action: 'wait', seconds: 0 }), hasCode('DESKTOP_EXECUTOR_OUT_OF_SCOPE'));
  assert.equal(preScopeTarget.requests.filter(request => request.path === '/action').length, 0, 'an out-of-scope pre-action state blocks the visual action');

  const target = await fixture({ afterActionState: state({ url: 'https://outside.example.test/escaped' }) });
  t.after(target.close);
  const lease = await acquire(target);
  await assert.rejects(() => lease.action({ action: 'wait', seconds: 0 }), hasCode('DESKTOP_EXECUTOR_OUT_OF_SCOPE'));
  const requestsAfterFailure = target.requests.length;
  await assert.rejects(() => lease.screenshot(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(target.requests.length, requestsAfterFailure, 'an out-of-scope action result cannot be followed by another executor call');
  assert.equal(target.requests.filter(request => request.path === '/action').length, 1);

  const delayedScopeTarget = await fixture({
    actionResponseState: state({ url: 'https://fixture.example.test/account/updated' }),
    afterActionState: state({ url: 'https://outside.example.test/escaped-after-response' }),
  });
  t.after(delayedScopeTarget.close);
  const delayedScopeLease = await acquire(delayedScopeTarget);
  await assert.rejects(() => delayedScopeLease.action({ action: 'wait', seconds: 0 }), hasCode('DESKTOP_EXECUTOR_OUT_OF_SCOPE'));
  const actionIndex = delayedScopeTarget.requests.findIndex(request => request.path === '/action');
  assert.equal(delayedScopeTarget.requests.at(actionIndex + 1)?.path, '/state', 'the authenticated post-action state is fetched independently of the action response');
});

test('a browser or capture rebinding after an action invalidates the evidence lease', async t => {
  const target = await fixture({ afterActionState: state({ bridge: bridge({ target_id: 'target-replaced', network_capture: { mode: 'cdp_fetch', active: true, capture_id: 'capture-replaced', target_id: 'target-replaced' } }) }) });
  t.after(target.close);
  const lease = await acquire(target);
  await assert.rejects(() => lease.action({ action: 'wait', seconds: 0 }), hasCode('DESKTOP_EXECUTOR_BROWSER_BINDING_CHANGED'));
  const requestsAfterFailure = target.requests.length;
  await assert.rejects(() => lease.state(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(target.requests.length, requestsAfterFailure, 'a bridge mismatch permanently closes the evidence lease');
  assert.equal(target.requests.filter(request => request.path === '/action').length, 1);
});

test('health, action, and state transport failures close an evidence lease instead of allowing recovery', async t => {
  const healthTarget = await fixture({ failHealthAt: 2 });
  t.after(healthTarget.close);
  const healthLease = await acquire(healthTarget);
  await assert.rejects(() => healthLease.health(), hasCode('DESKTOP_EXECUTOR_REQUEST_REJECTED'));
  const healthRequestsAfterFailure = healthTarget.requests.length;
  await assert.rejects(() => healthLease.state(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(healthTarget.requests.length, healthRequestsAfterFailure, 'a failed health transport cannot leave a usable lease');

  const actionTarget = await fixture({ actionStatus: 503 });
  t.after(actionTarget.close);
  const actionLease = await acquire(actionTarget);
  await assert.rejects(() => actionLease.action({ action: 'wait', seconds: 0 }), hasCode('DESKTOP_EXECUTOR_REQUEST_REJECTED'));
  const actionRequestsAfterFailure = actionTarget.requests.length;
  await assert.rejects(() => actionLease.health(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(actionTarget.requests.length, actionRequestsAfterFailure, 'a rejected action cannot be retried on the same lease');

  const stateTarget = await fixture({ failStateAt: 2 });
  t.after(stateTarget.close);
  const stateLease = await acquire(stateTarget);
  await assert.rejects(() => stateLease.state(), hasCode('DESKTOP_EXECUTOR_REQUEST_REJECTED'));
  const stateRequestsAfterFailure = stateTarget.requests.length;
  await assert.rejects(() => stateLease.action({ action: 'wait', seconds: 0 }), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(stateTarget.requests.length, stateRequestsAfterFailure, 'a failed state transport cannot be recovered by an action');
});

test('a queued lease call cannot race past a failed action', async t => {
  const target = await fixture({ actionStatus: 503, actionDelayMs: 20 });
  t.after(target.close);
  const lease = await acquire(target);
  const failedAction = lease.action({ action: 'wait', seconds: 0 });
  const queuedState = lease.state();
  await assert.rejects(() => failedAction, hasCode('DESKTOP_EXECUTOR_REQUEST_REJECTED'));
  await assert.rejects(() => queuedState, hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  assert.equal(target.requests.filter(request => request.path === '/state').length, 2, 'only acquisition and the action preflight state are sent; the queued state is blocked');
});

test('only exact in-page editing and focus hotkeys are allowed', async t => {
  const target = await fixture();
  t.after(target.close);
  const accepted = [
    ['ctrl', 'a'],
    ['ctrl', 'shift', 'z'],
    ['shift', 'tab'],
    ['shift', 'left'],
  ];
  for (const keys of accepted) {
    const lease = await acquire(target);
    await lease.action({ action: 'hotkey', keys });
  }

  const rejected = [
    ['alt', 'tab'],
    ['ctrl', 'tab'],
    ['ctrl', 'alt', 'delete'],
    ['ctrl', 'shift', 'c'],
    ['command', 'tab'],
  ];
  for (const keys of rejected) {
    const lease = await acquire(target);
    await assert.rejects(() => lease.action({ action: 'hotkey', keys }), hasCode('DESKTOP_EXECUTOR_INVALID_ACTION'));
    await assert.rejects(() => lease.health(), hasCode('DESKTOP_EXECUTOR_LEASE_CLOSED'));
  }

  const actions = target.requests.filter(request => request.path === '/action').map(request => JSON.parse(request.body));
  assert.deepEqual(actions.map(action => action.keys), accepted, 'only the exact safe hotkeys reach the executor');
});

test('private config is a strict 0600 absolute JSON file and remote HTTP endpoints fail closed', async t => {
  assert.throws(() => parseDesktopExecutorConfig({ version: 1, endpoint: 'http://executor.example.test', bearer_token: token }), hasCode('DESKTOP_EXECUTOR_REMOTE_NOT_ALLOWED'));
  assert.throws(() => parseDesktopExecutorConfig({ version: 1, endpoint: 'http://executor.example.test', bearer_token: token, allow_remote: true }), hasCode('DESKTOP_EXECUTOR_REMOTE_TLS_REQUIRED'));
  assert.throws(() => parseDesktopExecutorConfig({ version: 1, endpoint: 'http://127.0.0.1:8765/hidden', bearer_token: token }), hasCode('DESKTOP_EXECUTOR_INVALID_CONFIG'));

  const directory = await mkdtemp(path.join(tmpdir(), 'bstg-desktop-executor-test-'));
  const file = path.join(directory, 'desktop.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, JSON.stringify({ version: 1, endpoint: 'http://127.0.0.1:8765', bearer_token: token }), { mode: 0o644 });
  if (process.platform !== 'win32') await assert.rejects(() => loadDesktopExecutorConfigFromFile(file), hasCode('DESKTOP_EXECUTOR_CONFIG_PERMISSIONS'));
  await chmod(file, 0o600);
  assert.deepEqual(await loadDesktopExecutorConfigFromFile(file), { version: 1, endpoint: 'http://127.0.0.1:8765', bearer_token: token });
});
