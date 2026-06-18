# 检查清单模块

## 模块概述

检查清单模块用于管理可重用的值列表，作为 API 模板和工作流中变量替换的数据源。

## 数据模型

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

## 配置示例

### Email 列表（正面测试）
```json
{
  "name": "有效 Email 列表",
  "description": "包含各种格式的有效 Email 地址",
  "values": [
    "user@example.com",
    "test.user@example.com",
    "user+tag@example.com"
  ],
  "tags": "email,positive,validation",
  "is_active": true
}
```

### Email 列表（负面测试）
```json
{
  "name": "无效 Email 列表",
  "description": "包含无效 Email 地址用于测试错误处理",
  "values": [
    "invalid-email",
    "test@",
    "@example.com",
    ""
  ],
  "tags": "email,negative,validation",
  "is_active": true
}
```

### 用户 ID 列表
```json
{
  "name": "用户 ID 列表",
  "values": ["1", "2", "3", "100", "999"],
  "tags": "user,id,positive",
  "is_active": true
}
```

### SQL 注入载荷
```json
{
  "name": "SQL 注入基础载荷",
  "values": [
    "' OR '1'='1",
    "' OR 1=1--",
    "admin'--",
    "'; DROP TABLE users--"
  ],
  "tags": "sql-injection,security,attack-payload",
  "is_active": true
}
```

### XSS 载荷
```json
{
  "name": "XSS 测试载荷",
  "values": [
    "<script>alert('XSS')</script>",
    "<img src=x onerror=alert('XSS')>",
    "javascript:alert('XSS')"
  ],
  "tags": "xss,security,attack-payload",
  "is_active": true
}
```

## 使用场景

### 参数化测试
使用检查清单中的多组值测试同一接口

### 边界值测试
定义边界值列表进行边界测试

### 负面测试
定义无效值列表测试错误处理

### 安全测试
定义攻击载荷列表进行安全漏洞扫描

## API 接口

### 获取所有检查清单
```http
GET /api/checklists
```

### 创建检查清单
```http
POST /api/checklists
Content-Type: application/json

{
  "name": "测试数据",
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

## 常见问题

### Q: 值列表有数量限制吗？
A: 没有硬性限制，但建议每个检查清单的值数量不超过 100 个。

### Q: 如何在模板中使用检查清单？
A: 在 API 模板的变量配置中，将数据源设置为 checklist，并指定检查清单 ID。

---

查看 [数据库配置](../configuration/database.md) 了解数据存储配置。
