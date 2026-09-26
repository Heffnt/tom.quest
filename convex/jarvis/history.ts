// history.ts — the one-time copy of three kinds' history from dtsEvents into
// `events` (night/w4, 2026-09-26), run once by hand after the deploy that
// moved them, then deleted with the file.
//
// box-change, job-failed and job-recovered moved their home to `events`
// tonight: the box posts box changes through POST /jarvis/event with
// provenance.agentId, and the jobs area's standing check reads events. Their
// rows written before that live in dtsEvents only, and the readers that moved
// (an agent's chat, the /agents window view, the standing check, the weekly
// gather) would lose them. So each is copied once, as the record's own write
// would have made it:
//   - box-change: at = data.at, provenance { job, agentId } (boxChangeEvent);
//   - job-failed / job-recovered: provenance.job = data.job, subject = key.
// Rows at or after `before` are not copied: from the skeleton's deploy on,
// every such row already has its events twin (copyFromDts, or the job-failed
// post itself). The copies the skeleton made of box changes carry no agentId
// and the dtsEvents row's time; fixCopiedBoxChanges gives them both.
// Every mutation pages, so no call reads past a query's limits; each returns
// the cursor for the next call, null when done.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { BOX_CHANGE, boxChangeEvent, boxChangeOf } from "../boxChanges";
import { JOB_FAILED, JOB_RECOVERED } from "./jobs";

const PAGE = 200;

/** Whether `events` already holds this change (same kind, time and body). */
async function boxChangeCopied(ctx: MutationCtx, at: number, data: unknown): Promise<boolean> {
  const same = await ctx.db
    .query("events")
    .withIndex("by_kind_at", (q) => q.eq("kind", BOX_CHANGE).eq("at", at))
    .take(50);
  const body = JSON.stringify(data);
  return same.some((row) => JSON.stringify(row.data) === body);
}

async function copyOne(ctx: MutationCtx, row: Doc<"dtsEvents">): Promise<boolean> {
  if (row.kind === BOX_CHANGE) {
    const change = boxChangeOf(row.data);
    if (change === null) return false;
    if (await boxChangeCopied(ctx, change.at, row.data)) return false;
    const event = boxChangeEvent(change);
    await ctx.db.insert("events", { ...event, provenance: event.provenance });
    return true;
  }
  const data = (row.data ?? {}) as Record<string, unknown>;
  const job = typeof data.job === "string" && data.job !== "" ? data.job : undefined;
  await ctx.db.insert("events", {
    kind: row.kind,
    at: row.at,
    provenance: job === undefined ? {} : { job },
    ...(row.key === undefined ? {} : { subject: row.key }),
    data: row.data ?? {},
    ...(row.kind === JOB_FAILED && typeof data.error === "string" ? { text: data.error } : {}),
  });
  return true;
}

/** One page of one kind's history, oldest first, up to `before`. */
export const copyHistory = internalMutation({
  args: {
    kind: v.union(v.literal(BOX_CHANGE), v.literal(JOB_FAILED), v.literal(JOB_RECOVERED)),
    before: v.number(),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, { kind, before, cursor, dryRun }) => {
    const page = await ctx.db
      .query("dtsEvents")
      .withIndex("by_kind_at", (q) => q.eq("kind", kind).lt("at", before))
      .order("asc")
      .paginate({ cursor, numItems: PAGE });
    let copied = 0;
    if (dryRun !== true) for (const row of page.page) if (await copyOne(ctx, row)) copied += 1;
    return { read: page.page.length, copied, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** The skeleton's box-change copies: the agentId from data, the job, and
 *  `at` when the change happened. */
export const fixCopiedBoxChanges = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", BOX_CHANGE))
      .order("asc")
      .paginate({ cursor, numItems: PAGE });
    let fixed = 0;
    for (const row of page.page) {
      if (row.provenance.job !== undefined) continue;
      const change = boxChangeOf(row.data);
      if (change === null) continue;
      const event = boxChangeEvent(change);
      await ctx.db.patch(row._id, { at: event.at, provenance: event.provenance });
      fixed += 1;
    }
    return { read: page.page.length, fixed, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** The skeleton's job-failed rows, one per post: a post under a condition
 *  already standing is marked with the report it repeats, as the hook now
 *  marks it (convex/jarvis/jobs.ts onJobFailed). Oldest first, one page. */
export const markRepeats = internalMutation({
  args: { since: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { since, cursor }) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", JOB_FAILED).gte("at", since))
      .order("asc")
      .paginate({ cursor, numItems: PAGE });
    let marked = 0;
    for (const row of page.page) {
      const subject = row.subject;
      const data = (row.data ?? {}) as Record<string, unknown>;
      if (subject === undefined || data.standingSince !== undefined) continue;
      const recovered = await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) => q.eq("kind", JOB_RECOVERED).eq("subject", subject).lt("at", row.at))
        .order("desc")
        .first();
      const earlier = await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) =>
          q.eq("kind", JOB_FAILED).eq("subject", subject).gt("at", recovered?.at ?? -1).lt("at", row.at),
        )
        .order("asc")
        .first();
      if (earlier === null) continue;
      await ctx.db.patch(row._id, { data: { ...data, standingSince: earlier.at } });
      marked += 1;
    }
    return { read: page.page.length, marked, cursor: page.isDone ? null : page.continueCursor };
  },
});
