# Checklists Module

## Module Overview

The Checklists module manages reusable value lists that serve as data sources for variable substitution in API templates and workflows.

## Data Model

```typescript
interface Checklist {
  id: string;
  name: string;
  description?: string;
  values: string[];
  tags?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
```

## Configuration Examples

### Valid Email List (Positive Testing)
```json
{
  "name": "Valid Email List",
  "description": "Contains various formats of valid email addresses",
  "values": [
    "user@example.com",
    "test.user@example.com",
    "user+tag@example.com",
    "firstname.lastname@company.co.uk",
    "user123@test-domain.com"
  ],
  "tags": "email,positive,validation",
  "is_active": true
}
```

### Invalid Email List (Negative Testing)
```json
{
  "name": "Invalid Email List",
  "description": "Contains invalid email addresses for testing error handling",
  "values": [
    "invalid-email",
    "test@",
    "@example.com",
    "test@test",
    "",
    "spaces in@email.com"
  ],
  "tags": "email,negative,validation",
  "is_active": true
}
```

### User ID List
```json
{
  "name": "User ID List",
  "description": "Common user IDs for testing",
  "values": ["1", "2", "3", "100", "999", "10000"],
  "tags": "user,id,positive",
  "is_active": true
}
```

### SQL Injection Payloads
```json
{
  "name": "SQL Injection Basic Payloads",
  "description": "Common SQL injection attack vectors",
  "values": [
    "' OR '1'='1",
    "' OR 1=1--",
    "admin'--",
    "'; DROP TABLE users--",
    "1' UNION SELECT NULL--",
    "' OR 'x'='x"
  ],
  "tags": "sql-injection,security,attack-payload",
  "is_active": true
}
```

### XSS Payloads
```json
{
  "name": "XSS Test Payloads",
  "description": "Cross-site scripting attack vectors",
  "values": [
    "<script>alert('XSS')</script>",
    "<img src=x onerror=alert('XSS')>",
    "javascript:alert('XSS')",
    "<svg onload=alert('XSS')>",
    "'\"><script>alert('XSS')</script>"
  ],
  "tags": "xss,security,attack-payload",
  "is_active": true
}
```

### Command Injection Payloads
```json
{
  "name": "Command Injection Payloads",
  "description": "OS command injection test cases",
  "values": [
    "; ls -la",
    "| cat /etc/passwd",
    "&& whoami",
    "`id`",
    "$(whoami)"
  ],
  "tags": "command-injection,security,attack-payload",
  "is_active": true
}
```

### Path Traversal Payloads
```json
{
  "name": "Path Traversal Payloads",
  "description": "Directory traversal attack vectors",
  "values": [
    "../../../etc/passwd",
    "..\\..\\..\\windows\\system32\\config\\sam",
    "....//....//....//etc/passwd",
    "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd"
  ],
  "tags": "path-traversal,security,attack-payload",
  "is_active": true
}
```

### Boundary Value Testing
```json
{
  "name": "Integer Boundary Values",
  "description": "Common boundary values for integer fields",
  "values": [
    "-1",
    "0",
    "1",
    "255",
    "256",
    "32767",
    "32768",
    "2147483647",
    "2147483648"
  ],
  "tags": "boundary,integer,validation",
  "is_active": true
}
```

## Use Cases

### Parameterized Testing
Use checklist values to test the same endpoint with multiple input values.

### Boundary Value Testing
Define boundary value lists for testing edge cases and limits.

### Negative Testing
Define invalid value lists to test error handling and validation.

### Security Testing
Define attack payload lists for security vulnerability scanning.

### Data-Driven Testing
Create comprehensive test datasets for thorough API coverage.

## API Endpoints

### Get All Checklists
```http
GET /api/checklists
```

### Create Checklist
```http
POST /api/checklists
Content-Type: application/json

{
  "name": "Test Data",
  "values": ["value1", "value2", "value3"],
  "is_active": true
}
```

### Update Checklist
```http
PUT /api/checklists/:id
```

### Delete Checklist
```http
DELETE /api/checklists/:id
```

## Using Checklists in Templates

To use a checklist in an API template:

1. Create a checklist with your test values
2. In your API template, add a variable configuration
3. Set the variable's `data_source` to `"checklist"`
4. Set the `checklist_id` to your checklist's ID

Example variable configuration:
```json
{
  "name": "test_email",
  "json_path": "$.body.email",
  "operation_type": "replace",
  "data_source": "checklist",
  "checklist_id": "email-list-id"
}
```

## Best Practices

### 1. Use Descriptive Names and Tags
```
✅ Good: "SQL Injection - Authentication Bypass"
❌ Bad: "List1"
```

### 2. Separate Positive and Negative Tests
Create separate checklists for valid and invalid inputs.

### 3. Document Checklist Purpose
Always fill in the description field to explain what the checklist is for.

### 4. Keep Lists Focused
Each checklist should test one specific aspect or attack vector.

### 5. Version Control for Security Payloads
Maintain security payload lists separately and update them regularly.

## Common Questions

### Q: Is there a limit on the number of values in a checklist?
A: No hard limit, but we recommend keeping each checklist under 100 values for performance.

### Q: How do I use a checklist in a template?
A: In the API template's variable configuration, set the data source to checklist and specify the checklist ID.

### Q: Can I use the same checklist across multiple templates?
A: Yes, checklists are reusable across all templates and workflows.

### Q: How do I organize many checklists?
A: Use the tags field to categorize checklists (e.g., "security", "validation", "boundary").

### Q: Can checklist values contain special characters?
A: Yes, values are stored as-is, including special characters, newlines, and Unicode.

---

**Next**: Check out [Database Configuration](../configuration/database.md) to learn about data storage options.
