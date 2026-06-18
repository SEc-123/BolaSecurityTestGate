# 账户管理模块

## 模块概述

账户管理模块用于管理安全测试中使用的身份凭证和认证信息。

## 数据模型

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

## 认证方式

### Basic Auth
```json
{
  "name": "管理员账户",
  "username": "admin",
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
  "name": "JWT Token 账户",
  "auth_profile": {
    "type": "bearer",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

### API Key
```json
{
  "name": "API Key 账户",
  "auth_profile": {
    "type": "api_key",
    "key": "sk_test_abc123..."
  }
}
```

## API 接口

### 获取所有账户
```http
GET /api/accounts
```

### 创建账户
```http
POST /api/accounts
Content-Type: application/json

{
  "name": "测试账户",
  "username": "testuser",
  "status": "active",
  "auth_profile": {
    "type": "basic",
    "username": "testuser",
    "password": "testpass123"
  }
}
```

### 更新账户
```http
PUT /api/accounts/:id
```

### 删除账户
```http
DELETE /api/accounts/:id
```

## 常见问题

### Q: 支持哪些认证方式？
A: 支持 Basic Auth、Bearer Token、API Key 和自定义 Header。

### Q: 密码如何存储？
A: 密码在数据库中加密存储，通过 API 查询时会被隐藏。

---

查看 [API 模板](03-api-templates.md) 了解如何使用账户创建测试。
