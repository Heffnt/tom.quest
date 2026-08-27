# DTS worker box

The always-on home for DTS's scheduled headless-Claude jobs: a Hetzner CAX11
(Ubuntu 24.04, ARM64) that does exactly two things on a schedule:

1. **poll-dump** (every 2 min) — reads new human messages from the Slack
   `#dump` channel and submits each one to Convex as an unprepared todo.
2. **prepare-queue** (4:30 a.m. New York) — runs headless Claude Code to pick
   today's queue (≤7 items) and write the daily digest, and posts both to
   Convex. If it fails, the Convex-side fallback prep (4:45) and the
   always-sends 5 a.m. digest cover the day — a digest that reports missing
   prep is the "worker is broken" signal; no digest at all means Convex/Slack
   is broken. That split is the whole monitoring story.

## The no-state rule

**This box owns no durable state.** Everything that matters lives in Convex.
The only local file with memory is the Slack poll cursor
(`/var/lib/dts/dump-cursor`); losing it just means up to 24 hours of `#dump`
messages get re-captured as duplicates, which Tom can archive. Losing the
whole box loses nothing but a paused digest.

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
node /opt/dts/poll-dump.mjs             # capture anything new in #dump now
node /opt/dts/prepare-queue.mjs --force # prep today's queue regardless of hour
```

`--force` skips the 4-a.m.-New-York hour guard (cron fires the prep at both
08:30 and 09:30 UTC and the guard keeps exactly the slot that is 4:30 a.m. NY,
whichever side of daylight saving we're on).

## Logs

Cron output: `/var/log/dts/poll-dump.log` and `/var/log/dts/prepare-queue.log`
(truncated monthly by cron — they are convenience, not state).
