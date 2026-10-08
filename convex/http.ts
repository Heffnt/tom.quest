import { httpRouter } from "convex/server";
import { register as registerJarvisRoutes } from "./jarvis/routes";
import { jarvisAuth, presentsJarvisKey } from "./jarvis/auth";
import { postRuling } from "./jarvis/rulings";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { nowContext } from "./tts";
import {
  DELEGATE_MAX_PER_JOB,
  DELEGATE_MAX_PER_SESSION,
  DELEGATE_MAX_TURNS,
  DELEGATE_TIMEOUT_MS,
} from "./ttsAsk";
import {
  NARROW_LIST,
  ttsPrepDay,
} from "./ttsShared";
import { isNarrowListId } from "./ttsShared";
import { RUN_END_REASONS, type RunEndReason } from "./agents";
import { auditVerdictOf, mergedOnMain } from "./ttsMerge";
import { isModelOfTomPath, MODEL_OF_TOM_LAYER_NAMES } from "./ttsSkills";
import { DELEGATE_ONLY_KINDS, JARVIS_EVENT_ONLY_KINDS, RECORD_ONLY_KINDS, registryDiffOf, STANDING_RULING_ONLY_KINDS, SUBJECT_REQUIRED, TOM_ONLY_KINDS } from "../shared/jarvis-events.mjs";

const http = httpRouter();

auth.addHttpRoutes(http);

// Constant-time string compare — the Convex runtime has no crypto.timingSafeEqual. Length is
// not secret (it leaks via the early return), but the per-char comparison must not short-circuit.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// JSON may encode every character as a six-byte `\uXXXX` escape. An ingest
// carries at most 200 rows whose display payloads are each cut to 32 KiB, so
// reserve that worst case plus the former 1 MiB body limit as the envelope for
// the run, children, row metadata, and JSON punctuation.
const AGENTS_INGEST_ENVELOPE_BYTES = 1024 * 1024;
const AGENTS_INGEST_MAX_BODY_BYTES =
  6 * 200 * 32 * 1024 + AGENTS_INGEST_ENVELOPE_BYTES;
// A chunk itself may be 256 KiB. In the worst valid JSON string encoding every
// content byte is a six-byte `\uXXXX` escape (quotes and backslashes use two),
// with 4 KiB left for the fixed fields and JSON punctuation.
const AGENTS_OVERFLOW_ENVELOPE_BYTES = 4 * 1024;
const AGENTS_OVERFLOW_MAX_BODY_BYTES =
  6 * 256 * 1024 + AGENTS_OVERFLOW_ENVELOPE_BYTES;
const AGENT_ID = /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;

/** Read no more than `limit` bytes before JSON parsing or allocating its tree. */
async function boundedJson(request: Request, limit: number): Promise<{ body: unknown } | { tooLarge: true } | { invalid: true }> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) return { tooLarge: true };
  const reader = request.body?.getReader();
  if (!reader) return { invalid: true };
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    byteLength += next.value.byteLength;
    if (byteLength > limit) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { body: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { invalid: true };
  }
}

function validAgentId(agentId: unknown): agentId is string {
  return typeof agentId === "string" && AGENT_ID.test(agentId);
}

// ── The wire spelling and the stored spelling ─────────────────────────────
// The wire names a thread an agent: `agent`, `agentId`, `parentAgentId`,
// `rootAgentId`, `continuesAgentId`, `stepAgentId`, `agentToken`. The stored
// tables and fields keep the run spelling (`runs`, `runId`, `parentRunId`, …)
// by Tom's ruling of 2026-09-25, because Convex prod is additive-only
// (convex/schema.ts:388) and renaming a populated field is a data migration.
// So each door below reads the agent spelling only, refuses a body that still
// carries a run-spelled key with a 400 that names both keys, and hands the
// internal function the stored spelling. The helpers here are the one
// translation between the two.
//
// A refusal and not a silent drop: most of these keys are optional, so a
// caller still sending the old one would otherwise lose the edge it meant to
// write (a draft's agent token) without learning it.

/** The first run-spelled key the object carries, as the sentence a 400
 *  answers with, or null when it carries none. `keys` maps each old key to
 *  the key that replaced it. */
function oldSpelling(b: Record<string, unknown>, keys: Record<string, string>): string | null {
  for (const [old, replacement] of Object.entries(keys)) {
    if (b[old] !== undefined) return `${old} is no longer read; send ${replacement}`;
  }
  return null;
}

/** The keys of an agent object and of a child edge: wire key → stored key. */
const STORED_AGENT_KEYS = {
  agentId: "runId",
  parentAgentId: "parentRunId",
  rootAgentId: "rootRunId",
  continuesAgentId: "continuesRunId",
} as const;
/** The same keys the other way round: stored (old wire) key → wire key. */
const OLD_AGENT_KEYS: Record<string, string> = Object.fromEntries(
  Object.entries(STORED_AGENT_KEYS).map(([wire, stored]) => [stored, wire]),
);

/** An agent object or a child edge in the stored spelling: each agent key
 *  becomes its stored key. Anything that is not an object is returned as it
 *  came, for the caller's own check to refuse. */
function storedAgentKeys(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const [wire, stored] of Object.entries(STORED_AGENT_KEYS)) {
    if (out[wire] !== undefined) out[stored] = out[wire];
    delete out[wire];
  }
  return out;
}

/** An ingest body's first run-spelled key, on the body, on the agent object
 *  or on a child edge, as a 400 sentence; null when there is none. */
function ingestOldSpelling(body: Record<string, unknown>): string | null {
  const top = oldSpelling(body, { run: "agent" });
  if (top) return top;
  const objects = [body.agent, ...(Array.isArray(body.children) ? body.children : [])];
  for (const object of objects) {
    if (typeof object !== "object" || object === null || Array.isArray(object)) continue;
    const fault = oldSpelling(object as Record<string, unknown>, OLD_AGENT_KEYS);
    if (fault) return fault;
  }
  return null;
}

/** An ingest body in the stored spelling: `agent` becomes `run`, and the
 *  agent object and each child edge take the stored keys. Rows are not
 *  touched; a row's digest covers its content. */
function storedIngestBody(body: Record<string, unknown>): Record<string, unknown> {
  const { agent, ...rest } = body;
  const out: Record<string, unknown> = { ...rest, run: storedAgentKeys(agent) };
  if (Array.isArray(body.children)) out.children = body.children.map(storedAgentKeys);
  return out;
}

// The one key-auth gate for every agent-facing route (ledger graduation:
// tts-shared-gate-dedup). Each route family keeps its OWN env key and header
// (sharing nothing between keys — the auth-clobber lesson); what they share
// is the guard's shape: 503 when the key is unconfigured, then a
// constant-time compare, 401 on mismatch. Returns null when authorized.
function keyAuth(
  request: Request,
  envVar: string,
  header: string,
): Response | null {
  const expected = process.env[envVar];
  if (!expected) {
    return jsonResponse(503, { error: `${envVar} not configured` });
  }
  const presented = request.headers.get(header) ?? "";
  if (!timingSafeEqual(presented, expected)) {
    return jsonResponse(401, { error: "unauthorized" });
  }
  return null;
}

// ── TTS worker endpoints (spec: WikiTom tts/spec.md) ─────────────────────────
// The Jarvis Box's narrow, key-authed path into TTS, mirroring the /pool
// pattern: TTS_WORKER_KEY lives only in the Convex env and shares nothing with
// the other keys. The worker may capture items, post the day's prepared
// queue+digest, and read state to prepare from — never rule, archive, or
// delete (those are Tom-gated mutations). The one ruling door on this key,
// POST /tts/ruling, writes only what Tom himself typed: it takes the id of a
// turn he authored and his sentence verbatim, and refuses anything else.

// The record's key check (convex/jarvis/auth.ts): JARVIS_KEY ?? TTS_WORKER_KEY,
// on X-Jarvis-Key or X-TTS-Key, so the same handler answers the box under
// /jarvis/ with the new header and old callers under /tts/ with the old.
// This name goes with the /tts/ routes; new routes call jarvisAuth.
function ttsAuth(request: Request): Response | null {
  return jarvisAuth(request);
}

type TtsSearchArgs = {
  query: string;
  limit: number;
  repo?: string;
  status?: string;
  since?: number;
};

function parseTtsSearchArgs(
  request: Request,
  {
    queryRequired = true,
    allowSince = true,
  }: { queryRequired?: boolean; allowSince?: boolean } = {},
): TtsSearchArgs | Response {
  const params = new URL(request.url).searchParams;
  const query = params.get("query") ?? "";
  if (queryRequired && query.trim() === "") {
    return jsonResponse(400, { error: "query (non-empty string) required" });
  }
  const rawLimit = params.get("limit");
  if (
    rawLimit !== null &&
    (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200)
  ) {
    return jsonResponse(400, { error: "limit (integer from 1 to 200) required" });
  }
  const optionalText = (name: "repo" | "status"): string | Response | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    if (value.trim() === "") {
      return jsonResponse(400, { error: `${name} (non-empty string) required` });
    }
    return value;
  };
  const repo = optionalText("repo");
  if (repo instanceof Response) return repo;
  const status = optionalText("status");
  if (status instanceof Response) return status;
  const rawSince = params.get("since");
  let since: number | undefined;
  if (rawSince !== null) {
    if (!allowSince) {
      return jsonResponse(400, { error: "since is not supported for this search" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawSince)) {
      return jsonResponse(400, { error: "since (YYYY-MM-DD) required" });
    }
    const parsed = Date.parse(`${rawSince}T00:00:00.000Z`);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== rawSince) {
      return jsonResponse(400, { error: "since (YYYY-MM-DD) required" });
    }
    since = parsed;
  }
  return {
    query,
    // Internal queries retain their clamp as a defense for non-HTTP callers.
    limit: rawLimit === null ? 20 : Number(rawLimit),
    repo,
    status,
    since,
  };
}

// GET /tts/search/* is a bounded, redacted history search for box jobs. It
// uses the ordinary TTS worker capability, never the sessions ingest key.
const ttsSearchRulings = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const args = parseTtsSearchArgs(request);
  if (args instanceof Response) return args;
  return jsonResponse(
    200,
    await ctx.runQuery(internal.ttsSearch.rulings, {
      query: args.query,
      limit: args.limit,
      since: args.since,
    }),
  );
});

const ttsSearchSessions = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const args = parseTtsSearchArgs(request, { queryRequired: false });
  if (args instanceof Response) return args;
  return jsonResponse(
    200,
    await ctx.runQuery(internal.ttsSearch.sessions, {
      query: args.query,
      limit: args.limit,
      repo: args.repo,
      since: args.since,
    }),
  );
});

const ttsSearchEvents = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const args = parseTtsSearchArgs(request);
  if (args instanceof Response) return args;
  return jsonResponse(
    200,
    await ctx.runQuery(internal.ttsSearch.events, {
      query: args.query,
      limit: args.limit,
      since: args.since,
    }),
  );
});

const ttsSearchTodos = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const args = parseTtsSearchArgs(request);
  if (args instanceof Response) return args;
  return jsonResponse(
    200,
    await ctx.runQuery(internal.ttsSearch.todos, {
      query: args.query,
      limit: args.limit,
      status: args.status,
      since: args.since,
    }),
  );
});

http.route({ path: "/tts/search/rulings", method: "GET", handler: ttsSearchRulings });
http.route({ path: "/tts/search/sessions", method: "GET", handler: ttsSearchSessions });
http.route({ path: "/tts/search/events", method: "GET", handler: ttsSearchEvents });
http.route({ path: "/tts/search/todos", method: "GET", handler: ttsSearchTodos });

// POST /tts/capture — one captured thought/message becomes an `unprepared`
// item. Body: { statement, source?, provenance?, threadMessageId?, dueAt?,
// dateKind?, needsTomToday?, why? }. `threadMessageId` makes the capture
// idempotent on the Jarvis-thread message it came from; `dueAt` (epoch ms)
// with `dateKind` ("external" | "self-imposed") gives the todo a dated
// timing class. `needsTomToday: true` is a poller's triage judging the item
// to need Tom today, and `why` its few words; both are stored on the todo,
// and the morning message and the hourly line say them. No worker opens a
// needs-you thread (Tom, 2026-09-21).
const ttsCapture = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.statement !== "string" || b.statement.trim().length === 0) {
    return jsonResponse(400, { error: "statement (non-empty string) required" });
  }
  // A present-but-malformed value is the caller's error, not a reason to
  // treat the field as absent (the audit's finding): refuse it with one
  // sentence naming the shape.
  if (b.threadMessageId !== undefined && (typeof b.threadMessageId !== "string" || b.threadMessageId.trim() === "")) {
    return jsonResponse(400, { error: "threadMessageId, when given, is a non-empty string" });
  }
  const threadMessageId = typeof b.threadMessageId === "string" ? b.threadMessageId : undefined;
  if (b.dueAt !== undefined && !(typeof b.dueAt === "number" && Number.isFinite(b.dueAt) && b.dueAt > 0)) {
    return jsonResponse(400, { error: "dueAt, when given, is epoch milliseconds (a finite number greater than 0)" });
  }
  const dueAt = typeof b.dueAt === "number" ? b.dueAt : undefined;
  const hasDateKind = b.dateKind === "external" || b.dateKind === "self-imposed";
  if (b.dateKind !== undefined && !hasDateKind) {
    return jsonResponse(400, { error: 'dateKind must be "external" or "self-imposed"' });
  }
  if (dueAt !== undefined && !hasDateKind) {
    return jsonResponse(400, { error: "a dated capture names its dateKind" });
  }
  const dateKind = hasDateKind ? (b.dateKind as "external" | "self-imposed") : undefined;
  const id = await ctx.runMutation(internal.tts.internalCapture, {
    statement: b.statement,
    source:
      typeof b.source === "string" && b.source
        ? b.source
        : threadMessageId !== undefined
          ? "thread"
          : "slack-capture",
    provenance: typeof b.provenance === "string" ? b.provenance : undefined,
    threadMessageId,
    dueAt,
    dateKind,
    // The Slack coordinates, when the caller is a Slack producer. They are
    // what the threaded reply is addressed to and what the push route dedupes
    // on; a caller that has none simply omits them.
    slackChannel: typeof b.slackChannel === "string" ? b.slackChannel : undefined,
    slackTs: typeof b.slackTs === "string" ? b.slackTs : undefined,
    needsTomToday:
      b.needsTomToday === true
        ? { why: typeof b.why === "string" ? b.why.trim() : "" }
        : undefined,
  });
  return jsonResponse(200, { ok: true, id });
});

http.route({ path: "/tts/capture", method: "POST", handler: ttsCapture });

// POST /tts/needs-tom — one needs-you thread for a todo only Tom can settle.
// NO CODE IN THIS REPOSITORY CALLS IT since Tom ruled on 2026-09-21 that
// workers do not reach him directly: the mail pollers stopped. It stays
// because the agent rules still list it as a pen a session with Tom's context
// may use, and removing a pen is a change to those rules, made there first,
// not a side effect of this one.
// Body: { todoId, reason, key }. The job stops composing message text: it
// sends FACTS, and convex/ttsSlack.ts composes the thread from the todo's own
// statement and entry action plus `reason`, then opens it through the one
// Slack door with the todo as its subject, so his reply in it is already
// routed back to the row. `key` is the producer's own id for the thing that
// needs him (`gmail:message:<id>`), and it is what makes the thread open
// exactly once.
//
// `reason` is `verdict.why` from the Gmail triage — the field the prompt
// already asks for and the job used to print to its log file and drop. It is
// the one thing the old "Needs you today — <sender>: <subject>" never said.
//
// `text` is REFUSED rather than ignored: both sides ship in one commit, and a
// silent ignore would post a message with no reason for as long as an old
// worker copy survives on the box.
const ttsNeedsTom = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.todoId !== "string" || b.todoId.length === 0) {
    return jsonResponse(400, { error: "todoId (non-empty string) required" });
  }
  if (b.text !== undefined) {
    return jsonResponse(400, { error: "text is no longer accepted; send reason" });
  }
  if (typeof b.reason !== "string" || b.reason.trim().length === 0) {
    return jsonResponse(400, { error: "reason (non-empty string) required" });
  }
  if (typeof b.key !== "string" || b.key.trim().length === 0) {
    return jsonResponse(400, { error: "key (non-empty string) required" });
  }
  // A QUESTION WITH LETTERED OPTIONS (Jarvis `jarvis decide --trade-off`):
  // the record stores both on the item and composes the lines Tom reads from
  // them, so a reply of his naming a letter is later read against the options
  // he was shown (convex/ttsAsk.ts tomAnswer), not against a caller's copy.
  const nonempty = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if ((b.question === undefined) !== (b.options === undefined)) {
    return jsonResponse(400, { error: "question and options go together" });
  }
  if (b.question !== undefined && (!nonempty(b.question) || (b.question as string).trim().length > 400)) {
    return jsonResponse(400, { error: "question, when given, is 1-400 characters" });
  }
  if (b.options !== undefined && !(Array.isArray(b.options) && b.options.length >= 2 && b.options.length <= 5 && b.options.every(nonempty))) {
    return jsonResponse(400, { error: "options, when given, are 2-5 non-empty strings" });
  }
  // A REPLY UNDER THE DAY'S DIGEST in the one output channel, posted by the
  // box's digest job (convex/jarvis/digest.ts); no channel of its own.
  try {
    const result = await ctx.runMutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId: b.todoId,
      reason: b.reason,
      key: b.key,
      ...(b.question === undefined
        ? {}
        : { question: (b.question as string).trim(), options: (b.options as string[]).map((option) => option.trim()) }),
      // The reply invitation is printed only when a reply would reach TTS.
      canReply: Boolean(process.env.SLACK_SIGNING_SECRET && process.env.TOM_SLACK_USER_ID),
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/needs-tom", method: "POST", handler: ttsNeedsTom });

// POST /tts/job-failed — a box job reporting its own failure in plain words
// (the lifeos update, phase 6). Body: { job, error, key?, durationMs? }.
//
// This is the channel convex/ttsDigest.ts already reads: every "-failed" event
// kind becomes a line in the morning digest's job-failures section. Until now nothing on the Jarvis Box could write one — a cron job's
// only voice was /var/log/tts, which Tom does not read. An expired Canvas
// token is the first thing that speaks through here.
//
// A REPORT, NOT A TODO. The row records what broke and what to do about it;
// deciding whether it is worth Tom's morning is the digest's job.
//
// `key` names the CONDITION rather than the run — `poll-canvas:canvas-auth`.
// A condition already reported and not since recovered is not reported again
// (convex/ttsJobs.ts), because a dead credential is dead for days and a row a
// tick would bury the one fact under its own repetitions. A report without a
// key is about the job itself: its condition is the job's name
// (convex/jarvis/jobs.ts onJobFailed), cleared by the job's next clean run.
// A job report's optional runtime (shared/jarvis-events.mjs
// JOB_KINDS_WITH_DURATION): absent, or non-negative milliseconds.
const DURATION_MS_ERROR = "durationMs, when given, is non-negative milliseconds";
const durationMsOk = (value: unknown) =>
  value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);

const ttsJobFailed = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.job !== "string" || b.job.trim().length === 0) {
    return jsonResponse(400, { error: "job (non-empty string) required" });
  }
  if (typeof b.error !== "string" || b.error.trim().length === 0) {
    return jsonResponse(400, { error: "error (non-empty string) required" });
  }
  if (b.key !== undefined && (typeof b.key !== "string" || b.key.trim() === "")) {
    return jsonResponse(400, { error: "key, when given, is a non-empty string" });
  }
  if (!durationMsOk(b.durationMs)) return jsonResponse(400, { error: DURATION_MS_ERROR });
  const result = await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
    job: b.job,
    error: b.error,
    key: typeof b.key === "string" ? b.key : undefined,
    durationMs: b.durationMs as number | undefined,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/job-failed", method: "POST", handler: ttsJobFailed });

// POST /tts/job-ok — the same box job saying it just ran clean. Body:
// { job, key, durationMs? }; durationMs, on this route and on job-failed's,
// is how long the job had run when it posted, and lands in the row's data.
//
// The other half of the keyed report above, and the only thing that re-arms
// it: a run that ends a reported failure writes the recovery row and the next
// expiry of the same credential is reported afresh. A run that ends nothing
// writes nothing — a job running clean every thirty minutes must not become a
// row every thirty minutes.
const ttsJobOk = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.job !== "string" || b.job.trim().length === 0) {
    return jsonResponse(400, { error: "job (non-empty string) required" });
  }
  if (typeof b.key !== "string" || b.key.trim().length === 0) {
    return jsonResponse(400, { error: "key (non-empty string) required" });
  }
  if (!durationMsOk(b.durationMs)) return jsonResponse(400, { error: DURATION_MS_ERROR });
  const result = await ctx.runMutation(internal.ttsJobs.internalReportJobOk, {
    job: b.job,
    key: b.key,
    durationMs: b.durationMs as number | undefined,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/job-ok", method: "POST", handler: ttsJobOk });

// POST /tts/calendar-event — the Jarvis Box's path through the ONE write door
// to Tom's Google Calendar (convex/ttsCalendarWrite.ts owns the door; this
// route only carries the traffic). Body: { title, start, end, description?,
// location?, recurrence?, calendarId? } — start/end epoch ms. The record no
// longer has a send-in-Tom's-name path, so guest invitations are refused.
const ttsCalendarEvent = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.title !== "string" || b.title.trim() === "") {
    return jsonResponse(400, { error: "title (non-empty string) required" });
  }
  if (typeof b.start !== "number" || typeof b.end !== "number") {
    return jsonResponse(400, { error: "start and end (epoch ms) required" });
  }
  // An event with guests sends each an invitation from Tom's calendar, a
  // message in his name, which only his sign-off allowed; with the sign-off
  // removed the route refuses it rather than create the event without them,
  // which would drop what the caller asked for without saying so.
  if (b.guests !== undefined) {
    return jsonResponse(400, { error: "guests are not supported by the calendar-event route" });
  }
  const recurrence = Array.isArray(b.recurrence)
    ? b.recurrence.filter((r): r is string => typeof r === "string")
    : undefined;
  try {
    const created = await ctx.runAction(
      internal.ttsCalendarWrite.internalCreateEvent,
      {
        title: b.title,
        start: b.start,
        end: b.end,
        description: typeof b.description === "string" ? b.description : undefined,
        location: typeof b.location === "string" ? b.location : undefined,
        recurrence,
        calendarId: typeof b.calendarId === "string" ? b.calendarId : undefined,
      },
    );
    return jsonResponse(200, { ok: true, ...created });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return jsonResponse(400, { error });
  }
});

http.route({
  path: "/tts/calendar-event",
  method: "POST",
  handler: ttsCalendarEvent,
});


// ── POST /slack/events — Slack output-channel replies and reactions ───────
// This receives Slack's push for Tom's threaded replies and reactions in the
// output channel. Tom ruled on 2026-10-02: "retire slack fully. i dont want to
// use it at all anymore for jarvis." The Jarvis thread replaced #dump capture;
// phase 2 of that retirement removes the rest of this route.
// This route was one of the two #dump readers; the other, the box's poll-dump
// job posting to POST /tts/capture, is deleted by Heffnt/Jarvis#231, which lands
// before this change, so after both #dump is no longer read.
//
// This route is unlike every other one in this file: it is the only PUBLIC one
// (Slack cannot present X-TTS-Key), so its authentication IS the signature
// check below. Three requirements Slack imposes, each load-bearing:
//
//  1. The one-time url_verification handshake — echo `challenge` or the
//     subscription cannot be enabled at all.
//  2. Signature verification. HMAC-SHA256 over the literal string
//     `v0:<X-Slack-Request-Timestamp>:<raw body>`, keyed by SLACK_SIGNING_SECRET,
//     compared to X-Slack-Signature. The RAW body is what is signed, so it is
//     read as text once and parsed after — re-serializing the parsed object
//     would change the bytes and every request would fail.
//  3. 200 within 3 seconds or Slack retries. Accepted events are handled
//     inline.
//
// Replay window: 5 minutes, standard for this scheme. It bounds how long a
// signed request stays useful to an attacker who has the bytes but not the
// secret; without it a signed request is valid forever.
const SLACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
// Log-once guard for an unset TOM_SLACK_USER_ID (per isolate — Convex may run
// the route in more than one, so "once" is once per warm runtime).
let warnedNoTomSlackUserId = false;
/** The configured names of the output channel, under either variable read by
 * outputChannel(). Read per request so a value set after the isolate warmed up
 * counts. */
function slackReplyChannels(): Set<string> {
  return new Set(
    [
      process.env.SLACK_TTS_CHANNEL_ID,
      process.env.SLACK_TTS_TODAY_CHANNEL_ID,
    ].filter((id): id is string => typeof id === "string" && id !== ""),
  );
}

// Constant-time hex compare of our computed signature against the presented
// one. Reuses timingSafeEqual above for the same reason it exists there.
async function slackSignatureValid(
  secret: string,
  timestamp: string,
  rawBody: string,
  presented: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  const expected =
    "v0=" +
    Array.from(new Uint8Array(mac))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return timingSafeEqual(expected, presented);
}

const slackEvents = httpAction(async (ctx, request) => {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    // Fail LOUD-but-safe: refuse rather than accept unverified writes. 503
    // matches the unconfigured-key posture of keyAuth above, and Slack shows
    // the failure in the app's event-delivery panel.
    return jsonResponse(503, { error: "SLACK_SIGNING_SECRET not configured" });
  }
  // The raw bytes are what Slack signed — read once, verify, then parse.
  const rawBody = await request.text();
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";
  const age = Math.abs(Date.now() - Number(timestamp) * 1000);
  if (!Number.isFinite(age) || age > SLACK_REPLAY_WINDOW_MS) {
    return jsonResponse(401, { error: "stale or missing timestamp" });
  }
  if (!(await slackSignatureValid(secret, timestamp, rawBody, signature))) {
    return jsonResponse(401, { error: "bad signature" });
  }

  let body: Record<string, unknown>;
  try {
    body = (JSON.parse(rawBody) ?? {}) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }

  // (1) The handshake. Echoed as PLAIN TEXT, which is what Slack's verifier
  // accepts most reliably.
  if (body.type === "url_verification") {
    return new Response(String(body.challenge ?? ""), {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (body.type !== "event_callback") return jsonResponse(200, { ok: true });
  const event = (body.event ?? {}) as Record<string, unknown>;

  // ── An emoji on the morning digest (the evals layer, phase 7) ─────────────
  // The fourth door judgment enters by (convex/agentLabels.ts): Tom taps a
  // thumb on the morning message and that becomes a label on the run that
  // WROTE it. It is the cheapest act he can perform, which is the point — the
  // other three doors all cost him a sentence.
  //
  // The gate is Tom, then the room, and then the mutation. Everything it turns
  // away is acknowledged with a 200, because anything but a 200 makes Slack
  // retry an event we have already decided we do not want.
  //
  //  1. TOM HIMSELF. An emoji from anyone else in the workspace is somebody
  //     agreeing with the morning, not a judgment on a run, and an unset
  //     TOM_SLACK_USER_ID admits NOTHING — the same posture the threaded-reply
  //     branch below takes, logged once per isolate rather than per event.
  //  2. #tts-today, read as its id is set like every other channel here. The
  //     morning message is the only thing that room carries, so the room is
  //     what makes "a reaction" mean "a reaction to the digest"; an unset id
  //     admits nothing.
  //  3. WHICH digest, and whether a run wrote it at all, is the mutation's
  //     question and is not asked twice — it resolves the digest-sent row from
  //     the ts, and a morning the plain template wrote has no run to label.
  if (event.type === "reaction_added" || event.type === "reaction_removed") {
    const tomSlackUserId = process.env.TOM_SLACK_USER_ID;
    if (!tomSlackUserId) {
      if (!warnedNoTomSlackUserId) {
        warnedNoTomSlackUserId = true;
        console.warn(
          "TTS slack events: TOM_SLACK_USER_ID not configured — threaded replies and digest reactions are ignored",
        );
      }
      return jsonResponse(200, { ok: true, ignored: true });
    }
    if (event.user !== tomSlackUserId) return jsonResponse(200, { ok: true, ignored: true });
    const item = (event.item ?? {}) as Record<string, unknown>;
    const itemChannel = typeof item.channel === "string" ? item.channel : "";
    const todayChannel = process.env.SLACK_TTS_TODAY_CHANNEL_ID;
    if (!todayChannel || itemChannel !== todayChannel) {
      return jsonResponse(200, { ok: true, ignored: true });
    }
    const itemTs = typeof item.ts === "string" ? item.ts : "";
    const reaction = typeof event.reaction === "string" ? event.reaction : "";
    if (itemTs === "" || reaction === "") return jsonResponse(200, { ok: true, ignored: true });
    // A SLACK TS IS NOT A MILLISECOND NUMBER. It is seconds with a fractional
    // part — "1757000000.001200" — and reading it as a number would date every
    // label to 1970. The label's `at` is when he tapped, which is `event_ts`;
    // a missing one falls back to the arrival clock rather than to zero.
    const eventTs = typeof event.event_ts === "string" ? Number(event.event_ts) : NaN;
    const at = Number.isFinite(eventTs) ? Math.round(eventTs * 1000) : Date.now();
    const result = await ctx.runMutation(internal.agentLabels.internalLabelFromReaction, {
      channel: itemChannel,
      ts: itemTs,
      emoji: reaction,
      at,
      removed: event.type === "reaction_removed",
    });
    return jsonResponse(200, { ok: true, ...result });
  }

  // bot_id skips our own posts, subtype skips joins/edits/thread-broadcasts,
  // and empty text has nothing to route.
  const text = typeof event.text === "string" ? event.text : "";
  const ts = typeof event.ts === "string" ? event.ts : "";
  const channel = typeof event.channel === "string" ? event.channel : "";
  const threadTs =
    typeof event.thread_ts === "string" ? event.thread_ts : undefined;
  if (
    event.type !== "message" ||
    event.bot_id !== undefined ||
    event.subtype !== undefined ||
    text.trim() === "" ||
    ts === "" ||
    channel === ""
  ) {
    // Acknowledged and ignored: anything but a 200 makes Slack retry an event
    // we have already decided we do not want.
    return jsonResponse(200, { ok: true, ignored: true });
  }

  // ── A threaded reply (the lifeos update, phase 2) ────────────────────────
  // A reply in a thread is Tom answering something TTS posted in the output
  // channel. Accepted from ONE Slack user id — TOM_SLACK_USER_ID — because a
  // reply becomes a session's next turn or a time note on a todo, which are
  // Tom's pens; anyone else's reply is
  // acknowledged and ignored. Unset means no threaded reply is acted on, and
  // the log says so once per isolate rather than on every event.
  //
  // Only the output channel is accepted. An unknown thread becomes a todo and
  // gets a capture line posted into it, so another channel must admit nothing.
  if (threadTs !== undefined && threadTs !== ts) {
    if (!slackReplyChannels().has(channel)) {
      return jsonResponse(200, { ok: true, ignored: true });
    }
    const tomSlackUserId = process.env.TOM_SLACK_USER_ID;
    if (!tomSlackUserId) {
      if (!warnedNoTomSlackUserId) {
        warnedNoTomSlackUserId = true;
        console.warn(
          "TTS slack events: TOM_SLACK_USER_ID not configured — threaded replies and digest reactions are ignored",
        );
      }
      return jsonResponse(200, { ok: true, ignored: true });
    }
    if (event.user !== tomSlackUserId) {
      return jsonResponse(200, { ok: true, ignored: true });
    }
    // Slack's event_id is the dedupe key (delivery is at-least-once); an
    // envelope without one falls back to the message's own coordinates.
    const eventId =
      typeof body.event_id === "string" && body.event_id !== ""
        ? body.event_id
        : `${channel}:${ts}`;
    const result = await ctx.runMutation(
      internal.ttsSlack.internalSlackThreadReply,
      { eventId, channel, threadTs, ts, text, user: tomSlackUserId },
    );
    return jsonResponse(200, { ok: true, ...result });
  }

  // A top-level Slack message is not captured by this route; acknowledge it so
  // Slack does not retry.
  return jsonResponse(200, { ok: true, ignored: true });
});

http.route({ path: "/slack/events", method: "POST", handler: slackEvents });


// GET /tts/state — the record as a box job or a session reads it: all todos
// and the server's clock. The server owns
// the day arithmetic (5 a.m. boundary + DST) so the worker never computes a
// day key — two hand-rolled implementations of that math diverged on DST
// Sundays before this was centralized (review finding). An explicit ?day=
// overrides `prepDay`. (The day's queue row rode this payload until the lifeos
// update, phase 7; today's view is computed, not stored.)
const ttsState = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const day =
    new URL(request.url).searchParams.get("day") ?? ttsPrepDay(Date.now());
  const todos = await ctx.runQuery(internal.tts.internalListTodos, {});
  // nowContext carries the NY calendar date too — a different question from
  // prepDay (which rolls at 5 a.m.) and the one a preparer needs to resolve
  // "sept 3" or "Friday" in a statement. Same rule either way: the server owns
  // the clock, the worker repeats it back.
  return jsonResponse(200, {
    todos,
    // The one home reaching the one caller that cannot import it: the delegate
    // is worker/jobs/delegate.mjs and Node does not load .ts, so the narrow
    // list and the delegate's budgets ride this payload.
    narrowList: NARROW_LIST,
    delegate: {
      maxPerSession: DELEGATE_MAX_PER_SESSION,
      maxPerJob: DELEGATE_MAX_PER_JOB,
      maxTurns: DELEGATE_MAX_TURNS,
      timeoutMs: DELEGATE_TIMEOUT_MS,
    },
    prepDay: day,
    ...nowContext(Date.now()),
  });
});

http.route({ path: "/tts/state", method: "GET", handler: ttsState });

// POST /tts/ruling is POST /jarvis/ruling's old spelling (convex/jarvis/rulings.ts),
// served until the box's callers spell the new one.
http.route({ path: "/tts/ruling", method: "POST", handler: postRuling });

// POST /tts/ask records a completed delegate call. It intentionally never
// calls a model: Fable runs on the box where the caller already is, while this
// route is the durable record, digest input, and immediate Slack notification.
// It is also the one door a `decision` event comes through (convex/ttsAsk.ts
// internalRecordAsk): the generic event routes refuse the kind.
const ttsAsk = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const nonempty = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if (!nonempty(b.askId) || !/^[0-9a-f]{8}$/.test(b.askId as string)) {
    return jsonResponse(400, { error: "askId (8 lowercase hex characters) required" });
  }
  const hasSession = nonempty(b.sessionId);
  const hasJob = nonempty(b.job);
  if (hasSession === hasJob) return jsonResponse(400, { error: "exactly one of sessionId or job is required" });
  if (b.todoId !== undefined && !nonempty(b.todoId)) return jsonResponse(400, { error: "todoId, when given, must be non-empty" });
  if (!nonempty(b.question) || (b.question as string).trim().length > 400) return jsonResponse(400, { error: "question (1-400 characters) required" });
  if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 5 || !b.options.every(nonempty)) return jsonResponse(400, { error: "options must be 2-5 non-empty strings" });
  const options = b.options.map((option) => (option as string).trim());
  if (!nonempty(b.recommendation) || !options.includes((b.recommendation as string).trim())) return jsonResponse(400, { error: "recommendation must be one of options" });
  if (!nonempty(b.fallback)) return jsonResponse(400, { error: "fallback (non-empty string) required" });
  if (b.decision !== null && !nonempty(b.decision)) return jsonResponse(400, { error: "decision must be a non-empty string or null" });
  if (!nonempty(b.reason) || (b.reason as string).trim().length > 400) return jsonResponse(400, { error: "reason (1-400 characters) required" });
  if (typeof b.refused !== "boolean") return jsonResponse(400, { error: "refused (boolean) required" });
  if (b.refused) {
    const id = typeof b.refusedBecause === "string" ? b.refusedBecause.split(" — ")[0] : "";
    if (!nonempty(b.refusedBecause) || !isNarrowListId(id)) return jsonResponse(400, { error: "refusedBecause must start with a narrow-list id" });
  } else if (b.refusedBecause !== null) return jsonResponse(400, { error: "refusedBecause must be null unless refused" });
  if (!nonempty(b.model) || !nonempty(b.promptSha)) return jsonResponse(400, { error: "model and promptSha (non-empty strings) required" });
  if (typeof b.ms !== "number" || !Number.isFinite(b.ms) || b.ms < 0) return jsonResponse(400, { error: "ms (nonnegative finite number) required" });
  if (b.restedOn !== undefined && !(Array.isArray(b.restedOn) && b.restedOn.every((line) => typeof line === "string"))) {
    return jsonResponse(400, { error: "restedOn, when given, is an array of strings" });
  }
  if (b.wouldChange !== undefined && b.wouldChange !== null && typeof b.wouldChange !== "string") {
    return jsonResponse(400, { error: "wouldChange, when given, is a string or null" });
  }
  // How long the question waited for Tom, and who decided (convex/ttsAsk.ts
  // ASK_ARGS). A decision by Tom is his reply: it names the needs-you item he
  // answered, and the mutation checks that reply before writing anything.
  if (b.waitedMs !== undefined && (typeof b.waitedMs !== "number" || !Number.isFinite(b.waitedMs) || b.waitedMs < 0)) {
    return jsonResponse(400, { error: "waitedMs, when given, is a nonnegative finite number of milliseconds" });
  }
  if (b.waitNote !== undefined && (typeof b.waitNote !== "string" || b.waitNote.trim().length > 400)) {
    return jsonResponse(400, { error: "waitNote, when given, is a string of at most 400 characters" });
  }
  if (b.decidedBy !== undefined && b.decidedBy !== "delegate" && b.decidedBy !== "tom") {
    return jsonResponse(400, { error: 'decidedBy, when given, is "delegate" or "tom"' });
  }
  if (b.decidedBy === "tom") {
    if (!nonempty(b.needsTomId)) return jsonResponse(400, { error: "a decision by Tom names needsTomId, the needs-you item his reply answered" });
    if (b.decision === null || b.refused !== false) return jsonResponse(400, { error: "a decision by Tom is his answer: decision set, refused false" });
  } else if (b.needsTomId !== undefined) {
    return jsonResponse(400, { error: 'needsTomId goes only with decidedBy "tom"' });
  }
  try {
    const result = await ctx.runMutation(internal.ttsAsk.internalRecordAsk, {
      askId: b.askId as string, sessionId: hasSession ? b.sessionId as string : undefined,
      job: hasJob ? b.job as string : undefined, todoId: b.todoId as string | undefined,
      question: (b.question as string).trim(), options,
      recommendation: (b.recommendation as string).trim(), fallback: (b.fallback as string).trim(),
      decision: b.decision as string | null, reason: (b.reason as string).trim(),
      refused: b.refused, refusedBecause: b.refusedBecause as string | null,
      model: b.model as string, ms: b.ms, promptSha: b.promptSha as string,
      restedOn: b.restedOn as string[] | undefined, wouldChange: b.wouldChange as string | null | undefined,
      nearMissed: b.nearMissed,
      waitedMs: b.waitedMs as number | undefined,
      waitNote: typeof b.waitNote === "string" ? b.waitNote.trim() : undefined,
      decidedBy: b.decidedBy as "delegate" | "tom" | undefined,
      needsTomId: b.needsTomId as string | undefined,
    });
    const context = await ctx.runQuery(internal.ttsAsk.internalAskContext, {
      sessionId: hasSession ? b.sessionId as string : undefined,
      job: hasJob ? b.job as string : undefined,
      todoId: b.todoId as string | undefined,
    });
    return jsonResponse(200, { ok: true, askId: b.askId, ...result, priorObjections: context.priorObjections });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : String(error) });
  }
});
http.route({ path: "/tts/ask", method: "POST", handler: ttsAsk });


// ── The mechanical merge gate's three doors (convex/ttsMerge.ts) ────────────
// Two facts about the merged head are read: the tests are green, and an audit
// approved it. These routes are where the two are written, where they are
// read, and where a passed merge is recorded.

// POST /tts/tests — the Guardrails run's own result, posted by the `report` job
// once the other four have answered (scripts/tests-report.mjs), or by the
// box's checks job. Body:
// { repo, sha, ok, detail?, url?, mode?, files?, durations?, slowest?,
// memory?, registryDiff? }.
//
// EITHER KEY: CI holds the narrow evals key and posts this fact, while the box
// holds the worker key and posts its own local runs. The worker key is
// strictly the more privileged of the two, so accepting it widens nothing.
//
// One row per commit, except that a red row posted with the box's key over a
// green one for a Jarvis or WikiTom commit is recorded and becomes the row the
// gate reads (convex/ttsMerge.ts internalRecordTests). The answer says which:
// { ok: true, recorded, existing, green, rule }, where `recorded` is true when
// this post wrote a row, `existing` when an earlier row stands instead,
// `green` is the verdict the gate now reads, and `rule` is the sentence.
/** `{ name: seconds }` when every value is a finite number, else null. The
 *  schema's `v.record(v.string(), v.number())` refuses anything else, and a
 *  refused mutation is a missing tests row. */
/** A whole number of zero or more: what a count of tests or of MiB is. */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [name, seconds] of Object.entries(value as Record<string, unknown>)) {
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
    out[name] = seconds;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** `{ memory }` with `{ step: { peak, resident?, budget } }` when every entry
 *  is a positive budget and non-negative finite measurements, `{ memory: null }`
 *  when the field is absent, else `{ error }` naming the entry and what is
 *  wrong with it. REFUSED, NOT DROPPED, unlike a malformed duration: the
 *  memory field is written only by the box's own checks job from a scope it
 *  measured, so a budget of zero or a negative byte count is a broken
 *  measurement, and a row recorded without it would hide that. */
function memoryRecord(value: unknown): { memory: Record<string, { peak: number; resident?: number; budget: number }> | null; error?: string } {
  if (value === undefined) return { memory: null };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { memory: null, error: "memory must be an object of { peak, resident?, budget } per step" };
  const out: Record<string, { peak: number; resident?: number; budget: number }> = {};
  for (const [step, entry] of Object.entries(value as Record<string, unknown>)) {
    const row = (entry ?? {}) as Record<string, unknown>;
    const bytes = (name: string, required: boolean): number | undefined | string => {
      const number = row[name];
      if (number === undefined && !required) return undefined;
      if (typeof number !== "number" || !Number.isFinite(number)) return `${name} must be a finite number of bytes`;
      if (number < 0) return `${name} must not be negative`;
      return number;
    };
    const peak = bytes("peak", true);
    const resident = bytes("resident", false);
    const budget = bytes("budget", true);
    for (const problem of [peak, resident, budget]) {
      if (typeof problem === "string") return { memory: null, error: `memory entry ${JSON.stringify(step)}: ${problem}` };
    }
    if ((budget as number) <= 0) return { memory: null, error: `memory entry ${JSON.stringify(step)}: budget must be positive` };
    out[step] = { peak: peak as number, ...(resident === undefined ? {} : { resident: resident as number }), budget: budget as number };
  }
  return { memory: Object.keys(out).length === 0 ? null : out };
}

/** The slowest files, kept to five: the warning names them and a row is a
 *  record, not the reporter's whole answer. */
function slowestFiles(value: unknown): { file: string; seconds: number }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { file: string; seconds: number }[] = [];
  for (const entry of value.slice(0, 5)) {
    const row = (entry ?? {}) as Record<string, unknown>;
    if (typeof row.file !== "string" || row.file.trim() === "") return null;
    if (typeof row.seconds !== "number" || !Number.isFinite(row.seconds)) return null;
    out.push({ file: row.file.trim(), seconds: row.seconds });
  }
  return out.length === 0 ? null : out;
}

const ttsTests = httpAction(async (ctx, request) => {
  const denied = presentsJarvisKey(request)
    ? ttsAuth(request)
    : keyAuth(request, "EVALS_KEY", "X-Evals-Key");
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const nonempty = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if (!nonempty(b.repo) || !nonempty(b.sha)) {
    return jsonResponse(400, { error: "repo and sha (non-empty strings) required" });
  }
  if (typeof b.ok !== "boolean") return jsonResponse(400, { error: "ok (boolean) required" });
  const durations = numberRecord(b.durations);
  const slowest = slowestFiles(b.slowest);
  const { memory, error: memoryError } = memoryRecord(b.memory);
  if (memoryError !== undefined) return jsonResponse(400, { error: memoryError });
  const registryDiff = registryDiffOf(b.registryDiff);
  const result = await ctx.runMutation(internal.ttsMerge.internalRecordTests, {
    repo: (b.repo as string).trim(),
    sha: (b.sha as string).trim(),
    ok: b.ok,
    ...(nonempty(b.detail) ? { detail: (b.detail as string).trim() } : {}),
    ...(nonempty(b.url) ? { url: (b.url as string).trim() } : {}),
    // WHICH SCOPE RAN AND HOW LONG IT TOOK. All four are optional and none is a
    // condition: a caller that sends none records the row it always did, and
    // the timing warning (convex/ttsMerge.ts slowConditions) simply has nothing
    // to measure. Each is DROPPED rather than refused when it is the wrong
    // shape — a malformed duration must not cost the gate its tests row.
    ...(nonempty(b.mode) ? { mode: (b.mode as string).trim() } : {}),
    ...(typeof b.files === "number" && Number.isFinite(b.files) ? { files: b.files } : {}),
    ...(durations === null ? {} : { durations }),
    ...(slowest === null ? {} : { slowest }),
    // WHAT THE RUN SKIPPED AND THE MOST MEMORY IT HELD, in MiB. Dropped like
    // the timing when not a count: a malformed number must not cost the gate
    // its tests row.
    ...(isCount(b.skipped) ? { skipped: b.skipped as number } : {}),
    ...(isCount(b.peakMemoryMb) ? { peakMemoryMb: b.peakMemoryMb as number } : {}),
    // EACH STEP'S PEAK MEMORY beside its budget, from the box's run; the
    // record's memory warning (convex/ttsMerge.ts slowConditions) reads it.
    // A malformed one was refused above (memoryRecord).
    ...(memory === null ? {} : { memory }),
    // WHAT A JARVIS HEAD DOES TO THE REGISTRY of parts (shared/jarvis-events.mjs
    // registryDiffOf), which tom.quest/design draws. Dropped like the timing
    // when malformed, for the same reason.
    ...(registryDiff === null ? {} : { registryDiff }),
    // WHO POSTED IT: the box's key may add a red row over a green one for a
    // Jarvis or WikiTom commit (convex/ttsMerge.ts internalRecordTests); the
    // evals key, GitHub Actions', never may.
    fromBox: presentsJarvisKey(request),
  });
  //  rather than : the answer's own ok says the POST landed, and
  // the row's ok says whether the tests were green.
  return jsonResponse(200, {
    ok: true,
    recorded: result.recorded,
    existing: result.existing,
    green: result.ok,
    rule: result.rule,
  });
});

http.route({ path: "/tts/tests", method: "POST", handler: ttsTests });

// POST /tts/audit — the Codex/Opus audit of one head. Body:
// { repo, sha, text, model?, fallback?, url? }, where `text` is the audit's
// own answer and `fallback` says why a stand-in model wrote it.
// The VERDICT LINE IS READ HERE, from that text, so the parse has one home
// (ttsMerge.auditVerdictOf) and the record keeps the words the auditor wrote.
// An answer with no `VERDICT: <WORD>` line of its own is refused rather than
// filed as a non-approval: an audit that did not say is an audit that did not
// finish, and the gate must not be able to confuse the two.
//
// The worker key: the audit step runs on the box.
const ttsAudit = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const nonempty = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if (!nonempty(b.repo) || !nonempty(b.sha)) {
    return jsonResponse(400, { error: "repo and sha (non-empty strings) required" });
  }
  if (!nonempty(b.text)) return jsonResponse(400, { error: "text (the audit answer) required" });
  const verdict = auditVerdictOf(b.text as string);
  if (verdict === null) {
    return jsonResponse(400, {
      error: "the audit answer carries no VERDICT: <WORD> line of its own",
    });
  }
  // ── What the audit saw, and whether its own claims are true ────────────────
  // THE SHAPES ARE THE DOOR'S BUSINESS; THE CAPS AND THE REDACTION ARE THE
  // MUTATION'S. internalRecordAudit's object validators would refuse a
  // malformed field with an exception the caller reads as a 500 naming nothing;
  // checking here answers a 400 that names the member. The capping and the
  // redaction stay THERE and are not repeated here, because two homes for one
  // rule is how one of them comes to be forgotten.
  //
  // ALL THREE ARE OPTIONAL AND AN ABSENT ONE SENDS NO KEY: a post with none of
  // them is an audit recorded before any of this existed, which is a different
  // fact from one that read nothing and traced nothing.
  let chunks:
    | { count: number; read: number; charsRead: number; charsTotal: number; truncatedChunks: number; files: number }
    | undefined;
  if (b.chunks !== undefined) {
    if (typeof b.chunks !== "object" || b.chunks === null || Array.isArray(b.chunks)) {
      return jsonResponse(400, { error: "chunks, when given, must be an object" });
    }
    const given = b.chunks as Record<string, unknown>;
    const counts: Record<string, number> = {};
    for (const member of ["count", "read", "charsRead", "charsTotal", "truncatedChunks", "files"]) {
      const value = given[member];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return jsonResponse(400, { error: `chunks.${member} must be a finite number of 0 or more` });
      }
      counts[member] = value;
    }
    // A COVERAGE RECORD THAT CLAIMS MORE THAN THERE WAS IS WORSE THAN NONE: it
    // reads as a fuller audit than the one that ran, and once it is on the row
    // nothing downstream can tell it from the truth. This door is the only
    // place that can say so before it is on the row forever.
    if (counts.read > counts.count) {
      return jsonResponse(400, { error: "chunks.read cannot exceed chunks.count" });
    }
    if (counts.charsRead > counts.charsTotal) {
      return jsonResponse(400, { error: "chunks.charsRead cannot exceed chunks.charsTotal" });
    }
    chunks = {
      count: counts.count, read: counts.read, charsRead: counts.charsRead,
      charsTotal: counts.charsTotal, truncatedChunks: counts.truncatedChunks, files: counts.files,
    };
  }
  // FORWARDED AS WRITTEN. internalRecordAudit caps the list and redacts each
  // finding, and doing either here as well would be that second home.
  let traceFindings: string[] | undefined;
  if (b.traceFindings !== undefined) {
    if (!Array.isArray(b.traceFindings) || !b.traceFindings.every((finding) => typeof finding === "string")) {
      return jsonResponse(400, { error: "traceFindings, when given, must be an array of strings" });
    }
    traceFindings = b.traceFindings as string[];
  }
  let trace: { available: boolean; reason?: string } | undefined;
  if (b.trace !== undefined) {
    if (typeof b.trace !== "object" || b.trace === null || Array.isArray(b.trace)) {
      return jsonResponse(400, { error: "trace, when given, must be an object" });
    }
    const given = b.trace as Record<string, unknown>;
    if (typeof given.available !== "boolean") {
      return jsonResponse(400, { error: "trace.available (boolean) required" });
    }
    if (given.reason !== undefined && typeof given.reason !== "string") {
      return jsonResponse(400, { error: "trace.reason, when given, must be a string" });
    }
    trace = {
      available: given.available,
      ...(given.reason === undefined ? {} : { reason: given.reason as string }),
    };
  }
  const result = await ctx.runMutation(internal.ttsMerge.internalRecordAudit, {
    repo: (b.repo as string).trim(),
    sha: (b.sha as string).trim(),
    verdict,
    text: b.text as string,
    ...(nonempty(b.model) ? { model: (b.model as string).trim() } : {}),
    // Why a stand-in auditor answered ("codex-cap"): the row declares a
    // same-family audit rather than passing it off as the second opinion the
    // check is for (convex/ttsMerge.ts auditFallbackNote).
    ...(nonempty(b.fallback) ? { fallback: (b.fallback as string).trim() } : {}),
    ...(nonempty(b.url) ? { url: (b.url as string).trim() } : {}),
    ...(chunks === undefined ? {} : { chunks }),
    ...(traceFindings === undefined ? {} : { traceFindings }),
    ...(trace === undefined ? {} : { trace }),
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/audit", method: "POST", handler: ttsAudit });

// GET /tts/merge-gate?repo=&sha= — the two checks, and which of the
// required ones are missing. This is what the box asks before it lets a merge command run
// (worker/session-host/session.mjs), so it is read-only and opens nothing.
const ttsMergeGate = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const repo = (params.get("repo") ?? "").trim();
  const sha = (params.get("sha") ?? "").trim();
  if (repo === "" || sha === "") return jsonResponse(400, { error: "repo and sha required" });
  return jsonResponse(200, await ctx.runQuery(internal.ttsMerge.internalMergeGate, { repo, sha }));
});

http.route({ path: "/tts/merge-gate", method: "GET", handler: ttsMergeGate });

// POST /tts/merge records a merge that has already happened. It is not a
// delegate decision: a mechanically gated merge is reported in the objection
// list on the digest, keyed by repo+sha so a retry stays one
// event. The gate runs again inside the mutation, so a merge that reached the
// default branch some other way cannot be laundered into a reported one; the
// answer is then 409 naming which checks are missing.
const ttsMerge = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonResponse(400, { error: "invalid JSON body" }); }
  const b = (body ?? {}) as Record<string, unknown>;
  const nonempty = (value: unknown) => typeof value === "string" && value.trim() !== "";
  if (!nonempty(b.repo) || !nonempty(b.sha) || !nonempty(b.subject)) return jsonResponse(400, { error: "repo, sha, and subject (non-empty strings) required" });
  if (b.todoId !== undefined && !nonempty(b.todoId)) return jsonResponse(400, { error: "todoId, when given, must be non-empty" });
  // A merge GitHub does not show is not recorded: the row cannot be corrected
  // once written (convex/ttsMerge.ts mergedOnMain).
  const onMain = await mergedOnMain(b.repo as string, b.sha as string);
  if (!onMain.merged) return jsonResponse(409, { ok: false, recorded: false, error: `not recorded: ${onMain.why}` });
  try {
    const result = await ctx.runMutation(internal.ttsMerge.internalRecordMerge, { repo: b.repo as string, sha: b.sha as string, subject: b.subject as string, todoId: b.todoId as string | undefined, mainCheck: onMain.why });
    if (!result.recorded) {
      return jsonResponse(409, {
        ok: false,
        error: `the merge gate is not met — missing: ${result.gate.missing.join(", ")}`,
        ...result,
      });
    }
    return jsonResponse(200, { ok: true, ...result });
  } catch (error) {
    return jsonResponse(400, { error: error instanceof Error ? error.message : String(error) });
  }
});
http.route({ path: "/tts/merge", method: "POST", handler: ttsMerge });


// ── POST /tts/model-of-tom — the nightly job's three-layer publication every
// prompt selects from (the lifeos update, phase 4) ───────────────────────────
// Body: { commit, committedAt, pushed, force?, layers, headers, files }.
// `layers` and the seven selection headers are already rendered by the
// publisher; files retain source facts ({ path, body, bytes }). The store is
// replaced atomically in convex/ttsSkills.ts.
const MODEL_OF_TOM_FILES_MAX = 64;

const ttsModelOfTom = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.commit !== "string" || !/^[0-9a-f]{40}$/.test(b.commit)) {
    return jsonResponse(400, { error: "commit (40 hex characters) required" });
  }
  if (typeof b.committedAt !== "number" || !Number.isFinite(b.committedAt)) {
    return jsonResponse(400, { error: "committedAt (epoch ms) required" });
  }
  if (typeof b.pushed !== "boolean") {
    return jsonResponse(400, { error: "pushed (boolean) required" });
  }
  if (b.force !== undefined && (typeof b.force !== "string" || b.force.trim() === "")) {
    return jsonResponse(400, { error: "force, when given, is the reason (a non-empty string)" });
  }
  // `operate` IS THE ONLY LAYER STORED (convex/ttsSkills.ts); the write pages
  // come from modelOfTomFiles. `write` and `know` are still ACCEPTED here and
  // dropped in the mutation, because the publisher renders all three —
  // refusing a night's base over text nothing reads would cost the prefix.
  if (typeof b.layers !== "object" || b.layers === null) {
    return jsonResponse(400, { error: "layers ({ operate }) required" });
  }
  const rawLayers = b.layers as Record<string, unknown>;
  if (!Object.keys(rawLayers).every((name) => (MODEL_OF_TOM_LAYER_NAMES as readonly string[]).includes(name))) {
    return jsonResponse(400, { error: "layers may name only operate, write, and know" });
  }
  const layers: { operate: string; write?: string; know?: string } = { operate: "" };
  for (const name of MODEL_OF_TOM_LAYER_NAMES) {
    const value = rawLayers[name];
    if (value === undefined && name !== "operate") continue;
    if (typeof value !== "string" || value.trim() === "") {
      return jsonResponse(400, { error: `layers.${name} (non-empty string) required` });
    }
    layers[name] = value;
  }
  if (!Array.isArray(b.headers) || b.headers.length === 0 || b.headers.length > 7) {
    return jsonResponse(400, { error: "headers (1 to 7 canonical selections, including operate) required" });
  }
  const headers: { layers: (typeof MODEL_OF_TOM_LAYER_NAMES)[number][]; header: string }[] = [];
  for (let i = 0; i < b.headers.length; i++) {
    const header = b.headers[i] as Record<string, unknown> | null;
    if (typeof header !== "object" || header === null || !Array.isArray(header.layers) ||
      !header.layers.every((name) => (MODEL_OF_TOM_LAYER_NAMES as readonly string[]).includes(name as string)) ||
      typeof header.header !== "string" || header.header.trim() === "" || header.header.includes("\n")) {
      return jsonResponse(400, { error: `headers[${i}] must contain layers and a non-empty header` });
    }
    headers.push({ layers: header.layers as (typeof MODEL_OF_TOM_LAYER_NAMES)[number][], header: header.header });
  }
  // THE GRAPH VERSION THE BASE WAS PUBLISHED FROM. The nightly generates the
  // graph and posts the base in the same step off the same commit, so this
  // names the object a run row's own `graphVersion` names. Optional, because a
  // box whose graph step failed still has a base worth posting; absent stores
  // nothing rather than an empty string.
  //
  // REMOVAL CHECK: sent-but-blank and absent are different facts, and treating
  // the first as the second is what this refuses. Absence is a box whose graph
  // step did not run — nothing to say, and nothing stored. A blank or a number
  // is a CALLER BUG: something computed a version and got "" or 7, and storing
  // that as "no version" hides the bug in a field the merge gate and the run
  // row both read. The 400 is how the caller finds out.
  if (b.graphVersion !== undefined && b.graphVersion !== null
    && (typeof b.graphVersion !== "string" || b.graphVersion.trim() === "")) {
    return jsonResponse(400, { error: "graphVersion, when given, is a non-empty string" });
  }
  const graphVersion = typeof b.graphVersion === "string" && b.graphVersion.trim() !== ""
    ? b.graphVersion
    : undefined;
  if (!Array.isArray(b.files)) {
    return jsonResponse(400, { error: "files (array) required" });
  }
  if (b.files.length > MODEL_OF_TOM_FILES_MAX) {
    return jsonResponse(400, {
      error: `at most ${MODEL_OF_TOM_FILES_MAX} files per post — got ${b.files.length}`,
    });
  }
  if (b.files.length === 0) {
    return jsonResponse(400, { error: "files (non-empty array) required" });
  }
  const files: { path: string; body: string; bytes: number }[] = [];
  for (let i = 0; i < b.files.length; i++) {
    const f = b.files[i] as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null || !isModelOfTomPath(f.path)) {
      return jsonResponse(400, {
        error: `files[${i}].path must be a markdown path under model-of-tom/`,
      });
    }
    if (typeof f.body !== "string" || f.body.trim() === "") {
      return jsonResponse(400, { error: `files[${i}].body (non-empty string) required` });
    }
    if (typeof f.bytes !== "number" || !Number.isSafeInteger(f.bytes) || f.bytes < 0) {
      return jsonResponse(400, { error: `files[${i}].bytes (nonnegative integer) required` });
    }
    files.push({ path: f.path, body: f.body, bytes: f.bytes });
  }
  try {
    const result = await ctx.runMutation(
      internal.ttsSkills.internalReplaceModelOfTom,
        { commit: b.commit, committedAt: b.committedAt, pushed: b.pushed, force: b.force, layers, headers, files, graphVersion },
    );
    return jsonResponse(200, { ok: true, commit: b.commit, ...result });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/model-of-tom", method: "POST", handler: ttsModelOfTom });


// ── The nightly job's doors (convex/ttsNightly.ts) ───────────────────────────


// A registration token is a UUID (worker/agents/registration.mjs mints it with
// crypto.randomUUID), and the shape is CHECKED BEFORE THE LOOKUP. An
// unvalidated string on an indexed read is a scan this deployment pays for on
// behalf of whoever sent it; refusing the shape costs one regex.
const RUN_TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /tts/agent-trace?token=… — the same token, the same agent, ITS TOOL CALLS.
//
// WHY IT EXISTS: the audit checks its own claims against its own run. It says
// it opened `convex/foo.ts`, and this says whether any Read, Grep or Glob call
// in that run ever named that path (worker/jobs/audit.mjs, finding 2). Without
// it the audit's "I read the whole change" is unverifiable, which is the exact
// fault this round closes.
//
// NARROW ON PURPOSE: tool NAMES and PATHS, redacted and bounded, never the
// transcript, its text or its results.
//
// Read-only, worker-keyed, and SHAPE-CHECKED BEFORE THE LOOKUP for the reason
// stated at RUN_TOKEN_SHAPE. `null` for an unknown token is a normal answer,
// because the sweeper needs a moment to see the run's file.
const ttsAgentTrace = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!RUN_TOKEN_SHAPE.test(token)) {
    return jsonResponse(400, { error: "token (a registration UUID) required" });
  }
  return jsonResponse(200, await ctx.runQuery(internal.agents.internalAgentTrace, { token }));
});

http.route({ path: "/tts/agent-trace", method: "GET", handler: ttsAgentTrace });

// `tts search evals` (convex/ttsEvals.ts internalSearchEvals): the newest
// eval-run rows, `limit` of them.
const ttsSearchEvals = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 200)) {
    return jsonResponse(400, { error: "limit must be 1 to 200" });
  }
  return jsonResponse(200, await ctx.runQuery(internal.ttsEvals.internalSearchEvals, { limit }));
});

http.route({ path: "/tts/search/evals", method: "GET", handler: ttsSearchEvals });

// POST /tts/event — one dtsEvents row from the worker. Body: { kind, data? }.
// The job records a failed step ("nightly-failure") and its summary
// ("nightly-run") this way, which is what
// the digest reads for "job failures" and "what the nightly job wrote". Before
// each push of WikiTom's main it also posts a "nightly-run" row keyed
// `WikiTom@<sha>` for each commit it is about to push, which opens the merge
// gate for that commit (convex/ttsMerge.ts NIGHTLY_RUN). The mutation refuses
// a kind Convex writes itself.
const ttsEvent = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.kind !== "string" || b.kind === "") {
    return jsonResponse(400, { error: "kind (non-empty string) required" });
  }
  if (b.kind === "thread-reply" || b.kind === "thread-message") {
    return jsonResponse(400, { error: "thread events are written through their own route" });
  }
  if ((TOM_ONLY_KINDS as readonly string[]).includes(b.kind)) {
    return jsonResponse(403, { error: `${b.kind} is Tom-only` });
  }
  if ((DELEGATE_ONLY_KINDS as readonly string[]).includes(b.kind)) {
    return jsonResponse(403, { error: `${b.kind} is written only by POST /tts/ask` });
  }
  if ((JARVIS_EVENT_ONLY_KINDS as readonly string[]).includes(b.kind)) {
    return jsonResponse(403, { error: `${b.kind} is written only by POST /jarvis/event` });
  }
  if ((RECORD_ONLY_KINDS as readonly string[]).includes(b.kind)) {
    return jsonResponse(403, { error: `${b.kind} is written only by the record` });
  }
  // This route's row is copied into events unchecked (jarvis/events
  // copyDtsRow), so a ruling posted here would skip the sentence check.
  if ((STANDING_RULING_ONLY_KINDS as readonly string[]).includes(b.kind)) {
    return jsonResponse(403, { error: `${b.kind} is written only by POST /jarvis/standing-ruling` });
  }
  if (b.key !== undefined && (typeof b.key !== "string" || b.key.trim() === "")) {
    return jsonResponse(400, { error: "key, when given, is a non-empty string" });
  }
  // The key becomes the record row's subject (jarvis/events copyDtsRow), so a
  // kind whose subject is its identity is refused without one here, as POST
  // /jarvis/event refuses it (shared/jarvis-events.mjs SUBJECT_REQUIRED).
  if (b.key === undefined && SUBJECT_REQUIRED.includes(b.kind)) {
    return jsonResponse(400, { error: `a ${b.kind} event names its key` });
  }
  try {
    // A box change goes to the record's own write, not dtsEvents
    // (convex/ttsNightly.ts internalRecordBoxChange), for as long as a box
    // still posts it here.
    if (b.kind === "box-change") {
      const recorded = await ctx.runMutation(internal.ttsNightly.internalRecordBoxChange, { data: b.data, key: b.key as string | undefined });
      return jsonResponse(200, { ok: true, ...recorded });
    }
    // One mutation writes the row and its copy in the one record
    // (convex/jarvis/events.ts copyDtsRow), so /agents and GET /jarvis/events
    // show one list while the areas that still post here move to POST
    // /jarvis/event. The copy goes with this route.
    const id = await ctx.runMutation(internal.ttsNightly.internalRecordWorkerEvent, {
      kind: b.kind,
      data: b.data,
      key: b.key,
    });
    return jsonResponse(200, { ok: true, id });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/event", method: "POST", handler: ttsEvent });

// (POST /tts/plan-graph, the planner's pen that wrote one batch's graph per
// call, and POST /tts/plan-repairs-consumed, which marked the workers'
// wrong-edge reports read, went with batches: Tom's ruling of 2026-09-24. A box
// still running the old plan pass gets a 404 from each, and forms no batch.)

// POST /tts/session-outcome — a worker's outcome pen. Body:
// { sessionId, outcome: "completed"|"errored", summary? }. It lives under the
// TTS key ON PURPOSE: a worker's environment carries ONLY
// CONVEX_SITE_URL + TTS_WORKER_KEY — SESSIONS_WORKER_KEY never enters a
// model-reachable shell (the auth-clobber lesson: the ingest key would let a
// prompt-injected session forge poll/ingest traffic for every session), so
// the one key the agent holds must be the one this pen accepts.
const ttsSessionOutcome = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.sessionId !== "string" || b.sessionId === "") {
    return jsonResponse(400, { error: "sessionId required" });
  }
  if (b.outcome !== "completed" && b.outcome !== "errored") {
    return jsonResponse(400, {
      error: 'outcome must be "completed" or "errored"',
    });
  }
  // (The wrong-edge channel, `planRepair`, went with the plan pass that read
  // it. A worker opened before that still sends the field; it is not read, so
  // the outcome still lands.)
  try {
    await ctx.runMutation(internal.claudeSessions.internalRecordOutcome, {
      id: b.sessionId,
      outcome: b.outcome,
      summary: typeof b.summary === "string" ? b.summary : "",
    });
    return jsonResponse(200, { ok: true });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/tts/session-outcome",
  method: "POST",
  handler: ttsSessionOutcome,
});

// ── Claude Code session-host endpoints ───────────────────────────────────────
// The session-host daemon's channel (worker/session-host/). Its OWN key —
// SESSIONS_WORKER_KEY shares nothing with the other keys (the auth-clobber
// lesson). Two routes: poll (heartbeat + full state pull for every live
// session) and ingest (per-session flush whose response piggybacks pending
// commands + permission decisions). Bodies validated hand-rolled, rejected by
// name; the heavy lifting lives in convex/claudeSessions.ts internal
// functions.

function sessionsAuth(request: Request): Response | null {
  return keyAuth(request, "SESSIONS_WORKER_KEY", "X-Sessions-Key");
}

const sessionsPoll = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.version !== "string" || b.version === "") {
    return jsonResponse(400, { error: "version (non-empty string) required" });
  }
  if (typeof b.daemonStartedAt !== "number") {
    return jsonResponse(400, { error: "daemonStartedAt (number) required" });
  }
  const result = await ctx.runMutation(internal.claudeSessions.internalPoll, {
    version: b.version,
    daemonStartedAt: b.daemonStartedAt,
    activeAccount:
      typeof b.activeAccount === "string" ? b.activeAccount : undefined,
    lastIngestError:
      typeof b.lastIngestError === "string"
        ? b.lastIngestError.slice(0, 2000)
        : undefined,
    // Jarvis Box load snapshot, loose-shape: the mutation's arg validator is the
    // final gate; a malformed report surfaces as a validator error.
    load:
      typeof b.load === "object" && b.load !== null
        ? (b.load as never)
        : undefined,
    // Codex account usage, same loose-shape posture as `load`: the mutation's
    // arg validator is the final gate, so a malformed report surfaces as a
    // named validator error rather than being half-stored here.
    codexUsage:
      typeof b.codexUsage === "object" && b.codexUsage !== null
        ? (b.codexUsage as never)
        : undefined,
    codexModels: stringList(b.codexModels),
    hosts: stringList(b.hosts),
    held: stringList(b.held),
    // Fable availability (worker/agents/models.mjs), the same loose-shape
    // posture: the mutation's arg validator is the final gate.
    fableAvailability:
      typeof b.fableAvailability === "object" && b.fableAvailability !== null
        ? (b.fableAvailability as never)
        : undefined,
    // The latest usage limit the daemon recorded, the same posture.
    usageLimit:
      typeof b.usageLimit === "object" && b.usageLimit !== null
        ? (b.usageLimit as never)
        : undefined,
  });
  return jsonResponse(200, result);
});

/** A list of strings from a daemon body, or undefined when it is not one. */
function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? (value as string[]) : undefined;
}

http.route({ path: "/sessions/poll", method: "POST", handler: sessionsPoll });

const sessionsIngest = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  // `agentId` is the wire spelling of the stored `runId`: it is moved to the
  // stored key here, so the strict validator below never meets it, and a body
  // still sending `runId` is refused.
  const raw = (body ?? {}) as Record<string, unknown>;
  const old = oldSpelling(raw, { runId: "agentId" });
  if (old) return jsonResponse(400, { error: old });
  const { agentId, ...rest } = raw;
  const b: Record<string, unknown> = agentId !== undefined ? { ...rest, runId: agentId } : rest;
  if (typeof b.sessionId !== "string" || b.sessionId === "") {
    return jsonResponse(400, { error: "sessionId required" });
  }
  try {
    // Field-level validation happens in the internal mutation's arg
    // validators; a mismatch surfaces here as a named 400.
    const result = await ctx.runMutation(
      internal.claudeSessions.internalIngest,
      b as never,
    );
    return jsonResponse(200, result);
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/sessions/ingest",
  method: "POST",
  handler: sessionsIngest,
});

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

// Agent-file ingestion deliberately shares the daemon worker credential while
// migration still has one box-side installation surface. Only this legacy
// auth helper retains the old name.
//
// The body arrives in the agent spelling (`agent`, and `agentId`,
// `parentAgentId`, `rootAgentId`, `continuesAgentId` on the agent object and
// on each child edge); a run-spelled key anywhere there is refused. It is put
// in the stored spelling before any other check, so internalIngest's strict
// validator sees only keys it declares.
const agentsIngest = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const parsed = await boundedJson(request, AGENTS_INGEST_MAX_BODY_BYTES);
  if ("tooLarge" in parsed) return jsonResponse(413, { error: "request body too large" });
  if ("invalid" in parsed) return jsonResponse(400, { error: "invalid JSON body" });
  const raw = (parsed.body ?? {}) as Record<string, unknown>;
  const old = ingestOldSpelling(raw);
  if (old) return jsonResponse(400, { error: old });
  const b = storedIngestBody(raw);
  if (typeof b.run !== "object" || b.run === null || !Array.isArray(b.rows) || !Array.isArray(b.children)) {
    return jsonResponse(400, { error: "agent, rows, and children required" });
  }
  if (!validAgentId((b.run as Record<string, unknown>).runId)) return jsonResponse(400, { error: "agentId invalid" });
  try {
    const result = await ctx.runMutation(internal.agents.internalIngest, b as never);
    return jsonResponse(200, result);
  } catch {
    return jsonResponse(400, { error: "agent ingest rejected" });
  }
});
http.route({ path: "/agents/ingest", method: "POST", handler: agentsIngest });

// Payload text never reaches a validator error: every field is narrowed here
// and failures use fixed words so the caller cannot reflect a transcript.
const agentsOverflow = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const parsed = await boundedJson(request, AGENTS_OVERFLOW_MAX_BODY_BYTES);
  if ("tooLarge" in parsed) return jsonResponse(413, { error: "request body too large" });
  if ("invalid" in parsed) return jsonResponse(400, { error: "invalid JSON body" });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const old = oldSpelling(b, { runId: "agentId" });
  if (old) return jsonResponse(400, { error: old });
  const agentId = b.agentId;
  if (!validAgentId(agentId)) return jsonResponse(400, { error: "agentId invalid" });
  for (const field of ["seq", "index", "chunkCount"] as const) if (!nonNegativeInteger(b[field])) return jsonResponse(400, { error: `${field} (non-negative integer) required` });
  if (typeof b.text !== "string") return jsonResponse(400, { error: "text (string) required" });
  try {
    const result = await ctx.runMutation(internal.agents.internalIngestOverflow, { runId: agentId, seq: b.seq as number, index: b.index as number, chunkCount: b.chunkCount as number, text: b.text });
    return result.ok ? jsonResponse(200, result) : jsonResponse(409, { error: result.reason });
  } catch { return jsonResponse(400, { error: "overflow chunk rejected" }); }
});
http.route({ path: "/agents/overflow", method: "POST", handler: agentsOverflow });

// POST /agents/run-end — the end of one run, as the box saw it: { agentId,
// endedAt (epoch ms), endReason (one of agents.RUN_END_REASONS) }. Posted by
// the sweep from the end marker a SessionEnd or SubagentStop hook, a launcher
// or the Codex runner wrote, after the run's page is in. The key and the wire
// spelling are the other /agents routes'. A run the record does not hold
// answers 404, which the box reads as final and retires the end; the sweep
// posts the end only after the run's page is in, so a held run is the case it
// meets. Any other refusal is a 400, which the box also does not retry.
const agentsRunEnd = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const old = oldSpelling(b, { runId: "agentId" });
  if (old) return jsonResponse(400, { error: old });
  if (!validAgentId(b.agentId)) return jsonResponse(400, { error: "agentId invalid" });
  if (typeof b.endedAt !== "number" || !Number.isFinite(b.endedAt) || b.endedAt <= 0) {
    return jsonResponse(400, { error: "endedAt (epoch ms) required" });
  }
  if (typeof b.endReason !== "string" || !(RUN_END_REASONS as readonly string[]).includes(b.endReason)) {
    return jsonResponse(400, { error: `endReason must be one of ${RUN_END_REASONS.join(", ")}` });
  }
  const result = await ctx.runMutation(internal.agents.internalRecordRunEnd, {
    runId: b.agentId,
    endedAt: b.endedAt,
    endReason: b.endReason as RunEndReason,
  });
  if (!result.ok) return jsonResponse(result.reason === "no run" ? 404 : 400, { error: result.reason });
  const { runId, ...rest } = result;
  return jsonResponse(200, { ...rest, agentId: runId });
});
http.route({ path: "/agents/run-end", method: "POST", handler: agentsRunEnd });

const agentsOverflowStamp = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const parsed = await boundedJson(request, AGENTS_OVERFLOW_MAX_BODY_BYTES);
  if ("tooLarge" in parsed) return jsonResponse(413, { error: "request body too large" });
  if ("invalid" in parsed) return jsonResponse(400, { error: "invalid JSON body" });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  const old = oldSpelling(b, { runId: "agentId" });
  if (old) return jsonResponse(400, { error: old });
  const agentId = b.agentId;
  if (!validAgentId(agentId)) return jsonResponse(400, { error: "agentId invalid" });
  for (const field of ["seq", "byteLength", "chunkCount"] as const) if (!nonNegativeInteger(b[field])) return jsonResponse(400, { error: `${field} (non-negative integer) required` });
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return jsonResponse(400, { error: "sha256 (64 hex chars) required" });
  try {
    const result = await ctx.runMutation(internal.agents.internalStampOverflow, { runId: agentId, seq: b.seq as number, sha256: b.sha256, byteLength: b.byteLength as number, chunkCount: b.chunkCount as number });
    return result.ok ? jsonResponse(200, result) : jsonResponse(409, { error: result.reason });
  } catch { return jsonResponse(400, { error: "overflow stamp rejected" }); }
});
http.route({ path: "/agents/overflow/stamp", method: "POST", handler: agentsOverflowStamp });


// The WikiTom writer receives already-shaped manifest entries and an opaque
// cursor. The full `(at, agentId, fileVersion)` checkpoint makes equal-ms
// versions retry-safe without dropping later lines at the same timestamp.
// The entries keep their `run_id` keys: WikiTom stores them as written.
const agentsManifest = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const sinceText = url.searchParams.get("since");
  if (sinceText === null || sinceText === "") return jsonResponse(400, { error: "since required" });
  const since = Number(sinceText);
  if (!Number.isFinite(since) || since < 0) return jsonResponse(400, { error: "since (non-negative number) required" });
  if (url.searchParams.has("afterRunId")) return jsonResponse(400, { error: "afterRunId is no longer read; send afterAgentId" });
  const afterRunId = url.searchParams.get("afterAgentId") ?? undefined;
  const afterFileVersion = url.searchParams.get("afterFileVersion") ?? undefined;
  if ((afterRunId === undefined) !== (afterFileVersion === undefined)) return jsonResponse(400, { error: "manifest checkpoint requires agentId and fileVersion together" });
  try {
    const result = await ctx.runQuery(internal.agents.internalManifest, {
      since,
      afterRunId,
      afterFileVersion,
      cursor: url.searchParams.get("cursor") ?? undefined,
    });
    return jsonResponse(200, result);
  } catch {
    return jsonResponse(400, { error: "manifest page rejected" });
  }
});
http.route({ path: "/agents/manifest", method: "GET", handler: agentsManifest });

// GET /sessions/transcript?sessionId=<id>&cursor=<opaque> — one page of a
// session's finalized transcript, oldest first. The daemon walks it to write
// .tts-transcript.md into a forked session's workspace before that session's
// first turn (claudeSessions.forkSessionAs): a cross-family fork carries no
// SDK state, so the previous conversation reaches the new model only as text
// on disk. Same SESSIONS_WORKER_KEY door as poll/ingest — this is the daemon's
// channel, and a whole transcript is exactly what must not be readable by the
// key an agent's own shell holds.
//
// A GET with query params rather than a POST body: the daemon loops on
// `nextCursor` until it is null, and a cursor in a URL is what makes that loop
// resumable from a log line. Nothing personal rides in the params — a session
// id and an opaque page cursor.
const sessionsTranscript = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return jsonResponse(400, { error: "sessionId required" });
  }
  const cursor = url.searchParams.get("cursor");
  try {
    const result = await ctx.runQuery(
      internal.claudeSessions.internalTranscriptPage,
      {
        sessionId: sessionId as never,
        cursor: cursor ?? undefined,
      },
    );
    return jsonResponse(200, result);
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/sessions/transcript",
  method: "GET",
  handler: sessionsTranscript,
});

// GET /sessions/secrets — every value waiting in the /secrets mailbox
// (convex/secrets.ts), as { secrets: [{ name, value, setAt }] }. The daemon
// writes each into its env file and answers POST /sessions/secrets/taken
// { name, setAt }, which deletes the value and keeps the name and dates.
//
// THE DAEMON'S DOOR, NOT THE TTS ONE. SESSIONS_WORKER_KEY never enters an
// agent's shell (worker/session-host/env-scrub.mjs); TTS_WORKER_KEY is in
// every session's shell and every cron job's agentic run. A pending value
// behind X-TTS-Key would be readable by any agent with one curl, which is the
// one thing this mailbox exists to prevent.
//
// Errors are fixed strings: the taken body names a variable, and nothing
// here may echo a value into a response the daemon would log.
const sessionsSecrets = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const secrets = await ctx.runQuery(internal.secrets.internalPending, {});
  return jsonResponse(200, { secrets });
});

http.route({ path: "/sessions/secrets", method: "GET", handler: sessionsSecrets });

// ── Sessions the box did not start, and the subagents sessions dispatch ─────
// convex/sessionRegistration.ts holds what each writes. The SessionStart,
// SubagentStart and SubagentStop hooks (Jarvis scripts/agent-hook.mjs) post
// the first two; the session host reads the third.
async function sessionsBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : jsonResponse(400, { error: "a JSON object is required" });
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
}

const agentsSessionRegister = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const b = await sessionsBody(request);
  if (b instanceof Response) return b;
  try {
    const result = await ctx.runMutation(internal.sessionRegistration.internalRegisterSession, b as never);
    return jsonResponse(200, result);
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

http.route({ path: "/agents/session-register", method: "POST", handler: agentsSessionRegister });

const agentsSubagent = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const b = await sessionsBody(request);
  if (b instanceof Response) return b;
  try {
    const result = await ctx.runMutation(internal.sessionRegistration.internalSubagentEvent, b as never);
    return jsonResponse(200, result);
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

http.route({ path: "/agents/subagent", method: "POST", handler: agentsSubagent });

const sessionsRunningSubagents = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  // Every page: a running subagent past the first hundred is still one the
  // host must check.
  const subagents: unknown[] = [];
  let cursor: string | null = null;
  for (;;) {
    const result: { page: unknown[]; isDone: boolean; continueCursor: string } = await ctx.runQuery(internal.sessionRegistration.internalRunningSubagents, { cursor });
    subagents.push(...result.page);
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  return jsonResponse(200, { subagents });
});

http.route({ path: "/sessions/subagents/running", method: "GET", handler: sessionsRunningSubagents });

const sessionsSecretsTaken = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name === "") {
    return jsonResponse(400, { error: "name required" });
  }
  if (typeof b.setAt !== "number") {
    return jsonResponse(400, { error: "setAt (number) required" });
  }
  const result = await ctx.runMutation(internal.secrets.internalTaken, {
    name: b.name,
    setAt: b.setAt,
  });
  return result.ok ? jsonResponse(200, result) : jsonResponse(409, { error: result.reason });
});

http.route({ path: "/sessions/secrets/taken", method: "POST", handler: sessionsSecretsTaken });

// ── /jarvis/: the one prefix (night/s3, 2026-09-26) ─────────────────────────
// The record's own routes first (convex/jarvis/routes.ts register), then
// every /tts/* route above is also served under /jarvis/* by the same
// handler, so the box switches its base path (Jarvis worker/jobs/tts-lib.mjs
// recordRoute) with no change in behaviour. A /jarvis/ path an area has
// registered itself keeps its own handler: the loop skips it, which is how
// an area moves a route (write the /jarvis/ handler; the /tts/ one still
// answers old callers). /tts/ GOES WHEN THE BOX HAS SWITCHED: delete the
// loop and each /tts/ registration per area, and the area's route file is
// the only registration left.
registerJarvisRoutes(http);
const jarvisOwn = new Set(
  http.getRoutes().filter(([path]) => path.startsWith("/jarvis/")).map(([path, method]) => `${method} ${path}`),
);
for (const [path, method, handler] of http.getRoutes()) {
  if (!path.startsWith("/tts/")) continue;
  const moved = `/jarvis/${path.slice("/tts/".length)}`;
  if (jarvisOwn.has(`${method} ${moved}`)) continue;
  http.route({ path: moved, method, handler });
}

export default http;
