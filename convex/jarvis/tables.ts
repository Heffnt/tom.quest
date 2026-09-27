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
// RULINGS ALONE. The todos, blocks and timeNotes switch lands as its own
// pull request, with its own faithful sync (one that carries edits and
// deletions); their plain-named tables stay declared in the schema until
// then, and so do calendar, repeats and vocabulary.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

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
