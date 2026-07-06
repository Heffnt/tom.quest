// What the current pot brews, for the brew bar (see DESIGN.md).
// Thin, pure layer over the engine: exact matches only ("perfect"), one
// option per perfume at its best (k, recipe). Reachability ("in reach") stays
// the perfume panel's business — this module never reports craftable.

import type { BrewState, Ingredient, Multiset, Perfume } from "./types";
import { brewTally, evaluate } from "./engine";

export type BrewableOption = {
  perfume: Perfume;
  k: number; // copies brewed: the tally equals k× the recipe
  recipeIndex: number; // Perfume.recipes index the match landed on
};

// Every perfume the current tally EXACTLY brews, in the order of `perfumes`.
// `evaluate` already picks the best recipe/copy-count pairing, so a perfume
// appears at most once.
export function brewableOptions(
  brew: BrewState,
  perfumes: Perfume[],
): BrewableOption[] {
  const options: BrewableOption[] = [];
  for (const perfume of perfumes) {
    const res = evaluate(brew, perfume);
    if (res.status === "perfect") {
      options.push({ perfume, k: res.k, recipeIndex: res.reqIndex });
    }
  }
  return options;
}

export type HoverDelta = {
  tally: Multiset; // combined tally WITH the hovered ingredient in the pot
  gains: { perfume: Perfume; k: number }[];
  losses: { perfume: Perfume }[];
};

// The brew-bar hover ghost: what one more `extra` would do to the pot.
// gains = perfumes newly brewable, plus ones whose copy-count changed (the
// hint shows the new ×k); losses = perfumes brewable now that the addition
// would break. The input brew is never mutated.
export function hoverDelta(
  brew: BrewState,
  extra: Ingredient,
  perfumes: Perfume[],
): HoverDelta {
  const after: BrewState = {
    ...brew,
    ingredients: [...brew.ingredients, extra],
  };
  const beforeByKey = new Map(
    brewableOptions(brew, perfumes).map((o) => [o.perfume.key, o]),
  );
  const afterOptions = brewableOptions(after, perfumes);
  const afterKeys = new Set(afterOptions.map((o) => o.perfume.key));
  const gains = afterOptions
    .filter((o) => beforeByKey.get(o.perfume.key)?.k !== o.k)
    .map((o) => ({ perfume: o.perfume, k: o.k }));
  const losses = [...beforeByKey.values()]
    .filter((o) => !afterKeys.has(o.perfume.key))
    .map((o) => ({ perfume: o.perfume }));
  return { tally: brewTally(after), gains, losses };
}
