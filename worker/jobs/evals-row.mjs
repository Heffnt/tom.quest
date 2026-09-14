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

export function scoredNothing(data) {
  const row = data !== null && typeof data === "object" ? data : {};
  // Historical rows recorded the failure text; newer catastrophic rows carry
  // the boolean. Both say the set was never measured.
  return row.unaffected === true || row.superseded === true || row.error === true ||
    (typeof row.error === "string" && row.error !== "");
}
