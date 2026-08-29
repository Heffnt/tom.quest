import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { requireTom } from "./authRoles";
import { IMPORTANCE_LEVEL, agentImportancePatch, logEvent } from "./dts";

// DTS code-todo BRIEFS — the worker box writes ground-up briefs for each open
// code todo (from the dtsCodeTodoMirror's repos); Tom's rulings on them live in
// the unified dtsRulings table (dtsRulings.ts, ratified 2026-08-28), and worker
// jobs read pending rulings back from there to apply/execute them. Tom-facing
// functions are Tom-gated (dts.ts pattern); everything the worker touches goes
// through internal functions behind the key-authed /dts/code-* routes in http.ts.

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
    await requireTom(ctx, "DTS");
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});

// Tom's importance override for a CODE todo — it lives on the brief (the
// stable home; mirror rows are deleted on upstream close). null clears the
// whole object; setBy "tom" makes every agent write a no-op until cleared.
export const setCodeImportance = mutation({
  args: {
    repo: v.string(),
    externalId: v.string(),
    level: v.union(IMPORTANCE_LEVEL, v.null()),
  },
  handler: async (ctx, { repo, externalId, level }) => {
    await requireTom(ctx, "DTS");
    const brief = await ctx.db
      .query("dtsCodeBriefs")
      .withIndex("by_repo_external", (q) =>
        q.eq("repo", repo).eq("externalId", externalId),
      )
      .first();
    if (!brief) throw new Error("Code brief not found");
    await ctx.db.patch(brief._id, {
      importance:
        level === null ? undefined : { level, setBy: "tom", setAt: Date.now() },
    });
    await logEvent(ctx, "importance-set", undefined, {
      repo,
      externalId,
      level,
      setBy: "tom",
    });
  },
});

// ── Internal: worker paths (via key-authed http.ts /dts/code-* routes) ───────

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
        importanceLevel: v.optional(IMPORTANCE_LEVEL),
        importanceRationale: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { briefs }) => {
    const now = Date.now();
    let importanceSkipped = 0;
    // importanceLevel/importanceRationale are transport fields, not schema
    // fields — stripped here so only the assembled `importance` object lands.
    for (const { importanceLevel, importanceRationale, ...brief } of briefs) {
      const existing = await ctx.db
        .query("dtsCodeBriefs")
        .withIndex("by_repo_external", (q) =>
          q.eq("repo", brief.repo).eq("externalId", brief.externalId),
        )
        .first();
      let importance: ReturnType<typeof agentImportancePatch>;
      if (importanceLevel !== undefined) {
        // Agent importance never overwrites Tom's — the ONE guard
        // implementation (dts.agentImportancePatch) decides.
        importance = agentImportancePatch(
          existing?.importance,
          importanceLevel,
          importanceRationale,
          now,
        );
        if (importance === undefined) importanceSkipped++;
      }
      if (existing) {
        await ctx.db.patch(
          existing._id,
          importance !== undefined
            ? { ...brief, importance, preparedAt: now }
            : { ...brief, preparedAt: now },
        );
      } else {
        await ctx.db.insert("dtsCodeBriefs", {
          ...brief,
          importance,
          preparedAt: now,
        });
      }
    }
    await logEvent(ctx, "code-briefed", undefined, { count: briefs.length });
    if (importanceSkipped > 0) {
      await logEvent(ctx, "importance-skipped", undefined, {
        count: importanceSkipped,
      });
    }
  },
});

export const internalListBriefs = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});
