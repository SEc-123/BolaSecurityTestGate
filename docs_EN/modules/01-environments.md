# Environments Module

## Module Overview

The Environments module is used to define and manage test target environments. Each environment represents an independent test target system.

## Data Model

```typescript
interface Environment {
  id: string;
  name: string;
  base_url: string;
  description?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
```

## Field Descriptions

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier |
| `name` | string | Environment name |
| `base_url` | string | Base URL (required) |
| `description` | string | Environment description |
| `is_active` | boolean | Whether the environment is active |

## Configuration Examples

### Development Environment
```json
{
  "name": "Development",
  "base_url": "http://localhost:3000",
  "description": "Local development environment",
  "is_active": true
}
```

### Staging Environment
```json
{
  "name": "Staging",
  "base_url": "https://staging.example.com",
  "description": "Staging environment for integration testing",
  "is_active": true
}
```

### Production Environment
```json
{
  "name": "Production",
  "base_url": "https://api.example.com",
  "description": "Production API environment",
  "is_active": true
}
```

### Testing Environment with Custom Port
```json
{
  "name": "Test Environment",
  "base_url": "http://test-server:8080",
  "description": "Automated testing environment",
  "is_active": true
}
```

### Internal API Environment
```json
{
  "name": "Internal API",
  "base_url": "https://internal-api.company.local",
  "description": "Internal corporate API",
  "is_active": true
}
```

## API Endpoints

### Get All Environments
```http
GET /api/environments
```

**Response:**
```json
[
  {
    "id": "env-1",
    "name": "Development",
    "base_url": "http://localhost:3000",
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
  "name": "Test Environment",
  "base_url": "https://test.example.com",
  "is_active": true
}
```

### Update Environment
```http
PUT /api/environments/:id
Content-Type: application/json

{
  "name": "Updated Name",
  "base_url": "https://new-url.example.com",
  "is_active": true
}
```

### Delete Environment
```http
DELETE /api/environments/:id
```

## Usage in Tests

When running tests, you select an environment which provides:

- **Base URL**: All API template URLs are prefixed with this base URL
- **Environment Context**: Templates can access environment-specific configurations
- **Isolation**: Different environments can be tested independently

## Best Practices

### 1. Use Descriptive Names
```
✅ Good: "Production API v2"
❌ Bad: "Env1"
```

### 2. Include Protocol in Base URL
```
✅ Good: "https://api.example.com"
❌ Bad: "api.example.com"
```

### 3. Don't Include Paths in Base URL
```
✅ Good: "https://api.example.com"
❌ Bad: "https://api.example.com/v1/users"
```

### 4. Use is_active for Temporary Disabling
Set `is_active: false` to temporarily disable an environment without deleting it.

### 5. Document Environment Purpose
Use the description field to clearly document what the environment is used for.

## Common Questions

### Q: What should the base_url include?
A: Only include the protocol and domain, such as `https://api.example.com`. Do not include specific paths.

### Q: Can I create multiple environments?
A: Yes, the system supports managing multiple environments for development, testing, production, and other stages.

### Q: How does base_url affect API requests?
A: When executing an API template, the environment's base_url is prepended to the template's request path.

### Q: Can I use environment variables in base_url?
A: Not directly. The base_url must be a complete URL. However, you can create multiple environment entries for different configurations.

### Q: What happens if I delete an environment?
A: Deleting an environment doesn't affect historical test runs, but you won't be able to run new tests against that environment.

---

**Next**: Check out [Account Management](02-accounts.md) to learn how to configure test accounts.
