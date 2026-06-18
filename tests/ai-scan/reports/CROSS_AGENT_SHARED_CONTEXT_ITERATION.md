# Cross-Agent Shared Context Iteration

This iteration fixes the sub-agent isolation problem: independent vulnerability sub-agents now share scan-wide resources instead of rediscovering or recreating accounts, login/session workflows, payload plans and object inventories.

## Added shared resources

- `ai_scan_shared_resources` persistent table.
- `agent.shared_context.prepare` Agent tool.
- `agent_shared_context_inventory` artifact.
- Shared resource types:
  - `identity_pool/default-attacker-victim-admin`
  - `workflow_blueprint/canonical-login-session-flow`
  - `session_strategy/default-session-jar-and-token-propagation`
  - `object_inventory/observed-object-and-owner-fields`
  - `payload_plan/<vuln_type>`
  - `feature_attack_context/<vuln_type>:<feature>`
  - `execution_reuse_record/<task_id>`

## Runtime integration

- Agent context now includes `shared_resources` and `shared_resource_summary`.
- Sub-agent tasks receive `execution_plan.shared_resource_refs`.
- Identity/context-heavy tasks prepend the canonical login/session blueprint endpoint sequence when available.
- Native BSTG orchestration records which shared resources each sub-agent consumed.
- Shared resources have usage counters, proving real reuse across sub-agent executions.

## Verified commands

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run build
npm run build:frontend
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/runcheck/laravel_src npm run test:ai-scan:laravel-blackbox
```

## E2E highlights

Local vulnerable target:

- `agent_shared_context_inventory`: present
- `agent.shared_context.prepare`: invoked
- shared identity pool, login workflow blueprint, payload plans, object inventory: persisted
- executable sub-agents create reuse records and increment shared-resource usage counters
- confirmed findings: 14
- accounts: 3, proving account pool reuse rather than per-task account creation

Laravel route-derived target:

- parsed routes: 420
- discovered endpoints: 186
- confirmed findings: 17
- native BSTG test runs: 123
- accounts: 3
- shared resources and reuse counters verified by test assertions
