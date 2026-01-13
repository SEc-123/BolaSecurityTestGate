---
Documentation & AI Assistant (Important)

Bola Security Test Gate currently does not provide a traditional feature-by-feature documentation manual.

This is an intentional design decision.

Instead, the project provides a dedicated AI assistant, designed to function as a living, interactive security expert.
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
.
├── src/                 # Frontend: pages, components, API client
├── server/              # Backend: Express APIs, DB providers, services
├── supabase/            # Supabase migrations (if you use Supabase)
├── SECURITY_TESTING_ENHANCEMENTS.md
├── SOLUTION_SUMMARY.md
└── IMPLEMENTATION_GUIDE.md
```

> For a detailed “file/function logic tree”, see `PROJECT_LOGIC_TREE.md` (recommended at repo root).

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
