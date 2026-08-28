import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireTom } from "./authRoles";
import { logEvent } from "./dts";

// DTS code-todo ruling loop — the Convex side of the worker-brief / Tom-rule /
// worker-apply cycle over code todos (spec: WikiTom dts/spec.md §5.3). The
// worker box writes ground-up BRIEFS for each open code todo (from the
// dtsCodeTodoMirror's repos), Tom records RULINGS on the dashboard, and worker
// jobs read pending rulings back to apply/execute them. Tom-facing functions
// are Tom-gated (dts.ts pattern); everything the worker touches goes through
// internal functions behind the key-authed /dts/code-* routes in http.ts.

const RECOMMENDATION = v.union(
  v.literal("approve"),
  v.literal("needs-session"),
  v.literal("propose-archive"),
  v.literal("stale-replan"),
);
const EXEC_CLASS = v.union(v.literal("box"), v.literal("needs-turing"));
// Rulings extend the recommendation vocabulary with "defer" (Tom explicitly
// putting an item off — recorded, never silent).
const RULING = v.union(
  v.literal("approve"),
  v.literal("needs-session"),
  v.literal("propose-archive"),
  v.literal("stale-replan"),
  v.literal("defer"),
);

const itemKey = (row: { repo: string; externalId: string }) =>
  `${row.repo}\u0000${row.externalId}`;

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Everything, always (spec §6): both tables stay small (one brief per open
// code todo; append-only rulings at human pace), so full collects are fine and
// let the client group/join freely.
export const listCodeBriefs = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, "DTS");
    return await ctx.db.query("dtsCodeBriefs").collect();
  },
});

export const listCodeRulings = query({
  args: {},
  handler: async (ctx) => {
    await requireTom(ctx, "DTS");
    return await ctx.db.query("dtsCodeRulings").collect();
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

// Append-only: a new ruling on an already-ruled item is a NEW row (history
// kept, nothing-is-lost) — the newest ruledAt is the live ruling for display
// and for internalPendingRulings.
export const recordCodeRuling = mutation({
  args: {
    repo: v.string(),
    externalId: v.string(),
    ruling: RULING,
    note: v.optional(v.string()),
  },
  handler: async (ctx, { repo, externalId, ruling, note }) => {
    await requireTom(ctx, "DTS");
    const id = await ctx.db.insert("dtsCodeRulings", {
      repo,
      externalId,
      ruling,
      note,
      ruledAt: Date.now(),
    });
    await logEvent(ctx, "code-ruling", undefined, { repo, externalId, ruling });
    return id;
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

// The rulings a worker job should act on: appliedAt unset AND not superseded —
// a newer ruling on the same (repo, externalId) makes the older one dead
// history (the newest ruling per item is the live one), so an unapplied older
// ruling must never be executed. Rows carry _id for the apply callback.
export const internalPendingRulings = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("dtsCodeRulings").collect();
    const newest = new Map<string, Doc<"dtsCodeRulings">>();
    for (const row of all) {
      const key = itemKey(row);
      const prior = newest.get(key);
      // ruledAt wins; _creationTime breaks same-millisecond ties.
      if (
        !prior ||
        row.ruledAt > prior.ruledAt ||
        (row.ruledAt === prior.ruledAt && row._creationTime > prior._creationTime)
      ) {
        newest.set(key, row);
      }
    }
    return all.filter(
      (row) =>
        row.appliedAt === undefined && newest.get(itemKey(row))?._id === row._id,
    );
  },
});

// Apply callback: the worker reports what it did (commit sha / PR url) or how
// it failed (error text) — either way the ruling is consumed (appliedAt set),
// with the outcome on record in applyResult.
export const internalMarkRulingApplied = internalMutation({
  args: { id: v.string(), result: v.string() },
  handler: async (ctx, { id, result }) => {
    // The worker sends plain strings over HTTP; normalizeId is the proper
    // reject-with-a-name path for malformed/wrong-table ids.
    const normalized = ctx.db.normalizeId("dtsCodeRulings", id);
    if (!normalized) throw new Error(`Unknown ruling id: ${id}`);
    const ruling = await ctx.db.get(normalized);
    if (!ruling) throw new Error(`Unknown ruling id: ${id}`);
    await ctx.db.patch(normalized, { appliedAt: Date.now(), applyResult: result });
    await logEvent(ctx, "code-ruling-applied", undefined, {
      repo: ruling.repo,
      externalId: ruling.externalId,
      ruling: ruling.ruling,
      result,
    });
  },
});

// Digest input: how many briefed items have NO ruling row at all — the pile
// waiting on Tom. An item with any ruling (even an unapplied or superseded
// one) has been ruled on and is off Tom's plate.
export const internalAwaitingRulingCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const briefs = await ctx.db.query("dtsCodeBriefs").collect();
    const rulings = await ctx.db.query("dtsCodeRulings").collect();
    const ruled = new Set(rulings.map(itemKey));
    return briefs.filter((b) => !ruled.has(itemKey(b))).length;
  },
});
