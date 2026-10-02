import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../mobile-closure/fixtures.mjs';
import { AIScanRepository } from '../../server/src/services/ai-scan/repository.ts';
import { buildBusinessFlowToolSpecs } from '../../server/src/agent/tools/business-agent-tools.ts';
import { AgentToolRegistry } from '../../server/src/agent/tool-registry.ts';
import { buildAutonomousAgentContext } from '../../server/src/agent/context-builder.ts';
import { localPolicy } from '../../server/src/agent/autonomous-planner.ts';
import { BUSINESS_PLAN_INTENT } from '../../server/src/agent/business-task-lifecycle.ts';

async function fixture(t) {
  const db = await database();
  t.after(() => db.disconnect());
  const repo = new AIScanRepository(db);
  const run = await repo.createRun({
    base_url: 'https://authorized.example.test',
    scan_config: {
      accounts: {
        customer_one: { username: 'customer-one', password: 'fixture-only' },
        'member@example.test': { auth_token: 'fixture-email-identity' },
        '成员一': { cookie: 'sid=fixture-unicode-identity' },
        empty_account: {},
      },
    },
  });
  const task = await repo.createTask({ scan_run_id: run.id, title: 'Plan normal flows', task_type: 'plan_business_flows' });
  await db.repos.accounts.create({
    name: 'Authenticated supplied member',
    username: 'fixture-attacker',
    status: 'active',
    tags: ['ai_scan', `scan:${run.id}`, 'role:attacker'],
    fields: { auth_token: 'fixture-only' },
    variables: {},
    auth_profile: {},
  });
  const define = buildBusinessFlowToolSpecs().find(tool => tool.name === 'bstg.business.flow.define');
  assert.ok(define, 'business flow definition tool is registered');
  return { db, repo, run, task, define, context: { db, repo, scanRunId: run.id, taskId: task.id } };
}

test('flow definition stores only exact active or supplied executable identity keys', async t => {
  const f = await fixture(t);

  const supplied = await f.define.handler({ name: 'Customer setting', goal: 'The customer sees the saved setting', role: 'customer_one' }, f.context);
  assert.equal(supplied.ok, true, supplied.error);
  assert.equal(supplied.data.role, 'customer_one');

  const active = await f.define.handler({ name: 'Authenticated setting', goal: 'The signed-in member sees the saved setting', role: 'attacker' }, f.context);
  assert.equal(active.ok, true, active.error);
  assert.equal(active.data.role, 'attacker');

  const emailKey = await f.define.handler({ name: 'Email-key setting', goal: 'The supplied member sees the saved setting', role: 'member@example.test' }, f.context);
  assert.equal(emailKey.ok, true, emailKey.error);
  assert.equal(emailKey.data.role, 'member@example.test');

  const unicodeKey = await f.define.handler({ name: 'Unicode-key setting', goal: 'The supplied member sees the saved setting', role: '成员一' }, f.context);
  assert.equal(unicodeKey.ok, true, unicodeKey.error);
  assert.equal(unicodeKey.data.role, '成员一');

  const anonymous = await f.define.handler({ name: 'Public search', goal: 'A public search shows matching results' }, f.context);
  assert.equal(anonymous.ok, true, anonymous.error);
  assert.equal(anonymous.data.role, 'anonymous');

  const flows = (await f.repo.listArtifacts(f.run.id)).filter(artifact => artifact.artifact_type === 'business_flow');
  assert.deepEqual(flows.map(artifact => artifact.content_json.role).sort(), ['anonymous', 'attacker', 'customer_one', 'member@example.test', '成员一']);
});

test('a human display label is a recoverable identity-key request and never defines a flow', async t => {
  const f = await fixture(t);

  const rejected = await f.define.handler({
    name: 'Authenticated profile update',
    goal: 'The signed-in member sees the saved profile',
    role: 'Authenticated supplied member',
  }, f.context);

  assert.equal(rejected.ok, true, rejected.error);
  assert.equal(rejected.data.status, 'identity_key_required');
  assert.equal(rejected.data.identity_key_required, true);
  assert.deepEqual(rejected.data.allowed_identity_keys, ['attacker', 'customer_one', 'member@example.test', '成员一']);
  assert.match(rejected.summary, /was not defined/);
  assert.match(rejected.summary, /attacker, customer_one, member@example\.test, 成员一/);
  assert.match(rejected.summary, /display labels are not executable identity keys/);

  const whitespaceAlias = await f.define.handler({
    name: 'Second profile update',
    goal: 'The signed-in member sees the saved profile',
    role: 'attacker ',
  }, f.context);
  assert.equal(whitespaceAlias.ok, true, whitespaceAlias.error);
  assert.equal(whitespaceAlias.data.status, 'identity_key_required');

  const flows = (await f.repo.listArtifacts(f.run.id)).filter(artifact => artifact.artifact_type === 'business_flow');
  assert.equal(flows.length, 0, 'identity-key recovery must not create a flow or satisfy planning coverage');
});

test('identity-key recovery is persisted as safe model feedback instead of a failed planning invocation', async t => {
  const f = await fixture(t);
  const registry = new AgentToolRegistry();
  registry.register(f.define);

  const result = await registry.call('bstg.business.flow.define', {
    name: 'Authenticated profile update',
    goal: 'The signed-in member sees the saved profile',
    role: 'Authenticated supplied member',
  }, { ...f.context, allowed_tool_names: ['bstg.business.flow.define'] });

  assert.equal(result.ok, true, result.error);
  const invocation = (await f.repo.listToolInvocations(f.run.id, f.task.id))[0];
  assert.equal(invocation.status, 'completed');
  assert.equal(invocation.output_json.status, 'identity_key_required');
  assert.match(invocation.output_json.summary, /attacker, customer_one, member@example\.test, 成员一/);
  const modelContext = await buildAutonomousAgentContext({ repo: f.repo, scanRunId: f.run.id, task: f.task, tools: [f.define] });
  assert.match(JSON.stringify(modelContext.task_tool_invocations), /attacker, customer_one, member@example\.test, 成员一/);
  assert.equal((await f.repo.listArtifacts(f.run.id)).filter(artifact => artifact.artifact_type === 'business_flow').length, 0);
});

test('coverage inspection keeps server graph references callable while omitting transport scalar values', async t => {
  const f = await fixture(t);
  const registry = new AgentToolRegistry();
  registry.register({
    name: 'bstg.business.coverage.inspect', description: 'Safe fixture coverage inventory', input_schema: {},
    handler: async () => ({ok: true, data: {
      plan_task_id: f.task.id,
      targets: [
        {target_type: 'feature', target_id: 'feature-ref-1', feature_id: 'feature-ref-1', name: 'Profile', disposition: 'uncovered'},
        {target_type: 'operation', target_id: 'endpoint-ref-1', endpoint_id: 'endpoint-ref-1', name: 'POST /profile', disposition: 'planned'},
      ],
      private_transport_value: 'never-model-visible-body-value',
    }}),
  });
  await registry.call('bstg.business.coverage.inspect', {}, {...f.context, allowed_tool_names: ['bstg.business.coverage.inspect']});
  const invocation = (await f.repo.listToolInvocations(f.run.id, f.task.id))[0];
  assert.equal(invocation.output_json.targets[0].target_id, 'feature-ref-1');
  assert.equal(invocation.output_json.targets[1].endpoint_id, 'endpoint-ref-1');
  assert.deepEqual(invocation.output_json.targets.map(target=>target.disposition), ['uncovered','planned']);
  assert.equal(JSON.stringify(invocation.output_json).includes('never-model-visible-body-value'), false);

  const context = await buildAutonomousAgentContext({repo: f.repo, scanRunId: f.run.id, task: f.task, tools: registry.list()});
  const modelInventory = context.task_tool_invocations[0].output_json.targets;
  assert.equal(modelInventory[0].target_id, 'feature-ref-1');
  assert.equal(modelInventory[1].endpoint_id, 'endpoint-ref-1');
  assert.deepEqual(modelInventory.map(target=>target.disposition), ['uncovered','planned']);
  assert.equal(JSON.stringify(context).includes('never-model-visible-body-value'), false);
});

test('workflow inspection keeps every safe semantic assertion path without exposing captured structures', async t => {
  const f = await fixture(t);
  const registry = new AgentToolRegistry();
  registry.register({
    name: 'bstg.business.workflow.inspect', description: 'Safe workflow inspection fixture', input_schema: {},
    handler: async () => ({ok: true, data: {
      flow_id: 'flow-current', workflow_id: 'workflow-current', recording_session_id: 'recording-current', identity_key: 'customer_one',
      goal: 'The supplied identity sees the saved profile state',
      steps: [
        {step_id: 'step-1', step_order: 1, template_id: 'template-1', name: 'Load profile', structure: {body: 'private-body-value'},
          assertion_paths: [{path: 'status', semantic: false}, {path: 'body.user_id', semantic: true}], semantic_body_path_available: true},
        {step_id: 'step-2', step_order: 2, template_id: 'template-2', name: 'Save profile', structure: {body: 'private-body-value'},
          assertion_paths: [{path: 'status', semantic: false}, {path: 'body.applied', semantic: true}, {path: 'body.display_name', semantic: true}], semantic_body_path_available: true},
        {step_id: 'step-3', step_order: 3, template_id: 'template-3', name: 'Read saved profile', structure: {body: 'private-body-value'},
          assertion_paths: [{path: 'headers.content-type', semantic: false}, {path: 'body.display_name', semantic: true}], semantic_body_path_available: true},
      ],
      learning_candidates: {private_trace: 'private-body-value'},
      coverage_bindings: [{target_type: 'operation', target_id: 'operation-current', endpoint_id: 'endpoint-current', action_id: 'action-current', source_step_order: 2, source_workflow_id: 'workflow-current', validated: false}],
    }}),
  });
  await registry.call('bstg.business.workflow.inspect', {workflow_id: 'workflow-current'}, {...f.context, allowed_tool_names: ['bstg.business.workflow.inspect']});
  const context = await buildAutonomousAgentContext({repo: f.repo, scanRunId: f.run.id, task: f.task, tools: registry.list()});
  const output = context.task_tool_invocations[0].output_json;
  assert.equal(output.workflow_id, 'workflow-current');
  assert.deepEqual(output.steps.map(step => step.step_order), [1, 2, 3]);
  assert.deepEqual(output.steps[1].assertion_paths, [
    {path: 'status', semantic: false}, {path: 'body.applied', semantic: true}, {path: 'body.display_name', semantic: true},
  ]);
  assert.ok(output.steps.every(step => step.semantic_body_path_available === true));
  assert.equal(output.steps[0].structure, undefined);
  assert.equal(JSON.stringify(output).includes('private-body-value'), false);
  assert.equal(output.coverage_bindings[0].target_id, 'operation-current');
});

test('the local planning fallback never invents an authenticated display label', () => {
  const next = localPolicy({
    scan: { base_url: 'https://authorized.example.test', scan_config: {} },
    task: { id: 'plan', task_type: 'plan_business_flows', execution_plan: { intent: BUSINESS_PLAN_INTENT } },
    selected_vuln_types: [],
    task_tool_invocations: [
      { tool_name: 'browser.navigate', status: 'completed', output_json: {} },
      { tool_name: 'bstg.business.coverage.inspect', status: 'completed', output_json: { targets: [] } },
    ],
    task_artifacts: [],
    feature_tree: [],
    business_flows: [],
  });
  assert.equal(next.tool_name, 'bstg.business.flow.define');
  assert.equal(next.arguments.role, 'anonymous');
  assert.match(next.rationale, /only role safe to synthesize/);
  assert.match(next.rationale, /never a display label/);
});
