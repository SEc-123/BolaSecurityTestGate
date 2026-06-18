# Campaign-scoped Sub-Agent Iteration

This iteration fixes the coarse parallelization model. The scanner no longer treats “file_upload / xss / bola_idor / business_logic” as one worker per vulnerability class. Instead, `task.expand_selected_vulnerabilities` creates a persistent campaign parent per selected vulnerability type and decomposes each campaign into multiple feature/sub-feature child jobs.

## Implemented structure

- `vulnerability_campaign` parent task per selected vulnerability type.
- `vulnerability_campaign_plan` artifact with candidate/function/endpoint mapping.
- Multiple child tasks under each campaign, e.g. BOLA/IDOR can spawn order, wallet, transfer, user object, login/session related sub-agents.
- Each child task keeps `campaign_task_id`, `function_name`, `parallel_group`, `recommended_agent_role`, and `requires_identity_context` in `execution_plan`.
- `summarize_vulnerability_campaign` task depends on all child jobs in the campaign.
- `task.summarize_vulnerability_campaign` aggregates child task results, native BSTG evidence, findings, and residual gaps into `vulnerability_campaign_summary`.

## E2E verification

### Local vulnerable target

- Tasks completed: 39 / 39
- Campaign plan artifacts: 9
- Campaign summary artifacts: 9
- Sub-agent spawned artifacts: 29
- Agent decisions from provider: 69
- Fallback decisions: 0
- Native API test-run artifacts: 24
- Native workflow verification artifacts: 17
- Native backed findings: 14 / 14
- Findings: 14

### Laravel route-derived blackbox target

- Parsed Laravel routes: 420
- Discovered endpoints: 186
- Tasks completed: 43 / 43
- Campaign plan artifacts: 10
- Campaign summary artifacts: 10
- Sub-agent spawned artifacts: 32
- Agent decisions from provider: 75
- Fallback decisions: 0
- Native API test-run artifacts: 26
- Native workflow verification artifacts: 19
- Native backed findings: 17 / 17
- Findings: 17

## Key validation assertions

The tests now assert:

- Selected vulnerability types create persistent campaign parent tasks.
- Campaigns create summary tasks.
- BOLA/IDOR is decomposed into multiple feature/sub-feature child jobs under one campaign parent.
- Child jobs keep campaign linkage and are parallel capable.
- Campaign summary artifacts are created after child sub-agents finish.
- Every confirmed finding remains backed by native BSTG evidence.
- Agent decisions are provider-driven, with zero fallback decisions.
