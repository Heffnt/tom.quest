// tick.ts — the record's own scheduled work, run from the box.
//
// ONE SCHEDULER, ON THE BOX (Tom, 2026-09-26). Convex keeps one cron, the
// silence alarm, because it must fire when the box has gone quiet. Every other
// piece of timed work the record does is a task here, and the box's
// record-tick job (Jarvis worker/jobs/record-tick.mjs, every minute) POSTs
// /jarvis/tick, which starts each task whose cadence has come round. A task's
// last outcome is its own job-ok or job-failed row (provenance.job and
// subject `tick:<name>`), so each task's last refresh is a read of the record;
// a failing task is a failure line in the digest like any box
// job's, and a failing task is retried at its cadence, not every minute.
//
// The tasks, and what each keeps alive:
//   turing-health   /turing's reachability light (the debug panel reads the
//                   serverHealth row, fresh for 90 s): every minute.
//   pull-requests   the open pull requests mirror, and the landing of every
//                   approved one whose gate turned green: every 5 minutes.

import { v } from "convex/values";
import { httpAction, internalAction, internalMutation, type QueryCtx } from "../_generated/server";
import type { FunctionReference } from "convex/server";
import { internal } from "../_generated/api";
import { jarvisAuth, jsonResponse } from "./auth";
import { JOB_FAILED, JOB_OK } from "./jobs";
import { recordEvent } from "./events";
import { insertEvent } from "./record";

const MINUTE = 60_000;
const ACTION_LIMIT_MS = 10 * MINUTE;
const TICK_STARTED = "tick-started";

type Task = {
  /** The cadence. */
  when: { everyMs: number };
  /** A queued run older than this cannot still be alive and may be retried. */
  timeoutMs: number;
  run: { action: FunctionReference<"action", "internal", Record<string, unknown>> };
};

/** The tasks by name. A cadence is a floor: the box ticks every minute, so a
 *  task runs within a minute of coming due. */
const TICK_TASKS: Record<string, Task> = {
  "turing-health": { when: { everyMs: MINUTE }, timeoutMs: ACTION_LIMIT_MS, run: { action: internal.serverHealth.pollTuring } },
  "pull-requests": { when: { everyMs: 5 * MINUTE }, timeoutMs: ACTION_LIMIT_MS, run: { action: internal.observeMerge.refreshOpenPulls } },
};

/** The ticks' own slack: a task whose last run was a few seconds short of its
 *  cadence at a minute's tick is due, not a minute late. */
const EARLY_MS = 15_000;

const jobOf = (name: string) => `tick:${name}`;

/** What a task that caught its own failures says about them. A task that
 *  keeps going past one bad source (a mirrored repository)
 *  returns `{ failures: [...] }` instead of throwing, so the other sources
 *  still land; a non-empty list makes its run a job-failed row all the same. */
function failuresOf(result: unknown): string[] {
  const failures = (result as { failures?: unknown } | null | undefined)?.failures;
  return Array.isArray(failures) ? failures.filter((one): one is string => typeof one === "string") : [];
}

/** One task's newest outcome and newest lease, and whether that lease is a
 *  run still in flight: started after the newest outcome and younger than the
 *  task's timeout (a queued run older than that cannot still be alive). */
async function taskState(ctx: QueryCtx, name: string, now: number) {
  const job = jobOf(name);
  const ok = await ctx.db
    .query("events")
    .withIndex("by_kind_job_at", (q) => q.eq("kind", JOB_OK).eq("provenance.job", job))
    .order("desc")
    .first();
  const failed = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", JOB_FAILED).eq("subject", job))
    .order("desc")
    .first();
  const finished = [ok, failed]
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((left, right) => right.at - left.at || right._creationTime - left._creationTime)[0];
  const queued = await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", TICK_STARTED).eq("subject", job))
    .order("desc")
    .first();
  const inFlight = queued !== null && now - queued.at <= TICK_TASKS[name].timeoutMs && (
    finished === undefined ||
    queued.at > finished.at ||
    (queued.at === finished.at && queued._creationTime > finished._creationTime)
  );
  return { ok, failed, finished, inFlight };
}

/** POST /jarvis/tick's mutation: start every due task; answer their names. */
export const due = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ started: string[] }> => {
    const now = Date.now();
    const started: string[] = [];
    for (const [name, task] of Object.entries(TICK_TASKS)) {
      const job = jobOf(name);
      const { finished, inFlight } = await taskState(ctx, name, now);
      if (inFlight) continue;
      const last = finished?.at ?? 0;
      if (now - last < task.when.everyMs - EARLY_MS) continue;
      const leaseId = await insertEvent(ctx, {
        kind: TICK_STARTED,
        at: now,
        provenance: { job },
        subject: job,
        data: { task: name, timeoutMs: task.timeoutMs },
      });
      await ctx.scheduler.runAfter(0, internal.jarvis.tick.runTask, { name, leaseId });
      started.push(name);
    }
    return { started };
  },
});

/** Record one task's outcome and remove the exact lease that started it. The
 *  outcome and deletion share a transaction, so a completed run never leaves
 *  its tick-started row behind and can never delete a newer retry's lease. */
export const complete = internalMutation({
  args: {
    name: v.string(),
    leaseId: v.id("events"),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { name, leaseId, error }): Promise<null> => {
    const job = jobOf(name);
    await recordEvent(ctx, error === undefined
      ? {
          kind: JOB_OK,
          provenance: { job },
          subject: job,
          data: { job, key: job },
        }
      : {
          kind: JOB_FAILED,
          provenance: { job },
          subject: job,
          data: { job, error },
          text: `The ${name} task failed: ${error}`,
        });
    const lease = await ctx.db.get(leaseId);
    if (lease?.kind === TICK_STARTED && lease.subject === job) await ctx.db.delete(leaseId);
    return null;
  },
});

/** One task, and the row that says how it went. */
export const runTask = internalAction({
  args: { name: v.string(), leaseId: v.id("events") },
  handler: async (ctx, { name, leaseId }): Promise<{ ok: boolean }> => {
    const task = TICK_TASKS[name];
    if (task === undefined) throw new Error(`no tick task named ${name}`);
    let error: string | null = null;
    try {
      const result: unknown = await ctx.runAction(task.run.action, {});
      const failures = failuresOf(result);
      if (failures.length > 0) error = failures.join("; ");
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const completed: null = await ctx.runMutation(internal.jarvis.tick.complete, {
      name,
      leaseId,
      ...(error === null ? {} : { error }),
    });
    void completed;
    return { ok: error === null };
  },
});

/** POST /jarvis/tick — the box's record-tick job. Answers { ok, started }. */
export const tickRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const answer: { started: string[] } = await ctx.runMutation(internal.jarvis.tick.due, {});
  return jsonResponse(200, { ok: true, ...answer });
});
