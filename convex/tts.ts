import { v } from "convex/values";
import { composeCaptured, renderSlack } from "./ttsCompose";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTom, requireTomOrAgent } from "./authRoles";
import { INTEGRATION_SOURCE, integrationName } from "./ttsIntegrations";
import {
  DAY_MS,
  MAX_NEEDS,
  READINESS,
  SESSION_MODEL,
  goalCheckable,
  isPrepared,
  nyCalendarDayBoundsUtc,
  nyCalendarDayKey,
  normalizeSessionRepos,
  nyOffsetHours,
} from "./ttsShared";

// TTS (Delegated Todo System) — life-todo store, instrumentation, daily queue,
// and the code-todo mirror. Spec: WikiTom tts/spec.md. Everything Tom-facing is
// Tom-gated (forge.ts pattern); everything the Jarvis Box or crons touch goes
// through internal functions (http.ts routes are key-authed with TTS_WORKER_KEY).

// The WRITE gate: Tom only. Every mutation on this surface calls it.
async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "TTS");
}

// The READ gate: Tom, plus the `agent` role a TTS session browses as, because
// "TTS" is an agent-readable surface (convex/agentSurfaces.ts). Only query
// handlers the /tts page renders from call this — a reader that can also
// write is the thing this split exists to prevent.
async function requireTomOrAgentId(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  return await requireTomOrAgent(ctx, "TTS");
}

// Readiness is two values (ruling 18); READINESS, the two-value validator, is
// imported from ttsShared — Tom's door writes only those. The worker's pen
// below still ACCEPTS the retired spellings and stores them normalized.
const STATUS = v.union(
  v.literal("active"),
  v.literal("waiting"),
  v.literal("archived"),
  v.literal("done"),
);
const TIMING_CLASS = v.union(v.literal("dated"), v.literal("whenever"));
const DATE_KIND = v.union(v.literal("external"), v.literal("self-imposed"));
const DATE_OUTCOME = v.union(
  v.literal("done"),
  v.literal("renegotiated"),
  v.literal("missed"),
);
// ── Schema v2 graph shapes (ratified 2026-08-29) ─────────────────────────────
const ACTOR = v.union(v.literal("tom"), v.literal("agent"));
// A `needs` reference inside a plan-graph payload: a STRING is an existing
// dtsTodos id; a NUMBER is the index of a task EARLIER in the same payload, so
// a model can lay down a small graph in one call. The two are unambiguous (a
// Convex id is never a bare integer) and the backward-only index rule keeps
// in-payload edges acyclic by construction.
const NEED_REF = v.union(v.string(), v.number());
const GRAPH_TASK = v.object({
  id: v.optional(v.string()), // absent = create
  statement: v.string(),
  actor: ACTOR,
  needs: v.optional(v.array(NEED_REF)),
  condition: v.optional(v.string()),
  groundUpExplanation: v.optional(v.string()),
  evidence: v.optional(v.string()),
  status: v.optional(v.union(v.literal("active"), v.literal("done"))),
  // The model this task needs (schema: dtsTodos.model; the union is
  // ttsShared SESSION_MODELS). Absent means the fleet default the scheduler
  // resolves; the planner tags only the task that needs a particular model.
  // The HTTP route drops an unrecognized name before it reaches this union.
  model: v.optional(SESSION_MODEL),
});

// Array caps (Convex guideline: array fields on a document must be bounded —
// an unbounded array grows a single row without limit). A batch is FOR at
// most 20 goals and holds at most 40 tasks — the two numbers the retired v1
// batch used for its members and its plan steps, kept because the graph
// succeeds both and a batch has not become a bigger thing.
const MAX_BATCH_GOALS = 20;
const MAX_GRAPH_TASKS = 40;

// ── #tts-broken, from the one place failures are already written ─────────────
// Every job failure in the system is a "-failed" event kind. Rather than
// making each producer remember to post, the ONE event writer schedules the
// broken line — which is why there is no second list of failure kinds to keep
// in step with this one.
//
// Two exclusions, both load-bearing:
//   "slack-send-failed"  the Slack door's own. Posting it to Slack is the loop
//                        convex/ttsHourly.ts already warns about: a refused
//                        post would write a row that schedules another post.
//   "learning-revert-failed"  not a job failure at all — it is an objection
//                        the nightly job could not apply, and it belongs to
//                        the model-of-Tom line it is about.
const NOT_A_BROKEN_LINE = new Set(["slack-send-failed", "learning-revert-failed"]);

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export async function logEvent(
  ctx: MutationCtx,
  kind: string,
  todoId?: Id<"dtsTodos">,
  data?: unknown,
  // The indexed lookup key (schema: dtsEvents.key) — set on the kinds the
  // schema comment lists, and on no other.
  key?: string,
) {
  return await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind,
    todoId,
    data: data === undefined ? undefined : data,
    key,
  });
  if (kind.endsWith("-failed") && !NOT_A_BROKEN_LINE.has(kind)) {
    const d = (data ?? {}) as Record<string, unknown>;
    const job = str(d.job) ?? kind.replace(/-failed$/, "");
    // Scheduled, not awaited: the post is network I/O and this is a mutation.
    // It rides the transaction, so a rolled-back failure is never reported.
    // The action itself dedupes by job for the TTS day.
    await ctx.scheduler.runAfter(0, internal.ttsSync.sendBroken, {
      job,
      statement: `The ${job} job failed, so whatever it feeds you has stopped arriving.`,
      ...(str(d.error) === undefined ? {} : { detail: str(d.error) as string }),
    });
  }
}

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Inventory: everything, always (spec §6). Single-user table, small for years —
// a full collect is fine and lets the client group/filter freely.
export const listTodos = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgentId(ctx);
    return await ctx.db.query("dtsTodos").collect();
  },
});

export const listMirror = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgentId(ctx);
    return await ctx.db.query("dtsCodeTodoMirror").collect();
  },
});

// Every batches row (schema v2), for the page's batches tab. The Tom-facing
// twin of internalListBatches: a full collect, because the table holds a few
// dozen rows for years and the client picks its own grouping (paths) and
// filtering (status) out of the whole set.
export const listBatches = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgentId(ctx);
    return await ctx.db.query("batches").collect();
  },
});

// Focus: today's queue row (entries joined with their todos) — null when no
// prep has happened yet today.
export const listRecentEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireTomOrAgentId(ctx);
    return await ctx.db
      .query("dtsEvents")
      .withIndex("by_at")
      .order("desc")
      .take(Math.min(limit ?? 200, 1000));
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

export const createTodo = mutation({
  args: {
    statement: v.string(),
    body: v.optional(v.string()),
    timingClass: v.optional(TIMING_CLASS),
    dueAt: v.optional(v.number()),
    dateKind: v.optional(DATE_KIND),
    condition: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    const now = Date.now();
    const timingClass = args.timingClass ?? (args.dueAt ? "dated" : "whenever");
    const id = await ctx.db.insert("dtsTodos", {
      statement: args.statement.trim(),
      body: args.body,
      readiness: "unprepared",
      status: "active",
      timingClass,
      dueAt: args.dueAt,
      dateKind: args.dueAt ? (args.dateKind ?? "self-imposed") : undefined,
      condition: args.condition,
      category: args.category,
      source: "manual",
      workDescription: args.workDescription,
      entryAction: args.entryAction,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "created", id, { source: "manual" });
    return id;
  },
});

// Generic field edit. Only fields present in args change; updatedAt always
// bumps. Status transitions go through setStatus (they carry side effects).
export const updateTodo = mutation({
  args: {
    id: v.id("dtsTodos"),
    statement: v.optional(v.string()),
    body: v.optional(v.string()),
    readiness: v.optional(READINESS),
    timingClass: v.optional(TIMING_CLASS),
    dueAt: v.optional(v.union(v.number(), v.null())),
    dateKind: v.optional(DATE_KIND),
    condition: v.optional(v.string()),
    wakeAt: v.optional(v.union(v.number(), v.null())),
    unarchiveCondition: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    brief: v.optional(v.string()),
    category: v.optional(v.union(v.string(), v.null())),
    // Tom's line on a GOAL (schema: mustNotBreak); null clears it. This door
    // is the only writer — ruling 13.
    mustNotBreak: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    if (fields.mustNotBreak !== undefined && todo.kind !== "goal") {
      throw new Error(
        "mustNotBreak is a goal's field — this todo is not a goal",
      );
    }
    // Kept-dates rule (spec §8): a date never just disappears — the silent
    // slide is the one forbidden outcome. Clearing dueAt directly is refused;
    // dates leave via recordDateOutcome (done / renegotiated / missed).
    if (fields.dueAt === null && todo.dueAt !== undefined) {
      throw new Error(
        "A date is never cleared silently — resolve it via recordDateOutcome (renegotiated before the date, or missed)",
      );
    }
    const now = Date.now();
    // Every updateTodo edit is a Tom touch — tomTouchedAt marks the row FROZEN
    // to the planner (tts.internalStorePlanGraph never rewrites it).
    const patch: Record<string, unknown> = { updatedAt: now, tomTouchedAt: now };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      patch[key] = value === null ? undefined : value;
    }
    // Setting a due date on a whenever item promotes it to dated (spec §5.2);
    // an explicit timingClass in the same call wins.
    if (
      patch.dueAt !== undefined &&
      fields.timingClass === undefined &&
      todo.timingClass === "whenever"
    ) {
      patch.timingClass = "dated";
      if (patch.dateKind === undefined && todo.dateKind === undefined) {
        patch.dateKind = "self-imposed";
      }
    }
    await ctx.db.patch(id, patch);
    await logEvent(ctx, "updated", id, { fields: Object.keys(fields) });
  },
});

// The ONE place an open date resolves as kept when an item completes — called
// by setStatus(done) and recordDateOutcome(done) so the kept-dates side
// effects cannot drift between the two paths (review finding).
function resolveDateAsDone(
  todo: Doc<"dtsTodos">,
  now: number,
  note: string | undefined,
  patch: Record<string, unknown>,
) {
  patch.status = "done";
  patch.doneAt = now;
  if (todo.dueAt !== undefined) {
    patch.dateOutcomes = [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome: "done" as const, recordedAt: now, note },
    ];
    patch.dueAt = undefined;
  }
}

// The ONE implementation of a status transition (spec §5.1) — used by the
// Tom-gated setStatus below, by internalTriage (live sessions applying
// Tom's spoken rulings via `npx convex run`), and by ttsRulings.recordRuling
// (the archive verdict). Nothing is ever deleted: "archived" and "done" are
// the only terminal states, both kept and visible.
export async function applyStatusChange(
  ctx: MutationCtx,
  todo: Doc<"dtsTodos">,
  args: {
    status: "active" | "waiting" | "archived" | "done";
    wakeAt?: number;
    unarchiveCondition?: string;
    note?: string;
  },
) {
  const { status, wakeAt, unarchiveCondition, note } = args;
  const now = Date.now();
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "active") {
    // Reopening: stale terminal/sleep facts must not linger on a live item
    // (descriptive-never-evaluative demands the panel state be TRUE).
    patch.doneAt = undefined;
    patch.archivedAt = undefined;
    patch.unarchiveCondition = undefined;
    patch.wakeAt = undefined;
  }
  if (status === "waiting") {
    // A sleep is a TIME (the lifeos update, phase 7). The prose wake
    // condition this branch used to store is retired: what a row is waiting
    // for belongs in its statement, where every reader already looks.
    patch.wakeAt = wakeAt;
  }
  if (status === "archived") {
    patch.archivedAt = now;
    patch.unarchiveCondition = unarchiveCondition;
  }
  if (status === "done") {
    // An open date on a completed item resolves as kept (kept-dates rule).
    resolveDateAsDone(todo, now, note, patch);
  }
  await ctx.db.patch(todo._id, patch);
  await logEvent(ctx, "status-changed", todo._id, {
    from: todo.status,
    to: status,
    note,
  });
}

export const setStatus = mutation({
  args: {
    id: v.id("dtsTodos"),
    status: STATUS,
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    await applyStatusChange(ctx, todo, args);
    // Stamped HERE, not in applyStatusChange: agent-driven writes go through
    // that same transition (tts.internalMigrateToGraph archives a superseded
    // row with it), and an agent action must not stamp a Tom touch
    // (tomTouchedAt freezes the row to the planner).
    await ctx.db.patch(id, { tomTouchedAt: Date.now() });
  },
});

// Triage from a LIVE session with Tom (the Friday session, or any interactive
// session where he rules out loud and the session agent records it): an
// internal mutation so the agent can apply rulings via `npx convex run
// tts:internalTriage` with the deploy credentials Tom's machine holds. Only
// ever run while Tom is present and ruling — it is his pen, not a policy
// actor. Same status semantics as setStatus (one implementation), plus an
// optional self-imposed date for undated items (dated items keep the
// kept-dates rule: dates move only via recordDateOutcome).
export const internalTriage = internalMutation({
  args: {
    id: v.string(),
    status: v.optional(STATUS),
    dueAt: v.optional(v.number()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, dueAt, ...rest }) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    if (dueAt !== undefined) {
      if (todo.dueAt !== undefined) {
        throw new Error(
          "Item already has a date — move it via recordDateOutcome (kept-dates rule), not triage",
        );
      }
      await ctx.db.patch(normalized, {
        dueAt,
        dateKind: "self-imposed",
        timingClass: "dated",
        updatedAt: Date.now(),
      });
      await logEvent(ctx, "updated", normalized, { fields: ["dueAt"], via: "triage" });
    }
    if (status !== undefined) {
      const fresh = await ctx.db.get(normalized);
      if (fresh) await applyStatusChange(ctx, fresh, { status, ...rest });
    }
    // Triage is Tom's pen: a Tom touch, so the row is frozen to the planner —
    // but only when the call actually did something. A no-op/retry pen call
    // must not freeze a row.
    if (status !== undefined || dueAt !== undefined) {
      await ctx.db.patch(normalized, { tomTouchedAt: Date.now() });
    }
  },
});

// Bulk field edits from a LIVE session with Tom (the internalTriage pattern):
// an internal mutation so the session agent can record Tom's spoken rulings
// via `npx convex run tts:internalBulkUpdate` with the deploy credentials
// Tom's machine holds. Only ever run while Tom is present and ruling — it is
// his pen, not a policy actor.
export const internalBulkUpdate = internalMutation({
  args: {
    updates: v.array(
      v.object({
        id: v.string(),
        category: v.optional(v.union(v.string(), v.null())),
        entryAction: v.optional(v.string()),
        workDescription: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { updates }) => {
    for (const u of updates) {
      const normalized = ctx.db.normalizeId("dtsTodos", u.id);
      if (!normalized) throw new Error(`Unknown todo id: ${u.id}`);
      const todo = await ctx.db.get(normalized);
      if (!todo) throw new Error(`Unknown todo id: ${u.id}`);
      const now = Date.now();
      const patch: Record<string, unknown> = { tomTouchedAt: now };
      const fields: string[] = [];
      if (u.category !== undefined) {
        patch.category = u.category === null ? undefined : u.category;
        fields.push("category");
      }
      if (u.entryAction !== undefined) {
        patch.entryAction = u.entryAction;
        fields.push("entryAction");
      }
      if (u.workDescription !== undefined) {
        patch.workDescription = u.workDescription;
        fields.push("workDescription");
      }
      // Every field this pen writes is a content edit, so it bumps updatedAt;
      // a call that carries none must not (the ruledAt<updatedAt predicate
      // would resurface an already-ruled gate).
      if (fields.length > 0) patch.updatedAt = now;
      await ctx.db.patch(normalized, patch);
      await logEvent(ctx, "bulk-updated", normalized, { fields });
    }
  },
});

// The ONE implementation of the kept-dates rule (spec §8) — used by the
// Tom-gated recordDateOutcome below AND by internalApplyTimeNote (the time-note
// worker acting on Tom's written instruction), so the rule cannot drift between
// the two doors. Every date resolves to done | renegotiated | missed;
// renegotiation is only legal BEFORE the date arrives; the silent slide is the
// one forbidden outcome. "renegotiated" and "missed" both take a newDueAt only
// when the item stays dated ("missed" without a new date drops the item back to
// whenever with the miss on record).
export async function applyDateOutcome(
  ctx: MutationCtx,
  todo: Doc<"dtsTodos">,
  {
    outcome,
    newDueAt,
    note,
  }: {
    outcome: "done" | "renegotiated" | "missed";
    newDueAt?: number;
    note?: string;
  },
) {
  if (todo.dueAt === undefined) throw new Error("Todo has no date to resolve");
  const now = Date.now();
  if (outcome === "renegotiated") {
    if (now >= todo.dueAt) {
      throw new Error(
        "Renegotiation is only allowed before the date arrives — record it as missed, then set a new date",
      );
    }
    if (newDueAt === undefined) {
      throw new Error("Renegotiation requires the new date");
    }
  }
  const patch: Record<string, unknown> = {
    updatedAt: now,
    dateOutcomes: [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome, recordedAt: now, note },
    ],
  };
  if (outcome === "done") {
    resolveDateAsDone(todo, now, note, patch); // overwrites dateOutcomes consistently
  } else if (newDueAt !== undefined) {
    patch.dueAt = newDueAt;
    if (todo.dateKind === undefined) patch.dateKind = "self-imposed";
  } else {
    patch.dueAt = undefined;
    patch.timingClass = "whenever";
  }
  await ctx.db.patch(todo._id, patch);
  await logEvent(ctx, "date-outcome", todo._id, { outcome, newDueAt, note });
}

// The 5 a.m. rollover's OWN door (ruling 14, the lifeos update) — deliberately
// NOT applyDateOutcome above, because the rollover is not Tom resolving a date.
// It records that a date passed unanswered and changes NOTHING else:
//   - the date stays, so the item is still listed overdue with its own date;
//   - dateKind stays exactly as it was. Going through applyDateOutcome with
//     newDueAt = todo.dueAt would stamp "self-imposed" on any row that had no
//     dateKind (line 663 above), quietly rewriting an unlabelled external
//     deadline as one Tom set himself;
//   - updatedAt is NOT bumped. This is an annotation by a cron, not a content
//     edit, and the needs-me predicate resurfaces an already-ruled gate when
//     ruledAt < updatedAt (the same reasoning as internalBulkUpdate's).
// The outcome row itself is written in the one shape every reader knows.
export async function recordMissedKeepingDate(
  ctx: MutationCtx,
  todo: Doc<"dtsTodos">,
  note?: string,
) {
  if (todo.dueAt === undefined) throw new Error("Todo has no date to resolve");
  const now = Date.now();
  await ctx.db.patch(todo._id, {
    dateOutcomes: [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome: "missed" as const, recordedAt: now, note },
    ],
  });
  // `rollover: true` marks the row as the system's, not Tom's: the weekly
  // gather counts a date outcome as a touch of his unless it carries this
  // (convex/ttsWeekly.ts isTomTouch).
  await logEvent(ctx, "date-outcome", todo._id, {
    outcome: "missed",
    newDueAt: todo.dueAt,
    note,
    rollover: true,
  });
}

export const recordDateOutcome = mutation({
  args: {
    id: v.id("dtsTodos"),
    outcome: DATE_OUTCOME,
    newDueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    await applyDateOutcome(ctx, todo, args);
  },
});

// ── Blocks: committed time (ratified 2026-08-28) ─────────────────────────────
// One row = one placed span on Tom's calendar, targeting exactly one todo
// (per-todo commitment) or one category ("chores"; "code" = the code-todo
// mirror). Blocks are calendar strokes, not todos — moving or deleting one is
// rescheduling, recorded as an event, never a "ruling".

function requireOneBlockTarget(todoId: unknown, category: unknown) {
  if ((todoId === undefined) === (category === undefined)) {
    throw new Error(
      "A block targets exactly one thing: a todoId OR a category",
    );
  }
}

// Optional [start, end) window: blocks overlapping it (block.start < end AND
// block.end > start), served from the by_start index so the calendar's
// subscription carries one week, not the whole ever-growing table. No args =
// everything (small-table admin/test use).
export const listBlocks = query({
  args: { start: v.optional(v.number()), end: v.optional(v.number()) },
  handler: async (ctx, { start, end }) => {
    await requireTomOrAgentId(ctx);
    const rows =
      end === undefined
        ? await ctx.db.query("dtsBlocks").collect()
        : await ctx.db
            .query("dtsBlocks")
            .withIndex("by_start", (q) => q.lt("start", end))
            .collect();
    return start === undefined ? rows : rows.filter((b) => b.end > start);
  },
});

// The ONE implementation of each block write (the applyStatusChange pattern) —
// shared by the Tom-gated mutations below and by internalApplyTimeNote, so a
// time note placing a block obeys exactly the same validation as the calendar.

export async function insertBlock(
  ctx: MutationCtx,
  {
    start,
    end,
    todoId,
    category,
    note,
  }: {
    start: number;
    end: number;
    todoId?: Id<"dtsTodos">;
    category?: string;
    note?: string;
  },
) {
  // Trim BEFORE the exactly-one check: a whitespace-only category must not
  // pass the check and then collapse into a targetless block.
  const trimmedCategory = category?.trim() || undefined;
  requireOneBlockTarget(todoId, trimmedCategory);
  if (end <= start) throw new Error("A block ends after it starts");
  if (todoId !== undefined) {
    const todo = await ctx.db.get(todoId);
    if (!todo) throw new Error("TTS todo not found");
  }
  const id = await ctx.db.insert("dtsBlocks", {
    start,
    end,
    todoId,
    category: trimmedCategory,
    note,
    createdAt: Date.now(),
  });
  await logEvent(ctx, "block-created", todoId, {
    start,
    end,
    category: trimmedCategory,
  });
  return id;
}

export async function patchBlock(
  ctx: MutationCtx,
  block: Doc<"dtsBlocks">,
  { start, end, note }: { start?: number; end?: number; note?: string | null },
) {
  const nextStart = start ?? block.start;
  const nextEnd = end ?? block.end;
  if (nextEnd <= nextStart) throw new Error("A block ends after it starts");
  await ctx.db.patch(block._id, {
    start: nextStart,
    end: nextEnd,
    note: note === null ? undefined : (note ?? block.note),
  });
  // block-moved only when the span actually changed — a note-only edit is
  // not a move and must not fake one in the event stream.
  if (nextStart !== block.start || nextEnd !== block.end) {
    await logEvent(ctx, "block-moved", block.todoId, {
      from: { start: block.start, end: block.end },
      to: { start: nextStart, end: nextEnd },
      category: block.category,
    });
  }
}

export async function removeBlock(ctx: MutationCtx, block: Doc<"dtsBlocks">) {
  await ctx.db.delete(block._id);
  await logEvent(ctx, "block-deleted", block.todoId, {
    start: block.start,
    end: block.end,
    category: block.category,
  });
}

export const createBlock = mutation({
  args: {
    start: v.number(),
    end: v.number(),
    todoId: v.optional(v.id("dtsTodos")),
    category: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    return await insertBlock(ctx, args);
  },
});

export const updateBlock = mutation({
  args: {
    id: v.id("dtsBlocks"),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const block = await ctx.db.get(id);
    if (!block) throw new Error("Block not found");
    await patchBlock(ctx, block, args);
  },
});

export const deleteBlock = mutation({
  args: { id: v.id("dtsBlocks") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    const block = await ctx.db.get(id);
    if (!block) throw new Error("Block not found");
    await removeBlock(ctx, block);
  },
});

// ── Time notes (ratified 2026-08-29) ─────────────────────────────────────────
// The /dts page has no date or time pickers left. Tom writes one sentence
// against exactly one context — a todo, a block, or a calendar day — and the
// worker job apply-time-notes.mjs reads it and asks for concrete actions via
// internalApplyTimeNote. The server re-validates EVERY action against the same
// helpers the Tom-gated mutations use (kept dates, block target/span), so a
// misread note is refused, not silently obeyed; the job then re-submits the
// note as "needs-session" carrying the server's reason.

// How long an applied note stays on the page after it lands (descriptive
// transparency: Tom sees what just happened, then it stops being clutter).
const TIME_NOTE_VISIBLE_MS = 24 * 3_600_000;

function requireOneTimeNoteContext(
  todoId: unknown,
  blockId: unknown,
  day: unknown,
) {
  const set = [todoId, blockId, day].filter((x) => x !== undefined).length;
  if (set !== 1) {
    throw new Error(
      "A time note has exactly one context: a todoId, a blockId, or a day",
    );
  }
}

// A day-scoped note carries the calendar-date LABEL of the column Tom clicked
// ("YYYY-MM-DD"), never a timestamp. The server reads it as a New York calendar
// day (nyCalendarDayBoundsUtc), so the browser's own timezone cannot decide
// which day a note is about.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// A day the page could not paint anyway is not worth a range query: an
// unbounded list is capped so one subscription stays one page-worth of rows.
const TIME_NOTE_LIST_MAX = 200;

export const listTimeNotes = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgentId(ctx);
    const byStatus = (status: "pending" | "needs-session" | "applied") =>
      ctx.db
        .query("dtsTimeNotes")
        .withIndex("by_status_and_resolvedAt", (q) => q.eq("status", status));
    // Applied notes are kept forever (instrumentation); only the last 24h of
    // them ride the page's subscription — hence resolvedAt in the index. The
    // pending/needs-session arms have no time bound of their own, so they take
    // a fixed page instead of collecting an unbounded backlog.
    const cutoff = Date.now() - TIME_NOTE_VISIBLE_MS;
    const [pending, needsSession, recentlyApplied] = await Promise.all([
      byStatus("pending").take(TIME_NOTE_LIST_MAX),
      byStatus("needs-session").take(TIME_NOTE_LIST_MAX),
      ctx.db
        .query("dtsTimeNotes")
        .withIndex("by_status_and_resolvedAt", (q) =>
          q.eq("status", "applied").gte("resolvedAt", cutoff),
        )
        .collect(),
    ]);
    return [...pending, ...needsSession, ...recentlyApplied];
  },
});

// One args object and one body behind two doors (the claudeSessions pattern):
// Tom's browser mutation, and the internal twin a Slack reply that says only
// "done" or a date goes through (convex/ttsSlack.ts) — a time note is Tom's
// own written instruction either way, and the pen may never skip a check the
// browser enforces.
const CREATE_TIME_NOTE_ARGS = {
  text: v.string(),
  todoId: v.optional(v.id("dtsTodos")),
  blockId: v.optional(v.id("dtsBlocks")),
  day: v.optional(v.string()),
};

async function createTimeNoteFrom(
  ctx: MutationCtx,
  {
    text,
    todoId,
    blockId,
    day,
  }: {
    text: string;
    todoId?: Id<"dtsTodos">;
    blockId?: Id<"dtsBlocks">;
    day?: string;
  },
): Promise<Id<"dtsTimeNotes">> {
  const trimmed = text.trim();
  if (trimmed === "") throw new Error("A time note needs text");
  requireOneTimeNoteContext(todoId, blockId, day);
  if (day !== undefined && !DAY_KEY_RE.test(day)) {
    throw new Error(`A day is a calendar date, YYYY-MM-DD — got ${day}`);
  }
  if (todoId !== undefined && !(await ctx.db.get(todoId))) {
    throw new Error("TTS todo not found");
  }
  if (blockId !== undefined && !(await ctx.db.get(blockId))) {
    throw new Error("Block not found");
  }
  const id = await ctx.db.insert("dtsTimeNotes", {
    text: trimmed,
    todoId,
    blockId,
    day,
    status: "pending",
    createdAt: Date.now(),
  });
  await logEvent(ctx, "time-note", todoId, { text: trimmed, blockId, day });
  return id;
}

export const createTimeNote = mutation({
  args: CREATE_TIME_NOTE_ARGS,
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    return await createTimeNoteFrom(ctx, args);
  },
});

export const internalCreateTimeNote = internalMutation({
  args: CREATE_TIME_NOTE_ARGS,
  handler: async (ctx, args) => await createTimeNoteFrom(ctx, args),
});

// Tom withdraws a note he no longer wants acted on. An APPLIED note is not
// deletable — it already changed the world, and its record is the only trace
// of why (nothing-ever-lost applies to what happened, not to what is queued).
export const deleteTimeNote = mutation({
  args: { id: v.id("dtsTimeNotes") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    const note = await ctx.db.get(id);
    if (!note) throw new Error("Time note not found");
    if (note.status === "applied") {
      throw new Error("An applied time note is history — it is not deleted");
    }
    await ctx.db.delete(id);
    await logEvent(ctx, "time-note-deleted", note.todoId, { text: note.text });
  },
});

// The actions a time note may ask for. Every one of them is validated again
// below against the same helpers the equivalent Tom-gated mutation uses.
const TIME_NOTE_ACTION = v.union(
  v.object({
    kind: v.literal("set-due"),
    dueAt: v.number(),
    dateKind: v.optional(DATE_KIND),
  }),
  v.object({
    kind: v.literal("renegotiate"),
    newDueAt: v.number(),
    note: v.optional(v.string()),
  }),
  // A miss may come with the replacement date in the same breath ("I blew
  // Tuesday, do it Friday") — the outcome row records the miss, newDueAt is the
  // new date. Omit it and the item drops back to whenever with the miss on
  // record (applyDateOutcome's existing two branches).
  v.object({
    kind: v.literal("record-missed"),
    newDueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  }),
  // The date stands; only its NATURE was misread ("that deadline is the
  // landlord's, not mine").
  v.object({ kind: v.literal("set-date-kind"), dateKind: DATE_KIND }),
  // A sleep is a time and nothing else. `set-latest-safe`, `clear-latest-safe`
  // and a `wakeCondition` on this action were the roll-out shim of the lifeos
  // update's phase 7 — declared, accepted and doing nothing, because the box
  // rolls out separately from a Convex deploy and a mutation refuses an
  // argument it does not declare. worker/setup.sh has since run at main
  // 6825608, so nothing emits them and they are gone: the route refuses them
  // by name (convex/http.ts), and what a row waits FOR belongs in its
  // statement.
  v.object({ kind: v.literal("set-waiting"), wakeAt: v.optional(v.number()) }),
  v.object({ kind: v.literal("set-active") }),
  v.object({
    kind: v.literal("create-block"),
    start: v.number(),
    end: v.number(),
    todoId: v.optional(v.string()),
    category: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("update-block"),
    blockId: v.string(),
    start: v.number(),
    end: v.number(),
  }),
  v.object({ kind: v.literal("delete-block"), blockId: v.string() }),
);

// The pending queue with the full context each note needs, for the worker job
// (POST /tts/time-notes). Nothing here is a decision — it is the facts the
// note is about, so the job never has to guess what "it" refers to.
export const internalPendingTimeNotes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const notes = await ctx.db
      .query("dtsTimeNotes")
      .withIndex("by_status_and_resolvedAt", (q) => q.eq("status", "pending"))
      .take(TIME_NOTE_LIST_MAX);
    if (notes.length === 0) return [];
    // Blocks are read PER NEEDED WINDOW off by_start, never as a whole table:
    // one NY calendar day per note that needs one, memoized so N notes on the
    // same day cost one range query. "That day's blocks" = the blocks that
    // START that day — the same rule the day column paints by.
    const blocksByDay = new Map<string, Doc<"dtsBlocks">[]>();
    const dayBlocks = async (dayKey: string) => {
      const cached = blocksByDay.get(dayKey);
      if (cached) return cached;
      let rows: Doc<"dtsBlocks">[] = [];
      // A key that is not a calendar date has no window. createTimeNote is the
      // only writer and validates the same shape, but this read serves the
      // whole worker queue every two minutes: one malformed row must not take
      // every other note down with a NaN range query.
      if (DAY_KEY_RE.test(dayKey)) {
        const { start, end } = nyCalendarDayBoundsUtc(dayKey);
        rows = await ctx.db
          .query("dtsBlocks")
          .withIndex("by_start", (q) => q.gte("start", start).lt("start", end))
          .collect();
      }
      blocksByDay.set(dayKey, rows);
      return rows;
    };
    // The active list is the same for every day-scoped note, and most runs have
    // none at all — read it once, lazily.
    let activeTodos: Doc<"dtsTodos">[] | null = null;
    const activeOnce = async () => {
      activeTodos ??= await ctx.db
        .query("dtsTodos")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
      return activeTodos;
    };
    const out = [];
    for (const note of notes) {
      let context: unknown = null;
      if (note.todoId !== undefined) {
        const todo = await ctx.db.get(note.todoId);
        context = todo
          ? {
              kind: "todo",
              todo: {
                _id: todo._id,
                statement: todo.statement,
                status: todo.status,
                timingClass: todo.timingClass,
                dueAt: todo.dueAt ?? null,
                dateKind: todo.dateKind ?? null,
                wakeAt: todo.wakeAt ?? null,
                dateOutcomes: todo.dateOutcomes ?? [],
              },
            }
          : { kind: "todo", todo: null };
      } else if (note.blockId !== undefined) {
        const block = await ctx.db.get(note.blockId);
        context = block
          ? {
              kind: "block",
              block,
              // Same NY calendar date as the block — what else is committed
              // that day, so a move can be judged against the day's shape.
              sameDayBlocks: (
                await dayBlocks(nyCalendarDayKey(block.start))
              ).filter((b) => b._id !== block._id),
            }
          : { kind: "block", block: null, sameDayBlocks: [] };
      } else if (note.day !== undefined) {
        context = {
          kind: "day",
          dayBlocks: await dayBlocks(note.day),
          activeTodos: (await activeOnce()).map((t) => ({
            _id: t._id,
            statement: t.statement,
            category: t.category ?? null,
            dueAt: t.dueAt ?? null,
          })),
        };
      }
      out.push({ ...note, context });
    }
    return out;
  },
});

// The worker's write-back (POST /tts/apply-time-note). Every action is
// re-validated HERE with the shared helpers — applyDateOutcome for kept dates,
// applyStatusChange for waiting/active, insert/patch/removeBlock for the
// calendar — so the agent's reading of Tom's sentence is a PROPOSAL, never an
// authority. Any rejection throws, the whole mutation rolls back (note left
// pending), and the job re-submits it as "needs-session" with the reason.
export const internalApplyTimeNote = internalMutation({
  args: {
    id: v.string(),
    status: v.union(v.literal("applied"), v.literal("needs-session")),
    result: v.string(),
    actions: v.optional(v.array(TIME_NOTE_ACTION)),
  },
  handler: async (ctx, { id, status, result, actions }) => {
    const normalized = ctx.db.normalizeId("dtsTimeNotes", id);
    if (!normalized) throw new Error(`Unknown time note id: ${id}`);
    const note = await ctx.db.get(normalized);
    if (!note) throw new Error(`Unknown time note id: ${id}`);
    if (note.status !== "pending") {
      throw new Error(`Time note is already ${note.status}`);
    }
    if (result.trim() === "") throw new Error("result (one sentence) required");
    const list = actions ?? [];
    if (status === "needs-session" && list.length > 0) {
      throw new Error("A needs-session time note carries no actions");
    }

    const now = Date.now();
    // The todo the note is about — the only subject a todo-scoped action may
    // touch (a day/block note has none, so those actions are refused). RE-READ
    // per action, never hoisted: one note may carry a sequence ("I missed
    // Tuesday, do it Friday"), and a Convex read sees this mutation's own
    // earlier writes, so action N validates against action N−1's RESULT rather
    // than against a snapshot from before the loop.
    const requireSubject = async (kind: string) => {
      const subject = note.todoId ? await ctx.db.get(note.todoId) : null;
      if (!subject) {
        throw new Error(`${kind} needs a time note written on a todo`);
      }
      return subject;
    };
    const getBlock = async (raw: string) => {
      const blockId = ctx.db.normalizeId("dtsBlocks", raw);
      const block = blockId && (await ctx.db.get(blockId));
      if (!block) throw new Error(`Unknown block id: ${raw}`);
      return block;
    };
    // A time note is Tom's own written instruction, so an action that lands
    // through it is a Tom touch — stamped exactly where the equivalent public
    // mutation stamps it (updateTodo and setStatus do; recordDateOutcome and
    // the block mutations do not).
    const touch = async (todoId: Id<"dtsTodos">) =>
      ctx.db.patch(todoId, { tomTouchedAt: now });

    for (const action of list) {
      switch (action.kind) {
        case "set-due": {
          const todo = await requireSubject("set-due");
          // First date is free; a second one is a renegotiation (kept dates).
          if (todo.dueAt !== undefined) {
            throw new Error(
              "This todo already has a date — moving it is a renegotiation, not a new date (kept-dates rule)",
            );
          }
          await ctx.db.patch(todo._id, {
            dueAt: action.dueAt,
            dateKind: action.dateKind ?? "self-imposed",
            timingClass: "dated",
            updatedAt: now,
            tomTouchedAt: now,
          });
          await logEvent(ctx, "updated", todo._id, {
            fields: ["dueAt"],
            via: "time-note",
          });
          break;
        }
        case "renegotiate": {
          const todo = await requireSubject("renegotiate");
          // applyDateOutcome enforces "before the date" — no silent slides,
          // no post-hoc renegotiation.
          await applyDateOutcome(ctx, todo, {
            outcome: "renegotiated",
            newDueAt: action.newDueAt,
            note: action.note,
          });
          break;
        }
        case "record-missed": {
          const todo = await requireSubject("record-missed");
          if (todo.dueAt === undefined) {
            throw new Error("Todo has no date to resolve");
          }
          if (now < todo.dueAt) {
            throw new Error(
              "The date has not arrived — a date that is still ahead is renegotiated, not missed",
            );
          }
          // With newDueAt the item stays dated on the replacement date; without
          // it, it drops back to whenever — applyDateOutcome's own two branches,
          // and the miss is on record either way.
          await applyDateOutcome(ctx, todo, {
            outcome: "missed",
            newDueAt: action.newDueAt,
            note: action.note,
          });
          break;
        }
        case "set-date-kind": {
          const todo = await requireSubject("set-date-kind");
          // Whose deadline it is only means anything while there IS one.
          if (todo.dueAt === undefined) {
            throw new Error("Todo has no date to describe");
          }
          await ctx.db.patch(todo._id, {
            dateKind: action.dateKind,
            updatedAt: now,
            tomTouchedAt: now,
          });
          await logEvent(ctx, "updated", todo._id, {
            fields: ["dateKind"],
            via: "time-note",
          });
          break;
        }
        case "set-waiting": {
          const todo = await requireSubject("set-waiting");
          // MERGE, don't replace: a note that only moves the wake DATE ("wait
          // until the 15th instead") says nothing about the sleep it already
          // had, and applyStatusChange writes wakeAt unconditionally — so an
          // omitted field carries the stored value forward instead of erasing
          // a fact Tom never asked to lose.
          await applyStatusChange(ctx, todo, {
            status: "waiting",
            wakeAt: action.wakeAt ?? todo.wakeAt,
            note: note.text,
          });
          await touch(todo._id);
          break;
        }
        case "set-active": {
          const todo = await requireSubject("set-active");
          await applyStatusChange(ctx, todo, {
            status: "active",
            note: note.text,
          });
          await touch(todo._id);
          break;
        }
        case "create-block": {
          let blockTodoId: Id<"dtsTodos"> | undefined;
          if (action.todoId !== undefined) {
            const t = ctx.db.normalizeId("dtsTodos", action.todoId);
            if (!t) throw new Error(`Unknown todo id: ${action.todoId}`);
            blockTodoId = t;
          } else if (action.category === undefined && note.todoId) {
            // A block asked for from a todo's own note defaults to that todo.
            blockTodoId = note.todoId;
          }
          await insertBlock(ctx, {
            start: action.start,
            end: action.end,
            todoId: blockTodoId,
            category: action.category,
          });
          break;
        }
        case "update-block": {
          const block = await getBlock(action.blockId);
          await patchBlock(ctx, block, {
            start: action.start,
            end: action.end,
          });
          break;
        }
        case "delete-block": {
          await removeBlock(ctx, await getBlock(action.blockId));
          break;
        }
      }
    }

    await ctx.db.patch(normalized, {
      status,
      result: result.trim(),
      resolvedAt: now,
    });
    await logEvent(ctx, "time-note-resolved", note.todoId, {
      status,
      result: result.trim(),
      actions: list.map((a) => a.kind),
    });
    return { ok: true, applied: list.length };
  },
});

// The server owns the clock (the /tts/state prepDay convention): the worker
// never computes New York time itself, it repeats back what this returns.
export function nowContext(utcMs: number) {
  return {
    now: utcMs,
    nowIso: new Date(utcMs).toISOString(),
    nyCalendarDay: nyCalendarDayKey(utcMs),
    nyOffsetHours: nyOffsetHours(utcMs),
    timezone: "America/New_York",
  };
}

// Instrumentation hook for the surfaces (spec §10): Focus/Inventory record
// engagement, queue cycling, session starts, etc. Kind is free-form by
// convention; the analysis layer is a later TTS todo.
export const recordEvent = mutation({
  args: {
    kind: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    data: v.optional(v.any()),
  },
  handler: async (ctx, { kind, todoId, data }) => {
    await requireTomId(ctx);
    await logEvent(ctx, kind, todoId, data);
  },
});

// ── Internal: worker submissions (via key-authed http.ts routes) ─────────────

export const internalCapture = internalMutation({
  args: {
    statement: v.string(),
    source: v.string(),
    provenance: v.optional(v.string()),
    // The Slack coordinates of the message this came from, when it came from
    // one. Machine fields, kept out of `provenance` (which is Tom's to read).
    slackChannel: v.optional(v.string()),
    slackTs: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { statement, source, provenance, slackChannel, slackTs },
  ) => {
    const now = Date.now();
    // IDEMPOTENT ON THE SLACK MESSAGE TS. Two producers now capture the same
    // #dump message — the Events push route (fast, at-least-once: Slack
    // retries the same event) and poll-dump.mjs (the reconciliation backstop,
    // which cannot know what the push route already took). Without this, every
    // Slack retry and every overlap between the two would mint a duplicate
    // todo. Returning the EXISTING id rather than throwing is what lets the
    // push route answer 200 to a retry, which is what stops Slack retrying.
    if (slackTs !== undefined) {
      const existing = await ctx.db
        .query("dtsTodos")
        .withIndex("by_slackTs", (q) => q.eq("slackTs", slackTs))
        .first();
      if (existing) return existing._id;
    }
    // A RULING ABOUT AN INTEGRATION IS LABELLED WHERE IT IS WRITTEN. The
    // statement `integration: outlook` is Tom turning a poller off
    // (convex/ttsIntegrations.ts), and every poller asks which ones are off
    // before it captures anything. A statement prefix cannot be indexed, so
    // the shape is read once — here, at the one place a todo is born from a
    // message — and recorded as the row's source; the pollers' read is then
    // the handful of rows under that source rather than the whole archive.
    const declaredSource =
      integrationName(statement) === null ? source : INTEGRATION_SOURCE;
    const id = await ctx.db.insert("dtsTodos", {
      statement: statement.trim(),
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source: declaredSource,
      provenance,
      slackChannel,
      slackTs,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "captured", id, { source: declaredSource });
    // The one reply line at capture, in the thread of the #dump message this
    // came from. Scheduled INSIDE the insert's transaction, after the dedupe
    // above — so a Slack retry, which returns the existing id, never
    // schedules a second one, and no reply exists for a capture that rolled
    // back. The door (ttsSync.sendSlack) records the send and stamps
    // slackReplyTs. This is the ONE reply a #dump message gets: no worker
    // posts its own (a second sender reading a stale copy of the stamp is how
    // a message got two replies), and a refused send is a recorded failure.
    if (slackChannel !== undefined && slackTs !== undefined) {
      await ctx.scheduler.runAfter(0, internal.ttsSync.sendSlack, {
        channel: slackChannel,
        threadTs: slackTs,
        text: renderSlack(composeCaptured({ todoId: id, statement })),
        subject: { kind: "todo", id },
      });
    }
    return id;
  },
});

// The preparation path for LIFE todos (spec §15, swarm-lite): the worker's
// preparer job advances an unprepared capture toward prepared by
// attaching the ground-up brief, the smallest entry action, and a qualitative
// work description. It never touches statement or status — those are Tom's
// (or the capture's) and preparation must not rewrite intent. Since
// 2026-08-29 it may also set a FIRST dueAt, and only when the statement
// itself states the date (the QuickAdd date input is gone): Tom's own words,
// never an agent's guess, and never over an existing date.
export const internalPrepareTodo = internalMutation({
  args: {
    id: v.string(),
    brief: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    // "prepared" is the value (ruling 18), and the only one this pen takes.
    // The retired spellings a pre-rename box job wrote are refused since the
    // narrow (the lifeos update, phase 7; the planner's prepare pass writes
    // "prepared"). The literal "unprepared" is refused too: an agent must
    // never erase the record that a todo was written up.
    readiness: v.optional(v.literal("prepared")),
    // ── The graph worker's three args (schema v2, 2026-08-29) ────────────────
    // A worker session claims ONE ready todo inside a batch and advances it by
    // one stable state, and this is the pen it writes that state with. It
    // needs three things the plan-era pen did not have:
    //   evidence             — the artifact that shows the work happened (a
    //                          branch, a pull request, a written brief). The
    //                          schema field of the same name, per row.
    //   groundUpExplanation  — the self-contained "more" layer, written when a
    //                          task turns out to need Tom's judgment and he has
    //                          to be able to rule on it cold.
    //   status: "done"       — closes the row, which is what makes every task
    //                          that NEEDS it ready. Accepted only for a row
    //                          inside a batch (batchId set): a standalone life
    //                          todo is Tom's to close and no agent write may
    //                          close one behind him. "done" is the only value —
    //                          archiving and sleeping stay Tom's verdicts.
    evidence: v.optional(v.string()),
    groundUpExplanation: v.optional(v.string()),
    status: v.optional(v.literal("done")),
    // The date the STATEMENT itself states ("pay rent sept 3"). The QuickAdd
    // date input is gone (2026-08-29), so this is how an explicit date Tom
    // wrote in his own words reaches the row. Statement text is Tom's, so this
    // is not an agent inventing a date — but the guard below is absolute: only
    // when the todo has no dueAt yet, never an overwrite.
    dueAt: v.optional(v.number()),
    dateKind: v.optional(DATE_KIND),
  },
  handler: async (
    ctx,
    { id, brief, entryAction, workDescription, readiness, dueAt, dateKind, evidence, groundUpExplanation, status },
  ) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    // Every field lands on every row. The batch gate that used to sit here —
    // a row carrying `members` took only its plan, because the v1 batcher
    // owned its brief — went with the v1 batch itself (the lifeos update,
    // phase 7): there is no grouping brief for a single-todo preparer to
    // overwrite any more, and a batch is its own `batches` row.
    if (brief !== undefined) patch.brief = brief;
    if (evidence !== undefined) patch.evidence = evidence;
    if (groundUpExplanation !== undefined) {
      patch.groundUpExplanation = groundUpExplanation;
    }
    if (entryAction !== undefined) patch.entryAction = entryAction;
    if (workDescription !== undefined) patch.workDescription = workDescription;
    if (readiness !== undefined) patch.readiness = readiness;
    if (dueAt !== undefined) {
      // Kept-dates rule (spec §8): a stored date moves only through
      // recordDateOutcome / a time note. The preparer gets the FIRST date
      // only — an existing one is never overwritten, and the skip is named.
      // A RESOLVED date counts as a date: an item whose date was recorded
      // missed or renegotiated has a dateOutcomes history, and letting a
      // re-prep read the same statement and hand back the very date Tom just
      // resolved would resurrect it behind his back.
      if (todo.dueAt !== undefined || (todo.dateOutcomes ?? []).length > 0) {
        await logEvent(ctx, "due-skipped", normalized, { dueAt });
      } else {
        patch.dueAt = dueAt;
        patch.dateKind = dateKind ?? "self-imposed";
        patch.timingClass = "dated";
      }
    }
    await ctx.db.patch(normalized, patch);
    await logEvent(ctx, "prepared", normalized, {
      readiness: patch.readiness,
      fields: [
        patch.brief !== undefined && "brief",
        patch.entryAction !== undefined && "entryAction",
        patch.workDescription !== undefined && "workDescription",
        patch.dueAt !== undefined && "dueAt",
        patch.evidence !== undefined && "evidence",
        patch.groundUpExplanation !== undefined && "groundUpExplanation",
      ].filter(Boolean),
    });
    // Completion runs LAST and through the ONE transition implementation
    // (applyStatusChange): a raw status patch would skip the kept-dates
    // resolution on a dated row and emit no status-changed event. It reads the
    // row as it stands AFTER the patch above, so the evidence written in the
    // same call is already on it.
    if (status === "done") {
      const fresh = await ctx.db.get(normalized);
      if (!fresh) return;
      // THE THREE BARS, most specific first. Each is a NAMED refusal rather
      // than a silent skip: a worker that thinks it closed a todo and did not
      // would report work as landed that is still open, and only this row
      // would say otherwise.
      //
      //   (a) inside a batch — a standalone life todo is Tom's to close.
      //   (b) not frozen, unless it is a checkable goal. tomTouchedAt is the
      //       freeze every other agent write in this file respects, and goal
      //       binding is explicitly allowed on Tom-touched rows, so without
      //       this bar every bound goal became a row an agent could close.
      //       A CHECKABLE goal is the one exception, and it is the design:
      //       checking the world and recording the answer is a goal's whole
      //       contract.
      //   (c) a goal's condition is a GOAL CONDITION — a sentence about the
      //       world that is either true yet or not. A goal with no condition
      //       and no code subject has nothing an agent can go and check, and
      //       closing it would be closing Tom's todo for him.
      const why =
        fresh.batchId === undefined
          ? "only a todo inside a batch may be completed by the pen"
          : fresh.kind === "goal" && !goalCheckable(fresh)
            ? "a goal is completed by the pen only when it has a checkable condition or a code subject"
            : fresh.tomTouchedAt !== undefined && fresh.kind !== "goal"
              ? "Tom-touched (frozen) — only he closes a row he has ruled on"
              : null;
      if (why !== null) {
        await logEvent(ctx, "done-skipped", normalized, { why });
      } else if (fresh.status !== "done") {
        await applyStatusChange(ctx, fresh, {
          status: "done",
          note: "worker: task completed",
        });
      }
    }
  },
});

// ── The plan graph (schema v2, ratified 2026-08-29) ──────────────────────────
// A BATCH IS NO LONGER A TODO: it is a `batches` row holding HOW a set of
// todos gets completed, and its contents are dtsTodos rows pointing back at it
// (batchId) as kind "task" (work) or kind "goal" (a checkable state of the
// world). Dependencies between them are `needs`; the todos whose needs are all
// done are "ready" (the frontier — ttsShared owns that rule).

/**
 * The nodes that cannot be ordered: everything still standing after repeatedly
 * removing nodes whose needs are all resolved (Kahn's algorithm, run to a
 * fixed point). That set is exactly the cycles PLUS everything downstream of
 * one — which is what makes dropping all of them a safe repair: no surviving
 * task is left needing a dropped one.
 */
function cycleBoundNodes(edges: Map<string, string[]>): Set<string> {
  const remaining = new Set(edges.keys());
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of [...remaining]) {
      if ((edges.get(node) ?? []).every((dep) => !remaining.has(dep))) {
        remaining.delete(node);
        progressed = true;
      }
    }
  }
  return remaining;
}

/**
 * WHAT HAPPENS TO A BATCH'S CONTENTS WHEN THE BATCH GOES AWAY. Archiving only
 * the `batches` row leaves its todos behind as active rows with a batchId
 * nothing will ever schedule: the frontier skips them (their batch is not
 * active), every legacy lane skips them (they carry a batchId), and the
 * preparer skips them too. They become open work that is invisible to the
 * whole system.
 *
 * So the two kinds part ways, each to the place it came from:
 *   tasks — the batch's own work, archived with it. Their statements only ever
 *           meant something inside this batch's plan.
 *   goals — TOM'S OWN TODOS, which the planner merely bound here. They are
 *           unbound (batchId and kind cleared) and returned to the general
 *           pool, where the preparer and the legacy lanes pick them up again
 *           and the planner may bind them into a batch that is still live.
 *
 * Never touches a done row (its resting state is the record of what landed) or
 * a Tom-touched task (he ruled on it; the archive is not an agent's to make).
 */
export async function archiveBatchContents(
  ctx: MutationCtx,
  batchId: Id<"batches">,
  note: string,
) {
  const rows = await ctx.db
    .query("dtsTodos")
    .withIndex("by_batch", (q) => q.eq("batchId", batchId))
    .collect();
  let archivedTasks = 0;
  let unboundGoals = 0;
  for (const row of rows) {
    if (row.kind === "goal") {
      // No updatedAt bump, the mirror of the binding rule: binding and
      // unbinding are both structural annotations, and bumping would resurface
      // a gate Tom already ruled on (the needs-me ruledAt<updatedAt
      // predicate). The row's own content is untouched either way.
      await ctx.db.patch(row._id, { batchId: undefined, kind: undefined });
      unboundGoals++;
      continue;
    }
    if (row.status === "done" || row.status === "archived") continue;
    if (row.tomTouchedAt !== undefined) continue;
    await applyStatusChange(ctx, row, {
      status: "archived",
      unarchiveCondition: "the batch it belonged to comes back",
      note,
    });
    archivedTasks++;
  }
  if (archivedTasks > 0 || unboundGoals > 0) {
    await logEvent(ctx, "graph-batch-emptied", undefined, {
      batchId,
      archivedTasks,
      unboundGoals,
      note,
    });
  }
  return { archivedTasks, unboundGoals };
}

// The planner's pen, one batch per call: upserts ONE batch's graph — the batch row, its tasks, and the goals bound to
// it. Drop-don't-reject: a task that fails validation is SKIPPED with a named
// reason and the rest of the graph still lands; only a batch that is unknown
// or FROZEN (Tom-touched, or terminal) costs the whole call.
export const internalStorePlanGraph = internalMutation({
  args: {
    batchId: v.optional(v.string()), // absent = create the batch
    statement: v.string(),
    groundUpExplanation: v.optional(v.string()),
    // Sequencing between batches: the batches this one needs done first.
    // Absent PRESERVES the stored value, like every field on this pen.
    needs: v.optional(v.array(v.string())),
    // The repos this batch's work lives in (Tom's ruling 2026-08-30: a batch
    // DECLARES its repos; the session scheduler no longer guesses them from a
    // substring search). Normalized here — an unknown name is dropped rather
    // than stored, so nothing downstream has to re-check it, and the planner
    // naming a repo that does not exist costs a checkout, not a dead session.
    repos: v.optional(v.array(v.string())),
    tasks: v.array(GRAPH_TASK),
    goalIds: v.optional(v.array(v.string())), // existing todos to bind as goals
    archive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const statement = args.statement.trim();
    const result = {
      batchId: null as Id<"batches"> | null,
      // Did THIS BATCH's graph store? The caller consumes Tom's revise ruling
      // on exactly this fact, and it cannot be read off `skipped`: a task's
      // skip carries the task's statement as its ref, and a task whose
      // statement happens to equal the batch's would read as a refused batch.
      // One field, stated by the only code that knows.
      batchStored: false,
      created: 0,
      updated: 0,
      unchanged: 0,
      goalsBound: 0,
      retired: 0,
      archived: 0,
      skipped: [] as { ref: string; why: string }[],
    };

    // ── The batch row ────────────────────────────────────────────────────────
    let batch: Doc<"batches"> | null = null;
    if (args.batchId !== undefined) {
      const normalized = ctx.db.normalizeId("batches", args.batchId);
      batch = normalized ? await ctx.db.get(normalized) : null;
      if (!batch) {
        result.skipped.push({
          ref: statement,
          why: `unknown batch id: ${args.batchId}`,
        });
        return result;
      }
    } else {
      // IDENTITY WITHOUT AN ID: to the planner a batch IS its statement. v1
      // got idempotence for free from the occupied-member map — a re-post
      // could not re-create a batch claiming the same subjects. Here nothing
      // else carries identity, so a scheduled planner that re-posts a graph
      // without echoing the batch id would mint a fresh batch, and a fresh
      // copy of every task in it, on every run, unbounded. Only ACTIVE
      // batches match (an archived one is history; re-posting its statement
      // starts a new batch); oldest wins, so the choice is deterministic.
      const activeBatches = await ctx.db
        .query("batches")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
      batch =
        activeBatches
          .filter((b) => b.statement === statement)
          .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
    }
    if (batch) {
      result.batchId = batch._id;
      // The freeze: a Tom-touched batch is never rewritten by an agent, and a
      // terminal one is not rewritten at all.
      const frozen =
        batch.tomTouchedAt !== undefined
          ? "Tom-touched (frozen)"
          : batch.status !== "active"
            ? `status ${batch.status}`
            : null;
      if (frozen) {
        result.skipped.push({ ref: statement, why: frozen });
        return result;
      }
    }
    const currentBatchId = batch?._id;

    // The batch's existing contents — the other half of the graph a payload
    // edge may point into (by_batch, not a full collect).
    const existingRows = currentBatchId
      ? await ctx.db
          .query("dtsTodos")
          .withIndex("by_batch", (q) => q.eq("batchId", currentBatchId))
          .collect()
      : [];

    // ── Validate every task BEFORE anything is written ───────────────────────
    // A todo is addressable by this graph while it is in THIS batch or in none
    // (claiming another batch's todo is the cross-batch edge Tom ruled out).
    const addressable = (todo: Doc<"dtsTodos">) =>
      todo.batchId === undefined ||
      (currentBatchId !== undefined && todo.batchId === currentBatchId);

    // The PER-ROW freeze, applied to a task target (addressable() only says
    // which batch a row is in, not whether the planner may write it). null =
    // writable; otherwise the plain-language reason it is not. Without this
    // the pen would rewrite a life todo Tom wrote by hand or reopen a task he
    // closed. A `done` task IS writable: it is the resting state of a landed
    // step inside a live graph, and a re-post must still read as unchanged.
    const notWritable = (todo: Doc<"dtsTodos">): string | null => {
      if (todo.tomTouchedAt !== undefined) return "Tom-touched (frozen)";
      if (todo.source !== "planner" && todo.source !== "migration") {
        return `source ${todo.source} is not the planner's`;
      }
      if (todo.status === "archived" || todo.status === "waiting") {
        return `status ${todo.status}`;
      }
      return null;
    };

    type Accepted = {
      key: string; // "#<index>" for a create, the todo id for a rewrite
      existing: Doc<"dtsTodos"> | null;
      task: (typeof args.tasks)[number];
      deps: string[]; // node keys, resolved to ids at write time
    };
    const accepted: Accepted[] = [];
    // Payload index → the accepted task's NODE KEY (its todo id for a rewrite,
    // "#<index>" for a create). An index ref resolves through this, so it can
    // never name a node the write step cannot find.
    const keyByIndex = new Map<number, string>();
    const claimedIds = new Set<string>();
    // Rows this batch would hold once the payload lands — the cap below is on
    // the BATCH, not on one payload: without it a re-post carrying new task
    // statements grows a single batch without bound.
    let projectedRows = existingRows.length;

    for (let i = 0; i < args.tasks.length; i++) {
      const task = args.tasks[i];
      const trimmed = task.statement.trim();
      const ref = trimmed || `task ${i}`;
      const skip = (why: string) => result.skipped.push({ ref, why });
      if (i >= MAX_GRAPH_TASKS) {
        skip(`a graph holds at most ${MAX_GRAPH_TASKS} tasks`);
        continue;
      }
      if (trimmed === "") {
        skip("a task needs a statement");
        continue;
      }
      let existing: Doc<"dtsTodos"> | null = null;
      if (task.id !== undefined) {
        const normalized = ctx.db.normalizeId("dtsTodos", task.id);
        existing = normalized ? await ctx.db.get(normalized) : null;
        if (!existing) {
          skip(`unknown todo id: ${task.id}`);
          continue;
        }
        if (!addressable(existing)) {
          skip(`${task.id} belongs to another batch`);
          continue;
        }
      } else {
        // The same identity rule as the batch row above, one level down:
        // inside a batch a task's STATEMENT names it. A planner that re-posts
        // a graph without echoing task ids rewrites its own rows instead of
        // minting a duplicate set every run. Matched BEFORE the checks below,
        // so an unwritable row is skipped rather than silently duplicated.
        existing =
          existingRows.find((row) => row.statement === trimmed) ?? null;
      }
      if (existing) {
        if (existing.kind === "goal") {
          skip(`${existing._id} is a goal, not a task`);
          continue;
        }
        if (claimedIds.has(existing._id)) {
          skip(`duplicate task: ${existing._id}`);
          continue;
        }
        const frozen = notWritable(existing);
        if (frozen) {
          skip(frozen);
          continue;
        }
      }
      if (!existing && projectedRows >= MAX_GRAPH_TASKS) {
        skip(`a batch holds at most ${MAX_GRAPH_TASKS} todos`);
        continue;
      }
      const refs = task.needs ?? [];
      if (refs.length > MAX_NEEDS) {
        skip(`a todo needs at most ${MAX_NEEDS} others — got ${refs.length}`);
        continue;
      }
      // Resolve each need to a node key. A number addresses an EARLIER task in
      // this payload (backward-only, so in-payload edges cannot cycle); a
      // string addresses an existing todo, which must be addressable too.
      const deps: string[] = [];
      let bad: string | null = null;
      for (const need of refs) {
        if (typeof need === "number") {
          if (!Number.isInteger(need) || need < 0 || need >= i) {
            bad = `needs ${need}: an index must name an EARLIER task in this payload`;
            break;
          }
          // A skipped task takes its dependents with it — landing a task whose
          // need was dropped would silently write a graph that is missing an
          // edge the planner asked for.
          const target = keyByIndex.get(need);
          if (target === undefined) {
            bad = `needs task ${need}, which was skipped`;
            break;
          }
          // The NODE KEY of that task, which is its todo id when the payload
          // addressed an existing row: "#<index>" is only the key of a task
          // being CREATED, and pushing it blindly wrote the literal string
          // "#0" into `needs` whenever an index ref named a rewritten task.
          deps.push(target);
        } else {
          const normalized = ctx.db.normalizeId("dtsTodos", need);
          const target = normalized ? await ctx.db.get(normalized) : null;
          if (!target) {
            bad = `needs an unknown todo id: ${need}`;
            break;
          }
          if (!addressable(target)) {
            bad = `needs ${need}, which belongs to another batch`;
            break;
          }
          deps.push(target._id);
        }
      }
      if (bad) {
        skip(bad);
        continue;
      }
      if (existing) claimedIds.add(existing._id);
      else projectedRows++;
      const key = existing ? (existing._id as string) : `#${i}`;
      keyByIndex.set(i, key);
      accepted.push({
        key,
        existing,
        task,
        // An ABSENT `needs` PRESERVES the stored edges (the preserve-on-absent
        // rule the write below applies to every field), so the acyclicity
        // check has to see the preserved edges, not an empty set — checking []
        // and then storing the old edges would validate a graph nobody wrote.
        deps:
          task.needs === undefined && existing
            ? (existing.needs ?? []).map((id) => id as string)
            : [...new Set(deps)],
      });
    }

    // Acyclicity across the WHOLE batch: the payload's projected edges plus
    // the stored edges of every row the payload does not rewrite. Anything
    // still unorderable is dropped (cycle-bound or downstream of one); the
    // stored rows were validated on their own write, so a cycle always
    // involves this payload.
    const edges = new Map<string, string[]>();
    for (const row of existingRows) {
      if (claimedIds.has(row._id)) continue;
      edges.set(
        row._id,
        (row.needs ?? []).map((id) => id as string),
      );
    }
    for (const a of accepted) edges.set(a.key, a.deps);
    // Close the map over needs that point OUTSIDE this batch. A batch-less
    // todo carries needs of its own, and a node that is not a KEY in the map
    // reads to cycleBoundNodes as already resolved — so A(batch-less) needs B
    // while B needs A would be stored as orderable, and neither would ever be
    // ready with nothing anywhere saying why. Walking the closure (each id
    // fetched once; a dangling id resolves as a leaf) is what makes the
    // acyclicity claim true of the whole graph rather than of one batch.
    const pendingRefs = [...edges.values()].flat();
    const walked = new Set(edges.keys());
    while (pendingRefs.length > 0) {
      const id = pendingRefs.pop()!;
      if (walked.has(id)) continue;
      walked.add(id);
      const normalized = ctx.db.normalizeId("dtsTodos", id);
      const outside = normalized ? await ctx.db.get(normalized) : null;
      const outsideNeeds = (outside?.needs ?? []).map((need) => need as string);
      edges.set(id, outsideNeeds);
      pendingRefs.push(...outsideNeeds);
    }
    const cyclic = cycleBoundNodes(edges);
    const landing = accepted.filter((a) => {
      if (!cyclic.has(a.key)) return true;
      result.skipped.push({
        ref: a.task.statement.trim(),
        why: "needs form a cycle",
      });
      return false;
    });

    // ── The batch's needs: ids of OTHER batches, bounded, known, acyclic ────
    // A name that is not a batch id, or the batch itself, is dropped with a
    // named skip rather than stored: an edge to nothing would block the batch
    // forever, and an edge to itself would too. So would a cycle through
    // other batches — A needs B and B needs A passes a self-need check, and
    // then the scheduler's batchNeedsMet holds both back forever with nothing
    // saying why. Each candidate need is walked transitively through the
    // stored needs of every batch (ONE collect of a human-scale table), and
    // one that reaches this batch is skipped naming the batch it names.
    // Absent preserves.
    let batchNeeds: Id<"batches">[] | undefined;
    if (args.needs !== undefined) {
      const allBatches = await ctx.db.query("batches").collect();
      const batchByIdForNeeds = new Map(allBatches.map((b) => [b._id as string, b]));
      /** Whether `from` reaches `target` along stored needs edges. */
      const reaches = (from: string, target: string): boolean => {
        const seen = new Set<string>();
        const stack = [from];
        while (stack.length > 0) {
          const id = stack.pop()!;
          if (id === target) return true;
          if (seen.has(id)) continue;
          seen.add(id);
          stack.push(...(batchByIdForNeeds.get(id)?.needs ?? []));
        }
        return false;
      };
      batchNeeds = [];
      const seen = new Set<string>();
      for (const raw of args.needs) {
        const id = ctx.db.normalizeId("batches", raw);
        const target = id ? batchByIdForNeeds.get(id) : undefined;
        if (!id || !target) {
          result.skipped.push({ ref: raw, why: "needs names no batch" });
          continue;
        }
        if (batch && id === batch._id) {
          result.skipped.push({ ref: raw, why: "a batch cannot need itself" });
          continue;
        }
        if (batch && reaches(id, batch._id)) {
          result.skipped.push({
            ref: raw,
            why: `needs form a cycle: "${target.statement}" already needs this batch`,
          });
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        batchNeeds.push(id);
      }
      if (batchNeeds.length > MAX_NEEDS) {
        result.skipped.push({
          ref: statement,
          why: `needs holds at most ${MAX_NEEDS} batches — the rest are dropped`,
        });
        batchNeeds = batchNeeds.slice(0, MAX_NEEDS);
      }
    }

    // ── Write: the batch row, then its tasks in payload order ────────────────
    if (batch) {
      // An ABSENT field PRESERVES the stored value (internalStoreBriefs
      // semantics: an LLM omission must not delete state), and an unchanged
      // re-post writes nothing — a repeated run must not bump updatedAt and
      // re-push every open client.
      const projected = {
        statement,
        groundUpExplanation:
          args.groundUpExplanation ?? batch.groundUpExplanation,
        needs: batchNeeds ?? batch.needs,
        repos:
          args.repos === undefined
            ? batch.repos
            : normalizeSessionRepos(args.repos),
      };
      const stored = {
        statement: batch.statement,
        groundUpExplanation: batch.groundUpExplanation,
        needs: batch.needs,
        repos: batch.repos,
      };
      if (JSON.stringify(projected) !== JSON.stringify(stored)) {
        await ctx.db.patch(batch._id, { ...projected, updatedAt: now });
      }
    } else {
      result.batchId = await ctx.db.insert("batches", {
        statement,
        groundUpExplanation: args.groundUpExplanation,
        needs: batchNeeds,
        repos:
          args.repos === undefined
            ? undefined
            : normalizeSessionRepos(args.repos),
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await logEvent(ctx, "graph-batch-formed", undefined, {
        batchId: result.batchId,
        statement,
      });
    }
    const batchId = result.batchId!;
    result.batchStored = true;

    // Payload order + backward-only index refs mean every dep already has its
    // id by the time it is read.
    const idByKey = new Map<string, Id<"dtsTodos">>();
    for (const a of landing) {
      const needs = a.deps.map(
        (dep) => idByKey.get(dep) ?? (dep as Id<"dtsTodos">),
      );
      const prior = a.existing;
      // An ABSENT field PRESERVES the stored value — the same rule the batch
      // row above follows (internalStoreBriefs semantics: an LLM omission must
      // not delete state). ctx.db.patch DELETES a field written as undefined,
      // so writing the payload straight through would erase the evidence a
      // session recorded, the "more" layer, and a claimed row's trigger
      // condition on the planner's very next re-post. `needs` rides the same
      // rule via a.deps: an explicit EMPTY array is how a payload clears edges.
      const fields = {
        statement: a.task.statement.trim(),
        kind: "task" as const,
        actor: a.task.actor,
        batchId,
        needs: needs.length > 0 ? needs : undefined,
        condition: a.task.condition ?? prior?.condition,
        groundUpExplanation:
          a.task.groundUpExplanation ?? prior?.groundUpExplanation,
        evidence: a.task.evidence ?? prior?.evidence,
        // Preserve-on-absent like every field above: a re-post that omits the
        // tier must not silently demote a task the planner already marked as
        // needing the stronger model.
        model: a.task.model ?? prior?.model,
      };
      const desired = a.task.status ?? prior?.status ?? ("active" as const);
      if (prior) {
        const stored = {
          statement: prior.statement,
          kind: prior.kind,
          actor: prior.actor,
          batchId: prior.batchId,
          needs: prior.needs,
          condition: prior.condition,
          groundUpExplanation: prior.groundUpExplanation,
          evidence: prior.evidence,
          model: prior.model,
        };
        const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(stored);
        const statusChanged = desired !== prior.status;
        if (!fieldsChanged && !statusChanged) {
          result.unchanged++;
        } else {
          if (fieldsChanged) {
            await ctx.db.patch(prior._id, { ...fields, updatedAt: now });
          }
          // A status change goes through the ONE transition implementation.
          // A raw patch would leave an archived row's archivedAt and unarchive
          // condition standing on a live todo, skip the kept-dates resolution
          // on a completion (the silent slide updateTodo refuses), and emit no
          // status-changed event for the transition.
          if (statusChanged) {
            await applyStatusChange(ctx, prior, {
              status: desired,
              note: "planner: graph",
            });
          }
          result.updated++;
        }
        idByKey.set(a.key, prior._id);
      } else {
        const id = await ctx.db.insert("dtsTodos", {
          ...fields,
          status: desired,
          doneAt: desired === "done" ? now : undefined,
          // A task is work inside a batch, not a gate: the BATCH is what Tom
          // rules on, so a fresh task is "unprepared" rather than
          // "prepared" (which would flood the needs-me feed).
          readiness: "unprepared",
          timingClass: "whenever",
          source: "planner",
          createdAt: now,
          updatedAt: now,
        });
        idByKey.set(a.key, id);
        result.created++;
      }
    }

    // ── Goals: existing todos bound to this batch ────────────────────────────
    // No updatedAt bump — binding is a structural annotation, and bumping it
    // would resurface already-ruled gates (the needs-me ruledAt<updatedAt
    // predicate).
    const goalIds = args.goalIds ?? [];
    for (let g = 0; g < goalIds.length; g++) {
      const raw = goalIds[g];
      // Bounded like every other array here (Convex unbounded-array-field
      // guideline): a batch is FOR at most MAX_BATCH_GOALS subjects.
      if (g >= MAX_BATCH_GOALS) {
        result.skipped.push({
          ref: raw,
          why: `a batch holds at most ${MAX_BATCH_GOALS} goals`,
        });
        continue;
      }
      const normalized = ctx.db.normalizeId("dtsTodos", raw);
      const todo = normalized ? await ctx.db.get(normalized) : null;
      if (!todo) {
        result.skipped.push({ ref: raw, why: `unknown todo id: ${raw}` });
        continue;
      }
      // (The two v1-batch bars that used to sit here — a v1 batch row bound as
      // a goal, and a row a live v1 batch already claimed — went with the v1
      // batch itself: the graph migration turned every one of them into a
      // `batches` row and archived the old row, and nothing writes `members`
      // any more. The lifeos update, phase 7.)
      if (claimedIds.has(todo._id)) {
        result.skipped.push({
          ref: raw,
          why: "already addressed as a task in this graph",
        });
        continue;
      }
      if (!addressable(todo)) {
        result.skipped.push({ ref: raw, why: `${raw} belongs to another batch` });
        continue;
      }
      if (todo.batchId === batchId && todo.kind === "goal") continue; // already bound
      await ctx.db.patch(todo._id, { batchId, kind: "goal" });
      result.goalsBound++;
    }

    // ── Retire what the payload dropped ──────────────────────────────────────
    // THE TASKS ARRAY IS THE BATCH'S TASK LIST. Identity without an id is exact
    // statement match, and the planner is an LLM re-emitting the whole graph
    // every run: a task it REWORDS while omitting its id mints a second row,
    // and both are then ready, both agent-workable, and both get sessions doing
    // the same work on the same branch namespace. Nothing else retires the
    // first, so this does.
    //
    // WHAT IT WILL NOT TOUCH, because a dropped row must never be lost work: a
    // goal (Tom's own todo), a row Tom has touched, a row from any other
    // source, a terminal row, and — the load-bearing one — any row a session
    // has already written to (evidence recorded, or readiness moved off
    // "unprepared"). Those stay in the batch and are reported, not archived.
    // The rule is also skipped entirely when nothing landed, so a payload the
    // server dropped whole cannot empty a graph.
    if (landing.length > 0) {
      for (const row of existingRows) {
        // claimedIds, not the landing set: a task the payload DID address and
        // the server then dropped (a cycle, a fan-in cap) was listed by the
        // planner, and dropping an edge is not the same statement as dropping
        // the task.
        if (claimedIds.has(row._id)) continue;
        if (row.kind === "goal") continue;
        if (row.status !== "active") continue;
        if (row.source !== "planner") continue;
        if (row.tomTouchedAt !== undefined) continue;
        if (row.evidence !== undefined || isPrepared(row.readiness)) {
          result.skipped.push({
            ref: row.statement,
            why: "left in the batch: the planner did not re-emit it, and a session has already worked it",
          });
          continue;
        }
        await applyStatusChange(ctx, row, {
          status: "archived",
          unarchiveCondition: "the planner puts it back in the graph",
          note: "planner: no longer in the graph",
        });
        result.retired++;
      }
    }

    if (args.archive) {
      await ctx.db.patch(batchId, { status: "archived", updatedAt: now });
      result.archived = 1;
      await archiveBatchContents(ctx, batchId, "planner: batch archived");
    }

    await logEvent(ctx, "graph-stored", undefined, {
      batchId,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      goalsBound: result.goalsBound,
      retired: result.retired,
      archived: result.archived,
      skipped: result.skipped.length > 0 ? result.skipped : undefined,
    });
    return result;
  },
});

// ── The v1 → v2 migration (built, tested, NOT wired to any cron) ─────────────
// Turns every ACTIVE v1 batch (a dtsTodos row carrying `members`) into the new
// world: a batches row, its plan steps as task todos chained by `needs`, its
// members bound as goals. NOTHING IS EVER DELETED — the old row is archived
// with a pointer to its successor, which is also the idempotence key.
/** The unarchiveCondition a v1 batch row carries once the graph migration
 * has replaced it — its idempotence key, and what the weekly gather must
 * skip when it lists archived rows whose sentence names a return condition
 * (this one is a pointer, not a condition). */
export const GRAPH_SUPERSEDED = "superseded by graph batch ";

/** The v1 batch pair, as a stored row still holds it. THIS MIGRATION IS THE
 * LAST READER of either field, and it reads them through a loose view of the
 * row rather than the generated Doc type: the narrow drops both declarations
 * from convex/schema.ts, and Convex still returns them off any row the
 * clearing walk has not reached — which is what keeps a re-run possible. */
type RetiredV1Batch = {
  members?: { todoId?: Id<"dtsTodos">; repo?: string; externalId?: string }[];
  plan?: {
    text: string;
    actor: "tom" | "agent";
    status: "open" | "done";
    doneAt?: number;
    evidence?: string;
  }[];
};
const v1Batch = (row: Doc<"dtsTodos">): RetiredV1Batch =>
  row as unknown as RetiredV1Batch;

export const internalMigrateToGraph = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("dtsTodos").collect();
    const oldBatches = all.filter(
      (t) =>
        v1Batch(t).members !== undefined &&
        t.status === "active" &&
        !(t.unarchiveCondition ?? "").startsWith(GRAPH_SUPERSEDED),
    );
    const counts = {
      batches: 0,
      tasks: 0,
      goals: 0,
      codeGoals: 0,
      missingMembers: 0,
      alreadyBound: 0,
    };
    for (const row of oldBatches) {
      const batchId = await ctx.db.insert("batches", {
        statement: row.statement,
        // The v1 grouping brief IS the ground-up explanation — same text, same
        // job (why these belong together), now under its ratified name.
        groundUpExplanation: row.brief,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      counts.batches++;

      // Plan steps become tasks in a LINEAR CHAIN (each needs the one before
      // it): the v1 plan was an ordered list, so the chain is the only reading
      // that is certainly true. The planner parallelizes it later by dropping
      // edges — inventing that parallelism here would be a guess.
      let previous: Id<"dtsTodos"> | undefined;
      for (const step of v1Batch(row).plan ?? []) {
        const done = step.status === "done";
        const id = await ctx.db.insert("dtsTodos", {
          statement: step.text,
          kind: "task",
          actor: step.actor,
          status: done ? "done" : "active",
          doneAt: done ? (step.doneAt ?? now) : undefined,
          evidence: step.evidence,
          batchId,
          needs: previous ? [previous] : undefined,
          readiness: "unprepared",
          timingClass: "whenever",
          source: "migration",
          createdAt: now,
          updatedAt: now,
        });
        previous = id;
        counts.tasks++;
      }

      for (const member of v1Batch(row).members ?? []) {
        if (member.todoId !== undefined) {
          const todo = await ctx.db.get(member.todoId);
          if (!todo) {
            counts.missingMembers++;
            continue;
          }
          // The planner's pen is live before this ever runs, so a member may
          // ALREADY be a goal of a v2 batch. Overwriting batchId here would
          // move it out of that batch silently, with nothing recording the
          // loss — the addressable() rule the pen enforces, enforced here too.
          if (todo.batchId !== undefined && todo.batchId !== batchId) {
            counts.alreadyBound++;
            continue;
          }
          // The accumulated todos ARE the batch's goals (Tom): the statement
          // is untouched, and updatedAt is NOT bumped — a migration must not
          // resurface gates Tom already ruled on.
          await ctx.db.patch(member.todoId, { batchId, kind: "goal" });
          counts.goals++;
        } else {
          // A code member becomes a goal ABOUT the upstream todo: the repo
          // stays the system of record, so the goal is "it is closed there",
          // checkable by (codeRepo, codeExternalId) — the same addressing the
          // member used.
          const sentence = `${member.repo} ${member.externalId} closed upstream`;
          await ctx.db.insert("dtsTodos", {
            statement: sentence,
            kind: "goal",
            condition: sentence,
            codeRepo: member.repo,
            codeExternalId: member.externalId,
            batchId,
            readiness: "unprepared",
            status: "active",
            timingClass: "whenever",
            source: "migration",
            createdAt: now,
            updatedAt: now,
          });
          counts.codeGoals++;
        }
      }

      await applyStatusChange(ctx, row, {
        status: "archived",
        unarchiveCondition: `${GRAPH_SUPERSEDED}${batchId}`,
        note: "schema v2 migration",
      });
    }
    await logEvent(ctx, "graph-migrated", undefined, counts);
    return counts;
  },
});

export const internalListTodos = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsTodos").collect();
  },
});

// ── The hourly update's three reads (Tom's ruling 2026-08-30) ────────────────
// The hourly Slack update runs from a CRON, and every equivalent Tom-facing
// query in this file is requireTomId-gated — a cron has no identity, so it
// cannot call one. These are the internal twins, and they exist for exactly
// that reason.

/**
 * What Tom is scheduled to be doing at `at`: the time blocks he placed, joined
 * with their todos. The overlap predicate is listBlocks' own — every block
 * starting before `at` fetched by index, then filtered to the ones that have
 * not ended — so the calendar surface and the Slack line can never disagree
 * about what "now" contains.
 *
 * The calendar-mirror half of the answer (ttsCalendarEvents) is read by the
 * caller through ttsCalendar.internalListEventsInRange: it is a different
 * table with its own index, and joining them here would hide which half was
 * empty.
 */
export const internalScheduleAt = internalQuery({
  args: { at: v.number() },
  handler: async (ctx, { at }) => {
    const blocks = await ctx.db
      .query("dtsBlocks")
      .withIndex("by_start", (q) => q.lte("start", at))
      .collect();
    const live = blocks.filter((b) => b.end > at);
    return await Promise.all(
      live.map(async (b) => ({
        start: b.start,
        end: b.end,
        category: b.category,
        note: b.note,
        statement:
          b.todoId === undefined
            ? undefined
            : (await ctx.db.get(b.todoId))?.statement,
      })),
    );
  },
});

/**
 * Everything dtsEvents recorded in [start, end). The window is what makes the
 * hourly update's "what happened since last time" EXACT rather than
 * approximate: the caller passes the timestamp of the last update it actually
 * sent, so a missed cron tick loses nothing — the next one simply covers a
 * longer window.
 *
 * Bounded by `limit` on top of the range, because dtsEvents is the system's
 * busy append-only instrumentation and a long outage would otherwise make this
 * read unbounded.
 */
export const internalEventsInRange = internalQuery({
  args: { start: v.number(), end: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { start, end, limit }) => {
    return await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", start).lt("at", end))
      .order("desc")
      .take(Math.min(limit ?? 500, 2000));
  },
});

/**
 * When an event of `kind` last happened, or null. The hourly update's own
 * bookkeeping read: it writes an "hourly-update-sent" row after each send and
 * reads the newest one back before composing, so its window is [last sent,
 * now] and a MISSED cron tick loses nothing.
 *
 * Walks newest-first and stops at the first match. Bounded by HOURLY_SCAN
 * because dtsEvents is busy: if the kind has not occurred inside that many
 * rows, "never" is the honest answer and the caller falls back to its default
 * window rather than reading the whole table.
 */
const EVENT_KIND_SCAN = 2000;
export const internalLastEventAt = internalQuery({
  args: { kind: v.string() },
  handler: async (ctx, { kind }) => {
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_at")
      .order("desc")
      .take(EVENT_KIND_SCAN);
    return rows.find((e) => e.kind === kind)?.at ?? null;
  },
});

/**
 * The events pen for an ACTION. logEvent is a helper that needs a MutationCtx,
 * and an internalAction has none — so the hourly update, which is an action
 * (it does network I/O), records that it sent through here rather than
 * reaching for a second event-writing path.
 */
export const internalLogEvent = internalMutation({
  args: { kind: v.string(), data: v.optional(v.any()) },
  handler: async (ctx, { kind, data }) => {
    await logEvent(ctx, kind, undefined, data);
  },
});

export const internalListMirror = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsCodeTodoMirror").collect();
  },
});

// Every batches row (schema v2), for the planner's context. A full collect,
// like internalListTodos: this is a single-user table holding a few dozen rows
// for years, and the planner needs the archived statements too (it must not
// recreate a grouping Tom retired).
export const internalListBatches = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("batches").collect();
  },
});

// PLAN REPAIRS — a worker that reached a task and found the graph wrong (a
// `needs` edge that is not a real prerequisite, a missing one that blocked it)
// records the finding as a dtsEvents row of kind "plan-repair"; that is the
// only channel by which the doing of the work corrects the planning of it.
// The planner reads these each run and fixes the structure.
//
// THE SCAN IS BOUNDED ON PURPOSE. dtsEvents is append-only instrumentation and
// grows without limit, so this walks the by_at index BACKWARD from `sinceMs`
// (a week by default) rather than filtering the whole table — a run in a week
// with no repairs at all must not read every event ever written.
const PLAN_REPAIR_KIND = "plan-repair";
const PLAN_REPAIR_WINDOW_MS = 7 * DAY_MS;

export const internalRecentPlanRepairs = internalQuery({
  args: { limit: v.optional(v.number()), sinceMs: v.optional(v.number()) },
  handler: async (ctx, { limit, sinceMs }) => {
    const since = sinceMs ?? Date.now() - PLAN_REPAIR_WINDOW_MS;
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", since))
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("kind"), PLAN_REPAIR_KIND),
          // UNCONSUMED ONLY. A repair is an INSTRUCTION ("this edge is wrong"),
          // not a record, and the planner runs every two hours over the same
          // seven-day window: without this the planner is told to fix an edge
          // it already dropped, ~84 times per repair. The window is still the
          // outer bound — a repair nothing ever consumes ages out as before.
          q.eq(q.field("consumedAt"), undefined),
        ),
      )
      .take(Math.min(limit ?? 20, 100));
    return rows;
  },
});

// The planner's consume pen for the above: the repairs it has now acted on.
// Stamped, never deleted — dtsEvents is append-only instrumentation, and what
// the planner consumed and when is part of the record.
export const internalMarkPlanRepairsConsumed = internalMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    let consumed = 0;
    for (const raw of ids.slice(0, 100)) {
      const id = ctx.db.normalizeId("dtsEvents", raw);
      if (!id) continue;
      const row = await ctx.db.get(id);
      if (!row || row.kind !== PLAN_REPAIR_KIND) continue;
      if (row.consumedAt !== undefined) continue;
      await ctx.db.patch(id, { consumedAt: now });
      consumed++;
    }
    return { consumed };
  },
});

export const internalMarkDigestSent = internalMutation({
  // windowEnd: the instant the digest was composed against. It is the start of
  // the NEXT digest's window (convex/ttsDigest.ts digestWindowStart), and the
  // event's `day` is the once-a-day dedupe key — so the two facts a digest run
  // needs from the last one live on one "digest-sent" event (ttsDigest
  // lastDigestSent reads it). Nothing is written to dtsDailyQueues any more
  // (the lifeos update, phase 7): the table stays until NARROW and gets no
  // new rows.
  args: {
    day: v.string(),
    surfacedTodoIds: v.array(v.id("dtsTodos")),
    // The askIds the objection list printed, in printed order — the digest's
    // own numbering, which is what a reply of "revert 2" names. Absent on a
    // resend and on a morning with no delegated decisions. `data` is v.any(),
    // so this is not a schema change.
    objectionAskIds: v.optional(v.array(v.string())),
    windowEnd: v.optional(v.number()),
    // The morning message was reduced to fit one Slack message (ttsCompose
    // MESSAGE_MAX_CHARS). Absent on a resend, which reposts a text already
    // composed and whose row said so at the time.
    truncated: v.optional(v.boolean()),
    // Which path wrote the message: the Fable run on the box, or the plain
    // template it falls back to (Tom 2026-09-09, amendment 2).
    writtenBy: v.optional(v.string()),
    // The deterministic inputs the message was written from — stored so the
    // transcript shows what the writer was given, not only what it wrote.
    facts: v.optional(v.any()),
  },
  handler: async (
    ctx,
    { day, surfacedTodoIds, windowEnd, truncated, objectionAskIds, writtenBy, facts },
  ) => {
    for (const todoId of surfacedTodoIds) {
      await logEvent(ctx, "surfaced", todoId, { via: "digest", day });
    }
    // NO KEY on a "digest-sent" row, ever: ttsDigest.lastDigestSent reads
    // by_kind_key with the kind pinned and every key empty, so within the kind
    // the index order IS time order and .first() is the newest row. Keying
    // these by day would silently break the window arithmetic of every future
    // morning message.
    await logEvent(ctx, "digest-sent", undefined, {
      day,
      windowEnd,
      truncated,
      objectionAskIds,
      writtenBy,
      facts,
    });
  },
});

// ── Internal: code-todo mirror upserts (from ttsSync.refreshMirror) ──────────
export const internalReplaceMirror = internalMutation({
  args: {
    repo: v.string(),
    rows: v.array(
      v.object({
        externalId: v.string(),
        tier: v.string(),
        status: v.string(),
        statement: v.string(),
        url: v.string(),
      }),
    ),
  },
  handler: async (ctx, { repo, rows }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsCodeTodoMirror")
      .withIndex("by_repo_external", (q) => q.eq("repo", repo))
      .collect();
    const byId = new Map(existing.map((r) => [r.externalId, r]));
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.externalId);
      const prior = byId.get(row.externalId);
      if (prior) {
        await ctx.db.patch(prior._id, { ...row, syncedAt: now });
      } else {
        await ctx.db.insert("dtsCodeTodoMirror", { repo, ...row, syncedAt: now });
      }
    }
    // A row missing from the file was closed-and-rewritten or renamed upstream;
    // the mirror only reflects, so drop it (the repo is the system of record —
    // nothing-is-lost applies to LIFE todos, not to this display cache).
    for (const prior of existing) {
      if (!seen.has(prior.externalId)) await ctx.db.delete(prior._id);
    }

    // A schema-v2 CODE GOAL says "that upstream todo is closed" — the mirror is
    // the only thing that can ever say so, and this is the only place the
    // mirror changes. Without this the migration mints active goals nothing can
    // complete, each of which blocks every dependent forever (ttsShared.isReady)
    // and never leaves Tom's inventory. An ABSENT mirror row is NOT evidence of
    // completion (memberProgress' rule: it may be a closed todo or an id that
    // never matched); only an explicit "closed" status closes the goal.
    const closed = new Set(
      rows.filter((r) => r.status === "closed").map((r) => r.externalId),
    );
    if (closed.size > 0) {
      const all = await ctx.db.query("dtsTodos").collect();
      for (const goal of all) {
        if (goal.kind !== "goal" || goal.status !== "active") continue;
        if (goal.codeRepo !== repo || goal.codeExternalId === undefined) continue;
        if (!closed.has(goal.codeExternalId)) continue;
        await applyStatusChange(ctx, goal, {
          status: "done",
          note: `${repo} ${goal.codeExternalId} closed upstream`,
        });
      }
    }
  },
});
