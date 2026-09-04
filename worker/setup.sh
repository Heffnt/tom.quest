#!/usr/bin/env bash
# setup.sh — build (or rebuild) the Jarvis Box from a fresh Ubuntu 24.04
# ARM64 server. Run as root from inside a clone of the tom.quest repo:
#
#   git clone https://github.com/<owner>/tom.quest && cd tom.quest
#   bash worker/setup.sh
#
# THE NO-STATE RULE: the Jarvis Box owns no durable state. Everything that matters
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

echo "== [1/10] apt packages (curl, git, python3, gh) =="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates
# For the code-todo jobs: python3 + python3-yaml is the sanctioned YAML parser
# (the jobs shell out to it — the no-npm-deps rule leaves Node without one)
# and python3-pytest runs CMT's own guard tests before any push; gh opens the
# executor's PRs. apt-get install is a no-op when already present, so re-runs
# stay fast and idempotent.
apt-get install -y python3 python3-yaml python3-pytest gh

echo "== [2/10] Node 22 (NodeSource) =="
# Only (re)install if node is missing or not major version 22 — keeps re-runs
# fast and avoids needlessly touching apt sources.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" != "v22" ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "node: $(node -v)"

echo "== [3/10] Claude Code CLI =="
# npm -g install is idempotent (re-running upgrades to latest).
npm install -g @anthropic-ai/claude-code
echo "claude: $(claude --version || true)"

echo "== [4/10] Codex CLI (OpenAI) =="
# Codex is a first-class session runner on this box, not only a second opinion:
# a session whose model is one of the gpt-5.6-* names runs Codex instead of
# Claude, and every session can reach Codex through `tts-codex` (installed in
# step 7).
#
# PINNED ON PURPOSE. The copy bundled with the Codex desktop app is 0.130,
# which predates the gpt-5.6 model family and refuses those model names, so
# "whatever the desktop app ships" is not a floor this box can stand on.
# 0.153.3 is the npm release that knows gpt-5.6-sol / gpt-5.6-terra and carries
# the native subagent tool (spawn_agent) that the delegation rule in AGENTS.md
# depends on, and it has a linux-arm64 build, which this box needs. Moving the
# pin is a deliberate act: re-read the [agents] key names in the Codex config
# docs when you do, because they have been renamed across releases once already
# (agents.max_threads -> agents.max_concurrent_threads_per_session).
npm install -g @openai/codex@0.153.3
echo "codex: $(codex --version || true)"

# Config: written ONLY if absent, on the same rule as worker.env — a re-run
# must never clobber settings tuned by hand on the box.
if [ ! -f /root/.codex/config.toml ]; then
  mkdir -p /root/.codex
  cat > /root/.codex/config.toml <<'CODEXCFG'
# Codex on the Jarvis Box. Written once by worker/setup.sh; edit freely here.

# Auth lands in a plain file under /root/.codex rather than a desktop keyring:
# this box is headless and runs no keyring daemon at all.
cli_auth_credentials_store = "file"

# The fleet default (Tom, 2026-09-04): the strongest model at the highest
# reasoning effort. scripts/codex-run.mjs passes the same pair explicitly; this
# is what a bare `codex` and every session runner get.
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"

# No desktop notifier exists here, and an unanswered notify hook stalls a turn.
notify = []

# Native subagents. default_subagent_model is deliberately UNSET: a spawned
# agent inherits the parent's model unless the parent names a cheaper one
# (gpt-5.6-terra), which is exactly the delegation rule in AGENTS.md.
[agents]
max_concurrent_threads_per_session = 4
CODEXCFG
  echo "  wrote /root/.codex/config.toml"
else
  echo "  /root/.codex/config.toml already exists — left alone"
fi

# Login is interactive and cannot happen here; print where it stands so a
# rebuild does not discover it only when the first Codex session fails.
codex login status || echo "  codex is NOT logged in — see NEXT STEPS below"

echo "== [5/10] headless browser (Playwright + Chromium) =="
# A session that changes a tom.quest page can look at the result instead of
# asking Tom to look. Playwright is installed GLOBALLY (not as a repo dep) and
# its browsers land in /root/.cache/ms-playwright, so every session — each of
# which runs as root in its own throwaway workdir — sees the same Chromium
# without downloading 115MB per session.
#
# Deliberately NOT `playwright install --with-deps`: that path validates the
# host against a supported-distro list and hard-fails on Ubuntu 26.04. The
# plain download works, and the shared libraries Chromium needs are already
# pulled in by the apt line below. Keep them together — a missing libnss3 is
# reported by Chromium as an opaque launch failure, not as a missing package.
apt-get install -y \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 2>/dev/null || \
  echo "  (some Chromium libs unavailable under these package names; tts-browse will report if launch fails)"
npm install -g playwright
# Idempotent: re-downloads nothing when the pinned revision is already there.
npx playwright install chromium

echo "== [6/10] directories =="
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

echo "== [7/10] install worker files =="
# Job scripts (plain Node ESM, zero npm deps — a copy is a deploy).
cp "$WORKER_DIR"/jobs/*.mjs /opt/tts/
# The Codex wrapper is a repo script, not a job, but sessions need it from ANY
# repo — including checkouts that predate it, and repos that are not tom.quest
# at all. One copy here is what `tts-codex` executes, so the flags and the
# stdout contract have exactly one home (scripts/codex-run.mjs) whichever way a
# session reaches Codex.
cp "$WORKER_DIR"/../scripts/codex-run.mjs /opt/tts/codex-run.mjs
# CLI helpers onto the PATH.
cp "$WORKER_DIR"/bin/* /usr/local/bin/
chmod +x /usr/local/bin/tts-account /usr/local/bin/tts-browse \
  /usr/local/bin/tts-turing /usr/local/bin/tts-git-credential \
  /usr/local/bin/tts-codex

# GitHub credentials for sessions (ledger graduation sessions-cannot-open-prs,
# 2026-08-31). Two consumers, one source of truth (GH_TOKEN in worker.env):
#
#   git — the global credential.helper below. Clones and pushes use CLEAN
#     https URLs; the helper hands git the token at ask time, so no work tree
#     or `git remote -v` ever contains it.
#   gh  — /root/.config/gh/hosts.yml, REGENERATED from worker.env on every
#     run (a derived file, never hand-edited), so `gh pr create` works in a
#     session shell whose env is scrubbed of GH_TOKEN. The file sits outside
#     every work tree; reading /root paths from a session pays a classifier
#     verdict like any other box-configuration touch.
#
# Ordering note: session.mjs clones with clean URLs and RELIES on this
# helper — both roll out in the same setup.sh run, so there is no window
# where private-repo clones lack credentials.
#
# SYSTEM level (/etc/gitconfig), not --global: the daemon runs under systemd,
# which sets no HOME, and git only finds ~/.gitconfig through $HOME — the
# first post-rollout clones failed with "could not read Username" because the
# global entry was invisible to the service. /etc/gitconfig is read
# regardless. (A stray --global entry from the first rollout is removed so
# the fact has one home.)
git config --system credential.helper /usr/local/bin/tts-git-credential
git config --global --unset-all credential.helper 2>/dev/null || true
GH_TOKEN_VALUE="$(sed -n 's/^GH_TOKEN=//p' /etc/tts/worker.env 2>/dev/null | tail -1)"
if [ -n "$GH_TOKEN_VALUE" ]; then
  mkdir -p /root/.config/gh
  cat > /root/.config/gh/hosts.yml <<EOF
github.com:
    oauth_token: $GH_TOKEN_VALUE
    git_protocol: https
EOF
  chmod 600 /root/.config/gh/hosts.yml
  echo "  gh authenticated from worker.env (hosts.yml regenerated)"
else
  echo "  GH_TOKEN not set in /etc/tts/worker.env — gh stays unauthenticated"
  echo "  and private-repo clones will fail; fill it in and re-run setup.sh."
fi

# Env file: seed from the template ONLY if absent — a re-run must never
# clobber real secrets. Tighten permissions every time regardless.
if [ ! -f /etc/tts/worker.env ]; then
  cp "$WORKER_DIR/worker.env.example" /etc/tts/worker.env
  echo "  seeded /etc/tts/worker.env from template — FILL IT IN (see next steps)"
fi
chmod 600 /etc/tts/worker.env

echo "== [8/10] cron =="
# System cron runs in UTC and knows nothing about daylight saving, so
# prepare-queue is scheduled at BOTH 08:30 and 09:30 UTC; the script itself
# checks the New York wall-clock hour and proceeds only when it is the
# 4 a.m. NY hour — exactly one of the two slots, in every season.
# (4:30 NY chosen so the Convex fallback prep at 4:45 and the always-sends
# digest at 5:00 have a clean ordering after us.)
cat > /etc/cron.d/tts <<'CRON'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Poll the Slack #dump channel for new captures — HOURLY, as the reconciliation
# BACKSTOP behind the push route (Tom 2026-08-30: Slack pushes events to TTS at
# POST /slack/events instead of TTS polling). Slack's event delivery is
# best-effort, not guaranteed, so this stays: its cursor file in /var/lib/tts is
# what makes a missed event recoverable. Captures are idempotent on the Slack
# message ts server-side, so re-offering what the push route already took costs
# nothing.
7 * * * * root /usr/bin/node /opt/tts/poll-dump.mjs >> /var/log/tts/poll-dump.log 2>&1

# Poll Gmail for action-implying mail every 10 minutes (quiet no-op until the
# GMAIL_* keys exist in worker.env — see poll-gmail.mjs's header for the
# one-time credential mint). flock: the batch's Claude triage call can outlast
# a tick, and two overlapping runs would capture the same emails twice.
*/10 * * * * root /usr/bin/flock -n /var/lock/tts-poll-gmail.lock /usr/bin/node /opt/tts/poll-gmail.mjs >> /var/log/tts/poll-gmail.log 2>&1

# Poll Canvas course announcements every 30 minutes at :13/:43 (odd minutes;
# no collision with the other jobs' slots). Quiet no-op until CANVAS_TOKEN
# exists in worker.env (WPI token request pending). Same flock reasoning as
# poll-gmail: the Claude triage call can outlast a tick.
13,43 * * * * root /usr/bin/flock -n /var/lock/tts-poll-canvas.lock /usr/bin/node /opt/tts/poll-canvas.mjs >> /var/log/tts/poll-canvas.log 2>&1

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
#
# EVERY 2 MINUTES (Tom 2026-08-30: #dump messages are processed immediately, so
# the threaded Slack reply can state how TTS interpreted the message). Safe and
# cheap because the job returns BEFORE any Claude call when there is nothing to
# prepare ("if (targets.length === 0) return; // quiet when idle"), so an idle
# tick costs one HTTP read.
#
# CONSEQUENCE ACCEPTED, STATED: the old :37 slot existed so the Claude-calling
# jobs never shared a tick. At */2 this job can now overlap brief-code-todos
# (:17), form-batches (:07) and plan-graphs (:27). flock guards it only against
# ITSELF — which is also the lock poll-dump.mjs takes when it spawns this job
# straight after a capture, so the spawn and the cron can never both run.
*/2 * * * * root /usr/bin/flock -n /var/lock/tts-prepare-life-todos.lock /usr/bin/node /opt/tts/prepare-life-todos.mjs >> /var/log/tts/prepare-life-todos.log 2>&1

# ── THE BATCH PAIR, MID-CUTOVER (schema v2, 2026-08-29) ─────────────────────
# These two jobs are the OLD and the NEW way of doing the same thing, and they
# run side by side on purpose until the cutover.
#
#   form-batches.mjs  — the v1 batcher. A batch is a todo row carrying a list
#                       of `members` and an ordered plan.
#   plan-graphs.mjs   — the v2 PLANNER. A batch is its own row holding a GRAPH:
#                       goal todos (the end states it is for) and task todos
#                       (the work), wired by `needs` edges, so the todos whose
#                       needs are all done are the ready ones.
#
# They cannot collide, and the guard is the SERVER'S in both directions: it
# refuses a v1 batch that claims a row already inside a v2 batch, and it
# refuses to bind a row a live v1 batch claims as a v2 goal. (The planner's
# own filter is not that guard — it governs which ids are offered to the
# model, not which the model may emit.) Each job also consumes only its own
# revise rulings: v1 takes rulings whose subject is a members-bearing todo, v2
# takes rulings whose subject is a batch row, which exist only in v2.
#
# AT CUTOVER: delete the form-batches line below, and nothing else here.
# plan-graphs already sits in the slot that will be the only one left.

# v1 — Form batches (life + code todos grouped so one session with Tom advances
# many) via headless Claude, every 2 hours at :07 (:07 collides with nothing;
# :17/:37/:45 are taken). An input-hash cursor in /var/lib/tts/ makes
# unchanged-input runs no-ops, so most ticks cost no Claude call.
# REPLACED BY plan-graphs.mjs — remove this line at cutover.
7 */2 * * * root /usr/bin/node /opt/tts/form-batches.mjs >> /var/log/tts/form-batches.log 2>&1

# v2 — Maintain the graph inside every batch (goals, tasks, needs edges, the
# paths between batches) via headless Claude, every 2 hours at :27 (an odd
# minute of its own; :07/:17/:37/:45 are taken, and the offset from
# form-batches keeps the two Claude calls off the same tick). Its own
# input-hash cursor (/var/lib/tts/plan-input-hash) makes unchanged-input runs
# no-ops. This line REPLACES the form-batches line above at cutover.
27 */2 * * * root /usr/bin/node /opt/tts/plan-graphs.mjs >> /var/log/tts/plan-graphs.log 2>&1

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
# crude — these logs are debugging convenience, not state, and the Jarvis Box keeps
# nothing it can't lose.
0 6 1 * * root sh -c 'for f in /var/log/tts/*.log; do : > "$f"; done'
CRON
chmod 644 /etc/cron.d/tts

echo "== [9/10] session-host daemon =="
# The always-on daemon that runs interactive Claude Code sessions and streams
# them into Convex (worker/session-host/README.md). Unlike the cron jobs it
# carries the Jarvis Box's ONE sanctioned npm dependency (@anthropic-ai/
# claude-agent-sdk — pinned in its package.json), so this step also runs
# npm install in its install dir. Everything here is idempotent: cp + install
# + unit rewrite + restart is exactly how updated daemon code rolls out after
# a git pull.
mkdir -p /opt/tts/session-host
# worker-env.mjs in this glob is a SYMLINK to ../jobs/worker-env.mjs (the one
# env-file reader, shared with the cron jobs). Plain `cp` follows it, so the
# install dir gets a real file at a path the daemon's "./worker-env.mjs"
# import resolves — which a spelled-out ../jobs import could not, since jobs
# land flat in /opt/tts and this daemon lives one level down.
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
# systemd sets no HOME for system services. Every session shell inherits this
# env, and gh only finds its auth (/root/.config/gh/hosts.yml) through $HOME —
# without it `gh pr create` cannot see the credential setup.sh installed.
Environment=HOME=/root
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

echo "== [10/10] done =="
cat <<'STEPS'

NEXT STEPS (manual, in order):

  1. Fill in the secrets:
       nano /etc/tts/worker.env
     (CONVEX_SITE_URL, TTS_WORKER_KEY, SLACK_BOT_TOKEN, SLACK_DUMP_CHANNEL_ID,
      GH_TOKEN, SESSIONS_WORKER_KEY, TOMQUEST_AGENT_USERNAME,
      TOMQUEST_AGENT_PASSWORD — the file explains each one. If
      SESSIONS_WORKER_KEY was empty during this run, re-run setup.sh after
      filling it so the tts-session-host daemon gets enabled.)

     The two TOMQUEST_AGENT_* values are the tom.quest account a session's
     browser signs in as (tts-browse --login). They are LISTED HERE because
     leaving them blank fails quietly: the session-host runs, sessions start,
     and --login just refuses — a rebuilt box whose sessions can no longer
     look at their own work. The account must hold the `agent` role, which
     reads /turing and /tts and writes nothing; grant it from the Convex
     dashboard with users.setRoleByUsername({ username, role: "agent" }).
     Do NOT put Tom's own account here: everything the account can do, every
     session can do.

     TURING_READ_KEY is optional and READ-ONLY: it opens three GETs on the
     cluster API (/gpu-report, /jobs, /sessions/{name}/output) for the
     tts-turing command. It must match TURING_READ_KEY in turing-api/.env on
     the login node. The full TURING_API_KEY does NOT belong in this file —
     it authorizes POST /sessions/{name}/run, i.e. arbitrary cluster shell.
     Restart tts-session-host after adding it, or running sessions won't see
     it:  systemctl restart tts-session-host

  2. Log in both Claude Max accounts (interactive, over this SSH session —
     run it twice, switching the BROWSER profile between runs; each login is
     filed into the slot matching the account that actually signed in):
       tts-account login
       tts-account login

  3. Pick the account the jobs run under:
       tts-account use gmail

  4. Log Codex in (interactive, ONCE — sessions on this box start Codex only
     while `codex login status` says "Logged in"; until then every gpt-5.6-*
     session and every `tts-codex` call fails at the first turn):

       a. In ChatGPT (Tom's own browser): Settings -> Security -> turn ON
          "Allow device code login". Device auth is refused outright until
          that toggle is set, and the error does not say so.
       b. On this box:
            codex login --device-auth
          It prints a short code and a URL; open the URL in a browser, enter
          the code, approve. The credentials land in /root/.codex/auth.json.
       c. Confirm:
            codex login status

     IF DEVICE AUTH IS UNAVAILABLE, tunnel the browser callback instead —
     from YOUR machine:
       ssh -L 1455:localhost:1455 root@<this box>
     then, in that SSH session:
       codex login
     and open the printed localhost:1455 URL in your own browser.

     DO NOT COPY /root/.codex/auth.json FROM ANOTHER MACHINE. The refresh
     token rotates on use, so two machines sharing one auth file invalidate
     each other and both end up logged out. Log in on the box, on the box.

  5. Smoke-test the jobs by hand:
       node /opt/tts/poll-dump.mjs
       node /opt/tts/prepare-queue.mjs --force
       echo "Reply with exactly: pong" | tts-codex --effort low

  6. Check the session-host daemon (once SESSIONS_WORKER_KEY is set):
       systemctl status tts-session-host
       journalctl -u tts-session-host -f

Cron is already installed (/etc/cron.d/tts); logs land in /var/log/tts/.
Re-running this script at any time is safe and is also how you roll out
updated job scripts after a git pull.
STEPS
