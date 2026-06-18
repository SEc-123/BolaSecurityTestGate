# Advanced State-Machine / Replay / Race Native BSTG Closure

This iteration closes the gap that business-logic/race tests were too shallow and did not fully exploit native BSTG workflow mutation capabilities.

## Implemented

- Added `state_machine_race` vulnerability type and candidate generation for order/payment/refund/cancel/withdraw/transfer state flows.
- Added native advanced mutation planning in `bstg-native-orchestrator.ts`.
- Native mutation profiles now encode:
  - `skip_steps` for state transition bypass / out-of-order workflow testing.
  - `repeat_steps` for idempotency and replay testing.
  - `concurrent_replay` for same-packet race testing with a barrier.
  - `parallel_groups` for cross-packet concurrent state races such as pay+refund, refund+cancel, withdraw+transfer.
  - `static_conditions` metadata for baseline/session/state postconditions.
- Added persistent artifacts:
  - `advanced_mutation_plan`
  - `advanced_mutation_execution`
- Native evidence gate now records advanced mutation dimensions and verifies advanced mutation only when such dimensions are planned.
- Added E2E assertions that native workflow mutation profiles actually contain `concurrent_replay`, `parallel_groups`, `skip_steps`, and `repeat_steps`.

## Local vulnerable-target verification

- Endpoints discovered: 28
- Candidate coverage includes:
  - `business_logic`: 20
  - `replay_race`: 9
  - `state_machine_race`: 8
- Tasks completed: 55 / 55
- Findings: 22
- Native assets:
  - `api_templates`: 212
  - `workflows`: 75
  - `workflow_steps`: 140
  - `workflow_variable_configs`: 700
  - `workflow_extractors`: 570
  - `workflow_variables`: 368
  - `workflow_mappings`: 644
  - `security_rules`: 61
  - `checklists`: 38
  - `test_runs`: 167

## Laravel route-derived blackbox verification

- Routes parsed: 420
- Endpoints discovered: 188
- Candidate coverage includes:
  - `business_logic`: 95
  - `replay_race`: 54
  - `state_machine_race`: 54
- Tasks completed: 54 / 54
- Findings: 24
- Native assets:
  - `api_templates`: 233
  - `workflows`: 72
  - `workflow_steps`: 165
  - `workflow_variable_configs`: 887
  - `workflow_extractors`: 1365
  - `workflow_variables`: 494
  - `workflow_mappings`: 851
  - `security_rules`: 58
  - `checklists`: 36
  - `test_runs`: 159

## Commands executed

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run build
npm run build:frontend
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/runcheck/laravel_src npm run test:ai-scan:laravel-blackbox
```

Both E2E suites completed successfully after the advanced mutation profile integration.
