#!/usr/bin/env bash
# Runs e2e/terminal-surfaces.spec.ts, the check that opens both Turing terminal
# surfaces against a real tmux session and compares connecting, resizing and one
# forced reconnect on each.
#
# It stands up everything the check needs on this machine: a copy of turing-api/
# on a local port with a throwaway API key, and a Next.js dev server wired to
# that copy with the terminal-modal test route turned on. Nothing here touches
# the Turing cluster, Vercel or the Convex deployment, and the key it invents
# never leaves this machine.
#
#   scripts/terminal-surfaces-live.sh
#
# Requirements: tmux, a Python with fastapi, uvicorn and websockets, pnpm
# install already run, a .env.local holding NEXT_PUBLIC_CONVEX_URL (the app
# refuses to start without it), and a Playwright Chromium. If Playwright cannot
# install a browser for this Linux release, install one another way and export
# E2E_CHROMIUM_PATH pointing at it. The TURING_API_URL and TURING_API_KEY this
# script exports win over whatever .env.local holds, so a real cluster key in
# that file is not used and not reachable from the check.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${TERMINAL_LIVE_API_PORT:-8899}"
WEB_PORT="${TERMINAL_LIVE_WEB_PORT:-3000}"
API_KEY="local-terminal-check-$(date +%s)"
api_pid=""
web_pid=""

cleanup() {
  [ -n "$web_pid" ] && kill "$web_pid" 2>/dev/null || true
  [ -n "$api_pid" ] && kill "$api_pid" 2>/dev/null || true
  tmux kill-session -t e2e-terminal-modal 2>/dev/null || true
  tmux kill-session -t e2e-terminal-page 2>/dev/null || true
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2" i
  for i in $(seq 1 60); do
    if curl -sf -m 2 -o /dev/null "$url"; then return 0; fi
    sleep 1
  done
  echo "$name did not come up at $url" >&2
  return 1
}

# turing-api forks "tmux attach-session" into a pseudo-terminal and inherits its
# own environment; with TERM unset tmux refuses to attach.
echo "Starting turing-api on 127.0.0.1:$API_PORT"
(
  cd "$ROOT/turing-api"
  TERM=xterm-256color TURING_API_KEY="$API_KEY" \
    python3 -m uvicorn main:app --host 127.0.0.1 --port "$API_PORT" \
    >/tmp/terminal-surfaces-api.log 2>&1
) &
api_pid=$!
wait_for "http://127.0.0.1:$API_PORT/health" "turing-api"

echo "Starting Next.js on 127.0.0.1:$WEB_PORT"
(
  cd "$ROOT"
  TURING_API_URL="http://127.0.0.1:$API_PORT" TURING_API_KEY="$API_KEY" \
    TERMINAL_HARNESS=1 \
    pnpm exec next dev --port "$WEB_PORT" >/tmp/terminal-surfaces-web.log 2>&1
) &
web_pid=$!
wait_for "http://127.0.0.1:$WEB_PORT/" "Next.js"

echo "Running the check"
cd "$ROOT"
E2E_TERMINAL_LIVE=1 \
  TURING_API_URL="http://127.0.0.1:$API_PORT" TURING_API_KEY="$API_KEY" \
  PLAYWRIGHT_WEBSERVER_COMMAND="echo reusing the server this script started" \
  pnpm exec playwright test e2e/terminal-surfaces.spec.ts --project=chromium --workers=1
