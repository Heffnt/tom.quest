// tables.ts — rulings under their plain name (2026-09-26).
//
// Convex has no table rename, so the old dtsRulings rows were COPIED into
// `rulings` (convex/schema.ts), every field kept, and the old row's _id kept
// as `legacyId` so an id cited outside the record (the evidence, a Slack
// thread, a box file, WikiTom's tts/snapshot) still finds its row (resolveId
// below). The copy never deletes: dtsRulings stays whole until the counts
// are confirmed, then a later commit empties it and drops it from the schema.
//
// RULINGS ALONE. The rulings switch is the one this stack makes: every
// ruling reader and writer uses `rulings`. The todos, blocks and timeNotes
// switch lands as its own pull request, with a faithful sync (one that
// carries edits and deletions, which an upsert copy cannot); their
// plain-named tables stay declared in the schema until then, and so do
// calendar, repeats and vocabulary.
//
// THE ORDER, as it ran: (1) deploy the schema with both tables; (2) `copy`;
// (3) deploy the commit that points every reader and writer at `rulings`;
// (4) `copy` again, which brings over what the old code wrote between (2)
// and (3) and touches nothing written since; (5) `counts`. The copy is an
// upsert on legacyId: a copied row is patched only when the old row is newer
// by its own clock (appliedAt, else ruledAt), so a change made through the
// new code is never overwritten by the old row.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/** A ruling row's own clock: the copy patches a copied row only when the old
 *  row is newer by it. */
const version = (row: { appliedAt?: number; ruledAt?: number }) => Number(row.appliedAt ?? row.ruledAt ?? 0);

const DEFAULT_PAGE = 100;
const MAX_PAGE = 500;

/** The ruling copied from an old dtsRulings row, found by the old _id. */
async function copyOf(ctx: QueryCtx | MutationCtx, legacyId: string): Promise<Doc<"rulings"> | null> {
  return await ctx.db
    .query("rulings")
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
  const copied = await copyOf(ctx, id);
  return copied === null ? null : copied._id;
}

/**
 * Copy one page of dtsRulings into `rulings`, and schedule the next page
 * until it is done, then the label remap. Re-running is safe: see the
 * header.
 */
// RAN IN PRODUCTION (2026-09-26 09:01Z and 09:04Z, remap done); every ruling since is written to `rulings`, so merging needs no copy.
export const copy = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    /** false runs one page only (tests); the default chains to the end. */
    chain: v.optional(v.boolean()),
  },
  handler: async (ctx, { cursor, pageSize, chain }) => {
    const numItems = Math.min(Math.max(1, Math.floor(pageSize ?? DEFAULT_PAGE)), MAX_PAGE);
    const page = await ctx.db.query("dtsRulings").order("asc").paginate({ cursor: cursor ?? null, numItems });
    let inserted = 0;
    let patched = 0;
    let unchanged = 0;
    for (const old of page.page) {
      const { _id, _creationTime, ...fields } = old;
      const row = { ...fields, legacyId: String(_id) };
      const existing = await copyOf(ctx, _id);
      if (existing === null) {
        await ctx.db.insert("rulings", row as never);
        inserted += 1;
      } else if (version(old) > version(existing)) {
        await ctx.db.patch(existing._id, row as never);
        patched += 1;
      } else {
        unchanged += 1;
      }
    }
    if (chain !== false) {
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.copy, { cursor: page.continueCursor, pageSize: numItems });
      } else {
        await ctx.scheduler.runAfter(0, internal.jarvis.tables.remapRulingRefs, {});
      }
    }
    return { inserted, patched, unchanged, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

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
