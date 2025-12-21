# Security Testing Console

一个面向 **Web/API 安全测试** 的可视化控制台：用「环境 + 测试账号 + API 模板 + 工作流」的方式组织安全用例，批量执行并产出 Findings（漏洞线索），同时支持治理（抑制/限流/保留策略）与 CI Gate（质量门禁）。

> ⚠️ 请仅在你**明确授权**的系统/环境中使用本项目进行测试。

---

## ✨ 主要能力

- **Environments**：管理被测环境（Base URL、Headers 等）
- **Test Accounts**：测试账号/身份（支持多账号组合策略）
- **API Templates**：定义接口模板（方法、路径、headers、body、变量提取与替换）
- **Workflows**：多步流程编排（登录 → 取 token → 访问资源 → 断言）
- **Test Runs**：执行单次模板/工作流测试并追踪状态
- **Findings**：聚合结果与证据，支持账号溯源、Baseline 对比等增强字段
- **Governance**：抑制规则、限流、数据保留/清理策略
- **CI Gate Policies**：面向 CI 的门禁策略（按严重性/规则/阈值等拦截）

---

## 🧱 技术栈

- **Frontend**：Vite + React 18 + TypeScript + TailwindCSS
- **Backend**：Node.js + Express + TypeScript
- **Database**：
  - 默认：本地 **SQLite**（开箱即用）
  - 可选：**Postgres / Supabase Postgres**（通过 DB Profile 切换）

---

## 📁 目录结构（关键）

```text
.
├── src/                 # 前端：页面、组件、API client
├── server/              # 后端：Express API、DB providers、services
├── supabase/            # Supabase 相关迁移（如果你使用 Supabase）
├── SECURITY_TESTING_ENHANCEMENTS.md
├── SOLUTION_SUMMARY.md
└── IMPLEMENTATION_GUIDE.md
```

> 需要更细的「文件/功能逻辑树」：见 `PROJECT_LOGIC_TREE.md`（建议放到仓库根目录）。

---

## 🚀 快速开始（开发模式）

### 1) 环境要求
- Node.js **18+**（建议 20+）
- npm（或 pnpm/yarn 也可自行改脚本）

### 2) 安装依赖

```bash
# 前端
npm ci

# 后端
cd server
npm ci
```

### 3) 配置环境变量

前端（仓库根目录）使用 `.env`：

```bash
# Backend API URL
VITE_API_URL=http://localhost:3001

# 可选：如果你要用 Supabase 作为数据库后端（仅在你启用相关能力时需要）
# VITE_SUPABASE_URL=...
# VITE_SUPABASE_ANON_KEY=...
```

后端（`server/`）可选环境变量：

```bash
PORT=3001
CORS_ORIGIN=*
CLEANUP_INTERVAL_HOURS=4320
```

> ✅ 后端默认会创建本地 SQLite：`server/data/app.db`（元数据库 `server/data/meta.db`）。

### 4) 启动

开两个终端：

**Terminal A（后端）**
```bash
cd server
npm run dev
```

**Terminal B（前端）**
```bash
npm run dev
```

- 前端默认：`http://localhost:5173`
- 后端默认：`http://localhost:3001`
- 健康检查：`GET http://localhost:3001/health`

---

## 🔧 数据库与 Profile 管理

后端支持通过 **Admin API** 管理数据库 profile（sqlite / postgres / supabase_postgres）：

- `GET  /admin/db/status`
- `GET  /admin/db/profiles`
- `POST /admin/db/profiles`
- `POST /admin/db/switch`
- `POST /admin/db/migrate`
- `POST /admin/db/export`
- `POST /admin/db/import`

> ⚠️ 切换 DB profile 时，如果存在运行中的 run，后端会返回 409 并拒绝切换。

---

## 📚 文档导航（强烈建议从这里读）

- `ENHANCEMENTS_README.md`：文档索引（阅读顺序建议）
- `SOLUTION_SUMMARY.md`：6 个结构性问题的解决方案总览
- `SECURITY_TESTING_ENHANCEMENTS.md`：完整架构设计与字段说明
- `IMPLEMENTATION_GUIDE.md`：分阶段实施手册
- `IMPLEMENTATION_EXAMPLES.ts`：可直接复制的关键实现示例

---

## 🧪 常用脚本

前端（根目录）：

```bash
npm run dev        # 启动前端
npm run build      # 构建
npm run preview    # 本地预览构建产物
npm run lint       # ESLint
npm run typecheck  # TS 类型检查
```

后端（`server/`）：

```bash
npm run dev        # tsx watch 启动后端
npm run build      # tsc 编译到 dist/
npm run start      # 运行 dist/index.js
npm run typecheck  # TS 类型检查
```

---

## 🛡️ 安全与合规说明

- 请确保你对被测系统拥有**书面授权**。
- 不要将真实生产密钥、token、账号密码提交到仓库。
- 建议为 `.env` 提供 `.env.example`，并在 CI 中注入配置。

---

## 🤝 贡献方式

1. Fork & 创建分支：`feat/*` / `fix/*`
2. 保持 TS 类型通过：`npm run typecheck`（前后端各跑一次）
3. 提交 PR 时说明：改动点、影响范围、回归建议

---

## License

内部项目/私有项目可先保留此段；若开源请补充具体 License（MIT/Apache-2.0 等）。
