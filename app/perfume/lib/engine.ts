// Matching engine for the Perfumer's Bench (/perfume).
// Pure-TypeScript port of the Three Feifs matching logic from the Byobu repo
// (index.html lines 2314-2369). Named frequencies are ATOMIC frequencies —
// they are never unpacked into their fundamental components for matching.

import type {
  Multiset,
  Ingredient,
  Perfume,
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
// bigger one). The consumed components no longer count toward perfumes; only
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

// The frequencies the brew counts for perfumes: strikes and summons applied
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
//   An empty cauldron therefore has every perfume in reach.
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

// Evaluate a brew against a perfume: the brew matches if it matches ANY tuning,
// so return the result for the closest one (best status, then least distance).
export function evaluate(brew: BrewState, perfume: Perfume): EvalResult {
  let best: EvalResult | null = null;
  for (let ri = 0; ri < perfume.reqs.length; ri++) {
    const e = evalReq(brew, perfume.reqs[ri], ri);
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

export type FoundRecipe = { ings: string[]; trim: number };

// Every combination of ingredients that lands on the target tuning, found by
// depth-first search over the catalog (repeats allowed, e.g. Chrythsmeum ×4;
// non-decreasing candidate order avoids permutation duplicates). Pure,
// strike-carrying and wild-carrying ingredients are always excluded — a combo
// is emitted frequencies only.
//
// `maxTrim` is how far a combo may over-emit: `trim` is the number of ⊖
// strikes the perfumer must supply FROM ELSEWHERE (a Shadow Demon Liver, a
// pure strike) to remove the excess. With maxTrim 0 combos sum exactly to
// the tuning; every ingredient must contribute at least one needed frequency,
// so no combo carries a purely useless ingredient.
export function findRecipes(
  req: string[],
  ingredients: Ingredient[],
  maxTrim = 0,
  cap = 24,
): FoundRecipe[] {
  const target = msFromList(req);
  const reqSize = msSize(target);
  const cands = ingredients
    .filter(
      (i) =>
        !i.key.startsWith("pure:") &&
        i.strike === 0 &&
        i.wild === 0 &&
        i.emits.length > 0,
    )
    .filter((i) =>
      maxTrim > 0
        ? i.emits.some((t) => (target[t] || 0) > 0)
        : msIsSubset(msFromList(i.emits), target),
    )
    .map((i) => ({ name: i.name, ms: msFromList(i.emits) }));
  const results: FoundRecipe[] = [];
  const cur: string[] = [];
  const dfs = (remaining: Multiset, excess: number, start: number): void => {
    if (results.length >= cap) return;
    if (msSize(remaining) === 0) {
      results.push({ ings: [...cur], trim: excess });
      return;
    }
    if (cur.length >= reqSize + 2) return;
    for (let k = start; k < cands.length; k++) {
      const c = cands[k];
      let over = 0;
      let consumed = false;
      const next = { ...remaining };
      for (const id in c.ms) {
        const take = Math.min(c.ms[id], next[id] || 0);
        if (take > 0) {
          next[id] -= take;
          if (next[id] === 0) delete next[id];
          consumed = true;
        }
        over += c.ms[id] - take;
      }
      if (!consumed) continue; // contributes nothing toward the tuning
      if (excess + over > maxTrim) continue;
      cur.push(c.name);
      dfs(next, excess + over, k);
      cur.pop();
      if (results.length >= cap) return;
    }
  };
  dfs(target, 0, 0);
  return results.sort(
    (a, b) => a.trim - b.trim || a.ings.length - b.ings.length,
  );
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
