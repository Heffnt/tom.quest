// workdir.mjs — the one deleter of a session workdir, keyed on the session id,
// and the two places outside a Session that call it.
//
// A session's workdir (/var/cache/tts/sessions/<id>) is deleted when its
// session ends, by whichever process observes the ending:
//
//   - the Session that ended it, through Session.cleanupWorkdir;
//   - the daemon's reap step, for an ending another process caused — a
//     force-close from the page, a stop landing on a session this daemon
//     adopted, a row that went terminal while the previous daemon held it.
//     The server stops listing the session; `reapUnlisted` drops the local
//     and deletes the workdir by id in the same breath.
//
// On 2026-09-22 the endings nobody cleaned up after held 10.8 GB of a 75 GB
// disk and a run died with ENOSPC.

import fsDefault from "node:fs";
import path from "node:path";

import { SESSIONS_ROOT } from "./overflow.mjs";

/**
 * Delete session `id`'s workdir, keeping overflow/ when it holds anything:
 * those are complete payloads Convex refused, which exist nowhere else, and
 * reingest-overflow.mjs removes them once Convex has taken them. Everything
 * else under the workdir is a clone and rebuildable.
 *
 * Returns "deleted", "kept-overflow" or null (nothing was there). Never
 * throws: a workdir that cannot be deleted costs disk, and a daemon that dies
 * of it costs Tom every live session.
 */
export function removeWorkdir(id, { root = SESSIONS_ROOT, fs = fsDefault, log = () => {} } = {}) {
  const base = path.join(root, String(id));
  try {
    if (!fs.existsSync(base)) return null;
    const overflowDir = path.join(base, "overflow");
    const rescued = fs.existsSync(overflowDir) && fs.readdirSync(overflowDir).length > 0;
    if (!rescued) {
      fs.rmSync(base, { recursive: true, force: true });
      return "deleted";
    }
    for (const entry of fs.readdirSync(base)) {
      if (entry === "overflow") continue;
      fs.rmSync(path.join(base, entry), { recursive: true, force: true });
    }
    log(`session ${id}: kept ${overflowDir} — it holds payloads Convex refused`);
    return "kept-overflow";
  } catch (err) {
    log(`session ${id}: workdir cleanup failed (ignored):`, String(err?.message ?? err));
    return null;
  }
}

/**
 * The daemon's reap step. A local the server no longer lists is terminal
 * server-side: either our own ended/failed report landed (reap once the
 * outbox drains) or the browser force-closed a session it thought orphaned
 * (kill the process — the server's word is final). Each local dropped here
 * has its workdir deleted by id, since the ending may have happened in no
 * Session of this process.
 */
export function reapUnlisted(sessions, listed, { remove = removeWorkdir } = {}) {
  for (const [id, s] of sessions) {
    if (listed.has(id)) continue;
    if (s.dead) {
      // Force-killed sessions were never drained (their outbox is dropped,
      // not flushed), so waiting on isDrained() would leak the map entry
      // forever. Dead means gone — delete unconditionally.
    } else if (s.status === "ended" || s.status === "failed") {
      if (!s.isDrained()) continue;
    } else {
      s.forceKill("server no longer lists this session");
    }
    sessions.delete(id);
    remove(id);
  }
}

/**
 * Once, on a daemon's first successful poll: delete every workdir whose
 * session is neither listed live nor held in the Session map.
 *
 * Why this pass exists rather than a cause deleted: a session that ended
 * while no daemon ran — a force-close from the page during a restart, a row
 * gone terminal while the box was down — had its ending observed by no
 * process, so nothing keyed on the ending can clean up after it; the first
 * daemon to start afterwards is the first process that can see the orphan.
 */
export function removeOrphanWorkdirs({
  known,
  root = SESSIONS_ROOT,
  fs = fsDefault,
  remove = (id) => removeWorkdir(id, { root, fs }),
} = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // no sessions root yet: nothing has run on this box
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    if (remove(entry.name) !== null) removed.push(entry.name);
  }
  return removed;
}
