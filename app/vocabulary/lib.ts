// The vocabulary page's own reading of the render the record holds: the kinds
// a word can be, where a word is defined, and the search over the list.

import type { Doc } from "@/convex/_generated/dataModel";

type VocabularyRow = Doc<"ttsVocabulary">;
export type Term = VocabularyRow["terms"][number];
export type Disagreement = VocabularyRow["disagreements"][number];

/**
 * Where a word is defined, in one line.
 *
 * §12.1 IS THE AUTHORITY and the generator says so; a word also present in the
 * code carries the symbol that holds it, so a disagreement between the two has
 * both its addresses on screen. A word the spec does not define at all is a
 * word the generator minted from the code, and saying "the code" is the whole
 * of what is true about it.
 */
export function definedIn(term: Term): string {
  const places: string[] = [];
  if (term.specSection !== undefined) places.push(`spec §${term.specSection}`);
  if (term.codeSymbol !== undefined) places.push(term.codeSymbol);
  return places.length === 0 ? "the code" : places.join(" · ");
}

/** Every kind present in the render, sorted, for the filter row. */
export function kindsOf(terms: Term[]): string[] {
  return [...new Set(terms.map((term) => term.kind))].sort();
}

/**
 * The words a query shows: the word itself, its definition, and the word it is
 * refused in favour of — so typing a word that is NOT in the vocabulary still
 * finds the entry that says which word to use instead.
 */
export function searchTerms(terms: Term[], kind: string, query: string): Term[] {
  const q = query.trim().toLowerCase();
  return terms.filter((term) =>
    (kind === "all" || term.kind === kind)
    && (q === ""
      || term.term.toLowerCase().includes(q)
      || term.definition.toLowerCase().includes(q)
      || (term.refusedFor ?? "").toLowerCase().includes(q)));
}
