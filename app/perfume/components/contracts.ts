// Prop contracts shared between the orchestrator (perfume-client.tsx) and the
// self-contained panel/modal components, so the two cannot drift.

import type { Ingredient, Recipe, BrewState, Tier } from "../lib/types";

export interface IngredientPanelProps {
  // Full catalog (base + custom). The panel does its own search / frequency /
  // source filtering locally.
  ingredients: Ingredient[];
  // Add one ingredient (by its stable `key`) to the brew.
  onAdd: (key: string) => void;
  // Open the "create ingredient" modal.
  onRequestAdd: () => void;
  // Whether the viewer is signed in (gates the create button).
  canCreate: boolean;
  // The signed-in user's convex id (to decide which custom items are deletable).
  currentUserId?: string;
  // Delete a custom ingredient the viewer created. Receives the raw convex id
  // (the part after "user:" in Ingredient.key).
  onRemoveCustom?: (convexId: string) => void;
}

export interface RecipeBookProps {
  // Full catalog (base + custom). The panel does its own source filtering.
  recipes: Recipe[];
  // Current brew, for live per-recipe evaluation.
  brew: BrewState;
  onRequestAdd: () => void;
  canCreate: boolean;
  currentUserId?: string;
  // Load a base recipe's worked example into the brew (base recipes only).
  onLoadExample?: (recipe: Recipe) => void;
  onRemoveCustom?: (convexId: string) => void;
}

export interface AddIngredientModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    emits: string[]; // token ids (fundamental letters or named ids), repeats allowed
    minus: number;
    plus: number;
    color: string; // hex
  }) => Promise<void> | void;
}

export interface AddRecipeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: {
    name: string;
    school: string;
    tier: Tier;
    req: string[]; // token ids, repeats allowed
    desc: string;
  }) => Promise<void> | void;
}
