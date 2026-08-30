import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireTom, requireTomOrAgent } from "./authRoles";
import { logEvent } from "./tts";

// TTS code-todo BRIEFS — the Jarvis Box writes ground-up briefs for each open
// code todo (from the dtsCodeTodoMirror's repos); Tom's rulings on them live in
// the unified ttsRulings table (ttsRulings.ts, ratified 2026-08-28), and worker
// jobs read pending rulings back from there to apply/execute them. Tom-facing
// functions are Tom-gated (tts.ts pattern); everything the worker touches goes
// through internal functions behind the key-authed /tts/code-* routes in http.ts.

const RECOMMENDATION = v.union(
  v.literal("approve"),
  v.literal("needs-session"),
  v.literal("propose-archive"),
  v.literal("stale-replan"),
);
const EXEC_CLASS = v.union(v.literal("box"), v.literal("needs-turing"));

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Everything, always (spec §6): one brief per open code todo — the table stays
// small, so a full collect is fine and lets the client group/join freely.
export const listCodeBriefs = query({
  args: {},
  handler: async (ctx) => {
    await requireTomOrAgent(ctx, "TTS");
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});

// ── Internal: worker paths (via key-authed http.ts /tts/code-* routes) ───────

// Upsert by (repo, externalId): the brief table holds the CURRENT brief per
// item, not history (the ruling table is the append-only side). One
// "code-briefed" event per batch, not per row.
export const internalStoreBriefs = internalMutation({
  args: {
    briefs: v.array(
      v.object({
        repo: v.string(),
        externalId: v.string(),
        sourceHash: v.string(),
        brief: v.string(),
        recommendation: RECOMMENDATION,
        execClass: EXEC_CLASS,
        evidence: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { briefs }) => {
    const now = Date.now();
    for (const brief of briefs) {
      const existing = await ctx.db
        .query("dtsCodeBriefs")
        .withIndex("by_repo_external", (q) =>
          q.eq("repo", brief.repo).eq("externalId", brief.externalId),
        )
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, { ...brief, preparedAt: now });
      } else {
        await ctx.db.insert("dtsCodeBriefs", { ...brief, preparedAt: now });
      }
    }
    await logEvent(ctx, "code-briefed", undefined, { count: briefs.length });
  },
});

export const internalListBriefs = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});
