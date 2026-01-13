# API 模板模块

## 模块概述

API 模板模块用于定义可重用的 API 请求模板，支持变量替换、失败模式检测和基线对比。

## 数据模型

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

## 创建模板

### 基本 GET 请求
```json
{
  "name": "获取用户列表",
  "raw_request": "GET /api/users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json",
  "failure_logic": "OR",
  "is_active": true
}
```

### POST 请求
```json
{
  "name": "创建用户",
  "raw_request": "POST /api/users HTTP/1.1\nHost: api.example.com\nContent-Type: application/json\n\n{\"name\":\"John\",\"email\":\"john@example.com\"}",
  "failure_logic": "OR",
  "is_active": true
}
```

## 变量配置

### URL 路径变量
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

### Body 字段变量
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

## 失败模式

### HTTP 状态码检测
```json
{
  "type": "http_status",
  "operator": "not_equals",
  "value": "200"
}
```

### 响应消息检测
```json
{
  "type": "response_message",
  "path": "$.message",
  "operator": "contains",
  "value": "error"
}
```

## 账户绑定策略

### Independent（独立模式）
每个账户独立执行测试

### Anchor Attacker（锚定攻击者）
用于 BOLA 漏洞检测，对比不同账户的响应

## API 接口

### 获取所有模板
```http
GET /api/templates
```

### 创建模板
```http
POST /api/templates
```

### 运行模板
```http
POST /api/run/template
Content-Type: application/json

{
  "template_id": "template-123",
  "environment_id": "env-1",
  "account_ids": ["account-1", "account-2"]
}
```

## 常见问题

### Q: 如何配置变量替换？
A: 在模板中添加 variables 配置，指定 JSON Path 和数据源。

### Q: 失败模式的 OR 和 AND 有什么区别？
A: OR 表示任一条件满足即失败，AND 表示所有条件都满足才失败。

---

查看 [检查清单](04-checklists.md) 了解如何管理测试数据。
