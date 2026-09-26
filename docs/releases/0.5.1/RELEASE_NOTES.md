# BSTG 0.5.1 — Discovery-focused correction of 0.4.0/0.5.0 increments

This release is generated against the original 0.3.3 working baseline, but it is **not** a fresh 3.3 rewrite. It reviews the 0.4.0 P0/P1 and 0.5.0 P2 increments and removes the parts that made BSTG more governance-heavy than discovery-oriented.

## Removed from the 0.4.0/0.5.0 increment

- Scan traffic budgets, request counters, rate-limit/concurrency blockers, and their UI/API surface.
- Tool runtime capability/side-effect allowlists and timeout contract enforcement.
- Vulnerability-specific evidence contracts as finding blockers.
- Generated asset lifecycle registry, promotion, and cleanup workflow.
- Bounded-autonomy AI call/token/step budgeting and allowlist validation.

## Kept or adjusted because it helps discover more issues

- Local/self-hosted target origin boundary for active target actions, without blocking localhost/private targets.
- Sensitive model-context redaction and trace isolation fixes.
- Finding provenance relation so findings remain traceable to scan/task/candidate/feature/endpoint.
- Agent memory and persistent browser continuity, adjusted to support rediscovery avoidance and authenticated-state exploration rather than governance.
- Browser passive subresources are allowed so real applications can render through CDNs/static assets and expose more routes/forms.
- AI-vulnerable results now create findings even when native replay/workflow evidence is incomplete; replay gaps are recorded as artifacts instead of suppressing the finding.

The intended direction is: **Agent 负责 Reasoning，BSTG 负责 Proof；Proof gaps should drive follow-up replay work, not hide possible vulnerabilities.**
