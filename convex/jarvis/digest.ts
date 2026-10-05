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
//
// THE THREAD GETS THE DIGEST TOO, from the record's own clock (Tom's ruling
// of 2026-10-05: the digest on a Convex cron at 05:00). convex/crons.ts runs
// appendThreadDigest at the top of every hour; from 5 a.m. New York it appends
// the day's digest once, with the needs-you items numbered beneath its text,
// and sends one web push. A reply under it is routed in convex/thread.ts.

import { httpAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { logEvent } from "../tts";
import { resolveId } from "./tables";
import { THREAD_GATHER_BYTES, THREAD_OWN_BYTES, composeToday, rollMissed, supersededCursorOf } from "../ttsDigest";
import { ReadBudget, readWithin } from "../readBudget";
import { getDocumentSize } from "convex/values";
import { insertEvent } from "./record";
import { needsYouInThread, recordSlackSent } from "../ttsSlack";
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
  ITEM_TEXT_MAX_BYTES,
  NEEDS_YOU_OPENED,
  NEEDS_YOU_POSTED,
  NEEDS_YOU_WINDOW_MS,
  THREAD_DIGEST,
  cutToBytes,
  digestFacts,
  lastDigest,
  laterDigestItems,
  digestsSince,
  type DigestItem,
} from "./outbox";

/** The most pending needs-you items one digest or outbox read answers. */
const PENDING_MAX = 200;

/** The most bytes of needs-you items one thread digest lists, sized as Convex
 *  sizes a document (getDocumentSize). With the
 *  digest text (at most ttsCompose's MESSAGE_MAX_CHARS) a thread-digest row
 *  stays far under Convex's 1 MiB document limit, and /thread's read of 60
 *  of them (convex/thread.ts messages) stays under its read limit. */
const DIGEST_ITEMS_MAX_BYTES = 64 * 1024;

/** appendThreadDigest's own reads, each an allotment of one ReadBudget of
 *  THREAD_OWN_BYTES (convex/ttsDigest.ts, where the transaction's bound is
 *  stated); they sum to it. */
export const THREAD_OWN_READS = {
  digests: { what: "thread digests", bytes: THREAD_OWN_BYTES / 4 },
  items: { what: "items posted under recent thread digests", bytes: THREAD_OWN_BYTES / 4 },
  openings: { what: "needs-you openings", bytes: THREAD_OWN_BYTES / 4 },
  surfaced: { what: "surfaced marks", bytes: THREAD_OWN_BYTES / 4 },
};

/** How far before its own time a digest's next scan starts when it listed
 *  every opening it read. An opening's time is taken when its transaction
 *  starts, and POST /jarvis/event writes openings without reading the
 *  digest, so one timed just before a digest can commit just after it. */
const OPENINGS_OVERLAP_MS = 60_000;

/** The most thread digests in the needs-you window: one per day across
 *  NEEDS_YOU_WINDOW_MS (three days) touches at most four days. */
const DIGESTS_IN_WINDOW = 4;

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
      // Where the next digest's read of superseded rulings starts; the sender
      // records it on the digest-sent row with windowEnd (convex/ttsDigest.ts
      // supersededCursorAfter).
      supersededCursor: { at: number; after: number };
      facts: unknown;
    };

export const compose = internalMutation({
  args: {},
  handler: async (ctx): Promise<ComposeAnswer> => {
    const now = Date.now();
    const day = ttsDayKey(now);
    const lastRow = await lastDigest(ctx);
    const last = digestFacts(lastRow);
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
    // The rollover's read cut, if any, is said in the digest's cut lines.
    const { cuts } = await rollMissed(ctx, day);
    const since = last.windowEnd ?? now - DAY_MS;
    const composed: {
      text: string;
      truncated: boolean;
      surfacedTodoIds: string[];
      objectionAskIds: string[];
      supersededCursor: { at: number; after: number };
      facts: unknown;
    } =
      await ctx.runQuery(internal.ttsDigest.internalComposeToday, {
      day,
      now,
      since,
      canReply: replyRouteLive(),
      earlierCuts: cuts,
      // Superseded rulings from where the last digest-sent row stopped.
      supersededFrom: supersededCursorOf(lastRow) ?? undefined,
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
      supersededCursor: composed.supersededCursor,
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
  await markSurfaced(ctx, surfaced, day);
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

export async function markSurfaced(ctx: MutationCtx, surfacedTodoIds: unknown[], day: string | null, budget?: ReadBudget): Promise<void> {
  for (const raw of surfacedTodoIds) {
    if (typeof raw !== "string") continue;
    if (budget === undefined) {
      const todoId = await resolveId(ctx, "todos", raw);
      if (todoId !== null) await logEvent(ctx, "surfaced", todoId, { via: "digest", day });
      continue;
    }
    // Under the thread digest's budget the ids are plain todo ids
    // (composeToday). A mark reads its todo twice, here and in logEvent's
    // resolveId; each read is made only while the budget is open and is
    // charged, so the marks read at most one document past it. A mark past
    // the budget is left out, so that todo can be said again on a later
    // morning.
    if (!budget.open) {
      budget.skip();
      continue;
    }
    const todoId = ctx.db.normalizeId("todos", raw);
    const todo = todoId === null ? null : await ctx.db.get(todoId);
    if (todo === null) continue;
    budget.charge(todo);
    if (!budget.open) {
      budget.skip();
      continue;
    }
    await logEvent(ctx, "surfaced", todo._id, { via: "digest", day });
    budget.charge(todo);
  }
}

type ThreadDigestAnswer = { appended: false; day: string; reason: string; id?: string }
  | { appended: true; day: string; id: string };

/** Append today's rendered digest and its numbered needs-you items to the
 * Jarvis thread once the TTS day has begun, and push once. convex/crons.ts
 * runs it at the top of every hour: the 05:00 New York run appends, and a
 * later run appends only when no digest for the day exists yet. */
/** The first `rows` rows of `query` under `budget`, which is checked before
 *  each row is fetched. Unlike readWithin it reads no row past `rows` to learn
 *  whether more exist: taking the newest few is the read's whole intent, not
 *  a cut. A stop at the budget is recorded, as readWithin records it. */
async function firstRows(budget: ReadBudget, query: AsyncIterable<Doc<"events">>, rows: number): Promise<Doc<"events">[]> {
  const out: Doc<"events">[] = [];
  const iterator = query[Symbol.asyncIterator]();
  try {
    while (out.length < rows) {
      if (!budget.open) {
        budget.stop("bytes");
        break;
      }
      const next = await iterator.next();
      if (next.done === true) break;
      budget.charge(next.value);
      out.push(next.value);
    }
  } finally {
    await iterator.return?.();
  }
  return out;
}

export const appendThreadDigest = internalMutation({ args: {}, handler: (ctx) => appendDigestToThread(ctx) });

/** appendThreadDigest's work, in the caller's transaction (a test counts its
 *  reads against DIGEST_READ_BOUND). */
export async function appendDigestToThread(ctx: MutationCtx): Promise<ThreadDigestAnswer> {
  const now = Date.now();
  const day = ttsDayKey(now);
  if (nyLocalHour(now) < TTS_DIGEST_NY_HOUR) {
    return { appended: false, day, reason: "before 5 a.m. New York" };
  }
  const own = ReadBudget.of(THREAD_OWN_BYTES);
  const digestReads = own.allot(THREAD_OWN_READS.digests.what, THREAD_OWN_READS.digests.bytes);
  const [existing] = await firstRows(digestReads, ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", THREAD_DIGEST).eq("subject", day))
    .order("desc"), 1);
  if (existing !== undefined) return {
    appended: false, day, reason: `the digest for ${day} is on the thread`, id: existing._id,
  };
  // The rollover's read cut, if any, is said in the digest's cut lines, as
  // compose does above.
  const { cuts } = await rollMissed(ctx, day);
  const needsFrom = now - NEEDS_YOU_WINDOW_MS;
  // The newest digests in the needs-you window; the newest of all, which
  // may be older, gives the window start when none is in it.
  const recentDigests = await firstRows(digestReads, ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", THREAD_DIGEST))
    .order("desc"), DIGESTS_IN_WINDOW);
  const previousWindowEnd = (recentDigests[0]?.data as { windowEnd?: unknown } | undefined)?.windowEnd;
  const since = typeof previousWindowEnd === "number" ? previousWindowEnd : now - DAY_MS;
  const composed = await composeToday(ctx, {
    day,
    now,
    since,
    // Superseded rulings from where the previous thread digest stopped.
    supersededFrom: supersededCursorOf(recentDigests[0] ?? null) ?? undefined,
    // The composer's invitations describe Slack's "revert 2" and line-level
    // "done" grammar, which the Jarvis thread does not route.
    canReply: false,
    earlierCuts: cuts,
    gatherBytes: THREAD_GATHER_BYTES,
  });
  const inWindow = recentDigests.filter((row) => row.at >= needsFrom);
  const itemReads = own.allot(THREAD_OWN_READS.items.what, THREAD_OWN_READS.items.bytes);
  const listedKeys = new Set<string>();
  for (const row of inWindow) {
    for (const item of (row.data as { items: DigestItem[] }).items) listedKeys.add(item.key);
    for (const item of await laterDigestItems(ctx, row._id, itemReads)) listedKeys.add(item.key);
  }
  // A listed key the budget left unread could be listed twice, so a byte cut
  // of the two reads the keys come from (the digest rows, the items posted
  // under them) lists no opening today and leaves the next digest's start
  // where this one's was. No other cut stops the scan.
  const listedComplete = !own.cuts().some((cut) => cut.by === "bytes"
    && (cut.what === THREAD_OWN_READS.digests.what || cut.what === THREAD_OWN_READS.items.what));
  // An opening is listed once, in the first thread digest after it opened,
  // found by its key. The scan starts where the previous digest stopped
  // (data.openingsFrom), so an opening it listed is not read again, except
  // the items posted under it after it was appended and the openings of its
  // last OPENINGS_OVERLAP_MS, which are read and skipped. Each row read is
  // charged to the openings allotment; the first row past a bound (that
  // allotment, PENDING_MAX items, DIGEST_ITEMS_MAX_BYTES of them) is where
  // the next digest starts, so each digest moves the start forward and an
  // opening is listed by a later digest while it is inside the three-day
  // window (NEEDS_YOU_WINDOW_MS); past that window it is left to its todo,
  // as the Slack path leaves it.
  const resume = (inWindow[0]?.data as { openingsFrom?: unknown } | undefined)?.openingsFrom;
  const scanFrom = Math.max(needsFrom, typeof resume === "number" ? resume : needsFrom);
  const budget = own.allot(THREAD_OWN_READS.openings.what, THREAD_OWN_READS.openings.bytes);
  const first = composed.objectionAskIds.length + 1;
  const items: DigestItem[] = [];
  let itemBytes = 0;
  // readWithin checks the allotment before it fetches each row, so no row
  // is read uncharged. When the allotment stopped the read, the next digest
  // starts one millisecond after the last row read, so a row that fills the
  // allotment alone is not read again; an opening in that same millisecond
  // that the read did not reach is left to its todo, as one past the
  // three-day window is.
  const opened = listedComplete ? await readWithin(budget, ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", NEEDS_YOU_OPENED).gte("at", scanFrom))
    .order("asc"), Number.POSITIVE_INFINITY) : [];
  let openingsFrom = !listedComplete ? scanFrom
    : budget.open ? now - OPENINGS_OVERLAP_MS : (opened.at(-1)?.at ?? scanFrom - 1) + 1;
  for (const row of opened) {
    // The writers refuse a needs-you-opened without a subject
    // (shared/jarvis-events.mjs SUBJECT_REQUIRED); this narrows the type.
    if (row.subject === undefined || listedKeys.has(row.subject)) continue;
    if (items.length >= PENDING_MAX) {
      openingsFrom = row.at;
      break;
    }
    const data = (row.data ?? {}) as Record<string, unknown>;
    const item: DigestItem = { n: first + items.length, key: row.subject,
      text: cutToBytes(row.text ?? "", ITEM_TEXT_MAX_BYTES),
      ...(typeof data.todoId === "string" ? { todoId: data.todoId } : {}),
      ...(typeof data.job === "string" ? { job: data.job } : {}),
    };
    const size = getDocumentSize(item);
    if (itemBytes + size > DIGEST_ITEMS_MAX_BYTES) {
      openingsFrom = row.at;
      break;
    }
    items.push(item);
    itemBytes += size;
  }
  await markSurfaced(ctx, composed.surfacedTodoIds, day, own.allot(THREAD_OWN_READS.surfaced.what, THREAD_OWN_READS.surfaced.bytes));
  const id = await insertEvent(ctx, {
    kind: THREAD_DIGEST,
    at: now,
    provenance: { job: "digest" },
    subject: day,
    text: composed.text,
    data: { day, since, windowEnd: now, truncated: composed.truncated,
      surfacedTodoIds: composed.surfacedTodoIds,
      objectionAskIds: composed.objectionAskIds,
      items,
      openingsFrom,
      // Where the next digest's read of superseded rulings starts.
      supersededCursor: composed.supersededCursor,
    },
  });
  // One push for the digest; its text stays in the record, as the needs-you
  // push's does (convex/jarvis/outbox.ts openNeedsYou).
  await ctx.scheduler.runAfter(0, internal.pushSend.sendToAll, { title: "Digest", body: day, url: "/thread" });
  return { appended: true, day, id };
}

/** The needs-you-posted hook: his reply in the digest's thread finds the
 *  needs-you reply above it through this slack-sent row (subject: the todo,
 *  or the producer's job). */
export async function onNeedsYouPosted(ctx: MutationCtx, row: Doc<"events">): Promise<{ threaded: boolean }> {
  const d = (row.data ?? {}) as Record<string, unknown>;
  const channel = typeof d.channel === "string" ? d.channel : null;
  const ts = typeof d.ts === "string" ? d.ts : null;
  const threadTs = typeof d.threadTs === "string" ? d.threadTs : null;
  const subject = await needsYouSubject(ctx, d);
  if (channel === null || ts === null || threadTs === null || subject === null) return { threaded: false };
  await recordSlackSent(ctx, { channel, ts, threadTs, subject, text: row.text ?? "" });
  return { threaded: true };
}

async function needsYouSubject(ctx: MutationCtx, d: Record<string, unknown>): Promise<SlackSubject | null> {
  const todoId = typeof d.todoId === "string" ? await resolveId(ctx, "todos", d.todoId) : null;
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
  /** Every digest thread a pending reply may already sit under, newest
   *  first: each digest sent since a day before the pending window opened
   *  (the digest that was newest when the oldest pending item opened is at
   *  most a day older than it). The box reads them all before posting. */
  searchThreads: Thread[];
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
  args: {},
  handler: async (ctx): Promise<PendingNeedsYou> => {
    const now = Date.now();
    const from = now - NEEDS_YOU_WINDOW_MS;
    const digests = await digestsSince(ctx, from - DAY_MS);
    const newest = digests[0];
    const thread = threadOf(newest);
    // THE PENDING ONES, OLDEST FIRST, however many were opened and posted
    // before them: the openings are walked in order and each is looked up by
    // its own subject (events.by_subject_at), so a posted one costs one read
    // and never uses up the room a later opening needs.
    const opened: Doc<"events">[] = [];
    for await (const row of ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", NEEDS_YOU_OPENED).gte("at", from))
      .order("asc")) {
      if (row.subject === undefined) continue;
      const key = row.subject;
      const sent = await ctx.db
        .query("events")
        .withIndex("by_subject_at", (q) => q.eq("subject", key))
        .filter((q) => q.eq(q.field("kind"), NEEDS_YOU_POSTED))
        .first();
      if (sent !== null) continue;
      opened.push(row);
      if (opened.length >= PENDING_MAX) break;
    }
    // The next number after the objection lines and the highest reply
    // number already in this thread (every row of it, however many).
    const objectionLines = (newest?.data as { objectionAskIds?: unknown } | undefined)?.objectionAskIds;
    const inThread = thread === null
      ? []
      : (await needsYouInThread(ctx, { channel: thread.channel, threadTs: thread.ts })).map((item) => item.n);
    const first = Math.max(Array.isArray(objectionLines) ? objectionLines.length : 0, ...inThread) + 1;
    return {
      thread,
      searchThreads: digests.flatMap((row) => {
        const one = threadOf(row);
        return one === null ? [] : [one];
      }),
      pending: opened.map((row, index) => {
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

/**
 * GET /jarvis/digest/channel — { ok, channel }: the output channel's id as the
 * record posts to it (outputChannel(): SLACK_TTS_TODAY_CHANNEL_ID, then the
 * older SLACK_TTS_CHANNEL_ID), or null when neither is set. The id lives in
 * the record's env, not the box's; Jarvis `slack-setup` asks here, looks the
 * channel up by this id (it is renamed #jarvis, and a name would miss it),
 * and never creates one when the record names one.
 */
export const channelRoute = httpAction(async (_ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  return jsonResponse(200, { ok: true, channel: outputChannel() });
});
