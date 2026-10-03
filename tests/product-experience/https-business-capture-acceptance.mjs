#!/usr/bin/env node
/**
 * Real Chromium worker + controlled CA-signed HTTPS target + persistent
 * business capture + native Workflow replay. This is intentionally separate
 * from ordinary Node tests because the worker must be started with the CA
 * before this process begins; no browser certificate-error bypass is allowed.
 */
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteProvider } from '../../server/src/db/sqlite-provider.ts';
import { dbManager } from '../../server/src/db/db-manager.ts';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { newBusinessFlow, saveBusinessFlow } from '../../server/src/services/ai-scan/agent-business-contract.ts';
import { startBusinessCapture, stopBusinessCapture, prepareBusinessWorkflow, validateBusinessWorkflow } from '../../server/src/services/ai-scan/agent-business-capture.ts';
import { navigatePersistentBrowser, interactPersistentBrowser, closePersistentBrowserContextsForScan } from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';
import { assertBrowserTargetTlsTrust, targetTlsTrustMetadata } from '../../server/src/services/ai-scan/target-tls-trust.ts';

const tlsDirectory = path.resolve(process.env.BSTG_WEB_TLS_DIR || '');
const output = path.resolve('artifacts', `https-business-capture-${Date.now()}`);
const report = { ok: false, started_at: new Date().toISOString(), checks: [] };
let server;
let db;
let repo;
let run;
let originalDb;

function check(name, value) {
  assert.ok(value, name);
  report.checks.push(name);
}

function closeServer(value) {
  return new Promise(resolve => { value.closeAllConnections(); value.close(resolve); });
}

try {
  const workerEndpoint = process.env.BSTG_BROWSER_WS_ENDPOINT?.trim();
  const systemTrustedChromium = process.env.BSTG_BROWSER_TRUSTED_CA_MODE?.trim() === 'system';
  if (!workerEndpoint && !systemTrustedChromium) {
    throw new Error('Use an isolated CA-configured Chromium worker, or explicitly configure BSTG_BROWSER_TRUSTED_CA_MODE=system for an operator-provisioned local Chromium trust store.');
  }
  if (!workerEndpoint && !process.env.BSTG_CHROMIUM_EXECUTABLE?.trim()) {
    throw new Error('System-trust acceptance requires BSTG_CHROMIUM_EXECUTABLE to name the real local Chromium binary being verified.');
  }
  if (!process.env.BSTG_TARGET_CA_FILE) throw new Error('BSTG_TARGET_CA_FILE must name the same CA bundle attested for the Chromium trust store.');
  if (!tlsDirectory || tlsDirectory === path.resolve('.')) throw new Error('BSTG_WEB_TLS_DIR must name a pre-generated controlled HTTPS fixture directory.');
  const [key, cert] = await Promise.all([readFile(path.join(tlsDirectory, 'key.pem')), readFile(path.join(tlsDirectory, 'cert.pem'))]);
  const targetTrust = targetTlsTrustMetadata();
  check('explicit CA bundle is configured for native replay', targetTrust.mode === 'configured_ca');
  check(workerEndpoint ? 'isolated Chromium declares the same CA bundle' : 'system-trusted Chromium declares the same CA bundle', assertBrowserTargetTlsTrust().ca_bundle_sha256 === targetTrust.ca_bundle_sha256);
  report.browser_trust_mode = workerEndpoint ? 'isolated_worker' : 'system';
  process.env.BSTG_BROWSER_MODE = 'headless';
  process.env.BSTG_BROWSER_EXPOSE_NETWORK = '<loopback>';

  const csrf = `controlled-${randomUUID()}`;
  let operations = 0;
  server = https.createServer({ key, cert }, async (request, response) => {
    const url = new URL(request.url || '/', 'https://fixture.invalid');
    if (url.pathname === '/portal') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>HTTPS business fixture</title><button id="save">Save profile</button><div id="result"></div><script>
        document.querySelector('#save').onclick=async()=>{const r=await fetch('/api/profile',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':'${csrf}'},body:JSON.stringify({display_name:'controlled'})});document.querySelector('#result').textContent=(await r.json()).state;};
      </script>`);
      return;
    }
    if (url.pathname === '/api/profile' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.headers['x-csrf-token'] !== csrf || body !== JSON.stringify({ display_name: 'controlled' })) {
        response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: 'rejected' })); return;
      }
      operations += 1;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ state: 'saved' })); return;
    }
    response.writeHead(404); response.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `https://127.0.0.1:${server.address().port}`;

  db = new SqliteProvider('https-business-capture-acceptance', { file: ':memory:' });
  await db.connect(); await db.migrate();
  originalDb = dbManager.getActive; dbManager.getActive = () => db;
  repo = new AIScanRepository(db);
  run = await repo.createRun({ base_url: baseUrl, name: 'HTTPS persistent business capture acceptance' });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Record a verified HTTPS business operation', task_type: 'autonomous_agent_task', execution_plan: { intent: 'learn_business_flow' } });
  const flow = newBusinessFlow({ name: 'Save profile over HTTPS', goal: 'The profile save is confirmed by the target state', role: 'anonymous' }, task.id);
  await saveBusinessFlow(repo, run.id, task.id, flow);
  await repo.updateTask(task.id, { execution_plan: { intent: 'learn_business_flow', flow_id: flow.id } });
  await repo.upsertEndpoint({ scan_run_id: run.id, method: 'POST', path: '/api/profile', url: `${baseUrl}/api/profile` });
  const context = { db, repo, scanRunId: run.id, taskId: task.id };

  const capture = await startBusinessCapture(context, { flow_id: flow.id, field_names: ['x-csrf-token'] });
  const browser = { repo, scanRunId: run.id, taskId: task.id, scope_base_url: baseUrl, identity_key: 'anonymous', context_key: capture.context_key };
  check('real Chromium navigates a CA-signed HTTPS page', (await navigatePersistentBrowser({ ...browser, url: `${baseUrl}/portal` })).ok === true);
  const action = await interactPersistentBrowser({ ...browser, operation: { action: 'click', selector: '#save' } });
  check('real Chromium executes the normal business UI action', action.ok === true);
  check('the visible target state confirms the browser operation', (await interactPersistentBrowser({ ...browser, operation: { action: 'assert', selector: '#result', text: 'saved' } })).ok === true);
  const captured = await stopBusinessCapture(context, capture.recording_session_id);
  const selected = captured.events.filter(event => event.action_id === action.action_id && event.method === 'POST');
  check('same Chromium capture retains the operation request and response', selected.length === 1);
  check('target observed the browser operation once', operations === 1);

  const raw = (await repo.listArtifacts(run.id)).find(artifact => artifact.artifact_type === 'business_capture_event' && artifact.source_ref === capture.recording_session_id && artifact.content_json.action_id === action.action_id && artifact.content_json.method === 'POST')?.content_json;
  check('captured request has complete HTTPS transport provenance', raw?.complete === true && raw?.tls?.scheme === 'https' && raw?.tls?.certificate_verified === true && raw?.tls?.security_state === 'secure' && raw?.tls?.trust_mode === 'configured_ca' && raw?.tls?.ca_bundle_sha256 === targetTrust.ca_bundle_sha256);
  check('captured response is from the same live Chromium request', raw?.response_status === 200 && typeof raw?.response_body_text === 'string' && raw.response_body_text.includes('saved'));

  const prepared = await prepareBusinessWorkflow(context, { recording_session_id: capture.recording_session_id, event_ids: selected.map(event => event.event_id) });
  const validated = await validateBusinessWorkflow(context, { workflow_id: prepared.workflow_id, assertions: [{
    id: 'profile-save-state', step_order: 1, description: 'The server confirms the normal profile save', purpose: 'goal',
    left: { type: 'response', path: 'body.state' }, op: 'equals', right: { type: 'literal', value: 'saved' },
  }] });
  check('native Workflow replay succeeds through the exact configured CA', validated.verified === true && validated.execution.success === true);
  check('the target observed a real native Workflow replay', operations === 2);
  report.tls = raw.tls;
  report.capture_event_count = captured.events.length;
  report.workflow_test_run_id = validated.test_run_id;
  report.ok = true;
} catch (error) {
  report.error = String(error?.stack || error);
  process.exitCode = 1;
} finally {
  if (repo && run) await closePersistentBrowserContextsForScan(repo, run.id).catch(() => undefined);
  if (originalDb) dbManager.getActive = originalDb;
  await db?.disconnect().catch(() => undefined);
  if (server) await closeServer(server).catch(() => undefined);
  report.completed_at = new Date().toISOString();
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, output, checks: report.checks, error: report.error }, null, 2));
}
