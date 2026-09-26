#!/usr/bin/env bash
# Node performs typed JSON handling and calls product APIs; no direct ADB shortcut.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec node "$ROOT_DIR/scripts/mobile-lab/run-real-android-e2e.mjs"
