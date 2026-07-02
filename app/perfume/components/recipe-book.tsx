"use client";

// The formulary, laid out like the Byobu bench: a vertical, searchable,
// filterable book of the 41 d40 recipes. Cards are compact when collapsed
// (name, roll, the closest tuning with frequency names printed underneath,
// clickable common-ingredient pills) and expand for the full story (flavor
// text, strike/summon hints, every valid tuning judged against the brew, and
// one-click brew buttons for the table's common combos).

import { useMemo, useState } from "react";
import type { Recipe, EvalResult, RecipeSlotEntry } from "../lib/types";
import type { RecipeBookProps } from "./contracts";
import { evaluate, evalReq, msToList } from "../lib/engine";
import { ALL_TOKENS, FUND, isNamed, baseIngredients } from "../data/base";
import { FrequencySymbol, COPPER, STRIKE } from "../lib/frequencies";

const STATUS_RANK: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Display order for tokens inside a tuning row: fundamentals in canonical
// order, then named frequencies by complexity (ALL_TOKENS is already sorted).
const TOKEN_ORDER = new Map(ALL_TOKENS.map((t, i) => [t.id, i]));
const ING_BY_NAME = new Map(baseIngredients.map((i) => [i.name, i]));

type Filter = "all" | "perfect" | "craftable" | "legendary" | "simple";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "perfect", label: "bottled" },
  { key: "craftable", label: "in reach" },
  { key: "legendary", label: "legendary" },
  { key: "simple", label: "simple" },
];

function groupTokens(req: string[]): { id: string; count: number }[] {
  const m = new Map<string, number>();
  for (const t of req) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()]
    .sort((a, b) => (TOKEN_ORDER.get(a[0]) ?? 99) - (TOKEN_ORDER.get(b[0]) ?? 99))
    .map(([id, count]) => ({ id, count }));
}

function tokenLabel(id: string): string {
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

// Search by perfume name, common ingredient, or required frequency (token id
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
  const bottled = evaluated.filter((e) => e.res.status === "perfect").length;
  const inReach = evaluated.filter((e) => e.res.status === "craftable").length;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return evaluated
      .filter(({ recipe }) => matchesQuery(recipe, q))
      .filter(({ recipe, res }) => {
        if (filter === "perfect") return res.status === "perfect";
        if (filter === "craftable")
          return res.status === "craftable" || res.status === "perfect";
        if (filter === "legendary") return recipe.tier === "legendary";
        if (filter === "simple") return recipe.tier === "simple";
        return true;
      })
      .sort((a, b) => {
        const s = STATUS_RANK[a.res.status] - STATUS_RANK[b.res.status];
        if (s !== 0) return s;
        const roll = a.recipe.roll - b.recipe.roll;
        if (roll !== 0) return roll;
        return a.recipe.name.localeCompare(b.recipe.name);
      });
  }, [evaluated, query, filter]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header */}
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-muted">Recipe Book</h2>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          <span className="text-success">{bottled}</span> bottled ·{" "}
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
            no formula matches
          </p>
        )}
        {shown.map(({ recipe, res }) => (
          <RecipeCard
            key={recipe.key}
            recipe={recipe}
            res={res}
            brew={brew}
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

// A token with its ×count and its name printed underneath.
function LabeledToken({ id, count, size = 22 }: { id: string; count: number; size?: number }) {
  return (
    <span className="flex max-w-16 flex-col items-center gap-0.5">
      <span className="flex items-center gap-0.5">
        <FrequencySymbol id={id} size={size} />
        {count > 1 && (
          <span className="font-mono text-[10px] text-text-muted">×{count}</span>
        )}
      </span>
      <span className="text-center font-mono text-[7.5px] uppercase leading-tight tracking-wide text-text-faint">
        {tokenLabel(id)}
      </span>
    </span>
  );
}

// Compact symbols-only row for tuning lists.
function TokenRow({ req, size = 16 }: { req: string[]; size?: number }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {groupTokens(req).map(({ id, count }) => (
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

// A clickable common-ingredient pill; lore-only names render as plain text.
function IngredientPill({
  entry,
  onAdd,
}: {
  entry: RecipeSlotEntry;
  onAdd?: (key: string, qty?: number) => void;
}) {
  const ing = ING_BY_NAME.get(entry.name);
  const label = entry.qty > 1 ? `${entry.name} ×${entry.qty}` : entry.name;
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
  return (
    <button
      type="button"
      onClick={() => onAdd?.(ing.key, entry.qty)}
      title="Add to the cauldron"
      className="rounded-full border border-border bg-bg px-2 py-0.5 text-xs text-text transition-colors duration-150 hover:border-accent hover:text-accent"
      style={{ borderLeftWidth: 3, borderLeftColor: ing.color }}
    >
      {label}
    </button>
  );
}

function StatusPill({ res }: { res: EvalResult }) {
  if (res.status === "perfect")
    return (
      <span className="inline-block shrink-0 rounded border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[11px] text-success">
        ✦ Bottled
      </span>
    );
  if (res.status === "craftable")
    return (
      <span className="inline-block shrink-0 rounded border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">
        Within reach
      </span>
    );
  return (
    <span className="inline-block shrink-0 rounded border border-border px-2 py-0.5 font-mono text-[11px] text-text-faint">
      {res.exN + res.miN} off
    </span>
  );
}

function RecipeCard({
  recipe,
  res,
  brew,
  open,
  onToggle,
  onLoadCombo,
  onAddIngredient,
}: {
  recipe: Recipe;
  res: EvalResult;
  brew: Parameters<typeof evaluate>[0];
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
              {recipe.reqs.length > 1 && (
                <span className="text-text-faint">{recipe.reqs.length} tunings</span>
              )}
            </div>
          </div>
          <StatusPill res={res} />
        </div>

        {/* the tuning closest to the current brew, names underneath */}
        <div className="mt-2 flex flex-wrap items-start gap-1.5">
          {groupTokens(recipe.reqs[res.reqIndex]).map(({ id, count }) => (
            <LabeledToken key={id} id={id} count={count} />
          ))}
          {recipe.reqs.length > 1 && (
            <span className="self-center font-mono text-[9px] uppercase text-text-faint">
              or {recipe.reqs.length - 1} more…
            </span>
          )}
        </div>
      </button>

      {/* common ingredients — always visible, click to add */}
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
      </div>

      {open && (
        <div className="space-y-2.5 border-t border-border/60 px-3 py-2.5">
          {recipe.desc && <p className="text-xs italic text-text-muted">{recipe.desc}</p>}

          {/* verdict + hints */}
          {res.status === "perfect" ? (
            <p className="font-mono text-[11px] text-success">
              Perfect resonance — this perfume is bottled.
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
                      summon ⊕
                    </span>
                    {missing.map((t, i) => (
                      <FrequencySymbol key={`mi:${t}:${i}`} id={t} size={16} />
                    ))}
                  </div>
                )}
              </div>
            )
          )}

          {/* every valid tuning, each judged against the current brew */}
          {recipe.reqs.length > 1 && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-faint">
                valid tunings — match any one
              </p>
              <div className="space-y-1">
                {recipe.reqs.map((req, ri) => {
                  const te = ri === res.reqIndex ? res : evalReq(brew, req, ri);
                  return (
                    <div key={ri} className="flex items-center gap-2">
                      <span
                        className={`w-16 shrink-0 font-mono text-[9px] uppercase ${
                          te.status === "perfect"
                            ? "text-success"
                            : te.status === "craftable"
                              ? "text-accent"
                              : "text-text-faint"
                        }`}
                      >
                        {te.status === "perfect"
                          ? "bottled"
                          : te.status === "craftable"
                            ? "in reach"
                            : `${te.exN + te.miN} off`}
                      </span>
                      <TokenRow req={req} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* the common combos from the d40 table — click to brew */}
          {recipe.combos.length > 0 && onLoadCombo && (
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-text-faint">
                common recipe{recipe.combos.length > 1 ? "s" : ""}
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
