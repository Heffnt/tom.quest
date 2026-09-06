#!/usr/bin/env node
// reingest-overflow.mjs — finish storing the complete payloads the daemon
// could not.
//
// When a message's overflow upload fails for good (a permanent rejection, or
// attempts spent, or a force-kill mid-upload), session.mjs writes the redacted
// payload to /var/cache/tts/sessions/<id>/overflow/<seq>, lands the finalize
// row WITHOUT its `overflow` stamp, writes an `error` row naming the file, and
// the server records a session-overflow-unstored event naming it too. That
// directory is the one thing a session dir keeps after cleanup, and until this
// job runs nothing reads it.
//
// Hourly by cron (/etc/cron.d/tts, installed by setup.sh). Each file is one
// payload; for each, the chunks go up again through POST /sessions/overflow
// (an upsert — a partial earlier upload is overwritten, not doubled), then
// POST /sessions/overflow/stamp names them from the row, and only after the
// stamp is acknowledged is the file deleted. A file that still cannot be
// stored stays where it is and is named in this job's log with the reason —
// that log, /var/log/tts/reingest-overflow.log, is the runbook: a file that
// keeps appearing there needs a hand.
//
// Lives beside the daemon rather than in worker/jobs/ because it is the
// daemon's own last step: it reads the daemon's directory, chunks with the
// daemon's chunker, and opens the daemon's door with the daemon's key
// (SESSIONS_WORKER_KEY, not TTS_WORKER_KEY). setup.sh installs this directory
// whole, so ./overflow.mjs and ./lib.mjs resolve the same on the box as here.
//
// Files younger than MIN_AGE_MS are left alone: the daemon writes them with
// one writeFileSync, and re-ingesting a file still being written would store
// a prefix under a hash of the prefix and then delete the whole.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { backoffMs, loadEnv, log, sessionsFetch, sleep } from "./lib.mjs";
import { SESSIONS_ROOT, overflowFor, sendOverflow } from "./overflow.mjs";

export const MIN_AGE_MS = 60_000;

/**
 * Every payload file under `sessionsRoot` old enough to be whole, as
 * { sessionId, seq, file }, sessions and seqs in order.
 */
export function listOverflowFiles(
  sessionsRoot,
  { now = Date.now(), minAgeMs = MIN_AGE_MS } = {},
) {
  const found = [];
  let sessions;
  try {
    sessions = fs.readdirSync(sessionsRoot);
  } catch {
    return found; // no sessions dir yet — nothing to do
  }
  for (const sessionId of sessions.sort()) {
    const dir = path.join(sessionsRoot, sessionId, "overflow");
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const seqs = names
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b);
    for (const seq of seqs) {
      const file = path.join(dir, String(seq));
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || now - stat.mtimeMs < minAgeMs) continue;
      found.push({ sessionId, seq, file });
    }
  }
  return found;
}

/** Remove the file, then the directories it leaves empty (best-effort). */
function removeStored(file) {
  fs.unlinkSync(file);
  for (const dir of [path.dirname(file), path.dirname(path.dirname(file))]) {
    try {
      fs.rmdirSync(dir); // refuses a non-empty dir — a live session's workdir stays
    } catch {
      return;
    }
  }
}

/**
 * One file: chunks up, stamp written, file gone. `post` and `stamp` are the
 * two routes (sessionsFetch-shaped: throw with `status` on non-2xx).
 * Returns { ok: true } or { ok: false, stage, error } — the file stays.
 */
export async function reingestFile({
  file,
  sessionId,
  seq,
  post,
  stamp,
  sleep: pause = sleep,
  backoffMs: backoff = backoffMs,
  log: say = log,
}) {
  const text = fs.readFileSync(file, "utf8");
  // Redacted again on the way through: idempotent on a file the daemon wrote
  // (already redacted), and the stamp is of whatever is uploaded, so the two
  // cannot disagree.
  const overflow = overflowFor(text);
  const sent = await sendOverflow({
    post,
    sessionId,
    seq,
    overflow,
    sessionsRoot: undefined,
    sleep: pause,
    backoffMs: backoff,
    log: say,
    // The file IS the fallback; never rewrite it under itself mid-failure.
    keep: () => file,
  });
  if (!sent.ok) {
    return { ok: false, stage: "chunks", error: sent.error ?? "stopped" };
  }
  try {
    await stamp({
      sessionId,
      seq,
      sha256: overflow.sha256,
      byteLength: overflow.byteLength,
      chunkCount: overflow.chunkCount,
    });
  } catch (err) {
    return {
      ok: false,
      stage: "stamp",
      error:
        typeof err?.status === "number"
          ? `HTTP ${err.status}`
          : String(err?.message ?? err).slice(0, 300),
    };
  }
  removeStored(file);
  return { ok: true };
}

/**
 * The whole sweep. Returns { files, stored, kept } where `kept` names each
 * file that stays and why.
 */
export async function reingestOverflow({
  sessionsRoot = SESSIONS_ROOT,
  post,
  stamp,
  now = Date.now(),
  minAgeMs = MIN_AGE_MS,
  sleep: pause = sleep,
  backoffMs: backoff = backoffMs,
  log: say = log,
} = {}) {
  const files = listOverflowFiles(sessionsRoot, { now, minAgeMs });
  const kept = [];
  let stored = 0;
  for (const { sessionId, seq, file } of files) {
    let res;
    try {
      res = await reingestFile({
        file,
        sessionId,
        seq,
        post,
        stamp,
        sleep: pause,
        backoffMs: backoff,
        log: say,
      });
    } catch (err) {
      res = { ok: false, stage: "read", error: String(err?.message ?? err) };
    }
    if (res.ok) {
      stored += 1;
      say(`session ${sessionId}: overflow seq ${seq} stored from ${file}`);
    } else {
      kept.push({ file, stage: res.stage, error: res.error });
      say(
        `session ${sessionId}: overflow seq ${seq} still unstored (${res.stage}: ${res.error}) — kept at ${file}`,
      );
    }
  }
  return { files: files.length, stored, kept };
}

async function main() {
  const env = loadEnv();
  const summary = await reingestOverflow({
    post: (body) => sessionsFetch(env, "/sessions/overflow", body),
    stamp: (body) => sessionsFetch(env, "/sessions/overflow/stamp", body),
  });
  if (summary.files > 0) {
    log(
      `reingest-overflow: ${summary.stored}/${summary.files} stored, ${summary.kept.length} kept`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    log("reingest-overflow failed:", String(err?.message ?? err));
    process.exit(1);
  });
}
