// decided-by.mjs — who took a decision filed through POST /tts/ask, and how
// long its question waited for Tom first.
//
// Jarvis `jarvis decide --trade-off` (Jarvis #262, worker/jobs/delegate.mjs
// waitForTom) puts a real trade-off to Tom as a needs-you item on /thread and
// waits up to two hours. His numbered reply is a `needs-tom-answered` row, and
// it becomes the decision: the option its letter or words name, or else his
// own words. With no answer, the delegate decides. Three sides read the same
// answer: the box maps his reply to the decision, the record checks that the
// decision is what his reply named (convex/ttsAsk.ts), and the digest and
// /intent say who decided and after how long. This module is the one home of
// that mapping and that wording, so the record cannot refuse a mapping the
// box made, and the two pages cannot word it differently.

/** The letters a needs-you item gives the options, in order. */
export const OPTION_LETTERS = ["a", "b", "c", "d", "e"];

/**
 * The question and its lettered options as the needs-you item shows them to
 * Tom: "Do I move it? Options: a) Move it to Thursday; b) Leave it." The
 * record composes this from the question and options it stores on the item
 * (convex/ttsSlack.ts internalOpenNeedsTomThread), so the letters he reads
 * are the letters his reply is later read against.
 *
 * @param {string} question
 * @param {readonly string[]} options
 * @returns {string}
 */
export function askShown(question, options) {
  const lettered = options.map((option, i) => `${OPTION_LETTERS[i]}) ${String(option).trim().replace(/[.;]+$/, "")}`);
  return `${String(question).trim()} Options: ${lettered.join("; ")}.`;
}

/**
 * The option an answer of Tom's names: its letter ("b", "b)", "(b)",
 * "option b") or its words (case, outer spaces and a closing full stop or
 * exclamation mark ignored). Null when it names none; his words are then the
 * decision itself.
 *
 * @param {unknown} answer
 * @param {readonly string[]} options
 * @returns {string | null}
 */
export function optionNamed(answer, options) {
  const said = String(answer ?? "").trim();
  const letter = /^(?:option\s+)?\(?([a-e])\)?[.)]?$/i.exec(said);
  if (letter) return options[OPTION_LETTERS.indexOf(letter[1].toLowerCase())] ?? null;
  const plain = (/** @type {string} */ text) => String(text).trim().toLowerCase().replace(/[.!]+$/, "");
  return options.find((option) => plain(option) === plain(said)) ?? null;
}

/**
 * The decision Tom's answer makes: the option it names, else his own words.
 *
 * @param {unknown} answer
 * @param {readonly string[]} options
 * @returns {string}
 */
export function decisionOfAnswer(answer, options) {
  return optionNamed(answer, options) ?? String(answer ?? "").trim();
}

/**
 * The clause the digest and /intent print for who decided: "decided by Tom
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
