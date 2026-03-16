# API Templates Module

## Module Overview

The API Templates module is used to define reusable API request templates, supporting variable substitution, failure pattern detection, and baseline comparison.

## Data Model

```typescript
interface ApiTemplate {
  id: string;
  name: string;
  group_name?: string;
  description?: string;
  raw_request: string;
  parsed_structure: ParsedRequest;
  variables: VariableConfig[];
  failure_patterns: FailurePattern[];
  failure_logic: 'OR' | 'AND';
  is_active: boolean;
  account_binding_strategy?: 'independent' | 'per_account' | 'anchor_attacker';
  enable_baseline?: boolean;
  rate_limit_override?: number;
}
```

## Creating Templates

### Basic GET Request
```json
{
  "name": "Get User List",
  "raw_request": "GET /api/users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json",
  "failure_logic": "OR",
  "is_active": true
}
```

### POST Request
```json
{
  "name": "Create User",
  "raw_request": "POST /api/users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json\n\n{\"name\":\"John\",\"email\":\"john@example.com\"}",
  "failure_logic": "OR",
  "is_active": true
}
```

### PUT Request
```json
{
  "name": "Update User",
  "raw_request": "PUT /api/users/123 HTTP/1.1\nHost: api.example.com\nContent-Type: application/json\n\n{\"name\":\"Jane\"}",
  "failure_logic": "OR",
  "is_active": true
}
```

### DELETE Request
```json
{
  "name": "Delete User",
  "raw_request": "DELETE /api/users/123 HTTP/1.1\nHost: api.example.com",
  "failure_logic": "OR",
  "is_active": true
}
```

## Variable Configuration

### URL Path Variable
```json
{
  "name": "user_id",
  "json_path": "$.path",
  "operation_type": "replace",
  "original_value": "123",
  "path_replacement_mode": "segment_index",
  "path_segment_index": 2,
  "data_source": "checklist",
  "checklist_id": "user-ids"
}
```

### Body Field Variable
```json
{
  "name": "email",
  "json_path": "$.body.email",
  "operation_type": "replace",
  "original_value": "test@example.com",
  "body_content_type": "json",
  "data_source": "checklist",
  "checklist_id": "email-list"
}
```

### Header Variable
```json
{
  "name": "api_key",
  "json_path": "$.headers['X-API-Key']",
  "operation_type": "replace",
  "original_value": "default_key",
  "data_source": "checklist",
  "checklist_id": "api-keys"
}
```

## Failure Patterns

### HTTP Status Code Detection
```json
{
  "type": "http_status",
  "operator": "not_equals",
  "value": "200"
}
```

### Response Message Detection
```json
{
  "type": "response_message",
  "path": "$.message",
  "operator": "contains",
  "value": "error"
}
```

### Response Time Detection
```json
{
  "type": "response_time",
  "operator": "greater_than",
  "value": "5000"
}
```

## Account Binding Strategies

### Independent Mode
Each account executes tests independently without comparison.

**Use Case**: Basic functional testing where account interactions don't matter.

### Per Account Mode
Execute template once per account, collecting separate results for each.

**Use Case**: Testing different user roles or permissions.

### Anchor Attacker Mode
Used for BOLA vulnerability detection. Compares responses between different accounts to detect authorization bypass.

**Use Case**: Authorization and access control testing.

**How it works**:
1. Execute request with anchor account (legitimate user)
2. Execute same request with attacker account (unauthorized user)
3. Compare responses to detect if attacker can access anchor's data

## API Endpoints

### Get All Templates
```http
GET /api/templates
```

### Create Template
```http
POST /api/templates
Content-Type: application/json

{
  "name": "Get User Profile",
  "raw_request": "GET /api/users/me HTTP/1.1\nHost: api.example.com",
  "failure_logic": "OR",
  "is_active": true
}
```

### Update Template
```http
PUT /api/templates/:id
```

### Delete Template
```http
DELETE /api/templates/:id
```

### Run Template
```http
POST /api/run/template
Content-Type: application/json

{
  "template_id": "template-123",
  "environment_id": "env-1",
  "account_ids": ["account-1", "account-2"]
}
```

## Best Practices

### 1. Use Descriptive Names
```
✅ Good: "Get User Profile - BOLA Test"
❌ Bad: "Test1"
```

### 2. Group Related Templates
Use the `group_name` field to organize templates by feature or API domain.

### 3. Document Failure Patterns
Use OR logic for "any failure condition" and AND logic for "all conditions must fail".

### 4. Test Variable Substitution
Always test your variable configurations with a small dataset first.

### 5. Enable Baseline for Consistency Checks
Enable baseline comparison to detect unexpected API changes.

## Common Questions

### Q: How do I configure variable substitution?
A: Add variable configurations to the template, specifying JSON Path and data source (checklist, variable pool, or literal value).

### Q: What's the difference between OR and AND in failure_logic?
A: OR means any condition triggers a failure. AND means all conditions must be met to trigger a failure.

### Q: How do I test BOLA vulnerabilities?
A: Use the "anchor_attacker" account binding strategy with at least two accounts having different permission levels.

### Q: Can I use regular expressions in failure patterns?
A: Yes, use the "matches" operator with regex patterns in response_message failure patterns.

### Q: What happens if a template has no failure patterns?
A: The test will always pass unless there's a network error or timeout.

---

**Next**: Check out [Checklists](04-checklists.md) to learn how to manage test data.
