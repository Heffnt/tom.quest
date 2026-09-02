import { v } from "convex/values";
import { internalAction, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

// The one name this table records. pollTuring below is the table's only writer
// and always passes "turing"; Jarvis liveness comes from the gateway socket
// (useJarvisServer in app/lib/hooks/use-server.ts), not from a row here. Keep
// this in step with the serverHealth.serverName validator in convex/schema.ts —
// they are two spellings of one vocabulary, and only widening both together
// lets a row actually be written and read.
const SERVER_NAME = v.literal("turing");
const HEALTH_TIMEOUT_MS = 10_000;

export const get = query({
  args: { serverName: SERVER_NAME },
  handler: async (ctx, { serverName }) => {
    return await ctx.db
      .query("serverHealth")
      .withIndex("by_server", (q) => q.eq("serverName", serverName))
      .first();
  },
});

export const set = internalMutation({
  args: {
    serverName: SERVER_NAME,
    reachable: v.boolean(),
    lastChecked: v.number(),
    lastSuccessAt: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("serverHealth")
      .withIndex("by_server", (q) => q.eq("serverName", args.serverName))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        reachable: args.reachable,
        lastChecked: args.lastChecked,
        lastSuccessAt: args.lastSuccessAt ?? existing.lastSuccessAt,
        error: args.error,
      });
    } else {
      await ctx.db.insert("serverHealth", args);
    }
  },
});

export const pollTuring = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.TURING_API_URL;
    const now = Date.now();
    if (!url) {
      await ctx.runMutation(internal.serverHealth.set, {
        serverName: "turing",
        reachable: false,
        lastChecked: now,
        error: "TURING_API_URL not set",
      });
      return;
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await ctx.runMutation(internal.serverHealth.set, {
          serverName: "turing",
          reachable: false,
          lastChecked: now,
          error: `health returned ${res.status}`,
        });
        return;
      }
      await ctx.runMutation(internal.serverHealth.set, {
        serverName: "turing",
        reachable: true,
        lastChecked: now,
        lastSuccessAt: now,
      });
    } catch (e) {
      await ctx.runMutation(internal.serverHealth.set, {
        serverName: "turing",
        reachable: false,
        lastChecked: now,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
