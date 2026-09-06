// lib.mjs — env, fetch, backoff, and truncation helpers for the session-host
// daemon (worker/session-host/). Companions: session.mjs (the per-session
// class) and session-host.mjs (the poll loop).
//
// The env-file parsing itself is NOT here: it is worker-env.mjs, the one body
// the cron jobs read too. It is reached through ./worker-env.mjs — a symlink
// to ../jobs/worker-env.mjs — because setup.sh installs the two directories
// to different depths (/opt/tts vs /opt/tts/session-host), so a spelled-out
// ../jobs import would resolve in the repo and dangle after install. That
// file's header carries the full reasoning.
//
// What stays here is this daemon's own required-key list: CONVEX_SITE_URL +
// SESSIONS_WORKER_KEY and nothing else (GH_TOKEN is optional — without it,
// repo clones fall back to anonymous https, which works for public repos and
// fails loudly for private ones).

import { ENV_PATH, loadEnv as loadWorkerEnv } from "./worker-env.mjs";
import { redactSecrets } from "./redact.mjs";
import { overflowFor } from "./overflow.mjs";

export { ENV_PATH };
// The credential filter every persisted row passes through, applied in
// sessionsFetch below. Its body is redact.mjs — dependency-free for the same
// reason env-scrub.mjs is.
export { redactSecrets } from "./redact.mjs";
// The secret-name scrub every model-reachable spawn applies. Its body is
// env-scrub.mjs — dependency-free so the repo's vitest can fence the list,
// which it cannot do through this file (the worker-env symlink above is a
// plain text file on a Windows checkout). Callers import it from here.
export { scrubbedEnv, SCRUBBED_SECRET_NAMES } from "./env-scrub.mjs";
// Overflow storage: the complete payload behind the 32KB cut. Dependency-free
// for the same reason, and re-exported here so session.mjs has one import.
export {
  OVERFLOW_CHUNK_BYTES,
  chunkUtf8,
  isPermanentStatus,
  overflowFor,
  overflowPath,
  sendOverflow,
  writeOverflowFallback,
} from "./overflow.mjs";

export function loadEnv(path = ENV_PATH) {
  return loadWorkerEnv({
    path,
    require: ["CONVEX_SITE_URL", "SESSIONS_WORKER_KEY"],
  });
}

// stdout with the daemon's prefix; journald adds timestamps, so we don't.
export function log(...args) {
  console.log("[session-host]", ...args);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// POST a /sessions/* endpoint on the Convex site origin. Always POST, always
// JSON — both routes take bodies. Auth is X-Sessions-Key: the session
// surface's OWN key, deliberately not X-TTS-Key (one leaked key must not
// open the other surface — see convex/http.ts). Throws on non-2xx with the
// response text included so journald shows WHY a call failed; the thrown
// error also carries `status` (the HTTP status) and `bodyText` (the server's
// error text, first 300 chars) so callers can tell a PERMANENT 4xx rejection
// from a transient failure instead of blind-retrying everything forever
// (review fix: permanent-400 ingest wedge). Optional timeoutMs aborts the
// request — used for the best-effort final flush on force-kill.
export async function sessionsFetch(env, path, body, { timeoutMs } = {}) {
  const url = env.CONVEX_SITE_URL.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Sessions-Key": env.SESSIONS_WORKER_KEY,
      "Content-Type": "application/json",
    },
    // The one choke point: every row this daemon persists is serialized here,
    // AFTER the 32KB cut below has already run, so the redaction marker is in
    // the final bytes and cannot itself be sliced.
    body: redactSecrets(JSON.stringify(body)),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.bodyText = text.slice(0, 300);
    throw err;
  }
  return JSON.parse(text);
}

// GET a /sessions/* endpoint with query parameters, same key and same error
// contract as sessionsFetch. One caller today: the fork-transcript fetch
// (GET /sessions/transcript?sessionId=&cursor=), which is a read and so a
// GET by the server's contract. Runs in the daemon only — the ingest key
// never enters a session shell.
export async function sessionsGet(env, path, params = {}, { timeoutMs } = {}) {
  const url = new URL(env.CONVEX_SITE_URL.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    method: "GET",
    headers: { "X-Sessions-Key": env.SESSIONS_WORKER_KEY },
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.bodyText = text.slice(0, 300);
    throw err;
  }
  return JSON.parse(text);
}

// Retry delay: 1s, 2s, 4s, ... capped at 30s, with ±25% jitter so a fleet of
// stuck requests doesn't retry in lockstep. Used by both the poll loop and
// per-session ingest retries — blind retries are SAFE by design (the server's
// per-session seq floor drops replayed rows).
export function backoffMs(attempt) {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

// Cap for any single content payload persisted to Convex (tool inputs, tool
// results, thinking) — a runaway 2MB grep result must not blow up the
// transcript row or the ingest body. 32KB ratified in the daemon spec.
export const TRUNCATE_LIMIT = 32 * 1024;

// Tighter cap for error-MESSAGE strings (finalize "error" rows, endedReason,
// claim-failure reports). git runs with an 8MB maxBuffer and Convex caps a
// document at ~1MB, so an untruncated failure report could itself be rejected
// at ingest — the failure path failing (review fix: unbounded error text).
export const ERROR_TEXT_LIMIT = 8 * 1024;

// The text a row's payload becomes on the way to Convex: a string as itself,
// anything else as its JSON. One home, because the cut below and the overflow
// copy beside it must agree on what "the payload" is down to the byte — the
// stored hash is worthless otherwise. Returns null for a value with no JSON
// form at all (bare undefined).
export function rowText(value) {
  if (typeof value === "string") return value;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  return json === undefined ? null : json;
}

// Truncate a value destined for a Convex row. Returns { value, note? }:
// `value` passes through untouched when small enough; otherwise it becomes a
// sliced STRING (of the raw text for strings, of the JSON for everything
// else) and `note` says explicitly what was cut — the explicit truncation
// note the spec requires, so the UI can say "truncated" instead of silently
// showing a mangled tail.
export function truncated(value, limit = TRUNCATE_LIMIT) {
  const text = rowText(value);
  if (text === null) return { value: null }; // e.g. bare undefined
  if (text.length <= limit) return { value };
  const kind = typeof value === "string" ? "" : " (JSON)";
  return {
    value: text.slice(0, limit),
    note: `truncated by session-host${kind}: ${text.length} chars -> ${limit}`,
  };
}

// The same cut, plus the complete payload for the rows whose content IS the
// agent's context (thinking, assistant text, tool inputs, tool results,
// delivered turns). `overflow` is present exactly when the cut fired, and
// carries the redacted full text with its sha256, byte length and chunks —
// session.mjs stores it through POST /sessions/overflow and stamps the hash
// on the row, so a short rendered view keeps the full bytes retrievable
// (the transcript principle).
//
// Deliberately NOT used for the ERROR_TEXT_LIMIT cut: those strings are the
// daemon's own failure reports, not anything a model read, and their 8KB
// bound exists so the failure path cannot itself be rejected.
export function cutWithOverflow(value, limit = TRUNCATE_LIMIT) {
  const cut = truncated(value, limit);
  if (!cut.note) return cut;
  return { ...cut, overflow: overflowFor(rowText(value)) };
}
