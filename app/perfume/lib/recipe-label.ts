// recipeLabel — the SINGLE phrasing for "which recipe" a brew's tally lands on
// (DESIGN.md §1 "recipe": a perfume has one common recipe and may have others;
// "when a brew completes, the UI shows which recipe was satisfied"). Two
// surfaces name recipes — the stage's satisfied banner / brew footer
// (components/brew-graph.tsx) and the perfume book's satisfied chip
// (components/perfume-panel.tsx). They MUST agree, so the phrasing lives here,
// imported by both, rather than being spelled twice.
//
// Index 0 is the COMMON recipe; the rest are numbered 1-based ("recipe 2", …).
// Returns null when the perfume carries a single recipe — there is nothing to
// disambiguate, so neither surface prints a qualifier.

import { basePerfumes } from "../data/base";

const RECIPE_COUNT = new Map(basePerfumes.map((p) => [p.key, p.recipes.length]));

export function recipeLabel(perfumeKey: string, recipeIndex: number): string | null {
  const n = RECIPE_COUNT.get(perfumeKey);
  if (n === undefined || n <= 1) return null;
  return recipeIndex === 0 ? "common recipe" : `recipe ${recipeIndex + 1}`;
}
