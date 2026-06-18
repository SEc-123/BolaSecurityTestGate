# API Test Run Agentization Iteration

## Objective

Close the gap between BSTG's two native execution modes:

1. API/template `test_run` mode for single-interface vulnerabilities.
2. Workflow `test_run` mode for multi-step business/API sequences.

Before this iteration, AI Scan used workflow-native evidence and aggregate template runs, but API-mode test runs were not first-class evidence for single-interface vulnerabilities. This left a product gap: many issues such as XSS, command injection, path traversal, file download, simple BOLA/BFLA and parameter tampering can be found by driving a single API template directly.

## Code changes

### Native orchestration

Updated `server/src/services/ai-scan/bstg-native-orchestrator.ts`:

- Added API-mode baseline and mutation template compilation.
- Added native API-mode `test_runs` for baseline and mutation.
- Added `native_api_test_run` artifacts.
- Added API-mode assets into `NativeBstgAssetBundle`:
  - `api_mode_template_ids`
  - `api_mode_baseline_test_run_id`
  - `api_mode_mutation_test_run_id`
  - `api_mode_security_rule_id`
  - `api_mode_checklist_id`
- Added exported `runNativeApiTestRun(...)` for direct Agent/tool invocation.

### Evidence gate

Updated `server/src/services/ai-scan/native-evidence-gate.ts`:

- Confirmed findings now require API-mode evidence in addition to aggregate template/workflow evidence.
- Gate now reports:
  - `native_api_mode_executed`
  - `native_api_test_run_ids`
  - `api_mode_test_run_not_successful` if missing.

### Agent tool surface

Updated `server/src/agent/tools/ai-scan-tools.ts`:

- Added `bstg.api_test.run` so the Agent can explicitly drive API-mode execution.
- The tool compiles native API templates, attaches security rules/checklists/account fields, executes template test runs, and writes native API evidence.

### Capability inventory

Updated `server/src/services/ai-scan/bstg-capability-map.ts`:

- Added `api_test_run_mode` capability group.
- Updated the production gate to require native API-mode test run evidence.

### Regression tests

Updated:

- `tests/ai-scan/run-ai-scan-e2e.mjs`
- `tests/ai-scan/run-laravel-exchange-blackbox-e2e.mjs`

New assertions require:

- `native_api_test_run` artifacts.
- API-mode test run metrics.
- Every confirmed finding includes `native_api_mode_executed` in the evidence gate payload.

## Verification

Commands executed:

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run build
npm run build:frontend
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/laravel_source npm run test:ai-scan:laravel-blackbox
```

## Results: local vulnerable target

- Scan completed: yes
- Tasks completed: 49
- Failed tasks: 0
- Confirmed findings: 10
- `native_api_test_run` artifacts: 46
- `native_bstg_execution` artifacts: 46
- `native_workflow_verification` artifacts: 46
- `bstg_learning_repair` artifacts: 46
- Native backed findings: 10 / 10
- Native unverified baselines: 0

Native assets:

- `api_templates`: 275
- `workflows`: 138
- `workflow_steps`: 183
- `workflow_variable_configs`: 750
- `workflow_extractors`: 573
- `workflow_variables`: 48
- `workflow_mappings`: 84
- `security_rules`: 92
- `checklists`: 49
- `accounts`: 3
- `test_runs`: 270

## Results: Laravel route-derived blackbox target

- Parsed Laravel routes: 420
- Discovered endpoints: 186
- Tasks completed: 54
- Failed tasks: 0
- Confirmed findings: 32
- `native_api_test_run` artifacts: 51
- `native_bstg_execution` artifacts: 51
- `native_workflow_verification` artifacts: 51
- `bstg_learning_repair` artifacts: 51
- Native backed findings: 32 / 32
- Native unverified baselines: 0

Native assets:

- `api_templates`: 346
- `workflows`: 153
- `workflow_steps`: 244
- `workflow_variable_configs`: 1114
- `workflow_extractors`: 2551
- `workflow_variables`: 200
- `workflow_mappings`: 272
- `security_rules`: 102
- `checklists`: 57
- `accounts`: 3
- `test_runs`: 289

## Conclusion

This iteration makes BSTG API `test_run` mode a first-class Agent-controlled execution path. Single-interface tests are no longer only represented by direct HTTP attempts or workflow side effects. Each confirmed finding now carries both:

1. Native API-mode template test run evidence.
2. Native workflow baseline/mutation evidence when the task is compiled as a workflow.

This closes the specific gap that API test run and workflow test run are two distinct BSTG execution modes and both must be AI-drivable.
