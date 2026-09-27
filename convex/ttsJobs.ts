// ttsJobs.ts — the previous generation's names for the jobs area, kept as
// wrappers until their callers move (convex/ttsMerge.ts, convex/ttsSignoff.ts,
// the /tts/job-failed and /tts/job-ok routes in
// convex/http.ts, and the silence-alarm cron in convex/crons.ts). The area
// itself is convex/jarvis/jobs.ts, and every report here is one row of the
// `events` table through convex/jarvis/events.ts recordEvent, the same path
// POST /jarvis/event takes. This file goes when the last caller names the
// new path (the deletion stream).

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { recordEvent } from "./jarvis/events";
import { checkSilence, JOB_FAILED, JOB_OK } from "./jarvis/jobs";

export { JOB_FAILED, JOB_RECOVERED, SILENCE_INTERVALS } from "./jarvis/jobs";

export const internalReportJobFailed = internalMutation({
  args: { job: v.string(), error: v.string(), key: v.optional(v.string()) },
  handler: async (ctx, { job, error, key }): Promise<{ reported: boolean; since?: number }> => {
    const { result } = await recordEvent(ctx, {
      kind: JOB_FAILED,
      provenance: { job },
      subject: key,
      data: { job, error },
      text: error,
    });
    return result as { reported: boolean; since?: number };
  },
});

export const internalReportJobOk = internalMutation({
  args: { job: v.string(), key: v.string() },
  handler: async (ctx, { job, key }): Promise<{ recovered: boolean; since?: number }> => {
    const { result } = await recordEvent(ctx, {
      kind: JOB_OK,
      provenance: { job },
      subject: key,
      data: { job, key },
    });
    return result as { recovered: boolean; since?: number };
  },
});

/** The alarm's one pass, on the cron's old name. */
export const internalCheckSilence = internalMutation({
  args: {},
  handler: async (ctx) => await checkSilence(ctx),
});
