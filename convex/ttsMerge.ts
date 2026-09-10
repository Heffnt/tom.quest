import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { logEvent } from "./tts";
import { EVALS_RUN } from "./ttsEvals";

// ── THE MECHANICAL MERGE GATE (Tom, 2026-09-09) ─────────────────────────────
// Merging used to be Tom's gate: the box classifier denied `git merge` and
// `gh pr merge` outright, and every finished branch waited on him. His ruling
// is that merging is MECHANICAL — when the tests are green, an audit approved
// the head, and the evals came back clean, nothing is left for a person to
// judge — so the gate is those three checks, and the merge is then REPORTED
// for objection rather than asked about. That is also why a merge is not on
// the narrow list: the delegate takes no decision here.
//
// The three facts are three dtsEvents rows about ONE COMMIT, each keyed
// `<repo>@<sha>`, so every check is a point lookup:
//
//   "tests-run"     — the Guardrails `tests` job posts its own result at the
//                     end of the run (.github/workflows/guardrails.yml).
//                     data { repo, sha, ok, detail?, url? }
//   "audit-verdict" — the Codex/Opus audit step posts its answer, and the
//                     `VERDICT: <WORD>` line in it is the verdict
//                     (POST /tts/audit). data { repo, sha, verdict, model? }
//   "evals-run"     — already written by worker/jobs/evals.mjs for every
//                     scored head (convex/ttsEvals.ts). `data.regressions` is
//                     the runner's own comparison against the base run, so
//                     this file never reimplements gate().
//
// FAIL-CLOSED, and deliberately unlike the Bash classifier, which fails open:
// a missing row is a check that did not pass. Guessing wrong here costs a
// merge nobody looked at; guessing wrong the other way costs a branch that
// waits, and a branch that waits is visible.

export const TESTS_RUN = "tests-run";
export const AUDIT_VERDICT = "audit-verdict";
/** One merge, reported for objection. Its key keeps the `<repo>:<sha>`
 *  spelling it was written with. */
export const MERGE = "merge";
/** The one word the audit line must carry for the gate to open. */
export const AUDIT_APPROVED = "APPROVED";

/** The key every fact ABOUT ONE COMMIT is filed under — the spelling
 *  convex/ttsEvals.ts already uses for an evals run, so all three checks are
 *  the same lookup. */
export function commitKey(repo: string, sha: string): string {
  return `${repo}@${sha}`;
}

/** The merge event's own key, which predates this file. */
export function mergeKey(repo: string, sha: string): string {
  return `${repo}:${sha}`;
}

/**
 * The audit step's one machine-readable line. The audit itself is prose from
 * Codex or Opus; the gate reads exactly one line of it, ANCHORED AND ALONE ON
 * ITS LINE, so a verdict quoted inside the prose ("do not write VERDICT:
 * APPROVED unless…") is not mistaken for the verdict.
 *
 * Answers the WORD, not a boolean: a refusal is then recorded as what it said
 * rather than as a missing row, and the deny message can name it.
 */
export function auditVerdictOf(text: string): string | null {
  const hit = /^[ \t]*VERDICT:[ \t]*([A-Za-z][A-Za-z_-]*)[ \t]*$/im.exec(text);
  return hit === null ? null : hit[1].toUpperCase();
}

export type MergeCheck = {
  /** "tests", "audit" or "evals" — the vocabulary the prompt, the deny message
   *  and the morning line all use, so what Tom reads and what an agent is told
   *  are the same three words. */
  name: string;
  passed: boolean;
  /** One sentence: what was found, or what is missing. */
  why: string;
};

export type MergeGateResult = {
  repo: string;
  sha: string;
  allowed: boolean;
  checks: MergeCheck[];
  /** The names of the checks that did not pass, in gate order. */
  missing: string[];
};

async function rowFor(ctx: QueryCtx | MutationCtx, kind: string, key: string) {
  return await ctx.db
    .query("dtsEvents")
    .withIndex("by_kind_key", (q) => q.eq("kind", kind).eq("key", key))
    .order("desc")
    .first();
}

/** The gate itself. A plain function, so the record mutation runs the same
 *  three checks the read route reports: one implementation, and no door that
 *  can write a merge past a check the reader would have failed. */
export async function mergeGateFor(
  ctx: QueryCtx | MutationCtx,
  repo: string,
  sha: string,
): Promise<MergeGateResult> {
  const key = commitKey(repo, sha);
  const short = sha.slice(0, 7);

  const tests = await rowFor(ctx, TESTS_RUN, key);
  const testsData = (tests?.data ?? {}) as { ok?: unknown; detail?: unknown };
  const testsCheck: MergeCheck =
    tests === null
      ? { name: "tests", passed: false, why: `no tests result is recorded for ${short}` }
      : testsData.ok === true
        ? { name: "tests", passed: true, why: `the tests are green at ${short}` }
        : {
            name: "tests",
            passed: false,
            why: `the tests are red at ${short}${
              typeof testsData.detail === "string" ? ` — ${testsData.detail}` : ""
            }`,
          };

  const audit = await rowFor(ctx, AUDIT_VERDICT, key);
  const auditData = (audit?.data ?? {}) as { verdict?: unknown };
  const verdict = typeof auditData.verdict === "string" ? auditData.verdict.toUpperCase() : null;
  const auditCheck: MergeCheck =
    audit === null
      ? { name: "audit", passed: false, why: `no audit verdict is recorded for ${short}` }
      : verdict === AUDIT_APPROVED
        ? { name: "audit", passed: true, why: `the audit approved ${short}` }
        : {
            name: "audit",
            passed: false,
            why: `the audit answered ${verdict ?? "nothing readable"} at ${short}, not ${AUDIT_APPROVED}`,
          };

  const evals = await rowFor(ctx, EVALS_RUN, key);
  const evalsData = (evals?.data ?? {}) as {
    regressions?: unknown;
    items?: unknown;
    pass?: unknown;
  };
  const regressions = typeof evalsData.regressions === "number" ? evalsData.regressions : null;
  const scored =
    typeof evalsData.pass === "number" && typeof evalsData.items === "number"
      ? ` (${evalsData.pass} of ${evalsData.items} pass)`
      : "";
  const evalsCheck: MergeCheck =
    evals === null
      ? { name: "evals", passed: false, why: `no evals run scored ${short}` }
      : regressions === 0
        ? { name: "evals", passed: true, why: `the evals scored ${short} with no regression${scored}` }
        : {
            name: "evals",
            passed: false,
            why: `the evals found ${regressions ?? "an unreadable number of"} regression${
              regressions === 1 ? "" : "s"
            } at ${short}`,
          };

  const checks = [testsCheck, auditCheck, evalsCheck];
  return {
    repo,
    sha,
    allowed: checks.every((check) => check.passed),
    checks,
    missing: checks.filter((check) => !check.passed).map((check) => check.name),
  };
}

/** What the box asks before it lets a merge command run
 *  (worker/session-host/session.mjs). Read-only: it opens nothing by itself. */
export const internalMergeGate = internalQuery({
  args: { repo: v.string(), sha: v.string() },
  handler: async (ctx, { repo, sha }): Promise<MergeGateResult> =>
    await mergeGateFor(ctx, repo, sha),
});

/** The Guardrails `tests` job's own result, at the end of its run. Recorded
 *  ONCE per commit: a rerun of the same sha keeps the first answer, so a red
 *  run cannot be turned green by pressing re-run until it flakes through. */
export const internalRecordTests = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    ok: v.boolean(),
    detail: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = commitKey(args.repo, args.sha);
    const existing = await rowFor(ctx, TESTS_RUN, key);
    if (existing) {
      return { existing: true, ok: (existing.data as { ok?: unknown } | undefined)?.ok === true };
    }
    await logEvent(ctx, TESTS_RUN, undefined, { ...args }, key);
    return { existing: false, ok: args.ok };
  },
});

/** The audit step's verdict, recorded once per commit for the same reason. */
export const internalRecordAudit = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    verdict: v.string(),
    model: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = commitKey(args.repo, args.sha);
    const existing = await rowFor(ctx, AUDIT_VERDICT, key);
    if (existing) {
      const recorded = (existing.data as { verdict?: unknown } | undefined)?.verdict;
      return { existing: true, verdict: typeof recorded === "string" ? recorded : null };
    }
    const verdict = args.verdict.toUpperCase();
    await logEvent(ctx, AUDIT_VERDICT, undefined, { ...args, verdict }, key);
    return { existing: false, verdict };
  },
});

/**
 * POST /tts/merge writes exactly this event, and ONLY after the three checks
 * above pass. A merge is reported for objection, never placed on the narrow
 * list: the delegate did not make this decision.
 *
 * The gate runs HERE as well as at the box, on purpose. The box's check is
 * what stops the COMMAND; this one is what stops the RECORD — a merge that
 * reached main some other way is not laundered into a reported merge by
 * posting to this route.
 */
export const internalRecordMerge = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    subject: v.string(),
    todoId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const gate = await mergeGateFor(ctx, args.repo, args.sha);
    if (!gate.allowed) return { recorded: false, existing: false, gate };
    const todoId =
      args.todoId === undefined ? undefined : ctx.db.normalizeId("dtsTodos", args.todoId);
    if (args.todoId !== undefined && todoId === null) {
      throw new Error(`Unknown todo id: ${args.todoId}`);
    }
    const key = mergeKey(args.repo, args.sha);
    const existing = await rowFor(ctx, MERGE, key);
    if (existing) return { recorded: true, id: existing._id, existing: true, gate };
    const id = await logEvent(
      ctx,
      MERGE,
      todoId ?? undefined,
      { repo: args.repo, sha: args.sha, subject: args.subject },
      key,
    );
    // ONE LINE IN #tts-decisions as it is recorded, through the one decisions
    // door every producer shares (convex/ttsSync.ts sendDecision). The morning
    // message's objection list is the second sighting, not the only one.
    //
    // Its askId is the merge's own key, so a reply in that thread objects to
    // THIS merge: convex/ttsAsk.ts internalRecordDelegateObjection resolves a
    // merge row as well as a delegate decision.
    await ctx.scheduler.runAfter(0, internal.ttsSync.sendDecision, {
      askId: key,
      ...(todoId === undefined || todoId === null ? {} : { todoId: todoId as string }),
      decision: `merged ${args.repo}@${args.sha.slice(0, 7)}: ${args.subject}`,
      reason: gate.checks.map((check) => check.why).join("; "),
      refused: false,
    });
    return { recorded: true, id, existing: false, gate };
  },
});
