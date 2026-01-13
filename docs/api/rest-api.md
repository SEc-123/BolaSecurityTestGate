# REST API 参考文档

## 基础信息

### Base URL

**开发环境**: `http://localhost:3001`
**生产环境**: `https://api.yourdomain.com`

### Content Type
```
Content-Type: application/json
```

## 环境管理 API

### 获取所有环境
```http
GET /api/environments
```

### 创建环境
```http
POST /api/environments
Content-Type: application/json

{
  "name": "Production",
  "base_url": "https://api.example.com",
  "is_active": true
}
```

### 更新环境
```http
PUT /api/environments/:id
```

### 删除环境
```http
DELETE /api/environments/:id
```

## 账户管理 API

### 获取所有账户
```http
GET /api/accounts
```

### 创建账户
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

### 更新账户
```http
PUT /api/accounts/:id
```

### 删除账户
```http
DELETE /api/accounts/:id
```

## API 模板管理 API

### 获取所有模板
```http
GET /api/templates
```

### 创建模板
```http
POST /api/templates
Content-Type: application/json

{
  "name": "Get Users",
  "raw_request": "GET /api/users HTTP/1.1\nHost: api.example.com",
  "failure_logic": "OR",
  "is_active": true
}
```

### 更新模板
```http
PUT /api/templates/:id
```

### 删除模板
```http
DELETE /api/templates/:id
```

## 检查清单管理 API

### 获取所有检查清单
```http
GET /api/checklists
```

### 创建检查清单
```http
POST /api/checklists
Content-Type: application/json

{
  "name": "Test Data",
  "values": ["value1", "value2", "value3"],
  "is_active": true
}
```

### 更新检查清单
```http
PUT /api/checklists/:id
```

### 删除检查清单
```http
DELETE /api/checklists/:id
```

## 测试运行 API

### 运行模板测试
```http
POST /api/run/template
Content-Type: application/json

{
  "template_id": "template-123",
  "environment_id": "env-1",
  "account_ids": ["account-1", "account-2"]
}
```

### 运行工作流测试
```http
POST /api/run/workflow
Content-Type: application/json

{
  "workflow_id": "workflow-123",
  "environment_id": "env-1",
  "account_ids": ["account-1"]
}
```

### 获取测试运行状态
```http
GET /api/run/:test_run_id/status
```

## 发现管理 API

### 获取所有发现
```http
GET /api/findings
```

查询参数:
- `severity`: 按严重级别筛选
- `status`: 按状态筛选
- `limit`: 返回数量限制
- `offset`: 偏移量

### 获取单个发现
```http
GET /api/findings/:id
```

### 更新发现状态
```http
PATCH /api/findings/:id/status
Content-Type: application/json

{
  "status": "confirmed"
}
```

### 删除发现
```http
DELETE /api/findings/:id
```

## 管理员 API

### 导出所有数据
```http
GET /admin/export
```

### 导入数据
```http
POST /admin/import
Content-Type: application/json

{
  "environments": [...],
  "accounts": [...]
}
```

### 获取数据库配置
```http
GET /admin/db-profiles
```

### 创建数据库配置
```http
POST /admin/db-profiles
Content-Type: application/json

{
  "profile_name": "postgres_prod",
  "provider_type": "postgres",
  "config": {...}
}
```

### 切换数据库
```http
POST /admin/db-profiles/switch
Content-Type: application/json

{
  "profile_name": "postgres_prod"
}
```

## 错误处理

### 错误响应格式
```json
{
  "error": "错误消息",
  "code": "ERROR_CODE"
}
```

### HTTP 状态码

| 状态码 | 说明 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 404 | 资源不存在 |
| 409 | 资源冲突 |
| 500 | 服务器内部错误 |

---

查看 [模块文档](../modules/01-environments.md) 了解详细的功能说明。
