#!/usr/bin/env bash
set -euo pipefail

AVD_NAME="${BSTG_ANDROID_AVD_NAME:-Pixel_API_34_BurpReady}"
PROXY_HOST="${BSTG_MOBILE_PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${BSTG_MOBILE_PROXY_PORT:-8080}"
EMULATOR_BIN="${BSTG_EMULATOR_BIN:-emulator}"
ADB_BIN="${BSTG_ADB_BIN:-adb}"

if ! command -v "$EMULATOR_BIN" >/dev/null 2>&1; then
  echo "emulator binary not found. Set BSTG_EMULATOR_BIN." >&2
  exit 1
fi
if ! command -v "$ADB_BIN" >/dev/null 2>&1; then
  echo "adb binary not found. Set BSTG_ADB_BIN." >&2
  exit 1
fi

echo "Starting AVD $AVD_NAME with proxy $PROXY_HOST:$PROXY_PORT"
"$EMULATOR_BIN" @"$AVD_NAME" -http-proxy "http://$PROXY_HOST:$PROXY_PORT" >/tmp/bstg-mobile-avd.log 2>&1 &

"$ADB_BIN" wait-for-device
"$ADB_BIN" shell settings put global http_proxy "$PROXY_HOST:$PROXY_PORT" || true
"$ADB_BIN" shell settings get global http_proxy || true

echo "Mobile Lab AVD is online. Run BSTG Assessment with surface=Android."
