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
import type { Doc, Id, TableNames } from "../_generated/dataModel";

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

/** The row's copy in `table`, found by the old _id it was copied from. */
async function copyOf(
  ctx: QueryCtx | MutationCtx,
  table: NewTable,
  legacyId: string,
): Promise<Record<string, unknown> & { _id: string } | null> {
  // Every renamed table declares by_legacy; the cast is the one place the
  // seven tables are spoken of as one.
  return (await (ctx.db.query(table) as any)
    .withIndex("by_legacy", (q: any) => q.eq("legacyId", legacyId))
    .first()) as (Record<string, unknown> & { _id: string }) | null;
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

/** The old row as the new table stores it: every field, references mapped,
 *  needs left to the needs pass. */
async function fieldsFor(
  ctx: MutationCtx,
  table: NewTable,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
        await ctx.db.insert(table, fields as any);
        inserted += 1;
      } else if (VERSION[table](old) > VERSION[table](existing)) {
        await ctx.db.patch(existing._id as Id<NewTable>, fields as any);
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
