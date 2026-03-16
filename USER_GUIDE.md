# API Security Testing Platform - User Guide

## Table of Contents

1. [Introduction](#introduction)
2. [Getting Started](#getting-started)
3. [Core Concepts](#core-concepts)
4. [Features & Configuration](#features--configuration)
   - [Environments](#environments)
   - [Accounts](#accounts)
   - [API Templates](#api-templates)
   - [Workflows](#workflows)
   - [Checklists](#checklists)
   - [Security Rules](#security-rules)
   - [Security Suites](#security-suites)
   - [Test Runs](#test-runs)
   - [Variable Pool Manager](#variable-pool-manager)
   - [Template Variable Manager](#template-variable-manager)
   - [Dictionary Manager](#dictionary-manager)
   - [Suppression Rules](#suppression-rules)
   - [Findings](#findings)
   - [Findings Governance](#findings-governance)
   - [CI/CD Gate Policies](#cicd-gate-policies)
   - [AI Analysis](#ai-analysis)
   - [Debug Panel](#debug-panel)
5. [CLI Tool](#cli-tool)
6. [Best Practices](#best-practices)

---

## Introduction

This platform is a comprehensive API security testing solution designed for automated security testing, vulnerability detection, and compliance verification. It combines traditional security testing with AI-powered analysis to provide deep insights into API security posture.

### Key Capabilities

- **API Template Management**: Define and manage reusable API request templates
- **Workflow Orchestration**: Chain multiple API calls with data extraction and context passing
- **Security Testing**: Execute security payloads (XSS, SQLi, IDOR, etc.) against APIs
- **AI-Powered Analysis**: Leverage LLMs to detect security vulnerabilities beyond pattern matching
- **Variable Management**: Dynamic variable binding from accounts, checklists, or security rules
- **Findings Management**: Centralized vulnerability tracking with suppression rules
- **CI/CD Integration**: Gate policies to fail builds based on security findings
- **Debug Tracing**: Full request/response capture for debugging and manual testing

---

## Getting Started

### Installation

```bash
# Install dependencies
npm install
cd server && npm install
cd ../cli/sec-runner && npm install

# Start the platform
npm run dev  # Frontend (port 5173)
cd server && npm start  # Backend (port 3000)
```

### Initial Configuration

1. **Configure Database**: The platform uses SQLite by default. For production, configure PostgreSQL in `server/.env`:
   ```
   DATABASE_TYPE=postgres
   DATABASE_URL=postgresql://user:password@localhost:5432/dbname
   ```

2. **Set Up AI Providers** (Optional): Navigate to **AI Providers** page to configure OpenAI/DeepSeek/Qwen for intelligent analysis.

3. **Create Environments**: Define base URLs for different environments (dev, staging, prod).

---

## Core Concepts

### API Template
A reusable HTTP request definition including:
- Method (GET, POST, PUT, DELETE, etc.)
- URL path
- Headers
- Body
- Variables (dynamic values that can be replaced at runtime)

### Workflow
A sequence of API template executions with:
- Variable configurations (how to populate template variables)
- Response extractors (capture values from responses for use in subsequent steps)
- Step assertions (validate response status, content, timing)

### Security Rule
A collection of malicious payloads designed to test for specific vulnerability types:
- XSS payloads
- SQL injection patterns
- Command injection strings
- IDOR test values

### Security Suite
A bundle of security rules that are executed together against API templates/workflows.

### Finding
A detected security issue including:
- Severity (critical, high, medium, low, info)
- Evidence (request, response, AI analysis)
- Status (open, false_positive, suppressed, verified)

---

## Features & Configuration

### Environments

**Purpose**: Define base URLs for different deployment environments.

**Configuration Example**:

```json
{
  "name": "Production",
  "base_url": "https://api.example.com",
  "description": "Production API environment"
}
```

**Usage**:
1. Navigate to **Environments** page
2. Click **Create Environment**
3. Enter name, base URL, and optional description
4. Use this environment when running workflows/test runs

---

### Accounts

**Purpose**: Store test user credentials and data for authentication scenarios.

**Configuration Example**:

```json
{
  "name": "Admin User",
  "fields": {
    "email": "admin@example.com",
    "password": "P@ssw0rd123",
    "userId": "12345",
    "apiKey": "sk-abc123xyz",
    "role": "admin"
  },
  "description": "Administrator account for privileged operations"
}
```

**Usage**:
1. Navigate to **Accounts** page
2. Click **Create Account**
3. Add key-value pairs for credentials/user data
4. Reference account fields in **Template Variable Manager** by setting:
   - Data Source: `Account Field`
   - Field Name: `email`, `password`, etc.

**Best Practices**:
- Store one account per user role (admin, user, guest)
- Include all necessary authentication data (tokens, cookies, API keys)
- Use descriptive names for easy identification

---

### API Templates

**Purpose**: Define reusable HTTP requests with variables for dynamic value replacement.

**Configuration Example**:

#### Basic GET Request
```http
GET /api/users/{{userId}} HTTP/1.1
Host: api.example.com
Authorization: Bearer {{apiToken}}
Content-Type: application/json
```

#### POST Request with JSON Body
```http
POST /api/users HTTP/1.1
Host: api.example.com
Content-Type: application/json

{
  "email": "{{email}}",
  "password": "{{password}}",
  "role": "{{role}}"
}
```

**Creating a Template**:
1. Navigate to **API Templates** page
2. Click **Create Template**
3. Enter name, group name (for organization)
4. **Option A - Paste Raw HTTP Request**:
   ```
   POST /api/login HTTP/1.1
   Host: api.example.com
   Content-Type: application/json

   {"username": "test", "password": "test123"}
   ```
   Click **Parse Request** to extract variables automatically

5. **Option B - Build Manually**:
   - Select Method
   - Enter Path: `/api/login`
   - Add Headers: `Content-Type: application/json`
   - Enter Body: `{"username": "{{username}}", "password": "{{password}}"}`
   - System auto-detects variables in `{{}}` format

**Variable Types**:
- **Body Variables**: JSON path-based (`content.user.id`)
- **Header Variables**: Header name-based (`Authorization`)
- **Query Variables**: Query parameter name-based (`?userId={{id}}`)
- **Path Variables**: URL path segment-based (`/users/{{id}}/profile`)

**Failure Patterns**: Define expected error indicators
```json
{
  "status_codes": [400, 401, 403, 500],
  "body_patterns": ["error", "exception", "denied"],
  "exclude_patterns": ["errorCode: 0"]
}
```

---

### Workflows

**Purpose**: Chain multiple API calls with context passing and assertions.

**Configuration Example**:

#### Workflow: User Registration → Login → Get Profile

**Steps**:
1. **Register User** (POST /api/register)
2. **Login** (POST /api/login) - Extract token from response
3. **Get Profile** (GET /api/profile) - Use token from step 2

**Step Configuration**:

##### Step 1: Register
- **Template**: `POST /api/register`
- **Variable Config**:
  ```json
  {
    "variable_name": "email",
    "data_source": "checklist",
    "checklist_id": "<email_checklist_id>"
  }
  ```
- **Extractor** (captures userId from response):
  ```json
  {
    "step_order": 1,
    "source": "body",
    "jsonpath": "$.data.userId",
    "target_variable": "userId",
    "is_required": true
  }
  ```

##### Step 2: Login
- **Template**: `POST /api/login`
- **Variable Config**:
  ```json
  {
    "variable_name": "email",
    "data_source": "workflow_context",
    "context_variable": "email"
  }
  ```
- **Extractor** (captures access token):
  ```json
  {
    "step_order": 2,
    "source": "body",
    "jsonpath": "$.token",
    "target_variable": "accessToken",
    "is_required": true
  }
  ```

##### Step 3: Get Profile
- **Template**: `GET /api/users/{{userId}}/profile`
- **Variable Config**:
  ```json
  [
    {
      "variable_name": "userId",
      "data_source": "workflow_context",
      "context_variable": "userId"
    },
    {
      "variable_name": "Authorization",
      "data_source": "workflow_context",
      "context_variable": "accessToken",
      "value_prefix": "Bearer "
    }
  ]
  ```

**Step Assertions**:
```json
{
  "step_order": 3,
  "assertions": [
    {
      "type": "status_code",
      "expected": 200
    },
    {
      "type": "body_jsonpath",
      "jsonpath": "$.data.email",
      "operator": "exists"
    },
    {
      "type": "response_time_ms",
      "operator": "less_than",
      "expected": 500
    }
  ],
  "assertions_mode": "all_must_pass"
}
```

**Mutation Profiles** (Advanced):

##### Concurrent Replay (Race Condition Testing)
```json
{
  "concurrent_replay": {
    "step_order": 2,
    "concurrency": 10,
    "timeout_ms": 5000,
    "pick_primary": "first_success"
  }
}
```

##### Parallel Groups (Branch Testing)
```json
{
  "parallel_groups": [
    {
      "anchor_step_order": 2,
      "extras": [
        {
          "name": "Alternative Login - OAuth",
          "request_snapshot_raw": "POST /oauth/token HTTP/1.1\n..."
        },
        {
          "name": "Alternative Login - SSO",
          "request_snapshot_raw": "POST /sso/authenticate HTTP/1.1\n..."
        }
      ],
      "timeout_ms": 3000
    }
  ]
}
```

---

### Checklists

**Purpose**: Store lists of test values for parameterized testing.

**Configuration Example**:

#### Email Checklist
```json
{
  "name": "Valid Emails",
  "description": "List of valid email addresses for testing",
  "config": {
    "strategy": "sequential",
    "values": [
      "user1@example.com",
      "user2@example.com",
      "admin@example.com",
      "test@domain.org"
    ]
  }
}
```

**Strategies**:
- **sequential**: Use values in order
- **random**: Pick random value each time
- **exhaustive**: Try all values in test runs

**Use Cases**:
- Valid input testing (emails, phone numbers, usernames)
- Boundary value testing (min/max values)
- Locale testing (different languages, timezones)
- Role-based testing (different user roles)

**Usage**:
1. Create checklist with test values
2. In **Template Variable Manager**, select variable
3. Set **Data Source** → `Checklist`
4. Choose checklist from dropdown

---

### Security Rules

**Purpose**: Define malicious payloads for vulnerability testing.

**Configuration Example**:

#### XSS Security Rule
```json
{
  "name": "XSS - Basic Vectors",
  "description": "Common XSS payloads for input validation testing",
  "rule_type": "xss",
  "payloads": [
    "<script>alert('XSS')</script>",
    "<img src=x onerror=alert('XSS')>",
    "javascript:alert('XSS')",
    "<svg onload=alert('XSS')>",
    "'\"><script>alert(String.fromCharCode(88,83,83))</script>"
  ],
  "context_hints": ["user_input", "comment", "search_query"]
}
```

#### SQL Injection Security Rule
```json
{
  "name": "SQLi - Authentication Bypass",
  "description": "SQL injection payloads for authentication bypass",
  "rule_type": "sqli",
  "payloads": [
    "' OR '1'='1",
    "admin' --",
    "' OR '1'='1' /*",
    "1' UNION SELECT NULL, NULL, NULL --",
    "' AND 1=2 UNION SELECT NULL, username, password FROM users --"
  ],
  "context_hints": ["username", "password", "search"]
}
```

#### IDOR Security Rule
```json
{
  "name": "IDOR - Numeric IDs",
  "description": "Test for insecure direct object references",
  "rule_type": "idor",
  "payloads": [
    "1",
    "2",
    "999999",
    "-1",
    "0"
  ],
  "context_hints": ["userId", "orderId", "documentId"]
}
```

**Rule Types**:
- `xss`: Cross-Site Scripting
- `sqli`: SQL Injection
- `cmd_injection`: Command Injection
- `xxe`: XML External Entity
- `idor`: Insecure Direct Object Reference
- `path_traversal`: Directory Traversal
- `ssrf`: Server-Side Request Forgery
- `custom`: Custom test payloads

**Usage**:
1. Create security rule with payloads
2. Add to **Security Suite**
3. Execute suite against templates/workflows
4. Review findings in **Findings** page

---

### Security Suites

**Purpose**: Bundle multiple security rules for comprehensive testing.

**Configuration Example**:

```json
{
  "name": "OWASP Top 10 Suite",
  "description": "Comprehensive security testing for web APIs",
  "rule_ids": [
    "<xss_rule_id>",
    "<sqli_rule_id>",
    "<idor_rule_id>",
    "<xxe_rule_id>",
    "<cmd_injection_rule_id>"
  ],
  "is_default": true
}
```

**Usage**:
1. Navigate to **Security Suites** page
2. Click **Create Suite**
3. Select security rules to include
4. Mark as default (optional) for automatic inclusion in test runs
5. Execute against workflows via **Test Runs** page

---

### Test Runs

**Purpose**: Execute workflows or templates with security testing and capture results.

**Configuration Example**:

#### Test Run Configuration
```json
{
  "test_type": "workflow",
  "workflow_id": "<workflow_id>",
  "environment_id": "<environment_id>",
  "security_suite_ids": ["<suite_id_1>", "<suite_id_2>"],
  "settings": {
    "max_retries": 2,
    "timeout_ms": 30000,
    "follow_redirects": true,
    "verify_ssl": true
  }
}
```

**Test Types**:
- **workflow**: Execute full workflow with context passing
- **template**: Execute single API template
- **security_scan**: Run security suite against template

**Execution Flow**:
1. Navigate to **Test Runs** page
2. Click **Create Test Run**
3. Select:
   - Test Type
   - Workflow/Template
   - Environment
   - Security Suites (optional)
4. Click **Run**
5. View results:
   - Execution status
   - Step-by-step results
   - Extracted variables
   - Assertion results
   - Security findings

**Baseline Mode**:
- Capture "good" responses as baseline
- Future runs compare against baseline
- Detect unexpected changes (new fields, different values)
- Alert on deviations

---

### Variable Pool Manager

**Purpose**: Define global variables accessible across all workflows.

**Configuration Example**:

```json
{
  "name": "API_VERSION",
  "value": "v2",
  "description": "Current API version",
  "scope": "global"
}
```

**Usage**:
1. Navigate to **Variable Pool Manager** page
2. Click **Add Variable**
3. Enter name, value, description
4. Reference in templates: `{{$global.API_VERSION}}`

**Variable Types**:
- **Static**: Fixed values (API version, tenant ID)
- **Dynamic**: Computed at runtime (timestamps, UUIDs)
- **Environment-Specific**: Different values per environment

**Best Practices**:
- Use for constants (API keys, base paths, version numbers)
- Avoid storing sensitive data (use Accounts instead)
- Document variable purpose in description field

---

### Template Variable Manager

**Purpose**: Bulk configure variable bindings across multiple API templates.

**Features**:
- **Search**: Find variables by JSONPath, keyword, header name, or query param
- **Bulk Update**: Apply configuration to multiple variables at once
- **Value Mode**: Change default values
- **Source/Rule Mode**: Change data source and security rules

**Configuration Example**:

#### Search for Variables
1. Navigate to **Template Variable Manager**
2. **Search Options**:
   - **Type**: Keyword / JSONPath / Header Key / Query Param
   - **Pattern**: `email` or `content.user.email`
   - **Match Mode**: Exact / Contains
   - **Scopes**: Body / Header / Query / Path
3. Click **Search**

#### Bulk Update - Value Mode
**Use Case**: Change all `userId` variables to use a specific test value

1. Search for: `userId` (keyword)
2. Select matching variables (checkbox)
3. Switch to **Value Mode**
4. Enter **Default Value**: `12345`
5. Click **Preview Changes**
6. Review diff (shows before/after, raw_request sync status)
7. Click **Apply Changes**

**Result**:
- `variable.original_value` = `12345`
- `template.raw_request` JSON body updated (if applicable)
- `template.parsed_structure` regenerated

#### Bulk Update - Source/Rule Mode
**Use Case**: Configure all email variables to pull from account

1. Search for: `email` (keyword)
2. Select matching variables
3. Switch to **Source/Rule Mode**
4. Set:
   - **Data Source**: `Account Field`
   - **Account Field Name**: `email`
   - **Operation Type**: `Replace`
5. Click **Preview Changes**
6. Click **Apply Changes**

**Data Sources**:
- **Original**: Use variable's default value
- **Account Field**: Pull from account (e.g., `email`, `password`)
- **Checklist**: Use values from checklist
- **Security Rule**: Replace with security payloads
- **Workflow Context**: Use extracted value from previous step

---

### Dictionary Manager

**Purpose**: Manage field-level configuration for baseline normalization and comparison.

**Configuration Example**:

```json
{
  "field_path": "content.user.lastLoginAt",
  "field_type": "timestamp",
  "should_drop": false,
  "normalization_config": {
    "strategy": "ignore_value",
    "reason": "Timestamp changes on every login"
  }
}
```

**Field Types**:
- **timestamp**: ISO dates, Unix timestamps
- **uuid**: UUIDs, GUIDs
- **random**: Nonces, session IDs
- **incremental**: Auto-increment IDs, counters
- **computed**: Calculated values (checksums, hashes)

**Normalization Strategies**:
- **ignore_value**: Always treat as matching (for dynamic fields)
- **sort_array**: Sort arrays before comparison
- **round_number**: Round floats to N decimals
- **strip_whitespace**: Remove leading/trailing spaces

**Use Cases**:
- Ignore dynamic timestamps in baseline comparison
- Normalize array order for consistent comparison
- Drop irrelevant fields from baseline
- Handle computed fields (hashes, signatures)

---

### Suppression Rules

**Purpose**: Filter out false positives and expected findings.

**Configuration Example**:

#### Suppress False Positive XSS
```json
{
  "name": "Suppress Sanitized XSS",
  "rule_type": "response_pattern",
  "config": {
    "response_body_contains": "&lt;script&gt;",
    "severity": "high",
    "vulnerability_type": "xss"
  },
  "reason": "XSS payload is properly HTML-encoded in response",
  "is_enabled": true
}
```

#### Suppress Expected 404
```json
{
  "name": "Suppress IDOR 404",
  "rule_type": "status_code",
  "config": {
    "status_code": 404,
    "severity": "medium",
    "vulnerability_type": "idor"
  },
  "reason": "404 indicates proper access control (resource not found for unauthorized user)",
  "is_enabled": true
}
```

**Rule Types**:
- **response_pattern**: Match response body content
- **status_code**: Match HTTP status code
- **template_id**: Suppress findings from specific template
- **workflow_id**: Suppress findings from specific workflow
- **severity**: Suppress all findings of given severity

**Best Practices**:
- Document suppression reason clearly
- Review suppressed findings periodically
- Use specific rules (avoid broad suppressions)
- Disable rule instead of deleting (for audit trail)

---

### Findings

**Purpose**: View and manage detected security vulnerabilities.

**Columns**:
- **Severity**: Critical / High / Medium / Low / Info
- **Type**: XSS / SQLi / IDOR / etc.
- **Status**: Open / False Positive / Suppressed / Verified
- **Source**: Template/Workflow name
- **Evidence**: Request/Response snippets
- **AI Analysis**: LLM-generated explanation

**Actions**:
- **View Details**: See full request/response, AI analysis
- **Mark as False Positive**: Add to suppression rules
- **Verify**: Confirm as true positive
- **Export**: Download findings as JSON/CSV

**Filtering**:
- By severity
- By vulnerability type
- By status
- By source (template/workflow)
- By date range

---

### Findings Governance

**Purpose**: Configure retention policies and rate limiting for findings.

**Configuration Example**:

```json
{
  "retention_days": 90,
  "cleanup_interval_hours": 24,
  "rate_limit_per_template_per_hour": 100,
  "auto_suppress_duplicates": true,
  "duplicate_window_hours": 24
}
```

**Settings**:
- **Retention Days**: Auto-delete findings older than N days
- **Cleanup Interval**: How often to run cleanup job
- **Rate Limit**: Max findings per template per hour (prevents flooding)
- **Auto-Suppress Duplicates**: Suppress identical findings within time window

**Cleanup Rules**:
- Delete findings older than retention period
- Keep verified findings permanently (unless manually deleted)
- Archive suppressed findings after 180 days

---

### CI/CD Gate Policies

**Purpose**: Fail CI/CD builds based on security findings.

**Configuration Example**:

```json
{
  "name": "Block Critical Vulnerabilities",
  "description": "Fail build if critical or high severity findings detected",
  "is_enabled": true,
  "conditions": {
    "fail_on_severity": ["critical", "high"],
    "fail_on_types": ["sqli", "rce", "xxe"],
    "min_findings_count": 1
  },
  "apply_to": {
    "workflow_ids": ["<workflow_id_1>", "<workflow_id_2>"],
    "template_ids": []
  }
}
```

**Condition Types**:
- **fail_on_severity**: Fail if findings match severity
- **fail_on_types**: Fail if findings match vulnerability types
- **min_findings_count**: Minimum findings to trigger failure
- **exclude_false_positives**: Ignore findings marked as false positive

**Integration**:
```bash
# In CI/CD pipeline
sec-runner scan --workflow-id <id> --environment dev --gate-policy <policy_id>
exit_code=$?

if [ $exit_code -ne 0 ]; then
  echo "Security gate failed! Build aborted."
  exit 1
fi
```

---

### AI Analysis

**Purpose**: Leverage LLMs to analyze responses for security vulnerabilities.

**Configuration**:

#### AI Provider Setup
1. Navigate to **AI Providers** page
2. Click **Add Provider**
3. Enter:
   - **Name**: OpenAI GPT-4
   - **Provider Type**: OpenAI / DeepSeek / Qwen / OpenAI Compatible
   - **Base URL**: (for compatible providers)
   - **API Key**: Your API key
   - **Model**: `gpt-4o` / `deepseek-chat` / etc.
   - **Is Default**: Toggle on for primary provider
4. Click **Save**

#### Enable AI Analysis in Test Runs
```json
{
  "ai_analysis_enabled": true,
  "ai_analysis_config": {
    "verdict_version": "v2",
    "analyze_all_responses": false,
    "analyze_only_suspicious": true
  }
}
```

**Verdict Versions**:
- **v1**: Simple binary verdict (vulnerable / safe)
- **v2**: Detailed analysis with confidence score, reasoning, and suggested payloads

**Analysis Modes**:
- **All Responses**: Analyze every response (expensive, thorough)
- **Suspicious Only**: Analyze only responses with anomalies (cost-effective)
- **Failed Requests Only**: Analyze errors and unexpected status codes

**AI Report Review**:
1. Navigate to **AI Reports** page
2. View analysis results:
   - Verdict (Vulnerable / Uncertain / Not Vulnerable)
   - Confidence (0-100)
   - Reasoning (LLM explanation)
   - Evidence (Request/Response snippets)
3. Export reports for documentation

---

### Debug Panel

**Purpose**: View complete request/response history for troubleshooting.

**Features**:
- **Live Trace Capture**: Automatically captures last workflow/test run
- **Full Request/Response**: See headers, body, timing
- **Export Formats**:
  - **JSON**: Structured data for analysis
  - **TXT**: Human-readable format
  - **Raw HTTP**: Copy-paste directly into Burp Suite Repeater

**Usage**:

#### View Debug Trace
1. Navigate to **Debug Panel**
2. Select **Trace Type**: Workflow / Template
3. Click **Refresh** to load latest trace
4. Expand request to see details:
   - Method, URL, Headers
   - Request Body
   - Response Status, Headers, Body
   - Duration, Retry Attempts

#### Export for Burp Suite
1. Click **Export Raw HTTP**
2. Open downloaded `.txt` file
3. Copy request block (starts with `POST /api/... HTTP/1.1`)
4. Paste into Burp Suite Repeater
5. Click **Send** to replay request

**Example Raw HTTP Output**:
```
# Request #1
# Step: 1
# Template: User Login
# Timestamp: 2024-01-15T10:30:00Z
# Duration: 245ms

POST /api/login HTTP/1.1
Host: api.example.com
Content-Type: application/json
User-Agent: SecurityTestPlatform/1.0

{"username":"test@example.com","password":"Test123!"}

================================================================================

# Request #2
# Step: 2
# Template: Get User Profile
# Timestamp: 2024-01-15T10:30:01Z
# Duration: 123ms

GET /api/users/12345/profile HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGc...
Content-Type: application/json
```

---

## CLI Tool

The `sec-runner` CLI tool enables headless execution for CI/CD integration.

### Installation

```bash
cd cli/sec-runner
npm install
npm link  # Makes 'sec-runner' command globally available
```

### Commands

#### Run Workflow
```bash
sec-runner scan \
  --workflow-id <workflow_id> \
  --environment dev \
  --security-suite <suite_id> \
  --output results.json
```

#### Run Template (Single API)
```bash
sec-runner scan-template \
  --template-id <template_id> \
  --environment prod \
  --output results.json
```

#### Check Gate Policy
```bash
sec-runner check-gate \
  --workflow-id <workflow_id> \
  --policy-id <policy_id> \
  --environment prod

# Exit codes:
# 0 = Passed gate policy
# 1 = Failed gate policy (findings detected)
# 2 = Error during execution
```

### CI/CD Integration Examples

#### GitHub Actions
```yaml
name: API Security Scan

on: [push, pull_request]

jobs:
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2

      - name: Run Security Scan
        run: |
          npx sec-runner scan \
            --workflow-id ${{ secrets.WORKFLOW_ID }} \
            --environment staging \
            --security-suite ${{ secrets.SECURITY_SUITE_ID }} \
            --output scan-results.json

      - name: Check Gate Policy
        run: |
          npx sec-runner check-gate \
            --workflow-id ${{ secrets.WORKFLOW_ID }} \
            --policy-id ${{ secrets.GATE_POLICY_ID }} \
            --environment staging

      - name: Upload Results
        uses: actions/upload-artifact@v2
        if: always()
        with:
          name: security-scan-results
          path: scan-results.json
```

#### GitLab CI
```yaml
security-scan:
  stage: test
  script:
    - npm install -g sec-runner
    - sec-runner scan --workflow-id $WORKFLOW_ID --environment $CI_ENVIRONMENT_NAME --output results.json
    - sec-runner check-gate --workflow-id $WORKFLOW_ID --policy-id $GATE_POLICY_ID --environment $CI_ENVIRONMENT_NAME
  artifacts:
    paths:
      - results.json
    when: always
```

---

## Best Practices

### 1. Template Organization
- Use descriptive names: `POST /api/users - Create User`
- Group related templates: `User Management`, `Authentication`, `Orders`
- Document expected behavior in description field
- Keep templates focused (one endpoint per template)

### 2. Workflow Design
- Keep workflows under 10 steps for maintainability
- Use extractors for all dynamic values (tokens, IDs)
- Add assertions at critical steps
- Handle errors gracefully (don't assume success)

### 3. Variable Management
- Use consistent naming conventions (`userId` not `user_id` or `UserID`)
- Document variable purpose in Template Variable Manager
- Prefer account fields over hardcoded credentials
- Use workflow context for dynamic values

### 4. Security Testing
- Start with default security suite to establish baseline
- Create custom rules for application-specific vulnerabilities
- Review and tune suppression rules regularly
- Enable AI analysis for complex scenarios

### 5. Findings Management
- Triage findings within 24 hours of detection
- Mark false positives immediately (with reason)
- Verify critical/high findings manually
- Track remediation in external ticket system

### 6. AI Usage
- Use AI for ambiguous cases (not for clear-cut vulnerabilities)
- Review AI reasoning before accepting verdict
- Tune prompts based on false positive rate
- Monitor AI provider costs

### 7. Debug & Troubleshooting
- Enable debug tracing during development
- Export raw HTTP for manual verification
- Check extractor JSONPaths if context passing fails
- Review step assertions for unexpected failures

### 8. CI/CD Integration
- Start with warning-only gate policies
- Gradually enable blocking for critical vulnerabilities
- Run security scans on every merge to main/master
- Archive scan results as build artifacts

### 9. Performance
- Limit concurrent replay to 10-20 requests (avoid overwhelming servers)
- Set reasonable timeouts (30s for complex workflows)
- Use baseline mode sparingly (captures large responses)
- Clean up old findings regularly (retention policies)

### 10. Compliance
- Document security rules based on compliance requirements (PCI-DSS, HIPAA, etc.)
- Export findings for audit reports
- Retain verified findings permanently
- Map findings to CWE/OWASP categories

---

## Troubleshooting

### Common Issues

#### Issue: Variables not replacing in requests
**Solution**:
1. Check variable name matches exactly (case-sensitive)
2. Verify data source is configured (Account Field / Checklist / etc.)
3. Ensure workflow context variable was extracted in previous step
4. Review debug trace to see actual request sent

#### Issue: Workflow step failing with "Extractor failed"
**Solution**:
1. Check JSONPath syntax: `$.data.userId` (not `data.userId`)
2. Verify response structure matches expected path
3. Set `is_required: false` if value may be missing
4. Use debug panel to inspect actual response

#### Issue: AI analysis not running
**Solution**:
1. Verify AI provider is enabled and set as default
2. Check API key is valid and has credits
3. Ensure `ai_analysis_enabled: true` in test run config
4. Review error logs in AI Reports page

#### Issue: Findings not being created
**Solution**:
1. Check suppression rules (may be auto-suppressing)
2. Verify security suite is assigned to test run
3. Ensure rate limit not exceeded
4. Review failure patterns on API template (may be marking as expected)

---

## Support & Contribution

For issues, feature requests, or contributions, please refer to the project repository.

**Documentation Version**: 1.0
**Last Updated**: 2024-01-15
