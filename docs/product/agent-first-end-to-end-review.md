# Agent-first end-to-end review

This project now treats API templates, workflow learning, recordings, variables, field dictionaries and low-level debug traces as internal Agent infrastructure. They remain available to the backend execution engine, but they are no longer user-facing product pages.

## User-facing product model

The user-facing console exposes only:

1. **Assessment** — start a Web or Android App assessment, watch the Agent operate the browser/App, and see business-function test progress.
2. **Findings** — validated risks, business impact and evidence.
3. **Reports** — delivery-ready summary and markdown export.

The frontend no longer imports or routes the legacy internal pages from `src/pages`. Those files have been moved to `archive/frontend-internal-pages` so they cannot appear as product features.

## Web/App closed-loop flow

### Web

```text
User starts Web assessment
→ Agent opens controlled browser
→ Agent discovers business functions and HTTP endpoints
→ Agent creates function-level test plan
→ Agent executes BSTG native API/workflow checks internally
→ Evidence gate confirms or blocks findings
→ UI shows function progress, controlled browser frame, risk status and evidence
```

### Android App

```text
User starts Android App assessment
→ Agent prepares Mobile Lab
→ Agent launches/observes Android App through Appium/UIAutomator-compatible runtime
→ UI shows Controlled Android App frames
→ Agent executes business actions
→ Internal Burp-compatible capture provides decrypted HTTPS flows
→ BSTG imports flows into internal recording events
→ Agent converts observed behavior into function-level test plan
→ Existing BSTG native API/workflow/evidence-gate engine validates risks
→ UI shows business-function progress, Controlled Android App frames, findings and report
```

## What is intentionally not exposed

These are internal implementation details and no longer appear as user-facing pages:

- API templates
- Workflow builder
- Recording center
- Variable pool
- Checklists
- Rule engine
- Field dictionary / memory
- Debug trace
- Model providers
- Raw Agent candidate queue
- Raw tool invocation names
- Shared resources

## Verification

Run:

```bash
npm run test:product:e2e-contract
npm run test:mobile-lab:closed-loop-static
```

The product contract test verifies:

- Only three user-facing pages remain under `src/pages`.
- Internal page modules are removed from product routing and archived.
- User-facing source does not contain banned internal labels.
- Android Agent tools are implemented and included in the offline E2E contract.
- The Mobile API path covers App observe/action/import-capture.
- The offline E2E contract asserts `android-ui -> appium-actions -> burp-https-flow -> recording -> endpoint discovery -> agent artifacts`.
