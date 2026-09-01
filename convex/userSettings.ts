import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireViewerId } from "./authRoles";

export const get = query({
  args: { settingKey: v.string() },
  handler: async (ctx, { settingKey }) => {
    // Deliberately NOT requireViewerId: reading a setting while signed out is
    // "no setting", not an error — the page renders for signed-out visitors
    // and would break if this threw. The write path below does require a
    // viewer.
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const setting = await ctx.db
      .query("userSettings")
      .withIndex("by_user_setting", (q) =>
        q.eq("userId", userId).eq("settingKey", settingKey),
      )
      .unique();
    return setting?.value ?? null;
  },
});

export const set = mutation({
  args: { settingKey: v.string(), value: v.any() },
  handler: async (ctx, { settingKey, value }) => {
    const userId = await requireViewerId(ctx);
    const existing = await ctx.db
      .query("userSettings")
      .withIndex("by_user_setting", (q) =>
        q.eq("userId", userId).eq("settingKey", settingKey),
      )
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("userSettings", {
      userId,
      settingKey,
      value,
      updatedAt,
    });
  },
});
