import { httpRouter } from "convex/server";
import type { FunctionArgs } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { nowContext } from "./tts";
import {
  DAY_MS,
  SESSION_REPO_NAMES,
  WRITING_SKILL,
  WRITING_STANDARD,
  nyCalendarDayBoundsUtc,
  ttsPrepDay,
} from "./ttsShared";

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
// delete (those are Tom-gated mutations).

function ttsAuth(request: Request): Response | null {
  return keyAuth(request, "TTS_WORKER_KEY", "X-TTS-Key");
}

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

// POST /tts/slack-replied — the worker reports that it posted its ONE threaded
// reply to the #dump message a todo came from. Body: { id, replyTs? }. Separate
// from /tts/prepare-todo because the reply happens AFTER preparation lands: the
// reply names the brief, so it cannot be written before there is one.
const ttsSlackReplied = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || b.id === "") {
    return jsonResponse(400, { error: "id (non-empty string) required" });
  }
  try {
    const result = await ctx.runMutation(internal.tts.internalMarkSlackReplied, {
      id: b.id,
      replyTs: typeof b.replyTs === "string" ? b.replyTs : undefined,
    });
    return jsonResponse(200, { ok: true, ...result });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({
  path: "/tts/slack-replied",
  method: "POST",
  handler: ttsSlackReplied,
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
  if (
    event.type !== "message" ||
    event.bot_id !== undefined ||
    event.subtype !== undefined ||
    // A threaded reply is not a capture — Tom's replies to our own reply would
    // otherwise become todos.
    event.thread_ts !== undefined ||
    text.trim() === "" ||
    ts === "" ||
    (dumpChannel !== undefined && event.channel !== dumpChannel)
  ) {
    // Acknowledged and ignored: anything but a 200 makes Slack retry an event
    // we have already decided we do not want.
    return jsonResponse(200, { ok: true, ignored: true });
  }

  // The capture itself — one idempotent insert keyed on the message ts, so
  // Slack's at-least-once retries and poll-dump's backstop pass converge on
  // one todo. No permalink call here: fetching one is a second network round
  // trip inside the 3-second budget, and poll-dump's provenance is not worth
  // the risk of a retry storm. The ts IS the address until then.
  const id = await ctx.runMutation(internal.tts.internalCapture, {
    statement: text,
    source: "slack-capture",
    provenance: `slack:#dump ts=${ts}`,
    slackChannel: typeof event.channel === "string" ? event.channel : undefined,
    slackTs: ts,
  });
  return jsonResponse(200, { ok: true, id });
});

http.route({ path: "/slack/events", method: "POST", handler: slackEvents });

// POST /tts/prep — the worker's Claude-prepared daily queue + digest text.
// Body: { day, todoIds: string[], reasons?: string[], digestText? }.
const ttsPrep = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.day)) {
    return jsonResponse(400, { error: "day (YYYY-MM-DD) required" });
  }
  if (
    !Array.isArray(b.todoIds) ||
    b.todoIds.some((x) => typeof x !== "string")
  ) {
    return jsonResponse(400, { error: "todoIds (string[]) required" });
  }
  try {
    await ctx.runMutation(internal.tts.internalStoreWorkerPrep, {
      day: b.day,
      todoIds: b.todoIds as string[],
      reasons: Array.isArray(b.reasons)
        ? (b.reasons as unknown[]).map(String)
        : undefined,
      digestText: typeof b.digestText === "string" ? b.digestText : undefined,
    });
    return jsonResponse(200, { ok: true });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/prep", method: "POST", handler: ttsPrep });

// POST /tts/prepare-todo — the worker's preparer job attaches brief /
// entry action / work description to a life todo and advances its readiness,
// plus the date the statement itself states, if any.
// Body: { id, brief?, entryAction?, workDescription?, readiness?, dueAt?,
// dateKind?, plan? }.
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
  if (
    b.readiness !== undefined &&
    b.readiness !== "preparing" &&
    b.readiness !== "ready-for-tom"
  ) {
    return jsonResponse(400, {
      error: 'readiness must be "preparing" or "ready-for-tom"',
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
      readiness: b.readiness as "preparing" | "ready-for-tom" | undefined,
      // The date the STATEMENT states, when it states one. The mutation is
      // the real gate: a first date only, never over an existing one.
      dueAt: b.dueAt as number | undefined,
      dateKind: b.dateKind as "external" | "self-imposed" | undefined,
      // The plan rides through loose-shape; the mutation's arg validators are
      // the final gate and a mismatch surfaces as a named 400 below.
      plan: b.plan as never,
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

// GET /tts/state — everything the prep job needs: all todos, the queue row for
// the day being prepared, and `prepDay` itself. The server owns the day
// arithmetic (5 a.m. boundary + DST) so the worker never computes a day key —
// two hand-rolled implementations of that math diverged on DST Sundays before
// this was centralized (review finding). An explicit ?day= overrides.
const ttsState = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const day =
    new URL(request.url).searchParams.get("day") ?? ttsPrepDay(Date.now());
  const todos = await ctx.runQuery(internal.tts.internalListTodos, {});
  const queue = await ctx.runQuery(internal.tts.internalGetDay, { day });
  // The coming week of external-calendar mirror rows (ttsCalendarEvents):
  // schedule knowledge for realistic queueing — the prep prompt shows them as
  // context, never as queueable items.
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
    queue,
    calendarEvents,
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
  const notes = await ctx.runQuery(internal.tts.internalPendingTimeNotes, {});
  return jsonResponse(200, { notes, ...nowContext(Date.now()) });
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
// needs-session on Tom's page.

// One note is one sentence; ten actions is already far past what one sentence
// asks for (Convex bounded-args guideline).
const TIME_NOTE_ACTIONS_MAX = 10;

// The mutation's OWN declared arg type — the only assertion here, and one that
// cannot drift from the validator the way a hand-written projection could.
type TimeNoteActions = FunctionArgs<
  typeof internal.tts.internalApplyTimeNote
>["actions"];
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

const CODE_RECOMMENDATIONS = [
  "approve",
  "needs-session",
  "propose-archive",
  "stale-replan",
] as const;
const CODE_EXEC_CLASSES = ["box", "needs-turing"] as const;

type CodeBrief = {
  repo: string;
  externalId: string;
  sourceHash: string;
  brief: string;
  recommendation: (typeof CODE_RECOMMENDATIONS)[number];
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
  if (
    !CODE_RECOMMENDATIONS.includes(
      b.recommendation as (typeof CODE_RECOMMENDATIONS)[number],
    )
  ) {
    return {
      error: `briefs[${i}].recommendation must be one of ${CODE_RECOMMENDATIONS.join(" | ")}`,
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
    recommendation: b.recommendation as (typeof CODE_RECOMMENDATIONS)[number],
    execClass: b.execClass as (typeof CODE_EXEC_CLASSES)[number],
    evidence: b.evidence as string | undefined,
  };
}

// POST /tts/code-briefs — the worker's prepared briefs, upserted by
// (repo, externalId). Body: { briefs: [{ repo, externalId, sourceHash, brief,
// recommendation, execClass, evidence? }] }.
const dtsCodeBriefs = httpAction(async (ctx, request) => {
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

http.route({ path: "/tts/code-briefs", method: "POST", handler: dtsCodeBriefs });

// GET /tts/code-rulings — the rulings a worker job should act on (unapplied
// and not superseded by a newer ruling on the same subject), from the unified
// ttsRulings table. ALL THREE subject types ride the one feed: rows carry
// subjectType ("code" → the apply job; "life" with verdict "revise" → the
// preparer, or form-batches when the subject is a v1 batch; "batch" with
// verdict "revise" → the planner, worker/jobs/plan-graphs.mjs). Each job
// filters for its own kind and consumes only those. Each row carries its _id,
// which the worker echoes back to /tts/ruling-applied.
const dtsCodeRulings = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  const pending = await ctx.runQuery(
    internal.ttsRulings.internalPendingRulings,
    {},
  );
  return jsonResponse(200, { pending });
});

// Canonical path: /tts/rulings — the feed serves BOTH subject types, so the
// old code-scoped name is kept only as an alias for not-yet-redeployed
// workers (drop the alias in the tts→tts rename round).
http.route({ path: "/tts/rulings", method: "GET", handler: dtsCodeRulings });
http.route({ path: "/tts/code-rulings", method: "GET", handler: dtsCodeRulings });

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

// ── TTS batches (ratified 2026-08-28) ────────────────────────────────────────
// Same TTS_WORKER_KEY path: the batcher job reads context, then posts its
// desired batch set. It can only touch source-"batcher" rows that Tom has
// never touched — the freeze/skip gates live in internalStoreBatches.

// The sanitizers for POST /tts/batches: the body is model-written JSON, so
// each batch is PROJECTED to exactly the known shape — unknown keys and
// shape-invalid scalars are dropped, never rejected, because one stray LLM
// key must not abort the whole POST. The mutation's arg validators stay the
// final gate (anything still malformed lands in its per-batch skip report).
const PLAN_ACTORS = ["tom", "agent"] as const;
const PLAN_STATUSES = ["open", "done"] as const;

function sanitizeMember(m: unknown): Record<string, unknown> {
  // A non-object or key-less member survives as {} — validateBatchMembers
  // then names it in the skip report (better than dropping it silently).
  if (typeof m !== "object" || m === null) return {};
  const r = m as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.todoId === "string") out.todoId = r.todoId;
  if (typeof r.repo === "string") out.repo = r.repo;
  if (typeof r.externalId === "string") out.externalId = r.externalId;
  return out;
}

// A plan step with a broken required field poisons the whole plan (undefined
// = absent, which the mutation treats as "preserve stored plan") — dropping
// single steps would silently reorder someone's plan.
function sanitizePlan(plan: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(plan)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const step of plan) {
    if (typeof step !== "object" || step === null) return undefined;
    const s = step as Record<string, unknown>;
    if (
      typeof s.text !== "string" ||
      !PLAN_ACTORS.includes(s.actor as (typeof PLAN_ACTORS)[number]) ||
      !PLAN_STATUSES.includes(s.status as (typeof PLAN_STATUSES)[number])
    ) {
      return undefined;
    }
    const clean: Record<string, unknown> = {
      text: s.text,
      actor: s.actor,
      status: s.status,
    };
    if (typeof s.doneAt === "number") clean.doneAt = s.doneAt;
    if (typeof s.evidence === "string") clean.evidence = s.evidence;
    out.push(clean);
  }
  return out;
}

function sanitizeBatch(item: unknown): Record<string, unknown> | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const r = item as Record<string, unknown>;
  // statement and brief are the mutation's required strings — without them
  // the row cannot even be named in a skip report, so the batch is dropped.
  if (typeof r.statement !== "string" || typeof r.brief !== "string") {
    return undefined;
  }
  const out: Record<string, unknown> = {
    statement: r.statement,
    brief: r.brief,
    members: Array.isArray(r.members) ? r.members.map(sanitizeMember) : [],
  };
  if (typeof r.id === "string") out.id = r.id;
  const plan = sanitizePlan(r.plan);
  if (plan !== undefined) out.plan = plan;
  return out;
}

// POST /tts/batches — the batcher's desired batch set. Body: { batches:
// [{ id?, statement, brief, members, plan? }], archiveIds? }.
// Sanitized (drop-don't-reject)
// before the mutation; the mutation's per-batch skip report is the response.
const ttsBatches = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(b.batches)) {
    return jsonResponse(400, { error: "batches (array) required" });
  }
  const batches = b.batches
    .map(sanitizeBatch)
    .filter((x): x is Record<string, unknown> => x !== undefined);
  const droppedBatches = b.batches.length - batches.length;
  const archiveIds = Array.isArray(b.archiveIds)
    ? b.archiveIds.filter((x): x is string => typeof x === "string")
    : undefined;
  try {
    const result = await ctx.runMutation(internal.tts.internalStoreBatches, {
      batches: batches as never,
      archiveIds,
    });
    return jsonResponse(200, {
      ...result,
      droppedBatches: droppedBatches > 0 ? droppedBatches : undefined,
    });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/tts/batches", method: "POST", handler: ttsBatches });

// GET /tts/batch-context — everything the batcher and the planner work from:
// all life todos (schema-v2 graph fields included), the code-todo mirror, the
// code briefs, and Tom's recent rulings (grouping signal).
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
// ITS SOURCE is the synced WikiTom skill (ttsSkills, name "writing-to-tom"),
// with ttsShared.WRITING_STANDARD as the fallback until the sync has run. The
// field name and type do not change: worker/jobs/plan-graphs.mjs treats a
// missing `writingStandard` as fatal and form-batches.mjs reads the same
// payload.
const ttsBatchContext = httpAction(async (ctx, request) => {
  const denied = ttsAuth(request);
  if (denied) return denied;
  // Seven independent reads — issued in parallel, not awaited one by one.
  const [todos, mirror, briefs, recentRulings, batches, planRepairs, writingSkill] =
    await Promise.all([
      ctx.runQuery(internal.tts.internalListTodos, {}),
      ctx.runQuery(internal.tts.internalListMirror, {}),
      ctx.runQuery(internal.ttsCode.internalListBriefs, {}),
      ctx.runQuery(internal.ttsRulings.internalRecentRulings, { limit: 200 }),
      ctx.runQuery(internal.tts.internalListBatches, {}),
      ctx.runQuery(internal.tts.internalRecentPlanRepairs, { limit: 20 }),
      ctx.runQuery(internal.ttsSkills.internalGetSkill, { name: WRITING_SKILL }),
    ]);
  const synced = writingSkill?.body.trim() ?? "";
  return jsonResponse(200, {
    todos,
    mirror,
    briefs,
    recentRulings,
    batches,
    planRepairs,
    writingStandard: synced === "" ? WRITING_STANDARD : synced,
    // The repo names a batch may declare. Served for the SAME reason as
    // writingStandard above: the planner is Node ESM on a box that never loads
    // TypeScript, so it cannot import SESSION_REPOS. Serving the one home's
    // value is what stops a fourth hand-written copy of the repo list
    // appearing in worker/ (VQC C1).
    sessionRepos: SESSION_REPO_NAMES,
  });
});

http.route({
  path: "/tts/batch-context",
  method: "GET",
  handler: ttsBatchContext,
});

// ── POST /tts/plan-graph — the planner's pen (schema v2) ─────────────────────
// ONE batch's graph per call, the successor to POST /tts/batches. Body:
// { batchId?, statement, groundUpExplanation?, path?, tasks: [...], goalIds?,
// archive? }. Same drop-don't-reject discipline as /tts/batches: the body is
// model-written JSON, so it is PROJECTED to the known shape and the mutation's
// per-item skip report is the real validator.
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

// A path places this batch in a named sequence; `index` orders it and `edge`
// describes the link to the previous batch ("must" = that one has to land
// first, "helps" = it only makes this easier). A path missing either required
// field is dropped whole — the mutation reads an absent path as "preserve the
// stored one", which is the safe reading of a broken one too.
function sanitizeBatchPath(p: unknown): Record<string, unknown> | undefined {
  if (typeof p !== "object" || p === null) return undefined;
  const r = p as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.index !== "number") {
    return undefined;
  }
  if (!Number.isFinite(r.index)) return undefined;
  const out: Record<string, unknown> = { name: r.name, index: r.index };
  if (r.edge === "must" || r.edge === "helps") out.edge = r.edge;
  return out;
}

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
  // The model tier. Absent is the norm (workers run Opus); "fable" is the
  // planner's tag for a task whose difficulty warrants the stronger model.
  // Any other value is simply not carried — an unrecognized tier must not
  // reach the mutation, and dropping the tag costs a default, not a task.
  if (r.model === "fable") out.model = r.model;
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
  const droppedTasks: DroppedTask[] = [];
  const tasks = b.tasks.map((task, i) => sanitizeGraphTask(task, i, droppedTasks));
  const path = sanitizeBatchPath(b.path);
  try {
    const result = await ctx.runMutation(internal.tts.internalStorePlanGraph, {
      batchId: typeof b.batchId === "string" ? b.batchId : undefined,
      statement: b.statement,
      groundUpExplanation:
        typeof b.groundUpExplanation === "string"
          ? b.groundUpExplanation
          : undefined,
      path: path as never,
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

export default http;
