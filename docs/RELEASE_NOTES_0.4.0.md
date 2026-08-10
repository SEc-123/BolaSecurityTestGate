# BSTG 0.4.0 — Agent governance and evidence integrity

BSTG 0.4.0 completes the P0 and P1 hardening work for the local/self-hosted security-testing model. It intentionally does **not** introduce SaaS tenancy, user login, RBAC, or multi-tenant authorization concepts.

## P0 security boundaries included in this release

- Server binds to loopback by default; remote/LAN exposure remains an explicit operator choice through `BSTG_HOST` and `CORS_ORIGIN`.
- AI Scan and native target traffic are constrained to the configured target origin, including redirects and browser subrequests, while still allowing explicitly chosen localhost/private-network targets.
- Credentials, cookies, tokens, passwords, OTP values, and other secrets are sanitized at the common AI transport boundary.
- Debug/evidence traces are keyed by execution run ID so parallel Agent tasks cannot consume another task's “last trace”.

## P1 agent governance

### Scan-wide target traffic budget

Every Agent-driven target request now participates in a shared scan budget, including Browser/HTTP discovery, account bootstrap, direct vulnerability probes, uploads, native API Template execution, Workflow execution, and learning traffic.

The budget supports:

- max target concurrency
- requests per second and burst control
- total-request quota
- per-endpoint quota
- mutation quota
- upload quota
- account-creation quota
- persisted traffic snapshots so completed tool calls restore the budget after a server restart
- abort-aware permit queues so timed-out Agent tools do not emit delayed requests

Assessment launch settings expose the primary concurrency/RPS/total-request controls, and the live workspace displays traffic consumption.

### Vulnerability-specific evidence contracts

The previous one-size-fits-all native evidence gate is replaced by explicit contracts:

- `stateless_input_v1` — XSS, command injection, path traversal, file download
- `file_upload_v1` — native upload baseline/mutation workflow evidence
- `authorization_stateful_v1` — BOLA/IDOR and BFLA
- `business_stateful_v1` — business logic, OTP, email/SMS bypass, passcode bypass
- `race_v1` — replay/state-machine races plus executed concurrent mutation evidence
- `strict_generic_v1` — conservative fallback for unclassified vulnerability types

AI judgement is still insufficient on its own. A confirmed Finding requires the applicable evidence contract, and stateful generic tests still require workflow preconditions.

### Tool runtime contracts

Agent tools now execute through a runtime contract rather than using descriptive metadata only. The registry enforces:

- input schema validation
- Agent capability class (`read`, `control_plane`, `active_test`) — this is an internal Agent safety class, not user RBAC
- side-effect level
- configured target-URL fields against the scan origin
- per-tool timeout with abort propagation to outbound target traffic
- shared traffic-budget context

Each invocation persists its enforced contract and traffic snapshot for audit/debugging. The Agent context also receives these runtime constraints so planning and execution use the same contract.

### AI-generated asset lifecycle

Agent-created Environments, synthetic Accounts, API Templates, Workflows, Rules, Checklists, workflow-variable assets, and Test Runs are registered in a dedicated lifecycle registry.

Lifecycle states are monotonic:

`ephemeral → reusable → promoted`

`cleaned` is used only after an ephemeral asset is actually removed. Re-registering an asset cannot downgrade retained evidence or transfer its generation ownership to another scan. Reused/manual Accounts are never registered as generated cleanup candidates, and native execution cannot claim a caller-provided Environment as generated.

Confirmed Findings automatically retain the generated assets required for replay. Operators can promote assets explicitly at any time; explicit cleanup is allowed only after the assessment reaches `completed` or `failed`, preventing an active Agent run from deleting its own execution assets. Optional end-of-run auto-cleanup is configurable per scan.

### Relational Finding provenance

AI Findings now carry structured Assessment provenance and a dedicated foreign-key relation linking:

`Finding → Scan → Task/Campaign → Candidate → Feature → Endpoint → Evidence Contract`

Campaign summaries query this relation directly rather than searching Finding titles, notes, or localized text. Deduplicated Findings preserve their first canonical task/campaign origin.

## Database schema

Schema version: `1.4.0-ai-agent-p1`

New/extended structures include:

- `ai_generated_assets`
- `ai_finding_provenance`
- Agent provenance columns on `findings`
- `contract_json` and `traffic_json` on `ai_tool_invocations`
- supporting indexes for scan/campaign/asset queries

Both SQLite and PostgreSQL migration paths are updated.

## Validation

Project regression commands:

```bash
npm run test:p0:security-boundaries
npm run test:p1:agent-governance
npm run check:i18n
```

The P1 regression suite covers evidence-contract selection, Traffic Governor quotas/restart/abort behavior, Tool Runtime contract enforcement and timeout, SQLite migration surfaces, generated-asset lifecycle invariants, and relational Finding provenance.
