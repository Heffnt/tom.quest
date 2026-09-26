// events.ts — the record's events table: the one write (record), the kind
// hooks, the reads, and the copy from the previous generation's table.
//
// HOW AN AREA JOINS. Its kinds go in shared/jarvis-events.mjs; a kind that
// has a side effect on the Convex side (a Slack line, a recovery, a todo
// touched) names its hook in AFTER_RECORD below, one line, importing the
// area's file under convex/jarvis/. The box posts every kind through the one
// route (routes.ts); nothing else on the box needs to know the hook exists.
//
// ONE LIST, NO DUPLICATES. dtsEvents rows that still arrive through POST
// /tts/event (deploy, box-change, evals-run, the learning runs...) are copied
// here by copyFromDts, called from that route, with `provenance: {}` and the
// old `key` as `subject`: a faithful copy, nothing invented. The copy is
// the route's, not the writer's (logEvent), because /tts/event is the box's
// one generic pen into dtsEvents and the other writers are Convex-internal
// facts (Slack, digest, merge, sessions) whose areas move them here in their
// own streams. A box change is no longer copied: the pen hands it to this
// table's own write (convex/ttsNightly.ts internalRecordBoxChange), and the
// box posts it through POST /jarvis/event with provenance.agentId, which is
// how the /agents chat finds it (convex/boxChanges.ts forAgent).

import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTom } from "../authRoles";
import { eventArgs, insertEvent } from "./record";
import type { EventInput } from "./record";
import { onJobFailed, onJobOk } from "./jobs";
import { onBoxChange } from "../boxChanges";
import { onDigestSent, onNeedsYouPosted } from "./digest";

/** What runs after a row of each kind lands, inside the same mutation. */
const AFTER_RECORD: Record<string, (ctx: MutationCtx, row: Doc<"events">) => Promise<unknown>> = {
  "job-ok": onJobOk,
  "job-failed": onJobFailed,
  "box-change": onBoxChange,
  "digest-sent": onDigestSent,
  "needs-you-posted": onNeedsYouPosted,
};

/** Insert one event and run its kind's hook. The hook's answer rides along. */
export async function recordEvent(
  ctx: MutationCtx,
  input: EventInput,
): Promise<{ id: Id<"events">; result?: unknown }> {
  const id = await insertEvent(ctx, input);
  const hook = AFTER_RECORD[input.kind];
  if (hook === undefined) return { id };
  const row = await ctx.db.get(id);
  if (row === null) return { id };
  return { id, result: await hook(ctx, row) };
}

/** POST /jarvis/event's mutation, and any Convex reporter's. */
export const record = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => await recordEvent(ctx, args),
});

/** The most rows one read answers. */
const LIST_MAX = 500;
const LIST_DEFAULT = 50;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return LIST_DEFAULT;
  return Math.min(Math.floor(limit), LIST_MAX);
}

/** Newest first, on the one index the filters name. */
async function listEvents(
  ctx: QueryCtx,
  { kind, subject, since, limit }: { kind?: string; subject?: string; since?: number; limit?: number },
): Promise<Doc<"events">[]> {
  const n = clampLimit(limit);
  const from = since ?? 0;
  if (subject !== undefined) {
    const rows = await ctx.db
      .query("events")
      .withIndex("by_subject_at", (q) => q.eq("subject", subject).gte("at", from))
      .order("desc")
      .take(kind === undefined ? n : LIST_MAX);
    return (kind === undefined ? rows : rows.filter((row) => row.kind === kind)).slice(0, n);
  }
  if (kind !== undefined) {
    return await ctx.db
      .query("events")
      .withIndex("by_kind_at", (q) => q.eq("kind", kind).gte("at", from))
      .order("desc")
      .take(n);
  }
  return await ctx.db
    .query("events")
    .withIndex("by_at", (q) => q.gte("at", from))
    .order("desc")
    .take(n);
}

/** GET /jarvis/events?kind=&since=&subject=&limit= */
export const list = internalQuery({
  args: {
    kind: v.optional(v.string()),
    subject: v.optional(v.string()),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => await listEvents(ctx, args),
});

/** The /agents page's strip: the newest rows of the record, every kind. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireTom(ctx, "Agents");
    return await listEvents(ctx, { limit });
  },
});

/** One agent's rows, oldest first, for the marked lines in its chat. */
export const forAgent = query({
  args: { agentId: v.string() },
  handler: async (ctx, { agentId }) => {
    await requireTom(ctx, "Agents");
    return await ctx.db
      .query("events")
      .withIndex("by_agent_at", (q) => q.eq("provenance.agentId", agentId))
      .order("asc")
      .take(LIST_MAX);
  },
});

/**
 * Copy one dtsEvents row into events, as it is: the kind it had, the key as
 * subject, no provenance (the old row carries none). Called by POST /tts/event
 * for every row it writes, until each area posts through /jarvis/event and
 * this, with the route, goes. Not validated against the kinds list: the row is
 * already in the record; the list governs what is posted.
 */
export const copyFromDts = internalMutation({
  args: { id: v.id("dtsEvents") },
  handler: async (ctx, { id }): Promise<Id<"events"> | null> => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    return await ctx.db.insert("events", {
      kind: row.kind,
      at: row.at,
      provenance: {},
      ...(row.key === undefined ? {} : { subject: row.key }),
      data: row.data === undefined ? {} : row.data,
    });
  },
});
