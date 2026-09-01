# The Jarvis Box

The always-on home for TTS's scheduled headless-Claude jobs: a Hetzner CAX11
(Ubuntu 24.04, ARM64) running three personal-todo jobs and three code-todo jobs
on a schedule:

1. **poll-dump** (every 2 min) — reads new human messages from the Slack
   `#dump` channel and submits each one to Convex as an unprepared todo.
2. **poll-gmail** (every 10 min) — lists new inbox mail and spends ONE headless
   Claude call per batch deciding which messages imply an action by Tom, then
   submits each of those to Convex as an unprepared todo with source `email`
   (linked back to the thread). Judged from headers plus Gmail's ~100-character
   snippet only — v1 never downloads bodies — and the prompt leans toward
   capturing when unsure, because a wrong capture costs one archive click while
   a wrong skip loses the thread. Until the Gmail credentials exist it is a
   quiet no-op; see below.
3. **poll-canvas** (every 30 min) — lists new Canvas course announcements and
   spends ONE headless Claude call per batch deciding which imply an action
   by Tom (schedule changes, sign-ups, required responses), then submits
   those to Convex as unprepared todos with source `canvas`, linked to the
   announcement. Assignments are NOT this job's business — the Convex-side
   sync (convex/ttsCanvas.ts) owns those, with due dates and auto-done on
   submission. Quiet no-op until `CANVAS_TOKEN` exists in worker.env (WPI
   restricts token creation; Tom's request form is pending).
4. **prepare-queue** (4:30 a.m. New York) — runs headless Claude Code to pick
   today's queue (≤7 items) and write the daily digest, and posts both to
   Convex. If it fails, the Convex-side fallback prep (4:45) still writes the
   day's queue. The digest half of that split is OFF — Tom ruled outbound Slack
   off on 2026-08-29, so the 5 a.m. digest crons are unregistered
   (`convex/crons.ts:32-35`) and `sendDigest` returns on
   `OUTBOUND_SLACK_ENABLED = false`. The queue and digest text are still
   written and read in the app; nothing is sent, so there is no send-or-silence
   monitoring signal today.
5. **brief-code-todos** (every 2 h at :17) — see the ruling loop below.
6. **apply-rulings** (every 10 min) — see the ruling loop below.
7. **execute-approved** (hourly at :45) — see the ruling loop below.

## The code-todo ruling loop

CMT (`github.com/Heffnt/ComplexMultiTrigger`) keeps its standing intent in
`vqc/todos.yaml`; the Jarvis Box turns that file into rulings Tom can make from the
tom.quest UI in seconds:

- **brief-code-todos** refreshes a shallow cache clone of CMT, and for every
  OPEN todo entry whose YAML changed since its last brief (sha256 cursor in
  `/var/lib/tts/brief-hashes.json`), has headless Claude write a ground-up
  brief against the current tree and a recommendation — `propose-archive`
  (already done/moot, with evidence), `stale-replan` (intent live, plan
  stale), `needs-session` (open judgment call; all tier C), or `approve` —
  plus an exec class (`box` vs `needs-turing`). Briefs POST to Convex and are
  also cached locally under `/var/cache/tts/briefs/`.
- Tom rules on each brief in the UI; Convex queues the rulings.
- **apply-rulings** carries out the non-execution rulings: `defer` records
  it; `stale-replan` queues a re-brief that must propose a fresh plan;
  `needs-session` pushes a session-agenda file to CMT master; and
  `propose-archive` closes the entry in `vqc/todos.yaml` (text surgery, then
  CMT's own todos guard test — a red guard reverts and reports instead of
  pushing).
- **execute-approved** takes ONE pending `approve` per hour, runs agentic
  Claude in a throwaway full clone on a `tts/<id>` branch, verifies commits +
  the todos guard, pushes, and opens a PR. **Merging the PR is the human
  gate** — nothing lands on master autonomously.

To start a `needs-session` working session, from any CMT checkout:

```
claude "Run the TTS session in dev/handoff/tts-session-<id>.md"
```

## The browser

Every session on this box can open a real page. `setup.sh` step 4 installs
Playwright globally and downloads Chromium once into
`/root/.cache/ms-playwright`; because sessions run as root, they all share
that one copy rather than each pulling 115MB. The interface is a single
command:

```
tts-browse https://tom.quest/turing --out /tmp/t.png          # anonymous
tts-browse https://tom.quest/turing --login --full --json     # signed in
```

It prints the navigation status, the title, **console errors**, and **failed
or 4xx/5xx requests**, then writes a PNG the session reads back. The failed-
request line is the point: a recurring class of tom.quest bug is a request
that should never have been sent — an id still resolving, a placeholder path
segment — and this is what makes one visible instead of inferred.

`--login` signs in through the ordinary widget using
`TOMQUEST_AGENT_USERNAME` / `TOMQUEST_AGENT_PASSWORD`, and refuses to run
without them, because every `/turing` and `/tts` page is role-gated: browsing
one anonymously returns a 200 with 401s underneath, which reads as "page is
fine" to a session that only checked the status.

**Those two keys hold an account at role `agent`** — tom.quest's fourth role,
which exists for this and nothing else. It reads `/turing` and `/tts`; it
writes nothing anywhere; and it sees no other page, including `/sessions`,
`/forge`, `/jarvis` and `/canvas`. On `/turing` it gets the `GET` that lists
GPUs and jobs, but not the `POST` that allocates, the `DELETE` that cancels,
or the terminal's credential endpoint. The single list that defines the reach
is `convex/agentSurfaces.ts`; widening it is adding one name there.

So a Tom-only page browsed with `--login` shows the restricted card. That is
the correct result for this account, not a bug in the page.

The two names are **deleted from a session's shell** (`session.mjs` drops them
alongside `SESSIONS_WORKER_KEY` and `GH_TOKEN`), so no `env` or `echo` can
write the password into a transcript Convex stores forever; `tts-browse` reads
them back out of `/etc/tts/worker.env` itself, running as the same user. The
scrub and the narrow role are independent: the role means a leak costs little,
the scrub means there is nothing to leak.

These held Tom's own account as a knowing interim, ratified 2026-08-30, until
the `agent` role existed.

## The cluster, read-only

`ssh` exists on this box but `turing.wpi.edu` is not reachable from it, and the
session sandbox's command policy refuses to open a remote shell anyway. The one
door to the WPI Turing cluster is the HTTPS API at `turing.tom.quest`, and its
`TURING_API_KEY` opens everything there — including `POST /sessions/{name}/run`,
which types an arbitrary command into a tmux session under Tom's cluster
account. That key is **deliberately absent from `worker.env`** and stays absent.

Instead turing-api carries a **second credential**, `TURING_READ_KEY`
(`verify_read_key` in `turing-api/main.py`), which opens three GETs and nothing
else. `worker.env` holds that one, and one command spends it:

```
tts-turing health                    # is the API up (needs no key at all)
tts-turing gpus                      # GET /gpu-report
tts-turing jobs                      # GET /jobs
tts-turing output <session> [lines]  # GET /sessions/<name>/output
```

**There is no write verb, by construction** — no allocate, no cancel, no run,
no file read. A session that needs one of those asks Tom. Unlike the browser
credentials above, this key's blast radius is the four lines printed here.

The key is minted by Tom and must be installed on **both** sides — in
`/etc/tts/worker.env` here and in `turing-api/.env` on the cluster login node
(`secrets/turing-api.env.example`), each service restarted afterwards. Until
both have it, `tts-turing health` works and every other verb reports 401 with
that ambiguity spelled out. An unset `TURING_READ_KEY` on the API side is the
fail-closed state: the read door does not exist and the three endpoints stay
full-key-only.

## The no-state rule

**The Jarvis Box owns no durable state.** Everything that matters lives in Convex
(and, for code todos, in the CMT repo itself). The local files with memory
are all harmless to lose:

- `/var/lib/tts/dump-cursor` — Slack poll cursor; losing it re-captures up to
  24 hours of `#dump` messages as duplicates Tom can archive.
- `/var/lib/tts/gmail-cursor` — timestamp of the newest email poll-gmail has
  processed (captured or skipped); losing it re-examines the last 24 hours,
  at worst re-capturing a few emails as duplicates Tom can archive.
- `/var/lib/tts/canvas-announcements-cursor` — timestamp of the newest
  announcement poll-canvas has processed; losing it re-examines the last
  7 days, at worst re-capturing a few announcements as duplicates.
- `/var/lib/tts/brief-hashes.json` — which todo version was last briefed;
  losing it re-briefs everything once (the Convex POST upserts).
- `/var/cache/tts/` — rebuildable caches: the shallow CMT clone, the local
  brief copies, the executor's throwaway clones.

Losing the whole Jarvis Box loses nothing but a paused digest and some re-work.

## Rebuild from scratch

```
# 1. Create a Hetzner CAX11 (Ubuntu 24.04, ARM64), add the SSH key, log in as root.
# 2. On the Jarvis Box:
git clone https://github.com/<owner>/tom.quest
bash tom.quest/worker/setup.sh
# 3. Fill the secrets (the file documents each key):
nano /etc/tts/worker.env
# 4. Log in both Claude Max accounts (interactive), pick one:
# run twice, switching the BROWSER profile between runs — each login is
# filed into the slot matching the account that actually signed in
tts-account login
tts-account login
tts-account use gmail
# Done. Cron is installed; the digest resumes tomorrow at 5.
```

`setup.sh` is idempotent — re-running it is also how updated job scripts are
rolled out after a `git pull`.

## Gmail credentials (one-time)

poll-gmail needs three keys in `/etc/tts/worker.env` — `GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` — and skips every run until all
three are there, so the job ships and runs harmlessly ahead of them.

The client id and secret come from a "Desktop app" OAuth client in Tom's
Google Cloud console (any project, with the Gmail API enabled). The refresh
token is minted ONCE, on Tom's own machine rather than the Jarvis Box, because
approving it needs a browser:

```
node worker/jobs/gmail-auth.mjs <client_id> <client_secret>
```

It prints a Google URL, and after read-only Gmail access (`gmail.readonly`) is
approved it prints all three lines ready to paste into `worker.env`. The token
lasts until it is revoked at `myaccount.google.com/permissions`. The script's
own header carries the ten-minute console walkthrough.

## Switching Claude accounts

Jobs run under `CLAUDE_CONFIG_DIR=/root/.claude-accounts/active`, a symlink:

```
tts-account status       # which account is active
tts-account use wpi      # switch; takes effect on the next job run
```

## Testing jobs by hand

```
node /opt/tts/poll-dump.mjs               # capture anything new in #dump now
node /opt/tts/poll-gmail.mjs              # triage + capture new inbox mail now
node /opt/tts/poll-canvas.mjs             # triage + capture new announcements now
node /opt/tts/prepare-queue.mjs --force   # prep today's queue regardless of hour
node /opt/tts/brief-code-todos.mjs        # brief changed CMT todos now
node /opt/tts/brief-code-todos.mjs --force # re-brief EVERY open CMT todo
node /opt/tts/apply-rulings.mjs           # apply pending rulings now
node /opt/tts/execute-approved.mjs        # execute one approved plan now
```

`--force` skips the 4-a.m.-New-York hour guard (cron fires the prep at both
08:30 and 09:30 UTC and the guard keeps exactly the slot that is 4:30 a.m. NY,
whichever side of daylight saving we're on).

## Logs

Cron output: one `/var/log/tts/<job>.log` per job (poll-dump, poll-gmail,
prepare-queue, brief-code-todos, apply-rulings, execute-approved), truncated
monthly by cron — they are convenience, not state.
