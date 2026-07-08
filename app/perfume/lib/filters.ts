// The single `type:<t>` filter-value parser. A filter-value list (as stored in
// SharedUI's `inputFilters` / `perfumeFilters`) mixes plain frequency ids
// (plus the "strike"/"wild" pseudo-filters) with "type:<t>" entries tagging an
// ingredient TYPE (animal/plant/mineral). This module is the one place that
// knows the "type:" prefix convention — components/frequency-filter.tsx and
// components/ingredient-panel.tsx both parse it and should import from here
// rather than re-deriving `startsWith("type:")` / `.slice(5)` locally.

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
