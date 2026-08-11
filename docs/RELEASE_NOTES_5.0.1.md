# BSTG 5.0.1 — Discovery-first release from 0.3.3 baseline

This patch is intentionally based on the 0.3.3 working baseline and reverses the earlier governance-heavy direction. The goal is to find more vulnerabilities, not to add budgets, tool capability locks, asset lifecycle control planes, or evidence hard gates that suppress discovery.

## What changed

- Default scan config now favors max coverage: more task expansion per vulnerability type, more fallback tasks, and larger account bootstrap discovery.
- Native BSTG replay evidence is treated as proof-strengthening metadata, not a default blocker for finding creation.
- Missing workflow/login/object preconditions are recorded as replay gaps, not used to suppress likely findings by default.
- AI and heuristic judges preserve likely vulnerable verdicts instead of locally downgrading them before a finding is created.
- File upload and generic vulnerability runners now create findings from vulnerable judgement/direct mutation evidence even when replay evidence is incomplete, while recording the proof gap as an artifact.
- Business-logic expansion no longer samples only “primary” business domains by default; suspicious auth-only/other domains can still become executable tasks.

## Explicitly not included

This release does not add traffic budgets, tool capability gates, asset lifecycle cleanup control planes, SaaS/RBAC/tenant controls, or private-network blocking. BSTG remains a local/self-hosted security testing tool; private IP and localhost targets remain valid when explicitly selected by the operator.

## Compatibility

- Base: 0.3.3
- Package version: 5.0.1
- Patch scope: discovery-first behavior only, without importing the 0.4.0/5.0 governance framework.
