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
   Convex. If it fails, the Convex-side fallback prep (4:45) and the
   always-sends 5 a.m. digest cover the day — a digest that reports missing
   prep is the "worker is broken" signal; no digest at all means Convex/Slack
   is broken. That split is the whole monitoring story.
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

**Those two keys hold Tom's own account** (ratified 2026-08-30), so every
session browses at role `tom`. Nothing scrubs them from a session's shell —
`session.mjs` drops exactly `SESSIONS_WORKER_KEY` and `GH_TOKEN` and inherits
the rest — so the account's role is the role every session holds. This is a
knowing interim: no other account exists yet, and a session that cannot see
`/turing` cannot check its own work there. A session account with a narrower
role is a captured TTS todo.

**Not installed: any path from this box to the Turing cluster.** `ssh` exists
but `turing.wpi.edu` is not reachable from here, and the session sandbox's own
command policy refuses to open a remote shell. The cluster is reachable only
as the HTTPS API at `turing.tom.quest`, and that API's key would grant
`POST /sessions/{name}/run` — arbitrary commands on the cluster — so it is
deliberately absent from `worker.env`. Adding it is a posture decision, not a
setup step.

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
  brief copies, the executor's throwaway clones. None of them holds a
  credential: every clone here uses a clean `https://github.com/...` URL and
  authenticates through `/usr/local/bin/tts-git-credential` (see the GitHub
  credentials section in `session-host/README.md`). CMT is private, so these
  jobs refuse to run when that helper is missing rather than fail inside git.

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
tts-account login gmail
tts-account login wpi
tts-account use gmail
# Done. Cron is installed; the digest resumes tomorrow at 5.
```

`setup.sh` is idempotent — re-running it is also how updated job scripts are
rolled out after a `git pull`.

### What re-running setup.sh costs on a live box

Its last step restarts the session-host daemon, and that is not free. The
daemon holds every live session inside its own process. When the new process
adopts the session rows afterwards, an **interactive** session survives as
idle with a transcript line saying its turn was interrupted, but an
**autonomous** session is ended — outcome `errored`, summary "daemon restarted
mid-mission" — and its work tree is deleted, because there is no Tom to send
it the next turn. Anything it had not committed and pushed is gone; the
scheduler's backoff owns the retry. Run `setup.sh` when the fleet is quiet.

GitHub credentials are the one part of the box that needs no restart, so they
have their own script and `setup.sh` calls it:

```
bash tom.quest/worker/install-git-credentials.sh          # install / re-install
bash tom.quest/worker/install-git-credentials.sh --check   # report only, no secret printed
bash tom.quest/worker/install-git-credentials.sh --verify-clean-url
                                                           # can the daemon's git authenticate?
```

It installs `/usr/local/bin/tts-git-credential`, registers it as git's
**system** credential helper (`git config --system`, i.e. `/etc/gitconfig` —
not `--global`, because the daemon runs with no `HOME` and could not read a
per-user config), and regenerates `gh`'s credential file at
`/root/.config/gh/hosts.yml` from `GH_TOKEN` in `worker.env`. Every git or gh
process started afterwards picks all of it up, including the sessions already
running, since each command a session runs is a fresh process.

Run it BEFORE `setup.sh` when rolling the clean-URL change out to a box that
does not have it yet. Until the new daemon and job code are deployed the box
still clones with the token in the remote URL, and git prefers a credential
embedded in the URL over any helper, so installing the helper early changes
nothing that already works. The other order fails: clean-URL code on a box
with no helper cannot clone ComplexMultiTrigger, which is private and which
every session clones, and cannot push to either repository. (Measured
2026-09-01: an unauthenticated API read of ComplexMultiTrigger returns 404 and
an anonymous `ls-remote` of it fails, while tom.quest returns 200 and clones
anonymously — tom.quest is public, so only its pushes need the credential.)

`--verify-clean-url` is that failure turned into a check. It reads
ComplexMultiTrigger through a clean URL with `HOME` removed from the
environment, which is how the daemon's git runs, and `setup.sh` calls it right
after the install — before the scrub, and long before the daemon restart in
step 8. A non-zero exit stops the deploy. Two branches, because two situations
look the same to a bare read failure: with a token set in `worker.env` the
credential path is broken and the deploy must not continue, while with no token
set the box is simply not finished being built, so the check says what is
missing and lets the install run on. `TTS_SKIP_CLEAN_URL_CHECK=1` deploys
anyway, for a rebuild while GitHub itself is unreachable.

Why the check drops `HOME` rather than trusting the daemon's `HOME=/root`: a
helper registered with `git config --global` writes `$HOME/.gitconfig`, works
for the person running `setup.sh`, and is invisible to a service started
without a `HOME`. Dropping `HOME` is what tells those two states apart.
Measured on the Jarvis Box 2026-09-01 00:44 UTC, this is not hypothetical —
`main` was in exactly that state: `session.mjs` there already clones with clean
URLs, `/etc/gitconfig` held no `credential.helper` at all (only the git-lfs
filters), the running daemon's environment had no `HOME`, and an anonymous
clean-URL read of both private repositories failed with "could not read
Username". Deploying `main` as it stood would have restarted the daemon onto
clean-URL code with nothing able to authenticate, which stops every session
start on the box.

### Rotating the GitHub token

```
bash tom.quest/worker/rotate-github-token.sh --audit   # read-only report
bash tom.quest/worker/rotate-github-token.sh           # install a new token
```

The script reads the new token from stdin — never from an argument, which
`ps` can read — checks it against both repositories BEFORE writing anything,
replaces only the `GH_TOKEN` line of `/etc/tts/worker.env` by atomic rename,
leaves no backup copy of the old value, re-runs `install-git-credentials.sh`
so `gh`'s file is regenerated, and restarts nothing.

Revoke the old token LAST, not first. Three consumers pick a new value up at
different moments: the cron jobs read `worker.env` once per run (live at the
next tick), the git credential helper re-reads it on every git request (live
immediately), but the session-host daemon calls `loadEnv()` once in `main()`
and keeps that object for its whole life. On a box still running the
tokenised-URL code the daemon therefore writes the value it read at startup
into every session clone's remote URL, and keeps using it until it is
restarted — which ends every live autonomous session. Measured 2026-09-01:
when a remote URL carries a credential and GitHub rejects it, git calls the
credential helper with `erase` and never with `get`, so a helper does not
rescue a checkout whose URL holds a revoked token. Revoking first would break
every live session's push and every new private-repo clone until the daemon
restarted.

The order that costs nothing: create the replacement while the old token is
still valid → run this script → deploy the clean-URL code with `setup.sh` at a
quiet moment → run `--audit` until it reports that nothing on the box still
authenticates with an older token → then revoke the old one in GitHub. The
audit prints the deployed code's state and every `.git/config` on the box that
still carries a credential in its remote URL (paths only, never contents); it
exits non-zero while any of them remain.

### Clearing the token copies that already exist

```
bash tom.quest/worker/scrub-token-urls.sh --dry-run   # report only
bash tom.quest/worker/scrub-token-urls.sh             # rewrite them
```

Deploying the clean-URL code stops NEW copies of the token being written into
remote URLs. It does not remove the copies already on disk, and nothing else
does. Measured on the Jarvis Box at 00:29 UTC on 2026-09-01, before any of
this was deployed: 17 checkouts of 32 scanned carried a credential in a remote
URL — 8 under `/var/cache/tts` and 9 under `/tmp` — across three repositories
(ComplexMultiTrigger 8, tom.quest 7, WikiTom 2). The ones under
`/var/cache/tts/sessions` disappear when their session ends, and the cron
jobs' cache clone repairs its own URL on the next tick, but a clone a session
made for itself under `/tmp` outlives that session and no cleanup rule touches
its contents.

`scrub-token-urls.sh` rewrites each of those remote URLs to its plain form in
place, deleting nothing; the checkout keeps working because the credential
helper supplies the token at ask time instead. It refuses to run unless
`/usr/local/bin/tts-git-credential` is installed AND registered as git's
effective `credential.helper`, because a cleaned URL has no other way to
authenticate (`--force` overrides that, and is meant for fixtures and for a
box being taken out of service). It prints paths and cleaned URLs only, never
a line that still holds a credential. `setup.sh` runs it automatically, after
installing the helper and after copying the new job scripts into place.

It does not make revoking the old token safe on its own: the running daemon
holds the value it read at startup and keeps writing it into new session
clones until it is restarted, so scrubbing at 12:00 says nothing about the
clone minted at 12:01. The revocation still waits for the deploy, and
`rotate-github-token.sh --audit` is what says when.

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
