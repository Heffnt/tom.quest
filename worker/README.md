# The Jarvis Box

The always-on home for TTS's scheduled headless-Claude jobs: a Hetzner VPS
(today: x86_64, Ubuntu 26.04 — it began life as an ARM64 CAX11 on 24.04) running these jobs
on a schedule:

1. **poll-dump** (hourly) — reads new human messages from the Slack
   `#dump` channel and submits each one to Convex as an unprepared todo.
   The recovery pass behind the push route (`POST /slack/events`), which is
   how a message normally arrives.
2. **plan-graphs** (every 30 min) — the planner, two passes in one run:
   **prepare** every unprepared life todo (brief, entry action, work
   description, ground-up explanation, readiness `prepared`, and the date
   the statement itself states), re-preparing any todo Tom ruled `revise`
   on with his sentence in the prompt; then **plan** the graph inside every
   batch (goals, tasks, `needs` edges, the needs between batches). Nothing
   here posts to Slack — the capture posts its own threaded reply.
3. **apply-time-notes** (every 2 min) — turns each time note Tom wrote into
   concrete date and block changes.
4. **poll-gmail** (every 10 min) — lists new inbox mail and spends ONE headless
   Claude call per batch on TWO judgements. First: does the message imply an
   action by Tom? If so it is submitted to Convex as an unprepared todo with
   source `email` and the stable source id `gmail:message:<id>` in its
   provenance, followed by the `#all` link. Judged from headers plus Gmail's
   ~100-character snippet only — v1 never downloads bodies — and the prompt
   leans toward capturing when unsure, because a wrong capture costs one
   archive click while a wrong skip loses the thread. Second: does it need Tom
   **today**? If so the job asks Convex to open one thread in `#tts` on that
   todo (`POST /tts/needs-tom`), carrying one line — the sender, the subject,
   the todo's link — so his reply in it is the next turn on the row. That
   second judgement is capture triage, not an importance rating: three facts
   and no others make it true (a deadline inside 48 hours, a named person
   waiting on a reply, money or credentials), and the rules for both
   judgements come from the deployment (`GET /tts/capture-context`, the synced
   WikiTom capture-triage text), never from a copy in the job. The thread is
   deduped on the Gmail message id, so one mail opens one thread however many
   times the job re-reads it. Until the Gmail credentials exist it is a quiet
   no-op; see below.
5. **poll-canvas** (every 30 min) — the one job that owns Canvas, in two
   halves on one tick. **Assignments**: every published, dated assignment
   within 14 days back and 60 days on is posted to
   `POST /tts/canvas-assignments`, which keeps one todo per assignment (source
   `canvas`, `dateKind: "external"`, provenance `canvas:assignment:<id> <url>`)
   — the instructor's date is a fact and moves the todo with it, and a
   submission on Canvas completes the todo. No Claude call: an assignment with
   a due date *is* an obligation, there is nothing to judge, and posting the
   whole window every run is safe because the sync keys each row by its
   assignment id. **Announcements**: ONE headless Claude call per batch, under
   the deployment's own capture-triage rules (`GET /tts/capture-context`, the
   same words poll-gmail uses), deciding which imply an action by Tom
   (schedule changes, sign-ups, required responses); those are captured as
   unprepared todos with source `canvas-announcement`, linked to the
   announcement. Two source names for two facts: they shared `canvas` until the
   sync was found reading every announcement row and dropping it without a
   word. Quiet no-op until `CANVAS_TOKEN` exists in worker.env (WPI restricts
   token creation; Tom's request form is pending), and an expired or revoked
   token is reported to TTS as a job failure so it reaches him in the morning
   digest instead of dying in `/var/log/tts`.

   **One credential copy.** The assignments half used to be a Convex cron
   action with a second `CANVAS_TOKEN` in the deployment env. It is gone; the
   token lives only in `/etc/tts/worker.env`, and what stayed in Convex is the
   mutation that writes todos, because writing todos has to be one.
6. **poll-outlook** (not scheduled yet) — the Outlook counterpart of
   poll-gmail (Tom, 2026-08-25: "outlook is where the most important mail comes
   in"). It is a **skeleton**: the credential contract, the cursor's home and
   the two strings a later reader depends on are settled, and the Microsoft
   Graph half lands in the same change as the `OUTLOOK_*` credential, because
   network code that can never be exercised is worse than an empty hand. It
   has no cron line at all until then — the line is written and commented out
   in `setup.sh`, with the reason next to it. Run by hand today it prints one
   line naming the keys it is still waiting for. See "Outlook credentials"
   below.
7. **prepare-queue** (4:30 a.m. New York) — runs headless Claude Code to pick
   today's queue (≤7 items) and write the daily digest, and posts both to
   Convex. If it fails, the Convex-side fallback prep (4:45) still writes the
   day's queue. The digest text it writes has no reader any more: since the
   lifeos update (phase 2) the 5 a.m. digest is composed deterministically in
   Convex (`convex/ttsDigest.ts`) and sent by `sendDigest`, so a missing
   morning message is itself the monitoring signal. This job's digest half
   goes in phase 7 with the queue.
8. **execute-approved** (hourly at :45) — see the ruling loop below.
9. **nightly** (4:00 a.m. New York) — copies the Convex record and this
   box's session files into WikiTom, runs the learning step, pushes, and
   posts the model-of-tom files back to Convex. See "The nightly job" below.

## Declining an integration

**An integration Tom declines is an archived todo with his ruling on it.**
There is no integrations table, no enabled flag, no config page: the thing that
already records a decision of his records this one too, so it keeps his own
words, its date, and its place in everything that reads rulings.

To decline one, dump the line into `#dump` and archive it with the **archive**
verdict:

```
integration: outlook
```

The optional sentence on that verdict is the reason. Every poller asks
`declined(env, "<its name>")` before anything else — before its credential
check, before any read — and exits with one line naming the date and the
sentence:

```
[poll-outlook] declined by Tom on 2026-09-05: not worth the credential — skipping
```

The names are `gmail`, `canvas` (both halves) and `outlook`; the prefix is
matched case-insensitively, so `Integration: Outlook` is the same ruling.

Both halves are required — the row must be **archived** *and* its newest ruling
must be **archive**. An archived row alone is not a decision of his (a cleanup
or a batch archive can archive a row), and a ruling alone is not either. Ruling
again takes the decline back: an approve after an archive re-enables the
integration and leaves the history of having declined it. The Friday weekly
gather lists integrations by state, with the ruling date.

The one home for all of that is `convex/ttsIntegrations.ts`.

## The nightly job

`worker/jobs/nightly.mjs` (the lifeos update, phase 4) runs at 4:00 a.m. New
York, an hour before the 5 a.m. digest reads what it wrote. It works in the
WikiTom checkout at `/root/wikitom` — a full clone, `sessions/` included,
made by `setup.sh` over the SSH alias `github.com-wikitom` (a `Host` entry
in `/root/.ssh/config` pointing at the deploy key `/root/.ssh/wikitom`,
readable by root only). `setup.sh` also puts github.com's host keys in
`/root/.ssh/known_hosts`, each verified against GitHub's published
fingerprints before it is trusted — a rebuild has no terminal to answer a
host-key prompt with — and reports git's own words when a clone is refused. Five steps, in order; a step that fails writes one
`nightly-failure` row to `dtsEvents` (`POST /tts/event`, naming the step and
git's or the server's own words) and the next step runs anyway. Steps 1 to 4
write the checkout and run under one hold of `/var/lock/tts-wikitom.lock` —
the lock every writer of the checkout takes — taken around all four together,
never around the commit alone; step 5 only reads `HEAD` and takes no lock:

1. **snapshot** — every Convex table except the six `auth*` ones, read by
   pages from `GET /tts/export` against one boundary instant, into
   `tts/snapshot/`: one JSON-lines file per table, keys sorted, newest row
   first, a table over 90 MB as gzipped parts (`<table>.partNN.jsonl.gz`).
   The set is assembled in `/var/cache/tts/snapshot-staging/` first and a
   file is written only where its hash changed, so a night with no change
   to a table makes no commit for it.
2. **learning** — a skeleton for now: reads yesterday's turns Tom typed,
   his Slack replies and his rulings (`GET /tts/learning-input`) and records
   one `learning-run` row with the counts and zero changes. The comment above
   the step in the job says what the full step will do (proposed lines with
   evidence, one `learning-change` row each, the digest listing them, the
   inverse applied on an objection).
3. **sessions** — every Codex rollout (`/root/.codex/sessions/YYYY/MM/DD/`)
   and Claude SDK session file (`/root/.claude-accounts/<account>/projects/`;
   the `active` symlink is skipped) whose content the manifests under
   `sessions/` do not already hold, archived in phase 1's layout:
   `sessions/YYYY/MM/DD/claude-<id>/session.jsonl.gz` with `children/` and
   `attachments/` beside it, `codex-<thread>/rollout.jsonl.gz` with its
   subagent threads under `children/<thread>.jsonl.gz`, a per-account subdir
   when both Max accounts hold one session id. Dates come from the files'
   own timestamps (mtime when there is none); one line per file is appended
   to `sessions/manifest-box-<day>.jsonl`, phase 1's columns. A file that
   grew since it was archived is archived again.
4. **push** — one commit per step that changed something, and then, always,
   one more for anything still modified under `tts/snapshot/` and `sessions/`
   — what a run that died part-way left behind, which `git pull --rebase`
   would otherwise refuse every night after. A rebase an earlier run left in
   progress is aborted before the run's first write (aborting resets the tree
   hard) and recorded as a failure. Commits are authored `tts-nightly` (an
   identity `setup.sh` also writes into the checkout's own config, because the
   rebase commits under it) so the digest tells the box's commits from Tom's,
   then `git pull --rebase` and `git push` over the alias. A refused pull or
   push is a failure row and the commits stay local, to go with the next
   night's. **Until Tom adds the deploy key's public half to the WikiTom
   repository, every push is refused and this is the row the digest shows.**
5. **post** — the model-of-tom files at `HEAD`, whether or not the push
   went through: `model-of-tom/writing.md`, `priorities.md`, `schedule.md`,
   then for each page under `model-of-tom/areas/` its "Current state" and
   "Must not break" sections (parsed by heading; while `areas/` does not
   exist, the three alone), posted with the commit hash and the commit's
   time to `POST /tts/model-of-tom`. Convex replaces the `ttsSkills` table
   whole and every prompt from then on begins with those files under a
   header naming that commit. A named file that is missing or empty is a
   failure row and NO post goes out: the replace is wholesale, so posting the
   rest would take that file — `writing.md`, the writing standard itself —
   out of every prompt until a night that reads it again. Convex refuses a
   post without `writing.md` on its own account.

Then one `nightly-run` row with the summary (commit, pushed or not, table
and row counts, files archived, the failures). By hand:

```
node /opt/tts/nightly.mjs --force                  # every step, now
node /opt/tts/nightly.mjs --force --only=post      # one step, or a comma list
```

Nothing here prints a token: the deploy key is a file git reads, and
`TTS_WORKER_KEY` travels only in a request header.

## The code-todo ruling loop

CMT (`github.com/Heffnt/ComplexMultiTrigger`) keeps its standing intent in
`vqc/todos.yaml`; the Jarvis Box turns that file into rulings Tom can make from the
tom.quest UI in seconds:

- **The planner's brief pass** (`plan-graphs.mjs`, every 30 minutes)
  refreshes a shallow cache clone of CMT, and for every OPEN todo entry
  whose YAML changed since its last brief (sha256 cursor in
  `/var/lib/tts/brief-hashes.json`) — or that Tom ruled `revise` on, with
  his sentence as the replan note — has headless Claude write a ground-up
  brief against the current tree and a recommendation in the four verdict
  words — `archive` (already done/moot, with evidence), `revise` (intent
  live, plan stale), `session` (open judgment call; all tier C), or
  `approve` — plus an exec class (`box` vs `needs-turing`). Briefs POST to
  Convex and are also cached locally under `/var/cache/tts/briefs/`.
- Tom rules on each brief in the UI. There is no apply job: every verdict's
  effect is applied at write time in Convex (`convex/ttsRulings.ts`), or at
  the one moment its effect can exist. `revise` is consumed by the brief
  pass once the fresh brief has posted, with Tom's sentence as the replan
  note. `session` is applied when Tom opens the code block session from
  the calendar. `archive` is admitted by the auto-session scheduler as a
  worker mission that closes the entry in `vqc/todos.yaml` and opens a
  pull request — the same lane as `approve`, below.
- **execute-approved** takes ONE pending `approve` per hour, runs agentic
  Claude in a throwaway full clone on a `tts/<id>` branch, verifies commits +
  the todos guard, pushes, and opens a PR. **Merging the PR is the human
  gate** — nothing lands on master autonomously.

## Codex

Codex is the second session runner on this box: a session whose model is one of
the `gpt-5.6-*` names runs OpenAI's Codex instead of Claude, and any session can
hand a prompt to Codex with `echo "<prompt>" | tts-codex`, from any repo.
`setup.sh` step 4 installs the pinned CLI (`@openai/codex@0.153.3` — the copy
bundled with the Codex desktop app is too old to know the gpt-5.6 models) and
writes `/root/.codex/config.toml` if it is absent: file-backed credentials, the
fleet default `gpt-5.6-sol` at `xhigh` effort, and a subagent concurrency cap.
Login is the one manual step (`codex login --device-auth`, once, after Tom
enables device-code login in ChatGPT's security settings) and it must happen on
this box: `auth.json` uses a rotating refresh token, so copying one in from
another machine logs both machines out.

Codex has native subagents (`spawn_agent`, types `explorer` and `worker`) and a
spawned agent inherits the parent's model unless the parent names a cheaper one,
which is exactly the delegation rule in `AGENTS.md`: the strong model keeps
judgment and review, `gpt-5.6-terra` gets the reading and the mechanical edits.

**Quota is shared, not extra.** Codex here draws on the same ChatGPT Plus rate
windows as Tom's own laptop use — a busy fleet hour is an hour he finds his
own Codex throttled. The fleet caps its own weekly Codex consumption at 90% of
the window and falls back to Opus past that, so the ceiling is reached by
sessions switching runner rather than by anything stopping.

## The browser

Every session on this box can open a real page. `setup.sh` step 5 installs
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
- `/var/lib/tts/outlook-cursor` — the same, for poll-outlook, in the same
  one-integer format; it does not exist yet (the job has no cron line until
  the `OUTLOOK_*` credential does).
- `/var/lib/tts/canvas-announcements-cursor` — timestamp of the newest
  announcement poll-canvas has processed; losing it re-examines the last
  7 days, at worst re-capturing a few announcements as duplicates.
- `/var/lib/tts/brief-hashes.json` — which todo version was last briefed;
  losing it re-briefs everything once (the Convex POST upserts).
- `/var/cache/tts/` — rebuildable caches: the shallow CMT clone, the local
  brief copies, the executor's throwaway clones, the nightly job's snapshot
  staging directory.
- `/root/wikitom` — the WikiTom checkout the nightly job writes. Everything
  in it is pushed, or reproducible from Convex and the session files, except
  commits a refused push left local — those are lost with the box, and the
  next night's run makes them again from the same sources.

Losing the whole Jarvis Box loses nothing but a paused digest and some re-work.

## Rebuild from scratch

```
# 1. Create a Hetzner VPS (any arch; x86_64 Ubuntu 26.04 is what runs today), add the SSH key, log in as root.
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
# 5. Log Codex in (once, on the box — never copy auth.json in):
codex login --device-auth
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
approved it writes all three `KEY=VALUE` lines to `~/tts-gmail-credentials.env`
with mode 0600 and prints only that path, the variable names, and the two
commands that append the file to `/etc/tts/worker.env` and delete both copies.
No credential value is ever printed — see the "never log secrets" rule in
`AGENTS.md`, which has no exemption for these helpers, and
`worker/jobs/credential-file.mjs`, which is how they comply. The token lasts
until it is revoked at `myaccount.google.com/permissions`. The script's own
header carries the ten-minute console walkthrough.

## Outlook credentials (one-time, not yet minted)

poll-outlook needs three keys in `/etc/tts/worker.env` — `OUTLOOK_CLIENT_ID`,
`OUTLOOK_CLIENT_SECRET`, `OUTLOOK_REFRESH_TOKEN` — and prints one line naming
the missing ones until all three are there.

The client id and secret come from an Entra ID (Azure AD) app registration in
Tom's tenant, with the **delegated** Microsoft Graph permission `Mail.Read`
plus `offline_access` (which is what makes a refresh token mintable at all).
Read-only by construction: a leaked token cannot send mail as him.

The refresh token is minted ONCE on Tom's own machine rather than on the
Jarvis Box, because approving it needs a browser — the same one-time shape as
`gmail-auth.mjs`. **That minting helper and the Microsoft Graph half of the
job both land in the change that carries this credential**, together with the
cron line, which sits commented out in `setup.sh` with the reason beside it
until then. Network code that can never be exercised is worse than an empty
hand, so what is in the repo today is only what could be settled without the
token: the three key names, the cursor's home
(`/var/lib/tts/outlook-cursor`, the same one-integer format as the Gmail
cursor), the source id shape `outlook:message:<id>`, and the line a `#tts`
thread opens with.

## Calendar credentials (one-time)

The calendar WRITE door — `convex/ttsCalendarWrite.ts`, reached as
`POST /tts/calendar-event` from Jarvis Box jobs and sessions, or as
`npx convex run ttsCalendarWrite:internalCreateEvent` from Tom's machine —
needs three values named `GOOGLE_CALENDAR_CLIENT_ID`,
`GOOGLE_CALENDAR_CLIENT_SECRET` and `GOOGLE_CALENDAR_REFRESH_TOKEN`. Without
all three it throws "Calendar write is not configured" on every call.

Those three live on the **Convex deployment**, not in `/etc/tts/worker.env`,
because the Google call is made by a Convex action rather than by anything on
this box. Nothing in this directory reads them; the Jarvis Box only posts to
Convex and lets Convex hold the credential.

The client id and secret are the SAME "Desktop app" OAuth client as the Gmail
section above (same Google Cloud project, with the Google Calendar API enabled
alongside the Gmail API). The refresh token is a separate one, minted ONCE on
Tom's own machine because approving it needs a browser, and scoped to
`calendar.events` only — event create/edit/delete, no calendar admin and no
mail, so one leaked credential does not open the other surface:

```
node worker/jobs/calendar-auth.mjs <client_id> <client_secret>
```

Run it from a tom.quest checkout: it prints a Google URL, and after
calendar-events access is approved it runs `npx convex env set` for all three
values itself, using the deploy key in that checkout's `.env.local`. The token
goes Google → script → Convex without being pasted anywhere. If the env set
fails (no deploy key in reach), it prints the three lines instead, for the
Convex dashboard → Production → Settings → Environment Variables.

One follow-up, because `npx convex env set` writes past the usual door: copy
the three values into `secrets/convex.env`, which is the source of truth the
repo pushes from. `pnpm secrets:sync` sends every key in that file to Convex
including the empty ones, so a `GOOGLE_CALENDAR_CLIENT_ID=` left blank there —
the shape it has in `secrets/convex.env.example` — silently overwrites a
working token with an empty string on the next sync.

## The hourly update channel (one-time)

Every hour, 24/7, `internal.ttsSync.sendHourlyUpdate` posts to `#tts-hourly`:
what the box is running now, which batches were worked since the last update,
what changed since the last update (captures, completions, archives, rulings,
date outcomes, failures, each with its link) — or one line saying nothing did.
It goes through the one Slack door in `convex/ttsSync.ts` like every other
message, so each send leaves the door's `slack-sent` row and each refusal its
`slack-send-failed` row. The update also carries one duty for the digest: if
today's 5 a.m. digest was composed and refused, its text is reposted unchanged
here first — to `#tts` (`SLACK_TTS_CHANNEL_ID`), the channel the digest belongs
to, not the hourly one.

It posts to `SLACK_TTS_HOURLY_CHANNEL_ID` on the Convex deployment, and until
that is set every hour logs one line and sends nothing. The id comes from a
one-off run on this box, which reads `SLACK_BOT_TOKEN` from
`/etc/tts/worker.env` (or the environment):

```
tts-slack-setup                     # lists the human members and stops
tts-slack-setup --user U012ABCDEF   # that member is Tom
```

The first form prints every human member (id, name, whether it owns the
workspace) and changes nothing: which account is Tom is an input, because
`TOM_SLACK_USER_ID` is the id the events route trusts to authorize writes.
`--email <address>` selects by `profile.email` instead when exactly one member
matches. With the account named it creates the public channel `tts-hourly` if
it does not exist (unarchiving an archived one), joins the bot, invites Tom,
and prints exactly two lines:

```
SLACK_TTS_HOURLY_CHANNEL_ID=C…
TOM_SLACK_USER_ID=U…
```

Both go into `secrets/convex.env` under those names, then `pnpm secrets:sync`.
`TOM_SLACK_USER_ID` is the one Slack user whose threaded replies the events
route acts on. The token is never printed.

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
node /opt/tts/poll-outlook.mjs            # prints the OUTLOOK_* keys still missing
node /opt/tts/prepare-queue.mjs --force   # prep today's queue regardless of hour
node /opt/tts/plan-graphs.mjs             # prepare, brief, plan — now
node /opt/tts/plan-graphs.mjs --force     # also re-prepare and re-brief EVERYTHING
node /opt/tts/execute-approved.mjs        # execute one approved plan now
node /opt/tts/nightly.mjs --force         # the nightly job, every step, now
```

`--force` skips the 4-a.m.-New-York hour guard (cron fires the prep at both
08:30 and 09:30 UTC and the guard keeps exactly the slot that is 4:30 a.m. NY,
whichever side of daylight saving we're on).

## Logs

Cron output: one `/var/log/tts/<job>.log` per job (poll-dump, poll-gmail,
poll-canvas, apply-time-notes, plan-graphs, prepare-queue, execute-approved,
nightly), truncated monthly by cron — they are convenience, not state.
