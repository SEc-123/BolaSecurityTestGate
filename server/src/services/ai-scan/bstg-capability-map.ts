import type { DbProvider } from '../../types/index.js';
import { dbGet } from '../../db/sql-helpers.js';

export interface BstgCapabilityDescriptor {
  id: string;
  name: string;
  layer: 'discovery' | 'asset' | 'execution' | 'learning' | 'mutation' | 'identity' | 'validation' | 'evidence';
  ai_tool_names: string[];
  native_tables: string[];
  production_role: string;
  agent_usage: string;
  closure_requirement: string;
}

export const BSTG_CAPABILITIES: BstgCapabilityDescriptor[] = [
  {
    id: 'api_templates',
    name: 'API template raw-request execution unit',
    layer: 'asset',
    ai_tool_names: ['bstg.api_test.run', 'bstg.native.compile_and_run', 'bstg.template.inspect'],
    native_tables: ['api_templates', 'test_runs'],
    production_role: 'Canonical replayable HTTP request asset. Agent must compile single-interface testable endpoints into API-mode templates and execute native template test_runs before workflow mutation/finding.',
    agent_usage: 'Create from observed browser/network requests, attach variables, payload dictionaries, account binding strategy, baseline config, and failure patterns.',
    closure_requirement: 'Confirmed finding must reference native API-mode template test_run evidence and, when a chain exists, workflow evidence too.',
  },
  {
    id: 'api_test_run_mode',
    name: 'Single API test run execution mode',
    layer: 'execution',
    ai_tool_names: ['bstg.api_test.run', 'bstg.payload.plan', 'bstg.evidence.evaluate_native_gate'],
    native_tables: ['api_templates', 'test_runs', 'security_rules', 'checklists', 'accounts'],
    production_role: 'Tests vulnerabilities that do not require multi-step sequencing through native template test_run execution: XSS, command injection, path traversal, file download, simple BOLA/BFLA and parameter tampering.',
    agent_usage: 'Compile one observed request into baseline and mutation API templates, attach security_rules/checklists/account fields, execute template test_runs, and feed native evidence into the finding gate.',
    closure_requirement: 'Single-interface findings require native_api_test_run artifact and successful API-mode baseline + mutation template test_runs.',
  },
  {
    id: 'workflows',
    name: 'Multi-step workflow orchestration',
    layer: 'execution',
    ai_tool_names: ['bstg.native.compile_and_run', 'bstg.workflow.inspect', 'bstg.workflow.repair_with_learning'],
    native_tables: ['workflows', 'workflow_steps', 'test_runs'],
    production_role: 'Models login, OTP, upload, order, payment, download, admin and chained API flows.',
    agent_usage: 'Compile ordered endpoint context into baseline workflow and mutation workflow; validate baseline before attack stage.',
    closure_requirement: 'Mutation may not create finding unless baseline workflow is verified and mutation workflow executed.',
  },
  {
    id: 'workflow_variables_mappings_extractors',
    name: 'Extractor, VariablePool and cross-step mapping',
    layer: 'learning',
    ai_tool_names: ['bstg.learning.repair_workflow', 'bstg.workflow.inspect'],
    native_tables: ['workflow_extractors', 'workflow_variables', 'workflow_mappings', 'workflow_variable_configs', 'workflow_learning_suggestions', 'workflow_learning_evidence'],
    production_role: 'Keeps values from one step and injects them into later steps: token, csrf, object_id, order_id, file_url, cookies and flow tickets.',
    agent_usage: 'Start with heuristic mappings, then run execution learning from actual traces and apply high-confidence suggestions automatically.',
    closure_requirement: 'Baseline failure should trigger learning repair and rerun before task is considered failed or blocked.',
  },
  {
    id: 'session_jar',
    name: 'Session jar and cookie/header/body session propagation',
    layer: 'identity',
    ai_tool_names: ['bstg.learning.repair_workflow', 'bstg.identity.prepare_accounts'],
    native_tables: ['workflows', 'test_runs', 'workflow_learning_suggestions'],
    production_role: 'Maintains login/session continuity across multi-step workflows and separates attacker/victim/admin identities.',
    agent_usage: 'Enable session jar, learn Set-Cookie/session response sources, propagate Cookie/Authorization/X-CSRF headers.',
    closure_requirement: 'Workflow artifacts must show session jar configuration and baseline execution with no session-related execution error.',
  },
  {
    id: 'security_rules_checklists',
    name: 'Security payload dictionaries and checklist value pools',
    layer: 'mutation',
    ai_tool_names: ['bstg.payload.plan', 'bstg.native.compile_and_run'],
    native_tables: ['security_rules', 'checklists', 'workflow_variable_configs'],
    production_role: 'Supplies payloads and enumerated values to native template/workflow runners.',
    agent_usage: 'Pick or create vulnerability-specific security_rules, extract observed IDs into checklists, bind them through workflow_variable_configs.',
    closure_requirement: 'Mutation workflow must consume security_rule/checklist/account_field variables rather than using only ad-hoc direct HTTP payloads.',
  },
  {
    id: 'account_binding_anchor_attacker',
    name: 'Account binding strategies and anchor attacker',
    layer: 'identity',
    ai_tool_names: ['bstg.identity.prepare_accounts', 'bstg.native.compile_and_run'],
    native_tables: ['accounts', 'api_templates', 'workflows', 'workflow_variable_configs'],
    production_role: 'Drives BOLA/BFLA and multi-account logic tests using attacker/victim/admin account field pools.',
    agent_usage: 'Create/import accounts, bind attacker auth fields, bind victim object IDs, configure anchor_attacker strategy and scoped account pools.',
    closure_requirement: 'Access-control findings must include account mapping and native validation report with attacker/victim/admin scope.',
  },
  {
    id: 'mutation_profile',
    name: 'Workflow mutation profile',
    layer: 'mutation',
    ai_tool_names: ['bstg.mutation.plan', 'bstg.native.compile_and_run'],
    native_tables: ['workflows', 'test_runs'],
    production_role: 'Encodes skip/repeat/replay/swap-account/concurrent-replay behavior for business logic, BOLA, BFLA and race tests.',
    agent_usage: 'Derive mutation profile from selected vuln type and business flow, then execute as native mutation workflow.',
    closure_requirement: 'Every non-upload vulnerability task should have a mutation workflow whose mutation_profile explains the test strategy.',
  },
  {
    id: 'advanced_state_machine_mutation',
    name: 'Advanced state-machine, replay, race and parallel workflow mutation',
    layer: 'mutation',
    ai_tool_names: ['bstg.mutation.plan', 'bstg.generic_vuln.run_test', 'bstg.native.compile_and_run'],
    native_tables: ['workflows', 'test_runs', 'ai_scan_artifacts'],
    production_role: 'Tests non-linear business logic defects through skip_steps, repeat_steps, same-packet concurrent_replay and cross-packet parallel_groups, e.g. refund + cancel, pay + refund, withdraw + transfer, OTP verify + replay.',
    agent_usage: 'For business_logic/replay_race/auth/passcode tasks, derive a state-machine mutation plan from the normal workflow and encode concurrent_replay/parallel_groups into native BSTG mutation_profile before execution.',
    closure_requirement: 'State/race findings must reference advanced_mutation_plan and advanced_mutation_execution artifacts with native mutation workflow evidence.',
  },
  {
    id: 'validation_gate',
    name: 'Validation report, baseline comparison and evidence gate',
    layer: 'validation',
    ai_tool_names: ['bstg.evidence.evaluate_native_gate'],
    native_tables: ['test_runs', 'findings', 'ai_scan_artifacts'],
    production_role: 'Prevents confirmed findings without native execution proof.',
    agent_usage: 'Review native template/workflow run status, validation_report, baseline/mutation execution, direct confirmation and missing evidence.',
    closure_requirement: 'Confirmed generic findings require native_evidence_gate=confirmed. Dedicated multipart findings require upload_evidence_gate=confirmed with normal readback and verified execution impact. Incomplete evidence remains inconclusive.',
  },
];

const COUNT_TABLES = [
  'api_templates', 'workflows', 'workflow_steps', 'workflow_variable_configs', 'workflow_extractors',
  'workflow_variables', 'workflow_mappings', 'workflow_learning_suggestions', 'workflow_learning_evidence',
  'security_rules', 'checklists', 'accounts', 'test_runs', 'findings', 'environments',
];

export async function getBstgCapabilityInventory(db: DbProvider): Promise<{ capabilities: BstgCapabilityDescriptor[]; native_counts: Record<string, number>; summary: Record<string, any> }> {
  const native_counts: Record<string, number> = {};
  for (const table of COUNT_TABLES) {
    try {
      const row = await dbGet<any>(db, `SELECT COUNT(*) as c FROM ${table}`, []);
      native_counts[table] = Number(row?.c || 0);
    } catch {
      native_counts[table] = 0;
    }
  }
  return {
    capabilities: BSTG_CAPABILITIES,
    native_counts,
    summary: {
      capability_count: BSTG_CAPABILITIES.length,
      layers: [...new Set(BSTG_CAPABILITIES.map(item => item.layer))],
      ai_tool_count: [...new Set(BSTG_CAPABILITIES.flatMap(item => item.ai_tool_names))].length,
      production_gate: 'confirmed findings require native API-mode test run + aggregate template run + baseline workflow + mutation workflow evidence',
    },
  };
}
