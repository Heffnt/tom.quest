// A box job's own report about itself (the lifeos update, phase 6).
//
// A cron job on the Jarvis Box has one voice Tom hears: a dtsEvents row. The
// row is written through logEvent (convex/tts.ts), the one event writer, so it
// schedules the #tts-broken line in the same transaction (postBroken, deduped
// by job for the TTS day in internal.ttsSync.sendBroken). The digest then reads
// every "-failed" kind into its job-failures section (convex/ttsDigest.ts) and
// the hourly update names "job-failed" among the kinds it reports
// (convex/ttsHourly.ts). POST /tts/job-failed is the door.
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
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { logEvent } from "./tts";

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
    // Through the one event writer, which also schedules the #tts-broken
    // line. A suppressed report returned above, so it posts nothing.
    await logEvent(ctx, JOB_FAILED, undefined, { job, error }, key);
    return { reported: true };
  },
});

export const internalReportJobOk = internalMutation({
  args: { job: v.string(), key: v.string() },
  handler: async (
    ctx,
    { job, key },
  ): Promise<{ recovered: boolean; since?: number }> => {
    // THE HEARTBEAT, before anything else: a clean run is the one fact the
    // silence alarm below reads, whether or not it ends a failure.
    await beat(ctx, job, Date.now());
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

// ── THE SILENCE ALARM (plan-root T3) ────────────────────────────────────────
// Guarantee G4 says every change to the box is in the record within minutes.
// A reader that has stopped says nothing, so its silence is the thing to hear:
// every job below reports its clean runs through POST /tts/job-ok, which
// stamps jobHeartbeats (beat, above), and a cron here reads the stamps. A
// watched job whose last clean run is older than three of its intervals is a
// job-failed row under `<job>:silent` and one #tts-broken line naming how
// long it has been quiet; the first clean run after it writes the recovery
// row, which re-arms the alarm. A job with no heartbeat yet is not watched: the
// alarm is armed by the job's first clean run, so it cannot fire before the
// job is deployed.
//
// The intervals are the schedule's (Jarvis worker/jobs/schedule.json):
// box-watch every 2 minutes, box-state every 10, the sweep every 2.

/** The watched jobs: the name each reports under, and its interval. */
const SILENCE_WATCH = [
  { job: "box-watch", everyMs: 2 * 60_000, feeds: "changes to the box" },
  { job: "box-state", everyMs: 10 * 60_000, feeds: "the box's state comparison" },
  { job: "agents-sweep", everyMs: 2 * 60_000, feeds: "the agents' transcripts" },
] as const;

/** How many intervals of silence make a job silent: the plan's three, so one
 *  run lost to a lock or a slow tick is not an alarm. */
export const SILENCE_INTERVALS = 3;

async function beat(ctx: MutationCtx, job: string, at: number): Promise<void> {
  const row = await ctx.db
    .query("jobHeartbeats")
    .withIndex("by_job", (q) => q.eq("job", job))
    .first();
  if (row === null) await ctx.db.insert("jobHeartbeats", { job, lastOkAt: at });
  else if (row.lastOkAt < at) await ctx.db.patch(row._id, { lastOkAt: at });
}

function minutesWord(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/** The alarm's one pass: which watched jobs are silent, and which recovered. */
export const internalCheckSilence = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ silent: string[]; recovered: string[] }> => {
    const now = Date.now();
    const silent: string[] = [];
    const recovered: string[] = [];
    for (const { job, everyMs, feeds } of SILENCE_WATCH) {
      const heartbeat = await ctx.db
        .query("jobHeartbeats")
        .withIndex("by_job", (q) => q.eq("job", job))
        .first();
      if (heartbeat === null) continue;
      const key = `${job}:silent`;
      const standing = await standingFailure(ctx, key);
      const quiet = now - heartbeat.lastOkAt;
      if (quiet > SILENCE_INTERVALS * everyMs) {
        silent.push(job);
        if (standing !== null) continue;
        const error = `The ${job} job has not run clean for ${minutesWord(quiet)} (it runs every ${minutesWord(everyMs)}), so ${feeds} after that are not reaching the record.`;
        // The row directly, not logEvent: its #tts-broken line is the one
        // below, in the alarm's own words, and logEvent would post a second.
        await ctx.db.insert("dtsEvents", { at: now, kind: JOB_FAILED, key, data: { job, error } });
        await ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
          job: key,
          statement: error,
          url: "https://tom.quest/observe",
        });
        continue;
      }
      if (standing !== null) {
        await ctx.db.insert("dtsEvents", { at: now, kind: JOB_RECOVERED, key, data: { job, key, since: standing.at } });
        recovered.push(job);
      }
    }
    return { silent, recovered };
  },
});
