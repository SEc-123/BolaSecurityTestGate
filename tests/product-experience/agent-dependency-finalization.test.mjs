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

  test(`review still runs after an ordinary failed normal dependency (${parallel} workers)`, async t => {
    const f = await fixture(t);
    const plan = await f.task({task_type:'plan_business_flows', execution_plan:{intent:'plan_business_flows', fixture_outcome:'failed'}});
    const review = await f.task({task_type:'review_business_flows', dependencies:[plan.id], execution_plan:{intent:'review_business_flows'}});
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    assertClosed(result);
    assert.deepEqual(f.executed, [plan.id, review.id]);
    assert.equal(result.snapshot.tasks.find(task => task.id === review.id).status, 'completed');
  });

  test(`provider-blocked business planning terminalizes its otherwise-runnable review (${parallel} workers)`, async t => {
    const f = await fixture(t);
    const plan = await f.task({task_type:'plan_business_flows', execution_plan:{intent:'plan_business_flows'}});
    const review = await f.task({task_type:'review_business_flows', dependencies:[plan.id], execution_plan:{intent:'review_business_flows'}});
    const later = await f.task({dependencies:[review.id]});
    f.runtime.executeTask = async (task, budget) => {
      assert.equal(task.id, plan.id);
      assert.equal(budget.take(), true);
      budget.release();
      f.executed.push(task.id);
      await f.repo.updateTask(task.id, {
        status:'blocked', phase:'provider_temporarily_unavailable',
        error_message:'Safe provider outage fixture.', completed_at:new Date().toISOString(),
      });
      return 0;
    };
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    assertClosed(result);
    assert.deepEqual(f.executed, [plan.id]);
    assert.equal(result.snapshot.run.current_phase, 'provider_temporarily_unavailable');
    assert.equal(result.snapshot.run.summary.provider_planning_unavailable, true);
    for (const task of [review, later]) {
      const saved = result.snapshot.tasks.find(item => item.id === task.id);
      assert.equal(saved.status, 'blocked');
      assert.equal(saved.phase, 'provider_dependency_unavailable');
    }
  });

  test(`provider-blocked planning preserves review after persisted planning evidence (${parallel} workers)`, async t => {
    const f = await fixture(t);
    const plan = await f.task({task_type:'plan_business_flows', execution_plan:{intent:'plan_business_flows'}});
    const review = await f.task({task_type:'review_business_flows', dependencies:[plan.id], execution_plan:{intent:'review_business_flows'}});
    f.runtime.executeTask = async (task, budget) => {
      assert.equal(task.id, plan.id);
      assert.equal(budget.take(), true);
      budget.release();
      f.executed.push(task.id);
      await f.repo.createPlannerDecision({scan_run_id:f.run.id, task_id:task.id, iteration:1,
        source:'fixture', proposal_json:{action:'tool_call'}, decision_json:{action:'tool_call'},
        policy_json:{}, validation_status:'accepted'});
      await f.repo.createToolInvocation({scan_run_id:f.run.id, task_id:task.id,
        tool_name:'fixture.business.inspect', input_json:{}, output_json:{}, status:'completed'});
      await f.repo.updateTask(task.id, {
        status:'blocked', phase:'provider_temporarily_unavailable',
        error_message:'Safe provider outage fixture.', completed_at:new Date().toISOString(),
      });
      return 0;
    };
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    assert.equal(result.completed, false);
    assert.equal(result.snapshot.run.status, 'running');
    assert.deepEqual(f.executed, [plan.id]);
    const savedReview = result.snapshot.tasks.find(task => task.id === review.id);
    assert.equal(savedReview.status, 'pending');
    assert.notEqual(savedReview.phase, 'provider_dependency_unavailable');
    assert.equal(result.snapshot.run.summary.provider_planning_unavailable, undefined);
  });

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

test('normal-then-model-experiment cannot complete without a verified required normal Flow', async t => {
  const f = await fixture(t);
  await f.repo.updateRun(f.run.id, {scan_config:{business_learning:{mode:'normal_then_model_experiment'}}});
  const plan = await f.task({task_type:'plan_business_flows', status:'completed', execution_plan:{
    intent:'plan_business_flows', normal_objectives_required:true, strict_normal_objectives:true,
    normal_objective_manifest:[{id:'objective:aaaaaaaaaaaaaaaaaaaaaaaa', label:'Verify a required normal outcome'}],
  }});
  const learning = await f.task({task_type:'learn_business_flow', status:'failed', dependencies:[plan.id], execution_plan:{intent:'learn_business_flow'}});
  const review = await f.task({task_type:'review_business_flows', status:'completed', dependencies:[learning.id], execution_plan:{intent:'review_business_flows'}});
  await f.task({status:'completed', dependencies:[review.id]});
  const result = await f.runtime.finishRun(f.run.id, new RunDecisionBudget(5), undefined, 1, 0);
  assert.equal(result.completed, true);
  assert.equal(result.snapshot.run.status, 'failed');
  assert.equal(result.snapshot.run.current_phase, 'normal_business_objectives_unverified');
  assert.equal(result.snapshot.run.summary.normal_business_objectives_unverified, true);
  assert.equal(result.snapshot.run.summary.normal_business_objectives_required, 1);
  assert.equal(result.snapshot.tasks.find(task => task.id === review.id).status, 'completed');
});

test('normal-then-model-experiment still completes when a required normal Flow is verified', async t => {
  const f = await fixture(t);
  await f.repo.updateRun(f.run.id, {scan_config:{business_learning:{mode:'normal_then_model_experiment'}}});
  const plan = await f.task({task_type:'plan_business_flows', status:'completed', execution_plan:{
    intent:'plan_business_flows', normal_objectives_required:true, strict_normal_objectives:true,
    normal_objective_manifest:[{id:'objective:aaaaaaaaaaaaaaaaaaaaaaaa', label:'Verify a required normal outcome'}],
  }});
  await f.repo.createArtifact({scan_run_id:f.run.id, task_id:plan.id, artifact_type:'business_flow', source_ref:'verified-normal-flow', title:'Verified normal Flow', content_json:{
    id:'verified-normal-flow', revision:1, objective_id:'objective:aaaaaaaaaaaaaaaaaaaaaaaa', status:'verified', assertions_verified:true,
    workflow_id:'verified-normal-workflow', normal_run_id:'verified-normal-run', evidence_artifact_ids:['verified-normal-proof'],
  }});
  await f.task({status:'completed', dependencies:[plan.id], task_type:'review_business_flows', execution_plan:{intent:'review_business_flows'}});
  const result = await f.runtime.finishRun(f.run.id, new RunDecisionBudget(5), undefined, 1, 0);
  assert.equal(result.completed, true);
  assert.equal(result.snapshot.run.status, 'completed');
  assert.equal(result.snapshot.run.summary.normal_business_objectives_unverified, undefined);
});

for (const status of ['learning', 'blocked', 'failed']) {
  test(`normal_only rejects a terminal run with a ${status} normal Flow`, async t => {
    const f = await fixture(t);
    await f.repo.updateRun(f.run.id, {scan_config:{business_learning:{mode:'normal_only'}}});
    const learning = await f.task({task_type:'learn_business_flow', status:'completed', execution_plan:{intent:'learn_business_flow', flow_id:'normal-flow'}});
    await f.repo.createArtifact({scan_run_id:f.run.id, task_id:learning.id, artifact_type:'business_flow', source_ref:'normal-flow', content_json:{
      id:'normal-flow', revision:1, name:'Normal fixture', goal:'Verify the normal fixture state.', role:'anonymous', status,
      prerequisites:[], blockers:status==='blocked'?['Fixture blocker retained.']:[], steps:[], assertions:[], evidence_artifact_ids:[],
    }});
    const result = await f.runtime.finishRun(f.run.id, new RunDecisionBudget(5), undefined, 1, 0);
    assert.equal(result.completed, true);
    assert.equal(result.snapshot.run.status, 'failed');
    assert.equal(result.snapshot.run.current_phase, 'normal_only_incomplete');
    assert.equal(result.snapshot.run.summary.normal_only_incomplete_flows, 1);
    assert.equal(result.snapshot.run.summary.normal_only_incomplete_tasks, 0);
  });
}

test('normal_only rejects a user-selection pause as an immediate terminal failure', async t => {
  const f = await fixture(t);
  await f.repo.updateRun(f.run.id, {scan_config:{business_learning:{mode:'normal_only'}}});
  const waiting = await f.task({status:'waiting_selection', execution_plan:{intent:'learn_business_flow', flow_id:'normal-flow'}});
  const dependent = await f.task({dependencies:[waiting.id], execution_plan:{intent:'review_business_flows'}});
  const result = await f.runtime.finishRun(f.run.id, new RunDecisionBudget(5), undefined, 1, 0);
  assert.equal(result.completed, true);
  assert.equal(result.blocked_waiting_selection, false);
  assert.equal(result.snapshot.run.status, 'failed');
  assert.equal(result.snapshot.run.current_phase, 'normal_only_selection_not_allowed');
  for (const task of [waiting, dependent]) {
    const saved = result.snapshot.tasks.find(item => item.id === task.id);
    assert.equal(saved.status, 'failed');
    assert.equal(saved.phase, 'normal_only_selection_not_allowed');
  }
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
