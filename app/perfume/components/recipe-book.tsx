"use client";

import { useMemo, useState } from "react";
import type { Recipe, Source, EvalResult } from "../lib/types";
import type { RecipeBookProps } from "./contracts";
import { evaluate, msToList } from "../lib/engine";
import { FrequencySymbol, COPPER } from "../lib/frequencies";

function sourceKey(s: Source): string {
  return s.kind === "base" ? "base" : `user:${s.userId}`;
}
function sourceLabel(s: Source): string {
  return s.kind === "base" ? "Base" : s.name || "Anonymous";
}

const TIER_RANK: Record<string, number> = { simple: 0, advanced: 1, legendary: 2 };
const STATUS_RANK: Record<string, number> = { perfect: 0, craftable: 1, off: 2 };

export default function RecipeBook({
  recipes,
  brew,
  onRequestAdd,
  canCreate,
  currentUserId,
  onLoadExample,
  onRemoveCustom,
}: RecipeBookProps) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const sources = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of recipes) map.set(sourceKey(r.source), sourceLabel(r.source));
    return [...map.entries()].sort((a, b) =>
      a[0] === "base" ? -1 : b[0] === "base" ? 1 : a[1].localeCompare(b[1]),
    );
  }, [recipes]);

  const evaluated = useMemo(() => {
    return recipes
      .filter((r) => !hidden.has(sourceKey(r.source)))
      .map((r) => ({ recipe: r, res: evaluate(brew, r) }))
      .sort((a, b) => {
        const s = STATUS_RANK[a.res.status] - STATUS_RANK[b.res.status];
        if (s !== 0) return s;
        const t = (TIER_RANK[a.recipe.tier] ?? 9) - (TIER_RANK[b.recipe.tier] ?? 9);
        if (t !== 0) return t;
        return a.recipe.name.localeCompare(b.recipe.name);
      });
  }, [recipes, brew, hidden]);

  const bottled = evaluated.filter((e) => e.res.status === "perfect").length;
  const inReach = evaluated.filter((e) => e.res.status === "craftable").length;

  const toggleSource = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold text-text-muted">Recipe Book</h2>
          <span className="font-mono text-xs tabular-nums text-text-faint">
            <span className="text-success">{bottled}</span> bottled ·{" "}
            <span className="text-accent">{inReach}</span> in reach
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {sources.length > 1 &&
            sources.map(([k, label]) => {
              const on = !hidden.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => toggleSource(k)}
                  aria-pressed={on}
                  className={`rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors duration-150 ${
                    on
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border text-text-faint hover:text-text-muted"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          <button
            type="button"
            onClick={onRequestAdd}
            className="rounded-lg border border-accent/30 px-3 py-1 text-xs text-accent transition-colors duration-150 hover:border-accent/50 hover:bg-accent/10"
          >
            {canCreate ? "+ New recipe" : "Sign in to add"}
          </button>
        </div>
      </div>

      <div className="flex gap-3 overflow-x-auto scroll-smooth px-4 py-3">
        {evaluated.length === 0 && (
          <p className="py-6 font-mono text-xs text-text-faint">no recipes</p>
        )}
        {evaluated.map(({ recipe, res }) => (
          <RecipeCard
            key={recipe.key}
            recipe={recipe}
            res={res}
            onLoadExample={onLoadExample}
            deletable={
              recipe.source.kind === "user" &&
              !!currentUserId &&
              recipe.source.userId === currentUserId
            }
            onRemoveCustom={onRemoveCustom}
          />
        ))}
      </div>
    </div>
  );
}

function RecipeCard({
  recipe,
  res,
  onLoadExample,
  deletable,
  onRemoveCustom,
}: {
  recipe: Recipe;
  res: EvalResult;
  onLoadExample?: (r: Recipe) => void;
  deletable: boolean;
  onRemoveCustom?: (convexId: string) => void;
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
    <div
      className={`flex min-w-[260px] max-w-[260px] flex-col rounded-lg border bg-surface p-3 ${
        res.status === "perfect" ? "border-success/50 ring-1 ring-success/40" : "border-border"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold leading-tight text-text">{recipe.name}</h3>
        {deletable && onRemoveCustom && (
          <button
            type="button"
            onClick={() => onRemoveCustom(recipe.key.replace(/^user:/, ""))}
            aria-label={`Delete ${recipe.name}`}
            className="shrink-0 text-text-faint transition-colors duration-150 hover:text-error"
          >
            ×
          </button>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
        <span className="text-text-faint">{recipe.school}</span>
        <span style={{ color: tierColor }}>{recipe.tier}</span>
        {recipe.source.kind === "user" && (
          <span className="text-text-faint">· {recipe.source.name}</span>
        )}
      </div>

      {/* required */}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {recipe.req.map((t, i) => (
          <FrequencySymbol key={`${t}:${i}`} id={t} size={22} />
        ))}
      </div>

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

      {/* footer */}
      {recipe.source.kind === "base" && recipe.example && recipe.example.length > 0 && onLoadExample && (
        <div className="mt-auto pt-2">
          <button
            type="button"
            onClick={() => onLoadExample(recipe)}
            className="w-full rounded-md border border-border px-2 py-1 font-mono text-[11px] text-text-muted transition-colors duration-150 hover:border-text-muted hover:text-text"
          >
            Load example
          </button>
        </div>
      )}
    </div>
  );
}
