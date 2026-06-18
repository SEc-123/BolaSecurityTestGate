# AI Scan Production-Closure Iteration Report

This iteration was driven by the production gaps identified in the code review: the earlier implementation proved the end-to-end path, but still depended too heavily on direct HTTP runners and did not enforce that confirmed findings were backed by native BSTG workflow/template evidence.

## Implemented changes

### 1. Native BSTG evidence gate

Added `server/src/services/ai-scan/native-evidence-gate.ts`.

Confirmed findings now require:

- native BSTG template run evidence;
- native BSTG baseline workflow verification;
- native BSTG mutation workflow execution;
- native test run IDs, workflow IDs and template IDs in finding evidence.

If AI/heuristic judgement says vulnerable but native evidence is incomplete, the finding is blocked and a `finding_blocked_by_native_evidence_gate` artifact is written.

### 2. Native-first finding creation

Updated:

- `server/src/services/ai-scan/generic-vuln-runner.ts`
- `server/src/services/ai-scan/file-upload-runner.ts`

Direct HTTP execution remains as confirmation evidence, but it can no longer be the only basis for a confirmed finding. All confirmed findings must include `native_bstg` and `native_evidence_gate` evidence.

### 3. Production workflow context expansion

Added `server/src/services/ai-scan/workflow-context.ts`.

Task expansion now injects relevant precursor endpoints into the task endpoint sequence, such as:

- token / CSRF / session endpoints;
- captcha / OTP / verification endpoints;
- login / auth endpoints;
- list/query/create endpoints needed before object-sensitive actions;
- admin/management context for BFLA;
- business setup context for order/cart/payment/replay tests.

The executable endpoint remains the last endpoint in the task sequence. `agent-runtime.ts` was fixed to use the last endpoint as the action endpoint, not the first precursor endpoint.

### 4. Cross-step extractor and mapping coverage

Updated `server/src/services/ai-scan/bstg-native-orchestrator.ts`.

Native baseline workflows now get production-oriented extractors for:

- status;
- Set-Cookie;
- Location;
- token / access_token;
- CSRF token;
- object IDs such as id, user_id, order_id;
- file URL / path.

The orchestrator also creates workflow variable pool items and cross-step mappings so prior-step values can feed later requests.

### 5. Baseline verification artifact

Native orchestration now writes `native_workflow_verification` artifacts for every native execution. These artifacts explicitly record:

- `baseline_verified`;
- `mutation_executed`;
- whether a repair rerun was attempted;
- baseline and mutation test run summaries.

### 6. Real account override support

Native account creation now supports `scan_config.accounts` / `scan_config.identities` overrides for attacker, victim and admin accounts. The fallback synthetic identities remain for local blackbox harnesses, but real deployments can pass actual account fields/tokens/session data.

### 7. Test assertions hardened

Updated:

- `tests/ai-scan/run-ai-scan-e2e.mjs`
- `tests/ai-scan/run-laravel-exchange-blackbox-e2e.mjs`

The tests now assert:

- native BSTG execution artifacts exist;
- native workflow verification artifacts exist;
- no native baseline verification failed;
- every confirmed finding is backed by native BSTG evidence;
- native asset counts include templates, workflows, workflow steps, variable configs, extractors, variable pool, mappings, security rules, checklists, accounts and test runs.

## Validation results

### Vulnerable target E2E

Command:

```bash
npm run test:ai-scan:e2e
```

Result:

```text
scan status: completed
completed tasks: 48
findings: 10
native_bstg_execution_artifacts: 46
native_workflow_verification_artifacts: 46
native_unverified_baselines: 0
native_backed_findings: 10
```

Native BSTG assets:

```text
api_templates: 183
workflows: 138
workflow_steps: 183
workflow_variable_configs: 750
workflow_extractors: 2740
workflow_variables: 364
workflow_mappings: 637
security_rules: 92
checklists: 49
accounts: 3
test_runs: 138
```

### Laravel route-derived blackbox E2E

Command:

```bash
TARGET_SOURCE_DIR=/mnt/data/laravel_source npm run test:ai-scan:laravel-blackbox
```

Result:

```text
route_count: 420
discovered endpoints: 186
completed tasks: 53
findings: 32
native_bstg_execution_artifacts: 51
native_workflow_verification_artifacts: 51
native_unverified_baselines: 0
native_backed_findings: 32
```

Native BSTG assets:

```text
api_templates: 244
workflows: 153
workflow_steps: 244
workflow_variable_configs: 1114
workflow_extractors: 3860
workflow_variables: 568
workflow_mappings: 994
security_rules: 102
checklists: 57
accounts: 3
test_runs: 153
```

## Remaining production gaps

This iteration materially closes the native-BSTG-first gap, but these items remain future hardening work before claiming mature production readiness against arbitrary real targets:

1. Playwright is still optional. A production deployment should install it and make Playwright-first browsing the default discovery path.
2. Real login/registration/OTP solving still needs a dedicated identity workflow compiler rather than relying only on account/session overrides.
3. The learning engine is partially represented by native repair/verifier artifacts, but the full existing learning suggestion/apply service should be promoted into an Agent tool.
4. Long-running task execution is still single-process; production should add claim/lock/retry/cancel semantics for distributed workers.

