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
 * UPDATED AT MERGE to the day this branch deploys. Convex deploys on the push
 * to main, so the merge is the bump: the row answering a request filed before
 * it carries no `answersRequestAt`, and the row answering one filed after it
 * does.
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
export const EVALS_PROTOCOL_SINCE = "2026-09-14T00:00:00Z";
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
