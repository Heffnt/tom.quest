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
 * Upload one message's complete payload, chunk by chunk.
 *
 * `post` sends one chunk (session.mjs hands it POST /sessions/overflow) and
 * throws sessionsFetch's error — `status` set — on failure. Transient failures
 * back off and retry; a permanent rejection, or attempts running out, stops
 * and writes the payload to disk instead so nothing is dropped silently.
 *
 * Returns { ok: true, chunkCount } or { ok: false, error, path, index }.
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
}) {
  const { chunks, sha256, byteLength, chunkCount, text } = overflow;
  for (let index = 0; index < chunks.length; index++) {
    let attempt = 0;
    for (;;) {
      try {
        await post({
          sessionId,
          seq,
          index,
          chunkCount,
          sha256,
          byteLength,
          text: chunks[index],
        });
        break;
      } catch (err) {
        attempt += 1;
        const permanent = isPermanentStatus(err?.status);
        const spent = attempt >= maxAttempts;
        if (permanent || spent) {
          const error = String(err?.bodyText ?? err?.message ?? err).slice(
            0,
            300,
          );
          const file = writeOverflowFallback(
            sessionsRoot,
            sessionId,
            seq,
            text,
          );
          log(
            `session ${sessionId}: overflow seq ${seq} chunk ${index} ${
              permanent ? "REJECTED" : "gave up"
            } — kept at ${file ?? "(write failed)"}:`,
            error,
          );
          return { ok: false, error, path: file, index };
        }
        await sleep(backoffMs(attempt));
      }
    }
  }
  return { ok: true, chunkCount };
}
