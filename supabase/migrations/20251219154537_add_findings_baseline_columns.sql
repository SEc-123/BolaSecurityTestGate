/*
  # Add Baseline Comparison Columns to Findings

  1. Changes to findings table
    - Add `account_source_map` for tracking which account each variable came from
    - Add `attacker_account_id` for anchor_attacker strategy
    - Add `victim_account_ids` for tracking target accounts
    - Add `baseline_response` for storing baseline response data
    - Add `mutated_response` for storing mutated response data  
    - Add `response_diff` for storing comparison diff

  2. Notes
    - These columns support the baseline comparison feature for detecting vulnerabilities
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'account_source_map'
  ) THEN
    ALTER TABLE findings ADD COLUMN account_source_map jsonb DEFAULT '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'attacker_account_id'
  ) THEN
    ALTER TABLE findings ADD COLUMN attacker_account_id uuid;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'victim_account_ids'
  ) THEN
    ALTER TABLE findings ADD COLUMN victim_account_ids uuid[] DEFAULT '{}';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'baseline_response'
  ) THEN
    ALTER TABLE findings ADD COLUMN baseline_response jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'mutated_response'
  ) THEN
    ALTER TABLE findings ADD COLUMN mutated_response jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'response_diff'
  ) THEN
    ALTER TABLE findings ADD COLUMN response_diff jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'status'
  ) THEN
    ALTER TABLE findings ADD COLUMN status text DEFAULT 'new';
  END IF;
END $$;
