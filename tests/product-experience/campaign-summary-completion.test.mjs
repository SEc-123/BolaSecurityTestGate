import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {database} from '../mobile-closure/fixtures.mjs';
import {AIScanRepository} from '../../server/src/services/ai-scan/repository.ts';
import {AIScanAgentRuntime} from '../../server/src/agent/agent-runtime.ts';
import {AgentToolRegistry} from '../../server/src/agent/tool-registry.ts';
import {buildProductAssessmentState} from '../../server/src/services/ai-scan/product-state-service.ts';

// Real scheduler, tool registry and native SQLite, with a loopback model protocol
// fixture. Child outcomes are seeded; no browser, live target or device is used.
async function fixture(t, outcomes, {
  summaryByIntent = false,
  firstTool = 'task.summarize_vulnerability_campaign',
  afterSummary = {action:'complete_task', summary:'Campaign evidence summarized; child failures and evidence gaps remain.'},
} = {}) {
  const db = await database(), repo = new AIScanRepository(db);
  t.after(() => db.disconnect());
  const run = await repo.createRun({base_url:'http://127.0.0.1:9/unused-summary-fixture', scan_config:{surface:'web'}});
  const campaign = await repo.createTask({scan_run_id:run.id, title:'Role access campaign',
    task_type:'vulnerability_campaign', vuln_type:'bfla', status:'completed'});
  const children = [];
  for (const status of outcomes) {
    const task = await repo.createTask({scan_run_id:run.id, parent_task_id:campaign.id,
      title:`Role access ${status}`, task_type:'test_generic_vuln', vuln_type:'bfla', status});
    await repo.updateTask(task.id, {phase:status === 'blocked' ? 'dependency_failed' : `fixture_${status}`,
      result_summary:`Local ${status} outcome; no verified security verdict.`,
      ...(status === 'failed' || status === 'blocked' ? {error_message:`Local ${status} reason.`} : {}),
      completed_at:new Date().toISOString()});
    children.push(await repo.getTask(task.id));
  }
  const summary = await repo.createTask({scan_run_id:run.id, parent_task_id:campaign.id,
    title:'Summarize role access evidence', task_type:summaryByIntent ? 'autonomous_agent_task' : 'summarize_vulnerability_campaign', vuln_type:'bfla',
    dependencies:children.map(task => task.id), execution_plan:{...(summaryByIntent ? {intent:'summarize_vulnerability_campaign'} : {}),
      campaign_task_id:campaign.id, child_task_ids:children.map(task => task.id)}});
  const contexts = [];
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const context = JSON.parse(JSON.parse(raw).messages.find(message => message.role === 'user').content).context;
    contexts.push(context);
    const decision = contexts.length === 1
      ? {action:'tool_call', tool_name:firstTool, arguments:{}}
      : afterSummary;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({id:`summary-${contexts.length}`, model:'contract-model',
      choices:[{message:{role:'assistant', content:JSON.stringify(decision)}}]}));
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => new Promise(resolve => { provider.closeAllConnections(); provider.close(resolve); }));
  await db.runRawQuery('INSERT INTO ai_providers (id,name,provider_type,base_url,api_key,model,is_enabled,is_default) VALUES (?,?,?,?,?,?,?,?)',
    ['summary-fixture','Local protocol fixture','openai_compat',`http://127.0.0.1:${provider.address().port}/v1`,'test-only','contract-model',1,1]);
  return {db, repo, run, campaign, children, summary, contexts, runtime:new AIScanAgentRuntime(db)};
}

for (const outcomes of [['failed'], ['blocked'], ['completed', 'failed', 'blocked'], ['completed']]) {
  test(`campaign summary completes independently of child outcomes: ${outcomes.join(', ')}`, async t => {
    const f = await fixture(t, outcomes);
    const result = await f.runtime.run(f.run.id);
    const {snapshot} = result;
    const summaries = snapshot.artifacts.filter(artifact => artifact.artifact_type === 'vulnerability_campaign_summary');
    assert.equal(summaries.length, 1);
    const evidence = summaries[0].content_json;
    const counts = Object.fromEntries(['completed', 'failed', 'blocked'].map(status => [status, outcomes.filter(value => value === status).length]));
    assert.equal(evidence.child_tasks_total, outcomes.length);
    for (const [status, count] of Object.entries(counts)) assert.equal(evidence[`child_tasks_${status}`], count);
    assert.equal(evidence.findings_count, 0);
    assert.deepEqual(evidence.findings, []);
    assert.deepEqual(evidence.residual_gaps, [
      ...(counts.failed ? [`${counts.failed} child task(s) failed`] : []),
      ...(counts.blocked ? [`${counts.blocked} child task(s) blocked`] : []),
      'No confirmed finding for this vulnerability campaign; evidence may be negative or inconclusive.',
    ]);
    for (const child of f.children) {
      assert.deepEqual(snapshot.tasks.find(task => task.id === child.id), child);
      assert.equal(evidence.child_tasks.find(task => task.id === child.id).status, child.status);
    }
    const savedSummary = snapshot.tasks.find(task => task.id === f.summary.id);
    assert.equal(savedSummary.status, 'completed', `${savedSummary.result_summary}; ${savedSummary.error_message}`);
    assert.ok(!savedSummary.error_message);
    const invocations = snapshot.tool_invocations.filter(call => call.task_id === f.summary.id);
    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].status, 'completed');
    assert.deepEqual(invocations[0].output_json, evidence);
    assert.equal(f.contexts.length, 1);
    assert.equal(result.completed, true);
    assert.equal(snapshot.run.status, counts.failed || counts.blocked ? 'failed' : 'completed');
    assert.equal(snapshot.run.summary.tasks_failed, counts.failed);
    assert.equal(snapshot.run.summary.tasks_blocked, counts.blocked);
    const product = buildProductAssessmentState(snapshot);
    assert.equal(product.totals.tests, outcomes.length);
    assert.equal(product.totals.completed, 0);
    assert.equal(product.totals.confirmed_risks, 0);
    assert.ok(product.business_functions.flatMap(feature => feature.tests).every(task => !task.checked && task.outcome === 'inconclusive'));
  });
}

for (const summaryByIntent of [false, true]) {
  test(`successful campaign summary is terminal before a provider can continue testing (${summaryByIntent ? 'intent' : 'type'})`, async t => {
    const f = await fixture(t, ['completed'], {summaryByIntent,
      afterSummary:{action:'tool_call', tool_name:'bstg.generic_vuln.run_test', arguments:{}}});
    const registry = new AgentToolRegistry(), subsequentCalls = [];
    registry.register(f.runtime.registry.list().find(tool => tool.name === 'task.summarize_vulnerability_campaign'));
    registry.register({name:'bstg.generic_vuln.run_test', description:'Explicit no-side-effect continuation fixture', input_schema:{},
      handler:async input => { subsequentCalls.push(input); return {ok:false, error:'Unrelated test must not overwrite a completed summary.'}; }});
    f.runtime.registry = registry;

    const result = await f.runtime.run(f.run.id);
    const snapshot = await f.repo.getSnapshot(f.run.id);
    const saved = snapshot.tasks.find(task => task.id === f.summary.id);
    assert.equal(saved.status, 'completed', saved.error_message);
    assert.equal(saved.phase, 'completed');
    assert.ok(saved.completed_at);
    assert.ok(!saved.error_message);
    assert.deepEqual(subsequentCalls, []);
    assert.equal(f.contexts.length, 1, 'successful summary must not request another provider decision');
    assert.equal(result.steps_executed, 1);
    assert.deepEqual(snapshot.tool_invocations.map(call => [call.tool_name, call.status]), [['task.summarize_vulnerability_campaign', 'completed']]);
    const summaries = snapshot.artifacts.filter(artifact => artifact.artifact_type === 'vulnerability_campaign_summary');
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].task_id, f.summary.id);
    assert.equal(summaries[0].content_json.child_tasks_completed, 1);
    assert.deepEqual(summaries[0].content_json, snapshot.tool_invocations[0].output_json);
    assert.equal(saved.result_summary, 'bfla campaign summary: 1/1 child tasks completed, 0 confirmed finding(s).');
    const memory = snapshot.agent_memories.find(item => item.memory_type === 'task_outcome' && item.owner_task_id === f.summary.id);
    assert.equal(memory.content_json.status, 'completed');
    assert.equal(snapshot.run.status, 'completed');
  });
}

test('campaign summary can complete on the final allowed decision', async t => {
  const f = await fixture(t, ['completed']);
  await f.repo.updateRun(f.run.id, {scan_config:{surface:'web', agent_task_budgets:{default:1}}});
  const result = await f.runtime.run(f.run.id, {max_steps:1});
  const saved = result.snapshot.tasks.find(task => task.id === f.summary.id);
  assert.equal(saved.status, 'completed', saved.error_message);
  assert.equal(saved.phase, 'completed');
  assert.equal(result.steps_executed, 1);
  assert.equal(f.contexts.length, 1);
  assert.equal(result.snapshot.run.status, 'completed');
  assert.equal(result.snapshot.artifacts.filter(artifact => artifact.artifact_type === 'vulnerability_campaign_summary').length, 1);
});

test('a summary tool does not finish an unrelated task', async t => {
  const f = await fixture(t, ['completed'], {afterSummary:{action:'complete_task', summary:'Unrelated task completed after its own decision.'}});
  await f.repo.updateTask(f.summary.id, {task_type:'autonomous_agent_task', execution_plan:{}});
  const result = await f.runtime.run(f.run.id);
  const saved = result.snapshot.tasks.find(task => task.id === f.summary.id);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.contexts[1].task.status, 'running');
  assert.equal(saved.result_summary, 'Unrelated task completed after its own decision.');
  assert.equal(result.steps_executed, 2);
});

test('another successful tool does not finish a summary task', async t => {
  const f = await fixture(t, ['completed'], {firstTool:'bstg.generic_vuln.run_test',
    afterSummary:{action:'tool_call', tool_name:'task.summarize_vulnerability_campaign', arguments:{}}});
  const summaryTool = f.runtime.registry.list().find(tool => tool.name === 'task.summarize_vulnerability_campaign');
  const registry = new AgentToolRegistry();
  registry.register(summaryTool);
  registry.register({name:'bstg.generic_vuln.run_test', description:'Explicit successful helper fixture', input_schema:{},
    handler:async () => ({ok:true, summary:'Helper finished; summary is still needed.'})});
  f.runtime.registry = registry;
  const result = await f.runtime.run(f.run.id);
  assert.equal(f.contexts.length, 2);
  assert.equal(f.contexts[1].task.status, 'running');
  assert.equal(result.snapshot.tasks.find(task => task.id === f.summary.id).status, 'completed');
  assert.equal(result.snapshot.tool_invocations.length, 2);
  assert.equal(result.snapshot.artifacts.filter(artifact => artifact.artifact_type === 'vulnerability_campaign_summary').length, 1);
});

test('campaign summary persistence failure remains a failed tool and summary task', async t => {
  const f = await fixture(t, ['failed']);
  await f.db.runRawQuery(`CREATE TRIGGER reject_summary_fixture BEFORE INSERT ON ai_scan_artifacts
    WHEN NEW.artifact_type = 'vulnerability_campaign_summary'
    BEGIN SELECT RAISE(ABORT, 'Local summary persistence failure'); END`);
  const {snapshot} = await f.runtime.run(f.run.id);
  assert.equal(snapshot.artifacts.filter(artifact => artifact.artifact_type === 'vulnerability_campaign_summary').length, 0);
  const savedSummary = snapshot.tasks.find(task => task.id === f.summary.id);
  assert.equal(savedSummary.status, 'failed');
  assert.match(savedSummary.error_message, /Local summary persistence failure/);
  const invocations = snapshot.tool_invocations.filter(call => call.task_id === f.summary.id);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].status, 'failed');
  assert.match(invocations[0].error_message, /Local summary persistence failure/);
  assert.equal(f.contexts.length, 1);
  assert.deepEqual(snapshot.tasks.find(task => task.id === f.children[0].id), f.children[0]);
  assert.equal(snapshot.run.status, 'failed');
});
