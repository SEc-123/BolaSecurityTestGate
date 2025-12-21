/*
  # Add Workflow Tables

  1. New Tables
    - `workflows`
      - `id` (uuid, primary key)
      - `name` (text) - Workflow name like "Login Flow", "Registration Flow"
      - `description` (text) - Optional description
      - `is_active` (boolean) - Whether workflow is active
      - `created_by` (uuid) - Creator reference
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

    - `workflow_steps`
      - `id` (uuid, primary key)
      - `workflow_id` (uuid, foreign key) - Reference to workflows
      - `api_template_id` (uuid, foreign key) - Reference to api_templates
      - `step_order` (integer) - Order of execution (1, 2, 3...)
      - `created_at` (timestamptz)

    - `workflow_variable_configs`
      - `id` (uuid, primary key)
      - `workflow_id` (uuid, foreign key) - Reference to workflows
      - `name` (text) - Variable name for display
      - `step_variable_mappings` (jsonb) - Maps step_order to variable config
      - `data_source` (text) - 'checklist' or 'account_field' or 'security_rule'
      - `checklist_id` (uuid) - Reference to checklists
      - `security_rule_id` (uuid) - Reference to security_rules
      - `account_field_name` (text) - Account field name
      - `created_at` (timestamptz)

  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated users

  3. Notes
    - Workflow steps can reference same API template multiple times
    - Variable configs apply across all steps in workflow
*/

-- Create workflows table
CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  is_active boolean DEFAULT true,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create workflow_steps table
CREATE TABLE IF NOT EXISTS workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  api_template_id uuid NOT NULL REFERENCES api_templates(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(workflow_id, step_order)
);

-- Create workflow_variable_configs table
CREATE TABLE IF NOT EXISTS workflow_variable_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  name text NOT NULL,
  step_variable_mappings jsonb NOT NULL DEFAULT '[]',
  data_source text CHECK (data_source IN ('checklist', 'account_field', 'security_rule')),
  checklist_id uuid REFERENCES checklists(id) ON DELETE SET NULL,
  security_rule_id uuid REFERENCES security_rules(id) ON DELETE SET NULL,
  account_field_name text,
  created_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_variable_configs ENABLE ROW LEVEL SECURITY;

-- RLS policies for workflows
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflows' AND policyname = 'Authenticated users can view workflows') THEN
    CREATE POLICY "Authenticated users can view workflows"
      ON workflows FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflows' AND policyname = 'Authenticated users can create workflows') THEN
    CREATE POLICY "Authenticated users can create workflows"
      ON workflows FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflows' AND policyname = 'Authenticated users can update workflows') THEN
    CREATE POLICY "Authenticated users can update workflows"
      ON workflows FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflows' AND policyname = 'Authenticated users can delete workflows') THEN
    CREATE POLICY "Authenticated users can delete workflows"
      ON workflows FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;

-- RLS policies for workflow_steps
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_steps' AND policyname = 'Authenticated users can view workflow_steps') THEN
    CREATE POLICY "Authenticated users can view workflow_steps"
      ON workflow_steps FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_steps' AND policyname = 'Authenticated users can create workflow_steps') THEN
    CREATE POLICY "Authenticated users can create workflow_steps"
      ON workflow_steps FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_steps' AND policyname = 'Authenticated users can update workflow_steps') THEN
    CREATE POLICY "Authenticated users can update workflow_steps"
      ON workflow_steps FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_steps' AND policyname = 'Authenticated users can delete workflow_steps') THEN
    CREATE POLICY "Authenticated users can delete workflow_steps"
      ON workflow_steps FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;

-- RLS policies for workflow_variable_configs
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_variable_configs' AND policyname = 'Authenticated users can view workflow_variable_configs') THEN
    CREATE POLICY "Authenticated users can view workflow_variable_configs"
      ON workflow_variable_configs FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_variable_configs' AND policyname = 'Authenticated users can create workflow_variable_configs') THEN
    CREATE POLICY "Authenticated users can create workflow_variable_configs"
      ON workflow_variable_configs FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_variable_configs' AND policyname = 'Authenticated users can update workflow_variable_configs') THEN
    CREATE POLICY "Authenticated users can update workflow_variable_configs"
      ON workflow_variable_configs FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'workflow_variable_configs' AND policyname = 'Authenticated users can delete workflow_variable_configs') THEN
    CREATE POLICY "Authenticated users can delete workflow_variable_configs"
      ON workflow_variable_configs FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_id ON workflow_steps(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_steps_template_id ON workflow_steps(api_template_id);
CREATE INDEX IF NOT EXISTS idx_workflow_variable_configs_workflow_id ON workflow_variable_configs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflows_is_active ON workflows(is_active);

-- Add execution_type column to test_runs to distinguish workflow vs template execution
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'execution_type'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN execution_type text DEFAULT 'template' CHECK (execution_type IN ('template', 'workflow'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'workflow_id'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL;
  END IF;
END $$;
