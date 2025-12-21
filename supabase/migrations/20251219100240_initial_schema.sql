/*
  # Initial Schema for API Security Testing Platform

  ## 1. Core Tables
    - `environments` - Target environments (dev, staging, prod)
    - `accounts` - Test accounts for different environments
    - `api_templates` - API request templates for testing
    - `checklists` - Value lists for fuzzing/testing
    - `test_runs` - Test execution records
    - `findings` - Security findings from tests
    - `security_rules` - Custom security validation rules

  ## 2. Workflow Tables
    - `workflows` - Multi-step test workflows
    - `workflow_steps` - Individual steps in workflows
    - `workflow_executions` - Workflow execution records

  ## 3. Suppression Tables
    - `finding_suppression_rules` - Rules for suppressing noisy findings

  ## 4. CI/CD Gate Tables
    - `security_runs` - CI/CD security run tracking
    - `cicd_gate_policies` - Gate policy configuration

  ## 5. Security
    - RLS enabled on all tables
    - Policies for authenticated and anon users
*/

-- Helper function for updated_at triggers
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- ENVIRONMENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE environments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read environments" ON environments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create environments" ON environments FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update environments" ON environments FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete environments" ON environments FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read environments" ON environments FOR SELECT TO anon USING (true);

-- ============================================
-- ACCOUNTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  environment_id uuid REFERENCES environments(id) ON DELETE CASCADE,
  credentials jsonb DEFAULT '{}'::jsonb,
  fields jsonb DEFAULT '{}'::jsonb,
  description text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read accounts" ON accounts FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create accounts" ON accounts FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update accounts" ON accounts FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete accounts" ON accounts FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read accounts" ON accounts FOR SELECT TO anon USING (true);

-- ============================================
-- API TEMPLATES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS api_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  method text NOT NULL DEFAULT 'GET',
  path text NOT NULL,
  headers jsonb DEFAULT '{}'::jsonb,
  body text,
  raw_request text,
  parsed_structure jsonb DEFAULT '{}'::jsonb,
  variables jsonb DEFAULT '[]'::jsonb,
  failure_patterns jsonb DEFAULT '[]'::jsonb,
  failure_logic text DEFAULT 'OR',
  baseline_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE api_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read templates" ON api_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create templates" ON api_templates FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update templates" ON api_templates FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete templates" ON api_templates FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read templates" ON api_templates FOR SELECT TO anon USING (true);

-- ============================================
-- CHECKLISTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE checklists ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read checklists" ON checklists FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create checklists" ON checklists FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update checklists" ON checklists FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete checklists" ON checklists FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read checklists" ON checklists FOR SELECT TO anon USING (true);

-- ============================================
-- SECURITY RULES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS security_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  rule_type text NOT NULL CHECK (rule_type IN ('status_code', 'header', 'body_contains', 'body_regex', 'response_time', 'custom')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  severity text DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE security_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read rules" ON security_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create rules" ON security_rules FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update rules" ON security_rules FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete rules" ON security_rules FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read rules" ON security_rules FOR SELECT TO anon USING (true);

-- ============================================
-- WORKFLOWS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  is_enabled boolean DEFAULT true,
  config jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read workflows" ON workflows FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create workflows" ON workflows FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update workflows" ON workflows FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete workflows" ON workflows FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read workflows" ON workflows FOR SELECT TO anon USING (true);

-- ============================================
-- WORKFLOW STEPS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  step_order integer NOT NULL DEFAULT 0,
  step_type text NOT NULL DEFAULT 'request' CHECK (step_type IN ('request', 'extract', 'assert', 'delay', 'condition')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read steps" ON workflow_steps FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create steps" ON workflow_steps FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update steps" ON workflow_steps FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete steps" ON workflow_steps FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read steps" ON workflow_steps FOR SELECT TO anon USING (true);

-- ============================================
-- WORKFLOW EXECUTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS workflow_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at timestamptz,
  completed_at timestamptz,
  results jsonb DEFAULT '[]'::jsonb,
  error_message text,
  context_data jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE workflow_executions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read executions" ON workflow_executions FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create executions" ON workflow_executions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update executions" ON workflow_executions FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete executions" ON workflow_executions FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read executions" ON workflow_executions FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can create executions" ON workflow_executions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update executions" ON workflow_executions FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================
-- TEST RUNS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  api_template_id uuid REFERENCES api_templates(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  trigger_type text DEFAULT 'manual',
  progress jsonb DEFAULT '{}'::jsonb,
  results jsonb DEFAULT '[]'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE test_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read runs" ON test_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create runs" ON test_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update runs" ON test_runs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete runs" ON test_runs FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read runs" ON test_runs FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can create runs" ON test_runs FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update runs" ON test_runs FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================
-- CICD GATE POLICIES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS cicd_gate_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_enabled boolean DEFAULT true,
  weight_test integer NOT NULL DEFAULT 100 CHECK (weight_test >= 0 AND weight_test <= 100),
  weight_workflow integer NOT NULL DEFAULT 100 CHECK (weight_workflow >= 0 AND weight_workflow <= 100),
  combine_operator text NOT NULL DEFAULT 'OR' CHECK (combine_operator IN ('OR', 'AND')),
  pass_threshold integer,
  warn_threshold integer,
  block_threshold integer,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE cicd_gate_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read policies" ON cicd_gate_policies FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create policies" ON cicd_gate_policies FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update policies" ON cicd_gate_policies FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete policies" ON cicd_gate_policies FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read policies" ON cicd_gate_policies FOR SELECT TO anon USING (true);

-- ============================================
-- SECURITY RUNS TABLE (CI/CD)
-- ============================================
CREATE TABLE IF NOT EXISTS security_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  exit_code integer CHECK (exit_code IS NULL OR exit_code IN (0, 2, 3, 4)),
  gate_result text CHECK (gate_result IS NULL OR gate_result IN ('PASS', 'WARN', 'BLOCK')),
  policy_id uuid REFERENCES cicd_gate_policies(id) ON DELETE SET NULL,
  test_findings_count integer NOT NULL DEFAULT 0,
  workflow_findings_count integer NOT NULL DEFAULT 0,
  gate_score numeric(10, 4),
  error_message text,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE security_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read security_runs" ON security_runs FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create security_runs" ON security_runs FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update security_runs" ON security_runs FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete security_runs" ON security_runs FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read security_runs" ON security_runs FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can create security_runs" ON security_runs FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update security_runs" ON security_runs FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================
-- FINDING SUPPRESSION RULES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS finding_suppression_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_enabled boolean DEFAULT true,
  applies_to text DEFAULT 'both' CHECK (applies_to IN ('test_run', 'workflow', 'both')),
  match_method text DEFAULT 'ANY',
  match_type text DEFAULT 'prefix' CHECK (match_type IN ('exact', 'prefix', 'regex', 'contains')),
  match_path text,
  match_service_id text,
  match_template_id uuid REFERENCES api_templates(id) ON DELETE CASCADE,
  match_workflow_id uuid REFERENCES workflows(id) ON DELETE CASCADE,
  match_environment_id uuid REFERENCES environments(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE finding_suppression_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read suppression rules" ON finding_suppression_rules FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create suppression rules" ON finding_suppression_rules FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update suppression rules" ON finding_suppression_rules FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete suppression rules" ON finding_suppression_rules FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read suppression rules" ON finding_suppression_rules FOR SELECT TO anon USING (true);

-- ============================================
-- FINDINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id uuid REFERENCES test_runs(id) ON DELETE CASCADE,
  security_run_id uuid REFERENCES security_runs(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN ('test_run', 'workflow')),
  template_id uuid REFERENCES api_templates(id) ON DELETE SET NULL,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  api_template_id uuid REFERENCES api_templates(id) ON DELETE SET NULL,
  template_name text,
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title text NOT NULL,
  description text,
  evidence text,
  request_url text,
  request_method text,
  request_headers jsonb DEFAULT '{}'::jsonb,
  request_body text,
  request_raw text,
  response_status integer,
  response_headers jsonb DEFAULT '{}'::jsonb,
  response_body text,
  variable_values jsonb DEFAULT '{}'::jsonb,
  matched_rules jsonb DEFAULT '[]'::jsonb,
  is_suppressed boolean DEFAULT false,
  suppression_rule_id uuid REFERENCES finding_suppression_rules(id) ON DELETE SET NULL,
  notes text,
  discovered_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE findings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read findings" ON findings FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can create findings" ON findings FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update findings" ON findings FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete findings" ON findings FOR DELETE TO authenticated USING (true);
CREATE POLICY "Anon can read findings" ON findings FOR SELECT TO anon USING (true);
CREATE POLICY "Anon can create findings" ON findings FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Anon can update findings" ON findings FOR UPDATE TO anon USING (true) WITH CHECK (true);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================
CREATE INDEX IF NOT EXISTS idx_accounts_environment ON accounts(environment_id);
CREATE INDEX IF NOT EXISTS idx_templates_environment ON api_templates(environment_id);
CREATE INDEX IF NOT EXISTS idx_workflows_environment ON workflows(environment_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_order ON workflow_steps(workflow_id, step_order);
CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow ON workflow_executions(workflow_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_template ON test_runs(api_template_id);
CREATE INDEX IF NOT EXISTS idx_test_runs_status ON test_runs(status);
CREATE INDEX IF NOT EXISTS idx_findings_test_run ON findings(test_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_security_run ON findings(security_run_id);
CREATE INDEX IF NOT EXISTS idx_findings_source_type ON findings(source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_template ON findings(template_id);
CREATE INDEX IF NOT EXISTS idx_findings_workflow ON findings(workflow_id);
CREATE INDEX IF NOT EXISTS idx_findings_suppressed ON findings(is_suppressed) WHERE is_suppressed = true;
CREATE INDEX IF NOT EXISTS idx_security_runs_status ON security_runs(status);
CREATE INDEX IF NOT EXISTS idx_security_runs_created ON security_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suppression_rules_enabled ON finding_suppression_rules(is_enabled) WHERE is_enabled = true;

-- ============================================
-- TRIGGERS FOR updated_at
-- ============================================
CREATE TRIGGER update_environments_updated_at BEFORE UPDATE ON environments FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_api_templates_updated_at BEFORE UPDATE ON api_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_checklists_updated_at BEFORE UPDATE ON checklists FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_security_rules_updated_at BEFORE UPDATE ON security_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_workflow_steps_updated_at BEFORE UPDATE ON workflow_steps FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_workflow_executions_updated_at BEFORE UPDATE ON workflow_executions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_test_runs_updated_at BEFORE UPDATE ON test_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_findings_updated_at BEFORE UPDATE ON findings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_security_runs_updated_at BEFORE UPDATE ON security_runs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_cicd_gate_policies_updated_at BEFORE UPDATE ON cicd_gate_policies FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_suppression_rules_updated_at BEFORE UPDATE ON finding_suppression_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();