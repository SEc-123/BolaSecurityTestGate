export type DbKind = 'sqlite' | 'postgres' | 'supabase_postgres';

export interface DbProfile {
  id: string;
  name: string;
  kind: DbKind;
  config: DbConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DbConfig {
  file?: string;
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean;
}

export interface DbStatus {
  activeProfileId: string;
  activeProfileName: string;
  kind: DbKind;
  schemaVersion: string;
  connected: boolean;
  runningRunsCount: number;
}

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

export interface ApiTemplate {
  id: string;
  name: string;
  group_name?: string;
  description?: string;
  raw_request: string;
  parsed_structure: Record<string, any>;
  variables: any[];
  failure_patterns: any[];
  failure_logic: 'OR' | 'AND';
  is_active: boolean;
  account_binding_strategy?: string;
  attacker_account_id?: string;
  enable_baseline?: boolean;
  baseline_config?: Record<string, any>;
  advanced_config?: Record<string, any>;
  rate_limit_override?: number;
  created_at: string;
  updated_at: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  is_active: boolean;
  assertion_strategy?: string;
  critical_step_orders?: number[];
  account_binding_strategy?: string;
  attacker_account_id?: string;
  enable_baseline?: boolean;
  baseline_config?: Record<string, any>;
  enable_extractor?: boolean;
  enable_session_jar?: boolean;
  session_jar_config?: Record<string, any>;
  workflow_type?: 'baseline' | 'mutation';
  base_workflow_id?: string;
  learning_status?: 'unlearned' | 'learning' | 'learned';
  learning_version?: number;
  template_mode?: 'live' | 'snapshot';
  mutation_profile?: MutationProfile;
  created_at: string;
  updated_at: string;
}

export interface ConcurrentReplay {
  step_order: number;
  concurrency: number;
  barrier?: boolean;
  timeout_ms?: number;
  pick_primary?: 'first_success' | 'first' | 'majority_success';
}

export interface ConcurrentResultItem {
  ok: boolean;
  status?: number;
  error?: string;
  duration_ms?: number;
  response_preview?: string;
}

export interface ConcurrentResults {
  step_order: number;
  concurrency: number;
  success_count: number;
  failure_count: number;
  items: ConcurrentResultItem[];
  primary_index: number | null;
}

export interface InjectionOverride {
  variable_name: string;
  to_location: 'request.header' | 'request.cookie' | 'request.query' | 'request.path' | 'request.body';
  to_path: string;
}

export interface ParallelExtraRequest {
  kind: 'extra';
  name: string;
  snapshot_template_id: string;
  snapshot_template_name: string;
  request_snapshot_raw: string;
  repeat?: number;
  injection_overrides?: InjectionOverride[];
}

export interface ParallelGroup {
  anchor_step_order: number;
  barrier?: boolean;
  timeout_ms?: number;
  extras: ParallelExtraRequest[];
  pick_primary?: 'anchor_first_success' | 'anchor_first';
  writeback_policy?: 'primary_only' | 'none';
}

export interface ParallelExtraResult {
  name: string;
  template_id: string;
  ok: boolean;
  status?: number;
  error?: string;
  duration_ms?: number;
  response_preview?: string;
}

export interface ParallelResults {
  anchor_step_order: number;
  extras: ParallelExtraResult[];
}

export interface MutationProfile {
  skip_steps?: number[];
  swap_account_at_steps?: { step_order: number; account_id: string }[];
  lock_variables?: string[];
  replay_mode?: boolean;
  repeat_steps?: Record<number, number>;
  reuse_tickets?: boolean;
  concurrent_replay?: ConcurrentReplay;
  parallel_groups?: ParallelGroup[];
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  api_template_id: string;
  step_order: number;
  step_assertions?: any[];
  assertions_mode?: string;
  failure_patterns_override?: any[];
  request_snapshot_raw?: string;
  failure_patterns_snapshot?: any[];
  snapshot_template_name?: string;
  snapshot_template_id?: string;
  snapshot_created_at?: string;
  created_at: string;
}

export interface WorkflowVariableConfig {
  id: string;
  workflow_id: string;
  name: string;
  step_variable_mappings: any[];
  data_source: string;
  checklist_id?: string;
  security_rule_id?: string;
  account_field_name?: string;
  binding_strategy?: string;
  attacker_account_id?: string;
  role?: string;
  is_attacker_field?: boolean;
  advanced_config?: Record<string, any>;
  account_scope_mode?: 'all' | 'only_selected' | 'exclude_selected';
  account_scope_ids?: string[];
  created_at: string;
}

export interface WorkflowExtractor {
  id: string;
  workflow_id: string;
  step_order: number;
  name: string;
  source: string;
  expression: string;
  transform?: Record<string, any>;
  required: boolean;
  created_at: string;
}

export interface Checklist {
  id: string;
  name: string;
  config: { values: string[] };
  description?: string;
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

export interface TestRun {
  id: string;
  name?: string;
  status: string;
  execution_type?: string;
  trigger_type?: string;
  rule_ids?: string[];
  template_ids?: string[];
  account_ids?: string[];
  environment_id?: string;
  workflow_id?: string;
  execution_params?: Record<string, any>;
  progress_percent: number;
  progress?: Record<string, any>;
  error_message?: string;
  errors_count?: number;
  has_execution_error?: boolean;
  validation_report?: Record<string, any>;
  dropped_count?: number;
  findings_count_effective?: number;
  suppressed_count_rule?: number;
  suppressed_count_rate_limit?: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface Finding {
  id: string;
  source_type: string;
  test_run_id?: string;
  security_run_id?: string;
  api_template_id?: string;
  template_id?: string;
  workflow_id?: string;
  rule_id?: string;
  severity: string;
  status: string;
  title: string;
  description?: string;
  template_name?: string;
  variable_values?: Record<string, string>;
  request_raw?: string;
  response_status?: number;
  response_headers?: Record<string, string>;
  response_body?: string;
  request_evidence?: Record<string, any>;
  response_evidence?: Record<string, any>;
  ai_analysis?: Record<string, any>;
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

export interface CicdGatePolicy {
  id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  weight_test: number;
  weight_workflow: number;
  combine_operator: string;
  rules_test: any[];
  rules_workflow: any[];
  pass_threshold?: number;
  warn_threshold?: number;
  block_threshold?: number;
  created_at: string;
  updated_at: string;
}

export interface SecuritySuite {
  id: string;
  name: string;
  description?: string;
  environment_id?: string;
  environment_name?: string;
  template_ids: string[];
  workflow_ids: string[];
  account_ids: string[];
  policy_id?: string;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface SecurityRun {
  id: string;
  status: string;
  exit_code?: number;
  gate_result?: string;
  policy_id?: string;
  test_findings_count: number;
  workflow_findings_count: number;
  gate_score?: number;
  error_message?: string;
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export interface FindingSuppressionRule {
  id: string;
  name: string;
  description?: string;
  is_enabled: boolean;
  applies_to: string;
  match_method: string;
  match_type: string;
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
  applies_to: string;
  match_method: string;
  match_type: string;
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
  last_cleanup_stats?: Record<string, any>;
}

export interface Repository<T> {
  findAll(options?: { where?: Partial<T>; limit?: number; offset?: number }): Promise<T[]>;
  findById(id: string): Promise<T | null>;
  create(data: Omit<T, 'id' | 'created_at' | 'updated_at'>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T | null>;
  delete(id: string): Promise<boolean>;
  count(where?: Partial<T>): Promise<number>;
}

export interface DbRepositories {
  environments: Repository<Environment>;
  accounts: Repository<Account>;
  apiTemplates: Repository<ApiTemplate>;
  workflows: Repository<Workflow>;
  workflowSteps: Repository<WorkflowStep>;
  workflowVariableConfigs: Repository<WorkflowVariableConfig>;
  workflowExtractors: Repository<WorkflowExtractor>;
  checklists: Repository<Checklist>;
  securityRules: Repository<SecurityRule>;
  testRuns: Repository<TestRun>;
  findings: Repository<Finding>;
  cicdGatePolicies: Repository<CicdGatePolicy>;
  securitySuites: Repository<SecuritySuite>;
  securityRuns: Repository<SecurityRun>;
  findingSuppressionRules: Repository<FindingSuppressionRule>;
  findingDropRules: Repository<FindingDropRule>;
  dbProfiles: Repository<DbProfile>;
}

export interface DbProvider {
  kind: DbKind;
  profileId: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
  getSchemaVersion(): Promise<string>;
  migrate(): Promise<void>;
  repos: DbRepositories;
  runRawQuery<T = any>(sql: string, params?: any[]): Promise<T[]>;
}
