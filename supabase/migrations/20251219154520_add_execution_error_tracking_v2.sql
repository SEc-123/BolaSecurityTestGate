/*
  # Add Execution Error Tracking and Workflow Binding Strategy

  1. Changes to workflows table
    - Add `account_binding_strategy` column for workflow-level binding strategy
    - Add `attacker_account_id` column for anchor_attacker strategy

  2. Changes to test_runs table
    - Add `errors_count` column to track execution errors
    - Add `has_execution_error` column for quick error detection
    - Update status check constraint to include 'completed_with_errors'
    - Add `progress_percent` column for progress tracking

  3. Notes
    - account_binding_strategy: 'per_account' (default), 'anchor_attacker', 'independent'
    - status now supports: 'pending', 'running', 'completed', 'completed_with_errors', 'failed'
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'account_binding_strategy'
  ) THEN
    ALTER TABLE workflows ADD COLUMN account_binding_strategy text DEFAULT 'per_account';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'attacker_account_id'
  ) THEN
    ALTER TABLE workflows ADD COLUMN attacker_account_id uuid;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'errors_count'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN errors_count integer DEFAULT 0;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'has_execution_error'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN has_execution_error boolean DEFAULT false;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'progress_percent'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN progress_percent integer DEFAULT 0;
  END IF;
END $$;

ALTER TABLE test_runs DROP CONSTRAINT IF EXISTS test_runs_status_check;
ALTER TABLE test_runs ADD CONSTRAINT test_runs_status_check 
  CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'completed_with_errors'::text, 'failed'::text]));
