import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const topScores = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const scores = await ctx.db
      .query("symbolScores")
      .withIndex("by_time")
      .order("desc")
      .take(limit ?? 10);
    return scores.map((score) => ({
      id: score._id,
      username: score.username,
      time_ms: score.timeMs,
      created_at: new Date(score.createdAt).toISOString(),
    }));
  },
});

export const submitScore = mutation({
  args: { username: v.string(), timeMs: v.number() },
  handler: async (ctx, { username, timeMs }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Authentication required");
    return await ctx.db.insert("symbolScores", {
      userId,
      username,
      timeMs,
      createdAt: Date.now(),
    });
  },
});
