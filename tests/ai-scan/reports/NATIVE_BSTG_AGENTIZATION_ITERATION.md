# Native BSTG Agentization Iteration

## Goal

Make BSTG's original native capabilities first-class Agent-controllable tools instead of leaving them as disconnected manual UI features or secondary evidence only.

## Native capabilities now inventoried for Agent control

The Agent now creates a `bstg_capability_inventory` artifact at the start of each AI Scan. The inventory explicitly maps native BSTG capability groups to Agent tools, native tables, production role and closure requirement:

- API templates / template test runs
- Multi-step workflows / workflow steps
- Workflow variables, variable pool, mappings and extractors
- Execution learning suggestions and learning evidence
- Session jar propagation
- Security rules and checklists
- Accounts and anchor-attacker binding
- Mutation profiles
- Native validation/evidence gates

## Engineering changes

### New services

- `server/src/services/ai-scan/bstg-capability-map.ts`
- `server/src/services/ai-scan/bstg-learning-automation.ts`

### New Agent tools

- `bstg.capabilities.inventory`
- `bstg.payload.plan`
- `bstg.learning.repair_workflow`

### Runtime changes

- `AIScanAgentRuntime.bootstrapRun()` now starts with a native BSTG capability inventory task.
- `runNativeBstgOrchestration()` now converts real workflow debug traces into execution learning suggestions.
- Learning repair writes/updates native BSTG assets:
  - `workflow_learning_suggestions`
  - `workflow_learning_evidence`
  - `workflow_variables`
  - `workflow_mappings`
  - `workflow_extractors`
  - workflow `session_jar_config`
- The baseline workflow is rerun after learned extractor/mapping/session updates when applicable.
- Native execution artifact now includes the learning repair result.

## Test results

### Vulnerable target E2E

Command:

```bash
npm run test:ai-scan:e2e
```

Result:

- Scan status: completed
- Tasks completed: 49
- Failed tasks: 0
- Findings: 10
- Native assets created:
  - `api_templates`: 183
  - `workflows`: 138
  - `workflow_steps`: 183
  - `workflow_variable_configs`: 750
  - `workflow_extractors`: 573
  - `workflow_variables`: 48
  - `workflow_mappings`: 84
  - `security_rules`: 92
  - `checklists`: 49
  - `accounts`: 3
  - `test_runs`: 178

### Laravel route-derived blackbox E2E

Command:

```bash
TARGET_SOURCE_DIR=/mnt/data/laravel_source npm run test:ai-scan:laravel-blackbox
```

Result:

- Parsed Laravel routes: 420
- Discovered endpoints: 186
- Tasks completed: 54
- Failed tasks: 0
- Findings: 32
- Native assets created:
  - `api_templates`: 244
  - `workflows`: 153
  - `workflow_steps`: 244
  - `workflow_variable_configs`: 1114
  - `workflow_extractors`: 2551
  - `workflow_variables`: 200
  - `workflow_mappings`: 272
  - `security_rules`: 102
  - `checklists`: 57
  - `accounts`: 3
  - `test_runs`: 187

## Remaining production hardening still needed

This iteration makes native BSTG learning/variable/mapping/session capabilities Agent-controlled, but the next major production hardening items remain:

1. Playwright-first multi-action browser exploration instead of HTTP crawler as fallback-heavy discovery.
2. Real login/OTP workflow compiler using user-provided or Agent-created accounts.
3. Multi-worker task claim/lock/retry/resume runtime.
4. Evidence policies stricter per vulnerability type with automatic follow-up tasks when evidence is incomplete.
