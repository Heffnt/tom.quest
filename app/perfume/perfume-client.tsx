"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ingredient, Recipe, BrewState } from "./lib/types";
import { baseIngredients, pureIngredients, baseRecipes } from "./data/base";
import {
  baseTally,
  markerTotals,
  availableMarkers,
  autoResolvePlays,
  evaluate,
} from "./lib/engine";
import Cauldron from "./components/cauldron";
import IngredientPanel from "./components/ingredient-panel";
import RecipeBook from "./components/recipe-book";

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Clamp manual plays to what the brew can support: no more ⊖/⊕ than markers, and
// a ⊖ may only target a token present in the BASE tally (the engine applies
// strikes before summons, so a strike on a summon-only token would waste the
// charge — summoned tokens are dispelled with onUnsummon instead).
function reconcile(ings: Ingredient[], strikePlays: string[], wildPlays: string[]) {
  const totals = markerTotals(ings);
  const nextWild = wildPlays.slice(0, totals.wild);
  const capped = strikePlays.slice(0, totals.strike);
  const avail: Record<string, number> = { ...baseTally(ings) };
  const nextStrike: string[] = [];
  for (const id of capped) {
    if ((avail[id] || 0) > 0) {
      avail[id]--;
      nextStrike.push(id);
    }
  }
  return { strike: nextStrike, wild: nextWild };
}

export default function PerfumeClient() {
  const ingByKey = useMemo(() => {
    const m = new Map<string, Ingredient>();
    for (const ing of [...baseIngredients, ...pureIngredients]) m.set(ing.key, ing);
    return m;
  }, []);

  // ---- brew state ----
  const [brewKeys, setBrewKeys] = useState<string[]>([]);
  const [strikePlays, setStrikePlays] = useState<string[]>([]);
  const [wildPlays, setWildPlays] = useState<string[]>([]);

  const brewIngredients = useMemo(
    () => brewKeys.map((k) => ingByKey.get(k)).filter((x): x is Ingredient => !!x),
    [brewKeys, ingByKey],
  );

  // keep plays valid as the brew changes
  const sane = useMemo(
    () => reconcile(brewIngredients, strikePlays, wildPlays),
    [brewIngredients, strikePlays, wildPlays],
  );
  useEffect(() => {
    if (!arraysEqual(sane.strike, strikePlays)) setStrikePlays(sane.strike);
    if (!arraysEqual(sane.wild, wildPlays)) setWildPlays(sane.wild);
  }, [sane, strikePlays, wildPlays]);

  const brew = useMemo<BrewState>(
    () => ({ ingredients: brewIngredients, strikePlays: sane.strike, wildPlays: sane.wild }),
    [brewIngredients, sane],
  );

  const avail = useMemo(() => availableMarkers(brew), [brew]);
  const base = useMemo(() => baseTally(brewIngredients), [brewIngredients]);

  const brewCounts = useMemo(() => {
    const order: string[] = [];
    const counts = new Map<string, number>();
    for (const k of brewKeys) {
      if (!ingByKey.has(k)) continue;
      if (!counts.has(k)) order.push(k);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return order.map((k) => {
      const ing = ingByKey.get(k)!;
      return { key: k, name: ing.name, color: ing.color, count: counts.get(k)! };
    });
  }, [brewKeys, ingByKey]);

  // ---- brew actions ----
  const addKey = useCallback((key: string) => setBrewKeys((p) => [...p, key]), []);
  const addKeyN = useCallback(
    (key: string, qty = 1) =>
      setBrewKeys((p) => [...p, ...Array<string>(Math.max(1, qty)).fill(key)]),
    [],
  );
  const decKey = useCallback(
    (key: string) =>
      setBrewKeys((p) => {
        const idx = p.lastIndexOf(key);
        if (idx === -1) return p;
        return [...p.slice(0, idx), ...p.slice(idx + 1)];
      }),
    [],
  );
  const clear = useCallback(() => {
    setBrewKeys([]);
    setStrikePlays([]);
    setWildPlays([]);
  }, []);

  const strike = useCallback(
    (id: string) => {
      const alreadyStruck = brew.strikePlays.filter((x) => x === id).length;
      if (avail.strike > 0 && (base[id] ?? 0) - alreadyStruck > 0) {
        setStrikePlays((p) => [...p, id]);
      }
    },
    [avail.strike, base, brew.strikePlays],
  );
  const unstrike = useCallback(
    (id: string) =>
      setStrikePlays((p) => {
        const i = p.indexOf(id);
        return i === -1 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      }),
    [],
  );
  const summon = useCallback(
    (id: string) => {
      if (avail.wild > 0) setWildPlays((p) => [...p, id]);
    },
    [avail.wild],
  );
  const unsummon = useCallback(
    (id: string) =>
      setWildPlays((p) => {
        const i = p.indexOf(id);
        return i === -1 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      }),
    [],
  );

  // load one of a recipe's common combos from the d40 table, greedily
  // auto-spending wildcards to land on that combo's tuning
  const loadCombo = useCallback(
    (recipe: Recipe, comboIndex: number) => {
      const combo = recipe.combos[comboIndex];
      if (!combo) return;
      const keys = combo.ings.map((name) => `base:${name}`);
      const ings = keys
        .map((k) => ingByKey.get(k))
        .filter((x): x is Ingredient => !!x);
      const plays = autoResolvePlays(ings, recipe.reqs[combo.req]);
      setBrewKeys(keys);
      setStrikePlays(plays.strikePlays);
      setWildPlays(plays.wildPlays);
    },
    [ingByKey],
  );

  // perfumes the current brew matches exactly — named on the cauldron
  const bottled = useMemo(
    () =>
      brew.ingredients.length === 0
        ? []
        : baseRecipes
            .filter((r) => evaluate(brew, r).status === "perfect")
            .map((r) => r.name),
    [brew],
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden bg-bg text-text">
      {/* the Byobu bench layout: library | cauldron | recipe book as three
          working columns on wide screens; on small screens the page scrolls
          through cauldron, then book, then library. The page banner is gone —
          the cauldron's own status bar carries the Perfumer's Bench name. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        {/* ingredient library */}
        <aside className="order-3 flex flex-col overflow-hidden border-t border-border p-3 max-lg:h-[72vh] max-lg:shrink-0 lg:order-1 lg:min-h-0 lg:w-[330px] lg:flex-none lg:border-r lg:border-t-0">
          <IngredientPanel ingredients={baseIngredients} onAdd={addKey} />
        </aside>

        {/* the cauldron */}
        <section className="order-1 flex min-w-0 flex-col max-lg:h-[56vh] max-lg:shrink-0 lg:order-2 lg:min-h-0 lg:flex-1">
          <Cauldron
            brew={brew}
            brewCounts={brewCounts}
            bottled={bottled}
            onInc={addKey}
            onDec={decKey}
            onStrike={strike}
            onUnstrike={unstrike}
            onSummon={summon}
            onUnsummon={unsummon}
            onClear={clear}
          />
        </section>

        {/* the formulary */}
        <aside className="order-2 flex flex-col overflow-hidden border-t border-border p-3 max-lg:h-[72vh] max-lg:shrink-0 lg:order-3 lg:min-h-0 lg:w-[400px] lg:flex-none lg:border-l lg:border-t-0 xl:w-[440px]">
          <RecipeBook
            recipes={baseRecipes}
            brew={brew}
            onLoadCombo={loadCombo}
            onAddIngredient={addKeyN}
          />
        </aside>
      </div>
    </div>
  );
}
