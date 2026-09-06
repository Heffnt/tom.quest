// A box job's own report about itself (the lifeos update, phase 6).
//
// A cron job on the Jarvis Box has one voice Tom hears: a dtsEvents row. The
// digest reads every "-failed" kind into its job-failures section
// (convex/ttsDigest.ts) and the hourly update names "job-failed" among the
// kinds it reports (convex/ttsHourly.ts), so a row written here is in front of
// him within the hour. POST /tts/job-failed is the door.
//
// ONE ROW PER CONDITION, NOT ONE PER TICK. The first thing that ever spoke
// through this channel was a dead Canvas access token — and a dead token is
// dead until Tom mints a new one, which is days. Reported unkeyed, that is one
// row every thirty minutes for ever: the morning digest lists them all, the
// hourly update reports the same sentence twenty-four times a day, and the one
// fact Tom needed to see is buried under its own repetitions.
//
// So a report may name the CONDITION it is about — `poll-canvas:canvas-auth`,
// not the run — and a condition already reported and not since recovered is
// not reported again. The job says so when it next runs clean (POST
// /tts/job-ok), which writes the recovery and re-arms the report for the next
// expiry. Nothing is lost either way: the failure row stays, the recovery row
// is its own fact with its own date, and both are readable for ever.
//
// A report with NO key is unconditional — one row per call, for a failure that
// is about this run and not about a standing condition.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/** The kind the digest and the hourly update read as a job failure. */
export const JOB_FAILED = "job-failed";
/** The kind that closes one, written when the job next runs clean. */
export const JOB_RECOVERED = "job-recovered";

/** The newest row of one kind under one key. */
async function newest(
  ctx: MutationCtx,
  kind: string,
  key: string,
): Promise<Doc<"dtsEvents"> | null> {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .order("desc")
    .first();
}

/**
 * The failure standing under this key: reported, and not recovered since.
 * Two reads on by_kind_key, the same index the #tts thread marker uses.
 */
async function standingFailure(
  ctx: MutationCtx,
  key: string,
): Promise<Doc<"dtsEvents"> | null> {
  const failed = await newest(ctx, JOB_FAILED, key);
  if (failed === null) return null;
  const recovered = await newest(ctx, JOB_RECOVERED, key);
  return recovered !== null && recovered.at >= failed.at ? null : failed;
}

export const internalReportJobFailed = internalMutation({
  args: { job: v.string(), error: v.string(), key: v.optional(v.string()) },
  handler: async (
    ctx,
    { job, error, key },
  ): Promise<{ reported: boolean; since?: number }> => {
    if (key !== undefined) {
      const standing = await standingFailure(ctx, key);
      // Already said, and still true. Saying it again adds no fact.
      if (standing !== null) return { reported: false, since: standing.at };
    }
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: JOB_FAILED,
      key,
      data: { job, error },
    });
    return { reported: true };
  },
});

export const internalReportJobOk = internalMutation({
  args: { job: v.string(), key: v.string() },
  handler: async (
    ctx,
    { job, key },
  ): Promise<{ recovered: boolean; since?: number }> => {
    const standing = await standingFailure(ctx, key);
    // A job that has not failed says nothing by running: only the run that
    // ENDS a reported failure is news, so only that one writes a row. A clean
    // run every thirty minutes must not become a row every thirty minutes.
    if (standing === null) return { recovered: false };
    await ctx.db.insert("dtsEvents", {
      at: Date.now(),
      kind: JOB_RECOVERED,
      key,
      data: { job, key, since: standing.at },
    });
    return { recovered: true, since: standing.at };
  },
});
