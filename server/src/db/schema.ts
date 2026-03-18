export const SCHEMA_VERSION = '1.1.8';

export const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS db_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sqlite', 'postgres')),
  config TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  base_url TEXT NOT NULL,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  status TEXT DEFAULT 'active',
  tags TEXT,
  auth_profile TEXT,
  variables TEXT,
  fields TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  group_name TEXT,
  description TEXT,
  raw_request TEXT NOT NULL,
  parsed_structure TEXT,
  variables TEXT DEFAULT '[]',
  failure_patterns TEXT DEFAULT '[]',
  failure_logic TEXT DEFAULT 'OR',
  is_active INTEGER DEFAULT 1,
  account_binding_strategy TEXT,
  attacker_account_id TEXT,
  enable_baseline INTEGER DEFAULT 0,
  baseline_config TEXT,
  advanced_config TEXT,
  rate_limit_override INTEGER,
  source_recording_session_id TEXT,
  failure_template_id TEXT,
  account_binding_template_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);


CREATE TABLE IF NOT EXISTS failure_pattern_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  failure_patterns TEXT DEFAULT '[]',
  failure_logic TEXT DEFAULT 'OR',
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_binding_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  binding_strategy TEXT DEFAULT 'independent',
  attacker_account_id TEXT,
  enable_baseline INTEGER DEFAULT 0,
  baseline_config TEXT,
  rate_limit_override INTEGER,
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  assertion_strategy TEXT DEFAULT 'any_step_pass',
  critical_step_orders TEXT,
  account_binding_strategy TEXT,
  attacker_account_id TEXT,
  enable_baseline INTEGER DEFAULT 0,
  baseline_config TEXT,
  enable_extractor INTEGER DEFAULT 0,
  enable_session_jar INTEGER DEFAULT 0,
  session_jar_config TEXT,
  workflow_type TEXT DEFAULT 'baseline' CHECK (workflow_type IN ('baseline', 'mutation')),
  base_workflow_id TEXT,
  learning_status TEXT DEFAULT 'unlearned' CHECK (learning_status IN ('unlearned', 'learned')),
  learning_version INTEGER DEFAULT 0,
  learning_source_preference TEXT DEFAULT 'execution_only',
  last_learning_session_id TEXT,
  last_learning_mode TEXT,
  template_mode TEXT DEFAULT 'reference' CHECK (template_mode IN ('reference', 'snapshot')),
  mutation_profile TEXT,
  source_recording_session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (base_workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  api_template_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  step_assertions TEXT,
  assertions_mode TEXT DEFAULT 'all',
  failure_patterns_override TEXT,
  request_snapshot_raw TEXT,
  parsed_snapshot TEXT,
  failure_patterns_snapshot TEXT,
  snapshot_template_name TEXT,
  snapshot_template_id TEXT,
  snapshot_created_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (api_template_id) REFERENCES api_templates(id)
);

CREATE TABLE IF NOT EXISTS workflow_variable_configs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  step_variable_mappings TEXT NOT NULL,
  data_source TEXT NOT NULL,
  checklist_id TEXT,
  security_rule_id TEXT,
  account_field_name TEXT,
  binding_strategy TEXT,
  attacker_account_id TEXT,
  role TEXT,
  is_attacker_field INTEGER DEFAULT 0,
  advanced_config TEXT,
  account_scope_mode TEXT DEFAULT 'all',
  account_scope_ids TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_extractors (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  expression TEXT NOT NULL,
  transform TEXT,
  required INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_variables (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'GENERIC')),
  source TEXT NOT NULL CHECK (source IN ('account_injected', 'extracted', 'manual')),
  write_policy TEXT NOT NULL DEFAULT 'first' CHECK (write_policy IN ('first', 'overwrite', 'on_success_only')),
  is_locked INTEGER DEFAULT 0,
  description TEXT,
  current_value TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  UNIQUE(workflow_id, name)
);

CREATE TABLE IF NOT EXISTS workflow_mappings (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  from_step_order INTEGER NOT NULL,
  from_location TEXT NOT NULL CHECK (from_location IN ('response.body', 'response.header', 'response.cookie')),
  from_path TEXT NOT NULL,
  to_step_order INTEGER NOT NULL,
  to_location TEXT NOT NULL CHECK (to_location IN ('request.body', 'request.header', 'request.cookie', 'request.query', 'request.path')),
  to_path TEXT NOT NULL,
  variable_name TEXT NOT NULL,
  confidence REAL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT CHECK (reason IN ('same_name', 'same_value', 'heuristic', 'manual')),
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workflow_learning_suggestions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('recording_only', 'execution_only', 'hybrid')),
  source_recording_session_id TEXT,
  source_execution_run_id TEXT,
  suggestion_payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'applied', 'archived')),
  learning_version INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE,
  FOREIGN KEY (source_recording_session_id) REFERENCES recording_sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_learning_evidence (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL,
  from_step_order INTEGER,
  to_step_order INTEGER,
  evidence_type TEXT NOT NULL,
  evidence_payload TEXT DEFAULT '{}',
  confidence REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (suggestion_id) REFERENCES workflow_learning_suggestions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS field_dictionary (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  scope_id TEXT,
  pattern TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('AUTH', 'IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'NOISE')),
  priority INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checklists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS security_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payloads TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('workflow', 'api')),
  intent TEXT DEFAULT 'workflow_seed' CHECK (intent IN ('account_capture', 'api_test_seed', 'workflow_seed', 'learning_seed')),
  status TEXT DEFAULT 'recording' CHECK (status IN ('recording', 'processing', 'completed', 'finished', 'published', 'failed')),
  source_tool TEXT,
  account_label TEXT,
  requested_field_names TEXT DEFAULT '[]',
  capture_filters TEXT DEFAULT '{}',
  environment_id TEXT,
  account_id TEXT,
  role TEXT,
  target_fields TEXT DEFAULT '[]',
  event_count INTEGER DEFAULT 0,
  field_hit_count INTEGER DEFAULT 0,
  runtime_context_count INTEGER DEFAULT 0,
  generated_result_count INTEGER DEFAULT 0,
  published_result_count INTEGER DEFAULT 0,
  summary TEXT DEFAULT '{}',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recording_field_targets (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT DEFAULT '[]',
  from_sources TEXT DEFAULT '[]',
  bind_to_account_field TEXT,
  category TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recording_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  source_tool TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  scheme TEXT,
  host TEXT,
  path TEXT NOT NULL,
  query_params TEXT DEFAULT '{}',
  request_headers TEXT DEFAULT '{}',
  request_body_text TEXT,
  request_cookies TEXT DEFAULT '{}',
  parsed_request_body TEXT,
  response_status INTEGER,
  response_headers TEXT DEFAULT '{}',
  response_body_text TEXT,
  response_cookies TEXT DEFAULT '{}',
  parsed_response_body TEXT,
  field_hit_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recording_field_hits (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  field_name TEXT NOT NULL,
  matched_alias TEXT,
  source_location TEXT NOT NULL,
  source_key TEXT,
  value_preview TEXT,
  value_text TEXT,
  value_hash TEXT,
  bind_to_account_field TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES recording_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recording_runtime_context (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_id TEXT,
  context_key TEXT NOT NULL,
  category TEXT NOT NULL,
  source_location TEXT,
  value_preview TEXT,
  value_text TEXT,
  bind_to_account_field TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES recording_events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recording_account_apply_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('session_only', 'write_back')),
  persisted INTEGER DEFAULT 0,
  applied_by TEXT,
  target_snapshot TEXT DEFAULT '{}',
  field_changes TEXT DEFAULT '[]',
  auth_profile_changes TEXT DEFAULT '[]',
  variable_changes TEXT DEFAULT '[]',
  summary TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recording_audit_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  action TEXT NOT NULL,
  actor TEXT,
  target_type TEXT,
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  message TEXT,
  details TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recording_dead_letters (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  failure_stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'replayed', 'discarded')),
  error_message TEXT NOT NULL,
  batch_size INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  payload TEXT DEFAULT '{}',
  last_retried_at TEXT,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'published')),
  summary TEXT DEFAULT '{}',
  draft_payload TEXT DEFAULT '{}',
  published_workflow_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (published_workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS workflow_draft_steps (
  id TEXT PRIMARY KEY,
  workflow_draft_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  summary TEXT DEFAULT '{}',
  request_template_payload TEXT DEFAULT '{}',
  response_signature TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_draft_id) REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES recording_events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recording_extractor_candidates (
  id TEXT PRIMARY KEY,
  workflow_draft_id TEXT NOT NULL,
  workflow_draft_step_id TEXT,
  session_id TEXT NOT NULL,
  source_event_id TEXT,
  step_sequence INTEGER,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  expression TEXT NOT NULL,
  transform TEXT,
  required INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.5,
  value_preview TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_draft_id) REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_draft_step_id) REFERENCES workflow_draft_steps(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES recording_events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS recording_variable_candidates (
  id TEXT PRIMARY KEY,
  workflow_draft_id TEXT NOT NULL,
  workflow_draft_step_id TEXT,
  session_id TEXT NOT NULL,
  source_event_id TEXT,
  name TEXT NOT NULL,
  data_source TEXT NOT NULL,
  source_location TEXT NOT NULL,
  json_path TEXT,
  checklist_id TEXT,
  security_rule_id TEXT,
  account_field_name TEXT,
  runtime_context_key TEXT,
  step_variable_mappings TEXT DEFAULT '[]',
  advanced_config TEXT DEFAULT '{}',
  role TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workflow_draft_id) REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  FOREIGN KEY (workflow_draft_step_id) REFERENCES workflow_draft_steps(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES recording_events(id) ON DELETE SET NULL,
  FOREIGN KEY (checklist_id) REFERENCES checklists(id) ON DELETE SET NULL,
  FOREIGN KEY (security_rule_id) REFERENCES security_rules(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS test_run_drafts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived')),
  sequence INTEGER,
  source_event_id TEXT,
  summary TEXT DEFAULT '{}',
  suggestion_summary TEXT DEFAULT '{}',
  review_decisions TEXT DEFAULT '{}',
  draft_payload TEXT DEFAULT '{}',
  intent TEXT DEFAULT 'api_test_seed',
  draft_status TEXT DEFAULT 'generated',
  published_template_id TEXT,
  published_preset_id TEXT,
  published_test_run_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES recording_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (source_event_id) REFERENCES recording_events(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS test_run_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source_draft_id TEXT,
  template_id TEXT NOT NULL,
  environment_id TEXT,
  default_account_id TEXT,
  preset_config TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (source_draft_id) REFERENCES test_run_drafts(id) ON DELETE SET NULL,
  FOREIGN KEY (template_id) REFERENCES api_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  FOREIGN KEY (default_account_id) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS draft_publish_logs (
  id TEXT PRIMARY KEY,
  draft_type TEXT NOT NULL CHECK (draft_type IN ('workflow', 'test_run')),
  source_draft_id TEXT NOT NULL,
  source_recording_session_id TEXT,
  target_asset_type TEXT NOT NULL,
  target_asset_id TEXT NOT NULL,
  published_by TEXT,
  published_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS test_runs (
  id TEXT PRIMARY KEY,
  name TEXT,
  status TEXT DEFAULT 'pending',
  execution_type TEXT,
  trigger_type TEXT,
  rule_ids TEXT,
  template_ids TEXT,
  account_ids TEXT,
  environment_id TEXT,
  workflow_id TEXT,
  execution_params TEXT,
  source_recording_session_id TEXT,
  progress_percent INTEGER DEFAULT 0,
  progress TEXT,
  error_message TEXT,
  errors_count INTEGER DEFAULT 0,
  has_execution_error INTEGER DEFAULT 0,
  validation_report TEXT,
  dropped_count INTEGER DEFAULT 0,
  findings_count_effective INTEGER DEFAULT 0,
  suppressed_count_rule INTEGER DEFAULT 0,
  suppressed_count_rate_limit INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  test_run_id TEXT,
  security_run_id TEXT,
  api_template_id TEXT,
  template_id TEXT,
  workflow_id TEXT,
  rule_id TEXT,
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'new',
  title TEXT NOT NULL,
  description TEXT,
  template_name TEXT,
  workflow_name TEXT,
  variable_values TEXT,
  request_raw TEXT,
  response_status INTEGER,
  response_headers TEXT,
  response_body TEXT,
  request_evidence TEXT,
  response_evidence TEXT,
  ai_analysis TEXT,
  evidence_comparison TEXT,
  notes TEXT,
  discovered_at TEXT,
  account_source_map TEXT,
  attacker_account_id TEXT,
  victim_account_ids TEXT,
  baseline_response TEXT,
  mutated_response TEXT,
  response_diff TEXT,
  is_suppressed INTEGER DEFAULT 0,
  suppression_rule_id TEXT,
  suppressed_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cicd_gate_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_enabled INTEGER DEFAULT 1,
  weight_test INTEGER DEFAULT 100,
  weight_workflow INTEGER DEFAULT 0,
  combine_operator TEXT DEFAULT 'OR',
  rules_test TEXT DEFAULT '[]',
  rules_workflow TEXT DEFAULT '[]',
  pass_threshold INTEGER,
  warn_threshold INTEGER,
  block_threshold INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS security_suites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  environment_id TEXT,
  environment_name TEXT,
  template_ids TEXT DEFAULT '[]',
  workflow_ids TEXT DEFAULT '[]',
  account_ids TEXT DEFAULT '[]',
  checklist_ids TEXT DEFAULT '[]',
  security_rule_ids TEXT DEFAULT '[]',
  policy_id TEXT,
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  FOREIGN KEY (policy_id) REFERENCES cicd_gate_policies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS security_runs (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  exit_code INTEGER,
  gate_result TEXT,
  policy_id TEXT,
  test_findings_count INTEGER DEFAULT 0,
  workflow_findings_count INTEGER DEFAULT 0,
  gate_score INTEGER,
  error_message TEXT,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finding_suppression_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_enabled INTEGER DEFAULT 1,
  applies_to TEXT DEFAULT 'both',
  match_method TEXT NOT NULL,
  match_type TEXT DEFAULT 'exact',
  match_path TEXT,
  match_service_id TEXT,
  match_template_id TEXT,
  match_workflow_id TEXT,
  match_environment_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS finding_drop_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  is_enabled INTEGER DEFAULT 1,
  priority INTEGER DEFAULT 100,
  applies_to TEXT DEFAULT 'both',
  match_method TEXT NOT NULL,
  match_type TEXT DEFAULT 'exact',
  match_path TEXT,
  match_service_id TEXT,
  match_template_id TEXT,
  match_workflow_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS governance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'deepseek', 'qwen', 'llama', 'openai_compat')),
  base_url TEXT,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  is_enabled INTEGER DEFAULT 1,
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ai_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  filters TEXT DEFAULT '{}',
  report_markdown TEXT NOT NULL,
  stats TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES ai_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_variable_configs_workflow_id ON workflow_variable_configs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_extractors_workflow_id ON workflow_extractors(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_variables_workflow_id ON workflow_variables(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_mappings_workflow_id ON workflow_mappings(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_mappings_from_step ON workflow_mappings(workflow_id, from_step_order);
CREATE INDEX IF NOT EXISTS idx_workflow_mappings_to_step ON workflow_mappings(workflow_id, to_step_order);
CREATE INDEX IF NOT EXISTS idx_workflow_learning_suggestions_workflow_id ON workflow_learning_suggestions(workflow_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_learning_suggestions_source_recording ON workflow_learning_suggestions(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_workflow_learning_evidence_suggestion_id ON workflow_learning_evidence(suggestion_id);
CREATE INDEX IF NOT EXISTS idx_field_dictionary_enabled ON field_dictionary(is_enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_workflows_type ON workflows(workflow_type);
CREATE INDEX IF NOT EXISTS idx_workflows_base_workflow_id ON workflows(base_workflow_id);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions(status, mode);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_environment ON recording_sessions(environment_id);
CREATE INDEX IF NOT EXISTS idx_recording_field_targets_session_id ON recording_field_targets(session_id);
CREATE INDEX IF NOT EXISTS idx_recording_events_session_id ON recording_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_recording_events_session_fingerprint_sequence ON recording_events(session_id, fingerprint, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_events_session_sequence ON recording_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_recording_field_hits_session_id ON recording_field_hits(session_id, field_name);
CREATE INDEX IF NOT EXISTS idx_recording_field_hits_event_id ON recording_field_hits(event_id);
CREATE INDEX IF NOT EXISTS idx_recording_runtime_context_session_id ON recording_runtime_context(session_id, category);
CREATE INDEX IF NOT EXISTS idx_recording_account_apply_logs_session_id ON recording_account_apply_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_account_apply_logs_account_id ON recording_account_apply_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_session_id ON recording_audit_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_action ON recording_audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_status ON recording_dead_letters(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_session_id ON recording_dead_letters(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_drafts_session_id ON workflow_drafts(session_id);
CREATE INDEX IF NOT EXISTS idx_workflow_draft_steps_draft_id ON workflow_draft_steps(workflow_draft_id, sequence);
CREATE INDEX IF NOT EXISTS idx_recording_extractor_candidates_draft_id ON recording_extractor_candidates(workflow_draft_id);
CREATE INDEX IF NOT EXISTS idx_recording_variable_candidates_draft_id ON recording_variable_candidates(workflow_draft_id);
CREATE INDEX IF NOT EXISTS idx_test_run_drafts_session_id ON test_run_drafts(session_id);
CREATE INDEX IF NOT EXISTS idx_test_run_presets_template_id ON test_run_presets(template_id);
CREATE INDEX IF NOT EXISTS idx_api_templates_source_recording_session ON api_templates(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_api_templates_failure_template_id ON api_templates(failure_template_id);
CREATE INDEX IF NOT EXISTS idx_api_templates_account_binding_template_id ON api_templates(account_binding_template_id);
CREATE INDEX IF NOT EXISTS idx_failure_pattern_templates_name ON failure_pattern_templates(name);
CREATE INDEX IF NOT EXISTS idx_account_binding_templates_name ON account_binding_templates(name);
CREATE INDEX IF NOT EXISTS idx_workflows_source_recording_session ON workflows(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_source_recording_session ON test_runs(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_target_asset ON draft_publish_logs(target_asset_type, target_asset_id);
CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_source_recording_session ON draft_publish_logs(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
CREATE INDEX IF NOT EXISTS idx_findings_test_run_id ON findings(test_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_workflow_id ON findings(workflow_id);

INSERT OR IGNORE INTO field_dictionary (id, scope, scope_id, pattern, category, priority, is_enabled, notes, created_at, updated_at) VALUES
  ('dict_001', 'global', NULL, '(?i)^(authorization|access_token|auth_token|bearer|x-auth-token)$', 'AUTH', 100, 1, 'Common auth headers', datetime('now'), datetime('now')),
  ('dict_002', 'global', NULL, '(?i)^(token|jwt|session_id|session)$', 'AUTH', 90, 1, 'Session tokens', datetime('now'), datetime('now')),
  ('dict_003', 'global', NULL, '(?i)^(user_id|userid|uid|account_id)$', 'OBJECT_ID', 80, 1, 'User identifiers', datetime('now'), datetime('now')),
  ('dict_004', 'global', NULL, '(?i)^(order_id|orderid|transaction_id|txn_id)$', 'OBJECT_ID', 70, 1, 'Business objects', datetime('now'), datetime('now')),
  ('dict_005', 'global', NULL, '(?i)^(challenge_id|nonce|csrf_token|state)$', 'FLOW_TICKET', 60, 1, 'Flow control', datetime('now'), datetime('now')),
  ('dict_006', 'global', NULL, '(?i)^(timestamp|time|date|created_at|updated_at)$', 'NOISE', 50, 1, 'Temporal noise', datetime('now'), datetime('now')),
  ('dict_007', 'global', NULL, '(?i)^(request_id|trace_id|span_id|correlation_id)$', 'NOISE', 50, 1, 'Tracing noise', datetime('now'), datetime('now')),
  ('dict_008', 'global', NULL, '(?i)^(message|msg|success|status|code|error)$', 'NOISE', 40, 1, 'Status fields', datetime('now'), datetime('now'));
`;

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS db_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('sqlite', 'postgres')),
  config JSONB NOT NULL,
  is_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  base_url TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  status TEXT DEFAULT 'active',
  tags JSONB,
  auth_profile JSONB,
  variables JSONB,
  fields JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  group_name TEXT,
  description TEXT,
  raw_request TEXT NOT NULL,
  parsed_structure JSONB,
  variables JSONB DEFAULT '[]',
  failure_patterns JSONB DEFAULT '[]',
  failure_logic TEXT DEFAULT 'OR',
  is_active BOOLEAN DEFAULT true,
  account_binding_strategy TEXT,
  attacker_account_id UUID,
  enable_baseline BOOLEAN DEFAULT false,
  baseline_config JSONB,
  advanced_config JSONB,
  rate_limit_override INTEGER,
  source_recording_session_id UUID,
  failure_template_id UUID,
  account_binding_template_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);


CREATE TABLE IF NOT EXISTS failure_pattern_templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  failure_patterns JSONB DEFAULT '[]',
  failure_logic TEXT DEFAULT 'OR',
  tags JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_binding_templates (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  binding_strategy TEXT DEFAULT 'independent',
  attacker_account_id UUID,
  enable_baseline BOOLEAN DEFAULT FALSE,
  baseline_config JSONB,
  rate_limit_override INTEGER,
  tags JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  assertion_strategy TEXT DEFAULT 'any_step_pass',
  critical_step_orders JSONB,
  account_binding_strategy TEXT,
  attacker_account_id UUID,
  enable_baseline BOOLEAN DEFAULT false,
  baseline_config JSONB,
  enable_extractor BOOLEAN DEFAULT false,
  enable_session_jar BOOLEAN DEFAULT false,
  session_jar_config JSONB,
  learning_status TEXT DEFAULT 'unlearned' CHECK (learning_status IN ('unlearned', 'learned')),
  learning_version INTEGER DEFAULT 0,
  learning_source_preference TEXT DEFAULT 'execution_only',
  last_learning_session_id UUID,
  last_learning_mode TEXT,
  source_recording_session_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  api_template_id UUID NOT NULL REFERENCES api_templates(id),
  step_order INTEGER NOT NULL,
  step_assertions JSONB,
  assertions_mode TEXT DEFAULT 'all',
  failure_patterns_override JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_variable_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  step_variable_mappings JSONB NOT NULL,
  data_source TEXT NOT NULL,
  checklist_id UUID,
  security_rule_id UUID,
  account_field_name TEXT,
  binding_strategy TEXT,
  attacker_account_id UUID,
  role TEXT,
  is_attacker_field BOOLEAN DEFAULT false,
  advanced_config JSONB,
  account_scope_mode TEXT DEFAULT 'all',
  account_scope_ids JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_extractors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  expression TEXT NOT NULL,
  transform JSONB,
  required BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_learning_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('recording_only', 'execution_only', 'hybrid')),
  source_recording_session_id UUID REFERENCES recording_sessions(id) ON DELETE SET NULL,
  source_execution_run_id UUID,
  suggestion_payload JSONB DEFAULT '{}'::jsonb,
  status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'applied', 'archived')),
  learning_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_learning_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id UUID NOT NULL REFERENCES workflow_learning_suggestions(id) ON DELETE CASCADE,
  from_step_order INTEGER,
  to_step_order INTEGER,
  evidence_type TEXT NOT NULL,
  evidence_payload JSONB DEFAULT '{}'::jsonb,
  confidence DOUBLE PRECISION DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS field_dictionary (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
  scope_id TEXT,
  pattern TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('AUTH', 'IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'NOISE')),
  priority INTEGER DEFAULT 0,
  is_enabled BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS checklists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  config JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  payloads JSONB NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('workflow', 'api')),
  status TEXT DEFAULT 'recording' CHECK (status IN ('recording', 'processing', 'completed', 'finished', 'published', 'failed')),
  source_tool TEXT,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  role TEXT,
  target_fields JSONB DEFAULT '[]'::jsonb,
  event_count INTEGER DEFAULT 0,
  field_hit_count INTEGER DEFAULT 0,
  runtime_context_count INTEGER DEFAULT 0,
  generated_result_count INTEGER DEFAULT 0,
  published_result_count INTEGER DEFAULT 0,
  summary JSONB DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_field_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  aliases JSONB DEFAULT '[]'::jsonb,
  from_sources JSONB DEFAULT '[]'::jsonb,
  bind_to_account_field TEXT,
  category TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  source_tool TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  scheme TEXT,
  host TEXT,
  path TEXT NOT NULL,
  query_params JSONB DEFAULT '{}'::jsonb,
  request_headers JSONB DEFAULT '{}'::jsonb,
  request_body_text TEXT,
  request_cookies JSONB DEFAULT '{}'::jsonb,
  parsed_request_body JSONB,
  response_status INTEGER,
  response_headers JSONB DEFAULT '{}'::jsonb,
  response_body_text TEXT,
  response_cookies JSONB DEFAULT '{}'::jsonb,
  parsed_response_body JSONB,
  field_hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_field_hits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES recording_events(id) ON DELETE CASCADE,
  field_name TEXT NOT NULL,
  matched_alias TEXT,
  source_location TEXT NOT NULL,
  source_key TEXT,
  value_preview TEXT,
  value_text TEXT,
  value_hash TEXT,
  bind_to_account_field TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_runtime_context (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  event_id UUID REFERENCES recording_events(id) ON DELETE SET NULL,
  context_key TEXT NOT NULL,
  category TEXT NOT NULL,
  source_location TEXT,
  value_preview TEXT,
  value_text TEXT,
  bind_to_account_field TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_account_apply_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('session_only', 'write_back')),
  persisted BOOLEAN DEFAULT false,
  applied_by TEXT,
  target_snapshot JSONB DEFAULT '{}'::jsonb,
  field_changes JSONB DEFAULT '[]'::jsonb,
  auth_profile_changes JSONB DEFAULT '[]'::jsonb,
  variable_changes JSONB DEFAULT '[]'::jsonb,
  summary JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES recording_sessions(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor TEXT,
  target_type TEXT,
  target_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  message TEXT,
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES recording_sessions(id) ON DELETE SET NULL,
  failure_stage TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'replayed', 'discarded')),
  error_message TEXT NOT NULL,
  batch_size INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  payload JSONB DEFAULT '{}'::jsonb,
  last_retried_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'published')),
  summary JSONB DEFAULT '{}'::jsonb,
  draft_payload JSONB DEFAULT '{}'::jsonb,
  published_workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_draft_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_draft_id UUID NOT NULL REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  source_event_id UUID NOT NULL REFERENCES recording_events(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  enabled BOOLEAN DEFAULT true,
  summary JSONB DEFAULT '{}'::jsonb,
  request_template_payload JSONB DEFAULT '{}'::jsonb,
  response_signature JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_extractor_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_draft_id UUID NOT NULL REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  workflow_draft_step_id UUID REFERENCES workflow_draft_steps(id) ON DELETE SET NULL,
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  source_event_id UUID REFERENCES recording_events(id) ON DELETE SET NULL,
  step_sequence INTEGER,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  expression TEXT NOT NULL,
  transform JSONB,
  required BOOLEAN DEFAULT false,
  confidence REAL DEFAULT 0.5,
  value_preview TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recording_variable_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_draft_id UUID NOT NULL REFERENCES workflow_drafts(id) ON DELETE CASCADE,
  workflow_draft_step_id UUID REFERENCES workflow_draft_steps(id) ON DELETE SET NULL,
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  source_event_id UUID REFERENCES recording_events(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  data_source TEXT NOT NULL,
  source_location TEXT NOT NULL,
  json_path TEXT,
  checklist_id UUID REFERENCES checklists(id) ON DELETE SET NULL,
  security_rule_id UUID REFERENCES security_rules(id) ON DELETE SET NULL,
  account_field_name TEXT,
  runtime_context_key TEXT,
  step_variable_mappings JSONB DEFAULT '[]'::jsonb,
  advanced_config JSONB DEFAULT '{}'::jsonb,
  role TEXT,
  confidence REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_run_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'generated' CHECK (status IN ('generated', 'reviewing', 'approved', 'preconfigured', 'published', 'run_created', 'archived')),
  sequence INTEGER,
  source_event_id UUID REFERENCES recording_events(id) ON DELETE SET NULL,
  summary JSONB DEFAULT '{}'::jsonb,
  suggestion_summary JSONB DEFAULT '{}'::jsonb,
  review_decisions JSONB DEFAULT '{}'::jsonb,
  draft_payload JSONB DEFAULT '{}'::jsonb,
  intent TEXT DEFAULT 'api_test_seed',
  draft_status TEXT DEFAULT 'generated',
  published_template_id UUID,
  published_preset_id UUID,
  published_test_run_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_run_presets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  source_draft_id UUID REFERENCES test_run_drafts(id) ON DELETE SET NULL,
  template_id UUID NOT NULL REFERENCES api_templates(id) ON DELETE CASCADE,
  environment_id UUID REFERENCES environments(id) ON DELETE SET NULL,
  default_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  preset_config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS draft_publish_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_type TEXT NOT NULL CHECK (draft_type IN ('workflow', 'test_run')),
  source_draft_id UUID NOT NULL,
  source_recording_session_id UUID,
  target_asset_type TEXT NOT NULL,
  target_asset_id UUID NOT NULL,
  published_by TEXT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS test_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  status TEXT DEFAULT 'pending',
  execution_type TEXT,
  trigger_type TEXT,
  rule_ids JSONB,
  template_ids JSONB,
  account_ids JSONB,
  environment_id UUID,
  workflow_id UUID,
  execution_params JSONB,
  source_recording_session_id UUID,
  progress_percent INTEGER DEFAULT 0,
  progress JSONB,
  error_message TEXT,
  errors_count INTEGER DEFAULT 0,
  has_execution_error BOOLEAN DEFAULT false,
  validation_report JSONB,
  dropped_count INTEGER DEFAULT 0,
  findings_count_effective INTEGER DEFAULT 0,
  suppressed_count_rule INTEGER DEFAULT 0,
  suppressed_count_rate_limit INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  test_run_id UUID,
  security_run_id UUID,
  api_template_id UUID,
  template_id UUID,
  workflow_id UUID,
  rule_id UUID,
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'new',
  title TEXT NOT NULL,
  description TEXT,
  template_name TEXT,
  workflow_name TEXT,
  variable_values JSONB,
  request_raw TEXT,
  response_status INTEGER,
  response_headers JSONB,
  response_body TEXT,
  request_evidence JSONB,
  response_evidence JSONB,
  ai_analysis JSONB,
  evidence_comparison JSONB,
  notes TEXT,
  discovered_at TIMESTAMPTZ,
  account_source_map JSONB,
  attacker_account_id UUID,
  victim_account_ids JSONB,
  baseline_response JSONB,
  mutated_response JSONB,
  response_diff JSONB,
  is_suppressed BOOLEAN DEFAULT false,
  suppression_rule_id UUID,
  suppressed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cicd_gate_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  weight_test INTEGER DEFAULT 100,
  weight_workflow INTEGER DEFAULT 0,
  combine_operator TEXT DEFAULT 'OR',
  rules_test JSONB DEFAULT '[]',
  rules_workflow JSONB DEFAULT '[]',
  pass_threshold INTEGER,
  warn_threshold INTEGER,
  block_threshold INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS security_suites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  environment_id UUID,
  environment_name TEXT,
  template_ids JSONB DEFAULT '[]',
  workflow_ids JSONB DEFAULT '[]',
  account_ids JSONB DEFAULT '[]',
  checklist_ids JSONB DEFAULT '[]',
  security_rule_ids JSONB DEFAULT '[]',
  policy_id UUID,
  is_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  FOREIGN KEY (environment_id) REFERENCES environments(id) ON DELETE SET NULL,
  FOREIGN KEY (policy_id) REFERENCES cicd_gate_policies(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS security_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT DEFAULT 'pending',
  exit_code INTEGER,
  gate_result TEXT,
  policy_id UUID,
  test_findings_count INTEGER DEFAULT 0,
  workflow_findings_count INTEGER DEFAULT 0,
  gate_score INTEGER,
  error_message TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finding_suppression_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  applies_to TEXT DEFAULT 'both',
  match_method TEXT NOT NULL,
  match_type TEXT DEFAULT 'exact',
  match_path TEXT,
  match_service_id TEXT,
  match_template_id UUID,
  match_workflow_id UUID,
  match_environment_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finding_drop_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  is_enabled BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 100,
  applies_to TEXT DEFAULT 'both',
  match_method TEXT NOT NULL,
  match_type TEXT DEFAULT 'exact',
  match_path TEXT,
  match_service_id TEXT,
  match_template_id UUID,
  match_workflow_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS governance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'deepseek', 'qwen', 'llama', 'openai_compat')),
  base_url TEXT,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  is_enabled BOOLEAN DEFAULT true,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_analyses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  finding_id UUID NOT NULL,
  provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  result_json JSONB NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL,
  provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  filters JSONB DEFAULT '{}'::jsonb,
  report_markdown TEXT NOT NULL,
  stats JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_variable_configs_workflow_id ON workflow_variable_configs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_extractors_workflow_id ON workflow_extractors(workflow_id);
CREATE INDEX IF NOT EXISTS idx_field_dictionary_enabled ON field_dictionary(is_enabled, priority DESC);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_status ON recording_sessions(status, mode);
CREATE INDEX IF NOT EXISTS idx_recording_sessions_environment ON recording_sessions(environment_id);
CREATE INDEX IF NOT EXISTS idx_recording_field_targets_session_id ON recording_field_targets(session_id);
CREATE INDEX IF NOT EXISTS idx_recording_events_session_id ON recording_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_recording_events_session_fingerprint_sequence ON recording_events(session_id, fingerprint, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_events_session_sequence ON recording_events(session_id, sequence);
CREATE INDEX IF NOT EXISTS idx_recording_field_hits_session_id ON recording_field_hits(session_id, field_name);
CREATE INDEX IF NOT EXISTS idx_recording_field_hits_event_id ON recording_field_hits(event_id);
CREATE INDEX IF NOT EXISTS idx_recording_runtime_context_session_id ON recording_runtime_context(session_id, category);
CREATE INDEX IF NOT EXISTS idx_recording_account_apply_logs_session_id ON recording_account_apply_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_account_apply_logs_account_id ON recording_account_apply_logs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_session_id ON recording_audit_logs(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_audit_logs_action ON recording_audit_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_status ON recording_dead_letters(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recording_dead_letters_session_id ON recording_dead_letters(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_drafts_session_id ON workflow_drafts(session_id);
CREATE INDEX IF NOT EXISTS idx_workflow_draft_steps_draft_id ON workflow_draft_steps(workflow_draft_id, sequence);
CREATE INDEX IF NOT EXISTS idx_recording_extractor_candidates_draft_id ON recording_extractor_candidates(workflow_draft_id);
CREATE INDEX IF NOT EXISTS idx_recording_variable_candidates_draft_id ON recording_variable_candidates(workflow_draft_id);
CREATE INDEX IF NOT EXISTS idx_test_run_drafts_session_id ON test_run_drafts(session_id);
CREATE INDEX IF NOT EXISTS idx_test_run_presets_template_id ON test_run_presets(template_id);
CREATE INDEX IF NOT EXISTS idx_api_templates_source_recording_session ON api_templates(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_api_templates_failure_template_id ON api_templates(failure_template_id);
CREATE INDEX IF NOT EXISTS idx_api_templates_account_binding_template_id ON api_templates(account_binding_template_id);
CREATE INDEX IF NOT EXISTS idx_failure_pattern_templates_name ON failure_pattern_templates(name);
CREATE INDEX IF NOT EXISTS idx_account_binding_templates_name ON account_binding_templates(name);
CREATE INDEX IF NOT EXISTS idx_workflows_source_recording_session ON workflows(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_source_recording_session ON test_runs(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_target_asset ON draft_publish_logs(target_asset_type, target_asset_id);
CREATE INDEX IF NOT EXISTS idx_draft_publish_logs_source_recording_session ON draft_publish_logs(source_recording_session_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
CREATE INDEX IF NOT EXISTS idx_findings_test_run_id ON findings(test_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_workflow_id ON findings(workflow_id);
`;
