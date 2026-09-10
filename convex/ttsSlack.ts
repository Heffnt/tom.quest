import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { applyStatusChange, logEvent } from "./tts";
import { DIGEST_OBJECTION_LOOKBACK } from "./ttsAsk";
import { DIGEST_SENT } from "./ttsDigest";
import {
  SLACK_SUBJECT,
  isLive,
  slackThreadKey,
  ttsDayKey,
  ttsSessionLink,
  type SlackSubject,
} from "./ttsShared";
import {
  SLACK_CLAIMED,
  claimKey,
  composeCaptured,
  composeContinued,
  composeNeedsYou,
  needsYouFactsBlock,
  renderSlack,
  type NeedsYouFacts,
} from "./ttsCompose";
import { changeIdTokens, namedChange, withoutChangeId } from "../worker/jobs/learning-change-names.mjs";

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
/** A reply Tom typed in a thread that could not be routed (the row records
 * what was tried; the reply is captured as a todo instead). */
export const SLACK_REPLY_FAILED = "slack-reply-failed";

// ── One appearance per item per day, across channels (§2.5) ──────────────────
/** Claim an item for one ask for one TTS day. Returns false when another
 *  channel already claimed it today, and the caller then does not post.
 *  Point lookup on by_kind_key, the NEEDS_TOM marker pattern in this same
 *  file; two concurrent claims conflict on the key and the retry reads the
 *  winner's row.
 *
 *  THE DAY ROLLS AT 5 A.M. A needs-you thread opened at 19:10 does not
 *  suppress the next morning's line about the same item: they are different
 *  TTS days, and an item he ignored last night is exactly what the morning
 *  exists to re-raise.
 *
 *  `ask` is "act" or "object" (ttsCompose.SlackAsk) for the two asks that
 *  compete across channels, and "broken" for the per-job failure dedupe, which
 *  shares the mechanism and nothing else. */
export const internalClaimSlackItem = internalMutation({
  args: {
    day: v.string(),
    ask: v.string(),
    itemId: v.string(),
    channel: v.string(),
  },
  handler: async (
    ctx,
    { day, ask, itemId, channel },
  ): Promise<{ claimed: boolean; by: string | null }> => {
    const key = claimKey(day, ask as "act" | "object", itemId);
    const seen = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", SLACK_CLAIMED).eq("key", key))
      .first();
    if (seen) {
      const by = (seen.data as { channel?: unknown } | undefined)?.channel;
      return { claimed: false, by: typeof by === "string" ? by : null };
    }
    const todoId = ctx.db.normalizeId("dtsTodos", itemId);
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: SLACK_CLAIMED,
      key,
      ...(todoId === null ? {} : { todoId }),
      data: { day, ask, itemId, channel },
    });
    return { claimed: true, by: channel };
  },
});

// ── The needs-you thread ─────────────────────────────────────────────────────
// Composed HERE, from the todo and the poller's verdict, not on the box: the
// job stops writing message text and sends facts. The raw vendor subject and
// the From header never reach Slack — they stay on the needs-tom row and in
// the dedupe key, which is where they belong.
export const internalOpenNeedsTomThread = internalMutation({
  // todoId as a plain string, normalized here: the caller is an HTTP route
  // carrying a worker's JSON, and this is where an unknown id becomes a named
  // refusal rather than a validator error (the internalPrepareTodo pattern).
  args: {
    todoId: v.string(),
    // `verdict.why` from the triage — HALF A SENTENCE HE CAN READ, and the one
    // thing the old message never said.
    reason: v.string(),
    key: v.string(),
    canReply: v.optional(v.boolean()),
    channel: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { todoId, reason, key, canReply, channel },
  ): Promise<{ opened: boolean; key: string; reason?: string }> => {
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

    const facts: NeedsYouFacts = {
      todoId: id,
      statement: todo.statement,
      entryAction: todo.entryAction,
      reason,
      sourceUrl: sourceUrlOf(todo.provenance),
    };
    const day = ttsDayKey(Date.now());
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: NEEDS_TOM,
      key,
      todoId: id,
      // The provenance the message does NOT print stays on the row.
      data: { key, reason, provenance: todo.provenance, facts: needsYouFactsBlock(facts, day, canReply ?? false) },
    });

    // ONE APPEARANCE PER ITEM PER DAY. The morning message claims at 5 a.m.,
    // before any daytime channel runs, so an item it printed is already on his
    // list today and this thread is correctly suppressed; an item that arrives
    // at 9 a.m. was not in the morning message and is not suppressed.
    const claim = await ctx.runMutation(internal.ttsSlack.internalClaimSlackItem, {
      day,
      ask: "act",
      itemId: id,
      channel: "needsYou",
    });
    if (!claim.claimed) {
      return { opened: false, key, reason: `already claimed today by ${claim.by}` };
    }
    // WRITTEN, NOT FILLED IN (Tom 2026-09-09, amendment 2) — the same route the
    // morning message takes: the facts go to a draft request, the Fable run on
    // the box writes it, the verifier checks every link and number against the
    // facts, and the timeout posts this template if no accepted draft arrives.
    await ctx.runMutation(internal.ttsSlackDrafts.internalOpenSlackDraft, {
      requestId: `needs-you:${key}`,
      kind: "needs-you",
      subject: { kind: "todo", id },
      ...(channel === undefined ? {} : { channel }),
      facts: needsYouFactsBlock(facts, day, canReply ?? false),
      canReply: canReply ?? false,
      fallback: renderSlack(composeNeedsYou(facts, { canReply: canReply ?? false })),
    });
    return { opened: true, key };
  },
});

/** The message a capture came from, when its provenance carries one.
 *  worker/jobs/poll-gmail.mjs writes `gmail:message:<id> https://mail.google…`,
 *  so the first https token is the link and everything else is machine text
 *  the message must not print. */
export function sourceUrlOf(provenance: string | undefined): string | null {
  if (provenance === undefined) return null;
  const hit = provenance.match(/https:\/\/[^\s]+/);
  return hit === null ? null : hit[0];
}

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
  | { outcome: "delegate-objection"; id: string }
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
 *              "done" or a date is that todo's reply, as above; and a reply
 *              that names a model-of-Tom line by the id the digest printed
 *              is a "learning-objection" to that line.
 *   learning → a "learning-objection" event with the learning change's id
 *              (the nightly job applies the inverse the next night).
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
    await logEvent(ctx, SLACK_REPLY_FAILED, outcome.todoId, {
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
    case "today":
    case "digest":
    case "hourly": {
      // A reply to the morning message or an hourly line is a fact (the brief's
      // "captured as a fact") — the thread has no one todo for a date or a
      // "done" to land on. The one exception: a reply that NAMES a todo (its
      // link or id) and otherwise says only "done" or a date is that todo's
      // reply, exactly as if it were in the todo's own thread. A reply that
      // names a model-of-Tom line by its id is an objection to that line —
      // the nightly job applies the inverse the next night. BOTH CAN BE
      // TRUE OF ONE REPLY — "<todo id> done [<change id>]" — and both then
      // happen: the objection is written first, and the todo's part is read
      // with the change's name taken out, so the "done" is still a "done".
      // The objection branch runs FIRST. The two grammars cannot collide — a
      // learning id is hex, an objection number is one or two digits and
      // anchored at the start — and running first keeps the precedence
      // obvious. Both can be true of one reply, and both then happen.
      const objectedDecision =
        subject.kind === "today" || subject.kind === "digest"
          ? await namedObjection(ctx, text, subject.day, at)
          : undefined;
      const objected = await namedLearningChange(ctx, text);
      if (objected !== undefined) {
        await logEvent(ctx, "learning-objection", undefined, {
          id: objected,
          text,
          ...at,
          subject,
        });
      }
      const named = await namedTodo(ctx, text);
      if (named !== undefined) {
        const rest = objected === undefined ? named.rest : withoutChangeId(named.rest, objected);
        const shape = replyShape(rest);
        if (shape !== "fact") {
          return await todoReply(ctx, named.todoId, text, at, shape);
        }
      }
      if (objectedDecision !== undefined) {
        return { outcome: "delegate-objection", id: objectedDecision };
      }
      if (objected !== undefined) return { outcome: "learning-objection", id: objected };
      await logEvent(ctx, "tom-note", named?.todoId, {
        text,
        ...at,
        subject,
        ...(subject.kind === "hourly"
          ? { hour: subject.hour, day: subject.hour.slice(0, 10) }
          : { day: subject.day }),
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
    case "ask": {
      // THE THREAD IS THE DECISION, so no number is parsed: a reply in a
      // decisions-channel thread is an objection to that ONE decision. A reply
      // that opens with "revert" says "not that"; anything else says what
      // instead. Silence, here as in the morning message, means it stands.
      //
      // Same row, same askId key as the morning message's numbered branch
      // (namedObjection below) — two doors, ONE implementation: ttsAsk's
      // mutation is the only writer, so an objection always lands on the
      // decision's own todo timeline, where internalAskContext reads it back.
      const revert = /^revert\b[.!]?/i.test(text.trim());
      const sentence = revert ? null : text.trim() === "" ? null : text.trim();
      await ctx.runMutation(internal.ttsAsk.internalRecordDelegateObjection, {
        askId: subject.id,
        text,
        revert,
        sentence,
        ...at,
      });
      return { outcome: "delegate-objection", id: subject.id };
    }
    case "job":
      // A reply about a failure is a fact, and nothing else: the failure is
      // the box's to fix, not a row with a status Tom can set.
      await logEvent(ctx, "tom-note", undefined, { text, ...at, subject, job: subject.id });
      return { outcome: "tom-note", subject };
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
    text: renderSlack(composeCaptured({ todoId, statement: text })),
    subject: { kind: "todo", id: todoId },
  });
  return { outcome: "captured", todoId };
}

/** The todo a reply names — by its page link (tts?item=<id>, Slack-wrapped
 * or bare) or a bare id — and the reply with that name taken out. The first
 * token that is an existing todo's id wins; a reply naming none is undefined. */
// How many recent rows of EACH kind — model-of-Tom changes, repository-rule
// proposals — a reply's id is matched against: weeks of nights on both,
// inside Slack's 3-second budget.
export const LEARNING_CHANGE_LOOKBACK = 500;

/**
 * The full id of the model-of-Tom line, or of the repository-rule proposal, a
 * reply names — if any. What a name is — the digest's `[<id>]`, or a bare
 * prefix of it — is one rule in worker/jobs/learning-change-names.mjs, the
 * nightly job's too; the token is checked against the recent rows, so a commit
 * hash printed in the same digest, or a word spelled in hex letters, names
 * nothing.
 *
 * BOTH SETS ARE SEARCHED. The digest prints repository-rule proposals beside
 * the model-of-Tom lines and a proposal's id is the same length and alphabet
 * by construction, so a reply naming one reads exactly like a reply naming the
 * other: it is an objection to that proposal, which the nightly job drops
 * before the line ever reaches the repository. The row this writes stays a
 * "learning-objection" either way — the job tells a proposal id from a change
 * id by looking it up, and the reply does not have to know which it named.
 */
async function namedLearningChange(ctx: MutationCtx, text: string): Promise<string | undefined> {
  const tokens = changeIdTokens(text);
  if (tokens.length === 0) return undefined;
  const recentOfKind = async (kind: string) =>
    (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => q.eq("kind", kind))
        .order("desc")
        .take(LEARNING_CHANGE_LOOKBACK)
    ).map((row) => (row.data ?? {}) as { id?: unknown });
  const hit = namedChange(tokens, [
    ...(await recentOfKind("learning-change")),
    ...(await recentOfKind("repo-proposal")),
  ]);
  return typeof hit?.id === "string" ? hit.id : undefined;
}

/**
 * The objection grammar, in two forms, both ANCHORED at the start of the
 * reply and case-insensitive:
 *
 *   "revert 2" / "Revert 2."   → { n: 2, revert: true,  sentence: null }
 *   "2: leave it Wednesday"    → { n: 2, revert: false, sentence: "leave it Wednesday" }
 *
 * Anything else is null. Anchored, so a reply that merely CONTAINS a number
 * ("see item 2 in the list", "2 done") is a fact, not an objection.
 */
export function parseObjectionReply(
  text: string,
): { n: number; revert: boolean; sentence: string | null } | null {
  const t = text.trim();
  const revert = /^revert\s+(\d{1,2})\b[.!]?\s*$/i.exec(t);
  if (revert) return { n: Number(revert[1]), revert: true, sentence: null };
  const numbered = /^(\d{1,2})\s*:\s*(\S[\s\S]*)$/.exec(t);
  if (numbered) return { n: Number(numbered[1]), revert: false, sentence: numbered[2].trim() };
  return null;
}

/**
 * The delegate decision a reply in THIS morning's digest thread objects to, or
 * undefined when the reply is not an objection or its number named no line.
 * Records the objection as a side effect and answers with the askId.
 *
 * The numbers are the digest's own, so they are resolved against the
 * "digest-sent" row that morning wrote (data.objectionAskIds, in printed
 * order) rather than recomputed — a number Tom types must name a line he could
 * actually see.
 */
async function namedObjection(
  ctx: MutationCtx,
  text: string,
  day: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<string | undefined> {
  const parsed = parseObjectionReply(text);
  if (parsed === null) return undefined;
  // DO NOT put `day` in the row's key to make this a point lookup.
  // ttsDigest.lastDigestSent depends on "digest-sent" rows carrying NO key:
  // with the kind pinned and every key empty, by_kind_key orders by time and
  // .first() is the newest row. Keying them by day would silently break the
  // window arithmetic of every future digest. So: a bounded newest-first take
  // over two weeks of mornings, inside Slack's 3-second budget.
  const recent = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", DIGEST_SENT))
    .order("desc")
    .take(DIGEST_OBJECTION_LOOKBACK);
  const sent = recent.find((row) => (row.data as { day?: unknown } | undefined)?.day === day);
  const printed = (sent?.data as { objectionAskIds?: unknown } | undefined)?.objectionAskIds;
  const askId = Array.isArray(printed) ? printed[parsed.n - 1] : undefined;
  // A number that named no printed line is not an objection: fall through, and
  // the reply is kept as the fact it is. Nothing is lost.
  if (typeof askId !== "string" || askId === "") return undefined;
  await ctx.runMutation(internal.ttsAsk.internalRecordDelegateObjection, {
    askId,
    n: parsed.n,
    day,
    text,
    revert: parsed.revert,
    sentence: parsed.sentence,
    ...at,
  });
  return askId;
}

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
    text: renderSlack(
      composeContinued({ sessionId: newId, title: session.title, status: session.status }),
    ),
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
