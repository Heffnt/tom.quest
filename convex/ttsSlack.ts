import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { applyStatusChange, logEvent } from "./tts";
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
 * "slack-send-failed" row with the subject, so the digest can report it.
 * One row per SEND, not per attempt — the door has already retried, and
 * `attempts` says how many times it tried. The row carries the composed `text`
 * because that is what a later resend posts unchanged: the message Tom missed
 * is the message he eventually gets. It carries `windowEnd` for the same
 * reason one step further out: a message composed against a window records the
 * instant it was composed against, so the resend advances the window to what
 * the text covers rather than to the hour the failure was written. */
export const internalRecordSlackFailed = internalMutation({
  args: {
    channel: v.optional(v.string()),
    threadTs: v.optional(v.string()),
    subject: SLACK_SUBJECT,
    error: v.string(),
    text: v.optional(v.string()),
    attempts: v.optional(v.number()),
    windowEnd: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { channel, threadTs, subject, error, text, attempts, windowEnd },
  ) => {
    await logEvent(
      ctx,
      "slack-send-failed",
      subject.kind === "todo" ? subject.id : undefined,
      { channel, threadTs, subject, error, text, attempts, windowEnd },
    );
  },
});

// ── One thread in #tts for a todo that needs Tom (the lifeos update, phase 6)
// ONE MESSAGE SHAPE for anything that needs him: a thread in #tts whose reply
// is the next turn. A capture poller on the Jarvis Box (poll-gmail today) that
// judges a captured item to need Tom TODAY calls POST /tts/needs-tom, which
// lands here; the message goes out through the one door in convex/ttsSync.ts
// with the todo as its subject, so his threaded reply already routes — "done"
// completes it, a bare date is a time note, anything else is a fact on the row
// (todoReply below).
//
// DEDUPED ON THE PRODUCER'S OWN ID, not on the todo. A poller's key is the
// identity of the thing it read — `gmail:message:<id>` — so the same mail can
// never open a second thread, not on a re-run, not after a lost cursor, not
// after a redeployment. The marker is an ordinary dtsEvents row keyed like the
// door's own rows; two concurrent calls with one key conflict on it in Convex
// and the retry reads the marker the winner wrote.
export const NEEDS_TOM = "needs-tom";

export const internalOpenNeedsTomThread = internalMutation({
  // todoId as a plain string, normalized here: the caller is an HTTP route
  // carrying a worker's JSON, and this is where an unknown id becomes a named
  // refusal rather than a validator error (the internalPrepareTodo pattern).
  args: { todoId: v.string(), text: v.string(), key: v.string() },
  handler: async (
    ctx,
    { todoId, text, key },
  ): Promise<{ opened: boolean; key: string }> => {
    // The todo first: a thread about a row that is not there is a message Tom
    // cannot reply to, and the marker would suppress the real one for ever.
    const id = ctx.db.normalizeId("dtsTodos", todoId);
    const todo = id === null ? null : await ctx.db.get(id);
    if (id === null || !todo) throw new Error(`Unknown todo id: ${todoId}`);
    const seen = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", NEEDS_TOM).eq("key", key))
      .first();
    if (seen) return { opened: false, key };
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: NEEDS_TOM,
      key,
      todoId: id,
      data: { key, text },
    });
    await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
      text,
      subject: { kind: "todo", id },
    });
    return { opened: true, key };
  },
});

// ── "done", a bare date, or a fact ───────────────────────────────────────────
// A reply on a todo thread that says ONLY "done" completes the todo through
// applyStatusChange — the one status writer, so the kept-dates rule resolves
// an open date the same way the page's button does. A reply that is ONLY a
// date is a time note (dtsTimeNotes): worker/jobs/apply-time-notes.mjs reads
// Tom's words and moves the date through the kept-dates rules. Anything
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

export type ReplyShape = "done" | "date" | "fact";

/** "done" when the whole reply is the word done; "date" when it is a bare
 * date (optionally "on"/"by" first, a time after); "fact" otherwise.
 * Exported for its test. */
export function replyShape(text: string): ReplyShape {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ")
    .replace(/^(?:on|by|for)\s+/, "");
  if (normalized === "done") return "done";
  return DATE_ONLY.test(normalized) ? "date" : "fact";
}

// ── A threaded reply from Tom ────────────────────────────────────────────────

type ThreadSubject = SlackSubject | { kind: "unknown" };

/**
 * A thread's subject taken WITHOUT waiting for a message to reach Slack.
 *
 * A send tells the thread its subject only once the post lands and the door
 * records it, which is a scheduled action away. That is too late for the one
 * case where a reply CREATES the thing the thread now belongs to: a reply to
 * an ended session opens the replacement, and a second reply arriving in the
 * seconds before the "continued in a new session" notice posts would find the
 * ended session still owning the thread and open a second replacement.
 *
 * So the replacement claims the thread in the same transaction that creates
 * it (sessionReply below), and this row is what the claim writes. Convex
 * serializes the two replies against it: whichever runs second reads the claim
 * — or conflicts on it and retries into reading it — and joins the session the
 * first one opened.
 *
 * Keyed like the door's own rows, on the thread, so both are one read apart.
 */
export const SLACK_THREAD_CLAIMED = "slack-thread-claimed";

/** The newest row of one kind in this thread, and the subject it names. */
async function threadRow(
  ctx: MutationCtx,
  kind: string,
  key: string,
): Promise<{ at: number; subject: SlackSubject } | null> {
  const row = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .order("desc")
    .first();
  const subject = (row?.data as { subject?: SlackSubject } | undefined)?.subject;
  return row !== null && subject !== undefined ? { at: row.at, subject } : null;
}

/** The newest record in this thread decides its subject — the door's
 * "slack-sent" row, or a claim written ahead of one. A thread with neither is
 * a #dump message that was captured without a recorded reply, found by the
 * todo's own slackTs; otherwise the thread is unknown. */
async function threadSubject(
  ctx: MutationCtx,
  channel: string,
  threadTs: string,
): Promise<ThreadSubject> {
  const key = slackThreadKey(channel, threadTs);
  const sent = await threadRow(ctx, "slack-sent", key);
  const claimed = await threadRow(ctx, SLACK_THREAD_CLAIMED, key);
  // Newest wins, so an ordinary later send in the thread still re-points it.
  const subject =
    sent === null || (claimed !== null && claimed.at > sent.at)
      ? claimed?.subject
      : sent.subject;
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
  | { outcome: "done"; todoId: Id<"dtsTodos"> }
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
 *   todo     → "done" completes the todo (applyStatusChange, the reply as the
 *              note); a bare date is a time note on the todo; anything else
 *              is a "tom-note" event on the todo.
 *   digest   → a "tom-note" event with the day — a fact, per the brief;
 *   hourly   → a "tom-note" event with the hour and day — a fact. For both,
 *              a reply that names a todo (link or id) and otherwise says only
 *              "done" or a date is that todo's reply, as above.
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
  // NOTHING IS EVER LOST. Routing runs as a sub-mutation so a throw anywhere
  // in it (a session row gone, a refused turn, a seed that fails validation)
  // rolls its writes back; the reply then takes the unknown-thread path — it
  // becomes a todo whose provenance names the thread, and the thread is
  // answered — and a "slack-reply-failed" row records what was tried. The
  // route answers 200 either way: a 500 here would make Slack retry three
  // times and then drop the event with nothing recorded.
  let outcome: ThreadReplyOutcome;
  let error: string | undefined;
  try {
    outcome = await ctx.runMutation(internal.ttsSlack.internalRouteReply, {
      subject,
      text: trimmed,
      at,
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    outcome = await captureUnknown(ctx, trimmed, at);
    await logEvent(ctx, "slack-reply-failed", outcome.todoId, {
      ...at,
      text: trimmed,
      subject,
      error,
      capturedAs: outcome.todoId,
    });
  }
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
    data: {
      ...at,
      user,
      text: trimmed,
      subject,
      outcome: outcome.outcome,
      ...(error !== undefined ? { error } : {}),
    },
  });
  return outcome;
}

const THREAD_SUBJECT = v.union(SLACK_SUBJECT, v.object({ kind: v.literal("unknown") }));

/** routeReply behind its own transaction boundary — see slackThreadReplyFrom.
 * Internal: only that function calls it. */
export const internalRouteReply = internalMutation({
  args: {
    subject: THREAD_SUBJECT,
    text: v.string(),
    at: v.object({ channel: v.string(), ts: v.string(), threadTs: v.string() }),
  },
  handler: async (ctx, { subject, text, at }): Promise<ThreadReplyOutcome> =>
    await routeReply(ctx, subject, text, at),
});

async function routeReply(
  ctx: MutationCtx,
  subject: ThreadSubject,
  text: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<ThreadReplyOutcome> {
  switch (subject.kind) {
    case "session":
      return await sessionReply(ctx, subject.id, text, at);
    case "todo":
      return await todoReply(ctx, subject.id, text, at);
    case "digest":
    case "hourly": {
      // A reply to a digest or an hourly update is a fact (the brief's
      // "captured as a fact") — the thread has no one todo for a date or a
      // "done" to land on. The one exception: a reply that NAMES a todo (its
      // link or id) and otherwise says only "done" or a date is that todo's
      // reply, exactly as if it were in the todo's own thread.
      const named = await namedTodo(ctx, text);
      if (named !== undefined) {
        const shape = replyShape(named.rest);
        if (shape !== "fact") {
          return await todoReply(ctx, named.todoId, text, at, shape);
        }
      }
      await logEvent(ctx, "tom-note", named?.todoId, {
        text,
        ...at,
        subject,
        ...(subject.kind === "digest"
          ? { day: subject.day }
          : { hour: subject.hour, day: subject.hour.slice(0, 10) }),
      });
      return { outcome: "tom-note", subject };
    }
    case "learning":
      await logEvent(ctx, "learning-objection", undefined, {
        id: subject.id,
        text,
        ...at,
      });
      return { outcome: "learning-objection", id: subject.id };
    case "unknown":
      return await captureUnknown(ctx, text, at);
  }
}

/** Nothing is lost: the reply becomes a todo whose provenance names the
 * thread it came from, and the thread gets the one capture line. No slackTs
 * on the row — the thread root is not this message, and the reply is
 * addressed to the thread by hand. Also the landing place for a reply whose
 * routing threw (slackThreadReplyFrom). */
async function captureUnknown(
  ctx: MutationCtx,
  text: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<{ outcome: "captured"; todoId: Id<"dtsTodos"> }> {
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

/** The todo a reply names — by its page link (tts?item=<id>, Slack-wrapped
 * or bare) or a bare id — and the reply with that name taken out. The first
 * token that is an existing todo's id wins; a reply naming none is undefined. */
async function namedTodo(
  ctx: MutationCtx,
  text: string,
): Promise<{ todoId: Id<"dtsTodos">; rest: string } | undefined> {
  for (const token of text.split(/\s+/)) {
    const bare = token.replace(/^<|>$/g, "").split("|")[0];
    const candidate = /[?&]item=([A-Za-z0-9]+)/.exec(bare)?.[1] ?? bare.replace(/[.,;:!)]+$/, "");
    const todoId = ctx.db.normalizeId("dtsTodos", candidate);
    if (todoId === null || !(await ctx.db.get(todoId))) continue;
    return { todoId, rest: text.replace(token, " ").replace(/\s+/g, " ").trim() };
  }
  return undefined;
}

/** A reply on a todo's thread, by its shape: "done" completes the todo, a
 * bare date is a time note on it, anything else is a fact on it. A todo that
 * is already done takes a second "done" as a fact — nothing to complete, and
 * the words are still kept. The shape is the reply's own unless the caller
 * read it off the reply with the todo's name taken out (namedTodo). */
async function todoReply(
  ctx: MutationCtx,
  todoId: Id<"dtsTodos">,
  text: string,
  at: { channel: string; ts: string; threadTs: string },
  shape: ReplyShape = replyShape(text),
): Promise<ThreadReplyOutcome> {
  const todo = await ctx.db.get(todoId);
  if (!todo) throw new Error(`Unknown todo id: ${todoId}`);
  const subject: SlackSubject = { kind: "todo", id: todoId };
  switch (shape) {
    case "done":
      if (todo.status !== "done") {
        await applyStatusChange(ctx, todo, { status: "done", note: text });
        return { outcome: "done", todoId };
      }
      break;
    case "date": {
      const timeNoteId = await ctx.runMutation(
        internal.tts.internalCreateTimeNote,
        { text, todoId },
      );
      return { outcome: "time-note", timeNoteId };
    }
    case "fact":
      break;
  }
  await logEvent(ctx, "tom-note", todoId, { text, ...at, subject });
  return { outcome: "tom-note", subject };
}

/** Live session: the reply is its next turn. Ended or failed: a new session
 * of the same kind (same subject, repos, model) seeded with the thread, which
 * takes the thread over IN THIS TRANSACTION, and one line in the thread saying
 * so.
 *
 * The claim is what makes the replacement single. Tom types two lines in a row
 * — the second lands while the first's notice is still a scheduled action — and
 * before the claim both replies read an ended session under the thread and each
 * opened its own replacement, two sessions on one thread with his words split
 * between them. The claim is written next to the session that answers for the
 * thread from now on, so the second reply is that session's next turn. Slack
 * delivery is then only the part Tom can see, not the part the fork depended on.
 *
 * The turn Tom's reply becomes is written with author "tom" on both paths:
 * the events route verified the reply's user is TOM_SLACK_USER_ID, so the
 * words are his, and a ruling in his words (POST /tts/ruling) may cite the
 * row. On the ended path the code-built seed stays "agent" and Tom's reply is
 * its own turn after it, verbatim. */
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
      author: "tom",
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
      ),
    },
  );
  // Before the turn and before the notice: the thread belongs to the new
  // session the moment the new session exists.
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: SLACK_THREAD_CLAIMED,
    key: slackThreadKey(at.channel, at.threadTs),
    data: {
      channel: at.channel,
      threadTs: at.threadTs,
      subject: { kind: "session", id: newId },
      replaces: sessionId,
    },
  });
  await ctx.runMutation(internal.claudeSessions.internalSendMessage, {
    sessionId: newId,
    text,
    author: "tom",
  });
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
): string {
  return [
    `Tom replied in the Slack thread of session "${session.title}" (${session._id}), which had ${session.status}${
      session.outcomeSummary ? ` — its recorded outcome: ${session.outcomeSummary}` : ""
    }. This session continues that one from his reply; its transcript is at ${ttsSessionLink(session._id)}.`,
    ``,
    `The thread so far, as TTS posted it:`,
    ...posted.map((p) => `[TTS] ${p}`),
    ``,
    `Tom's reply is the next turn, in his own words.`,
  ].join("\n");
}

export const internalSlackThreadReply = internalMutation({
  args: THREAD_REPLY_ARGS,
  handler: async (ctx, args) => await slackThreadReplyFrom(ctx, args),
});
