import test from 'node:test';
import assert from 'node:assert/strict';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {RunDecisionBudget} from '../../server/src/agent/decision-budget.ts';
import {POLICY_DENIAL_MESSAGE, stopScanForPolicyDenial} from '../../server/src/services/ai-scan/run-control.ts';

// Native in-memory SQLite and deterministic task outcomes only. No planner,
// browser, provider, target server, or external network is used by these tests.
async function fixture(t) {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({base_url:'http://127.0.0.1:9/unused-dependency-fixture'});
  const runtime = new AIScanAgentRuntime(db), executed = [];
  runtime.executeTask = async (task, budget) => {
    assert.equal(budget.take(), true);
    executed.push(task.id);
    const status = task.execution_plan.fixture_outcome || 'completed';
    await repo.updateTask(task.id, {status, phase:status === 'failed' ? 'fixture_failed' : 'fixture_completed',
      result_summary:'Local fixture evidence retained.', completed_at:new Date().toISOString()});
    return 1;
  };
  const task = input => repo.createTask({scan_run_id:run.id, title:'Dependency fixture', task_type:'autonomous_agent_task', ...input});
  return {db, repo, run, runtime, executed, task};
}

function assertClosed(result, status = 'failed') {
  assert.equal(result.completed, true);
  assert.equal(result.blocked_waiting_selection, false);
  assert.equal(result.snapshot.run.status, status);
  assert.ok(result.snapshot.tasks.every(task => !['pending', 'running'].includes(task.status)));
}

for (const parallel of [1, 3]) {
  test(`failed dependencies become explicit blocked tasks through reverse-ordered cascades (${parallel} workers)`, async t => {
    const f = await fixture(t);
    const root = await f.task({priority:30, execution_plan:{fixture_outcome:'failed'}});
    const middle = await f.task({priority:20, dependencies:[root.id]});
    const leaf = await f.task({priority:10, dependencies:[middle.id]});
    await f.repo.updateTask(leaf.id, {created_assets_json:{fixture_evidence:'retained'}, result_summary:'Earlier observation retained.'});
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    assertClosed(result);
    assert.deepEqual(f.executed, [root.id]);
    assert.equal(result.steps_executed, 1);
    for (const [id, dependencyId] of [[middle.id, root.id], [leaf.id, middle.id]]) {
      const task = result.snapshot.tasks.find(item => item.id === id);
      assert.equal(task.status, 'blocked');
      assert.equal(task.phase, 'dependency_failed');
      assert.ok(task.error_message.includes(dependencyId));
      assert.ok(Number.isFinite(Date.parse(task.completed_at)));
    }
    const savedLeaf = result.snapshot.tasks.find(item => item.id === leaf.id);
    assert.deepEqual(savedLeaf.created_assets_json, {fixture_evidence:'retained'});
    assert.equal(savedLeaf.result_summary, 'Earlier observation retained.');
    assert.equal(result.snapshot.run.summary.tasks_failed, 1);
    assert.equal(result.snapshot.run.summary.tasks_blocked, 2);
    assert.deepEqual(result.snapshot.run.summary.deadlocked_pending_tasks, []);
  });

  for (const summaryByIntent of [false, true]) {
    test(`campaign summary still executes after failure propagation (${parallel} workers, ${summaryByIntent ? 'intent' : 'type'})`, async t => {
      const f = await fixture(t);
      const root = await f.task({execution_plan:{fixture_outcome:'failed'}});
      const child = await f.task({dependencies:[root.id]});
      const summary = await f.task({dependencies:[root.id, child.id],
        ...(summaryByIntent ? {execution_plan:{intent:'summarize_vulnerability_campaign'}} : {task_type:'summarize_vulnerability_campaign'})});
      const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
      assertClosed(result);
      assert.deepEqual(f.executed, [root.id, summary.id]);
      assert.equal(result.snapshot.tasks.find(task => task.id === child.id).phase, 'dependency_failed');
      assert.equal(result.snapshot.tasks.find(task => task.id === summary.id).status, 'completed');
      assert.equal(result.snapshot.run.summary.tasks_completed, 1);
      assert.equal(result.steps_executed, 2);
    });
  }

  test(`cyclic dependencies are terminal blocked tasks instead of pending work (${parallel} workers)`, async t => {
    const f = await fixture(t);
    const first = await f.task({});
    const second = await f.task({dependencies:[first.id]});
    await f.repo.updateTask(first.id, {dependencies:[second.id]});
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    assertClosed(result);
    assert.deepEqual(f.executed, []);
    assert.equal(result.steps_executed, 0);
    assert.ok(result.snapshot.tasks.every(task => task.status === 'blocked' && task.phase === 'dependency_deadlock' && task.completed_at));
    assert.equal(result.snapshot.run.summary.tasks_blocked, 2);
    assert.deepEqual(new Set(result.snapshot.run.summary.deadlocked_pending_tasks.map(task => task.id)), new Set([first.id, second.id]));
  });
}

test('missing dependencies are recorded explicitly at terminal finalization', async t => {
  const f = await fixture(t);
  const task = await f.task({dependencies:['missing-fixture-task']});
  const result = await f.runtime.run(f.run.id);
  assertClosed(result);
  const saved = result.snapshot.tasks.find(item => item.id === task.id);
  assert.equal(saved.phase, 'dependency_deadlock');
  assert.match(saved.error_message, /missing-fixture-task \(missing\)/);
  assert.deepEqual(f.executed, []);
});

test('blocked prerequisite cannot leave its ordinary dependent or the run looking successful', async t => {
  const f = await fixture(t);
  const root = await f.task({status:'blocked'});
  const child = await f.task({dependencies:[root.id]});
  const result = await f.runtime.run(f.run.id);
  assertClosed(result);
  assert.equal(result.snapshot.tasks.find(task => task.id === child.id).phase, 'dependency_failed');
  assert.equal(result.snapshot.run.summary.tasks_failed, 0);
  assert.equal(result.snapshot.run.summary.tasks_blocked, 2);
});

test('completed and skipped prerequisites still release ordinary tasks successfully', async t => {
  const f = await fixture(t);
  const completed = await f.task({status:'completed'});
  const skipped = await f.task({status:'skipped'});
  const child = await f.task({dependencies:[completed.id, skipped.id]});
  const result = await f.runtime.run(f.run.id);
  assertClosed(result, 'completed');
  assert.deepEqual(f.executed, [child.id]);
});

test('direct finalization settles failed dependency cascades without a scheduler pass', async t => {
  const f = await fixture(t);
  const root = await f.task({status:'failed'});
  await f.task({dependencies:[root.id]});
  const result = await f.runtime.finishRun(f.run.id, new RunDecisionBudget(5), undefined, 1, 0);
  assertClosed(result);
  assert.equal(result.snapshot.run.summary.tasks_blocked, 1);
});

for (const waitingTask of [false, true]) {
  test(`selection pause preserves pending dependency work (${waitingTask ? 'task state' : 'run state'})`, async t => {
    const f = await fixture(t);
    const root = await f.task({status:waitingTask ? 'waiting_selection' : 'failed'});
    const child = await f.task({dependencies:[root.id]});
    if (!waitingTask) await f.repo.updateRun(f.run.id, {status:'awaiting_selection'});
    const result = await f.runtime.finishRun(f.run.id, new RunDecisionBudget(5), undefined, 1, 0);
    assert.equal(result.completed, false);
    assert.equal(result.blocked_waiting_selection, true);
    assert.equal(result.snapshot.tasks.find(task => task.id === child.id).status, 'pending');
    assert.equal(result.snapshot.tasks.find(task => task.id === child.id).phase, child.phase);
    if (!waitingTask) assert.equal(result.snapshot.run.status, 'awaiting_selection');
  });
}

test('run budget exhaustion retains its existing terminal reason before dependency cleanup', async t => {
  const f = await fixture(t);
  const root = await f.task({execution_plan:{fixture_outcome:'failed'}});
  const child = await f.task({dependencies:[root.id]});
  const result = await f.runtime.run(f.run.id, {max_steps:1});
  assertClosed(result);
  assert.equal(result.snapshot.run.current_phase, 'run_step_limit_exceeded');
  assert.equal(result.snapshot.tasks.find(task => task.id === child.id).phase, 'run_step_limit_exceeded');
});

test('provider cancellation keeps the cancellation reason on all unfinished tasks', async t => {
  const f = await fixture(t);
  const root = await f.task({});
  await f.task({dependencies:[root.id]});
  f.runtime.executeTask = async (_task, budget) => {
    assert.equal(budget.take(), true);
    stopScanForPolicyDenial({provider_id:'fixture-provider', model:'fixture-model'});
    return 1;
  };
  const result = await f.runtime.run(f.run.id);
  assertClosed(result);
  assert.ok(result.snapshot.tasks.every(task => task.status === 'failed' && task.phase === 'provider_policy_denied' && task.error_message === POLICY_DENIAL_MESSAGE));
  assert.equal(result.snapshot.run.summary.provider_policy_denial.code, 'provider_policy_denied');
});
