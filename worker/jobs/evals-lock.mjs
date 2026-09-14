/**
 * ONE EVALS RUN ON THE BOX AT A TIME.
 *
 * WHAT WENT WRONG WITHOUT IT. worktreeFor (worker/jobs/evals.mjs) builds its
 * path out of the repo and the ref and nothing else, and it begins by removing
 * whatever is there. So a run started by hand and the five-minute `--serve`
 * cron, both asked about the same head, computed the same directory and each
 * deleted the other's checkout mid-run: the head worktree vanished under a
 * regeneration, the run died somewhere unrelated, and the row it posted said
 * the tree could not be read. Twice on 2026-09-14.
 *
 * TWO FIXES, AND BOTH ARE NEEDED. The path is made unique per process, so two
 * runs cannot name one directory even by accident; and this lock makes the
 * second run decline to start at all, so the box is never spending two sets of
 * model calls on one question. Uniqueness alone would let a hand-run and the
 * cron both score the same sha and post two rows over each other.
 *
 * WHY A PID FILE AND NOT flock(2). Node has no flock: every route to it means
 * holding a `flock` child alive for the length of the run and inheriting its
 * fate, which is more machinery than the guarantee is worth for one box. An
 * exclusive create (`wx`) is atomic on the same filesystem, which is the whole
 * requirement here, and the holder's pid in the file is what makes the refusal
 * READABLE — "held by pid 2118 since 14:02" is a thing an operator can act on,
 * where a silent blocked flock is not.
 *
 * A DEAD HOLDER DOES NOT HOLD ANYTHING. A run killed with SIGKILL leaves its
 * file behind; the next run finds the pid gone and takes the lock, saying so.
 * That is the failure mode a lock file has and flock does not, and it is
 * answered here rather than by a human deleting a file at 4 a.m.
 */

import fs from "node:fs";
import path from "node:path";

/** /var/lock is tmpfs on the box: a reboot clears it, which is right — no
 *  process survives a reboot holding this. */
export const EVALS_LOCK_FILE = process.env.TTS_EVALS_LOCK || "/var/lock/tts-evals.lock";

/** Whether a pid names a live process. `kill(pid, 0)` signals nothing and
 *  throws ESRCH when there is no such process; EPERM means it exists and
 *  belongs to somebody else, which still counts as alive. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function holderOf(file) {
  try {
    const held = JSON.parse(fs.readFileSync(file, "utf8"));
    return { pid: Number(held?.pid), at: Number(held?.at) || null, what: held?.what ?? null };
  } catch {
    // Unreadable or half-written: no holder can be named, so the age of the
    // file is all there is and the caller treats it as dead.
    return { pid: NaN, at: null, what: null };
  }
}

/**
 * Take the lock, or answer why not.
 *
 * Returns `{ held: true, release }` — `release` is idempotent and removes only
 * a file this process still owns — or `{ held: false, why }` with one sentence
 * naming the holder.
 */
export function takeEvalsLock({ file = EVALS_LOCK_FILE, what = "evals", now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: now(), what }), { flag: "wx" });
      let released = false;
      return {
        held: true,
        file,
        release: () => {
          if (released) return;
          released = true;
          // ONLY OUR OWN. A release that removed the file unconditionally would
          // hand the lock away when this process had already lost it to a
          // staleness sweep, and then two runs would hold it at once.
          if (holderOf(file).pid === process.pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const holder = holderOf(file);
      if (processAlive(holder.pid)) {
        const since = holder.at === null ? "an unknown time" : new Date(holder.at).toISOString();
        return {
          held: false,
          file,
          why: `${file} is held by pid ${holder.pid} (${holder.what ?? "unknown"}) since ${since}`,
        };
      }
      // The holder is gone. Clear its file and try once more; a second EEXIST
      // means somebody else won the race, and the loop ends returning their
      // refusal rather than stealing from a live process.
      fs.rmSync(file, { force: true });
    }
  }
  const holder = holderOf(file);
  return { held: false, file, why: `${file} was taken by pid ${holder.pid} while this run was clearing it` };
}

/** A worktree directory older than this is nobody's: no evals run lasts a day,
 *  so what is left is the debris of one that was killed. */
export const STALE_WORKTREE_MS = 24 * 60 * 60 * 1000;

/**
 * Remove worktree directories left by runs that died, under `root`.
 *
 * WHY IT IS SAFE NOW AND WAS NOT BEFORE. While every run computed the same
 * path for a ref, a directory's age said nothing about whose it was. Now the
 * path carries the pid of the run that made it, so a directory is stale when
 * its process is gone — and the day-old floor is the belt to that braces, for
 * a pid that has been recycled onto something else entirely.
 *
 * It removes the directory and NOT the git registration, which is what `git
 * worktree prune` in the cache clone is for; worktreeFor already prunes before
 * it adds.
 */
export function pruneStaleWorktrees(root, { now = Date.now, olderThan = STALE_WORKTREE_MS } = {}) {
  const removed = [];
  let repos;
  try {
    repos = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No work directory yet: nothing has ever run here, so nothing is stale.
    return removed;
  }
  for (const repo of repos) {
    if (!repo.isDirectory()) continue;
    const repoDir = path.join(root, repo.name);
    let trees;
    try {
      trees = fs.readdirSync(repoDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const tree of trees) {
      if (!tree.isDirectory()) continue;
      const dir = path.join(repoDir, tree.name);
      const owner = Number(/\.(\d+)$/.exec(tree.name)?.[1]);
      const abandoned = Number.isInteger(owner) && !processAlive(owner);
      let age;
      try {
        age = now() - fs.statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      // A dead owner is enough on its own. The age floor is what covers a
      // directory whose name carries no pid — every worktree made before this
      // round — and one whose pid has been recycled onto something else.
      if (!abandoned && age < olderThan) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch {
        // A directory that will not go is not a reason to fail the run.
      }
    }
  }
  return removed;
}
