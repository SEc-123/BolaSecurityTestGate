# Autonomous AI Provider Runtime Iteration

This iteration removes the hard-coded `switch(task_type)` executor path from `AIScanAgentRuntime` and replaces it with an autonomous provider-driven tool-call loop.

## Structural changes

- Added `server/src/agent/decision-types.ts` for structured Agent decisions.
- Added `server/src/agent/context-builder.ts` to build per-task context from scan state, endpoints, features, candidates, artifacts, prior tool invocations, and tool specs.
- Added `server/src/agent/autonomous-planner.ts` to call the configured AI provider with the full context and available BSTG/browser tools.
- Rewrote `server/src/agent/agent-runtime.ts` so task execution is now:
  - build context
  - ask AI provider for the next action
  - persist `agent_decision`
  - dispatch selected tool through `AgentToolRegistry`
  - loop until complete/wait/fail
- Added `tests/ai-scan/fixtures/local-autonomous-ai-provider.mjs`, an OpenAI-compatible local relay used by E2E to validate the real AI provider integration path instead of local in-process policy.
- Enhanced task expansion scoring so high-value BOLA/BFLA/business-logic endpoints are chosen before low-value login/static endpoints.
- Enhanced generic mutation execution so POST endpoints can be tested through JSON body mutations, not only query-string mutations.
- Cleaned standalone native API test-run auto-findings so confirmed findings remain gated by AI Scan native evidence.

## Validation commands

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run build
npm run build:frontend
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/runcheck/laravel_src npm run test:ai-scan:laravel-blackbox
```

## Local vulnerable target result

- Endpoints discovered: 17
- Tasks completed: 13 / 13
- Confirmed findings: 9
- Native API test-run artifacts: 13
- Native workflow verification artifacts: 9
- Native BSTG execution artifacts: 9
- Agent decisions: provider-driven, no fallback required
- Native BSTG assets:
  - api_templates: 61
  - workflows: 27
  - workflow_steps: 35
  - workflow_variable_configs: 140
  - workflow_extractors: 95
  - workflow_variables: 8
  - workflow_mappings: 14
  - security_rules: 22
  - checklists: 14
  - accounts: 3
  - test_runs: 61

## Laravel route-derived blackbox result

- Parsed Laravel routes: 420
- Endpoints discovered: 186
- Tasks completed: 14 / 14
- Confirmed findings: 9
- Native API test-run artifacts: 14+
- Native workflow verification artifacts: 10
- Native BSTG execution artifacts: 10
- Agent decisions: provider-driven, no fallback required
- Native BSTG assets:
  - api_templates: 93
  - workflows: 30
  - workflow_steps: 65
  - workflow_variable_configs: 338
  - workflow_extractors: 999
  - workflow_variables: 57
  - workflow_mappings: 72
  - security_rules: 24
  - checklists: 15
  - accounts: 3
  - test_runs: 64

## Current meaning

The AI Scan system is no longer a fixed switch-case automation script. The runtime now has a Codex-style loop: context -> provider decision -> tool dispatch -> evidence -> next decision. The local OpenAI-compatible relay is used only to validate the provider integration in offline E2E; production can point the same `ai_providers` row at a real OpenAI-compatible model.
