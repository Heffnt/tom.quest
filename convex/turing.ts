import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

const STALE_AFTER_MS = 5 * 60 * 1000;

async function requireUser(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Authentication required");
  return userId;
}

async function viewerRole(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) return "user";
  const user = await ctx.db.get(userId);
  return user?.role ?? "user";
}

function isAdminRole(role: string): boolean {
  return role === "admin" || role === "tom";
}

function isFresh(lastHeartbeat: number): boolean {
  return Date.now() - lastHeartbeat <= STALE_AFTER_MS;
}

export const registerConnectionFromWorker = internalMutation({
  args: {
    connectionKey: v.string(),
    tunnelUrl: v.string(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("turingConnections")
      .withIndex("by_connection_key", (q) => q.eq("connectionKey", args.connectionKey))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        tunnelUrl: args.tunnelUrl,
        lastHeartbeat: args.now,
      });
      return existing._id;
    }
    return await ctx.db.insert("turingConnections", {
      connectionKey: args.connectionKey,
      tunnelUrl: args.tunnelUrl,
      lastHeartbeat: args.now,
    });
  },
});

export const connectionForViewer = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
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
    const userId = await requireUser(ctx);
    const role = await viewerRole(ctx);
    if (!isAdminRole(role)) throw new Error("Admin access required");
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
    const userId = await requireUser(ctx);
    const role = await viewerRole(ctx);
    if (!isAdminRole(role)) throw new Error("Admin access required");
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
    const userId = await requireUser(ctx);
    const role = await viewerRole(ctx);
    if (!isAdminRole(role)) throw new Error("Admin access required");
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
