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
  CODE_TODO_REPOS,
  READINESS,
  goalCheckable,
  nyCalendarDayBoundsUtc,
  nyCalendarDayKey,
  nyOffsetHours,
} from "./ttsShared";
import { redactSecrets } from "../shared/redact.mjs";

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
export async function logEvent(
  ctx: MutationCtx,
  kind: string,
  todoId?: Id<"dtsTodos">,
  data?: unknown,
  // The indexed lookup key (schema: dtsEvents.key) — set on the kinds the
  // schema comment lists, and on no other.
  key?: string,
) {
  // A failure row (convex/ttsShared.ts isFailureKind) is a line in the
  // digest's broken section, which reads its window; nothing posts here.
  const id = await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind,
    todoId,
    data: data === undefined ? undefined : data,
    key,
  });
  return id;
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

/**
 * The mirror rows of the repos that still keep a code-todo file
 * (ttsShared CODE_TODO_REPOS). A repo taken OFF that list leaves its rows in
 * the table as records — ComplexMultiTrigger's 40, frozen at the last refresh
 * before ruling 70 moved its todos into TTS — and the evals still read them
 * by (repo, externalId) to rebuild a past code ruling's input, so they cannot
 * be deleted. What must not happen is a frozen "open" row reaching the page
 * or the planner as work that is still open: the refresh no longer visits
 * its repo, so nothing would ever close it. Every live reader goes through
 * here.
 */
async function liveMirrorRows(ctx: QueryCtx): Promise<Doc<"dtsCodeTodoMirror">[]> {
  const rows: Doc<"dtsCodeTodoMirror">[] = [];
  for (const repo of Object.keys(CODE_TODO_REPOS)) {
    rows.push(
      ...(await ctx.db
        .query("dtsCodeTodoMirror")
        .withIndex("by_repo_external", (q) => q.eq("repo", repo))
        .collect()),
    );
  }
  return rows;
}

export const listMirror = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgentId(ctx);
    return await liveMirrorRows(ctx);
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
    // Every updateTodo edit is a Tom touch — tomTouchedAt marks the row FROZEN:
    // no agent pen rewrites it or closes it behind him.
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
    // that same transition (the worker pen's completion closes a row with it),
    // and an agent action must not stamp a Tom touch (tomTouchedAt freezes the
    // row to every agent pen).
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
    // A poller's triage judged it to need Tom today, and why. Recorded on the
    // row for the morning message and the hourly line; nothing opens a thread.
    needsTomToday: v.optional(v.object({ why: v.string() })),
  },
  handler: async (
    ctx,
    { statement, source, provenance, slackChannel, slackTs, needsTomToday },
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
      // The reason is a model's words about a mail and reaches Slack, so it
      // passes the one redaction choke point here, where it is stored.
      ...(needsTomToday !== undefined ? { needsTomToday: { why: redactSecrets(needsTomToday.why) } } : {}),
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
    // ── The worker's three args (schema v2, 2026-08-29) ──────────────────────
    // A worker session advances one todo by one stable state, and this is the
    // pen it writes that state with. It needs three things the plan-era pen
    // did not have:
    //   evidence             — the artifact that shows the work happened (a
    //                          branch, a pull request, a written brief). The
    //                          schema field of the same name, per row.
    //   groundUpExplanation  — the self-contained "more" layer, written when a
    //                          task turns out to need Tom's judgment and he has
    //                          to be able to rule on it cold.
    //   status: "done"       — closes the row, which is what makes every todo
    //                          that NEEDS it ready. Accepted for any todo Tom
    //                          has not ruled on, once its evidence is recorded
    //                          (the bars are at the end of the handler). "done"
    //                          is the only value — archiving and sleeping stay
    //                          Tom's verdicts.
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
    // THE RUN THAT WROTE THE WRITE-UP. A ruling of Tom's on this todo is a
    // judgment about the text he read on the page, and this token is the only
    // honest edge back to the run that produced it (convex/agentLabels.ts; the
    // schema note on runs.regToken says why a time-window search over `runs`
    // by todoId is wrong on the ordinary case). Absent is a supported value:
    // an unregistered caller stamps nothing and a ruling on the row writes no
    // label rather than a guessed one.
    runToken: v.optional(v.string()),
    // THE DOOR CHECK'S MARK (phase 9). The planner's prepare pass reads what
    // it wrote against the writing standard and retries once; a write-up that
    // fails on both attempts is still posted, and these are the complaints it
    // failed on (Tom, 2026-09-12: "Agreed." — a silent hole costs more than a
    // marked fault). They ride the "prepared" event's `data` below rather than
    // the todo row: `data` is v.any(), so no schema change, and dtsEvents
    // by_todo already finds them. A PASS SENDS NO doorFaults KEY AT ALL, so
    // the newest "prepared" row answers "was the last write-up refused" by
    // itself and there is nothing to clear.
    doorFaults: v.optional(v.array(v.string())),
  },
  handler: async (
    ctx,
    { id, brief, entryAction, workDescription, readiness, dueAt, dateKind, evidence, groundUpExplanation, status, runToken, doorFaults },
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
    const written = [
      patch.brief !== undefined && "brief",
      patch.entryAction !== undefined && "entryAction",
      patch.workDescription !== undefined && "workDescription",
      patch.dueAt !== undefined && "dueAt",
      patch.evidence !== undefined && "evidence",
      patch.groundUpExplanation !== undefined && "groundUpExplanation",
    ].filter(Boolean);
    // THE STAMP FOLLOWS THE TEXT, and only the text. A call that wrote one of
    // the prepared fields above produced what Tom reads on the page, and its
    // run owns that text. A call that wrote NONE of them — the graph worker's
    // bare `status: "done"`, which closes a row and says nothing — wrote no
    // Tom-facing words, and stamping it would hand that run the credit (and
    // the blame) for a write-up another run made: a ruling on the row would
    // then be scored against the wrong output, which is the one failure the
    // whole token mechanism exists to prevent.
    if (runToken !== undefined && written.length > 0) {
      patch.producedByRunToken = runToken;
    }
    await ctx.db.patch(normalized, patch);
    await logEvent(ctx, "prepared", normalized, {
      readiness: patch.readiness,
      fields: written,
      ...(doorFaults === undefined ? {} : { doorFaults }),
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
      //   (a) evidence recorded. Tom ruled on 2026-09-24 to have no batches,
      //       so agents move toward completing all todos, and any todo he has
      //       not ruled on may be closed by an agent with its evidence
      //       recorded. The bar that stood here before — only a todo inside a
      //       batch could be completed by the pen — cannot stay: with no
      //       batches it would let no agent complete anything, the opposite of
      //       the ruling. The evidence bar replaces it as the thing that stops
      //       a bare status write closing one of Tom's todos with nothing to
      //       show for it.
      //   (b) a goal's condition is a GOAL CONDITION — a sentence about the
      //       world that is either true yet or not. A goal with no condition
      //       and no code subject has nothing an agent can go and check, and
      //       closing it would be closing Tom's todo for him. A todo with a
      //       condition is closed only when the condition is met, which is what
      //       its evidence has to show.
      //   (c) not frozen, unless it is a checkable goal. tomTouchedAt is the
      //       mark that Tom has ruled on the row, and every other agent write
      //       in this file respects it. A CHECKABLE goal is the one exception,
      //       and it is the design: its condition, not a judgment, decides it,
      //       and checking the world and recording the answer is a goal's
      //       whole contract.
      const why =
        (fresh.evidence ?? "").trim() === ""
          ? "a todo is completed by the pen only with its evidence recorded"
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

export const internalListMirror = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await liveMirrorRows(ctx);
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
    // The ComplexMultiTrigger goals the two batch migrations wrote this way are
    // no longer code goals: CMT's registry is retired (ruling 70), and
    // ttsMigrations.internalConvertClosedUpstreamGoals turns each into a plain
    // goal whose condition is the entry's own completion test, with no code
    // subject, so this sweep never reaches them.
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
