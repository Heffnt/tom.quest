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
// TODOS, BLOCKS AND TIME NOTES move the same way: the copy machinery below
// the rulings count, then the dual write (every writer of the old tables
// calls `follow`), then step B, the readers. calendar, repeats and
// vocabulary stay declared and untouched.
//
// STEP B, THE READERS. An id reaches the record from outside in either form:
// the plain row's, or the old one's (an old link, a Slack thread, a box file,
// and every reference rulings, claudeSessions, runs and dtsEvents store,
// which keep the ids they hold). `eitherId` is the argument validator that
// takes both; `resolveId` answers the plain row a reader reads, `oldId` the
// old row a writer writes, since the write path does not move in this step.
//
// STEP C, THE OLD WRITES STOP, lands as a stack. First the readers: a stored
// reference to a todo (rulings.todoId, dtsEvents.todoId, claudeSessions.todoId,
// runs.todoId, a Slack thread's todo subject) takes either id, and every
// reader of a stored reference reads both forms as the one todo (todoIdForms,
// todoEvents, todoRulings; withPlainTodoIds before liveRulings); copyBack
// (below) arrives with them, the way back from what follows. Then the writers
// move to the plain tables a group at a time (blocks and time notes, then
// every writer of a todo but the repeats generator and the migrations, whose
// rows are their own; tts.logEvent stores the plain id from then on),
// each writing its old row back (`back`, `backDelete`), so a writer not yet
// moved, which writes the old row and `follow`s, finds it current, and
// leftToRemap stays at zero throughout. The last pull request of the stack
// takes `back`, `follow` and the copy out.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

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

/** Each table under its plain name and the table its rows were copied from. */
const OLD = { rulings: "dtsRulings", ...CORE } as const;
type Plain = keyof typeof OLD;

/** A core id as a function argument takes it from outside the record: the
 *  plain row's id, or the id its row had in the old table (an old link, a
 *  Slack thread, a box file, a stored reference). resolveId or oldId reads it. */
export const eitherId = {
  todos: v.union(v.id("todos"), v.id("dtsTodos")),
  blocks: v.union(v.id("blocks"), v.id("dtsBlocks")),
  timeNotes: v.union(v.id("timeNotes"), v.id("dtsTimeNotes")),
} as const;

/**
 * An id as anything outside the record spells it: an id of the plain table,
 * or the id its row had in the old one (the box's files, a Slack thread, a
 * label's ref, the evidence, a reference another table stores). The one
 * reader of legacyId; null when neither names a row.
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
 * The old row an id in either form names: what a writer writes, and what
 * rulings, sessions, runs and events store, until the write path moves. null
 * when neither names a row.
 */
export async function oldId<T extends Core>(
  ctx: QueryCtx | MutationCtx,
  table: T,
  id: string,
): Promise<Id<(typeof CORE)[T]> | null> {
  const plain = ctx.db.normalizeId(table, id);
  const row = plain === null ? null : ((await ctx.db.get(plain)) as Row | null);
  const old = ctx.db.normalizeId(CORE[table], row === null ? id : String(row.legacyId));
  return old !== null && (await ctx.db.get(old)) !== null ? old : null;
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
  const seen = new Map<string, Id<"todos">>();
  const out: Array<Omit<R, "todoId"> & { todoId?: Id<"todos"> }> = [];
  for (const row of rows) {
    if (row.todoId === undefined) {
      out.push(row as Omit<R, "todoId">);
      continue;
    }
    let plain = seen.get(row.todoId);
    if (plain === undefined) {
      // A reference naming no row (none is deleted) is handed out as stored.
      plain = (await resolveId(ctx, "todos", row.todoId)) ?? (row.todoId as Id<"todos">);
      seen.set(row.todoId, plain);
    }
    out.push({ ...row, todoId: plain });
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

// ── todos, blocks and timeNotes: the copy, the remap, the check ─────────────
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
// THE DUAL WRITE. Every writer of dtsTodos, dtsBlocks and dtsTimeNotes calls
// `follow` right after its write, so the plain row is written in the same
// transaction. Each old row carries legacyVersion, a fingerprint of its other
// fields, and its copy carries the same stamp: leftToRemap's `version` counts
// an old row whose stamp is not its fingerprint (a write that went around
// `follow`) or whose copy's stamp differs. sync stays the catch-up, and
// stamps as it copies. Step B moves the readers (the header above).
//
// THE WAY BACK before the switch: nothing reads the plain tables, so it is the
// previous head, whose schema has no legacyVersion and whose todoIds name
// dtsTodos only (a deploy checks every stored row). Stop nothing; run, in
// order: `unstamp` (legacyVersion off dtsTodos, dtsBlocks, dtsTimeNotes,
// todos, blocks, timeNotes); refsPage {direction: "back"} over blocks, then
// timeNotes, each page's continueCursor until isDone; then deploy the
// previous head. A write in between stamps again and the deploy says so:
// run the two again right before it.

type Direction = "forward" | "back";

/** Rows per page: a todo runs to ~5 KB and holds at most MAX_NEEDS (10)
 *  needs, two reads each, so a page stays far under a function's limits. */
const PAGE = 100;

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

/** One old row, stamped with its version and copied into its plain table:
 *  inserted with legacyId, or written over where it differs (a field the
 *  old row lost is cleared). */
async function syncRow(ctx: MutationCtx, table: Core, row: Row) {
  const version = versionOf(row);
  let old = row;
  if (row.legacyVersion !== version) {
    await ctx.db.patch(row._id as Id<(typeof CORE)[Core]>, { legacyVersion: version });
    old = { ...row, legacyVersion: version };
  }
  const { fields, unresolved, dangling } = await mirror(ctx, table, old);
  const existing = await copyOf(ctx, table, old._id);
  let outcome: "inserted" | "patched" | "unchanged" = "unchanged";
  if (existing === null) {
    await ctx.db.insert(table, { ...fields, legacyId: old._id } as never);
    outcome = "inserted";
  } else if (!same(payload(existing), fields)) {
    for (const key of Object.keys(existing)) if (!key.startsWith("_") && key !== "legacyId" && !(key in fields)) fields[key] = undefined;
    await ctx.db.patch(existing._id as Id<Core>, fields as never);
    outcome = "patched";
  }
  return { outcome, unresolved, dangling };
}

/**
 * The dual write: every writer of an old core table calls this right after
 * its write, with the row's id. The old row is stamped and copied as sync
 * copies it; a deleted old row takes its copy with it, and a deleted block's
 * copy is taken off the plain time notes that named it (their old notes now
 * name a block that is gone, which the copy leaves off).
 */
export async function follow(ctx: MutationCtx, table: Core, id: string): Promise<void> {
  const oldId = ctx.db.normalizeId(CORE[table], id);
  const old = oldId === null ? null : ((await ctx.db.get(oldId)) as Row | null);
  if (old !== null) {
    await syncRow(ctx, table, old);
    return;
  }
  const copy = await copyOf(ctx, table, id);
  if (copy === null) return;
  if (table === "blocks") await clearBlock(ctx, copy._id as Id<"blocks">);
  await ctx.db.delete(copy._id as Id<Core>);
}

/** One page of the plain time notes naming a deleted block's copy, taken off
 *  it; the rest go to clearBlockPage, which runs until none is left. Each
 *  patched note leaves the by_block range, so every page reads from its
 *  start. Until then leftToRemap counts each note still naming it as stale. */
export async function clearBlock(ctx: MutationCtx, blockId: Id<"blocks">) {
  const notes = await ctx.db.query("timeNotes").withIndex("by_block", (q) => q.eq("blockId", blockId)).take(PAGE + 1);
  for (const note of notes.slice(0, PAGE)) await ctx.db.patch(note._id, { blockId: undefined });
  if (notes.length > PAGE) await ctx.scheduler.runAfter(0, internal.jarvis.tables.clearBlockPage, { blockId });
}

export const clearBlockPage = internalMutation({
  args: { blockId: v.id("blocks") },
  handler: async (ctx, { blockId }) => await clearBlock(ctx, blockId),
});

/** One page of the old table, copied into the plain one. */
async function syncOnePage(ctx: MutationCtx, table: Core, cursor: string | null) {
  const page = await ctx.db.query(CORE[table]).order("asc").paginate({ cursor, numItems: PAGE });
  const done = { inserted: 0, patched: 0, unchanged: 0, unresolved: 0, dangling: 0 };
  for (const row of page.page as unknown as Row[]) {
    const { outcome, unresolved, dangling } = await syncRow(ctx, table, row);
    done[outcome] += 1;
    done.unresolved += unresolved;
    done.dangling += dangling;
  }
  return { ...done, isDone: page.isDone, continueCursor: page.continueCursor };
}

/** One page of sync; `npx convex run` it with each answer's continueCursor
 *  until isDone, or run `sync`, which does that. */
export const syncPage = internalMutation({
  args: { table: CORE_TABLE, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => await syncOnePage(ctx, table, cursor),
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

const STAMPED = ["dtsTodos", "dtsBlocks", "dtsTimeNotes", "todos", "blocks", "timeNotes"] as const;

/** One page of a table with legacyVersion taken off each row: the way back
 *  before the switch, whose schema has no such field. */
export const unstampPage = internalMutation({
  args: { table: v.union(...STAMPED.map((table) => v.literal(table))), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }) => {
    const page = await ctx.db.query(table).paginate({ cursor, numItems: PAGE });
    let unstamped = 0;
    for (const row of page.page) {
      if (row.legacyVersion === undefined) continue;
      await ctx.db.patch(row._id, { legacyVersion: undefined });
      unstamped += 1;
    }
    return { unstamped, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/**
 * One page of the todoIds in `blocks` or `timeNotes`, moved: forward to the
 * todos copy (what remapTodoRefs runs), back to the dtsTodos id (this pull
 * request's way back, run by hand before the previous head deploys). One
 * with no counterpart is counted and left.
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

/** The whole copy of one table into its plain table, then the prune. A second
 *  pass runs when the first left references unresolved (a todo's need on a
 *  todo later in the table). */
export const sync = internalAction({
  args: { table: CORE_TABLE },
  handler: async (ctx, { table }) => {
    const pass = () =>
      drain((cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.syncPage, { table, cursor }));
    const first = await pass();
    const passes = first.unresolved > 0 ? [first, await pass()] : [first];
    const pruned = await drain(
      (cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.prunePage, { table, cursor }),
    );
    return { table, passes, pruned: pruned.deleted ?? 0 };
  },
});

/** Every todoId in blocks and timeNotes that names a copied dtsTodos row,
 *  pointed at its todos copy. Run after sync todos, blocks, timeNotes. */
export const remapTodoRefs = internalAction({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, Record<string, number>> = {};
    for (const table of ["blocks", "timeNotes"] as const) {
      out[table] = await drain(
        (cursor): Promise<Paged> =>
          ctx.runMutation(internal.jarvis.tables.refsPage, { table, direction: "forward", cursor }),
      );
    }
    return out;
  },
});

/** unstampPage over all six tables, every page. */
export const unstamp = internalAction({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, number> = {};
    for (const table of STAMPED) {
      const sums = await drain(
        (cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.unstampPage, { table, cursor }),
      );
      out[table] = sums.unstamped ?? 0;
    }
    return out;
  },
});

/**
 * One page of the check. side "old": the old table's rows with no copy,
 * those whose copy differs from what sync would write now, and (`version`)
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
 * What is left before the switch, per table: notCopied, stale, version, orphaned and,
 * per reference field, the ids still naming an old table. `zero` is true when
 * every one is 0.
 */
export const leftToRemap = internalAction({
  args: {},
  handler: async (ctx) => {
    const left: Record<string, Record<string, number>> = {};
    for (const table of ["todos", "blocks", "timeNotes"] as const) {
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
// stale, and the code before it (whose writers write an old row, then
// `follow`) would find no old row for a todo created since and would copy a
// stale old row over a newer plain one. copyBack makes each old table hold
// what its plain table holds, so that code can deploy again: a plain row with
// no old row gets one (and its legacyId), an old row that differs is written
// over (a field the plain row lost is cleared), both carry the same stamp, and
// an old row whose plain row is gone (a block or time note deleted since) is
// deleted with it. References move back to old ids. Run todos (twice when the
// first pass left a need unresolved: a need on a todo later in the table),
// then blocks, then timeNotes; leftToRemap then reads zero.

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

/**
 * The write back, while step C moves the writers: a writer moved to the plain
 * tables calls this right after its write, with the plain row's id, so its
 * old row holds the same (stamped, as copyBack stamps it) and a writer not
 * yet moved, which writes the old row and `follow`s, finds it current. Every
 * plain row it writes carries a legacyId from then on. The last step C pull
 * request takes it out with `follow`.
 */
export async function back(ctx: MutationCtx, table: Core, id: string): Promise<void> {
  const row = (await ctx.db.get(id as Id<Core>)) as Row | null;
  if (row !== null) await copyBackRow(ctx, table, row);
}

/** A deleted plain row's old row, deleted with it (a moved writer's delete). */
export async function backDelete(ctx: MutationCtx, table: Core, row: { legacyId?: string }): Promise<void> {
  const old = typeof row.legacyId === "string" ? ctx.db.normalizeId(CORE[table], row.legacyId) : null;
  if (old !== null && (await ctx.db.get(old)) !== null) await ctx.db.delete(old);
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

/** copyBack over all three tables, in order, then the prune of each. */
export const copyBack = internalAction({
  args: {},
  handler: async (ctx) => {
    const out: Record<string, Record<string, number>> = {};
    for (const table of ["todos", "blocks", "timeNotes"] as const) {
      const pass = () =>
        drain((cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.copyBackPage, { table, cursor }));
      const first = await pass();
      out[table] = first.unresolved > 0 ? await pass() : first;
    }
    for (const table of ["timeNotes", "blocks", "todos"] as const) {
      const pruned = await drain(
        (cursor): Promise<Paged> => ctx.runMutation(internal.jarvis.tables.copyBackPrunePage, { table, cursor }),
      );
      out[table].pruned = pruned.deleted ?? 0;
    }
    return out;
  },
});
