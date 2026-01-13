# 环境变量配置文档

## 前端环境变量

前端使用 Vite 的环境变量系统，所有变量必须以 `VITE_` 前缀开头。

### 配置文件

文件位置: `/project/.env`

### 变量列表

| 变量名 | 类型 | 必填 | 说明 | 默认值 |
|--------|------|------|------|--------|
| `VITE_API_URL` | string | 是 | 后端 API 地址 | `http://localhost:3001` |
| `VITE_SUPABASE_URL` | string | 否 | Supabase 项目 URL | - |
| `VITE_SUPABASE_ANON_KEY` | string | 否 | Supabase 匿名密钥 | - |

### 配置示例

**.env (开发环境)**:
```env
VITE_API_URL=http://localhost:3001
```

**.env.production (生产环境)**:
```env
VITE_API_URL=https://api.yourdomain.com
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 后端环境变量

后端使用标准的 Node.js 环境变量系统。

### 配置文件

文件位置: `/project/server/.env` (可选)

### 变量列表

| 变量名 | 类型 | 必填 | 说明 | 默认值 |
|--------|------|------|------|--------|
| `PORT` | number | 否 | 后端服务器端口 | `3001` |
| `NODE_ENV` | string | 否 | 运行环境 | `development` |
| `DB_TYPE` | string | 否 | 数据库类型 | `sqlite` |
| `DB_PATH` | string | 否 | SQLite 数据库路径 | `./data/app.db` |

### 配置示例

**server/.env (开发环境 - SQLite)**:
```env
PORT=3001
NODE_ENV=development
DB_TYPE=sqlite
DB_PATH=./data/app.db
```

**server/.env (生产环境 - PostgreSQL)**:
```env
PORT=3001
NODE_ENV=production
DB_TYPE=postgres
POSTGRES_HOST=db.example.com
POSTGRES_PORT=5432
POSTGRES_DB=bola_prod
POSTGRES_USER=bola_user
POSTGRES_PASSWORD=strong_password
```

## 常见问题

### Q: 环境变量修改后不生效？
A: 需要重启开发服务器。前端变量必须以 `VITE_` 开头。

### Q: .env 文件应该提交到 Git 吗？
A: 不应该。使用 `.env.example` 作为模板，将 `.env` 添加到 `.gitignore`。

### Q: 如何在代码中访问环境变量？
A: 
- 前端: `import.meta.env.VITE_API_URL`
- 后端: `process.env.PORT`

---

查看 [数据库配置](database.md) 了解数据库设置。
