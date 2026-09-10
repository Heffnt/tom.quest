import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import {
  type BatchWorked,
  type Change,
  type ChangeKind,
  type RunningSession,
} from "./ttsCompose";
import { LIVE_STATUSES, TTS_BATCHES_LINK, ttsItemLink, ttsSessionLink } from "./ttsShared";

// The hourly update's FACTS. The SEND lives in convex/ttsSync.ts (a Node
// action: it does the network I/O, through the one Slack door) and the TEXT in
// convex/ttsHourlyText.ts (a pure function a test calls with hand-built facts);
// the reads here are plain queries in the default runtime.
//
// The message, every hour, 24/7, in #tts-hourly:
//   (1) what the box is running now — every live session with its kind, the
//       todo or batch it is on, and how long it has been open;
//   (2) which batches were worked since the last update — sessions opened or
//       ended in the window, and worker events, grouped by batch;
//   (3) what changed since the last update — the dtsEvents rows that are
//       captures, completions, archives, rulings, date outcomes, failures.
// When all three are empty it is ONE line, with the time, saying so.
//
// NOTHING HERE WRITES A SLACK ROW. "slack-sent" and "slack-send-failed" are
// the one door's own record (convex/ttsSync.ts postSlack → convex/ttsSlack.ts);
// the only bookkeeping this piece owns is its window marker, below.

// Per reported kind, inside the window, newest first. A window of hours holds a
// few rows of each; the cap only bites after a long outage, and because the
// read is newest-first what it drops is the OLDEST of that kind rather than the
// rows the next window will never look at again.
const PER_KIND_LIMIT = 500;
// The whole reported list, newest kept. composeHourlyUpdate lists a prefix of
// it and says how many more there are.
const CHANGES_LIMIT = 1000;

// ── One kind over a time range, on the kind-and-time index ──────────────────
// by_kind_at, ["kind", "at"]: exact on the kind, ordered by time, and blind to
// what the rows carry in `key`. A by_at read filtered by kind would not do —
// dtsEvents is busy instrumentation and past N rows such a read silently
// answers wrong.
//
// THIS USED TO READ by_kind_key WITH `key` PINNED TO UNDEFINED, which was
// exact only for as long as no row of the kind had a key — and "job-failed"
// grew one (convex/ttsJobs.ts), which would have taken every keyed failure out
// of this update without a word. A kind's rows belong to it whatever they are
// keyed on, so the read no longer mentions the key at all.
async function kindRange(
  ctx: QueryCtx,
  kind: string,
  start: number,
  end: number,
  limit: number,
): Promise<Doc<"dtsEvents">[]> {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", start).lt("at", end))
    .order("desc")
    .take(limit);
}

// ── The window this update covers ───────────────────────────────────────────
// The hourly update keeps its own marker, separate from the door's record of
// the send: the door's row says a message reached Slack, this one says which
// window has been reported. Two kinds, because a window is spent two ways:
//   hourly-update-sent      the update went out over {windowStart, windowEnd}
//   hourly-update-abandoned Slack refused for a reason it will keep refusing
//                           for, so the window is closed unreported rather
//                           than recomposed against the same refusal forever
// Both carry windowEnd, and the newest windowEnd of either is the next
// window's start — so a MISSED cron tick loses nothing: the next update simply
// covers two hours.
//
// An abandoned row of ZERO WIDTH (windowStart === windowEnd) is the third
// shape and reports nothing at all: the FIRST run was refused transiently, and
// with no marker to come back to the next run would have invented a fresh
// now-minus-an-hour and lost the older half of the refused hour. It records
// where reporting begins so the next run resumes there (convex/ttsSync.ts).
export const HOURLY_UPDATE_SENT = "hourly-update-sent";
export const HOURLY_UPDATE_ABANDONED = "hourly-update-abandoned";

// The newest rows of one marker kind. A marker is written at most once an
// hour, so a handful reaches back days.
const MARKER_SCAN = 20;

/** The END of the window the last hourly update covered, or null when there
 * has never been one. That is the next window's start.
 *
 * The marker row's `at` is stamped when the send RETURNS, after the reads;
 * using it would drop every event recorded while Slack was answering. The
 * window end the sender wrote is the number those reads actually used. */
export const internalLastHourlyWindowEnd = internalQuery({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    let best: number | null = null;
    for (const kind of [HOURLY_UPDATE_SENT, HOURLY_UPDATE_ABANDONED]) {
      // One kind, newest first, on the same kind-and-time index kindRange
      // above reads.
      const rows = await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", kind))
        .order("desc")
        .take(MARKER_SCAN);
      for (const row of rows) {
        const end = (row.data as { windowEnd?: unknown } | undefined)?.windowEnd;
        if (typeof end !== "number") continue;
        if (best === null || end > best) best = end;
        break;
      }
    }
    return best;
  },
});

// ── (1) Running now ─────────────────────────────────────────────────────────

async function subjectStatement(
  ctx: QueryCtx,
  s: Doc<"claudeSessions">,
): Promise<{ statement: string | null; batchId: Id<"batches"> | null }> {
  if (s.batchId !== undefined) {
    const batch = await ctx.db.get(s.batchId);
    return { statement: batch?.statement ?? null, batchId: s.batchId };
  }
  if (s.todoId !== undefined) {
    const todo = await ctx.db.get(s.todoId);
    return { statement: todo?.statement ?? null, batchId: todo?.batchId ?? null };
  }
  return { statement: null, batchId: null };
}

async function liveSessions(ctx: QueryCtx): Promise<Doc<"claudeSessions">[]> {
  const rows: Doc<"claudeSessions">[] = [];
  for (const status of LIVE_STATUSES) {
    rows.push(
      ...(await ctx.db
        .query("claudeSessions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()), // bounded: live sessions are few by design
    );
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export const internalRunningNow = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, { now }): Promise<RunningSession[]> => {
    const live = await liveSessions(ctx);
    return await Promise.all(
      live.map(async (s) => {
        const subject = await subjectStatement(ctx, s);
        return {
          sessionId: s._id,
          title: s.title,
          kind: s.kind,
          mode: s.mode ?? "interactive",
          status: s.status,
          statement: subject.statement,
          batchId: subject.batchId,
          elapsedMs: Math.max(0, now - s.createdAt),
        };
      }),
    );
  },
});

// ── (2) Batches worked in the window ────────────────────────────────────────
// A batch counts as worked when a session on it (directly, or through one of
// its todos) was live or ended inside the window, or a worker wrote an event
// about it. The worker event kinds are the two the box's workers write with a
// batch in reach: the planner's "graph-stored" (data.batchId) and a worker's
// "plan-repair" (todoId, whose todo names the batch).

const WORKER_EVENT_KINDS = ["graph-stored", "plan-repair"] as const;

export const internalBatchesWorked = internalQuery({
  args: { since: v.number(), now: v.number() },
  handler: async (ctx, { since, now }): Promise<BatchWorked[]> => {
    const sessions = await liveSessions(ctx);
    for (const status of ["ended", "failed"] as const) {
      sessions.push(
        ...(await ctx.db
          .query("claudeSessions")
          .withIndex("by_status", (q) =>
            q.eq("status", status).gte("statusChangedAt", since),
          )
          .collect()), // bounded by the window
      );
    }
    const byBatch = new Map<string, BatchWorked>();
    const touch = async (batchId: Id<"batches">, field: "sessions" | "workerEvents") => {
      let row = byBatch.get(batchId);
      if (row === undefined) {
        const batch = await ctx.db.get(batchId);
        row = {
          batchId,
          statement: batch?.statement ?? batchId,
          sessions: 0,
          workerEvents: 0,
        };
        byBatch.set(batchId, row);
      }
      row[field] += 1;
    };
    for (const s of sessions) {
      const { batchId } = await subjectStatement(ctx, s);
      if (batchId !== null) await touch(batchId, "sessions");
    }
    const events: Doc<"dtsEvents">[] = [];
    for (const kind of WORKER_EVENT_KINDS) {
      events.push(...(await kindRange(ctx, kind, since, now, PER_KIND_LIMIT)));
    }
    for (const e of events) {
      const data = e.data as { batchId?: unknown } | undefined;
      let batchId: Id<"batches"> | null = null;
      if (typeof data?.batchId === "string") {
        batchId = data.batchId as Id<"batches">;
      } else if (e.todoId !== undefined) {
        batchId = (await ctx.db.get(e.todoId))?.batchId ?? null;
      }
      if (batchId !== null) await touch(batchId, "workerEvents");
    }
    return [...byBatch.values()];
  },
});

// ── (3) What changed in the window ──────────────────────────────────────────

// The event kinds this update reports, each read by the ["kind","at"] index.
// A NEW reported kind is added here — including a new failure kind: matching
// every name ending in "-failed" would sweep in this update's OWN bookkeeping
// (slack-failed), which makes each rejected post a reported change, and the
// message grows by one line an hour until Slack refuses it for length.
const FAILURE_KINDS = new Set(["failure", "job-failed"]);
const REPORTED_KINDS = [
  "captured",
  "status-changed",
  "ruling",
  "date-outcome",
  "session-outcome", // only the errored ones; see below
  ...FAILURE_KINDS,
] as const;

function str(x: unknown): string | null {
  return typeof x === "string" && x.trim() !== "" ? x.trim() : null;
}

/**
 * The dtsEvents rows in [start, end) that are captures, completions,
 * archives, rulings, date outcomes, or failures — each with its link. Every
 * other kind (surfacing, queue cycles, planner bookkeeping) is instrumentation
 * and stays out of Slack. Oldest first, so the hour reads in order.
 */
export const internalChangedSince = internalQuery({
  args: { start: v.number(), end: v.number() },
  handler: async (ctx, { start, end }): Promise<Change[]> => {
    const found: Doc<"dtsEvents">[] = [];
    for (const kind of REPORTED_KINDS) {
      found.push(...(await kindRange(ctx, kind, start, end, PER_KIND_LIMIT)));
    }
    // Newest kept, then oldest first, so the hour reads in order.
    const rows = found
      .sort((a, b) => b.at - a.at)
      .slice(0, CHANGES_LIMIT)
      .reverse();
    const todoCache = new Map<string, Doc<"dtsTodos"> | null>();
    const todoOf = async (id: Id<"dtsTodos"> | undefined) => {
      if (id === undefined) return null;
      if (!todoCache.has(id)) todoCache.set(id, await ctx.db.get(id));
      return todoCache.get(id) ?? null;
    };
    const out: Change[] = [];
    for (const e of rows) {
      const data = (e.data ?? {}) as Record<string, unknown>;
      let kind: ChangeKind | null = null;
      let detail: string | null = null;
      if (e.kind === "captured") {
        kind = "captured";
        detail = str(data.source);
      } else if (e.kind === "status-changed" && data.to === "done") {
        kind = "done";
      } else if (e.kind === "status-changed" && data.to === "archived") {
        kind = "archived";
      } else if (e.kind === "ruling") {
        kind = "ruling";
        detail = [str(data.verdict), str(data.sentence)].filter(Boolean).join(": ") || null;
      } else if (e.kind === "date-outcome") {
        kind = "date-outcome";
        detail = str(data.outcome);
      } else if (
        FAILURE_KINDS.has(e.kind) ||
        (e.kind === "session-outcome" && data.outcome === "errored")
      ) {
        kind = "failure";
        detail = str(data.error) ?? str(data.summary) ?? str(data.endedReason);
      }
      if (kind === null) continue;

      const todo = await todoOf(e.todoId);
      const sessionId = str(data.sessionId);
      let text: string;
      let link: string | null;
      if (todo !== null) {
        text = todo.statement;
        link = ttsItemLink(todo._id);
      } else if (sessionId !== null) {
        text = str(data.title) ?? "session";
        link = ttsSessionLink(sessionId);
      } else if (typeof data.batchId === "string") {
        const batch = await ctx.db.get(data.batchId as Id<"batches">);
        text = batch?.statement ?? "batch";
        link = TTS_BATCHES_LINK;
      } else {
        text = e.kind;
        link = null;
      }
      out.push({ kind, at: e.at, text, detail, link });
    }
    return out;
  },
});

// ── The digest resend ───────────────────────────────────────────────────────
// The 5 a.m. digest (convex/ttsSync.ts sendDigest) marks itself with a
// "digest-sent" row {day, windowEnd} the moment its post lands, and a refused
// post leaves the door's "slack-send-failed" row carrying the composed text.
// So today's digest is owed exactly when there is no "digest-sent" row for
// today AND a failed digest row exists — and what is owed is that row's text,
// reposted UNCHANGED: the message Tom missed is the message he eventually
// gets, not a message recomposed against a different hour's facts.
//
// windowEnd comes back with it, and it is the SENDER'S number, carried on the
// failure row (convex/ttsSync.ts postSlack): the instant the composer read
// Convex up to. NOT the row's own `at`, which is stamped after composing, two
// posts and a retry pause — every event in between would then be reported by
// neither digest, because the resend would mark the day at the later instant
// and tomorrow's window would start past them. A row written before the sender
// carried the boundary has only its `at`, and falls back to it.
//
// Read defensively — these rows are two other pieces' bookkeeping.

// A day holds a handful of failed sends however busy the rest of dtsEvents is;
// this bounds the walk if something goes very wrong.
const DIGEST_FAILURE_SCAN = 50;

export const internalDigestToResend = internalQuery({
  args: { day: v.string(), dayStart: v.number(), dayEnd: v.number() },
  handler: async (
    ctx,
    { day, dayStart, dayEnd },
  ): Promise<{ text: string; windowEnd: number } | null> => {
    const sent = await kindRange(ctx, "digest-sent", dayStart, dayEnd, 5);
    if (sent.some((e) => (e.data as { day?: unknown } | undefined)?.day === day)) {
      return null;
    }
    const failures = await kindRange(
      ctx,
      "slack-send-failed",
      dayStart,
      dayEnd,
      DIGEST_FAILURE_SCAN,
    );
    for (const row of failures) {
      const data = (row.data ?? {}) as {
        subject?: { kind?: unknown; day?: unknown };
        text?: unknown;
        windowEnd?: unknown;
      };
      // "today" is the morning message's subject; "digest" is what rows
      // written before the rename carry, and a refused digest can be a day old.
      const kind = data.subject?.kind;
      if ((kind !== "today" && kind !== "digest") || data.subject?.day !== day) continue;
      const text = str(data.text);
      if (text === null) continue;
      return {
        text,
        windowEnd: typeof data.windowEnd === "number" ? data.windowEnd : row.at,
      };
    }
    return null;
  },
});

