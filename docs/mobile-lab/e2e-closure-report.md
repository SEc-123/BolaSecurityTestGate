# Android Mobile Lab end-to-end closure report

This branch has been checked as a product + execution closed loop, not just a backend skeleton.

## Verified commands

```bash
npm run build
npm run test:mobile-lab:offline-e2e
npm run test:product:e2e-contract
npm run test:mobile-lab:closed-loop-static
```

## Verified execution loop

```text
Android surface assessment
→ offline Appium-compatible Mobile Lab simulator
→ mobile.lab.prepare
→ HTTPS capture health = https_decrypted
→ mobile.app.install
→ mobile.app.launch
→ mobile.observe creates mobile_device_state screenshots
→ mobile.flow.run performs App actions
→ mobile.capture.import imports Burp-style HTTPS JSONL flows
→ recording_events are created
→ workflow draft regeneration runs
→ ai_discovered_endpoints contains POST /login, POST /orders, GET /orders/10086
→ /api/ai-scans/:id/product-state exposes business functions, current work, and controlled Android app frame
→ Assessment UI consumes the product state instead of exposing workflow/recording/variable internals
```

## Product UX contract

User-visible pages are limited to:

```text
Assessment
Findings
Reports
```

Internal infrastructure pages are not part of the user-facing frontend. Recording, Workflow, API templates, variables, dictionaries, rules, and learning remain backend/Agent infrastructure only.

## Important boundary

The bundled offline lab supplied for development is an Appium/Burp-compatible deterministic simulator. It is enough to verify the integration contract and the UI/API/Agent loop. For a real APK, use the same adapter with your lawful Android SDK/AVD and internal Burp by setting:

```bash
BSTG_MOBILE_OFFLINE_SIMULATOR=false
BSTG_MOBILE_ADB_PATH=/path/to/adb
BSTG_MOBILE_ADB_SERIAL=emulator-5554
BSTG_MOBILE_APPIUM_URL=http://127.0.0.1:4723
BSTG_BURP_CAPTURE_URL=http://127.0.0.1:<burp-bridge>/bstg/mobile/capture
# or
BSTG_BURP_FLOW_EXPORT_PATH=/path/to/burp-history.jsonl
```
