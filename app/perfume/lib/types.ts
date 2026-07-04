// Shared types for the Perfumer's Bench (/perfume).
// Frequency ids are either a fundamental id (9) or a named-frequency id (17).
// Frequencies COMBINE: a multiset equal to a named frequency's components is
// interchangeable with it, so matching compares equivalence classes.

/** A single frequency id — either a fundamental (e.g. "A") or named (e.g. "Crallax"). */
export type Frequency = string;

export type Fundamental = { id: string; school: string; color: string };

/** An ingredient's TYPE — the element icon on its card. */
export type IngredientType = "animal" | "plant" | "mineral";

export type Named = {
  id: string;
  icon: string;
  components: string[];
  weight: number; // total fundamentals it expands to
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
  wild: number; // ⊕ wild charges granted
  color: string;
  type?: IngredientType; // base only (pure frequencies have none)
  page?: number; // base only
  source: Source;
};

// One alternative inside a common-recipe ingredient slot. `known: false` marks
// an ingredient named in the lore table but absent from the Ingredients Table
// (display-only; excluded from the math).
export type PerfumeSlotEntry = { name: string; qty: number; known: boolean };

// One common way to brew the perfume from the d40 table: the expanded
// ingredient list, which tuning (`req` indexes Perfume.reqs) it lands on, and
// how many ⊖ strikes removing its excess takes.
export type Combo = {
  ings: string[]; // ingredient names, repeats allowed (e.g. Chrythsmeum ×4)
  req: number;
  strikes: number;
};

// A perfume is DEFINED by its frequency multisets, derived from the common
// recipe Joe gave (or a recorded ruling where wildcards make that ambiguous).
// Slashed ingredient alternatives can emit different profiles, so a perfume
// may carry several valid `reqs` ("tunings") — a brew matches if it can be
// made exactly equal to an integer MULTIPLE of ANY one of them (k copies).
export type Perfume = {
  key: string; // "base:<id>" or "user:<convexId>"
  name: string;
  roll: number; // d40 table row (16 appears twice: Bright and Frenzy)
  effect: string; // what the perfume does — "unknown" until discovered in play
  reqs: Frequency[][]; // valid tunings, each a target multiset
  slots: PerfumeSlotEntry[][]; // common-recipe slots, each a list of alternatives
  combos: Combo[];
  source: Source;
};

export type Multiset = Record<string, number>;

export type PerfumeStatus = "perfect" | "craftable" | "off";

export type EvalResult = {
  status: PerfumeStatus;
  k: number; // copy count: perfect means the brew equals k× the tuning
  excess: Multiset; // B - k·R : frequencies to strike (⊖)
  missing: Multiset; // k·R - B : frequencies still needed
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
  wildPlays: Frequency[]; // wild frequencies added to the brew (each consumes one ⊕)
};
