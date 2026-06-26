"use client";

import { useMemo, useState } from "react";
import type { Ingredient, Source } from "../lib/types";
import type { IngredientPanelProps } from "./contracts";
import { ALL_TOKENS, FUND } from "../data/base";
import { FrequencySymbol, STRIKE, COPPER } from "../lib/frequencies";

function sourceKey(s: Source): string {
  return s.kind === "base" ? "base" : `user:${s.userId}`;
}
function sourceLabel(s: Source): string {
  return s.kind === "base" ? "Base" : s.name || "Anonymous";
}

export default function IngredientPanel({
  ingredients,
  onAdd,
  onRequestAdd,
  canCreate,
  currentUserId,
  onRemoveCustom,
}: IngredientPanelProps) {
  const [search, setSearch] = useState("");
  const [freqFilter, setFreqFilter] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  const sources = useMemo(() => {
    const map = new Map<string, string>();
    for (const ing of ingredients) map.set(sourceKey(ing.source), sourceLabel(ing.source));
    // Base first, then creators alphabetically.
    return [...map.entries()].sort((a, b) =>
      a[0] === "base" ? -1 : b[0] === "base" ? 1 : a[1].localeCompare(b[1]),
    );
  }, [ingredients]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ingredients
      .filter((ing) => !hidden.has(sourceKey(ing.source)))
      .filter((ing) => (freqFilter ? ing.emits.includes(freqFilter) : true))
      .filter((ing) => {
        if (!q) return true;
        if (ing.name.toLowerCase().includes(q)) return true;
        if (ing.emits.some((t) => t.toLowerCase().includes(q))) return true;
        if (ing.emits.some((t) => (FUND[t]?.school ?? "").toLowerCase().includes(q))) return true;
        return false;
      })
      .sort((a, b) => {
        const ab = a.source.kind === "base" ? 0 : 1;
        const bb = b.source.kind === "base" ? 0 : 1;
        if (ab !== bb) return ab - bb;
        return a.name.localeCompare(b.name);
      });
  }, [ingredients, hidden, freqFilter, search]);

  const toggleSource = (k: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header */}
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-text-muted">Ingredients</h2>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          {filtered.length}/{ingredients.length}
        </span>
      </div>

      {/* controls */}
      <div className="space-y-2 border-b border-border p-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search ingredients…"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />

        {/* frequency filter */}
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setFreqFilter(null)}
            className={`rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors duration-150 ${
              freqFilter === null
                ? "bg-surface-alt text-text"
                : "text-text-faint hover:text-text-muted"
            }`}
          >
            all
          </button>
          {ALL_TOKENS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setFreqFilter((cur) => (cur === t.id ? null : t.id))}
              title={`filter by ${t.id}`}
              aria-pressed={freqFilter === t.id}
              className={`grid place-items-center rounded-full p-0.5 transition-shadow ${
                freqFilter === t.id ? "ring-2 ring-accent" : "opacity-80 hover:opacity-100"
              }`}
            >
              <FrequencySymbol id={t.id} size={20} />
            </button>
          ))}
        </div>

        {/* sources */}
        {sources.length > 1 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-faint">
              sources:
            </span>
            {sources.map(([k, label]) => {
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
          </div>
        )}
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-xs text-text-faint">
            no ingredients match
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {filtered.map((ing) => (
              <IngredientRow
                key={ing.key}
                ing={ing}
                onAdd={onAdd}
                deletable={
                  ing.source.kind === "user" &&
                  !!currentUserId &&
                  ing.source.userId === currentUserId
                }
                onRemoveCustom={onRemoveCustom}
              />
            ))}
          </ul>
        )}
      </div>

      {/* create */}
      <div className="border-t border-border p-3">
        <button
          type="button"
          onClick={onRequestAdd}
          className="w-full rounded-lg border border-accent/30 px-3 py-1.5 text-xs text-accent transition-colors duration-150 hover:border-accent/50 hover:bg-accent/10"
        >
          {canCreate ? "+ New ingredient" : "Sign in to add an ingredient"}
        </button>
      </div>
    </div>
  );
}

function IngredientRow({
  ing,
  onAdd,
  deletable,
  onRemoveCustom,
}: {
  ing: Ingredient;
  onAdd: (key: string) => void;
  deletable: boolean;
  onRemoveCustom?: (convexId: string) => void;
}) {
  const inert = ing.emits.length === 0 && !ing.minus && !ing.plus;
  return (
    <li className="group flex items-start justify-between gap-2 px-4 py-2.5 hover:bg-surface-alt">
      <button
        type="button"
        onClick={() => onAdd(ing.key)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Add ${ing.name} to the cauldron`}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: ing.color }}
          />
          <span className="truncate text-sm text-text">{ing.name}</span>
          {ing.source.kind === "user" && (
            <span className="shrink-0 truncate font-mono text-[10px] text-text-faint">
              · {ing.source.name}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {ing.emits.map((t, i) => (
            <FrequencySymbol key={`${t}:${i}`} id={t} size={18} />
          ))}
          {ing.minus > 0 && (
            <span
              className="rounded px-1 font-mono text-[10px]"
              style={{ color: STRIKE, background: "#a855f71a" }}
            >
              ⊖{ing.minus > 1 ? `×${ing.minus}` : ""}
            </span>
          )}
          {ing.plus > 0 && (
            <span
              className="rounded px-1 font-mono text-[10px]"
              style={{ color: COPPER, background: "#c98a3c1a" }}
            >
              ⊕{ing.plus > 1 ? `×${ing.plus}` : ""}
            </span>
          )}
          {inert && <span className="font-mono text-[10px] text-text-faint">inert</span>}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {deletable && onRemoveCustom && (
          <button
            type="button"
            onClick={() => onRemoveCustom(ing.key.replace(/^user:/, ""))}
            aria-label={`Delete ${ing.name}`}
            className="grid h-6 w-6 place-items-center rounded text-text-faint opacity-0 transition-colors duration-150 hover:text-error group-hover:opacity-100"
          >
            ×
          </button>
        )}
        <button
          type="button"
          onClick={() => onAdd(ing.key)}
          aria-label={`Add ${ing.name}`}
          className="grid h-7 w-7 place-items-center rounded-lg border border-border text-text-muted transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          +
        </button>
      </div>
    </li>
  );
}
