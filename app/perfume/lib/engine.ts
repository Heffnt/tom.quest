// Matching engine for the Perfumer's Bench (/perfume).
// Pure-TypeScript port of the Three Feifs matching logic from the Byobu repo
// (index.html lines 2314-2369). Named frequencies are ATOMIC frequencies —
// they are never unpacked into their fundamental components for matching.

import type {
  Multiset,
  Ingredient,
  Recipe,
  BrewState,
  EvalResult,
} from "./types";
import { named } from "../data/base";

// ── Multiset primitives ──────────────────────────────────────────────────────
// A multiset is a Record<frequency, count>. Counts are positive integers; a
// frequency with count 0 should be absent from the map.

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

// Sum of every ingredient's emitted frequencies (each frequency atomic).
export function baseTally(ingredients: Ingredient[]): Multiset {
  const ms: Multiset = {};
  for (const ing of ingredients) {
    for (const freq of ing.emits) msAdd(ms, freq);
  }
  return ms;
}

// Total ⊖ / ⊕ strike/wild charges granted by the ingredients in the brew.
export function chargeTotals(ingredients: Ingredient[]): {
  strike: number;
  wild: number;
} {
  let strike = 0;
  let wild = 0;
  for (const ing of ingredients) {
    strike += ing.strike;
    wild += ing.wild;
  }
  return { strike, wild };
}

// The brew's frequency multiset after applying ⊖ strikes and ⊕ summons.
export function effectiveTally(brew: BrewState): Multiset {
  const ms = baseTally(brew.ingredients);
  for (const id of brew.strikePlays) {
    if (ms[id]) {
      ms[id] -= 1;
      if (ms[id] === 0) delete ms[id];
    }
  }
  for (const id of brew.wildPlays) {
    msAdd(ms, id);
  }
  return ms;
}

// Strike/wild charges still available: total granted minus the ones already played.
export function availableCharges(brew: BrewState): {
  strike: number;
  wild: number;
} {
  const totals = chargeTotals(brew.ingredients);
  return {
    strike: totals.strike - brew.strikePlays.length,
    wild: totals.wild - brew.wildPlays.length,
  };
}

// ── Auto-combination ─────────────────────────────────────────────────────────

export type DerivedCombination = { id: string; consumed: string[] };

// Named frequencies sorted cheapest-first, so combinations build bottom-up
// (fundamental sets fuse into the small named frequencies before those can
// fuse into bigger ones).
const NAMED_BY_WEIGHT = [...named].sort((a, b) => a.weight - b.weight);

// Auto-combination: whenever the brew holds every component of a named
// frequency, those components fuse into it. Runs to a fixpoint (cheapest
// first, chains allowed — a derived frequency can itself be consumed by a
// bigger one). The consumed components no longer count toward recipes; only
// the tally AFTER combination does.
export function combineFrequencies(pool: Multiset): {
  tally: Multiset;
  derived: DerivedCombination[];
} {
  const tally: Multiset = { ...pool };
  const derived: DerivedCombination[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of NAMED_BY_WEIGHT) {
      const comps = msFromList(n.components);
      while (msIsSubset(comps, tally)) {
        for (const k in comps) {
          tally[k] -= comps[k];
          if (tally[k] === 0) delete tally[k];
        }
        msAdd(tally, n.id);
        derived.push({ id: n.id, consumed: [...n.components] });
        changed = true;
      }
    }
  }
  return { tally, derived };
}

// The frequencies the brew counts for recipes: strikes and summons applied
// to the raw emissions, then auto-combination.
export function brewTally(brew: BrewState): Multiset {
  return combineFrequencies(effectiveTally(brew)).tally;
}

const STATUS_ORDER: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Evaluate a brew against ONE tuning (target multiset).
//
// Combination makes a brew and a tuning each stand for an equivalence class:
// {Ev,Ev,En,C} and {Ignetium} are the same resonance. So both sides are
// compared in BOTH forms — raw and auto-combined — and the closest pairing
// wins. (Pensive Perfume's own tuning {Albutian,Chrysipil,N,T} self-combines
// into {Ontoligin,N,T}; raw-vs-raw keeps its common combo a perfect brew.)
//
// - "perfect": some form of the brew equals some form of the tuning — brewed.
// - "craftable" (shown as "in reach"): the perfume can still be made from
//   here by ADDING frequencies (more ingredients or pure frequencies fill
//   `missing`), provided any excess can be struck with the ⊖ charges on hand.
//   An empty cauldron therefore has every recipe in reach.
// - "off": the brew carries excess the available strikes can't remove.
export function evalReq(
  brew: BrewState,
  req: string[],
  reqIndex = 0,
): EvalResult {
  const rawB = effectiveTally(brew);
  const combB = combineFrequencies(rawB).tally;
  const rawR = msFromList(req);
  const combR = combineFrequencies(rawR).tally;
  const charges = availableCharges(brew);
  const S = charges.strike;
  const W = charges.wild;
  const Bs = msEqual(rawB, combB) ? [rawB] : [rawB, combB];
  const Rs = msEqual(rawR, combR) ? [rawR] : [rawR, combR];
  let best: EvalResult | null = null;
  for (const B of Bs) {
    for (const R of Rs) {
      const excess = msDiff(B, R);
      const missing = msDiff(R, B);
      const exN = msSize(excess);
      const miN = msSize(missing);
      const status: EvalResult["status"] = msEqual(B, R)
        ? "perfect"
        : exN <= S
          ? "craftable"
          : "off";
      const cand: EvalResult = { status, excess, missing, exN, miN, S, W, reqIndex };
      if (
        !best ||
        STATUS_ORDER[cand.status] < STATUS_ORDER[best.status] ||
        (STATUS_ORDER[cand.status] === STATUS_ORDER[best.status] &&
          cand.exN + cand.miN < best.exN + best.miN)
      ) {
        best = cand;
      }
    }
  }
  return best!;
}

// Evaluate a brew against a recipe: the brew matches if it matches ANY tuning,
// so return the result for the closest one (best status, then least distance).
export function evaluate(brew: BrewState, recipe: Recipe): EvalResult {
  let best: EvalResult | null = null;
  for (let ri = 0; ri < recipe.reqs.length; ri++) {
    const e = evalReq(brew, recipe.reqs[ri], ri);
    if (
      !best ||
      STATUS_ORDER[e.status] < STATUS_ORDER[best.status] ||
      (STATUS_ORDER[e.status] === STATUS_ORDER[best.status] &&
        e.exN + e.miN < best.exN + best.miN)
    ) {
      best = e;
    }
  }
  return best!; // reqs is never empty
}

// True when every count in `a` fits inside `b`.
export function msIsSubset(a: Multiset, b: Multiset): boolean {
  for (const k in a) {
    if (a[k] > (b[k] || 0)) return false;
  }
  return true;
}

// Every combination of ingredients whose emissions sum EXACTLY to the target
// tuning — no strikes, no wilds. Computed by depth-first exact cover over the
// candidates whose emissions fit inside the target (repeats allowed, e.g.
// Chrythsmeum ×4; non-decreasing candidate order avoids permutation dupes).
// Pure-frequency ingredients and charge-carrying ingredients are excluded: the
// point is real recipes, and a strike/wild in the pot is by definition not "no wilds".
export function findExactCombos(
  req: string[],
  ingredients: Ingredient[],
  cap = 24,
): string[][] {
  const target = msFromList(req);
  const cands = ingredients
    .filter(
      (i) =>
        i.emits.length > 0 &&
        i.strike === 0 &&
        i.wild === 0 &&
        !i.key.startsWith("pure:") &&
        msIsSubset(msFromList(i.emits), target),
    )
    .map((i) => ({ name: i.name, ms: msFromList(i.emits) }));
  const results: string[][] = [];
  const cur: string[] = [];
  const dfs = (remaining: Multiset, start: number): void => {
    if (results.length >= cap) return;
    if (msSize(remaining) === 0) {
      results.push([...cur]);
      return;
    }
    for (let k = start; k < cands.length; k++) {
      const c = cands[k];
      if (!msIsSubset(c.ms, remaining)) continue;
      cur.push(c.name);
      dfs(msDiff(remaining, c.ms), k);
      cur.pop();
      if (results.length >= cap) return;
    }
  };
  dfs(target, 0);
  return results.sort((a, b) => a.length - b.length);
}

// Greedily spend ⊖ on excess and ⊕ on missing until `ingredients` matches the
// target tuning exactly (or charges run out). Pure: returns the plays to apply.
export function autoResolvePlays(
  ingredients: Ingredient[],
  req: string[],
): { strikePlays: string[]; wildPlays: string[] } {
  const R = msFromList(req);
  const strikePlays: string[] = [];
  const wildPlays: string[] = [];
  for (let guard = 0; guard < 80; guard++) {
    const state: BrewState = { ingredients, strikePlays, wildPlays };
    const B = effectiveTally(state);
    if (msEqual(B, R)) break;
    const avail = availableCharges(state);
    const excess = Object.keys(msDiff(B, R));
    const missing = Object.keys(msDiff(R, B));
    if (avail.strike > 0 && excess.length) strikePlays.push(excess[0]);
    else if (avail.wild > 0 && missing.length) wildPlays.push(missing[0]);
    else break;
  }
  return { strikePlays, wildPlays };
}
