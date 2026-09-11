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
  OverflowQueue,
  SESSIONS_ROOT,
  chunkUtf8,
  isPermanentStatus,
  overflowFor,
  overflowPath,
  sendOverflow,
  writeOverflowFallback,
} from "./overflow.mjs";
// The cut has its own dependency-free home so offline parsers and their tests
// use the daemon's exact rendering bound without loading worker-env.mjs.
// Keep the legacy source mirror readable: TRUNCATE_LIMIT = 32 * 1024 in cut.mjs.
export {
  TRUNCATE_LIMIT,
  ERROR_TEXT_LIMIT,
  rowText,
  cutRow,
  truncated,
  cutWithOverflow,
} from "./cut.mjs";

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
