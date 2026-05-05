import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

export type UserRole = "user" | "admin" | "tom";

function roleOrDefault(role: UserRole | undefined): UserRole {
  return role ?? "user";
}

async function viewerDoc(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return await ctx.db.get(userId);
}

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerDoc(ctx);
    if (!user) return null;
    const role = roleOrDefault(user.role);
    return {
      _id: user._id,
      name: user.name ?? "User",
      email: user.email ?? null,
      role,
      isAdmin: role === "admin" || role === "tom",
      isTom: role === "tom",
    };
  },
});

export const setTomByUsername = mutation({
  args: { username: v.string(), setupSecret: v.string() },
  handler: async (ctx, { username, setupSecret }) => {
    const expectedSecret = process.env.TOM_SETUP_SECRET;
    if (!expectedSecret || setupSecret !== expectedSecret) {
      throw new Error("Tom setup is not authorized");
    }
    const normalized = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const allowedUsername = (process.env.TOM_USERNAME ?? "tom")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (normalized !== allowedUsername) {
      throw new Error("Only the configured Tom username can be promoted this way");
    }
    const existingTom = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("role"), "tom"))
      .first();
    if (existingTom) {
      throw new Error("Tom account is already configured");
    }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", `${normalized}@tom.quest`))
      .unique();
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, { role: "tom" });
    return user._id;
  },
});

export const promoteToAdmin = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const viewer = await viewerDoc(ctx);
    if (roleOrDefault(viewer?.role) !== "tom") {
      throw new Error("Only Tom can promote admins");
    }
    await ctx.db.patch(userId as Id<"users">, { role: "admin" });
  },
});
