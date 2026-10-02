import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { assertUrlInTargetScope, fetchInTargetScope } from '../../server/src/services/ai-scan/target-scope.ts';
import { executeHttpRequest } from '../../server/src/services/ai-scan/http-executor.ts';
import { fetchWithRetry } from '../../server/src/services/execution-utils.ts';
import { assertBrowserTargetTlsTrust, targetTlsTrustMetadata } from '../../server/src/services/ai-scan/target-tls-trust.ts';
import { launchAssessmentBrowser } from '../../server/src/services/ai-scan/browser/browser-provider.ts';

const execFile = promisify(execFileCallback);
const tlsFixture = path.resolve('tests/fixtures/prepare-local-tls.py');
const tlsEnvironment = ['BSTG_TARGET_CA_FILE', 'BSTG_BROWSER_TRUSTED_CA_SHA256', 'BSTG_BROWSER_TRUSTED_CA_MODE', 'BSTG_BROWSER_WS_ENDPOINT'];

async function certificateDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bstg-target-tls-'));
  await execFile('python3', [tlsFixture, '--output', directory]);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function tlsServer(t, directory, name = 'verified') {
  const server = https.createServer({ key: await readFile(path.join(directory, 'key.pem')), cert: await readFile(path.join(directory, 'cert.pem')) }, (request, response) => {
    if (request.url === '/business') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: name, replayed: request.headers['x-bstg-replay'] === 'true' }));
      return;
    }
    response.writeHead(404); response.end('missing');
  });
  server.listen(0, '::');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server;
}

function restoreEnvironment(before) {
  for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('explicit CA trust keeps browser and native HTTPS replay on one fail-closed contract', { concurrency: false }, async t => {
  const before = Object.fromEntries(tlsEnvironment.map(key => [key, process.env[key]]));
  t.after(() => restoreEnvironment(before));
  const trusted = await certificateDirectory(t);
  const untrusted = await certificateDirectory(t);
  const verifiedServer = await tlsServer(t, trusted, 'verified');
  const rejectedServer = await tlsServer(t, untrusted, 'untrusted');
  const verified = `https://127.0.0.1:${verifiedServer.address().port}/business`;
  // The generated certificate authorizes 127.0.0.1, localhost and 10.0.2.2,
  // but never IPv6 loopback. The dual-stack local listener makes this a real
  // TLS hostname check instead of a DNS/connection failure.
  const wrongHostname = `https://[::1]:${verifiedServer.address().port}/business`;
  const unknownCa = `https://127.0.0.1:${rejectedServer.address().port}/business`;
  const downgraded = `http://127.0.0.1:${verifiedServer.address().port}/business`;

  delete process.env.BSTG_TARGET_CA_FILE;
  delete process.env.BSTG_BROWSER_TRUSTED_CA_SHA256;
  delete process.env.BSTG_BROWSER_TRUSTED_CA_MODE;
  delete process.env.BSTG_BROWSER_WS_ENDPOINT;
  await assert.rejects(fetchInTargetScope(verified, {}, verified), /certificate|self.?signed|fetch failed|unable/i,
    'The fixture is not accepted before its CA is explicitly configured.');

  process.env.BSTG_TARGET_CA_FILE = path.join(trusted, 'ca.pem');
  const metadata = targetTlsTrustMetadata();
  assert.equal(metadata.mode, 'configured_ca');
  assert.match(metadata.ca_bundle_sha256, /^[a-f0-9]{64}$/);

  const observed = await fetchInTargetScope(verified, {}, verified);
  assert.equal(observed.status, 200);
  assert.equal(observed.url, verified);
  assert.deepEqual(await observed.json(), { state: 'verified', replayed: false });

  const replay = await executeHttpRequest({ method: 'GET', url: verified, headers: { 'x-bstg-replay': 'true' }, timeout_ms: 10000 });
  assert.equal(replay.ok, true);
  assert.equal(replay.status, 200);
  assert.equal(replay.final_url, verified);
  assert.match(replay.body_preview, /"replayed":true/,
    'The native API executor uses the explicit CA transport rather than a startup-only Node trust setting.');

  const workflowResponse = await fetchWithRetry(verified, { method: 'GET', headers: { 'x-bstg-replay': 'true' } }, 0);
  assert.equal(workflowResponse.status, 200);
  assert.match(await workflowResponse.text(), /"replayed":true/,
    'The template/workflow execution helper takes the same native CA path.');

  await assert.rejects(fetchInTargetScope(wrongHostname, { signal: AbortSignal.timeout(5000) }, wrongHostname), /altname|certificate|fetch failed|hostname|socket disconnected/i,
    'Trusting the CA does not waive hostname verification.');
  await assert.rejects(fetchInTargetScope(unknownCa, { signal: AbortSignal.timeout(5000) }, unknownCa), /certificate|self.?signed|fetch failed|unable/i,
    'Only the configured CA is trusted; a different self-signed chain remains rejected.');
  assert.throws(() => assertUrlInTargetScope(downgraded, verified), /out-of-scope/i,
    'An HTTPS target scope rejects an HTTP downgrade before a native request is made.');

  await assert.rejects(Promise.resolve().then(() => assertBrowserTargetTlsTrust()), /fingerprint is not attested/i,
    'A Chromium private-CA context cannot start without an exact worker/system trust attestation.');
  process.env.BSTG_BROWSER_TRUSTED_CA_SHA256 = metadata.ca_bundle_sha256;
  process.env.BSTG_BROWSER_TRUSTED_CA_MODE = 'system';
  assert.deepEqual(assertBrowserTargetTlsTrust(), metadata,
    'A pre-provisioned system trust store must name exactly the same CA bundle as native replay.');
  await assert.rejects(launchAssessmentBrowser({ headless: true, args: ['--ignore-certificate-errors'] }), /cannot disable TLS/i,
    'Assessment Chromium rejects certificate-error bypass flags before launch.');
  await assert.rejects(launchAssessmentBrowser({ headless: true, args: ['--ignore-certificate-errors-spki-list=not-an-allowed-substitute'] }), /cannot disable TLS/i,
    'Pin-list certificate bypasses are rejected too because they can waive hostname validation.');
});
