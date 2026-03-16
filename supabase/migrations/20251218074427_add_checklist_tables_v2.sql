/*
  # Add Checklist Tables for API Security Testing Platform

  1. New Tables
    - `checklists` - Manage value lists for fuzzing (number ranges, string lists, account fields)

  2. Modify Existing Tables
    - Update `accounts` table to support custom fields
    - Update `api_templates` table to support variables and failure patterns
    - Update `test_runs` table structure
    - Update `findings` table structure

  3. Security
    - Enable RLS on new tables
    - Add policies for authenticated users
*/

-- Create update_updated_at_column function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create checklists table (this is completely new)
CREATE TABLE IF NOT EXISTS checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('number_range', 'string_list', 'account_field')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Add new columns to accounts table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'accounts' AND column_name = 'fields'
  ) THEN
    ALTER TABLE accounts ADD COLUMN fields jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Add new columns to api_templates table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'raw_request'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN raw_request text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'parsed_structure'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN parsed_structure jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'variables'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN variables jsonb DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'failure_patterns'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN failure_patterns jsonb DEFAULT '[]'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'failure_logic'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN failure_logic text DEFAULT 'OR';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'api_templates' AND column_name = 'baseline_account_id'
  ) THEN
    ALTER TABLE api_templates ADD COLUMN baseline_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add new columns to test_runs table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'trigger_type'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN trigger_type text DEFAULT 'manual';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'test_runs' AND column_name = 'progress'
  ) THEN
    ALTER TABLE test_runs ADD COLUMN progress jsonb DEFAULT '{}'::jsonb;
  END IF;
END $$;

-- Add new columns to findings table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'template_name'
  ) THEN
    ALTER TABLE findings ADD COLUMN template_name text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'variable_values'
  ) THEN
    ALTER TABLE findings ADD COLUMN variable_values jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'request_raw'
  ) THEN
    ALTER TABLE findings ADD COLUMN request_raw text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'response_status'
  ) THEN
    ALTER TABLE findings ADD COLUMN response_status integer;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'response_headers'
  ) THEN
    ALTER TABLE findings ADD COLUMN response_headers jsonb DEFAULT '{}'::jsonb;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'response_body'
  ) THEN
    ALTER TABLE findings ADD COLUMN response_body text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'notes'
  ) THEN
    ALTER TABLE findings ADD COLUMN notes text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'findings' AND column_name = 'discovered_at'
  ) THEN
    ALTER TABLE findings ADD COLUMN discovered_at timestamptz DEFAULT now();
  END IF;
END $$;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_checklists_type ON checklists(type);

-- Enable Row Level Security on checklists
ALTER TABLE checklists ENABLE ROW LEVEL SECURITY;

-- RLS Policies for checklists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'checklists' AND policyname = 'Allow all authenticated users to read checklists'
  ) THEN
    CREATE POLICY "Allow all authenticated users to read checklists"
      ON checklists FOR SELECT
      TO authenticated
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'checklists' AND policyname = 'Allow all authenticated users to insert checklists'
  ) THEN
    CREATE POLICY "Allow all authenticated users to insert checklists"
      ON checklists FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'checklists' AND policyname = 'Allow all authenticated users to update checklists'
  ) THEN
    CREATE POLICY "Allow all authenticated users to update checklists"
      ON checklists FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'checklists' AND policyname = 'Allow all authenticated users to delete checklists'
  ) THEN
    CREATE POLICY "Allow all authenticated users to delete checklists"
      ON checklists FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Create trigger for checklists updated_at
DROP TRIGGER IF EXISTS update_checklists_updated_at ON checklists;
CREATE TRIGGER update_checklists_updated_at
  BEFORE UPDATE ON checklists
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();