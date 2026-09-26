#!/usr/bin/env bash
# Starts the deterministic offline Mobile Lab simulator.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="$root/run"
pid_file="$run_dir/mobile-lab-simulator.pid"
log_file="$run_dir/mobile-lab-simulator.log"

mkdir -p "$run_dir"
source "$root/simulator/.env.offline-simulator"

if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "Offline Mobile Lab simulator is already running (PID $(cat "$pid_file"))."
  exit 0
fi

node "$root/simulator/mobile-lab-simulator.mjs" >"$log_file" 2>&1 &
echo $! >"$pid_file"

for _ in {1..20}; do
  if curl --silent --show-error --fail "http://127.0.0.1:${BSTG_SIMULATOR_PORT}/status" >/dev/null; then
    echo "Offline Mobile Lab simulator is ready at http://127.0.0.1:${BSTG_SIMULATOR_PORT}."
    exit 0
  fi
  sleep 0.2
done

echo "Simulator failed to become ready. See $log_file." >&2
exit 1
