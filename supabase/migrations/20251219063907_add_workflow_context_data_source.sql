/*
  # Add workflow_context to data_source constraint

  1. Changes
    - Updates CHECK constraint on `workflow_variable_configs.data_source` to include 'workflow_context'
    - This allows workflow variables to use values extracted by workflow extractors

  2. Notes
    - Existing data is not affected as only the constraint is updated
    - 'workflow_context' data_source works with the extractor feature to inject extracted values
*/

DO $$
BEGIN
  ALTER TABLE workflow_variable_configs DROP CONSTRAINT IF EXISTS workflow_variable_configs_data_source_check;
  
  ALTER TABLE workflow_variable_configs 
    ADD CONSTRAINT workflow_variable_configs_data_source_check 
    CHECK (data_source IN ('checklist', 'account_field', 'security_rule', 'workflow_context'));
END $$;

COMMENT ON COLUMN workflow_variable_configs.data_source IS 'Source of variable values: checklist, account_field, security_rule, or workflow_context (from extractors)';
