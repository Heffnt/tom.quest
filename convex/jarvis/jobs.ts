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
// line: every accepted post is one row (the job said it again), and a row
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
// older than three of its intervals is a job-failed under `<job>:silent` and
// one #tts-broken line in the alarm's own words; the first clean run after it
// writes the recovery, which re-arms the alarm. A job with no job-ok row yet
// is not watched: the alarm is armed by the job's first clean run, so it
// cannot fire before the job is deployed.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { nyLocalHour, outputChannel, ttsDayKey } from "../ttsShared";
import { digestFacts, lastDigest } from "./outbox";
import { insertEvent } from "./record";

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
  if (row.provenance.job === undefined) throw new Error("a job-failed names its job in provenance.job");
  const key = row.subject;
  if (key !== undefined) {
    const standing = await standingFailure(ctx, key, row._id);
    // Already said, and still true. Saying it again adds no fact.
    if (standing !== null) {
      await ctx.db.patch(row._id, { data: { ...data, standingSince: standing.at } });
      return { reported: false, since: standing.at };
    }
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
 */
export async function failuresInWindow(
  ctx: QueryCtx,
  from: number,
  to: number,
): Promise<{ failed: Doc<"events">[]; recovered: Doc<"events">[] }> {
  const read = async (kind: string) =>
    await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", from).lt("at", to))
      .order("asc")
      .take(WINDOW_MAX);
  const failed = (await read(JOB_FAILED)).filter(
    (row) => (row.data as Record<string, unknown> | undefined)?.standingSince === undefined,
  );
  return { failed, recovered: await read(JOB_RECOVERED) };
}

/** The most rows of one kind a window reads: a failing job posts every tick,
 *  and a day of a two-minute job's repeats is 720 rows. */
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
  const key = row.subject;
  if (key === undefined) return { recovered: false };
  const standing = await standingFailure(ctx, key);
  if (standing === null) return { recovered: false };
  await recover(ctx, job ?? str((row.data as Record<string, unknown> | undefined)?.job) ?? "unknown", key, standing.at, row.at);
  return { recovered: true, since: standing.at };
}

/** The recovery row, which re-arms the condition's report. */
async function recover(ctx: MutationCtx, job: string, key: string, since: number, at: number): Promise<void> {
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
  // The box's digest writer (Jarvis worker/jobs/write-slack.mjs): the one
  // thing that writes to the output channel. The hourly update's idea — the
  // ABSENT message is the alarm — lives here now: when it stops, this says so.
  { job: "write-slack", everyMs: 2 * 60_000, feeds: "the digest and the needs-you replies" },
  // The box's record-tick (Jarvis worker/jobs/record-tick.mjs), which starts
  // the record's timed tasks now that Convex's crons are gone (tick.ts).
  { job: "record-tick", everyMs: 60_000, feeds: "the record's timed work (calendar, pull requests, repeats)" },
] as const;

/** The New York hour by which today's digest should be in the channel: an
 *  hour after it is due at 5, so a box that was briefly down is not an alarm. */
const DIGEST_LATE_NY_HOUR = 6;

/** A condition the alarm raises: the row and one line in the output channel,
 *  through the one Slack door, once until it recovers. The row directly, not
 *  recordEvent: the line is the alarm's own, and the job-failed hook's would
 *  be a second. */
async function raise(ctx: MutationCtx, job: string, key: string, error: string, now: number): Promise<void> {
  await insertEvent(ctx, { kind: JOB_FAILED, at: now, provenance: { job }, subject: key, data: { job, error }, text: error });
  const channel = outputChannel();
  if (channel === null) return;
  await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
    channel,
    text: `${error} ${AGENTS_WINDOW_URL}`,
    subject: { kind: "job", id: key },
  });
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
      await raise(ctx, job, key, error, now);
      continue;
    }
    if (standing !== null) {
      await recover(ctx, job, key, standing.at, now);
      recovered.push(job);
    }
  }
  // THE MORNING IS NEVER SILENT. The digest used to have a second writer (a
  // Convex template behind the model); it has one now, on the box, so its
  // absence is this alarm's to say: past 6 a.m. New York with no digest-sent
  // for today, one line, once, closed when the digest goes out.
  if (nyLocalHour(now) >= DIGEST_LATE_NY_HOUR) {
    const day = ttsDayKey(now);
    const key = `digest:${day}`;
    const standing = await standingFailure(ctx, key);
    const sentToday = digestFacts(await lastDigest(ctx)).day === day;
    if (!sentToday && standing === null) {
      silent.push("digest");
      await raise(ctx, "write-slack", key, `Today's digest (${day}) has not gone out: the box's write-slack job has not posted it.`, now);
    } else if (sentToday && standing !== null) {
      await recover(ctx, "write-slack", key, standing.at, now);
      recovered.push("digest");
    }
  }
  return { silent, recovered };
}
