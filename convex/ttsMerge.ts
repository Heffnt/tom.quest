import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { logEvent } from "./tts";
import { EVALS_RUN } from "./ttsEvals";
import { redactSecrets } from "../worker/session-host/redact.mjs";

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
//                     (POST /tts/audit).
//                     data { repo, sha, verdict, text, model?, fallback? }
//   "evals-run"     — already written by worker/jobs/evals.mjs for every
//                     scored head (convex/ttsEvals.ts). `data.regressions` is
//                     the runner's own comparison against the base run, and
//                     `data.goldenCoverage` its answer to whether a watched
//                     context change shipped an item, so this file never
//                     reimplements gate().
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
/** The word the audit step posts when it could not run at all
 *  (worker/jobs/audit.mjs AUDIT_UNAVAILABLE). NOT A VERDICT: it is the
 *  ABSENCE of one, which is why a later real verdict replaces it below. */
export const AUDIT_UNAVAILABLE = "UNAVAILABLE";
/** The most audit prose retained on its event, measured after redaction. */
export const AUDIT_TEXT_MAX_BYTES = 8 * 1024;

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

function capUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // Do not retain a partial multi-byte code point at the boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end));
}

function auditReason(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  const verdictLine = lines.findIndex((line) =>
    /^[ \t]*VERDICT:[ \t]*[A-Za-z][A-Za-z_-]*[ \t]*$/i.test(line),
  );
  if (verdictLine < 0) return null;
  return lines.slice(verdictLine + 1).map((line) => line.trim()).find(Boolean) ?? null;
}

/**
 * The parenthetical the audit's `why` carries when a fallback auditor answered
 * — "(audit by claude-opus-5, Codex at its cap)" — and the empty string when
 * Codex itself answered, which is the ordinary case and needs no note.
 *
 * `fallback` is the worker's one word for WHY the stand-in ran
 * (worker/jobs/audit.mjs AUDIT_FALLBACK_REASON); "codex-cap" is the only one
 * so far and gets the sentence Tom reads. An unknown reason is still declared
 * rather than hidden.
 */
export function auditFallbackNote(data: { model?: unknown; fallback?: unknown }): string {
  const fallback = typeof data.fallback === "string" ? data.fallback.trim() : "";
  if (fallback === "") return "";
  const model = typeof data.model === "string" && data.model.trim() !== ""
    ? data.model.trim()
    : "a stand-in model";
  return fallback === "codex-cap"
    ? ` (audit by ${model}, Codex at its cap)`
    : ` (audit by ${model}, fallback: ${fallback})`;
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
  const auditData = (audit?.data ?? {}) as {
    verdict?: unknown;
    text?: unknown;
    model?: unknown;
    fallback?: unknown;
  };
  const verdict = typeof auditData.verdict === "string" ? auditData.verdict.toUpperCase() : null;
  const auditWhy = auditReason(auditData.text);
  const auditDetail = auditWhy === null ? "" : ` — ${auditWhy}`;
  // A fallback audit is a WEAKER audit and says so wherever it is read: the
  // point of the check is a family that did not write the code, and at Codex's
  // weekly cap it was Opus that answered. The note rides the `why`, so the
  // gate's answer and the #tts-decisions merge line (which joins these whys)
  // both carry it and Tom can object to a same-family audit.
  const byWhom = auditFallbackNote(auditData);
  const auditCheck: MergeCheck =
    audit === null
      ? { name: "audit", passed: false, why: `no audit verdict is recorded for ${short}` }
      : verdict === AUDIT_APPROVED
        ? { name: "audit", passed: true, why: `the audit approved ${short}${byWhom}${auditDetail}` }
        : {
            name: "audit",
            passed: false,
            why: `the audit answered ${verdict ?? "nothing readable"} at ${short}${byWhom}, not ${AUDIT_APPROVED}${auditDetail}`,
          };

  const evals = await rowFor(ctx, EVALS_RUN, key);
  const evalsData = (evals?.data ?? {}) as {
    regressions?: unknown;
    goldenCoverage?: unknown;
    items?: unknown;
    pass?: unknown;
  };
  const regressions = typeof evalsData.regressions === "number" ? evalsData.regressions : null;
  // STILL THREE HEAD ROWS. Golden coverage is not a fourth check and has no
  // row of its own: it is a field of the evals run, so the evals arm asks two
  // questions of one fact and GET /tts/merge-gate's shape does not move.
  //
  // BOTH null AND undefined DENY. `null` is the run saying nobody asked it
  // about a diff; `undefined` is a run recorded before the field existed.
  // A MERGE ALWAYS HAS A DIFF, so neither is an answer to "did this change
  // ship what it owed" — and a gate that opened on "we did not check" is
  // precisely the failure the `regressions: null` rule above was written to
  // prevent (worker/jobs/evals.mjs failedRun).
  const coverage =
    typeof evalsData.goldenCoverage === "boolean" || evalsData.goldenCoverage === null
      ? evalsData.goldenCoverage
      : undefined;
  const scored =
    typeof evalsData.pass === "number" && typeof evalsData.items === "number"
      ? ` (${evalsData.pass} of ${evalsData.items} pass)`
      : "";
  const evalsCheck: MergeCheck =
    evals === null
      ? { name: "evals", passed: false, why: `no evals run scored ${short}` }
      : regressions !== 0
        ? {
            name: "evals",
            passed: false,
            why: `the evals found ${regressions ?? "an unreadable number of"} regression${
              regressions === 1 ? "" : "s"
            } at ${short}`,
          }
        : coverage === true
          ? { name: "evals", passed: true, why: `the evals scored ${short} with no regression${scored}` }
          : coverage === false
            ? {
                name: "evals",
                passed: false,
                why: `the evals run at ${short} changed a watched context file and shipped no golden item`,
              }
            : {
                name: "evals",
                passed: false,
                why:
                  `the evals run did not check golden coverage — re-run it: ` +
                  `node /opt/tts/evals.mjs --repo ${repo} --sha ${sha} --force`,
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

/**
 * The audit step's verdict and bounded, redacted answer, recorded once per
 * commit for the same reason: a refusal cannot be re-run until it approves.
 *
 * ONE EXCEPTION, and it is not a loophole: an UNAVAILABLE row is the ABSENCE
 * of an audit, not an audit — it says the auditor could not be reached at all
 * (Codex over its weekly cap, the CLI missing, the box offline). Write-once
 * over that absence meant a head audited during a capped hour could NEVER
 * pass, because the only row it would ever have said "could not run". A later
 * REAL verdict therefore replaces it, in either direction: an Opus fallback
 * that approves opens the gate, and one that refuses shuts it just as firmly.
 * Any other existing verdict — APPROVED or REFUSED — still stands forever.
 */
export const internalRecordAudit = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    verdict: v.string(),
    text: v.string(),
    model: v.optional(v.string()),
    /** Why a stand-in auditor answered ("codex-cap"), when one did. */
    fallback: v.optional(v.string()),
    url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const key = commitKey(args.repo, args.sha);
    const existing = await rowFor(ctx, AUDIT_VERDICT, key);
    const recorded = (existing?.data as { verdict?: unknown } | undefined)?.verdict;
    const recordedVerdict = typeof recorded === "string" ? recorded.toUpperCase() : null;
    if (existing && recordedVerdict !== AUDIT_UNAVAILABLE) {
      return { existing: true, verdict: typeof recorded === "string" ? recorded : null };
    }
    // The row that replaces an UNAVAILABLE is a NEW row, not an edit: the
    // failed attempt stays in the event log (mergeGateFor reads the newest row
    // for the key), so the record still says the audit was unreachable first.
    const verdict = args.verdict.toUpperCase();
    if (existing && verdict === AUDIT_UNAVAILABLE) {
      // A second "could not run" adds nothing but a row.
      return { existing: true, verdict: typeof recorded === "string" ? recorded : null };
    }
    const text = capUtf8(redactSecrets(args.text), AUDIT_TEXT_MAX_BYTES);
    await logEvent(ctx, AUDIT_VERDICT, undefined, { ...args, verdict, text }, key);
    return { existing: false, verdict, replaced: existing !== null };
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
