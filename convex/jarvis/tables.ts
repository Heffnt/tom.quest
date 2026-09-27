// tables.ts — the record's core tables under their plain names.
//
// Convex has no table rename, so the rows of dtsRulings, and then of the
// todos, blocks and time notes, were COPIED into `rulings`, `todos`, `blocks`
// and `timeNotes` (convex/schema.ts), every field kept, and the old row's _id
// kept as `legacyId`, so an id cited outside the record (the evidence, a Slack
// thread, a box file, WikiTom's tts/snapshot) or stored by a row written
// before the move still finds its row (resolveId below). The rulings' copy ran
// in production on 2026-09-26; dtsRulings stays whole until `counts` confirms
// it, then a later commit empties it and drops it from the schema.
//
// TODOS, BLOCKS AND TIME NOTES moved in three steps: the copy and the dual
// write (step A), the readers (step B), and the writers (step C, whose last
// pull request stopped every write to the old tables). Then the old tables
// left the schema. What the deployment still holds of them is emptied once by
// purgeOldTables (below), after WikiTom tts/snapshot holds their final state;
// nothing else here names them.
//
// AN ID IN EITHER FORM. An id reaches the record as the plain row's, or as the
// _id its row had before the move (an old link, a Slack thread, a box file,
// and the todo reference a ruling, event, session, run or ask stored before
// step C). The old table is gone, so an old id is no table's id: it is a
// string, and the plain row carrying it as legacyId is the row it names.
// `coreId` is the argument validator that takes either form; `resolveId`
// answers the plain row, which every reader reads and every writer writes.
// Every writer stores the plain id; a stored todo reference is a string in the
// schema because the rows written before step C hold the old one, and every
// reader of one reads both forms as the one todo (todoIdForms, todoEvents,
// todoRulings; withPlainTodoIds before liveRulings).

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** A row of a plain-named table, as the legacy lookup reads it. */
type Row = Record<string, unknown> & { _id: string };

/** The one index every plain-named table declares, as the lookup uses it. */
type ByLegacy = {
  withIndex(
    name: "by_legacy",
    range: (q: { eq(field: "legacyId", value: string): unknown }) => unknown,
  ): { first(): Promise<Row | null> };
};

/** The tables whose rows were copied, each keeping its old _id as legacyId. */
type Plain = "rulings" | "todos" | "blocks" | "timeNotes";

/** The row copied from an old row, found by the old _id. The cast is the one
 *  place the plain tables are spoken of as one. */
async function copyOf(ctx: QueryCtx | MutationCtx, table: Plain, legacyId: string): Promise<Row | null> {
  return await (ctx.db.query(table) as unknown as ByLegacy)
    .withIndex("by_legacy", (q) => q.eq("legacyId", legacyId))
    .first();
}

/** A core id as a function argument takes it from outside the record: the
 *  plain row's id, or the id its row had before the move (an old link, a
 *  Slack thread, a box file, a stored reference). resolveId reads it; a
 *  string naming no row names nothing. */
export const coreId = v.string();

/**
 * An id as anything outside the record spells it: an id of the plain table,
 * or the id its row had before the move (the box's files, a Slack thread, a
 * label's ref, the evidence, a reference another table stores), found as the
 * plain row's legacyId. The one reader of legacyId; null when neither names a
 * row.
 *
 * A TODO REFERENCE NAMING NO ROW NAMES NO TODO. No todo is ever deleted, so
 * such an id (one checked for form only before step B, or a caller's typo)
 * names nothing a reader could find: a writer stores no todo for it, and a
 * reader of a stored one hands out none.
 */
export async function resolveId<T extends Plain>(
  ctx: QueryCtx | MutationCtx,
  table: T,
  id: string,
): Promise<Id<T> | null> {
  const direct = ctx.db.normalizeId(table, id);
  if (direct !== null) return (await ctx.db.get(direct)) === null ? null : direct;
  const copied = await copyOf(ctx, table, id);
  return copied === null ? null : (copied._id as Id<T>);
}

/**
 * The plain todo an id in either form names, read at most once per id: the
 * lookup a gather makes for every reference its rows hold.
 */
export function todoReader(ctx: QueryCtx | MutationCtx): (id: string | undefined) => Promise<Doc<"todos"> | null> {
  const seen = new Map<string, Doc<"todos"> | null>();
  return async (id) => {
    if (id === undefined) return null;
    const hit = seen.get(id);
    if (hit !== undefined) return hit;
    const plain = await resolveId(ctx, "todos", id);
    const row = plain === null ? null : await ctx.db.get(plain);
    seen.set(id, row);
    return row;
  };
}

/**
 * Rows holding a stored todo reference (a ruling's, an event's, a session's),
 * as a reader hands them out: the todoId is the plain row's id, whichever
 * form the row stores. One lookup per todo named, however many rows name it.
 */
export async function withPlainTodoIds<R extends { todoId?: string }>(
  ctx: QueryCtx | MutationCtx,
  rows: R[],
): Promise<Array<Omit<R, "todoId"> & { todoId?: Id<"todos"> }>> {
  const seen = new Map<string, Id<"todos"> | null>();
  const out: Array<Omit<R, "todoId"> & { todoId?: Id<"todos"> }> = [];
  for (const row of rows) {
    const stored = row.todoId;
    if (stored !== undefined && !seen.has(stored)) seen.set(stored, await resolveId(ctx, "todos", stored));
    const plain = stored === undefined ? null : (seen.get(stored) ?? null);
    if (plain !== null) {
      out.push({ ...row, todoId: plain });
      continue;
    }
    // No reference, or one naming no row: handed out as no todo (resolveId above).
    const copy = { ...row };
    delete copy.todoId;
    out.push(copy as Omit<R, "todoId">);
  }
  return out;
}

/**
 * Every id a stored reference to this todo may hold, the plain row's first:
 * a ruling, event, session or run written before step C holds the old row's
 * id, one written since holds the plain one. A read of an index on a stored
 * todoId reads each form. [] when neither form names a row.
 */
export async function todoIdForms(ctx: QueryCtx | MutationCtx, id: string): Promise<string[]> {
  const plain = await resolveId(ctx, "todos", id);
  const row = plain === null ? null : await ctx.db.get(plain);
  if (row === null) return [];
  return row.legacyId === undefined ? [row._id] : [row._id, row.legacyId];
}

/** The events on a todo under either id they store it by, oldest first:
 *  those at or after `from`. */
export async function todoEvents(
  ctx: QueryCtx | MutationCtx,
  id: string,
  from = 0,
): Promise<Doc<"dtsEvents">[]> {
  const out: Doc<"dtsEvents">[] = [];
  for (const form of await todoIdForms(ctx, id)) {
    out.push(...(await ctx.db.query("dtsEvents").withIndex("by_todo", (q) => q.eq("todoId", form).gte("at", from)).collect()));
  }
  return out.sort((a, b) => a.at - b.at || a._creationTime - b._creationTime);
}

/** Whether a todo has an event of `kind` at or after `from`, under either id
 *  it is stored by: each form read through by_todo_kind to its first row, so
 *  no other kind of row on the todo is read. */
export async function todoHasEventSince(
  ctx: QueryCtx | MutationCtx,
  id: string,
  kind: string,
  from: number,
): Promise<boolean> {
  for (const form of await todoIdForms(ctx, id)) {
    const hit = await ctx.db
      .query("dtsEvents")
      .withIndex("by_todo_kind", (q) => q.eq("todoId", form).eq("kind", kind).gte("at", from))
      .first();
    if (hit !== null) return true;
  }
  return false;
}

/** The newest `n` events on a todo under either id they store it by, newest
 *  first: `n` read through the index for each form, merged, cut to `n`. The
 *  bounded read for a history that only grows. */
export async function newestTodoEvents(
  ctx: QueryCtx | MutationCtx,
  id: string,
  n: number,
): Promise<Doc<"dtsEvents">[]> {
  const out: Doc<"dtsEvents">[] = [];
  for (const form of await todoIdForms(ctx, id)) {
    out.push(...(await ctx.db.query("dtsEvents").withIndex("by_todo", (q) => q.eq("todoId", form)).order("desc").take(n)));
  }
  return out.sort((a, b) => b.at - a.at || b._creationTime - a._creationTime).slice(0, n);
}

/** The rulings on a todo under either id they store it by, each handed out
 *  with the plain id, so liveRulings keys them as one subject. */
export async function todoRulings(ctx: QueryCtx | MutationCtx, id: string): Promise<Doc<"rulings">[]> {
  const out: Doc<"rulings">[] = [];
  for (const form of await todoIdForms(ctx, id)) {
    out.push(...(await ctx.db.query("rulings").withIndex("by_todo", (q) => q.eq("todoId", form)).collect()));
  }
  return await withPlainTodoIds(ctx, out);
}

/** One page of a count: rows, and (in `rulings`) rows carrying a legacyId. */
export const countPage = internalQuery({
  args: {
    table: v.union(v.literal("rulings"), v.literal("dtsRulings")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems: 200 });
    const copied = page.page.filter((r) => typeof (r as Record<string, unknown>).legacyId === "string").length;
    return { rows: page.page.length, copied, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * `rulings` counted beside dtsRulings: the check the old table is emptied
 * on. `copied` is the new table's rows that came from the old one; it equals
 * `old` when the copy is whole.
 */
export const counts = internalAction({
  args: {},
  handler: async (ctx) => {
    const count = async (table: "rulings" | "dtsRulings") => {
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
    const before = await count("dtsRulings");
    const after = await count("rulings");
    return { rulings: { old: before.rows, new: after.rows, copied: after.copied, whole: after.copied === before.rows } };
  },
});

// ── blocks ──────────────────────────────────────────────────────────────────

/** Rows per page of clearBlock. */
const PAGE = 100;

/** One page of the time notes naming a deleted block, taken off it (tts
 *  removeBlock); the rest go to clearBlockPage, which runs until none is
 *  left. Each patched note leaves the by_block range, so every page reads
 *  from its start. */
export async function clearBlock(ctx: MutationCtx, blockId: Id<"blocks">) {
  const notes = await ctx.db.query("timeNotes").withIndex("by_block", (q) => q.eq("blockId", blockId)).take(PAGE + 1);
  for (const note of notes.slice(0, PAGE)) await ctx.db.patch(note._id, { blockId: undefined });
  if (notes.length > PAGE) await ctx.scheduler.runAfter(0, internal.jarvis.tables.clearBlockPage, { blockId });
}

export const clearBlockPage = internalMutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => await clearBlock(ctx, blockId),
});

type Paged = { isDone: boolean; continueCursor: string };

/** Every page of a paged function, from the start, and the sum of each
 *  numeric field of the answers. */
async function drain<T extends Paged>(step: (cursor: string | null) => Promise<T>): Promise<Record<string, number>> {
  const sum: Record<string, number> = {};
  let cursor: string | null = null;
  for (;;) {
    const page = await step(cursor);
    for (const [key, value] of Object.entries(page)) if (typeof value === "number") sum[key] = (sum[key] ?? 0) + value;
    if (page.isDone) return sum;
    cursor = page.continueCursor;
  }
}

// ── the old tables are emptied ──────────────────────────────────────────────
//
// dtsTodos, dtsBlocks and dtsTimeNotes are out of the schema: nothing has
// written them since step C and nothing reads them. Dropping a table from the
// schema deletes none of its rows (Convex validates only the tables the
// schema lists, and a push's schema diff has no table deletion, only index
// removals: AGENTS.md, "schema"), so the rows stay on the deployment
// undeclared until this empties them.
//
// It runs once, by hand (`tts-convex run jarvis/tables:purgeOldTables`), and
// only after WikiTom tts/snapshot holds each table's final state: the first
// nightly copy after the old writes stopped. `expect` is that copy's row
// count per table (the lines of dtsTodos.jsonl, dtsBlocks.jsonl and
// dtsTimeNotes.jsonl). The tables are counted first, and nothing is deleted
// unless every count equals the copy's, so a row the copy does not hold is
// never deleted. The old ids stay readable after: each plain row keeps its
// old row's _id as legacyId, and resolveId maps it.
//
// The tables are named through a loose view of the database, since the
// schema no longer declares them: Convex reads and deletes an undeclared
// table's rows like any other's. A later pull request deletes this section
// once the run has reported every table empty.

const OLD_TABLES = ["dtsTimeNotes", "dtsBlocks", "dtsTodos"] as const;
type OldTable = (typeof OLD_TABLES)[number];
const OLD_TABLE = v.union(...OLD_TABLES.map((table) => v.literal(table)));

/** Rows per page of the count and the purge: a dtsTodos row runs to ~5 KB. */
const PURGE_PAGE = 200;

/** The database as the purge reads it: any table by name. */
type LooseDb = {
  query(table: string): {
    paginate(opts: { cursor: string | null; numItems: number }): Promise<{
      page: Array<{ _id: string }>;
      isDone: boolean;
      continueCursor: string;
    }>;
    take(n: number): Promise<Array<{ _id: string }>>;
  };
  delete(id: string): Promise<void>;
};
const loose = (ctx: QueryCtx | MutationCtx) => ctx.db as unknown as LooseDb;

/** One page of an old table's count. */
export const oldCountPage = internalQuery({
  args: { table: OLD_TABLE, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    const page = await loose(ctx).query(table).paginate({ cursor, numItems: PURGE_PAGE });
    return { rows: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** One page of an old table deleted, from its start: every row a page
 *  deletes leaves the table, so the next page reads the rows after it. */
export const purgeOldPage = internalMutation({
  args: { table: OLD_TABLE },
  handler: async (ctx, { table }) => {
    const rows = await loose(ctx).query(table).take(PURGE_PAGE);
    for (const row of rows) await loose(ctx).delete(row._id);
    return { deleted: rows.length, isDone: rows.length < PURGE_PAGE };
  },
});

/** The purge's one row in the record: what each table held and what went,
 *  as the migrations record a finished run. */
export const recordPurge = internalMutation({
  args: { counted: v.record(v.string(), v.number()), deleted: v.record(v.string(), v.number()) },
  handler: async (ctx, data) => {
    await ctx.db.insert("dtsEvents", { at: Date.now(), kind: "old-tables-purged", data });
  },
});

/**
 * Empties dtsTodos, dtsBlocks and dtsTimeNotes, once each table's row count
 * equals `expect` (the off-box copy's). Answers each table's count and, when
 * every count matched, what was deleted; when one did not, deletes nothing.
 */
export const purgeOldTables = internalAction({
  args: { expect: v.object({ dtsTodos: v.number(), dtsBlocks: v.number(), dtsTimeNotes: v.number() }) },
  handler: async (ctx, { expect }) => {
    const counted = {} as Record<OldTable, number>;
    for (const table of OLD_TABLES) {
      const sums = await drain(
        (cursor): Promise<Paged> => ctx.runQuery(internal.jarvis.tables.oldCountPage, { table, cursor }),
      );
      counted[table] = sums.rows ?? 0;
    }
    const mismatched = OLD_TABLES.filter((table) => counted[table] !== expect[table]);
    if (mismatched.length > 0) return { purged: false as const, counted, expect, mismatched };
    const deleted = {} as Record<OldTable, number>;
    for (const table of OLD_TABLES) {
      deleted[table] = 0;
      for (;;) {
        const page: { deleted: number; isDone: boolean } = await ctx.runMutation(
          internal.jarvis.tables.purgeOldPage,
          { table },
        );
        deleted[table] += page.deleted;
        if (page.isDone) break;
      }
    }
    await ctx.runMutation(internal.jarvis.tables.recordPurge, { counted, deleted });
    return { purged: true as const, counted, deleted };
  },
});
