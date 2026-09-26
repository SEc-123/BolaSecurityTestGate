#!/usr/bin/env bash
# Stops the deterministic offline Mobile Lab simulator if this kit started it.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pid_file="$root/run/mobile-lab-simulator.pid"

if [[ ! -f "$pid_file" ]]; then
  echo 'Offline Mobile Lab simulator is not running.'
  exit 0
fi

pid="$(cat "$pid_file")"
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid"
  echo "Stopped offline Mobile Lab simulator (PID $pid)."
else
  echo "Removed stale simulator PID file for PID $pid."
fi
rm -f "$pid_file"
