/*
  # Add Variable Validation and Account Scope Control
  
  1. New Table (if not exists): workflow_variable_configs
    - Core fields for variable configuration
    - Account scope control fields for filtering which accounts participate in variable values
  
  2. New Columns:
    - `account_scope_mode` (TEXT): Controls which accounts participate
      - 'all': Use all accounts (default, current behavior)
      - 'only_selected': Only use accounts in account_scope_ids
      - 'exclude_selected': Use all accounts except those in account_scope_ids
    - `account_scope_ids` (JSONB): Array of account IDs for scope filtering
  
  3. Changes to test_runs:
    - `validation_report` (JSONB): Stores variable validation results
  
  4. Purpose:
    - Enable strategy-aware validation before execution
    - Support variable-level account pool control
    - Provide audit trail for validation decisions
*/

CREATE TABLE IF NOT EXISTS workflow_variable_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  name text NOT NULL,
  step_variable_mappings jsonb NOT NULL DEFAULT '[]',
  data_source text CHECK (data_source IN ('checklist', 'account_field', 'security_rule', 'workflow_context')),
  checklist_id uuid,
  security_rule_id uuid,
  account_field_name text,
  binding_strategy text,
  attacker_account_id uuid,
  role text,
  is_attacker_field boolean DEFAULT false,
  advanced_config jsonb,
  account_scope_mode text DEFAULT 'all' CHECK (account_scope_mode IN ('all', 'only_selected', 'exclude_selected')),
  account_scope_ids jsonb DEFAULT '[]',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE workflow_variable_configs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_variable_configs' AND policyname = 'Allow all access to workflow_variable_configs') THEN
    CREATE POLICY "Allow all access to workflow_variable_configs"
      ON workflow_variable_configs FOR ALL
      TO authenticated, anon
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_variable_configs' AND column_name = 'account_scope_mode'
  ) THEN
    ALTER TABLE workflow_variable_configs 
    ADD COLUMN account_scope_mode text DEFAULT 'all' CHECK (account_scope_mode IN ('all', 'only_selected', 'exclude_selected'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_variable_configs' AND column_name = 'account_scope_ids'
  ) THEN
    ALTER TABLE workflow_variable_configs 
    ADD COLUMN account_scope_ids jsonb DEFAULT '[]';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  status text DEFAULT 'pending',
  execution_type text,
  trigger_type text,
  rule_ids jsonb,
  template_ids jsonb,
  account_ids jsonb,
  environment_id uuid,
  workflow_id uuid,
  execution_params jsonb,
  progress_percent integer DEFAULT 0,
  progress jsonb,
  error_message text,
  errors_count integer DEFAULT 0,
  has_execution_error boolean DEFAULT false,
  validation_report jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE test_runs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'test_runs' AND policyname = 'Allow all access to test_runs') THEN
    CREATE POLICY "Allow all access to test_runs"
      ON test_runs FOR ALL
      TO authenticated, anon
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'validation_report'
  ) THEN
    ALTER TABLE test_runs 
    ADD COLUMN validation_report jsonb;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workflow_variable_configs_workflow_id ON workflow_variable_configs(workflow_id);

COMMENT ON COLUMN workflow_variable_configs.account_scope_mode IS 'Account pool filter mode: all, only_selected, exclude_selected';
COMMENT ON COLUMN workflow_variable_configs.account_scope_ids IS 'Account IDs for scope filtering when mode is only_selected or exclude_selected';
COMMENT ON COLUMN test_runs.validation_report IS 'Variable validation results including coverage analysis and fatal errors';
