// decided-by.mjs — who took a decision filed through POST /tts/ask, and how
// long its question waited for Tom first.
//
/**
 * The clause that says who decided: "decided by Tom
 * after 12 minutes", "decided by the delegate after waiting 120 minutes", or
 * "decided by Tom" when no wait was recorded. A delegate decision with no
 * recorded wait (an ask that was not a trade-off, or one recorded before the
 * wait existed) gets null: the page says what it said before.
 *
 * @param {boolean} byTom whether the row says decidedBy "tom"
 * @param {unknown} waitedMs nonnegative milliseconds, or absent
 * @returns {string | null}
 */
export function decidedByText(byTom, waitedMs) {
  const waited = typeof waitedMs === "number" && Number.isFinite(waitedMs) && waitedMs >= 0;
  const minutes = waited ? Math.round(waitedMs / 60_000) : 0;
  const span = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (byTom) return waited ? `decided by Tom after ${span}` : "decided by Tom";
  return waited ? `decided by the delegate after waiting ${span}` : null;
}
