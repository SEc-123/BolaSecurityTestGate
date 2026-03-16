/*
  # AI Findings Analyzer & Report Generator Tables

  ## Overview
  This migration creates the necessary tables for the AI-powered security findings analysis system.
  It enables configuration of multiple AI providers, storage of AI analysis verdicts, and generated reports.

  ## 1. New Tables
  
  ### `ai_providers`
  Stores configuration for different AI service providers (DeepSeek, Qwen, Llama, ChatGPT, etc.)
  - `id` (uuid, primary key) - Unique identifier
  - `name` (text) - Display name for the provider
  - `provider_type` (text) - Type: 'openai' | 'deepseek' | 'qwen' | 'llama' | 'openai_compat'
  - `base_url` (text, nullable) - API endpoint URL
  - `api_key` (text) - API authentication key (encrypted/sensitive)
  - `model` (text) - Model identifier (e.g., 'gpt-4', 'deepseek-chat')
  - `is_enabled` (boolean) - Whether this provider is active
  - `is_default` (boolean) - Whether this is the default provider
  - `created_at` (timestamptz) - Creation timestamp
  - `updated_at` (timestamptz) - Last update timestamp
  
  ### `ai_analyses`
  Stores AI analysis results for individual findings
  - `id` (uuid, primary key) - Unique identifier
  - `run_id` (uuid) - Reference to security_run or test_run
  - `finding_id` (uuid) - Reference to the analyzed finding
  - `provider_id` (uuid, foreign key) - AI provider used
  - `model` (text) - Specific model version used
  - `prompt_version` (text) - Version of the prompt template used
  - `input_hash` (text) - Hash of input data for deduplication
  - `result_json` (jsonb) - Structured verdict output (strict schema)
  - `tokens_in` (integer, nullable) - Input tokens consumed
  - `tokens_out` (integer, nullable) - Output tokens generated
  - `latency_ms` (integer, nullable) - Analysis duration in milliseconds
  - `created_at` (timestamptz) - Analysis timestamp
  
  ### `ai_reports`
  Stores generated markdown reports based on AI verdicts
  - `id` (uuid, primary key) - Unique identifier
  - `run_id` (uuid) - Reference to security_run or test_run
  - `provider_id` (uuid, foreign key) - AI provider used
  - `model` (text) - Model used for report generation
  - `prompt_version` (text) - Version of report prompt template
  - `filters` (jsonb) - Applied filters (min_confidence, include_severities)
  - `report_markdown` (text) - Generated markdown report content
  - `stats` (jsonb) - Statistics (vulnerability count, severity distribution)
  - `created_at` (timestamptz) - Report generation timestamp

  ## 2. Security
  - Enable RLS on all tables
  - Add policies for authenticated users to manage their AI configurations and view results
  
  ## 3. Indexes
  - Index on ai_analyses(run_id, finding_id) for fast lookup
  - Index on ai_analyses(input_hash) for deduplication
  - Index on ai_reports(run_id) for report listing
*/

-- Create ai_providers table
CREATE TABLE IF NOT EXISTS ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  provider_type text NOT NULL CHECK (provider_type IN ('openai', 'deepseek', 'qwen', 'llama', 'openai_compat')),
  base_url text,
  api_key text NOT NULL,
  model text NOT NULL,
  is_enabled boolean DEFAULT true NOT NULL,
  is_default boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- Create ai_analyses table
CREATE TABLE IF NOT EXISTS ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  result_json jsonb NOT NULL,
  tokens_in integer,
  tokens_out integer,
  latency_ms integer,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Create ai_reports table
CREATE TABLE IF NOT EXISTS ai_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model text NOT NULL,
  prompt_version text NOT NULL,
  filters jsonb DEFAULT '{}'::jsonb NOT NULL,
  report_markdown text NOT NULL,
  stats jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_ai_analyses_run_finding ON ai_analyses(run_id, finding_id);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_input_hash ON ai_analyses(input_hash);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_provider ON ai_analyses(provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_reports_run ON ai_reports(run_id);
CREATE INDEX IF NOT EXISTS idx_ai_reports_provider ON ai_reports(provider_id);

-- Enable Row Level Security
ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_reports ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ai_providers
CREATE POLICY "Authenticated users can view AI providers"
  ON ai_providers FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert AI providers"
  ON ai_providers FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update AI providers"
  ON ai_providers FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete AI providers"
  ON ai_providers FOR DELETE
  TO authenticated
  USING (true);

-- RLS Policies for ai_analyses
CREATE POLICY "Authenticated users can view AI analyses"
  ON ai_analyses FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert AI analyses"
  ON ai_analyses FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update AI analyses"
  ON ai_analyses FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete AI analyses"
  ON ai_analyses FOR DELETE
  TO authenticated
  USING (true);

-- RLS Policies for ai_reports
CREATE POLICY "Authenticated users can view AI reports"
  ON ai_reports FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert AI reports"
  ON ai_reports FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update AI reports"
  ON ai_reports FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete AI reports"
  ON ai_reports FOR DELETE
  TO authenticated
  USING (true);

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add trigger for ai_providers updated_at
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'update_ai_providers_updated_at'
  ) THEN
    CREATE TRIGGER update_ai_providers_updated_at
      BEFORE UPDATE ON ai_providers
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;