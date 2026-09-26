# BSTG Mobile Lab

This folder contains sample assets for the Android App closed-loop implementation.

## Files

- `flows/example-login-order-flow.json`: deterministic App UI flow steps.
- `flows/example-burp-flow.jsonl`: sample decrypted Burp HTTP history in BSTG-compatible JSONL.

## Local profile environment variables

You can override the default Mobile Lab profile with environment variables before starting the server:

```bash
export BSTG_MOBILE_PROFILE_ID=android-burp-ready-default
export BSTG_ANDROID_SERIAL=emulator-5554
export BSTG_MOBILE_PROXY_HOST=127.0.0.1
export BSTG_MOBILE_PROXY_PORT=8080
export BSTG_BURP_FLOW_EXPORT_PATH="$PWD/mobile-lab/flows/latest-burp-flows.jsonl"
export BSTG_SCREEN_STREAM_URL=http://127.0.0.1:7912
```

The default profile assumes Burp CA/certificate trust was preconfigured in the emulator image or debug App build. Each scan only verifies the lab, configures the proxy, and imports decrypted flows.

## Verified offline E2E

This branch includes `mobile-lab/offline-kit/`, a minimal simulator package derived from the operator-provided offline Mobile Lab kit. Run:

```bash
npm run test:mobile-lab:offline-e2e
```

This verifies the complete App-side loop through the running BSTG server: Mobile Lab health, App observe/action, Burp HTTPS capture import, recording/workflow regeneration, Agent mobile tools, right-panel `mobile_device_state` artifacts, and discovered Android App endpoints.
