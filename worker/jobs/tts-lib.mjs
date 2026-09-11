// tts-lib.mjs — shared helpers for the TTS worker jobs (the pollers, the
// planner plan-graphs.mjs, apply-time-notes.mjs, nightly.mjs). Plain Node
// ESM, ZERO npm dependencies: node:fs, node:child_process and the global
// fetch (Node >= 18, the Jarvis Box runs Node 22) are all we use.
//
// WHY no dependencies: the Jarvis Box owns no state and must be rebuildable by one
// script with nothing but Node itself. No node_modules means no lockfile, no
// install step, no supply-chain surface — setup.sh just copies these files
// into /opt/tts/ and cron runs them.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENV_PATH, loadEnv as loadWorkerEnv } from "./worker-env.mjs";

// Jobs run from worker/jobs in a checkout and are copied flat into /opt/tts on
// the box. Keep one installed registration body at /opt/tts/runs while making
// both import graphs explicit and deterministic.
const registrationUrls = [
  new URL("../runs/registration.mjs", import.meta.url),
  new URL("./runs/registration.mjs", import.meta.url),
];
// Vitest's ESM transform can give a dependency a non-file import.meta URL.
// The cwd candidates cover that test runner; ordinary Node always resolves
// through the module-relative URLs above, independent of its cwd.
const registrationFile = [
  ...registrationUrls.flatMap((candidate) => candidate.protocol === "file:" ? [fileURLToPath(candidate)] : []),
  path.resolve("worker/runs/registration.mjs"),
  path.resolve("runs/registration.mjs"),
].find((candidate) => existsSync(candidate));
if (!registrationFile) throw new Error("run registration module is not installed");
const { claimRegistration, writeRegistration } = await import(pathToFileURL(registrationFile).href);

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

// ONE HOME FOR MODEL NAMES. Every spawn names its model in the code rather than
// falling through to whatever the active account happens to default to: a job's
// tier is a decision this repo makes, and switching Max accounts must not
// silently re-tier the fleet. The keys are ROLES, not job names, so two jobs
// doing the same shape of work cannot drift apart:
//
//   planner    the planning passes (prepare a life todo, plan the graphs) —
//              judgment over Tom's own words and his goal structure.
//   codeBrief  the read-only pass over a real repo checkout that writes the
//              brief a code todo is worked from — judgment plus code reading.
//   triage     a capture verdict over a batch of inbound items (Gmail, Canvas):
//              classify-shaped, high volume, cheap tier.
//   timeNotes  reading one of Tom's time sentences into concrete actions —
//              mechanical parsing; the tier here is flagged for Tom's ruling.
//   simplify   the weekly simplification pass (worker/jobs/simplify.mjs, spec
//              §23.9): one run a week that reads a deterministic facts block
//              and may answer only with deletions. Fable, because judging what
//              a system can lose is the hardest judgment the fleet makes, and
//              because it is one call a week over a bounded prompt.
//
// `simplify` SPELLS THE ID IN FULL rather than using the `fable` alias the
// session model list takes, so the model recorded on the run matches the row
// in worker/runs/prices.mjs and this job's weekly cost is readable. It
// duplicates one string with delegate.mjs's DELEGATE_MODEL deliberately:
// MODELS is where "every spawn names its model" is enforced for jobs, and
// reaching into the delegate's constant would tier two unrelated jobs
// together.
//
// Model literals still live in nightly.mjs (LEARNING_MODEL), weekly.mjs
// (WEEKLY_MODEL), delegate.mjs (DELEGATE_MODEL), write-slack.mjs (MODEL) and
// evals.mjs (REGEN_MODEL / JUDGE_MODEL). They belong in this table too and
// should move here in a later pass.
export const MODELS = {
  planner: "opus",
  codeBrief: "opus",
  triage: "claude-haiku-4-5-20251001",
  timeNotes: "claude-sonnet-5",
  simplify: "claude-fable-5-1",
};

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
// `model` maps to --model. EVERY CALLER PASSES ONE, from the MODELS table
// above — omit it and the run silently takes the active account's default,
// which is a fleet-wide setting no job should be tiered by.
export function runClaude(
  prompt,
  { cwd, timeoutMs, agentic = false, maxTurns, model, allowedTools, registration } = {},
) {
  const turns = maxTurns ?? (agentic ? 200 : 8);
  const args = ["-p", "--output-format", "json", "--max-turns", String(turns)];
  if (model) args.push("--model", model);
  if (agentic) args.push("--permission-mode", "bypassPermissions");
  // Agentic mode makes Claude's tools usable. A caller that also supplies an
  // allow-list is responsible for putting it in a disposable workspace: the
  // allow-list keeps this run read-only, while the throwaway workspace makes
  // bypassPermissions harmless if a future CLI version interprets a tool more
  // broadly than we expect.
  if (allowedTools !== undefined) {
    if (!Array.isArray(allowedTools) || allowedTools.some((tool) => typeof tool !== "string" || tool === "")) {
      throw new Error("allowedTools must be an array of non-empty strings");
    }
    args.push("--allowedTools", allowedTools.join(","));
  }
  const childEnv = { ...process.env, CLAUDE_CONFIG_DIR };
  let spooled = null;
  if (registration !== undefined) {
    const script = path.basename(process.argv[1] ?? "unknown.mjs");
    const job = script.replace(/\.mjs$/i, "");
    const stateDir = process.env.RUN_SWEEP_STATE_DIR
      || (process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "tts", "runs")
        : "/var/cache/tts/runs");
    const layersKnown = registration.layersKnown === true;
    spooled = writeRegistration({
      spoolDir: process.env.TTS_RUN_REG_SPOOL || path.join(stateDir, "registration"),
      writer: { file: `worker/jobs/${script}`, job },
      registration: {
        ...registration,
        host: process.env.RUN_HOST === "box" || process.env.RUN_HOST === "laptop" ? process.env.RUN_HOST : null,
        runner: "claude",
        origin: registration.origin ?? `cron:${job}`,
        kind: registration.kind ?? "job",
        modelRequested: model ?? null,
        effortRequested: null,
        cwd: path.resolve(cwd ?? process.cwd()),
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
      },
    });
    childEnv.TTS_RUN_REG_TOKEN = spooled.token;
    childEnv.TTS_RUN_REG_SPOOL = path.dirname(spooled.file);
  }
  const stdout = execFileSync("claude", args, {
    input: prompt,
    cwd,
    env: childEnv,
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
  let resultEnvelope = null;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope && typeof envelope === "object" && envelope.type === "result") {
      resultEnvelope = envelope;
      if (typeof envelope.result === "string") answerText = envelope.result;
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      // stdout wasn't the JSON envelope — fall through with raw text.
    } else {
      throw err;
    }
  }
  if (spooled && typeof resultEnvelope?.session_id === "string" && resultEnvelope.session_id) {
    const project = path.resolve(cwd ?? process.cwd()).replaceAll("\\", "-").replaceAll("/", "-").replaceAll(":", "-");
    const runFile = path.join(CLAUDE_CONFIG_DIR, "projects", project, `${resultEnvelope.session_id}.jsonl`);
    claimRegistration({
      spoolDir: path.dirname(spooled.file),
      token: spooled.token,
      runFile,
      claim: { by: "launcher:runClaude", threadId: resultEnvelope.session_id, runFile, hookPayloadKeys: [] },
    });
  }
  if (resultEnvelope && typeof resultEnvelope.result !== "string") {
    throw new Error(
      `claude returned an error envelope (subtype: ${resultEnvelope.subtype ?? "?"})`,
    );
  }
  return answerText;
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
