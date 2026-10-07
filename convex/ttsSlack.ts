import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { applyStatusChange, logEvent } from "./tts";
import { DIGEST_OBJECTION_LOOKBACK } from "./ttsAsk";
import { DIGEST_SENT } from "./ttsDigest";
import {
  NEEDS_TOM,
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
  renderSlack,
  type NeedsYouFacts,
} from "./ttsCompose";
import { changeIdTokens, namedChange, withoutChangeId } from "../shared/learning-change-names.mjs";
import { needsYouNumber, openNeedsYou } from "./jarvis/outbox";
import { askShown } from "../shared/decided-by.mjs";
import { resolveId, todoIdForms } from "./jarvis/tables";

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

/** The todo a subject names, as a row's todoId column stores it: the plain
 *  id, or none for an id naming no row (convex/jarvis/tables.ts resolveId).
 *  Every todoId taken from a Slack subject is taken here. */
async function subjectTodo(ctx: MutationCtx, subject: { kind: string }): Promise<Id<"todos"> | undefined> {
  if (subject.kind !== "todo") return undefined;
  return (await resolveId(ctx, "todos", (subject as unknown as { id: string }).id)) ?? undefined;
}

/** A subject as a new row stores it: a todo named by its plain id, whichever
 *  form the thread or the caller holds (step C, convex/jarvis/tables.ts).
 *  A todo id naming no row stays in the subject, and only there: a subject is
 *  the thread's identity, which every message must carry and a todo subject
 *  has no todo-less form of, so the row's todoId column stores no todo. */
async function plainSubject<S extends { kind: string }>(ctx: MutationCtx, subject: S): Promise<S> {
  if (subject.kind !== "todo") return subject;
  const plain = await resolveId(ctx, "todos", (subject as unknown as { id: string }).id);
  return plain === null ? subject : ({ ...subject, id: plain } as S);
}

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
  // A subject names its todo in either form; the row stores the plain id,
  // in its todoId and in its subject.
  subject = await plainSubject(ctx, subject);
  const todoId = await subjectTodo(ctx, subject);
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: "slack-sent",
    key: slackThreadKey(channel, threadTs ?? ts),
    todoId,
    data: { channel, ts, threadTs, subject, text },
  });
  if (todoId !== undefined) {
    // The plain row, then its old row written back (convex/jarvis/tables.ts).
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
    // A todo subject is stored by its plain id, whichever form the caller holds.
    const stored = await plainSubject(ctx, subject);
    await logEvent(
      ctx,
      "slack-send-failed",
      await subjectTodo(ctx, stored),
      { channel, threadTs, subject: stored, error, text, attempts, windowEnd },
    );
  },
});

// ── One thread in #tts for a todo that needs Tom (the lifeos update, phase 6)
// ONE MESSAGE SHAPE for anything that needs him: a thread in #tts whose reply
// is the next turn. A capture poller on the Jarvis Box (poll-gmail today) that
// judges a captured item to need Tom TODAY calls POST /tts/needs-tom, which
// lands here; the message goes out through the one door in convex/ttsSync.ts
// with the todo as its subject, so his threaded reply already routes — "done"
// completes it, anything else is a fact on the row
// (todoReply below).
//
// DEDUPED ON THE PRODUCER'S OWN ID, not on the todo. A poller's key is the
// identity of the thing it read — `gmail:message:<id>` — so the same mail can
// never open a second thread, not on a re-run, not after a lost cursor, not
// after a redeployment. The marker is an ordinary dtsEvents row keyed like the
// door's own rows; two concurrent calls with one key conflict on it in Convex
// and the retry reads the marker the winner wrote.
export { NEEDS_TOM };
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
    // A todo is claimed under its old id when it has one (else its plain id),
    // whichever form the caller holds, so a claim made before the readers
    // moved still dedupes one made after; the row stores the plain id.
    const forms = await todoIdForms(ctx, itemId);
    const todoId = forms.length === 0 ? null : (forms[0] as Id<"todos">);
    const key = claimKey(day, ask as "act" | "object", forms.at(-1) ?? itemId);
    const seen = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", SLACK_CLAIMED).eq("key", key))
      .first();
    if (seen) {
      const by = (seen.data as { channel?: unknown } | undefined)?.channel;
      return { claimed: false, by: typeof by === "string" ? by : null };
    }
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
    // A question with lettered options: stored on the item, and composed
    // into what he reads ahead of `reason` (shared/decided-by.mjs askShown).
    question: v.optional(v.string()),
    options: v.optional(v.array(v.string())),
    canReply: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    { todoId, reason, key, question, options, canReply },
  ): Promise<{ opened: boolean; key: string; reason?: string }> => {
    // The todo first: a thread about a row that is not there is a message Tom
    // cannot reply to, and the marker would suppress the real one for ever.
    const id = await resolveId(ctx, "todos", todoId);
    const todo = id === null ? null : await ctx.db.get(id);
    if (id === null || !todo) throw new Error(`Unknown todo id: ${todoId}`);
    const seen = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_key", (q) => q.eq("kind", NEEDS_TOM).eq("key", key))
      .first();
    if (seen) return { opened: false, key };

    const asked = question !== undefined && options !== undefined;
    const facts: NeedsYouFacts = {
      todoId: id,
      statement: todo.statement,
      entryAction: todo.entryAction,
      reason: asked ? `${askShown(question, options)} ${reason}` : reason,
      sourceUrl: sourceUrlOf(todo.provenance),
    };
    const day = ttsDayKey(Date.now());
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: NEEDS_TOM,
      key,
      todoId: id,
      // The provenance the message does NOT print stays on the row. The
      // question and options are the ones he is shown, which a reply of his
      // naming a letter is read against (convex/ttsAsk.ts tomAnswer).
      data: { key, reason, provenance: todo.provenance, ...(asked ? { question, options } : {}) },
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
    // A REPLY UNDER THE DAY'S DIGEST (Tom, 2026-09-26: one output channel).
    // Deterministic, no model: the box's digest job posts it in the newest
    // digest's thread and records needs-you-posted, which routes his reply
    // back to this todo (convex/jarvis/digest.ts).
    await openNeedsYou(ctx, {
      key,
      todoId: id,
      reason,
      text: renderSlack(composeNeedsYou(facts, { canReply: canReply ?? false })),
    });
    return { opened: true, key };
  },
});

/** The message a capture came from, when its provenance carries one./** The message a capture came from, when its provenance carries one.
 *  worker/jobs/poll-gmail.mjs writes `gmail:message:<id> https://mail.google…`,
 *  so the first https token is the link and everything else is machine text
 *  the message must not print. */
export function sourceUrlOf(provenance: string | undefined): string | null {
  if (provenance === undefined) return null;
  const hit = provenance.match(/https:\/\/[^\s]+/);
  return hit === null ? null : hit[0];
}

// ── "done", or a fact ────────────────────────────────────────────────────────
// A reply on a todo thread that says ONLY "done" completes the todo through
// applyStatusChange — the one status writer, so the kept-dates rule resolves
// an open date the same way the page's button does. Anything else, a bare
// date included, is a fact on the todo: the time notes that once read a bare
// date went with the Jarvis calendar (design section 13.2).
export type ReplyShape = "done" | "fact";

/** "done" when the whole reply is the word done; "fact" otherwise.
 * Exported for its test. */
export function replyShape(text: string): ReplyShape {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/, "")
    .replace(/\s+/g, " ");
  return normalized === "done" ? "done" : "fact";
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
  // A DIGEST OWNS ITS THREAD. The needs-you replies under it are later sends
  // in the same thread, and newest-wins would hand the whole thread to the
  // last of them; the digest case reads them itself (needsYouReply).
  const root = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", "slack-sent").eq("key", key))
    .order("asc")
    .first();
  const rootSubject = (root?.data as { subject?: SlackSubject } | undefined)?.subject;
  if (rootSubject?.kind === "today" || rootSubject?.kind === "digest") return rootSubject;
  const sent = await threadRow(ctx, "slack-sent", key);
  const claimed = await threadRow(ctx, SLACK_THREAD_CLAIMED, key);
  // Newest wins, so an ordinary later send in the thread still re-points it.
  const subject =
    sent === null || (claimed !== null && claimed.at > sent.at)
      ? claimed?.subject
      : sent.subject;
  if (subject !== undefined) return subject;
  const todo = await ctx.db
    .query("todos")
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
  | { outcome: "done"; todoId: Id<"todos"> }
  | { outcome: "tom-note"; subject: SlackSubject }
  | { outcome: "learning-objection"; id: string }
  | { outcome: "delegate-objection"; id: string }
  | { outcome: "golden-confirmed"; ids: string[] }
  | { outcome: "asked-which"; numbers: number[] }
  | { outcome: "captured"; todoId: Id<"todos"> };

type NeedsYouAnswerOutcome = Extract<
  ThreadReplyOutcome,
  { outcome: "done" | "tom-note" }
>;

/**
 * One transaction per reply event. Dedupe first (Slack delivers at least
 * once: a redelivered event_id is dropped and counted on the row that took
 * the first delivery), then route by the thread's subject:
 *   session  → the text is the session's next inbound turn; an ended session
 *              gets a NEW session of the same kind seeded with the thread,
 *              and the thread is told which one.
 *   todo     → "done" completes the todo (applyStatusChange, the reply as the
 *              note); anything else
 *              is a "tom-note" event on the todo.
 *   digest   → a "tom-note" event with the day — a fact, per the brief;
 *              a reply that names a todo (link or id) and otherwise says only
 *              "done" is that todo's reply, as above; a reply that
 *              names a model-of-Tom line by the id the digest printed is a
 *              "learning-objection" to that line; "revert <n>" is an
 *              objection to the digest's line n; and a reply to a needs-you
 *              under the digest is that needs-you's answer.
 *   job      → a "tom-note" event with the job — a fact (the silence alarm).
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
  // A thread opened before step C names its todo by the old id; the rows
  // written from here name it by the plain one.
  const subject = await plainSubject(ctx, await threadSubject(ctx, channel, threadTs));
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
        ? await subjectTodo(ctx, subject)
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
    case "digest": {
      // A reply to the morning message is a fact (the brief's
      // "captured as a fact") — the thread has no one todo for a "done" to
      // land on. The one exception: a reply that NAMES a todo (its link or
      // id) and otherwise says only "done" is that todo's
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
      // THE WEEKLY EVALS THREAD HAS NO SUBJECT KIND of its own yet
      // (convex/ttsShared.ts SLACK_SUBJECT), so the confirmation grammar is
      // read here, beside the objection grammar: the weekly gather posts into
      // the morning's channel, and a reply to it resolves as a
      // `today`/`digest` thread. When the evals thread gets its own subject,
      // this branch moves there unchanged.
      //
      // FIRST, and it ends the reply: "confirm <id> <id>" says one thing and
      // says it anchored. The grammars cannot collide — an objection is a
      // leading number, a golden id is a word — and nothing else in this
      // branch would read a confirmation as anything but a fact.
      const confirmed = parseConfirmReply(text);
      if (confirmed.length > 0) {
        // ONE ROW PER ID, because the mined items are confirmed one at a time
        // and a row carrying a list would make "which ones did he confirm" a
        // parse rather than a read.
        for (const id of confirmed) {
          await logEvent(ctx, GOLDEN_CONFIRMED, undefined, { id, text, ...at });
        }
        return { outcome: "golden-confirmed", ids: confirmed };
      }
      const objectedDecision = await namedObjection(ctx, text, subject.day, at);
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
      // A NEEDS-YOU REPLY ANSWERED (convex/jarvis/digest.ts numbers them).
      // In the digest's thread, a reply that names no todo and is no objection
      // is the next turn of the needs-you it names by number; unnumbered, of
      // the one needs-you still open; with several open, the thread is asked
      // which (needsYouReply).
      if (named === undefined) {
        const answered = await needsYouReply(ctx, text, subject.day, at);
        if (answered !== null) return answered;
      }
      await logEvent(ctx, "tom-note", named?.todoId, { text, ...at, subject, day: subject.day });
      return { outcome: "tom-note", subject };
    }
    case "learning":
      await logEvent(ctx, "learning-objection", undefined, {
        id: subject.id,
        text,
        ...at,
      });
      return { outcome: "learning-objection", id: subject.id };
    case "job":
      // A reply about a failure is a fact, and nothing else: the failure is
      // the box's to fix, not a row with a status Tom can set.
      await logEvent(ctx, "tom-note", undefined, { text, ...at, subject, job: subject.id });
      return { outcome: "tom-note", subject };
    case "unknown":
      return await captureUnknown(ctx, text, at);
  }
}

/** The row that says a reply of his was routed to one numbered needs-you
 *  of one thread, which closes it for an unnumbered reply. */
const NEEDS_YOU_ANSWERED = "needs-you-answered";

/** A reply that begins with a number: the number, and what follows it
 *  ("4 done", "4 · Friday", "4: call her first", or "4" alone). A number run
 *  into a word ("4pm") is not one. Exported for its test. */
export function numberedReply(text: string): { n: number; rest: string } | null {
  const hit = /^(\d{1,3})(?:\s*[·.:)\-–—]\s*|\s+|$)([\s\S]*)$/.exec(text.trim());
  return hit === null ? null : { n: Number(hit[1]), rest: hit[2].trim() };
}

type NeedsYouItem = { n: number; subject: SlackSubject; answeredKey: string };

/** The needs-you replies posted in this digest's thread, each with the number
 *  it was posted with (convex/jarvis/outbox.ts needsYouNumber) and its
 *  subject: the todo, or the producer's job. Also the numbering's read
 *  (convex/jarvis/digest.ts pendingNeedsYou goes on from the highest).
 *
 *  EVERY ROW OF THE THREAD, not a first page: a reply numbered past a page
 *  would be unroutable and its number handed out again. The read is one
 *  thread's slack-sent rows on by_kind_key, the digest and what was posted
 *  under it that day. */
export async function needsYouInThread(
  ctx: QueryCtx,
  at: { channel: string; threadTs: string },
): Promise<NeedsYouItem[]> {
  const key = slackThreadKey(at.channel, at.threadTs);
  const rows = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", "slack-sent").eq("key", key))
    .collect();
  const items: NeedsYouItem[] = [];
  for (const row of rows) {
    const d = (row.data ?? {}) as { threadTs?: unknown; subject?: SlackSubject; text?: unknown };
    if (d.threadTs !== at.threadTs || d.subject === undefined) continue;
    if (d.subject.kind !== "todo" && d.subject.kind !== "job") continue;
    const n = needsYouNumber(d.text);
    if (n === null) continue;
    items.push({ n, subject: d.subject, answeredKey: `${key}#${n}` });
  }
  return items;
}

/** Open: no reply of his has been routed to it, and its todo, if it has one,
 *  is not done or archived. */
async function isOpen(ctx: MutationCtx, item: NeedsYouItem): Promise<boolean> {
  const answered = await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", NEEDS_YOU_ANSWERED).eq("key", item.answeredKey))
    .first();
  if (answered !== null) return false;
  if (item.subject.kind !== "todo") return true;
  const plain = await resolveId(ctx, "todos", item.subject.id);
  const todo = plain === null ? null : await ctx.db.get(plain);
  return todo !== null && todo.status !== "done" && todo.status !== "archived";
}

/**
 * The needs-you a reply in the digest's thread answers, and its answer — or
 * null when the thread holds none, or the reply's number names none of them
 * (a number that names an objection line was read before this).
 *
 * UNAMBIGUOUS BY CONSTRUCTION. A reply that starts with a number is that
 * item's; one that does not goes to the one item still open; with several
 * open, nothing is guessed: the thread gets one line asking which number,
 * and the reply is kept as a note on the day.
 */
async function needsYouReply(
  ctx: MutationCtx,
  text: string,
  day: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<ThreadReplyOutcome | null> {
  const items = await needsYouInThread(ctx, at);
  if (items.length === 0) return null;
  const numbered = numberedReply(text);
  let item: NeedsYouItem | undefined;
  let said = text;
  if (numbered !== null) {
    item = items.find((one) => one.n === numbered.n);
    if (item === undefined) return null;
    said = numbered.rest;
  } else {
    const open: NeedsYouItem[] = [];
    for (const one of items) if (await isOpen(ctx, one)) open.push(one);
    if (open.length === 0) return null;
    if (open.length > 1) {
      const numbers = open.map((one) => one.n).sort((a, b) => a - b);
      await logEvent(ctx, "tom-note", undefined, { text, ...at, subject: { kind: "today", day }, day, askedWhich: numbers });
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
        channel: at.channel,
        threadTs: at.threadTs,
        text: `Which one is that for? Start your reply with its number: ${numbers.slice(0, -1).join(", ")} or ${numbers[numbers.length - 1]}.`,
        subject: { kind: "today", day },
      });
      return { outcome: "asked-which", numbers };
    }
    item = open[0];
  }
  return await answerNeedsYou(ctx, item, { text, said, numbered: numbered !== null }, at);
}

/** Apply one answer to one numbered needs-you item. Shared by Slack and the
 * Jarvis thread so both surfaces preserve the same done/date/note behavior. */
export async function answerNeedsYou(
  ctx: MutationCtx,
  item: { n: number; subject: SlackSubject; answeredKey: string },
  reply: { text: string; said: string; numbered: boolean },
  at: Record<string, string>,
): Promise<NeedsYouAnswerOutcome> {
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind: NEEDS_YOU_ANSWERED,
    key: item.answeredKey,
    data: { n: item.n, subject: await plainSubject(ctx, item.subject), text: reply.text, ...at },
  });
  // The number named the item; what follows it is the answer ("4 done").
  const answer = reply.numbered && reply.said !== "" ? reply.said : reply.text;
  if (item.subject.kind === "todo") return await todoReply(ctx, item.subject.id, answer, at, replyShape(reply.said));
  await logEvent(ctx, "tom-note", undefined, { text: reply.text, ...at, subject: item.subject });
  return { outcome: "tom-note", subject: item.subject };
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
): Promise<{ outcome: "captured"; todoId: Id<"todos"> }> {
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
 * prefix of it — is one rule in shared/learning-change-names.mjs, the
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

/** One mined golden item Tom confirmed, by the id the weekly evals thread
 *  printed beside it. */
export const GOLDEN_CONFIRMED = "golden-confirmed";

/**
 * The confirmation grammar, ANCHORED at the start of the reply and
 * case-insensitive, exactly like the objection grammar above:
 *
 *   "confirm run-ruling-8fb2d10a4c3e"                          → one id
 *   "Confirm run-ruling-8fb2d10a4c3e explanations-todo-k97x2m4bq1zp"  → two
 *
 * Anything else is []. Anchored, so a reply that merely CONTAINS the word
 * ("I'll confirm that tomorrow", "nothing to confirm here") is a fact, not a
 * confirmation — the same rule, for the same reason, as a reply that merely
 * contains a number.
 *
 * WHY A REPLY AND NOT A REACTION. A reaction is one bit about a whole message,
 * and the weekly gather prints many mined items in one message: the items must
 * be confirmed ONE AT A TIME, and a thumbs-up on the message says only that
 * Tom read it.
 *
 * WHY NOT A RULING WORD. A ruling needs a subject — life or code — and
 * ttsRulings.insertRuling refuses anything else by construction. A mined
 * golden item is neither. Bending the four verdicts to fit it would
 * widen the one vocabulary in this system with a closed verdict set, and every
 * ruling button, worker filter and pending feed reads that set.
 */
export function parseConfirmReply(text: string): string[] {
  const anchored = /^confirm\s+([\s\S]*)$/i.exec(text.trim());
  if (anchored === null) return [];
  const ids = anchored[1]
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => /^[a-z0-9-]{4,80}$/.test(token));
  return [...new Set(ids)];
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
  // The record's digest-sent rows (convex/jarvis/digest.ts), a bounded
  // newest-first take over two weeks of mornings, inside Slack's 3-second
  // budget.
  const recent = await ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", DIGEST_SENT))
    .order("desc")
    .take(DIGEST_OBJECTION_LOOKBACK);
  const onDay = (row: { data?: unknown }) => (row.data as { day?: unknown } | undefined)?.day === day;
  // A morning marked before the box wrote the digest has its row in dtsEvents
  // (convex/jarvis/digest.ts lastDigest says why); its thread still takes
  // "revert 2" for the two weeks this lookback covers, then this read goes.
  const sent =
    recent.find(onDay) ??
    (
      await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", DIGEST_SENT))
        .order("desc")
        .take(DIGEST_OBJECTION_LOOKBACK)
    ).find(onDay);
  const printed = (sent?.data as { objectionAskIds?: unknown } | undefined)?.objectionAskIds;
  return await recordLineObjection(ctx, text, printed, day, at);
}

/**
 * The objection a reply makes to one printed objection line, recorded, or
 * undefined when the reply is not an objection or its number named no line.
 * `printed` is the digest's objectionAskIds in printed order. Shared by the
 * Slack digest's thread (namedObjection) and the Jarvis thread's digest
 * (convex/thread.ts), whose `at` is { channel: "thread", ts: Tom's message's
 * event id, threadTs: the digest's }.
 */
export async function recordLineObjection(
  ctx: MutationCtx,
  text: string,
  printed: unknown,
  day: string,
  at: { channel: string; ts: string; threadTs: string },
): Promise<string | undefined> {
  const parsed = parseObjectionReply(text);
  if (parsed === null) return undefined;
  const askId = Array.isArray(printed) ? printed[parsed.n - 1] : undefined;
  // A number that named no printed line, or a line printed with an empty id
  // (one no objection applies to), is not an objection: fall through, and
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
): Promise<{ todoId: Id<"todos">; rest: string } | undefined> {
  for (const token of text.split(/\s+/)) {
    const bare = token.replace(/^<|>$/g, "").split("|")[0];
    const candidate = /[?&]item=([A-Za-z0-9]+)/.exec(bare)?.[1] ?? bare.replace(/[.,;:!)]+$/, "");
    const todoId = await resolveId(ctx, "todos", candidate);
    if (todoId === null) continue;
    return { todoId, rest: text.replace(token, " ").replace(/\s+/g, " ").trim() };
  }
  return undefined;
}

/** A reply on a todo's thread, by its shape: "done" completes the todo, a
 * anything else is a fact on it. A todo that
 * is already done takes a second "done" as a fact — nothing to complete, and
 * the words are still kept. The shape is the reply's own unless the caller
 * read it off the reply with the todo's name taken out (namedTodo). */
async function todoReply(
  ctx: MutationCtx,
  given: Id<"todos"> | Id<"dtsTodos">,
  text: string,
  at: Record<string, string>,
  shape: ReplyShape = replyShape(text),
): Promise<NeedsYouAnswerOutcome> {
  // A thread names its todo in either form (convex/jarvis/tables.ts).
  const todoId = await resolveId(ctx, "todos", given);
  const todo = todoId === null ? null : await ctx.db.get(todoId);
  if (todoId === null || !todo) throw new Error(`Unknown todo id: ${given}`);
  const subject: SlackSubject = { kind: "todo", id: todoId };
  switch (shape) {
    case "done":
      if (todo.status !== "done") {
        await applyStatusChange(ctx, todo, { status: "done", note: text });
        return { outcome: "done", todoId };
      }
      break;
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
  // An ended persistent session is reopened, never continued as a new row:
  // its name is one row (claudeSessions.internalEnsurePersistentSessions).
  if (session.kind === "persistent") {
    await ctx.runMutation(internal.claudeSessions.internalReopenSession, { sessionId, text, author: "tom" });
    return { outcome: "session-turn", sessionId };
  }
  const newId = await ctx.runMutation(
    internal.claudeSessions.internalCreateSession,
    {
      title: session.title,
      kind: session.kind,
      repos: session.repos ?? [session.repo],
      todoId: session.todoId,
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
