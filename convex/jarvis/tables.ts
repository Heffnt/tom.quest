// tables.ts — rulings under their plain name (2026-09-26).
//
// Convex has no table rename, so the old dtsRulings rows were COPIED into
// `rulings` (convex/schema.ts), every field kept, and the old row's _id kept
// as `legacyId` so an id cited outside the record (the evidence, a Slack
// thread, a box file, WikiTom's tts/snapshot) still finds its row (resolveId
// below). The copy and the label remap ran in production on 2026-09-26
// (09:01Z and 09:04Z) and went with this stack; every ruling since is written
// to `rulings`. dtsRulings stays whole until `counts` confirms the copy, then
// a later commit empties it and drops it from the schema.
//
// TODOS, BLOCKS AND TIME NOTES move the same way in three pull requests. This
// file holds the first: the copy machinery below the rulings count, which
// changes no reader or writer (every one still names dtsTodos, dtsBlocks and
// dtsTimeNotes until the switch). calendar, repeats and vocabulary stay
// declared and untouched.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Each plain-named core table and the table its rows come from. */
const CORE = { todos: "dtsTodos", blocks: "dtsBlocks", timeNotes: "dtsTimeNotes" } as const;
type Core = keyof typeof CORE;
const CORE_TABLE = v.union(v.literal("todos"), v.literal("blocks"), v.literal("timeNotes"));

/** A row of any of these tables, as the copy reads it. */
type Row = Record<string, unknown> & { _id: string };

/** The one index every plain-named table declares, as the copy uses it. */
type ByLegacy = {
  withIndex(
    name: "by_legacy",
    range: (q: { eq(field: "legacyId", value: string): unknown }) => unknown,
  ): { first(): Promise<Row | null> };
};

/** The row copied from an old row, found by the old _id. The cast is the one
 *  place the plain tables are spoken of as one. */
async function copyOf(ctx: QueryCtx | MutationCtx, table: "rulings" | Core, legacyId: string): Promise<Row | null> {
  return await (ctx.db.query(table) as unknown as ByLegacy)
    .withIndex("by_legacy", (q) => q.eq("legacyId", legacyId))
    .first();
}

/**
 * A ruling id as anything outside the record spells it: an id of `rulings`,
 * or the id its row had in dtsRulings (the box's files, a Slack thread, a
 * label's ref, the evidence). The one reader of legacyId; null when neither
 * names a row.
 */
export async function resolveId(
  ctx: QueryCtx | MutationCtx,
  table: "rulings",
  id: string,
): Promise<Id<"rulings"> | null> {
  const direct = ctx.db.normalizeId(table, id);
  if (direct !== null) return (await ctx.db.get(direct)) === null ? null : direct;
  if (ctx.db.normalizeId("dtsRulings", id) === null) return null;
  const copied = await copyOf(ctx, table, id);
  return copied === null ? null : (copied._id as Id<"rulings">);
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

// ── todos, blocks and timeNotes: the copy, the remap, the check, the way back ─
//
// sync {table} makes the plain table hold what its old table holds: a row the
// copy has not seen is inserted with legacyId (the old _id), a copy that
// differs from its old row is written over (a field the old row lost is
// cleared), and prune deletes a copy whose old row is gone. The old table is
// the truth until the switch: nothing writes the plain tables before it, so
// a copy that differs is an edit the old code made. Run todos, then blocks,
// then timeNotes (a time note names a block, and both name a todo).
//
// REFERENCES are copied pointing at the plain row: todos.needs at todos,
// timeNotes.blockId at blocks, and a block's or time note's todoId at todos.
// A reference whose row has no copy yet is "unresolved": todoId keeps its
// dtsTodos id (the schema takes either until the switch narrows it), and a
// need or a blockId is left off until a later pass finds the copy. One that
// names a deleted row is "dangling" and left off. remapTodoRefs points the
// todoIds an earlier copy left as dtsTodos ids at todos. leftToRemap is the
// check: every count under `left` is 0 once the copy is whole and remapped.
//
// THE WAY BACK. unmapTodoRefs points every todoId back at its dtsTodos id,
// which the schema before this one requires. copyBack {table} is sync the
// other way, for after the switch, when the plain tables are the truth: a
// row born in a plain table is inserted into the old one and given that id as
// its legacyId, and a copy that differs is written over its old row. It never
// deletes: an old row with no copy is left, and a copy whose old row is gone
// is counted as orphaned.

type Direction = "forward" | "back";

/** Rows per page: a todo runs to ~5 KB and holds at most MAX_NEEDS (10)
 *  needs, two reads each, so a page stays far under a function's limits. */
const PAGE = 100;
const MAX_PAGE = 500;
const pageOf = (pageSize: number | undefined) => Math.min(Math.max(1, Math.floor(pageSize ?? PAGE)), MAX_PAGE);

/** The references a row of each table holds, and the table each names.
 *  `either`: the plain field takes a dtsTodos id as well until the switch. */
const REFS: Record<Core, Array<{ field: string; to: Core; either?: true }>> = {
  todos: [{ field: "needs", to: "todos" }],
  blocks: [{ field: "todoId", to: "todos", either: true }],
  timeNotes: [
    { field: "todoId", to: "todos", either: true },
    { field: "blockId", to: "blocks" },
  ],
};

/** A row's fields, less the system fields and legacyId. */
function payload(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (!key.startsWith("_") && key !== "legacyId") out[key] = value;
  return out;
}

/** Object keys in one order at every depth, so equal rows print alike. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key]);
  return out;
}

const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

type Miss = { miss: "unresolved" | "dangling" };

/** A reference moved across: forward, a dtsTodos/dtsBlocks id to its copy's
 *  id; back, a plain id to its row's legacyId. An id already on the far side
 *  stays as it is. */
async function moveRef(ctx: QueryCtx | MutationCtx, to: Core, id: string, direction: Direction): Promise<string | Miss> {
  if (direction === "forward") {
    const old = ctx.db.normalizeId(CORE[to], id);
    if (old === null) return id;
    if ((await ctx.db.get(old)) === null) return { miss: "dangling" };
    const copy = await copyOf(ctx, to, id);
    return copy === null ? { miss: "unresolved" } : copy._id;
  }
  const plain = ctx.db.normalizeId(to, id);
  if (plain === null) return id;
  const row = (await ctx.db.get(plain)) as Row | null;
  if (row === null) return { miss: "dangling" };
  return typeof row.legacyId === "string" ? row.legacyId : { miss: "unresolved" };
}

/** A row as the other side stores it: its fields with every reference moved. */
async function mirror(ctx: QueryCtx | MutationCtx, table: Core, row: Row, direction: Direction) {
  const fields = payload(row);
  let unresolved = 0;
  let dangling = 0;
  for (const { field, to, either } of REFS[table]) {
    const value = fields[field];
    if (value === undefined) continue;
    const moved: string[] = [];
    for (const id of (Array.isArray(value) ? value : [value]) as string[]) {
      const ref = await moveRef(ctx, to, id, direction);
      if (typeof ref === "string") moved.push(ref);
      else if (ref.miss === "dangling") dangling += 1;
      else {
        unresolved += 1;
        if (either && direction === "forward") moved.push(id);
      }
    }
    if (Array.isArray(value)) fields[field] = moved;
    else if (moved.length > 0) fields[field] = moved[0];
    else delete fields[field];
  }
  return { fields, unresolved, dangling };
}

/** One page of the copy, either way: forward reads the old table and writes
 *  the plain one, back the reverse. */
async function mirrorPage(
  ctx: MutationCtx,
  table: Core,
  direction: Direction,
  cursor: string | null,
  pageSize: number | undefined,
) {
  const source = direction === "forward" ? CORE[table] : table;
  const target = direction === "forward" ? table : CORE[table];
  const page = await ctx.db.query(source).order("asc").paginate({ cursor, numItems: pageOf(pageSize) });
  const done = { inserted: 0, patched: 0, unchanged: 0, orphaned: 0, unresolved: 0, dangling: 0 };
  for (const row of page.page as unknown as Row[]) {
    const { fields, unresolved, dangling } = await mirror(ctx, table, row, direction);
    done.unresolved += unresolved;
    done.dangling += dangling;
    let existing: Row | null;
    if (direction === "forward") existing = await copyOf(ctx, table, row._id);
    else if (typeof row.legacyId !== "string") existing = null;
    else {
      const old = ctx.db.normalizeId(CORE[table], row.legacyId);
      existing = old === null ? null : ((await ctx.db.get(old)) as Row | null);
      if (existing === null) {
        done.orphaned += 1;
        continue;
      }
    }
    if (existing === null) {
      if (direction === "forward") await ctx.db.insert(target, { ...fields, legacyId: row._id } as never);
      else await ctx.db.patch(row._id as Id<Core>, { legacyId: await ctx.db.insert(target, fields as never) });
      done.inserted += 1;
      continue;
    }
    const current = payload(existing);
    if (same(current, fields)) {
      done.unchanged += 1;
      continue;
    }
    for (const key of Object.keys(current)) if (!(key in fields)) fields[key] = undefined;
    await ctx.db.patch(existing._id as Id<Core>, fields as never);
    done.patched += 1;
  }
  return { ...done, isDone: page.isDone, continueCursor: page.continueCursor };
}

const PAGE_ARGS = {
  table: CORE_TABLE,
  cursor: v.union(v.string(), v.null()),
  pageSize: v.optional(v.number()),
};

/** One page of sync; `npx convex run` it with each answer's continueCursor
 *  until isDone, or run `sync`, which does that. */
export const syncPage = internalMutation({
  args: PAGE_ARGS,
  handler: async (ctx, { table, cursor, pageSize }) => await mirrorPage(ctx, table, "forward", cursor, pageSize),
});

/** One page of copyBack, paged as syncPage is. */
export const copyBackPage = internalMutation({
  args: PAGE_ARGS,
  handler: async (ctx, { table, cursor, pageSize }) => await mirrorPage(ctx, table, "back", cursor, pageSize),
});

/**
 * One page of the plain table: a copy whose old row is gone is deleted. An
 * EMPTY old table deletes nothing and says so: it reads as the table emptied
 * after its switch, not as every row deleted.
 */
export const prunePage = internalMutation({
  args: { table: CORE_TABLE, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    if ((await ctx.db.query(CORE[table]).first()) === null) {
      return { deleted: 0, skipped: `${CORE[table]} is empty; nothing pruned`, isDone: true, continueCursor: "" };
    }
    const page = await ctx.db.query(table).paginate({ cursor, numItems: PAGE });
    let deleted = 0;
    for (const row of page.page as unknown as Row[]) {
      if (typeof row.legacyId !== "string") continue;
      const old = ctx.db.normalizeId(CORE[table], row.legacyId);
      if (old !== null && (await ctx.db.get(old)) !== null) continue;
      await ctx.db.delete(row._id as Id<Core>);
      deleted += 1;
    }
    return { deleted, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * One page of the todoIds in `blocks` or `timeNotes`, moved: forward to the
 * todos copy (remapTodoRefs), back to the dtsTodos id (unmapTodoRefs). One
 * with no counterpart yet is counted and left.
 */
export const refsPage = internalMutation({
  args: {
    table: v.union(v.literal("blocks"), v.literal("timeNotes")),
    direction: v.union(v.literal("forward"), v.literal("back")),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { table, direction, cursor }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems: PAGE });
    let patched = 0;
    let unresolved = 0;
    for (const row of page.page) {
      if (row.todoId === undefined) continue;
      const ref = await moveRef(ctx, "todos", row.todoId, direction);
      if (typeof ref !== "string") unresolved += 1;
      else if (ref !== row.todoId) {
        await ctx.db.patch(row._id, { todoId: ref as Id<"todos"> | Id<"dtsTodos"> });
        patched += 1;
      }
    }
    return { patched, unresolved, isDone: page.isDone, continueCursor: page.continueCursor };
  },
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

type MirrorAnswer = Paged & Record<"inserted" | "patched" | "unchanged" | "orphaned" | "unresolved" | "dangling", number>;

/** Copy passes over a table: a second when the first left references
 *  unresolved (a todo's need on a todo later in the table). */
async function passes(step: (cursor: string | null) => Promise<MirrorAnswer>) {
  const first = await drain(step);
  return first.unresolved > 0 ? [first, await drain(step)] : [first];
}

/** The whole copy of one table into its plain table, then the prune. */
export const sync = internalAction({
  args: { table: CORE_TABLE, pageSize: v.optional(v.number()) },
  handler: async (ctx, { table, pageSize }) => {
    const copied = await passes(
      (cursor): Promise<MirrorAnswer> => ctx.runMutation(internal.jarvis.tables.syncPage, { table, cursor, pageSize }),
    );
    const pruned = await drain(
      (cursor): Promise<Paged & { deleted: number }> => ctx.runMutation(internal.jarvis.tables.prunePage, { table, cursor }),
    );
    return { table, passes: copied, pruned: pruned.deleted };
  },
});

/** The whole way back of one table: todos, then blocks, then timeNotes. */
export const copyBack = internalAction({
  args: { table: CORE_TABLE, pageSize: v.optional(v.number()) },
  handler: async (ctx, { table, pageSize }) => ({
    table,
    passes: await passes(
      (cursor): Promise<MirrorAnswer> => ctx.runMutation(internal.jarvis.tables.copyBackPage, { table, cursor, pageSize }),
    ),
  }),
});

async function moveTodoRefs(ctx: ActionCtx, direction: Direction) {
  const out: Record<string, Record<string, number>> = {};
  for (const table of ["blocks", "timeNotes"] as const) {
    out[table] = await drain(
      (cursor): Promise<Paged & { patched: number; unresolved: number }> =>
        ctx.runMutation(internal.jarvis.tables.refsPage, { table, direction, cursor }),
    );
  }
  return out;
}

/** Every todoId in blocks and timeNotes that names a copied dtsTodos row,
 *  pointed at its todos copy. Run after sync todos, blocks, timeNotes. */
export const remapTodoRefs = internalAction({ args: {}, handler: async (ctx) => await moveTodoRefs(ctx, "forward") });

/** remapTodoRefs undone: every todoId naming a todos row, pointed back at its
 *  dtsTodos id (after copyBack todos, for a row born in todos). */
export const unmapTodoRefs = internalAction({ args: {}, handler: async (ctx) => await moveTodoRefs(ctx, "back") });

/**
 * One page of the check. side "old": the old table's rows with no copy, and
 * those whose copy differs from what sync would write now. side "plain": the
 * copies whose old row is gone, each reference field's ids still naming an
 * old table, and (`remapped`) the todoIds naming todos, which the way back
 * must bring to 0 before the schema before this one deploys again.
 */
export const leftPage = internalQuery({
  args: { table: CORE_TABLE, side: v.union(v.literal("old"), v.literal("plain")), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, side, cursor }) => {
    const counts: Record<string, number> = {};
    const add = (key: string) => (counts[key] = (counts[key] ?? 0) + 1);
    const page = await ctx.db.query(side === "old" ? CORE[table] : table).paginate({ cursor, numItems: PAGE });
    for (const row of page.page as unknown as Row[]) {
      if (side === "old") {
        const copy = await copyOf(ctx, table, row._id);
        if (copy === null) add("notCopied");
        else if (!same(payload(copy), (await mirror(ctx, table, row, "forward")).fields)) add("stale");
        continue;
      }
      if (typeof row.legacyId === "string") {
        const old = ctx.db.normalizeId(CORE[table], row.legacyId);
        if (old === null || (await ctx.db.get(old)) === null) add("orphaned");
      }
      for (const { field, to, either } of REFS[table]) {
        const value = row[field];
        for (const id of (Array.isArray(value) ? value : value === undefined ? [] : [value]) as string[]) {
          if (ctx.db.normalizeId(CORE[to], id) !== null) add(field);
          else if (either && ctx.db.normalizeId(to, id) !== null) add("remapped");
        }
      }
    }
    return { ...counts, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * What is left before the switch, per table: notCopied, stale, orphaned and,
 * per reference field, the ids still naming an old table. `zero` is true when
 * every one is 0. `remapped` counts the todoIds naming todos: the way back's
 * check, 0 once unmapTodoRefs has run.
 */
export const leftToRemap = internalAction({
  args: {},
  handler: async (ctx) => {
    const left: Record<string, Record<string, number>> = {};
    const remapped: Record<string, number> = {};
    for (const table of ["todos", "blocks", "timeNotes"] as const) {
      const counts: Record<string, number> = { notCopied: 0, stale: 0, orphaned: 0 };
      for (const { field } of REFS[table]) counts[field] = 0;
      for (const side of ["old", "plain"] as const) {
        const sums = await drain(
          (cursor): Promise<Paged> =>
            ctx.runQuery(internal.jarvis.tables.leftPage, { table, side, cursor }),
        );
        for (const [key, value] of Object.entries(sums)) {
          if (key === "remapped") remapped[table] = value;
          else counts[key] += value;
        }
      }
      left[table] = counts;
    }
    const zero = Object.values(left).every((counts) => Object.values(counts).every((n) => n === 0));
    return { zero, left, remapped: { blocks: remapped.blocks ?? 0, timeNotes: remapped.timeNotes ?? 0 } };
  },
});
