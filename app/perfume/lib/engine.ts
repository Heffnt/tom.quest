// Matching engine for the Perfumer's Bench (/perfume).
// Pure-TypeScript port of the Three Feifs matching logic from the Byobu repo
// (index.html lines 2314-2369). Named frequencies are ATOMIC tokens — they are
// never unpacked into their fundamental components for matching.

import type {
  Multiset,
  Ingredient,
  Recipe,
  BrewState,
  EvalResult,
} from "./types";

// ── Multiset primitives ──────────────────────────────────────────────────────
// A multiset is a Record<token, count>. Counts are positive integers; a token
// with count 0 should be absent from the map.

export function msAdd(ms: Multiset, id: string, k = 1): void {
  ms[id] = (ms[id] || 0) + k;
}

export function msFromList(list: string[]): Multiset {
  const ms: Multiset = {};
  for (const id of list) msAdd(ms, id);
  return ms;
}

// Total count across all keys (multiplicity), NOT the number of distinct keys.
export function msSize(ms: Multiset): number {
  let n = 0;
  for (const k in ms) n += ms[k];
  return n;
}

// a - b, keeping only POSITIVE remainders.
export function msDiff(a: Multiset, b: Multiset): Multiset {
  const r: Multiset = {};
  for (const k in a) {
    const v = a[k] - (b[k] || 0);
    if (v > 0) r[k] = v;
  }
  return r;
}

// Equality over the union of keys, treating a missing key as count 0.
export function msEqual(a: Multiset, b: Multiset): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] || 0) !== (b[k] || 0)) return false;
  }
  return true;
}

export function msToList(ms: Multiset): string[] {
  const list: string[] = [];
  for (const k in ms) {
    for (let i = 0; i < ms[k]; i++) list.push(k);
  }
  return list;
}

// ── Brew tallies ─────────────────────────────────────────────────────────────

// Sum of every ingredient's emitted tokens (each token atomic).
export function baseTally(ingredients: Ingredient[]): Multiset {
  const ms: Multiset = {};
  for (const ing of ingredients) {
    for (const tok of ing.emits) msAdd(ms, tok);
  }
  return ms;
}

// Total ⊖ / ⊕ charges granted by the ingredients in the brew.
export function markerTotals(ingredients: Ingredient[]): {
  minus: number;
  plus: number;
} {
  let minus = 0;
  let plus = 0;
  for (const ing of ingredients) {
    minus += ing.minus;
    plus += ing.plus;
  }
  return { minus, plus };
}

// The brew's token multiset after applying ⊖ strikes and ⊕ summons.
export function effectiveTally(brew: BrewState): Multiset {
  const ms = baseTally(brew.ingredients);
  for (const id of brew.minusPlays) {
    if (ms[id]) {
      ms[id] -= 1;
      if (ms[id] === 0) delete ms[id];
    }
  }
  for (const id of brew.plusPlays) {
    msAdd(ms, id);
  }
  return ms;
}

// Charges still available: total granted minus the ones already played.
export function availableMarkers(brew: BrewState): {
  minus: number;
  plus: number;
} {
  const totals = markerTotals(brew.ingredients);
  return {
    minus: totals.minus - brew.minusPlays.length,
    plus: totals.plus - brew.plusPlays.length,
  };
}

// Evaluate a brew against a recipe.
export function evaluate(brew: BrewState, recipe: Recipe): EvalResult {
  const B = effectiveTally(brew);
  const R = msFromList(recipe.req);
  const markers = availableMarkers(brew);
  const M = markers.minus;
  const P = markers.plus;
  const excess = msDiff(B, R);
  const missing = msDiff(R, B);
  const exN = msSize(excess);
  const miN = msSize(missing);
  const status = msEqual(B, R)
    ? "perfect"
    : exN <= M && miN <= P
      ? "craftable"
      : "off";
  return { status, excess, missing, exN, miN, M, P };
}
