# REST API Reference

## Base Information

### Base URL

**Development**: `http://localhost:3001`
**Production**: `https://api.yourdomain.com`

### Content Type
```
Content-Type: application/json
```

### Authentication

Currently, the API does not require authentication. This may change in future versions.

## Environments API

### Get All Environments
```http
GET /api/environments
```

**Response**:
```json
[
  {
    "id": "env-1",
    "name": "Production",
    "base_url": "https://api.example.com",
    "description": "Production environment",
    "is_active": true,
    "created_at": "2026-01-13T00:00:00Z",
    "updated_at": "2026-01-13T00:00:00Z"
  }
]
```

### Create Environment
```http
POST /api/environments
Content-Type: application/json

{
  "name": "Production",
  "base_url": "https://api.example.com",
  "description": "Production environment",
  "is_active": true
}
```

### Update Environment
```http
PUT /api/environments/:id
Content-Type: application/json

{
  "name": "Updated Name",
  "base_url": "https://new-api.example.com"
}
```

### Delete Environment
```http
DELETE /api/environments/:id
```

## Accounts API

### Get All Accounts
```http
GET /api/accounts
```

**Response**:
```json
[
  {
    "id": "acc-1",
    "name": "Test Account",
    "username": "testuser",
    "status": "active",
    "auth_profile": {
      "type": "basic",
      "username": "testuser"
    },
    "created_at": "2026-01-13T00:00:00Z",
    "updated_at": "2026-01-13T00:00:00Z"
  }
]
```

### Create Account
```http
POST /api/accounts
Content-Type: application/json

{
  "name": "Test Account",
  "username": "testuser",
  "status": "active",
  "auth_profile": {
    "type": "basic",
    "username": "testuser",
    "password": "password123"
  }
}
```

### Update Account
```http
PUT /api/accounts/:id
Content-Type: application/json

{
  "name": "Updated Account Name",
  "status": "disabled"
}
```

### Delete Account
```http
DELETE /api/accounts/:id
```

## API Templates API

### Get All Templates
```http
GET /api/templates
```

**Query Parameters**:
- `group_name`: Filter by group name
- `is_active`: Filter by active status (true/false)

### Create Template
```http
POST /api/templates
Content-Type: application/json

{
  "name": "Get Users",
  "group_name": "User Management",
  "raw_request": "GET /api/users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json",
  "failure_logic": "OR",
  "is_active": true
}
```

### Update Template
```http
PUT /api/templates/:id
Content-Type: application/json

{
  "name": "Updated Template Name",
  "is_active": false
}
```

### Delete Template
```http
DELETE /api/templates/:id
```

## Checklists API

### Get All Checklists
```http
GET /api/checklists
```

**Response**:
```json
[
  {
    "id": "checklist-1",
    "name": "Test Data",
    "description": "Test data values",
    "values": ["value1", "value2", "value3"],
    "tags": "test,data",
    "is_active": true,
    "created_at": "2026-01-13T00:00:00Z",
    "updated_at": "2026-01-13T00:00:00Z"
  }
]
```

### Create Checklist
```http
POST /api/checklists
Content-Type: application/json

{
  "name": "Test Data",
  "description": "Sample test data",
  "values": ["value1", "value2", "value3"],
  "tags": "test,sample",
  "is_active": true
}
```

### Update Checklist
```http
PUT /api/checklists/:id
Content-Type: application/json

{
  "values": ["value1", "value2", "value3", "value4"]
}
```

### Delete Checklist
```http
DELETE /api/checklists/:id
```

## Test Execution API

### Run Template Test
```http
POST /api/run/template
Content-Type: application/json

{
  "template_id": "template-123",
  "environment_id": "env-1",
  "account_ids": ["account-1", "account-2"]
}
```

**Response**:
```json
{
  "test_run_id": "run-123",
  "status": "running",
  "started_at": "2026-01-13T10:00:00Z"
}
```

### Run Workflow Test
```http
POST /api/run/workflow
Content-Type: application/json

{
  "workflow_id": "workflow-123",
  "environment_id": "env-1",
  "account_ids": ["account-1"]
}
```

### Get Test Run Status
```http
GET /api/run/:test_run_id/status
```

**Response**:
```json
{
  "test_run_id": "run-123",
  "status": "completed",
  "progress": {
    "total": 100,
    "completed": 100,
    "failed": 5
  },
  "started_at": "2026-01-13T10:00:00Z",
  "completed_at": "2026-01-13T10:05:00Z"
}
```

## Findings API

### Get All Findings
```http
GET /api/findings
```

**Query Parameters**:
- `severity`: Filter by severity (critical, high, medium, low)
- `status`: Filter by status (new, confirmed, false_positive, resolved)
- `limit`: Number of results to return (default: 50)
- `offset`: Offset for pagination (default: 0)

**Response**:
```json
[
  {
    "id": "finding-1",
    "title": "BOLA Vulnerability Detected",
    "severity": "high",
    "status": "new",
    "template_id": "template-123",
    "environment_id": "env-1",
    "evidence": {
      "request": "...",
      "response": "..."
    },
    "created_at": "2026-01-13T10:00:00Z"
  }
]
```

### Get Finding Details
```http
GET /api/findings/:id
```

### Update Finding Status
```http
PATCH /api/findings/:id/status
Content-Type: application/json

{
  "status": "confirmed",
  "notes": "Verified as a real vulnerability"
}
```

### Delete Finding
```http
DELETE /api/findings/:id
```

## Admin API

### Export All Data
```http
GET /admin/export
```

**Response**: JSON containing all data from the current database.

### Import Data
```http
POST /admin/import
Content-Type: application/json

{
  "environments": [...],
  "accounts": [...],
  "templates": [...],
  "checklists": [...]
}
```

### Get Database Profiles
```http
GET /admin/db-profiles
```

### Create Database Profile
```http
POST /admin/db-profiles
Content-Type: application/json

{
  "profile_name": "postgres_prod",
  "provider_type": "postgres",
  "config": {
    "host": "localhost",
    "port": 5432,
    "database": "bola_db",
    "user": "bola_user",
    "password": "your_password"
  }
}
```

### Switch Database
```http
POST /admin/db-profiles/switch
Content-Type: application/json

{
  "profile_name": "postgres_prod"
}
```

## Error Handling

### Error Response Format
```json
{
  "error": "Error message",
  "code": "ERROR_CODE",
  "details": "Additional error details"
}
```

### HTTP Status Codes

| Status Code | Description |
|------------|-------------|
| 200 | Success |
| 201 | Created successfully |
| 400 | Bad request - Invalid parameters |
| 404 | Resource not found |
| 409 | Conflict - Resource already exists |
| 500 | Internal server error |

## Pagination

For endpoints that support pagination (e.g., findings), use these query parameters:

- `limit`: Number of results per page (default: 50, max: 100)
- `offset`: Number of results to skip (default: 0)

**Example**:
```http
GET /api/findings?limit=20&offset=40
```

## Filtering

Many endpoints support filtering via query parameters:

**Example**:
```http
GET /api/findings?severity=high&status=new
```

---

**Next**: Check out [Module Documentation](../modules/01-environments.md) for detailed feature explanations.
