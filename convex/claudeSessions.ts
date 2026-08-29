import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import { markLiveSessionRulingApplied } from "./dtsRulings";

// Claude Code session surface — the Convex half of the web wrapper around
// headless Claude Code sessions on the worker box. Design ratified 2026-08-28
// (first-principles, canvas explicitly NOT a precedent — steering gotcha
// canvas-code-unvalidated). Convex IS the stream: the daemon persists SDK
// events via key-authed /sessions/* routes; the browser subscribes.
//
// Ownership split (state machine): the BROWSER owns create, inbound commands
// (user-turn / interrupt / stop), permission decisions, and stale-only
// forceClose. The DAEMON owns every other transition, reported as fact.

async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "Sessions");
}

// The browser treats the daemon as unreachable when the heartbeat is older
// than this; forceClose is allowed only past this threshold (a reachable
// daemon should execute a stop command instead). 90s = 3 missed idle polls
// (the daemon's idle cadence is 30s) — review finding: 60s left only 2×
// headroom, so one transient failure plus the UI's 15s tick produced a false
// "worker unreachable" with a live Force close button. Mirrored in
// app/sessions/lib.ts (client bundle cannot import this server module).
export const DAEMON_STALE_MS = 90_000;

const LIVE_STATUSES = [
  "requested",
  "starting",
  "idle",
  "running",
  "awaiting-permission",
] as const;

function isLive(status: Doc<"claudeSessions">["status"]): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

// Un-acked permission decisions for a session, bounded: newest 25 per decided
// status, filtered to appliedAt-unset. Correct in practice because un-acked
// decisions are by construction the most recent rows (the daemon acks within
// a poll cycle); acked history beyond the window is irrelevant.
async function recentUnappliedDecisions(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"claudeSessions">,
): Promise<Doc<"claudePermissions">[]> {
  const out: Doc<"claudePermissions">[] = [];
  for (const status of ["allowed", "denied"] as const) {
    const rows = await ctx.db
      .query("claudePermissions")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", status),
      )
      .order("desc")
      .take(25);
    out.push(...rows.filter((p) => p.appliedAt === undefined));
  }
  return out;
}

async function getSessionOrThrow(
  ctx: QueryCtx | MutationCtx,
  id: Id<"claudeSessions">,
): Promise<Doc<"claudeSessions">> {
  const session = await ctx.db.get(id);
  if (!session) throw new Error("Session not found");
  return session;
}

// ── Tom-facing queries ───────────────────────────────────────────────────────

export const listSessions = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    // Newest first; the session list is human-scale (take, not collect —
    // ledger dts-collect-pagination discipline).
    return await ctx.db.query("claudeSessions").order("desc").take(100);
  },
});

export const getSession = query({
  args: { id: v.id("claudeSessions") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    return await ctx.db.get(id);
  },
});

// Finalized transcript, seq-ascending, paginated — history rows never change,
// so pages are cache-friendly forever.
export const getMessages = query({
  args: {
    sessionId: v.id("claudeSessions"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { sessionId, paginationOpts }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudeMessages")
      .withIndex("by_session_seq", (q) => q.eq("sessionId", sessionId))
      .order("desc") // newest page first; client reverses within a page
      .paginate(paginationOpts);
  },
});

// The live tail — one tiny row; the hot subscription during streaming.
export const getStreamBuf = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudeStreamBuf")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
  },
});

// Pending inbound rows double as the optimistic echo of not-yet-delivered
// user turns; the client renders them at the transcript's end.
export const getPendingInbound = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect(); // bounded: pending commands are transient and few
  },
});

export const getPendingPermissions = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("claudePermissions")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect(); // bounded: a session blocks while one is pending
  },
});

export const getDaemonHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("claudeDaemonHealth").first();
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

export const createSession = mutation({
  args: {
    title: v.string(),
    kind: v.union(
      v.literal("gate"),
      v.literal("focus-item"),
      v.literal("weekly"),
      v.literal("adhoc"),
      v.literal("block"),
    ),
    repo: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    blockCategory: v.optional(v.string()),
    initialPrompt: v.string(),
  },
  handler: async (
    ctx,
    { title, kind, repo, todoId, blockCategory, initialPrompt },
  ) => {
    await requireTomId(ctx);
    if (initialPrompt.trim() === "") throw new Error("initialPrompt is empty");
    const now = Date.now();
    const sessionId = await ctx.db.insert("claudeSessions", {
      title: title.trim() || "Untitled session",
      kind,
      repo,
      todoId,
      blockCategory: kind === "block" ? blockCategory : undefined,
      status: "requested",
      statusChangedAt: now,
      nextSeq: 0,
      createdAt: now,
    });
    // A "session" verdict is applied the moment its session exists — the
    // supersession rule lives in dtsRulings.ts, not here.
    if (todoId !== undefined) {
      await markLiveSessionRulingApplied(ctx, todoId, sessionId);
    }
    await ctx.db.insert("claudeInbound", {
      sessionId,
      kind: "user-turn",
      text: initialPrompt,
      status: "pending",
      createdAt: now,
    });
    return sessionId;
  },
});

export const sendMessage = mutation({
  args: { sessionId: v.id("claudeSessions"), text: v.string() },
  handler: async (ctx, { sessionId, text }) => {
    await requireTomId(ctx);
    const session = await getSessionOrThrow(ctx, sessionId);
    if (!isLive(session.status)) {
      throw new Error(`Session is ${session.status} — messages cannot be sent`);
    }
    if (text.trim() === "") throw new Error("Message is empty");
    await ctx.db.insert("claudeInbound", {
      sessionId,
      kind: "user-turn",
      text,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

// interrupt = stop the current turn, keep the session; stop = end the session.
export const sendControl = mutation({
  args: {
    sessionId: v.id("claudeSessions"),
    kind: v.union(v.literal("interrupt"), v.literal("stop")),
  },
  handler: async (ctx, { sessionId, kind }) => {
    await requireTomId(ctx);
    const session = await getSessionOrThrow(ctx, sessionId);
    if (!isLive(session.status)) {
      throw new Error(`Session is ${session.status}`);
    }
    // Idempotent: a same-kind control already pending is not duplicated.
    const pending = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
    if (pending.some((p) => p.kind === kind)) return;
    await ctx.db.insert("claudeInbound", {
      sessionId,
      kind,
      status: "pending",
      createdAt: Date.now(),
    });
  },
});

export const decidePermission = mutation({
  args: {
    requestId: v.string(),
    decision: v.union(v.literal("allowed"), v.literal("denied")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, decision, note }) => {
    await requireTomId(ctx);
    const row = await ctx.db
      .query("claudePermissions")
      .withIndex("by_request", (q) => q.eq("requestId", requestId))
      .first();
    if (!row) throw new Error("Permission request not found");
    // Compare-and-set: only pending → decided. A second tab's tap is a no-op.
    if (row.status !== "pending") return;
    await ctx.db.patch(row._id, {
      status: decision,
      decidedAt: Date.now(),
      decidedBy: "tom",
      note,
    });
  },
});

// Force-close is the last resort for a session whose daemon is unreachable:
// allowed ONLY when the heartbeat is stale (a reachable daemon should execute
// a stop command instead, so state stays daemon-reported fact).
export const forceClose = mutation({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    const session = await getSessionOrThrow(ctx, sessionId);
    if (!isLive(session.status)) return;
    const health = await ctx.db.query("claudeDaemonHealth").first();
    if (health && Date.now() - health.lastSeenAt < DAEMON_STALE_MS) {
      throw new Error(
        "The worker is reachable — use stop; force-close is only for a stale worker",
      );
    }
    const now = Date.now();
    await ctx.db.patch(sessionId, {
      status: "ended",
      statusChangedAt: now,
      endedReason: "force-closed by Tom; worker unconfirmed",
    });
    // Settle the orphans (review finding): nothing else ever will — a
    // force-closed session drops out of the daemon's live scan, so pending
    // rows would pin ghost "sending" bubbles and a live-looking permission
    // card forever.
    const pendingInbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
    for (const row of pendingInbound) {
      await ctx.db.patch(row._id, { status: "interrupted" });
    }
    const pendingPermissions = await ctx.db
      .query("claudePermissions")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", sessionId).eq("status", "pending"),
      )
      .collect();
    for (const row of pendingPermissions) {
      await ctx.db.patch(row._id, {
        status: "expired",
        decidedAt: now,
        decidedBy: "force-close",
      });
    }
    const buf = await ctx.db
      .query("claudeStreamBuf")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .first();
    if (buf) await ctx.db.delete(buf._id);
    // A returning daemon learns from the poll that this session is terminal
    // and kills any process it still holds for it.
  },
});

// ── Internal: daemon poll (heartbeat + full state pull) ──────────────────────
// One POST /sessions/poll per tick returns everything the daemon needs for
// every non-terminal session — full state each time, no cursors: the payload
// is small (a handful of sessions, pending rows only) and idempotent pulls
// make daemon restarts a non-event (the no-state rule).

export const internalPoll = internalMutation({
  args: {
    version: v.string(),
    activeAccount: v.optional(v.string()),
    daemonStartedAt: v.number(),
    // The daemon's report of its most recent permanently-rejected flush
    // (review finding: a dropped write must be visible on the surface, not
    // only in journald).
    lastIngestError: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { version, activeAccount, daemonStartedAt, lastIngestError },
  ) => {
    const now = Date.now();
    const health = await ctx.db.query("claudeDaemonHealth").first();
    if (health) {
      // Throttle heartbeat writes: patch at most every 10s (subscription
      // economy), but always on daemon restart or an error report.
      if (
        now - health.lastSeenAt > 10_000 ||
        health.daemonStartedAt !== daemonStartedAt ||
        lastIngestError !== undefined
      ) {
        await ctx.db.patch(health._id, {
          lastSeenAt: now,
          daemonStartedAt,
          version,
          activeAccount,
          ...(lastIngestError !== undefined ? { lastIngestError } : {}),
        });
      }
    } else {
      await ctx.db.insert("claudeDaemonHealth", {
        lastSeenAt: now,
        daemonStartedAt,
        version,
        activeAccount,
      });
    }

    const sessions: unknown[] = [];
    for (const status of LIVE_STATUSES) {
      const rows = await ctx.db
        .query("claudeSessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect(); // bounded: live sessions are few by design
      for (const s of rows) {
        const pendingInbound = await ctx.db
          .query("claudeInbound")
          .withIndex("by_session_status", (q) =>
            q.eq("sessionId", s._id).eq("status", "pending"),
          )
          .collect();
        // Decisions the daemon has not yet applied to the SDK (decided but
        // no appliedAt) — plus pending ones so a restarted daemon can
        // re-register its local promise bookkeeping. Bounded with take(25)
        // newest-first (review finding: a plain collect re-reads the
        // session's whole decision HISTORY on the hot path; un-acked rows
        // are always recent and 0-1 in number).
        const permissions = (
          await ctx.db
            .query("claudePermissions")
            .withIndex("by_session_status", (q) =>
              q.eq("sessionId", s._id).eq("status", "pending"),
            )
            .collect()
        ).concat(await recentUnappliedDecisions(ctx, s._id));
        sessions.push({
          id: s._id,
          status: s.status,
          kind: s.kind,
          title: s.title,
          repo: s.repo,
          sdkSessionId: s.sdkSessionId,
          nextSeq: s.nextSeq,
          pendingInbound,
          permissions,
        });
      }
    }
    return { now, sessions };
  },
});

// ── Internal: daemon ingest (per-session flush) ──────────────────────────────
// ONE transaction per flush (~400ms cadence while streaming). Carries any
// subset of: status transition, stream-buffer replacement, finalized message
// rows, inbound acks, permission requests/acks. The response piggybacks this
// session's pending commands + fresh decisions, which is what makes polling
// feel push-like exactly when a turn is live.

const MESSAGE_KIND = v.union(
  v.literal("user"),
  v.literal("assistant-text"),
  v.literal("thinking"),
  v.literal("tool-call"),
  v.literal("tool-result"),
  v.literal("permission"),
  v.literal("system"),
  v.literal("error"),
);

export const internalIngest = internalMutation({
  args: {
    sessionId: v.id("claudeSessions"),
    // Daemon-reported session facts (all optional — send what changed).
    status: v.optional(
      v.union(
        v.literal("starting"),
        v.literal("idle"),
        v.literal("running"),
        v.literal("awaiting-permission"),
        v.literal("ended"),
        v.literal("failed"),
      ),
    ),
    endedReason: v.optional(v.string()),
    sdkSessionId: v.optional(v.string()),
    cwd: v.optional(v.string()),
    lastSdkEventAt: v.optional(v.number()),
    // Finalized rows, seq-ascending. Rows with seq < nextSeq are dropped
    // (idempotency floor — network retries are safe blind retries).
    finalize: v.optional(
      v.array(
        v.object({
          seq: v.number(),
          turn: v.number(),
          kind: MESSAGE_KIND,
          content: v.any(),
        }),
      ),
    ),
    // Live-tail replacement; null clears it (turn boundary).
    buf: v.optional(
      v.union(
        v.object({ turn: v.number(), seq: v.number(), text: v.string() }),
        v.null(),
      ),
    ),
    inboundUpdates: v.optional(
      v.array(
        v.object({
          id: v.id("claudeInbound"),
          status: v.union(
            v.literal("delivered"),
            v.literal("done"),
            v.literal("interrupted"),
            v.literal("failed"),
          ),
        }),
      ),
    ),
    permissionRequests: v.optional(
      v.array(
        v.object({
          requestId: v.string(),
          toolName: v.string(),
          input: v.any(),
        }),
      ),
    ),
    // Daemon acks that a decision reached the SDK; also used to mark
    // pending rows expired/superseded on restart or stop.
    permissionUpdates: v.optional(
      v.array(
        v.object({
          requestId: v.string(),
          applied: v.optional(v.boolean()),
          status: v.optional(
            v.union(v.literal("superseded"), v.literal("expired")),
          ),
          decidedBy: v.optional(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const session = await getSessionOrThrow(ctx, args.sessionId);
    const now = Date.now();
    const patch: Record<string, unknown> = {};

    if (args.finalize && args.finalize.length > 0) {
      let maxSeq = session.nextSeq - 1;
      for (const row of args.finalize) {
        if (row.seq < session.nextSeq) continue; // retry replay — drop
        await ctx.db.insert("claudeMessages", {
          sessionId: args.sessionId,
          seq: row.seq,
          turn: row.turn,
          kind: row.kind,
          content: row.content,
          createdAt: now,
        });
        if (row.seq > maxSeq) maxSeq = row.seq;
      }
      patch.nextSeq = maxSeq + 1;
    }

    // Terminal sessions (forceClose is browser-owned) accept FINALIZE rows —
    // transcript completeness is nothing-is-lost — but no state: a late
    // daemon flush must not resurrect the status, overwrite the endedReason
    // that records what actually happened, or advance activity facts
    // (review finding: the guard originally covered status alone).
    const terminal = !isLive(session.status);

    if (args.buf !== undefined || terminal) {
      const existing = await ctx.db
        .query("claudeStreamBuf")
        .withIndex("by_session", (q) => q.eq("sessionId", args.sessionId))
        .first();
      if (terminal || args.buf === null) {
        if (existing) await ctx.db.delete(existing._id);
      } else if (args.buf) {
        if (existing) {
          await ctx.db.patch(existing._id, { ...args.buf, updatedAt: now });
        } else {
          await ctx.db.insert("claudeStreamBuf", {
            sessionId: args.sessionId,
            ...args.buf,
            updatedAt: now,
          });
        }
      }
    }

    if (!terminal) {
      if (args.status !== undefined && args.status !== session.status) {
        patch.status = args.status;
        patch.statusChangedAt = now;
      }
      if (args.endedReason !== undefined) patch.endedReason = args.endedReason;
      if (args.sdkSessionId !== undefined)
        patch.sdkSessionId = args.sdkSessionId;
      if (args.cwd !== undefined) patch.cwd = args.cwd;
      if (args.lastSdkEventAt !== undefined)
        patch.lastSdkEventAt = args.lastSdkEventAt;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.sessionId, patch);
    }

    for (const upd of args.inboundUpdates ?? []) {
      const row = await ctx.db.get(upd.id);
      if (row && row.sessionId === args.sessionId) {
        await ctx.db.patch(upd.id, {
          status: upd.status,
          deliveredAt: upd.status === "delivered" ? now : row.deliveredAt,
        });
      }
    }

    for (const req of args.permissionRequests ?? []) {
      const existing = await ctx.db
        .query("claudePermissions")
        .withIndex("by_request", (q) => q.eq("requestId", req.requestId))
        .first();
      if (existing) continue; // retry replay
      await ctx.db.insert("claudePermissions", {
        sessionId: args.sessionId,
        requestId: req.requestId,
        toolName: req.toolName,
        input: req.input,
        status: "pending",
        requestedAt: now,
      });
    }

    for (const upd of args.permissionUpdates ?? []) {
      const row = await ctx.db
        .query("claudePermissions")
        .withIndex("by_request", (q) => q.eq("requestId", upd.requestId))
        .first();
      if (!row || row.sessionId !== args.sessionId) continue;
      const p: Record<string, unknown> = {};
      if (upd.applied) p.appliedAt = now;
      if (upd.status !== undefined && row.status === "pending") {
        p.status = upd.status;
        p.decidedAt = now;
        p.decidedBy = upd.decidedBy ?? "daemon";
      }
      if (Object.keys(p).length > 0) await ctx.db.patch(row._id, p);
    }

    // Piggyback: this session's pending commands and undelivered decisions
    // ride back on the flush response (~400ms latency while streaming).
    const pendingInbound = await ctx.db
      .query("claudeInbound")
      .withIndex("by_session_status", (q) =>
        q.eq("sessionId", args.sessionId).eq("status", "pending"),
      )
      .collect();
    const fresh = await ctx.db.get(args.sessionId);
    const decisions = await recentUnappliedDecisions(ctx, args.sessionId);
    return {
      nextSeq: fresh?.nextSeq ?? session.nextSeq,
      sessionStatus: fresh?.status ?? session.status,
      pendingInbound,
      decisions,
    };
  },
});

// ── Session outcomes (ratified 2026-08-28) ───────────────────────────────────
// Every session ends with a written outcome record: "completed" (purpose met —
// including ending by recording rulings that hand work back to the pipeline)
// or "errored". A session with neither is in progress (resumable via
// sdkSessionId). Internal so the session agent itself can write it via
// `npx convex run claudeSessions:internalRecordOutcome` at wrap-up — the same
// pen pattern as dts.internalTriage; the daemon may also stamp "errored" on
// failures it observes.
export const internalRecordOutcome = internalMutation({
  args: {
    id: v.string(),
    outcome: v.union(v.literal("completed"), v.literal("errored")),
    summary: v.string(),
  },
  handler: async (ctx, { id, outcome, summary }) => {
    const normalized = ctx.db.normalizeId("claudeSessions", id);
    if (!normalized) throw new Error(`Unknown session id: ${id}`);
    const session = await ctx.db.get(normalized);
    if (!session) throw new Error(`Unknown session id: ${id}`);
    await ctx.db.patch(normalized, {
      outcome,
      outcomeSummary: summary.trim(),
    });
  },
});
