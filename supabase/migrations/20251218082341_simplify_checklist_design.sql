/*
  # Simplify Checklist Design

  1. Changes
    - Remove type field (no longer needed)
    - Simplify config to just store array of values
    - Keep name and description

  2. Notes
    - Users can freely input values, one per line
    - No distinction between number ranges, strings, etc.
*/

-- Drop type constraint if exists
DO $$
BEGIN
  ALTER TABLE checklists DROP CONSTRAINT IF EXISTS checklists_type_check;
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- Remove type column
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'checklists' AND column_name = 'type'
  ) THEN
    ALTER TABLE checklists DROP COLUMN type;
  END IF;
END $$;

-- Update config to store simple array of strings
-- Keep the jsonb column but it will just store { "values": ["val1", "val2", ...] }