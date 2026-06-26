// Prop contracts shared between the orchestrator (perfume-client.tsx) and the
// panel components, so the two cannot drift.

import type { Ingredient, Recipe, BrewState } from "../lib/types";

export interface IngredientPanelProps {
  // The base ingredient catalog. The panel does its own search / frequency
  // filtering locally.
  ingredients: Ingredient[];
  // Add one ingredient (by its stable `key`) to the brew.
  onAdd: (key: string) => void;
}

export interface RecipeBookProps {
  recipes: Recipe[];
  // Current brew, for live per-recipe evaluation.
  brew: BrewState;
  // Load a recipe's worked example into the brew.
  onLoadExample?: (recipe: Recipe) => void;
}
