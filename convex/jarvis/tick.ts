// tick.ts — the record's own scheduled work, run from the box.
//
// ONE SCHEDULER, ON THE BOX (Tom, 2026-09-26). Convex keeps one cron, the
// silence alarm, because it must fire when the box has gone quiet. Every other
// piece of timed work the record does is a task here, and the box's
// record-tick job (Jarvis worker/jobs/record-tick.mjs, every minute) POSTs
// /jarvis/tick, which starts each task whose cadence has come round. A task's
// last outcome is its own job-ok or job-failed row (provenance.job and
// subject `tick:<name>`), so "when did the calendar last refresh" is a read
// of the record, a failing task is a failure line in the digest like any box
// job's, and a failing task is retried at its cadence, not every minute.
//
// The tasks, and what each keeps alive:
//   turing-health   /turing's reachability light (the debug panel reads the
//                   serverHealth row, fresh for 90 s): every minute.
//   pull-requests   the open pull requests mirror, and the landing of every
//                   approved one whose gate turned green: every 5 minutes.
//   calendar        the ICS feeds the digest and the planner read: hourly.
//   code-mirror     tom.quest's vqc/todos.yaml beside the life todos: 6 h.
//   repeats         the repeating todos, minted in the 4 a.m. New York hour
//                   before the 5 a.m. digest reads them; the mutation's own
//                   guard holds it to that hour and its provenance key makes a
//                   second call in the hour create nothing: every 30 minutes.

import { v } from "convex/values";
import { httpAction, internalAction, internalMutation } from "../_generated/server";
import type { FunctionReference } from "convex/server";
import { internal } from "../_generated/api";
import { jarvisAuth, jsonResponse } from "./auth";
import { JOB_FAILED, JOB_OK } from "./jobs";

const MINUTE = 60_000;

type Task = {
  everyMs: number;
  run:
    | { action: FunctionReference<"action", "internal", Record<string, unknown>> }
    | { mutation: FunctionReference<"mutation", "internal", Record<string, unknown>> };
};

/** The tasks by name. A cadence is a floor: the box ticks every minute, so a
 *  task runs within a minute of coming due. */
const TICK_TASKS: Record<string, Task> = {
  "turing-health": { everyMs: MINUTE, run: { action: internal.serverHealth.pollTuring } },
  "pull-requests": { everyMs: 5 * MINUTE, run: { action: internal.observeMerge.refreshOpenPulls } },
  calendar: { everyMs: 60 * MINUTE, run: { action: internal.ttsCalendarFetch.refreshFeeds } },
  "code-mirror": { everyMs: 6 * 60 * MINUTE, run: { action: internal.ttsSync.refreshMirror } },
  repeats: { everyMs: 30 * MINUTE, run: { mutation: internal.ttsRepeats.internalGenerateRepeats } },
};

/** The ticks' own slack: a task whose last run was a few seconds short of its
 *  cadence at a minute's tick is due, not a minute late. */
const EARLY_MS = 15_000;

const jobOf = (name: string) => `tick:${name}`;

/** POST /jarvis/tick's mutation: start every due task; answer their names. */
export const due = internalMutation({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, { now: givenNow }): Promise<{ started: string[] }> => {
    const now = givenNow ?? Date.now();
    const started: string[] = [];
    for (const [name, task] of Object.entries(TICK_TASKS)) {
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
      const last = Math.max(ok?.at ?? 0, failed?.at ?? 0);
      if (now - last < task.everyMs - EARLY_MS) continue;
      await ctx.scheduler.runAfter(0, internal.jarvis.tick.runTask, { name });
      started.push(name);
    }
    return { started };
  },
});

/** One task, and the row that says how it went. */
export const runTask = internalAction({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<{ ok: boolean }> => {
    const task = TICK_TASKS[name];
    if (task === undefined) throw new Error(`no tick task named ${name}`);
    const job = jobOf(name);
    try {
      if ("action" in task.run) await ctx.runAction(task.run.action, {});
      else await ctx.runMutation(task.run.mutation, {});
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await ctx.runMutation(internal.jarvis.events.record, {
        kind: JOB_FAILED,
        provenance: { job },
        subject: job,
        data: { job, error },
        text: `The ${name} task failed: ${error}`,
      });
      return { ok: false };
    }
    await ctx.runMutation(internal.jarvis.events.record, {
      kind: JOB_OK,
      provenance: { job },
      subject: job,
      data: { job, key: job },
    });
    return { ok: true };
  },
});

/** POST /jarvis/tick — the box's record-tick job. Answers { ok, started }. */
export const tickRoute = httpAction(async (ctx, request) => {
  const denied = jarvisAuth(request);
  if (denied) return denied;
  const answer: { started: string[] } = await ctx.runMutation(internal.jarvis.tick.due, {});
  return jsonResponse(200, { ok: true, ...answer });
});
