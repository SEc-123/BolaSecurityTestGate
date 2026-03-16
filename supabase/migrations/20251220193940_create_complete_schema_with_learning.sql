/*
  # Complete Schema with Learning Mode Support
  
  This migration creates the complete database schema including:
  - Base tables for security testing platform
  - Learning mode tables and columns
  - All required indexes and constraints
  
  1. Core Tables:
    - environments, accounts, api_templates
    - workflows, workflow_steps, workflow_variable_configs
    - workflow_extractors, checklists, security_rules
    - test_runs, findings, cicd_gate_policies
    - security_runs, finding_suppression_rules, finding_drop_rules
    - governance_settings
  
  2. Learning Mode Tables:
    - workflow_variables, workflow_mappings, field_dictionary
  
  3. Security:
    - RLS enabled on all tables
*/

-- Create environments table
CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  description text,
  headers jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create accounts table
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  role text DEFAULT 'user',
  fields jsonb DEFAULT '{}',
  auth_profile jsonb DEFAULT '{}',
  tags text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create api_templates table
CREATE TABLE IF NOT EXISTS api_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  raw_request text NOT NULL,
  variables jsonb DEFAULT '[]',
  failure_patterns jsonb DEFAULT '[]',
  failure_logic text DEFAULT 'OR',
  tags text[] DEFAULT '{}',
  baseline_config jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create workflows table with learning mode columns
CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  assertion_strategy text DEFAULT 'any_step_pass',
  critical_step_orders integer[] DEFAULT '{}',
  enable_extractor boolean DEFAULT false,
  enable_session_jar boolean DEFAULT false,
  session_jar_config jsonb DEFAULT '{"cookie_mode": true}',
  account_binding_strategy text,
  attacker_account_id uuid,
  enable_baseline boolean DEFAULT false,
  baseline_config jsonb DEFAULT '{}',
  workflow_type text DEFAULT 'baseline',
  base_workflow_id uuid,
  learning_status text DEFAULT 'unlearned',
  learning_version integer DEFAULT 0,
  template_mode text DEFAULT 'snapshot',
  mutation_profile jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Add self-reference foreign key for base_workflow_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'workflows_base_workflow_id_fkey'
  ) THEN
    ALTER TABLE workflows ADD CONSTRAINT workflows_base_workflow_id_fkey 
      FOREIGN KEY (base_workflow_id) REFERENCES workflows(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Create workflow_steps table with snapshot columns
CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  api_template_id uuid NOT NULL REFERENCES api_templates(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  step_assertions jsonb DEFAULT '[]',
  assertions_mode text DEFAULT 'all',
  failure_patterns_override jsonb,
  request_snapshot_raw text,
  failure_patterns_snapshot jsonb,
  snapshot_template_name text,
  snapshot_template_id uuid,
  snapshot_created_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Create workflow_variable_configs table
CREATE TABLE IF NOT EXISTS workflow_variable_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  data_source text NOT NULL,
  account_field_name text,
  checklist_id uuid,
  security_rule_id uuid,
  role text,
  is_attacker_field boolean DEFAULT false,
  scope text DEFAULT 'all_accounts',
  step_variable_mappings jsonb DEFAULT '[]',
  advanced_config jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Create workflow_extractors table
CREATE TABLE IF NOT EXISTS workflow_extractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  step_order integer NOT NULL,
  source text NOT NULL,
  expression text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- Create checklists table
CREATE TABLE IF NOT EXISTS checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  config jsonb DEFAULT '{"values": []}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create security_rules table
CREATE TABLE IF NOT EXISTS security_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  category text,
  payloads text[] DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create test_runs table
CREATE TABLE IF NOT EXISTS test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  status text DEFAULT 'pending',
  run_type text DEFAULT 'manual',
  template_id uuid,
  workflow_id uuid,
  environment_id uuid,
  account_ids uuid[] DEFAULT '{}',
  configuration jsonb DEFAULT '{}',
  progress jsonb DEFAULT '{}',
  progress_percent integer DEFAULT 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  errors_count integer DEFAULT 0,
  has_execution_error boolean DEFAULT false,
  validation_report jsonb,
  dropped_count integer DEFAULT 0,
  findings_count_effective integer DEFAULT 0,
  suppressed_count_rule integer DEFAULT 0,
  suppressed_count_rate_limit integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create findings table
CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text DEFAULT 'test_run',
  test_run_id uuid,
  security_run_id uuid,
  template_id uuid,
  workflow_id uuid,
  severity text DEFAULT 'medium',
  status text DEFAULT 'new',
  title text NOT NULL,
  description text,
  template_name text,
  variable_values jsonb,
  request_raw text,
  response_status integer,
  response_body text,
  account_source_map jsonb,
  attacker_account_id uuid,
  victim_account_ids uuid[] DEFAULT '{}',
  baseline_response jsonb,
  mutated_response jsonb,
  response_diff jsonb,
  is_suppressed boolean DEFAULT false,
  suppression_rule_id uuid,
  suppressed_reason text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create cicd_gate_policies table
CREATE TABLE IF NOT EXISTS cicd_gate_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_enabled boolean DEFAULT true,
  rules jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create security_runs table
CREATE TABLE IF NOT EXISTS security_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  status text DEFAULT 'pending',
  gate_policy_id uuid REFERENCES cicd_gate_policies(id),
  environment_id uuid,
  configuration jsonb DEFAULT '{}',
  results jsonb,
  gate_result text,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create finding_suppression_rules table
CREATE TABLE IF NOT EXISTS finding_suppression_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_enabled boolean DEFAULT true,
  match_type text DEFAULT 'all',
  conditions jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create finding_drop_rules table
CREATE TABLE IF NOT EXISTS finding_drop_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_enabled boolean DEFAULT true,
  match_type text DEFAULT 'all',
  conditions jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create governance_settings table
CREATE TABLE IF NOT EXISTS governance_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create workflow_variables table
CREATE TABLE IF NOT EXISTS workflow_variables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'GENERIC',
  source text NOT NULL DEFAULT 'extracted',
  write_policy text NOT NULL DEFAULT 'overwrite',
  is_locked boolean DEFAULT false,
  description text,
  current_value text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT workflow_variables_type_check CHECK (type IN ('IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'GENERIC')),
  CONSTRAINT workflow_variables_source_check CHECK (source IN ('account_injected', 'extracted', 'manual')),
  CONSTRAINT workflow_variables_policy_check CHECK (write_policy IN ('first', 'overwrite', 'on_success_only')),
  CONSTRAINT workflow_variables_unique_name UNIQUE (workflow_id, name)
);

-- Create workflow_mappings table
CREATE TABLE IF NOT EXISTS workflow_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  from_step_order integer NOT NULL,
  from_location text NOT NULL,
  from_path text NOT NULL,
  to_step_order integer NOT NULL,
  to_location text NOT NULL,
  to_path text NOT NULL,
  variable_name text NOT NULL,
  confidence numeric(3,2) DEFAULT 1.0,
  reason text DEFAULT 'manual',
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Create field_dictionary table
CREATE TABLE IF NOT EXISTS field_dictionary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL DEFAULT 'global',
  scope_id uuid,
  pattern text NOT NULL,
  category text NOT NULL,
  priority integer DEFAULT 50,
  is_enabled boolean DEFAULT true,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT field_dictionary_scope_check CHECK (scope IN ('global', 'project')),
  CONSTRAINT field_dictionary_category_check CHECK (category IN ('IDENTITY', 'FLOW_TICKET', 'OBJECT_ID', 'NOISE'))
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_template_id ON workflow_steps(api_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_variable_configs_workflow_id ON workflow_variable_configs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_extractors_workflow_id ON workflow_extractors(workflow_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
CREATE INDEX IF NOT EXISTS idx_test_runs_workflow_id ON test_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_findings_test_run_id ON findings(test_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_workflow_id ON findings(workflow_id);
CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
CREATE INDEX IF NOT EXISTS idx_workflow_variables_workflow_id ON workflow_variables(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_mappings_workflow_id ON workflow_mappings(workflow_id);
CREATE INDEX IF NOT EXISTS idx_field_dictionary_scope ON field_dictionary(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_workflows_type ON workflows(workflow_type);
CREATE INDEX IF NOT EXISTS idx_workflows_base_workflow ON workflows(base_workflow_id);

-- Enable RLS on all tables
ALTER TABLE environments ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_variable_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_extractors ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cicd_gate_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_suppression_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE finding_drop_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_variables ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_dictionary ENABLE ROW LEVEL SECURITY;

-- Create permissive RLS policies for authenticated users (for internal tool use)
-- These allow authenticated users to access all data - adjust as needed for production
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'environments', 'accounts', 'api_templates', 'workflows', 'workflow_steps',
    'workflow_variable_configs', 'workflow_extractors', 'checklists', 'security_rules',
    'test_runs', 'findings', 'cicd_gate_policies', 'security_runs',
    'finding_suppression_rules', 'finding_drop_rules', 'governance_settings',
    'workflow_variables', 'workflow_mappings', 'field_dictionary'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "Auth users can select %s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "Auth users can select %s" ON %I FOR SELECT TO authenticated USING (true)', t, t);
    
    EXECUTE format('DROP POLICY IF EXISTS "Auth users can insert %s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "Auth users can insert %s" ON %I FOR INSERT TO authenticated WITH CHECK (true)', t, t);
    
    EXECUTE format('DROP POLICY IF EXISTS "Auth users can update %s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "Auth users can update %s" ON %I FOR UPDATE TO authenticated USING (true) WITH CHECK (true)', t, t);
    
    EXECUTE format('DROP POLICY IF EXISTS "Auth users can delete %s" ON %I', t, t);
    EXECUTE format('CREATE POLICY "Auth users can delete %s" ON %I FOR DELETE TO authenticated USING (true)', t, t);
  END LOOP;
END $$;

-- Seed default dictionary rules
INSERT INTO field_dictionary (scope, pattern, category, priority, notes)
SELECT 'global', pattern, category::text, priority, notes FROM (VALUES
  ('(?i)(authorization|bearer|access_?token|jwt)', 'IDENTITY', 90, 'Authorization headers and JWT tokens'),
  ('(?i)(session_?id|sid|sess)', 'IDENTITY', 85, 'Session identifiers'),
  ('(?i)(api_?key|apikey|x-api-key)', 'IDENTITY', 80, 'API keys'),
  ('(?i)(csrf|xsrf|_token$|nonce)', 'FLOW_TICKET', 70, 'CSRF and anti-forgery tokens'),
  ('(?i)(challenge|verification|otp|code$)', 'FLOW_TICKET', 65, 'Challenge and verification codes'),
  ('(?i)(user_?id|account_?id|customer_?id)', 'OBJECT_ID', 60, 'User and account identifiers'),
  ('(?i)(order_?id|transaction_?id|payment_?id)', 'OBJECT_ID', 55, 'Transaction identifiers'),
  ('(?i)(timestamp|created_?at|updated_?at|modified)', 'NOISE', 30, 'Timestamps'),
  ('(?i)(request_?id|trace_?id|correlation_?id|span_?id)', 'NOISE', 25, 'Request tracing IDs'),
  ('(?i)^(message|msg|error|success|status|code|description)$', 'NOISE', 20, 'Common response metadata fields')
) AS seed(pattern, category, priority, notes)
WHERE NOT EXISTS (SELECT 1 FROM field_dictionary LIMIT 1);
