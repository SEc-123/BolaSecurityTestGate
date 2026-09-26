# Android App End-to-End Security Testing Loop

This implementation adds an Android surface to BSTG without replacing the existing API Template, Workflow, Evidence Gate, Findings, Reports, or CI Gate layers.

## Product experience

The Assessment page now supports two surfaces:

- **Web/API**: the existing Playwright/browser-discovery path.
- **Android App**: a Mobile Lab path that shows Agent progress on the left and the current Android App state on the right.

For Android, the Agent loop is:

```text
mobile.lab.prepare
→ mobile.app.install
→ mobile.app.launch
→ mobile.observe
→ mobile.flow.run
→ mobile.capture.import
→ feature.extract_tree
→ vuln.generate_candidates
→ agent.shared_context.prepare
→ bstg.generic_vuln.run_test / workflow runner
→ native evidence gate
→ finding / report / CI gate
```

## Core design

Android automation is not Playwright DOM automation. It uses:

- **ADB + UIAutomator hierarchy** for observe/tap/input/swipe/back/wait.
- **Internal Burp bridge** for authorized HTTPS capture.
- **BSTG Recording importer** to turn App traffic into `recording_events`.
- **Existing BSTG API/Workflow runners** to perform mutation, replay, BOLA/BFLA/business-logic checks, and evidence validation.

This keeps the AI Agent as the orchestrator. The Agent does not invent confirmed findings from screenshots; it must import real HTTP evidence and pass the native BSTG evidence gate.

## Mobile Lab profile

Mobile Lab profiles are stored in `mobile_lab_profiles` and can be seeded through environment variables or API calls. A profile describes an already prepared Android lab:

```json
{
  "id": "android-burp-ready-default",
  "runtime_type": "local_avd",
  "android_api_level": 34,
  "adb_serial": "emulator-5554",
  "proxy_type": "internal_burp",
  "proxy_host": "127.0.0.1",
  "proxy_port": 8080,
  "certificate_mode": "preinstalled_system_ca",
  "config_json": {
    "burp_flow_export_path": "./mobile-lab/flows/latest-burp-flows.jsonl",
    "screen_stream_url": "http://127.0.0.1:7912"
  }
}
```

The recommended model is a **Burp-ready profile**: the Android emulator/snapshot already trusts the internal Burp CA, and each run only performs health checks. It does not reinstall certificates on every scan.

## HTTPS capture health gate

Before deep testing, BSTG checks:

1. ADB device is reachable.
2. Android global proxy points to the profile proxy.
3. Burp has decrypted HTTPS flows, or the session is still in the initial no-traffic state.
4. If only CONNECT/TLS metadata is observed, the session is blocked from confirmed API-level findings.

Statuses:

- `ready`: flows show decryptable App traffic.
- `warning`: lab is reachable but no traffic has been captured yet.
- `blocked`: ADB/proxy failed or TLS traffic is not decrypted.

## Burp bridge format

Your internal Burp integration can export HTTP history to JSON or JSONL. BSTG reads either format from `burp_flow_export_path` or accepts flows directly through the Mobile API.

Minimum flow object:

```json
{
  "method": "GET",
  "url": "https://api.example.test/orders/10086",
  "request_headers": { "authorization": "Bearer ..." },
  "response_status": 200,
  "response_headers": { "content-type": "application/json" },
  "response_body_text": "{\"order_id\":\"10086\"}",
  "tls_decrypted": true
}
```

The importer writes these flows into the existing `recording_sessions` and `recording_events` tables, then calls the existing regenerate path to create API/workflow drafts where possible.

## UI automation flow steps

For stable security regression, provide deterministic flow steps in Assessment → Android App → Flow steps JSON:

```json
[
  { "action": "tap", "target": { "text": "登录" } },
  { "action": "input", "target": { "resourceId": "com.example:id/email" }, "value": "victim@example.test" },
  { "action": "input", "target": { "resourceId": "com.example:id/password" }, "value": "Password123!" },
  { "action": "tap", "target": { "text": "登录" } },
  { "action": "tap", "target": { "text": "订单" } }
]
```

Supported actions:

- `tap` / `click`
- `input` / `type` / `fill`
- `swipe`
- `back`
- `wait`

Each action records a `mobile_actions` row and creates a `mobile_device_state` artifact so the UI can show the App screen.

## Safety boundary

This integration assumes an authorized lab. It does not implement certificate pinning bypass or third-party App interception tricks. For Android 9+ and production-like apps, use one of:

1. A security-test/debug APK that trusts the test CA via Network Security Config.
2. A prebuilt emulator/system image where the Burp CA is installed as a trusted system CA.
3. A pre-verified internal lab profile.

If HTTPS cannot be decrypted, BSTG can still show UI progress and metadata, but it must not create confirmed API-level BOLA/BFLA findings.
