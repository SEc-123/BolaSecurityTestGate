/*
  # Add Workflow Extractors and Session Jar Support
  
  1. New Tables
    - `workflow_extractors`
      - `id` (uuid, primary key)
      - `workflow_id` (uuid, foreign key to workflows)
      - `step_order` (integer) - which step to extract from
      - `name` (text) - variable name to store extracted value
      - `source` (text) - extraction source type
      - `expression` (text) - JSONPath, regex, or header key
      - `transform` (jsonb) - optional transformations
      - `required` (boolean) - if true, extraction failure = workflow failure
      - `created_at` (timestamptz)
  
  2. Modified Tables
    - `workflows` - add enable_extractor, enable_session_jar, session_jar_config
    - `workflow_variable_configs` - add workflow_context data_source support
  
  3. Security
    - Enable RLS on workflow_extractors
    - Add policies for authenticated users
*/

CREATE TABLE IF NOT EXISTS workflow_extractors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('response_body_jsonpath', 'response_body_regex', 'response_header', 'response_status')),
  expression text NOT NULL,
  transform jsonb DEFAULT NULL,
  required boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_extractors_workflow_id ON workflow_extractors(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_extractors_step_order ON workflow_extractors(workflow_id, step_order);

ALTER TABLE workflow_extractors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read workflow_extractors"
  ON workflow_extractors
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert workflow_extractors"
  ON workflow_extractors
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update workflow_extractors"
  ON workflow_extractors
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete workflow_extractors"
  ON workflow_extractors
  FOR DELETE
  TO authenticated
  USING (true);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'enable_extractor'
  ) THEN
    ALTER TABLE workflows ADD COLUMN enable_extractor boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'enable_session_jar'
  ) THEN
    ALTER TABLE workflows ADD COLUMN enable_session_jar boolean DEFAULT false;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workflows' AND column_name = 'session_jar_config'
  ) THEN
    ALTER TABLE workflows ADD COLUMN session_jar_config jsonb DEFAULT NULL;
  END IF;
END $$;

COMMENT ON TABLE workflow_extractors IS 'Stores extraction rules for workflow steps to extract values from responses';
COMMENT ON COLUMN workflow_extractors.source IS 'Source type: response_body_jsonpath, response_body_regex, response_header, response_status';
COMMENT ON COLUMN workflow_extractors.expression IS 'JSONPath expression, regex pattern, or header key depending on source';
COMMENT ON COLUMN workflow_extractors.transform IS 'Optional transformations: {type: "trim"|"lower"|"upper"|"prefix"|"suffix", value?: string}';
COMMENT ON COLUMN workflow_extractors.required IS 'If true, extraction failure causes the workflow combination to fail';
COMMENT ON COLUMN workflows.enable_extractor IS 'When true, enables extractor rules for this workflow';
COMMENT ON COLUMN workflows.enable_session_jar IS 'When true, enables cookie/session jar for cross-step session data';
COMMENT ON COLUMN workflows.session_jar_config IS 'Configuration for session jar: {body_json_paths: string[], header_keys: string[], cookie_mode: boolean}';