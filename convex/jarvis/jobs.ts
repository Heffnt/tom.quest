// jobs.ts — the jobs area: what a box job says about itself, and the silence
// alarm. Moved from convex/ttsJobs.ts on night/s3 (2026-09-26); ttsJobs.ts
// keeps the old function names as wrappers until its callers move.
//
// A cron job on the Jarvis Box has one voice Tom hears: a row of the record.
// A clean run is a `job-ok` event (provenance.job names the job, subject the
// condition it re-arms); a failure is a `job-failed` event; the run that ends
// a reported failure writes `job-recovered`. The box posts the first two
// through POST /jarvis/event (Jarvis tts-lib postEvent); the hooks below run
// on each, inside the same mutation.
//
// ONE #tts-broken LINE PER CONDITION, NOT ONE PER TICK. The first thing that
// ever spoke through this channel was a dead Canvas access token, dead until
// Tom mints a new one, which is days. So a `job-failed` names the CONDITION
// it is about in `subject` (`poll-canvas:canvas-auth`, not the run), and a
// condition already reported and not since recovered gets no second Slack
// line and no second digest row: the events row records that the job said it
// again (every accepted post is one row), the dtsEvents row and the line are
// written once. THE STANDING CHECK STILL READS dtsEvents tonight: the digest
// (convex/ttsDigest.ts), the hourly update (convex/ttsHourly.ts) and
// #tts-broken read failures there, and the Slack/digest stream moves those
// readers and this check to `events` together (an index by kind, subject, at),
// after which dtsEvents' job-failed and job-recovered rows go.
//
// THE SILENCE ALARM (plan-root T3). Guarantee G4 says every change to the box
// is in the record within minutes. A reader that has stopped says nothing, so
// its silence is the thing to hear: checkSilence reads each watched job's
// newest `job-ok` on events.by_kind_job_at, and a job whose last clean run is
// older than three of its intervals is a job-failed under `<job>:silent` and
// one #tts-broken line in the alarm's own words; the first clean run after it
// writes the recovery, which re-arms the alarm. A job with no job-ok row yet
// is not watched: the alarm is armed by the job's first clean run, so it
// cannot fire before the job is deployed.

import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { logEvent } from "../tts";
import { insertEvent } from "./record";

/** The kind the digest and the hourly update read as a job failure. */
export const JOB_FAILED = "job-failed";
/** The kind that closes one, written when the job next runs clean. */
export const JOB_RECOVERED = "job-recovered";
/** The kind a clean run writes: the heartbeat the silence alarm reads. */
export const JOB_OK = "job-ok";

/** The newest dtsEvents row of one kind under one key. */
async function newest(ctx: MutationCtx, kind: string, key: string): Promise<Doc<"dtsEvents"> | null> {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .order("desc")
    .first();
}

/** The failure standing under this key: reported, and not recovered since. */
async function standingFailure(ctx: MutationCtx, key: string): Promise<Doc<"dtsEvents"> | null> {
  const failed = await newest(ctx, JOB_FAILED, key);
  if (failed === null) return null;
  const recovered = await newest(ctx, JOB_RECOVERED, key);
  return recovered !== null && recovered.at >= failed.at ? null : failed;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The job-failed hook: the digest row and the #tts-broken line, once per
 * standing condition. Returns whether this call was the first report.
 */
export async function onJobFailed(ctx: MutationCtx, row: Doc<"events">): Promise<{ reported: boolean; since?: number }> {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const job = str(data.job) ?? row.provenance.job ?? "unknown";
  const error = str(data.error) ?? row.text ?? "";
  const key = row.subject;
  if (key !== undefined) {
    const standing = await standingFailure(ctx, key);
    // Already said, and still true. Saying it again adds no fact.
    if (standing !== null) return { reported: false, since: standing.at };
  }
  // Through the previous generation's event writer, which also schedules the
  // #tts-broken line. A suppressed report returned above, so it posts nothing.
  await logEvent(ctx, JOB_FAILED, undefined, { job, error }, key);
  return { reported: true };
}

/**
 * The job-ok hook: a clean run that ENDS a reported failure writes the
 * recovery; every other clean run is the heartbeat row alone.
 */
export async function onJobOk(ctx: MutationCtx, row: Doc<"events">): Promise<{ recovered: boolean; since?: number }> {
  const key = row.subject;
  if (key === undefined) return { recovered: false };
  const standing = await standingFailure(ctx, key);
  if (standing === null) return { recovered: false };
  const job = row.provenance.job ?? str((row.data as Record<string, unknown> | undefined)?.job) ?? "unknown";
  await recover(ctx, job, key, standing.at, row.at);
  return { recovered: true, since: standing.at };
}

/** The recovery, in both homes (see the header). */
async function recover(ctx: MutationCtx, job: string, key: string, since: number, at: number): Promise<void> {
  await ctx.db.insert("dtsEvents", { at, kind: JOB_RECOVERED, key, data: { job, key, since } });
  await insertEvent(ctx, { kind: JOB_RECOVERED, at, provenance: { job }, subject: key, data: { job, key, since } });
}

// ── The silence alarm ────────────────────────────────────────────────────────
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

/** When this job last said it ran clean, or null before its first job-ok. */
export async function lastOkAt(ctx: MutationCtx, job: string): Promise<number | null> {
  const row = await ctx.db
    .query("events")
    .withIndex("by_kind_job_at", (q) => q.eq("kind", JOB_OK).eq("provenance.job", job))
    .order("desc")
    .first();
  return row === null ? null : row.at;
}

function minutesWord(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} minutes`;
  return `${Math.round(minutes / 60)} hours`;
}

/** The alarm's one pass: which watched jobs are silent, and which recovered. */
export async function checkSilence(ctx: MutationCtx): Promise<{ silent: string[]; recovered: string[] }> {
  const now = Date.now();
  const silent: string[] = [];
  const recovered: string[] = [];
  for (const { job, everyMs, feeds } of SILENCE_WATCH) {
    const okAt = await lastOkAt(ctx, job);
    if (okAt === null) continue;
    const key = `${job}:silent`;
    const standing = await standingFailure(ctx, key);
    const quiet = now - okAt;
    if (quiet > SILENCE_INTERVALS * everyMs) {
      silent.push(job);
      if (standing !== null) continue;
      const error = `The ${job} job has not run clean for ${minutesWord(quiet)} (it runs every ${minutesWord(everyMs)}), so ${feeds} after that are not reaching the record.`;
      // The rows directly, not logEvent: its #tts-broken line is the one
      // below, in the alarm's own words, and logEvent would post a second.
      await ctx.db.insert("dtsEvents", { at: now, kind: JOB_FAILED, key, data: { job, error } });
      await insertEvent(ctx, { kind: JOB_FAILED, at: now, provenance: { job }, subject: key, data: { job, error }, text: error });
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
        job: key,
        statement: error,
        url: "https://tom.quest/observe",
      });
      continue;
    }
    if (standing !== null) {
      await recover(ctx, job, key, standing.at, now);
      recovered.push(job);
    }
  }
  return { silent, recovered };
}
