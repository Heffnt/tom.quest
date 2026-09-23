// workdir-sweep.mjs — the one thing that deletes a session workdir no live
// Session speaks for.
//
// THE HOLE THIS CLOSES. `Session.cleanupWorkdir` (session.mjs) is the only
// deleter of /var/cache/tts/sessions/<id>, and it is a method: it runs when a
// Session object in THIS process ends its session. Every other way a session
// can finish leaves the directory for good —
//
//   - the daemon was killed (deploy, crash, OOM) while the session was live,
//     and the session then ended server-side or was never resumed;
//   - the session ended in a previous daemon's process, so the row went
//     terminal and /sessions/poll no longer carries it: no Session is ever
//     constructed for it again, and nothing walks the directory;
//   - the session is idle — parked by an adoption after a restart — which is
//     not an ending at all, so cleanupWorkdir is never reached, and a full
//     clone of tom.quest or WikiTom sits there until someone notices.
//
// On 2026-09-22 those three together held 10.8 GB of a 75 GB disk and the box
// filled: a run died with ENOSPC. Hence a sweep over the directory itself,
// which is the only reading under which a workdir's fate does not depend on
// which process happened to be running when its session finished.
//
// WHY AN IDLE SESSION'S WORKDIR MAY GO. #deliverUserTurn calls
// `ensureWorkdir({ forResume: true })` before it resumes (session.mjs), which
// re-clones a workdir that vanished; the SDK session resumes by id with its
// context intact. So the cost of deleting an idle session's clone is one
// re-clone on Tom's next turn, and the cost of keeping it is a gigabyte per
// conversation, for ever.
//
// THE TWO THINGS IT MUST NEVER TOUCH: a workdir with a turn running in it, and
// overflow/. The first is the `busy` set below, taken from the daemon's own
// Session map. The second is the same exception cleanupWorkdir makes — those
// payloads exist nowhere else, and reingest-overflow.mjs removes them once
// Convex has taken them.

import fsDefault from "node:fs";
import path from "node:path";

import { SESSIONS_ROOT } from "./overflow.mjs";

// A workdir untouched for this long belongs to no turn anyone is waiting on.
// One day, not one hour: Tom returns to a conversation the same evening, and
// the point is to reclaim the clones of sessions he has moved on from, not to
// make every second turn pay for a fresh clone.
export const STALE_WORKDIR_MS = 24 * 60 * 60_000;

// A Session holds its workdir against the sweep while it is in either of these
// statuses: `starting` is cloning into it and `running` has a turn writing in
// it. `idle`, `ended` and `failed` all mean nothing is in flight.
const BUSY_STATUSES = new Set(["starting", "running"]);

/**
 * The newest mtime of the directory and its immediate children — what
 * "untouched" has to mean here. The directory's own mtime changes only when a
 * name is added or removed at the top level, so for a one-repo session (whose
 * whole checkout is a single child directory) it never moves after the clone,
 * and a workdir in daily use would read as a month old.
 */
export function workdirTouchedAt(dir, fs = fsDefault) {
  let newest = 0;
  try {
    newest = fs.statSync(dir).mtimeMs;
  } catch {
    return null; // vanished between the listing and the stat — nothing to reap
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return newest;
  }
  for (const entry of entries) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(dir, entry)).mtimeMs);
    } catch {
      // Same race, one level down; the other entries still answer.
    }
  }
  return newest;
}

/**
 * The session ids whose workdir may be deleted now: every directory under
 * `root` that no live Session is working in and that nothing has touched for
 * `maxAgeMs`.
 *
 * `busy` is the set of ids the caller's Session map holds mid-turn. Passing
 * the ids rather than the map keeps this function free of the daemon.
 */
export function reapableWorkdirs({
  root = SESSIONS_ROOT,
  busy = new Set(),
  now = Date.now(),
  maxAgeMs = STALE_WORKDIR_MS,
  fs = fsDefault,
} = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no sessions root yet: nothing has run on this box
  }
  const reapable = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (busy.has(entry.name)) continue;
    const touchedAt = workdirTouchedAt(path.join(root, entry.name), fs);
    if (touchedAt === null) continue;
    if (now - touchedAt < maxAgeMs) continue;
    reapable.push(entry.name);
  }
  return reapable;
}

/**
 * Delete one session's workdir, keeping overflow/ when it holds anything. The
 * same rule and the same order as Session.cleanupWorkdir, because it is the
 * same decision: everything under /var/cache is rebuildable EXCEPT the
 * payloads Convex refused.
 *
 * Returns "deleted", "kept-overflow" or null (nothing was there).
 */
export function reapWorkdir(dir, fs = fsDefault) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let overflow = [];
  try {
    overflow = fs.readdirSync(path.join(dir, "overflow"));
  } catch {
    overflow = [];
  }
  if (overflow.length === 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return "deleted";
  }
  for (const entry of entries) {
    if (entry === "overflow") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  return "kept-overflow";
}

/**
 * One pass: find the reapable workdirs and delete them. Returns
 * { deleted, keptOverflow, bytes } — `bytes` is what the pass freed, so the
 * daemon's log line says the thing worth knowing.
 *
 * Never throws: a sweep that cannot delete a directory has cost the box
 * disk, and a daemon that dies of it costs Tom every live session.
 */
export function sweepWorkdirs({
  root = SESSIONS_ROOT,
  busy = new Set(),
  now = Date.now(),
  maxAgeMs = STALE_WORKDIR_MS,
  fs = fsDefault,
  log = () => {},
} = {}) {
  let deleted = 0;
  let keptOverflow = 0;
  let bytes = 0;
  for (const id of reapableWorkdirs({ root, busy, now, maxAgeMs, fs })) {
    const dir = path.join(root, id);
    try {
      const size = directoryBytes(dir, fs);
      const outcome = reapWorkdir(dir, fs);
      if (outcome === "deleted") deleted += 1;
      else if (outcome === "kept-overflow") keptOverflow += 1;
      else continue;
      bytes += size;
      log(`workdir-sweep: session ${id} ${outcome} (${size} bytes)`);
    } catch (err) {
      log(`workdir-sweep: session ${id} kept — ${String(err?.message ?? err)}`);
    }
  }
  return { deleted, keptOverflow, bytes };
}

/** The bytes a directory holds, counted before it is deleted. */
function directoryBytes(dir, fs) {
  let total = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directoryBytes(child, fs);
      else if (entry.isFile()) total += fs.statSync(child).size;
    } catch {
      // A file that went away mid-count contributes nothing.
    }
  }
  return total;
}
