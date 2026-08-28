# DTS worker box

The always-on home for DTS's scheduled headless-Claude jobs: a Hetzner CAX11
(Ubuntu 24.04, ARM64) running two personal-todo jobs and three code-todo jobs
on a schedule:

1. **poll-dump** (every 2 min) — reads new human messages from the Slack
   `#dump` channel and submits each one to Convex as an unprepared todo.
2. **prepare-queue** (4:30 a.m. New York) — runs headless Claude Code to pick
   today's queue (≤7 items) and write the daily digest, and posts both to
   Convex. If it fails, the Convex-side fallback prep (4:45) and the
   always-sends 5 a.m. digest cover the day — a digest that reports missing
   prep is the "worker is broken" signal; no digest at all means Convex/Slack
   is broken. That split is the whole monitoring story.
3. **brief-code-todos** (every 2 h at :17) — see the ruling loop below.
4. **apply-rulings** (every 10 min) — see the ruling loop below.
5. **execute-approved** (hourly at :45) — see the ruling loop below.

## The code-todo ruling loop

CMT (`github.com/Heffnt/ComplexMultiTrigger`) keeps its standing intent in
`vqc/todos.yaml`; this box turns that file into rulings Tom can make from the
tom.quest UI in seconds:

- **brief-code-todos** refreshes a shallow cache clone of CMT, and for every
  OPEN todo entry whose YAML changed since its last brief (sha256 cursor in
  `/var/lib/dts/brief-hashes.json`), has headless Claude write a ground-up
  brief against the current tree and a recommendation — `propose-archive`
  (already done/moot, with evidence), `stale-replan` (intent live, plan
  stale), `needs-session` (open judgment call; all tier C), or `approve` —
  plus an exec class (`box` vs `needs-turing`). Briefs POST to Convex and are
  also cached locally under `/var/cache/dts/briefs/`.
- Tom rules on each brief in the UI; Convex queues the rulings.
- **apply-rulings** carries out the non-execution rulings: `defer` records
  it; `stale-replan` queues a re-brief that must propose a fresh plan;
  `needs-session` pushes a session-agenda file to CMT master; and
  `propose-archive` closes the entry in `vqc/todos.yaml` (text surgery, then
  CMT's own todos guard test — a red guard reverts and reports instead of
  pushing).
- **execute-approved** takes ONE pending `approve` per hour, runs agentic
  Claude in a throwaway full clone on a `dts/<id>` branch, verifies commits +
  the todos guard, pushes, and opens a PR. **Merging the PR is the human
  gate** — nothing lands on master autonomously.

To start a `needs-session` working session, from any CMT checkout:

```
claude "Run the DTS session in dev/handoff/dts-session-<id>.md"
```

## The no-state rule

**This box owns no durable state.** Everything that matters lives in Convex
(and, for code todos, in the CMT repo itself). The local files with memory
are all harmless to lose:

- `/var/lib/dts/dump-cursor` — Slack poll cursor; losing it re-captures up to
  24 hours of `#dump` messages as duplicates Tom can archive.
- `/var/lib/dts/brief-hashes.json` — which todo version was last briefed;
  losing it re-briefs everything once (the Convex POST upserts).
- `/var/cache/dts/` — rebuildable caches: the shallow CMT clone, the local
  brief copies, the executor's throwaway clones.

Losing the whole box loses nothing but a paused digest and some re-work.

## Rebuild from scratch

```
# 1. Create a Hetzner CAX11 (Ubuntu 24.04, ARM64), add the SSH key, log in as root.
# 2. On the box:
git clone https://github.com/<owner>/tom.quest
bash tom.quest/worker/setup.sh
# 3. Fill the secrets (the file documents each key):
nano /etc/dts/worker.env
# 4. Log in both Claude Max accounts (interactive), pick one:
dts-account login gmail
dts-account login wpi
dts-account use gmail
# Done. Cron is installed; the digest resumes tomorrow at 5.
```

`setup.sh` is idempotent — re-running it is also how updated job scripts are
rolled out after a `git pull`.

## Switching Claude accounts

Jobs run under `CLAUDE_CONFIG_DIR=/root/.claude-accounts/active`, a symlink:

```
dts-account status       # which account is active
dts-account use wpi      # switch; takes effect on the next job run
```

## Testing jobs by hand

```
node /opt/dts/poll-dump.mjs               # capture anything new in #dump now
node /opt/dts/prepare-queue.mjs --force   # prep today's queue regardless of hour
node /opt/dts/brief-code-todos.mjs        # brief changed CMT todos now
node /opt/dts/brief-code-todos.mjs --force # re-brief EVERY open CMT todo
node /opt/dts/apply-rulings.mjs           # apply pending rulings now
node /opt/dts/execute-approved.mjs        # execute one approved plan now
```

`--force` skips the 4-a.m.-New-York hour guard (cron fires the prep at both
08:30 and 09:30 UTC and the guard keeps exactly the slot that is 4:30 a.m. NY,
whichever side of daylight saving we're on).

## Logs

Cron output: one `/var/log/dts/<job>.log` per job (poll-dump, prepare-queue,
brief-code-todos, apply-rulings, execute-approved), truncated monthly by cron
— they are convenience, not state.
