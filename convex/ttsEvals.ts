import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

// ── EVALS: ONE EVENT KIND (Tom, 2026-09-26: "I want to work in evals which are
// important but not implemented properly") ──────────────────────────────────
// The box's runner (Jarvis worker/jobs/evals.mjs) scores one set of items and
// posts ONE row per set through POST /jarvis/event into the `events` table:
// kind `eval-run` (shared/jarvis-events.mjs), subject = the set's name
// ("wall", "rule", "role/classify", ...), data = EvalRunData, text = its one
// summary line. This module is that shape and its two readers. Nothing here
// writes: the one event door does.

export const EVAL_RUN = "eval-run";

/** One set's run, exactly as the runner's runData() builds it. */
export type EvalRunData = {
  set: string;
  passed: number;
  failed: number;
  skipped: number;
  /** passed + failed: skipped items are not scored. */
  total: number;
  /** `pass` is null for an item skipped because what it needs was absent. */
  items: { name: string; pass: boolean | null; note: string }[];
  model: string | null;
  role: string | null;
  candidate: string | null;
  /** The HEAD sha of each checkout the items came from, by repo name: Jarvis
   *  and WikiTom (null when that checkout was absent). */
  commit: Record<string, string | null>;
  /** Hashes of the model-of-tom rules pages and the model registry. */
  inputs: { rules: string | null; registry: string | null };
  at: number;
};

/** The share of scored items that passed, or null when nothing was scored. */
export function passRateOf(data: Pick<EvalRunData, "passed" | "total"> | null | undefined): number | null {
  return data && data.total > 0 ? data.passed / data.total : null;
}

/**
 * The newest eval-run event of one set, or null.
 *
 * THE /intent PAGE'S PASS-RATE READER: the page shows each set's (and each
 * rule's) latest pass rate by reading this and passRateOf, so a set's number
 * there is always its last recorded run.
 */
export async function latestEvalRunFor(ctx: QueryCtx | MutationCtx, set: string) {
  return await ctx.db
    .query("events")
    .withIndex("by_kind_subject_at", (q) => q.eq("kind", EVAL_RUN).eq("subject", set))
    .order("desc")
    .first();
}

const EVALS_SEARCH_SCAN_LIMIT = 2_000;

// GET /tts/search/evals, which serves `tts search evals` alone: the runner
// reads its own last run off GET /jarvis/events. `set` narrows to one set on
// events.by_kind_subject_at; without it, the newest runs of every set on
// by_kind_at. Each row is the events document plus `id`, the name the search
// command cites it by. `repo`, `sha` and `failing` are the old search's
// arguments, still accepted by the route; an eval-run carries no repo or sha,
// so `repo`/`sha` match nothing and `failing` keeps only runs with a failed item.
export const internalSearchEvals = internalQuery({
  args: {
    set: v.optional(v.string()),
    repo: v.optional(v.string()),
    sha: v.optional(v.string()),
    since: v.optional(v.number()),
    failing: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 20)));
    const { set, since } = args;
    const rows = set !== undefined
      ? await ctx.db
        .query("events")
        .withIndex("by_kind_subject_at", (q) => since === undefined
          ? q.eq("kind", EVAL_RUN).eq("subject", set)
          : q.eq("kind", EVAL_RUN).eq("subject", set).gte("at", since),
        )
        .order("desc")
        .take(args.failing ? EVALS_SEARCH_SCAN_LIMIT : limit)
      : await ctx.db
        .query("events")
        .withIndex("by_kind_at", (q) => since === undefined
          ? q.eq("kind", EVAL_RUN)
          : q.eq("kind", EVAL_RUN).gte("at", since),
        )
        .order("desc")
        .take(EVALS_SEARCH_SCAN_LIMIT);
    return rows
      .filter((row) => {
        const data = (row.data ?? {}) as Partial<EvalRunData> & Record<string, unknown>;
        return (args.repo === undefined || data.repo === args.repo) &&
          (args.sha === undefined || data.sha === args.sha) &&
          (!args.failing || (typeof data.failed === "number" && data.failed > 0));
      })
      .slice(0, limit)
      .map((row) => ({ ...row, id: row._id }));
  },
});

// ── THE HISTORIC evals-run ROWS ─────────────────────────────────────────────
// Before 2026-09-26 a GitHub Action filed an evals-request per pull-request
// head and the box answered with an `evals-run` row keyed `<repo>@<sha>`. That
// protocol is gone; its rows stay in the log. What follows is only what other
// modules still import, over those rows.

// kept for convex/ttsDigest.ts, ttsWeekly.ts and ttsSimplify.ts; that stream cuts it
export const EVALS_RUN = "evals-run";

// kept for convex/ttsDigest.ts and ttsWeekly.ts; that stream cuts it
export const PRELUDE_DELIVERY = "prelude-delivery";

// kept for convex/ttsWeekly.ts; that stream cuts it
/** A historic row that scored nothing: an unaffected, superseded or failed run. */
export function scoredNothing(data: unknown): boolean {
  const row = (data !== null && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return row.unaffected === true || row.superseded === true || row.error === true ||
    (typeof row.error === "string" && row.error !== "");
}
