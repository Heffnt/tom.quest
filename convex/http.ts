import { httpRouter } from "convex/server";
import type { FunctionArgs } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { nowContext } from "./tts";
import { isRulingVerdict } from "./ttsRulings";
import {
  DELEGATE_MAX_PER_JOB,
  DELEGATE_MAX_PER_SESSION,
  DELEGATE_MAX_TURNS,
  DELEGATE_TIMEOUT_MS,
} from "./ttsAsk";
import {
  DAY_MS,
  NARROW_LIST,
  RECOMMENDATION_VALUES,
  SESSION_REPO_NAMES,
  TTS_CLOSED_VOCABULARY,
  channelFor,
  isRecommendation,
  isSessionModel,
  nyCalendarDayBoundsUtc,
  ttsPrepDay,
  type Recommendation,
} from "./ttsShared";
import { isNarrowListId } from "./ttsShared";
import { auditVerdictOf } from "./ttsMerge";
import { isModelOfTomPath, MODEL_OF_TOM_LAYER_NAMES } from "./ttsSkills";
import { isRepoRulesPath } from "./ttsContext";
import { EXPORT_PAGE_DEFAULT, EXPORT_TABLES, isExportTable } from "./ttsNightly";

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
const RUNS_INGEST_ENVELOPE_BYTES = 1024 * 1024;
const RUNS_INGEST_MAX_BODY_BYTES =
  6 * 200 * 32 * 1024 + RUNS_INGEST_ENVELOPE_BYTES;
// A chunk itself may be 256 KiB. In the worst valid JSON string encoding every
// content byte is a six-byte `\uXXXX` escape (quotes and backslashes use two),
// with 4 KiB left for the fixed fields and JSON punctuation.
const RUNS_OVERFLOW_ENVELOPE_BYTES = 4 * 1024;
const RUNS_OVERFLOW_MAX_BODY_BYTES =
  6 * 256 * 1024 + RUNS_OVERFLOW_ENVELOPE_BYTES;
const RUN_ID = /^(claude|codex):(laptop|box):[A-Za-z0-9._-]{8,128}(\/[A-Za-z0-9._-]{8,128})?$/;

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

function validRunId(runId: unknown): runId is string {
  return typeof runId === "string" && RUN_ID.test(runId);
}

/** Worker jobs need the original missing-layer sentence, not a framework
 * exception, so their nonzero exit names the deployment state to repair. */
function modelOfTomErrorResponse(error: unknown): Response {
  return jsonResponse(503, { error: error instanceof Error ? error.message : String(error) });
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

type PoolRequest = {
  writer: string;
  gpuType: string;
  desiredCount: number;
  enabled: boolean;
  restart: "always" | "never";
};

// Validate the agent request body. The agent may scale/toggle/restart only — never a command,
// projectDir, or resource limit — so those fields are not even accepted here (spec §7).
function parsePoolRequest(body: unknown): PoolRequest | { error: string } {
  if (typeof body !== "object" || body === null) {
    return { error: "body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (typeof b.gpuType !== "string" || b.gpuType.length === 0) {
    return { error: "gpuType (non-empty string) required" };
  }
  if (typeof b.desiredCount !== "number" || !Number.isFinite(b.desiredCount)) {
    return { error: "desiredCount (finite number) required" };
  }
  if (typeof b.enabled !== "boolean") {
    return { error: "enabled (boolean) required" };
  }
  if (b.restart !== "always" && b.restart !== "never") {
    return { error: 'restart must be "always" or "never"' };
  }
  const writer =
    typeof b.writer === "string" && b.writer.length > 0 ? b.writer : "agent";
  return {
    writer,
    gpuType: b.gpuType,
    desiredCount: b.desiredCount,
    enabled: b.enabled,
    restart: b.restart,
  };
}

// Agent worker-pool scaling endpoint (spec §7). The narrow, key-authed path an agent uses to
// scale / toggle / set the restart policy of a PRE-APPROVED (admin-authored) pool row. It may
// write only desiredCount / enabled / restart via internal.gpuPool.agentScale, and never
// authors a command — so arbitrary shell as the cluster user over the agent key is impossible
// (that stays a Tom-only capability behind the admin path). The key is POOL_AGENT_KEY, stored
// only in the Convex env and sharing nothing with TURING_API_KEY (the auth-clobber lesson).
const pool = httpAction(async (ctx, request) => {
  const denied = keyAuth(request, "POOL_AGENT_KEY", "X-Pool-Key");
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const parsed = parsePoolRequest(body);
  if ("error" in parsed) {
    return jsonResponse(400, parsed);
  }
  try {
    const result = await ctx.runMutation(internal.gpuPool.agentScale, parsed);
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    // agentScale refuses (no insert) when no admin-authored row exists for the gpuType —
    // surface that as 404, any other failure as 400. The command is never agent-writable.
    const message = e instanceof Error ? e.message : String(e);
    const status = message.includes("no admin-authored") ? 404 : 400;
    return jsonResponse(status, { error: message });
  }
});

http.route({ path: "/pool", method: "POST", handler: pool });

// Agent worker-pool READ endpoint (spec §7) — the key-authed monitoring counterpart to POST /pool.
// Lets a monitoring agent confirm pool desired-state, the last reconcile outcome, and the recent
// agent-write audit WITHOUT an admin session or the deploy key. Read-only: same POOL_AGENT_KEY and
// the same 503-then-401 guard order as the write path, but it never parses a body (a GET has none)
// and reads only the projected/internal queries — never the requireAdmin status/list, which would
// throw under the agent key. GET and POST coexist on "/pool" because the router keys on path+method.
const poolRead = httpAction(async (ctx, request) => {
  const denied = keyAuth(request, "POOL_AGENT_KEY", "X-Pool-Key");
  if (denied) return denied;
  return jsonResponse(200, {
    configs: await ctx.runQuery(internal.gpuPool.publicConfigs, {}),
    status: await ctx.runQuery(internal.gpuPool.prevStatus, {}),
    recentAgentLog: await ctx.runQuery(internal.gpuPool.recentAgentLog, {}),
  });
});

http.route({ path: "/pool", method: "GET", handler: poolRead });

// ── TTS worker endpoints (spec: WikiTom tts/spec.md) ─────────────────────────
// The Jarvis Box's narrow, key-authed path into TTS, mirroring the /pool
// pattern: TTS_WORKER_KEY lives only in the Convex env and shares nothing with
// the other keys. The worker may capture items, post the day's prepared
// queue+digest, and read state to prepare from — never rule, archive, or
// delete (those are Tom-gated mutations). The one ruling door on this key,
// POST /tts/ruling, writes only what Tom himself typed: it takes the id of a
// turn he authored and his sentence verbatim, and refuses anything else.

function ttsAuth(request: Request): Response | null {
  return keyAuth(request, "TTS_WORKER_KEY", "X-TTS-Key");
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
// item. Body: { statement, source?, provenance? }.
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
  const id = await ctx.runMutation(internal.tts.internalCapture, {
    statement: b.statement,
    source: typeof b.source === "string" && b.source ? b.source : "slack-capture",
    provenance: typeof b.provenance === "string" ? b.provenance : undefined,
    // The Slack coordinates, when the caller is a Slack producer. They are
    // what the threaded reply is addressed to and what the push route dedupes
    // on; a caller that has none simply omits them.
    slackChannel: typeof b.slackChannel === "string" ? b.slackChannel : undefined,
    slackTs: typeof b.slackTs === "string" ? b.slackTs : undefined,
  });
  return jsonResponse(200, { ok: true, id });
});

http.route({ path: "/tts/capture", method: "POST", handler: ttsCapture });

// GET /tts/capture-context supplies the model-of-tom context a capture run
// works from, and the declined integrations, before a poller captures anything.
// The worker cannot import TypeScript or read the WikiTom checkout, so it
// receives the assembled text instead.
//
// ITS BYTES SHRANK, ITS MEANING DID NOT (the dynamic-context round): this was
// the write + know layers whole, 29.6 KB with the whole know layer inside it.
// It is now the stable prefix, nothing expanded (a poller has no subject of its
// own — rule 12), and the FETCHABLE index, which names every page, section and
// search question it did not get and the exact command that gets it. Rule 7
// gives this caller `priorities.md § What becomes a todo`, because capture is
// the one thing it does on his behalf.

const ttsCaptureContext = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let writingStandard: string;
  let declinedIntegrations;
  try {
    [writingStandard, declinedIntegrations] = await Promise.all([
      ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "capture-context" }),
      ctx.runQuery(internal.ttsIntegrations.internalDeclinedIntegrations, {}),
    ]);
  } catch (error) {
    return modelOfTomErrorResponse(error);
  }
  return jsonResponse(200, {
    writingStandard,
    declinedIntegrations,
  });
});

http.route({
  path: "/tts/capture-context",
  method: "GET",
  handler: ttsCaptureContext,
});

// POST /tts/needs-tom — one needs-you thread for a todo only Tom can settle.
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
  // #tts-needs-you OR NOWHERE. This route used to omit `channel` when
  // SLACK_TTS_NEEDS_YOU_CHANNEL_ID was unset, and the Slack door's default
  // target is SLACK_TTS_CHANNEL_ID — so an unset variable did not silence the
  // thread, it moved it into #tts-today, the one room the design says nothing
  // but the morning message may write to. channelFor logs and answers null
  // instead (ruling digest-env-missing-is-quiet), and nothing is opened.
  //
  // A DROP IS A BROKEN JOB, NOT SILENCE. Quiet here means Tom never learns
  // that the things only he can settle stopped arriving, so the drop is
  // reported through the same door a box job's failure comes through
  // (convex/ttsJobs.ts): one "job-failed" row, keyed on the condition so a
  // poller running every half hour writes it once, and the digest and the
  // hourly update carry it to #tts-broken for as long as it stands.
  const channel = channelFor("needsYou");
  if (channel === null) {
    const reported = await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
      job: "tts/needs-tom",
      error:
        "SLACK_TTS_NEEDS_YOU_CHANNEL_ID is not set — needs-you threads are being dropped rather than posted to #tts-today. Set it (slack-design.md §5.1).",
      key: "tts/needs-tom:needs-you-channel",
    });
    return jsonResponse(200, {
      ok: false,
      opened: false,
      key: b.key,
      reason: "SLACK_TTS_NEEDS_YOU_CHANNEL_ID not configured",
      ...reported,
    });
  }
  try {
    const result = await ctx.runMutation(internal.ttsSlack.internalOpenNeedsTomThread, {
      todoId: b.todoId,
      reason: b.reason,
      key: b.key,
      // The reply invitation is printed only when a reply would reach TTS.
      canReply: Boolean(process.env.SLACK_SIGNING_SECRET && process.env.TOM_SLACK_USER_ID),
      channel,
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/needs-tom", method: "POST", handler: ttsNeedsTom });

// ── The Fable writer's two doors (Tom 2026-09-09, amendment 2) ──────────────
// The morning message is written by a Fable run on the Jarvis Box, not filled
// into a template. Convex cannot run a model, so the 5 a.m. cron opens a
// DRAFT REQUEST carrying the deterministic facts block and returns; the box
// job (worker/jobs/write-slack.mjs) reads the open requests here, writes the
// message, and submits it. The verifier runs in the SUBMIT mutation, so a
// draft that invents a link or a number is refused by Convex rather than by
// the thing that wrote it.
//
// GET /tts/slack-drafts — the open requests, newest first. Each carries the
// facts block, whether a reply invitation may be printed, and the complaints
// from an earlier attempt (which is what the one repair turn is written
// against).
const ttsSlackDrafts = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const open = await ctx.runQuery(internal.ttsSlackDrafts.internalOpenDraftRequests, {});
  return jsonResponse(200, { ok: true, requests: open });
});

http.route({ path: "/tts/slack-drafts", method: "GET", handler: ttsSlackDrafts });

// POST /tts/slack-draft — one written draft. Body: { requestId, draft }, where
// `draft` is { firstLine, firstLineSources, lines: [{ role, text, url?,
// sources }] }. The answer says whether it was accepted and, when it was not,
// every complaint the verifier made and whether this was the last attempt.
const ttsSlackDraftSubmit = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.requestId !== "string" || b.requestId.trim().length === 0) {
    return jsonResponse(400, { error: "requestId (non-empty string) required" });
  }
  if (b.draft === null || typeof b.draft !== "object") {
    return jsonResponse(400, { error: "draft (object) required" });
  }
  try {
    const result = await ctx.runMutation(internal.ttsSlackDrafts.internalSubmitSlackDraft, {
      requestId: b.requestId,
      draft: b.draft,
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

http.route({ path: "/tts/slack-draft", method: "POST", handler: ttsSlackDraftSubmit });

// POST /tts/canvas-assignments — the Canvas assignments worker/jobs/
// poll-canvas.mjs read this run (the lifeos update, phase 6). Body:
// { assignments: [{ externalId, courseCode, name, htmlUrl, dueAt, submitted }] }.
//
// The job owns the FETCH (one job and one CANVAS_TOKEN copy, in
// /etc/tts/worker.env); convex/ttsCanvas.ts owns what a fetched assignment
// DOES to a todo — insert, move the date, complete on submission — because
// that is a mutation. The mutation's own validators are the gate on the array;
// this route only carries the traffic and names a refusal.
//
// REPLAYING THE SAME ASSIGNMENTS CHANGES NOTHING: the sync keys every row by
// its `canvas:assignment:<id>` provenance, so a re-run creates no second todo.
const ttsCanvasAssignments = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.assignments)) {
    return jsonResponse(400, { error: "assignments (array) required" });
  }
  try {
    const result = await ctx.runMutation(
      internal.ttsCanvas.internalSyncCanvasTodos,
      { assignments: b.assignments as never },
    );
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/tts/canvas-assignments",
  method: "POST",
  handler: ttsCanvasAssignments,
});

// POST /tts/job-failed — a box job reporting its own failure in plain words
// (the lifeos update, phase 6). Body: { job, error, key? }.
//
// This is the channel convex/ttsDigest.ts already reads: every "-failed" event
// kind becomes a line in the morning digest's job-failures section, and
// convex/ttsHourly.ts names "job-failed" among the kinds the hourly update
// reports. Until now nothing on the Jarvis Box could write one — a cron job's
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
// key is unconditional: one row per call.
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
  const result = await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
    job: b.job,
    error: b.error,
    key: typeof b.key === "string" ? b.key : undefined,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/job-failed", method: "POST", handler: ttsJobFailed });

// POST /tts/job-ok — the same box job saying it just ran clean. Body:
// { job, key }.
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
  const result = await ctx.runMutation(internal.ttsJobs.internalReportJobOk, {
    job: b.job,
    key: b.key,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/job-ok", method: "POST", handler: ttsJobOk });

// POST /tts/calendar-event — the Jarvis Box's path through the ONE write door
// to Tom's Google Calendar (convex/ttsCalendarWrite.ts owns the door; this
// route only carries the traffic). Body: { title, start, end, description?,
// location?, recurrence?, calendarId? } — start/end epoch ms.
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
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/tts/calendar-event",
  method: "POST",
  handler: ttsCalendarEvent,
});

// ── POST /slack/events — Slack PUSHES #dump messages to TTS ──────────────────
// Tom's ruling 2026-08-30: Slack pushes instead of TTS polling every two
// minutes. worker/jobs/poll-dump.mjs STAYS as the reconciliation backstop
// (Slack's delivery is best-effort, not guaranteed) at an hourly cadence; its
// cursor file is what makes a missed event recoverable.
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
//  3. 200 within 3 seconds or Slack retries. The capture is a single
//     idempotent insert, so it happens inline and nothing else does.
//
// Replay window: 5 minutes, standard for this scheme. It bounds how long a
// captured request stays useful to an attacker who has the bytes but not the
// secret; without it a signed request is valid forever.
const SLACK_REPLAY_WINDOW_MS = 5 * 60 * 1000;
// Log-once guard for an unset TOM_SLACK_USER_ID (per isolate — Convex may run
// the route in more than one, so "once" is once per warm runtime).
let warnedNoTomSlackUserId = false;
// The same guard for an unset SLACK_DUMP_CHANNEL_ID, which admits no capture.
let warnedNoDumpChannel = false;

/** The channels a threaded reply is acted on in: the three TTS posts to.
 * Read per request so a value set after the isolate warmed up counts. */
function slackReplyChannels(): Set<string> {
  return new Set(
    [
      process.env.SLACK_DUMP_CHANNEL_ID,
      process.env.SLACK_TTS_CHANNEL_ID,
      process.env.SLACK_TTS_TODAY_CHANNEL_ID,
      process.env.SLACK_TTS_HOURLY_CHANNEL_ID,
      // The three rooms this round adds, so a reply in them is acted on:
      // "revert" in a decision's thread, an answer in a needs-you thread, a
      // note on a failure (convex/ttsSlack.ts routeReply).
      process.env.SLACK_TTS_DECISIONS_CHANNEL_ID,
      process.env.SLACK_TTS_NEEDS_YOU_CHANNEL_ID,
      process.env.SLACK_TTS_BROKEN_CHANNEL_ID,
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

  // The SAME filter poll-dump.mjs applies, and it must stay the same filter:
  // bot_id skips our own posts (including the threaded replies this whole
  // feature adds — otherwise every reply would capture itself), subtype skips
  // joins/edits/thread-broadcasts, and empty text has nothing to capture.
  const dumpChannel = process.env.SLACK_DUMP_CHANNEL_ID;
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
  // A reply in a thread is never a capture; it is Tom answering something TTS
  // posted (a digest line, an hourly update, a session that needs him, the
  // reply under his own #dump message). Accepted from ONE Slack user id —
  // TOM_SLACK_USER_ID — because a reply becomes a session's next turn or a
  // time note on a todo, which are Tom's pens; anyone else's reply is
  // acknowledged and ignored. Unset means no threaded reply is acted on, and
  // the log says so once per isolate rather than on every event.
  //
  // And accepted in TTS's OWN channels only: #dump, #tts, #tts-hourly. An
  // unknown thread becomes a todo and gets a capture line posted into it, so
  // a reply in any other channel the app happens to be in would make TTS
  // post where nobody asked it to (agents post nothing Tom did not ask for).
  // Each id is read as it is set; an unset one admits nothing.
  if (threadTs !== undefined && threadTs !== ts) {
    if (!slackReplyChannels().has(channel)) {
      return jsonResponse(200, { ok: true, ignored: true });
    }
    const tomSlackUserId = process.env.TOM_SLACK_USER_ID;
    if (!tomSlackUserId) {
      if (!warnedNoTomSlackUserId) {
        warnedNoTomSlackUserId = true;
        console.warn(
          "TTS slack events: TOM_SLACK_USER_ID not configured — threaded replies are ignored",
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

  // A top-level message is a capture only in #dump, and an UNSET id admits
  // nothing — the same posture as TOM_SLACK_USER_ID above, and for the same
  // reason. Read as "no channel is #dump yet", this used to read as "every
  // channel is #dump": a message in any channel the app happens to be in
  // became a todo and got a bot reply posted under it, TTS speaking where
  // nobody asked it to. Logged once per isolate rather than per event.
  if (!dumpChannel) {
    if (!warnedNoDumpChannel) {
      warnedNoDumpChannel = true;
      console.warn(
        "TTS slack events: SLACK_DUMP_CHANNEL_ID not configured — captures are ignored",
      );
    }
    return jsonResponse(200, { ok: true, ignored: true });
  }
  if (channel !== dumpChannel) {
    return jsonResponse(200, { ok: true, ignored: true });
  }

  // The capture itself — one idempotent insert keyed on the message ts, so
  // Slack's at-least-once retries and poll-dump's backstop pass converge on
  // one todo. No permalink call here: fetching one is a second network round
  // trip inside the 3-second budget, and poll-dump's provenance is not worth
  // the risk of a retry storm. The ts IS the address until then. The one
  // reply line in the message's thread is scheduled by the capture itself
  // (tts.internalCapture → ttsSync.sendSlack), so a retry never re-posts it.
  const id = await ctx.runMutation(internal.tts.internalCapture, {
    statement: text,
    source: "slack-capture",
    provenance: `slack:#dump ts=${ts}`,
    slackChannel: channel,
    slackTs: ts,
  });
  return jsonResponse(200, { ok: true, id });
});

http.route({ path: "/slack/events", method: "POST", handler: slackEvents });

// POST /tts/prepare-todo — the worker's preparer job attaches brief /
// entry action / work description to a life todo and advances its readiness,
// plus the date the statement itself states, if any.
// Body: { id, brief?, entryAction?, workDescription?, readiness?, dueAt?,
// dateKind?, evidence?, groundUpExplanation?, status? }.
const ttsPrepareTodo = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) {
    return jsonResponse(400, { error: "id (non-empty string) required" });
  }
  // "prepared" (ruling 18) is the one value; the retired spellings are
  // refused since the narrow (the lifeos update, phase 7). The literal
  // "unprepared" is refused too (an agent never erases a write-up).
  if (b.readiness !== undefined && b.readiness !== "prepared") {
    return jsonResponse(400, {
      error: 'readiness must be "prepared"',
    });
  }
  if (
    b.dateKind !== undefined &&
    b.dateKind !== "external" &&
    b.dateKind !== "self-imposed"
  ) {
    return jsonResponse(400, {
      error: 'dateKind must be "external" or "self-imposed"',
    });
  }
  if (b.dueAt !== undefined && typeof b.dueAt !== "number") {
    return jsonResponse(400, { error: "dueAt must be a number (epoch ms)" });
  }
  // The graph worker's completion value (schema v2): "done" is the only status
  // this pen accepts, and only on a todo inside a batch — the mutation is the
  // real gate and refuses a standalone one by name.
  if (b.status !== undefined && b.status !== "done") {
    return jsonResponse(400, { error: 'status must be "done"' });
  }
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  try {
    await ctx.runMutation(internal.tts.internalPrepareTodo, {
      id: b.id,
      brief: str(b.brief),
      entryAction: str(b.entryAction),
      workDescription: str(b.workDescription),
      readiness: b.readiness as "prepared" | undefined,
      // The date the STATEMENT states, when it states one. The mutation is
      // the real gate: a first date only, never over an existing one.
      dueAt: b.dueAt as number | undefined,
      dateKind: b.dateKind as "external" | "self-imposed" | undefined,
      // The graph worker's three: the artifact that shows the work happened,
      // the self-contained "more" layer, and the completion itself.
      evidence: str(b.evidence),
      groundUpExplanation: str(b.groundUpExplanation),
      status: b.status as "done" | undefined,
    });
    return jsonResponse(200, { ok: true });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/prepare-todo", method: "POST", handler: ttsPrepareTodo });

// GET /tts/state — the record as a box job or a session reads it: all todos,
// the coming week of calendar events, and the server's clock. The server owns
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
  // The coming week of external-calendar mirror rows (ttsCalendarEvents):
  // schedule knowledge, shown as context.
  const dayStart = nyCalendarDayBoundsUtc(day).start;
  const calendarEvents = await ctx.runQuery(
    internal.ttsCalendar.internalListEventsInRange,
    { start: dayStart, end: dayStart + 7 * DAY_MS },
  );
  // nowContext carries the NY calendar date too — a different question from
  // prepDay (which rolls at 5 a.m.) and the one a preparer needs to resolve
  // "sept 3" or "Friday" in a statement. Same rule either way: the server owns
  // the clock, the worker repeats it back.
  return jsonResponse(200, {
    todos,
    calendarEvents,
    // The one home reaching the one caller that cannot import it: the delegate
    // is worker/jobs/delegate.mjs and Node does not load .ts, so the narrow
    // list and the delegate's budgets ride this payload the way
    // writingStandard and sessionRepos ride /tts/batch-context.
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

// ── TTS time notes (ratified 2026-08-29) ─────────────────────────────────────
// Same TTS_WORKER_KEY path. Tom writes one freeform sentence about time
// against a todo, a block, or a calendar day; apply-time-notes.mjs reads the
// pending queue here, asks Claude for concrete actions, and posts them back.
// The SERVER decides what is legal (internalApplyTimeNote re-validates every
// action against the same helpers the Tom-gated mutations use) — these routes
// only carry the traffic.

// POST /tts/time-notes — the pending queue, each note with the full context it
// is about, plus the server's clock: the worker never computes New York time
// itself (the /tts/state prepDay convention), it repeats back what it is told.
const ttsTimeNotes = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let notes;
  let writingStandard: string;
  try {
    [notes, writingStandard] = await Promise.all([
      ctx.runQuery(internal.tts.internalPendingTimeNotes, {}),
      ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "time-notes" }),
    ]);
  } catch (error) {
    return modelOfTomErrorResponse(error);
  }
  return jsonResponse(200, { notes, writingStandard, ...nowContext(Date.now()) });
});

http.route({ path: "/tts/time-notes", method: "POST", handler: ttsTimeNotes });

// POST /tts/apply-time-note — the worker's verdict on one note.
// Body: { id, status: "applied"|"needs-session", result, actions? }.
// A rejection here is the POINT of the endpoint: the note stays pending (the
// mutation rolls back whole) and the job re-submits it as needs-session with
// the reason, so a kept-dates violation surfaces to Tom instead of landing.
// The actions array is passed to the mutation AS WRITTEN — the Convex union
// validator is the single gate. No projection step: a sanitizer that silently
// dropped a field the model DID send (a create-block category, say) would let a
// half-understood action land as a different, legal one. Malformed in, 400 out,
// needs-session on Tom's page. The one thing read here first is the retired
// sleep vocabulary (retiredTimeNoteAction), which the validator would refuse
// anyway — reading it names WHICH spelling it was.

// One note is one sentence; ten actions is already far past what one sentence
// asks for (Convex bounded-args guideline).
const TIME_NOTE_ACTIONS_MAX = 10;

// The mutation's OWN declared arg type — the only assertion here, and one that
// cannot drift from the validator the way a hand-written projection could.
type TimeNoteActions = FunctionArgs<
  typeof internal.tts.internalApplyTimeNote
>["actions"];

// The one exception to "no projection step": three spellings of a retired
// sleep. A latest-safe instant and a wake CONDITION are gone (the lifeos
// update, phase 7) — a sleep is a wake time, and what a row waits for belongs
// in its statement. The union validator would refuse them anyway; this names
// which one it was, so a job still emitting them is readable from the reply
// rather than from a validator dump. Returns the reason, or null.
function retiredTimeNoteAction(actions: unknown): string | null {
  if (!Array.isArray(actions)) return null;
  for (const action of actions) {
    if (typeof action !== "object" || action === null) continue;
    const a = action as Record<string, unknown>;
    if (a.kind === "set-latest-safe" || a.kind === "clear-latest-safe") {
      return `${a.kind} is retired — a sleep is a wake time (set-waiting with wakeAt)`;
    }
    if (a.kind === "set-waiting" && a.wakeCondition !== undefined) {
      return "set-waiting.wakeCondition is retired — what a row waits for goes in its statement";
    }
  }
  return null;
}
const ttsApplyTimeNote = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) {
    return jsonResponse(400, { error: "id (non-empty string) required" });
  }
  if (b.status !== "applied" && b.status !== "needs-session") {
    return jsonResponse(400, {
      error: 'status must be "applied" or "needs-session"',
    });
  }
  if (typeof b.result !== "string" || b.result.trim().length === 0) {
    return jsonResponse(400, { error: "result (non-empty string) required" });
  }
  if (Array.isArray(b.actions) && b.actions.length > TIME_NOTE_ACTIONS_MAX) {
    return jsonResponse(400, {
      error: `at most ${TIME_NOTE_ACTIONS_MAX} actions per time note — got ${b.actions.length}`,
    });
  }
  // The retired sleep vocabulary, named here rather than left to the union
  // validator's error. Until worker/setup.sh had rolled out these were
  // DECLARED and did nothing, so a box that had not caught up still landed its
  // whole flush; setup.sh has since run at main 6825608, so a note still
  // carrying one comes from code nobody runs and says so plainly.
  const retired = retiredTimeNoteAction(b.actions);
  if (retired) return jsonResponse(400, { error: retired });
  try {
    const outcome = await ctx.runMutation(internal.tts.internalApplyTimeNote, {
      id: b.id,
      status: b.status,
      result: b.result,
      actions: Array.isArray(b.actions)
        ? (b.actions as TimeNoteActions)
        : undefined,
    });
    return jsonResponse(200, outcome);
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/tts/apply-time-note",
  method: "POST",
  handler: ttsApplyTimeNote,
});

// ── TTS code-todo ruling loop (spec §5.3) ────────────────────────────────────
// Same TTS_WORKER_KEY path: the worker posts ground-up briefs for open code
// todos, reads back Tom's pending rulings, and reports each application. The
// worker never rules — recordCodeRuling is Tom-gated in ttsCode.ts.

// A brief's recommendation is one of the four verdict words and nothing else
// (ttsShared is the one home). The three retired spellings were refused here
// from the moment the box's own job stopped emitting them; now the validator
// behind this route refuses them too.
const CODE_EXEC_CLASSES = ["box", "needs-turing"] as const;

type CodeBrief = {
  repo: string;
  externalId: string;
  sourceHash: string;
  brief: string;
  recommendation: Recommendation;
  execClass: (typeof CODE_EXEC_CLASSES)[number];
  evidence?: string;
};

// Validate one posted brief. Every field the schema requires must arrive as a
// non-empty string / a known enum member — a malformed item rejects the whole
// batch by index so the worker can fix its payload.
function parseCodeBrief(item: unknown, i: number): CodeBrief | { error: string } {
  if (typeof item !== "object" || item === null) {
    return { error: `briefs[${i}] must be an object` };
  }
  const b = item as Record<string, unknown>;
  for (const field of ["repo", "externalId", "sourceHash", "brief"] as const) {
    if (typeof b[field] !== "string" || b[field].length === 0) {
      return { error: `briefs[${i}].${field} (non-empty string) required` };
    }
  }
  if (!isRecommendation(b.recommendation)) {
    return {
      error: `briefs[${i}].recommendation must be one of ${RECOMMENDATION_VALUES.join(" | ")}`,
    };
  }
  if (
    !CODE_EXEC_CLASSES.includes(b.execClass as (typeof CODE_EXEC_CLASSES)[number])
  ) {
    return {
      error: `briefs[${i}].execClass must be one of ${CODE_EXEC_CLASSES.join(" | ")}`,
    };
  }
  if (b.evidence !== undefined && typeof b.evidence !== "string") {
    return { error: `briefs[${i}].evidence must be a string when present` };
  }
  return {
    repo: b.repo as string,
    externalId: b.externalId as string,
    sourceHash: b.sourceHash as string,
    brief: b.brief as string,
    recommendation: b.recommendation,
    execClass: b.execClass as (typeof CODE_EXEC_CLASSES)[number],
    evidence: b.evidence as string | undefined,
  };
}

// POST /tts/code-briefs — the worker's prepared briefs, upserted by
// (repo, externalId). Body: { briefs: [{ repo, externalId, sourceHash, brief,
// recommendation, execClass, evidence? }] }.
const ttsCodeBriefs = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.briefs)) {
    return jsonResponse(400, { error: "briefs (array) required" });
  }
  const briefs: CodeBrief[] = [];
  for (let i = 0; i < b.briefs.length; i++) {
    const parsed = parseCodeBrief(b.briefs[i], i);
    if ("error" in parsed) return jsonResponse(400, parsed);
    briefs.push(parsed);
  }
  await ctx.runMutation(internal.ttsCode.internalStoreBriefs, { briefs });
  return jsonResponse(200, { ok: true, count: briefs.length });
});

http.route({ path: "/tts/code-briefs", method: "POST", handler: ttsCodeBriefs });

// GET /tts/rulings — the rulings a box job should act on (unapplied and not
// superseded by a newer ruling on the same subject), from the unified
// ttsRulings table. ALL THREE subject types ride the one feed: rows carry
// subjectType, and the planner (worker/jobs/plan-graphs.mjs) filters for its
// own kinds — a "life" revise → its prepare pass, a "code" revise → its brief
// pass, a "batch" revise → its plan pass — consuming only what it served. A
// "code" approve or archive rides the feed too but is consumed by the
// auto-session scheduler in Convex. Each row carries its _id, which the
// planner echoes back to /tts/ruling-applied.
const ttsRulingsFeed = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const pending = await ctx.runQuery(
    internal.ttsRulings.internalPendingRulings,
    {},
  );
  return jsonResponse(200, { pending });
});

// /tts/rulings is the only path. The feed carries every subject type, so there
// is no code-scoped variant: a /tts/code-rulings alias pointed at this same
// handler for workers predating the unified feed, and was removed once every
// caller had moved to /tts/rulings.
http.route({ path: "/tts/rulings", method: "GET", handler: ttsRulingsFeed });

// POST /tts/code-ruling-applied — the worker's apply report. Body: { id,
// result } where result is a commit sha / PR url / error text.
const ttsCodeRulingApplied = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id.length === 0) {
    return jsonResponse(400, { error: "id (non-empty string) required" });
  }
  if (typeof b.result !== "string" || b.result.length === 0) {
    return jsonResponse(400, { error: "result (non-empty string) required" });
  }
  try {
    await ctx.runMutation(internal.ttsRulings.internalMarkRulingApplied, {
      id: b.id,
      result: b.result,
    });
    return jsonResponse(200, { ok: true });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

// Canonical path: /tts/ruling-applied (any subject type); old name aliased
// for not-yet-redeployed workers.
http.route({
  path: "/tts/ruling-applied",
  method: "POST",
  handler: ttsCodeRulingApplied,
});
http.route({
  path: "/tts/code-ruling-applied",
  method: "POST",
  handler: ttsCodeRulingApplied,
});

// POST /tts/ruling — a ruling from Tom's own words (ruling 15, 2026-09-05).
// Body: { inboundId, verdict, subjectType, subjectId, quote, sentence? }: the
// claudeInbound row Tom typed, one of the four verdicts, "life" | "code" |
// "batch", the subject's id (a code subject is "<repo> <externalId>"), one
// whole sentence of Tom's turn verbatim (provenance only), and — on revise
// alone — the ruling's own sentence, the redirect, which is another (or the
// same) whole sentence of that turn. Same key as every worker pen; the
// checks that make it Tom's pen and not the agent's — the row is
// Tom-authored, the quote and the redirect are whole sentences of it, the
// subject exists and is what the turn's session was about, the row has not
// ruled on this subject before — live in
// ttsRulings.internalRecordRulingFromTomWords, and each refusal comes back
// as a 400 with its reason.
const ttsRuling = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.inboundId !== "string" || b.inboundId === "") {
    return jsonResponse(400, { error: "inboundId (non-empty string) required" });
  }
  if (!isRulingVerdict(b.verdict)) {
    return jsonResponse(400, {
      error: "verdict must be one of approve, revise, session, archive",
    });
  }
  if (b.subjectType !== "life" && b.subjectType !== "code" && b.subjectType !== "batch") {
    return jsonResponse(400, {
      error: "subjectType must be one of life, code, batch",
    });
  }
  if (typeof b.subjectId !== "string" || b.subjectId === "") {
    return jsonResponse(400, { error: "subjectId (non-empty string) required" });
  }
  if (typeof b.quote !== "string" || b.quote.trim() === "") {
    return jsonResponse(400, { error: "quote (non-empty string) required" });
  }
  if (b.sentence !== undefined && typeof b.sentence !== "string") {
    return jsonResponse(400, { error: "sentence must be a string when given" });
  }
  try {
    const id = await ctx.runMutation(
      internal.ttsRulings.internalRecordRulingFromTomWords,
      {
        inboundId: b.inboundId,
        verdict: b.verdict,
        subjectType: b.subjectType,
        subjectId: b.subjectId,
        quote: b.quote,
        sentence: b.sentence,
      },
    );
    return jsonResponse(200, { ok: true, id });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/ruling", method: "POST", handler: ttsRuling });

// POST /tts/ask records a completed delegate call. It intentionally never
// calls a model: Fable runs on the box where the caller already is, while this
// route is the durable record, digest input, and immediate Slack notification.
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
  try {
    const result = await ctx.runMutation(internal.ttsAsk.internalRecordAsk, {
      askId: b.askId as string, sessionId: hasSession ? b.sessionId as string : undefined,
      job: hasJob ? b.job as string : undefined, todoId: b.todoId as string | undefined,
      question: (b.question as string).trim(), options,
      recommendation: (b.recommendation as string).trim(), fallback: (b.fallback as string).trim(),
      decision: b.decision as string | null, reason: (b.reason as string).trim(),
      refused: b.refused, refusedBecause: b.refusedBecause as string | null,
      model: b.model as string, ms: b.ms, promptSha: b.promptSha as string,
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

// GET /tts/ask-context — what the caller sees BEFORE it asks: how many asks it
// has spent in the last day, its cap, and every objection Tom has already made
// about this todo. Those objections go into the delegate's prompt, and they
// are the point of the whole loop: the delegate never re-takes a decision he
// reverted. Read-only, worker-key gated, and bounded — one index read per kind.
const ttsAskContext = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const nonempty = (value: string | null) => (value !== null && value.trim() !== "" ? value.trim() : undefined);
  const sessionId = nonempty(params.get("sessionId"));
  const job = nonempty(params.get("job"));
  if ((sessionId === undefined) === (job === undefined)) {
    return jsonResponse(400, { error: "exactly one of sessionId or job is required" });
  }
  const context = await ctx.runQuery(internal.ttsAsk.internalAskContext, {
    sessionId,
    job,
    todoId: nonempty(params.get("todoId")),
  });
  return jsonResponse(200, context);
});
http.route({ path: "/tts/ask-context", method: "GET", handler: ttsAskContext });

// ── The mechanical merge gate's three doors (convex/ttsMerge.ts) ────────────
// A merge is allowed when three facts about the merged head are on record:
// the tests are green, an audit approved it, and the evals found no
// regression. These routes are where the first two are written, where all
// three are read, and where a passed merge is recorded.

// POST /tts/tests — the Guardrails `tests` job's own result, at the end of its
// run. Body: { repo, sha, ok, detail?, url? }.
//
// EITHER KEY, for the reason the evals-run read takes either: CI holds the
// narrow evals key and this is a CI fact of the same class, while the box
// holds the worker key and posts its own local runs. The worker key is
// strictly the more privileged of the two, so accepting it widens nothing.
const ttsTests = httpAction(async (ctx, request) => {
  const denied = request.headers.get("X-TTS-Key")
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
  const result = await ctx.runMutation(internal.ttsMerge.internalRecordTests, {
    repo: (b.repo as string).trim(),
    sha: (b.sha as string).trim(),
    ok: b.ok,
    ...(nonempty(b.detail) ? { detail: (b.detail as string).trim() } : {}),
    ...(nonempty(b.url) ? { url: (b.url as string).trim() } : {}),
  });
  //  rather than : the answer's own ok says the POST landed, and
  // the row's ok says whether the tests were green.
  return jsonResponse(200, { ok: true, existing: result.existing, green: result.ok });
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
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/audit", method: "POST", handler: ttsAudit });

// GET /tts/merge-gate?repo=&sha= — the three checks, and which of them are
// missing. This is what the box asks before it lets a merge command run
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
// list and posted to #tts-decisions, keyed by repo+sha so a retry stays one
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
  try {
    const result = await ctx.runMutation(internal.ttsMerge.internalRecordMerge, { repo: b.repo as string, sha: b.sha as string, subject: b.subject as string, todoId: b.todoId as string | undefined });
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

// GET /tts/batch-context — everything the planner works from: all life todos
// (schema-v2 graph fields included), the code-todo mirror, the code briefs,
// and Tom's recent rulings (grouping signal). The v1 batcher that shared this
// payload, and the POST /tts/batches door it wrote back through, are gone with
// the `members`/`plan` pair (the lifeos update, phase 7); the name stays
// because worker/jobs/plan-graphs.mjs asks for it by it.
//
// SCHEMA V2 ADDITIONS, for worker/jobs/plan-graphs.mjs: the `batches` rows
// (the planner maintains the graph inside them, and needs the archived
// statements so it does not recreate a grouping Tom retired), the recent
// plan-repair events (a worker found an edge wrong; the planner fixes the
// structure), and `writingStandard`.
//
// WHY THE WRITING STANDARD RIDES THIS PAYLOAD: the planner is Node ESM on a box
// that never loads TypeScript — it cannot import the text and it cannot read a
// git checkout of WikiTom. Serving it here is what keeps the text the planner
// pastes into its prompt the same text every TypeScript caller reads.
//
// ITS SOURCE is the context assembler (convex/ttsContext.ts assembleContext),
// which since the dynamic-context round sends the STABLE PREFIX plus a
// FETCHABLE index rather than the write and know layers whole — the planner has
// no subject of its own, so nothing expands (rule 12) and every page it did not
// get is one line naming the command that gets it. THE FIELD NAME AND TYPE DO
// NOT CHANGE: worker/jobs/plan-graphs.mjs treats a missing `writingStandard` as
// fatal.
const ttsBatchContext = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  // Seven independent reads — issued in parallel, not awaited one by one.
  let todos, mirror, briefs, recentRulings, batches, planRepairs, writingStandard: string;
  try {
    [todos, mirror, briefs, recentRulings, batches, planRepairs, writingStandard] = await Promise.all([
      ctx.runQuery(internal.tts.internalListTodos, {}),
      ctx.runQuery(internal.tts.internalListMirror, {}),
      ctx.runQuery(internal.ttsCode.internalListBriefs, {}),
      ctx.runQuery(internal.ttsRulings.internalRecentRulings, { limit: 200 }),
      ctx.runQuery(internal.tts.internalListBatches, {}),
      ctx.runQuery(internal.tts.internalRecentPlanRepairs, { limit: 20 }),
      ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "batch-context" }),
    ]);
  } catch (error) {
    return modelOfTomErrorResponse(error);
  }
  return jsonResponse(200, {
    todos,
    mirror,
    briefs,
    recentRulings,
    batches,
    planRepairs,
    writingStandard,
    vocabulary: TTS_CLOSED_VOCABULARY,
    // The repo names a batch may declare. Served for the SAME reason as
    // writingStandard above: the planner is Node ESM on a box that never loads
    // TypeScript, so it cannot import SESSION_REPOS. Serving the one home's
    // value is what stops a fourth hand-written copy of the repo list
    // appearing in worker/ (VQC C1).
    sessionRepos: SESSION_REPO_NAMES,
    // The server's clock, the /tts/state convention: the planner's prepare
    // pass resolves "sept 3" in a statement against nyCalendarDay and never
    // computes a New York date of its own.
    ...nowContext(Date.now()),
  });
});

http.route({
  path: "/tts/batch-context",
  method: "GET",
  handler: ttsBatchContext,
});

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
  if (typeof b.layers !== "object" || b.layers === null) {
    return jsonResponse(400, { error: "layers ({ operate, write, know }) required" });
  }
  const rawLayers = b.layers as Record<string, unknown>;
  if (Object.keys(rawLayers).length !== MODEL_OF_TOM_LAYER_NAMES.length ||
    !Object.keys(rawLayers).every((name) => (MODEL_OF_TOM_LAYER_NAMES as readonly string[]).includes(name))) {
    return jsonResponse(400, { error: "layers must contain exactly operate, write, and know" });
  }
  const layers: Record<(typeof MODEL_OF_TOM_LAYER_NAMES)[number], string> = {
    operate: "", write: "", know: "",
  };
  for (const name of MODEL_OF_TOM_LAYER_NAMES) {
    if (typeof rawLayers[name] !== "string" || rawLayers[name].trim() === "") {
      return jsonResponse(400, { error: `layers.${name} (non-empty string) required` });
    }
    layers[name] = rawLayers[name];
  }
  if (!Array.isArray(b.headers) || b.headers.length !== 7) {
    return jsonResponse(400, { error: "headers (the 7 canonical nonempty selections) required" });
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
        { commit: b.commit, committedAt: b.committedAt, pushed: b.pushed, force: b.force, layers, headers, files },
    );
    return jsonResponse(200, { ok: true, commit: b.commit, ...result });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/model-of-tom", method: "POST", handler: ttsModelOfTom });

// POST /tts/repo-rules — one repo's AGENTS.md bodies, replaced whole.
//
// SAME REASON AS THE DOOR ABOVE: the context assembler pre-expands the repo
// rules for the directories a todo's brief names (convex/ttsContext.ts rule 9)
// and it runs inside Convex, which has no filesystem. The nightly job reads
// each repo's own immutable HEAD and posts the bodies here; a run with no
// checkout at all still learns from the fetchable block that these files exist.
//
// Per repo, not per post: the mutation replaces this repo's rows and no other
// repo's, so a night that could read one checkout and not another leaves the
// second exactly as it was.
const REPO_RULES_FILES_MAX = 24;

const ttsRepoRules = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.repo !== "string" || b.repo.trim() === "") {
    return jsonResponse(400, { error: "repo (a session repo name) required" });
  }
  if (typeof b.commit !== "string" || !/^[0-9a-f]{40}$/.test(b.commit)) {
    return jsonResponse(400, { error: "commit (40 hex characters) required" });
  }
  if (typeof b.syncedAt !== "number" || !Number.isFinite(b.syncedAt)) {
    return jsonResponse(400, { error: "syncedAt (epoch ms) required" });
  }
  if (!Array.isArray(b.files) || b.files.length === 0) {
    return jsonResponse(400, { error: "files (non-empty array) required" });
  }
  if (b.files.length > REPO_RULES_FILES_MAX) {
    return jsonResponse(400, { error: `at most ${REPO_RULES_FILES_MAX} files per post — got ${b.files.length}` });
  }
  const files: { path: string; body: string; bytes: number }[] = [];
  for (let i = 0; i < b.files.length; i++) {
    const f = b.files[i] as Record<string, unknown> | null;
    if (typeof f !== "object" || f === null || !isRepoRulesPath(f.path)) {
      return jsonResponse(400, { error: `files[${i}].path must be an AGENTS.md path inside the repo` });
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
    const result = await ctx.runMutation(internal.ttsContext.internalReplaceRepoRules, {
      repo: b.repo,
      commit: b.commit,
      syncedAt: b.syncedAt,
      files,
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

http.route({ path: "/tts/repo-rules", method: "POST", handler: ttsRepoRules });

// ── The nightly job's three doors (convex/ttsNightly.ts) ─────────────────────

// GET /tts/export?table=<name>&boundary=<epoch ms>&cursor=<opaque>&numItems=<n>
// — one page of one table, rows created before the boundary, in creation
// order. The job walks `continueCursor` until `isDone` for every table in
// `EXPORT_TABLES` (GET /tts/export with no table lists them) and writes one
// JSON-lines file per table into WikiTom tts/snapshot/. Same key as every
// worker read; the auth tables are not on the list at all.
const ttsExport = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const table = params.get("table");
  if (table === null) return jsonResponse(200, { tables: EXPORT_TABLES });
  if (!isExportTable(table)) {
    return jsonResponse(400, { error: `not an exported table: ${table}` });
  }
  const boundary = Number(params.get("boundary"));
  if (!Number.isFinite(boundary) || boundary <= 0) {
    return jsonResponse(400, { error: "boundary (epoch ms) required" });
  }
  const numItems = params.has("numItems")
    ? Number(params.get("numItems"))
    : EXPORT_PAGE_DEFAULT;
  if (!Number.isFinite(numItems) || numItems < 1) {
    return jsonResponse(400, { error: "numItems must be a positive number" });
  }
  try {
    const page = await ctx.runQuery(internal.ttsNightly.internalExportPage, {
      table,
      boundary,
      cursor: params.get("cursor"),
      numItems,
    });
    return jsonResponse(200, page);
  } catch (e) {
    // A cursor this route did not write (an old run's, a hand-typed one).
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

http.route({ path: "/tts/export", method: "GET", handler: ttsExport });

// GET /tts/learning-input?until=<epoch ms>[&since=<epoch ms>] — what the
// learning step reads: the turns Tom typed with the agent's replies around
// them, his Slack replies, his rulings, in the window; and the objections
// not yet acted on with the changes they can name. `since` omitted means
// "where the last learning run stopped" (convex/ttsNightly.ts).
const ttsLearningInput = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const sinceRaw = params.get("since");
  const untilRaw = params.get("until");
  const since = sinceRaw === null ? undefined : Number(sinceRaw);
  const until = untilRaw === null ? NaN : Number(untilRaw);
  if (
    !Number.isFinite(until) ||
    (since !== undefined && (!Number.isFinite(since) || since >= until))
  ) {
    return jsonResponse(400, { error: "until (epoch ms) required; since, if given, before it" });
  }
  const input = await ctx.runQuery(internal.ttsNightly.internalLearningInput, {
    since,
    until,
  });
  return jsonResponse(200, input);
});

http.route({ path: "/tts/learning-input", method: "GET", handler: ttsLearningInput });

// GET /tts/weekly-input?until=<epoch ms> — the Friday job's one deterministic
// gather (convex/ttsWeekly.ts): every fact of the seven days ending at
// `until` (default: now), read on indexes, no model in the loop. The job adds
// last week's agenda from the WikiTom checkout and makes the one model call.
const ttsWeeklyInput = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const until = params.has("until") ? Number(params.get("until")) : Date.now();
  if (!Number.isFinite(until) || until <= 0) {
    return jsonResponse(400, { error: "until must be an epoch ms instant" });
  }
  let facts;
  let writingStandard: string;
  try {
    [facts, writingStandard] = await Promise.all([
      ctx.runQuery(internal.ttsWeekly.internalWeeklyInput, { until }),
      ctx.runQuery(internal.ttsContext.internalContextPrelude, { caller: "weekly-input" }),
    ]);
  } catch (error) {
    return modelOfTomErrorResponse(error);
  }
  return jsonResponse(200, { ...facts, writingStandard });
});

http.route({ path: "/tts/weekly-input", method: "GET", handler: ttsWeeklyInput });

// GET /tts/prelude-delivery?since=<epoch ms>&until=<epoch ms> — the nightly
// delivery check reads sessions against the commit that was published when
// they began. It is worker-only: it exposes session titles and commit stamps.
const ttsPreludeDelivery = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const until = params.has("until") ? Number(params.get("until")) : Date.now();
  const sinceArg = params.has("since") ? Number(params.get("since")) : undefined;
  if (!Number.isFinite(until) || until <= 0 || (sinceArg !== undefined && (!Number.isFinite(sinceArg) || sinceArg <= 0 || sinceArg >= until))) {
    return jsonResponse(400, { error: "until must be an epoch ms instant; since, if given, before it" });
  }
  const since = sinceArg ?? (await ctx.runQuery(internal.ttsEvals.internalLatestPreludeDeliveryAt, {}) ?? until - DAY_MS);
  return jsonResponse(200, await ctx.runQuery(internal.ttsEvals.internalPreludeDelivery, { since, until }));
});

http.route({ path: "/tts/prelude-delivery", method: "GET", handler: ttsPreludeDelivery });

// GET /tts/golden-input?limitPerPartition=20 — deterministic, indexed input
// for the exporter. Snapshot lookup stays on the machine with the WikiTom git
// checkout; Convex returns only the ruled subjects and their resolution facts.
const ttsGoldenInput = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const raw = new URL(request.url).searchParams.get("limitPerPartition");
  const limitPerPartition = raw === null ? undefined : Number(raw);
  if (limitPerPartition !== undefined && (!Number.isFinite(limitPerPartition) || limitPerPartition <= 0)) {
    return jsonResponse(400, { error: "limitPerPartition must be a positive number" });
  }
  return jsonResponse(200, await ctx.runQuery(internal.ttsEvals.internalGoldenInput, { limitPerPartition }));
});

http.route({ path: "/tts/golden-input", method: "GET", handler: ttsGoldenInput });

// CI has a distinct, narrow key: it can request and read evals, never use the
// broader worker key that can write every TTS event.
const evalsRequest = httpAction(async (ctx, request) => {
  const denied = keyAuth(request, "EVALS_KEY", "X-Evals-Key");
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.repo !== "string" || b.repo === "" || typeof b.sha !== "string" || b.sha === "") {
    return jsonResponse(400, { error: "repo and sha (non-empty strings) required" });
  }
  if (b.baseSha !== undefined && (typeof b.baseSha !== "string" || b.baseSha === "")) {
    return jsonResponse(400, { error: "baseSha, when given, is a non-empty string" });
  }
  if (b.pr !== undefined && (!Number.isInteger(b.pr) || (b.pr as number) <= 0)) {
    return jsonResponse(400, { error: "pr, when given, is a positive integer" });
  }
  if (!Array.isArray(b.paths) || !b.paths.every((path) => typeof path === "string" && path !== "")) {
    return jsonResponse(400, { error: "paths (array of non-empty strings) required" });
  }
  const result = await ctx.runMutation(internal.ttsEvals.internalRequestEvals, {
    repo: b.repo,
    sha: b.sha,
    baseSha: typeof b.baseSha === "string" ? b.baseSha : undefined,
    pr: typeof b.pr === "number" ? b.pr : undefined,
    paths: b.paths,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/evals-request", method: "POST", handler: evalsRequest });

// Readable with EITHER key. CI holds the narrow evals key; the box holds the
// worker key and must read this route too — it looks a run up before spending
// eighty model calls repeating it, and reads the base run before comparing.
// The worker key is strictly the more privileged of the two, so accepting it
// here widens nothing.
const evalsRun = httpAction(async (ctx, request) => {
  const denied = request.headers.get("X-TTS-Key")
    ? ttsAuth(request)
    : keyAuth(request, "EVALS_KEY", "X-Evals-Key");
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const repo = params.get("repo") ?? "";
  const sha = params.get("sha") ?? "";
  const baseSha = params.get("base") ?? undefined;
  if (repo === "" || sha === "") return jsonResponse(400, { error: "repo and sha required" });
  return jsonResponse(200, await ctx.runQuery(internal.ttsEvals.internalEvalsRun, { repo, sha, baseSha }));
});

http.route({ path: "/tts/evals-run", method: "GET", handler: evalsRun });

// The box polls exactly one unanswered request per pass. This stays on the
// worker key; an Action may request work but cannot observe another PR's queue.
const ttsEvalsRequest = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  return jsonResponse(200, { request: await ctx.runQuery(internal.ttsEvals.internalOldestEvalsRequest, {}) });
});

http.route({ path: "/tts/evals-request", method: "GET", handler: ttsEvalsRequest });

// Mission 3's read-only search family. `--failing` is projected from the run
// row's failures array, never by a second event read.
const ttsSearchEvals = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const since = params.has("since") ? Number(params.get("since")) : undefined;
  const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
  if ((since !== undefined && (!Number.isFinite(since) || since <= 0)) ||
    (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 200))) {
    return jsonResponse(400, { error: "since must be an epoch ms instant; limit must be 1 to 200" });
  }
  return jsonResponse(200, await ctx.runQuery(internal.ttsEvals.internalSearchEvals, {
    repo: params.get("repo") ?? undefined,
    sha: params.get("sha") ?? undefined,
    since,
    failing: params.get("failing") === "true",
    limit,
  }));
});

http.route({ path: "/tts/search/evals", method: "GET", handler: ttsSearchEvals });

// GET /tts/weekly-run?day=YYYY-MM-DD — whether the Friday job already ran for
// that day: its "weekly-run" row, keyed on the day (convex/ttsWeekly.ts). The
// job asks before it writes anything, and a rerun stops here unless it was
// told --overwrite.
const ttsWeeklyRun = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const day = new URL(request.url).searchParams.get("day") ?? "";
  if (day === "") return jsonResponse(400, { error: "day (YYYY-MM-DD) required" });
  try {
    const run = await ctx.runQuery(internal.ttsWeekly.internalWeeklyRun, { day });
    return jsonResponse(200, { run });
  } catch (e) {
    return jsonResponse(400, { error: e instanceof Error ? e.message : String(e) });
  }
});

http.route({ path: "/tts/weekly-run", method: "GET", handler: ttsWeeklyRun });

// POST /tts/area-reviewed — the weekly session's record that Tom confirmed an
// area page. Body: { path, reviewedOn }. One "area-reviewed" dtsEvents row
// (convex/ttsWeekly.ts); the page's `reviewed:` line itself is edited in the
// checkout by the session's pen (worker/jobs/weekly.mjs reviewed), which
// calls this after the commit.
const ttsAreaReviewed = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.path !== "string" || b.path === "") {
    return jsonResponse(400, { error: "path (non-empty string) required" });
  }
  if (typeof b.reviewedOn !== "string" || b.reviewedOn === "") {
    return jsonResponse(400, { error: "reviewedOn (YYYY-MM-DD) required" });
  }
  try {
    const id = await ctx.runMutation(internal.ttsWeekly.internalRecordAreaReviewed, {
      path: b.path,
      reviewedOn: b.reviewedOn,
    });
    return jsonResponse(200, { ok: true, id });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/area-reviewed", method: "POST", handler: ttsAreaReviewed });

// POST /tts/learning-objections-consumed — body { ids: [<dtsEvents id>] }.
// The job stamps each objection it acted on (reverted, or could not revert
// and said so), so the next night's read does not return it again.
const ttsLearningObjectionsConsumed = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
    return jsonResponse(400, { error: "ids (array of strings) required" });
  }
  const result = await ctx.runMutation(internal.ttsNightly.internalConsumeLearningObjections, {
    ids,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({
  path: "/tts/learning-objections-consumed",
  method: "POST",
  handler: ttsLearningObjectionsConsumed,
});

// GET /tts/repo-proposals?repo=<repo> — the open repository-rule proposals
// the nightly repo-learning step made for one repository, newest first. A
// session working in that repository reads them before it edits the nested
// AGENTS.md files, applies the ones it agrees with on a branch, and posts
// back below. Read-only, worker key.
const ttsRepoProposals = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const repo = params.get("repo");
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limitRaw !== null && !Number.isFinite(limit)) {
    return jsonResponse(400, { error: "limit, if given, must be a number" });
  }
  const result = await ctx.runQuery(internal.ttsNightly.internalOpenRepoProposals, {
    repo: repo === null || repo === "" ? undefined : repo,
    limit,
  });
  return jsonResponse(200, result);
});

http.route({ path: "/tts/repo-proposals", method: "GET", handler: ttsRepoProposals });

// POST /tts/repo-proposal-applied — body { id, commit, line? }. The session
// that landed a proposal in its repository says so: the row's status becomes
// "applied" and the commit and the FINAL wording are stamped on it. The next
// night's repo-learning step reads that and moves the evidence entry from its
// "— proposed" heading to the live one, rewriting the line to what merged.
const ttsRepoProposalApplied = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const { id, commit, line } = (body ?? {}) as { id?: unknown; commit?: unknown; line?: unknown };
  if (typeof id !== "string" || id.trim() === "" || typeof commit !== "string" || commit.trim() === "") {
    return jsonResponse(400, { error: "id and commit (strings) required" });
  }
  if (line !== undefined && typeof line !== "string") {
    return jsonResponse(400, { error: "line, if given, must be a string" });
  }
  const result = await ctx.runMutation(internal.ttsNightly.internalApplyRepoProposal, {
    id: id.trim(),
    commit: commit.trim(),
    line,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/repo-proposal-applied", method: "POST", handler: ttsRepoProposalApplied });

// POST /tts/repo-proposal-dropped — body { id, reply? }. Tom replied on the
// proposal's digest line. The nightly job posts this where it would revert a
// model-of-Tom line: the row's status becomes "dropped", and the next night's
// repo-learning step writes `dropped:` on the evidence entry, which is what
// stops the same rule being proposed again.
const ttsRepoProposalDropped = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const { id, reply } = (body ?? {}) as { id?: unknown; reply?: unknown };
  if (typeof id !== "string" || id.trim() === "") {
    return jsonResponse(400, { error: "id (string) required" });
  }
  if (reply !== undefined && typeof reply !== "string") {
    return jsonResponse(400, { error: "reply, if given, must be a string" });
  }
  const result = await ctx.runMutation(internal.ttsNightly.internalDropRepoProposal, {
    id: id.trim(),
    reply,
  });
  return jsonResponse(200, { ok: true, ...result });
});

http.route({ path: "/tts/repo-proposal-dropped", method: "POST", handler: ttsRepoProposalDropped });

// POST /tts/event — one dtsEvents row from the worker. Body: { kind, data? }.
// The job records a failed step ("nightly-failure"), its learning run
// ("learning-run") and its summary ("nightly-run") this way, which is what
// the digest reads for "job failures" and "what the nightly job wrote". The
// mutation refuses a kind Convex writes itself.
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
  if (b.key !== undefined && (typeof b.key !== "string" || b.key === "")) {
    return jsonResponse(400, { error: "key, when given, is a non-empty string" });
  }
  try {
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

// ── POST /tts/plan-graph — the planner's pen (schema v2) ─────────────────────
// ONE batch's graph per call, and the ONE batch door since the v1 pen and its
// route (POST /tts/batches) went with `members` and `plan`. Body:
// { batchId?, statement, groundUpExplanation?, needs?, repos?, tasks: [...],
// goalIds?, archive? }. Drop-don't-reject: the body is model-written JSON, so
// it is PROJECTED to the known shape and the mutation's per-item skip report
// is the real validator.
//
// ONE DIFFERENCE, and it is the whole reason this sanitizer is not a copy of
// the batch one: a task's `needs` may address an EARLIER TASK BY ITS POSITION
// IN THIS PAYLOAD. Positions are therefore load-bearing — removing a malformed
// task from the array would renumber every task after it and silently
// re-point every index reference at the wrong task. So a malformed task keeps
// its slot and is emptied instead: the mutation skips an empty statement by
// name, and anything that needed it comes back as "needs task N, which was
// skipped" rather than landing with an invented edge. What was dropped and why
// is reported back in `droppedTasks`.
const GRAPH_ACTORS = ["tom", "agent"] as const;
const GRAPH_STATUSES = ["active", "done"] as const;

type DroppedTask = { index: number; statement: string; why: string };

function sanitizeGraphTask(
  item: unknown,
  index: number,
  dropped: DroppedTask[],
): Record<string, unknown> {
  const statementOf = (x: unknown) =>
    typeof x === "object" && x !== null &&
    typeof (x as Record<string, unknown>).statement === "string"
      ? ((x as Record<string, unknown>).statement as string)
      : "";
  const drop = (why: string): Record<string, unknown> => {
    dropped.push({ index, statement: statementOf(item), why });
    return { statement: "", actor: "agent" };
  };
  if (typeof item !== "object" || item === null) return drop("not an object");
  const r = item as Record<string, unknown>;
  if (typeof r.statement !== "string" || r.statement.trim() === "") {
    return drop("a task needs a statement");
  }
  if (!GRAPH_ACTORS.includes(r.actor as (typeof GRAPH_ACTORS)[number])) {
    // Never defaulted: the actor is who does the work, and guessing "agent"
    // for a step that was Tom's would hand his own decision to a worker.
    return drop('actor must be "tom" or "agent"');
  }
  const out: Record<string, unknown> = {
    statement: r.statement,
    actor: r.actor,
  };
  if (typeof r.id === "string") out.id = r.id;
  if (r.needs !== undefined) {
    if (!Array.isArray(r.needs)) return drop("needs must be an array");
    const needs: (string | number)[] = [];
    for (const need of r.needs) {
      // A string is an existing todo id; a whole number is the position of an
      // earlier task in this payload. Anything else would have to be dropped
      // from the array, which deletes an edge the planner asked for — so the
      // task goes instead, and the planner sees it in the report.
      if (typeof need === "string") needs.push(need);
      else if (typeof need === "number" && Number.isInteger(need)) {
        needs.push(need);
      } else return drop("a need is a todo id or an earlier task's index");
    }
    out.needs = needs;
  }
  if (typeof r.condition === "string") out.condition = r.condition;
  if (typeof r.groundUpExplanation === "string") {
    out.groundUpExplanation = r.groundUpExplanation;
  }
  if (typeof r.evidence === "string") out.evidence = r.evidence;
  if (GRAPH_STATUSES.includes(r.status as (typeof GRAPH_STATUSES)[number])) {
    out.status = r.status;
  }
  // The model. Absent is the norm (the scheduler falls back to the fleet
  // default); a name from SESSION_MODELS is the planner's tag for a task that
  // needs a particular one. Any other value is simply NOT CARRIED — an
  // unrecognized name would reach the mutation's closed union and cost the
  // whole call, so one hallucinated word would lose a batch's entire graph
  // instead of one default.
  if (isSessionModel(r.model)) out.model = r.model;
  return out;
}

const ttsPlanGraph = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  // The statement IS the batch's identity when no id is echoed (the mutation
  // matches an active batch by it), so an absent one is not something to drop
  // around — there would be no batch to speak of and nothing to name in a
  // report.
  if (typeof b.statement !== "string" || b.statement.trim() === "") {
    return jsonResponse(400, { error: "statement (non-empty string) required" });
  }
  if (!Array.isArray(b.tasks)) {
    return jsonResponse(400, { error: "tasks (array) required" });
  }
  // `path` was a batch's sequencing (name, index, must/helps edge) and it is
  // retired — its edges are `needs` now. Until worker/setup.sh had rolled out
  // it was IGNORED here, because one retired field would otherwise have cost a
  // whole plan; the box has since caught up (main 6825608), so a payload still
  // carrying it comes from code nobody is running and is refused by name. A
  // stale planner is then visible in the job's error rather than silently
  // losing the sequencing it thought it wrote.
  if (b.path !== undefined) {
    return jsonResponse(400, {
      error: "path is retired — sequence a batch with needs (batch ids)",
    });
  }
  const droppedTasks: DroppedTask[] = [];
  const tasks = b.tasks.map((task, i) => sanitizeGraphTask(task, i, droppedTasks));
  try {
    const result = await ctx.runMutation(internal.tts.internalStorePlanGraph, {
      batchId: typeof b.batchId === "string" ? b.batchId : undefined,
      statement: b.statement,
      groundUpExplanation:
        typeof b.groundUpExplanation === "string"
          ? b.groundUpExplanation
          : undefined,
      // The batches this one needs done first. Absent preserves; the
      // mutation drops a name that is not a batch with a named skip.
      needs: Array.isArray(b.needs)
        ? b.needs.filter((x): x is string => typeof x === "string")
        : undefined,
      // The batch's declared repos (Tom 2026-08-30). Absent PRESERVES the
      // stored value, the same rule every other field on this pen follows —
      // so a planner run that says nothing about repos never erases a
      // declaration. A non-array is treated as absent rather than rejected:
      // one malformed field must not cost the whole graph.
      repos: Array.isArray(b.repos)
        ? b.repos.filter((x): x is string => typeof x === "string")
        : undefined,
      tasks: tasks as never,
      goalIds: Array.isArray(b.goalIds)
        ? b.goalIds.filter((x): x is string => typeof x === "string")
        : undefined,
      archive: b.archive === true ? true : undefined,
    });
    return jsonResponse(200, {
      ...result,
      droppedTasks: droppedTasks.length > 0 ? droppedTasks : undefined,
    });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/plan-graph", method: "POST", handler: ttsPlanGraph });

// POST /tts/plan-repairs-consumed — the planner reports which plan-repair
// reports it has now acted on. Body: { ids: [eventId, ...] }. A repair is an
// INSTRUCTION to fix the graph, not a record to keep re-reading: unconsumed it
// is re-injected into the prompt every two hours for a week, telling the
// planner to fix an edge it already dropped. Same drop-don't-reject posture as
// the pens above — an unknown or already-consumed id is simply not counted.
const ttsPlanRepairsConsumed = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.ids)) {
    return jsonResponse(400, { error: "ids (array) required" });
  }
  const result = await ctx.runMutation(
    internal.tts.internalMarkPlanRepairsConsumed,
    { ids: b.ids.filter((x): x is string => typeof x === "string") },
  );
  return jsonResponse(200, result);
});

http.route({
  path: "/tts/plan-repairs-consumed",
  method: "POST",
  handler: ttsPlanRepairsConsumed,
});

// POST /tts/session — the Friday weekly job's door (worker/jobs/weekly.mjs)
// to open ITS session on the sessions page. Body: { title, kind: "weekly",
// day, agendaSubjects, repos?, model?, initialPrompt } →
// claudeSessions.internalCreateWeeklySession, the same one row-builder
// (insertSession) behind every session, so the opener begins with the
// model-of-tom prelude and the outcome footer like every other.
//
// KIND "weekly" ONLY, ONE PER DAY. Every holder of TTS_WORKER_KEY — every
// session on the box — reaches this route, so it opens nothing but the
// weekly session and refuses a second one for the same `day`. `agendaSubjects`
// is the list of todo and batch ids the agenda's forks name; the session's
// turns rule on those and nothing else (ttsRulings). The system's own kinds
// (gate, focus-item, block) name a subject and are opened by the code that
// holds it; an adhoc session is Tom's to open from the page.
const ttsSession = httpAction(async (ctx, request) => {
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
  if (b.kind !== "weekly") {
    return jsonResponse(400, { error: 'kind must be "weekly" — this door opens the weekly session only' });
  }
  if (typeof b.day !== "string" || b.day === "") {
    return jsonResponse(400, { error: "day (YYYY-MM-DD) required" });
  }
  if (
    !Array.isArray(b.agendaSubjects) ||
    !b.agendaSubjects.every((s) => typeof s === "string")
  ) {
    return jsonResponse(400, { error: "agendaSubjects (array of todo and batch ids) required" });
  }
  if (typeof b.initialPrompt !== "string" || b.initialPrompt.trim() === "") {
    return jsonResponse(400, { error: "initialPrompt (non-empty string) required" });
  }
  if (
    b.repos !== undefined &&
    (!Array.isArray(b.repos) ||
      !b.repos.every((r) => (SESSION_REPO_NAMES as readonly string[]).includes(r as string)))
  ) {
    return jsonResponse(400, {
      error: `repos must be an array of ${SESSION_REPO_NAMES.join(", ")}`,
    });
  }
  if (b.model !== undefined && !isSessionModel(b.model)) {
    return jsonResponse(400, { error: "model is not a session model" });
  }
  try {
    const sessionId = await ctx.runMutation(internal.claudeSessions.internalCreateWeeklySession, {
      title: b.title,
      repos: b.repos as string[] | undefined,
      model: b.model,
      initialPrompt: b.initialPrompt,
      day: b.day,
      agendaSubjects: b.agendaSubjects as string[],
    });
    return jsonResponse(200, { ok: true, sessionId });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/session", method: "POST", handler: ttsSession });

// POST /tts/session-outcome — an autonomous session's outcome pen. Body:
// { sessionId, outcome: "completed"|"errored", summary?, planRepair? }. It lives under the
// TTS key ON PURPOSE: an autonomous session's environment carries ONLY
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
  // The wrong-edge channel (schema v2): a worker that reached its task and
  // found the graph wrong — a `needs` edge that is not a real prerequisite, or
  // a prerequisite the graph never named — writes what it found here, and the
  // mutation records it as a "plan-repair" event the planner reads. It rides
  // the outcome pen because the finding and the ending are the same moment: a
  // separate route would be a second command to teach for one sentence.
  if (b.planRepair !== undefined && typeof b.planRepair !== "string") {
    return jsonResponse(400, { error: "planRepair must be a string" });
  }
  try {
    await ctx.runMutation(internal.claudeSessions.internalRecordOutcome, {
      id: b.sessionId,
      outcome: b.outcome,
      summary: typeof b.summary === "string" ? b.summary : "",
      planRepair: typeof b.planRepair === "string" ? b.planRepair : undefined,
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
  });
  return jsonResponse(200, result);
});

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
  const b = (body ?? {}) as Record<string, unknown>;
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

// POST /sessions/overflow — one ≤256KB chunk of a message's COMPLETE payload
// (the transcript principle: the 32KB cut is what the page renders, not what
// is stored). Its own route rather than a field on the ingest body: the flush
// cadence is ~400ms and a failed flush re-sends its whole payload, so a
// multi-megabyte tool result riding along would wreck both. Same
// SESSIONS_WORKER_KEY door as poll/ingest.
//
// Every field is checked HERE, by type, and every error this route returns
// is a fixed string. The body carries payload text, and a validator error
// from the mutation would spell its arguments — text included — into a
// message the daemon would then store in an error row and print to journald.
// So the mutation is only ever reached with well-typed arguments, and
// whatever it throws is reported as one constant.
const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const sessionsOverflow = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
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
  for (const field of ["seq", "index", "chunkCount"] as const) {
    if (!nonNegativeInteger(b[field])) {
      return jsonResponse(400, {
        error: `${field} (non-negative integer) required`,
      });
    }
  }
  if (typeof b.text !== "string") {
    return jsonResponse(400, { error: "text (string) required" });
  }
  try {
    const result = await ctx.runMutation(
      internal.claudeSessions.internalIngestOverflow,
      {
        sessionId: b.sessionId as Id<"claudeSessions">,
        seq: b.seq as number,
        index: b.index as number,
        chunkCount: b.chunkCount as number,
        text: b.text,
      },
    );
    // A refusal is permanent by the daemon's rule (4xx other than 408/429):
    // re-sending the same chunk cannot change the verdict.
    if (!result.ok) return jsonResponse(409, { error: result.reason });
    return jsonResponse(200, result);
  } catch {
    return jsonResponse(400, { error: "overflow chunk rejected" });
  }
});

http.route({
  path: "/sessions/overflow",
  method: "POST",
  handler: sessionsOverflow,
});

// POST /sessions/overflow/stamp — the second step of a re-ingest
// (worker/session-host/reingest-overflow.mjs): the row landed without its
// stamp when the live upload failed, the chunks are up now, and this names
// them from the row. Same door, same posture: typed fields, fixed errors.
const sessionsOverflowStamp = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
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
  for (const field of ["seq", "byteLength", "chunkCount"] as const) {
    if (!nonNegativeInteger(b[field])) {
      return jsonResponse(400, {
        error: `${field} (non-negative integer) required`,
      });
    }
  }
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) {
    return jsonResponse(400, { error: "sha256 (64 hex chars) required" });
  }
  try {
    const result = await ctx.runMutation(
      internal.claudeSessions.internalStampOverflow,
      {
        sessionId: b.sessionId as Id<"claudeSessions">,
        seq: b.seq as number,
        sha256: b.sha256,
        byteLength: b.byteLength as number,
        chunkCount: b.chunkCount as number,
      },
    );
    if (!result.ok) return jsonResponse(409, { error: result.reason });
    return jsonResponse(200, result);
  } catch {
    return jsonResponse(400, { error: "overflow stamp rejected" });
  }
});

http.route({
  path: "/sessions/overflow/stamp",
  method: "POST",
  handler: sessionsOverflowStamp,
});

// Run-file ingestion deliberately shares the daemon worker credential while
// migration still has one box-side installation surface. New routes use the
// run vocabulary; only this legacy auth helper retains the old name.
const runsIngest = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const parsed = await boundedJson(request, RUNS_INGEST_MAX_BODY_BYTES);
  if ("tooLarge" in parsed) return jsonResponse(413, { error: "request body too large" });
  if ("invalid" in parsed) return jsonResponse(400, { error: "invalid JSON body" });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  if (typeof b.run !== "object" || b.run === null || !Array.isArray(b.rows) || !Array.isArray(b.children)) {
    return jsonResponse(400, { error: "run, rows, and children required" });
  }
  if (!validRunId((b.run as Record<string, unknown>).runId)) return jsonResponse(400, { error: "runId invalid" });
  try {
    const result = await ctx.runMutation(internal.runs.internalIngest, b as never);
    return jsonResponse(200, result);
  } catch {
    return jsonResponse(400, { error: "run ingest rejected" });
  }
});
http.route({ path: "/runs/ingest", method: "POST", handler: runsIngest });

// Payload text never reaches a validator error: every field is narrowed here
// and failures use fixed words so the caller cannot reflect a transcript.
const runsOverflow = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const parsed = await boundedJson(request, RUNS_OVERFLOW_MAX_BODY_BYTES);
  if ("tooLarge" in parsed) return jsonResponse(413, { error: "request body too large" });
  if ("invalid" in parsed) return jsonResponse(400, { error: "invalid JSON body" });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  if (!validRunId(b.runId)) return jsonResponse(400, { error: "runId invalid" });
  for (const field of ["seq", "index", "chunkCount"] as const) if (!nonNegativeInteger(b[field])) return jsonResponse(400, { error: `${field} (non-negative integer) required` });
  if (typeof b.text !== "string") return jsonResponse(400, { error: "text (string) required" });
  try {
    const result = await ctx.runMutation(internal.runs.internalIngestOverflow, { runId: b.runId, seq: b.seq as number, index: b.index as number, chunkCount: b.chunkCount as number, text: b.text });
    return result.ok ? jsonResponse(200, result) : jsonResponse(409, { error: result.reason });
  } catch { return jsonResponse(400, { error: "overflow chunk rejected" }); }
});
http.route({ path: "/runs/overflow", method: "POST", handler: runsOverflow });

const runsOverflowStamp = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const parsed = await boundedJson(request, RUNS_OVERFLOW_MAX_BODY_BYTES);
  if ("tooLarge" in parsed) return jsonResponse(413, { error: "request body too large" });
  if ("invalid" in parsed) return jsonResponse(400, { error: "invalid JSON body" });
  const b = (parsed.body ?? {}) as Record<string, unknown>;
  if (!validRunId(b.runId)) return jsonResponse(400, { error: "runId invalid" });
  for (const field of ["seq", "byteLength", "chunkCount"] as const) if (!nonNegativeInteger(b[field])) return jsonResponse(400, { error: `${field} (non-negative integer) required` });
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return jsonResponse(400, { error: "sha256 (64 hex chars) required" });
  try {
    const result = await ctx.runMutation(internal.runs.internalStampOverflow, { runId: b.runId, seq: b.seq as number, sha256: b.sha256, byteLength: b.byteLength as number, chunkCount: b.chunkCount as number });
    return result.ok ? jsonResponse(200, result) : jsonResponse(409, { error: result.reason });
  } catch { return jsonResponse(400, { error: "overflow stamp rejected" }); }
});
http.route({ path: "/runs/overflow/stamp", method: "POST", handler: runsOverflowStamp });

// The comparison reads both row sets inside Convex and returns counts and
// digests only. Transcript text never crosses this route.
const runsCompare = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try { body = await request.json(); } catch { return jsonResponse(400, { error: "invalid JSON body" }); }
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.sessionId !== undefined && (typeof b.sessionId !== "string" || b.sessionId === "")) return jsonResponse(400, { error: "sessionId must be a non-empty string" });
  try {
    const compareAllPages = async (sessionId: Id<"claudeSessions">) => {
      let state: Record<string, unknown> | undefined;
      for (;;) {
        const result = await ctx.runMutation(internal.runs.internalShadowCompare, {
          sessionId,
          ...(state === undefined ? {} : { state }),
        } as never);
        if (result.complete) return result;
        state = result.state;
      }
    };
    if (typeof b.sessionId === "string") {
      const result = await compareAllPages(b.sessionId as Id<"claudeSessions">);
      return jsonResponse(200, result);
    }
    const comparisons = [];
    for (const status of ["ended", "failed"] as const) {
      let cursor: string | null = null;
      for (;;) {
        const page: {
          eligible: Array<{ sessionId: Id<"claudeSessions">; runId: string }>;
          isDone: boolean;
          continueCursor: string | null;
        } = await ctx.runQuery(internal.runs.internalEligibleComparisons, {
          status,
          paginationOpts: { cursor, numItems: 100 },
        });
        for (const session of page.eligible) comparisons.push(await compareAllPages(session.sessionId));
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
    }
    return jsonResponse(200, { comparisons });
  } catch {
    return jsonResponse(400, { error: "run comparison rejected" });
  }
});
http.route({ path: "/runs/compare", method: "POST", handler: runsCompare });

// The WikiTom writer receives already-shaped manifest entries and an opaque
// cursor. The full `(at, runId, fileVersion)` checkpoint makes equal-ms
// versions retry-safe without dropping later lines at the same timestamp.
const runsManifest = httpAction(async (ctx, request) => {
  const denied = sessionsAuth(request);
  if (denied) return denied;
  const url = new URL(request.url);
  const sinceText = url.searchParams.get("since");
  if (sinceText === null || sinceText === "") return jsonResponse(400, { error: "since required" });
  const since = Number(sinceText);
  if (!Number.isFinite(since) || since < 0) return jsonResponse(400, { error: "since (non-negative number) required" });
  const afterRunId = url.searchParams.get("afterRunId") ?? undefined;
  const afterFileVersion = url.searchParams.get("afterFileVersion") ?? undefined;
  if ((afterRunId === undefined) !== (afterFileVersion === undefined)) return jsonResponse(400, { error: "manifest checkpoint requires runId and fileVersion together" });
  try {
    const result = await ctx.runQuery(internal.runs.internalManifest, {
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
http.route({ path: "/runs/manifest", method: "GET", handler: runsManifest });

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

export default http;
