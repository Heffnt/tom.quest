import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { roleAccess, viewerDoc } from "./authRoles";

export const viewer = query({
  args: {},
  handler: async (ctx) => {
    const user = await viewerDoc(ctx);
    if (!user) return null;
    const access = roleAccess(user.role);
    return {
      _id: user._id,
      name: user.name ?? "User",
      email: user.email ?? null,
      role: access.role,
      isAdmin: access.isAdmin,
      isTom: access.isTom,
      isAgent: access.isAgent,
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
    if (!roleAccess(viewer?.role).isTom) {
      throw new Error("Only Tom can promote admins");
    }
    await ctx.db.patch(userId, { role: "admin" });
  },
});

// Set an account's role by the username it signed up with. Run from the Convex
// dashboard; there is no user-list UI, and promoteToAdmin above takes a raw
// document id, which means reading it off the dashboard first anyway.
//
// This is how the TTS session account gets to `agent`, and it is also the only
// way back down — nothing else in this file ever writes a role other than
// upward.
//
// Two things it will not do. It cannot grant `tom`: that stays the one-shot
// setTomByUsername path above, gated on TOM_SETUP_SECRET. And it refuses an
// account already at `tom`, so a mistyped username cannot demote Tom out of
// his own deployment and leave nobody able to undo it.
export const setRoleByUsername = mutation({
  args: {
    username: v.string(),
    role: v.union(v.literal("user"), v.literal("admin"), v.literal("agent")),
  },
  handler: async (ctx, { username, role }) => {
    const viewer = await viewerDoc(ctx);
    if (!roleAccess(viewer?.role).isTom) {
      throw new Error("Only Tom can set roles");
    }
    const normalized = username.toLowerCase().replace(/[^a-z0-9]/g, "");
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", `${normalized}@tom.quest`))
      .unique();
    if (!user) throw new Error("User not found");
    if (user.role === "tom") {
      throw new Error("The Tom account's role cannot be changed here");
    }
    await ctx.db.patch(user._id, { role });
    return user._id;
  },
});
