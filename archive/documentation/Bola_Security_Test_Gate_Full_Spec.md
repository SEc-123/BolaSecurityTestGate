
# Bola Security Test Gate — Full Feature Specification

This document is a **complete, engineer‑level functional specification** of Bola Security Test Gate.
It explains **what each module is**, **what security problem it solves**, **how it is configured**, and **how findings are judged as real**.

This is NOT marketing material.  
This is meant for **security engineers, backend engineers, and CI owners**.

---

## 0. What This Tool Is (Correct Mental Model)

Bola Security Test Gate is:

> **A stateful API execution engine + identity binding system + governance gate**

It does NOT “scan vulnerabilities” in the traditional sense.
It **executes real API requests** under **different identities, states, and object bindings**, then judges whether the system violates **authorization, state-machine, or business invariants**.

It is designed to catch:
- BOLA / IDOR
- Authorization binding mistakes
- State-machine & workflow bypass
- Regression re‑introduction in CI/CD

---

## Capability Levels (Do NOT confuse)

### Basic Capabilities — Single API (Test Runs)
- Parameter validation bypass (negative price, large quantity, type confusion)
- Missing authentication (no token but 200)
- Information disclosure (sensitive fields)

### Intermediate Capabilities — Normal Business Flows
- Order / address / coupon / refund / profile / query authorization bypass

### Advanced Capabilities — Systematic Workflow Attacks
- State continuation bypass
- API semantic inconsistency
- Weak consistency / async bypass
- TOCTOU
- Rollback / downgrade / state machine flaws
- Cross‑workflow variable pollution
- Regression vulnerabilities (CI focused)
- Concurrency / replay / idempotency bugs

---

## 1. Test Accounts

### What It Is
A **structured identity container** used to:
- inject authentication material
- inject user‑owned business identifiers
- simulate attacker / victim relationships

### Data Model
Each account contains:
- `auth_profile` (headers, cookies, tokens)
- `fields` (userId, orderId, addressId, tenantId, etc.)

### Why It Exists
BOLA / workflow bugs only exist **across identities**.
Accounts make identity switching **explicit, reproducible, and automatable**.

### Interaction
Used by:
- API Templates
- Workflows
- Learning / Mutation engine

---

### Account Binding Strategies (CRITICAL)

#### 1. independent
Variables may come from **different accounts**.
Used to discover **mixed‑identity payload bugs**.

Example:
- userId from A
- addressId from B
Server only checks one of them.

#### 2. per_account
All account fields come from **the same account**.
Used as baseline for “correct” behavior.

#### 3. anchor_attacker
One fixed attacker identity + victim object IDs.
Used for **classic BOLA / IDOR**.

This is how real attackers operate.

---

## 2. Environment

### What It Is
A **base URL definition** for execution targets.

### Why It Exists
Templates & workflows stay constant while environments change:
- staging
- pre‑prod
- region variants

### Runtime Behavior
Final request URL =
`environment.base_url + template.path`

---

## 3. API Templates (CORE)

### What It Is
A **single API request blueprint** with:
- variable injection
- identity binding
- failure judgment logic
- optional baseline diff

### What Problem It Solves
Allows **systematic execution** of:
- same endpoint
- different identities
- different object bindings
- different payloads

### Template Structure
- raw HTTP request
- parsed structure
- variable definitions
- failure patterns
- baseline config
- account binding strategy

---

### Template Variables

Each variable defines:
- where to inject (`json_path`, header, query, path)
- source of data:
  - account field
  - checklist
  - security rule
- identity role (attacker / victim)
- scope & binding behavior

This is how IDOR payloads are built **correctly**.

---

### Failure Patterns (IMPORTANT)

Failure patterns define:
> “What does *proper denial* look like?”

Examples:
- HTTP 401 / 403
- error code = ACCESS_DENIED
- message contains “not allowed”

If a response does **not** match failure patterns,
it is treated as **suspicious success**.

This avoids false positives where denial still returns HTTP 200.

---

### Baseline (IMPORTANT)

Baseline means:
- execute **known‑good request**
- compare mutated execution against it

Used when:
- denial still returns 200
- business logic differs subtly

Baseline supports:
- ignore fields (timestamp, requestId)
- critical fields (ownerId, balance, state)
- cross‑step comparison

Incorrect baseline config = false positives.

---

## 4. Checklists

### What It Is
A **value list payload source**.

### Used For
- numeric edge cases
- role values
- invalid IDs

### Example
Checklist values:
`[-1, 0, 1, 9999999]`

Injected via template variable.

---

## 5. Security Rules

### What It Is
Reusable **payload libraries**.

### Used For
- state transition values
- known bypass tokens
- protocol edge cases

Different from checklist only by **intent & reuse**.

---

## 6. Test Runs (Single API Execution)

### What It Is
A **single‑endpoint execution session**.

### When To Use
- parameter validation bugs
- missing auth
- information disclosure
- simple IDOR on one endpoint

### What It Produces
- execution log
- findings
- suppression stats
- effective findings count

---

## 7. Workflows (MOST IMPORTANT)

### What It Is
A **stateful, multi‑step execution graph**.

Each step:
- references an API Template
- can read/write global variables
- can change identity
- shares cookies/session

### What Problem It Solves
Real vulnerabilities do NOT exist in isolation.
They exist across:
- order → pay → refund
- create → modify → cancel
- async → eventual consistency

Workflows model **real business processes**.

---

### Cookie / Session Jar
- Cookies persist across steps
- Supports login → action chains
- Identity switching invalidates or preserves session (configurable)

---

### Global Variable Pool (Field Dictionary)
- Extract values from responses
- Reuse in later steps
- Enables cross‑step object reuse

Example:
Step 1 creates order → extracts orderId  
Step 3 refunds same orderId under attacker identity

---

### Learning Mode

Learning Mode:
- observes normal workflow execution
- learns which fields change, persist, or correlate
- seeds mutation engine

Used to:
- reduce blind fuzzing
- focus mutations on meaningful fields

---

### Mutation Engine

Mutation applies:
- cross‑account substitution
- replay / concurrency
- state rollback
- semantic inconsistencies

This is where **advanced logic bugs** are found.

---

## 8. Findings + Governance (CRITICAL)

### What Is a Finding
A finding is created when:
1. Failure patterns NOT matched
2. Baseline diff is significant (if enabled)
3. Not dropped by rules

### Three‑Layer Filtering

#### Layer 1 — Drop Rules
Hard filters.
Example:
- ignore test users
- ignore non‑prod tenants

#### Layer 2 — Suppression Rules
Soft filters.
Example:
- known acceptable behavior
- temporarily tolerated issues

#### Layer 3 — Rate Limiting
Caps repeated findings from same template.

Only **effective findings** count toward CI.

---

## 9. CI Gate (Math, Not Magic)

### What It Is
A **numeric gate** over effective findings.

### Example Policy
- Block if `effective_findings >= 1`
- Warn if `effective_findings >= 3`
- Pass otherwise

### Why It Works
Because findings are:
- identity‑aware
- state‑aware
- filtered
- reproducible

This avoids flaky CI failures.

---

## 10. Learning + Variable Pool + Mutation (Deep Summary)

Together they allow:
- understanding normal behavior
- systematic deviation
- reproducible attack execution

This is why workflows become:
> **business attack executors**, not scanners.

---

## Final Boundary

This tool is NOT good for:
- static code analysis
- pure SQLi/XSS scanning
- UI‑only vulnerabilities

It is EXTREMELY good at:
- authorization logic
- business invariants
- state machine bugs
- regression prevention in CI

---

END OF DOCUMENT
