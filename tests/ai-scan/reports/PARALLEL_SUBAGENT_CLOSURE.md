# Parallel Sub-Agent Closure Iteration

This iteration closes the structural gap where autonomous testing tasks were executed serially even after the AI driver had expanded independent vulnerability tests.

## Implemented changes

- Added parallel Agent execution in `server/src/agent/agent-runtime.ts`.
  - `scan_config.max_parallel_agents` and `/api/ai-scans/:id/run { max_parallel_agents }` now control worker parallelism.
  - Runnable independent tasks are claimed in batches and executed concurrently as sub-agent jobs.
  - The runtime persists `parallel_agent_batch_started`, `subagent_spawned`, and `parallel_agent_batch_completed` artifacts.
- Added repository support in `server/src/services/ai-scan/repository.ts`.
  - `findRunnablePendingTasks()` filters dependency-satisfied pending tasks.
  - `claimRunnableTasks()` marks tasks as running and annotates execution plans with worker metadata.
- Marked expanded vulnerability tasks as parallel-capable in `server/src/agent/tools/ai-scan-tools.ts`.
  - Each file upload and generic vulnerability task gets a `parallel_group`, `recommended_agent_role`, and `parallel_capable` marker.
- Updated API and frontend client types to accept/report parallel agent settings.
- Strengthened E2E tests.
  - The standard vulnerable-target E2E and Laravel route-derived blackbox E2E now run with `max_parallel_agents: 4`.
  - Tests assert the presence of parallel batch and sub-agent artifacts.

## Verified commands

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run build
npm run build:frontend
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/runcheck/laravel_src npm run test:ai-scan:laravel-blackbox
```

## Standard vulnerable target result

- Status: completed
- Tasks: 13 completed / 0 failed
- Findings: 9
- Parallel batches: 6 started / 6 completed
- Sub-agents spawned: 12
- Agent decisions: 32
- Native API test-run artifacts: 13
- Native workflow verification artifacts: 9

## Laravel route-derived blackbox result

- Parsed Laravel routes: 420
- Discovered endpoints: 186
- Tasks: 14 completed / 0 failed
- Findings: 9
- Parallel batches: 6 started / 6 completed
- Sub-agents spawned: 13
- Agent decisions: 34
- Native API test-run artifacts: 14
- Native workflow verification artifacts: 10

## Current closure status

The AI Scan runtime no longer needs to serialize independent vulnerability tasks. After the AI driver expands selected vulnerability classes into executable tasks, the runtime now runs them as concurrent sub-agent jobs while preserving native BSTG evidence gates.

Remaining production work is still needed for Playwright-first multi-action browser exploration, real login/OTP workflow compilation, and true attacker/victim/admin object-ownership lifecycle. This iteration specifically closes the parallel sub-agent/job-runtime structural gap.
