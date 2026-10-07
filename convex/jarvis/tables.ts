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
// TODOS, BLOCKS AND TIME NOTES moved the same way, in three steps: the copy
// and the dual write (step A: every writer wrote the old row, then `follow`
// copied it into the plain one), the readers (step B), and the writers (step
// C). Blocks and time notes, both tables of each, then went with the Jarvis
// calendar (design section 13.2, 2026-10-07); todos is the one core table
// left here.
//
// AN ID IN EITHER FORM. An id reaches the record from outside as the plain
// row's, or as the old one's (an old link, a Slack thread, a box file, and a
// reference a ruling, event, session or run stored before step C).
// `eitherId` is the argument validator that takes both; `resolveId` answers
// the plain row, which every reader reads and every writer writes.
//
// STEP C, THE OLD WRITES STOP. Every writer inserts, patches and deletes the
// plain row directly; nothing writes dtsTodos, dtsBlocks or dtsTimeNotes, and
// they stay as read-only history until a later pull request drops them. A new
// row exists only in the plain table, with no legacyId, and a creating door
// answers its plain id. Everything that stores a reference to a todo, block
// or time note stores the plain id (a block's and a time note's todoId and
// blockId, rulings.todoId, the events' todoId, a session's, a run's, a Slack
// thread's todo subject). Those fields still take either id (existing rows
// hold old ones; the schema was widened, never narrowed), and every reader of
// a stored reference reads both forms as the one todo (todoIdForms,
// todoEvents, todoRulings; withPlainTodoIds before liveRulings).
//
// It landed as a stack, each pull request safe to deploy alone in order: the
// readers of both forms and copyBack; then the writers, a group at a time
// (blocks and time notes; every other writer of a todo but two; the repeats
// generator, the migrations and the last stored references), each writing
// its old row back so that a writer not yet moved, which wrote the old row
// and `follow`ed, found it current and leftToRemap stayed at zero; then
// `follow`, `oldId` and the copy went; last, the write back stopped.
//
// THE COPY IS OVER, so `sync`, `remapTodoRefs` and their pages are deleted,
// not left to refuse: each copied the old tables over the plain ones, which
// after step C would overwrite every write since with a stale old row.
// `unstamp` and `refsPage` were step A's way back, which no longer applies
// once the readers read the plain tables. `leftToRemap` stays, read-only
// (below).
//
// THE WAY BACK from step C. The plain tables are the truth after it; the old
// tables are frozen at the last write back. Reverting only the last pull
// request is safe as it is: its predecessor's writers write each row's old
// row back at their next write of it (inserting a missing one, patching a
// stale one), and nothing it runs reads an old row; `copyBack` (below) brings
// every old row current at once, after which leftToRemap reads zero. Going
// back further, to the pull request whose migrations and repeats generator
// still wrote an old row and `follow`ed it (or anything before), needs
// copyBack first, since `follow` would copy a stale old row over a newer
// plain one and a writer's oldId would find no old row for a todo created
// since: run copyBack, confirm leftToRemap reads zero, deploy, and run it
// again right before the deploy if anything wrote in between. Never go back
// past step C's first pull request: step B's schema refuses the plain ids
// stored since.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** Each plain-named core table and the table its rows come from. */
const CORE = { todos: "dtsTodos" } as const;
type Core = keyof typeof CORE;
const CORE_TABLE = v.literal("todos");

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

/** Each table under its plain name and the table its rows were copied from. */
const OLD = { rulings: "dtsRulings", ...CORE } as const;
type Plain = keyof typeof OLD;

/** A core id as a function argument takes it from outside the record: the
 *  plain row's id, or the id its row had in the old table (an old link, a
 *  Slack thread, a box file, a stored reference). resolveId reads it. */
export const eitherId = {
  todos: v.union(v.id("todos"), v.id("dtsTodos")),
} as const;

/**
 * An id as anything outside the record spells it: an id of the plain table,
 * or the id its row had in the old one (the box's files, a Slack thread, a
 * label's ref, the evidence, a reference another table stores). The one
 * reader of legacyId; null when neither names a row.
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
  if (ctx.db.normalizeId(OLD[table], id) === null) return null;
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
 * The plain todo an id in either form names, in ONE document read: the row
 * itself for a plain id, the copy found on by_legacy for an old one. A reader
 * that counts its bytes (convex/readBudget.ts) uses this, because resolveId
 * and then get read the same row twice.
 */
export async function readTodo(ctx: QueryCtx | MutationCtx, id: string): Promise<Doc<"todos"> | null> {
  const direct = ctx.db.normalizeId("todos", id);
  if (direct !== null) return await ctx.db.get(direct);
  if (ctx.db.normalizeId("dtsTodos", id) === null) return null;
  return await ctx.db
    .query("todos")
    .withIndex("by_legacy", (q) => q.eq("legacyId", id))
    .first();
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
export async function todoIdForms(
  ctx: QueryCtx | MutationCtx,
  id: string,
): Promise<Array<Id<"todos"> | Id<"dtsTodos">>> {
  const plain = await resolveId(ctx, "todos", id);
  const row = plain === null ? null : await ctx.db.get(plain);
  if (row === null) return [];
  const old = row.legacyId === undefined ? null : ctx.db.normalizeId("dtsTodos", row.legacyId);
  return old === null ? [row._id] : [row._id, old];
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

// ── todos: the check ──────────────────────────────────────────────────────
//
// leftToRemap compares each old table with its plain one. Before step C it
// was the copy's check, and while step C's writers wrote their old rows back
// it stayed at zero. Since the old tables are frozen it reads as what the way
// back would carry: `stale` counts the plain rows changed since, `orphaned`
// the plain rows created since (no legacyId) and `notCopied` the old rows
// whose plain row was deleted since; `version` (an old
// row whose stamp is not its fingerprint) counts a write to an old table,
// which nothing makes any more, and each reference field counts the plain
// rows still naming an old id, which no writer stores any more. copyBack
// brings every count to 0.
//
// REFERENCES in the comparison point at the plain row: todos.needs at todos.
// A reference whose row has no copy is "unresolved", one that names a
// deleted row "dangling".

type Direction = "forward" | "back";

/** Rows per page: a todo runs to ~5 KB and holds at most MAX_NEEDS (10)
 *  needs, two reads each, so a page stays far under a function's limits. */
const PAGE = 100;

/** The references a row of each table holds, and the table each names.
 *  `either`: the plain field takes a dtsTodos id as well until the switch. */
const REFS: Record<Core, Array<{ field: string; to: Core; either?: true }>> = {
  todos: [{ field: "needs", to: "todos" }],
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

/** A reference moved across: forward, a dtsTodos id to its copy's
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

/** An old row as its plain table stores it: its fields, references moved.
 *  Back (copyBack): a plain row as its old table stores it; an unresolved
 *  reference is left off, since no old field takes a plain id. */
async function mirror(ctx: QueryCtx | MutationCtx, table: Core, row: Row, direction: Direction = "forward") {
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

/**
 * An old row's version: its fields less its own stamp, in canonical JSON,
 * through FNV-1a in two 32-bit lanes. Change detection, not security; a
 * clock would miss a write that leaves updatedAt alone (a Slack reply ts),
 * and a block has none.
 */
function versionOf(row: Row): string {
  const fields = payload(row);
  delete fields.legacyVersion;
  const text = JSON.stringify(canonical(fields));
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

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

/**
 * One page of the check. side "old": the old table's rows with no copy,
 * those whose copy differs from their old row (references moved), and (`version`)
 * those whose stamp is not their fingerprint or not their copy's. side
 * "plain": the rows no old row holds (gone, or never had one), and each
 * reference field's ids still naming an old table.
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
        else if (!same(payload(copy), (await mirror(ctx, table, row)).fields)) add("stale");
        if (row.legacyVersion !== versionOf(row) || (copy !== null && copy.legacyVersion !== row.legacyVersion)) add("version");
        continue;
      }
      if (typeof row.legacyId !== "string") add("orphaned");
      else {
        const old = ctx.db.normalizeId(CORE[table], row.legacyId);
        if (old === null || (await ctx.db.get(old)) === null) add("orphaned");
      }
      for (const { field, to } of REFS[table]) {
        const value = row[field];
        for (const id of (Array.isArray(value) ? value : value === undefined ? [] : [value]) as string[]) {
          if (ctx.db.normalizeId(CORE[to], id) !== null) add(field);
        }
      }
    }
    return { ...counts, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * How each old table differs from its plain one, per table: notCopied, stale,
 * version, orphaned and, per reference field, the ids still naming an old
 * table (the check's section above says what each counts since step C).
 * `zero` is true when every one is 0: the old tables hold what the plain ones
 * do, and the way back may deploy.
 */
export const leftToRemap = internalAction({
  args: {},
  handler: async (ctx) => {
    const left: Record<string, Record<string, number>> = {};
    for (const table of ["todos"] as const) {
      const counts: Record<string, number> = { notCopied: 0, stale: 0, version: 0, orphaned: 0 };
      for (const { field } of REFS[table]) counts[field] = 0;
      for (const side of ["old", "plain"] as const) {
        const sums = await drain(
          (cursor): Promise<Paged> => ctx.runQuery(internal.jarvis.tables.leftPage, { table, side, cursor }),
        );
        for (const [key, value] of Object.entries(sums)) counts[key] += value;
      }
      left[table] = counts;
    }
    const zero = Object.values(left).every((counts) => Object.values(counts).every((n) => n === 0));
    return { zero, left };
  },
});

// ── copyBack: the way back from step C ──────────────────────────────────────
//
// Step C's writers write only the plain tables, so after it the old tables go
// stale, and the code before it (whose writers wrote an old row, then
// `follow`ed it) would find no old row for a todo created since and would
// copy a stale old row over a newer plain one (the header says when a revert
// needs it). copyBack makes each old table hold what its plain table holds,
// so that code can deploy again: a plain row with no old row gets one (and
// its legacyId), an old row that differs is written over (a field the plain
// row lost is cleared), both carry the same stamp, and an old row whose
// plain row is gone is deleted with it. References move back to old ids.
// Run todos (twice when the first pass left a need unresolved: a need on a
// todo later in the table); leftToRemap then reads zero.

/** One plain row copied into its old table. */
async function copyBackRow(ctx: MutationCtx, table: Core, row: Row) {
  const { fields, unresolved, dangling } = await mirror(ctx, table, row, "back");
  delete fields.legacyVersion;
  const version = versionOf({ ...fields, _id: row._id });
  fields.legacyVersion = version;
  const oldRef = typeof row.legacyId === "string" ? ctx.db.normalizeId(CORE[table], row.legacyId) : null;
  const old = oldRef === null ? null : ((await ctx.db.get(oldRef)) as Row | null);
  let outcome: "inserted" | "patched" | "unchanged" = "unchanged";
  if (old === null) {
    const id = await ctx.db.insert(CORE[table], fields as never);
    await ctx.db.patch(row._id as Id<Core>, { legacyId: id, legacyVersion: version } as never);
    return { outcome: "inserted" as const, unresolved, dangling };
  }
  if (!same(payload(old), fields)) {
    for (const key of Object.keys(old)) if (!key.startsWith("_") && !(key in fields)) fields[key] = undefined;
    await ctx.db.patch(old._id as Id<(typeof CORE)[Core]>, fields as never);
    outcome = "patched";
  }
  if (row.legacyVersion !== version) await ctx.db.patch(row._id as Id<Core>, { legacyVersion: version } as never);
  return { outcome, unresolved, dangling };
}

/** One page of copyBack over a plain table. */
export const copyBackPage = internalMutation({
  args: { table: CORE_TABLE, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db.query(table).order("asc").paginate({ cursor, numItems: PAGE });
    const done = { inserted: 0, patched: 0, unchanged: 0, unresolved: 0, dangling: 0 };
    for (const row of page.page as unknown as Row[]) {
      const { outcome, unresolved, dangling } = await copyBackRow(ctx, table, row);
      done[outcome] += 1;
      done.unresolved += unresolved;
      done.dangling += dangling;
    }
    return { ...done, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** One page of an old table: a row whose plain row is gone is deleted. */
export const copyBackPrunePage = internalMutation({
  args: { table: CORE_TABLE, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db.query(CORE[table]).paginate({ cursor, numItems: PAGE });
    let deleted = 0;
    for (const row of page.page as unknown as Row[]) {
      if ((await copyOf(ctx, table, row._id)) !== null) continue;
      await ctx.db.delete(row._id as Id<(typeof CORE)[Core]>);
      deleted += 1;
    }
    return { deleted, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** copyBack over todos, then the prune. */
export const copyBack = internalAction({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, Record<string, number>> = {};
    for (const table of ["todos"] as const) {
      const pass = () =>
        drain((cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.copyBackPage, { table, cursor }));
      const first = await pass();
      out[table] = first.unresolved > 0 ? await pass() : first;
    }
    for (const table of ["todos"] as const) {
      const pruned = await drain(
        (cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.copyBackPrunePage, { table, cursor }),
      );
      out[table].pruned = pruned.deleted ?? 0;
    }
    return out;
  },
});
