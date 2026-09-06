// overflow.mjs — the complete payload behind the 32KB cut.
//
// The transcript principle (lifeos update §1): the transcript is the complete
// record of the agent's context — Tom sees everything the agent saw. The
// daemon's 32KB cut (TRUNCATE_LIMIT in lib.mjs) is a RENDERING bound, not a
// storage bound: the cut still lands in the claudeMessages row, and the full
// bytes land beside it as ordered chunks in claudeMessageOverflow, keyed by
// (sessionId, seq) — the message's identity at the moment the daemon writes
// it, before Convex has given the row an _id.
//
// Chunks rather than Convex file storage, for three reasons:
//   1. the read side is an internalQuery (claudeSessions.internalMessageOverflow);
//      ctx.storage.get is only reachable from an action, so a file could never
//      be reassembled by a query the way the transcript page needs;
//   2. a chunk row is written INSIDE internalIngest's transaction, so the
//      hash on the message row and the bytes it names commit together, and the
//      seq floor that drops a replayed finalize row drops its chunks too;
//   3. nothing in this repo stores files today (one unused `iconStorageId`),
//      so a chunk table adds no new store to reason about.
//
// Redaction runs HERE, on the whole payload, before hashing and chunking —
// not only at the ingest choke point (sessionsFetch). A credential straddling
// a chunk boundary is two harmless halves to redactSecrets, so redacting the
// chunks would leak the exact thing redact.mjs exists to stop. The recorded
// sha256 is therefore the hash of the REDACTED text: it fences reassembly
// (what was stored is what comes back), not provenance of the raw bytes.
//
// Dependency-free apart from node builtins and redact.mjs, for the same reason
// env-scrub.mjs and redact.mjs are: lib.mjs imports the worker-env symlink,
// which is a plain text file on a Windows checkout, so the repo's vitest
// cannot load it — and this is exactly the kind of thing a test must fence
// (__tests__/overflow.test.mjs). lib.mjs re-exports what session.mjs needs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { redactSecrets } from "./redact.mjs";

// One chunk row's text. Convex caps a document at ~1MB; 256KB leaves room for
// the row's scalars and for the ingest body that carries one chunk at a time,
// so a 200MB tool result is a long sequence of small bounded requests rather
// than one impossible one.
export const OVERFLOW_CHUNK_BYTES = 256 * 1024;

// How many times one chunk POST is retried before the payload is written to
// disk instead. Bounded on purpose: an unbounded retry would hold the whole
// payload in memory behind a wedged upload for the life of the daemon.
export const OVERFLOW_MAX_ATTEMPTS = 6;

/**
 * Is this HTTP status a PERMANENT rejection — a validation error or an
 * oversized document, where re-sending the identical body only wedges the
 * queue? 408 and 429 are the two 4xx that mean "later", not "never".
 *
 * One home for the verdict: the ingest flush in session.mjs asks the same
 * question of the same error contract (sessionsFetch stamps `status` on what
 * it throws), and this file is the half of the pair a unit test can load.
 */
export function isPermanentStatus(status) {
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * Split `text` into strings of at most `limit` UTF-8 bytes each, never cutting
 * a code point in half: a slice that would end on a continuation byte
 * (10xxxxxx) walks back to the start of that character. Concatenating the
 * result reproduces `text` exactly.
 */
export function chunkUtf8(text, limit = OVERFLOW_CHUNK_BYTES) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length === 0) return [];
  const chunks = [];
  let start = 0;
  while (start < buf.length) {
    let end = Math.min(start + limit, buf.length);
    if (end < buf.length) {
      while (end > start && (buf[end] & 0xc0) === 0x80) end -= 1;
      // A single code point longer than the limit cannot happen (4 bytes max),
      // but never emit an empty chunk if one somehow could.
      if (end === start) end = Math.min(start + limit, buf.length);
    }
    chunks.push(buf.subarray(start, end).toString("utf8"));
    start = end;
  }
  return chunks;
}

/**
 * The complete payload, ready to store: `text` redacted, hashed and chunked.
 * `sha256` and `byteLength` describe the redacted text — the bytes a reader
 * gets back — so a reassembly can be checked against them.
 */
export function overflowFor(text, limit = OVERFLOW_CHUNK_BYTES) {
  const redacted = redactSecrets(text);
  const chunks = chunkUtf8(redacted, limit);
  return {
    text: redacted,
    sha256: crypto.createHash("sha256").update(redacted, "utf8").digest("hex"),
    byteLength: Buffer.byteLength(redacted, "utf8"),
    chunkCount: chunks.length,
    chunks,
  };
}

// Where every session's workdir lives on the box, and under it the one
// directory that outlives a session: <id>/overflow/<seq>, a complete payload
// Convex would not take. Named here rather than in session.mjs because
// reingest-overflow.mjs walks it without the daemon (session.mjs re-exports).
export const SESSIONS_ROOT = "/var/cache/tts/sessions";

/** Where a payload Convex refused is kept on the box. */
export function overflowPath(sessionsRoot, sessionId, seq) {
  return path.join(sessionsRoot, String(sessionId), "overflow", String(seq));
}

/**
 * Last resort for a payload Convex will not take: write the (already redacted)
 * bytes next to the session's workdir so the transcript can still be completed
 * by hand. Returns the path, or null if even the write failed.
 */
export function writeOverflowFallback(sessionsRoot, sessionId, seq, text) {
  const file = overflowPath(sessionsRoot, sessionId, seq);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return null;
  }
}

/**
 * What an upload failure is recorded as. Never the response body: the route
 * returns fixed strings today, but this string lands in an `error` row, an
 * event and journald, and the one thing that must never reach any of them is
 * payload text — so the contract is the status alone, and a message only for
 * an error that carried no response at all (a network failure).
 */
export function describeFailure(err) {
  if (typeof err?.status === "number") return `HTTP ${err.status}`;
  return String(err?.message ?? err).slice(0, 300);
}

/**
 * Upload one message's complete payload, chunk by chunk.
 *
 * `post` sends one chunk (session.mjs hands it POST /sessions/overflow) and
 * throws sessionsFetch's error — `status` set — on failure. Transient failures
 * back off and retry; a permanent rejection, or attempts running out, stops
 * and writes the payload to disk (`keep`) instead so nothing is dropped
 * silently. `stop()` is asked before every send and after every failed one:
 * true means the owner has abandoned this upload (force-kill) and has already
 * dealt with the bytes itself.
 *
 * Returns { ok: true, chunkCount }, { ok: false, error, path, index }, or
 * { ok: false, stopped: true, index }.
 */
export async function sendOverflow({
  post,
  sessionId,
  seq,
  overflow,
  sessionsRoot,
  sleep,
  backoffMs,
  maxAttempts = OVERFLOW_MAX_ATTEMPTS,
  log = () => {},
  stop = () => false,
  keep = writeOverflowFallback,
}) {
  const { chunks, chunkCount, text } = overflow;
  for (let index = 0; index < chunks.length; index++) {
    let attempt = 0;
    for (;;) {
      if (stop()) return { ok: false, stopped: true, index };
      try {
        await post({ sessionId, seq, index, chunkCount, text: chunks[index] });
        break;
      } catch (err) {
        attempt += 1;
        const permanent = isPermanentStatus(err?.status);
        const spent = attempt >= maxAttempts;
        if (permanent || spent) {
          const error = describeFailure(err);
          const file = keep(sessionsRoot, sessionId, seq, text);
          log(
            `session ${sessionId}: overflow seq ${seq} chunk ${index} ${
              permanent ? "REJECTED" : "gave up"
            } (${error}) — kept at ${file ?? "(write failed)"}`,
          );
          return { ok: false, error, path: file, index };
        }
        if (stop()) return { ok: false, stopped: true, index };
        await sleep(backoffMs(attempt));
      }
    }
  }
  return { ok: true, chunkCount };
}

/**
 * The daemon's overflow queue: complete payloads awaiting upload, and the
 * hold that keeps their finalize rows out of the flush until the bytes are
 * stored.
 *
 * `hold(row, overflow)` takes the finalize row (already in the outbox, its
 * seq assigned) and the payload behind it. `readyCount(rows)` is what the
 * flush asks: how many leading rows of the outbox may go — everything up to
 * the first held row, so a row never reaches Convex before its chunks and
 * seq order is preserved (the server's seq floor would drop a row that
 * arrived after a later one). One upload at a time, in seq order.
 *
 * On success the row is stamped `overflow: { sha256, byteLength, chunkCount }`
 * and released; `onStored(row)` fires so the owner flushes. On failure the
 * row is released UNSTAMPED, the bytes are on disk, and
 * `onUnstored({ seq, byteLength, error, path })` fires so the owner records
 * the loss (an `error` row and an overflowFailures entry). `abandon(reason)`
 * is the force-kill path: every queued and in-flight payload goes to disk and
 * is reported the same way, and every hold is released so the final flush
 * carries the rows. Never throws — a failure here costs the full copy of one
 * payload, never the transcript row, never the daemon.
 */
export class OverflowQueue {
  constructor({
    post,
    sessionId,
    sessionsRoot,
    sleep,
    backoffMs,
    log = () => {},
    onStored = () => {},
    onUnstored = () => {},
  }) {
    this.post = post;
    this.sessionId = sessionId;
    this.sessionsRoot = sessionsRoot;
    this.sleep = sleep;
    this.backoffMs = backoffMs;
    this.log = log;
    this.onStored = onStored;
    this.onUnstored = onUnstored;
    this.queue = [];
    this.inFlight = null;
    this.held = new Set();
    this.pumping = false;
    this.abandoned = false;
    // Resolves each time the pump comes to rest; tests await it.
    this.settled = Promise.resolve();
  }

  hold(row, overflow) {
    if (this.abandoned) {
      this.#unstored({ row, overflow }, "queue abandoned");
      return;
    }
    this.queue.push({ row, overflow });
    this.held.add(row.seq);
    this.settled = this.#pump();
  }

  /** How many leading rows of `rows` are not waiting on an upload. */
  readyCount(rows) {
    for (let i = 0; i < rows.length; i++) {
      if (this.held.has(rows[i].seq)) return i;
    }
    return rows.length;
  }

  /** Nothing queued, nothing in flight. */
  get idle() {
    return this.queue.length === 0 && this.inFlight === null;
  }

  /** Force-kill: everything still unstored goes to disk and is reported. */
  abandon(reason) {
    this.abandoned = true;
    const items = [this.inFlight, ...this.queue].filter(Boolean);
    this.inFlight = null;
    this.queue = [];
    for (const item of items) this.#unstored(item, reason);
  }

  #unstored(item, error, file) {
    const { row, overflow } = item;
    const path =
      file === undefined
        ? writeOverflowFallback(this.sessionsRoot, this.sessionId, row.seq, overflow.text)
        : file;
    this.held.delete(row.seq);
    this.onUnstored({
      seq: row.seq,
      byteLength: overflow.byteLength,
      error: String(error).slice(0, 300),
      path,
    });
  }

  async #pump() {
    if (this.pumping) return this.settled;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.abandoned) {
        const item = this.queue.shift();
        this.inFlight = item;
        const { row, overflow } = item;
        let res;
        try {
          res = await sendOverflow({
            post: this.post,
            sessionId: this.sessionId,
            seq: row.seq,
            overflow,
            sessionsRoot: this.sessionsRoot,
            sleep: this.sleep,
            backoffMs: this.backoffMs,
            log: this.log,
            stop: () => this.abandoned,
          });
        } catch (err) {
          // sendOverflow handles HTTP failure itself; anything reaching here
          // is a bug or an out-of-memory, and the bytes still go to disk.
          res = { ok: false, error: String(err?.message ?? err), path: null };
        }
        // abandon() already wrote this item to disk and reported it; the
        // row went up unstamped in the final flush. Nothing more to do.
        if (this.abandoned) return;
        this.inFlight = null;
        if (res.ok) {
          row.overflow = {
            sha256: overflow.sha256,
            byteLength: overflow.byteLength,
            chunkCount: overflow.chunkCount,
          };
          this.held.delete(row.seq);
          this.onStored(row);
        } else {
          this.#unstored(
            item,
            res.error ?? "upload failed",
            res.path ?? writeOverflowFallback(this.sessionsRoot, this.sessionId, row.seq, overflow.text),
          );
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
