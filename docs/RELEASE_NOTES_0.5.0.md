# BSTG 0.5.0 — Persistent Agent cognition and bounded autonomy

BSTG 0.5.0 is intentionally built **on top of 0.4.0**. It keeps every P0/P1 target-scope, model-secret, trace-isolation, traffic-budget, evidence-contract, tool-runtime, generated-asset, and Finding-provenance boundary from 0.4.0, then adds persistent Agent cognition and bounded AI planning.

This release continues to target BSTG's local/self-hosted security-testing model. It does **not** introduce SaaS tenancy, user RBAC, or multi-tenant authorization.

## P2 design principles

1. **AI reasoning may propose; deterministic controls still authorize execution.** Planner proposals cannot bypass Tool Runtime contracts, target scope, traffic budgets, workflow preconditions, or vulnerability evidence contracts.
2. **Memory is structured and provenance-aware, not an unbounded prompt transcript.** Scope, confidence, TTL, version, dependencies, provenance, model visibility, and append-only revisions are first-class data.
3. **Secrets stay out of model memory.** Shared identity/session resources become reference-only memories; manually or automatically remembered observations are sanitized before persistence and model retrieval.
4. **Browser continuity is reusable but never privileged.** Persistent contexts retain application state across Agent steps and can recover from persisted Playwright storage state after a process restart, while every network request still passes target-scope and scan-traffic controls.
5. **Autonomy is resource bounded.** AI call, token, step, repeated-decision, supporting-tool, and child-task budgets prevent retry storms and planning loops.

## Agent Memory 2.0

New structured memory records include:

- scan/task/identity/feature/endpoint scope
- confidence
- TTL / expiry
- version and append-only revision snapshots
- atomic concurrent version assignment so parallel Sub-Agent updates cannot collapse or duplicate revisions
- provenance and dependency references
- sensitivity (`public`, `internal`, `secret_ref`)
- LLM visibility (`full`, `summary`, `reference_only`, `hidden`)
- usage counters and last-used timestamp

Shared resources such as identity pools and session strategies are mirrored as safe reference memories rather than copying passwords, cookies, tokens, OTPs, or raw authentication requests.

Retrieval uses scope, confidence, recency, usage, and lexical relevance. Unicode-aware tokenization plus CJK n-grams supports Chinese/Japanese/Korean business-function names without requiring an embedding service.

Assessment APIs expose memory records and append-only revision history. The UI shows memory scope/confidence/version/visibility and revision history for updated memories.

## Persistent browser runtime

Playwright navigation can now reuse contexts at three explicit scopes:

- `scan`
- `task`
- `identity`

The runtime persists Playwright storage state and reconstructs a context when the in-process browser context no longer exists. This preserves authenticated continuity across Agent steps and process restarts.

Hard boundaries remain active for every browser resource:

- target-origin scope enforcement
- scan-wide Traffic Governor permits
- timeout/abort propagation
- context TTL and expiry
- explicit close operations
- per-context operation serialization so parallel Sub-Agents sharing one scan/identity context cannot cross-contaminate navigation, DOM, or network evidence
- immutable scope/identity binding prevents a custom context key from rebinding attacker storage state to victim/admin sessions
- only active, unexpired contexts may restore persisted storage state; explicit close/failed state is not resurrected
- close operations latch the context, reject new navigation, drain queued work, then destroy state without falling through to HTTP navigation

Raw storage state is **not** returned by normal Assessment snapshot/browser-context APIs. The UI only receives whether state exists and aggregate cookie/origin counts. Raw state remains internal to the browser recovery runtime.

The external navigation result remains backward compatible with `mode: "playwright"`; `persistent_context: true` identifies the upgraded path.

## Bounded planner autonomy

Autopilot scans now default to `bounded_ai`; existing/manual scan configurations without the P2 setting remain `local_only` for backward compatibility.

Every AI decision is evaluated against the deterministic local policy. The AI may use stage-allowed supporting tools (for example, relevant memory lookup or controlled browser observation), but cannot:

- skip a mandatory native BSTG test
- complete a task before local completion prerequisites are met
- call tools outside the current stage allowlist
- call unknown tools
- indefinitely defer the mandatory policy tool
- create unbounded child-task fan-out
- repeat the same decision beyond the loop threshold
- exceed per-task/per-scan AI-call budgets
- exceed per-task/per-scan AI-token budgets
- exceed the task step budget

Provider attempts are counted even when the model returns malformed JSON or the call falls back to local policy. Token usage uses provider-reported usage when available and a conservative estimate otherwise, preventing failed responses from bypassing planner budgets.

Planner audit records persist the proposal, executed decision, deterministic policy decision, validation status, rejection reason, decision signature, provider-attempt marker, and token usage.

## Runtime memory feedback loop

Terminal task outcomes are written back into Agent Memory immediately, so sibling and later sub-agents can reuse confirmed context rather than waiting for the entire Assessment to finish.

The Agent context now includes:

- relevant safe memories
- memory inventory summary
- active browser-context summary
- planner call/token/validation/loop state

The LLM still receives a final model-context sanitization pass before transport.

## API and UI

Assessment launch controls now expose:

- bounded AI planner on/off
- AI calls per task
- steps per task
- AI tokens per task
- AI tokens per scan
- maximum relevant memories in context
- persistent browser on/off
- browser context scope (`task` or `scan`; identity scope is selected explicitly by Agent tools when an identity key is available)

The live Assessment workspace displays:

- structured memories and revision history
- active/closed/expired browser contexts
- safe browser-state presence/count metadata
- planner accepted/rejected/fallback decisions
- planner token consumption

New/extended APIs:

- `GET /api/ai-scans/:id/memories`
- `POST /api/ai-scans/:id/memories`
- `GET /api/ai-scans/:id/memories/:memoryId/revisions`
- `GET /api/ai-scans/:id/browser-contexts`
- `POST /api/ai-scans/:id/browser-contexts/:contextKey/close`
- `GET /api/ai-scans/:id/planner-decisions`

## Database schema

Schema version: `1.5.0-ai-agent-p2`

New tables:

- `ai_agent_memories`
- `ai_agent_memory_revisions`
- `ai_browser_contexts`
- `ai_planner_decisions`

The SQLite migration path is compatible with 0.4.0 databases; PostgreSQL receives the same P2 structures and indexes through the normal schema migration path.

## Validation

Standard project command for a fully installed development environment:

```bash
npm run test:p2:agent-runtime
```

The P2 regression suite validates:

- bounded planner early-completion rejection
- mandatory-tool deferral limits
- loop detection
- AI call/token budgets
- memory secret sanitization
- scoped memory retrieval
- append-only memory revisions
- concurrent memory revision version uniqueness
- memory TTL expiry
- internal-only browser storage-state recovery data
- public browser-context redaction
- browser context expiry
- planner-decision persistence
- browser context-key invariants

During release preparation the following compatibility checks were also run independently: P0 target/model/local-access boundaries, P1 traffic/evidence/tool-governance core, 0.4.0→0.5.0 SQLite migration + foreign keys, full TS/TSX syntax parsing, and the i18n coverage contract.
