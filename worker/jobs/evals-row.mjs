/**
 * A ROW IS NOT A RUN. Three kinds of evals-run row score nothing: a branch
 * that touched no watched path (`unaffected`), a head a later push replaced
 * (`superseded`), and a sha the box could not fetch or check out (`error`).
 *
 * ONE SPELLING, imported by every reader that cares. Convex keeps these rows
 * out of merge evidence and weekly facts; the box keeps them out of baselines
 * and retry sets. Counting or comparing their empty arrays would replace a
 * real measurement with a request-only answer. A fourth kind changes here, so
 * neither runtime can silently disagree about whether a row measured a tree.
 */

/**
 * The contract between the deployed Convex door and the box runner. Bump this
 * whenever an evals row gains a field the door needs in order to recognize an
 * answer. Version 2 is the first contract in which rows carry
 * `answersRequestAt`.
 */
export const EVALS_PROTOCOL = 2;

/**
 * WHEN PROTOCOL 2 REACHED THE DEPLOYMENT — the cutoff, and the only thing that
 * tells a request filed under this contract from one filed before it.
 *
 * UPDATED AT MERGE to the MOMENT this branch deploys, not the day of it.
 * Convex deploys on the push to main, so the merge commit's own timestamp is
 * the bump: the row answering a request filed before it carries no
 * `answersRequestAt`, and the row answering one filed after it does. A DAY IS
 * THE WRONG GRANULARITY, in both directions. #172 merged at 01:24Z on
 * 2026-09-15, so `2026-09-15T00:00:00Z` would read the eighty-four minutes
 * before it as post-protocol, and the `2026-09-14T00:00:00Z` it actually
 * merged carrying — written while the branch still expected to land that day —
 * read a whole day of pre-protocol requests that way, which is the expensive
 * half of the failure described below.
 *
 * WHY A CUTOFF AT ALL. `answersRequestAt` is the exact identity answeredRun
 * (convex/ttsEvals.ts) matches on, and a row written before this contract
 * carries no such field. Every sha with a standing request from before the
 * bump and a scored row from before the bump therefore reads as UNANSWERED the
 * moment this deploys: the queue hands each one out again and the box pays a
 * full run for each, one per pass, ahead of every live head. The backlog is
 * not a few — it is every pull request the check ever asked about that is
 * still inside the queue's window.
 *
 * SO THE BACKLOG IS NEVER SERVED. A request older than this is answered
 * `superseded` in one POST and no model call, the first time the queue reaches
 * it, and its check says to re-run at the head. Nothing is lost: a branch that
 * still matters pushes again or re-runs its check, which files a request dated
 * now — served normally, and stamped.
 *
 * A MISSING `runId` IS NOT THE TEST, though every pre-bump request carries
 * none. WikiTom's Action sends no run id until its copy of the workflow is
 * re-installed (evals/wikitom/evals.yml), so condemning a request for the
 * absence of one would leave that repository's heads unservable for good. The
 * time is exact; the id is a proxy that misfires.
 */
export const EVALS_PROTOCOL_SINCE = "2026-09-15T01:24:01Z";
export const EVALS_PROTOCOL_SINCE_MS = Date.parse(EVALS_PROTOCOL_SINCE);

/** The `supersededBy` a pre-protocol request is answered with. Not a sha, and
 *  deliberately not shaped like one: it names WHY, and every reader that
 *  shortens a sha for display has to leave it whole. */
export const PROTOCOL_SUPERSEDED = "protocol-2";

/** True for a request filed before the protocol bump — or one carrying no
 *  readable `requestedAt` at all, which is the same fail-closed answer. */
export function predatesEvalsProtocol(requestedAt) {
  return typeof requestedAt !== "number" || !Number.isFinite(requestedAt) ||
    requestedAt < EVALS_PROTOCOL_SINCE_MS;
}

/** A sha is shown short; anything else is shown whole. */
export function supersededName(by) {
  return typeof by === "string" && /^[0-9a-f]{7,40}$/i.test(by) ? by.slice(0, 7) : String(by);
}

/**
 * THE FIELDS THAT MAKE A SUPERSEDED ROW DENY, in one place, because two
 * runtimes write such a row: the box, for a head a later push replaced
 * (worker/jobs/evals.mjs supersededRun), and the door, draining the
 * pre-protocol queue in bulk (convex/ttsEvals.ts
 * internalSupersedeLegacyEvalsRequests). `regressions: null` and
 * `goldenCoverage: null` are what convex/ttsMerge.ts refuses on, and `error`
 * carries the same sentence for a reader too old to know the boolean — so a
 * second spelling of this set is a row that could open a gate.
 */
export function supersededFields(by) {
  const why = by === PROTOCOL_SUPERSEDED
    ? `filed before evals protocol ${EVALS_PROTOCOL}`
    : `superseded by ${supersededName(by)}`;
  return {
    superseded: true,
    supersededBy: by,
    error: `${why}; re-run this check at the head of the branch`,
    regressions: null,
    goldenCoverage: null,
  };
}

export function scoredNothing(data) {
  const row = data !== null && typeof data === "object" ? data : {};
  // Historical rows recorded the failure text; newer catastrophic rows carry
  // the boolean. Both say the set was never measured.
  return row.unaffected === true || row.superseded === true || row.error === true ||
    (typeof row.error === "string" && row.error !== "");
}

/**
 * A row whose answer can go wrong WITHOUT THE QUESTION CHANGING.
 *
 * `superseded` is a fact about the queue at the moment it looked, not about
 * the commit: a branch force-pushed back to an earlier sha makes that sha the
 * head again, and the row saying it was behind something is then simply
 * wrong. `error` is a fact about one attempt: the box could not fetch the tree
 * that time, and asking again is the whole point of asking again.
 *
 * A POSITIVE `errored` COUNT IS THE SAME KIND OF FACT, and leaving it out of
 * this set was a bug. A row with runner errors is one where the box reached
 * the trees and some ITEMS were never measured — the model call failed, the
 * tool call died — and it carries no `error` field at all, because the run
 * itself did not fail. Both gates deny on it (scripts/evals-check.mjs gate()
 * on `verdict.errored`, convex/ttsMerge.ts with "had N runner errors"), so
 * without this clause the row stood, an identical re-ask kept its
 * `requestedAt`, and the standing row went on answering. Seen on PR #177 on
 * 2026-09-15: the runner fix rolled, `gh run rerun` of the evals workflow read
 * the standing errored row and failed at once, and only `evals.mjs --force`
 * could produce a new row. A runner error is a fact about one attempt, exactly
 * as `error` is, and asking again is the whole point of asking again.
 *
 * `unaffected` is NOT in this set, and that is the distinction the identity
 * rule below turns on. What an unaffected row says — this diff touched no
 * watched path — is decided entirely by the base sha and the changed paths,
 * which are two thirds of the request's identity. Ask the same question and
 * the answer cannot have changed; change either one and the identity changes
 * and the row stops answering anyway. A CLEANLY scored row is likewise a
 * measurement of a tree against a base, and re-asking the same question of the
 * same trees is what this round exists to stop paying for.
 */
export function reopensOnReask(data) {
  const row = data !== null && typeof data === "object" ? data : {};
  return row.superseded === true || row.error === true ||
    (typeof row.error === "string" && row.error !== "") ||
    (typeof row.errored === "number" && row.errored > 0);
}

/**
 * The `evals: no-item <reason>` trailer on a pull-request body, or null.
 *
 * ANCHORED AND ALONE ON ITS LINE, so that a body DISCUSSING the escape hatch
 * ("put `evals: no-item why` on the body if…") is not read as using it.
 *
 * SPELLED TWICE, ON PURPOSE. scripts/evals-check.mjs carries the same reader
 * and cannot import this one: that file has zero imports by design — WikiTom's
 * Action fetches the single file and runs it, and worker/setup.sh copies it
 * beside the jobs. This copy exists because the Convex door needs the rule too
 * and cannot load a check that shells out. scripts/evals-check.test.mjs runs
 * both over one table of cases, so the two cannot drift in silence.
 */
export function noItemTrailer(prBody) {
  if (typeof prBody !== "string") return null;
  for (const line of prBody.split(/\r?\n/)) {
    const hit = /^[ \t]*evals:[ \t]*no-item[ \t]+(.+?)[ \t]*$/i.exec(line);
    if (hit !== null) return hit[1];
  }
  return null;
}

/**
 * WHAT MAKES A REQUEST A DIFFERENT QUESTION — three things, and the pull-request
 * body is not one of them.
 *
 * A run scores a TREE against a BASE and then answers one question about
 * coverage. The base sha and the changed paths are what decide the first; the
 * no-item trailer is the only part of the body anything reads, and it decides
 * the second. Everything else on a request is either fixed (the sha is the
 * key) or a diagnostic: `pr`, `paths`, the run id, and the body around the
 * trailer.
 *
 * WHY IT MATTERS THAT THE BODY IS OUT. `.github/workflows/evals.yml` fires on
 * `edited`, which is right — a trailer added to the body has to be honoured,
 * and nothing else would notice it. But the same trigger fires on every typo
 * fixed in a description, and re-dating the request on one of those threw away
 * a scored run and bought a fresh fifty-minute one that could only reach the
 * same numbers. The trigger stays; an edit that does not touch the trailer now
 * costs nothing.
 *
 * THE CHANGED PATHS ARE COMPARED, NOT DIGESTED. Both lists are in hand at the
 * comparison, so there is nothing a hash would buy and one thing it would
 * cost: a collision reads a different diff as the same question and skips the
 * re-score. Sorted and de-duplicated first, because the order CI lists them in
 * is not a fact about the diff. A request carrying no list at all (the hint is
 * optional) is not the same question as one that carries an empty one: null
 * means unknown and `[]` means nothing changed.
 */
export function evalsRequestIdentity(request) {
  const changed = Array.isArray(request?.changed)
    ? [...new Set(request.changed.map((path) => String(path)))].sort()
    : null;
  return JSON.stringify([
    typeof request?.baseSha === "string" ? request.baseSha : null,
    changed,
    noItemTrailer(request?.prBody ?? null),
  ]);
}
