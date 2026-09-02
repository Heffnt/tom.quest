// Saved /boolback views. GLOBAL (no auth gating — the page is effectively
// single-user; Tom confirmed global is fine). A preset has one kind, "view":
// `state` holds a whole ViewSpec, opaque here and validated by the client
// loader (app/boolback/lib/presets.ts). Upsert is by (kind, name), so the
// single-literal `kind` is still what the by_kind_name index looks up first.
// Follows the convex module conventions in userSettings.ts / brews.ts.

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const KIND = v.literal("view");

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("boolbackPresets").collect();
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

export const save = mutation({
  args: {
    name: v.string(),
    kind: KIND,
    schemaVersion: v.number(),
    state: v.any(),
  },
  handler: async (ctx, { name, kind, schemaVersion, state }) => {
    const existing = await ctx.db
      .query("boolbackPresets")
      .withIndex("by_kind_name", (q) => q.eq("kind", kind).eq("name", name))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { schemaVersion, state, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("boolbackPresets", {
      name,
      kind,
      schemaVersion,
      state,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const remove = mutation({
  args: { id: v.id("boolbackPresets") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});
