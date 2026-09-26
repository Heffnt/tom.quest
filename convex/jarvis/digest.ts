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
} from "./outbox";

/**
 * POST /jarvis/digest's mutation: is a digest due, and if so, the digest.
 * Due from 5 a.m. New York when no digest-sent row names today's day — "at or
 * after", not "in the 5 a.m. hour", so a box that was down at 5 sends late
 * rather than skipping the day. `force` composes regardless (a test run; its
 * first line is the box's to mark).
 */
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
  args: { now: v.optional(v.number()), force: v.optional(v.boolean()) },
  handler: async (ctx, { now: givenNow, force }): Promise<ComposeAnswer> => {
    const now = givenNow ?? Date.now();
    const day = ttsDayKey(now);
    const last = digestFacts(await lastDigest(ctx));
    if (!force && nyLocalHour(now) < TTS_DIGEST_NY_HOUR) {
      return { due: false, day, reason: "before 5 a.m. New York" };
    }
    if (!force && last.day === day) return { due: false, day, reason: `the digest for ${day} went out` };
    const channel = outputChannel();
    if (channel === null) {
      // The box reports this as its job's failure; the silence alarm's
      // missing-digest line is the one Tom sees.
      return { due: false, day, reason: "SLACK_TTS_TODAY_CHANNEL_ID is not set" };
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
type PendingNeedsYou = {
  thread: { channel: string; ts: string; day: string | null } | null;
  pending: { key: string; text: string; todoId?: string; job?: string }[];
};

export const pendingNeedsYou = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now: givenNow }): Promise<PendingNeedsYou> => {
    const now = givenNow ?? Date.now();
    const thread = digestFacts(await lastDigest(ctx));
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
    return {
      thread:
        thread.channel === null || thread.ts === null
          ? null
          : { channel: thread.channel, ts: thread.ts, day: thread.day },
      pending: opened
        .filter((row) => row.subject !== undefined && !done.has(row.subject))
        .map((row) => {
          const d = (row.data ?? {}) as Record<string, unknown>;
          return {
            key: row.subject as string,
            text: row.text ?? "",
            ...(typeof d.todoId === "string" ? { todoId: d.todoId } : {}),
            ...(typeof d.job === "string" ? { job: d.job } : {}),
          };
        }),
    };
  },
});

// ── The box's two doors ─────────────────────────────────────────────────────

/** POST /jarvis/digest — body { force? }. Answers { ok, due, ... } as compose. */
export const digestRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text.trim() !== "") body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  if (body.force !== undefined && typeof body.force !== "boolean") {
    return jsonResponse(400, { error: "force, when given, is a boolean" });
  }
  const answer: ComposeAnswer = await ctx.runMutation(internal.jarvis.digest.compose, {
    ...(body.force === true ? { force: true } : {}),
  });
  return jsonResponse(200, { ok: true, ...answer });
});

/** GET /jarvis/digest/needs-you — { ok, thread, pending } as pendingNeedsYou. */
export const needsYouRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const answer: PendingNeedsYou = await ctx.runQuery(internal.jarvis.digest.pendingNeedsYou, {});
  return jsonResponse(200, { ok: true, ...answer });
});
