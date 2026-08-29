# TTS worker box

The always-on home for TTS's scheduled headless-Claude jobs: a Hetzner CAX11
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

A **governed repo** is a repo that keeps its standing intent in a
`vqc/todos.yaml` registry. There are two, and the loop covers both:

| repo | branch | closing an entry | delivering a ruling |
| --- | --- | --- | --- |
| `Heffnt/ComplexMultiTrigger` | `master` | move below the closed-todos banner, add `closed:` | commit straight onto `master` |
| `Heffnt/tom.quest` | `main` | leave in place, set `status:` | push a branch and open a PR |

tom.quest gets the pull-request treatment for two reasons: `main` is what
Vercel deploys to production, and its todos guard is a vitest file that needs
an installed `node_modules` the box's shallow clone has none of — so the PR's
CI run is the first place that guard can go red before the change is
permanent. (The box always runs its own structural check on the surgery —
still a list, no entry lost, the closed entry really reads closed with a
resolution — for both repos.)

**Every mirrored repo must be a governed repo.** `MIRROR_SOURCES` in
`convex/ttsSync.ts` decides which registries reach Convex; `CODE_REPOS` in
`worker/jobs/tts-code-lib.mjs` decides which get briefed. A repo in the first
list but not the second is not merely slow — it has no ruling card in the UI
and `form-batches.mjs` drops it from the batchable set, so its todos are
invisible. `worker/jobs/tts-code-lib.test.ts` fences the two lists.

This box turns those registries into rulings Tom can make from the tom.quest
UI in seconds:

- **brief-code-todos** refreshes each governed repo's shallow cache clone,
  and for every OPEN todo entry whose YAML changed since its last brief
  (sha256 cursor in `/var/lib/tts/brief-hashes.json`, keyed `<repo>:<id>`),
  has headless Claude write a ground-up brief against that repo's current
  tree and a recommendation — `propose-archive` (already done/moot, with
  evidence), `stale-replan` (intent live, plan stale), `needs-session` (open
  judgment call), or `approve` — plus an exec class (`box` vs
  `needs-turing`). The per-run cap is taken round-robin across repos, so no
  repo's backlog can starve another's. Briefs POST to Convex and are also
  cached locally under `/var/cache/tts/briefs/<repo>/`.
- Tom rules on each brief in the UI; Convex queues the rulings.
- **apply-rulings** carries out the non-execution rulings: `revise` queues a
  re-brief that must propose a fresh plan; `session` delivers a
  session-agenda file to the repo; and `archive` closes the entry in that
  repo's registry (text surgery, then the guards — red reverts and reports
  instead of delivering).
- **execute-approved** takes ONE pending `approve` per hour, runs agentic
  Claude in a throwaway full clone of that todo's repo on a `tts/<id>`
  branch, verifies commits + the guards, pushes, and opens a PR. **Merging
  the PR is the human gate** — nothing lands on a default branch
  autonomously.

To start a `session` working session, from a checkout of the todo's repo
(`dev/handoff/` in CMT, `tts/handoff/` in tom.quest):

```
claude "Run the TTS session in <handoff-dir>/tts-session-<id>.md"
```

## The no-state rule

**This box owns no durable state.** Everything that matters lives in Convex
(and, for code todos, in the governed repo itself). The local files with
memory are all harmless to lose:

- `/var/lib/tts/dump-cursor` — Slack poll cursor; losing it re-captures up to
  24 hours of `#dump` messages as duplicates Tom can archive.
- `/var/lib/tts/brief-hashes.json` — which todo version was last briefed;
  losing it re-briefs everything once (the Convex POST upserts).
- `/var/cache/tts/` — rebuildable caches: one shallow clone per governed
  repo, the local brief copies, the executor's throwaway clones.

Losing the whole box loses nothing but a paused digest and some re-work.

## Rebuild from scratch

```
# 1. Create a Hetzner CAX11 (Ubuntu 24.04, ARM64), add the SSH key, log in as root.
# 2. On the box:
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

## Switching Claude accounts

Jobs run under `CLAUDE_CONFIG_DIR=/root/.claude-accounts/active`, a symlink:

```
tts-account status       # which account is active
tts-account use wpi      # switch; takes effect on the next job run
```

## Testing jobs by hand

```
node /opt/tts/poll-dump.mjs               # capture anything new in #dump now
node /opt/tts/prepare-queue.mjs --force   # prep today's queue regardless of hour
node /opt/tts/brief-code-todos.mjs        # brief changed todos, every repo
node /opt/tts/brief-code-todos.mjs --force # re-brief EVERY open todo
node /opt/tts/apply-rulings.mjs           # apply pending rulings now
node /opt/tts/execute-approved.mjs        # execute one approved plan now
```

`--force` skips the 4-a.m.-New-York hour guard (cron fires the prep at both
08:30 and 09:30 UTC and the guard keeps exactly the slot that is 4:30 a.m. NY,
whichever side of daylight saving we're on).

## Logs

Cron output: one `/var/log/tts/<job>.log` per job (poll-dump, prepare-queue,
brief-code-todos, apply-rulings, execute-approved), truncated monthly by cron
— they are convenience, not state.
