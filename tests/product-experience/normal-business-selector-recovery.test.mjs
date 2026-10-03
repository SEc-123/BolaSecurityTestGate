import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {BUSINESS_LEARNING_INTENT} from '../../server/src/agent/business-task-lifecycle.ts';
import {newBusinessFlow, saveBusinessFlow} from '../../server/src/services/ai-scan/agent-business-contract.ts';
import {closePersistentBrowserContextsForScan} from '../../server/src/services/ai-scan/browser/persistent-browser-runtime.ts';

// Real Chromium, native SQLite and the normal-learning model scope. The model
// protocol is local only. It first proposes an unknown opaque reference;
// the next model decision must reuse an exact current observed reference.
// No page selector or page wording is ever part of the provider protocol.
test('normal Flow selector correction permits only current observed opaque candidates', {timeout: 30000}, async t => {
  const previousMode = process.env.BSTG_BROWSER_MODE;
  process.env.BSTG_BROWSER_MODE = 'headless';
  t.after(() => {
    if (previousMode === undefined) delete process.env.BSTG_BROWSER_MODE;
    else process.env.BSTG_BROWSER_MODE = previousMode;
  });

  const target = http.createServer((_, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><main><p>Current display name: <strong id="current">Verified member</strong></p><button id="save">Save details</button></main>');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => new Promise(resolve => { target.closeAllConnections(); target.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${target.address().port}/`;

  const contexts = [];
  const currentAssertionRef = context => {
    const invocation = [...(context.task_tool_invocations || [])].reverse().find(item =>
      item.tool_name === 'browser.interact' || item.tool_name === 'browser.navigate');
    const candidate = invocation?.output_json?.observation?.assertion_targets
      ?.find(target => typeof target.assertion_ref === 'string')?.assertion_ref;
    assert.equal(typeof candidate, 'string');
    return candidate;
  };
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const wire = JSON.parse(raw);
      const context = JSON.parse(wire.messages.find(message => message.role === 'user').content).context;
      contexts.push(context);
      const turn = contexts.length;
      let decision;
      if (turn === 1) {
        decision = {action: 'tool_call', tool_name: 'browser.navigate', arguments: {url: baseUrl}};
      } else if (turn === 2) {
        decision = {action: 'tool_call', tool_name: 'browser.interact', arguments: {
          operation: {action: 'assert', assertion_ref: currentAssertionRef(context), text: 'fixture missing state'},
        }};
      } else if (turn === 3) {
        const failed = context.task_tool_invocations.at(-1)?.output_json;
        assert.equal(failed.error_code, 'assertion_not_observed');
        assert.equal(failed.failure_phase, 'pre_action');
        assert.equal(failed.action_performed, false);
        assert.equal(failed.retryable, true);
        assert.ok(failed.observation.assertion_targets.some(target => typeof target.assertion_ref === 'string'));
        // A passive refresh keeps the correction active, but produces a fresh
        // opaque candidate. The provider is never given page text or a DOM
        // selector from which it could manufacture a replacement.
        decision = {action: 'tool_call', tool_name: 'browser.interact', arguments: {
          operation: {action: 'observe'},
        }};
      } else if (turn === 4) {
        const latest = context.task_tool_invocations.at(-1);
        assert.equal(latest.tool_name, 'browser.interact');
        assert.equal(latest.status, 'completed');
        assert.equal(latest.input_json.operation.action, 'observe');
        const candidate = latest.output_json.observation.assertion_targets.find(target => typeof target.assertion_ref === 'string')?.assertion_ref;
        assert.ok(candidate);
        decision = {action: 'tool_call', tool_name: 'browser.interact', arguments: {
          operation: {action: 'assert', assertion_ref: candidate},
        }};
      } else {
        decision = {action: 'fail_task', reason: 'Fixture stops after proving scoped selector recovery.'};
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({id: `normal-selector-${turn}`, model: 'fixture-model', choices: [{message: {role: 'assistant', content: JSON.stringify(decision)}}]}));
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({error: {message: String(error)}}));
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));

  const db = await database();
  const repo = new AIScanRepository(db);
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)', [
    'normal-selector-fixture', 'Normal selector recovery fixture', 'openai_compat', `http://127.0.0.1:${provider.address().port}/v1`,
    'fixture-only-key', 'fixture-model', 1, 1,
  ]);
  const run = await repo.createRun({base_url: baseUrl, scan_config: {
    surface: 'web', driving_mode: 'autopilot', authorization_acknowledged: true,
    // This fixture needs exactly five provider proposals to prove opaque
    // selector correction.  A normal Flow cannot be ended by a free-form
    // fail_task, so cap the isolated proof after its final fixture response
    // instead of provoking unrelated Flow-inspection recovery turns.
    agent_task_budgets: {learn_business_flow: 5},
  }});
  t.after(async () => { await closePersistentBrowserContextsForScan(repo, run.id); await db.disconnect(); });
  const task = await repo.createTask({
    scan_run_id: run.id, title: 'Observed normal profile state', task_type: 'learn_business_flow',
    execution_plan: {intent: BUSINESS_LEARNING_INTENT, flow_id: 'pending'},
  });
  const flow = newBusinessFlow({
    name: 'Observe current display name', goal: 'The current display name is visible after the normal action.', role: 'anonymous',
  }, task.id);
  await saveBusinessFlow(repo, run.id, task.id, flow);
  await repo.updateTask(task.id, {execution_plan: {intent: BUSINESS_LEARNING_INTENT, flow_id: flow.id}});

  await new AIScanAgentRuntime(db).run(run.id);
  const snapshot = await repo.getSnapshot(run.id);
  const interactions = snapshot.tool_invocations.filter(invocation => invocation.tool_name === 'browser.interact');
  const failed = interactions.find(invocation => invocation.status === 'failed');
  const completed = interactions.filter(invocation => invocation.status === 'completed');
  assert.equal(contexts.length, 5,
    'the bounded selector-correction proof must not spend provider turns on unrelated Flow recovery');
  assert.equal(failed?.output_json.error_code, 'assertion_not_observed');
  assert.deepEqual(
    [...new Set(interactions.map(invocation => invocation.input_json.operation?.assertion_ref).filter(Boolean))].length,
    2,
  );
  assert.equal(completed.filter(invocation => invocation.input_json.operation?.action === 'observe').length, 1);
  assert.equal(completed.filter(invocation => typeof invocation.input_json.operation?.assertion_ref === 'string').length, 1);
  assert.equal(JSON.stringify(interactions).includes('selector'), false,
    'model-dispatched interaction history contains only opaque references');
  assert.equal(JSON.stringify(contexts).includes('Verified member'), false,
    'page-derived visible text never reaches the model context');
});
