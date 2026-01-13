# 数据库配置文档

## 支持的数据库

系统支持三种数据库：

- **SQLite**: 默认数据库，零配置
- **PostgreSQL**: 生产环境推荐
- **Supabase**: 云端 PostgreSQL

## SQLite 配置

### 默认配置

SQLite 是默认数据库，无需配置即可使用。

### 文件位置
```
server/data/
├── app.db      # 应用数据库
└── meta.db     # Meta 数据库
```

### 优势
- 零配置，开箱即用
- 文件级备份
- 适合开发和小团队

### 限制
- 并发写入限制
- 不适合高并发场景

## PostgreSQL 配置

### 前置要求

1. 安装 PostgreSQL 服务器
2. 创建数据库和用户

### 创建数据库
```sql
CREATE USER bola_user WITH PASSWORD 'your_password';
CREATE DATABASE bola_db OWNER bola_user;
GRANT ALL PRIVILEGES ON DATABASE bola_db TO bola_user;
```

### 创建数据库 Profile

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

### 切换数据库
```http
POST /admin/db-profiles/switch
Content-Type: application/json

{
  "profile_name": "postgres_prod"
}
```

## Supabase 配置

### 获取连接信息

1. 登录 Supabase Dashboard
2. Settings → Database
3. 复制 Connection String

### 创建 Supabase Profile

```http
POST /admin/db-profiles
Content-Type: application/json

{
  "profile_name": "supabase_cloud",
  "provider_type": "postgres",
  "config": {
    "host": "db.xxx.supabase.co",
    "port": 5432,
    "database": "postgres",
    "user": "postgres",
    "password": "your_supabase_password",
    "ssl": true
  }
}
```

## 数据迁移

### 导出数据
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

## 常见问题

### Q: 如何备份 SQLite 数据库？
A: 直接复制 `server/data/app.db` 文件。

### Q: 可以同时使用多个数据库吗？
A: 可以创建多个 Profile，但同一时间只有一个处于活动状态。

### Q: 切换数据库会丢失数据吗？
A: 不会，切换只是改变当前使用的数据库，原数据保持不变。

---

查看 [环境变量配置](environment-variables.md) 了解环境变量设置。
