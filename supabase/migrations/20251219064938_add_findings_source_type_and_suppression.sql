/*
  # Add Findings Source Type Classification and Suppression Rules

  ## 1. New Columns in findings table
    - `source_type` (text) - 'test_run' or 'workflow' (required)
    - `template_id` (uuid) - Reference to api_templates for test_run findings
    - `workflow_id` (uuid) - Reference to workflows for workflow findings
    
  ## 2. New Table: finding_suppression_rules
    - Stores rules for filtering/suppressing noisy findings
    - Supports both test_run and workflow findings
    - Can match by path, service-id, template, workflow, environment
    
  ## 3. Constraints
    - CHECK constraint ensuring source_type consistency:
      - test_run findings must have template_id, not workflow_id
      - workflow findings must have workflow_id, not template_id
    
  ## 4. Data Migration
    - Existing findings are migrated based on presence of workflow_id
    - Adds necessary indexes for performance
    
  ## 5. Security
    - Enable RLS on finding_suppression_rules
    - Add policies for authenticated users
*/

-- Step 1: Add new columns to findings table
DO $$
BEGIN
  -- Add source_type column
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE findings ADD COLUMN source_type text;
  END IF;
  
  -- Add template_id column (for test_run findings)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'template_id'
  ) THEN
    ALTER TABLE findings ADD COLUMN template_id uuid REFERENCES api_templates(id) ON DELETE SET NULL;
  END IF;
  
  -- Add workflow_id column if not exists (for workflow findings)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'workflow_id'
  ) THEN
    ALTER TABLE findings ADD COLUMN workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL;
  END IF;
  
  -- Add is_suppressed flag
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'is_suppressed'
  ) THEN
    ALTER TABLE findings ADD COLUMN is_suppressed boolean DEFAULT false;
  END IF;
  
  -- Add suppression_rule_id reference
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'suppression_rule_id'
  ) THEN
    ALTER TABLE findings ADD COLUMN suppression_rule_id uuid;
  END IF;
END $$;

-- Step 2: Migrate existing findings data
-- Findings with api_template_id are test_run findings
-- Findings with workflow-related fields in description/evidence are workflow findings
UPDATE findings
SET source_type = CASE
  WHEN api_template_id IS NOT NULL THEN 'test_run'
  WHEN template_name LIKE '%Workflow%' OR description LIKE '%workflow%' OR description LIKE '%Step %' THEN 'workflow'
  ELSE 'test_run'
END,
template_id = CASE
  WHEN api_template_id IS NOT NULL THEN api_template_id
  ELSE NULL
END
WHERE source_type IS NULL;

-- Step 3: Create finding_suppression_rules table
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

-- Step 4: Add CHECK constraints for source_type consistency
-- First ensure all findings have source_type
UPDATE findings SET source_type = 'test_run' WHERE source_type IS NULL;

-- Make source_type NOT NULL
ALTER TABLE findings ALTER COLUMN source_type SET NOT NULL;

-- Add CHECK constraint for source_type values
DO $$
BEGIN
  ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_source_type_check;
  ALTER TABLE findings ADD CONSTRAINT findings_source_type_check 
    CHECK (source_type IN ('test_run', 'workflow'));
END $$;

-- Add CHECK constraint for consistency
DO $$
BEGIN
  ALTER TABLE findings DROP CONSTRAINT IF EXISTS findings_source_consistency_check;
  ALTER TABLE findings ADD CONSTRAINT findings_source_consistency_check
    CHECK (
      (source_type = 'test_run' AND template_id IS NOT NULL AND workflow_id IS NULL) OR
      (source_type = 'workflow' AND workflow_id IS NOT NULL AND template_id IS NULL)
    );
END $$;

-- Step 5: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_findings_source_type_created ON findings(source_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_template_id ON findings(template_id, created_at DESC) WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_workflow_id_created ON findings(workflow_id, created_at DESC) WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_findings_is_suppressed ON findings(is_suppressed) WHERE is_suppressed = true;
CREATE INDEX IF NOT EXISTS idx_suppression_rules_enabled ON finding_suppression_rules(is_enabled) WHERE is_enabled = true;

-- Step 6: Enable RLS on finding_suppression_rules
ALTER TABLE finding_suppression_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read suppression rules"
  ON finding_suppression_rules
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can create suppression rules"
  ON finding_suppression_rules
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update suppression rules"
  ON finding_suppression_rules
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete suppression rules"
  ON finding_suppression_rules
  FOR DELETE
  TO authenticated
  USING (true);

-- Step 7: Add comments
COMMENT ON COLUMN findings.source_type IS 'Type of finding: test_run (API template) or workflow (workflow execution)';
COMMENT ON COLUMN findings.template_id IS 'Reference to api_templates for test_run findings';
COMMENT ON COLUMN findings.workflow_id IS 'Reference to workflows for workflow findings';
COMMENT ON COLUMN findings.is_suppressed IS 'Whether this finding is suppressed by a suppression rule';
COMMENT ON COLUMN findings.suppression_rule_id IS 'Reference to the suppression rule that suppressed this finding';

COMMENT ON TABLE finding_suppression_rules IS 'Rules for filtering/suppressing noisy findings';
COMMENT ON COLUMN finding_suppression_rules.applies_to IS 'Which findings to suppress: test_run, workflow, or both';
COMMENT ON COLUMN finding_suppression_rules.match_method IS 'HTTP method to match (ANY, GET, POST, etc.)';
COMMENT ON COLUMN finding_suppression_rules.match_type IS 'How to match the path: exact, prefix, regex, or contains';
COMMENT ON COLUMN finding_suppression_rules.match_path IS 'Path pattern to match';
COMMENT ON COLUMN finding_suppression_rules.match_service_id IS 'Service-Id header value to match';
