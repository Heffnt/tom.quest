// Prop contracts shared between the orchestrator (perfume-client.tsx) and the
// panel components, so the two cannot drift.

import type { Ingredient, Recipe, BrewState } from "../lib/types";

export interface IngredientPanelProps {
  // The catalog shown in the ingredients panel: the 96 base ingredients plus
  // the pure frequencies. The panel does its own search / frequency filtering.
  ingredients: Ingredient[];
  // How many of each ingredient (by key) is currently in the brew — drives the
  // amber in-brew highlight and the −/count/+ controls on each row.
  brewCounts: Record<string, number>;
  // Add one ingredient (by its stable `key`) to the brew.
  onAdd: (key: string) => void;
  // Remove one ingredient from the brew.
  onDec: (key: string) => void;
  // Remove every copy of an ingredient from the brew (row-click toggle).
  onRemoveAll: (key: string) => void;
}

export interface RecipeBookProps {
  recipes: Recipe[];
  // Current brew, for live per-recipe evaluation.
  brew: BrewState;
  // Add `qty` copies of an ingredient (by its stable `key`) to the brew —
  // used by the clickable ingredient pills on recipe cards.
  onAddIngredient?: (key: string, qty?: number) => void;
}
