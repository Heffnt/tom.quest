"use client";

// The recipe panel: a vertical, searchable, filterable book of the 41 d40
// recipes. Each card leads with ONE integrated frequency requirement — the
// frequencies every tuning shares, plus choice groups for interchangeable
// alternatives and "optional" extras — instead of listing alternative
// tunings separately. The common d40 recipe shows as clickable ingredient
// pills (hover a pill to see the frequencies it contains), and a
// "more recipes" button expands every ingredient combination that lands
// exactly on a tuning with no strikes and no wilds, computed live.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Multiset, Recipe, EvalResult, RecipeSlotEntry } from "../lib/types";
import type { RecipeBookProps } from "./contracts";
import {
  evaluate,
  msToList,
  msFromList,
  msDiff,
  findExactCombos,
} from "../lib/engine";
import { ALL_FREQUENCIES, FUND, isNamed, baseIngredients } from "../data/base";
import { FrequencySymbol, FrequencyGlyph, COPPER, STRIKE } from "../lib/frequencies";

const STATUS_RANK: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Display order for frequencies inside a tuning row: fundamentals in canonical
// order, then named frequencies by complexity (ALL_FREQUENCIES is already sorted).
const FREQ_ORDER = new Map(ALL_FREQUENCIES.map((t, i) => [t.id, i]));
const ING_BY_NAME = new Map(baseIngredients.map((i) => [i.name, i]));

type Filter = "all" | "perfect" | "craftable";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "perfect", label: "brewed" },
  { key: "craftable", label: "in reach" },
];

function groupFrequencies(req: string[]): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of req) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => (FREQ_ORDER.get(a[0]) ?? 99) - (FREQ_ORDER.get(b[0]) ?? 99))
    .map(([id, count]) => ({ id, count }));
}

function frequencyName(id: string): string {
  return isNamed(id) ? id : (FUND[id]?.school ?? id);
}

// One combo's ingredient list as a compact label: "A + B ×4".
function comboLabel(ings: string[]): string {
  const counts = new Map<string, number>();
  for (const n of ings) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(" + ");
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

export default function RecipeBook({
  recipes,
  brew,
  onLoadCombo,
  onAddIngredient,
}: RecipeBookProps) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const evaluated = useMemo(
    () => recipes.map((r) => ({ recipe: r, res: evaluate(brew, r) })),
    [recipes, brew],
  );
  const brewed = evaluated.filter((e) => e.res.status === "perfect").length;
  const inReach = evaluated.filter((e) => e.res.status === "craftable").length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return evaluated
      .filter(({ recipe }) => matchesQuery(recipe, q))
      .filter(({ res }) => {
        if (filter === "perfect") return res.status === "perfect";
        if (filter === "craftable")
          return res.status === "craftable" || res.status === "perfect";
        return true;
      })
      .sort((a, b) => {
        const s = STATUS_RANK[a.res.status] - STATUS_RANK[b.res.status];
        if (s !== 0) return s;
        // among in-reach recipes, the fewest missing frequencies come first
        if (a.res.status === "craftable") {
          const m = a.res.miN - b.res.miN;
          if (m !== 0) return m;
        }
        const roll = a.recipe.roll - b.recipe.roll;
        if (roll !== 0) return roll;
        return a.recipe.name.localeCompare(b.recipe.name);
      });
  }, [evaluated, query, filter]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header */}
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-muted">Recipes</h2>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          <span className="text-success">{brewed}</span> brewed ·{" "}
          <span className="text-accent">{inReach}</span> in reach · {recipes.length}
        </span>
      </div>

      {/* controls */}
      <div className="space-y-2 border-b border-border p-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search perfumes…"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={`rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors duration-150 ${
                filter === f.key
                  ? "bg-surface-alt text-text"
                  : "text-text-faint hover:text-text-muted"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
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
            open={open.has(recipe.key)}
            onToggle={() => toggle(recipe.key)}
            onLoadCombo={onLoadCombo}
            onAddIngredient={onAddIngredient}
          />
        ))}
      </div>
    </div>
  );
}

// A frequency with its ×count and its name printed underneath.
function LabeledFrequency({ id, count, size = 22 }: { id: string; count: number; size?: number }) {
  return (
    <span className="flex max-w-16 flex-col items-center gap-0.5">
      <span className="flex items-center gap-0.5">
        <FrequencySymbol id={id} size={size} />
        {count > 1 && (
          <span className="font-mono text-[10px] text-text-muted">×{count}</span>
        )}
      </span>
      <span className="text-center font-mono text-[7.5px] uppercase leading-tight tracking-wide text-text-faint">
        {frequencyName(id)}
      </span>
    </span>
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
  // floor the viewport width so degenerate windows can't fling the tip away
  const W = 190;
  const vw = Math.max(typeof window !== "undefined" ? window.innerWidth : 1024, 360);
  const left = tip ? Math.min(Math.max(tip.x - W / 2, 8), vw - W - 8) : 0;
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
            className="pointer-events-none fixed z-[70] flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1.5 shadow-xl"
            style={{ left, top: tip.y + 6 }}
            role="tooltip"
          >
            {ing.emits.map((t, i) => (
              <FrequencyGlyph key={`${t}:${i}`} id={t} size={17} />
            ))}
            {ing.strike > 0 && (
              <span className="font-mono text-[10px]" style={{ color: STRIKE }}>
                ⊖{ing.strike > 1 ? `×${ing.strike}` : ""}
              </span>
            )}
            {ing.wild > 0 && (
              <span className="font-mono text-[10px]" style={{ color: COPPER }}>
                ⊕{ing.wild > 1 ? `×${ing.wild}` : ""}
              </span>
            )}
            {ing.emits.length === 0 && !ing.strike && !ing.wild && (
              <span className="font-mono text-[10px] text-text-faint">inert</span>
            )}
          </span>,
          document.body,
        )}
    </button>
  );
}

// Top-right of each card: the frequencies still needed (non-wild — the actual
// missing frequencies, grouped ×n) plus the number of strikes required when
// the brew carries wrong frequencies. Perfect matches show the brewed seal.
function NeedsBadge({ res }: { res: EvalResult }) {
  if (res.status === "perfect")
    return (
      <span className="inline-block shrink-0 rounded border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[11px] text-success">
        ✦ Brewed
      </span>
    );
  const reach = res.status === "craftable";
  const missing = groupFrequencies(msToList(res.missing));
  return (
    <span
      className={`flex shrink-0 flex-col items-end gap-1 rounded border px-2 py-1 ${
        reach ? "border-accent/40 bg-accent/10" : "border-border"
      }`}
    >
      {missing.length > 0 && (
        <span className="flex items-center gap-1">
          <span className={`font-mono text-[10px] ${reach ? "text-accent" : "text-text-faint"}`}>
            +
          </span>
          {missing.map(({ id, count }) => (
            <span key={id} className="flex items-center gap-0.5">
              <FrequencySymbol id={id} size={15} />
              {count > 1 && (
                <span className="font-mono text-[9px] text-text-faint">×{count}</span>
              )}
            </span>
          ))}
        </span>
      )}
      {res.exN > 0 && (
        <span className="font-mono text-[10px]" style={{ color: STRIKE }}>
          ⊖ {res.exN} strike{res.exN > 1 ? "s" : ""}
        </span>
      )}
      {missing.length === 0 && res.exN === 0 && (
        <span className="font-mono text-[10px] text-accent">in reach</span>
      )}
    </span>
  );
}

// One dynamically-found combo as a row of clickable ingredient pills.
function ComboRow({
  combo,
  onAdd,
}: {
  combo: string[];
  onAdd?: (key: string, qty?: number) => void;
}) {
  const counts = new Map<string, number>();
  for (const n of combo) counts.set(n, (counts.get(n) ?? 0) + 1);
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
    </div>
  );
}

function RecipeCard({
  recipe,
  res,
  open,
  onToggle,
  onLoadCombo,
  onAddIngredient,
}: {
  recipe: Recipe;
  res: EvalResult;
  open: boolean;
  onToggle: () => void;
  onLoadCombo?: (r: Recipe, comboIndex: number) => void;
  onAddIngredient?: (key: string, qty?: number) => void;
}) {
  const tierColor =
    recipe.tier === "legendary"
      ? COPPER
      : recipe.tier === "advanced"
        ? "var(--color-accent)"
        : "var(--color-text-muted)";
  const excess = msToList(res.excess);
  const missing = msToList(res.missing);
  const integ = integrateRecipe(recipe);

  // "more recipes": every strike/wild-free combination, computed on demand
  const [moreOpen, setMoreOpen] = useState(false);
  const moreCombos = useMemo(
    () =>
      moreOpen
        ? recipe.reqs.map((req) => findExactCombos(req, baseIngredients, 24))
        : null,
    [moreOpen, recipe],
  );

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
      {/* header — click to expand */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold leading-tight text-text">
              {recipe.name}
            </h3>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
              <span className="text-text-faint">d40 · {recipe.roll}</span>
              <span style={{ color: tierColor }}>{recipe.tier}</span>
            </div>
          </div>
          <NeedsBadge res={res} />
        </div>

        {/* the integrated requirement: shared frequencies, then choice groups
            for interchangeable alternatives / optional extras */}
        {integ.core.length > 0 && (
          <div className="mt-2 flex flex-wrap items-start gap-1.5">
            {groupFrequencies(integ.core).map(({ id, count }) => (
              <LabeledFrequency key={id} id={id} count={count} />
            ))}
          </div>
        )}
        {integ.groups.map((g, gi) => (
          <div key={gi} className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-faint">
              {g.optional ? "optionally" : "plus one of"}
            </span>
            {g.options.map((opt, oi) => (
              <span key={oi} className="flex items-center gap-1.5">
                {oi > 0 && (
                  <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
                )}
                <FrequencyRow req={opt} size={15} />
              </span>
            ))}
          </div>
        ))}
      </button>

      {/* the common recipe — clickable pills; "more recipes" expands every
          strike/wild-free combination found live in the catalog */}
      <div className="flex flex-wrap items-center gap-1 px-3 pb-2.5">
        {recipe.slots.map((slot, si) => (
          <span key={si} className="flex flex-wrap items-center gap-1">
            {si > 0 && (
              <span className="px-0.5 font-mono text-[9px] uppercase text-text-faint">+</span>
            )}
            {slot.map((entry, ei) => (
              <span key={ei} className="flex items-center gap-1">
                {ei > 0 && (
                  <span className="px-0.5 font-mono text-[9px] uppercase text-text-faint">
                    or
                  </span>
                )}
                <IngredientPill entry={entry} onAdd={onAddIngredient} />
              </span>
            ))}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          className="ml-auto rounded-md border border-border px-2 py-0.5 font-mono text-[10px] text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
        >
          {moreOpen ? "less" : "more recipes"} {moreOpen ? "▴" : "▾"}
        </button>
      </div>

      {moreOpen && moreCombos && (
        <div className="space-y-2 border-t border-border/60 px-3 py-2.5">
          <p className="font-mono text-[9px] uppercase tracking-wider text-text-faint">
            every combo with no strikes, no wilds
          </p>
          {recipe.reqs.map((req, ri) => (
            <div key={ri} className="space-y-1">
              {recipe.reqs.length > 1 && (
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[9px] uppercase text-text-faint">for</span>
                  <FrequencyRow req={req} size={13} />
                </div>
              )}
              {moreCombos[ri].length === 0 ? (
                <p className="font-mono text-[10px] italic text-text-faint">
                  no exact combos exist
                </p>
              ) : (
                <div className="space-y-1">
                  {moreCombos[ri].map((combo, ci) => (
                    <ComboRow key={ci} combo={combo} onAdd={onAddIngredient} />
                  ))}
                  {moreCombos[ri].length >= 24 && (
                    <p className="font-mono text-[10px] italic text-text-faint">…and more</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {open && (
        <div className="space-y-2.5 border-t border-border/60 px-3 py-2.5">
          {recipe.desc && <p className="text-xs italic text-text-muted">{recipe.desc}</p>}

          {/* verdict + hints */}
          {res.status === "perfect" ? (
            <p className="font-mono text-[11px] text-success">
              Perfect resonance — this perfume is brewed.
            </p>
          ) : (
            (excess.length > 0 || missing.length > 0) && (
              <div className="space-y-1">
                {excess.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-mono text-[10px]" style={{ color: STRIKE }}>
                      strike ⊖
                    </span>
                    {excess.map((t, i) => (
                      <FrequencySymbol key={`ex:${t}:${i}`} id={t} size={16} />
                    ))}
                  </div>
                )}
                {missing.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    <span className="font-mono text-[10px]" style={{ color: COPPER }}>
                      still needs
                    </span>
                    {missing.map((t, i) => (
                      <FrequencySymbol key={`mi:${t}:${i}`} id={t} size={16} />
                    ))}
                  </div>
                )}
              </div>
            )
          )}

          {/* the common combos from the d40 table — click to brew */}
          {recipe.combos.length > 0 && onLoadCombo && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-faint">
                brew the common recipe
              </p>
              <div className="space-y-1">
                {recipe.combos.map((combo, ci) => (
                  <button
                    key={ci}
                    type="button"
                    onClick={() => onLoadCombo(recipe, ci)}
                    title={
                      combo.trim > 0
                        ? `Brews with ${combo.trim} ⊖ strike${combo.trim > 1 ? "s" : ""}`
                        : "Brew this combo"
                    }
                    className="w-full rounded-md border border-border px-2 py-1 text-left font-mono text-[10.5px] leading-snug text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
                  >
                    {comboLabel(combo.ings)}
                    {combo.trim > 0 && <span style={{ color: STRIKE }}> · ⊖{combo.trim}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
