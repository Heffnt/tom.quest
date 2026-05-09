import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireViewer, requireViewerId } from "./authRoles";

const STALE_AFTER_MS = 5 * 60 * 1000;

function isFresh(lastHeartbeat: number): boolean {
  return Date.now() - lastHeartbeat <= STALE_AFTER_MS;
}

async function tomUserId(ctx: MutationCtx) {
  const tom = await ctx.db
    .query("users")
    .filter((q) => q.eq(q.field("role"), "tom"))
    .first();
  return tom?._id;
}

export const registerConnectionFromWorker = internalMutation({
  args: {
    connectionKey: v.string(),
    tunnelUrl: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const autoLinkUserId = await tomUserId(ctx);
    const existing = await ctx.db
      .query("turingConnections")
      .withIndex("by_connection_key", (q) => q.eq("connectionKey", args.connectionKey))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        tunnelUrl: args.tunnelUrl,
        lastHeartbeat: args.now,
        userId: existing.userId ?? autoLinkUserId,
      });
      return existing._id;
    }
    return await ctx.db.insert("turingConnections", {
      connectionKey: args.connectionKey,
      tunnelUrl: args.tunnelUrl,
      lastHeartbeat: args.now,
      userId: autoLinkUserId,
    });
  },
});

export const connectionForViewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireViewerId(ctx);
    const connection = await ctx.db
      .query("turingConnections")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .unique();
    if (!connection) return null;
    return {
      _id: connection._id,
      tunnelUrl: connection.tunnelUrl,
      lastHeartbeat: connection.lastHeartbeat,
      fresh: isFresh(connection.lastHeartbeat),
    };
  },
});

export const linkConnection = mutation({
  args: { connectionKey: v.string() },
  handler: async (ctx, { connectionKey }) => {
    const { userId, access } = await requireViewer(ctx);
    if (!access.isAdmin) throw new Error("Admin access required");
    const connection = await ctx.db
      .query("turingConnections")
      .withIndex("by_connection_key", (q) => q.eq("connectionKey", connectionKey))
      .unique();
    if (!connection) throw new Error("Connection not found");
    await ctx.db
      .query("turingConnections")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .collect()
      .then((existing) =>
        Promise.all(existing.map((doc) => ctx.db.patch(doc._id, { userId: undefined }))),
      );
    await ctx.db.patch(connection._id, { userId });
  },
});

export const unlinkConnection = mutation({
  args: {},
  handler: async (ctx) => {
    const { userId, access } = await requireViewer(ctx);
    if (!access.isAdmin) throw new Error("Admin access required");
    const existing = await ctx.db
      .query("turingConnections")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .collect();
    await Promise.all(existing.map((doc) => ctx.db.patch(doc._id, { userId: undefined })));
  },
});

export const tunnelForViewer = query({
  args: {},
  handler: async (ctx) => {
    const { userId, access } = await requireViewer(ctx);
    if (!access.isAdmin) throw new Error("Admin access required");
    const connection = await ctx.db
      .query("turingConnections")
      .withIndex("by_user_id", (q) => q.eq("userId", userId))
      .unique();
    if (!connection || !isFresh(connection.lastHeartbeat)) {
      throw new Error("Turing backend not connected");
    }
    return {
      url: connection.tunnelUrl,
      key: connection.connectionKey,
    };
  },
});
