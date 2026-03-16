---
Documentation & AI Assistant (Important)

Bola Security Test Gate provide a traditional feature-by-feature documentation manual. /DOC_CH CHINESE /DOC_EN ENGLISH

the project provides a dedicated AI assistant, designed to function as a living, interactive security expert.
---
The assistant can help with:

- Installation and deployment  
- Configuration and usage  
- Design principles  
- Workflow and variable modeling  
- Business logic vulnerability patterns  
- CI/CD integration strategies  

You can access the assistant here:

👉 Bola Security Test Gate Assistant  
https://chatgpt.com/g/g-6947bdfc185481918368735a56c613c4-bola-security-test-gate-assistant

👉 Bola Security Test Gate Feedback Group  
https://chatgpt.com/gg/v/6949298429288198be46b0a7b879b7ad?token=VkESJJtq2d9ZZgWI4IytDA

Think of it as interactive documentation aligned with real security reasoning, rather than static text.
---

# Bola Security Test Gate

A visual console for **Web/API security testing**. Organize test cases with **Environments + Test Accounts + API Templates + Workflows**, execute them in batches, and produce actionable **Findings** (evidence-backed security signals). Includes governance (suppression / throttling / retention) and a CI **Gate** (quality bar enforcement).

## 🎯 项目概述

BSTG 是一个功能强大的 Web/API 安全测试平台，提供可视化控制台用于自动化安全测试。项目包含以下主要组件：

### 🌟 核心功能

- **环境管理**: 管理测试目标环境（dev/staging/prod）
- **账户管理**: 管理测试用户凭证和身份信息
- **API 模板**: 定义可重用的 API 请求模板
- **工作流**: 多步骤测试场景编排
- **安全规则**: SQL注入、XSS、命令注入等安全测试载荷
- **发现管理**: 漏洞发现和证据管理
- **CI/CD 集成**: 质量门禁策略

> ⚠️ Use this project only against systems/environments where you have **explicit authorization**.

---

## ✨ Key Capabilities

- **Environments**: Manage target environments (base URL, default headers, etc.)
- **Test Accounts**: Manage identities/credentials (supports multi-account strategies)
- **API Templates**: Define API requests (method, path, headers, body, variable extraction/substitution)
- **Workflows**: Multi-step orchestration (login → token → resource access → assertions)
- **Test Runs**: Execute a template/workflow run and track status
- **Findings**: Aggregate results and evidence, with enhanced fields for attribution/baselines
- **Governance**: Suppression rules, rate limits, retention/cleanup policies
- **CI Gate Policies**: CI-facing gate rules (block by severity/threshold/policy, etc.)

---

## 🧱 Tech Stack

- **Frontend**: Vite + React 18 + TypeScript + TailwindCSS
- **Backend**: Node.js + Express + TypeScript
- **Database**:
  - Default: local **SQLite** (works out of the box)
  - Optional: **Postgres / Supabase Postgres** (switchable via DB profiles)

---

## 📁 Project Layout (Key)

```text
BSTG/
├── 📄 核心配置文件
│   ├── .env                    # 环境变量配置
│   ├── package.json            # Node.js 项目配置
│   ├── README.md               # 项目说明文档
│   ├── USER_GUIDE.md           # 用户指南
│   └── ...
├── 🏗️ 核心目录
│   ├── src/                    # Frontend: pages, components, API client
│   ├── server/                 # Backend: Express APIs, DB providers, services
│   ├── cli/                    # 命令行工具
│   ├── burp-recorder-plugin/   # Burp Suite 插件
│   └── tests/                  # 测试代码
├── 📚 文档目录
│   ├── docs/                   # 英文文档
│   ├── docs_CH/                # 中文文档
│   ├── docs_EN/                # 英文文档
│   ├── SECURITY_TESTING_ENHANCEMENTS.md
│   ├── SOLUTION_SUMMARY.md
│   ├── IMPLEMENTATION_GUIDE.md
│   └── ...
├── 🧪 测试目录
│   └── tests/recording/smoke-tests/  # 录制功能冒烟测试
├── 📦 归档目录
│   ├── archive/documentation/  # 历史文档
│   └── archive/temp/           # 临时文件归档
└── supabase/                   # Supabase migrations (if you use Supabase)
```

> For a detailed "file/function logic tree", see `PROJECT_LOGIC_TREE.md` (recommended at repo root).

---

## � 如何使用

### 1️⃣ 启动 BSTG 平台

```bash
# 启动后端 (终端1)
cd server
npm run dev

# 启动前端 (终端2)  
npm run dev
```

访问: http://localhost:5173

### 2️⃣ 构建 Burp 插件

```bash
cd burp-recorder-plugin
mvn clean package
```

构建完成后会在 `target/` 目录生成 `bstg-burp-recorder.jar`

### 3️⃣ 安装 Burp 插件

1. 打开 Burp Suite
2. 进入 Extensions → Installed
3. 点击 Add → Extension file
4. 选择生成的 `bstg-burp-recorder.jar`
5. 插件安装后会显示 "BSTG Recorder" 标签页

### 4️⃣ 配置插件连接

在 Burp 的 BSTG Recorder 标签页中：

- **Server URL**: http://localhost:3001 (BSTG 后端地址)
- **API Key**: 从 BSTG 平台获取
- **Mode**: 选择 workflow 或 api
- **Environment ID**: BSTG 平台中的环境ID
- **Account ID**: 测试账户ID

### 5️⃣ 开始录制

1. 在 BSTG 平台创建测试工作流
2. 在 Burp 中配置代理并浏览目标应用
3. 在 BSTG Recorder 标签页点击 "Start Recording"
4. 执行测试操作，Burp 会自动捕获请求
5. 停止录制后，请求会同步到 BSTG 平台

### 6️⃣ 分析和测试

在 BSTG 平台中：

1. 查看录制的请求模板
2. 配置安全测试规则
3. 执行自动化安全测试
4. 查看发现的安全漏洞

### 📊 项目状态

项目已经完整实现了 Burp Suite 集成，包括：

- ✅ Burp 插件代码完整
- ✅ 实时请求捕获功能
- ✅ 与 BSTG 后端 API 集成
- ✅ 本地缓存和队列机制

---

## �🔗 与 Burp Suite 的联通

项目已完整集成 Burp Suite 插件：

### 📁 Burp 插件位置
```
burp-recorder-plugin/
├── pom.xml                    # Maven 构建文件
└── src/main/java/com/bstg/burp/recorder/
    ├── BstgExtension.java     # 主扩展类
    ├── RecorderTab.java       # Burp UI 标签页
    ├── BstgApiClient.java     # 与 BSTG 后端通信
    ├── EventSenderWorker.java # 事件发送工作器
    └── ...                    # 其他支持类
```

### ⚡ Burp 插件功能
- **请求录制**: 自动捕获 Burp Suite 中的 HTTP 请求/响应
- **实时传输**: 将捕获的请求实时发送到 BSTG 平台
- **会话管理**: 支持录制会话的创建和管理
- **队列缓冲**: 本地队列缓存，防止网络问题导致数据丢失
- **UI 集成**: 在 Burp Suite 中添加 "BSTG Recorder" 标签页

### 🛠️ 构建 Burp 插件

```bash
cd burp-recorder-plugin
mvn clean package
```

构建完成后会在 `target/` 目录生成 `bstg-burp-recorder.jar`

### 🔌 安装 Burp 插件

1. 打开 Burp Suite
2. 进入 Extensions → Installed
3. 点击 Add → Extension file
4. 选择生成的 `bstg-burp-recorder.jar`
5. 插件安装后会显示 "BSTG Recorder" 标签页

### ⚙️ 配置插件连接

在 Burp 的 BSTG Recorder 标签页中：

- **Server URL**: http://localhost:3001 (BSTG 后端地址)
- **API Key**: 从 BSTG 平台获取
- **Mode**: 选择 workflow 或 api
- **Environment ID**: BSTG 平台中的环境ID
- **Account ID**: 测试账户ID

### 🎬 开始录制

1. 在 BSTG 平台创建测试工作流
2. 在 Burp 中配置代理并浏览目标应用
3. 在 BSTG Recorder 标签页点击 "Start Recording"
4. 执行测试操作，Burp 会自动捕获请求
5. 停止录制后，请求会同步到 BSTG 平台

### 📊 分析和测试

在 BSTG 平台中：

1. 查看录制的请求模板
2. 配置安全测试规则
3. 执行自动化安全测试
4. 查看发现的安全漏洞

### ✅ 项目状态

项目已经完整实现了 Burp Suite 集成，包括：

- ✅ Burp 插件代码完整
- ✅ 实时请求捕获功能
- ✅ 与 BSTG 后端 API 集成
- ✅ 本地缓存和队列机制
- ✅ 可视化控制台界面
- ✅ 完整的测试套件

---

## 🚀 Quick Start (Development)

### 1) Requirements
- Node.js **18+** (20+ recommended)
- npm (pnpm/yarn are fine if you adjust scripts)

### 2) Install Dependencies

```bash
# Frontend (repo root)
npm ci

# Backend
cd server
npm ci
```

### 3) Configure Environment Variables

Frontend (repo root) via `.env`:

```bash
# Backend API URL
VITE_API_URL=http://localhost:3001

# Optional: if you use Supabase as the database backend
# VITE_SUPABASE_URL=...
# VITE_SUPABASE_ANON_KEY=...
```

Backend (`server/`) optional env vars:

```bash
PORT=3001
CORS_ORIGIN=*
CLEANUP_INTERVAL_HOURS=4320
```

> ✅ By default the backend creates local SQLite files:
> - `server/data/app.db` (application DB)
> - `server/data/meta.db` (meta DB)

### 4) Run

Open two terminals:

**Terminal A (Backend)**
```bash
cd server
npm run dev
```

**Terminal B (Frontend)**
```bash
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`
- Health check: `GET http://localhost:3001/health`

---

## 🔧 Database Profiles & Admin APIs

The backend supports managing database profiles (sqlite / postgres / supabase_postgres) via Admin APIs:

- `GET  /admin/db/status`
- `GET  /admin/db/profiles`
- `POST /admin/db/profiles`
- `POST /admin/db/switch`
- `POST /admin/db/migrate`
- `POST /admin/db/export`
- `POST /admin/db/import`

> ⚠️ If there is an active run, switching DB profiles will be rejected with HTTP 409.

---

## 📚 Documentation

### User Guide
**[USER_GUIDE.md](USER_GUIDE.md)** - Complete user manual with:
- Feature descriptions and configuration examples
- Step-by-step tutorials for all major features
- Best practices and troubleshooting
- CLI tool usage and CI/CD integration

### AI Assistant
For interactive guidance and security expertise:
- 👉 [Bola Security Test Gate Assistant](https://chatgpt.com/g/g-6947bdfc185481918368735a56c613c4-bola-security-test-gate-assistant)
- 👉 [Feedback Group](https://chatgpt.com/gg/v/6949298429288198be46b0a7b879b7ad?token=VkESJJtq2d9ZZgWI4IytDA)

---

## 🧪 Common Scripts

Frontend (repo root):

```bash
npm run dev        # start frontend
npm run build      # build
npm run preview    # preview build output
npm run lint       # ESLint
npm run typecheck  # TS typecheck
npm run check:recording:unit   # recording unit checks
npm run smoke:recording:doc10  # full doc10 acceptance
npm run migrate:recording      # recording migration helper
```

Backend (`server/`):

```bash
npm run dev        # start backend (watch)
npm run build      # compile to dist/
npm run start      # run dist/index.js
npm run typecheck  # TS typecheck
```

---

## 🛡️ Security & Compliance Notes

- Ensure you have **written authorization** for your target systems.
- Do not commit real production secrets, tokens, or credentials.
- Provide a `.env.example` and inject secrets via CI for safer workflows.

---

## 🤝 Contributing

1. Fork and create a branch: `feat/*` or `fix/*`
2. Keep type checks green: run `npm run typecheck` (both frontend and backend)
3. In PRs, describe: changes, impact, and how to validate/regress-test
