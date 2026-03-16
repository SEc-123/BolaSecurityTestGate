# 环境管理模块

## 模块概述

环境管理模块用于定义和管理测试目标环境，每个环境代表一个独立的测试目标系统。

## 数据模型

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

## 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识符 |
| `name` | string | 环境名称 |
| `base_url` | string | 基础 URL（必填） |
| `description` | string | 环境描述 |
| `is_active` | boolean | 是否启用 |

## 配置示例

### 开发环境
```json
{
  "name": "开发环境",
  "base_url": "http://localhost:3000",
  "description": "本地开发环境",
  "is_active": true
}
```

### 生产环境
```json
{
  "name": "生产环境",
  "base_url": "https://api.example.com",
  "description": "生产环境 API",
  "is_active": true
}
```

## API 接口

### 获取所有环境
```http
GET /api/environments
```

### 创建环境
```http
POST /api/environments
Content-Type: application/json

{
  "name": "测试环境",
  "base_url": "https://test.example.com",
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

## 常见问题

### Q: base_url 应该包含什么？
A: 只需要包含协议和域名，如 `https://api.example.com`，不要包含具体路径。

### Q: 可以创建多个环境吗？
A: 可以，系统支持管理多个环境，用于开发、测试、生产等不同阶段。

---

查看 [账户管理](02-accounts.md) 了解如何配置测试账户。
