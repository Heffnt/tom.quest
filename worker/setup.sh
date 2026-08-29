#!/usr/bin/env bash
# setup.sh — build (or rebuild) the TTS worker box from a fresh Ubuntu 24.04
# ARM64 server. Run as root from inside a clone of the tom.quest repo:
#
#   git clone https://github.com/<owner>/tom.quest && cd tom.quest
#   bash worker/setup.sh
#
# THE NO-STATE RULE: this box owns no durable state. Everything that matters
# lives in Convex; the only local file with any memory at all is the Slack
# poll cursor under /var/lib/tts/ (losing it merely re-captures up to 24h of
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

echo "== [1/8] apt packages (curl, git, python3, gh) =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates
# For the code-todo jobs: python3 + python3-yaml is the sanctioned YAML parser
# (the jobs shell out to it — the no-npm-deps rule leaves Node without one)
# and python3-pytest runs CMT's own guard tests before any push; gh opens the
# executor's PRs. apt-get install is a no-op when already present, so re-runs
# stay fast and idempotent.
apt-get install -y python3 python3-yaml python3-pytest gh

echo "== [2/8] Node 22 (NodeSource) =="
# Only (re)install if node is missing or not major version 22 — keeps re-runs
# fast and avoids needlessly touching apt sources.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node -v)"

echo "== [3/8] Claude Code CLI =="
# npm -g install is idempotent (re-running upgrades to latest).
npm install -g @anthropic-ai/claude-code
echo "claude: $(claude --version || true)"

echo "== [4/8] directories =="
# /opt/tts            — the job scripts (copied from the repo, below)
# /var/lib/tts        — small local state: the Slack poll cursor, the
#     brief-hash cursor, and the apply/execute lock dirs (all harmless to
#     lose; see each job's header)
# /var/cache/tts      — rebuildable caches: the shallow CMT clone, the brief
#     markdown copies, and the executor's throwaway full clones
# /etc/tts            — worker.env (secrets; mode 600)
# /var/log/tts        — cron output
# /root/.claude-accounts/{gmail,wpi} — one Claude Code config dir per Max
#     account; an "active" symlink (managed by tts-account) picks which one
#     the jobs use.
mkdir -p /opt/tts /var/lib/tts /var/cache/tts /etc/tts /var/log/tts \
  /root/.claude-accounts/gmail /root/.claude-accounts/wpi

echo "== [5/8] install worker files =="
# Job scripts (plain Node ESM, zero npm deps — a copy is a deploy).
cp "$WORKER_DIR"/jobs/*.mjs /opt/tts/
# CLI helpers onto the PATH.
cp "$WORKER_DIR"/bin/* /usr/local/bin/
chmod +x /usr/local/bin/tts-account

# Env file: seed from the template ONLY if absent — a re-run must never
# clobber real secrets. Tighten permissions every time regardless.
if [ ! -f /etc/tts/worker.env ]; then
  cp "$WORKER_DIR/worker.env.example" /etc/tts/worker.env
  echo "  seeded /etc/tts/worker.env from template — FILL IT IN (see next steps)"
fi
chmod 600 /etc/tts/worker.env

echo "== [6/8] cron =="
# System cron runs in UTC and knows nothing about daylight saving, so
# prepare-queue is scheduled at BOTH 08:30 and 09:30 UTC; the script itself
# checks the New York wall-clock hour and proceeds only when it is the
# 4 a.m. NY hour — exactly one of the two slots, in every season.
# (4:30 NY chosen so the Convex fallback prep at 4:45 and the always-sends
# digest at 5:00 have a clean ordering after us.)
cat > /etc/cron.d/tts <<'CRON'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Poll the Slack #dump channel for new captures every 2 minutes.
*/2 * * * * root /usr/bin/node /opt/tts/poll-dump.mjs >> /var/log/tts/poll-dump.log 2>&1

# Read Tom's freeform TIME NOTES (the only time input left on the /tts page)
# and turn each into concrete date/block changes, every 2 minutes so a note he
# types is acted on while he is still looking at the page. The queue is
# normally empty and the job exits before spending a Claude call.
# flock -n: a run that waits on Claude can outlast the 2-minute tick, and two
# runs would read the same pending notes and apply them TWICE. The second one
# exits immediately instead (no -w: there is nothing to wait for, the next tick
# is 2 minutes away).
*/2 * * * * root /usr/bin/flock -n /var/lock/tts-apply-time-notes.lock /usr/bin/node /opt/tts/apply-time-notes.mjs >> /var/log/tts/apply-time-notes.log 2>&1

# Prepare today's queue + digest via headless Claude. Two UTC slots because of
# US daylight saving; the script's NY-hour guard lets exactly one proceed
# (08:30 UTC = 4:30 a.m. EDT in summer; 09:30 UTC = 4:30 a.m. EST in winter).
# These hours are DERIVED from TTS_PREP_NY_HOUR (=4) in convex/ttsShared.ts as
# hour+4/hour+5 UTC — if the anchor hours ever move, THIS FILE and the guard in
# prepare-queue.mjs must move with them (no import path crosses this boundary).
30 8 * * * root /usr/bin/node /opt/tts/prepare-queue.mjs >> /var/log/tts/prepare-queue.log 2>&1
30 9 * * * root /usr/bin/node /opt/tts/prepare-queue.mjs >> /var/log/tts/prepare-queue.log 2>&1

# CODE-TODO RULING LOOP (CMT's vqc/todos.yaml -> briefs -> Tom rules -> apply/execute):

# Brief open CMT code todos via headless Claude, every 2nd hour at :17 (an
# odd minute so it never collides with the other jobs' slots). Incremental —
# only entries whose YAML changed since their last brief are re-briefed
# (hash cursor in /var/lib/tts/brief-hashes.json), so most runs are no-ops.
17 */2 * * * root /usr/bin/node /opt/tts/brief-code-todos.mjs >> /var/log/tts/brief-code-todos.log 2>&1

# Prepare unprepared LIFE todos (#dump captures, consolidation candidates)
# via headless Claude: ground-up brief + smallest entry action + work
# description, readiness advanced — so raw captures reach Tom pre-chewed.
# Every 2nd hour at :37 (odd minute; no collision with the other jobs).
37 */2 * * * root /usr/bin/node /opt/tts/prepare-life-todos.mjs >> /var/log/tts/prepare-life-todos.log 2>&1

# Form batches (life + code todos grouped so one session with Tom advances
# many) via headless Claude, every 6 hours at :07 (:07 collides with nothing;
# :17/:37/:45 are taken). An input-hash cursor in /var/lib/tts/ makes
# unchanged-input runs no-ops, so most ticks cost no Claude call.
7 0,6,12,18 * * * root /usr/bin/node /opt/tts/form-batches.mjs >> /var/log/tts/form-batches.log 2>&1

# Apply Tom's non-execution rulings (defer / stale-replan / needs-session /
# propose-archive) every 10 minutes, so a ruling made in the UI takes effect
# within minutes. The job serializes itself via /var/lib/tts/apply.lock —
# overlapping cron ticks exit immediately instead of double-applying.
*/10 * * * * root /usr/bin/node /opt/tts/apply-rulings.mjs >> /var/log/tts/apply-rulings.log 2>&1

# Execute ONE approved plan per hour at :45 (agentic Claude in a throwaway
# clone, 45-min cap, PR as output — merging the PR is the human gate). One
# per hour bounds Claude usage and keeps PRs reviewable in series;
# /var/lib/tts/execute.lock (stale after 3h) stops overlap.
45 * * * * root /usr/bin/node /opt/tts/execute-approved.mjs >> /var/log/tts/execute-approved.log 2>&1

# Log hygiene: truncate the TTS logs on the 1st of each month. Deliberately
# crude — these logs are debugging convenience, not state, and this box keeps
# nothing it can't lose.
0 6 1 * * root sh -c 'for f in /var/log/tts/*.log; do : > "$f"; done'
CRON
chmod 644 /etc/cron.d/tts

echo "== [7/8] session-host daemon =="
# The always-on daemon that runs interactive Claude Code sessions and streams
# them into Convex (worker/session-host/README.md). Unlike the cron jobs it
# carries the box's ONE sanctioned npm dependency (@anthropic-ai/
# claude-agent-sdk — pinned in its package.json), so this step also runs
# npm install in its install dir. Everything here is idempotent: cp + install
# + unit rewrite + restart is exactly how updated daemon code rolls out after
# a git pull.
mkdir -p /opt/tts/session-host
cp "$WORKER_DIR"/session-host/*.mjs "$WORKER_DIR"/session-host/package.json \
  /opt/tts/session-host/
(cd /opt/tts/session-host && npm install --omit=dev)

cat > /etc/systemd/system/tts-session-host.service <<'UNIT'
[Unit]
Description=TTS session-host (Claude Code sessions bridged to Convex)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /opt/tts/session-host/session-host.mjs
WorkingDirectory=/opt/tts/session-host
EnvironmentFile=/etc/tts/worker.env
Environment=CLAUDE_CONFIG_DIR=/root/.claude-accounts/active
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
# Only enable the daemon once its key exists — a daemon started with an empty
# SESSIONS_WORKER_KEY would just spin on 503s. On re-runs (key present) the
# restart is what rolls out freshly copied code.
if grep -Eq '^SESSIONS_WORKER_KEY=.+' /etc/tts/worker.env; then
  systemctl enable tts-session-host
  systemctl restart tts-session-host
  echo "  tts-session-host enabled + (re)started"
else
  echo "  SESSIONS_WORKER_KEY not set in /etc/tts/worker.env — tts-session-host"
  echo "  NOT enabled. Fill it in, then re-run this script (or:"
  echo "  systemctl enable --now tts-session-host)."
fi

echo "== [8/8] done =="
cat <<'STEPS'

NEXT STEPS (manual, in order):

  1. Fill in the secrets:
       nano /etc/tts/worker.env
     (CONVEX_SITE_URL, TTS_WORKER_KEY, SLACK_BOT_TOKEN, SLACK_DUMP_CHANNEL_ID,
      GH_TOKEN, SESSIONS_WORKER_KEY — the file explains each one. If
      SESSIONS_WORKER_KEY was empty during this run, re-run setup.sh after
      filling it so the tts-session-host daemon gets enabled.)

  2. Log in both Claude Max accounts (interactive, over this SSH session):
       tts-account login gmail
       tts-account login wpi

  3. Pick the account the jobs run under:
       tts-account use gmail

  4. Smoke-test the jobs by hand:
       node /opt/tts/poll-dump.mjs
       node /opt/tts/prepare-queue.mjs --force

  5. Check the session-host daemon (once SESSIONS_WORKER_KEY is set):
       systemctl status tts-session-host
       journalctl -u tts-session-host -f

Cron is already installed (/etc/cron.d/tts); logs land in /var/log/tts/.
Re-running this script at any time is safe and is also how you roll out
updated job scripts after a git pull.
STEPS
