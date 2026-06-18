# Accounts Module

## Module Overview

The Accounts module manages identity credentials and authentication information used in security testing.

## Data Model

```typescript
interface Account {
  id: string;
  name: string;
  username?: string;
  display_name?: string;
  status: string;
  tags?: string[];
  auth_profile?: Record<string, any>;
  variables?: Record<string, any>;
  fields?: Record<string, any>;
  notes?: string;
  created_at: string;
  updated_at: string;
}
```

## Authentication Methods

### Basic Authentication
```json
{
  "name": "Admin Account",
  "username": "admin",
  "status": "active",
  "auth_profile": {
    "type": "basic",
    "username": "admin",
    "password": "password123"
  }
}
```

### Bearer Token
```json
{
  "name": "JWT Token Account",
  "status": "active",
  "auth_profile": {
    "type": "bearer",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### API Key
```json
{
  "name": "API Key Account",
  "status": "active",
  "auth_profile": {
    "type": "api_key",
    "header_name": "X-API-Key",
    "key": "sk_test_abc123..."
  }
}
```

### Custom Header Authentication
```json
{
  "name": "Custom Auth Account",
  "status": "active",
  "auth_profile": {
    "type": "custom_header",
    "headers": {
      "X-Auth-Token": "custom_token_value",
      "X-Client-ID": "client_123"
    }
  }
}
```

## API Endpoints

### Get All Accounts
```http
GET /api/accounts
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
    "password": "testpass123"
  }
}
```

### Update Account
```http
PUT /api/accounts/:id
```

### Delete Account
```http
DELETE /api/accounts/:id
```

## Common Questions

### Q: What authentication methods are supported?
A: Basic Auth, Bearer Token, API Key, and Custom Headers.

### Q: How are passwords stored?
A: Passwords are encrypted in the database and masked when queried through the API.

### Q: Can I use the same account across multiple environments?
A: Yes, accounts are environment-independent and can be used across different environments.

### Q: How do I test BOLA vulnerabilities?
A: Create multiple accounts with different permission levels, then use the "anchor_attacker" account binding strategy in your API templates.

---

**Next**: Learn about [API Templates](03-api-templates.md) to start creating tests.
