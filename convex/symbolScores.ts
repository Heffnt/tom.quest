import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireViewerId } from "./authRoles";

// The endless symbol game scores a HIT COUNT. `hits` is the field; the old
// `timeMs`/`createdAt` pair survives only in rows written before the rename and
// only until `backfillHits` runs. See the symbolScores comment in schema.ts.

export const topScores = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const scores = await ctx.db
      .query("symbolScores")
      .withIndex("by_hits")
      .order("desc")
      .take(limit ?? 10);
    return scores.map((score) => ({
      id: score._id,
      username: score.username,
      // The `?? score.timeMs` fallback is load-bearing only between the deploy
      // of this file and the first backfill run: un-backfilled rows have no
      // `hits`, so they carry their count in `timeMs` and sort last under
      // by_hits. Delete the fallback with the fields, not before.
      hits: score.hits ?? score.timeMs ?? 0,
    }));
  },
});

export const submitScore = mutation({
  args: { username: v.string(), hits: v.number() },
  handler: async (ctx, { username, hits }) => {
    const userId = await requireViewerId(ctx);
    return await ctx.db.insert("symbolScores", { userId, username, hits });
  },
});

// One-shot rewrite of the stored rows into the post-rename shape: copy the hit
// count out of `timeMs` into `hits` and clear both dead fields. Idempotent — a
// second run finds nothing to rewrite and returns rewritten: 0 — because a cron
// calls it every hour until the narrow step lands, which is what makes the
// rename need no human to run anything between the two deploys.
//
// A full scan is correct here and nowhere else: this table is the symbol-game
// leaderboard, which has three rows in production and grows by one per win.
export const backfillHits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("symbolScores").collect();
    let rewritten = 0;
    for (const row of rows) {
      if (row.timeMs === undefined && row.createdAt === undefined) continue;
      await ctx.db.patch(row._id, {
        hits: row.hits ?? row.timeMs ?? 0,
        timeMs: undefined,
        createdAt: undefined,
      });
      rewritten += 1;
    }
    return { scanned: rows.length, rewritten };
  },
});
