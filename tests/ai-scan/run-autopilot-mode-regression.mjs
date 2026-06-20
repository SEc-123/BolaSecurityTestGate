import assert from 'node:assert/strict';
import { AutonomousAgentPlanner } from '../../server/dist/agent/autonomous-planner.js';

const expectedAllVulns = [
  'file_upload',
  'file_download',
  'path_traversal',
  'bola_idor',
  'bfla',
  'business_logic',
  'xss',
  'command_injection',
  'auth_otp',
  'email_sms_bypass',
  'passcode_bypass',
  'replay_race',
  'state_machine_race',
];

const baseContext = {
  scan: {
    id: 'scan-autopilot-regression',
    base_url: 'http://127.0.0.1:18080/',
    scan_config: {
      driving_mode: 'autopilot',
      auto_start: true,
      selected_scope_strategy: 'all_vulnerability_types',
    },
  },
  task: {
    id: 'task-model',
    title: '生成功能树和漏洞候选',
    task_type: 'autonomous_agent_task',
    execution_plan: { intent: 'model_features_and_candidates' },
    endpoint_ids: [],
  },
  selected_vuln_types: [],
  available_tools: [],
  relevant_endpoints: [],
  endpoint_inventory_summary: {},
  feature_tree: [],
  vulnerability_candidates: [],
  task_artifacts: [],
  task_tool_invocations: [
    { tool_name: 'feature.extract_tree', status: 'completed' },
    { tool_name: 'vuln.generate_candidates', status: 'completed' },
  ],
  global_recent_artifacts: [],
  shared_resources: [],
  shared_resource_summary: {},
  recent_tasks: [],
  operating_rules: [],
};

const planner = new AutonomousAgentPlanner({});
const prepareDecision = await planner.decide(baseContext);
assert.equal(prepareDecision.action, 'tool_call');
assert.equal(prepareDecision.tool_name, 'agent.shared_context.prepare');
assert.deepEqual(prepareDecision.arguments.selected_vuln_types, expectedAllVulns);

const expandDecision = await planner.decide({
  ...baseContext,
  task_tool_invocations: [
    ...baseContext.task_tool_invocations,
    { tool_name: 'agent.shared_context.prepare', status: 'completed' },
  ],
});
assert.equal(expandDecision.action, 'tool_call');
assert.equal(expandDecision.tool_name, 'task.expand_selected_vulnerabilities');
assert.deepEqual(expandDecision.arguments.selected_vuln_types, expectedAllVulns);

console.log('autopilot mode regression passed');
