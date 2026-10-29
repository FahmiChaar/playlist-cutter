#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8765}"
export HOME="$(mktemp -d)"
export PATH="$ROOT/tests/bin:$PATH"
python "$ROOT/app.py" --port "$PORT" > "$HOME/server.log" 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true' EXIT
for _ in $(seq 40); do
  curl -sf "http://localhost:$PORT/api/job" > /dev/null && break
  sleep 0.5
done
python "$ROOT/tests/check.py" "$PORT"
