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
// here by copyDtsRow, in that route's one mutation, with `provenance: {}` and the
// old `key` as `subject`: a faithful copy, nothing invented. The copy is
// the route's, not the writer's (logEvent), because /tts/event is the box's
// one generic pen into dtsEvents and the other writers are Convex-internal
// facts (Slack, digest, merge, sessions) whose areas move them here in their
// own streams. A box change is no longer copied: the pen hands it to this
// table's own write (convex/ttsNightly.ts internalRecordBoxChange), and the
// box posts it through POST /jarvis/event with provenance.agentId, which is
// how the /agents chat finds it (convex/boxChanges.ts forAgent).

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTom } from "../authRoles";
import { checkEvent, eventArgs, insertEvent } from "./record";
import type { EventInput } from "./record";
import { onJobFailed, onJobOk } from "./jobs";
import { assertBoxChange, BOX_CHANGE, boxChangeSubject, onBoxChange } from "../boxChanges";
import { onDigestSent, onNeedsYouPosted } from "./digest";
import { resolveId } from "./tables";
import { HANDOFF, onTodoState, prepareBuildRow, TODO_STATE } from "./build";
import { SESSION_OUTCOME } from "../ttsShared";
import { REPEATS_BY_DATA_ID } from "../../shared/jarvis-events.mjs";

/** What runs after a row of each kind lands, inside the same mutation. */
const AFTER_RECORD: Record<string, (ctx: MutationCtx, row: Doc<"events">) => Promise<unknown>> = {
  "job-ok": onJobOk,
  "job-failed": onJobFailed,
  "box-change": onBoxChange,
  "digest-sent": onDigestSent,
  "needs-you-posted": onNeedsYouPosted,
  [TODO_STATE]: onTodoState,
};

/** Insert one event and run its kind's hook. The hook's answer rides along. */
export async function recordEvent(
  ctx: MutationCtx,
  input: EventInput,
): Promise<{ id: Id<"events">; result?: unknown }> {
  // A box change is checked whole before anything else, a resend's lookup
  // below included: a malformed post is refused whatever id it reuses.
  if (input.kind === BOX_CHANGE) assertBoxChange(input);
  // An outcome is counted on its todo by subject, so it names one that
  // exists, in either id form, and the row keeps the plain id.
  if (input.kind === SESSION_OUTCOME) {
    const todo = input.subject === undefined ? null : await resolveId(ctx, "todos", input.subject);
    if (todo === null) throw new Error(`a ${SESSION_OUTCOME} event names its todo as its subject`);
    input = { ...input, subject: todo };
    // A ruling id, when supplied with a session outcome, is normalized to the
    // rulings table's id.
    const data = input.data as { rulingId?: unknown } | undefined;
    if (data?.rulingId !== undefined) {
      const ruling = typeof data.rulingId === "string" ? await resolveId(ctx, "rulings", data.rulingId) : null;
      if (ruling === null) throw new Error(`a ${SESSION_OUTCOME} event's data.rulingId names no ruling`);
      input = { ...input, data: { ...data, rulingId: ruling } };
    }
  }
  // A build row names a todo that exists, and a handoff the one before it (build.ts).
  if (input.kind === TODO_STATE || input.kind === HANDOFF) await prepareBuildRow(ctx, input);
  // A RETRY IS NOT A SECOND FACT. A kind whose writer re-posts with a stable
  // data.id (shared/jarvis-events.mjs REPEATS_BY_DATA_ID) is recorded once:
  // a row of the kind with the same data.id already stands for it (one point
  // read on events.by_kind_data_id), and the caller is answered with that
  // row's id. A box change with an id is filed under that id as its subject.
  const repeats = (REPEATS_BY_DATA_ID as readonly string[]).includes(input.kind);
  const repeatId = (input.data as { id?: unknown } | undefined)?.id;
  if (repeats && typeof repeatId === "string" && repeatId !== "") {
    // The whole event is valid before it is matched: a retry is the same
    // well-formed event, never a malformed one that reuses an id.
    const checked = checkEvent(input);
    if (!checked.ok) throw new Error(checked.error);
    const kind = input.kind;
    const earlier = await ctx.db
      .query("events")
      .withIndex("by_kind_data_id", (q) => q.eq("kind", kind).eq("data.id", repeatId))
      .first();
    if (earlier !== null) return { id: earlier._id, result: { duplicate: true } };
    if (kind === BOX_CHANGE) input = { ...input, subject: boxChangeSubject(repeatId) };
  }
  const id = await insertEvent(ctx, input);
  const hook = AFTER_RECORD[input.kind];
  if (hook === undefined) return repeats ? { id, result: { duplicate: false } } : { id };
  const row = await ctx.db.get(id);
  if (row === null) return { id };
  return { id, result: await hook(ctx, row) };
}

/** POST /jarvis/event's mutation, and any Convex reporter's. */
export const record = internalMutation({
  args: eventArgs,
  handler: async (ctx, args) => await recordEvent(ctx, args),
});

/**
 * Tom's own door for the rows a build writes on a todo (build.ts): the same
 * checks and hook as the box's route, his provenance, and data.by "tom" on a
 * todo-state that names no other mover.
 */
export const recordForTom = mutation({
  args: {
    kind: v.union(v.literal(TODO_STATE), v.literal(HANDOFF)),
    subject: v.string(),
    data: v.any(),
    text: v.string(),
  },
  handler: async (ctx, { kind, subject, data, text }) => {
    await requireTom(ctx, "Agents");
    const given = data as Record<string, unknown> | null;
    const stamped =
      kind === TODO_STATE && typeof given === "object" && given !== null && given.by === undefined
        ? { ...given, by: "tom" }
        : data;
    return await recordEvent(ctx, { kind, subject, data: stamped, text, provenance: { user: "tom" } });
  },
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
  if (subject !== undefined && kind !== undefined) {
    return await ctx.db
      .query("events")
      .withIndex("by_kind_subject_at", (q) => q.eq("kind", kind).eq("subject", subject).gte("at", from))
      .order("desc")
      .take(n);
  }
  if (subject !== undefined) {
    return await ctx.db
      .query("events")
      .withIndex("by_subject_at", (q) => q.eq("subject", subject).gte("at", from))
      .order("desc")
      .take(n);
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
 * subject, no provenance (the old row carries none). POST /tts/event's
 * mutation (convex/ttsNightly.ts internalRecordWorkerEvent) calls it inside
 * the same transaction that wrote the old row, so the two tables hold the row
 * together or neither does. Not validated against the kinds list: the row is
 * already in the record; the list governs what is posted.
 */
export async function copyDtsRow(
  ctx: MutationCtx,
  row: Pick<Doc<"dtsEvents">, "kind" | "at" | "key" | "data">,
): Promise<Id<"events">> {
  return await ctx.db.insert("events", {
    kind: row.kind,
    at: row.at,
    provenance: {},
    ...(row.key === undefined ? {} : { subject: row.key }),
    data: row.data === undefined ? {} : row.data,
  });
}
