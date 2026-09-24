// tts-lib.mjs — shared helpers for the TTS worker jobs (the pollers, the
// planner plan-graphs.mjs, apply-time-notes.mjs, nightly.mjs). Plain Node
// ESM, ZERO npm dependencies: node's own modules, the global fetch (Node >=
// 18, the Jarvis Box runs Node 22) and the run machinery in worker/runs/ are
// all we use.
//
// WHY no dependencies: the Jarvis Box owns no state and must be rebuildable by one
// script with nothing but Node itself. No node_modules means no lockfile, no
// install step, no supply-chain surface — setup.sh just copies these files
// into /opt/tts/ and cron runs them.

import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENV_PATH, graphVersion, loadEnv as loadWorkerEnv } from "./worker-env.mjs";

// Jobs run from worker/jobs in a checkout and are copied flat into /opt/tts on
// the box, while the run machinery is installed once at /opt/tts/runs. So the
// launcher is found by candidate: ../runs/ from a checkout, ./runs/ from the
// flat install. scripts/check-setup-imports.mjs fences runs/ importing jobs/,
// not this direction, so worker/jobs/tts-lib.test.mjs proves both layouts.
const launcherUrls = [
  new URL("../runs/box-run.mjs", import.meta.url),
  new URL("./runs/box-run.mjs", import.meta.url),
];
// Vitest's ESM transform can give a dependency a non-file import.meta URL.
// The cwd candidates cover that test runner; ordinary Node always resolves
// through the module-relative URLs above, independent of its cwd.
const launcherFile = [
  ...launcherUrls.flatMap((candidate) => candidate.protocol === "file:" ? [fileURLToPath(candidate)] : []),
  path.resolve("worker/runs/box-run.mjs"),
  path.resolve("runs/box-run.mjs"),
].find((candidate) => existsSync(candidate));
if (!launcherFile) throw new Error("the box launcher (runs/box-run.mjs) is not installed");
const boxRunModule = await import(pathToFileURL(launcherFile).href);
// The model table sits beside the launcher in both layouts (worker/runs/ in a
// checkout, /opt/tts/runs/ on the box), so it is found where the launcher was.
const modelsModule = await import(pathToFileURL(path.join(path.dirname(launcherFile), "models.mjs")).href);
const { boxRunSync, boxRunNoSlot } = boxRunModule;

export { ENV_PATH };

// Every unattended worker asks for a structured answer in these exact words.
// Keep the instruction in one home so prompt changes cannot leave one parser
// expecting JSON while its model was invited to answer in prose.
export const JSON_ONLY_ANSWER = "Answer ONLY a JSON object, no prose, no code fences:";

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

// NY wall-clock hour (0-23) at the given instant. The nightly job's DST
// guard (nightly.mjs): cron fires at both 08:00 and 09:00 UTC, and exactly
// one of those is the 4 a.m. NY hour depending on the season.
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
    let missingModelOfTomPart = null;
    try {
      const response = JSON.parse(text);
      if (
        typeof response?.error === "string" &&
        /^model-of-tom (?:layer|header) .+ is not stored$/.test(response.error)
      ) {
        missingModelOfTomPart = response.error;
      }
    } catch {
      // Non-JSON errors retain the HTTP summary below.
    }
    const err = new Error(missingModelOfTomPart ?? `${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * The link to one todo on the /tts page. ONE HOME in worker/ for the URL
 * shape — convex/ttsShared.ts ttsItemLink is the same string on the server
 * side, and a job that spells it itself is the drift this rule exists to stop.
 */
export function ttsItemLink(todoId) {
  return `https://tom.quest/tts?item=${todoId}`;
}

// ---------------------------------------------------------------------------
// Capture context — the state a poller checks before it runs
// ---------------------------------------------------------------------------
//
// Every capture poller reads this once before it runs. The deployment supplies
// the writing standard and declined integrations in one payload.

/**
 * The state a poller checks before it runs.
 *
 * ONE READ PER RUN. Everything a poller needs from the deployment rides this
 * payload, so a run never asks the same deployment twice a tick.
 */
export async function captureContext(env) {
  return await convexFetch(env, "/tts/capture-context");
}

/**
 * Tom's ruling declining this integration, or null. PURE: it reads the context
 * the run already fetched (captureContext above), not a second GET.
 *
 * AN INTEGRATION HE DECLINES IS AN ARCHIVED TODO WITH HIS RULING ON IT
 * (convex/ttsIntegrations.ts): he dumps the line `integration: outlook` and
 * archives it with the archive verdict, and the optional sentence on that
 * verdict is his reason. There is no enabled flag anywhere — the thing that
 * already records a decision of his records this one, so it keeps his words,
 * its date, and its place in everything that reads rulings.
 *
 * Every poller asks this FIRST and exits with one line when the answer is not
 * null. The returned row is `{ name, todoId, ruledAt, sentence }`; the caller
 * prints the date and the sentence so the log says why, not just that.
 */
export function declined(context, name) {
  const target = String(name).trim().toLowerCase();
  return (context?.declinedIntegrations ?? []).find((d) => d.name === target) ?? null;
}

// ---------------------------------------------------------------------------
// A job's own report about itself (the lifeos update, phase 6)
// ---------------------------------------------------------------------------
//
// A cron job's only voice used to be /var/log/tts, which Tom does not read.
// These two calls are the voice he does read: POST /tts/job-failed writes a
// dtsEvents row the morning digest and the hourly update both carry, and POST
// /tts/job-ok closes one.
//
// `key` NAMES THE CONDITION, NOT THE RUN — `poll-canvas:canvas-auth`. A
// condition already reported and not since recovered is not reported again
// (convex/ttsJobs.ts), so a credential that is dead for a week is one row and
// not one row a tick. Omit the key for a failure that is about this run alone.
//
// NEITHER CALL THROWS. Reporting a failure must not become a second unreported
// failure, and telling Tom about a bad run is never worth losing the run's
// real work — so a refusal is logged here and the caller carries on.

/** Report this job's failure in plain words. Returns null if the report failed. */
export async function reportJobFailed(env, { job, error, key }) {
  try {
    return await convexFetch(env, "/tts/job-failed", { job, error, key });
  } catch (err) {
    console.error(`[${job}] could not report the failure: ${err.message}`);
    return null;
  }
}

/** Say this job just ran clean, which re-arms the keyed report above. */
export async function reportJobOk(env, { job, key }) {
  try {
    return await convexFetch(env, "/tts/job-ok", { job, key });
  } catch (err) {
    console.error(`[${job}] could not report the clean run: ${err.message}`);
    return null;
  }
}

/** The one line a poller prints when it stands down. Exported for tests. */
export function declinedLine(job, ruling) {
  const on = new Date(ruling.ruledAt).toISOString().slice(0, 10);
  return (
    `[${job}] declined by Tom on ${on}` +
    (ruling.sentence ? `: ${ruling.sentence}` : "") +
    " — skipping"
  );
}

// ---------------------------------------------------------------------------
// Triage answers: what the model said about what it was given
// ---------------------------------------------------------------------------
//
// A capture poller hands a model a batch of items, each with an id, and reads
// back a verdict per item. The ids come back through the model, which means
// they can come back WRONG — a digit dropped from a Gmail id, an id invented,
// an item simply not mentioned.
//
// SILENCE USED TO MEAN "SKIP". Each job built a Map keyed by the id in the
// answer and looked each item up in it; a miss was read as "the model decided
// not to capture this one", the item was passed over, and the cursor advanced
// past it. So a garbled id lost a mail — permanently, since the cursor never
// comes back — and the only trace was a count that happened to be one lower.
//
// Now the answer is RECONCILED against the batch. Every item gets a verdict or
// is unresolved; every returned id is in the batch or is unmatched; both are
// reported to Tom through POST /tts/job-failed, and the caller holds its cursor
// at the oldest unresolved item so the next run reads it again. A model that
// answers well loses nothing to this; a model that garbles an id costs a
// re-read instead of a message.

/** The stand-in for an answer that names no id at all. Never a real id. */
export const NO_ID = "(no id)";

/**
 * Pure: the verdict one answer carries, or null when it carries none.
 *
 * `capture: false` is a complete verdict — the model looked and said no. A
 * `capture: true` with no statement is NOT: it claims an action and names
 * none, so there is nothing to write, and reading it as a skip would lose the
 * item exactly the way silence used to. Exported for tests.
 */
export function captureVerdict(answer) {
  if (answer === null || typeof answer !== "object") return null;
  if (answer.capture === false) return { capture: false };
  if (answer.capture !== true) return null;
  const statement = typeof answer.statement === "string" ? answer.statement.trim() : "";
  if (statement === "") return null;
  return {
    capture: true,
    statement,
    needsTomToday: answer.needsTomToday === true,
    why: typeof answer.why === "string" ? answer.why.trim() : "",
  };
}

/**
 * Pure: line a model's answers up against the batch ids it was given.
 *
 *   byId       the verdict for each batch id the model resolved;
 *   unresolved batch ids with no usable verdict, in the batch's own order —
 *              the caller processes up to the first of these and no further;
 *   unmatched  ids the answer named that were not in the batch, deduped.
 *
 * Exported for tests.
 */
export function reconcileVerdicts(batchIds, answers) {
  const inBatch = new Set(batchIds);
  const byId = new Map();
  const unmatched = [];
  for (const answer of Array.isArray(answers) ? answers : []) {
    const named = answer === null || typeof answer !== "object" ? undefined : answer.id;
    const id = typeof named === "string" && named.trim() !== "" ? named.trim() : NO_ID;
    if (!inBatch.has(id)) {
      if (!unmatched.includes(id)) unmatched.push(id);
      continue;
    }
    const verdict = captureVerdict(answer);
    // First usable verdict wins; a second answer for the same id changes
    // nothing, and a malformed one leaves the item unresolved.
    if (verdict !== null && !byId.has(id)) byId.set(id, verdict);
  }
  return { byId, unmatched, unresolved: batchIds.filter((id) => !byId.has(id)) };
}

/** The key one untriaged item is reported under: once per item, ever. */
export function untriagedKey(job, sourceId) {
  return `${job}:untriaged:${sourceId}`;
}

/** The key one unmatched id is reported under. Clipped: it is model output. */
export function unmatchedIdKey(job, id) {
  return `${job}:unmatched-id:${String(id).slice(0, 80)}`;
}

/** The plain words one untriaged item is reported in. Exported for tests. */
export function untriagedMessage(job, label, sourceId) {
  return (
    `${job} got no triage verdict for ${label} (${sourceId}), so nothing was ` +
    `captured from it. Its cursor is holding at the oldest untriaged item, so ` +
    `this one and everything after it are read again next run — nothing is lost, ` +
    `but nothing after it moves until a run answers for it.`
  );
}

/** The plain words an id that was not in the batch is reported in. */
export function unmatchedIdMessage(job, id) {
  return (
    `${job}'s triage answer named an id that was not in the batch it was given: ` +
    `"${String(id).slice(0, 80)}". The model is garbling or inventing ids, which ` +
    `is how an item's verdict goes missing.`
  );
}

/**
 * Report everything a triage answer left unresolved: one row per untriaged
 * item, one per unmatched id. Keyed per item (convex/ttsJobs.ts), so an item
 * the model keeps failing to answer for is ONE row and not one every tick.
 *
 * `untriaged` is `{ sourceId, label }` per item — the stable id the row is
 * keyed on and the words Tom reads it by.
 */
export async function reportUntriaged(env, job, { untriaged = [], unmatched = [] }) {
  for (const item of untriaged) {
    await reportJobFailed(env, {
      job,
      error: untriagedMessage(job, item.label, item.sourceId),
      key: untriagedKey(job, item.sourceId),
    });
  }
  for (const id of unmatched) {
    await reportJobFailed(env, {
      job,
      error: unmatchedIdMessage(job, id),
      key: unmatchedIdKey(job, id),
    });
  }
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
export const CLAUDE_CONFIG_DIR = "/root/.claude-accounts/active";

// ONE HOME FOR MODEL NAMES: worker/runs/models.mjs, beside the launcher. Every
// spawn names its model in the code rather than falling through to whatever the
// active account happens to default to: a job's tier is a decision this repo
// makes, and switching Max accounts must not silently re-tier the fleet. That
// file holds the table of roles (MODELS) and the model ceiling that stands in
// for Fable while Fable is unavailable, which box-run.mjs applies to every run.
// These are forwards, never copies, so a job imports them from the library as
// it always has.
export const { MODELS, MODEL_CEILING } = modelsModule;

// The model a job's record names for a call it made: the requested model, or
// "opus (fable requested, at the ceiling)" while Fable is unavailable. Read
// when the record is written, from the same file the launcher read.
export function modelLabel(requested) {
  return modelsModule.modelLabel(requested, boxRunModule.fableState());
}

// THE ARGV, THE TOOL LISTS AND THE ENVELOPE READER LIVE IN box-run.mjs, the
// box's one launcher, because that is where a command line is built now.
// These are forwards, never copies, for the callers that always imported the
// names from here (worker/jobs/evals.test.mjs reads DENIABLE_TOOLS).
export const DENIABLE_TOOLS = boxRunModule.DENIABLE_TOOLS;
export const resultEnvelopeOf = boxRunModule.resultEnvelopeOf;

// How much of the envelope's text and of the stderr tail a failure message
// carries, each. Enough for the CLI's one-sentence reason and a stack's head;
// the message lands in a cron log and in a Slack line, not a report.
const FAILURE_TEXT_CHARS = 300;

// Run headless Claude Code (`claude -p`) through box-run.mjs and return the
// model's ANSWER TEXT (the envelope is unwrapped there; parsing the answer is
// the caller's job — see extractJsonObject below for the JSON-answer case).
//
// NO JOB BUILDS A CLAUDE COMMAND LINE. This composes the job's registration and
// its settings and hands them to boxRunSync, which scrubs the child's
// environment, writes the envelope under box-run.mjs's name, runs the CLI and
// claims the run. It takes NO SLOT on the box's semaphore: a job's flock is
// its concurrency guard, and a slot here is what let the evals pass starve
// behind the runs waiting on it (box-run.mjs's noSlot says how). The origin is still the
// job's own (`cron:<job>`), so the record says which job asked and which
// program launched it.
//
// One mode: the CLI's default permission mode. The model may read files under
// `cwd` with its tools but cannot edit or run commands. Default --max-turns 8,
// not 1: with tools enabled, a single stray tool call would consume a 1-turn
// budget and end the run with an error envelope (review-caught on
// prepare-queue).
//
// NO FULL-ACCESS MODE. There was one (`agentic`: bypassPermissions), and the
// delegate was its only caller. The box runs every job as root, and the CLI
// refuses that mode under root, so from the delegate's first day each of its
// asks exited 1 and was recorded as silence. The mode is gone rather than
// guarded: an `allowedTools` list pre-approves what a run needs, and nothing
// here may ask for more.
//
// An `allowedTools` list pre-approves those tools; an empty one means no tools
// at all, and box-run's claudeArgs spells that out by name.
//
// The prompt goes over STDIN, not argv: Linux caps a single argv element at
// ~128 KiB and embedded todo/ledger JSON will eventually exceed that
// (review-caught on prepare-queue).
// `model` maps to --model. EVERY CALLER PASSES ONE, from the MODELS table
// above — omit it and the run silently takes the active account's default,
// which is a fleet-wide setting no job should be tiered by.
// `receipt` is an OUT-PARAMETER, and the one thing this function tells a
// caller besides the answer text: pass `receipt: {}` alongside a registration
// and the token this call spooled is written into it as `receipt.runToken`.
//
// WHY NOT A RICHER RETURN VALUE. Seven callers pass a registration today and
// use the answer as a string (apply-time-notes, delegate, plan-graphs in three
// places, poll-canvas, poll-gmail, write-slack); returning an object would
// break every one of them at a line that still type-checks in plain JS.
//
// AND WHY NOT process.env.TTS_RUN_REG_TOKEN, which the job also has. That
// variable is the token of the JOB'S OWN run, set by whatever launched the
// cron. The text a door then posts for Tom was written by the CHILD run this
// call spawns, which has its own token — so the job's variable names the wrong
// run, and stamping it on the row would make exactly the wrong edge
// convex/runLabels.ts is built to avoid. This is the token that names the run
// that wrote the text.
/**
 * The box-run options ONE claude call is made with, and the envelope it is
 * registered under.
 *
 * SPLIT OUT SO THERE IS STILL ONE ENVELOPE. runClaude and runClaudeAsync are
 * the same call waited for two ways, and the thing that must not differ between
 * them is what the record says a run was: its origin, its layers, its tools,
 * its prompt hash. A second copy of this block is how one of the two comes to
 * register runs the sweep reads differently.
 */
function claudeRunOptions(prompt, { cwd, timeoutMs, maxTurns, model, allowedTools, registration } = {}) {
  // Refused before anything is spooled or started: a malformed list must not
  // quietly widen the run to every tool the CLI has.
  if (allowedTools !== undefined && (!Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== "string" || tool === ""))) {
    throw new Error("allowedTools must be an array of non-empty strings");
  }
  const runCwd = path.resolve(cwd ?? process.cwd());
  let envelope = null;
  if (registration !== undefined) {
    const job = path.basename(process.argv[1] ?? "unknown.mjs").replace(/\.mjs$/i, "");
    const layersKnown = registration.layersKnown === true;
    envelope = {
      ...registration,
      host: process.env.RUN_HOST === "box" || process.env.RUN_HOST === "laptop" ? process.env.RUN_HOST : null,
      cli: "claude",
      origin: registration.origin ?? `cron:${job}`,
      kind: registration.kind ?? "job",
      environment: registration.environment ?? "worker",
      modelRequested: model ?? null,
      effortRequested: null,
      cwd: runCwd,
      todoId: registration.todoId ?? null,
      batchId: registration.batchId ?? null,
      mergeKey: registration.mergeKey ?? null,
      parentRunId: registration.parentRunId ?? process.env.TTS_RUN_PARENT_RUN_ID ?? null,
      spawnedByToolUseId: registration.spawnedByToolUseId ?? null,
      continuesRunId: registration.continuesRunId ?? null,
      layersKnown,
      layersGiven: layersKnown && Array.isArray(registration.layersGiven) ? registration.layersGiven : [],
      layersDenied: layersKnown && Array.isArray(registration.layersDenied) ? registration.layersDenied : [],
      skillsGranted: Array.isArray(registration.skillsGranted) ? registration.skillsGranted : [],
      skillsRefused: Array.isArray(registration.skillsRefused) ? registration.skillsRefused : [],
      tools: { allowed: allowedTools ?? null, denied: null },
      hooksConfigured: ["SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop"],
      promptSha256: crypto.createHash("sha256").update(String(prompt)).digest("hex"),
      // WHICH GRAPH THIS RUN RAN UNDER, and nothing about which of its nodes
      // the prompt carried: a cron job assembles no node list here, and an
      // empty array would claim it carried none rather than that this
      // launcher does not know. So no graphNodes key at all, and `undefined`
      // when there is no published graph to name.
      graphVersion: graphVersion() ?? undefined,
    };
  }
  return {
    prompt: String(prompt),
    cli: "claude",
    model,
    cwd: runCwd,
    outputFormat: "json",
    maxTurns: maxTurns ?? 8,
    allowedTools,
    timeoutMs: timeoutMs ?? 10 * 60 * 1000,
    registration: envelope,
    // Every headless Claude invocation on the box runs under the `active`
    // account, whatever the calling process happens to carry.
    env: { ...process.env, CLAUDE_CONFIG_DIR },
  };
}

/** What a caller that could not reach its child throws. Filled receipt and
 *  all: a caller that wants to report which run failed needs its token. */
function claudeStartFailure(error, receipt) {
  if (receipt !== undefined && receipt !== null && error?.runToken) receipt.runToken = error.runToken;
  return Object.assign(new Error(`claude failed: ${error?.message ?? error}`), {
    exitCode: error?.exitCode ?? null,
    runToken: error?.runToken ?? null,
  });
}

/** One finished box run as the answer text, or the throw that says why not. */
function claudeAnswer(result, receipt) {
  if (receipt !== undefined && receipt !== null && result.runToken) receipt.runToken = result.runToken;

  if (result.exitCode !== 0) {
    // THE CLI SAYS WHY ON ITS WAY OUT. A non-zero exit still prints the
    // envelope — subtype "error_max_turns" is the one that matters, because it
    // is a BUDGET the caller set and can change. "Command failed" is what
    // reached the evals log for a whole afternoon on 2026-09-14: eighty items
    // failing with a sentence that named neither the cause nor the knob.
    const failed = result.envelope;
    const said = [
      failed?.subtype ? `subtype: ${failed.subtype}` : null,
      typeof failed?.is_error === "boolean" ? `is_error: ${failed.is_error}` : null,
      result.signal ? `signal ${result.signal}` : `exit ${result.exitCode}`,
    ].filter((part) => part !== null);
    // THE CAUSE, IN THE CLI'S OWN WORDS. An account out of usage exits 1 with
    // subtype "success", is_error true and the reason as the envelope's
    // `result` ("You've hit your monthly spend limit"); from 2026-09-22 every
    // evals judge call failed that way and the log said only "subtype: success,
    // exit 1". So the message carries the envelope's text and the stderr tail
    // box-run.mjs kept (its last five lines), each on one line and trimmed.
    const oneLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, FAILURE_TEXT_CHARS);
    const detail = [
      typeof failed?.result === "string" && failed.result.trim() !== "" ? `result: ${oneLine(failed.result)}` : null,
      result.stderrTail.trim() !== "" ? `stderr: ${oneLine(result.stderrTail)}` : null,
    ].filter((part) => part !== null);
    throw Object.assign(new Error(
      `claude failed (${said.join(", ")})${detail.length === 0 ? "" : `: ${detail.join("; ")}`}`,
    ), { exitCode: result.exitCode, runToken: result.runToken });
  }
  // With --output-format json the CLI prints an envelope like
  // {"type":"result","subtype":"success","result":"<the model's text>", ...}.
  // An error envelope (e.g. subtype "error_max_turns") has NO result field —
  // that is a hard failure, not something to brace-extract garbage from
  // (review-caught). If stdout isn't JSON at all, the raw text is the answer.
  // A ZERO EXIT WITH NO RESULT IS THE SAME FAILURE, and it says so in the same
  // words: one prefix means one thing to grep the cron log for.
  if (result.envelope && typeof result.envelope.result !== "string") {
    throw new Error(
      `claude failed (subtype: ${result.envelope.subtype ?? "?"}): the envelope carried no result`,
    );
  }
  return result.text;
}

export function runClaude(prompt, options = {}) {
  const run = claudeRunOptions(prompt, options);
  let result;
  try {
    result = boxRunSync(run);
  } catch (error) {
    throw claudeStartFailure(error, options.receipt);
  }
  return claudeAnswer(result, options.receipt);
}

/**
 * The same call, AWAITED RATHER THAN BLOCKED, so a caller with several
 * independent calls can have them in flight together.
 *
 * IT IS NOT THE DEFAULT AND SHOULD NOT BECOME ONE. Every other job here makes
 * one model call and uses the answer on the next line; for those, runClaude's
 * shape is the right one and spawnSync costs them nothing. This exists for the
 * evals pass, which has thirty-five independent items and had been running them
 * one at a time because the runner could not do otherwise.
 *
 * IT TAKES NO SLOT, the same as runClaude — boxRunNoSlot, not boxRun. A job's
 * model call taking a semaphore slot is what let the runs queue starve the
 * evals pass once already, and making the calls concurrent would have made that
 * worse rather than better.
 */
export async function runClaudeAsync(prompt, options = {}) {
  const run = claudeRunOptions(prompt, options);
  let result;
  try {
    result = await boxRunNoSlot(run);
  } catch (error) {
    throw claudeStartFailure(error, options.receipt);
  }
  return claudeAnswer(result, options.receipt);
}

// ---------------------------------------------------------------------------
// Planner input bounds and text clipping
// ---------------------------------------------------------------------------

// One planner run offers at most this many unbatched life todos (oldest
// first), each with its brief clipped to MAX_BRIEF_CHARS. An unbounded offer
// sank real batcher runs: at 122+ todos with full briefs the single
// completion blew the 10-min timeout three runs in a row (2026-08-29) and the
// backlog compounded. The half-hourly cron drains any backlog in slices —
// todos placed in a batch this run drop out of the next run's offer.
//
// ONE HOME. Two planners (the v1 batcher and plan-graphs.mjs) once clipped
// with two separate copies of this rule and had already drifted — one marked
// the cut and the other did not, so the same brief reached the model in two
// forms depending on which job read it. The v1 batcher is gone; the rule
// stays here so it cannot happen again. Do not re-declare either constant,
// and do not re-spell clip().
export const MAX_LIFE_PER_RUN = 80;
export const MAX_BRIEF_CHARS = 400;

// clip() itself lives in clip.mjs — the one body convex/ttsNightly.ts reads
// too, which cannot import this file (node:child_process above). Re-exported
// here so every job keeps importing it from the library.
export { clip } from "./clip.mjs";

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
