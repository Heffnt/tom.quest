// tables.ts — the record's core tables under their plain names (2026-09-26).
//
// Convex has no table rename, so each old table's rows are COPIED into the
// plain-named table beside it (convex/schema.ts), every field kept, and the
// old row's _id kept as `legacyId` so an id cited outside the record (the
// evidence, a Slack thread, a box file, WikiTom's tts/snapshot) still finds
// its row (resolveId below). The copy never deletes: the old table stays
// whole until the copy counts are confirmed, then a later commit empties it
// and drops it from the schema.
//
// THE ORDER. Per table: (1) deploy the schema with both tables; (2) `copy`
// the rows; (3) deploy the commit that points every reader and writer at the
// new table; (4) `copy` again, which brings over what the old code wrote
// between (2) and (3) and touches nothing written since; (5) `counts`. The
// copy is an upsert on legacyId: a row already copied is patched only when
// the old row is newer by the table's own clock (VERSION below), so a change
// made through the new code is never overwritten by the old row.
//
// REFERENCES. todos.needs names todos, so it is mapped after the whole table
// is copied (`copy` chains the needs pass itself). A ruling's, block's or
// time note's todo is copied as the id it is: those tables name dtsTodos
// until todos move, and the todos move maps every reference at once.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id, TableNames } from "../_generated/dataModel";

/** Each plain-named table and the table its rows come from. */
const RENAMED = {
  todos: "dtsTodos",
  rulings: "dtsRulings",
  calendar: "ttsCalendarEvents",
  repeats: "ttsRepeats",
  vocabulary: "ttsVocabulary",
  blocks: "dtsBlocks",
  timeNotes: "dtsTimeNotes",
} as const;

type NewTable = keyof typeof RENAMED;
const NEW_TABLE = v.union(
  v.literal("todos"),
  v.literal("rulings"),
  v.literal("calendar"),
  v.literal("repeats"),
  v.literal("vocabulary"),
  v.literal("blocks"),
  v.literal("timeNotes"),
);

/** A row's own clock: the copy patches a copied row only when the old row is
 *  newer by it. Tables whose rows never change after insert use createdAt. */
const VERSION: Record<NewTable, (row: Record<string, unknown>) => number> = {
  todos: (r) => Number(r.updatedAt ?? 0),
  rulings: (r) => Number(r.appliedAt ?? r.ruledAt ?? 0),
  calendar: (r) => Number(r.syncedAt ?? 0),
  repeats: (r) => Number(r.updatedAt ?? 0),
  vocabulary: (r) => Number(r.generatedAt ?? 0),
  blocks: (r) => Number(r.createdAt ?? 0),
  timeNotes: (r) => Number(r.resolvedAt ?? r.createdAt ?? 0),
};

const DEFAULT_PAGE = 100;
/** todos rows run to ~5 KB, so a page of 100 stays far under a mutation's
 *  read and write limits; the smaller tables take the same page. */
const MAX_PAGE = 500;

/** A copied row, as the copy reads it: any of the seven tables' fields. */
type CopiedRow = Record<string, unknown> & { _id: string };

/** The one index every renamed table declares, as the copy uses it. */
type ByLegacy = {
  withIndex(
    name: "by_legacy",
    range: (q: { eq(field: "legacyId", value: string): unknown }) => unknown,
  ): { first(): Promise<CopiedRow | null> };
};

/** The row's copy in `table`, found by the old _id it was copied from. The
 *  cast is the one place the seven tables are spoken of as one. */
async function copyOf(
  ctx: QueryCtx | MutationCtx,
  table: NewTable,
  legacyId: string,
): Promise<CopiedRow | null> {
  return await (ctx.db.query(table) as unknown as ByLegacy)
    .withIndex("by_legacy", (q) => q.eq("legacyId", legacyId))
    .first();
}

/**
 * An id as anything outside the record spells it: an id of the renamed
 * table, or the id its row had before the rename (the box's files, a Slack
 * thread, a label's ref, the evidence). The one reader of legacyId; null when
 * neither names a row.
 */
export async function resolveId<T extends NewTable>(
  ctx: QueryCtx | MutationCtx,
  table: T,
  id: string,
): Promise<Id<T> | null> {
  const direct = ctx.db.normalizeId(table, id);
  if (direct !== null) return (await ctx.db.get(direct)) === null ? null : direct;
  if (ctx.db.normalizeId(RENAMED[table], id) === null) return null;
  const copied = await copyOf(ctx, table, id);
  return copied === null ? null : (copied._id as Id<T>);
}

/**
 * A todo reference read from a table that takes either id until the narrow
 * (rulings, blocks, timeNotes, claudeSessions, runs, dtsEvents, runners).
 * remapTodoRefs points every stored one at todos right after the switch, so
 * it is read as a todos id; the narrow deletes this with the union.
 */
export function todoRef(id: Id<"todos"> | Id<"dtsTodos">): Id<"todos">;
export function todoRef(id: Id<"todos"> | Id<"dtsTodos"> | undefined): Id<"todos"> | undefined;
export function todoRef(id: Id<"todos"> | Id<"dtsTodos"> | undefined): Id<"todos"> | undefined {
  return id as Id<"todos"> | undefined;
}

/** The old row as the new table stores it: every field, references mapped,
 *  needs left to the needs pass. */
async function fieldsFor(
  ctx: MutationCtx,
  table: NewTable,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // _creationTime is the old row's; the new row gets its own.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _id, _creationTime, ...fields } = row;
  const out: Record<string, unknown> = { ...fields, legacyId: String(_id) };
  if (table === "todos") delete out.needs;
  if (table === "timeNotes" && typeof fields.blockId === "string") {
    const block = await copyOf(ctx, "blocks", fields.blockId);
    if (block === null) throw new Error(`timeNotes: block ${fields.blockId} is not copied yet; copy blocks first`);
    out.blockId = block._id;
  }
  return out;
}

/**
 * Copy one page of `table`'s old rows, and schedule the next page until the
 * old table is done; for todos, then the needs pass. Answers what this page
 * did. Re-running is safe: see the header.
 */
export const copy = internalMutation({
  args: {
    table: NEW_TABLE,
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    /** false runs one page only (tests); the default chains to the end. */
    chain: v.optional(v.boolean()),
  },
  handler: async (ctx, { table, cursor, pageSize, chain }) => {
    const numItems = Math.min(Math.max(1, Math.floor(pageSize ?? DEFAULT_PAGE)), MAX_PAGE);
    const page = await ctx.db
      .query(RENAMED[table] as TableNames)
      .order("asc")
      .paginate({ cursor: cursor ?? null, numItems });
    let inserted = 0;
    let patched = 0;
    let unchanged = 0;
    for (const old of page.page as Array<Record<string, unknown>>) {
      const fields = await fieldsFor(ctx, table, old);
      const existing = await copyOf(ctx, table, String(old._id));
      if (existing === null) {
        await ctx.db.insert(table, fields as never);
        inserted += 1;
      } else if (VERSION[table](old) > VERSION[table](existing)) {
        await ctx.db.patch(existing._id as Id<NewTable>, fields as never);
        patched += 1;
      } else {
        unchanged += 1;
      }
    }
    if (chain !== false) {
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.copy, {
          table,
          cursor: page.continueCursor,
          pageSize: numItems,
        });
      } else if (table === "todos") {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.copyNeeds, { pageSize: numItems });
      } else if (table === "rulings") {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapRulingRefs, {});
      }
    }
    return { table, inserted, patched, unchanged, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * todos.needs, mapped from each old row's needs once every todo is copied.
 * A copied row whose own clock has moved past the old row's (a change made
 * through the new code) keeps its needs.
 */
export const copyNeeds = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    chain: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, pageSize, chain }) => {
    const numItems = Math.min(Math.max(1, Math.floor(pageSize ?? DEFAULT_PAGE)), MAX_PAGE);
    const page = await ctx.db.query("dtsTodos").order("asc").paginate({ cursor: cursor ?? null, numItems });
    let mapped = 0;
    let dangling = 0;
    const missing: string[] = [];
    for (const old of page.page) {
      const copied = await copyOf(ctx, "todos", old._id);
      if (copied === null) {
        missing.push(old._id);
        continue;
      }
      if (Number(copied.updatedAt ?? 0) > old.updatedAt) continue;
      if (old.needs === undefined) {
        if (copied.needs !== undefined) await ctx.db.patch(copied._id as Id<"todos">, { needs: undefined });
        continue;
      }
      const needs: Id<"todos">[] = [];
      for (const need of old.needs) {
        const target = await copyOf(ctx, "todos", need);
        if (target !== null) needs.push(target._id as Id<"todos">);
        // A need on a row that no longer exists names nothing in either
        // table; it is dropped, and counted.
        else if ((await ctx.db.get(need)) === null) dangling += 1;
        else missing.push(need);
      }
      await ctx.db.patch(copied._id as Id<"todos">, { needs });
      mapped += 1;
    }
    if (missing.length > 0) {
      // A need on a todo the copy has not reached cannot happen after a full
      // copy; saying so beats writing a shorter list silently.
      throw new Error(`copyNeeds: not copied yet: ${missing.slice(0, 5).join(", ")}; run copy todos first`);
    }
    if (chain !== false && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.jarvis.tables.copyNeeds, {
        cursor: page.continueCursor,
        pageSize: numItems,
      });
    }
    return { mapped, dangling, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** One page of a count: rows, and (new tables) rows carrying a legacyId. */
export const countPage = internalQuery({
  args: {
    table: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db
      .query(table as TableNames)
      .paginate({ cursor, numItems: 200 });
    const copied = page.page.filter((r) => typeof (r as Record<string, unknown>).legacyId === "string").length;
    return { rows: page.page.length, copied, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * Every renamed table's count beside its old table's: the check the old
 * tables are emptied on. `copied` is the new table's rows that came from the
 * old one; it equals `old` when the copy is whole.
 */
export const counts = internalAction({
  args: {},
  handler: async (ctx) => {
    const count = async (table: string) => {
      let rows = 0;
      let copied = 0;
      let cursor: string | null = null;
      for (;;) {
        const page: { rows: number; copied: number; isDone: boolean; continueCursor: string } =
          await ctx.runQuery(internal.jarvis.tables.countPage, { table, cursor });
        rows += page.rows;
        copied += page.copied;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      return { rows, copied };
    };
    const out: Record<string, { old: number; new: number; copied: number; whole: boolean }> = {};
    for (const [table, old] of Object.entries(RENAMED)) {
      const before = await count(old);
      const after = await count(table);
      out[table] = { old: before.rows, new: after.rows, copied: after.copied, whole: after.copied === before.rows };
    }
    return out;
  },
});

/**
 * A label on a ruling names it as `ruling:<id>` (runLabels.ref, looked up on
 * by_ref): each copied ruling's labels are pointed at its new id. The rulings
 * table is append-only at Tom's pace (five rows on 2026-09-26), so one
 * mutation takes every copied row.
 */
export const remapRulingRefs = internalMutation({
  args: {},
  handler: async (ctx) => {
    let labels = 0;
    for (const ruling of await ctx.db.query("rulings").collect()) {
      if (ruling.legacyId === undefined) continue;
      const old = await ctx.db
        .query("runLabels")
        .withIndex("by_ref", (q) => q.eq("ref", `ruling:${ruling.legacyId}`))
        .collect();
      for (const label of old) {
        await ctx.db.patch(label._id, { ref: `ruling:${ruling._id}` });
        labels += 1;
      }
    }
    return { labels };
  },
});

// ── The todos move: every stored reference to a todo, pointed at todos ─────
//
// Run once the todos switch is live and the catch-up copies of todos, blocks
// and timeNotes have run: remapTodoRefs walks the copied todos and patches
// what names each one by its old id: its rulings, sessions and dtsEvents rows
// (each on its by_todo index), the events rows whose subject is the old id,
// and chains remapTodoStragglers for the references no index reaches (blocks,
// time notes, runners, a weekly session's agenda) and then remapRunTodos for
// runs.todoId. A reference written after the switch already names todos and
// is left alone.

/** Rows patched per todo per table in one mutation; a todo with more is
 *  taken again by the same page, which then finds only what is left. */
const REMAP_CAP = 100;
const REMAP_PAGE = 10;

/** A todos id for a stored reference, or null when it already is one (or
 *  names no copied todo). */
async function mappedTodo(ctx: MutationCtx, id: string): Promise<Id<"todos"> | null> {
  if (ctx.db.normalizeId("dtsTodos", id) === null) return null;
  const copied = await copyOf(ctx, "todos", id);
  return copied === null ? null : (copied._id as Id<"todos">);
}

export const remapTodoRefs = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    chain: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, chain }) => {
    const page = await ctx.db.query("todos").order("asc").paginate({ cursor: cursor ?? null, numItems: REMAP_PAGE });
    const patched = { rulings: 0, claudeSessions: 0, dtsEvents: 0, events: 0 };
    let more = false;
    for (const todo of page.page) {
      if (todo.legacyId === undefined) continue;
      const old = todo.legacyId as Id<"dtsTodos">;
      for (const row of await ctx.db.query("rulings").withIndex("by_todo", (q) => q.eq("todoId", old)).take(REMAP_CAP)) {
        await ctx.db.patch(row._id, { todoId: todo._id });
        patched.rulings += 1;
      }
      for (const row of await ctx.db.query("claudeSessions").withIndex("by_todo", (q) => q.eq("todoId", old)).take(REMAP_CAP)) {
        await ctx.db.patch(row._id, { todoId: todo._id });
        patched.claudeSessions += 1;
      }
      const dts = await ctx.db.query("dtsEvents").withIndex("by_todo", (q) => q.eq("todoId", old)).take(REMAP_CAP);
      for (const row of dts) await ctx.db.patch(row._id, { todoId: todo._id });
      patched.dtsEvents += dts.length;
      const events = await ctx.db.query("events").withIndex("by_subject_at", (q) => q.eq("subject", todo.legacyId)).take(REMAP_CAP);
      for (const row of events) await ctx.db.patch(row._id, { subject: todo._id });
      patched.events += events.length;
      if (dts.length === REMAP_CAP || events.length === REMAP_CAP) more = true;
    }
    if (chain !== false) {
      if (more) {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapTodoRefs, { cursor: cursor ?? null });
      } else if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapTodoRefs, { cursor: page.continueCursor });
      } else {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapTodoStragglers, {});
      }
    }
    return { patched, more, isDone: page.isDone && !more, continueCursor: more ? (cursor ?? null) : page.continueCursor };
  },
});

/** The references no by_todo index reaches; each table holds a handful of
 *  rows (0 blocks, 1 time note, 0 runners, one weekly session a week). */
export const remapTodoStragglers = internalMutation({
  args: { chain: v.optional(v.boolean()) },
  handler: async (ctx, { chain }) => {
    const patched = { blocks: 0, timeNotes: 0, runners: 0, agendas: 0 };
    for (const row of await ctx.db.query("blocks").collect()) {
      const todoId = row.todoId === undefined ? null : await mappedTodo(ctx, row.todoId);
      if (todoId !== null) {
        await ctx.db.patch(row._id, { todoId });
        patched.blocks += 1;
      }
    }
    for (const row of await ctx.db.query("timeNotes").collect()) {
      const todoId = row.todoId === undefined ? null : await mappedTodo(ctx, row.todoId);
      if (todoId !== null) {
        await ctx.db.patch(row._id, { todoId });
        patched.timeNotes += 1;
      }
    }
    for (const row of await ctx.db.query("runners").collect()) {
      if (row.subject?.kind !== "todo") continue;
      const todoId = await mappedTodo(ctx, row.subject.todoId);
      if (todoId !== null) {
        await ctx.db.patch(row._id, { subject: { kind: "todo", todoId } });
        patched.runners += 1;
      }
    }
    for (const row of await ctx.db.query("claudeSessions").withIndex("by_kind_agenda_day", (q) => q.eq("kind", "weekly")).collect()) {
      if (row.agendaSubjects === undefined) continue;
      let changed = false;
      const subjects: string[] = [];
      for (const subject of row.agendaSubjects) {
        const todoId = await mappedTodo(ctx, subject);
        subjects.push(todoId ?? subject);
        changed ||= todoId !== null;
      }
      if (changed) {
        await ctx.db.patch(row._id, { agendaSubjects: subjects });
        patched.agendas += 1;
      }
    }
    if (chain !== false) await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapRunTodos, {});
    return patched;
  },
});

/** runs.todoId has no index: every run is read, a page at a time. */
export const remapRunTodos = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    chain: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, chain }) => {
    const page = await ctx.db.query("runs").paginate({ cursor: cursor ?? null, numItems: 200 });
    let patched = 0;
    for (const run of page.page) {
      const todoId = run.todoId === undefined ? null : await mappedTodo(ctx, run.todoId);
      if (todoId === null) continue;
      await ctx.db.patch(run._id, { todoId });
      patched += 1;
    }
    if (chain !== false && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapRunTodos, { cursor: page.continueCursor });
    }
    return { patched, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * What still names a todo by its old id, the check the narrow waits on: every
 * count is 0 once the remap has run. Reads each table a page at a time.
 */
export const leftToRemapPage = internalQuery({
  args: {
    table: v.union(
      v.literal("rulings"),
      v.literal("claudeSessions"),
      v.literal("runs"),
      v.literal("blocks"),
      v.literal("timeNotes"),
    ),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems: 500 });
    const old = page.page.filter((row) => {
      const id = (row as { todoId?: string }).todoId;
      return id !== undefined && ctx.db.normalizeId("dtsTodos", id) !== null;
    }).length;
    return { old, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

export const leftToRemap = internalAction({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, number> = {};
    // dtsEvents is left out: the remap reached its rows on by_todo, and a
    // full read of the retiring table is the slowest check there is.
    for (const table of ["rulings", "claudeSessions", "runs", "blocks", "timeNotes"] as const) {
      let old = 0;
      let cursor: string | null = null;
      for (;;) {
        const page: { old: number; isDone: boolean; continueCursor: string } = await ctx.runQuery(
          internal.jarvis.tables.leftToRemapPage,
          { table, cursor },
        );
        old += page.old;
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      out[table] = old;
    }
    return out;
  },
});
