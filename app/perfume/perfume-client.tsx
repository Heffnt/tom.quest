"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "../lib/auth";
import LoginModal from "../components/login-modal";
import type { Ingredient, Recipe, BrewState, Tier } from "./lib/types";
import { baseIngredients, baseRecipes } from "./data/base";
import {
  baseTally,
  markerTotals,
  effectiveTally,
  availableMarkers,
  msFromList,
  msDiff,
  msEqual,
} from "./lib/engine";
import Cauldron from "./components/cauldron";
import IngredientPanel from "./components/ingredient-panel";
import RecipeBook from "./components/recipe-book";
import AddIngredientModal from "./components/add-ingredient-modal";
import AddRecipeModal from "./components/add-recipe-modal";

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Merge the public list with the viewer's own list, de-duped by _id, so a
// creator's items are never hidden by the public list's size cap.
function mergeById<T extends { _id: string }>(
  a: T[] | undefined,
  b: T[] | undefined,
): T[] {
  const m = new Map<string, T>();
  for (const d of a ?? []) m.set(d._id, d);
  for (const d of b ?? []) m.set(d._id, d);
  return [...m.values()];
}

// Clamp manual plays to what the brew can actually support: no more ⊖/⊕ than
// markers, and a ⊖ may only target a token present in the BASE tally (not a
// summoned one). The engine applies strikes before summons, so a strike on a
// summon-only token would silently no-op and waste the charge — summoned tokens
// are dispelled with onUnsummon instead.
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
  const { user } = useAuth();
  const currentUserId = user?._id;

  // ---- catalog (base + user-created) ----
  const customIngredientDocs = useQuery(api.perfume.listIngredients, {});
  const myIngredientDocs = useQuery(api.perfume.listMineIngredients, {});
  const customRecipeDocs = useQuery(api.perfume.listRecipes, {});
  const myRecipeDocs = useQuery(api.perfume.listMineRecipes, {});

  const customIngredients = useMemo<Ingredient[]>(
    () =>
      mergeById(customIngredientDocs, myIngredientDocs).map((d) => ({
        key: `user:${d._id}`,
        name: d.name,
        emits: d.emits,
        minus: d.minus,
        plus: d.plus,
        color: d.color,
        source: { kind: "user", userId: d.userId, name: d.creatorName },
      })),
    [customIngredientDocs, myIngredientDocs],
  );
  const customRecipes = useMemo<Recipe[]>(
    () =>
      mergeById(customRecipeDocs, myRecipeDocs).map((d) => ({
        key: `user:${d._id}`,
        name: d.name,
        school: d.school,
        tier: d.tier as Tier,
        req: d.req,
        desc: d.desc,
        source: { kind: "user", userId: d.userId, name: d.creatorName },
      })),
    [customRecipeDocs, myRecipeDocs],
  );

  const allIngredients = useMemo(
    () => [...baseIngredients, ...customIngredients],
    [customIngredients],
  );
  const allRecipes = useMemo(() => [...baseRecipes, ...customRecipes], [customRecipes]);
  const ingByKey = useMemo(() => {
    const m = new Map<string, Ingredient>();
    for (const ing of allIngredients) m.set(ing.key, ing);
    return m;
  }, [allIngredients]);

  // ---- brew state ----
  const [brewKeys, setBrewKeys] = useState<string[]>([]);
  const [minusPlays, setMinusPlays] = useState<string[]>([]);
  const [plusPlays, setPlusPlays] = useState<string[]>([]);

  // drop brew entries whose ingredient no longer exists (e.g. a custom one deleted)
  useEffect(() => {
    setBrewKeys((prev) => {
      const next = prev.filter((k) => ingByKey.has(k));
      return next.length === prev.length ? prev : next;
    });
  }, [ingByKey]);

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
      // Only base-emitted tokens can be struck; summoned tokens are dispelled
      // via onUnsummon. Guard against spending a ⊖ on a summon-only token.
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

  // load a base recipe's worked example (greedily auto-spending wildcards)
  const loadExample = useCallback(
    (recipe: Recipe) => {
      if (!recipe.example) return;
      const keys = recipe.example.map((name) => `base:${name}`);
      const ings = keys
        .map((k) => ingByKey.get(k))
        .filter((x): x is Ingredient => !!x);
      const R = msFromList(recipe.req);
      const mp: string[] = [];
      const pp: string[] = [];
      for (let i = 0; i < 80; i++) {
        const state: BrewState = { ingredients: ings, minusPlays: mp, plusPlays: pp };
        const B = effectiveTally(state);
        if (msEqual(B, R)) break;
        const a = availableMarkers(state);
        const excess = Object.keys(msDiff(B, R));
        const missing = Object.keys(msDiff(R, B));
        if (a.minus > 0 && excess.length) mp.push(excess[0]);
        else if (a.plus > 0 && missing.length) pp.push(missing[0]);
        else break;
      }
      setBrewKeys(keys);
      setMinusPlays(mp);
      setPlusPlays(pp);
    },
    [ingByKey],
  );

  // ---- create / delete (auth-gated) ----
  const addIngredientMut = useMutation(api.perfume.addIngredient);
  const addRecipeMut = useMutation(api.perfume.addRecipe);
  const removeIngredientMut = useMutation(api.perfume.removeIngredient);
  const removeRecipeMut = useMutation(api.perfume.removeRecipe);

  const [loginOpen, setLoginOpen] = useState(false);
  const [addIngredientOpen, setAddIngredientOpen] = useState(false);
  const [addRecipeOpen, setAddRecipeOpen] = useState(false);

  const requestAddIngredient = useCallback(() => {
    if (user) setAddIngredientOpen(true);
    else setLoginOpen(true);
  }, [user]);
  const requestAddRecipe = useCallback(() => {
    if (user) setAddRecipeOpen(true);
    else setLoginOpen(true);
  }, [user]);

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
            <RecipeBook
              recipes={allRecipes}
              brew={brew}
              onRequestAdd={requestAddRecipe}
              canCreate={!!user}
              currentUserId={currentUserId}
              onLoadExample={loadExample}
              onRemoveCustom={(id) => removeRecipeMut({ id: id as Id<"perfumeRecipes"> })}
            />
          </div>
        </div>

        {/* right column: ingredient library, full height to the bottom-right corner */}
        <aside className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border p-3 md:w-[348px] md:flex-none md:border-l md:border-t-0">
          <IngredientPanel
            ingredients={allIngredients}
            onAdd={addKey}
            onRequestAdd={requestAddIngredient}
            canCreate={!!user}
            currentUserId={currentUserId}
            onRemoveCustom={(id) =>
              removeIngredientMut({ id: id as Id<"perfumeIngredients"> })
            }
          />
        </aside>
      </div>

      <AddIngredientModal
        isOpen={addIngredientOpen}
        onClose={() => setAddIngredientOpen(false)}
        onSubmit={async (data) => {
          await addIngredientMut(data);
        }}
      />
      <AddRecipeModal
        isOpen={addRecipeOpen}
        onClose={() => setAddRecipeOpen(false)}
        onSubmit={async (data) => {
          await addRecipeMut(data);
        }}
      />
      <LoginModal isOpen={loginOpen} onClose={() => setLoginOpen(false)} />
    </div>
  );
}
