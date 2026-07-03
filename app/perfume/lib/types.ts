// Shared types for the Perfumer's Bench (/perfume).
// Frequency ids are either a fundamental id (9) or a named-frequency id (17).
// Named frequencies are ATOMIC for matching — never unpacked into their
// components.

/** A single frequency id — either a fundamental (e.g. "A") or named (e.g. "Crallax"). */
export type Frequency = string;

export type Fundamental = { id: string; school: string; color: string };

/** An ingredient's TYPE — the element icon on its card. */
export type IngredientType = "animal" | "plant" | "mineral";

export type Named = {
  id: string;
  icon: string;
  components: string[];
  expanded: Record<string, number>;
  weight: number;
};

// Where an ingredient/perfume came from: the built-in base set, or a user.
export type Source =
  | { kind: "base" }
  | { kind: "user"; userId: string; name: string };

export type Ingredient = {
  key: string; // stable unique key: "base:<name>" or "user:<convexId>"
  name: string;
  emits: Frequency[]; // multiset of emitted frequencies (repeats allowed)
  strike: number; // ⊖ strike charges granted
  wild: number; // ⊕ wildcard charges granted
  color: string;
  type?: IngredientType; // base only (pure frequencies have none)
  page?: number; // base only
  source: Source;
};

// One alternative inside a common-perfume ingredient slot. `known: false` marks
// an ingredient named in the lore table but absent from the Ingredients Table
// (display-only; excluded from the math).
export type PerfumeSlotEntry = { name: string; qty: number; known: boolean };

// One concrete way to brew the perfume from the d40 table: the expanded
// ingredient list, which tuning (`req` indexes Perfume.reqs) it lands on, and
// how many ⊖ strikes (`trim`) / ⊕ summons (`wildAdd`) that takes.
export type Recipe = {
  ings: string[]; // ingredient names, repeats allowed (e.g. Chrythsmeum ×4)
  req: number;
  trim: number;
  wildAdd: number;
};

// A perfume is DEFINED by its frequency multisets. Slashed ingredient
// alternatives in the source table can emit different profiles, so a perfume
// may carry several valid `reqs` ("tunings") — a brew matches if it can be
// made exactly equal to ANY one of them.
export type Perfume = {
  key: string; // "base:<id>" or "user:<convexId>"
  name: string;
  roll: number; // d40 table row (16 appears twice: Bright and Frenzy)
  reqs: Frequency[][]; // valid tunings, each a target multiset
  slots: PerfumeSlotEntry[][]; // common-perfume slots, each a list of alternatives
  combos: Recipe[];
  desc: string;
  source: Source;
};

export type Multiset = Record<string, number>;

export type PerfumeStatus = "perfect" | "craftable" | "off";

export type EvalResult = {
  status: PerfumeStatus;
  excess: Multiset; // B - R : frequencies to strike (⊖)
  missing: Multiset; // R - B : frequencies to summon (⊕)
  exN: number; // total excess count
  miN: number; // total missing count
  S: number; // remaining ⊖ strike charges
  W: number; // remaining ⊕ wild charges
  reqIndex: number; // which tuning (Perfume.reqs index) this result is against
};

// The full brew state the engine evaluates. `ingredients` is the expanded list
// of added ingredients (each addition appears once; repeats allowed).
export type BrewState = {
  ingredients: Ingredient[];
  strikePlays: Frequency[]; // frequencies struck out of the brew (each consumes one ⊖)
  wildPlays: Frequency[]; // frequencies summoned into the brew (each consumes one ⊕)
};
