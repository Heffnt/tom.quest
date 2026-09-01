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

export { ENV_PATH };

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
    body: redactGitHubTokens(JSON.stringify(body)),
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

// Last line of defense against a GitHub token landing in a transcript row.
// On 2026-08-30 a session read the token out of its clone's .git/config and
// typed it inline in gh commands, and the classifier's verdict rows carried
// it verbatim into Convex — where a transcript lives forever. The token no
// longer sits in the clone (credential helper) or the shell env (scrub), but
// this daemon persists model-authored text, so the ingest body itself is the
// one choke point every row passes through. GitHub token shapes are prefixed
// and unambiguous (gh?[pousr]_… / github_pat_…), so the replacement cannot
// hit ordinary prose; the character class is JSON-escape-free, so replacing
// inside a serialized string never breaks the JSON.
export function redactGitHubTokens(text) {
  return text.replace(
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    "[REDACTED-GITHUB-TOKEN]",
  );
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

// Truncate a value destined for a Convex row. Returns { value, note? }:
// `value` passes through untouched when small enough; otherwise it becomes a
// sliced STRING (of the raw text for strings, of the JSON for everything
// else) and `note` says explicitly what was cut — the explicit truncation
// note the spec requires, so the UI can say "truncated" instead of silently
// showing a mangled tail.
export function truncated(value, limit = TRUNCATE_LIMIT) {
  if (typeof value === "string") {
    if (value.length <= limit) return { value };
    return {
      value: value.slice(0, limit),
      note: `truncated by session-host: ${value.length} chars -> ${limit}`,
    };
  }
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  if (json === undefined) return { value: null }; // e.g. bare undefined
  if (json.length <= limit) return { value };
  return {
    value: json.slice(0, limit),
    note: `truncated by session-host (JSON): ${json.length} chars -> ${limit}`,
  };
}
