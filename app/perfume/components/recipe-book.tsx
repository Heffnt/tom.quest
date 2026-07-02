"use client";

import { useMemo } from "react";
import type { Recipe, EvalResult } from "../lib/types";
import type { RecipeBookProps } from "./contracts";
import { evaluate, msToList } from "../lib/engine";
import { ALL_TOKENS, FUND, isNamed } from "../data/base";
import { FrequencySymbol, COPPER } from "../lib/frequencies";

const STATUS_RANK: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

// Display order for tokens inside a tuning row: fundamentals in canonical
// order, then named frequencies by complexity (ALL_TOKENS is already sorted).
const TOKEN_ORDER = new Map(ALL_TOKENS.map((t, i) => [t.id, i]));

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

export default function RecipeBook({ recipes, brew, onLoadCombo }: RecipeBookProps) {
  const evaluated = useMemo(() => {
    return recipes
      .map((r) => ({ recipe: r, res: evaluate(brew, r) }))
      .sort((a, b) => {
        const s = STATUS_RANK[a.res.status] - STATUS_RANK[b.res.status];
        if (s !== 0) return s;
        const roll = a.recipe.roll - b.recipe.roll;
        if (roll !== 0) return roll;
        return a.recipe.name.localeCompare(b.recipe.name);
      });
  }, [recipes, brew]);

  const bottled = evaluated.filter((e) => e.res.status === "perfect").length;
  const inReach = evaluated.filter((e) => e.res.status === "craftable").length;

  return (
    <div className="flex flex-col">
      <div className="flex items-baseline gap-3 px-4 pt-3">
        <h2 className="text-sm font-semibold text-text-muted">Recipe Book</h2>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          <span className="text-success">{bottled}</span> bottled ·{" "}
          <span className="text-accent">{inReach}</span> in reach ·{" "}
          {recipes.length} formulae
        </span>
      </div>

      <div className="flex gap-3 overflow-x-auto scroll-smooth px-4 py-3">
        {evaluated.map(({ recipe, res }) => (
          <RecipeCard
            key={recipe.key}
            recipe={recipe}
            res={res}
            onLoadCombo={onLoadCombo}
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

// Compact symbols-only row for the non-closest tunings.
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

// One combo's ingredient list as a compact label: "A + B ×4".
function comboLabel(ings: string[]): string {
  const counts = new Map<string, number>();
  for (const n of ings) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(" + ");
}

function RecipeCard({
  recipe,
  res,
  onLoadCombo,
}: {
  recipe: Recipe;
  res: EvalResult;
  onLoadCombo?: (r: Recipe, comboIndex: number) => void;
}) {
  const tierColor =
    recipe.tier === "legendary"
      ? COPPER
      : recipe.tier === "advanced"
        ? "var(--color-accent)"
        : "var(--color-text-muted)";
  const excess = msToList(res.excess);
  const missing = msToList(res.missing);
  const altTunings = recipe.reqs
    .map((req, ri) => ({ req, ri }))
    .filter(({ ri }) => ri !== res.reqIndex);
  // Lore-only slot alternatives (e.g. Were-Elk Antler) missing from the
  // Ingredients Table — shown as flavor, excluded from combos and the math.
  const loreOnly = recipe.slots.flatMap((slot) =>
    slot.filter((e) => !e.known).map((e) => e.name),
  );

  return (
    <div
      className={`flex min-w-[280px] max-w-[280px] flex-col rounded-lg border bg-surface p-3 ${
        res.status === "perfect" ? "border-success/50 ring-1 ring-success/40" : "border-border"
      }`}
    >
      <h3 className="text-base font-semibold leading-tight text-text">{recipe.name}</h3>
      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
        <span className="text-text-faint">d40 · {recipe.roll}</span>
        <span style={{ color: tierColor }}>{recipe.tier}</span>
        {recipe.reqs.length > 1 && (
          <span className="text-text-faint">{recipe.reqs.length} tunings</span>
        )}
      </div>

      {/* required — the tuning closest to the current brew, names underneath */}
      <div className="mt-2 flex flex-wrap items-start gap-1.5">
        {groupTokens(recipe.reqs[res.reqIndex]).map(({ id, count }) => (
          <LabeledToken key={id} id={id} count={count} />
        ))}
      </div>

      {/* alternate tunings — any one of these also bottles the perfume */}
      {altTunings.length > 0 && (
        <div className="mt-1.5 space-y-1">
          {altTunings.map(({ req, ri }) => (
            <div key={ri} className="flex items-center gap-1.5">
              <span className="font-mono text-[9px] uppercase text-text-faint">or</span>
              <TokenRow req={req} />
            </div>
          ))}
        </div>
      )}

      {/* status */}
      <div className="mt-2">
        {res.status === "perfect" && (
          <span className="inline-block rounded border border-success/40 bg-success/10 px-2 py-0.5 font-mono text-[11px] text-success">
            ✦ Bottled
          </span>
        )}
        {res.status === "craftable" && (
          <span className="inline-block rounded border border-accent/40 bg-accent/10 px-2 py-0.5 font-mono text-[11px] text-accent">
            Within reach
          </span>
        )}
        {res.status === "off" && (
          <span className="inline-block rounded border border-border px-2 py-0.5 font-mono text-[11px] text-text-faint">
            {res.exN + res.miN} off
          </span>
        )}
      </div>

      {/* hints */}
      {(excess.length > 0 || missing.length > 0) && (
        <div className="mt-2 space-y-1">
          {excess.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-mono text-[10px]" style={{ color: "#a855f7" }}>
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
      )}

      {recipe.desc && (
        <p className="mt-2 line-clamp-2 text-xs text-text-faint">{recipe.desc}</p>
      )}

      {loreOnly.length > 0 && (
        <p className="mt-1 text-[10px] italic text-text-faint">
          Lore also names {loreOnly.join(", ")} — not in the Ingredients Table.
        </p>
      )}

      {/* the common recipes from the d40 table — click to brew */}
      {recipe.combos.length > 0 && onLoadCombo && (
        <div className="mt-auto space-y-1 pt-2">
          {recipe.combos.map((combo, ci) => (
            <button
              key={ci}
              type="button"
              onClick={() => onLoadCombo(recipe, ci)}
              title={combo.trim > 0 ? `Brews with ${combo.trim} ⊖ strike${combo.trim > 1 ? "s" : ""}` : "Brew this combo"}
              className="w-full rounded-md border border-border px-2 py-1 text-left font-mono text-[10.5px] leading-snug text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
            >
              {comboLabel(combo.ings)}
              {combo.trim > 0 && (
                <span style={{ color: "#a855f7" }}> · ⊖{combo.trim}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
