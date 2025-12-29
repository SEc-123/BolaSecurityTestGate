---
Documentation & AI Assistant (Important)

Bola Security Test Gate does not provide a traditional feature-by-feature documentation manual.

This is an intentional design decision.
---
Instead, the project ships with a dedicated AI assistant designed to function as a living, interactive security expert.
The assistant can help with:

- Installation and deployment
- Configuration and usage
- Design principles
- Workflow and variable modeling
- Business-logic vulnerability patterns (BOLA/IDOR, etc.)
- CI/CD integration strategies

You can access the assistant here:

👉 Bola Security Test Gate Assistant  
https://chatgpt.com/g/g-6947bdfc185481918368735a56c613c4-bola-security-test-gate-assistant

👉 Bola Security Test Gate Feedback Group  
https://chatgpt.com/gg/v/6949298429288198be46b0a7b879b7ad?token=VkESJJtq2d9ZZgWI4IytDA
---

# Bola Security Test Gate

A visual console for Web/API security testing. Organize test assets with **Environments + Test Accounts + API Templates + Workflows**, execute them in batches, and produce actionable **Findings** (evidence-backed security signals). Includes governance (suppression / throttling / retention) and a CI Gate (quality bar enforcement).

> ⚠️ Use this project only against systems/environments where you have explicit authorization.

---

## 🔑 Key Concepts (Read This First)

### API Template
An **API Template** is a single request definition:
- method + path + headers + body
- variable substitution (e.g., `{{token}}`, `{{userId}}`)
- variable extraction (pull values from responses)
- baselines & assertions
- evidence capture (request/response snapshots relevant to a finding)

### Workflow (Business Flow)
A **Workflow** represents a **real business flow** (a concrete process) made of **multiple API Templates connected in sequence**.

Typical examples:
- Login
- Registration
- Bind Card / Add Payment Method
- Place Order / Checkout
- Transfer / Withdraw
- Reset Password / MFA enrollment

A workflow is essentially: **Template1 → Template2 → Template3 → ...**, where each step can:
- consume variables produced by previous steps (tokens, ids, session state)
- validate business rules and security invariants at the right moment
- produce evidence across the full flow (not just a single endpoint)

Example (Login flow):
- Login: **Template1 → Template2 → Template3 → Template4**

> Why this matters: business-logic vulnerabilities often appear only when endpoints are exercised **in the correct sequence** (stateful conditions), so workflows are the primary unit for modeling real attack paths.

---

## 🆕 What’s New in This Version (Feature Highlights)

This release expands the platform in five major areas:

### 1) Debugging & Observability
- **Debug Trace (last-run trace)**  
  Persist the most recent Template/Workflow execution trace and inspect it inside the UI.
  - Request/response snapshots (headers/body)
  - Variable extraction & substitution steps across the sequence
  - Assertion and baseline evaluations per step
  - Error surfaces (timeouts, parsing issues, auth failures)
  - Export trace to **JSON/TXT** to share in reviews or attach to tickets

### 2) Security Suites (Reusable Test Packs)
- **Suites as first-class objects**  
  Create reusable “packs” that bundle:
  - Templates and/or Workflows (business flows)
  - Target Environment(s)
  - Optional Gate Policy
  - Optional Account sets
- **One-click execution**  
  Run a suite to produce a consistent, repeatable security check for a system boundary.
- **CI-friendly gating**  
  Suites are designed to be triggered by automation (see `sec-runner`) to enforce a quality bar before deploy.

### 3) AI Augmentation (Providers → Analysis → Reports)
- **AI Providers**  
  Configure one or more AI backends (OpenAI / OpenAI-Compatible, etc.), including model selection and credentials.
- **AI Analysis**  
  Turn raw findings into structured reasoning:
  - Severity & confidence
  - Exploitability and business impact
  - Root-cause hypotheses
  - Fix guidance (secure patterns, guardrails, testing suggestions)
  - Grouping/deduping themes across runs
- **AI Reports**  
  Generate exportable **Markdown** reports for audit/engineering workflows, with consistent sections and evidence references.

> ⚠️ AI features may send findings/evidence to your configured provider as prompts. Ensure authorization and avoid sending sensitive data.

### 4) Variable Governance & Scale Operations
- **Global Variable Governance**
  - **Value Mode**: treat variable values as explicit constants for fast stabilization
  - **Source/Rule Mode**: define how values are derived (extraction rules, sources, or shared mappings)
- **Template Variable Manager**
  - Search variables across templates/workflows
  - Bulk update variable definitions for consistency and drift control

### 5) CI/CD CLI Gate Runner
- **`sec-runner` CLI**
  - Run suites in headless mode
  - Produce build artifacts (JSON + Markdown summary)
  - Return exit codes to **pass/warn/block** pipelines

---

## ✨ Core Capabilities

- **Environments**: Manage target environments (base URL, default headers, etc.)
- **Test Accounts**: Manage identities/credentials (supports multi-account strategies)
- **API Templates**: Define single requests with extraction/substitution, baselines/assertions, and evidence capture
- **Workflows (Business Flows)**: Connect templates into real processes (login/checkout/etc.) to model stateful logic and attack paths
- **Test Runs**: Execute templates/workflows/suites and track run status
- **Findings**: Aggregate results and evidence, with attribution/baseline context
- **Governance**:
  - suppression rules (noise control)
  - throttling/rate limits
  - retention/cleanup policies
- **CI Gate Policies**: Enforce pass/warn/block using severity/threshold/policy logic
- **Security Suites**: Reusable packs for one-click checks and CI gating
- **Debug Trace**: Last-run trace for fast troubleshooting and sharing
- **AI Providers / Analysis / Reports**: AI-assisted analysis and report generation
- **Variable Governance**: Search + bulk-update variables at scale

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
├── src/                         # Frontend
├── server/                      # Backend
├── cli/sec-runner/              # CI/CD Gate Runner CLI
├── supabase/migrations/         # Supabase migrations (includes AI tables)
└── *.md                         # Implementation notes, audit reports, updates, etc.
```

---

## 🚀 Quick Start (Development)

### 1) Requirements
- Node.js 18+ (20+ recommended)
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
```

Backend (server/) optional env vars:

```bash
PORT=3001
CORS_ORIGIN=*
CLEANUP_INTERVAL_HOURS=4320
```

✅ By default the backend creates local SQLite files:

- `server/data/app.db` (application DB)
- `server/data/meta.db` (meta DB)

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

- Frontend: http://localhost:5173  
- Backend: http://localhost:3001  
- Health check: `GET http://localhost:3001/health`

---

## ✅ Recommended Modeling Approach

1. Start from a **business flow** (Workflow): login / signup / bind card / checkout.
2. Implement each step as an **API Template**.
3. Connect templates into a **Workflow sequence** (Template1 → Template2 → ...).
4. Run the workflow with multiple test accounts and environments.
5. Use **Suites** to package repeatable checks and attach CI Gate policies.
6. Use **Debug Trace** to troubleshoot drift and step-level failures.
7. Use **AI Analysis/Reports** to triage findings and produce engineering-ready outputs.

---

## 🧰 CLI: sec-runner (CI/CD)

Location: `cli/sec-runner/`

### Build locally
```bash
cd cli/sec-runner
npm install
npm run build
```

### Run example
```bash
node cli/sec-runner/dist/index.js run --suite P0 --env staging --out ./artifacts
```

Output artifacts typically include:
- Gate result JSON
- Gate summary Markdown

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

Backend (server/):

```bash
npm run dev        # start backend (watch)
npm run build      # compile to dist/
npm run start      # run dist/index.js
npm run typecheck  # TS typecheck
```

---

## 📚 Repo Docs (Suggested Reading)

- `IMPLEMENTATION_COMPLETE.md`
- `P0_COMPLETE_IMPLEMENTATION.md`
- `GLOBAL_VARIABLE_AND_CLI_IMPLEMENTATION.md`
- `VALUE_MODE_AND_SUITES_FIX_COMPLETE.md`
- `INCREMENTAL_UPDATES.md`
- `B0_AUDIT_REPORT.md`

---

## 🛡️ Security & Compliance Notes

- Ensure you have written authorization for your target systems.
- Do not commit real production secrets, tokens, or credentials.
- Provide a `.env.example` and inject secrets via CI for safer workflows.

---

## 🤝 Contributing

- Fork and create a branch: `feat/*` or `fix/*`
- Keep type checks green: run `npm run typecheck` (both frontend and backend)
- In PRs, describe: changes, impact, and how to validate/regress-test
