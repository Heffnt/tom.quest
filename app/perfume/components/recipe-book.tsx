"use client";

// The recipe panel: a vertical, searchable book of the 41 d40 recipes, one
// COMPACT strip each: name + weight (with the "recipes" fold button under
// them), the integrated frequency requirement as bare symbols (shared core,
// interchangeable alternatives in parentheses, optional extras dashed), and
// the brew formula — a mini cauldron + the box of frequencies still missing
// (strikes needed shown as that many ⊖ icons). The fold lists every
// ingredient combination (common d40 ones first), grouped by the outside
// strikes required: strike-free first, then ⊖1 / ⊖2 behind reveal buttons.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Multiset, Recipe, EvalResult, RecipeSlotEntry } from "../lib/types";
import type { RecipeBookProps } from "./contracts";
import {
  evaluate,
  msToList,
  msFromList,
  msDiff,
  findRecipeCombos,
  type FoundCombo,
} from "../lib/engine";
import {
  ALL_FREQUENCIES,
  FUND,
  baseIngredients,
  recipeWeight,
} from "../data/base";
import { FrequencySymbol, FrequencyGlyph, COPPER, STRIKE } from "../lib/frequencies";

const STATUS_RANK: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Display order for frequencies inside a tuning row: fundamentals in canonical
// order, then named frequencies by complexity (ALL_FREQUENCIES is already sorted).
const FREQ_ORDER = new Map(ALL_FREQUENCIES.map((t, i) => [t.id, i]));
const ING_BY_NAME = new Map(baseIngredients.map((i) => [i.name, i]));

function groupFrequencies(req: string[]): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of req) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => (FREQ_ORDER.get(a[0]) ?? 99) - (FREQ_ORDER.get(b[0]) ?? 99))
    .map(([id, count]) => ({ id, count }));
}

// Search by perfume name, common ingredient, or required frequency (frequency id
// or its school name).
function matchesQuery(r: Recipe, q: string): boolean {
  if (!q) return true;
  if (r.name.toLowerCase().includes(q)) return true;
  if (r.slots.some((slot) => slot.some((e) => e.name.toLowerCase().includes(q))))
    return true;
  return r.reqs.some((req) =>
    req.some(
      (id) =>
        id.toLowerCase().includes(q) ||
        (FUND[id]?.school ?? "").toLowerCase().includes(q),
    ),
  );
}

// ── integrated requirements ──────────────────────────────────────────────────
// One recipe, one display: the frequencies shared by every tuning (`core`)
// plus choice groups where tunings differ. A group is `optional` when one of
// its source alternatives contributes nothing extra (e.g. Amber vs Gold —
// Ignetium is optional on top of the shared T).

type ChoiceGroup = { options: string[][]; optional: boolean };
type Integrated = { core: string[]; groups: ChoiceGroup[] };

function canon(list: string[]): string {
  return [...list].sort().join("|");
}

function msIntersect(list: Multiset[]): Multiset {
  const out: Multiset = { ...list[0] };
  for (const m of list.slice(1)) {
    for (const k of Object.keys(out)) {
      const v = Math.min(out[k], m[k] || 0);
      if (v > 0) out[k] = v;
      else delete out[k];
    }
  }
  return out;
}

// Turn remainders into a choice group (deduped); an empty remainder means the
// remaining options are optional extras.
function toGroup(rems: string[][]): ChoiceGroup | null {
  const nonEmpty = rems.filter((r) => r.length > 0);
  const optional = nonEmpty.length < rems.length;
  const seen = new Set<string>();
  const options: string[][] = [];
  for (const r of nonEmpty) {
    const c = canon(r);
    if (!seen.has(c)) {
      seen.add(c);
      options.push(r);
    }
  }
  return options.length ? { options, optional } : null;
}

const INTEGRATED = new Map<string, Integrated>();

function integrateRecipe(recipe: Recipe): Integrated {
  const cached = INTEGRATED.get(recipe.key);
  if (cached) return cached;
  const result = computeIntegrated(recipe);
  INTEGRATED.set(recipe.key, result);
  return result;
}

function computeIntegrated(recipe: Recipe): Integrated {
  if (recipe.reqs.length === 1) return { core: recipe.reqs[0], groups: [] };

  // Preferred: factor by the common recipe's slots — each slot's alternatives
  // become one independent choice group. Only trusted when the cartesian
  // product of slot emissions reproduces the tunings exactly.
  const slotAlts: string[][][] = [];
  let ok = true;
  for (const slot of recipe.slots) {
    const alts: string[][] = [];
    const seen = new Set<string>();
    for (const e of slot) {
      if (!e.known) continue;
      const ing = ING_BY_NAME.get(e.name);
      if (!ing) continue;
      const emits: string[] = [];
      for (let i = 0; i < e.qty; i++) emits.push(...ing.emits);
      const c = canon(emits);
      if (!seen.has(c)) {
        seen.add(c);
        alts.push(emits);
      }
    }
    if (!alts.length) {
      ok = false;
      break;
    }
    slotAlts.push(alts);
  }
  if (ok) {
    const products: string[] = [];
    const build = (i: number, acc: string[]) => {
      if (i === slotAlts.length) {
        products.push(canon(acc));
        return;
      }
      for (const alt of slotAlts[i]) build(i + 1, [...acc, ...alt]);
    };
    build(0, []);
    const reqSet = new Set(recipe.reqs.map((r) => canon(r)));
    ok = products.every((p) => reqSet.has(p)) && new Set(products).size === reqSet.size;
  }
  if (ok) {
    const core: string[] = [];
    const groups: ChoiceGroup[] = [];
    for (const alts of slotAlts) {
      if (alts.length === 1) {
        core.push(...alts[0]);
        continue;
      }
      const msAlts = alts.map(msFromList);
      const inter = msIntersect(msAlts);
      core.push(...msToList(inter));
      const g = toGroup(msAlts.map((m) => msToList(msDiff(m, inter))));
      if (g) groups.push(g);
    }
    return { core, groups };
  }

  // Fallback: shared part of all tunings + one group of the leftovers.
  const msReqs = recipe.reqs.map(msFromList);
  const inter = msIntersect(msReqs);
  const g = toGroup(msReqs.map((m) => msToList(msDiff(m, inter))));
  return { core: msToList(inter), groups: g ? [g] : [] };
}

// ── the "recipes" fold ───────────────────────────────────────────────────────
// Per tuning, EVERY combo — the common d40 ones plus everything the solver
// finds — grouped by the strikes the perfumer must supply: tier 0 is
// self-sufficient, tiers 1 and 2 over-emit and need that many ⊖ from
// elsewhere. A common combo whose own ingredients carry the strikes it
// spends (Black Gas's liver) counts as tier 0. Cached — static inputs.

const MAX_TRIM = 2;

// tiers[req index][trim] -> combos needing exactly that many outside strikes
const MORE_CACHE = new Map<string, FoundCombo[][][]>();

function moreCombosFor(recipe: Recipe): FoundCombo[][][] {
  const cached = MORE_CACHE.get(recipe.key);
  if (cached) return cached;
  const result = recipe.reqs.map((_, ri) => {
    const tiers: FoundCombo[][] = Array.from({ length: MAX_TRIM + 1 }, () => []);
    const seen = new Set<string>();
    // the common d40 combos lead their tier
    for (const c of recipe.combos) {
      if (c.req !== ri || c.wildAdd > 0) continue;
      const carried = c.ings.reduce(
        (s, n) => s + (ING_BY_NAME.get(n)?.strike ?? 0),
        0,
      );
      const ext = Math.max(0, c.trim - carried);
      if (ext > MAX_TRIM) continue;
      seen.add(canon(c.ings));
      tiers[ext].push({ ings: c.ings, trim: c.trim });
    }
    for (const c of findRecipeCombos(recipe.reqs[ri], baseIngredients, MAX_TRIM, 120)) {
      if (!seen.has(canon(c.ings))) tiers[c.trim].push(c);
    }
    return tiers;
  });
  MORE_CACHE.set(recipe.key, result);
  return result;
}

export default function RecipeBook({
  recipes,
  brew,
  onAddIngredient,
}: RecipeBookProps) {
  const [query, setQuery] = useState("");

  const evaluated = useMemo(
    () => recipes.map((r) => ({ recipe: r, res: evaluate(brew, r) })),
    [recipes, brew],
  );
  // "in reach" counts brewed perfumes too — they're trivially reachable
  const inReach = evaluated.filter((e) => e.res.status !== "off").length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return evaluated
      .filter(({ recipe }) => matchesQuery(recipe, q))
      .sort((a, b) => {
        const s = STATUS_RANK[a.res.status] - STATUS_RANK[b.res.status];
        if (s !== 0) return s;
        // lightest resonance first
        const w = recipeWeight(a.recipe) - recipeWeight(b.recipe);
        if (w !== 0) return w;
        return a.recipe.name.localeCompare(b.recipe.name);
      });
  }, [evaluated, query]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header */}
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-muted">Recipes</h2>
        <span className="font-mono text-xs tabular-nums text-text-muted">
          <span className="text-accent">{inReach}</span>/{recipes.length} in reach
        </span>
      </div>

      {/* controls */}
      <div className="border-b border-border p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search perfumes…"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
      </div>

      {/* the book */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {shown.length === 0 && (
          <p className="px-2 py-6 text-center font-mono text-xs text-text-faint">
            no recipes match
          </p>
        )}
        {shown.map(({ recipe, res }) => (
          <RecipeCard
            key={recipe.key}
            recipe={recipe}
            res={res}
            onAddIngredient={onAddIngredient}
          />
        ))}
      </div>
    </div>
  );
}

// A tiny cauldron silhouette — stands for "the current brew" in the card's
// brew + additions = perfume formula.
function MiniCauldron({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-label="the current brew"
      className="shrink-0 text-text-muted"
      fill="currentColor"
    >
      <ellipse cx="12" cy="8" rx="9" ry="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.4 9.2 C3.4 15.4 6.8 19 12 19 C17.2 19 20.6 15.4 20.6 9.2 C18.6 10.8 15.4 11.6 12 11.6 C8.6 11.6 5.4 10.8 3.4 9.2 Z" />
      <path d="M7.6 18.4 l-1.6 2.4 M16.4 18.4 l1.6 2.4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

// Compact symbols-only row.
function FrequencyRow({ req, size = 16 }: { req: string[]; size?: number }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {groupFrequencies(req).map(({ id, count }) => (
        <span key={id} className="flex items-center gap-0.5">
          <FrequencySymbol id={id} size={size} />
          {count > 1 && (
            <span className="font-mono text-[9px] text-text-faint">×{count}</span>
          )}
        </span>
      ))}
    </span>
  );
}

// A clickable ingredient pill; hovering shows the frequencies it contains.
// Lore-only names render as plain text.
function IngredientPill({
  entry,
  onAdd,
}: {
  entry: RecipeSlotEntry;
  onAdd?: (key: string, qty?: number) => void;
}) {
  const ing = ING_BY_NAME.get(entry.name);
  const label = entry.qty > 1 ? `${entry.name} ×${entry.qty}` : entry.name;
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  if (!entry.known || !ing) {
    return (
      <span
        className="cursor-help text-[11px] italic text-text-faint"
        title="Named in the lore, but absent from the Ingredients Table — the math uses the other option."
      >
        {label}
      </span>
    );
  }
  // the tip self-centers on the pill via translateX; clamp its anchor so it
  // can't spill past a (floored, for degenerate windows) viewport edge
  const vw = Math.max(typeof window !== "undefined" ? window.innerWidth : 1024, 360);
  const left = tip ? Math.min(Math.max(tip.x, 70), vw - 70) : 0;
  return (
    <button
      type="button"
      onClick={() => onAdd?.(ing.key, entry.qty)}
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setTip({ x: r.left + r.width / 2, y: r.bottom });
      }}
      onMouseLeave={() => setTip(null)}
      title="Add to the brew"
      className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-text transition-colors duration-150 hover:border-accent hover:text-accent"
      style={{ borderLeftWidth: 3, borderLeftColor: ing.color }}
    >
      {label}
      {tip &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            className="pointer-events-none fixed z-[70] flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-xl"
            style={{ left, top: tip.y + 6 }}
            role="tooltip"
          >
            {ing.emits.map((t, i) => (
              <FrequencyGlyph key={`${t}:${i}`} id={t} size={17} />
            ))}
            {Array.from({ length: ing.strike }, (_, i) => (
              <span key={`s${i}`} className="font-mono text-[12px]" style={{ color: STRIKE }}>
                ⊖
              </span>
            ))}
            {Array.from({ length: ing.wild }, (_, i) => (
              <span key={`w${i}`} className="font-mono text-[12px]" style={{ color: COPPER }}>
                ⊕
              </span>
            ))}
            {ing.emits.length === 0 && !ing.strike && !ing.wild && (
              <span className="font-mono text-[10px] text-text-faint">inert</span>
            )}
          </span>,
          document.body,
        )}
    </button>
  );
}

// The card's brew formula: 🫕 + [what to add] — a mini cauldron (the current
// brew), a plus, and a box holding the missing frequencies on top and one ⊖
// icon per strike needed below. Perfect matches show the brewed seal instead.
function BrewFormula({ res }: { res: EvalResult }) {
  if (res.status === "perfect")
    return (
      <span className="inline-block shrink-0 self-center rounded border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[11px] text-success">
        ✦ Brewed
      </span>
    );
  const reach = res.status === "craftable";
  const missing = groupFrequencies(msToList(res.missing));
  return (
    <span className="flex shrink-0 items-center gap-1.5 self-center">
      <MiniCauldron size={18} />
      <span className={`font-mono text-xs ${reach ? "text-accent" : "text-text-faint"}`}>+</span>
      <span
        className={`flex flex-col items-start gap-1 rounded border px-2 py-1 ${
          reach ? "border-accent/40 bg-accent/10" : "border-border"
        }`}
        title="what the brew still needs for this perfume"
      >
        {missing.length > 0 && (
          <span className="flex max-w-40 flex-wrap items-center gap-1">
            {missing.map(({ id, count }) => (
              <span key={id} className="flex items-center gap-0.5">
                <FrequencySymbol id={id} size={16} />
                {count > 1 && (
                  <span className="font-mono text-[9px] text-text-muted">×{count}</span>
                )}
              </span>
            ))}
          </span>
        )}
        {res.exN > 0 && (
          <span
            className="flex max-w-40 flex-wrap items-center gap-0.5"
            title={`${res.exN} strike${res.exN > 1 ? "s" : ""} needed to remove excess frequencies`}
          >
            {Array.from({ length: res.exN }, (_, i) => (
              <span
                key={i}
                className="grid h-[15px] w-[15px] place-items-center rounded-full border text-[10px] font-bold"
                style={{ color: STRIKE, borderColor: STRIKE, background: "#a855f71a" }}
              >
                ⊖
              </span>
            ))}
          </span>
        )}
        {missing.length === 0 && res.exN === 0 && (
          <span className="font-mono text-[10px] text-accent">in reach</span>
        )}
      </span>
    </span>
  );
}

// One dynamically-found combo as a row of clickable ingredient pills.
function ComboRow({
  combo,
  onAdd,
}: {
  combo: FoundCombo;
  onAdd?: (key: string, qty?: number) => void;
}) {
  const counts = new Map<string, number>();
  for (const n of combo.ings) counts.set(n, (counts.get(n) ?? 0) + 1);
  const entries = [...counts.entries()];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {entries.map(([name, qty], i) => (
        <span key={name} className="flex items-center gap-1">
          {i > 0 && (
            <span className="px-0.5 font-mono text-[9px] uppercase text-text-faint">+</span>
          )}
          <IngredientPill entry={{ name, qty, known: true }} onAdd={onAdd} />
        </span>
      ))}
      {combo.trim > 0 && (
        <span
          className="font-mono text-[10px]"
          style={{ color: STRIKE }}
          title={`spend ${combo.trim} strike${combo.trim > 1 ? "s" : ""} to remove the excess`}
        >
          · ⊖{combo.trim}
        </span>
      )}
    </div>
  );
}

function RecipeCard({
  recipe,
  res,
  onAddIngredient,
}: {
  recipe: Recipe;
  res: EvalResult;
  onAddIngredient?: (key: string, qty?: number) => void;
}) {
  const integ = integrateRecipe(recipe);
  const more = moreCombosFor(recipe);
  // trims that actually have combos in some tuning, in reveal order
  const tiersWithCombos = Array.from({ length: MAX_TRIM + 1 }, (_, t) => t).filter(
    (t) => more.some((tiers) => tiers[t].length > 0),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  // strike tiers revealed so far (0 = only strike-free combos)
  const [trimShown, setTrimShown] = useState(0);
  const nextTier = tiersWithCombos.find((t) => t > trimShown);

  return (
    <article
      className={`rounded-lg border bg-bg/40 ${
        res.status === "perfect"
          ? "border-success/50 ring-1 ring-success/40"
          : res.status === "craftable"
            ? "border-accent/50"
            : "border-border"
      }`}
    >
      {/* one compact strip: name + weight (recipes button beneath), the
          required frequencies (symbols only, wrapping as needed), then the
          brew formula — 🫕 + box of what's still missing */}
      <div className="flex items-start gap-2.5 p-2.5">
        <div className="w-32 shrink-0">
          <h3 className="truncate text-sm font-semibold leading-tight text-text" title={recipe.name}>
            {recipe.name}
          </h3>
          <div
            className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-text-faint"
            title="total fundamental weight of the heaviest tuning"
          >
            w · {recipeWeight(recipe)}
          </div>
          <button
            type="button"
            onClick={() => {
              setMoreOpen((o) => !o);
              setTrimShown(0);
            }}
            aria-expanded={moreOpen}
            className="mt-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-[10px] text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
          >
            recipes {moreOpen ? "▴" : "▾"}
          </button>
        </div>

        {/* the integrated requirement: shared frequencies, interchangeable
            alternatives in parentheses, optional extras in a dashed box */}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 self-center">
          {groupFrequencies(integ.core).map(({ id, count }) => (
            <span key={id} className="flex items-center gap-0.5">
              <FrequencySymbol id={id} size={20} />
              {count > 1 && (
                <span className="font-mono text-[10px] text-text-muted">×{count}</span>
              )}
            </span>
          ))}
          {integ.groups.map((g, gi) =>
            g.optional ? (
              <span
                key={gi}
                title="optional — either version brews the perfume"
                className="flex items-center gap-1.5 rounded-md border border-dashed border-text-faint/50 px-1.5 py-1"
              >
                {g.options.map((opt, oi) => (
                  <span key={oi} className="flex items-center gap-1.5">
                    {oi > 0 && (
                      <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
                    )}
                    <FrequencyRow req={opt} size={17} />
                  </span>
                ))}
              </span>
            ) : (
              <span key={gi} className="flex items-center gap-1.5">
                <span className="font-mono text-sm text-text-faint">(</span>
                {g.options.map((opt, oi) => (
                  <span key={oi} className="flex items-center gap-1.5">
                    {oi > 0 && (
                      <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
                    )}
                    <FrequencyRow req={opt} size={17} />
                  </span>
                ))}
                <span className="font-mono text-sm text-text-faint">)</span>
              </span>
            ),
          )}
        </div>

        <BrewFormula res={res} />
      </div>

      {moreOpen && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
          {tiersWithCombos.filter((t) => t <= trimShown).length === 0 && (
            <p className="font-mono text-[10px] italic text-text-faint">
              no strike-free recipes
            </p>
          )}
          {Array.from({ length: trimShown + 1 }, (_, t) => t)
            .filter((t) => tiersWithCombos.includes(t))
            .map((t) => (
              <div key={t} className="space-y-1.5">
                {t > 0 && (
                  <p className="font-mono text-[9px] uppercase tracking-wider" style={{ color: STRIKE }}>
                    ⊖ {t} strike{t > 1 ? "s" : ""} needed
                  </p>
                )}
                {recipe.reqs.map((req, ri) =>
                  more[ri][t].length === 0 ? null : (
                    <div key={ri} className="space-y-1">
                      {recipe.reqs.length > 1 && (
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-[9px] uppercase text-text-faint">for</span>
                          <FrequencyRow req={req} size={13} />
                        </div>
                      )}
                      <div className="space-y-1">
                        {more[ri][t].slice(0, 30).map((combo, ci) => (
                          <ComboRow key={ci} combo={combo} onAdd={onAddIngredient} />
                        ))}
                        {more[ri][t].length > 30 && (
                          <p className="font-mono text-[10px] italic text-text-faint">…and more</p>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
            ))}
          {nextTier !== undefined && (
            <button
              type="button"
              onClick={() => setTrimShown(nextTier)}
              className="rounded-md border border-dashed px-2 py-0.5 font-mono text-[10px] transition-colors duration-150 hover:border-solid"
              style={{ borderColor: `${STRIKE}88`, color: STRIKE }}
            >
              show combos needing ⊖ {nextTier} strike{nextTier > 1 ? "s" : ""} ▾
            </button>
          )}
        </div>
      )}
    </article>
  );
}
