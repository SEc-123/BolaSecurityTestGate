import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {RunDecisionBudget, taskDecisionLimit} from '../../server/src/agent/decision-budget.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';

// In-memory native SQLite and loopback model protocol only. The registry contains
// one harmless fixture, so these tests cannot launch a browser/device or visit a target.
async function fixture(t, {tasks = [{intent:'discover_target'}], config = {}, decisionsToComplete = 25, completionAction = 'complete_task'} = {}) {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db), contexts = [], counts = new Map();
  const provider = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const context = JSON.parse(JSON.parse(raw).messages.find(item => item.role === 'user').content).context;
      contexts.push(context);
      const count = (counts.get(context.task.id) || 0) + 1;
      counts.set(context.task.id, count);
      const completion = typeof decisionsToComplete === 'function' ? decisionsToComplete(context) : decisionsToComplete;
      const decision = count >= completion
        ? {action:completionAction, summary:'Local decision fixture completed.'}
        // This harmless memory query is visible in every staged context.  The
        // budget contract is independent of browser authority, and a browser
        // action is correctly unavailable during security-modeling stages.
        : {action:'tool_call', tool_name:'agent.memory.query', arguments:{fixture_decision:count}};
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({id:`budget-fixture-${contexts.length}`, model:'contract-model', choices:[{message:{role:'assistant', content:JSON.stringify(decision)}}]}));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({error:{message:String(error)}})); }
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['budget-fixture', 'Local protocol fixture', 'openai_compat', `http://127.0.0.1:${provider.address().port}/v1`, 'test-only', 'contract-model', 1, 1]);
  const run = await repo.createRun({base_url:'http://127.0.0.1:9/unused-fixture', scan_config:{surface:'web', driving_mode:'autopilot', ...config}});
  const savedTasks = [];
  for (const [index, spec] of tasks.entries()) {
    savedTasks.push(await repo.createTask({scan_run_id:run.id, title:spec.title || `Budget fixture ${index}`, task_type:spec.taskType || 'autonomous_agent_task',
      priority:index, dependencies:spec.dependsOnPrevious ? [savedTasks[index - 1].id] : [], execution_plan:{intent:spec.intent, ...spec.plan}}));
  }
  const runtime = new AIScanAgentRuntime(db), registry = new AgentToolRegistry();
  registry.register({name:'agent.memory.query', description:'Harmless local fixture; no browser or device.', input_schema:{type:'object'},
    handler:async () => ({ok:true, summary:'Fixture observation recorded.', data:{fixture:true}})});
  runtime.registry = registry;
  return {runtime, repo, run, savedTasks, contexts, counts};
}

for (const parallel of [1, 3]) {
  test(`discovery completes after 25 model decisions and releases its dependent task (${parallel} workers)`, {timeout:30000}, async t => {
    const f = await fixture(t, {tasks:[{intent:'discover_target'}, {intent:'model_features_and_candidates', dependsOnPrevious:true}],
      decisionsToComplete:context => context.task.execution_plan.intent === 'discover_target' ? 25 : 1});
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    const snapshot = await f.repo.getSnapshot(f.run.id);
    assert.equal(snapshot.run.status, 'completed');
    assert.equal(result.steps_executed, 26);
    assert.deepEqual(snapshot.tasks.map(task => task.status), ['completed', 'completed']);
    assert.equal(f.counts.get(f.savedTasks[0].id), 25);
    assert.ok(snapshot.planner_decisions.every(decision => decision.source === 'ai_provider'));
    assert.equal(snapshot.tool_invocations.length, 24);
    assert.ok(snapshot.tool_invocations.every(invocation => invocation.status === 'completed'));
    assert.deepEqual(f.contexts[0].task.decision_budget, {limit:80, used:0, remaining:80});
    assert.deepEqual(f.contexts[24].task.decision_budget, {limit:80, used:24, remaining:56});
  });

  test(`unending discovery stops at the default 80-decision cap (${parallel} workers)`, {timeout:30000}, async t => {
    const f = await fixture(t, {decisionsToComplete:Infinity});
    const result = await f.runtime.run(f.run.id, {max_parallel_agents:parallel});
    const task = await f.repo.getTask(f.savedTasks[0].id);
    assert.equal(result.steps_executed, 80); assert.equal(f.contexts.length, 80);
    assert.equal(task.status, 'failed'); assert.equal(task.phase, 'iteration_limit_exceeded');
    assert.match(task.error_message, /task limit of 80 decisions/);
    assert.equal(f.contexts.at(-1).task.decision_budget.remaining, 1);
  });

  test(`explicit max_steps remains exact with concurrent workers (${parallel} workers)`, {timeout:15000}, async t => {
    const f = await fixture(t, {tasks:Array.from({length:3}, () => ({intent:'discover_target'})), decisionsToComplete:Infinity});
    const result = await f.runtime.run(f.run.id, {max_steps:5, max_parallel_agents:parallel});
    const snapshot = await f.repo.getSnapshot(f.run.id);
    assert.equal(result.steps_executed, 5); assert.equal(f.contexts.length, 5);
    assert.equal(snapshot.planner_decisions.length, 5);
    assert.equal(snapshot.run.status, 'failed');
    assert.equal(snapshot.run.current_phase, 'run_step_limit_exceeded');
    assert.ok(snapshot.tasks.every(task => !['running', 'pending'].includes(task.status)));
    assert.ok(snapshot.tasks.filter(task => task.status === 'failed').every(task => task.phase === 'run_step_limit_exceeded'));
    assert.ok(f.contexts.every(context => context.task.decision_budget.remaining >= 1));
  });
}

test('ordinary tasks keep the 20-decision default', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{intent:'model_features_and_candidates'}], decisionsToComplete:21});
  const result = await f.runtime.run(f.run.id);
  assert.equal(result.steps_executed, 20);
  assert.equal((await f.repo.getTask(f.savedTasks[0].id)).phase, 'iteration_limit_exceeded');
});

test('normal-business planning and review use dedicated operator-owned budgets', () => {
  const planning = {task_type:'plan_business_flows', execution_plan:{intent:'plan_business_flows'}};
  const review = {task_type:'review_business_flows', execution_plan:{intent:'review_business_flows'}};
  assert.equal(taskDecisionLimit(planning, {}), 40);
  assert.equal(taskDecisionLimit(review, {}), 30);
  assert.equal(taskDecisionLimit(planning, {agent_task_budgets:{default:3, plan_business_flows:27}}), 27);
  assert.equal(taskDecisionLimit(review, {agent_task_budgets:{default:3, review_business_flows:19}}), 19);
  assert.equal(taskDecisionLimit(planning, {agent_task_budgets:{normal_business_planning:17}}), 17);
  assert.equal(taskDecisionLimit(review, {agent_task_budgets:{normal_business_review:13}}), 13);
});

test('saved task budgets are configurable and model task plans cannot increase them', {timeout:15000}, async t => {
  const f = await fixture(t, {config:{agent_task_budgets:{discover_target:23}}, tasks:[{intent:'discover_target', plan:{max_iterations:1000, agent_task_budgets:{discover_target:1000}}}], decisionsToComplete:24});
  const result = await f.runtime.run(f.run.id);
  assert.equal(result.steps_executed, 23);
  assert.equal(f.contexts[0].task.decision_budget.limit, 23);
  assert.equal((await f.repo.getTask(f.savedTasks[0].id)).phase, 'iteration_limit_exceeded');
});

test('legacy discovery task type receives the discovery allowance', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{taskType:'discover_target'}], decisionsToComplete:21});
  const result = await f.runtime.run(f.run.id);
  assert.equal(result.steps_executed, 21);
  assert.equal((await f.repo.getTask(f.savedTasks[0].id)).status, 'completed');
});

test('parallel scheduler claims no more tasks than the remaining run allowance', {timeout:15000}, async t => {
  // This is a scheduler contract. Use a generic model stage so the one-turn
  // completion is not deliberately rejected by normal-discovery's required
  // initial-observation protocol.
  const f = await fixture(t, {tasks:Array.from({length:4}, () => ({intent:'model_features_and_candidates'})), decisionsToComplete:1});
  const result = await f.runtime.run(f.run.id, {max_steps:1, max_parallel_agents:4});
  const snapshot = await f.repo.getSnapshot(f.run.id);
  assert.equal(result.steps_executed, 1); assert.equal(f.contexts.length, 1);
  assert.equal(snapshot.run.status, 'failed');
  assert.equal(snapshot.run.current_phase, 'run_step_limit_exceeded');
  assert.equal(snapshot.tasks.filter(task => task.status === 'blocked' && task.phase === 'run_step_limit_exceeded').length, 3);
  assert.equal(snapshot.tasks.filter(task => task.status === 'completed').length, 1);
  assert.equal(snapshot.artifacts.filter(artifact => artifact.artifact_type === 'subagent_spawned').length, 1);
  await assert.rejects(f.runtime.run(f.run.id), /本轮已经结束/);
});

test('delayed parallel task that reserves zero decisions still terminates after shared exhaustion', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{title:'fast', intent:'discover_target'}, {title:'delayed', intent:'discover_target'}], decisionsToComplete:Infinity});
  const executeTask = f.runtime.executeTask.bind(f.runtime);
  let releaseDelayed;
  const fastFinished = new Promise(resolve => { releaseDelayed = resolve; });
  f.runtime.executeTask = async (task, budget) => {
    if (task.title === 'delayed') await fastFinished;
    try { return await executeTask(task, budget); }
    finally { if (task.title === 'fast') releaseDelayed(); }
  };
  const result = await f.runtime.run(f.run.id, {max_steps:2, max_parallel_agents:2});
  const snapshot = await f.repo.getSnapshot(f.run.id);
  assert.equal(result.steps_executed, 2); assert.equal(f.contexts.length, 2);
  assert.equal(f.counts.get(f.savedTasks[1].id), undefined);
  assert.ok(snapshot.tasks.every(task => task.status === 'failed' && task.phase === 'run_step_limit_exceeded'));
  assert.equal(snapshot.run.status, 'failed');
});

test('serial task finishing exactly at the run cap blocks unstarted dependents and ends the scan', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{intent:'model_features_and_candidates'}, {intent:'model_features_and_candidates', dependsOnPrevious:true}], decisionsToComplete:1});
  const result = await f.runtime.run(f.run.id, {max_steps:1});
  const snapshot = await f.repo.getSnapshot(f.run.id);
  assert.equal(result.steps_executed, 1);
  assert.equal(snapshot.run.status, 'failed');
  assert.equal(snapshot.run.current_phase, 'run_step_limit_exceeded');
  assert.equal(snapshot.run.summary.decisions_used, 1);
  assert.equal(snapshot.run.summary.tasks_blocked, 1);
  assert.deepEqual(snapshot.tasks.map(task => task.status), ['completed', 'blocked']);
  const product = buildProductAssessmentState(snapshot);
  assert.equal(product.run.status, 'failed');
  assert.deepEqual(product.current_work, []);
  assert.ok(product.diagnostics.some(item => /decision limit of 1 exhausted/.test(item.message)));
});

test('serial final task completing exactly at max_steps remains successful', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{intent:'model_features_and_candidates'}], decisionsToComplete:1});
  const result = await f.runtime.run(f.run.id, {max_steps:1});
  assert.equal(result.steps_executed, 1);
  assert.equal(result.snapshot.run.status, 'completed');
});

test('explicit user selection at the cap retains the actionable waiting state', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{intent:'model_features_and_candidates'}, {intent:'expand_selected_vulnerabilities', dependsOnPrevious:true}],
    decisionsToComplete:1, completionAction:'wait_for_user_selection'});
  const result = await f.runtime.run(f.run.id, {max_steps:1});
  assert.equal(result.steps_executed, 1);
  assert.equal(result.blocked_waiting_selection, true);
  assert.equal(result.snapshot.run.status, 'awaiting_selection');
  assert.deepEqual(result.snapshot.tasks.map(task => task.status), ['waiting_selection', 'pending']);
});

test('parallel workers reuse unused allowance instead of splitting it into artificial task caps', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[{title:'short', intent:'model_features_and_candidates'}, {title:'long', intent:'model_features_and_candidates'}],
    decisionsToComplete:context => context.task.title === 'short' ? 1 : 4});
  const result = await f.runtime.run(f.run.id, {max_steps:5, max_parallel_agents:2});
  assert.equal(result.steps_executed, 5); assert.equal(f.contexts.length, 5);
  assert.equal((await f.repo.getSnapshot(f.run.id)).run.status, 'completed');
});

test('parallel worker rejection after decisions preserves consumed decision accounting', {timeout:15000}, async t => {
  const f = await fixture(t, {decisionsToComplete:4});
  // Simulate a late worker/cleanup rejection after its real model decisions.
  // No returned task count is available, so reservations must remain authoritative.
  const executeTask = f.runtime.executeTask.bind(f.runtime);
  f.runtime.executeTask = async (...args) => {
    await executeTask(...args);
    throw new Error('Local fixture late worker failure');
  };
  const result = await f.runtime.run(f.run.id, {max_steps:5, max_parallel_agents:2});
  assert.equal(result.steps_executed, 4); assert.equal(f.contexts.length, 4);
  const snapshot = await f.repo.getSnapshot(f.run.id);
  const batch = snapshot.artifacts.find(artifact => artifact.artifact_type === 'parallel_agent_batch_completed');
  assert.equal(batch.content_json.steps_used, 4);
  assert.equal(batch.content_json.results[0].status, 'rejected');
});

test('direct vulnerability expansion uses the configured ordinary task allowance', {timeout:15000}, async t => {
  const f = await fixture(t, {tasks:[], config:{agent_task_budgets:{default:3}}, decisionsToComplete:Infinity});
  await f.runtime.expandSelectedVulnerabilities(f.run.id, ['bola_idor']);
  const snapshot = await f.repo.getSnapshot(f.run.id);
  assert.equal(f.contexts.length, 3);
  assert.equal(snapshot.tasks[0].phase, 'iteration_limit_exceeded');
  assert.equal(f.contexts[0].task.decision_budget.limit, 3);
});

test('invalid explicit max_steps is rejected before task bootstrap or run mutation', async t => {
  const f = await fixture(t, {tasks:[]});
  for (const value of [0, -1, 1.5, NaN, Infinity, '5', null, 10001]) {
    await assert.rejects(f.runtime.run(f.run.id, {max_steps:value}), /max_steps must be an integer between 1 and 10000/);
    assert.deepEqual(await f.repo.listTasks(f.run.id), []);
    assert.equal((await f.repo.getRun(f.run.id)).status, 'created');
  }
});

test('task configuration normalization always produces a finite bounded integer', () => {
  const discovery = {task_type:'autonomous_agent_task', execution_plan:{intent:'discover_target'}};
  const ordinary = {task_type:'test_generic_vuln', execution_plan:{}};
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '500', true, {}]) {
    assert.equal(taskDecisionLimit(discovery, {agent_task_budgets:{discover_target:value}}), 80);
    assert.equal(taskDecisionLimit(ordinary, {agent_task_budgets:{default:value}}), 20);
  }
  for (const [value, expected] of [[0,1], [-4,1], [24.9,24], [201,200], [Number.MAX_VALUE,200]]) {
    assert.equal(taskDecisionLimit(discovery, {agent_task_budgets:{discover_target:value}}), expected);
    assert.equal(taskDecisionLimit(ordinary, {agent_task_budgets:{default:value}}), expected);
  }
  assert.equal(taskDecisionLimit(discovery, {agent_task_budgets:{default:1}}), 80);
});

test('default run allowance is finite and reservations cannot exceed it', () => {
  const budget = new RunDecisionBudget();
  for (let index = 0; index < 10000; index++) assert.equal(budget.take(), true);
  assert.equal(budget.take(), false); assert.equal(budget.take(), false);
  assert.equal(budget.used, 10000); assert.equal(budget.remaining, 0);
});
