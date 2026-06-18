# 环境变量配置文档

## 前端环境变量

前端使用 Vite 的环境变量系统，所有变量必须以 `VITE_` 前缀开头。

### 配置文件

文件位置：`/.env`

### 变量列表

| 变量名 | 类型 | 必填 | 说明 | 默认值 |
|--------|------|------|------|--------|
| `VITE_API_URL` | string | 是 | 后端 API 地址 | `http://localhost:3001` |

### 配置示例

**.env（开发环境）**：
```env
VITE_API_URL=http://localhost:3001
```

**.env.production（生产环境）**：
```env
VITE_API_URL=https://api.yourdomain.com
```

## 后端环境变量

后端使用标准的 Node.js 环境变量。

### 配置文件

文件位置：`/server/.env`（可选，但当前后端不会自动加载）

### 变量列表

| 变量名 | 类型 | 必填 | 说明 | 默认值 |
|--------|------|------|------|--------|
| `PORT` | number | 否 | 后端服务端口 | `3001` |
| `NODE_ENV` | string | 否 | 运行环境 | `development` |
| `DB_TYPE` | string | 否 | 给部署工具使用的数据库类型提示 | `sqlite` |
| `DB_PATH` | string | 否 | SQLite 数据库路径 | `./data/app.db` |
| `POSTGRES_HOST` | string | 否 | PostgreSQL 主机地址 | - |
| `POSTGRES_PORT` | number | 否 | PostgreSQL 端口 | `5432` |
| `POSTGRES_DB` | string | 否 | PostgreSQL 数据库名 | - |
| `POSTGRES_USER` | string | 否 | PostgreSQL 用户名 | - |
| `POSTGRES_PASSWORD` | string | 否 | PostgreSQL 密码 | - |
| `POSTGRES_SSL` | boolean | 否 | 是否启用 PostgreSQL SSL | `false` |

### 配置示例

**server/.env（开发环境 - SQLite）**：
```env
PORT=3001
NODE_ENV=development
DB_TYPE=sqlite
DB_PATH=./data/app.db
```

**server/.env（生产环境 - PostgreSQL）**：
```env
PORT=3001
NODE_ENV=production
DB_TYPE=postgres
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_DB=bola_prod
POSTGRES_USER=bola_user
POSTGRES_PASSWORD=strong_password
POSTGRES_SSL=true
```

## 在代码中访问环境变量

### 前端（Vite + React）
```typescript
const apiUrl = import.meta.env.VITE_API_URL;

if (!import.meta.env.VITE_API_URL) {
  console.error('VITE_API_URL is not defined');
}
```

### 后端（Node.js）
```typescript
const port = process.env.PORT || 3001;
const nodeEnv = process.env.NODE_ENV || 'development';

if (!process.env.DB_PATH && process.env.DB_TYPE === 'sqlite') {
  console.error('DB_PATH is not defined');
}
```

## 最佳实践

### 1. 不要提交 .env 文件
请将 `.env` 加入 `.gitignore`：
```gitignore
.env
.env.local
.env.production
```

### 2. 使用 .env.example 作为模板
创建 `.env.example` 并填写占位值：
```env
VITE_API_URL=http://localhost:3001
PORT=3001
```

### 3. 统一记录所有变量
建议把所有环境变量说明维护在本文件或 README 中。

### 4. 按环境拆分配置
- `.env`：开发默认配置
- `.env.production`：生产配置
- `.env.test`：测试配置

### 5. 启动时校验关键变量
应用启动时应尽早校验必填变量，缺失时直接报错退出。

## 常见问题

### Q: 修改环境变量后为什么没有生效？
A: 需要重启开发服务器。前端变量必须以 `VITE_` 开头。

### Q: .env 文件应该提交到 Git 吗？
A: 不应该。应使用 `.env.example` 作为模板，并把 `.env` 加入 `.gitignore`。

### Q: 代码里如何读取环境变量？
A:
- 前端：`import.meta.env.VITE_API_URL`
- 后端：`process.env.PORT`

### Q: 生产环境可以使用环境变量吗？
A: 可以。前端的 `VITE_` 变量会在构建时内联，后端变量在运行时读取。

### Q: 缺少必填环境变量会怎样？
A: 应在启动阶段直接校验，并给出明确错误信息。

---

下一步可查看 [数据库配置](database.md)。
