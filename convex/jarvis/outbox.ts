// outbox.ts — the rows the output channel is written from, and nothing else.
//
// A LEAF: it imports only record.ts, so any file can read the last digest or
// open a needs-you without importing the Slack and digest modules (and the
// cycle back through them that left module constants undefined at load).
// convex/jarvis/digest.ts is the area; this is its floor.

import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { DAY_MS } from "../ttsShared";
import { insertEvent } from "./record";

export const DIGEST_SENT = "digest-sent";
export const NEEDS_YOU_OPENED = "needs-you-opened";
export const NEEDS_YOU_POSTED = "needs-you-posted";
export const DIGEST_LINE = "digest-line";

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

type DigestData = { day?: unknown; windowEnd?: unknown; channel?: unknown; ts?: unknown };

export function digestFacts(row: { data?: unknown } | null): {
  day: string | null;
  windowEnd: number | null;
  channel: string | null;
  ts: string | null;
} {
  const d = (row?.data ?? {}) as DigestData;
  return {
    day: typeof d.day === "string" ? d.day : null,
    windowEnd: typeof d.windowEnd === "number" ? d.windowEnd : null,
    channel: typeof d.channel === "string" ? d.channel : null,
    ts: typeof d.ts === "string" ? d.ts : null,
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
  }: { key: string; text: string; todoId?: Id<"dtsTodos">; job?: string; reason?: string },
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
  // ONCE A DAY PER SUBJECT, as the channel's per-day claim was: a rerun that
  // offers the same decision again (a Friday job's --overwrite), or a job that
  // fails on every run, is one line, not one per offer.
  const seen = await ctx.db
    .query("events")
    .withIndex("by_subject_at", (q) => q.eq("subject", subject).gte("at", Date.now() - DAY_MS))
    .filter((q) => q.eq(q.field("kind"), DIGEST_LINE))
    .first();
  if (seen !== null) return { listed: false };
  await insertEvent(ctx, { kind: DIGEST_LINE, subject, data: line });
  return { listed: true };
}
