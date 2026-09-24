// THE ONE HOME for clipping a text before it is shown to a model or written
// into a row.
//
// Two sides read it: the worker jobs (through tts-lib.mjs, which re-exports
// it) and convex/ttsNightly.ts, which clips the agent's replies around each
// of Tom's turns. tts-lib.mjs itself cannot be that home — it imports
// node:child_process, which Convex's bundler has no runtime for — so the one
// function that both need lives here, with no imports at all (the
// markdown-sections.mjs arrangement).

/**
 * Shorten `text` to at most `max` characters for showing to a model.
 *
 * Anything that is not a non-empty string becomes null rather than an empty
 * string, so a missing brief is absent from the JSON instead of present and
 * blank — a blank field reads to the model as "this todo has an empty brief",
 * which is a claim about the todo rather than about our input.
 *
 * A clipped result ends in an ellipsis character so the model can see the text
 * was cut and does not treat a sentence that stops mid-clause as the whole
 * brief. The ellipsis is appended AFTER the slice, so the returned string is
 * max + 1 characters long; the limit bounds the source text we spend, not the
 * output width.
 */
export function clip(text, max) {
  if (typeof text !== "string" || text === "") return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
