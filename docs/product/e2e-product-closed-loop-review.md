# Agent-first Product E2E Closed Loop Review

This version treats Workflow, Recording, API Template, variable learning, field dictionaries, and debug traces as internal Agent infrastructure. The user-facing product loop is:

1. Create an Assessment.
2. Choose Web or Android App.
3. For Android, upload an authorized test APK. The backend stores the APK and inspects metadata when local tooling is available.
4. Start Autopilot.
5. Agent prepares browser/mobile lab, observes the surface, performs actions, imports HTTPS evidence, generates business functions and tests, and verifies risks.
6. The frontend displays business functions, test progress, current work, controlled Browser/App frames, and risk evidence.
7. Findings and Reports are the only downstream user pages.

## Frontend contract

Visible user pages:

- Assessment
- Findings
- Reports

The Assessment page no longer asks the user to understand package/activity/lab profile/Burp flow/workflow/recording/variable concepts. Android App input is an APK upload and target environment. Technical configuration remains backend/profile driven.

## Backend contract

User-facing API endpoints added for the closed loop:

- `POST /api/mobile/apps/import`: stores an authorized test APK and returns product-friendly app metadata.
- `GET /api/ai-scans/:id/product-state`: returns business functions, current work, live surface state, and risk evidence for the frontend.

Internal Agent APIs remain available for execution but are no longer modeled as user pages.

## Android closed loop

The implemented execution loop is:

Android App UI → Appium/ADB actions → Internal Burp HTTPS JSONL flow → BSTG recording events → endpoint discovery → feature/test plan → native API/Workflow validation → evidence gate → finding/report.

## Automated checks

Run:

```bash
npm run test:product:e2e-contract
npm run test:mobile-lab:closed-loop-static
```

These checks assert that internal pages are removed from user-facing navigation, APK import and product-state endpoints exist, Android Agent tools are registered, and the capture → recording → endpoint contract exists.
