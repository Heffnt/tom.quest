// Matching engine for the Perfumer (/perfume).
// Pure TypeScript, shared by the client and (eventually) Convex mutations —
// there is exactly ONE implementation of the Three Feifs rules.
//
// The rules (see Byobu docs/SYSTEM.md and app/transcription.py RULINGS):
// - Frequencies COMBINE: a multiset equal to a named frequency's components is
//   interchangeable with it, so brews and requirements are compared as
//   combination-equivalence classes.
// - MULTIPLES: a brew makes one type of perfume but many copies — a tally
//   equal to k× a recipe brews k perfumes.

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

function msAdd(ms: Multiset, id: string, k = 1): void {
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

// Every count multiplied by k (k >= 1).
export function msScale(ms: Multiset, k: number): Multiset {
  if (k === 1) return ms;
  const r: Multiset = {};
  for (const key in ms) r[key] = ms[key] * k;
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

// True when every count in `a` fits inside `b`.
export function msIsSubset(a: Multiset, b: Multiset): boolean {
  for (const k in a) {
    if (a[k] > (b[k] || 0)) return false;
  }
  return true;
}

// ── Brew tallies ─────────────────────────────────────────────────────────────

// Sum of every ingredient's emitted frequencies.
function baseTally(ingredients: Ingredient[]): Multiset {
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

// The brew's frequency multiset after applying ⊖ strikes and ⊕ wilds.
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
function availableCharges(brew: BrewState): {
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

// Auto-combination fast core: whenever the pool holds every component of a
// named frequency, those components fuse into it. Runs to a fixpoint
// (cheapest first, chains allowed — a derived frequency can itself be
// consumed by a bigger one). This is the hot path used by brewTally/evalReq;
// it does not track WHICH combinations fired, so it never allocates the
// derived[] list — use the exported combineFrequencies for that.
function combineTally(pool: Multiset): { tally: Multiset } {
  const tally: Multiset = { ...pool };
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
        changed = true;
      }
    }
  }
  return { tally };
}

// Same fixpoint as combineTally, but also records every combination that
// fired (for tests and traceCombination-adjacent callers that need to show
// their work). The consumed components no longer count toward perfumes; only
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

// The frequencies the brew counts for perfumes: strikes and wilds applied
// to the raw emissions, then auto-combination.
export function brewTally(brew: BrewState): Multiset {
  return combineTally(effectiveTally(brew)).tally;
}

// ── Instance-level combination trace ─────────────────────────────────────────
// One live frequency in the pool, carrying a caller-supplied stable `ref` so the
// trace can name exactly WHICH instances fused. Refs must be unique across the
// input; the engine treats them as opaque.
export type FreqInstance = { ref: string; id: string };

// One combination that fired: the derived named frequency (with its own fresh
// `ref`, usable as a component ref for a chained combination) and the refs of
// the instances it consumed, in the source's component order.
export type CombinationStep = {
  ref: string; // stable ref of the derived node
  id: string; // the named frequency produced
  consumed: string[]; // refs of the consumed instances
};

// The full instance-level trace of auto-combination over a labeled pool.
// `survivors` are the instance refs that remain uncombined (they still count
// for recipes, alongside every derived step's node); `steps` is the fixpoint
// chain, cheapest-first, in the same order combineFrequencies fires. Pure and
// deterministic: same input refs/order → identical trace. The derived tally
// (combineFrequencies) and this trace agree by construction — both walk
// NAMED_BY_WEIGHT to a fixpoint — so callers never re-derive the rules.
export function traceCombination(pool: FreqInstance[]): {
  steps: CombinationStep[];
  survivors: string[];
} {
  // live[id] = queue of refs still available at that frequency id. A consumed
  // ref leaves its queue; a derived node's ref joins the queue for its id so it
  // can be consumed by a heavier combination (chaining).
  const live = new Map<string, string[]>();
  for (const inst of pool) {
    const q = live.get(inst.id);
    if (q) q.push(inst.ref);
    else live.set(inst.id, [inst.ref]);
  }
  const steps: CombinationStep[] = [];
  let derivedCount = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of NAMED_BY_WEIGHT) {
      // does every component have a live instance to draw on?
      const needed = msFromList(n.components);
      let subset = true;
      for (const id in needed) {
        if ((live.get(id)?.length ?? 0) < needed[id]) {
          subset = false;
          break;
        }
      }
      while (subset) {
        const consumed: string[] = [];
        for (const cid of n.components) {
          // n.components lists each component once per multiplicity, so a single
          // shift per entry draws the right number of instances.
          const ref = live.get(cid)!.shift()!;
          consumed.push(ref);
        }
        const ref = `combo:${n.id}:${derivedCount++}`;
        steps.push({ ref, id: n.id, consumed });
        const q = live.get(n.id);
        if (q) q.push(ref);
        else live.set(n.id, [ref]);
        changed = true;
        for (const id in needed) {
          if ((live.get(id)?.length ?? 0) < needed[id]) {
            subset = false;
            break;
          }
        }
      }
    }
  }
  const survivors: string[] = [];
  for (const refs of live.values()) {
    for (const ref of refs) if (!ref.startsWith("combo:")) survivors.push(ref);
  }
  return { steps, survivors };
}

const STATUS_ORDER: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Evaluate a brew against ONE recipe (target multiset).
//
// Combination makes a brew and a recipe each stand for an equivalence class:
// {Ev,Ev,En,C} and {Ignetium} are the same resonance. So both sides are
// compared in BOTH forms — raw and auto-combined — and the closest pairing
// wins. (Pensive Perfume's own recipe {Albutian,Chrysipil,N,T} self-combines
// into {Ontoligin,N,T}; raw-vs-raw keeps its common combo a perfect brew.)
//
// MULTIPLES: for each pairing, every copy-count k = 1..k* is tried, where
// k* = max over the recipe's frequencies of ceil(B_f / R_f) — beyond k* the
// excess cannot shrink further and missing only grows.
//
// - "perfect": some form of the brew equals k× some form of the recipe —
//   the brew makes k copies of the perfume.
// - "craftable" (shown as "in reach"): the perfume can still be made from
//   here by ADDING frequencies (more ingredients or pure frequencies fill
//   `missing`), provided any excess can be struck with the ⊖ charges on hand.
//   An empty cauldron therefore has every perfume in reach.
// - "off": the brew carries excess the available strikes can't remove at any k.
export function evalReq(
  brew: BrewState,
  req: string[],
  reqIndex = 0,
): EvalResult {
  const rawB = effectiveTally(brew);
  const combB = combineTally(rawB).tally;
  const rawR = msFromList(req);
  const combR = combineTally(rawR).tally;
  const charges = availableCharges(brew);
  const S = charges.strike;
  const W = charges.wild;
  const Bs = msEqual(rawB, combB) ? [rawB] : [rawB, combB];
  const Rs = msEqual(rawR, combR) ? [rawR] : [rawR, combR];
  let best: EvalResult | null = null;
  for (const B of Bs) {
    for (const R of Rs) {
      let kMax = 1;
      for (const f in R) {
        kMax = Math.max(kMax, Math.ceil((B[f] || 0) / R[f]));
      }
      for (let k = 1; k <= kMax; k++) {
        const kR = msScale(R, k);
        const excess = msDiff(B, kR);
        const missing = msDiff(kR, B);
        const exN = msSize(excess);
        const miN = msSize(missing);
        const status: EvalResult["status"] = msEqual(B, kR)
          ? "perfect"
          : exN <= S
            ? "craftable"
            : "off";
        const cand: EvalResult = { status, k, excess, missing, exN, miN, S, W, reqIndex };
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
  }
  return best!;
}

// Evaluate a brew against a perfume: the brew matches if it matches ANY recipe
// at ANY copy-count, so return the result for the closest one (best status,
// then least distance).
export function evaluate(brew: BrewState, perfume: Perfume): EvalResult {
  let best: EvalResult | null = null;
  for (let ri = 0; ri < perfume.recipes.length; ri++) {
    const e = evalReq(brew, perfume.recipes[ri], ri);
    if (
      !best ||
      STATUS_ORDER[e.status] < STATUS_ORDER[best.status] ||
      (STATUS_ORDER[e.status] === STATUS_ORDER[best.status] &&
        e.exN + e.miN < best.exN + best.miN)
    ) {
      best = e;
    }
  }
  return best!; // recipes is never empty
}

// ── Pin: the closest path (DESIGN §5) ────────────────────────────────────────
// The pin's solver. Over ALL of a perfume's recipes and every copy-count k the
// same k-bounds evalReq uses, find the satisfying target reachable with the
// FEWEST additions:
//   - `additions` is the frequency multiset you must still ADD (rendered as
//     ghost circles) so the brew's tally equals k× that recipe;
//   - `strikes` is the frequency multiset you must STRIKE off.
// Both sides are compared in raw and auto-combined form, exactly as evalReq
// pairs them, and the combination core is reused — no new math here.
//
// Selection order:
//  1. Add-only paths are STRONGLY preferred — a path that needs strikes is
//     chosen only when NO add-only path exists at any k for any recipe.
//  2. Among the surviving paths, minimize msSize(additions), then
//     msSize(strikes).
//  3. Ties break toward the common recipe (reqIndex 0), then smaller k.
// Returns null only when the perfume has no recipes. Pure.
export type ClosestPath = {
  reqIndex: number;
  k: number;
  additions: Multiset;
  strikes: Multiset;
};

export function closestPath(
  brew: BrewState,
  perfume: Perfume,
): ClosestPath | null {
  if (perfume.recipes.length === 0) return null;

  const rawB = effectiveTally(brew);
  const combB = combineTally(rawB).tally;
  const Bs = msEqual(rawB, combB) ? [rawB] : [rawB, combB];

  type Cand = ClosestPath & { addN: number; strN: number };

  // Total order matching the selection rules above (min is the winner):
  // add-only first, then fewer additions, then fewer strikes, then the common
  // recipe, then the smaller k.
  const better = (a: Cand, b: Cand): boolean => {
    const aAddOnly = a.strN === 0;
    const bAddOnly = b.strN === 0;
    if (aAddOnly !== bAddOnly) return aAddOnly;
    if (a.addN !== b.addN) return a.addN < b.addN;
    if (a.strN !== b.strN) return a.strN < b.strN;
    if (a.reqIndex !== b.reqIndex) return a.reqIndex < b.reqIndex;
    return a.k < b.k;
  };

  let best: Cand | null = null;
  for (let reqIndex = 0; reqIndex < perfume.recipes.length; reqIndex++) {
    const rawR = msFromList(perfume.recipes[reqIndex]);
    const combR = combineTally(rawR).tally;
    const Rs = msEqual(rawR, combR) ? [rawR] : [rawR, combR];
    for (const B of Bs) {
      for (const R of Rs) {
        // Same k range evalReq scans: beyond k* the excess cannot shrink and
        // the missing only grows.
        let kMax = 1;
        for (const f in R) {
          kMax = Math.max(kMax, Math.ceil((B[f] || 0) / R[f]));
        }
        for (let k = 1; k <= kMax; k++) {
          const kR = msScale(R, k);
          const additions = msDiff(kR, B); // k·R - B : still to add
          const strikes = msDiff(B, kR); // B - k·R : still to strike
          const cand: Cand = {
            reqIndex,
            k,
            additions,
            strikes,
            addN: msSize(additions),
            strN: msSize(strikes),
          };
          if (!best || better(cand, best)) best = cand;
        }
      }
    }
  }

  // recipes is non-empty, so at least one k=1 candidate was produced.
  return {
    reqIndex: best!.reqIndex,
    k: best!.k,
    additions: best!.additions,
    strikes: best!.strikes,
  };
}

export type FoundRecipe = { ings: string[]; strikes: number };

// Every combination of ingredients that lands on the target recipe, found by
// depth-first search over the catalog (repeats allowed, e.g. Chrythsmeum ×4;
// non-decreasing candidate order avoids permutation duplicates). Pure,
// strike-carrying and wild-carrying ingredients are always excluded — a combo
// is emitted frequencies only.
//
// `maxStrikes` is how far a combo may over-emit: `strikes` is the number of ⊖
// the brewer must supply FROM ELSEWHERE (a Shadow Demon Liver, a pure strike)
// to remove the excess. With maxStrikes 0 combos sum exactly to the recipe;
// every ingredient must contribute at least one needed frequency, so no combo
// carries a purely useless ingredient.
export function findRecipes(
  req: string[],
  ingredients: Ingredient[],
  maxStrikes = 0,
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
      maxStrikes > 0
        ? i.emits.some((t) => (target[t] || 0) > 0)
        : msIsSubset(msFromList(i.emits), target),
    )
    .map((i) => ({ name: i.name, ms: msFromList(i.emits) }));
  const results: FoundRecipe[] = [];
  const cur: string[] = [];
  const dfs = (remaining: Multiset, excess: number, start: number): void => {
    if (results.length >= cap) return;
    if (msSize(remaining) === 0) {
      results.push({ ings: [...cur], strikes: excess });
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
      if (!consumed) continue; // contributes nothing toward the recipe
      if (excess + over > maxStrikes) continue;
      cur.push(c.name);
      dfs(next, excess + over, k);
      cur.pop();
      if (results.length >= cap) return;
    }
  };
  dfs(target, 0, 0);
  return results.sort(
    (a, b) => a.strikes - b.strikes || a.ings.length - b.ings.length,
  );
}

// Greedily spend ⊖ on excess and ⊕ on missing until `ingredients` matches the
// target recipe exactly at k=1 (or charges run out). Pure: returns the plays
// to apply.
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
