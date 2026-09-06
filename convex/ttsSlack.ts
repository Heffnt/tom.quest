import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { logEvent } from "./tts";
import {
  SLACK_SUBJECT,
  captureReplyText,
  isLive,
  slackThreadKey,
  ttsSessionLink,
  type SlackSubject,
} from "./ttsShared";

// Slack, the Convex side (the lifeos update, phase 2). Two facts live here:
//
//  1. THE RECORD OF EVERY SEND. convex/ttsSync.ts holds the one door that
//     posts to Slack; after each post it calls recordSlackSent below, which
//     writes a dtsEvents row of kind "slack-sent" keyed by the thread the
//     message lives in, carrying the message's subject. That row is what a
//     later reply from Tom is matched against.
//
//  2. WHAT A THREADED REPLY FROM TOM DOES. The events route (convex/http.ts,
//     POST /slack/events) has already verified Slack's signature and that the
//     reply's user is TOM_SLACK_USER_ID; internalSlackThreadReply dedupes on
//     Slack's event id, finds the thread's subject, and acts on it. Nothing a
//     reply says is ever dropped: an unknown thread becomes a new todo.

// ── The record of a send ─────────────────────────────────────────────────────

const RECORD_SLACK_SENT_ARGS = {
  channel: v.string(),
  ts: v.string(),
  threadTs: v.optional(v.string()),
  subject: SLACK_SUBJECT,
  text: v.string(),
};

/**
 * One "slack-sent" row per posted message: channel, ts, the thread it lives
 * in (its own ts when it is a root), its subject, and the text as posted.
 * When the subject is a todo, the todo's slackReplyTs is stamped — the FIRST
 * reply only, never re-pointed: the reply that exists in Slack is the first
 * one (Tom's ruling 2026-08-30: exactly one reply per #dump message).
 */
export async function recordSlackSent(
  ctx: MutationCtx,
  {
    channel,
    ts,
    threadTs,
    subject,
    text,
  }: {
    channel: string;
    ts: string;
    threadTs?: string;
    subject: SlackSubject;
    text: string;
  },
): Promise<void> {
  const todoId = subject.kind === "todo" ? subject.id : undefined;
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: "slack-sent",
    key: slackThreadKey(channel, threadTs ?? ts),
    todoId,
    data: { channel, ts, threadTs, subject, text },
  });
  if (todoId !== undefined) {
    const todo = await ctx.db.get(todoId);
    if (todo && todo.slackRepliedAt === undefined) {
      await ctx.db.patch(todoId, {
        slackRepliedAt: Date.now(),
        slackReplyTs: ts,
      });
    }
  }
}

export const internalRecordSlackSent = internalMutation({
  args: RECORD_SLACK_SENT_ARGS,
  handler: async (ctx, args) => {
    await recordSlackSent(ctx, args);
  },
});

/** A send Slack refused (or that never reached Slack) is a fact too: one
 * "slack-send-failed" row with the subject, so the digest can report it. */
export const internalRecordSlackFailed = internalMutation({
  args: {
    channel: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    subject: SLACK_SUBJECT,
    error: v.string(),
  },
  handler: async (ctx, { channel, threadTs, subject, error }) => {
    await logEvent(
      ctx,
      "slack-send-failed",
      subject.kind === "todo" ? subject.id : undefined,
      { channel, threadTs, subject, error },
    );
  },
});

// The worker's reply pen (POST /tts/slack-replied): prepare-life-todos.mjs
// posted its one threaded reply and records it here. The same first-reply-only
// rule as recordSlackSent, which it goes through — so a worker send leaves the
// same "slack-sent" row as a Convex send.
export const internalMarkSlackReplied = internalMutation({
  args: { id: v.string(), replyTs: v.optional(v.string()) },
  handler: async (ctx, { id, replyTs }) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    const todo = normalized && (await ctx.db.get(normalized));
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    if (todo.slackRepliedAt !== undefined) return { alreadyReplied: true };
    if (todo.slackChannel !== undefined && replyTs !== undefined) {
      await recordSlackSent(ctx, {
        channel: todo.slackChannel,
        ts: replyTs,
        threadTs: todo.slackTs,
        subject: { kind: "todo", id: todo._id },
        text: "(posted by prepare-life-todos.mjs)",
      });
    } else {
      // No coordinates to key a thread on: stamp the guard and nothing else.
      await ctx.db.patch(todo._id, {
        slackRepliedAt: Date.now(),
        slackReplyTs: replyTs,
      });
    }
    return { alreadyReplied: false };
  },
});

// ── "done" or a bare date: the time-note path ────────────────────────────────
// A reply on a todo or digest thread that says ONLY a date, or only "done",
// is a time note (dtsTimeNotes), not a fact: worker/jobs/apply-time-notes.mjs
// reads Tom's words and moves the date through the kept-dates rules. Anything
// longer is a fact. The recognised shapes are deliberately finite — a sentence
// that happens to contain a date is still a sentence.
const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY =
  "(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)";
const DAY_NUM = "\\d{1,2}(?:st|nd|rd|th)?";
const TIME = "(?:\\s+(?:at\\s+)?\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?";
const DATE_ONLY = new RegExp(
  "^(?:" +
    [
      "\\d{4}-\\d{2}-\\d{2}",
      "\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?",
      "today|tonight|tomorrow|this weekend",
      `(?:next\\s+|this\\s+)?${WEEKDAY}`,
      "next\\s+(?:week|month|year)",
      "in\\s+\\d+\\s+(?:days?|weeks?|months?)",
      `(?:the\\s+)?${DAY_NUM}(?:\\s+of)?\\s+${MONTH}(?:\\s+\\d{4})?`,
      `${MONTH}\\s+(?:the\\s+)?${DAY_NUM}(?:,?\\s+\\d{4})?`,
    ].join("|") +
    `)${TIME}$`,
  "i",
);

/** True when the whole reply is "done" or a bare date (optionally "on"/"by"
 * first, a time after). Exported for its test. */
export function timeNoteOnlyReply(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:on|by|for)\s+/, "");
  if (normalized === "done") return true;
  return DATE_ONLY.test(normalized);
}

// ── A threaded reply from Tom ────────────────────────────────────────────────

type ThreadSubject = SlackSubject | { kind: "unknown" };

/** The newest "slack-sent" row in this thread decides its subject; a thread
 * with none is a #dump message that was captured without a recorded reply,
 * found by the todo's own slackTs; otherwise the thread is unknown. */
async function threadSubject(
  ctx: MutationCtx,
  channel: string,
  threadTs: string,
): Promise<ThreadSubject> {
  const sent = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) =>
      q.eq("kind", "slack-sent").eq("key", slackThreadKey(channel, threadTs)),
    )
    .order("desc")
    .first();
  const subject = (sent?.data as { subject?: SlackSubject } | undefined)
    ?.subject;
  if (subject !== undefined) return subject;
  const todo = await ctx.db
    .query("dtsTodos")
    .withIndex("by_slackTs", (q) => q.eq("slackTs", threadTs))
    .first();
  if (todo && (todo.slackChannel === undefined || todo.slackChannel === channel)) {
    return { kind: "todo", id: todo._id };
  }
  return { kind: "unknown" };
}

const THREAD_REPLY_ARGS = {
  eventId: v.string(),
  channel: v.string(),
  threadTs: v.string(),
  ts: v.string(),
  text: v.string(),
  user: v.string(),
};

export type ThreadReplyOutcome =
  | { outcome: "duplicate"; duplicates: number }
  | { outcome: "session-turn"; sessionId: Id<"claudeSessions"> }
  | {
      outcome: "session-reopened";
      endedSessionId: Id<"claudeSessions">;
      sessionId: Id<"claudeSessions">;
    }
  | { outcome: "time-note"; timeNoteId: Id<"dtsTimeNotes"> }
  | { outcome: "tom-note"; subject: SlackSubject }
  | { outcome: "learning-objection"; id: string }
  | { outcome: "captured"; todoId: Id<"dtsTodos"> };

/**
 * One transaction per reply event. Dedupe first (Slack delivers at least
 * once: a redelivered event_id is dropped and counted on the row that took
 * the first delivery), then route by the thread's subject:
 *   session  → the text is the session's next inbound turn; an ended session
 *              gets a NEW session of the same kind seeded with the thread,
 *              and the thread is told which one.
 *   todo     → "done" / a bare date is a time note on the todo; anything else
 *              is a "tom-note" event on the todo.
 *   digest   → the same two shapes, on the digest's day.
 *   hourly   → a "tom-note" event with the hour.
 *   learning → a "learning-objection" event with the learning change's id
 *              (phase 4's nightly job applies the inverse).
 *   unknown  → a new todo whose provenance names the thread.
 */
export async function slackThreadReplyFrom(
  ctx: MutationCtx,
  { eventId, channel, threadTs, ts, text, user }: {
    eventId: string;
    channel: string;
    threadTs: string;
    ts: string;
    text: string;
    user: string;
  },
): Promise<ThreadReplyOutcome> {
  const seen = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) =>
      q.eq("kind", "slack-event").eq("key", eventId),
    )
    .first();
  if (seen) {
    const data = (seen.data ?? {}) as Record<string, unknown>;
    const duplicates = (typeof data.duplicates === "number" ? data.duplicates : 0) + 1;
    await ctx.db.patch(seen._id, { data: { ...data, duplicates } });
    return { outcome: "duplicate", duplicates };
  }
  const trimmed = text.trim();
  const subject = await threadSubject(ctx, channel, threadTs);
  const at = { channel, ts, threadTs };
  const outcome = await routeReply(ctx, subject, trimmed, at);
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: "slack-event",
    key: eventId,
    todoId:
      subject.kind === "todo"
        ? subject.id
        : outcome.outcome === "captured"
          ? outcome.todoId
          : undefined,
    data: { ...at, user, text: trimmed, subject, outcome: outcome.outcome },
  });
  return outcome;
}

async function routeReply(
  ctx: MutationCtx,
  subject: ThreadSubject,
  text: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<ThreadReplyOutcome> {
  switch (subject.kind) {
    case "session":
      return await sessionReply(ctx, subject.id, text, at);
    case "todo": {
      if (timeNoteOnlyReply(text)) {
        const timeNoteId = await ctx.runMutation(
          internal.tts.internalCreateTimeNote,
          { text, todoId: subject.id },
        );
        return { outcome: "time-note", timeNoteId };
      }
      await logEvent(ctx, "tom-note", subject.id, { text, ...at, subject });
      return { outcome: "tom-note", subject };
    }
    case "digest": {
      if (timeNoteOnlyReply(text)) {
        const timeNoteId = await ctx.runMutation(
          internal.tts.internalCreateTimeNote,
          { text, day: subject.day },
        );
        return { outcome: "time-note", timeNoteId };
      }
      await logEvent(ctx, "tom-note", undefined, {
        text,
        ...at,
        subject,
        day: subject.day,
      });
      return { outcome: "tom-note", subject };
    }
    case "hourly":
      await logEvent(ctx, "tom-note", undefined, {
        text,
        ...at,
        subject,
        hour: subject.hour,
        day: subject.hour.slice(0, 10),
      });
      return { outcome: "tom-note", subject };
    case "learning":
      await logEvent(ctx, "learning-objection", undefined, {
        id: subject.id,
        text,
        ...at,
      });
      return { outcome: "learning-objection", id: subject.id };
    case "unknown": {
      // Nothing is lost: the reply becomes a todo whose provenance names the
      // thread it came from. No slackTs on the row — the thread root is not
      // this message, and the reply below is addressed to the thread by hand.
      const todoId = await ctx.runMutation(internal.tts.internalCapture, {
        statement: text,
        source: "slack-reply",
        provenance: `slack:thread channel=${at.channel} thread_ts=${at.threadTs} ts=${at.ts}`,
      });
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
        channel: at.channel,
        threadTs: at.threadTs,
        text: captureReplyText(text, todoId),
        subject: { kind: "todo", id: todoId },
      });
      return { outcome: "captured", todoId };
    }
  }
}

/** Live session: the reply is its next turn. Ended or failed: a new session
 * of the same kind (same subject, repos, model) seeded with the thread, and
 * one line in the thread saying so — recorded with the NEW session as its
 * subject, so the next reply in the same thread reaches the new session. */
async function sessionReply(
  ctx: MutationCtx,
  sessionId: Id<"claudeSessions">,
  text: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<ThreadReplyOutcome> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error(`Unknown session id: ${sessionId}`);
  if (isLive(session.status)) {
    await ctx.runMutation(internal.claudeSessions.internalSendMessage, {
      sessionId,
      text,
    });
    return { outcome: "session-turn", sessionId };
  }
  const newId = await ctx.runMutation(
    internal.claudeSessions.internalCreateSession,
    {
      title: session.title,
      kind: session.kind,
      repos: session.repos ?? [session.repo],
      todoId: session.todoId,
      batchId: session.batchId,
      blockCategory: session.blockCategory,
      model: session.model,
      initialPrompt: continuationPrompt(
        session,
        await threadSoFar(ctx, at.channel, at.threadTs),
        text,
      ),
    },
  );
  await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
    channel: at.channel,
    threadTs: at.threadTs,
    text: `Session "${session.title}" had ${session.status}; your reply opened a new ${session.kind} session seeded with this thread — ${ttsSessionLink(newId)}`,
    subject: { kind: "session", id: newId },
  });
  return { outcome: "session-reopened", endedSessionId: sessionId, sessionId: newId };
}

/** Every message TTS posted in this thread, oldest first, as posted. */
async function threadSoFar(
  ctx: MutationCtx,
  channel: string,
  threadTs: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) =>
      q.eq("kind", "slack-sent").eq("key", slackThreadKey(channel, threadTs)),
    )
    .order("asc")
    .take(50);
  return rows.flatMap((r) => {
    const t = (r.data as { text?: unknown } | undefined)?.text;
    return typeof t === "string" ? [t] : [];
  });
}

function continuationPrompt(
  session: Doc<"claudeSessions">,
  posted: string[],
  reply: string,
): string {
  return [
    `Tom replied in the Slack thread of session "${session.title}" (${session._id}), which had ${session.status}${
      session.outcomeSummary ? ` — its recorded outcome: ${session.outcomeSummary}` : ""
    }. This session continues that one from his reply; its transcript is at ${ttsSessionLink(session._id)}.`,
    ``,
    `The thread so far:`,
    ...posted.map((p) => `[TTS] ${p}`),
    `[Tom] ${reply}`,
  ].join("\n");
}

export const internalSlackThreadReply = internalMutation({
  args: THREAD_REPLY_ARGS,
  handler: async (ctx, args) => await slackThreadReplyFrom(ctx, args),
});
