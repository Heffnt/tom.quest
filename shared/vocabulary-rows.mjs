// THE ONE SPELLING of a vocabulary row, as `tts search define` and `tts search
// vocabulary` print it.
//
// Two readers print the same rows: the box's search CLI (the Jarvis
// repository's worker/jobs/search-lib.mjs), which an agent runs, and the
// /vocabulary page, which Tom reads to see exactly what that agent sees. A
// formatter written twice drifts the first time one side adds a field, and the
// page would then be showing Tom a row no agent was ever shown. So both import
// this file, and the rows are pinned in __tests__/vocabulary-rows.test.mjs to
// the CLI's real output.
//
// PURE, like every module here: no I/O, and a value is made one line and
// stripped of anything credential-shaped (./redact.mjs) before it is printed.

import { redactSecrets } from "./redact.mjs";

/** How many near misses an unknown word lists. */
export const NEAR_MISSES = 5;

/** A value collapsed to one safe, readable line: credentials redacted, a
 *  backslash, a line break and a tab escaped, spacing collapsed. */
export function singleLine(value) {
  return redactSecrets(String(value ?? ""))
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/[ \f\v]+/g, " ")
    .trim();
}

export function quoted(value) {
  return `"${singleLine(value)}"`;
}

/** The fields `define` prints and searches, in that order. A term matches a
 * miss's substring search on any of them, because a reader who remembers a
 * definition and not its word is exactly who is asking. */
export function termHaystack(term) {
  return [
    term?.term,
    term?.kind,
    term?.definition,
    term?.specSection,
    term?.codeSymbol,
    ...(Array.isArray(term?.related) ? term.related : []),
  ]
    .map((value) => String(value ?? ""))
    .join("\n")
    .toLocaleLowerCase();
}

/**
 * `define <word>`: the term whose word it is, case aside, or the terms whose
 * printed fields carry it — at most NEAR_MISSES, sorted by word. An empty word
 * has no near misses, since every term would carry it.
 */
export function defineTerm(terms, wanted) {
  const list = Array.isArray(terms) ? terms : [];
  const asked = String(wanted ?? "").toLocaleLowerCase();
  const found = list.find((term) => String(term?.term ?? "").toLocaleLowerCase() === asked);
  if (found !== undefined) return { found, candidates: [] };
  const candidates = asked === "" ? [] : list
    .filter((term) => termHaystack(term).includes(asked))
    .sort((a, b) => String(a?.term ?? "").localeCompare(String(b?.term ?? "")))
    .slice(0, NEAR_MISSES);
  return { found: null, candidates };
}

/**
 * One term on one line. `section` is the spec section the vocabulary is fixed
 * in, printed on every row; a reader that does not know it passes nothing and
 * the column is left out rather than filled with a guess.
 */
export function formatTermRow({ section, term: entry }) {
  const term = entry ?? {};
  const related = Array.isArray(term.related) ? term.related.join(",") : "";
  const parts = [`vocabulary/${singleLine(term.term)}`];
  if (section !== undefined && section !== null && section !== "") parts.push(singleLine(section));
  parts.push(`kind=${singleLine(term.kind)}`, `definition=${quoted(term.definition)}`);
  if (term.specSection) parts.push(`spec=§${singleLine(term.specSection)}`);
  if (term.codeSymbol) parts.push(`code=${singleLine(term.codeSymbol)}`);
  if (related !== "") parts.push(`related=${related}`);
  // A refused word is a word the spec names as a second name for one it does
  // keep. The word it points at is the whole answer, so it is the last field
  // rather than one buried in the definition.
  if (term.kind === "refused") parts.push(`refused-for=${singleLine(term.refusedFor ?? "nothing")}`);
  return parts.join(" ");
}

/** A word the vocabulary does not have, and what it could have meant. */
export function formatUnknownTerm({ section, term, candidates }) {
  const head = `vocabulary/${singleLine(term)} unknown`;
  if (candidates.length === 0) return `${head}\n  no term's definition carries ${quoted(term)}`;
  return [
    head,
    ...candidates.map((candidate) => `  did you mean  ${formatTermRow({ section, term: candidate })}`),
  ].join("\n");
}

/** The order the header prints the counts in. */
const COUNT_NAMES = ["terms", "entities", "jobs", "search", "skills", "repos", "channels"];

/**
 * The `vocabulary/@version` header: the render's hash, each count, and the two
 * commits it was generated from. A count or a commit the caller does not have
 * is left out, never printed as zero or `unknown`.
 */
export function formatVersionRow({ version, counts = {}, wikitom, tomQuest }) {
  const parts = [`vocabulary/@version ${singleLine(version)}`];
  for (const name of COUNT_NAMES) {
    if (Number.isInteger(counts[name])) parts.push(`${name}=${counts[name]}`);
  }
  if (wikitom) parts.push(`wikitom=${singleLine(wikitom)}`);
  if (tomQuest) parts.push(`tom.quest=${singleLine(tomQuest)}`);
  return parts.join(" ");
}
