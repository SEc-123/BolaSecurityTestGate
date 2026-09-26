import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { AIScanAgentRuntime } from '../../server/src/agent/agent-runtime.ts';
import { AgentToolRegistry } from '../../server/src/agent/tool-registry.ts';
import { assertUrlInTargetScope } from '../../server/src/services/ai-scan/target-scope.ts';
import { buildProductAssessmentState } from '../../server/src/services/ai-scan/product-state-service.ts';
import { judge } from './fixtures.mjs';

// Real runtime, tool registry, origin guard and in-memory SQLite. The planner is
// an explicit test double; no model, browser, saved target or network is used.
async function fixture(t, { taskType = 'test_generic_vuln', handler, blockedUrl = 'https://outside.example.test/action' } = {}) {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({ base_url: 'https://authorized.example.test', scan_config: { surface: 'web', driving_mode: 'autopilot' } });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Scope status fixture', task_type: taskType,
    vuln_type: taskType === 'test_file_upload' ? 'file_upload' : 'bola_idor', endpoint_ids: ['fixture-endpoint'], execution_plan: {} });
  const runtime = new AIScanAgentRuntime(db);
  if (handler) {
    const registry = new AgentToolRegistry();
    registry.register({ name: 'browser.navigate', description: 'Explicit failure fixture', input_schema: {}, handler });
    runtime.registry = registry;
  }
  let decisions = 0;
  t.mock.method(runtime.planner, 'decide', async () => ++decisions === 1
    ? { action: 'tool_call', tool_name: 'browser.navigate', arguments: { url: blockedUrl }, source: 'local_policy' }
    : { action: 'complete_task', summary: 'Must never run after rejection.', source: 'local_policy' });
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected transport in scope fixture'); });
  await runtime.run(run.id);
  const snapshot = await repo.getSnapshot(run.id);
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(decisions, 1, 'terminal rejection cannot be followed by model completion');
  assert.equal(snapshot.browser_contexts.length, 0);
  assert.equal(snapshot.tool_invocations.length, 1);
  return { repo, run, task, snapshot };
}

for (const taskType of ['test_generic_vuln', 'test_file_upload']) {
  for (const blockedUrl of ['https://outside.example.test/action', 'http://authorized.example.test/action', 'https://authorized.example.test:444/action']) {
    test(`${taskType} persists origin rejection as blocked: ${blockedUrl}`, async t => {
      const { snapshot, task, run } = await fixture(t, { taskType, blockedUrl });
      const saved = snapshot.tasks.find(item => item.id === task.id);
      assert.equal(saved.status, 'blocked');
      assert.equal(saved.phase, 'target_scope_blocked');
      assert.match(saved.error_message, /Out-of-scope active target URL blocked/);
      assert.ok(saved.completed_at);
      assert.equal(snapshot.tool_invocations[0].status, 'blocked');
      assert.deepEqual(snapshot.tool_invocations[0].output_json, { blocked: true, error_code: 'TARGET_SCOPE_VIOLATION' });
      assert.equal(snapshot.run.summary.tasks_completed, 0);
      assert.equal(snapshot.run.summary.tasks_failed, 0);
      assert.equal(snapshot.run.summary.tasks_blocked, 1);
      const outcome = snapshot.agent_memories.find(memory => memory.memory_type === 'task_outcome');
      assert.equal(outcome.content_json.status, 'blocked');
      assert.equal(snapshot.artifacts.some(artifact => artifact.artifact_type === 'ai_judgement'), false);

      // Even an earlier clear verdict cannot turn an interrupted test into a pass.
      snapshot.artifacts.push({ ...judge(), scan_run_id: run.id, task_id: task.id, source_ref: 'fixture-endpoint' });
      const product = buildProductAssessmentState(snapshot);
      const projected = product.business_functions.flatMap(feature => feature.tests);
      assert.equal(projected.length, 1);
      assert.equal(projected[0].status, 'blocked');
      assert.equal(projected[0].outcome, 'inconclusive');
      assert.equal(projected[0].checked, false);
      assert.equal(product.totals.completed, 0);
    });
  }
}

for (const [name, handler] of [
  ['runtime exception', async () => { throw new Error('Browser process exited unexpectedly'); }],
  ['scope-looking ordinary exception', async () => { throw new Error('Out-of-scope active target URL blocked: plain runtime error fixture'); }],
  ['unsuccessful tool result', async () => ({ ok: false, error: 'Browser operation timed out' })],
]) {
  test(`${name} remains failed rather than becoming a scope block`, async t => {
    const { snapshot } = await fixture(t, { handler });
    assert.equal(snapshot.tasks[0].status, 'failed');
    assert.equal(snapshot.tasks[0].phase, 'failed');
    assert.equal(snapshot.tool_invocations[0].status, 'failed');
    assert.equal(snapshot.run.status, 'failed');
    assert.equal(snapshot.run.summary.tasks_failed, 1);
    const projected = buildProductAssessmentState(snapshot).business_functions.flatMap(feature => feature.tests)[0];
    assert.equal(projected.status, 'failed');
    assert.equal(projected.checked, false);
  });
}

test('the declared origin still accepts its own absolute and relative paths', () => {
  const base = 'https://authorized.example.test/start';
  assert.equal(assertUrlInTargetScope('/action', base).href, 'https://authorized.example.test/action');
  assert.equal(assertUrlInTargetScope('https://authorized.example.test/action', base).origin, new URL(base).origin);
});
