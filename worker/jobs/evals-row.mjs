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
export function scoredNothing(data) {
  const row = data !== null && typeof data === "object" ? data : {};
  // Historical rows recorded the failure text; newer catastrophic rows carry
  // the boolean. Both say the set was never measured.
  return row.unaffected === true || row.superseded === true || row.error === true ||
    (typeof row.error === "string" && row.error !== "");
}
