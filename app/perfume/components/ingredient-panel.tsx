"use client";

// The ingredients panel: the 96 base ingredients plus the pure frequencies,
// searchable by name or by any frequency they emit (id or school name — e.g.
// "transmutation" finds every T-emitting ingredient), with a frequency
// drop-down filter. Rows in the brew are highlighted amber and carry
// −/count/+ controls like the cauldron panel's brew tray; clicking the row
// itself adds one when absent, or removes all copies when present.

import { useMemo, useState } from "react";
import type { Ingredient } from "../lib/types";
import type { IngredientPanelProps } from "./contracts";
import { ALL_FREQUENCIES, FUND, isNamed } from "../data/base";
import { FrequencyGlyph, FrequencySymbol, STRIKE, COPPER } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";

function freqLabel(id: string): string {
  return isNamed(id) ? id : `${id} — ${FUND[id]?.school ?? id}`;
}

export default function IngredientPanel({
  ingredients,
  brewCounts,
  onAdd,
  onDec,
  onRemoveAll,
}: IngredientPanelProps) {
  const [search, setSearch] = useState("");
  const [freqFilter, setFreqFilter] = useState<string>("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ingredients
      .filter((ing) => (freqFilter ? ing.emits.includes(freqFilter) : true))
      .filter((ing) => {
        if (!q) return true;
        if (ing.name.toLowerCase().includes(q)) return true;
        // by emitted frequency: id ("En") or school name ("transmutation")
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
          placeholder="search ingredients or frequencies…"
          spellCheck={false}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />

        {/* frequency filter drop-down */}
        <div className="flex items-center gap-2">
          <select
            value={freqFilter}
            onChange={(e) => setFreqFilter(e.target.value)}
            aria-label="Filter ingredients by frequency"
            className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text focus:border-accent focus:outline-none"
          >
            <option value="">all frequencies</option>
            {ALL_FREQUENCIES.map((t) => (
              <option key={t.id} value={t.id}>
                {freqLabel(t.id)}
              </option>
            ))}
          </select>
          {freqFilter && <FrequencySymbol id={freqFilter} size={22} />}
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
              <IngredientRow
                key={ing.key}
                ing={ing}
                count={brewCounts[ing.key] ?? 0}
                onAdd={onAdd}
                onDec={onDec}
                onRemoveAll={onRemoveAll}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function IngredientRow({
  ing,
  count,
  onAdd,
  onDec,
  onRemoveAll,
}: {
  ing: Ingredient;
  count: number;
  onAdd: (key: string) => void;
  onDec: (key: string) => void;
  onRemoveAll: (key: string) => void;
}) {
  const inert = ing.emits.length === 0 && !ing.strike && !ing.wild;
  const pure = ing.key.startsWith("pure:");
  const pureId = pure ? ing.key.slice(5) : null;
  const inBrew = count > 0;

  return (
    <li
      className={`group flex items-start justify-between gap-2 px-4 py-2.5 transition-colors ${
        inBrew
          ? "border-l-2 border-amber-400 bg-amber-400/10 hover:bg-amber-400/15"
          : "border-l-2 border-transparent hover:bg-surface-alt"
      }`}
    >
      {/* row body: add one when absent, remove all when present */}
      <button
        type="button"
        onClick={() => (inBrew ? onRemoveAll(ing.key) : onAdd(ing.key))}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
        aria-label={
          inBrew
            ? `Remove all ${ing.name} from the brew`
            : `Add ${ing.name} to the brew`
        }
        title={inBrew ? "Click to remove all from the brew" : "Click to add to the brew"}
      >
        {pure && pureId && pureId !== "strike" && pureId !== "wild" ? (
          <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-md border border-border/60 bg-surface-alt">
            <FrequencyGlyph id={pureId} size={26} />
          </span>
        ) : pure ? (
          <span
            className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-md border border-border/60 bg-surface-alt text-lg font-bold"
            style={{ color: pureId === "strike" ? STRIKE : COPPER }}
          >
            {pureId === "strike" ? "⊖" : "⊕"}
          </span>
        ) : (
          <IngredientThumb name={ing.name} source={ing.source} color={ing.color} size={42} />
        )}
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text">{ing.name}</span>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {ing.emits.map((t, i) => (
              <FrequencySymbol key={`${t}:${i}`} id={t} size={18} />
            ))}
            {ing.strike > 0 && (
              <span
                className="rounded px-1 font-mono text-[10px]"
                style={{ color: STRIKE, background: "#a855f71a" }}
              >
                ⊖{ing.strike > 1 ? `×${ing.strike}` : ""}
              </span>
            )}
            {ing.wild > 0 && (
              <span
                className="rounded px-1 font-mono text-[10px]"
                style={{ color: COPPER, background: "#c98a3c1a" }}
              >
                ⊕{ing.wild > 1 ? `×${ing.wild}` : ""}
              </span>
            )}
            {inert && <span className="font-mono text-[10px] text-text-faint">inert</span>}
          </div>
        </div>
      </button>

      {/* −/count/+ controls, matching the brew tray */}
      <span className="flex shrink-0 items-center gap-0.5 self-center font-mono">
        <button
          type="button"
          onClick={() => onDec(ing.key)}
          disabled={!inBrew}
          aria-label={`Remove one ${ing.name}`}
          className="grid h-5 w-5 place-items-center rounded text-text-muted hover:bg-surface-alt hover:text-text disabled:opacity-30"
        >
          −
        </button>
        <span
          className={`w-5 text-center text-xs tabular-nums ${
            inBrew ? "text-amber-400" : "text-text-faint"
          }`}
        >
          {count}
        </span>
        <button
          type="button"
          onClick={() => onAdd(ing.key)}
          aria-label={`Add one ${ing.name}`}
          className="grid h-5 w-5 place-items-center rounded text-text-muted hover:bg-surface-alt hover:text-text"
        >
          +
        </button>
      </span>
    </li>
  );
}
