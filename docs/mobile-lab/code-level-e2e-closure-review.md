# Code-level E2E Closure Review

This build was audited and exercised as two product loops: AI-driven Web security assessment and AI-driven Android App security assessment.

## Verified command set

```bash
npm run build
npm run test:ai-scan:e2e
npm run test:mobile-lab:offline-e2e
npm run test:product:e2e-contract
npm run test:mobile-lab:closed-loop-static
```

## Web Agent loop verified

The Web loop starts a vulnerable target, a local AI provider, and BSTG server, then performs discovery, candidate generation, task expansion, native API/workflow execution, evidence-gated finding creation, and report generation.

Latest verified result:

- 23 discovered endpoints
- 13 vulnerability classes covered
- 55 completed Agent tasks
- 11 evidence-gated findings
- Native BSTG assets created: API templates, workflows, workflow steps, variables, extractors, mappings, security rules, checklists, accounts, test runs, findings

Fixes applied during closure review:

- Browser discovery no longer lets lower-fidelity inline API references overwrite richer HTML form observations. This preserved field semantics such as `passcode` and allowed passcode candidate generation.
- POST mutation transport now sends mutation parameters on both query and body surfaces for form/mobile-style endpoints, while preserving JSON/form body behavior. This lets the native runner exercise the parameter binding actually used by target handlers.
- The generic evidence gate can upgrade an AI-provider `inconclusive` result when local native mutation evidence contains a confirmed security signal.
- Generic vulnerability execution now prefers verify/check-code endpoints over send-code endpoints for OTP/SMS/email bypass tasks.

## Android Agent loop verified

The Android loop uses the bundled offline mobile lab simulator as an Appium/Burp-compatible deterministic lab.

Latest verified result:

- HTTPS health: `https_decrypted`
- UI tree nodes observed: 3
- Imported Burp flows: 3
- Generated workflow draft count: 1
- Agent tools completed:
  - `mobile.lab.prepare`
  - `mobile.app.install`
  - `mobile.app.launch`
  - `mobile.observe`
  - `mobile.flow.run`
  - `mobile.capture.import`
- App API endpoints discovered:
  - `POST /login`
  - `POST /orders`
  - `GET /orders/10086`
- Mobile screen artifacts: 4
- Product live surface: `mobile_device_state`

## Product UX loop verified

The front-end is now product-facing rather than infrastructure-facing:

- User pages: `Assessment`, `Findings`, `Reports`
- Internal infrastructure pages are archived and not routed as user features.
- Product state endpoint: `/api/ai-scans/:id/product-state`
- APK import endpoint: `/api/mobile/apps/import`
- The assessment page is driven by business functions, current work, live surface, and risk evidence.

## Remaining boundary

The bundled Android lab is deterministic/offline and validates the integration contract. Real APK + real Burp + real emulator execution uses the same adapters and must still pass the same tests in the deployment environment, especially HTTPS decryption and selector stability.
