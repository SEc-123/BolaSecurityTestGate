# Visual Account + Auth Coverage Iteration

This iteration closed the gaps raised in review:

## Implemented

- Expanded vulnerability coverage beyond the original fixed set:
  - `email_sms_bypass` for SMS/email OTP, captcha, verification-ticket reuse, weak/empty code and cross-account verification bypass.
  - `passcode_bypass` for pay password, trading password, PIN/passcode, omitted passcode, weak/default passcode and verification state reuse.
- Added account acquisition modes to scan configuration and UI:
  - Manual attacker/victim/admin account JSON.
  - Raw HTTP request packet parsing into identity material: Authorization, Cookie, username, email, mobile, user_id, role, token, csrf, otp/code/passcode fields.
  - Autonomous/browser-assisted registration mode with `human_input_request` artifacts for phone/email/SMS/OTP/passcode blocking points.
- Extended cross-agent shared context:
  - `identity_acquisition_plan`
  - richer `identity_pool`
  - `workflow_blueprint/canonical-login-session-flow`
  - `session_strategy`
  - `object_inventory` with OTP/passcode/ticket fields
  - shared `payload_plan` for auth/passcode classes
- Added visual sub-agent state artifacts:
  - `browser_agent_state` per executable sub-agent.
  - UI renders multi-browser/sub-agent panels on the right side, showing each agent's current URL/endpoint/action and screenshot when available.
- Added Codex-like UI enhancements:
  - account input mode selector
  - parallel-agent configuration
  - shared-resource panel
  - multi-browser/sub-agent visual grid
- Added test target routes and blackbox harness support for:
  - SMS/email code sending/verification
  - OTP bypass
  - passcode/pay password bypass

## Verification

Commands executed:

```bash
npm --prefix server run typecheck
npm run typecheck
npm --prefix server run build
npm run build:frontend
npm run test:ai-scan:e2e
TARGET_SOURCE_DIR=/mnt/data/runcheck/laravel_src npm run test:ai-scan:laravel-blackbox
```

Local vulnerable target:

- endpoints discovered: 25
- candidate types include `email_sms_bypass` and `passcode_bypass`
- tasks completed: 51/51
- findings: 21
- `browser_agent_state`: 23
- `identity_acquisition_plan`: 1
- raw request account material parsed into `identity_pool`: yes
- `human_input_request`: 2

Laravel route-derived target:

- routes parsed: 420
- endpoints discovered: 188
- candidate types include `email_sms_bypass` and `passcode_bypass`
- tasks completed: 50/50
- findings: 22
- `browser_agent_state`: verified by test assertions
- raw request account material parsed into `identity_pool`: verified
- `human_input_request`: verified

## Remaining production hardening

- Replace HTTP-fallback visual state with persistent Playwright browser contexts for every sub-agent when Playwright is installed.
- Add websocket/SSE streaming so the browser panels update live rather than via refresh polling.
- Strengthen evidence policies for each vulnerability type with automatic follow-up proof tasks.
