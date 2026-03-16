/*
  # Add Step Assertions and Baseline Config

  1. New Fields for workflow_steps
    - `step_assertions` (jsonb) - Array of assertion rules for cross-step/variable validation
    - `assertions_mode` (text) - 'all' (default) or 'any' for assertion combination logic

  2. New Fields for workflows
    - `baseline_config` (jsonb) - Configuration for baseline comparison
      - ignore_paths: paths to exclude from diff
      - critical_paths: paths to highlight in diff
      - diff_threshold: minimum diff score to create finding

  3. Structure
    - step_assertions: [{
        op: 'equals' | 'not_equals' | 'contains' | 'regex',
        left: { type: 'response', path: 'body.xxx' | 'headers.xxx' },
        right: { 
          type: 'literal' | 'workflow_variable' | 'workflow_context', 
          value/key: 'xxx' 
        }
      }]
    - baseline_config: {
        ignore_paths: ['body.timestamp', 'body.traceId'],
        critical_paths: ['body.user_id', 'body.phone'],
        diff_threshold: 0.1
      }
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_steps' AND column_name = 'step_assertions'
  ) THEN
    ALTER TABLE workflow_steps ADD COLUMN step_assertions jsonb DEFAULT '[]';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflow_steps' AND column_name = 'assertions_mode'
  ) THEN
    ALTER TABLE workflow_steps ADD COLUMN assertions_mode text DEFAULT 'all';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'baseline_config'
  ) THEN
    ALTER TABLE workflows ADD COLUMN baseline_config jsonb DEFAULT '{"ignore_paths": [], "critical_paths": [], "diff_threshold": 0.1}';
  END IF;
END $$;

COMMENT ON COLUMN workflow_steps.step_assertions IS 'Array of assertion rules for validating response against workflow variables/context';
COMMENT ON COLUMN workflow_steps.assertions_mode IS 'How to combine assertions: all (AND) or any (OR)';
COMMENT ON COLUMN workflows.baseline_config IS 'Configuration for baseline comparison: ignore_paths, critical_paths, diff_threshold';
