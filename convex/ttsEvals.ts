import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
// `commitKey` is the ONE spelling of `<repo>@<sha>` (convex/ttsShared.ts);
// scripts/check-vocabulary.mjs check 5 refuses the template written inline here.
import { commitKey } from "./ttsShared";

// ── EVALS: ONE EVENT KIND (Tom, 2026-09-26: "I want to work in evals which are
// important but not implemented properly") ──────────────────────────────────
// The box's runner (Jarvis worker/jobs/evals.mjs) scores one set of items and
// posts ONE event per set through POST /tts/event: kind `eval-run`, key = the
// set's name ("wall", "rule", "role/classify", ...), data = EvalRunData. This
// module is that shape and its two readers. Nothing here writes: the generic
// worker-event door does.

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
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", EVAL_RUN).eq("key", set))
    .order("desc")
    .first();
}

const EVALS_SEARCH_SCAN_LIMIT = 2_000;

// GET /tts/search/evals. `set` answers the runner's lastRun() (the newest run
// of one set, which its --changed and the learning job's revert test compare
// against) off the by_kind_key index; without it, the newest runs of every set.
// `repo`, `sha` and `failing` are the old search's arguments, still accepted by
// the route; an eval-run carries no repo or sha, so `repo`/`sha` match nothing
// and `failing` keeps only runs with a failed item.
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
    const set = args.set;
    const rows = set !== undefined
      ? await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_key", (q) => q.eq("kind", EVAL_RUN).eq("key", set))
        .order("desc")
        // The runner's lastRun() asks for one row; a whole scan is only for a filter.
        .take(args.failing || args.since !== undefined ? EVALS_SEARCH_SCAN_LIMIT : limit)
      : await ctx.db
        .query("dtsEvents")
        .withIndex("by_kind_at", (q) => args.since === undefined
          ? q.eq("kind", EVAL_RUN)
          : q.eq("kind", EVAL_RUN).gte("at", args.since!),
        )
        .order("desc")
        .take(EVALS_SEARCH_SCAN_LIMIT);
    return rows
      .map((row) => ({ id: row._id, at: row.at, data: (row.data ?? {}) as Partial<EvalRunData> & Record<string, unknown> }))
      .filter((row) =>
        (args.set === undefined || row.data.set === args.set) &&
        (args.since === undefined || row.at >= args.since) &&
        (args.repo === undefined || row.data.repo === args.repo) &&
        (args.sha === undefined || row.data.sha === args.sha) &&
        (!args.failing || (typeof row.data.failed === "number" && row.data.failed > 0)),
      )
      .slice(0, limit);
  },
});

// ── THE HISTORIC evals-run ROWS ─────────────────────────────────────────────
// Before 2026-09-26 a GitHub Action filed an evals-request per pull-request
// head and the box answered with an `evals-run` row keyed `<repo>@<sha>`. That
// protocol is gone; its rows stay in the log. What follows is only what other
// modules still import, over those rows.

// kept for convex/ttsMerge.ts, ttsDigest.ts, ttsWeekly.ts and ttsSimplify.ts; that stream cuts it
export const EVALS_RUN = "evals-run";

// kept for convex/ttsDigest.ts and ttsWeekly.ts; that stream cuts it
export const PRELUDE_DELIVERY = "prelude-delivery";

// kept for convex/ttsMerge.ts; that stream cuts it
export const COVERAGE_NOT_REQUIRED = "not-required";

// kept for convex/ttsWeekly.ts; that stream cuts it
/** A historic row that scored nothing: an unaffected, superseded or failed run. */
export function scoredNothing(data: unknown): boolean {
  const row = (data !== null && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return row.unaffected === true || row.superseded === true || row.error === true ||
    (typeof row.error === "string" && row.error !== "");
}

// kept for convex/ttsMerge.ts; that stream cuts it
export async function evalsProtocolStatus(
  _ctx: QueryCtx | MutationCtx,
): Promise<{ boxEvalsVersion: number; evalsProtocol: number; protocolGap: string | null }> {
  return { boxEvalsVersion: 1, evalsProtocol: 1, protocolGap: null };
}

// kept for convex/ttsMerge.ts; that stream cuts it
/** The newest historic evals-run row for one commit, or null. */
export async function answeredEvalsRun(ctx: QueryCtx | MutationCtx, repo: string, sha: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", EVALS_RUN).eq("key", commitKey(repo, sha)))
    .order("desc")
    .first();
}

// kept for convex/ttsMerge.ts; that stream cuts it
/** Always null: nothing files an evals request any more. */
export async function evalsRequestFor(
  _ctx: QueryCtx | MutationCtx,
  _repo: string,
  _sha: string,
): Promise<Record<string, unknown> | null> {
  return null;
}
