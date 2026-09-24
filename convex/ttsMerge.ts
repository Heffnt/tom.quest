import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { logEvent } from "./tts";
import {
  answeredEvalsRun,
  COVERAGE_NOT_REQUIRED,
  EVALS_RUN,
  evalsProtocolStatus,
  evalsRequestFor,
} from "./ttsEvals";
import { commitKey, mergeKey, SESSION_REPOS } from "./ttsShared";
import { redactSecrets } from "../shared/redact.mjs";

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
// FOR NOW THE GATE OPENS ON TWO OF THE THREE (Tom, 2026-09-24). The evals row
// is still read and still reported in `checks`, with its `passed` and its
// `why`, so the digest, the pages and the #tts-decisions merge line show it;
// it is not counted in `allowed` or in `missing` while EVALS_REQUIRED_FOR_MERGE
// below is false.
//
// FAIL-CLOSED, and deliberately unlike the Bash classifier, which fails open:
// a missing row is a check that did not pass. Guessing wrong here costs a
// merge nobody looked at; guessing wrong the other way costs a branch that
// waits, and a branch that waits is visible.

/** Whether the evals row must pass for the gate to open. Tom, 2026-09-24:
 *  "evals seem to be broken rn so lets remove that requirement for merging for
 *  now until I have the time to personally look into it." The evals arm had
 *  failed closed for every pull request because the box's Claude account was
 *  out of Fable usage and the Fable judge could not answer. Restoring the
 *  requirement is setting this to true; nothing else changes. */
export const EVALS_REQUIRED_FOR_MERGE = false;

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
/** The heading the audit files its removal-check findings under
 *  (worker/jobs/audit.mjs AUDIT_REMOVAL_HEADING asks for this exact word). */
export const AUDIT_REMOVAL_HEADING = "REMOVAL CHECK:";
/** How many findings and how much of each are kept. A row is a record, not the
 *  audit's whole answer: the text it came out of is already on the row.
 *
 *  ONE PAIR OF NUMBERS FOR BOTH LISTS the audit row carries — the removal
 *  check's findings and the trace check's (`traceFindings` below) — and for the
 *  one line a counted absence carries (`trace.reason`). They mean the same
 *  thing in all three places: a finding is one line for a person to read, and a
 *  row that grew without a ceiling is a row nobody reads at all. Two numbers
 *  named for the removal check and two more named for the trace check would be
 *  four numbers that have to agree, which is three more than the fact needs.
 *  If they ever genuinely need to differ, that is the moment to split them. */
export const AUDIT_REMOVAL_NOTES_MAX = 20;
export const AUDIT_REMOVAL_NOTE_MAX_CHARS = 300;

/** The key every fact ABOUT ONE COMMIT is filed under — the spelling
 *  convex/ttsEvals.ts already uses for an evals run, so all three checks are
 *  the same lookup. */
// Both keys moved to ./ttsShared, which convex/ttsEvals.ts already imports;
// they are re-exported here so every existing reader of this module keeps
// working and there is still exactly one definition.
export { commitKey, mergeKey } from "./ttsShared";

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

/**
 * The audit's removal check: every case, flag or check the diff ADDS whose
 * change does not say why the thing it patches cannot be deleted instead
 * (worker/jobs/audit.mjs asks the question; the operate rule is what the agent
 * writing the diff read first).
 *
 * ANCHORED, like the verdict line and for the same reason: a heading quoted
 * inside the prose ("say REMOVAL CHECK: none when there are none") is not the
 * heading. `none` on the heading line answers the question with nothing to
 * report, which is not the same fact as an audit that never answered it — both
 * come back as an empty list here, and the audit text on the row is where the
 * difference is still readable.
 *
 * The list ends at a blank line or at the first line that is not a bullet,
 * because the audit's paragraph follows it and a paragraph is not a finding.
 *
 * THE GATE DOES NOT READ THIS. §23.8: the gate keeps its three head rows, and a
 * fourth condition goes inside a check that already runs rather than beside it.
 * A branch that adds an early return with no argument against deleting what it
 * patches still merges; the finding is on the row for whoever reads it and for
 * the weekly simplification pass.
 */
export function removalNotesOf(text: string): string[] {
  const heading = new RegExp(`^[ \\t]*${AUDIT_REMOVAL_HEADING}[ \\t]*(.*)$`, "im").exec(text);
  if (heading === null) return [];
  if (heading[1].trim().toLowerCase() === "none") return [];
  const after = text.slice(heading.index + heading[0].length).split(/\r?\n/).slice(1);
  const notes: string[] = [];
  for (const line of after) {
    if (notes.length >= AUDIT_REMOVAL_NOTES_MAX) break;
    const bullet = /^[ \t]*-[ \t]+(.*\S)[ \t]*$/.exec(line);
    if (bullet === null) break;
    notes.push(bullet[1].trim().slice(0, AUDIT_REMOVAL_NOTE_MAX_CHARS));
  }
  return notes;
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

/**
 * A count at the magnitude a person reads it: `4,120`, `812 K`, `1.4 M`.
 *
 * The audit's character counts run to seven digits, and `1437221 of 1437221
 * characters` in a sentence Tom reads is two numbers he has to count the digits
 * of to compare. Grouped below ten thousand, because that is where the digits
 * are still worth having; scaled above it, because past that the magnitude IS
 * the fact and the last four digits are noise.
 *
 * `toLocaleString` is not used: the grouping has to be the same string in the
 * Convex runtime, in vitest and in whatever locale a box happens to carry, and
 * a separator that moves is a number that reads differently in the morning
 * message than in the test that pinned it.
 */
export function compactCount(n: unknown): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "?";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const group = (value: string) => value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (abs < 10_000) return sign + group(String(Math.round(abs)));
  const [scale, unit] = abs < 1_000_000 ? ([1_000, "K"] as const) : ([1_000_000, "M"] as const);
  const scaled = abs / scale;
  // One decimal only while it still says something: 1.4 M is a different size
  // from 1 M, 812.3 K is not a different size from 812 K.
  const shown = scaled < 100 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
  const [whole, fraction] = String(shown).split(".");
  return `${sign}${group(whole)}${fraction === undefined ? "" : `.${fraction}`} ${unit}`;
}

/**
 * HOW MUCH OF THE DIFF THE AUDIT ACTUALLY READ, as one clause of the sentence
 * Tom reads: "12 of 12 chunks, 1.4 M of 1.4 M characters".
 *
 * Why it exists: worker/jobs/audit.mjs used to cut the diff at 200,000
 * characters and tell the auditor it had been cut. On 2026-09-11 the Opus
 * auditor approved a ~30,000-line integration diff having read a slice of it,
 * and THE ROW RECORDED NOTHING ABOUT HOW MUCH IT SAW — the verdict and the
 * coverage were indistinguishable on the record from an audit that read every
 * line. The audit now reads the whole diff in chunks; this is the part that
 * makes what it read legible afterwards, in the gate's own answer and therefore
 * in the #tts-decisions merge line, which joins these `why` strings.
 *
 * AN AUDIT THAT REFUSED AFTER 3 OF 12 CHUNKS IS AS INTERESTING AS ONE THAT
 * APPROVED AFTER 12, so the clause rides the detail both arms carry, not the
 * approval arm.
 *
 * EVERY FIELD IS READ DEFENSIVELY. `data` is `v.any()` coming back out, so a
 * row whose `chunks` is a string, a null, or an object missing a number renders
 * as if it carried none rather than printing half a sentence. An older row
 * carries no `chunks` at all and must render exactly as it did before this
 * clause existed — that is the same answer, and it is why this returns the
 * empty string rather than a placeholder.
 */
export function auditChunkNote(data: { chunks?: unknown }): string {
  const chunks = data.chunks;
  if (typeof chunks !== "object" || chunks === null) return "";
  const row = chunks as Record<string, unknown>;
  const num = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  const count = num(row.count);
  const read = num(row.read);
  const charsRead = num(row.charsRead);
  const charsTotal = num(row.charsTotal);
  if (count === null || read === null || charsRead === null || charsTotal === null) return "";
  return (
    `${compactCount(read)} of ${compactCount(count)} chunk${count === 1 ? "" : "s"}, ` +
    `${compactCount(charsRead)} of ${compactCount(charsTotal)} characters`
  );
}

/**
 * What a PASSED check is, for each of the three kinds, in one place. The gate
 * below computes its three `passed` booleans with this, and convex/ttsSimplify.ts
 * counts how often a check has failed with it: two copies of this predicate is
 * one of them wrong, and the wrong one would be the copy that decides whether a
 * branch merges.
 *
 * An unknown kind is false, not an error, for the same reason the gate is
 * fail-closed: a row nobody taught this function about has not passed anything.
 */
export function checkRowPassed(kind: string, data: unknown): boolean {
  const row = (data ?? {}) as { ok?: unknown; verdict?: unknown; regressions?: unknown };
  if (kind === TESTS_RUN) return row.ok === true;
  if (kind === AUDIT_VERDICT) return String(row.verdict).toUpperCase() === AUDIT_APPROVED;
  if (kind === EVALS_RUN) return row.regressions === 0;
  return false;
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

/** The bounded part of the `tests-run` row the worker needs before it audits.
 * The merge gate already reads this exact row; carrying its three declared
 * data fields in the GET response avoids a second record door and does not
 * add another condition to the gate. */
type TestsRunRecord = {
  ok: boolean | null;
  detail?: string;
  url?: string;
};

export type MergeGateResult = {
  repo: string;
  sha: string;
  /** The head's recorded test result, or null when the fail-closed row is absent. */
  testsRun: TestsRunRecord | null;
  allowed: boolean;
  /** Every check, required or not, in gate order. */
  checks: MergeCheck[];
  /** The names of the REQUIRED checks that did not pass, in gate order. The
   *  evals check is not among them while EVALS_REQUIRED_FOR_MERGE is false. */
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
  const testsData = (tests?.data ?? {}) as { ok?: unknown; detail?: unknown; url?: unknown };
  const testsRun: TestsRunRecord | null = tests === null
    ? null
    : {
        ok: typeof testsData.ok === "boolean" ? testsData.ok : null,
        ...(typeof testsData.detail === "string" ? { detail: testsData.detail } : {}),
        ...(typeof testsData.url === "string" ? { url: testsData.url } : {}),
      };
  const testsCheck: MergeCheck =
    tests === null
      ? { name: "tests", passed: false, why: `no tests result is recorded for ${short}` }
      : checkRowPassed(TESTS_RUN, testsData)
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
    chunks?: unknown;
  };
  // The WORD is still read here, because the deny message names what the audit
  // answered; whether that word opens the gate is checkRowPassed's to say.
  const verdict = typeof auditData.verdict === "string" ? auditData.verdict.toUpperCase() : null;
  const auditWhy = auditReason(auditData.text);
  // The audit's reason and HOW MUCH OF THE DIFF IT READ, in the one detail
  // clause both arms already carried. Appending to `auditDetail` rather than
  // adding a second slot is what makes the coverage ride the refusal as well as
  // the approval, and what keeps it out of the merge line's shape: that line
  // joins these `why` strings, so it gets the clause for free.
  //
  // Nothing here is a condition. `chunks.read < chunks.count` still passes the
  // audit arm exactly as it did — checkRowPassed reads the verdict and nothing
  // else, and this file adds no fourth check to the three head rows.
  const auditDetail = [auditWhy, auditChunkNote(auditData)]
    .filter((clause): clause is string => typeof clause === "string" && clause !== "")
    .map((clause) => ` — ${clause}`)
    .join("");
  // A fallback audit is a WEAKER audit and says so wherever it is read: the
  // point of the check is a family that did not write the code, and at Codex's
  // weekly cap it was Opus that answered. The note rides the `why`, so the
  // gate's answer and the #tts-decisions merge line (which joins these whys)
  // both carry it and Tom can object to a same-family audit.
  const byWhom = auditFallbackNote(auditData);
  const auditCheck: MergeCheck =
    audit === null
      ? { name: "audit", passed: false, why: `no audit verdict is recorded for ${short}` }
      : checkRowPassed(AUDIT_VERDICT, auditData)
        ? { name: "audit", passed: true, why: `the audit approved ${short}${byWhom}${auditDetail}` }
        : {
            name: "audit",
            passed: false,
            why: `the audit answered ${verdict ?? "nothing readable"} at ${short}${byWhom}, not ${AUDIT_APPROVED}${auditDetail}`,
          };

  // THROUGH THE STALENESS RULE, not straight off the newest row. A row that
  // scored nothing answers only the request it was written for (convex/
  // ttsEvals.ts answeredRun), and this is the reader where getting that wrong
  // opens the gate instead of merely delaying a run.
  const evals = await answeredEvalsRun(ctx, repo, sha);
  const pendingEvalsRequest = evals === null
    ? await evalsRequestFor(ctx, repo, sha)
    : null;
  const protocol = pendingEvalsRequest === null ? null : await evalsProtocolStatus(ctx);
  const evalsData = (evals?.data ?? {}) as {
    regressions?: unknown;
    goldenCoverage?: unknown;
    items?: unknown;
    pass?: unknown;
    error?: unknown;
    reason?: unknown;
    errored?: unknown;
  };
  const regressions = typeof evalsData.regressions === "number" ? evalsData.regressions : null;
  const errored = typeof evalsData.errored === "number" && evalsData.errored > 0
    ? evalsData.errored
    : null;
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
  //
  // `not-required` IS AN ANSWER AND OPENS. It is the row an unaffected branch
  // gets: the check read its own diff, nothing in it was a watched path, and
  // the door recorded that instead of asking for a fifty-minute run of a set
  // this change cannot move. The distinction from `true` is kept because the
  // two are different facts — one says the branch paid for a context change,
  // the other says there was none — and the `why` below says which.
  const coverage =
    typeof evalsData.goldenCoverage === "boolean" ||
    evalsData.goldenCoverage === null ||
    evalsData.goldenCoverage === COVERAGE_NOT_REQUIRED
      ? evalsData.goldenCoverage
      : undefined;
  const scored =
    typeof evalsData.pass === "number" && typeof evalsData.items === "number"
      ? ` (${evalsData.pass} of ${evalsData.items} pass)`
      : "";
  const evalsUnavailable = evalsData.error === true ||
    (typeof evalsData.error === "string" && evalsData.error !== "");
  const evalsReason = typeof evalsData.reason === "string" && evalsData.reason !== ""
    ? evalsData.reason
    : typeof evalsData.error === "string" && evalsData.error !== "" ? evalsData.error : "runner failed";
  const evalsCheck: MergeCheck =
    pendingEvalsRequest !== null && protocol !== null && protocol.protocolGap !== null
      ? { name: "evals", passed: false, why: protocol.protocolGap }
    : pendingEvalsRequest !== null
      ? { name: "evals", passed: false, why: `the evals are being scored again at ${short}` }
    : evals === null
      ? { name: "evals", passed: false, why: `no evals run scored ${short}` }
      : evalsUnavailable
        ? { name: "evals", passed: false, why: `the evals could not run at ${short}: ${evalsReason}` }
      : errored !== null
        ? {
            name: "evals",
            passed: false,
            why: `the evals run at ${short} had ${errored} runner error${errored === 1 ? "" : "s"}`,
          }
      // `regressions !== 0` spelled with the one predicate the gate and
      // convex/ttsSimplify.ts share: a second copy is how the two come apart.
      : !checkRowPassed(EVALS_RUN, evalsData)
        ? {
            name: "evals",
            passed: false,
            why: `the evals found ${regressions ?? "an unreadable number of"} regression${
              regressions === 1 ? "" : "s"
            } at ${short}`,
          }
        : coverage === COVERAGE_NOT_REQUIRED
          ? {
              name: "evals",
              passed: true,
              // THE SAME WORDS the check's own log prints (scripts/
              // evals-check.mjs report()), and the #tts-decisions merge line
              // joins these whys — so the CI log, the gate and Tom's Slack all
              // say one thing about this commit.
              why: `the evals are unaffected at ${short}: no watched path changed`,
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
  // Every check is reported; only the required ones open or shut the gate.
  const required = EVALS_REQUIRED_FOR_MERGE ? checks : [testsCheck, auditCheck];
  return {
    repo,
    sha,
    testsRun,
    allowed: required.every((check) => check.passed),
    checks,
    missing: required.filter((check) => !check.passed).map((check) => check.name),
  };
}

/** What the box asks before it lets a merge command run
 *  (worker/session-host/session.mjs). Read-only: it opens nothing by itself. */
export const internalMergeGate = internalQuery({
  args: { repo: v.string(), sha: v.string() },
  handler: async (ctx, { repo, sha }): Promise<MergeGateResult> =>
    await mergeGateFor(ctx, repo, sha),
});

// ── HOW LONG THE CHECKS TOOK, AND WHEN THAT IS NEWS ──────────────────────────
// Tom's ruling (2026-09-22): quality is never traded for speed or cost, and a
// useful test is never left unwritten because the suite is slow. The answer to
// a slow suite is dedicated effort on speed at constant quality — and the
// trigger for that effort is a WARNING WHEN A THRESHOLD IS CROSSED, not a
// judgement anybody has to remember to make.
//
// SO NOTHING HERE FAILS ANYTHING. The thresholds are read after the row is
// recorded, on a fact that has already happened, and the only thing they can do
// is write one "job-failed" row — the channel the morning digest and the hourly
// update already read (convex/ttsJobs.ts). A time check that could fail a build
// would be a fourth condition on the merge gate, which §23.8 refuses, and it
// would trade quality for speed in exactly the direction the ruling forbids.
//
// IT LIVES IN CONVEX RATHER THAN IN CI for two reasons. CI holds the narrow
// evals key and POST /tts/job-failed takes the worker key, so a warning written
// from the workflow would mean widening a credential's reach to say a suite is
// slow. And a threshold spelled in a workflow is a threshold nothing tests: the
// row is already here, and so is the reporting.

/** The `tests` job's wall time above which the run is worth a word. */
export const TESTS_JOB_SLOW_SECONDS = 5 * 60;
/** The whole vitest suite's own wall time above which it is. */
export const SUITE_SLOW_SECONDS = 10 * 60;
/** The job name every timing warning is filed under, and the two conditions it
 *  reports. KEYED, so a suite that has been slow for a week is one row rather
 *  than one per push (convex/ttsJobs.ts), and a run back under the threshold
 *  writes the recovery that re-arms it. */
const TESTS_SLOW_JOB = "guardrails";
export const TESTS_JOB_SLOW_KEY = "guardrails:tests-slow";
export const SUITE_SLOW_KEY = "guardrails:suite-slow";

type TestsTiming = {
  durations?: Record<string, number>;
  mode?: string;
  slowest?: { file: string; seconds: number }[];
};

/** The slowest files, as the one clause a warning ends with. A number with no
 *  names is a number nobody can act on, and acting on it is the point. */
function slowestClause(slowest: TestsTiming["slowest"]): string {
  if (!Array.isArray(slowest) || slowest.length === 0) return "";
  return ` — slowest: ${slowest
    .slice(0, 5)
    .map((entry) => `${entry.file} ${entry.seconds}s`)
    .join(", ")}`;
}

/**
 * The two thresholds, against one run's durations. Answers a row per condition
 * — `{ key, crossed, error }` — so the caller reports the crossed ones and
 * recovers the rest with one pass and no second spelling of either key.
 *
 * The suite threshold is asked only of a FULL run. A related-mode run that took
 * ten minutes crossed the five-minute job threshold seven minutes earlier, and
 * one slow run should arrive as one sentence.
 */
export function slowConditions(timing: TestsTiming): {
  key: string;
  crossed: boolean;
  error: string;
}[] {
  const durations = timing.durations ?? {};
  const rows: { key: string; crossed: boolean; error: string }[] = [];
  const job = durations.tests;
  if (typeof job === "number" && job > 0) {
    rows.push({
      key: TESTS_JOB_SLOW_KEY,
      crossed: job > TESTS_JOB_SLOW_SECONDS,
      error:
        `the tests job took ${Math.round(job)}s, over the ${TESTS_JOB_SLOW_SECONDS}s threshold` +
        slowestClause(timing.slowest),
    });
  }
  const suite = durations.suite;
  if (timing.mode === "full" && typeof suite === "number" && suite > 0) {
    rows.push({
      key: SUITE_SLOW_KEY,
      crossed: suite > SUITE_SLOW_SECONDS,
      error:
        `the full suite took ${Math.round(suite)}s, over the ${SUITE_SLOW_SECONDS}s threshold` +
        slowestClause(timing.slowest),
    });
  }
  return rows;
}

/** The Guardrails run's own result, at the end of it. Recorded
 *  ONCE per commit: a rerun of the same sha keeps the first answer, so a red
 *  run cannot be turned green by pressing re-run until it flakes through.
 *
 *  THE TIMING IS READ EVERY TIME, including on a rerun the row already answers.
 *  Write-once is a rule about the VERDICT on one commit, which must not move;
 *  how long today's run took is a fact about today's run, and the nightly full
 *  suite on an already-recorded main sha is precisely the run whose duration
 *  there would otherwise be no way to hear about. */
export const internalRecordTests = internalMutation({
  args: {
    repo: v.string(),
    sha: v.string(),
    ok: v.boolean(),
    detail: v.optional(v.string()),
    url: v.optional(v.string()),
    /** Which scope the tests job ran — "full" or "related"
     *  (scripts/tests-affected.mjs) — and how many changed files chose it. A
     *  green related-mode row is a narrower fact than a green full one, so the
     *  row says which it is rather than leaving a reader to open the run. */
    mode: v.optional(v.string()),
    files: v.optional(v.number()),
    /** Seconds per Guardrails job, by the job's own name, plus `suite` for the
     *  vitest run inside the tests job. */
    durations: v.optional(v.record(v.string(), v.number())),
    slowest: v.optional(v.array(v.object({ file: v.string(), seconds: v.number() }))),
  },
  handler: async (ctx, args) => {
    const key = commitKey(args.repo, args.sha);
    const existing = await rowFor(ctx, TESTS_RUN, key);
    for (const condition of slowConditions(args)) {
      if (condition.crossed) {
        await ctx.runMutation(internal.ttsJobs.internalReportJobFailed, {
          job: TESTS_SLOW_JOB,
          error: condition.error,
          key: condition.key,
        });
      } else {
        await ctx.runMutation(internal.ttsJobs.internalReportJobOk, {
          job: TESTS_SLOW_JOB,
          key: condition.key,
        });
      }
    }
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
 *
 * The removal check's findings are read out of that same answer and filed
 * beside it. The gate is unchanged by them: they are read by whoever opens
 * the row and by the weekly simplification pass.
 *
 * SO IS WHAT THE AUDIT SAW AND WHETHER ITS OWN CLAIMS ARE TRUE. On 2026-09-11
 * the auditor approved a ~30,000-line diff having read the first 200,000
 * characters of it, and the row said nothing about that — the record could not
 * tell a full read from a slice. `chunks` is the coverage and `traceFindings`
 * are the audit's claims checked against its run record. They live HERE, on the
 * audit row, for the same reason `removalNotes` does: the audit is the verifier
 * that READS A CHANGE, and whether the audit's own claims are true is part of
 * what the audit answered. One home is one redaction path and one cap; a fourth
 * table would be a fourth thing to redact and a fourth thing to forget to.
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
    /**
     * How much of the diff the audit actually read. `read` is how many chunks
     * came back with a parseable verdict, `count` how many there were.
     *
     * THE GATE DOES NOT READ ANY OF IT: checkRowPassed asks the audit row for
     * its verdict and nothing else, and a head whose audit read 1 of 12 chunks
     * still passes the audit arm. This is a RECORD, not a condition — the third
     * thing on this row (with `removalNotes` and `traceFindings`) that is there
     * to be read rather than to decide. The clause it puts in the gate's `why`
     * (auditChunkNote) is what makes a thin read visible to Tom in the merge
     * line, which is where an objection belongs.
     *
     * OPTIONAL AND NEVER DEFAULTED: a row with no `chunks` is an audit recorded
     * before the diff was chunked at all, and that is a different fact from one
     * that read 0 of 12.
     */
    chunks: v.optional(
      v.object({
        count: v.number(),
        read: v.number(),
        charsRead: v.number(),
        charsTotal: v.number(),
        truncatedChunks: v.number(),
        files: v.number(),
      }),
    ),
    /**
     * The audit's own claims, checked against its run record: it said the tests
     * pass and no `tests-run` row exists; it said it opened a path its run never
     * opened; it did not read the whole diff; it changed a check in the same
     * commit as the thing that check guards.
     *
     * Capped and redacted exactly as `removalNotes` is, and to the same two
     * numbers — but NOT by the same route. `removalNotes` is derived from the
     * stored text, which was redacted and capped before it was read, so it
     * cannot say anything the row does not already say. THIS ARRIVES AS AN
     * ARGUMENT from the trace checker, so it has never been through the filter:
     * it is redacted HERE, on the way in, and that is the whole difference.
     */
    traceFindings: v.optional(v.array(v.string())),
    /**
     * THE COUNTED ABSENCE. `traceFindings: []` means the checks ran and found
     * nothing; `traceFindings: []` WITH `trace: { available: false, reason }`
     * means the audit's run record could not be read, so nothing was checked.
     * Those two must not print the same sentence, which is the posture
     * `regressions: null` already takes in the evals arm: "we did not check" is
     * never recorded as "we checked and it was clean".
     */
    trace: v.optional(v.object({ available: v.boolean(), reason: v.optional(v.string()) })),
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
    // The findings are read OUT OF THE TEXT THE ROW KEEPS, after the redaction
    // and the cap, so they cannot say anything the stored text does not and
    // they go through one redaction path rather than two — two is how one of
    // them comes to be forgotten. What that costs: an answer whose removal
    // check falls past 8 KiB loses its notes, and the verdict, which is read
    // before the cap, does not.
    const removalNotes = removalNotesOf(text);
    // The trace findings go through the SAME cap and the SAME filter, one step
    // later in the pipe: they never passed through the audit text, so this is
    // the only place they can be redacted at all.
    const traceFindings =
      args.traceFindings === undefined
        ? undefined
        : args.traceFindings
            .slice(0, AUDIT_REMOVAL_NOTES_MAX)
            .map((finding) => redactSecrets(finding).slice(0, AUDIT_REMOVAL_NOTE_MAX_CHARS));
    const trace =
      args.trace === undefined
        ? undefined
        : {
            available: args.trace.available,
            ...(args.trace.reason === undefined
              ? {}
              : {
                  reason: redactSecrets(args.trace.reason).slice(0, AUDIT_REMOVAL_NOTE_MAX_CHARS),
                }),
          };
    // AN ABSENT FIELD WRITES NO KEY. `...args` already leaves out what was never
    // sent, and the two conditional spreads put back only what was — so a row
    // with no `chunks` stays a pre-chunking audit rather than becoming one that
    // read 0 of 0, and a row with no `traceFindings` stays an audit nobody
    // traced rather than one that was traced and found nothing. Defaulting
    // either to a zero or an empty array is how the record forgets which of
    // those happened.
    await logEvent(
      ctx,
      AUDIT_VERDICT,
      undefined,
      {
        ...args,
        verdict,
        text,
        removalNotes,
        ...(traceFindings === undefined ? {} : { traceFindings }),
        ...(trace === undefined ? {} : { trace }),
      },
      key,
    );
    return { existing: false, verdict, replaced: existing !== null };
  },
});

/**
 * Whether GitHub shows `sha` merged into `repo`'s main branch, the one GitHub
 * names as its default (ComplexMultiTrigger's is master): on that branch
 * itself (it is at the sha or ahead of it), or the head of a pull request
 * merged into it.
 * The second is how a squash merge lands, where the head commit never reaches
 * main (worker/jobs/removal-loop.mjs merges that way).
 *
 * POST /tts/merge asks this before it records, because the record cannot be
 * corrected afterwards: a merge row is written once per sha, and a second
 * report returns the first. PR #196 was recorded at c4e73b5 on 2026-09-19 from
 * a merge command GitHub had refused; its real merge landed half an hour later
 * as 9f1096a, and that row stands. The three checks cannot catch this, since
 * they are about the commit and not about whether it was merged.
 *
 * Fail-closed like the gate: a GitHub that cannot be asked is a merge not
 * recorded, and the reporter can post again. ONE EXCEPTION, said in `why`:
 * a repository GitHub will not show the record's token at all (404 on the
 * repository itself; GITHUB_MIRROR_TOKEN does not cover WikiTom, see
 * convex/ttsSync.ts). Refusing there would leave every merge of that
 * repository with no row and no line to object to, which costs Tom more than
 * a row that says it was not checked; the row and its decisions line say so.
 */
export async function mergedOnMain(
  repo: string,
  sha: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ merged: boolean; why: string }> {
  const slug = (SESSION_REPOS as Record<string, string>)[repo];
  // Both values go into a GitHub URL: an unknown repo has no slug to ask
  // about, and a value that is not a sha (a branch name, a path) would ask
  // GitHub a different question than whether this commit merged.
  if (!slug) return { merged: false, why: `${repo} is not a repository the record knows` };
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { merged: false, why: `${sha} is not a commit sha` };
  const token = process.env.GITHUB_MIRROR_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tts-merge",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const ask = async (path: string) => {
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${slug}${path ? `/${path}` : ""}`, { headers });
      return { status: res.status, body: res.ok ? ((await res.json()) as unknown) : null };
    } catch {
      return { status: 0, body: null };
    }
  };
  const info = await ask("");
  // 404 only: GitHub answers a repository a token cannot see with 404, and a
  // 403 can be a rate limit, which must not pass as permission.
  if (info.status === 404) {
    return { merged: true, why: `not checked against GitHub: the record's token cannot read ${repo}` };
  }
  const main = (info.body as { default_branch?: unknown } | null)?.default_branch;
  if (typeof main !== "string" || main === "") {
    return { merged: false, why: `GitHub could not be asked for ${repo}'s main branch (status ${info.status})` };
  }
  const compare = await ask(`compare/${sha}...${encodeURIComponent(main)}`);
  const status = (compare.body as { status?: unknown } | null)?.status;
  // compare BASE...HEAD with main as the head: "ahead" means main has every
  // commit of the sha and more, "identical" that main is at it.
  if (status === "identical" || status === "ahead") return { merged: true, why: `${sha.slice(0, 7)} is on ${main}` };
  const pulls = await ask(`commits/${sha}/pulls`);
  const merged = Array.isArray(pulls.body)
    ? (pulls.body as { number?: unknown; merged_at?: unknown; base?: { ref?: unknown }; head?: { sha?: unknown } }[])
        // The pull request's HEAD, not any commit in it: GitHub lists every
        // pull request a commit belongs to, and an earlier commit of a
        // squash-merged one was never what merged.
        .find((pull) => typeof pull?.merged_at === "string" && pull.base?.ref === main &&
          typeof pull.head?.sha === "string" && pull.head.sha.toLowerCase().startsWith(sha.toLowerCase()))
    : undefined;
  if (merged) return { merged: true, why: `${sha.slice(0, 7)} is the head of pull request #${String(merged.number)}, merged into ${main}` };
  // A 404 from the comparison is GitHub not knowing the commit, which is an
  // answer (not merged); any other failure means it was not asked.
  if (compare.status !== 200 && compare.status !== 404) {
    return { merged: false, why: `GitHub could not be asked whether ${sha.slice(0, 7)} is on ${main} (status ${compare.status})` };
  }
  return { merged: false, why: `${sha.slice(0, 7)} is not on ${main} and belongs to no pull request merged into it` };
}

/**
 * POST /tts/merge writes exactly this event, and ONLY after the gate above
 * allows it (the tests and the audit, and the evals when
 * EVALS_REQUIRED_FOR_MERGE is true). A merge is reported for objection, never placed on the narrow
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
    // What GitHub said about the merge (mergedOnMain), kept on the row. The
    // one caller, POST /tts/merge, always has it.
    mainCheck: v.string(),
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
      { repo: args.repo, sha: args.sha, subject: args.subject, mainCheck: args.mainCheck },
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
      reason: [...gate.checks.map((check) => check.why), args.mainCheck].join("; "),
      refused: false,
    });
    return { recorded: true, id, existing: false, gate };
  },
});
