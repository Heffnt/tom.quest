#!/bin/bash
# Periodic boolback snapshot refresh. Triggers the running API's own submit_build
# (which sbatch-submits the build on a CPU compute node), so the served snapshot
# stays fresh without drift — naming/idempotency live in one place (Python).
#
# Install in the user crontab on ONE login node (system crond runs headless,
# independent of login sessions / systemd-user linger), e.g. every 2h:
#   0 */2 * * * $HOME/tom.quest/turing-api/boolback_cron.sh >> $HOME/.cache/boolback-snapshots/cron.log 2>&1
# submit_build coalesces, so even if this fires on a node whose build is mid-flight
# it will not double-submit.
set -u
ENVF="$HOME/tom.quest/turing-api/.env"
KEY=$(grep '^TURING_API_KEY=' "$ENVF" | cut -d= -f2- | tr -d '\r\n ')
for dir in artifacts; do
  echo "[boolback_cron] $(date -Is) submit $dir"
  # -m 45: submit_build takes ~31s when the done.json glob runs cold (observed
  # 2026-07-04 — a -m 30 timeout logs an EMPTY response while the server keeps
  # going, which reads identically to a dead API). Non-submit responses get a
  # loud WARN so the next debugger can tell the two apart from the log alone.
  resp=$(curl -s -m 45 -X POST -H "X-API-Key: $KEY" \
    "http://127.0.0.1:8000/boolback-snapshot?dir=$dir" || true)
  echo "$resp"
  case "$resp" in
    *'"submitted"'*) : ;;
    *) echo "[boolback_cron] WARN: submit for $dir got no/err response: '$resp'" ;;
  esac
done
