"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Ingredient, Recipe, BrewState } from "./lib/types";
import { baseIngredients, baseRecipes } from "./data/base";
import {
  baseTally,
  markerTotals,
  availableMarkers,
  autoResolvePlays,
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
function reconcile(ings: Ingredient[], minus: string[], plus: string[]) {
  const totals = markerTotals(ings);
  const nextPlus = plus.slice(0, totals.plus);
  const capped = minus.slice(0, totals.minus);
  const avail: Record<string, number> = { ...baseTally(ings) };
  const nextMinus: string[] = [];
  for (const id of capped) {
    if ((avail[id] || 0) > 0) {
      avail[id]--;
      nextMinus.push(id);
    }
  }
  return { minus: nextMinus, plus: nextPlus };
}

export default function PerfumeClient() {
  const ingByKey = useMemo(() => {
    const m = new Map<string, Ingredient>();
    for (const ing of baseIngredients) m.set(ing.key, ing);
    return m;
  }, []);

  // ---- brew state ----
  const [brewKeys, setBrewKeys] = useState<string[]>([]);
  const [minusPlays, setMinusPlays] = useState<string[]>([]);
  const [plusPlays, setPlusPlays] = useState<string[]>([]);

  const brewIngredients = useMemo(
    () => brewKeys.map((k) => ingByKey.get(k)).filter((x): x is Ingredient => !!x),
    [brewKeys, ingByKey],
  );

  // keep plays valid as the brew changes
  const sane = useMemo(
    () => reconcile(brewIngredients, minusPlays, plusPlays),
    [brewIngredients, minusPlays, plusPlays],
  );
  useEffect(() => {
    if (!arraysEqual(sane.minus, minusPlays)) setMinusPlays(sane.minus);
    if (!arraysEqual(sane.plus, plusPlays)) setPlusPlays(sane.plus);
  }, [sane, minusPlays, plusPlays]);

  const brew = useMemo<BrewState>(
    () => ({ ingredients: brewIngredients, minusPlays: sane.minus, plusPlays: sane.plus }),
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
    setMinusPlays([]);
    setPlusPlays([]);
  }, []);

  const strike = useCallback(
    (id: string) => {
      const alreadyStruck = brew.minusPlays.filter((x) => x === id).length;
      if (avail.minus > 0 && (base[id] ?? 0) - alreadyStruck > 0) {
        setMinusPlays((p) => [...p, id]);
      }
    },
    [avail.minus, base, brew.minusPlays],
  );
  const unstrike = useCallback(
    (id: string) =>
      setMinusPlays((p) => {
        const i = p.indexOf(id);
        return i === -1 ? p : [...p.slice(0, i), ...p.slice(i + 1)];
      }),
    [],
  );
  const summon = useCallback(
    (id: string) => {
      if (avail.plus > 0) setPlusPlays((p) => [...p, id]);
    },
    [avail.plus],
  );
  const unsummon = useCallback(
    (id: string) =>
      setPlusPlays((p) => {
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
      setMinusPlays(plays.minusPlays);
      setPlusPlays(plays.plusPlays);
    },
    [ingByKey],
  );

  return (
    <div className="flex h-[calc(100vh-4rem)] flex-col overflow-hidden bg-bg text-text">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
        <h1 className="font-display text-lg text-text">
          Perfumer&apos;s <span className="text-accent">Bench</span>
        </h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-text-faint">
          Three Feifs
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* left column: cauldron on top, recipe book beneath it. min-w-0 lets it
            shrink to its flex share so the recipe book's horizontal scroll is
            contained instead of pushing the ingredient column off-screen. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <section className="flex min-h-0 flex-1 flex-col">
            <Cauldron
              brew={brew}
              brewCounts={brewCounts}
              onInc={addKey}
              onDec={decKey}
              onStrike={strike}
              onUnstrike={unstrike}
              onSummon={summon}
              onUnsummon={unsummon}
              onClear={clear}
            />
          </section>

          <div className="shrink-0 border-t border-border">
            <RecipeBook recipes={baseRecipes} brew={brew} onLoadCombo={loadCombo} />
          </div>
        </div>

        {/* right column: ingredient library, full height to the bottom-right corner */}
        <aside className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border p-3 md:w-[348px] md:flex-none md:border-l md:border-t-0">
          <IngredientPanel ingredients={baseIngredients} onAdd={addKey} />
        </aside>
      </div>
    </div>
  );
}
