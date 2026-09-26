# Android Mobile Lab verified offline E2E loop

This branch contains a working Android Mobile Lab adapter that closes the loop from App UI automation to BSTG native recording/workflow assets.

## Verified command

```bash
npm run test:mobile-lab:offline-e2e
```

The test uses `mobile-lab/offline-kit/`, a deterministic Appium/Burp-compatible simulator extracted from the operator-provided offline Mobile Lab package. It does not require a real APK, Android SDK, Burp licence, or CA private key.

The command performs the following real project calls against the built BSTG server:

1. Starts the offline Mobile Lab simulator at `http://127.0.0.1:4723`.
2. Starts BSTG with an isolated SQLite data directory.
3. Resolves the default Mobile Lab profile from environment variables.
4. Creates a mobile session.
5. Runs `/api/mobile/sessions/:id/start` and verifies `https_decrypted` capture health.
6. Runs `/api/mobile/sessions/:id/observe` and receives screenshot + UI tree.
7. Runs `/api/mobile/sessions/:id/action` through the Appium-compatible simulator.
8. Runs `/api/mobile/sessions/:id/import-capture` and imports three HTTPS Burp flows into `recording_events`.
9. Regenerates recording artifacts and verifies at least one workflow draft.
10. Creates an Android `AI Scan` with `scan_config.surface = android`.
11. Runs the Agent loop and verifies these tools completed:
    - `mobile.lab.prepare`
    - `mobile.app.install`
    - `mobile.app.launch`
    - `mobile.observe`
    - `mobile.flow.run`
    - `mobile.capture.import`
12. Verifies `mobile_device_state` artifacts and discovered App endpoints:
    - `POST /login`
    - `POST /orders`
    - `GET /orders/10086`

A successful run prints JSON similar to:

```json
{
  "ok": true,
  "mobile_api_loop": {
    "health": "https_decrypted",
    "ui_nodes": 3,
    "imported_flows": 3,
    "workflow_draft_count": 1
  },
  "agent_loop": {
    "completed_tools": [
      "mobile.flow.run",
      "mobile.capture.import",
      "mobile.lab.prepare",
      "mobile.app.install",
      "mobile.app.launch",
      "mobile.observe"
    ],
    "endpoint_count": 3,
    "mobile_device_artifacts": 4
  }
}
```

## Real lab mode

For a real Android/Burp lab, keep the same BSTG code path and change only the profile environment:

```bash
export BSTG_MOBILE_OFFLINE_SIMULATOR=false
export BSTG_MOBILE_ADB_PATH=/path/to/adb
export BSTG_MOBILE_ADB_SERIAL=emulator-5554
export BSTG_MOBILE_APPIUM_URL=http://127.0.0.1:4723
export BSTG_MOBILE_PROXY_HOST=127.0.0.1
export BSTG_MOBILE_PROXY_PORT=8080
export BSTG_BURP_CAPTURE_URL=http://127.0.0.1:<your-burp-bridge-port>/bstg/mobile/capture
# or export BSTG_BURP_FLOW_EXPORT_PATH=/path/to/burp-history.jsonl
```

The real lab must already be authorized and preconfigured:

- the disposable emulator/device is under your control;
- Burp/proxy CA is already trusted by the App test build or test lab image;
- HTTPS capture is verified before deep testing;
- Burp history is available as JSON/JSONL or through the capture bridge.

BSTG does not bypass certificate pinning. If HTTPS request/response bodies are not decrypted, the Mobile Lab health gate blocks deep API/workflow testing instead of producing a confirmed finding.
