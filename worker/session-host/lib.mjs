// lib.mjs — env, fetch, backoff, and truncation helpers for the session-host
// daemon (worker/session-host/). Companions: session.mjs (the per-session
// class) and session-host.mjs (the poll loop).
//
// loadEnv is a minimal copy of worker/jobs/tts-lib.mjs's loadEnv (same file
// format, same tolerances — attribution: that file is the original) rather
// than a ../jobs relative import, because setup.sh installs the two
// directories to DIFFERENT places on the box (/opt/tts vs
// /opt/tts/session-host), so a relative import that resolves in the repo
// would dangle after install. Divergence risk is tiny: the KEY=VALUE format
// is frozen. The one real difference is the required-keys list — this daemon
// needs CONVEX_SITE_URL + SESSIONS_WORKER_KEY and nothing else (GH_TOKEN is
// optional: without it, repo clones fall back to anonymous https, which
// works for public repos and fails loudly for private ones).

import fs from "node:fs";

export const ENV_PATH = "/etc/tts/worker.env";

// Read /etc/tts/worker.env (KEY=VALUE lines; '#' comments and blank lines
// ignored; optional leading "export " and optional surrounding quotes
// tolerated so the same file can be `source`d from bash if ever needed).
export function loadEnv(path = ENV_PATH) {
  const env = {};
  const text = fs.readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue; // not KEY=VALUE — silently skip
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  for (const required of ["CONVEX_SITE_URL", "SESSIONS_WORKER_KEY"]) {
    if (!env[required]) {
      throw new Error(`missing ${required} in ${path} — fill in the env file`);
    }
  }
  return env;
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
    body: JSON.stringify(body),
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

// ── The session workspace shape ──────────────────────────────────────────────
// Two pure decisions, here rather than in session.mjs so a test can reach them
// without importing the Claude Agent SDK. Both are mirrors of Convex-side
// rules and must move together with them:
//   resolveSessionRepos  <- sessionRepoList in convex/ttsShared.ts
//   sessionWorkdir       <- workspaceBlock in convex/claudeSessions.ts, which
//                           is what TELLS the session where it is standing

/**
 * The repos one session holds, from the two fields a poll row carries.
 *
 * `repo` is the original single string (every row ever written has one) and
 * `repos` is the list added when Tom ruled on 2026-08-30 that a session must be
 * able to hold more than one. `repos` wins when the server sent it; a server
 * older than that ruling sends only `repo`, and "none" — the absence of a repo,
 * not a repo — is the empty list.
 */
export function resolveSessionRepos(repo, repos) {
  if (Array.isArray(repos) && repos.length > 0) return repos;
  return repo === "none" || repo === undefined || repo === null ? [] : [repo];
}

/**
 * Where the session's shell stands, given its per-repo checkout directories.
 *
 *   none -> <base>/ws     an empty scratch directory
 *   one  -> the checkout  (unchanged since the first repo-equipped mission:
 *                          `pwd` is a git repository, which every prompt,
 *                          tool call, and habit built since then assumes)
 *   many -> <base>        the parent, one subdirectory per repo — the only
 *                          shape that can hold two checkouts at once
 */
export function sessionWorkdir(base, repoDirs) {
  if (repoDirs.length === 0) return `${base}/ws`;
  if (repoDirs.length === 1) return repoDirs[0];
  return base;
}
