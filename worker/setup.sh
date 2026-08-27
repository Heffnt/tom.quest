#!/usr/bin/env bash
# setup.sh — build (or rebuild) the DTS worker box from a fresh Ubuntu 24.04
# ARM64 server. Run as root from inside a clone of the tom.quest repo:
#
#   git clone https://github.com/<owner>/tom.quest && cd tom.quest
#   bash worker/setup.sh
#
# THE NO-STATE RULE: this box owns no durable state. Everything that matters
# lives in Convex; the only local file with any memory at all is the Slack
# poll cursor under /var/lib/dts/ (losing it merely re-captures up to 24h of
# #dump messages as duplicates Tom can archive). Therefore this ONE script,
# plus filling the env file and logging in the two Claude accounts, is the
# complete rebuild procedure. It is idempotent — safe to re-run any time,
# including to roll out updated job scripts after a git pull.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "setup.sh must run as root" >&2
  exit 1
fi

# Directory this script lives in (the repo's worker/ dir), so copies below
# work no matter what the current working directory is.
WORKER_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== [1/7] apt packages (curl, git) =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates

echo "== [2/7] Node 22 (NodeSource) =="
# Only (re)install if node is missing or not major version 22 — keeps re-runs
# fast and avoids needlessly touching apt sources.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node -v)"

echo "== [3/7] Claude Code CLI =="
# npm -g install is idempotent (re-running upgrades to latest).
npm install -g @anthropic-ai/claude-code
echo "claude: $(claude --version || true)"

echo "== [4/7] directories =="
# /opt/dts            — the job scripts (copied from the repo, below)
# /var/lib/dts        — the ONLY local state: the Slack poll cursor
# /etc/dts            — worker.env (secrets; mode 600)
# /var/log/dts        — cron output
# /root/.claude-accounts/{gmail,wpi} — one Claude Code config dir per Max
#     account; an "active" symlink (managed by dts-account) picks which one
#     the jobs use.
mkdir -p /opt/dts /var/lib/dts /etc/dts /var/log/dts \
  /root/.claude-accounts/gmail /root/.claude-accounts/wpi

echo "== [5/7] install worker files =="
# Job scripts (plain Node ESM, zero npm deps — a copy is a deploy).
cp "$WORKER_DIR"/jobs/*.mjs /opt/dts/
# CLI helpers onto the PATH.
cp "$WORKER_DIR"/bin/* /usr/local/bin/
chmod +x /usr/local/bin/dts-account

# Env file: seed from the template ONLY if absent — a re-run must never
# clobber real secrets. Tighten permissions every time regardless.
if [ ! -f /etc/dts/worker.env ]; then
  cp "$WORKER_DIR/worker.env.example" /etc/dts/worker.env
  echo "  seeded /etc/dts/worker.env from template — FILL IT IN (see next steps)"
fi
chmod 600 /etc/dts/worker.env

echo "== [6/7] cron =="
# System cron runs in UTC and knows nothing about daylight saving, so
# prepare-queue is scheduled at BOTH 08:30 and 09:30 UTC; the script itself
# checks the New York wall-clock hour and proceeds only when it is the
# 4 a.m. NY hour — exactly one of the two slots, in every season.
# (4:30 NY chosen so the Convex fallback prep at 4:45 and the always-sends
# digest at 5:00 have a clean ordering after us.)
cat > /etc/cron.d/dts <<'CRON'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Poll the Slack #dump channel for new captures every 2 minutes.
*/2 * * * * root /usr/bin/node /opt/dts/poll-dump.mjs >> /var/log/dts/poll-dump.log 2>&1

# Prepare today's queue + digest via headless Claude. Two UTC slots because of
# US daylight saving; the script's NY-hour guard lets exactly one proceed
# (08:30 UTC = 4:30 a.m. EDT in summer; 09:30 UTC = 4:30 a.m. EST in winter).
# These hours are DERIVED from DTS_PREP_NY_HOUR (=4) in convex/dtsShared.ts as
# hour+4/hour+5 UTC — if the anchor hours ever move, THIS FILE and the guard in
# prepare-queue.mjs must move with them (no import path crosses this boundary).
30 8 * * * root /usr/bin/node /opt/dts/prepare-queue.mjs >> /var/log/dts/prepare-queue.log 2>&1
30 9 * * * root /usr/bin/node /opt/dts/prepare-queue.mjs >> /var/log/dts/prepare-queue.log 2>&1

# Log hygiene: truncate the DTS logs on the 1st of each month. Deliberately
# crude — these logs are debugging convenience, not state, and this box keeps
# nothing it can't lose.
0 6 1 * * root sh -c 'for f in /var/log/dts/*.log; do : > "$f"; done'
CRON
chmod 644 /etc/cron.d/dts

echo "== [7/7] done =="
cat <<'STEPS'

NEXT STEPS (manual, in order):

  1. Fill in the secrets:
       nano /etc/dts/worker.env
     (CONVEX_SITE_URL, DTS_WORKER_KEY, SLACK_BOT_TOKEN, SLACK_DUMP_CHANNEL_ID
      — the file explains each one.)

  2. Log in both Claude Max accounts (interactive, over this SSH session):
       dts-account login gmail
       dts-account login wpi

  3. Pick the account the jobs run under:
       dts-account use gmail

  4. Smoke-test the jobs by hand:
       node /opt/dts/poll-dump.mjs
       node /opt/dts/prepare-queue.mjs --force

Cron is already installed (/etc/cron.d/dts); logs land in /var/log/dts/.
Re-running this script at any time is safe and is also how you roll out
updated job scripts after a git pull.
STEPS
