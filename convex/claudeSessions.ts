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
import {
  liveRulings,
  markLiveSessionRulingApplied,
  subjectKey,
} from "./dtsRulings";
import { logEvent } from "./dts";

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
    // Box load snapshot — the scheduler's load-based admission input.
    // Stored on the same throttled heartbeat writes (no extra patch cadence).
    load: v.optional(
      v.object({
        loadavg1: v.number(),
        cpus: v.number(),
        freeMemMb: v.number(),
        totalMemMb: v.number(),
        liveSessions: v.number(),
      }),
    ),
  },
  handler: async (
    ctx,
    { version, activeAccount, daemonStartedAt, lastIngestError, load },
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
          ...(load !== undefined ? { load } : {}),
          ...(lastIngestError !== undefined ? { lastIngestError } : {}),
        });
      }
    } else {
      await ctx.db.insert("claudeDaemonHealth", {
        lastSeenAt: now,
        daemonStartedAt,
        version,
        activeAccount,
        load,
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
          // Posture + subject: the daemon needs mode at claim/adopt (an
          // autonomous session gets the auto-end + wall-clock-cap path) and
          // todoId/blockCategory to name what it is working on.
          mode: s.mode,
          todoId: s.todoId,
          blockCategory: s.blockCategory,
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
          // Subagent parentage: on a tool-call emitted inside a running Task
          // subagent, the parent Task's toolUseId.
          parentToolUseId: v.optional(v.string()),
        }),
      ),
    ),
    // Daemon-stamped session outcome (the autonomous auto-end / time-cap
    // path). Applied ONLY when the session has no outcome yet — an
    // agent-recorded outcome (internalRecordOutcome) always wins over the
    // daemon's cap-path stamp.
    outcome: v.optional(
      v.union(v.literal("completed"), v.literal("errored")),
    ),
    outcomeSummary: v.optional(v.string()),
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
          parentToolUseId: row.parentToolUseId,
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
    // Daemon-stamped outcome lands ONLY on a session with no outcome yet —
    // an agent-recorded outcome always wins over the daemon's cap-path stamp.
    if (args.outcome !== undefined && session.outcome === undefined) {
      patch.outcome = args.outcome;
      if (args.outcomeSummary !== undefined) {
        patch.outcomeSummary = args.outcomeSummary;
      }
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

// ── Open tool work (P2 agent panel) ──────────────────────────────────────────
// What is this session's model DOING right now? Derived entirely from the
// finalized tool-call / tool-result rows — the transcript is the only source;
// nothing here is invented state. A Task call with no result is a running
// subagent; a background Bash call is a long-running command whose latest
// BashOutput/KillShell check is its freshest known state.

const PREVIEW_CHARS = 200;

// Tool-call/tool-result content is daemon-written v.any(); read it loosely.
type ToolCallContent = {
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
};
type ToolResultContent = {
  toolUseId?: string;
  content?: unknown;
  isError?: boolean;
};

// Flatten a tool-result content payload (a string, or an array of typed
// blocks) to plain text for previews and id matching.
function contentText(x: unknown): string {
  if (typeof x === "string") return x;
  if (Array.isArray(x)) {
    return x
      .map((b) =>
        typeof (b as { text?: unknown })?.text === "string"
          ? (b as { text: string }).text
          : JSON.stringify(b),
      )
      .join("\n");
  }
  return x === undefined ? "" : JSON.stringify(x);
}

function previewText(x: unknown): string {
  const s = contentText(x);
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + "…" : s;
}

export const getOpenToolWork = query({
  args: { sessionId: v.id("claudeSessions") },
  handler: async (ctx, { sessionId }) => {
    await requireTomId(ctx);
    const session = await ctx.db.get(sessionId);
    // A terminal session has no OPEN work by definition — empty panel.
    if (!session || !isLive(session.status)) {
      return { agents: [], commands: [], finished: [] };
    }
    // Kind-scoped index reads: only the tool rows, never the whole transcript.
    const calls = await ctx.db
      .query("claudeMessages")
      .withIndex("by_session_kind", (q) =>
        q.eq("sessionId", sessionId).eq("kind", "tool-call"),
      )
      .collect(); // seq-ascending
    const results = await ctx.db
      .query("claudeMessages")
      .withIndex("by_session_kind", (q) =>
        q.eq("sessionId", sessionId).eq("kind", "tool-result"),
      )
      .collect();
    const resultById = new Map<string, Doc<"claudeMessages">>();
    for (const r of results) {
      const id = (r.content as ToolResultContent)?.toolUseId;
      if (typeof id === "string") resultById.set(id, r);
    }
    // Newest tool-call per parent Task (calls are seq-ascending: last wins) —
    // "what is this subagent doing right now".
    const newestChildByParent = new Map<string, Doc<"claudeMessages">>();
    for (const call of calls) {
      if (call.parentToolUseId !== undefined) {
        newestChildByParent.set(call.parentToolUseId, call);
      }
    }

    type AgentEntry = {
      toolUseId: string;
      subagentType: string;
      description: string;
      startedAt: number;
      running: boolean;
      endedAt?: number;
      isError?: boolean;
      currentChild?: { toolName: string; inputPreview: string };
      // Panel-facing alias of currentChild (the agent panel reads `current`).
      current?: { toolName: string; inputPreview: string };
    };
    // A finished agent always has its result facts — required, not optional.
    type FinishedAgentEntry = AgentEntry & {
      endedAt: number;
      isError: boolean;
      durationMs: number;
      resultPreview: string;
    };
    const agents: AgentEntry[] = [];
    const finished: FinishedAgentEntry[] = [];
    type CommandEntry = {
      toolUseId: string;
      command: string;
      launchedAt: number;
      // Panel-facing alias of launchedAt.
      startedAt: number;
      launchResultText?: string;
      latestCheck?: { toolName: string; resultText: string; at: number };
    };
    const commands: CommandEntry[] = [];

    // Background-command checks: BashOutput/KillShell calls, seq-ascending.
    const checks = calls.filter((call) => {
      const name = (call.content as ToolCallContent)?.toolName;
      return name === "BashOutput" || name === "KillShell";
    });

    for (const call of calls) {
      const c = call.content as ToolCallContent;
      if (typeof c?.toolUseId !== "string") continue;
      const input = (c.input ?? {}) as Record<string, unknown>;
      const result = resultById.get(c.toolUseId);

      if (c.toolName === "Task") {
        const entry: AgentEntry = {
          toolUseId: c.toolUseId,
          subagentType:
            typeof input.subagent_type === "string" ? input.subagent_type : "",
          description:
            typeof input.description === "string" ? input.description : "",
          startedAt: call.createdAt,
          running: result === undefined,
        };
        if (result === undefined) {
          const child = newestChildByParent.get(c.toolUseId);
          if (child) {
            const cc = child.content as ToolCallContent;
            entry.currentChild = {
              toolName: cc?.toolName ?? "",
              inputPreview: previewText(cc?.input),
            };
            entry.current = entry.currentChild;
          }
          agents.push(entry);
        } else {
          finished.push({
            ...entry,
            endedAt: result.createdAt,
            isError: (result.content as ToolResultContent)?.isError === true,
            durationMs: result.createdAt - call.createdAt,
            resultPreview: previewText(
              (result.content as ToolResultContent)?.content,
            ),
          });
        }
      } else if (c.toolName === "Bash" && input.run_in_background === true) {
        const entry: CommandEntry = {
          toolUseId: c.toolUseId,
          command: typeof input.command === "string" ? input.command : "",
          launchedAt: call.createdAt,
          startedAt: call.createdAt,
        };
        if (result !== undefined) {
          // The launch result names the background id; match checks against
          // it VERBATIM (the check's own id-bearing input strings must appear
          // in this text) — invent no state.
          const launchText = contentText(
            (result.content as ToolResultContent)?.content,
          );
          entry.launchResultText = previewText(
            (result.content as ToolResultContent)?.content,
          );
          for (const check of checks) {
            if (check.createdAt < call.createdAt) continue; // predates launch
            const checkContent = check.content as ToolCallContent;
            const checkInput = (checkContent?.input ?? {}) as Record<
              string,
              unknown
            >;
            // Candidate ids: the check input's id-named string fields
            // (bash_id / shell_id / …), matched verbatim in the launch text.
            const matches = Object.entries(checkInput).some(
              ([key, value]) =>
                /id/i.test(key) &&
                typeof value === "string" &&
                value.length > 0 &&
                launchText.includes(value),
            );
            if (!matches) continue;
            const checkResult =
              typeof checkContent?.toolUseId === "string"
                ? resultById.get(checkContent.toolUseId)
                : undefined;
            // checks are seq-ascending, so the last match is the newest.
            entry.latestCheck = {
              toolName: checkContent?.toolName ?? "",
              resultText: previewText(
                (checkResult?.content as ToolResultContent)?.content,
              ),
              at: checkResult?.createdAt ?? check.createdAt,
            };
          }
        }
        commands.push(entry);
      }
    }

    // Last 10 finished agents, newest last (finished is call-order; end order
    // matches it closely enough for a panel history).
    return { agents, commands, finished: finished.slice(-10) };
  },
});

// ── Autonomous-fleet config (P3) ─────────────────────────────────────────────

// Defaults when no claudeAutoConfig row exists. enabled FALSE: the fleet runs
// nothing until the enable pen is used deliberately.
const AUTO_DEFAULTS = {
  enabled: false,
  maxLoadPerCpu: 0.8,
  minFreeMemMb: 1024,
  maxLiveAutonomous: 8,
  maxNewPerTick: 2,
} as const;

const AUTO_CONFIG_FIELDS = {
  enabled: v.boolean(),
  maxLoadPerCpu: v.number(),
  minFreeMemMb: v.number(),
  maxLiveAutonomous: v.number(),
  maxNewPerTick: v.number(),
};

async function upsertAutoConfig(
  ctx: MutationCtx,
  fields: {
    enabled: boolean;
    maxLoadPerCpu: number;
    minFreeMemMb: number;
    maxLiveAutonomous: number;
    maxNewPerTick: number;
  },
): Promise<void> {
  const existing = await ctx.db.query("claudeAutoConfig").first();
  const row = { ...fields, updatedAt: Date.now() };
  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("claudeAutoConfig", row);
  }
}

export const getAutoConfig = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    const row = await ctx.db.query("claudeAutoConfig").first();
    return row
      ? { ...row, fromDefaults: false }
      : { ...AUTO_DEFAULTS, fromDefaults: true };
  },
});

export const setAutoConfig = mutation({
  args: AUTO_CONFIG_FIELDS,
  handler: async (ctx, fields) => {
    await requireTomId(ctx);
    await upsertAutoConfig(ctx, fields);
  },
});

// The CLI pen for supervised enable at deploy:
// `npx convex run claudeSessions:internalSetAutoConfig '{"enabled": true, ...}'`
// — same upsert as setAutoConfig (which needs Tom's browser identity the box
// does not hold). Use only while supervising the first ticks.
export const internalSetAutoConfig = internalMutation({
  args: AUTO_CONFIG_FIELDS,
  handler: async (ctx, fields) => {
    await upsertAutoConfig(ctx, fields);
  },
});

// ── Autonomous mission prompt ────────────────────────────────────────────────

// Live context for one batch member, resolved by the scheduler against the
// todo collect / mirror it already holds.
type AutoMemberContext = {
  kind: "life" | "code";
  label?: string;
  statement: string;
  status: string;
};

function promptFact(label: string, value: string | undefined): string | null {
  return value && value.trim() !== "" ? `${label}: ${value}` : null;
}

// Opening prompt for an AUTONOMOUS session (house voice: the ground-up
// contract of app/lib/dts-session-prompt.ts, adapted for a session no one is
// watching live). The sessionId rides in so the outcome pen can name this
// session — the agent has no other way to learn its own id.
function buildAutoMissionPrompt(
  todo: Doc<"dtsTodos">,
  sessionId: Id<"claudeSessions">,
  members?: AutoMemberContext[],
): string {
  const lines: (string | null)[] = [
    `You are working inside TTS (Toms Todo System) in an AUTONOMOUS session — no one is watching this transcript live, and nothing you write in chat reaches anyone unless a pen (a command below) records it. Follow the ground-up contract in everything you write into the system: define terms on first use, invent no names, concrete before abstract; language is descriptive, never evaluative.`,
    "",
    `The item ("${todo.statement}"):`,
    promptFact("category", todo.category),
    promptFact("entry action", todo.entryAction),
    promptFact("work description", todo.workDescription),
    promptFact("body", todo.body),
    promptFact("brief", todo.brief),
  ];
  const plan = todo.plan ?? [];
  if (plan.length > 0) {
    lines.push("", `The plan (${plan.length} steps, in order):`);
    plan.forEach((step, i) => {
      lines.push(
        `${i + 1}. [${step.actor}, ${step.status}] ${step.text}${step.evidence ? ` (evidence: ${step.evidence})` : ""}`,
      );
    });
  }
  if (todo.members !== undefined) {
    lines.push(
      "",
      "This item is a BATCH: one grouping of several todos, so one session's worth of shared context advances all of them.",
    );
    const resolved = members ?? [];
    if (resolved.length > 0) {
      lines.push("", `The members (${resolved.length}, live statuses):`);
      for (const m of resolved) {
        lines.push(
          `- [${m.kind}${m.label ? ` ${m.label}` : ""}, ${m.status}] "${m.statement}"`,
        );
      }
    }
  }
  lines.push(
    "",
    `The goal: do every open plan step with actor "agent" that needs no repository and no Tom — research, draft, gather, and write what you produce into the item via the prepare pen below. Advance readiness to "ready-for-tom" ONLY when the remaining work genuinely needs Tom. For a batch, refine the plan and check off the agent steps you complete (always post the FULL updated plan, never a diff).`,
    "",
    "The pens (shell commands; CONVEX_SITE_URL, DTS_WORKER_KEY, and SESSIONS_WORKER_KEY are already set in this session's environment):",
    "",
    "1. Write your work into the item:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/dts/prepare-todo" -H "X-DTS-Key: $DTS_WORKER_KEY" -H "Content-Type: application/json" -d '{"id": "${todo._id}", "brief": "...", "entryAction": "...", "workDescription": "...", "readiness": "preparing", "importanceLevel": "medium", "importanceRationale": "...", "plan": [{"text": "...", "actor": "agent", "status": "open"}]}'`,
    "```",
    'Every field except "id" is optional — send only what you produced. On a batch only "plan" lands (the server skips the other fields by design).',
    "",
    "2. Record this session's outcome when the mission is done:",
    "```",
    `curl -s -X POST "$CONVEX_SITE_URL/sessions/outcome" -H "X-Sessions-Key: $SESSIONS_WORKER_KEY" -H "Content-Type: application/json" -d '{"sessionId": "${sessionId}", "outcome": "completed", "summary": "one line: what landed where"}'`,
    "```",
    '"completed" means the mission produced its artifact; otherwise record "errored" with a summary saying what blocked you.',
    "",
    "Prohibitions: never record a ruling and never change a status — verdicts and status changes are Tom's pens alone. Never touch code — this session has an EMPTY scratch directory and no repository; anything that needs code goes into the plan as an open step instead.",
    "",
    "Ending: record the outcome via the /sessions/outcome command, then simply stop responding — the daemon ends the session after your final turn.",
  );
  return lines.filter((l): l is string => l !== null).join("\n");
}

// ── Autonomous-session scheduler (P3, cron every 5 min) ──────────────────────
// Walks Tom's committed and pending work and admits up to a handful of
// autonomous groundwork sessions when — and only when — the box has headroom.
// Load-based admission is the PRIMARY throttle (Tom's ruling: no scalar cap as
// primary); a heavy session with many subagents raises loadavg and blocks new
// admissions naturally. maxLiveAutonomous is a runaway failsafe only,
// maxNewPerTick a clone-burst bound.

const AUTO_BLOCK_HORIZON_MS = 48 * 60 * 60 * 1000;
const AUTO_BACKOFF_MS = 24 * 60 * 60 * 1000;
const AUTO_CIRCUIT_WINDOW_MS = 3 * 60 * 60 * 1000;
// Usage-pressure fingerprints in an ending's own words — daemon endedReason
// or agent outcomeSummary.
const AUTO_USAGE_RE = /usage.?limit|rate.?limit|overloaded/i;

export const internalAutoSchedule = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // (a) Off unless deliberately enabled — no config row means disabled.
    const config =
      (await ctx.db.query("claudeAutoConfig").first()) ?? { ...AUTO_DEFAULTS };
    if (!config.enabled) return;

    // (b) A stale daemon cannot start sessions — admission needs a live box.
    const health = await ctx.db.query("claudeDaemonHealth").first();
    if (!health || now - health.lastSeenAt > DAEMON_STALE_MS) return;

    // (c) LOAD-BASED ADMISSION — the primary throttle: no load report, high
    // per-cpu load, or low free memory all mean no new admissions this tick.
    const load = health.load;
    if (
      !load ||
      load.cpus <= 0 ||
      load.loadavg1 / load.cpus > config.maxLoadPerCpu ||
      load.freeMemMb < config.minFreeMemMb
    ) {
      return;
    }

    // (d) Runaway failsafe: live autonomous count under the hard cap.
    const liveSessions: Doc<"claudeSessions">[] = [];
    for (const status of LIVE_STATUSES) {
      liveSessions.push(
        ...(await ctx.db
          .query("claudeSessions")
          .withIndex("by_status", (q) => q.eq("status", status))
          .collect()), // bounded: live sessions are few by design
      );
    }
    const liveAutonomous = liveSessions.filter(
      (s) => s.mode === "autonomous",
    ).length;
    if (liveAutonomous >= config.maxLiveAutonomous) return;

    // (e) Usage circuit breaker: an autonomous ending in the last 3h that
    // names usage/rate pressure means the whole tick stands down.
    const recentTerminal: Doc<"claudeSessions">[] = [];
    for (const status of ["ended", "failed"] as const) {
      recentTerminal.push(
        ...(await ctx.db
          .query("claudeSessions")
          .withIndex("by_status", (q) =>
            q.eq("status", status).gte("statusChangedAt", now - AUTO_CIRCUIT_WINDOW_MS),
          )
          .collect()),
      );
    }
    const tripped = recentTerminal.some(
      (s) =>
        s.mode === "autonomous" &&
        (AUTO_USAGE_RE.test(s.endedReason ?? "") ||
          AUTO_USAGE_RE.test(s.outcomeSummary ?? "")),
    );
    if (tripped) return;

    const capacity = Math.min(
      config.maxNewPerTick,
      config.maxLiveAutonomous - liveAutonomous,
    );
    if (capacity <= 0) return;

    // ── The work walk ────────────────────────────────────────────────────────
    const todos = await ctx.db.query("dtsTodos").collect();
    const todoById = new Map<Id<"dtsTodos">, Doc<"dtsTodos">>(
      todos.map((t) => [t._id, t]),
    );
    // Members of non-terminal batches — the batch owns them (exclusion below).
    const batchOwned = new Set<string>();
    for (const t of todos) {
      if (t.members !== undefined && t.status !== "done" && t.status !== "archived") {
        for (const m of t.members) {
          if (m.todoId !== undefined) batchOwned.add(m.todoId);
        }
      }
    }

    const hasOpenAgentStep = (t: Doc<"dtsTodos">): boolean =>
      (t.plan ?? []).some((s) => s.actor === "agent" && s.status === "open");
    const unprepared = (t: Doc<"dtsTodos">): boolean =>
      t.readiness === "unprepared" || t.readiness === "preparing";

    // Candidates in walk order; lane + blockCategory ride along for the
    // created session's kind and the scheduler event's counts.
    type Candidate = {
      todo: Doc<"dtsTodos">;
      lane: "block" | "batch" | "dated" | "condition-bound" | "whenever";
      blockCategory?: string;
    };
    const candidates: Candidate[] = [];

    // (1) Block prep: committed time starting within 48h whose subject is not
    // ready — the nearest commitments get groundwork first.
    const blocks = await ctx.db
      .query("dtsBlocks")
      .withIndex("by_start", (q) =>
        q.gte("start", now).lt("start", now + AUTO_BLOCK_HORIZON_MS),
      )
      .collect();
    for (const block of blocks) {
      if (block.todoId !== undefined) {
        const t = todoById.get(block.todoId);
        if (!t || t.status !== "active") continue;
        // Not ready: a plain todo short of ready-for-tom, or a batch with
        // open agent plan steps still to do.
        const notReady =
          t.members !== undefined
            ? hasOpenAgentStep(t)
            : t.readiness !== "ready-for-tom";
        if (notReady) candidates.push({ todo: t, lane: "block" });
      } else if (block.category !== undefined && block.category !== "code") {
        // Category block: pick the stalest unprepared todo in the category.
        const inCategory = todos.filter(
          (t) =>
            t.status === "active" &&
            t.category === block.category &&
            t.members === undefined &&
            unprepared(t),
        );
        inCategory.sort((a, b) => a.updatedAt - b.updatedAt);
        if (inCategory.length > 0) {
          candidates.push({
            todo: inCategory[0],
            lane: "block",
            blockCategory: block.category,
          });
        }
      }
    }

    // (2) Active batches with open agent plan steps, importance
    // high > medium > low > unset.
    const importanceRank = (t: Doc<"dtsTodos">): number =>
      t.importance === undefined
        ? 3
        : { high: 0, medium: 1, low: 2 }[t.importance.level];
    const batches = todos.filter(
      (t) =>
        t.members !== undefined && t.status === "active" && hasOpenAgentStep(t),
    );
    batches.sort((a, b) => importanceRank(a) - importanceRank(b));
    for (const t of batches) candidates.push({ todo: t, lane: "batch" });

    // (3) Dated actives still unprepared, soonest due first.
    const dated = todos.filter(
      (t) =>
        t.status === "active" &&
        t.members === undefined &&
        t.timingClass === "dated" &&
        unprepared(t),
    );
    dated.sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
    for (const t of dated) candidates.push({ todo: t, lane: "dated" });

    // (4) Condition-bound actives, tightest latest-safe first.
    const conditionBound = todos.filter(
      (t) =>
        t.status === "active" &&
        t.members === undefined &&
        t.timingClass === "condition-bound" &&
        unprepared(t),
    );
    conditionBound.sort(
      (a, b) => (a.latestSafeAt ?? Infinity) - (b.latestSafeAt ?? Infinity),
    );
    for (const t of conditionBound) {
      candidates.push({ todo: t, lane: "condition-bound" });
    }

    // (5) Whenever actives, stalest first.
    const whenever = todos.filter(
      (t) =>
        t.status === "active" &&
        t.members === undefined &&
        t.timingClass === "whenever" &&
        unprepared(t),
    );
    whenever.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const t of whenever) candidates.push({ todo: t, lane: "whenever" });

    // ── Per-candidate exclusions (cheapest first) ────────────────────────────
    const excluded = async (t: Doc<"dtsTodos">): Promise<boolean> => {
      // Code todos live in the mirror; their work happens in the repo.
      if (t.category === "code") return true;
      // A member of a non-terminal batch is owned by the batch.
      if (batchOwned.has(t._id)) return true;
      // A live (unapplied) ruling means Tom already spoke — do not race it;
      // a live "session" verdict must not be silently consumed by an
      // autonomous session (a real conversation was asked for).
      const rulings = await ctx.db
        .query("dtsRulings")
        .withIndex("by_todo", (q) => q.eq("todoId", t._id))
        .collect();
      const live = liveRulings(rulings).get(
        subjectKey({ subjectType: "life", todoId: t._id }),
      );
      if (live && (live.appliedAt === undefined || live.verdict === "session")) {
        return true;
      }
      // An existing live session already references this todo.
      const history = await ctx.db
        .query("claudeSessions")
        .withIndex("by_todo", (q) => q.eq("todoId", t._id))
        .collect();
      if (history.some((s) => isLive(s.status))) return true;
      // Backoff from autonomous session history (do not redo settled work):
      const auto = history
        .filter((s) => s.mode === "autonomous")
        .sort((a, b) => b.createdAt - a.createdAt);
      const newest = auto[0];
      if (newest) {
        // A recent non-completed run: wait 24h before another try.
        if (
          newest.outcome !== "completed" &&
          now - newest.statusChangedAt < AUTO_BACKOFF_MS
        ) {
          return true;
        }
        // Three straight non-completed runs: wait for the todo to change.
        if (
          auto.length >= 3 &&
          auto.slice(0, 3).every((s) => s.outcome !== "completed") &&
          t.updatedAt <= newest.createdAt
        ) {
          return true;
        }
        // Last run completed: only re-run after the todo changed since.
        if (
          newest.outcome === "completed" &&
          t.updatedAt <= newest.statusChangedAt
        ) {
          return true;
        }
      }
      return false;
    };

    // ── Admit up to `capacity` picks ─────────────────────────────────────────
    const picked = new Set<string>();
    const counts: Record<string, number> = {};
    for (const c of candidates) {
      if (picked.size >= capacity) break;
      if (picked.has(c.todo._id)) continue;
      if (await excluded(c.todo)) continue;
      picked.add(c.todo._id);
      counts[c.lane] = (counts[c.lane] ?? 0) + 1;

      const sessionId = await ctx.db.insert("claudeSessions", {
        title: "auto: " + c.todo.statement.slice(0, 60),
        // Category-block picks work a category ("block"); everything else
        // targets the one todo ("focus-item").
        kind: c.blockCategory !== undefined ? "block" : "focus-item",
        blockCategory: c.blockCategory,
        todoId: c.todo._id,
        repo: "none", // v1: groundwork only, empty scratch — never repo edits
        mode: "autonomous",
        status: "requested",
        statusChangedAt: now,
        nextSeq: 0,
        createdAt: now,
      });
      // Resolve batch members for the mission prompt (life via the collect,
      // code via the mirror).
      let members: AutoMemberContext[] | undefined;
      if (c.todo.members !== undefined) {
        members = [];
        for (const m of c.todo.members) {
          if (m.todoId !== undefined) {
            const t = todoById.get(m.todoId);
            members.push({
              kind: "life",
              statement: t?.statement ?? "(missing todo)",
              status: t?.status ?? "missing",
            });
          } else {
            const row = await ctx.db
              .query("dtsCodeTodoMirror")
              .withIndex("by_repo_external", (q) =>
                q.eq("repo", m.repo ?? "").eq("externalId", m.externalId ?? ""),
              )
              .first();
            members.push({
              kind: "code",
              label: `${m.repo} ${m.externalId}`,
              statement: row?.statement ?? "(closed upstream)",
              status: row?.status ?? "closed",
            });
          }
        }
      }
      await ctx.db.insert("claudeInbound", {
        sessionId,
        kind: "user-turn",
        text: buildAutoMissionPrompt(c.todo, sessionId, members),
        status: "pending",
        createdAt: now,
      });
      await logEvent(ctx, "auto-session-created", c.todo._id, {
        sessionId,
        todoId: c.todo._id,
      });
    }

    // Quiet when idle: the scheduler event only exists when something was
    // admitted — no-op ticks leave no trace.
    if (picked.size > 0) {
      await logEvent(ctx, "auto-session-scheduler", undefined, {
        admitted: picked.size,
        counts,
        liveAutonomousBefore: liveAutonomous,
      });
    }
  },
});
