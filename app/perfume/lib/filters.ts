// The single `type:<t>` filter-value parser AND the ingredient search/filter
// grammar. A filter-value list (as stored in BrowseUI's `inputFilters` /
// `perfumeFilters`) mixes plain frequency ids (plus the "strike"/"wild"
// pseudo-filters) with "type:<t>" entries tagging an ingredient TYPE
// (animal/plant/mineral). This module is the one place that knows the "type:"
// prefix convention AND the "does this ingredient pass the search + filter"
// rules — components/frequency-filter.tsx, components/ingredient-panel.tsx and
// components/import-dialog.tsx all import from here rather than re-deriving the
// matching locally (DESIGN.md §Layout "same search/filter grammar").

import type { Ingredient } from "./types";
import { FUND } from "../data/base";

// Is this filter value a type tag rather than a frequency/charge id?
export const isTypeFilter = (v: string): boolean => v.startsWith("type:");

// The bare type name carried by a "type:<t>" filter value (undefined-unsafe:
// only call on values that pass isTypeFilter).
export const typeOf = (v: string): string => v.slice(5);

// Partition a filter-value list into its ingredient-type tags and the
// remaining frequency/charge ids. Types OR among themselves; frequencies AND
// — see DESIGN.md §"Input panel tabs" — but that matching logic belongs to
// the callers, not here.
export function splitFilters(values: string[]): { types: string[]; freqs: string[] } {
  const types: string[] = [];
  const freqs: string[] = [];
  for (const v of values) {
    if (isTypeFilter(v)) types.push(typeOf(v));
    else freqs.push(v);
  }
  return { types, freqs };
}

// Does an ingredient pass the active TYPE + FREQUENCY filter? Every selected
// frequency must match (AND); the strike/wild pseudo-filters test the charge
// counts; a non-empty type list requires the ingredient's type to be among them.
// `types`/`freqs` come from `splitFilters`.
export function ingredientPasses(ing: Ingredient, types: string[], freqs: string[]): boolean {
  if (types.length > 0 && (!ing.type || !types.includes(ing.type))) return false;
  return freqs.every((f) =>
    f === "strike" ? ing.strike > 0 : f === "wild" ? ing.wild > 0 : ing.emits.includes(f),
  );
}

// Does an ingredient match a free-text query? Matches its name, an emitted
// frequency id, or a fundamental's school name (e.g. "transmutation" finds
// every T-emitter). `q` must already be trimmed + lower-cased by the caller.
export function ingredientMatchesSearch(ing: Ingredient, q: string): boolean {
  if (!q) return true;
  if (ing.name.toLowerCase().includes(q)) return true;
  if (ing.emits.some((t) => t.toLowerCase().includes(q))) return true;
  return ing.emits.some((t) => (FUND[t]?.school ?? "").toLowerCase().includes(q));
}
