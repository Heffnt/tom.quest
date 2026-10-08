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
// ONE LINE IN THE DIGEST'S BROKEN SECTION PER CONDITION, NOT ONE PER TICK.
// The first failure ever reported was a dead Canvas access token, dead until
// Tom mints a new one, which is days. So a `job-failed` names the CONDITION
// it is about in `subject` (`poll-canvas:canvas-auth`, not the run), and a
// condition already reported and not since recovered gets no second line:
// every accepted post is one job-failed row (the job said it again), and a row
// posted while its condition stands carries `data.standingSince`, the time of
// the report it repeats, so a reader of reports (the digest) reads the rows
// without it. The standing check, the recovery and the rows are all `events`
// (night/w4, 2026-09-26; before, a second home in dtsEvents): a condition is
// standing when a job-failed under its subject is newer than its newest
// job-recovered, one read each on events.by_kind_subject_at.
//
// THE SILENCE ALARM (plan-root T3). Guarantee G4 says every change to the box
// is in the record within minutes. A reader that has stopped says nothing, so
// its silence is the thing to hear: checkSilence reads each watched job's
// newest `job-ok` on events.by_kind_job_at, and a job whose last clean run is
// older than three of its intervals is a job-failed row under `<job>:silent`
// (a line in the digest's broken section) and one silence-alarm line on the
// Jarvis thread in the alarm's own words, with one web push; the first clean run after it writes the recovery,
// which re-arms the alarm. A job with no job-ok row yet is not watched: the
// alarm is armed by the job's first clean run, so it cannot fire before the
// job is deployed.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { nyLocalHour, ttsDayKey } from "../ttsShared";
import { SILENCE_ALARM, THREAD_DIGEST } from "./outbox";
import { insertEvent } from "./record";
import { ReadBudget, readWithin } from "../readBudget";

/** The kind the digest reads as a job failure. */
export const JOB_FAILED = "job-failed";
/** The kind that closes one, written when the job next runs clean. */
export const JOB_RECOVERED = "job-recovered";
/** The kind a clean run writes: the heartbeat the silence alarm reads. */
export const JOB_OK = "job-ok";

/** Where a failure is read in time: the /agents page's window view. */
const AGENTS_WINDOW_URL = "https://tom.quest/agents?view=window";

/**
 * The report standing under this condition: the first job-failed under the
 * subject after its newest job-recovered, or null when it has recovered since
 * (or never failed). `except` is the row being hooked, which is not its own
 * standing report.
 */
async function standingFailure(
  ctx: MutationCtx,
  subject: string,
  except?: Id<"events">,
): Promise<Doc<"events"> | null> {
  const recovered = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", JOB_RECOVERED).eq("subject", subject))
    .order("desc")
    .first();
  const after = recovered?.at ?? -1;
  const failed = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", JOB_FAILED).eq("subject", subject).gt("at", after))
    .order("asc")
    .take(2);
  return failed.find((row) => row._id !== except) ?? null;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * The job-failed hook: once per standing condition. A post under a condition
 * already standing is marked with the time of the report it repeats, which is
 * what keeps it off the digest. Returns whether this call was the first report.
 */
export async function onJobFailed(ctx: MutationCtx, row: Doc<"events">): Promise<{ reported: boolean; since?: number }> {
  const data = (row.data ?? {}) as Record<string, unknown>;
  // Every writer names the job (Jarvis tts-lib reportJobFailed, POST
  // /tts/job-failed, the tick tasks, the silence alarm), and the digest's
  // line says which job failed, so a report without one is refused.
  const job = row.provenance.job;
  if (job === undefined) throw new Error("a job-failed names its job in provenance.job");
  // THE CONDITION DEFAULTS TO THE JOB. A report with no key (Jarvis tts-lib
  // reportJobFailed and POST /tts/job-failed both allow one) is about the job
  // itself: it is filed under the job's name, stands until the job next runs
  // clean (onJobOk), and every reader keys on the subject alone.
  const key = row.subject ?? job;
  if (row.subject === undefined) await ctx.db.patch(row._id, { subject: key });
  const standing = await standingFailure(ctx, key, row._id);
  // Already said, and still true. Saying it again adds no fact.
  if (standing !== null) {
    await ctx.db.patch(row._id, { data: { ...data, standingSince: standing.at } });
    return { reported: false, since: standing.at };
  }
  // No line of its own (one output channel): the digest's broken section
  // reads the report (failuresInWindow), once per condition.
  return { reported: true };
}

/**
 * The window's reported failures and recoveries, oldest first: every
 * job-failed that opened a condition (not a repeat of a standing one) and
 * every job-recovered that closed one. The digest's read of failures; the
 * Slack stream switches it to this.
 *
 * THE REPEATS ARE LEFT OUT BY THE INDEX, before the limit: by_kind_standing_at
 * reads only the rows with no data.standingSince, so a job failing every two
 * minutes all day adds nothing to the read and cannot push a new failure
 * past it.
 */
export async function failuresInWindow(
  ctx: QueryCtx,
  from: number,
  to: number,
  // The digest passes its allotment (convex/readBudget.ts); the weekly reads
  // by rows alone.
  budget: ReadBudget = ReadBudget.of(Number.POSITIVE_INFINITY),
): Promise<{ failed: Doc<"events">[]; recovered: Doc<"events">[] }> {
  const failed = await readWithin(
    budget,
    ctx.db
      .query("events")
      .withIndex("by_kind_standing_at", (q) =>
        q.eq("kind", JOB_FAILED).eq("data.standingSince", undefined).gte("at", from).lt("at", to),
      )
      .order("asc"),
    WINDOW_MAX,
  );
  const recovered = await readWithin(
    budget,
    ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", JOB_RECOVERED).gte("at", from).lt("at", to))
      .order("asc"),
    WINDOW_MAX,
  );
  return { failed, recovered };
}

/** The most rows of one kind a window reads: conditions opened, or closed,
 *  in one window, which is far fewer than this. */
const WINDOW_MAX = 4000;

/**
 * The job-ok hook: the row that just landed becomes the job's ONE job-ok row,
 * and a clean run that ENDS a reported failure writes the recovery.
 *
 * ONE JOB-OK ROW PER JOB. box-watch, box-state and the sweep alone would
 * write about 1,600 clean runs a day, and no reader wants any but the
 * newest: the silence alarm reads the last one (lastOkAt), and "when did
 * this job last run clean" is what GET /jarvis/events?kind=job-ok answers.
 * So the hook deletes the job's older job-ok rows on by_kind_job_at, the
 * same index the alarm reads. This is the fact jobHeartbeats held (one time
 * per job), kept as a row of the one record instead of a table of its own;
 * it cannot go without either bringing that table back or letting the record
 * grow by a heartbeat every two minutes, which is what the previous
 * generation wrote job-ok never to do.
 */
export async function onJobOk(ctx: MutationCtx, row: Doc<"events">): Promise<{ recovered: boolean; since?: number }> {
  const job = row.provenance.job;
  if (job !== undefined) {
    const older = await ctx.db
      .query("events")
      .withIndex("by_kind_job_at", (q) => q.eq("kind", JOB_OK).eq("provenance.job", job).lt("at", row.at))
      .collect();
    for (const previous of older) if (previous._id !== row._id) await ctx.db.delete(previous._id);
  }
  // The clean run re-arms the condition it names and, when that is not the
  // job itself, the job's own condition (a report filed without a key).
  let answer: { recovered: boolean; since?: number } = { recovered: false };
  for (const key of new Set([row.subject, job].filter((one): one is string => one !== undefined))) {
    const standing = await standingFailure(ctx, key);
    if (standing === null) continue;
    await recover(ctx, job ?? str((row.data as Record<string, unknown> | undefined)?.job) ?? "unknown", key, standing.at, row.at);
    if (key === row.subject || !answer.recovered) answer = { recovered: true, since: standing.at };
  }
  return answer;
}

/** The recovery row, which re-arms the condition's report. */
async function recover(ctx: MutationCtx, job: string, key: string, since: number, at: number): Promise<void> {
  await insertEvent(ctx, { kind: JOB_RECOVERED, at, provenance: { job }, subject: key, data: { job, key, since } });
}

// ── The silence alarm ────────────────────────────────────────────────────────
// The intervals are the schedule's (Jarvis worker/jobs/schedule.json):
// the sweep every 2 minutes; a tick task's is its cadence in tick.ts TASKS.
// box-watch and box-state are not watched: Jarvis removed box-watch on
// October 6, 2026, and the nightly comparison of the box replaces it.

/** The watched jobs: the name each reports under (the job-ok row's
 *  provenance.job, which lastOkAt reads), its interval, and, where that name
 *  is not plain words, the name the alarm's line prints. */
const SILENCE_WATCH: readonly { job: string; everyMs: number; feeds: string; says?: string }[] = [
  { job: "agents-sweep", everyMs: 2 * 60_000, feeds: "the agents' transcripts" },
  // The box's record-tick (Jarvis worker/jobs/record-tick.mjs), which starts
  // the record's timed tasks (tick.ts).
  { job: "record-tick", everyMs: 60_000, feeds: "the record's timed work (Turing health and pull requests)" },
  // The landing observer: tick.ts's pull-requests task, which mirrors the
  // open pull requests and lands each approved one whose gate turned green
  // (observeMerge.refreshOpenPulls). Its job-ok rows carry provenance.job
  // `tick:pull-requests` (tick.ts jobOf), so that is the name it is read
  // under; record-tick can run clean every minute while this task fails or
  // never finishes, so record-tick's watch does not cover it.
  {
    job: "tick:pull-requests",
    everyMs: 5 * 60_000,
    feeds: "the open pull requests and their landings",
    says: "pull-requests task (the landing observer)",
  },
];

/** The New York hour by which today's digest should be on the thread: an
 *  hour after it is due at 5, so one failed 05:00 run is retried once by the
 *  hourly cron (convex/crons.ts) before it is an alarm. */
const DIGEST_LATE_NY_HOUR = 6;

/** A condition the alarm raises: the row, one silence-alarm line on the
 *  Jarvis thread and one web push, once until it recovers. The row directly,
 *  not recordEvent: the line is the alarm's own, and the job-failed hook's
 *  would be a second. The push carries the line: it is made of job names and
 *  durations, none of them private. */
async function raise(ctx: MutationCtx, job: string, key: string, error: string, now: number): Promise<void> {
  await insertEvent(ctx, { kind: JOB_FAILED, at: now, provenance: { job }, subject: key, data: { job, error }, text: error });
  await insertEvent(ctx, {
    kind: SILENCE_ALARM,
    at: now,
    provenance: { job },
    subject: key,
    data: { job, href: AGENTS_WINDOW_URL },
    text: error,
  });
  await ctx.scheduler.runAfter(0, internal.pushSend.sendToAll, { title: "Silence alarm", body: error, url: "/thread" });
}

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
  for (const { job, everyMs, feeds, says } of SILENCE_WATCH) {
    const okAt = await lastOkAt(ctx, job);
    if (okAt === null) continue;
    const key = `${job}:silent`;
    const standing = await standingFailure(ctx, key);
    const quiet = now - okAt;
    if (quiet > SILENCE_INTERVALS * everyMs) {
      silent.push(job);
      if (standing !== null) continue;
      const error = `The ${says ?? `${job} job`} has not run clean for ${minutesWord(quiet)} (it runs every ${minutesWord(everyMs)}), so ${feeds} after that are not reaching the record.`;
      await raise(ctx, job, key, error, now);
      continue;
    }
    if (standing !== null) {
      await recover(ctx, job, key, standing.at, now);
      recovered.push(job);
    }
  }
  // THE MORNING DIGEST IS CHECKED HERE. The record's digest cron appends
  // today's thread-digest from 5 a.m. New York (convex/jarvis/digest.ts
  // appendThreadDigest); past 6 a.m. with no thread-digest for today, one
  // line, once, closed when the digest is appended.
  if (nyLocalHour(now) >= DIGEST_LATE_NY_HOUR) {
    const day = ttsDayKey(now);
    const key = `digest:${day}`;
    const standing = await standingFailure(ctx, key);
    const onThread = (await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", THREAD_DIGEST).eq("subject", day))
      .first()) !== null;
    if (!onThread && standing === null) {
      silent.push("digest");
      await raise(ctx, "digest", key, `Today's digest (${day}) is not on the thread: the record's digest cron has not appended it.`, now);
    } else if (onThread && standing !== null) {
      await recover(ctx, "digest", key, standing.at, now);
      recovered.push("digest");
    }
  }
  return { silent, recovered };
}
