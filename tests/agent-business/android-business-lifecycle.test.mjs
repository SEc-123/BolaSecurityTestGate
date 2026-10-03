import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { AIScanAgentRuntime } from '../../server/src/agent/agent-runtime.ts';
import { createAgentToolRegistry } from '../../server/src/agent/index.ts';
import { buildModelContextScope, selectModelVisibleTools } from '../../server/src/agent/model-context-profile.ts';
import { ANDROID_BUSINESS_PLAN_INTENT, ANDROID_BUSINESS_LEARNING_INTENT, ANDROID_BUSINESS_EXPERIMENT_INTENT } from '../../server/src/services/ai-scan/android-business-contract.ts';

async function fixture(t, businessLearning) {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({
    base_url: 'http://127.0.0.1:9/android-lifecycle-fixture',
    scan_config: { surface: 'android', business_learning: businessLearning },
  });
  return { db, repo, run, runtime: new AIScanAgentRuntime(db) };
}

test('Android business lifecycle is opt-in and schedules no Web business stages', async (t) => {
  const disabled = await fixture(t, { enabled: true });
  await disabled.runtime.bootstrapRun(disabled.run);
  const disabledIntents = (await disabled.repo.listTasks(disabled.run.id)).map(task => task.execution_plan.intent);
  assert.ok(!disabledIntents.includes(ANDROID_BUSINESS_PLAN_INTENT));
  assert.ok(!disabledIntents.includes('plan_business_flows'));

  const enabled = await fixture(t, { enabled: true, android_enabled: true });
  await enabled.runtime.bootstrapRun(enabled.run);
  await enabled.runtime.bootstrapRun(enabled.run);
  const tasks = await enabled.repo.listTasks(enabled.run.id);
  const byIntent = intent => tasks.find(task => task.execution_plan.intent === intent);
  const discover = byIntent('discover_target');
  const plan = byIntent(ANDROID_BUSINESS_PLAN_INTENT);
  const normal = byIntent(ANDROID_BUSINESS_LEARNING_INTENT);
  const experiment = byIntent(ANDROID_BUSINESS_EXPERIMENT_INTENT);
  assert.ok(discover && plan && normal && experiment);
  assert.deepEqual(plan.dependencies, [discover.id]);
  assert.deepEqual(normal.dependencies, [plan.id]);
  assert.deepEqual(experiment.dependencies, [normal.id]);
  assert.equal(tasks.filter(task => task.execution_plan.intent === 'plan_business_flows').length, 0);
  assert.equal(tasks.filter(task => task.execution_plan.intent === 'learn_business_flow').length, 0);
  assert.equal(tasks.filter(task => task.execution_plan.intent === 'review_business_flows').length, 0);
  assert.equal(tasks.filter(task => task.execution_plan.intent === ANDROID_BUSINESS_PLAN_INTENT).length, 1, 'bootstrap stays idempotent');
});

test('Android business model scopes expose only Android lifecycle tools and native experiment handoff', () => {
  const tools = createAgentToolRegistry().list();
  for (const [intent, expected] of [
    [ANDROID_BUSINESS_PLAN_INTENT, ['android.business.assets.inspect']],
    [ANDROID_BUSINESS_LEARNING_INTENT, ['android.business.assets.inspect', 'android.business.normal.replay']],
    [ANDROID_BUSINESS_EXPERIMENT_INTENT, ['android.business.assets.inspect', 'android.business.experiment.ready', 'bstg.generic_vuln.run_test']],
  ]) {
    const task = { id: `task-${intent}`, task_type: intent, execution_plan: { intent } };
    const scope = buildModelContextScope({ task, scanConfig: { surface: 'android', business_learning: { android_enabled: true } }, tools });
    assert.deepEqual(scope.allowed_tool_names, expected);
    assert.equal(scope.broader_assessment_context_withheld, true);
    assert.deepEqual(selectModelVisibleTools(tools, scope.stage).map(tool => tool.name), expected);
    assert.ok(!scope.allowed_tool_names.some(name => name.startsWith('browser.') || name.startsWith('bstg.business.capture.')));
  }

  const disabled = buildModelContextScope({
    task: { id: 'disabled-android-task', task_type: ANDROID_BUSINESS_PLAN_INTENT, execution_plan: { intent: ANDROID_BUSINESS_PLAN_INTENT } },
    scanConfig: { surface: 'android', business_learning: { enabled: true } },
    tools,
  });
  assert.equal(disabled.stage, 'android_business_unavailable');
  assert.deepEqual(disabled.allowed_tool_names, []);
  assert.deepEqual(disabled.allowed_actions, ['fail_task', 'block_task']);
});

test('Android discovery is mobile-only and cannot receive a hidden Web fallback', () => {
  const tools = createAgentToolRegistry().list();
  const scope = buildModelContextScope({
    task: { id: 'android-discovery-task', task_type: 'discover_target', execution_plan: { intent: 'discover_target', surface: 'android' } },
    scanConfig: { surface: 'android', business_learning: { android_enabled: true } },
    tools,
  });
  assert.equal(scope.stage, 'android_discovery');
  assert.equal(scope.broader_assessment_context_withheld, true);
  assert.ok(scope.allowed_tool_names.includes('mobile.lab.prepare'));
  assert.ok(scope.allowed_tool_names.includes('mobile.app.explore'));
  assert.ok(scope.allowed_tool_names.every(name => name.startsWith('mobile.')),
    'Android discovery receives only Mobile Lab/Appium capabilities');
  assert.ok(!scope.allowed_tool_names.some(name => name.startsWith('browser.') || name.startsWith('bstg.business.capture.')));
  assert.deepEqual(selectModelVisibleTools(tools, scope.stage).map(tool => tool.name), scope.allowed_tool_names);
});

test('Android experiment generic executor checks readiness before endpoint planning or native work', async (t) => {
  const { db, repo, run } = await fixture(t, { enabled: true, android_enabled: true });
  const task = await repo.createTask({
    scan_run_id: run.id,
    task_type: 'model_android_business_experiment',
    title: 'Android experiment gate fixture',
    execution_plan: { intent: ANDROID_BUSINESS_EXPERIMENT_INTENT, surface: 'android' },
  });
  const registry = createAgentToolRegistry();
  const context = { db, repo, scanRunId: run.id, taskId: task.id,
    allowed_tool_names: ['bstg.generic_vuln.run_test'] };
  await assert.rejects(
    registry.call('bstg.generic_vuln.run_test', {}, context),
    /Android generic execution requires the current task Android experiment-readiness receipt first/,
  );
  await repo.createArtifact({ scan_run_id: run.id, task_id: task.id,
    artifact_type: 'android_business_experiment_ready', title: 'Android ready fixture',
    content_json: { recording_session_id: 'recording-fixture', workflow_ids: ['workflow-fixture'], completed_test_run_ids: ['run-fixture'] },
  });
  const afterReady = await registry.call('bstg.generic_vuln.run_test', {}, context);
  assert.equal(afterReady.ok, false);
  assert.equal(afterReady.data?.error_code, 'task_endpoint_plan_mismatch',
    'after readiness, the ordinary immutable endpoint-plan gate is the next boundary');
});
