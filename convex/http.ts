import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { dtsPrepDay } from "./dtsShared";

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
// dts-shared-gate-dedup). Each route family keeps its OWN env key and header
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

// ── DTS worker endpoints (spec: WikiTom dts/spec.md) ─────────────────────────
// The worker box's narrow, key-authed path into DTS, mirroring the /pool
// pattern: DTS_WORKER_KEY lives only in the Convex env and shares nothing with
// the other keys. The worker may capture items, post the day's prepared
// queue+digest, and read state to prepare from — never rule, archive, or
// delete (those are Tom-gated mutations).

function dtsAuth(request: Request): Response | null {
  return keyAuth(request, "DTS_WORKER_KEY", "X-DTS-Key");
}

// POST /dts/capture — one captured thought/message becomes an `unprepared`
// item. Body: { statement, source?, provenance? }.
const dtsCapture = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
  const id = await ctx.runMutation(internal.dts.internalCapture, {
    statement: b.statement,
    source: typeof b.source === "string" && b.source ? b.source : "slack-capture",
    provenance: typeof b.provenance === "string" ? b.provenance : undefined,
  });
  return jsonResponse(200, { ok: true, id });
});

http.route({ path: "/dts/capture", method: "POST", handler: dtsCapture });

// POST /dts/prep — the worker's Claude-prepared daily queue + digest text.
// Body: { day, todoIds: string[], reasons?: string[], digestText? }.
const dtsPrep = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
    await ctx.runMutation(internal.dts.internalStoreWorkerPrep, {
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

http.route({ path: "/dts/prep", method: "POST", handler: dtsPrep });

// POST /dts/prepare-todo — the worker's preparer job attaches brief /
// entry action / work description to a life todo and advances its readiness.
// Body: { id, brief?, entryAction?, workDescription?, readiness? }.
const dtsPrepareTodo = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  try {
    await ctx.runMutation(internal.dts.internalPrepareTodo, {
      id: b.id,
      brief: str(b.brief),
      entryAction: str(b.entryAction),
      workDescription: str(b.workDescription),
      readiness: b.readiness as "preparing" | "ready-for-tom" | undefined,
      // The newer preparer args (importance + plan) ride through loose-shape;
      // the mutation's arg validators are the final gate and a mismatch
      // surfaces as a named 400 below.
      importanceLevel: b.importanceLevel as never,
      importanceRationale: str(b.importanceRationale),
      plan: b.plan as never,
    });
    return jsonResponse(200, { ok: true });
  } catch (e) {
    return jsonResponse(400, {
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

http.route({ path: "/dts/prepare-todo", method: "POST", handler: dtsPrepareTodo });

// GET /dts/state — everything the prep job needs: all todos, the queue row for
// the day being prepared, and `prepDay` itself. The server owns the day
// arithmetic (5 a.m. boundary + DST) so the worker never computes a day key —
// two hand-rolled implementations of that math diverged on DST Sundays before
// this was centralized (review finding). An explicit ?day= overrides.
const dtsState = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
  if (denied) return denied;
  const day =
    new URL(request.url).searchParams.get("day") ?? dtsPrepDay(Date.now());
  const todos = await ctx.runQuery(internal.dts.internalListTodos, {});
  const queue = await ctx.runQuery(internal.dts.internalGetDay, { day });
  return jsonResponse(200, { todos, queue, prepDay: day });
});

http.route({ path: "/dts/state", method: "GET", handler: dtsState });

// ── DTS code-todo ruling loop (spec §5.3) ────────────────────────────────────
// Same DTS_WORKER_KEY path: the worker posts ground-up briefs for open code
// todos, reads back Tom's pending rulings, and reports each application. The
// worker never rules — recordCodeRuling is Tom-gated in dtsCode.ts.

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

// POST /dts/code-briefs — the worker's prepared briefs, upserted by
// (repo, externalId). Body: { briefs: [{ repo, externalId, sourceHash, brief,
// recommendation, execClass, evidence? }] }.
const dtsCodeBriefs = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
  await ctx.runMutation(internal.dtsCode.internalStoreBriefs, { briefs });
  return jsonResponse(200, { ok: true, count: briefs.length });
});

http.route({ path: "/dts/code-briefs", method: "POST", handler: dtsCodeBriefs });

// GET /dts/code-rulings — the rulings a worker job should act on (unapplied
// and not superseded by a newer ruling on the same subject), from the unified
// dtsRulings table. BOTH subject types ride the feed: rows carry subjectType
// ("code" → the apply job; "life" with verdict "revise" → the preparer
// consumes the sentence). Each row carries its _id, which the worker echoes
// back to /dts/code-ruling-applied.
const dtsCodeRulings = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
  if (denied) return denied;
  const pending = await ctx.runQuery(
    internal.dtsRulings.internalPendingRulings,
    {},
  );
  return jsonResponse(200, { pending });
});

// Canonical path: /dts/rulings — the feed serves BOTH subject types, so the
// old code-scoped name is kept only as an alias for not-yet-redeployed
// workers (drop the alias in the dts→tts rename round).
http.route({ path: "/dts/rulings", method: "GET", handler: dtsCodeRulings });
http.route({ path: "/dts/code-rulings", method: "GET", handler: dtsCodeRulings });

// POST /dts/code-ruling-applied — the worker's apply report. Body: { id,
// result } where result is a commit sha / PR url / error text.
const dtsCodeRulingApplied = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
    await ctx.runMutation(internal.dtsRulings.internalMarkRulingApplied, {
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

// Canonical path: /dts/ruling-applied (any subject type); old name aliased
// for not-yet-redeployed workers.
http.route({
  path: "/dts/ruling-applied",
  method: "POST",
  handler: dtsCodeRulingApplied,
});
http.route({
  path: "/dts/code-ruling-applied",
  method: "POST",
  handler: dtsCodeRulingApplied,
});

// ── DTS batches (ratified 2026-08-28) ────────────────────────────────────────
// Same DTS_WORKER_KEY path: the batcher job reads context, then posts its
// desired batch set. It can only touch source-"batcher" rows that Tom has
// never touched — the freeze/skip gates live in internalStoreBatches.

// The sanitizers for POST /dts/batches: the body is model-written JSON, so
// each batch is PROJECTED to exactly the known shape — unknown keys and
// shape-invalid scalars are dropped, never rejected, because one stray LLM
// key must not abort the whole POST. The mutation's arg validators stay the
// final gate (anything still malformed lands in its per-batch skip report).
const IMPORTANCE_LEVELS = ["low", "medium", "high"] as const;
const PLAN_ACTORS = ["tom", "agent"] as const;
const PLAN_STATUSES = ["open", "done"] as const;

function sanitizeString(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}

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
  if (
    IMPORTANCE_LEVELS.includes(
      r.importanceLevel as (typeof IMPORTANCE_LEVELS)[number],
    )
  ) {
    out.importanceLevel = r.importanceLevel;
    const rationale = sanitizeString(r.importanceRationale);
    if (rationale !== undefined) out.importanceRationale = rationale;
  }
  return out;
}

// POST /dts/batches — the batcher's desired batch set. Body: { batches:
// [{ id?, statement, brief, members, plan?, importanceLevel?,
// importanceRationale? }], archiveIds? }. Sanitized (drop-don't-reject)
// before the mutation; the mutation's per-batch skip report is the response.
const dtsBatches = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
    const result = await ctx.runMutation(internal.dts.internalStoreBatches, {
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

http.route({ path: "/dts/batches", method: "POST", handler: dtsBatches });

// GET /dts/batch-context — everything the batcher groups from: all life
// todos (batches included), the code-todo mirror, the code briefs, and Tom's
// recent rulings (grouping signal).
const dtsBatchContext = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
  if (denied) return denied;
  // Four independent reads — issued in parallel, not awaited one by one.
  const [todos, mirror, briefs, recentRulings] = await Promise.all([
    ctx.runQuery(internal.dts.internalListTodos, {}),
    ctx.runQuery(internal.dts.internalListMirror, {}),
    ctx.runQuery(internal.dtsCode.internalListBriefs, {}),
    ctx.runQuery(internal.dtsRulings.internalRecentRulings, { limit: 200 }),
  ]);
  return jsonResponse(200, { todos, mirror, briefs, recentRulings });
});

http.route({
  path: "/dts/batch-context",
  method: "GET",
  handler: dtsBatchContext,
});

// POST /dts/session-outcome — an autonomous session's outcome pen. Body:
// { sessionId, outcome: "completed"|"errored", summary? }. It lives under the
// DTS key ON PURPOSE: an autonomous session's environment carries ONLY
// CONVEX_SITE_URL + DTS_WORKER_KEY — SESSIONS_WORKER_KEY never enters a
// model-reachable shell (the auth-clobber lesson: the ingest key would let a
// prompt-injected session forge poll/ingest traffic for every session), so
// the one key the agent holds must be the one this pen accepts.
const dtsSessionOutcome = httpAction(async (ctx, request) => {
  const denied = dtsAuth(request);
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
  path: "/dts/session-outcome",
  method: "POST",
  handler: dtsSessionOutcome,
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
    // Box load snapshot, loose-shape: the mutation's arg validator is the
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
