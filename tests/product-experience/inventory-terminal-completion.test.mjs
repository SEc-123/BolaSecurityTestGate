import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';

const inventoryToolName = 'bstg.capabilities.inventory';
const continuationTools = ['browser.discover_target', 'agent.shared_context.prepare', 'bstg.payload.plan', 'feature.extract_tree', 'bstg.file_upload.run_test'];
const toolCall = tool_name => ({action:'tool_call', tool_name, arguments:{}});
const complete = {action:'complete_task', summary:'Separate task finished after its own decision.'};

// Real scheduler, tool registry, inventory handler and native in-memory SQLite.
// Only the model protocol and unrelated continuation tools are local doubles.
async function fixture(t, {
  intent = 'inventory_bstg_capabilities',
  decisions = [toolCall(inventoryToolName), complete],
  continuationResult = {ok:false, error:'Unrelated work must not overwrite a completed inventory.'},
  inventoryHandler,
} = {}) {
  const db = await database(), repo = new AIScanRepository(db);
  t.after(() => db.disconnect());
  const run = await repo.createRun({base_url:'http://127.0.0.1:9/unused-inventory-fixture', scan_config:{surface:'web'}});
  const task = await repo.createTask({scan_run_id:run.id, title:'Inventory capability fixture', task_type:'autonomous_agent_task', execution_plan:{intent}});
  await repo.updateTask(task.id, {created_assets_json:{fixture_existing_asset:'preserve-existing'}});
  const contexts = [], calls = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const context = JSON.parse(JSON.parse(raw).messages.find(message => message.role === 'user').content).context;
    contexts.push(context);
    const decision = decisions[contexts.length - 1] || complete;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({id:`inventory-${contexts.length}`, model:'contract-model',
      choices:[{message:{role:'assistant', content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['inventory-fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
  const runtime = new AIScanAgentRuntime(db), registry = new AgentToolRegistry();
  const inventory = runtime.registry.list().find(tool => tool.name === inventoryToolName);
  registry.register(inventoryHandler ? {...inventory, handler:(input, context) => inventoryHandler(input, context, inventory.handler)} : inventory);
  for (const name of continuationTools) registry.register({name, description:'Explicit no-side-effect continuation fixture', input_schema:{},
    handler:async () => { calls.push(name); return continuationResult; }});
  runtime.registry = registry;
  return {db, repo, run, task, contexts, calls, runtime};
}

function assertCompletedInventory(f, result) {
  const {snapshot} = result;
  const saved = snapshot.tasks.find(task => task.id === f.task.id);
  assert.equal(saved.status, 'completed', saved.error_message);
  assert.equal(saved.phase, 'completed');
  assert.ok(saved.completed_at);
  assert.ok(!saved.error_message);
  assert.equal(f.contexts.length, 1, 'successful inventory must not request another provider decision');
  assert.equal(result.steps_executed, 1);
  assert.deepEqual(f.calls, []);
  const artifacts = snapshot.artifacts.filter(artifact => artifact.artifact_type === 'bstg_capability_inventory');
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].task_id, f.task.id);
  assert.ok(artifacts[0].content_json.capabilities.length > 0);
  assert.deepEqual(snapshot.tool_invocations.map(call => [call.tool_name, call.status]), [[inventoryToolName, 'completed']]);
  assert.deepEqual(snapshot.tool_invocations[0].output_json, artifacts[0].content_json);
  assert.equal(saved.result_summary, `Inventoried ${artifacts[0].content_json.capabilities.length} native BSTG capability groups for Agent control.`);
  assert.deepEqual(saved.created_assets_json, {fixture_existing_asset:'preserve-existing'});
  const memories = snapshot.agent_memories.filter(item => item.memory_type === 'task_outcome' && item.owner_task_id === f.task.id);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content_json.status, 'completed');
  assert.equal(memories[0].content_json.phase, 'completed');
  assert.equal(memories[0].summary, saved.result_summary);
  assert.equal(snapshot.run.status, 'completed');
}

for (const nextTool of continuationTools) {
  test(`successful inventory is terminal before provider continuation to ${nextTool}`, async t => {
    const f = await fixture(t, {decisions:[toolCall(inventoryToolName), toolCall(nextTool)]});
    assertCompletedInventory(f, await f.runtime.run(f.run.id));
  });
}

test('inventory completes on the final allowed task and run decision', async t => {
  const f = await fixture(t);
  await f.repo.updateRun(f.run.id, {scan_config:{surface:'web', agent_task_budgets:{default:1}}});
  assertCompletedInventory(f, await f.runtime.run(f.run.id, {max_steps:1}));
});

test('terminal inventory retains both existing and returned assets', async t => {
  const f = await fixture(t, {inventoryHandler:async (input, context, original) => {
    const result = await original(input, context);
    return {...result, data:{...result.data, assets:{fixture_returned_asset:'preserve-returned'}}};
  }});
  const {snapshot} = await f.runtime.run(f.run.id);
  const saved = snapshot.tasks.find(task => task.id === f.task.id);
  assert.equal(f.contexts.length, 1);
  assert.equal(saved.status, 'completed');
  assert.deepEqual(saved.created_assets_json, {fixture_existing_asset:'preserve-existing', fixture_returned_asset:'preserve-returned'});
  assert.deepEqual(snapshot.tool_invocations[0].output_json.assets, {fixture_returned_asset:'preserve-returned'});
  assert.equal(snapshot.artifacts.filter(artifact => artifact.artifact_type === 'bstg_capability_inventory').length, 1);
});

test('ordinary task can inventory capabilities and then continue its own tools and completion', async t => {
  const f = await fixture(t, {intent:'ordinary_task', continuationResult:{ok:true, summary:'Separate helper finished.'},
    decisions:[toolCall(inventoryToolName), toolCall('browser.discover_target'), complete]});
  const {snapshot, steps_executed} = await f.runtime.run(f.run.id);
  assert.equal(f.contexts.length, 3);
  assert.equal(f.contexts[1].task.status, 'running');
  assert.equal(f.contexts[2].task.status, 'running');
  assert.deepEqual(f.calls, ['browser.discover_target']);
  assert.equal(steps_executed, 3);
  const saved = snapshot.tasks.find(task => task.id === f.task.id);
  assert.equal(saved.status, 'completed');
  assert.equal(saved.result_summary, complete.summary);
  assert.deepEqual(snapshot.tool_invocations.map(call => call.tool_name).sort(), [inventoryToolName, 'browser.discover_target'].sort());
});

test('an out-of-stage successful tool proposal cannot complete an inventory task', async t => {
  const f = await fixture(t, {continuationResult:{ok:true, summary:'Separate helper finished.'},
    decisions:[toolCall('agent.shared_context.prepare'), toolCall(inventoryToolName)]});
  const {snapshot, steps_executed} = await f.runtime.run(f.run.id);
  assert.equal(f.contexts.length, 1);
  assert.equal(steps_executed, 1);
  assert.deepEqual(f.calls, []);
  assert.equal(snapshot.tasks.find(task => task.id === f.task.id).status, 'completed');
  assert.deepEqual(snapshot.tool_invocations.map(call => call.tool_name), [inventoryToolName]);
  const decision=snapshot.planner_decisions.find(item => item.task_id === f.task.id);
  assert.equal(decision.validation_status, 'rejected');
  assert.equal(decision.rejection_reason, 'policy_rejected');
});

test('unsuccessful inventory result remains a failed invocation and task', async t => {
  const f = await fixture(t, {inventoryHandler:async () => ({ok:false, error:'Local inventory failure', summary:'Inventory unavailable.'})});
  const {snapshot} = await f.runtime.run(f.run.id);
  assert.equal(f.contexts.length, 1);
  assert.deepEqual(f.calls, []);
  const saved = snapshot.tasks.find(task => task.id === f.task.id);
  assert.equal(saved.status, 'failed');
  assert.equal(saved.error_message, 'Local inventory failure');
  assert.equal(snapshot.tool_invocations[0].status, 'failed');
  assert.equal(snapshot.artifacts.filter(artifact => artifact.artifact_type === 'bstg_capability_inventory').length, 0);
  assert.equal(snapshot.agent_memories.find(item => item.memory_type === 'task_outcome' && item.owner_task_id === f.task.id).content_json.status, 'failed');
});

for (const persistence of ['artifact', 'invocation']) {
  test(`inventory ${persistence} persistence failure cannot complete the task`, async t => {
    const f = await fixture(t);
    await f.db.runRawQuery(persistence === 'artifact'
      ? `CREATE TRIGGER reject_inventory_fixture BEFORE INSERT ON ai_scan_artifacts
        WHEN NEW.artifact_type = 'bstg_capability_inventory'
        BEGIN SELECT RAISE(ABORT, 'Local inventory persistence failure'); END`
      : `CREATE TRIGGER reject_inventory_fixture BEFORE INSERT ON ai_tool_invocations
        WHEN NEW.tool_name = 'bstg.capabilities.inventory' AND NEW.status = 'completed'
        BEGIN SELECT RAISE(ABORT, 'Local inventory persistence failure'); END`);
    const {snapshot} = await f.runtime.run(f.run.id);
    const saved = snapshot.tasks.find(task => task.id === f.task.id);
    assert.equal(saved.status, 'failed');
    assert.match(saved.error_message, /Local inventory persistence failure/);
    assert.equal(f.contexts.length, 1);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(snapshot.tool_invocations.map(call => [call.tool_name, call.status]), [[inventoryToolName, 'failed']]);
    assert.equal(snapshot.artifacts.filter(artifact => artifact.artifact_type === 'bstg_capability_inventory').length, persistence === 'artifact' ? 0 : 1);
    assert.equal(snapshot.agent_memories.find(item => item.memory_type === 'task_outcome' && item.owner_task_id === f.task.id).content_json.status, 'failed');
    assert.equal(snapshot.run.status, 'failed');
  });
}
