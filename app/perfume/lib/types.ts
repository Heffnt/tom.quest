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

export type Recipe = {
  key: string; // "base:<id>" or "user:<convexId>"
  name: string;
  school: string;
  tier: Tier;
  req: Token[]; // target multiset
  desc: string;
  example?: string[]; // base only — ingredient names that craft it
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
};

// The full brew state the engine evaluates. `ingredients` is the expanded list
// of added ingredients (each addition appears once; repeats allowed).
export type BrewState = {
  ingredients: Ingredient[];
  minusPlays: Token[]; // tokens struck out of the brew (each consumes one ⊖)
  plusPlays: Token[]; // tokens summoned into the brew (each consumes one ⊕)
};
