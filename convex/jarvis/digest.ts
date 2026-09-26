// digest.ts — the digest area: the one message out, and the needs-you replies
// under it.
//
// ONE OUTPUT CHANNEL (Tom, 2026-09-26). #dump is where his words go in; the
// output channel (outputChannel(), #tts-today until it is renamed #jarvis,
// a rename that keeps the id) is where the record reaches him. What used to
// have a room of its own is a section of the digest: the delegate's decisions
// and the merges (the objection list), the failures and recoveries (broken),
// the box changes worth his eye (box), what ran (overnight). The silence
// alarm (jobs.ts) is the one thing that posts outside the digest, because it
// fires when the box that writes the digest has gone quiet.
//
// THE BOX WRITES IT. worker/jobs/write-slack.mjs on the Jarvis box runs every
// two minutes and asks POST /jarvis/digest whether a digest is due. From 5
// a.m. New York, once per day (the day rolls at 5), the answer carries the
// deterministic digest: the missed rollover is run, the facts are gathered
// from the record and rendered (convex/ttsDigest.ts, convex/ttsCompose.ts).
// No model writes it: "A list of what ran is more trustworthy than prose
// about it" (Tom, 2026-09-26). The box posts it through its one Slack door
// (tts-lib slackPost, redaction inside) and records `digest-sent`; the hook
// below makes a reply in its thread route back (a slack-sent row) and marks
// the todos it showed as surfaced.
//
// NEEDS-YOU IS A REPLY UNDER THAT DAY'S DIGEST, one per thing only Tom can
// settle. A producer (POST /tts/needs-tom, a sign-off proposal) records
// `needs-you-opened` with the reply's text; the box's same job posts every
// opened one not yet posted as a reply in the newest digest's thread and
// records `needs-you-posted`. His reply in the thread answers the needs-you
// reply directly above it, unless it names another todo or is an objection
// (convex/ttsSlack.ts, digest case): his reply is the asker's next turn.

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { logEvent } from "../tts";
import { recordSlackSent } from "../ttsSlack";
import {
  DAY_MS,
  TTS_DIGEST_NY_HOUR,
  outputChannel,
  nyLocalHour,
  replyRouteLive,
  ttsDayKey,
  type SlackSubject,
} from "../ttsShared";
import { jarvisAuth, jsonResponse } from "./auth";
import {
  NEEDS_YOU_OPENED,
  NEEDS_YOU_POSTED,
  NEEDS_YOU_WINDOW_MS,
  digestFacts,
  lastDigest,
  recentDigests,
} from "./outbox";

/**
 * POST /jarvis/digest's mutation: is a digest due, and if so, the digest.
 * Due from 5 a.m. New York when no digest-sent row names today's day — "at or
 * after", not "in the 5 a.m. hour", so a box that was down at 5 sends late
 * rather than skipping the day. `now` is for a test.
 */
/** The one answer that is not "not due" but "cannot": no output channel. */
const NO_CHANNEL = "no-channel";

type ComposeAnswer =
  | { due: false; day: string; reason: string }
  | {
      due: true;
      day: string;
      channel: string;
      since: number;
      windowEnd: number;
      text: string;
      truncated: boolean;
      surfacedTodoIds: string[];
      objectionAskIds: string[];
      facts: unknown;
    };

export const compose = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now: givenNow }): Promise<ComposeAnswer> => {
    const now = givenNow ?? Date.now();
    const day = ttsDayKey(now);
    const last = digestFacts(await lastDigest(ctx));
    if (nyLocalHour(now) < TTS_DIGEST_NY_HOUR) {
      return { due: false, day, reason: "before 5 a.m. New York" };
    }
    if (last.day === day) return { due: false, day, reason: `the digest for ${day} went out` };
    const channel = outputChannel();
    if (channel === null) {
      // NOT "not due": the digest is due and cannot be written anywhere. The
      // route answers this as an error, so the box's run is a failure and
      // not a quiet one (Jarvis worker/jobs/write-slack.mjs).
      return { due: false, day, reason: NO_CHANNEL };
    }
    await ctx.runMutation(internal.ttsDigest.internalRollMissed, { day });
    const since = last.windowEnd ?? now - DAY_MS;
    const composed: { text: string; truncated: boolean; surfacedTodoIds: string[]; objectionAskIds: string[]; facts: unknown } =
      await ctx.runQuery(internal.ttsDigest.internalComposeToday, {
      day,
      now,
      since,
      canReply: replyRouteLive(),
    });
    return {
      due: true,
      day,
      channel,
      since,
      windowEnd: now,
      text: composed.text,
      truncated: composed.truncated,
      surfacedTodoIds: composed.surfacedTodoIds,
      objectionAskIds: composed.objectionAskIds,
      facts: composed.facts,
    };
  },
});

/** The digest-sent hook: the thread it opened routes Tom's replies (one
 *  slack-sent row with the day as subject), and every todo it showed is
 *  marked surfaced, which is what keeps a flagged capture from being said on
 *  two mornings. */
export async function onDigestSent(ctx: MutationCtx, row: Doc<"events">): Promise<{ threaded: boolean }> {
  const d = (row.data ?? {}) as Record<string, unknown>;
  const day = typeof d.day === "string" ? d.day : null;
  const surfaced = Array.isArray(d.surfacedTodoIds) ? d.surfacedTodoIds : [];
  for (const raw of surfaced) {
    const todoId = typeof raw === "string" ? ctx.db.normalizeId("dtsTodos", raw) : null;
    if (todoId !== null) await logEvent(ctx, "surfaced", todoId, { via: "digest", day });
  }
  const { channel, ts } = digestFacts(row);
  if (day === null || channel === null || ts === null) return { threaded: false };
  await recordSlackSent(ctx, {
    channel,
    ts,
    subject: { kind: "today", day },
    text: row.text ?? (typeof d.text === "string" ? d.text : ""),
  });
  return { threaded: true };
}

/** The needs-you-posted hook: his reply in the digest's thread finds the
 *  needs-you reply above it through this slack-sent row (subject: the todo,
 *  or the producer's job). */
export async function onNeedsYouPosted(ctx: MutationCtx, row: Doc<"events">): Promise<{ threaded: boolean }> {
  const d = (row.data ?? {}) as Record<string, unknown>;
  const channel = typeof d.channel === "string" ? d.channel : null;
  const ts = typeof d.ts === "string" ? d.ts : null;
  const threadTs = typeof d.threadTs === "string" ? d.threadTs : null;
  const subject = needsYouSubject(ctx, d);
  if (channel === null || ts === null || threadTs === null || subject === null) return { threaded: false };
  await recordSlackSent(ctx, { channel, ts, threadTs, subject, text: row.text ?? "" });
  return { threaded: true };
}

function needsYouSubject(ctx: MutationCtx, d: Record<string, unknown>): SlackSubject | null {
  const todoId = typeof d.todoId === "string" ? ctx.db.normalizeId("dtsTodos", d.todoId) : null;
  if (todoId !== null) return { kind: "todo", id: todoId };
  const job = typeof d.job === "string" ? d.job : null;
  return job === null ? null : { kind: "job", id: job };
}

/**
 * GET /jarvis/digest/needs-you: the thread the replies go under (the newest
 * digest) and every needs-you opened in the window and not yet posted,
 * oldest first. No digest yet means nothing is posted: the reply waits for
 * the next one.
 */
type Thread = { channel: string; ts: string; day: string | null };

type PendingNeedsYou = {
  thread: Thread | null;
  previousThread: Thread | null;
  pending: { key: string; text: string; n: number; todoId?: string; job?: string }[];
};

function threadOf(row: { data?: unknown } | undefined): Thread | null {
  const facts = digestFacts(row ?? null);
  return facts.channel === null || facts.ts === null ? null : { channel: facts.channel, ts: facts.ts, day: facts.day };
}

/**
 * ONE NUMBERING PER THREAD. The digest numbers its objection lines 1..k
 * ("revert 2"); the needs-you replies under it go on from k + 1, in the order
 * they are posted, so a number Tom types names one line of that thread and
 * nothing else (convex/ttsSlack.ts routes it). The record gives each pending
 * reply its number here, the next free one after the objection lines and the
 * replies already posted in the thread; the box writes it first ("<n> · …").
 */
export const pendingNeedsYou = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now: givenNow }): Promise<PendingNeedsYou> => {
    const now = givenNow ?? Date.now();
    const [newest, previous] = await recentDigests(ctx, 2);
    const thread = threadOf(newest);
    const from = now - NEEDS_YOU_WINDOW_MS;
    const opened = await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", NEEDS_YOU_OPENED).gte("at", from))
      .order("asc")
      .take(200);
    const posted = await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", NEEDS_YOU_POSTED).gte("at", from))
      .take(500);
    const done = new Set(posted.map((row) => row.subject));
    const objectionLines = (newest?.data as { objectionAskIds?: unknown } | undefined)?.objectionAskIds;
    const inThread = thread === null
      ? 0
      : posted.filter((row) => (row.data as { threadTs?: unknown } | undefined)?.threadTs === thread.ts).length;
    const first = (Array.isArray(objectionLines) ? objectionLines.length : 0) + inThread + 1;
    return {
      thread,
      previousThread: threadOf(previous),
      pending: opened
        .filter((row) => row.subject !== undefined && !done.has(row.subject))
        .map((row, index) => {
          const d = (row.data ?? {}) as Record<string, unknown>;
          return {
            key: row.subject as string,
            text: row.text ?? "",
            n: first + index,
            ...(typeof d.todoId === "string" ? { todoId: d.todoId } : {}),
            ...(typeof d.job === "string" ? { job: d.job } : {}),
          };
        }),
    };
  },
});

// ── The box's two doors ─────────────────────────────────────────────────────

/** POST /jarvis/digest — no body. Answers { ok, due, ... } as compose. */
export const digestRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const answer: ComposeAnswer = await ctx.runMutation(internal.jarvis.digest.compose, {});
  if (!answer.due && answer.reason === NO_CHANNEL) {
    return jsonResponse(503, {
      error: "the digest is due and has no channel: SLACK_TTS_TODAY_CHANNEL_ID (or SLACK_TTS_CHANNEL_ID) is not set",
      reason: NO_CHANNEL,
    });
  }
  return jsonResponse(200, { ok: true, ...answer });
});

/** GET /jarvis/digest/needs-you — { ok, thread, pending } as pendingNeedsYou. */
export const needsYouRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const answer: PendingNeedsYou = await ctx.runQuery(internal.jarvis.digest.pendingNeedsYou, {});
  return jsonResponse(200, { ok: true, ...answer });
});
