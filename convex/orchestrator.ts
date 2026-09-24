// THE ORCHESTRATOR (Tom, 2026-09-21): one long-lived jarvis agent that hands
// work out to hosted workers and answers the decisions they raise.
//
// It is a chain of runs, the way a runner is a chain of steps. Each run is a
// claudeSessions row the box daemon HOSTS: kept alive across turns, so a
// worker's elevation reaches it as its next turn rather than at the end of
// anything. When a run asks to compact, crashes, or loses its lease, the next
// run starts cold from the orchestrator's document and names the last as its
// continuesRunId. Nothing re-enters a dead run.
//
// This file is the one writer of the orchestrators, orchestratorDocuments,
// hostedRuns and elevations tables, and of a delegate ruling.
//
// Two kinds of message cross between the runs, both as claudeInbound
// user-turns written by an agent: an elevation (a worker's question with its
// two sides, never a recommendation) and a plain message either way. The
// answer to an elevation goes back the same way.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { requireTom } from "./authRoles";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { insertSession, mergeGate, sessionOutcomePen, workspaceParagraph } from "./claudeSessions";
import { logEvent } from "./tts";
import {
  BOX_TOOLS_PARAGRAPH,
  CODEX_FALLBACK_MODEL,
  CODEX_USAGE_STALE_MS,
  CODEX_WEEKLY_CAP_PERCENT,
  DAEMON_RESTART_SENTENCE,
  DEFAULT_SESSION_MODEL,
  HOSTED_WORKERS_MAX,
  LIVE_STATUSES,
  NARROW_LIST,
  channelFor,
  isLive,
  isNarrowListId,
  isSessionModel,
  modelFamily,
  normalizeSessionRepos,
  type DecisionKind,
  type SessionModel,
} from "./ttsShared";
import { DELEGATE_DECISION, DELEGATE_OBJECTION } from "./ttsAsk";
import {
  COMPACT_ENDED_REASON,
  DAEMON_RESTART_ENDED_REASON,
  ORCHESTRATOR_COMPACT_WORD,
} from "../worker/session-host/hosted.mjs";
import { composeElevationAsk, elevationAskBody, renderSlack } from "./ttsCompose";

export const ORCHESTRATOR_KEY = "jarvis" as const;
/** How long a run holds the lease without the daemon saying it still holds
 * the run. The daemon polls every 30 seconds at the slowest, so three minutes
 * is six missed polls: a daemon that stopped, not one that paused. */
export const ORCHESTRATOR_LEASE_MS = 3 * 60_000;
/** The first wait after a crash; each consecutive crash doubles it, up to the
 * cap. A crash loop otherwise restarts a failing run every minute for ever. */
export const ORCHESTRATOR_CRASH_BACKOFF_MS = 60_000;
export const ORCHESTRATOR_CRASH_BACKOFF_CAP_MS = 60 * 60_000;
/** Consecutive crashes after which #tts-broken is told. */
export const ORCHESTRATOR_CRASHES_REPORTED = 3;
/** A run that stayed up this long was not part of a crash loop: the crash
 * count starts again from it. */
export const ORCHESTRATOR_STABLE_MS = 10 * 60_000;

/** The delegate's own question limit (POST /tts/ask): a trade-off goes to the
 * delegate word for word, so an elevation's question is held to it. */
const QUESTION_MAX_CHARS = 400;

export const INITIAL_DOCUMENT = [
  "# The orchestrator's document",
  "",
  "## Todos by area and order",
  "",
  "Nothing grouped yet.",
  "",
  "## Live workers",
  "",
  "None.",
  "",
  "## Open elevations",
  "",
  "None.",
  "",
  "## Learned",
  "",
  "Nothing yet.",
  "",
].join("\n");

// ── The model ────────────────────────────────────────────────────────────────

/**
 * The orchestrator's model (Tom, 2026-09-21): OpenAI's Astra if the box's
 * Codex CLI lists it, else gpt-5.6-sol, else Fable through the Claude path.
 * The list is what the daemon last reported on its heartbeat. Past Codex's
 * weekly cap every Codex model is out, and Fable runs it (the agent rules put
 * Opus at the cap for a box run; the orchestrator's own ruling names Fable as
 * its fallback, so Fable it is).
 *
 * The model ceiling (worker/runs/models.mjs) is applied where every session
 * starts, the daemon's modelSpec: while the heartbeat's fableAvailability says
 * Fable is unavailable, a session asked for Fable runs Opus, and the first
 * Fable probe that answers lifts it. So the choice stays "fable", and only
 * the recorded reason says the ceiling is in force.
 */
type Health = {
  codexModels?: string[];
  codexUsage?: { weeklyUsedPercent: number; readAt: number };
  fableAvailability?: { available: boolean };
} | null;

/** The Fable choice, its reason naming the ceiling while it is in force. */
function fableChoice(health: Health, why: string): { model: SessionModel; reason: string } {
  const atCeiling = health?.fableAvailability?.available === false;
  return {
    model: "fable",
    reason: atCeiling ? `${why}, so Fable, which runs as Opus at the model ceiling while Fable is unavailable on the box` : `${why}, so Fable`,
  };
}

/** True when a fresh reading puts Codex's weekly usage at or past the cap,
 * the same test the auto-session scheduler applies. */
function codexCapped(health: Health, now: number): boolean {
  const usage = health?.codexUsage;
  return usage !== undefined && now - usage.readAt <= CODEX_USAGE_STALE_MS && usage.weeklyUsedPercent >= CODEX_WEEKLY_CAP_PERCENT;
}

export function orchestratorModel(health: Health, now: number): { model: SessionModel; reason: string } {
  if (codexCapped(health, now)) {
    return fableChoice(health, `Codex's weekly usage is at ${Math.round(health!.codexUsage!.weeklyUsedPercent)}%, past the ${CODEX_WEEKLY_CAP_PERCENT}% cap`);
  }
  const listed = health?.codexModels;
  if (listed === undefined) {
    return { model: "gpt-5.6-sol", reason: "no daemon has reported the Codex model list yet, so gpt-5.6-sol, the Codex model known to run" };
  }
  if (listed.includes("gpt-6-astra")) return { model: "gpt-6-astra", reason: "the box's Codex CLI lists gpt-6-astra" };
  if (listed.includes("gpt-5.6-sol")) return { model: "gpt-5.6-sol", reason: "the box's Codex CLI does not list Astra, so gpt-5.6-sol" };
  return fableChoice(health, "the box's Codex CLI lists neither Astra nor gpt-5.6-sol");
}

export function crashBackoffMs(crashes: number): number {
  return Math.min(ORCHESTRATOR_CRASH_BACKOFF_CAP_MS, ORCHESTRATOR_CRASH_BACKOFF_MS * 2 ** Math.max(0, crashes - 1));
}

// ── Reads ────────────────────────────────────────────────────────────────────

async function orchestratorRow(ctx: QueryCtx): Promise<Doc<"orchestrators"> | null> {
  return await ctx.db
    .query("orchestrators")
    .withIndex("by_key", (q) => q.eq("key", ORCHESTRATOR_KEY))
    .unique();
}

/**
 * The hosted run a session is, or null. ONE RULE for every reader: a session
 * is hosted only while it runs unattended. Tom reopening a hosted row flips
 * its mode and makes it his interactive session, which nothing here may
 * count, stop, message or end as the orchestrator's.
 */
async function hostedRunOf(ctx: QueryCtx, session: Doc<"claudeSessions">): Promise<Doc<"hostedRuns"> | null> {
  if (session.mode !== "autonomous") return null;
  return await ctx.db
    .query("hostedRuns")
    .withIndex("by_session", (q) => q.eq("sessionId", session._id))
    .first();
}

/** The orchestrator's current run, when it is still running as the
 * orchestrator: live and unattended. A run Tom reopened is his conversation
 * and no longer the orchestrator's, even while the row still names it. */
function isOrchestratorRun(session: Doc<"claudeSessions"> | null): session is Doc<"claudeSessions"> {
  return session !== null && isLive(session.status) && session.mode === "autonomous";
}

/** The live orchestrator run, when the caller is it. Every orchestrator pen
 * names its own session id and is refused unless it is the live run: a run
 * the chain has moved past has no voice. */
async function requireLiveOrchestrator(ctx: MutationCtx, sessionId: string) {
  const id = ctx.db.normalizeId("claudeSessions", sessionId);
  const row = await orchestratorRow(ctx);
  if (!row || row.stoppedAt !== undefined) throw new Error("refused: the orchestrator is stopped");
  if (id === null || row.liveSessionId !== id) throw new Error(`refused: ${sessionId} is not the orchestrator's live run`);
  const session = await ctx.db.get(id);
  if (!isOrchestratorRun(session)) throw new Error(`refused: ${sessionId} has ended`);
  return { row, session };
}

async function requireHostedWorker(ctx: MutationCtx, sessionId: string) {
  const id = ctx.db.normalizeId("claudeSessions", sessionId);
  const session = id === null ? null : await ctx.db.get(id);
  const hosted = session === null ? null : await hostedRunOf(ctx, session);
  if (!session || !hosted || hosted.environment !== "worker") throw new Error(`refused: ${sessionId} is not a hosted worker`);
  if (!isLive(session.status)) throw new Error(`refused: ${sessionId} has ended`);
  return { hosted, session };
}

/** The hosted workers whose sessions are live, newest first. Read from the
 * live sessions, which are few by design, so no live worker is ever outside
 * the read. */
async function liveHostedWorkers(ctx: QueryCtx) {
  const live: { hosted: Doc<"hostedRuns">; session: Doc<"claudeSessions"> }[] = [];
  for (const status of LIVE_STATUSES) {
    const sessions = await ctx.db
      .query("claudeSessions")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect();
    for (const session of sessions) {
      const hosted = await hostedRunOf(ctx, session);
      if (hosted?.environment === "worker") live.push({ hosted, session });
    }
  }
  return live.sort((a, b) => b.session.createdAt - a.session.createdAt);
}

async function unansweredElevations(ctx: QueryCtx) {
  const open = await ctx.db.query("elevations").withIndex("by_status", (q) => q.eq("status", "open")).collect();
  const waiting = await ctx.db.query("elevations").withIndex("by_status", (q) => q.eq("status", "waiting-on-tom")).collect();
  return [...open, ...waiting].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * What the poll tells the daemon about one live session row: whether it is
 * hosted, and for a worker, what decides its ending. Undefined for a session
 * the daemon runs the ordinary way.
 */
export async function hostedFacts(ctx: QueryCtx, session: Doc<"claudeSessions">) {
  const hosted = await hostedRunOf(ctx, session);
  if (!hosted) return undefined;
  if (hosted.environment === "orchestrator") return { environment: "orchestrator" as const };
  const open = await ctx.db
    .query("elevations")
    .withIndex("by_worker_status", (q) => q.eq("workerSessionId", session._id).eq("status", "open"))
    .collect();
  const waiting = await ctx.db
    .query("elevations")
    .withIndex("by_worker_status", (q) => q.eq("workerSessionId", session._id).eq("status", "waiting-on-tom"))
    .collect();
  return {
    environment: "worker" as const,
    openElevations: open.length + waiting.length,
    outcomeRecorded: session.outcome !== undefined,
  };
}

/** The poll's other half: while the daemon says it holds the live run, the
 * lease is renewed. Written only when a third of the lease has passed, so a
 * one-second poll does not patch the row every second. */
export async function renewOrchestratorLease(ctx: MutationCtx, held: readonly string[], now: number) {
  const row = await orchestratorRow(ctx);
  if (!row || row.stoppedAt !== undefined || row.liveSessionId === undefined) return;
  if (!held.includes(row.liveSessionId)) return;
  if (!isOrchestratorRun(await ctx.db.get(row.liveSessionId))) return;
  if (row.leaseDeadline !== undefined && row.leaseDeadline - now > (ORCHESTRATOR_LEASE_MS * 2) / 3) return;
  await ctx.db.patch(row._id, {
    leaseDeadline: now + ORCHESTRATOR_LEASE_MS,
    ...(row.crashes > 0 && now - row.runStartedAt >= ORCHESTRATOR_STABLE_MS ? { crashes: 0 } : {}),
  });
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/** A message into a run, as its next turn. Written as an agent's turn, so it
 * can never be read as Tom's words. */
async function queueTurn(ctx: MutationCtx, sessionId: Id<"claudeSessions">, text: string) {
  await ctx.db.insert("claudeInbound", {
    sessionId,
    kind: "user-turn",
    text,
    author: "agent",
    status: "pending",
    createdAt: Date.now(),
  });
}

/** A message into a worker, only while it is live and still the
 * orchestrator's: an ended session is never polled again, so a turn queued on
 * it would sit unread for ever, and a worker Tom reopened is his
 * conversation. False otherwise, and the caller records that it was not
 * delivered. */
async function deliver(ctx: MutationCtx, sessionId: Id<"claudeSessions">, text: string): Promise<boolean> {
  const session = await ctx.db.get(sessionId);
  if (!session || !isLive(session.status) || session.mode !== "autonomous") return false;
  await queueTurn(ctx, sessionId, text);
  return true;
}

/** A message into the orchestrator. Queued on its latest run even when that
 * run has ended, because the next run's opener carries every message its
 * predecessor did not finish; true only when the run is live. */
async function deliverToOrchestrator(ctx: MutationCtx, text: string): Promise<boolean> {
  const row = await orchestratorRow(ctx);
  if (!row) return false;
  const session = row.liveSessionId === undefined ? null : await ctx.db.get(row.liveSessionId);
  // Stopped, or its latest run is one Tom reopened as his conversation: no
  // run of its own can hold the message, so it waits on the row for the next
  // run (the sweep's, within the minute, or the next start's).
  if (row.stoppedAt !== undefined || !session || session.mode !== "autonomous") {
    await ctx.db.patch(row._id, { mailbox: [...(row.mailbox ?? []), text] });
    return false;
  }
  await queueTurn(ctx, session._id, text);
  return isLive(session.status);
}

/** What a ruling on an elevation records about its delivery. */
function deliveryResult(delivered: boolean, worker: Id<"claudeSessions">): string {
  return delivered ? `delivered to worker ${worker}` : `recorded only: worker ${worker} had ended`;
}

// ── Start, stop, restart ─────────────────────────────────────────────────────

/**
 * Start the next run in the chain from the document. `from` is the run it
 * continues, if any: its pending messages are carried into the opener and
 * settled, and it is ended if it is somehow still live.
 */
async function launchRun(
  ctx: MutationCtx,
  row: Doc<"orchestrators">,
  reason: string,
): Promise<Id<"claudeSessions">> {
  const now = Date.now();
  const from = row.liveSessionId === undefined ? null : await ctx.db.get(row.liveSessionId);
  // The mailbox holds what the next run must be shown: messages that reached
  // no run of the orchestrator's, and those an earlier opener carried. It is
  // kept until a run FINISHES its opener, so a run that crashes during its
  // first turn hands the same messages on again rather than losing them.
  let carried: string[] = [...(row.mailbox ?? [])];
  // A run Tom reopened is his conversation, and everything queued on it is
  // its own; only a run still the orchestrator's hands its messages on.
  if (from && from.mode === "autonomous") {
    // Every message the ended run did not finish: never delivered (pending,
    // or settled "interrupted" by the ending), or delivered in a turn that
    // failed or was cut off. Only "done" means the run acted on it. The run's
    // own opener, its first row, is its successor's opener rebuilt, and is
    // never carried.
    const rows = (
      await ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) => q.eq("sessionId", from._id))
        .collect()
    ).sort((a, b) => a.createdAt - b.createdAt);
    // "done" is a turn the run acted on: the daemon settles a hosted run's
    // turn "failed" when its result failed (worker/session-host/session.mjs).
    const finished = (m: (typeof rows)[number]) => m.status === "done";
    // Its opener finished: what that opener carried was read, and only what
    // arrived since is handed on (with anything the mailbox gained meanwhile,
    // which reached no run).
    if (rows[0] !== undefined && finished(rows[0])) carried = carried.slice(row.carriedCount ?? 0);
    for (const message of rows.slice(1)) {
      if (finished(message) || message.author !== "agent" || message.kind !== "user-turn") continue;
      if (typeof message.text === "string") carried.push(message.text);
    }
    // Nothing is left pending on a run the chain has moved past, its opener
    // and any stop included: a reopen of it later must not replay them.
    for (const message of rows) {
      if (message.status === "pending") await ctx.db.patch(message._id, { status: "interrupted" });
    }
    if (isOrchestratorRun(from)) {
      // Ended here, not by the daemon, so its live tail is cleared here too,
      // as forceClose clears it.
      await ctx.db.patch(from._id, { status: "failed", statusChangedAt: now, endedReason: `orchestrator restarted: ${reason}` });
      const buf = await ctx.db
        .query("claudeStreamBuf")
        .withIndex("by_session", (q) => q.eq("sessionId", from._id))
        .first();
      if (buf) await ctx.db.delete(buf._id);
    }
  }
  const health = await ctx.db.query("claudeDaemonHealth").first();
  const { model, reason: modelReason } = orchestratorModel(health, now);
  const workers = await liveHostedWorkers(ctx);
  const elevations = await unansweredElevations(ctx);
  const sessionId = await insertSession(
    ctx,
    {
      title: "Jarvis orchestrator",
      kind: "adhoc",
      repos: [],
      mode: "autonomous",
      model,
      continuesRunId: from?.runId,
      outcomePen: false,
      prompt: (id) =>
        buildOrchestratorPrompt({
          sessionId: id,
          document: row.document,
          documentVersion: row.documentVersion,
          reason,
          instruction: row.instruction,
          carried,
          workers: workers.map(({ session }) => ({ id: session._id, title: session.title, status: session.status })),
          elevations: elevations.map((e) => ({
            id: e._id,
            worker: e.workerSessionId,
            question: e.question,
            sides: e.sides,
            status: e.status,
          })),
        }),
    },
    now,
  );
  await ctx.db.insert("hostedRuns", { sessionId, environment: "orchestrator", createdAt: now });
  await ctx.db.patch(row._id, {
    model,
    modelReason,
    liveSessionId: sessionId,
    leaseDeadline: now + ORCHESTRATOR_LEASE_MS,
    runStartedAt: now,
    restartAt: undefined,
    mailbox: carried.length > 0 ? carried : undefined,
    carriedCount: carried.length,
    lastRestart: { at: now, reason, ...(from ? { fromSessionId: from._id } : {}) },
  });
  await logEvent(ctx, "orchestrator-started", undefined, {
    sessionId,
    reason,
    model,
    modelReason,
    continuesRunId: from?.runId ?? null,
    carried: carried.length,
  });
  return sessionId;
}

/**
 * Start the orchestrator, or say which run is already live. One exists at a
 * time: a start while a run is live starts nothing.
 *
 * TOM'S DOOR, NOT A WORKER-KEY PEN: every run on the box holds the worker key,
 * so a pen could not tell Tom's start from a worker starting a fleet, or his
 * stop from a worker silencing the one run that answers it. Tom starts and
 * stops it from his login; a session with the deploy credential uses the
 * internal twins (`npx convex run orchestrator:internalStart`), the way
 * internalCreateSession is used. Restarts after a compaction or a crash are
 * the record's own and need neither.
 */
const START_ARGS = { reason: v.string(), instruction: v.optional(v.string()) };
export const start = mutation({
  args: START_ARGS,
  handler: async (ctx, args) => {
    await requireTom(ctx, "Orchestrator");
    return await startOrchestrator(ctx, args);
  },
});
export const internalStart = internalMutation({
  args: START_ARGS,
  handler: async (ctx, args) => await startOrchestrator(ctx, args),
});

async function startOrchestrator(ctx: MutationCtx, { reason, instruction }: { reason: string; instruction?: string }) {
  const now = Date.now();
  let row = await orchestratorRow(ctx);
  if (row && row.stoppedAt === undefined && row.liveSessionId !== undefined) {
    const live = await ctx.db.get(row.liveSessionId);
    if (isOrchestratorRun(live)) return { started: false, sessionId: live._id };
  }
  if (!row) {
    const id = await ctx.db.insert("orchestrators", {
      key: ORCHESTRATOR_KEY,
      model: DEFAULT_SESSION_MODEL,
      modelReason: "not started yet",
      document: INITIAL_DOCUMENT,
      documentVersion: 1,
      startedAt: now,
      runStartedAt: now,
      crashes: 0,
      instruction: instruction?.trim() || undefined,
    });
    await ctx.db.insert("orchestratorDocuments", { version: 1, text: INITIAL_DOCUMENT, at: now });
    row = (await ctx.db.get(id))!;
  } else {
    await ctx.db.patch(row._id, { stoppedAt: undefined, stoppedReason: undefined, crashes: 0, startedAt: now, instruction: instruction?.trim() || undefined });
    row = (await ctx.db.get(row._id))!;
  }
  const sessionId = await launchRun(ctx, row, `started: ${reason}`);
  return { started: true, sessionId };
}

/** End a session the daemon may never have claimed. A claimed run is sent a
 * stop, which the daemon honours; a run still requested is ended here, since
 * no daemon holds it to honour anything. */
async function endRun(ctx: MutationCtx, sessionId: Id<"claudeSessions">, reason: string) {
  const session = await ctx.db.get(sessionId);
  // A run Tom reopened is his conversation, and a stop of the orchestrator
  // never ends it.
  if (!session || !isLive(session.status) || session.mode !== "autonomous") return;
  if (session.status === "requested") {
    await ctx.db.patch(sessionId, { status: "ended", statusChangedAt: Date.now(), endedReason: reason });
    const pending = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "pending"))
      .collect();
    for (const message of pending) await ctx.db.patch(message._id, { status: "interrupted" });
    return;
  }
  await ctx.db.insert("claudeInbound", { sessionId, kind: "stop", author: "agent", status: "pending", createdAt: Date.now() });
}

/** Stop the orchestrator and the workers it hosts. Nothing restarts it until
 * the next start. Tom's door, for the reason start gives. */
export const stop = mutation({
  args: { reason: v.string() },
  handler: async (ctx, args) => {
    await requireTom(ctx, "Orchestrator");
    return await stopOrchestrator(ctx, args);
  },
});
export const internalStop = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, args) => await stopOrchestrator(ctx, args),
});

async function stopOrchestrator(ctx: MutationCtx, { reason }: { reason: string }) {
  const row = await orchestratorRow(ctx);
  if (!row) return { stopped: false };
  await ctx.db.patch(row._id, { stoppedAt: Date.now(), stoppedReason: reason, restartAt: undefined });
  if (row.liveSessionId !== undefined) await endRun(ctx, row.liveSessionId, `orchestrator stopped: ${reason}`);
  const workers = await liveHostedWorkers(ctx);
  for (const { session } of workers) await endRun(ctx, session._id, `orchestrator stopped: ${reason}`);
  await logEvent(ctx, "orchestrator-stopped", undefined, { reason, workers: workers.length });
  return { stopped: true, workers: workers.length };
}

/**
 * A hosted session reached an ending (the daemon's terminal flush, or a
 * force-close). A worker's orchestrator is told. For the orchestrator's live
 * run, a compaction restarts it at once and anything else counts a crash and
 * restarts it after the backoff. The restart itself runs in the sweep's own
 * transaction: a restart that throws must never roll back the ending the
 * daemon just reported.
 */
export async function onHostedSessionEnded(
  ctx: MutationCtx,
  session: Doc<"claudeSessions">,
  ending: { status: string; endedReason?: string },
) {
  const hosted = await hostedRunOf(ctx, session);
  if (!hosted) return;
  const now = Date.now();
  if (hosted.environment === "worker") {
    const fresh = await ctx.db.get(session._id);
    const outcome = fresh?.outcome
      ? `its outcome: ${fresh.outcome}${fresh.outcomeSummary ? ` — ${fresh.outcomeSummary}` : ""}`
      : "it recorded no outcome";
    // A message can be accepted for a worker in the moment before it ends; the
    // ending settles it unread. The orchestrator is told which, so nothing it
    // sent disappears without a word.
    const unread = (
      await ctx.db
        .query("claudeInbound")
        .withIndex("by_session_status", (q) => q.eq("sessionId", session._id))
        .collect()
    ).filter((m) => m.kind === "user-turn" && m.author === "agent" && m.deliveredAt === undefined && m.status !== "done" && typeof m.text === "string");
    const lost = unread.length === 0 ? "" : `\nThese messages never reached it:\n${unread.map((m) => `---\n${m.text}`).join("\n")}`;
    await deliverToOrchestrator(
      ctx,
      `Worker ${session._id} ("${session.title}") ended (${ending.endedReason ?? ending.status}); ${outcome}.${lost}`,
    );
    return;
  }
  const row = await orchestratorRow(ctx);
  if (!row || row.liveSessionId !== session._id || row.stoppedAt !== undefined) return;
  // A compaction restarts at once. So does a daemon restart (every roll of
  // worker/setup.sh): it ends every unattended run and says nothing about
  // this one, so it is not counted as a crash.
  if (ending.endedReason === COMPACT_ENDED_REASON || ending.endedReason === DAEMON_RESTART_ENDED_REASON) {
    await ctx.db.patch(row._id, { crashes: ending.endedReason === COMPACT_ENDED_REASON ? 0 : row.crashes, restartAt: now });
    await ctx.scheduler.runAfter(0, internal.orchestrator.internalSweep, {});
    return;
  }
  const crashes = await countCrash(ctx, row, session._id, ending.endedReason ?? ending.status);
  const wait = crashBackoffMs(crashes);
  await ctx.db.patch(row._id, { restartAt: now + wait });
  await ctx.scheduler.runAfter(wait, internal.orchestrator.internalSweep, {});
}

/** Count one crash, the one way: the event, and at the third in a row the
 * #tts-broken line. Returns the new count. */
async function countCrash(ctx: MutationCtx, row: Doc<"orchestrators">, sessionId: Id<"claudeSessions">, endedReason: string): Promise<number> {
  const crashes = row.crashes + 1;
  await ctx.db.patch(row._id, { crashes });
  await logEvent(ctx, "orchestrator-crashed", undefined, { sessionId, endedReason, crashes });
  if (crashes === ORCHESTRATOR_CRASHES_REPORTED) {
    // "-failed" is what makes logEvent post the #tts-broken line.
    await logEvent(ctx, "orchestrator-restart-failed", undefined, {
      job: "orchestrator",
      error: `the orchestrator has crashed ${crashes} times in a row; the last run ended: ${endedReason}`,
    });
  }
  return crashes;
}

/**
 * The one place a run restarts, every minute by cron and when an ending
 * schedules it. It restarts when the live run has ended and its backoff has
 * passed, or when a claimed run's lease has run out: the daemon stopped
 * saying it holds it. A run still requested is waiting for a daemon, not dead,
 * and is left alone.
 */
export const internalSweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await orchestratorRow(ctx);
    if (!row || row.stoppedAt !== undefined) return { restarted: false };
    const now = Date.now();
    const session = row.liveSessionId === undefined ? null : await ctx.db.get(row.liveSessionId);
    if (!session) {
      await launchRun(ctx, row, "its run was missing");
      return { restarted: true };
    }
    if (session.mode !== "autonomous") {
      // Tom reopened the orchestrator's run: it is his conversation now, and
      // the orchestrator goes on in a new run without waiting out a backoff.
      await launchRun(ctx, row, "Tom reopened its last run as a conversation");
      return { restarted: true };
    }
    if (!isLive(session.status)) {
      if (row.restartAt !== undefined && now < row.restartAt) return { restarted: false };
      const reason =
        session.endedReason === COMPACT_ENDED_REASON
          ? "the last run compacted"
          : `the last run ended: ${session.endedReason ?? session.status}`;
      await launchRun(ctx, row, reason);
      return { restarted: true };
    }
    if (session.status !== "requested" && row.leaseDeadline !== undefined && now > row.leaseDeadline) {
      await countCrash(ctx, row, session._id, "its lease expired");
      await launchRun(ctx, (await ctx.db.get(row._id))!, "the last run's lease expired");
      return { restarted: true };
    }
    return { restarted: false };
  },
});

// ── The pens ─────────────────────────────────────────────────────────────────

/** The orchestrator rewrites its document. Versioned: every rewrite is kept. */
export const internalWriteDocument = internalMutation({
  args: { sessionId: v.string(), document: v.string() },
  handler: async (ctx, { sessionId, document }) => {
    const { row, session } = await requireLiveOrchestrator(ctx, sessionId);
    const text = document.trim();
    if (text === "") throw new Error("refused: the document is empty");
    const version = row.documentVersion + 1;
    const now = Date.now();
    await ctx.db.insert("orchestratorDocuments", { version, text, sessionId: session._id, at: now });
    await ctx.db.patch(row._id, { document: text, documentVersion: version });
    return { version };
  },
});

/** The orchestrator spawns a hosted worker on a brief. Refused at the limit. */
export const internalSpawnWorker = internalMutation({
  args: {
    sessionId: v.string(),
    title: v.string(),
    brief: v.string(),
    repos: v.optional(v.array(v.string())),
    todoId: v.optional(v.string()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { session: orchestrator } = await requireLiveOrchestrator(ctx, args.sessionId);
    const title = args.title.trim();
    const brief = args.brief.trim();
    if (title === "" || brief === "") throw new Error("refused: a worker needs a title and a brief");
    const live = await liveHostedWorkers(ctx);
    if (live.length >= HOSTED_WORKERS_MAX) {
      throw new Error(`refused: ${live.length} hosted workers are live, the limit is ${HOSTED_WORKERS_MAX}; wait for one to end`);
    }
    if (args.model !== undefined && !isSessionModel(args.model)) throw new Error(`refused: unknown model ${args.model}`);
    // Codex's weekly cap, as the scheduler applies it: a worker that asked for
    // a Codex model waits, and one that took the default falls back to Claude.
    const capped = codexCapped(await ctx.db.query("claudeDaemonHealth").first(), Date.now());
    if (capped && args.model !== undefined && modelFamily(args.model as SessionModel) === "codex") {
      throw new Error(`refused: Codex is past its weekly cap; spawn this worker on a Claude model or wait`);
    }
    const model: SessionModel =
      args.model !== undefined && isSessionModel(args.model) ? args.model : capped ? CODEX_FALLBACK_MODEL : DEFAULT_SESSION_MODEL;
    let todoId: Id<"dtsTodos"> | undefined;
    if (args.todoId !== undefined) {
      const id = ctx.db.normalizeId("dtsTodos", args.todoId);
      if (id === null || !(await ctx.db.get(id))) throw new Error(`refused: unknown todo ${args.todoId}`);
      todoId = id;
    }
    const now = Date.now();
    const sessionId = await insertSession(
      ctx,
      {
        title,
        kind: "adhoc",
        repos: normalizeSessionRepos(args.repos ?? []),
        todoId,
        mode: "autonomous",
        model,
        outcomePen: false,
        prompt: (id, repos) => buildHostedWorkerPrompt({ sessionId: id, repos, brief, todoId }),
      },
      now,
    );
    await ctx.db.insert("hostedRuns", { sessionId, environment: "worker", spawnedBy: orchestrator._id, todoId, createdAt: now });
    await logEvent(ctx, "hosted-worker-spawned", todoId, { sessionId, title, model, spawnedBy: orchestrator._id });
    return { sessionId, model };
  },
});

/** A message between the orchestrator and one of its workers, either way. */
export const internalSendMessage = internalMutation({
  args: { sessionId: v.string(), to: v.string(), text: v.string() },
  handler: async (ctx, { sessionId, to, text }) => {
    const body = text.trim();
    if (body === "") throw new Error("refused: the message is empty");
    const id = ctx.db.normalizeId("claudeSessions", sessionId);
    const caller = id === null ? null : await ctx.db.get(id);
    const hosted = caller === null ? null : await hostedRunOf(ctx, caller);
    if (hosted?.environment === "worker") {
      if (to !== "orchestrator") throw new Error('refused: a worker messages only "orchestrator"');
      const { session } = await requireHostedWorker(ctx, sessionId);
      const delivered = await deliverToOrchestrator(ctx, `Message from worker ${session._id} ("${session.title}"): ${body}`);
      return { delivered };
    }
    await requireLiveOrchestrator(ctx, sessionId);
    const { session: worker } = await requireHostedWorker(ctx, to);
    const delivered = await deliver(ctx, worker._id, `Message from the orchestrator: ${body}`);
    return { delivered };
  },
});

/** A worker raises a decision to the orchestrator: the question and its two
 * sides, with no recommendation. */
export const internalElevate = internalMutation({
  args: {
    sessionId: v.string(),
    question: v.string(),
    sides: v.array(v.string()),
    todoId: v.optional(v.string()),
    concernsRunId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { session: worker } = await requireHostedWorker(ctx, args.sessionId);
    const question = args.question.trim();
    const sides = args.sides.map((side) => side.trim());
    if (question === "" || question.length > QUESTION_MAX_CHARS) throw new Error(`refused: the question is 1 to ${QUESTION_MAX_CHARS} characters`);
    if (sides.length !== 2 || sides.some((side) => side === "")) {
      throw new Error("refused: give exactly two sides and no recommendation");
    }
    let todoId: Id<"dtsTodos"> | undefined;
    if (args.todoId !== undefined) {
      const id = ctx.db.normalizeId("dtsTodos", args.todoId);
      if (id === null || !(await ctx.db.get(id))) throw new Error(`refused: unknown todo ${args.todoId}`);
      todoId = id;
    }
    const now = Date.now();
    const elevationId = await ctx.db.insert("elevations", {
      workerSessionId: worker._id,
      question,
      sides,
      todoId,
      concernsRunId: args.concernsRunId?.trim() || undefined,
      status: "open",
      createdAt: now,
    });
    const concerns = [
      todoId === undefined ? null : `It concerns todo ${todoId}.`,
      args.concernsRunId?.trim() ? `It concerns run ${args.concernsRunId.trim()}.` : null,
    ].filter((line): line is string => line !== null);
    const delivered = await deliverToOrchestrator(
      ctx,
      [
        `Elevation ${elevationId} from worker ${worker._id} ("${worker.title}"): ${question}`,
        `Side one: ${sides[0]}`,
        `Side two: ${sides[1]}`,
        ...concerns,
        "Judge its kind and answer it through the answer pen.",
      ].join("\n"),
    );
    await logEvent(ctx, "elevation-raised", todoId, { elevationId, workerSessionId: worker._id, delivered });
    return { elevationId, delivered };
  },
});

/**
 * The orchestrator answers an elevation, naming the kind it judged it.
 *
 * Obvious: its own answer. Trade-off: the delegate's answer, read off the
 * delegate's record by the ask id rather than taken from the orchestrator's
 * words, and written as a delegate ruling; when the delegate did not rule,
 * the orchestrator's fallback stands and no ruling is written. Reserved: the
 * question goes to Tom in #tts-needs-you with the orchestrator's
 * recommendation, and his reply is the answer.
 */
export const internalAnswer = internalMutation({
  args: {
    sessionId: v.string(),
    elevationId: v.string(),
    kind: v.string(),
    answer: v.optional(v.string()),
    askId: v.optional(v.string()),
    recommendation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireLiveOrchestrator(ctx, args.sessionId);
    const id = ctx.db.normalizeId("elevations", args.elevationId);
    const elevation = id === null ? null : await ctx.db.get(id);
    if (id === null || !elevation) throw new Error(`refused: unknown elevation ${args.elevationId}`);
    if (elevation.status !== "open") throw new Error(`refused: elevation ${id} is ${elevation.status}, not open`);
    const kind = args.kind as DecisionKind;
    const answer = args.answer?.trim() || undefined;
    const now = Date.now();

    if (kind === "obvious") {
      if (answer === undefined) throw new Error("refused: an obvious decision needs its answer");
      await ctx.db.patch(id, { status: "answered", kind, answer, answeredBy: "orchestrator", answeredAt: now });
      const delivered = await deliver(ctx, elevation.workerSessionId, `Answer to your elevation ${id} (obvious; the orchestrator's): ${answer}`);
      await logEvent(ctx, "elevation-answered", elevation.todoId, { elevationId: id, kind, by: "orchestrator", delivered });
      return { status: "answered", delivered };
    }

    if (kind === "trade-off") {
      const askId = args.askId?.trim();
      if (!askId) throw new Error("refused: a trade-off names the delegate's ask id (the first line tts-ask printed)");
      const ask = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", askId))
        .first();
      const data = (ask?.data ?? {}) as { elevationId?: unknown; decision?: unknown; reason?: unknown; refused?: unknown; capped?: unknown; refusedBecause?: unknown; fallback?: unknown };
      if (!ask || data.elevationId !== id) throw new Error(`refused: ask ${askId} is not the delegate's answer to elevation ${id}`);
      // A refusal naming one of Tom's four is the delegate saying the decision
      // is reserved: only the reserved path may close it.
      if (data.refused === true && data.capped !== true && typeof data.refusedBecause === "string" && isNarrowListId(data.refusedBecause.split(" — ")[0])) {
        throw new Error(`refused: the delegate says this decision is Tom's (${data.refusedBecause}); answer it as reserved, with your recommendation`);
      }
      // Tom may object in the decision's #tts-decisions thread before this
      // answer is written; an objected decision is never recorded as standing.
      const objection = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_OBJECTION).eq("key", askId))
        .first();
      if (objection) {
        const words = (objection.data as { revert?: unknown; text?: unknown } | undefined) ?? {};
        throw new Error(
          `refused: Tom objected to the delegate's decision on ask ${askId} (${words.revert === true ? "revert" : String(words.text ?? "")}); answer the elevation again in the light of his words`,
        );
      }
      const ruled = typeof data.decision === "string" && data.refused !== true && data.capped !== true;
      if (!ruled) {
        // The fallback stands, and it is the one the ask recorded before the
        // delegate ran, never one written after its silence.
        const fallback = typeof data.fallback === "string" ? data.fallback : "";
        await ctx.db.patch(id, { status: "answered", kind, answer: fallback, answeredBy: "orchestrator", answeredAt: now, askId });
        const delivered = await deliver(
          ctx,
          elevation.workerSessionId,
          `Answer to your elevation ${id} (a trade-off the delegate did not rule on; the fallback the orchestrator gave with its ask stands): ${fallback}`,
        );
        await logEvent(ctx, "elevation-answered", elevation.todoId, { elevationId: id, kind, by: "orchestrator", askId, delegateRuled: false, delivered });
        return { status: "answered", delivered, ruling: null };
      }
      const decision = data.decision as string;
      await ctx.db.patch(id, { status: "answered", kind, answer: decision, answeredBy: "delegate", answeredAt: now, askId });
      const reason = typeof data.reason === "string" ? ` Its reason: ${data.reason}` : "";
      const delivered = await deliver(
        ctx,
        elevation.workerSessionId,
        `Answer to your elevation ${id} (a trade-off, ruled by the delegate; treat it as Tom's ruling): ${decision}.${reason}`,
      );
      const rulingId = await ctx.db.insert("dtsRulings", {
        subjectType: "elevation",
        elevationId: id,
        verdict: "answer",
        sentence: decision,
        ruledAt: now,
        ruledBy: "delegate",
        askId,
        appliedAt: now,
        applyResult: deliveryResult(delivered, elevation.workerSessionId),
      });
      await logEvent(ctx, "elevation-answered", elevation.todoId, { elevationId: id, kind, by: "delegate", askId, rulingId, delivered });
      return { status: "answered", delivered, ruling: rulingId };
    }

    if (kind === "reserved") {
      const recommendation = args.recommendation?.trim();
      if (!recommendation) throw new Error("refused: a reserved decision goes to Tom with your recommendation");
      const opened = await openElevationNeedsYou(ctx, { ...elevation, recommendation });
      if (!opened.opened) {
        // No thread, so nothing Tom can answer: the elevation stays open and
        // the orchestrator answers it again once the channel is set.
        await logEvent(ctx, "elevation-to-tom", elevation.todoId, { elevationId: id, opened: false, reason: opened.reason });
        return { status: "open", opened: false, reason: opened.reason };
      }
      await ctx.db.patch(id, { status: "waiting-on-tom", kind, recommendation });
      await deliver(
        ctx,
        elevation.workerSessionId,
        `Your elevation ${id} is Tom's to decide; it has gone to him with the orchestrator's recommendation. Carry on with everything that does not depend on it; his answer arrives as a message.`,
      );
      await logEvent(ctx, "elevation-to-tom", elevation.todoId, { elevationId: id, opened: true });
      return { status: "waiting-on-tom", opened: true };
    }

    throw new Error('refused: kind is "obvious", "trade-off" or "reserved"');
  },
});

/**
 * A reserved elevation's #tts-needs-you thread. Composed here from the
 * elevation's facts and posted through the one Slack door with the elevation
 * as its subject, so Tom's reply in it routes back to recordElevationReply.
 * Keyed on the elevation, so a retried answer opens one thread.
 */
async function openElevationNeedsYou(
  ctx: MutationCtx,
  elevation: Doc<"elevations"> & { recommendation: string },
): Promise<{ opened: boolean; reason?: string }> {
  const key = `elevation:${elevation._id}`;
  const seen = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", "needs-tom").eq("key", key))
    .first();
  // A retry after the channel was unset: the key was never written then, so
  // a marker here means a thread really exists.
  if (seen) return { opened: true };
  const channel = channelFor("needsYou");
  if (channel === null) {
    // Reported through the same door the needs-tom route uses, so #tts-broken
    // says the channel is missing for as long as it is.
    await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
      job: "tts/needs-tom",
      error: "SLACK_TTS_NEEDS_YOU_CHANNEL_ID is not set — needs-you threads are being dropped rather than posted to #tts-today. Set it (slack-design.md §5.1).",
      key: "tts/needs-tom:needs-you-channel",
    });
    return { opened: false, reason: "SLACK_TTS_NEEDS_YOU_CHANNEL_ID not configured" };
  }
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: "needs-tom",
    key,
    todoId: elevation.todoId,
    data: { key, elevationId: elevation._id, workerSessionId: elevation.workerSessionId },
  });
  const canReply = Boolean(process.env.SLACK_SIGNING_SECRET && process.env.TOM_SLACK_USER_ID);
  const facts = {
    question: elevation.question,
    sides: elevation.sides,
    recommendation: elevation.recommendation,
    workerSessionId: elevation.workerSessionId,
  };
  await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
    channel,
    text: `${renderSlack(composeElevationAsk(facts, { canReply }))}\n\n${elevationAskBody(facts)}`,
    subject: { kind: "elevation", id: elevation._id },
  });
  return { opened: true };
}

/**
 * The Slack door gave up on a reserved elevation's thread: no thread exists,
 * so nothing waits on Tom. The elevation is open again, its marker goes so a
 * second answer can open the thread, and the orchestrator is told to answer
 * it again.
 */
export async function onElevationThreadFailed(ctx: MutationCtx, elevationId: Id<"elevations">, error: string) {
  const elevation = await ctx.db.get(elevationId);
  if (!elevation || elevation.status !== "waiting-on-tom") return;
  await ctx.db.patch(elevationId, { status: "open", kind: undefined, recommendation: undefined });
  const markers = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", "needs-tom").eq("key", `elevation:${elevationId}`))
    .collect();
  for (const marker of markers) await ctx.db.delete(marker._id);
  await deliverToOrchestrator(
    ctx,
    `The #tts-needs-you thread for elevation ${elevationId} could not be posted (${error.slice(0, 200)}), so Tom never saw it. It is open again: answer it as reserved again.`,
  );
}

/**
 * Tom's reply in a reserved elevation's thread. It is his by construction:
 * the events route reaches here only for his Slack user. His words are the
 * answer, recorded as his ruling on the elevation and delivered to the worker.
 * A reply after the elevation was answered is passed to the worker as a
 * message and changes nothing recorded.
 */
export async function recordElevationReply(
  ctx: MutationCtx,
  elevationId: Id<"elevations">,
  text: string,
  at: { channel: string; ts: string; threadTs: string },
) {
  const elevation = await ctx.db.get(elevationId);
  if (!elevation) throw new Error("The elevation this thread belongs to no longer exists.");
  const answer = text.trim();
  const now = Date.now();
  if (elevation.status === "answered") {
    await deliver(ctx, elevation.workerSessionId, `Tom wrote more about your elevation ${elevationId}, already answered: ${answer}`);
    await logEvent(ctx, "tom-note", elevation.todoId, { text, ...at, elevationId });
    return { outcome: "elevation-note" as const, elevationId };
  }
  await ctx.db.patch(elevationId, { status: "answered", answer, answeredBy: "tom", answeredAt: now });
  const delivered = await deliver(ctx, elevation.workerSessionId, `Tom answered your elevation ${elevationId}: ${answer}`);
  await ctx.db.insert("dtsRulings", {
    subjectType: "elevation",
    elevationId,
    verdict: "answer",
    sentence: answer,
    ruledAt: now,
    ruledBy: "tom",
    appliedAt: now,
    applyResult: deliveryResult(delivered, elevation.workerSessionId),
  });
  await deliverToOrchestrator(ctx, `Tom answered elevation ${elevationId} (worker ${elevation.workerSessionId}): ${answer}`);
  await logEvent(ctx, "elevation-answered", elevation.todoId, { elevationId, kind: "reserved", by: "tom", delivered, ...at });
  return { outcome: "elevation-answer" as const, elevationId };
}

/**
 * Tom objected to a delegate decision (convex/ttsAsk.ts, his reply in the
 * decision's #tts-decisions thread or the morning's objection list). When the
 * decision was a delegate ruling on an elevation, his objection reverts it
 * (Tom, 2026-09-21): the ruling is marked reverted, and the worker and the
 * orchestrator are told in his words. Undoing what the worker already did on
 * the ruling is work, and the orchestrator hands it out.
 */
export async function onDelegateObjection(ctx: MutationCtx, askId: string, text: string, revert: boolean) {
  const words = revert ? "revert it" : text.trim();
  const ruling = await ctx.db.query("dtsRulings").withIndex("by_ask", (q) => q.eq("askId", askId)).first();
  if (!ruling || ruling.ruledBy !== "delegate" || ruling.elevationId === undefined) {
    await onFallbackObjection(ctx, askId, words);
    return;
  }
  const elevation = await ctx.db.get(ruling.elevationId);
  await ctx.db.patch(ruling._id, { applyResult: `reverted by Tom's objection: ${words}` });
  const note = `Tom objected to the delegate's ruling on elevation ${ruling.elevationId} ("${ruling.sentence ?? ""}"), which no longer stands: ${words}`;
  if (elevation) await deliver(ctx, elevation.workerSessionId, note);
  await deliverToOrchestrator(ctx, note);
}

/**
 * His objection to a trade-off the delegate never ruled on. The fallback the
 * ask recorded closed the elevation, and convex/ttsAsk.ts posts that fallback
 * to #tts-decisions as a decision like any other — "a no-answer is still a
 * decision Tom may object to" — so it is one he can object to, while there is
 * no ruling row to revert, because nothing ruled.
 *
 * The elevation opens again and both runs are told, which is the whole of the
 * answer: the orchestrator judges the question afresh, and answering it as a
 * trade-off on the same ask is already refused while an objection to that ask
 * stands.
 */
async function onFallbackObjection(ctx: MutationCtx, askId: string, words: string) {
  const elevation = await ctx.db.query("elevations").withIndex("by_ask", (q) => q.eq("askId", askId)).first();
  // answeredBy "orchestrator" with an ask is the fallback and nothing else: an
  // obvious answer names no ask, and a reserved one is answered by Tom.
  if (!elevation || elevation.status !== "answered" || elevation.answeredBy !== "orchestrator") return;
  const stood = elevation.answer ?? "";
  // The ask goes with the answer it no longer has. Left behind, it would
  // still name this elevation: a second objection to the same ask would then
  // reopen whatever the orchestrator had since answered, and an obvious
  // answer, which names no ask of its own, would be the one it undid.
  await ctx.db.patch(elevation._id, { status: "open", answer: undefined, answeredBy: undefined, answeredAt: undefined, askId: undefined });
  const note = `Tom objected to the fallback that stood on elevation ${elevation._id} ("${stood}"), which no longer stands: ${words}. The question is open again.`;
  await deliver(ctx, elevation.workerSessionId, note);
  await deliverToOrchestrator(ctx, note);
}

/** The state, for GET /tts/orchestrator: the row, its live workers and its
 * unanswered elevations. Read by the orchestrator itself and by a check. */
export const internalState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await orchestratorRow(ctx);
    const workers = await liveHostedWorkers(ctx);
    const elevations = await unansweredElevations(ctx);
    return {
      orchestrator: row && {
        model: row.model,
        modelReason: row.modelReason,
        documentVersion: row.documentVersion,
        leaseDeadline: row.leaseDeadline ?? null,
        crashes: row.crashes,
        restartAt: row.restartAt ?? null,
        lastRestart: row.lastRestart ?? null,
        stoppedAt: row.stoppedAt ?? null,
      },
      workers: workers.map(({ hosted, session }) => ({ sessionId: session._id, title: session.title, status: session.status, todoId: hosted.todoId ?? null })),
      elevations: elevations.map((e) => ({ id: e._id, worker: e.workerSessionId, question: e.question, sides: e.sides, status: e.status, kind: e.kind ?? null })),
    };
  },
});

// ── The prompts ──────────────────────────────────────────────────────────────

function curl(route: string, body: string): string {
  return `curl -s -X POST "$CONVEX_SITE_URL${route}" -H "X-TTS-Key: $TTS_WORKER_KEY" -H "Content-Type: application/json" -d '${body}'`;
}

/** The three decision kinds, as every hosted run is told them. */
const DECISION_KINDS_TEXT = [
  "An agent makes moves and decisions. A move is a trivial action; the transcript records it and nothing else does. A decision is one of three kinds:",
  "- Obvious: one side is clearly better. Make it, and state it in one sentence where your work is reported.",
  "- Trade-off: there is a good reason either way. It needs a ruling.",
  `- Reserved: only Tom decides it. These are exactly: ${NARROW_LIST.map((item) => item.decision).join("; ")}. An agent may give a subagent up to its own permissions and no more.`,
].join("\n");

export function buildOrchestratorPrompt(args: {
  sessionId: string;
  document: string;
  documentVersion: number;
  reason: string;
  instruction?: string;
  carried: string[];
  workers: { id: string; title: string; status: string }[];
  elevations: { id: string; worker: string; question: string; sides: string[]; status: string }[];
}): string {
  const id = args.sessionId;
  const workers = args.workers.length === 0 ? "None." : args.workers.map((w) => `- ${w.id} "${w.title}" (${w.status})`).join("\n");
  const elevations =
    args.elevations.length === 0
      ? "None."
      : args.elevations
          .map((e) => `- ${e.id} from worker ${e.worker} (${e.status === "waiting-on-tom" ? "waiting on Tom" : "open"}): ${e.question} Side one: ${e.sides[0]} Side two: ${e.sides[1]}`)
          .join("\n");
  return [
    "You are the orchestrator: the one long-lived jarvis agent on the Jarvis Box that works through Tom's todos by handing each piece of work to a hosted worker, and that answers the decisions those workers raise. You never do a worker's work yourself: you write or delegate its brief, spawn it, and judge what it asks.",
    "",
    `This run's session id is ${id}. Every pen below names it, and a pen refuses any other.`,
    "",
    "How you live. The box daemon hosts you across turns. Your workers' elevations, their messages and their endings arrive as your next turn; between turns you are idle. End each turn once you have acted on everything in front of you. Your context grows with every turn: when it is long, at your own judgment, rewrite your document with everything your successor needs, then end the turn with a final message whose last line is exactly:",
    ORCHESTRATOR_COMPACT_WORD,
    "The daemon then ends this run and starts your successor cold from the document. It does the same after a crash, so the document is your memory: keep it current.",
    "",
    "Decisions (Tom, 2026-09-21).",
    DECISION_KINDS_TEXT,
    "",
    "Workers never decide trade-offs or reserved decisions; they raise them to you as elevations, with two sides and no recommendation. You judge which kind each is and answer it:",
    "- Obvious: answer it yourself, in one sentence.",
    `- Trade-off: ask the delegate first, giving it the two sides and NO recommendation: \`tts-ask --elevation <elevation id> [--todo <the todo it concerns, when it names one>] --question "<the question>" --option "<side one>" --option "<side two>" --fallback "<what the worker should do if it does not rule>"\`. Its first line is \`DELEGATE <ask id>\`. Then answer with kind trade-off and that ask id; the record reads the delegate's answer from its own record and writes it as a delegate ruling, which every run treats as Tom's and his objection reverts. If the delegate refused it as one of Tom's four, it is reserved: answer it as reserved. If it did not answer, or its cap was spent, answer trade-off with the same ask id and the fallback you gave it stands. If Tom objected to its decision before you answered, the answer is refused with his words; answer again in their light.`,
    "- Reserved: answer with kind reserved and your recommendation. The record opens a #tts-needs-you thread for Tom, and his reply is delivered to the worker. You open a needs-you thread for nothing else.",
    "",
    "Delegating (the agent rules). Fable for anything that needs simplification or judgment, Codex for mechanical work, Opus for briefs; every spawn names its model.",
    "",
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set):",
    "",
    "1. Spawn a hosted worker on a brief (at most four live at once; a refusal says so). repos are names like \"tom.quest\"; todoId and model are optional, and the model defaults to gpt-5.6-sol:",
    "```",
    curl("/tts/spawn-worker", `{"sessionId": "${id}", "title": "<short title>", "brief": "<the whole brief>", "repos": ["tom.quest"], "todoId": "<optional>", "model": "<optional>"}`),
    "```",
    "2. Message a worker:",
    "```",
    curl("/tts/message", `{"sessionId": "${id}", "to": "<worker session id>", "text": "<message>"}`),
    "```",
    "3. Answer an elevation (kind is obvious, trade-off or reserved; send answer for obvious, askId for trade-off, recommendation for reserved):",
    "```",
    curl("/tts/answer", `{"sessionId": "${id}", "elevationId": "<id>", "kind": "<kind>", "answer": "<obvious: your answer>", "askId": "<trade-off: the ask id>", "recommendation": "<reserved: what you recommend>"}`),
    "```",
    "4. Rewrite your document (the whole document each time; it is versioned):",
    "```",
    curl("/tts/orchestrator/document", `{"sessionId": "${id}", "document": "<markdown>"}`),
    "```",
    "5. Read the live workers and the unanswered elevations at any time:",
    "```",
    `curl -s "$CONVEX_SITE_URL/tts/orchestrator" -H "X-TTS-Key: $TTS_WORKER_KEY"`,
    "```",
    "",
    `Prohibitions: never record a ruling of Tom's, never change a todo's status by hand, and never do a worker's work in this run. ${DAEMON_RESTART_SENTENCE}`,
    "",
    BOX_TOOLS_PARAGRAPH,
    "",
    `Why this run started: ${args.reason}.`,
    ...(args.instruction ? ["", "The instruction Tom started the orchestrator with (every run of it carries this until he starts it again):", args.instruction] : []),
    "",
    `Your document (version ${args.documentVersion}):`,
    "",
    args.document,
    "",
    "Live workers:",
    workers,
    "",
    "Unanswered elevations:",
    elevations,
    ...(args.carried.length > 0
      ? ["", "Messages that arrived for your previous run and were never delivered to it, oldest first:", ...args.carried.map((text) => `---\n${text}`)]
      : []),
  ].join("\n");
}

export function buildHostedWorkerPrompt(args: {
  sessionId: string;
  repos: string[];
  brief: string;
  todoId?: string;
}): string {
  const id = args.sessionId;
  const todo = args.todoId === undefined ? "" : `, "todoId": "${args.todoId}"`;
  return [
    "You are a worker the orchestrator spawned: an unattended jarvis agent on the Jarvis Box with one brief. The box daemon hosts you across turns, so the orchestrator can reach you while you work: its messages and its answers to your elevations arrive as your next turn.",
    "",
    `This run's session id is ${id}. Every pen below names it.`,
    "",
    "The brief:",
    args.brief,
    "",
    "Decisions (Tom, 2026-09-21).",
    DECISION_KINDS_TEXT,
    "",
    "Make every move and every obvious decision yourself. A trade-off or a reserved decision is never yours: raise it to the orchestrator as an elevation, with the question and its two sides and no recommendation, and never ask the delegate or Tom yourself. Then carry on with everything that does not depend on it. When nothing is left that does not depend on an open elevation, end your turn without recording an outcome; the answer arrives as your next turn.",
    "",
    "The pens (shell commands; CONVEX_SITE_URL and TTS_WORKER_KEY are already set):",
    "",
    "1. Elevate a decision:",
    "```",
    curl("/tts/elevate", `{"sessionId": "${id}", "question": "<one sentence>", "sides": ["<side one>", "<side two>"]${todo}, "runId": "<optional: a run it concerns, other than yours>"}`),
    "```",
    "2. Message the orchestrator (what you found, what you need, what you are about to do that it should know):",
    "```",
    curl("/tts/message", `{"sessionId": "${id}", "to": "orchestrator", "text": "<message>"}`),
    "```",
    sessionOutcomePen({
      sessionId: id as Id<"claudeSessions">,
      leadIn: "3. Record your outcome when the brief is done, or blocked for good:",
      summary: "one line: what landed where, and every obvious decision you made",
      after: '"completed" means the brief is done; otherwise "errored" with what blocked you. The daemon ends this run once the outcome is recorded and your turn has ended.',
      fenced: true,
    }),
    "",
    ...(args.repos.length === 0
      ? [`Prohibitions: never record a ruling and never change a status. This run has an empty scratch directory and no repository. ${DAEMON_RESTART_SENTENCE}`]
      : [
          workspaceParagraph(args.repos, id as Id<"claudeSessions">, "Do the brief's work here, code included."),
          "",
          `Prohibitions: never record a ruling and never change a status. Never push any branch other than session/${id}. ${mergeGate()}`,
        ]),
    "",
    BOX_TOOLS_PARAGRAPH,
  ].join("\n");
}
