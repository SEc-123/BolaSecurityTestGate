/*
  # Enhance Security Testing Capabilities

  1. Account Binding Strategies
    - Add binding_strategy to variable configs
    - Support per-account binding and attacker anchoring
    - Add attacker_account_id for anchor strategy

  2. Baseline Comparison
    - Enable baseline request execution
    - Support response comparison modes
    - Add custom comparison rules

  3. Path Replacement Enhancement
    - Support segment index replacement
    - Support regex pattern replacement
    - Add configuration for replacement modes

  4. Body Format Support
    - Track body content type
    - Enable form-urlencoded and multipart handling

  5. Findings Traceability
    - Record account source mapping
    - Track attacker and victim accounts
    - Add execution context

  6. Workflow Assertion Strategies
    - Configure multi-step assertion logic
    - Specify critical steps for validation
    - Enable flexible failure detection
*/

-- Enhance api_templates variables with advanced replacement options
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'advanced_config'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN advanced_config jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN api_templates.advanced_config IS 'Advanced configuration for path/body replacement, baseline comparison, etc.';

-- Enhance variable_config structure in api_templates
-- This will be stored in the variables array with extended properties:
-- {
--   "path_replacement_mode": "placeholder|segment_index|regex",
--   "path_segment_index": number,
--   "path_regex_pattern": string,
--   "body_content_type": "json|form_urlencoded|multipart|text"
-- }

-- Add account binding strategy to api_templates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'account_binding_strategy'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN account_binding_strategy text DEFAULT 'independent' 
      CHECK (account_binding_strategy IN ('independent', 'per_account', 'anchor_attacker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'attacker_account_id'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN attacker_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN api_templates.account_binding_strategy IS 'Strategy for combining account field values: independent (cartesian), per_account (same account), anchor_attacker (fixed attacker)';
COMMENT ON COLUMN api_templates.attacker_account_id IS 'Fixed attacker account ID when using anchor_attacker strategy';

-- Add baseline comparison configuration to api_templates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'enable_baseline'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN enable_baseline boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'baseline_config'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN baseline_config jsonb DEFAULT '{
      "comparison_mode": "status_and_body",
      "rules": {
        "compare_status": true,
        "compare_body_structure": true,
        "compare_business_code": true,
        "business_code_path": "code",
        "ignore_fields": ["timestamp", "requestId"],
        "critical_fields": ["userId", "data"]
      }
    }'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN api_templates.enable_baseline IS 'Whether to execute baseline request before mutation for comparison';
COMMENT ON COLUMN api_templates.baseline_config IS 'Configuration for baseline vs mutated response comparison';

-- Enhance workflow_variable_configs with binding strategy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_variable_configs' AND column_name = 'binding_strategy'
  ) THEN
    ALTER TABLE workflow_variable_configs ADD COLUMN binding_strategy text DEFAULT 'independent'
      CHECK (binding_strategy IN ('independent', 'per_account', 'anchor_attacker'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_variable_configs' AND column_name = 'attacker_account_id'
  ) THEN
    ALTER TABLE workflow_variable_configs ADD COLUMN attacker_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_variable_configs' AND column_name = 'advanced_config'
  ) THEN
    ALTER TABLE workflow_variable_configs ADD COLUMN advanced_config jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Add workflow-level assertion strategy
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'assertion_strategy'
  ) THEN
    ALTER TABLE workflows ADD COLUMN assertion_strategy text DEFAULT 'any_step_pass'
      CHECK (assertion_strategy IN ('any_step_pass', 'all_steps_pass', 'last_step_pass', 'specific_steps'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'critical_step_orders'
  ) THEN
    ALTER TABLE workflows ADD COLUMN critical_step_orders integer[] DEFAULT ARRAY[]::integer[];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'enable_baseline'
  ) THEN
    ALTER TABLE workflows ADD COLUMN enable_baseline boolean DEFAULT false;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'baseline_config'
  ) THEN
    ALTER TABLE workflows ADD COLUMN baseline_config jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN workflows.assertion_strategy IS 'Strategy for determining workflow success/failure across multiple steps';
COMMENT ON COLUMN workflows.critical_step_orders IS 'Specific step orders to validate when using specific_steps strategy';
COMMENT ON COLUMN workflows.enable_baseline IS 'Whether to execute baseline workflow before mutation';

-- Enhance findings with account traceability
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'account_source_map'
  ) THEN
    ALTER TABLE findings ADD COLUMN account_source_map jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'attacker_account_id'
  ) THEN
    ALTER TABLE findings ADD COLUMN attacker_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'victim_account_ids'
  ) THEN
    ALTER TABLE findings ADD COLUMN victim_account_ids uuid[] DEFAULT ARRAY[]::uuid[];
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'baseline_response'
  ) THEN
    ALTER TABLE findings ADD COLUMN baseline_response jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'mutated_response'
  ) THEN
    ALTER TABLE findings ADD COLUMN mutated_response jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'response_diff'
  ) THEN
    ALTER TABLE findings ADD COLUMN response_diff jsonb;
  END IF;
END $$;

COMMENT ON COLUMN findings.account_source_map IS 'Map of variable names to source account IDs: {"userId": "account-uuid", "token": "account-uuid"}';
COMMENT ON COLUMN findings.attacker_account_id IS 'Account ID used as attacker (for anchor strategy)';
COMMENT ON COLUMN findings.victim_account_ids IS 'Account IDs used as victims/targets in this finding';
COMMENT ON COLUMN findings.baseline_response IS 'Baseline (original/attacker) response for comparison';
COMMENT ON COLUMN findings.mutated_response IS 'Mutated (with victim data) response';
COMMENT ON COLUMN findings.response_diff IS 'Computed differences between baseline and mutated responses';

-- Add indexes for new columns
CREATE INDEX IF NOT EXISTS idx_findings_attacker_account ON findings(attacker_account_id);
CREATE INDEX IF NOT EXISTS idx_findings_victim_accounts ON findings USING GIN(victim_account_ids);
CREATE INDEX IF NOT EXISTS idx_api_templates_attacker_account ON api_templates(attacker_account_id);
CREATE INDEX IF NOT EXISTS idx_workflow_configs_attacker_account ON workflow_variable_configs(attacker_account_id);

-- Add execution context to test_runs
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'execution_config'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN execution_config jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN test_runs.execution_config IS 'Execution configuration snapshot including binding strategies and baseline settings';
