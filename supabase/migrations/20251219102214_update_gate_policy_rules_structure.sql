/*
  # Update Gate Policy Rules Structure

  1. Changes
    - Add `rules_test` (jsonb) - Array of rules for test run findings
    - Add `rules_workflow` (jsonb) - Array of rules for workflow findings
    - Add constraint to ensure weight_test + weight_workflow = 100

  2. Rule Structure
    Each rule in the array has:
    - operator: '>=', '>', '<=', '<', '==', '!='
    - threshold: number (the value to compare against)
    - action: 'BLOCK', 'WARN', 'PASS'

    Rules are evaluated in order, first match wins.

  3. Example
    rules_test: [
      { "operator": ">=", "threshold": 30, "action": "BLOCK" },
      { "operator": ">=", "threshold": 1, "action": "WARN" },
      { "operator": "<", "threshold": 1, "action": "PASS" }
    ]
*/

-- Add new columns for rule arrays
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cicd_gate_policies' AND column_name = 'rules_test'
  ) THEN
    ALTER TABLE cicd_gate_policies ADD COLUMN rules_test jsonb DEFAULT '[
      {"operator": ">=", "threshold": 5, "action": "BLOCK"},
      {"operator": ">=", "threshold": 1, "action": "WARN"},
      {"operator": "<", "threshold": 1, "action": "PASS"}
    ]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cicd_gate_policies' AND column_name = 'rules_workflow'
  ) THEN
    ALTER TABLE cicd_gate_policies ADD COLUMN rules_workflow jsonb DEFAULT '[
      {"operator": ">=", "threshold": 5, "action": "BLOCK"},
      {"operator": ">=", "threshold": 1, "action": "WARN"},
      {"operator": "<", "threshold": 1, "action": "PASS"}
    ]'::jsonb;
  END IF;
END $$;

-- Update default values for weights to sum to 100
-- (weight_test=100, weight_workflow=0 means 100% test runs only)
ALTER TABLE cicd_gate_policies 
  ALTER COLUMN weight_test SET DEFAULT 100,
  ALTER COLUMN weight_workflow SET DEFAULT 0;

-- Add check constraint for weights summing to 100
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage 
    WHERE constraint_name = 'weights_sum_to_100'
  ) THEN
    ALTER TABLE cicd_gate_policies
      ADD CONSTRAINT weights_sum_to_100 
      CHECK (weight_test + weight_workflow = 100);
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Update existing rows to have valid weights (if any exist with invalid sums)
UPDATE cicd_gate_policies 
SET weight_workflow = 100 - weight_test 
WHERE weight_test + weight_workflow != 100;

-- Add comments
COMMENT ON COLUMN cicd_gate_policies.rules_test IS 'Array of threshold rules for test run findings. Each rule: {operator, threshold, action}';
COMMENT ON COLUMN cicd_gate_policies.rules_workflow IS 'Array of threshold rules for workflow findings. Each rule: {operator, threshold, action}';