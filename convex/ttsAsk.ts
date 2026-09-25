import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { DAY_MS } from "./ttsShared";
import { MERGE } from "./ttsMerge";
import { REMOVAL_LOOP_PR, SIMPLIFY_PROPOSAL } from "./ttsSimplify";
import { logEvent } from "./tts";
import { onDelegateObjection } from "./orchestrator";

export const DELEGATE_DECISION = "delegate-decision";
export const DELEGATE_OBJECTION = "delegate-objection";
export const DELEGATE_TIMEOUT_MS = 120_000;
export const DELEGATE_MAX_TURNS = 6;
export const DELEGATE_MAX_PER_SESSION = 5;
export const DELEGATE_MAX_PER_JOB = 3;
// A runner's cap is keyed on the RUNNER, not the step: a step lives ten
// minutes, so a per-step cap is no cap at all.
export const DELEGATE_MAX_PER_RUNNER = 5;
export const DIGEST_OBJECTION_LOOKBACK = 14;

export type ObjectionFact = {
  askId: string;
  at: number;
  todoId: string | null;
  decision: string | null;
  reason: string;
  refused: boolean;
  refusedBecause: string | null;
  fallback: string;
  subject: string | null;
  objectedAt: number | null;
};

export function objectionRank(
  // The THREE FIELDS the order reads, not a whole ObjectionFact: the morning's
  // gatherer (convex/ttsDigest.ts) holds its rows in the composer's shape,
  // where an absent todo is `undefined` rather than null, and one order must
  // serve both. Lower sorts first; ties break by `at` descending.
  objection: { refused?: boolean; todoId?: string | null; decision?: string | null },
  ready: ReadonlySet<string>,
  dueSoon: ReadonlySet<string>,
): number {
  const todoId = objection.todoId ?? null;
  if (objection.refused && todoId !== null && dueSoon.has(todoId)) return 0;
  if (objection.refused) return 1; // something is parked on him
  if (objection.decision === null || objection.decision === undefined) return 2; // no answer came back
  if (todoId !== null && dueSoon.has(todoId)) return 3;
  if (todoId !== null && ready.has(todoId)) return 4;
  if (todoId !== null) return 5;
  return 6; // a question about the run itself
}

export function stripNarrowListId(text: string): string {
  const cut = text.indexOf(" — ");
  return cut === -1 ? text.trim() : text.slice(cut + 3).trim();
}

const ASK_ARGS = {
  askId: v.string(),
  sessionId: v.optional(v.string()),
  job: v.optional(v.string()),
  runnerId: v.optional(v.string()),
  // An elevation's trade-off, asked by the orchestrator; it carries no
  // recommendation (Tom, 2026-09-21), and every other caller must send one.
  elevationId: v.optional(v.string()),
  todoId: v.optional(v.string()),
  question: v.string(),
  options: v.array(v.string()),
  recommendation: v.optional(v.string()),
  fallback: v.string(),
  decision: v.union(v.string(), v.null()),
  reason: v.string(),
  refused: v.boolean(),
  refusedBecause: v.union(v.string(), v.null()),
  model: v.string(),
  ms: v.number(),
  promptSha: v.string(),
  // THE RUN THAT TOOK THIS DECISION — the delegate run itself, so an objection
  // of Tom's in #tts-decisions can be scored against the output he objected to
  // (convex/agentLabels.ts internalLabelFromObjection reads it back off this
  // row's data). `data` is v.any(), so this is not a schema change, exactly as
  // the objectionAskIds note on tts.internalMarkDigestSent says of its own
  // field. A caller that passes no token stores none: an unregistered
  // delegate call carries no run, and the absence is never inferred into one.
  runToken: v.optional(v.string()),
};

type AskData = {
  askId: string;
  sessionId?: string;
  job?: string;
  runnerId?: string;
  elevationId?: string;
  todoId?: string;
  question: string;
  options: string[];
  recommendation?: string;
  fallback: string;
  decision: string | null;
  reason: string;
  refused: boolean;
  refusedBecause: string | null;
  model: string;
  ms: number;
  promptSha: string;
  runToken?: string;
};

/** Who asked: a session, a runner, an elevation or a job, exactly one. The
 *  cap and the count are both per caller, and both read this. */
function sameCaller(data: unknown, args: { sessionId?: string; job?: string; runnerId?: string; elevationId?: string }): boolean {
  const row = (data ?? {}) as { sessionId?: unknown; job?: unknown; runnerId?: unknown; elevationId?: unknown };
  if (args.sessionId !== undefined) return row.sessionId === args.sessionId;
  if (args.runnerId !== undefined) return row.runnerId === args.runnerId;
  if (args.elevationId !== undefined) return row.elevationId === args.elevationId;
  return row.job === args.job;
}

function capFor(args: { sessionId?: string; runnerId?: string; elevationId?: string }): number {
  if (args.sessionId !== undefined) return DELEGATE_MAX_PER_SESSION;
  if (args.runnerId !== undefined) return DELEGATE_MAX_PER_RUNNER;
  // An elevation is one more caller kind and is held to the job's cap: the
  // count needs a caller key, and a new number would be one more to keep.
  return DELEGATE_MAX_PER_JOB;
}

/** Record the completed box-side delegate call. This does not call a model:
 * Convex cannot reach the box, and the caller is already there. */
export const internalRecordAsk = internalMutation({
  args: ASK_ARGS,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", args.askId))
      .first();
    if (existing) return { id: existing._id, existing: true, attended: false, capped: false };

    const todoId = args.todoId === undefined ? undefined : ctx.db.normalizeId("dtsTodos", args.todoId);
    if (args.todoId !== undefined && todoId === null) throw new Error(`Unknown todo id: ${args.todoId}`);
    let session: Doc<"claudeSessions"> | null = null;
    if (args.sessionId !== undefined) {
      const sessionId = ctx.db.normalizeId("claudeSessions", args.sessionId);
      session = sessionId === null ? null : await ctx.db.get(sessionId);
      if (!session) throw new Error(`Unknown session id: ${args.sessionId}`);
    }

    const recent = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DELEGATE_DECISION).gte("at", Date.now() - DAY_MS))
      .take(200);
    if (args.runnerId !== undefined) {
      const runnerId = ctx.db.normalizeId("runners", args.runnerId);
      if (runnerId === null || !(await ctx.db.get(runnerId))) throw new Error(`Unknown runner id: ${args.runnerId}`);
    }
    if (args.elevationId !== undefined) {
      const elevationId = ctx.db.normalizeId("elevations", args.elevationId);
      if (elevationId === null || !(await ctx.db.get(elevationId))) throw new Error(`Unknown elevation id: ${args.elevationId}`);
      if (args.recommendation !== undefined) throw new Error("An elevation's trade-off carries no recommendation.");
    } else if (args.recommendation === undefined) {
      throw new Error("recommendation is required unless the ask is an elevation's trade-off");
    }
    const callerCount = recent.filter((event) => sameCaller(event.data, args)).length;
    const cap = capFor(args);
    const attended = session !== null && session.mode !== "autonomous";
    const capped = callerCount >= cap;
    const refused = attended ? true : args.refused;
    const refusedBecause = attended
      ? "attended-session: Tom is in this session — ask him"
      : args.refusedBecause;
    const id = await logEvent(ctx, DELEGATE_DECISION, todoId ?? undefined, {
      ...args,
      sessionId: args.sessionId ?? null,
      job: args.job ?? null,
      runnerId: args.runnerId ?? null,
      elevationId: args.elevationId ?? null,
      todoId: todoId ?? null,
      refused,
      refusedBecause,
      attended,
      capped,
    }, args.askId);

    // Posted line by line as it is recorded, so a decision is observable the
    // moment it is taken and not only at breakfast (Tom, 2026-09-09). It goes
    // through ttsSync.sendDecision — the ONE #tts-decisions door, shared with
    // the nightly job's model-of-Tom line and a ruling read out of Tom's
    // words — so the wording of a decisions line has one home
    // (ttsCompose.composeDecision) and the once-per-item-per-day claim is
    // applied to all three producers alike. That action is quiet while
    // SLACK_TTS_DECISIONS_CHANNEL_ID is unset, and the morning objection list
    // is then the whole of it. Its subject is the ask itself, never the todo:
    // a todo subject stamps slackReplyTs, which belongs to that todo's one
    // #dump thread.
    await ctx.scheduler.runAfter(0, internal.ttsSync.sendDecision, {
      askId: args.askId,
      ...(todoId === null || todoId === undefined ? {} : { todoId: todoId as string }),
      // A no-answer is still a decision Tom may object to; it is spelled out
      // rather than left null, because the composer prints one sentence.
      decision:
        attended || capped || args.decision === null
          ? args.fallback
          : args.decision,
      reason: attended || capped ? refusedBecause ?? args.reason : args.reason,
      refused: refused || capped,
      ...(refused || capped ? { refusedBecause: refusedBecause ?? args.reason } : {}),
      fallback: args.fallback,
    });
    return { id, existing: false, attended, capped };
  },
});

export const internalAskContext = internalQuery({
  args: { sessionId: v.optional(v.string()), job: v.optional(v.string()), runnerId: v.optional(v.string()), elevationId: v.optional(v.string()), todoId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const recent = await ctx.db.query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DELEGATE_DECISION).gte("at", Date.now() - DAY_MS))
      .order("desc").take(200);
    const asked = recent.filter((event) => sameCaller(event.data, args)).length;
    const todoId = args.todoId === undefined ? null : ctx.db.normalizeId("dtsTodos", args.todoId);
    const priorObjections: { askId: string; at: number; revert: boolean; sentence: string | null; decision: string | null }[] = [];
    if (todoId !== null) {
      const events = await ctx.db.query("dtsEvents").withIndex("by_todo", (q) => q.eq("todoId", todoId)).order("desc").take(100);
      for (const event of events) {
        if (event.kind !== DELEGATE_OBJECTION || priorObjections.length >= 5) continue;
        const data = (event.data ?? {}) as { askId?: unknown; revert?: unknown; sentence?: unknown };
        const askId = data.askId;
        if (typeof askId !== "string") continue;
        const decision = await ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", askId)).first();
        const decisionData = (decision?.data ?? {}) as { decision?: unknown };
        priorObjections.push({ askId, at: event.at, revert: data.revert === true, sentence: typeof data.sentence === "string" ? data.sentence : null, decision: typeof decisionData.decision === "string" ? decisionData.decision : null });
      }
    }
    return { asked, cap: capFor(args), priorObjections };
  },
});

/**
 * Tom's objection to one decision. It is his BY CONSTRUCTION: the only caller
 * is convex/ttsSlack.ts's thread-reply route, which is reached only for a
 * message it matched to TOM_SLACK_USER_ID in a thread whose subject it
 * resolved. No agent can write this row through any door.
 *
 * `n` and `day` name the digest line he answered; both are absent when the
 * objection came from the decisions channel, where a decision has its own
 * thread and no number.
 *
 * The row carries the DECISION's todoId, so it lands on that todo's own event
 * timeline — which is where internalAskContext finds it and hands it to the
 * delegate the next time anything asks about that todo. That, and nothing
 * automatic, is the whole of "supersedes": a revert does not patch the todo,
 * does not change readiness, and undoes nothing by itself. Undoing is work,
 * and work is done by a session.
 */
export const internalRecordDelegateObjection = internalMutation({
  args: {
    askId: v.string(),
    n: v.optional(v.number()),
    day: v.optional(v.string()),
    text: v.string(),
    revert: v.boolean(),
    sentence: v.union(v.string(), v.null()),
    channel: v.string(),
    ts: v.string(),
    threadTs: v.string(),
  },
  handler: async (ctx, args) => {
    // The thing objected to is a delegate decision, OR a merge: both are
    // reported in the objection list and both carry a #tts-decisions thread,
    // so both accept a "revert" (convex/ttsMerge.ts). A merge's askId is its
    // own `<repo>:<sha>` key. A simplification proposal is the third for the
    // same reason — the weekly pass reports each line it means to remove in
    // that channel and gives it a thread — and its askId is its own
    // `simplify:<id>` key (convex/ttsNightly.ts). A removal-loop pull request
    // is the fourth: its #tts-simplify thread is keyed `loop:<number>`, and a
    // reply there is what the loop rewrites the branch from.
    const subject =
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", args.askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", MERGE).eq("key", args.askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", SIMPLIFY_PROPOSAL).eq("key", args.askId))
        .first()) ??
      (await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", REMOVAL_LOOP_PR).eq("key", args.askId))
        .first());
    if (!subject) throw new Error(`Delegate decision not found: ${args.askId}`);
    const eventId = await logEvent(ctx, DELEGATE_OBJECTION, subject.todoId, args, args.askId);
    // A delegate ruling on a worker's elevation is reverted by his objection,
    // and the worker and the orchestrator are told (convex/orchestrator.ts).
    await onDelegateObjection(ctx, args.askId, args.text, args.revert);
    // AN OBJECTION IS A JUDGMENT ABOUT THE RUN THAT TOOK THE DECISION, and the
    // label writer resolves it the same way this handler just resolved the
    // subject: the decision row (or the merge row) carries the run's token.
    //
    // Scheduled rather than awaited, for the reason insertRuling gives: the
    // objection is the fact. A decision from before runs were registered
    // carries no token, and an unlinkable label must not roll back an
    // objection Tom typed into Slack — Slack has already been answered 200 and
    // will not deliver the reply again.
    await ctx.scheduler.runAfter(0, internal.agentLabels.internalLabelFromObjection, {
      eventId,
      askId: args.askId,
    });
    return eventId;
  },
});
