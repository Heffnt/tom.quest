// Shared types for the Perfumer's Bench (/perfume).
// Token ids are either a fundamental id (9) or a named-frequency id (17). Named
// frequencies are ATOMIC for matching — never unpacked into their components.

export type Token = string;

export type Tier = "simple" | "advanced" | "legendary";

export type Fundamental = { id: string; school: string; color: string };

export type Named = {
  id: string;
  icon: string;
  components: string[];
  expanded: Record<string, number>;
  weight: number;
};

// Where an ingredient/recipe came from: the built-in base set, or a user.
export type Source =
  | { kind: "base" }
  | { kind: "user"; userId: string; name: string };

export type Ingredient = {
  key: string; // stable unique key: "base:<name>" or "user:<convexId>"
  name: string;
  emits: Token[]; // multiset of emitted tokens (repeats allowed)
  minus: number; // ⊖ strike charges granted
  plus: number; // ⊕ wildcard charges granted
  color: string;
  page?: number; // base only
  source: Source;
};

// One alternative inside a common-recipe ingredient slot. `known: false` marks
// an ingredient named in the lore table but absent from the Ingredients Table
// (display-only; excluded from the math).
export type RecipeSlotEntry = { name: string; qty: number; known: boolean };

// One concrete way to brew the recipe from the d40 table: the expanded
// ingredient list, which tuning (`req` indexes Recipe.reqs) it lands on, and
// how many ⊖ strikes (`trim`) / ⊕ summons (`wildAdd`) that takes.
export type RecipeCombo = {
  ings: string[]; // ingredient names, repeats allowed (e.g. Chrythsmeum ×4)
  req: number;
  trim: number;
  wildAdd: number;
};

// A recipe is DEFINED by its frequency multisets. Slashed ingredient
// alternatives in the source table can emit different profiles, so a recipe
// may carry several valid `reqs` ("tunings") — a brew matches if it can be
// made exactly equal to ANY one of them.
export type Recipe = {
  key: string; // "base:<id>" or "user:<convexId>"
  name: string;
  roll: number; // d40 table row (16 appears twice: Bright and Frenzy)
  tier: Tier;
  reqs: Token[][]; // valid tunings, each a target multiset
  slots: RecipeSlotEntry[][]; // common-recipe slots, each a list of alternatives
  combos: RecipeCombo[];
  desc: string;
  source: Source;
};

export type Multiset = Record<string, number>;

export type RecipeStatus = "perfect" | "craftable" | "off";

export type EvalResult = {
  status: RecipeStatus;
  excess: Multiset; // B - R : tokens to strike (⊖)
  missing: Multiset; // R - B : tokens to summon (⊕)
  exN: number; // total excess count
  miN: number; // total missing count
  M: number; // remaining ⊖ charges
  P: number; // remaining ⊕ charges
  reqIndex: number; // which tuning (Recipe.reqs index) this result is against
};

// The full brew state the engine evaluates. `ingredients` is the expanded list
// of added ingredients (each addition appears once; repeats allowed).
export type BrewState = {
  ingredients: Ingredient[];
  minusPlays: Token[]; // tokens struck out of the brew (each consumes one ⊖)
  plusPlays: Token[]; // tokens summoned into the brew (each consumes one ⊕)
};
