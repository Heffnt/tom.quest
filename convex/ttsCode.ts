import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireTomOrAgent } from "./authRoles";
import { logEvent } from "./tts";
import { RECOMMENDATION } from "./ttsShared";

// TTS code-todo BRIEFS — the Jarvis Box writes ground-up briefs for each open
// code todo (from the dtsCodeTodoMirror's repos); Tom's rulings on them live in
// the unified ttsRulings table (ttsRulings.ts, ratified 2026-08-28), and worker
// jobs read pending rulings back from there to apply/execute them. Tom-facing
// functions are Tom-gated (tts.ts pattern); everything the worker touches goes
// through internal functions behind the key-authed /tts/code-* routes in http.ts.

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
    // THE RUN THAT WROTE THESE BRIEFS. A code ruling of Tom's is a judgment
    // about the brief he read, and this is the edge back to the run that wrote
    // it (convex/runLabels.ts tokenForRulingSubject reads it off the brief
    // row). One token per call rather than per brief: one brief pass is one
    // run, and the pen takes the pass's output as a batch. Absent is a
    // supported value and is never inferred.
    runToken: v.optional(v.string()),
  },
  handler: async (ctx, { briefs, runToken }) => {
    const now = Date.now();
    for (const brief of briefs) {
      const existing = await ctx.db
        .query("dtsCodeBriefs")
        .withIndex("by_repo_external", (q) =>
          q.eq("repo", brief.repo).eq("externalId", brief.externalId),
        )
        .first();
      // No normalizing left to do: the pen's validator holds the four verdict
      // words, so what arrives is already what is stored (the lifeos update,
      // phase 7).
      // Spread conditionally, never as `producedByRunToken: runToken`: a patch
      // written with undefined DELETES the field, so a re-brief from an
      // unregistered caller would silently strip the edge the last registered
      // run left behind.
      const row = {
        ...brief,
        ...(runToken === undefined ? {} : { producedByRunToken: runToken }),
        preparedAt: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert("dtsCodeBriefs", row);
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
