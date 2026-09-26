# Agent-first UX redesign

This project should present security assessment as a business-feature test plan, not as internal engine pages.

## Product model

Users should see:

1. Project / target
2. Surface: Web or Android App
3. Business feature map: login, registration, cart, orders, wallet, files, admin, profile
4. Test plan per feature: BOLA/IDOR, BFLA, auth bypass, OTP bypass, replay/race, business logic
5. Live execution: left task plan, right controlled browser/app
6. Result: confirmed risk, passed, blocked, inconclusive
7. Evidence: screenshots, API request/response, identity/object proof, remediation

Users should not need to understand:

- recording sessions
- workflow drafts
- API templates
- variable pools
- field dictionary
- mapping/extractor learning
- debug traces
- raw tool invocation logs

These are internal agent infrastructure and belong behind a Developer Workbench.

## UX changes in this package

- Primary navigation is reduced to the assessment workflow and outcomes.
- Internal infrastructure pages are hidden by default behind a Developer Workbench toggle.
- Assessment now surfaces a business-feature test plan before raw candidates.
- Raw candidates, tool calls, shared memory and other internals are labelled as agent internals/debug material.
- Android and Web use the same visible mental model: feature plan + live controlled surface + evidence.

## Closed-loop definition

A completed app/web assessment is not a completed internal workflow run. A completed assessment means:

- business feature identified
- test item scheduled
- UI action or API precondition executed
- traffic captured or template/workflow replayed
- identity and object context proven
- native evidence gate completed
- user-facing result updated as confirmed, passed, blocked or inconclusive

