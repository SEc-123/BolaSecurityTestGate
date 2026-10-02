import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {buildAutonomousAgentContext} from '../../server/src/agent/context-builder.ts';

const discoveryTool = 'browser.discover_target';
const bootstrapTool = 'bstg.identity.bootstrap_accounts';
const helperTool = 'agent.shared_context.prepare';
const toolCall = tool_name => ({action:'tool_call', tool_name, arguments:{}});
const complete = {action:'complete_task', summary:'Separate fixture task completed.'};
const discoverySummary = 'Synthetic discovery persisted.';
const bootstrapSummary = 'Synthetic account preparation persisted.';

// Real runtime/planner/registry and native in-memory SQLite. Only a loopback
// model protocol fixture is used; all browser/account handlers are inert doubles.
// No browser, real target, saved configuration, account or device is accessed.
async function fixture(t, {
  taskType = 'autonomous_agent_task', intent = 'discover_target', config = {},
  decisions = [toolCall(discoveryTool), toolCall(helperTool)],
  discoveryResult, bootstrapResult,
} = {}) {
  const db = await database(), repo = new AIScanRepository(db);
  t.after(() => db.disconnect());
  const run = await repo.createRun({base_url:'http://127.0.0.1:9/unused-discovery-fixture', scan_config:{surface:'web', ...config}});
  const task = await repo.createTask({scan_run_id:run.id, title:'Lifecycle fixture', task_type:taskType, execution_plan:{intent}});
  await repo.updateTask(task.id, {created_assets_json:{existing:'preserved'}});
  const contexts = [], calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const context = JSON.parse(JSON.parse(raw).messages.find(item => item.role === 'user').content).context;
    contexts.push(context);
    const taskDecisions = contexts.filter(item => item.task.id === context.task.id).length;
    const decision = context.task.id === task.id ? decisions[taskDecisions - 1] || complete : complete;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({id:`discovery-${contexts.length}`, model:'contract-model',
      choices:[{message:{role:'assistant', content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['discovery-fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
  const runtime = new AIScanAgentRuntime(db), registry = new AgentToolRegistry();
  for (const [name, artifactType, summary, configuredResult] of [
    [discoveryTool, 'browser_discovery_summary', discoverySummary, discoveryResult],
    [bootstrapTool, 'account_auto_bootstrap_result', bootstrapSummary, bootstrapResult],
  ]) registry.register({name, description:'Synthetic lifecycle fixture; no target access.', input_schema:{},
    handler:async (input, context) => {
      calls.push({name, input, task:await repo.getTask(context.taskId), invocations:await repo.listToolInvocations(run.id, context.taskId)});
      if (configuredResult instanceof Error) throw configuredResult;
      if (configuredResult?.ok === false) return configuredResult;
      const data = configuredResult?.data || {fixture:true, assets:{[name]:name}};
      await context.repo.createArtifact({scan_run_id:run.id, task_id:context.taskId, artifact_type:artifactType, title:summary, content_json:data});
      return {ok:true, summary, data};
    }});
  registry.register({name:helperTool, description:'Synthetic unrelated helper.', input_schema:{},
    handler:async () => { calls.push({name:helperTool}); return {ok:true, summary:'Unrelated helper succeeded.'}; }});
  runtime.registry = registry;
  return {db, repo, run, task, contexts, calls, runtime};
}

function assertCompleted(f, result, {steps = 1, summary = discoverySummary, bootstrap = false} = {}) {
  const {snapshot} = result, saved = snapshot.tasks.find(item => item.id === f.task.id);
  assert.equal(saved.status, 'completed', saved.error_message);
  assert.equal(saved.phase, 'completed');
  assert.ok(saved.completed_at);
  assert.ok(!saved.error_message);
  assert.equal(saved.result_summary, summary);
  assert.equal(f.contexts.filter(item => item.task.id === f.task.id).length, 1, 'dedicated discovery must not request a provider continuation');
  assert.equal(result.steps_executed, steps);
  assert.deepEqual(f.calls.map(item => item.name), bootstrap ? [discoveryTool, bootstrapTool] : [discoveryTool]);
  assert.deepEqual(saved.created_assets_json, {existing:'preserved', [discoveryTool]:discoveryTool, ...(bootstrap ? {[bootstrapTool]:bootstrapTool} : {})});
  const discoveryArtifacts = snapshot.artifacts.filter(item => item.task_id === f.task.id && item.artifact_type === 'browser_discovery_summary');
  assert.equal(discoveryArtifacts.length, 1);
  assert.deepEqual(snapshot.tool_invocations.find(item => item.task_id === f.task.id && item.tool_name === discoveryTool).output_json, discoveryArtifacts[0].content_json);
  assert.equal(snapshot.tool_invocations.filter(item => item.task_id === f.task.id).length, bootstrap ? 2 : 1);
  assert.ok(snapshot.tool_invocations.every(item => item.status === 'completed'));
  const outcomes = snapshot.agent_memories.filter(item => item.owner_task_id === f.task.id && item.memory_type === 'task_outcome');
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].content_json.status, 'completed');
  assert.equal(outcomes[0].content_json.phase, 'completed');
  assert.equal(outcomes[0].summary, summary);
  assert.equal(snapshot.run.status, 'completed');
}

for (const shape of [
  {name:'intent-only'},
  {name:'legacy task-type-only', taskType:'discover_target', intent:'ordinary_task'},
]) {
  for (const nextDecision of [toolCall(helperTool), {action:'fail_task', reason:'Extra provider decision'}, complete]) {
    test(`${shape.name} discovery completes before extra ${nextDecision.action} decision`, async t => {
      const f = await fixture(t, {...shape, decisions:[toolCall(discoveryTool), nextDecision]});
      assertCompleted(f, await f.runtime.run(f.run.id));
    });
  }
}

for (const config of [{account_mode:'manual'}, {account_mode:'prepare'}, {enable_account_auto_execution:false}, {enable_account_auto_execution:'true'}]) {
  test(`non-auto configuration does not bootstrap: ${JSON.stringify(config)}`, async t => {
    const f = await fixture(t, {config});
    assertCompleted(f, await f.runtime.run(f.run.id));
  });
}

test('discovery can complete on its last task and run decision', async t => {
  const f = await fixture(t, {config:{agent_task_budgets:{discover_target:1}}});
  assertCompleted(f, await f.runtime.run(f.run.id, {max_steps:1}));
});

for (const workers of [1, 3]) {
  test(`completed discovery releases a dependent job with ${workers} workers`, async t => {
    const f = await fixture(t);
    const dependent = await f.repo.createTask({scan_run_id:f.run.id, title:'Dependent fixture', task_type:'autonomous_agent_task',
      dependencies:[f.task.id], execution_plan:{intent:'ordinary_task'}});
    const result = await f.runtime.run(f.run.id, {max_steps:2, max_parallel_agents:workers});
    assertCompleted(f, result, {steps:2});
    assert.equal(result.snapshot.tasks.find(item => item.id === dependent.id).status, 'completed');
    assert.equal(f.contexts[1].task.id, dependent.id);
  });
}

for (const config of [{account_mode:'auto_execute'}, {enable_account_auto_execution:true}]) {
  for (const shape of [{}, {taskType:'discover_target', intent:'ordinary_task'}]) {
    test(`auto preparation follows persisted discovery and completes without another provider decision: ${JSON.stringify({...config,...shape})}`, async t => {
      const f = await fixture(t, {...shape, config:{...config, agent_task_budgets:{discover_target:2},
        auto_account_roles:['attacker','victim'], account_bootstrap_max_pages:3, auto_account_form_values:{fixture:'synthetic'}}});
      assertCompleted(f, await f.runtime.run(f.run.id, {max_steps:2}), {steps:2, summary:bootstrapSummary, bootstrap:true});
      const bootstrap = f.calls[1];
      assert.equal(bootstrap.task.status, 'running');
      assert.equal(bootstrap.task.phase, `tool_completed:${discoveryTool}`);
      assert.deepEqual(bootstrap.invocations.map(item => [item.tool_name,item.status]), [[discoveryTool,'completed']]);
      assert.deepEqual(bootstrap.input, {}, 'The local lifecycle reads potentially sensitive bootstrap settings from the persisted run, not model-visible invocation arguments.');
    });
  }
}

test('auto preparation on default options leaves role and form defaults in the trusted tool', async t => {
  const f = await fixture(t, {config:{account_mode:'auto_execute'}});
  assertCompleted(f, await f.runtime.run(f.run.id), {steps:2, summary:bootstrapSummary, bootstrap:true});
  assert.deepEqual(f.calls[1].input, {});
});

test('an earlier bootstrap does not satisfy preparation after discovery', async t => {
  const f = await fixture(t, {config:{account_mode:'auto_execute'}, decisions:[toolCall(bootstrapTool), toolCall(discoveryTool), complete]});
  const result = await f.runtime.run(f.run.id);
  assert.deepEqual(f.calls.map(item => item.name), [bootstrapTool, discoveryTool, bootstrapTool]);
  assert.equal(f.contexts.length, 2);
  assert.equal(result.steps_executed, 3);
  assert.equal(result.snapshot.tasks.find(item => item.id === f.task.id).result_summary, bootstrapSummary);
  assert.equal(result.snapshot.run.status, 'completed');
});

for (const [taskLimit, runLimit, phase] of [[1,2,'iteration_limit_exceeded'], [2,1,'run_step_limit_exceeded']]) {
  test(`${phase} cannot skip explicitly required preparation`, async t => {
    const f = await fixture(t, {config:{account_mode:'auto_execute', agent_task_budgets:{discover_target:taskLimit}}});
    const {snapshot} = await f.runtime.run(f.run.id, {max_steps:runLimit});
    assert.deepEqual(f.calls.map(item => item.name), [discoveryTool]);
    assert.equal(snapshot.tasks.find(item => item.id === f.task.id).status, 'failed');
    assert.equal(snapshot.tasks.find(item => item.id === f.task.id).phase, phase);
  });
}

for (const config of [{surface:'android'}, {surface_type:'android'}, {mobile:{platform:'android'}}, {android:{platform:'android'}}]) {
  test(`Android lifecycle is not replaced by Web account preparation: ${JSON.stringify(config)}`, async t => {
    const f = await fixture(t, {config:{...config, account_mode:'auto_execute'}});
    await f.repo.updateTask(f.task.id, {status:'running', phase:`tool_completed:${discoveryTool}`});
    const context = await buildAutonomousAgentContext({repo:f.repo, scanRunId:f.run.id, task:await f.repo.getTask(f.task.id), tools:f.runtime.registry.list()});
    const decision = await f.runtime.planner.decide(context);
    assert.equal(decision.tool_name, 'mobile.lab.prepare');
    assert.equal(decision.source, 'local_policy');
    assert.equal(f.contexts.length, 0);
    assert.deepEqual(f.calls, [], 'only a planner decision is inspected; no device tool is invoked');
  });
}

test('successful but partial account preparation retains its recorded result', async t => {
  const data = {ok:true, closure_state:'partial', created_accounts:[], blockers:[{role:'admin', reason:'synthetic prerequisite'}]};
  const f = await fixture(t, {config:{account_mode:'auto_execute'}, bootstrapResult:{ok:true,data}});
  const {snapshot} = await f.runtime.run(f.run.id);
  assert.equal(snapshot.tasks.find(item => item.id === f.task.id).status, 'completed');
  assert.deepEqual(snapshot.artifacts.find(item => item.artifact_type === 'account_auto_bootstrap_result').content_json, data);
  assert.equal(snapshot.tool_invocations.find(item => item.tool_name === bootstrapTool).status, 'completed');
});

for (const config of [{}, {account_mode:'auto_execute'}]) {
  test(`ordinary task reuses discovery and bootstrap without premature completion: ${JSON.stringify(config)}`, async t => {
    const f = await fixture(t, {intent:'ordinary_task', config,
      decisions:[toolCall(discoveryTool), toolCall(bootstrapTool), toolCall(helperTool), complete]});
    const {snapshot, steps_executed} = await f.runtime.run(f.run.id);
    assert.equal(f.contexts.length, 4);
    assert.equal(steps_executed, 4);
    assert.ok(f.contexts.every(item => item.task.status === 'running'));
    assert.deepEqual(f.calls.map(item => item.name), [discoveryTool,bootstrapTool,helperTool]);
    assert.equal(snapshot.tasks.find(item => item.id === f.task.id).result_summary, complete.summary);
  });
}

test('another permitted successful tool leaves discovery running until discovery succeeds', async t => {
  const f = await fixture(t, {decisions:[toolCall(bootstrapTool), toolCall(discoveryTool), complete]});
  const {snapshot} = await f.runtime.run(f.run.id);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.contexts[1].task.status, 'running');
  assert.equal(snapshot.tasks.find(item => item.id === f.task.id).result_summary, discoverySummary);
  assert.deepEqual(f.calls.map(item => item.name), [bootstrapTool, discoveryTool]);
});

for (const name of [discoveryTool, bootstrapTool]) {
  for (const failure of ['result', 'exception', 'artifact', 'invocation']) {
    test(`${name} ${failure} failure remains failed and cannot complete discovery`, async t => {
      const configuredResult = failure === 'result' ? {ok:false, error:'Synthetic tool failure'}
        : failure === 'exception' ? new Error('Synthetic tool failure') : undefined;
      const bootstrap = name === bootstrapTool;
      const f = await fixture(t, {config:bootstrap ? {account_mode:'auto_execute'} : {},
        [bootstrap ? 'bootstrapResult' : 'discoveryResult']:configuredResult});
      const dependent = await f.repo.createTask({scan_run_id:f.run.id, title:'Dependent fixture', task_type:'autonomous_agent_task',
        dependencies:[f.task.id], execution_plan:{intent:'ordinary_task'}});
      if (failure === 'artifact' || failure === 'invocation') {
        await f.db.runRawQuery(failure === 'artifact'
          ? `CREATE TRIGGER reject_discovery_fixture BEFORE INSERT ON ai_scan_artifacts
            WHEN NEW.artifact_type = '${bootstrap ? 'account_auto_bootstrap_result' : 'browser_discovery_summary'}'
            BEGIN SELECT RAISE(ABORT, 'Synthetic persistence failure'); END`
          : `CREATE TRIGGER reject_discovery_fixture BEFORE INSERT ON ai_tool_invocations
            WHEN NEW.tool_name = '${name}' AND NEW.status = 'completed'
            BEGIN SELECT RAISE(ABORT, 'Synthetic persistence failure'); END`);
      }
      const {snapshot} = await f.runtime.run(f.run.id), saved = snapshot.tasks.find(item => item.id === f.task.id);
      assert.equal(saved.status, 'failed');
      assert.equal(snapshot.tasks.find(item => item.id === dependent.id).status, 'blocked');
      assert.match(saved.error_message, /Synthetic (tool|persistence) failure/);
      assert.equal(f.contexts.length, 1);
      assert.deepEqual(f.calls.map(item => item.name), bootstrap ? [discoveryTool,bootstrapTool] : [discoveryTool]);
      assert.equal(snapshot.tool_invocations.find(item => item.tool_name === name).status, 'failed');
      const artifactType = bootstrap ? 'account_auto_bootstrap_result' : 'browser_discovery_summary';
      assert.equal(snapshot.artifacts.filter(item => item.artifact_type === artifactType).length, failure === 'invocation' ? 1 : 0);
      assert.equal(snapshot.agent_memories.find(item => item.owner_task_id === f.task.id && item.memory_type === 'task_outcome').content_json.status, 'failed');
      assert.equal(snapshot.run.status, 'failed');
    });
  }
}
