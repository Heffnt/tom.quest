import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { DAY_MS } from "./ttsShared";
import { logEvent } from "./tts";

export const DELEGATE_DECISION = "delegate-decision";
export const DELEGATE_OBJECTION = "delegate-objection";
export const MERGE = "merge";
export const DELEGATE_TIMEOUT_MS = 120_000;
export const DELEGATE_MAX_TURNS = 6;
export const DELEGATE_MAX_PER_SESSION = 5;
export const DELEGATE_MAX_PER_JOB = 3;
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
  objection: ObjectionFact,
  ready: ReadonlySet<string>,
  dueSoon: ReadonlySet<string>,
): number {
  if (objection.refused && objection.todoId !== null && dueSoon.has(objection.todoId)) return 0;
  if (objection.refused) return 1;
  if (objection.decision === null) return 2;
  if (objection.todoId !== null && dueSoon.has(objection.todoId)) return 3;
  if (objection.todoId !== null && ready.has(objection.todoId)) return 4;
  if (objection.todoId !== null) return 5;
  return 6;
}

export function stripNarrowListId(text: string): string {
  const cut = text.indexOf(" — ");
  return cut === -1 ? text.trim() : text.slice(cut + 3).trim();
}

const ASK_ARGS = {
  askId: v.string(),
  sessionId: v.optional(v.string()),
  job: v.optional(v.string()),
  todoId: v.optional(v.string()),
  question: v.string(),
  options: v.array(v.string()),
  recommendation: v.string(),
  fallback: v.string(),
  decision: v.union(v.string(), v.null()),
  reason: v.string(),
  refused: v.boolean(),
  refusedBecause: v.union(v.string(), v.null()),
  model: v.string(),
  ms: v.number(),
  promptSha: v.string(),
};

type AskData = {
  askId: string;
  sessionId?: string;
  job?: string;
  todoId?: string;
  question: string;
  options: string[];
  recommendation: string;
  fallback: string;
  decision: string | null;
  reason: string;
  refused: boolean;
  refusedBecause: string | null;
  model: string;
  ms: number;
  promptSha: string;
};

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
    const callerCount = recent.filter((event) => {
      const data = (event.data ?? {}) as { sessionId?: unknown; job?: unknown };
      return args.sessionId !== undefined ? data.sessionId === args.sessionId : data.job === args.job;
    }).length;
    const cap = args.sessionId === undefined ? DELEGATE_MAX_PER_JOB : DELEGATE_MAX_PER_SESSION;
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
      todoId: todoId ?? null,
      refused,
      refusedBecause,
      attended,
      capped,
    }, args.askId);

    // Posted line by line as it is recorded, so a decision is observable the
    // moment it is taken and not only at breakfast (Tom, 2026-09-09). The
    // existing Slack door is the only sender; with SLACK_TTS_DECISIONS_CHANNEL_ID
    // unset nothing is posted and the morning objection list is the whole of
    // it. The subject is the ask itself, never the todo: a todo subject stamps
    // slackReplyTs, which belongs to that todo's one #dump thread.
    const channel = process.env.SLACK_TTS_DECISIONS_CHANNEL_ID;
    if (channel) {
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
        channel,
        text: delegateDecisionSlackLine({
          askId: args.askId,
          decision: attended || capped ? null : args.decision,
          reason: attended || capped ? refusedBecause ?? args.reason : args.reason,
          refused: refused || capped,
          fallback: args.fallback,
        }),
        subject: { kind: "delegate", askId: args.askId },
      });
    }
    return { id, existing: false, attended, capped };
  },
});

/**
 * ONE decision, ONE plain line. Called here as each decision is recorded, and
 * exported so the Slack rework's composer can call it instead once that lands
 * — the wording of a decisions-channel line has one home, this one.
 *
 * The escape is deliberately local and minimal: ttsAsk is imported BY
 * ttsDigest (the objection list reads objectionRank and stripNarrowListId from
 * here), so importing that file's slackEscape back would be a cycle. The line
 * carries no link and no formatting, so the three mrkdwn characters are the
 * whole of it.
 */
export function delegateDecisionSlackLine(
  item: Pick<ObjectionFact, "askId" | "decision" | "reason" | "refused" | "fallback">,
): string {
  const plain = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
  if (item.refused) return `delegate ${item.askId}: REFUSED, parked — ${plain(item.reason)}`;
  if (item.decision === null) {
    return `delegate ${item.askId}: no answer; the caller took its fallback (${plain(item.fallback)}) — ${plain(item.reason)}`;
  }
  return `delegate ${item.askId}: ${plain(item.decision)} — ${plain(item.reason)}`;
}

export const internalAskContext = internalQuery({
  args: { sessionId: v.optional(v.string()), job: v.optional(v.string()), todoId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const recent = await ctx.db.query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DELEGATE_DECISION).gte("at", Date.now() - DAY_MS))
      .order("desc").take(200);
    const asked = recent.filter((event) => {
      const data = (event.data ?? {}) as { sessionId?: unknown; job?: unknown };
      return args.sessionId !== undefined ? data.sessionId === args.sessionId : data.job === args.job;
    }).length;
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
    return { asked, cap: args.sessionId === undefined ? DELEGATE_MAX_PER_JOB : DELEGATE_MAX_PER_SESSION, priorObjections };
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
    const decision = await ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", DELEGATE_DECISION).eq("key", args.askId)).first();
    if (!decision) throw new Error(`Delegate decision not found: ${args.askId}`);
    return await logEvent(ctx, DELEGATE_OBJECTION, decision.todoId, args, args.askId);
  },
});

/** Future merge command contract: POST /tts/merge writes exactly this event
 * after its mechanical gate passes. A merge is reported for objection, never
 * placed on the narrow list: the delegate did not make this decision. */
export const internalRecordMerge = internalMutation({
  args: { repo: v.string(), sha: v.string(), subject: v.string(), todoId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const todoId = args.todoId === undefined ? undefined : ctx.db.normalizeId("dtsTodos", args.todoId);
    if (args.todoId !== undefined && todoId === null) throw new Error(`Unknown todo id: ${args.todoId}`);
    const key = `${args.repo}:${args.sha}`;
    const existing = await ctx.db.query("dtsEvents").withIndex("by_kind_key", (q) => q.eq("kind", MERGE).eq("key", key)).first();
    if (existing) return { id: existing._id, existing: true };
    const id = await logEvent(ctx, MERGE, todoId ?? undefined, { repo: args.repo, sha: args.sha, subject: args.subject }, key);
    return { id, existing: false };
  },
});
