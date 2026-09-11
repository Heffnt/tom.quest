// THE AUDIT STEP — the merge gate's second check (Tom, 2026-09-09).
//
// Merging is mechanical when three things hold for the exact commit being
// merged: the tests are green, an AUDIT APPROVED IT, and the evals found no
// regression. The first is CI's own result and the third is the evals runner's;
// this file is the second. It runs a different model family over the diff —
// Codex by default, because a second opinion from the family that did not
// write the code is the point — and posts the answer to POST /tts/audit, where
// convex/ttsMerge.ts reads the one `VERDICT:` line out of it.
//
// THE VERDICT IS ONE LINE, ALONE ON ITS LINE, and everything else in the answer
// is prose for whoever reads the row later. `VERDICT: APPROVED` opens the gate;
// any other word does not, and is recorded as what it said — an audit that
// refused and an audit that never ran are different facts, and the gate's deny
// message says which it found.
//
// Plain Node ESM, zero npm dependencies (tts-lib.mjs's rule). Installed to
// /opt/tts by worker/setup.sh; the command an agent types is
// worker/bin/tts-audit.
import { execFileSync } from "node:child_process";

import { convexFetch, loadEnv } from "./tts-lib.mjs";

/** The wrapper every Codex door on the box goes through (AGENTS.md: one home
 *  for the flags and the stdout contract). */
export const AUDIT_RUNNER = process.env.TTS_CODEX_BIN || "/usr/local/bin/tts-codex";

/** Read-only, always: an audit that can edit the tree it is judging is not an
 *  audit. The effort is the wrapper's default (the fleet's strongest). */
export const AUDIT_SANDBOX = "read-only";

/** How much diff the auditor is given. A change larger than this is not
 *  refused — the auditor is told the diff was cut, and an auditor told it is
 *  looking at part of a change approves at its own discretion. */
export const AUDIT_DIFF_MAX_CHARS = 200_000;

/** The line the gate reads. Exported so the prompt and the parser cannot drift
 *  apart: the prompt below asks for exactly this shape. */
export const AUDIT_VERDICT_LINE = "VERDICT: APPROVED";

/** The audit's own answer, unparsed, when the runner could not be reached. A
 *  failed audit is NOT an approval and not silence either: it is posted as
 *  UNAVAILABLE, so the row says the audit ran and could not finish. */
export const AUDIT_UNAVAILABLE = "UNAVAILABLE";

/**
 * What the auditor is asked. It judges ONE QUESTION — is this change safe to
 * land on the default branch — and is told what it must not do with it: an
 * audit is not a code review that asks for polish, and a merge gate that
 * refuses on taste never opens.
 */
export function auditPrompt({ repo, sha, base, subject, diff, truncated }) {
  return [
    `You are auditing one change before it merges to the default branch of ${repo}.`,
    "",
    `The commit: ${sha}`,
    base ? `Its base: ${base}` : "Its base is the default branch as it stands.",
    subject ? `What it claims to do: ${subject}` : "",
    "",
    "THE ONE QUESTION: would landing this on the default branch break something,",
    "or do something nobody asked for? Approve unless you can name a concrete",
    "problem in the diff — a bug, a boundary crossed, a secret, a deletion of",
    "something still used, a change wider than what it claims to do, a test",
    "weakened or removed to make a failure go away.",
    "",
    "NOT your question: whether the code could be nicer, shorter, differently",
    "structured, better named, or more like the way you would have written it.",
    "A gate that refuses on taste never opens, and this gate is the whole",
    "difference between a branch that lands and a branch that waits for a human.",
    "",
    truncated
      ? "THE DIFF BELOW IS CUT: it was larger than this audit takes. Judge what you can see and say in your answer that you saw only part of the change."
      : "",
    "",
    "Answer in this shape, and put the verdict LINE ON ITS OWN, exactly:",
    "",
    `${AUDIT_VERDICT_LINE}`,
    "",
    "or",
    "",
    "VERDICT: REFUSED",
    "",
    "…followed by a short paragraph. When you refuse, the paragraph names the",
    "concrete problem and where it is. Write the verdict line NOWHERE ELSE in",
    "your answer, not even quoted.",
    "",
    "The diff, verbatim between the markers:",
    "<<<DIFF",
    diff,
    "DIFF>>>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The change under audit, as `git diff` sees it. Cut at
 *  AUDIT_DIFF_MAX_CHARS; the prompt says so when it was. */
export function diffOf(dir, sha, base, run = defaultRun) {
  const range = base ? `${base}..${sha}` : `${sha}~1..${sha}`;
  const text = run("git", ["-C", dir, "diff", "--no-color", range]);
  return text.length > AUDIT_DIFF_MAX_CHARS
    ? { diff: text.slice(0, AUDIT_DIFF_MAX_CHARS), truncated: true }
    : { diff: text, truncated: false };
}

function defaultRun(command, args) {
  return String(
    execFileSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
}

/**
 * Audit one commit and record the verdict. Answers
 * `{ verdict, text, recorded }`; the caller decides what to do with a refusal,
 * because the gate does — this never merges anything itself.
 *
 * `io` carries every side effect so the test drives it with no model, no git
 * and no network.
 */
export async function auditCommit(
  { repo, sha, base = null, subject = "", dir = "." },
  suppliedIo = {},
) {
  const io = {
    run: defaultRun,
    env: () => loadEnv({ require: ["CONVEX_SITE_URL", "TTS_WORKER_KEY"] }),
    // THE PROMPT GOES ON STDIN, never in argv. tts-codex forwards its argv
    // straight to scripts/codex-run.mjs, whose arg loop refuses anything that
    // is not one of its flags — a positional prompt was rejected as an unknown
    // option, readStdin() then found nothing, and every audit was recorded
    // UNAVAILABLE. codex-run reads the prompt from stdin and nowhere else.
    audit: (prompt) =>
      String(
        execFileSync(AUDIT_RUNNER, ["--cwd", dir, "--sandbox", AUDIT_SANDBOX, "--no-operate"], {
          input: prompt,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, TTS_RUN_ORIGIN: "cron:audit" },
        }),
      ),
    post: (env, body) => convexFetch(env, "/tts/audit", body),
    ...suppliedIo,
  };
  let text;
  try {
    const { diff, truncated } = diffOf(dir, sha, base, io.run);
    if (diff.trim() === "") {
      text = `VERDICT: REFUSED\n\nThere is no diff between ${base ?? `${sha}~1`} and ${sha}: there is nothing to audit, and an audit of nothing is not an approval.`;
    } else {
      text = String(
        io.audit(auditPrompt({ repo, sha, base, subject, diff, truncated })) ?? "",
      );
    }
  } catch (error) {
    // An auditor that could not run is recorded as one, never skipped: a
    // missing row and a refusal are different facts to the gate, and this is
    // neither an approval nor a silence.
    text = `VERDICT: ${AUDIT_UNAVAILABLE}\n\nThe audit could not run: ${String(error?.message ?? error).slice(0, 300)}`;
  }
  const env = io.env();
  const recorded = await io.post(env, { repo, sha, text, model: "codex" });
  return { verdict: recorded?.verdict ?? null, text, recorded };
}
