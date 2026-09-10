// THE MECHANICAL MERGE GATE, the box half (Tom, 2026-09-09).
//
// Merging was the one thing an autonomous session could not do: the Bash
// classifier's prompt denied it outright and said "merging is Tom's gate". His
// ruling is that merging is MECHANICAL — tests green, an audit approving the
// head, evals with no regression — so the daemon checks those three itself and
// allows the command when they hold. Convex holds the three facts and answers
// GET /tts/merge-gate; convex/ttsMerge.ts is their one home and says why each
// is what it is.
//
// This file is the PURE half: which commands are merges, which checkout a
// merge is about, and what the session is told when the gate refuses. It
// imports nothing, so it is unit-tested without the Agent SDK the daemon
// needs — the banned-tools.mjs pattern.

/**
 * A merge command. Both spellings Tom named, and `git -C <dir> merge` as well,
 * because that is the form a multi-repo session has to use.
 *
 * ANCHORED at the start. A merge that is one clause of a longer line is
 * refused rather than parsed: the daemon has to be able to say which commit it
 * checked, and a command whose earlier clauses can move HEAD does not have one
 * answer to that. `mergeCommandOf` is what enforces that; this only matches.
 */
export const MERGE_CMD_RE = /^\s*(?:git\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)\s+)*merge\b|gh\s+pr\s+merge\b)/;

/** The same shell control operators tier 1 refuses to fast-path past. */
export const MERGE_CHAIN_RE = /[\n;&|`]|\$\(/;

/** `git -C <dir>` — the directory a merge names for itself, if it names one. */
const GIT_C_RE = /\bgit\s+-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))/;

/**
 * Whether this Bash command is a merge the gate must rule on, and if so which
 * checkout it is about.
 *
 * Answers one of:
 *   null                      — not a merge; the ordinary tiers apply
 *   { chained: true }         — a merge inside a longer command line
 *   { repo, dir }             — a lone merge, and where to read HEAD
 *   { ambiguous: true }       — a lone merge in a session holding several
 *                               checkouts, with no `git -C` to say which
 *
 * `checkouts` is the daemon's [{ repo, dir }] list and `workdir` its working
 * directory; a session with one checkout has workdir === that checkout's dir.
 */
export function mergeCommandOf(command, { checkouts = [], workdir = null } = {}) {
  const text = String(command ?? "");
  if (!MERGE_CMD_RE.test(text)) return null;
  // Single-quoted spans are stripped before the chaining test for tier 1's
  // reason: a commit message may legitimately contain a semicolon.
  if (MERGE_CHAIN_RE.test(text.replace(/'[^']*'/g, ""))) return { chained: true };

  const named = GIT_C_RE.exec(text);
  const dir = named === null ? null : (named[1] ?? named[2] ?? named[3]);
  if (dir !== null) {
    const hit = checkouts.find((checkout) => checkout.dir === dir);
    return hit ? { repo: hit.repo, dir: hit.dir } : { repo: null, dir };
  }
  if (checkouts.length === 1) return { repo: checkouts[0].repo, dir: checkouts[0].dir };
  if (checkouts.length === 0) return { repo: null, dir: workdir };
  return { ambiguous: true };
}

/** What a session is told when its merge is one clause of a longer line. */
export const MERGE_CHAINED_DENIAL =
  "denied: run a merge as its own command. The merge gate reads the commit at HEAD before it allows the merge, and a line that does anything else first has no one commit to check.";

/** What a session holding several checkouts is told. */
export const MERGE_AMBIGUOUS_DENIAL =
  "denied: this session holds more than one checkout, so name the repository — `git -C <checkout dir> merge …`. The merge gate has to know which commit it is checking.";

/** What a session is told when the gate itself could not be read. FAIL-CLOSED,
 *  unlike the classifier, which fails open: a classifier that stumbles costs a
 *  denied command, and a merge gate that stumbles open costs a merge nobody
 *  looked at. */
export function mergeUnreadableDenial(reason) {
  return `denied: the merge gate could not be read (${reason}), and a merge is not allowed on an unread gate. Say so in your outcome; the merge is still there to make once the gate answers.`;
}

/** What a session is told when one or more of the three checks is not met.
 *  Names them, and says how each is satisfied, so the session can finish the
 *  work rather than retry the command. */
export function mergeDenial(gate) {
  const missing = Array.isArray(gate?.missing) ? gate.missing : [];
  const why = (Array.isArray(gate?.checks) ? gate.checks : [])
    .filter((check) => !check.passed)
    .map((check) => `${check.name}: ${check.why}`)
    .join("; ");
  return (
    `denied by the merge gate — missing ${missing.join(", ") || "every check"}. ` +
    `${why}. A merge is allowed once all three are on record: the tests green ` +
    `(the Guardrails tests job posts its result), an audit approving this exact ` +
    `commit (VERDICT: APPROVED, posted to /tts/audit), and an evals run at this ` +
    `commit with no regression. Finish the missing one, or leave the branch for ` +
    `the next session and say so in your outcome.`
  );
}

/** The transcript row for a merge the gate allowed. A merge is the one
 *  irreversible act a session takes, so it is always visible, and the row says
 *  WHY it was allowed rather than only that it was. */
export function mergeAllowedRow(gate) {
  const why = (Array.isArray(gate?.checks) ? gate.checks : [])
    .map((check) => check.why)
    .join("; ");
  return `merge gate passed for ${gate?.repo ?? "the repo"} ${String(gate?.sha ?? "").slice(0, 7)} — ${why}`;
}
