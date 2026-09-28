import test from 'node:test';
import assert from 'node:assert/strict';
import {AutonomousAgentPlanner} from '../../server/src/agent/autonomous-planner.ts';

test('Android vulnerability task executes imported traffic and closes after native evidence', async () => {
  // No provider is configured: these lifecycle decisions must not depend on a
  // later model instruction to reopen a stopped capture session.
  const planner = new AutonomousAgentPlanner({});
  const context = {
    scan: {scan_config: {surface: 'android', mobile: {acquisition_mode: 'scenario'}}},
    task: {task_type: 'test_generic_vuln', vuln_type: 'bola_idor', title: 'Document access', execution_plan: {}, endpoint_ids: ['captured-endpoint']},
    selected_vuln_types: ['bola_idor'],
    relevant_endpoints: [{id: 'captured-endpoint', method: 'GET', path: '/api/documents'}],
    endpoint_inventory_summary: {sample: []},
    task_tool_invocations: [],
  };
  const first = await planner.decide(context);
  assert.equal(first.action, 'tool_call');
  assert.equal(first.tool_name, 'bstg.generic_vuln.run_test');
  assert.equal(first.arguments.endpoint_id, 'captured-endpoint');

  context.task_tool_invocations.push({tool_name: 'bstg.generic_vuln.run_test', status: 'completed', output_summary: 'Native BOLA test completed.'});
  const second = await planner.decide(context);
  assert.equal(second.action, 'complete_task');
  assert.match(second.summary, /Native BOLA/);
});

test('Android feature planning stops after expanding captured candidates', async () => {
  const planner = new AutonomousAgentPlanner({});
  const context = {
    scan: {scan_config: {surface: 'android', mobile: {acquisition_mode: 'scenario'}}},
    task: {task_type: 'autonomous_agent_task', title: 'Model features', execution_plan: {intent: 'model_features_and_candidates'}},
    selected_vuln_types: ['bola_idor'],
    task_tool_invocations: [],
  };
  for (const expected of ['feature.extract_tree', 'vuln.generate_candidates', 'agent.shared_context.prepare', 'task.expand_selected_vulnerabilities']) {
    const decision = await planner.decide(context);
    assert.equal(decision.action, 'tool_call');
    assert.equal(decision.tool_name, expected);
    context.task_tool_invocations.push({tool_name: expected, status: 'completed', output_summary: `${expected} completed.`});
  }
  const complete = await planner.decide(context);
  assert.equal(complete.action, 'complete_task');
});
