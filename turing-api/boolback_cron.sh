#!/bin/bash
# Periodic boolback snapshot refresh. Triggers the running API's own submit_build
# (which sbatch-submits the build on a CPU compute node), so the served snapshot
# stays fresh without drift — naming/idempotency live in one place (Python).
#
# Install in the user crontab on ONE login node (system crond runs headless,
# independent of login sessions / systemd-user linger), e.g. every 2h:
#   0 */2 * * * $HOME/tom.quest/turing-api/boolback_cron.sh >> $HOME/.cache/boolback-snapshots/cron.log 2>&1
# submit_build coalesces against a marker file, so firing while a build is
# mid-flight returns that job instead of submitting a second one. That check is
# not atomic, so install this on ONE login node. Full write-up: spec.md §15.
set -u
ENVF="$HOME/tom.quest/turing-api/.env"

# Read one NAME=value out of the .env FILE (this script has no environment from
# crond and never sources the file, so a value with a space or a $ stays literal).
# Last assignment wins, matching how python-dotenv resolves a duplicated name.
env_value() {
  grep "^$1=" "$ENVF" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r\n '
}

KEY=$(env_value TURING_API_KEY)
# The port must come from the same .env the service binds from: main.py:30 reads
# API_PORT (default 8000), so hardcoding 8000 here silently posts to nothing the
# moment an operator takes that documented override. Unset or commented out in
# the file yields an empty string, and the default below has to match main.py's.
PORT=$(env_value API_PORT)
PORT=${PORT:-8000}
for dir in artifacts; do
  echo "[boolback_cron] $(date -Is) submit $dir (port $PORT)"
  # -m 45: submit_build takes ~31s when the done.json glob runs cold (observed
  # 2026-07-04 — a -m 30 timeout logs an EMPTY response while the server keeps
  # going, which reads identically to a dead API). Non-submit responses get a
  # loud WARN so the next debugger can tell the two apart from the log alone.
  resp=$(curl -s -m 45 -X POST -H "X-API-Key: $KEY" \
    "http://127.0.0.1:$PORT/boolback-snapshot?dir=$dir" || true)
  echo "$resp"
  case "$resp" in
    *'"submitted"'*) : ;;
    *) echo "[boolback_cron] WARN: submit for $dir got no/err response: '$resp'" ;;
  esac
done
