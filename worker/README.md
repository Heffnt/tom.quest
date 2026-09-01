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
  brief copies, the executor's throwaway clones.

Losing the whole Jarvis Box loses nothing but a paused digest and some re-work.

## Scratch files: /tmp costs memory, /var/cache/tts/tmp costs disk

`/tmp` on this box is a **tmpfs** — a filesystem held in RAM rather than on a
disk — sized 3.8 GB on a 7.7 GB machine. Every byte of every file left in it is
a byte the box cannot use for anything else, and nothing in it survives a
reboot (both true until `tmp-on-disk.sh`, below, has run and the box has
rebooted once). On 2026-08-30 one session left ~2.2 GB of scratch there, a leaking test
in a research checkout added ~1,400 empty directories a day beside it, `/tmp`
reached 100 percent full, and tooling inside a running session began failing
with out-of-space errors.

`worker/scratch-cleaning.sh` installs the fix, and step 8 of `setup.sh` is a
call to it. It is a separate file because running it on its own is how the
change reaches a live box **without** the `tts-session-host` restart that
`setup.sh` performs — that restart kills every session running at the time.
It handles two parts, because they cover different failures:

- **Cleaning between sessions.** `/etc/tmpfiles.d/tmp.conf` sets `q /tmp 1777
  root root abcmM:2d`: delete anything under `/tmp` untouched for two days.
  `abcmM` is systemd's own default (`abcmABM`) with one letter removed —
  **files** are still judged by all four of their timestamps, **directories**
  only by modification time. Directories must not count access time, because any
  recursive sweep (`du`, `find`, `ls -R`) refreshes the access time of every
  directory it walks, and the leak that fills this tmpfs is **empty**
  directories, which such a sweep would then keep alive forever. Files keep all
  four because sessions clone repositories into `/tmp` and read them for days
  without writing, and because a test suite here writes fixture files stamped
  with a 1970 modification time — under an mtime-only rule both get deleted
  while in use. A drop-in runs the existing `systemd-tmpfiles-clean.timer` every
  6 hours instead of daily. None of this can stop one session filling the tmpfs
  within an hour: nothing that young is old enough to reap.

  Residual failure: a checkout in `/tmp` used across more than two days still
  loses worktree files nothing has read (git restores them from the object
  store). Don't clone into `/tmp`; `mktemp -d` now lands on disk. To hold a path
  back from cleaning entirely, write `x /path` into
  `/etc/tmpfiles.d/zz-tts-keep.conf` by hand — `setup.sh` neither creates nor
  deletes that file.
- **Keeping tool-chosen scratch out of RAM.** `TMPDIR=/var/cache/tts/tmp` is set
  on the cron file and on the session-host unit, so cron jobs, every session,
  and every tool a session runs write scratch to `/dev/sda1` (75 GB) instead.
  That directory has its own 3-day rule. This only redirects programs that
  **ask** where to put scratch — `mkdtemp`, `mktemp`, `tempfile`,
  `os.tmpdir()`. It cannot redirect a path an agent typed out in full.
  A session's own `TMPDIR` is narrower still — see "What the daemon itself does
  about scratch" below, where each session gets a directory that dies with it.

Check what the cleaner would remove, removing nothing:
`systemd-tmpfiles --clean --dry-run`.

### Why those two are not enough, and what `tmp-on-disk.sh` does

Measured on the live box 2026-08-31 at 23:41 UTC, with `/tmp` holding 3.2 GB:

| Bytes in `/tmp` | Share | Reached by |
| --- | --- | --- |
| 86 MB in entries created through `TMPDIR` | 2% | the `TMPDIR` setting |
| 3,086 MB at paths an agent typed out (`/tmp/killcheck`, twelve repository checkouts) | 97% | nothing above |
| entries two days old or older | 0 | the age rule |

The 2% row is a floor, not the whole `TMPDIR` share: it counts entries with the
random suffix `mkdtemp` gives them, and programs that ask for the temporary
directory and then use a FIXED name inside it are missed. Re-measured
2026-09-01 at 00:30 UTC, three such entries — `/tmp/node-compile-cache`
(104 MB), `/tmp/pytest-of-root` (176 MB) and `/tmp/claude-0` (226 entries) —
were 284 MB, about 9% of the 3.2 GB, and each was confirmed to follow `TMPDIR`
by setting it and watching where the writer landed. The conclusion is unchanged:
the clones are the bulk and no variable moves them.

Four clones of one 417 MB research repository, at `/tmp/killcheck` through
`/tmp/killcheck4`, were made by a single session inside five minutes. Nothing
in `/tmp` was old enough for any age rule to touch — feeding the installed rule
to `systemd-tmpfiles --clean --dry-run` against the real `/tmp` selected zero
entries, while the same rule at a one-hour age selected 37,051, which is how we
know the check itself works.

So the thing that fills this tmpfs is agents cloning repositories to `/tmp`
paths of their own choosing, minutes at a time, and the only mechanism that
answers it is `/tmp` not being in RAM. `worker/tmp-on-disk.sh` masks systemd's
`tmp.mount`, so at the **next boot** `/tmp` is a plain directory on the root
disk (48 GB free) rather than a 3.8 GB slice of the machine's 7.7 GB of RAM.
The directory underneath the mount already exists with mode 1777 (read straight
off the ext4 inode with `debugfs -R 'ls -l /' /dev/sda1`), so `/tmp` is correct
from the first instant of boot, and nothing on the box declares `Requires=` or
`BindsTo=` on `tmp.mount`. Masking changes nothing while the box is up: no
process stops, no session dies, the tmpfs stays mounted. Undo with
`systemctl unmask tmp.mount`.

Two consequences worth knowing. A `/tmp` on disk is **not** emptied by a
reboot, so the age rule becomes the only thing that ever cleans it — which is
why the script refuses to run unless `/etc/tmpfiles.d/tmp.conf` is already
installed, and why `setup.sh` calls it after `scratch-cleaning.sh`. And
runaway scratch now fills the root filesystem instead of the tmpfs, which is
the worse failure of the two; the script refuses below 10 GB free, and the
budget is 12x larger than the tmpfs it replaces.

Writing to disk instead of RAM is not a speed problem here: `/dev/sda1` is
non-rotational, and 512 MB written with `conv=fdatasync` measured 1.8 GB/s
against 3.4 GB/s on a tmpfs (2026-09-01).

### The disk floor in the scheduler, which is what makes losing the tmpfs safe

The 3.8 GB tmpfs was itself a bound on runaway scratch: a session that wrote
without limit hit `ENOSPC` in `/tmp` and broke only scratch. On the root
filesystem the bound is 75 GB and what breaks is the box — the daemon, the
journal and the package manager all live there. Measured 2026-09-01 at 00:05
UTC, files in `/tmp` created within the preceding hour totalled 1.9 GB, and
within the preceding six hours 2.8 GB; the two-day age rule deletes none of
that, because none of it is two days old. So the age rule cannot be the only
thing standing between agent scratch and a full root filesystem.

The scheduler therefore gates on free disk exactly as it already gates on free
memory. `session-host.mjs` reports `load.freeDiskMb` (`statfs("/")`, `bavail`,
so the ext4 reserve is not counted as usable) and
`claudeAutoConfig.minFreeDiskMb` — default 10240, the same 10 GB
`tmp-on-disk.sh` refuses to install below — stops new autonomous admissions
under it. Sessions already running are left alone. A **missing** `freeDiskMb`
never refuses admission: a daemon older than the field would otherwise hold the
fleet shut permanently, which is worse than the failure being guarded. Both
halves are pinned by `convex/claudeSessions.test.ts` ("stands down on low free
disk, but not when free disk is unreported").

This lands with the merge and starts working at the daemon's next start, which
is the same reboot that moves `/tmp` off RAM.

### What the daemon itself does about scratch, needing no root

Everything above changes the box. Two things change the *sessions*, and they
ship with the daemon rather than with a command run as root.

- **Every session gets its own temporary-file directory,**
  `/var/cache/tts/sessions/<id>/tmp`, and the daemon exports it as `TMPDIR` in
  the session's environment (`Session#tmpDir`, set in `startQuery`). It sits
  beside the checkout, so nothing written there can be committed by accident,
  and it is inside the directory `cleanupWorkdir` already deletes when the
  session ends — so it is reaped by the session's own lifetime, not by an age
  rule that cannot fire until the files are two days old. It overrides the
  shared `TMPDIR=/var/cache/tts/tmp` the unit sets, which stays as the answer
  for cron jobs and the daemon itself. Verified on the box 2026-09-01 that this
  one variable is what the writers actually read: with it set, Node's
  `os.tmpdir()` and its compile cache, Python's `tempfile.gettempdir()`, the
  shell's `mktemp -d`, and the Claude CLI's own `claude-0` and `cc-socks`
  directories all resolved into it. Those account for `/tmp/node-compile-cache`
  (104 MB), `/tmp/pytest-of-root` (176 MB) and `/tmp/claude-0` (226 entries) as
  measured the same day.
- **The command classifier now refuses to create anything under `/tmp`.**
  `/tmp/` is an alternative in `BASH_DANGER_RE`, so such a command buys a
  verdict instead of passing free, and the classifier prompt denies *creation*
  there while allowing reads. This is the only mechanism that reaches the 2.5 GB
  of clones an agent addressed by absolute path, because that path was the
  agent's own choice and no environment variable can move it. The deny message
  names the session's own directory, so the model's next attempt goes to the
  right place. Two deliberate scopes: reading, listing and measuring `/tmp` stay
  allowed (the sessions that diagnose this very problem have to do it), and
  deletion under `/tmp` stays governed by the existing "nothing outside the
  working directory" rule, because another live session may be working inside a
  directory there.

Run against the real classifier model on 2026-09-01, one call per command:

| Command | Verdict |
| --- | --- |
| `git clone --depth 1 https://github.com/Heffnt/ComplexMultiTrigger.git /tmp/killcheck5` | DENY, naming `$TMPDIR` |
| `echo hello > /tmp/notes.txt` | DENY, naming `$TMPDIR` |
| `mkdir -p /tmp/pw-browsers && ls /tmp` | DENY, naming `$TMPDIR` |
| the same clone into `/var/cache/tts/sessions/<id>/tmp` | ALLOW |
| `du -sh /tmp/* \| sort -h \| tail -5` | ALLOW |
| `ls -la /tmp` | ALLOW |
| `cat /tmp/cmt_control/README.md` | ALLOW |
| the file-based pen still spelling `/tmp/explanation.html` | ALLOW |

That last row is a rule of its own in the prompt, and it exists because the
mission prompt is built in Convex while the classifier lives in this daemon:
the two deploy separately, so a session can be reading a prompt whose pen names
`/tmp` while running under a daemon that denies creation there. Denying the pen
would cost that session its whole prepared explanation, which is far worse than
the few tens of kilobytes the file occupies.

The mission prompt itself no longer names `/tmp` at all: the file-based pen
writes `"${TMPDIR:-/tmp}/explanation.html"` and `"${TMPDIR:-/tmp}/tts-body.json"`.
Those two filenames used to be identical for every session on the box, and on
2026-09-01 a session opened `/tmp/tts-body.json` and found *another* session's
todo id and evidence in it — one `curl -d @` away from posting a payload naming
a todo it did not hold. `scripts/check-session-mirrors.mjs` fails the build if
either half drifts: if the daemon stops exporting `TMPDIR`, if a bare `/tmp`
path returns to a prompt, or if `BASH_DANGER_RE` stops fingerprinting a clone
into `/tmp` (or starts fingerprinting ordinary dev flow, which would put a
classifier call in front of every test run).

Exemptions, if a path in `/tmp` must be spared, go in a *separate*
`/etc/tmpfiles.d/` file as `x /tmp/<path>` lines — never in `tmp.conf`, which
`setup.sh` rewrites on every run.

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
