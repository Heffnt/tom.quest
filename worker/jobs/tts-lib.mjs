// tts-lib.mjs — shared helpers for the TTS worker jobs (poll-dump.mjs,
// prepare-queue.mjs, and the code-todo jobs brief-code-todos.mjs /
// apply-rulings.mjs / execute-approved.mjs). Plain Node ESM, ZERO npm
// dependencies: node:fs, node:child_process and the global fetch (Node >= 18,
// the Jarvis Box runs Node 22) are all we use.
//
// WHY no dependencies: the Jarvis Box owns no state and must be rebuildable by one
// script with nothing but Node itself. No node_modules means no lockfile, no
// install step, no supply-chain surface — setup.sh just copies these files
// into /opt/tts/ and cron runs them.

import { execFileSync } from "node:child_process";
import { ENV_PATH, loadEnv as loadWorkerEnv } from "./worker-env.mjs";
import { CLAUDE_CONFIG_DIR } from "./claude-accounts.mjs";

export { ENV_PATH };

// ---------------------------------------------------------------------------
// Env file parsing
// ---------------------------------------------------------------------------

// The parsing itself lives in worker-env.mjs — the one body the session-host
// daemon reads too (through a symlink; that file's header says why).
//
// Every job here talks to Convex through convexFetch, so CONVEX_SITE_URL and
// TTS_WORKER_KEY are required of all of them. Anything beyond that is the
// CALLER's to name: `loadEnv({ require: [...] })` adds to the two. Slack used
// to be in this list for everyone, which meant an unfilled SLACK_BOT_TOKEN
// refused to run the ten jobs that never touch Slack; poll-dump.mjs, the one
// job that reads it, now asks for it itself.
export function loadEnv({ path = ENV_PATH, require = [] } = {}) {
  return loadWorkerEnv({
    path,
    require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY", ...require],
  });
}

// ---------------------------------------------------------------------------
// America/New_York wall-clock hour (for the cron DST guard only)
// ---------------------------------------------------------------------------
//
// We implement NY time by hand rather than trusting the Jarvis Box's TZ database
// or timezone config, because it must be rebuildable from a bare Ubuntu
// image with zero manual configuration (the no-state rule). US DST rules,
// fixed in law since 2007:
//   EDT (UTC-4): from the second Sunday of March 07:00 UTC (2 a.m. EST)
//                until the first Sunday of November 06:00 UTC (2 a.m. EDT)
//   EST (UTC-5): the rest of the year.

// Epoch ms of the DST-start instant (2nd Sunday of March, 07:00 UTC) for a year.
function dstStartUtcMs(year) {
  const march1 = new Date(Date.UTC(year, 2, 1));
  // Day-of-month of the first Sunday of March (getUTCDay(): 0 = Sunday).
  const firstSunday = 1 + ((7 - march1.getUTCDay()) % 7);
  return Date.UTC(year, 2, firstSunday + 7, 7, 0, 0);
}

// Epoch ms of the DST-end instant (1st Sunday of November, 06:00 UTC) for a year.
function dstEndUtcMs(year) {
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const firstSunday = 1 + ((7 - nov1.getUTCDay()) % 7);
  return Date.UTC(year, 10, firstSunday, 6, 0, 0);
}

// UTC offset of America/New_York at a given instant: -4 (EDT) or -5 (EST).
export function nyUtcOffsetHours(ms) {
  const year = new Date(ms).getUTCFullYear();
  return ms >= dstStartUtcMs(year) && ms < dstEndUtcMs(year) ? -4 : -5;
}

// A Date whose getUTC*() fields read as NY wall-clock time for the instant.
// (We shift the epoch value and then read UTC fields — the Date object itself
// is "wrong" as an instant, which is why it stays private to this module.)
function nyWallClock(ms) {
  return new Date(ms + nyUtcOffsetHours(ms) * 3_600_000);
}

// NY wall-clock hour (0-23) at the given instant. Used by prepare-queue.mjs
// as the DST guard: cron fires at both 08:30 and 09:30 UTC, and exactly one
// of those is the 4 a.m. NY hour depending on the season.
export function nyHour(ms) {
  return nyWallClock(ms).getUTCHours();
}

// Epoch ms of NOON New York on a YYYY-MM-DD calendar date. THE storage
// convention for dueAt (convex/ttsShared.ts countdownText): a date written as
// UTC midnight still reads as the previous NY evening and reports a day early,
// so every writer normalizes to local noon. Callers hand this a plain calendar
// date — the only date form a model is ever asked to produce.
export function nyNoonUtcMs(dayKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new Error(`not a YYYY-MM-DD date: ${dayKey}`);
  }
  const utcNoon = Date.parse(`${dayKey}T12:00:00Z`);
  if (Number.isNaN(utcNoon)) throw new Error(`unparseable date: ${dayKey}`);
  // Offset sampled at that day's midday, so a DST transition (2 a.m.) can't
  // skew it.
  return utcNoon - nyUtcOffsetHours(utcNoon) * 3_600_000;
}

// NOTE: this module deliberately has NO day-key function. The TTS day key
// (5 a.m. boundary) is a server-owned fact: /tts/state returns `prepDay` and
// the jobs repeat it back. A second hand-rolled copy of that math lived here
// once and disagreed with Convex's for five hours after each DST transition —
// the worker computes only the local-hour guard above, nothing more.

// ---------------------------------------------------------------------------
// Convex HTTP endpoints (key-authed)
// ---------------------------------------------------------------------------

// Call a /tts/* endpoint on the Convex site origin. GET when no body, POST
// (JSON) when a body is given. Throws on non-2xx with the response text
// included, so cron logs show WHY a call failed.
//
// The thrown Error carries `status` (the HTTP code) and `body` (the response
// text) so a caller can tell the two failure KINDS apart — the difference
// decides what happens to the work: a 4xx is the server REFUSING what was sent
// (content: re-sending it changes nothing), while a 5xx or a network throw is
// environmental (retry next tick). A network failure throws before any response
// exists, so `status` is undefined there — which is exactly the signal.
export async function convexFetch(env, path, body = undefined) {
  const url = env.CONVEX_SITE_URL.replace(/\/+$/, "") + path;
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-TTS-Key": env.TTS_WORKER_KEY,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Slack Web API
// ---------------------------------------------------------------------------
// ONE HOME for both verbs (VQC C1). poll-dump.mjs carried a GET-only helper of
// its own; prepare-life-todos.mjs needs the POST half for the threaded reply,
// and a second copy is exactly the drift this rule exists to stop.
//
// The bot token goes in the Authorization header, never in the URL — a URL
// lands in logs and in Slack's own error reports.

/** Slack read methods (conversations.history, chat.getPermalink): GET + query. */
export async function slackGet(env, method, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`slack ${method} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`slack ${method} -> ${data.error}`);
  return data;
}

/**
 * Slack write methods (chat.postMessage, chat.update): POST + JSON body.
 *
 * Needs the bot token to hold chat:write. Nothing in this repo PROVES it does
 * (worker.env.example claims only history-read), so a caller treats a
 * `missing_scope` failure as a real, reportable condition rather than a
 * transient — see the ledger entry slack-chat-write-scope-unverified.
 */
export async function slackPost(env, method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`slack ${method} -> HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`slack ${method} -> ${data.error}`);
  return data;
}

// The message the server put in a rejection body ({ "error": "..." }), for
// re-filing a refused item with the server's OWN words rather than an HTTP
// line. Falls back to the error message when the body is not that shape.
export function serverErrorMessage(err) {
  try {
    const parsed = JSON.parse(err?.body ?? "");
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      return parsed.error.trim();
    }
  } catch {
    // not JSON — fall through
  }
  return String(err?.message ?? err);
}

// ---------------------------------------------------------------------------
// Headless Claude Code
// ---------------------------------------------------------------------------

// The "active" account symlink managed by the tts-account CLI helper — every
// headless Claude invocation on the Jarvis Box goes through it, so switching Max
// accounts is one `tts-account use` away and no job hardcodes an account.
//
// The path itself lives in claude-accounts.mjs (its header lists the other two
// homes the literal has, in setup.sh and bin/tts-account); re-exported here
// because runClaude below is what puts it in every cron job's env.
export { CLAUDE_CONFIG_DIR };

// Run headless Claude Code (`claude -p`) and return the model's ANSWER TEXT
// (the envelope is unwrapped here; parsing the answer is the caller's job —
// see extractJsonObject below for the JSON-answer case).
//
// Two modes:
//   non-agentic (default) — the read-only default permission mode: the model
//       may read files under `cwd` with its tools but cannot edit or run
//       commands. Default --max-turns 8, not 1: with tools enabled, a single
//       stray tool call would consume a 1-turn budget and end the run with an
//       error envelope (review-caught on prepare-queue).
//   agentic (agentic: true) — --permission-mode bypassPermissions and a
//       --max-turns default of 200: the executor mode, where the model edits
//       files and runs tests inside a throwaway clone. NEVER point agentic
//       mode at a directory whose damage you can't discard.
//
// The prompt goes over STDIN, not argv: Linux caps a single argv element at
// ~128 KiB and embedded todo/ledger JSON will eventually exceed that
// (review-caught on prepare-queue).
// `model` maps to --model: mechanical jobs (parsing one sentence into concrete
// actions) pass a cheap model; omit it and the account default applies.
export function runClaude(
  prompt,
  { cwd, timeoutMs, agentic = false, maxTurns, model } = {},
) {
  const turns = maxTurns ?? (agentic ? 200 : 8);
  const args = ["-p", "--output-format", "json", "--max-turns", String(turns)];
  if (model) args.push("--model", model);
  if (agentic) args.push("--permission-mode", "bypassPermissions");
  const stdout = execFileSync("claude", args, {
    input: prompt,
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs ?? 10 * 60 * 1000,
  });

  // With --output-format json the CLI prints an envelope like
  // {"type":"result","subtype":"success","result":"<the model's text>", ...}.
  // An error envelope (e.g. subtype "error_max_turns") has NO result field —
  // that is a hard failure, not something to brace-extract garbage from
  // (review-caught). If stdout isn't JSON at all, treat it as the raw answer.
  let answerText = stdout;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope === "object" && envelope.type === "result") {
      if (typeof envelope.result !== "string") {
        throw new Error(
          `claude returned an error envelope (subtype: ${envelope.subtype ?? "?"})`,
        );
      }
      answerText = envelope.result;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // stdout wasn't the JSON envelope — fall through with raw text.
    } else {
      throw err;
    }
  }
  return answerText;
}

// ---------------------------------------------------------------------------
// Planner input bounds and text clipping
// ---------------------------------------------------------------------------

// One planner run offers at most this many unbatched life todos (oldest
// first), each with its brief clipped to MAX_BRIEF_CHARS. An unbounded offer
// sank real form-batches runs: at 122+ todos with full briefs the single
// completion blew the 10-min timeout three runs in a row (2026-08-29) and the
// backlog compounded. The 2-hourly cron drains any backlog in slices — todos
// placed in a batch this run drop out of the next run's offer.
//
// BOTH PLANNERS READ THESE FROM HERE. form-batches.mjs (v1 batches) and
// plan-graphs.mjs (v2 graphs) run side by side until cutover and offer the
// same todos to the same model; when they clipped with two separate copies of
// this rule they had already drifted — one marked the cut and the other did
// not, so the same brief reached the model in two forms depending on which job
// read it. Do not re-declare either constant, and do not re-spell clip().
export const MAX_LIFE_PER_RUN = 80;
export const MAX_BRIEF_CHARS = 400;

/**
 * Shorten `text` to at most `max` characters for showing to a model.
 *
 * Anything that is not a non-empty string becomes null rather than an empty
 * string, so a missing brief is absent from the JSON instead of present and
 * blank — a blank field reads to the model as "this todo has an empty brief",
 * which is a claim about the todo rather than about our input.
 *
 * A clipped result ends in an ellipsis character so the model can see the text
 * was cut and does not treat a sentence that stops mid-clause as the whole
 * brief. The ellipsis is appended AFTER the slice, so the returned string is
 * max + 1 characters long; the limit bounds the source text we spend, not the
 * output width.
 */
export function clip(text, max) {
  if (typeof text !== "string" || text === "") return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Pull the single JSON object out of a model answer: strip any code fences the
// model added despite instructions, then take the outermost {...} span (first
// "{" to last "}") and parse it. Throws when there is no object at all, with
// the head of the answer included so cron logs show WHAT came back instead.
export function extractJsonObject(answerText) {
  const stripped = answerText.replace(/```[a-z]*\n?/gi, "");
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) {
    throw new Error(`no JSON object in Claude output: ${stripped.slice(0, 200)}`);
  }
  return JSON.parse(stripped.slice(first, last + 1));
}
