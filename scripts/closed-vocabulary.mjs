// THE CLOSED VOCABULARY'S ONE RENDERER.
//
// The seven words a worker's prompt carries are defined once, in WikiTom
// `tts/spec.md` §12.1 (Tom, 2026-09-24: one wording, in the spec, with the
// prompt constant rendered from it). This file turns those entries into the
// vocabulary block a prompt carries, and it is the only thing that does:
//
//  - convex/vocabulary.ts renders the block at read time from the entries the
//    nightly posts to the record (the `ttsVocabulary` row), and
//  - scripts/vocabulary.mjs renders the same block from the spec it reads, to
//    write the fallback `TTS_CLOSED_VOCABULARY` in convex/ttsShared.ts.
//
// Two renderers of one block would be two wordings again the first time one of
// them changed, so both import this file. It imports nothing: Convex bundles it
// into functions that run without Node, and the box loads it beside
// scripts/vocabulary.mjs.
//
// THE OPENING LINE IS NOT SPELLED HERE. It lives inside the generated block in
// convex/ttsShared.ts, the one place scripts/check-vocabulary.mjs check 3
// allows it, and both callers pass it in as the first line of that constant.

/** The seven words the prompt carries, in the order it carries them. They are
 *  the seven a worker acts on WITHOUT being able to stop and ask; every other
 *  word is answered by `tts search define`, which costs no prompt bytes. */
export const PROMPT_TERMS = Object.freeze([
  "batch",
  "task",
  "goal",
  "needs",
  "ready",
  "display text",
  "ground-up explanation",
]);

/**
 * A spec definition as prompt text: the section references `(§5.4)` and the
 * markdown emphasis removed, because a worker reads the words and the spec's
 * navigation is not part of what a word means. Backticks go with the rest of
 * the emphasis, which is also what lets the fallback be written inside a
 * template literal without escaping.
 */
export function promptDefinition(definition) {
  return String(definition ?? "")
    .replace(/\s*\(§[^)]*\)/g, "")
    .replace(/\*\*|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The opening line of a rendered vocabulary: its first line. */
export function closedVocabularyOpening(text) {
  return String(text ?? "").split("\n")[0];
}

/**
 * The vocabulary block: the opening line, then one bullet per prompt term in
 * PROMPT_TERMS order, each the spec's definition as prompt text.
 *
 * NULL, NOT A SHORTER BLOCK, when any of the seven is missing or empty. A
 * block that silently lacks a word is a prompt that uses the word undefined;
 * a null sends the caller to its fallback, which carries all seven.
 */
export function renderClosedVocabulary(opening, terms) {
  if (typeof opening !== "string" || opening.trim() === "") return null;
  const byName = new Map();
  for (const entry of Array.isArray(terms) ? terms : []) {
    if (entry === null || typeof entry !== "object" || typeof entry.term !== "string") continue;
    const key = entry.term.toLowerCase();
    if (!byName.has(key)) byName.set(key, entry);
  }
  const lines = [opening];
  for (const name of PROMPT_TERMS) {
    const entry = byName.get(name);
    if (entry === undefined || typeof entry.definition !== "string") return null;
    const text = promptDefinition(entry.definition);
    if (text === "") return null;
    lines.push(`- ${text}`);
  }
  return lines.join("\n");
}
