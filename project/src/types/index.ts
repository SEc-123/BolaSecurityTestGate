export interface Environment {
  id: string;
  name: string;
  description?: string;
  base_url: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Account {
  id: string;
  name: string;
  username?: string;
  display_name?: string;
  status: string;
  tags?: string[];
  auth_profile?: Record<string, any>;
  variables?: Record<string, any>;
  fields?: Record<string, any>;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface VariableConfig {
  id: string;
  name: string;
  json_path: string;
  operation_type: 'replace' | 'append';
  original_value: string;
  data_source?: 'checklist' | 'account_field' | 'security_rule';
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  is_attacker_field?: boolean;
  path_replacement_mode?: 'placeholder' | 'segment_index' | 'regex';
  path_segment_index?: number;
  path_regex_pattern?: string;
  body_content_type?: 'json' | 'form_urlencoded' | 'multipart' | 'text';
}

export interface FailurePattern {
  type: 'response_code' | 'response_message' | 'http_status' | 'response_header';
  path?: string;
  operator: 'equals' | 'contains' | 'regex' | 'not_equals' | 'not_contains';
  value: string;
}

export interface ParsedRequest {
  method: string;
  path: string;
  protocol?: string;
  headers: Record<string, string>;
  body?: Record<string, any> | string;
}

export type AccountBindingStrategy = 'independent' | 'per_account' | 'anchor_attacker';

export interface BaselineComparisonConfig {
  comparison_mode: 'status_and_body' | 'status_only' | 'body_only' | 'custom';
  rules: {
    compare_status: boolean;
    compare_body_structure: boolean;
    compare_business_code: boolean;
    business_code_path?: string;
    ignore_fields?: string[];
    critical_fields?: string[];
  };
}

export interface WorkflowBaselineConfig {
  ignore_paths?: string[];
  critical_paths?: string[];
  compare_mode?: 'loose' | 'strict';
}

export interface ApiTemplate {
  id: string;
  name: string;
  group_name?: string;
  description?: string;
  raw_request: string;
  parsed_structure: ParsedRequest;
  variables: VariableConfig[];
  failure_patterns: FailurePattern[];
  failure_logic: 'OR' | 'AND';
  is_active: boolean;
  account_binding_strategy?: AccountBindingStrategy;
  attacker_account_id?: string;
  enable_baseline?: boolean;
  baseline_config?: BaselineComparisonConfig;
  advanced_config?: Record<string, any>;
  rate_limit_override?: number;
  created_at: string;
  updated_at: string;
}

export interface HeaderPreset {
  id: string;
  name: string;
  description?: string;
  headers: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export type RuleType = 'idor_userid_swap' | 'privilege_escalation' | 'sensitive_data_leak';

export interface SecurityTestRule {
  id: string;
  name: string;
  rule_type: RuleType;
  description?: string;
  target_templates: string[];
  is_active: boolean;
  parameters: Record<string, any>;
  assertion_config: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface SecurityRule {
  id: string;
  name: string;
  payloads: string[];
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface TestRunProgress {
  total: number;
  completed: number;
  findings: number;
  errors_count?: number;
  current_template?: string;
  current_variable?: string;
}

export type TestRunStatus = 'pending' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

export interface TestRun {
  id: string;
  name?: string;
  status: TestRunStatus;
  execution_type: 'template' | 'workflow';
  rule_ids: string[];
  template_ids: string[];
  account_ids: string[];
  environment_id?: string;
  workflow_id?: string;
  execution_params: Record<string, any>;
  progress_percent: number;
  progress?: TestRunProgress;
  error_message?: string;
  errors_count?: number;
  has_execution_error?: boolean;
  dropped_count?: number;
  findings_count_effective?: number;
  suppressed_count_rule?: number;
  suppressed_count_rate_limit?: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface FindingEvidence {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: {
    status_code: number;
    headers: Record<string, string>;
    body: string;
  };
}

export interface AIAnalysis {
  likelihood: 'high' | 'medium' | 'low' | 'uncertain';
  reasoning: string;
  recommendations?: string[];
}

export interface Finding {
  id: string;
  source_type: 'test_run' | 'workflow';
  test_run_id?: string;
  api_template_id?: string;
  template_id?: string;
  workflow_id?: string;
  rule_id?: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  status: 'new' | 'confirmed' | 'false_positive' | 'fixed';
  title: string;
  description?: string;
  template_name?: string;
  variable_values?: Record<string, string>;
  request_raw?: string;
  response_status?: number;
  response_headers?: Record<string, string>;
  response_body?: string;
  request_evidence?: FindingEvidence;
  response_evidence?: FindingEvidence;
  ai_analysis?: AIAnalysis;
  evidence_comparison?: Record<string, any>;
  notes?: string;
  discovered_at?: string;
  account_source_map?: Record<string, string>;
  attacker_account_id?: string;
  victim_account_ids?: string[];
  baseline_response?: Record<string, any>;
  mutated_response?: Record<string, any>;
  response_diff?: Record<string, any>;
  is_suppressed?: boolean;
  suppression_rule_id?: string;
  suppressed_reason?: 'rule' | 'rate_limited';
  created_at: string;
  updated_at: string;
}

export interface FindingSuppressionRule {
  id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  applies_to: 'test_run' | 'workflow' | 'both';
  match_method: string;
  match_type: 'exact' | 'prefix' | 'regex' | 'contains';
  match_path?: string;
  match_service_id?: string;
  match_template_id?: string;
  match_workflow_id?: string;
  match_environment_id?: string;
  created_at: string;
  updated_at: string;
}

export interface FindingDropRule {
  id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  priority: number;
  applies_to: 'test_run' | 'workflow' | 'both';
  match_method: string;
  match_type: 'exact' | 'prefix' | 'regex' | 'contains';
  match_path?: string;
  match_service_id?: string;
  match_template_id?: string;
  match_workflow_id?: string;
  created_at: string;
  updated_at: string;
}

export interface GovernanceSettings {
  rate_limit_enabled: boolean;
  rate_limit_default: number;
  retention_days_effective: number;
  retention_days_suppressed_rule: number;
  retention_days_suppressed_rate_limit: number;
  retention_days_evidence: number;
  vacuum_mode: 'none' | 'incremental' | 'full_weekly';
  cleanup_interval_hours: number;
  last_cleanup_at?: string;
  last_cleanup_stats?: {
    deleted_effective: number;
    deleted_suppressed_rule: number;
    deleted_suppressed_rate_limit: number;
    deleted_test_runs: number;
    vacuumed: boolean;
    duration_ms: number;
  };
}

export interface Checklist {
  id: string;
  name: string;
  config: {
    values: string[];
  };
  description?: string;
  created_at: string;
  updated_at: string;
}

export type AssertionOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'regex';
export type AssertionLeftType = 'response';
export type AssertionRightType = 'literal' | 'workflow_variable' | 'workflow_context';

export interface AssertionLeft {
  type: AssertionLeftType;
  path: string;
}

export interface AssertionRight {
  type: AssertionRightType;
  value?: string;
  key?: string;
}

export interface StepAssertion {
  op: AssertionOperator;
  left: AssertionLeft;
  right: AssertionRight;
  missing_behavior?: 'fail' | 'skip';
}

export type AssertionsMode = 'all' | 'any';

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  api_template_id: string;
  step_order: number;
  step_assertions?: StepAssertion[];
  assertions_mode?: AssertionsMode;
  failure_patterns_override?: FailurePattern[];
  created_at: string;
  api_template?: ApiTemplate;
}

export interface StepVariableMapping {
  step_order: number;
  json_path: string;
  original_value: string;
}

export type VariableRole = 'attacker' | 'target' | 'neutral';

export interface WorkflowVariableConfig {
  id: string;
  workflow_id: string;
  name: string;
  step_variable_mappings: StepVariableMapping[];
  data_source: 'checklist' | 'account_field' | 'security_rule' | 'workflow_context';
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  binding_strategy?: AccountBindingStrategy;
  attacker_account_id?: string;
  role?: VariableRole;
  is_attacker_field?: boolean;
  advanced_config?: Record<string, any>;
  created_at: string;
}

export type WorkflowAssertionStrategy = 'any_step_pass' | 'all_steps_pass' | 'last_step_pass' | 'specific_steps';

export type ExtractorSource = 'response_body_jsonpath' | 'response_body_regex' | 'response_header' | 'response_status';

export interface ExtractorTransform {
  type: 'trim' | 'lower' | 'upper' | 'prefix' | 'suffix';
  value?: string;
}

export interface WorkflowExtractor {
  id: string;
  workflow_id: string;
  step_order: number;
  name: string;
  source: ExtractorSource;
  expression: string;
  transform?: ExtractorTransform;
  required: boolean;
  created_at: string;
}

export interface SessionJarConfig {
  body_json_paths?: string[];
  header_keys?: string[];
  cookie_mode?: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;
  assertion_strategy?: WorkflowAssertionStrategy;
  critical_step_orders?: number[];
  account_binding_strategy?: AccountBindingStrategy;
  attacker_account_id?: string;
  enable_baseline?: boolean;
  baseline_config?: WorkflowBaselineConfig;
  enable_extractor?: boolean;
  enable_session_jar?: boolean;
  session_jar_config?: SessionJarConfig;
  created_at: string;
  updated_at: string;
  steps?: WorkflowStep[];
  variable_configs?: WorkflowVariableConfig[];
  extractors?: WorkflowExtractor[];
}

export interface VariableSearchMatch {
  template_id: string;
  template_name: string;
  group_name?: string;
  variable_type: 'body' | 'header' | 'query' | 'path';
  variable_name: string;
  json_path: string;
  current_config: {
    operation_type?: 'replace' | 'append';
    data_source?: 'checklist' | 'account_field' | 'security_rule' | 'original';
    checklist_id?: string;
    account_field_name?: string;
    security_rule_id?: string;
  };
  raw_snippet?: string;
}

export interface VariableBulkUpdatePatch {
  operation_type?: 'replace' | 'append';
  data_source?: 'checklist' | 'account_field' | 'security_rule';
  checklist_id?: string;
  account_field_name?: string;
  security_rule_id?: string;
}

export type GateResult = 'PASS' | 'WARN' | 'BLOCK';
export type GateAction = 'PASS' | 'WARN' | 'BLOCK';
export type SecurityRunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type CombineOperator = 'OR' | 'AND';
export type ThresholdOperator = '>=' | '>' | '<=' | '<' | '==' | '!=';

export interface GateThresholdRule {
  operator: ThresholdOperator;
  threshold: number;
  action: GateAction;
}

export interface CICDGatePolicy {
  id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  weight_test: number;
  weight_workflow: number;
  combine_operator: CombineOperator;
  rules_test: GateThresholdRule[];
  rules_workflow: GateThresholdRule[];
  pass_threshold?: number;
  warn_threshold?: number;
  block_threshold?: number;
  created_at: string;
  updated_at: string;
}

export interface SecurityRun {
  id: string;
  status: SecurityRunStatus;
  exit_code?: 0 | 2 | 3 | 4;
  gate_result?: GateResult;
  policy_id?: string;
  test_findings_count: number;
  workflow_findings_count: number;
  gate_score?: number;
  error_message?: string;
  metadata?: {
    template_ids?: string[];
    workflow_ids?: string[];
    account_ids?: string[];
    environment_id?: string;
    started_at?: string;
    completed_at?: string;
    gate_details?: {
      test_findings_count: number;
      workflow_findings_count: number;
      test_weighted_score: number;
      workflow_weighted_score: number;
      test_action: GateAction;
      workflow_action: GateAction;
      combine_operator: CombineOperator;
      final_action: GateAction;
    };
  };
  created_at: string;
  updated_at: string;
  policy?: CICDGatePolicy;
}

export interface DashboardSummary {
  db: {
    connected: boolean;
    schemaVersion: string;
    activeProfileName: string;
    runningRunsCount: number;
  };
  counts: {
    environments: {
      total: number;
      active: number;
    };
    accounts: {
      total: number;
      active: number;
    };
    templates: {
      total: number;
      active: number;
    };
    workflows: {
      total: number;
      baseline: number;
      mutation: number;
      baseline_learned: number;
    };
    gatePolicies: {
      total: number;
      enabled: number;
    };
  };
  runs: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    completed_with_errors: number;
  };
  findings: {
    total: number;
    open: number;
    bySeverity: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      info: number;
    };
  };
  mutationHealth: {
    versionMismatchCount: number;
    mismatches: Array<{
      mutation_workflow_id: string;
      mutation_name: string;
      baseline_workflow_id: string;
      baseline_version: number;
      mutation_version: number;
    }>;
  };
  recent: {
    runs: TestRun[];
    findings: Finding[];
  };
}
