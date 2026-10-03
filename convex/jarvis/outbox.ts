// outbox.ts — the rows the output channel is written from, and nothing else.
//
// A LEAF: it imports only record.ts, so any file can read the last digest or
// open a needs-you without importing the Slack and digest modules (and the
// cycle back through them that left module constants undefined at load).
// convex/jarvis/digest.ts is the area; this is its floor.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { DAY_MS, outputChannel, ttsDayBoundsUtc, ttsDayKey } from "../ttsShared";
import { insertEvent } from "./record";

export const DIGEST_SENT = "digest-sent";
export const NEEDS_YOU_OPENED = "needs-you-opened";
export const NEEDS_YOU_POSTED = "needs-you-posted";
export const DIGEST_LINE = "digest-line";
export const THREAD_DIGEST = "thread-digest";
export const THREAD_NEEDS_YOU = "thread-needs-you";
export const NEEDS_TOM_ANSWERED = "needs-tom-answered";

/** How far back an opened needs-you is still posted. Older than this, it
 *  was opened while the box was down for days; it is in the record and on
 *  its todo, and a reply under a digest a week late is not what he reads. */
export const NEEDS_YOU_WINDOW_MS = 3 * DAY_MS;

/** The newest digest-sent row: which day went out last, where its window
 *  ended, and where it lives in Slack. by_kind_at, newest first.
 *
 *  UNTIL THE FIRST ONE LANDS HERE, the previous generation's newest row. The
 *  digests before this area were marked in dtsEvents; without their last row
 *  the first run after the deploy would see no digest ever, send a second
 *  one for a day that had its own, and the late-digest alarm would say a
 *  sent morning was missing. The first digest-sent in the record ends this
 *  branch for good; it goes with dtsEvents' digest-sent rows. */
export async function lastDigest(ctx: QueryCtx): Promise<{ data?: unknown; text?: string } | null> {
  const row = await ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", DIGEST_SENT))
    .order("desc")
    .first();
  if (row !== null) return row;
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", DIGEST_SENT))
    .order("desc")
    .first();
}

/** Every digest-sent row in the record since `from`, newest first: the
 *  threads needs-you replies went under in that time. A day's digest is one
 *  row, so a few days is a handful. */
export async function digestsSince(ctx: QueryCtx, from: number): Promise<{ data?: unknown }[]> {
  const [record, legacy] = await Promise.all([
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", DIGEST_SENT).gte("at", from))
      .order("desc")
      .take(50),
    // A digest sent through the previous pen can still be today's newest
    // thread during the cutover, before the first record-native one lands.
    ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", DIGEST_SENT).gte("at", from))
      .order("desc")
      .take(50),
  ]);
  const seenThreads = new Set<string>();
  return [...record, ...legacy]
    .sort((left, right) => right.at - left.at || right._creationTime - left._creationTime)
    .filter((row) => {
      const facts = digestFacts(row);
      if (facts.channel === null || facts.ts === null) return true;
      const key = `${facts.channel}:${facts.ts}`;
      if (seenThreads.has(key)) return false;
      seenThreads.add(key);
      return true;
    })
    .slice(0, 50);
}

/** The number a needs-you reply was posted with: the box writes it first,
 *  "<n> · …" (Jarvis worker/jobs/write-slack.mjs), from the number the
 *  record gave it (convex/jarvis/digest.ts pendingNeedsYou). */
export function needsYouNumber(text: unknown): number | null {
  const hit = typeof text === "string" ? /^(\d{1,3}) · /.exec(text) : null;
  return hit === null ? null : Number(hit[1]);
}

type DigestData = { day?: unknown; windowEnd?: unknown; channel?: unknown; ts?: unknown; slackTs?: unknown };

export function digestFacts(row: { data?: unknown } | null): {
  day: string | null;
  windowEnd: number | null;
  channel: string | null;
  ts: string | null;
} {
  const d = (row?.data ?? {}) as DigestData;
  const legacyTs = typeof d.slackTs === "string" ? d.slackTs : null;
  return {
    day: typeof d.day === "string" ? d.day : null,
    windowEnd: typeof d.windowEnd === "number" ? d.windowEnd : null,
    channel: typeof d.channel === "string" ? d.channel : legacyTs === null ? null : outputChannel(),
    ts: typeof d.ts === "string" ? d.ts : legacyTs,
  };
}

/**
 * Open one needs-you reply: the row the box posts from. `key` is the
 * producer's own id for the thing that needs him and is the subject, so one
 * thing opens once. A todo or a producer's job names what his
 * reply is about, and his reply is that one's next turn.
 */
export async function openNeedsYou(
  ctx: MutationCtx,
  {
    key,
    text,
    todoId,
    job,
    reason,
  }: { key: string; text: string; todoId?: Id<"todos">; job?: string; reason?: string },
): Promise<{ opened: boolean; key: string }> {
  const seen = await ctx.db
    .query("events")
    .withIndex("by_subject_at", (q) => q.eq("subject", key))
    .filter((q) => q.eq(q.field("kind"), NEEDS_YOU_OPENED))
    .first();
  if (seen !== null) return { opened: false, key };
  await insertEvent(ctx, {
    kind: NEEDS_YOU_OPENED,
    subject: key,
    data: {
      key,
      ...(todoId === undefined ? {} : { todoId }),
      ...(job === undefined ? {} : { job }),
      ...(reason === undefined ? {} : { reason }),
    },
    text,
  });
  const day = ttsDayKey(Date.now());
  const digest = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", THREAD_DIGEST).eq("subject", day))
    .order("desc")
    .first();
  // This branch cannot be deleted: after today's digest exists the item must
  // appear now; before it exists the morning digest remains its one writer.
  if (digest !== null) {
    const digestData = digest.data as { objectionAskIds: string[]; items: Array<{ n: number }> };
    let last = Math.max(digestData.objectionAskIds.length, ...digestData.items.map((item) => item.n));
    for await (const row of ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) =>
        q.eq("kind", THREAD_NEEDS_YOU).eq("subject", digest._id))) {
      last = Math.max(last, (row.data as { n: number }).n);
    }
    await insertEvent(ctx, {
      kind: THREAD_NEEDS_YOU,
      provenance: { job: "needs-you" },
      subject: digest._id,
      data: { n: last + 1, key,
        ...(todoId === undefined ? {} : { todoId }),
        ...(job === undefined ? {} : { job }),
      },
      text,
    });
    // The record pushes here rather than the box because both openers run in
    // the record, and scheduling in the same transaction pushes exactly once
    // per posted item.
    await ctx.scheduler.runAfter(0, internal.pushSend.sendToAll, { title: "Needs you", body: "", url: "/thread" });
  }
  return { opened: true, key };
}


/**
 * A line for the next digest, from a producer whose fact the digest does not
 * read from a row of its own: a ruling read out of his words, a model-of-Tom
 * line the nightly wrote, a repository-rule proposal, a golden case that
 * graduated, a box change to who can act, a journal gap. These went to
 * #tts-decisions or #tts-broken as they happened; with one output channel
 * they are sections of the digest (convex/ttsDigest.ts reads these rows).
 * `section` "decisions" is a line on the objection list, where "revert <n>"
 * in the digest's thread reaches `askId`; "broken" is a failure line.
 */
type DigestLine =
  | {
      section: "decisions";
      askId: string;
      todoId?: string;
      decision: string;
      reason?: string;
      refused?: boolean;
      refusedBecause?: string;
    }
  | { section: "broken"; job: string; statement: string; detail?: string; url?: string };

export async function listForDigest(ctx: MutationCtx, line: DigestLine): Promise<{ listed: boolean }> {
  const subject = line.section === "decisions" ? line.askId : line.job;
  // ONCE PER DIGEST WINDOW PER SUBJECT: a rerun that
  // offers the same decision again (a Friday job's --overwrite), or a job that
  // fails on every run, is one line, not one per offer.
  const now = Date.now();
  const { start, end } = ttsDayBoundsUtc(ttsDayKey(now));
  const seen = await ctx.db
    .query("events")
    .withIndex("by_subject_at", (q) => q.eq("subject", subject).gte("at", start).lt("at", end))
    .filter((q) => q.eq(q.field("kind"), DIGEST_LINE))
    .first();
  if (seen !== null) return { listed: false };
  await insertEvent(ctx, { kind: DIGEST_LINE, subject, data: line });
  return { listed: true };
}
