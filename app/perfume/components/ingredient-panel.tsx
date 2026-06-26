"use client";

import { useMemo, useState } from "react";
import type { Ingredient } from "../lib/types";
import type { IngredientPanelProps } from "./contracts";
import { ALL_TOKENS, FUND } from "../data/base";
import { FrequencySymbol, STRIKE, COPPER } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";

export default function IngredientPanel({ ingredients, onAdd }: IngredientPanelProps) {
  const [search, setSearch] = useState("");
  const [freqFilter, setFreqFilter] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ingredients
      .filter((ing) => (freqFilter ? ing.emits.includes(freqFilter) : true))
      .filter((ing) => {
        if (!q) return true;
        if (ing.name.toLowerCase().includes(q)) return true;
        if (ing.emits.some((t) => t.toLowerCase().includes(q))) return true;
        if (ing.emits.some((t) => (FUND[t]?.school ?? "").toLowerCase().includes(q))) return true;
        return false;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [ingredients, freqFilter, search]);

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

        {/* filter by frequency */}
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
              <IngredientRow key={ing.key} ing={ing} onAdd={onAdd} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IngredientRow({
  ing,
  onAdd,
}: {
  ing: Ingredient;
  onAdd: (key: string) => void;
}) {
  const inert = ing.emits.length === 0 && !ing.minus && !ing.plus;
  return (
    <li className="group flex items-start justify-between gap-2 px-4 py-2.5 hover:bg-surface-alt">
      <button
        type="button"
        onClick={() => onAdd(ing.key)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        aria-label={`Add ${ing.name} to the cauldron`}
      >
        <IngredientThumb name={ing.name} source={ing.source} color={ing.color} size={42} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text">{ing.name}</span>
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
        </div>
      </button>
      <button
        type="button"
        onClick={() => onAdd(ing.key)}
        aria-label={`Add ${ing.name}`}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border text-text-muted transition-colors duration-150 hover:border-accent hover:text-accent"
      >
        +
      </button>
    </li>
  );
}
