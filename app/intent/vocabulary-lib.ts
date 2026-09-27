// The vocabulary page's own reading of the render the record holds: the kinds
// a word can be, and the rows `tts search` would print for it — the header,
// every term, or what `define` answers for one word. The rows themselves are
// spelled once, in shared/vocabulary-rows.mjs, which the box's CLI imports too.

import type { Doc } from "@/convex/_generated/dataModel";
import {
  defineTerm,
  formatTermRow,
  formatUnknownTerm,
  formatVersionRow,
} from "../../shared/vocabulary-rows.mjs";

type VocabularyRow = Doc<"ttsVocabulary">;
export type Term = VocabularyRow["terms"][number];
export type Disagreement = VocabularyRow["disagreements"][number];

/** Every kind present in the render, sorted, for the filter row. */
export function kindsOf(terms: Term[]): string[] {
  return [...new Set(terms.map((term) => term.kind))].sort();
}

/** `tts search vocabulary`'s header, from what the row carries. A count or a
 *  commit the night has not posted yet is left out rather than guessed. */
export function versionRow(row: VocabularyRow): string {
  return formatVersionRow({
    version: row.version,
    counts: { terms: row.terms.length, ...row.counts },
    wikitom: row.commit,
    tomQuest: row.tomQuestCommit,
  });
}

/**
 * The rows the page prints under the header. With no word typed, every term
 * of the picked kind, as `tts search vocabulary --kind` prints them. With a
 * word, what `tts search define <word>` prints: its one row, or the line that
 * says it is unknown and the words it could have meant.
 */
export function termRows(row: VocabularyRow, kind: string, word: string): string[] {
  const asked = word.trim();
  const section = row.section;
  if (asked === "") {
    return row.terms
      .filter((term) => kind === "all" || term.kind === kind)
      .map((term) => formatTermRow({ section, term }));
  }
  const { found, candidates } = defineTerm(row.terms, asked);
  return found === null
    ? [formatUnknownTerm({ section, term: asked, candidates })]
    : [formatTermRow({ section, term: found })];
}
