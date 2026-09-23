# The Jarvis Box's disk

The box owns no state and keeps nothing it cannot lose. Every directory below
is rebuildable — a clone, a cache, a transcript the record already holds —
with two exceptions, marked in the table. So the question is never whether a
directory may be deleted; it is who deletes it and when.

One volume, `/dev/sda1`, 75 GB. `/tmp` is a separate 3.8 GB tmpfs: what it
holds is RAM, it empties on reboot, and it never costs the disk. A run that
dies of ENOSPC on `/tmp` and a run that dies of ENOSPC on `/` are two different
faults.

The sizes are from 2026-09-23, measured with `du -x --max-depth=1`, which
counts a hardlinked file once per pass. pnpm hardlinks a worktree's
`node_modules` into `/var/cache/tts/pnpm-store`, so a per-directory `du -s`
reports the same bytes twice and the total is the honest number.

## What grows

| directory | 2026-09-23 | what it holds | who deletes it, and when |
| --- | --- | --- | --- |
| `/var/cache/tts/sessions/<id>` | 10.7 GB | one workdir per session: a fresh clone per repo the session named | `Session.cleanupWorkdir` when the session ends, and `worker/session-host/workdir-sweep.mjs` hourly for any workdir no live Session speaks for and nothing has touched for a day |
| `/var/cache/tts/sessions/<id>/overflow` | 0 | **keep** — complete payloads Convex refused; they exist nowhere else | `worker/session-host/reingest-overflow.mjs`, hourly, once Convex has taken the payload; both sweeps above keep it |
| `/var/cache/tts/runs/repos/*.git` | 4.5 GB | the bare mirrors every run's worktree is cut from | nobody: refreshed in place, never deleted. WikiTom is 3.9 GB of it, most of that the `sessions/` archive in its history |
| `/var/cache/tts/runs/work/<id>` | 1.9 GB | one worktree per run, plus its `stderr.log` | `box-run.mjs`'s reap, on every exit path — the child's close, a throw, a signal, a full disk. `--keep-worktree` is how to ask it not to |
| `/var/cache/tts/runs/store` | 1.7 GB | the run store, standing in for the object store that is not provisioned | nobody, until `RUN_STORE_ENDPOINT` and its three companions are set and the store moves off the box. The sweep already reports this as a failure every pass |
| `/var/cache/tts/runs/state` | 82 MB | one cursor per run file the sweep has ingested | nobody; a cursor is small and the sweep needs it |
| `/var/cache/tts/desktop/<name>` | 6.9 GB | Tom's desktop sessions' standing checkouts, one per repo, plus review worktrees with their `node_modules` | nobody: never reset by design (`worker/AGENTS.md`, "Desktop sessions"). Tom's to prune |
| `/var/cache/tts/pnpm-store` | 1.0 GB | the shared pnpm store every worktree's install hardlinks from | nobody; deleting it makes the next install slow, not wrong |
| `/root/wikitom` | 7.3 GB | the box's WikiTom checkout: 4.3 GB of `.git` and 2.9 GB of `sessions/` in the working tree | nobody: it is **keep** in the sense that it is a checkout with a remote, but the disk it costs is the archive's, and that archive is what the nightly push keeps adding to |
| `/root/.claude-accounts/<slot>` | 4.9 GB | the two Claude Max slots' config and every run's JSONL transcript | nobody on the box. The sweep ingests each transcript into the record and computes deletion eligibility, but `RUN_DELETE_AFTER_UPLOAD` is off, so nothing is unlinked |
| `/root/.codex/sessions` | 728 MB | the same, for Codex rollouts | the same: ingested, never deleted |
| `/root/.npm`, `/root/.cache`, `/root/.local` | 5.2 GB | npm, pnpm and pip caches | nobody; safe to empty at any time |
| `/root/tom.quest` | 1.2 GB | the box's own checkout, which `worker/setup.sh` resets hard on every rollout | nobody: it is the rollout's working copy |
| `/var/log/tts` | 3.1 MB | the cron jobs' logs | logrotate |
| `/tmp/codex-run-*` | tmpfs | one work directory per Codex run: its answer file and its stderr log | `scripts/codex-run.mjs`, on exit and on SIGINT, SIGTERM or SIGHUP. A SIGKILL still leaks one, and the tmpfs empties on reboot |
| `/tmp/tts-audit-reg-*` | tmpfs | the audit's registration spool, one per audit | `worker/jobs/audit.mjs`, in a `finally` |
| `/tmp/*` from the test suites | tmpfs, ~1 GB | `mkdtempSync` fixtures from `pnpm test`; about 35,000 of them | nobody; the tmpfs empties on reboot. Run `pnpm test` with `TMPDIR` on the real disk and this is a disk problem instead |

## The warning before the wall

`worker/runs/sweep.mjs` runs every two minutes and checks the free space on
the volume the run files live on. Under 10 GB it posts a `runs-sweep:disk`
job failure naming the free space and the three biggest directories, which the
digest carries; the measurement behind the three names is taken at most once an
hour. Over 10 GB it posts the matching job-ok, so the failure clears itself.

That check fired at 20:53, 20:56 and 20:57 UTC on 2026-09-22. At 20:59 the
volume filled and a run died with ENOSPC. What it said then was that the volume
had less than 10 GB free, and nothing about where the room had gone.

## Reclaiming by hand

The one command, which is safe at any time and needs nothing stopped:

```sh
for d in /var/cache/tts/sessions/*/; do
  [ -n "$(ls -A "$d/overflow" 2>/dev/null)" ] && continue
  [ -n "$(find "$d" -newermt '-1 day' -print -quit)" ] && continue
  rm -rf "$d"   # swap for `echo "$d"` to see the list first
done
```

That is the hourly sweep's rule, run now: every session workdir with nothing in
it touched in the last day goes, and one holding a refused payload stays. It was
10.7 GB on 2026-09-23. Unlike the sweep it does not know which session has a
turn running, so it can delete a workdir out from under a live turn — run it
when the fleet is quiet, or read the list first.

If more is needed, in the order of what costs least to lose:

```sh
# Run worktrees whose run is over — the reap missed these before it ran on
# every exit path. The list first; nothing here is deleted while a run holds it.
cat /var/cache/tts/runs/semaphore.json; ls -l /var/cache/tts/runs/work
git -C /var/cache/tts/runs/repos/tom.quest.git worktree remove --force <path>
git -C /var/cache/tts/runs/repos/tom.quest.git worktree prune

# Package caches: slow to rebuild, impossible to lose.
rm -rf /root/.npm /root/.cache/pnpm

# Desktop checkouts Tom has finished with. Look before deleting: these are the
# one place on the box where uncommitted work can be sitting.
du -sh /var/cache/tts/desktop/*
```

Not by hand, and not at all: `/var/cache/tts/sessions/*/overflow`, which holds
the only copy of a payload Convex refused, and anything under `/root/wikitom`
that is not committed and pushed.
