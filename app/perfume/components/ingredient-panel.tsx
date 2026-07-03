"use client";

// The ingredients panel, in two tabs: the 96 base ingredients and the pure
// frequencies. Search matches names or any emitted frequency (id or school
// name — e.g. "transmutation" finds every T-emitter); a symbol drop-down
// filters by frequency. Rows in the brew are ringed amber and carry
// −/count/+ controls; clicking the row body adds one when absent, or
// removes every copy when present.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Ingredient } from "../lib/types";
import type { IngredientPanelProps } from "./contracts";
import { ALL_FREQUENCIES, FUND, isNamed, isPureKey, ingredientWeight } from "../data/base";
import { FrequencyGlyph, FrequencySymbol, STRIKE, COPPER } from "../lib/frequencies";
import IngredientThumb from "./ingredient-thumb";

function freqLabel(id: string): string {
  return isNamed(id) ? id : `${id} — ${FUND[id]?.school ?? id}`;
}

// Frequencies-tab order: pure strike/wild first, then the fundamentals, then
// the named frequencies — alphabetical within each category.
function pureRank(ing: Ingredient): number {
  if (ing.strike > 0 || ing.wild > 0) return 0;
  return isNamed(ing.key.slice(5)) ? 2 : 1;
}

type Tab = "ingredients" | "frequencies";

export default function IngredientPanel({
  ingredients,
  brewCounts,
  onAdd,
  onDec,
  onRemoveAll,
}: IngredientPanelProps) {
  const [tab, setTab] = useState<Tab>("ingredients");
  const [search, setSearch] = useState("");
  const [freqFilter, setFreqFilter] = useState<string>("");

  const tabItems = useMemo(
    () => ingredients.filter((i) => (tab === "frequencies") === isPureKey(i.key)),
    [ingredients, tab],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    // the frequency filter only applies (and only shows) on the ingredients tab
    return tabItems
      .filter((ing) =>
        tab === "ingredients" && freqFilter ? ing.emits.includes(freqFilter) : true,
      )
      .filter((ing) => {
        if (!q) return true;
        if (ing.name.toLowerCase().includes(q)) return true;
        // by emitted frequency: id ("En") or school name ("transmutation")
        if (ing.emits.some((t) => t.toLowerCase().includes(q))) return true;
        if (ing.emits.some((t) => (FUND[t]?.school ?? "").toLowerCase().includes(q))) return true;
        return false;
      })
      .sort((a, b) =>
        tab === "frequencies"
          ? pureRank(a) - pureRank(b) || a.name.localeCompare(b.name)
          : ingredientWeight(a) - ingredientWeight(b) ||
            a.name.localeCompare(b.name),
      );
  }, [tab, tabItems, freqFilter, search]);

  return (
    <div className="flex h-full flex-col rounded-lg border border-border bg-surface">
      {/* header + tabs */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1">
          {(["ingredients", "frequencies"] as Tab[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              aria-pressed={tab === t}
              className={`rounded-md px-2.5 py-1.5 text-sm font-semibold transition-colors duration-150 ${
                tab === t
                  ? "bg-surface-alt text-text"
                  : "text-text-faint hover:text-text-muted"
              }`}
            >
              {t === "ingredients" ? "Ingredients" : "Frequencies"}
            </button>
          ))}
        </div>
        <span className="font-mono text-xs tabular-nums text-text-faint">
          {filtered.length}/{tabItems.length}
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
        {tab === "ingredients" && (
          <FrequencyDropdown value={freqFilter} onChange={setFreqFilter} />
        )}
      </div>

      {/* list */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="px-4 py-6 text-center font-mono text-xs text-text-faint">
            {tab === "ingredients" ? "no ingredients match" : "no frequencies match"}
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

// A drop-down of every frequency WITH its symbol (a native <select> can't
// render the glyphs, so this is a small custom listbox).
function FrequencyDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter by frequency"
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-left font-mono text-xs text-text focus:border-accent focus:outline-none"
      >
        {value ? (
          <>
            <FrequencyGlyph id={value} size={18} />
            <span>{freqLabel(value)}</span>
          </>
        ) : (
          <span className="text-text-muted">all frequencies</span>
        )}
        <span className="ml-auto text-text-faint">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl"
        >
          <button
            type="button"
            role="option"
            aria-selected={value === ""}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-surface-alt ${
              value === "" ? "text-text" : "text-text-muted"
            }`}
          >
            all frequencies
          </button>
          {ALL_FREQUENCIES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={value === t.id}
              onClick={() => {
                onChange(t.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-surface-alt ${
                value === t.id ? "bg-surface-alt text-text" : "text-text-muted"
              }`}
            >
              <FrequencyGlyph id={t.id} size={18} />
              <span>{freqLabel(t.id)}</span>
            </button>
          ))}
        </div>
      )}
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
  const pure = isPureKey(ing.key);
  const pureId = pure ? ing.key.slice(5) : null;
  const inBrew = count > 0;

  return (
    <li
      className={`group flex items-start justify-between gap-2 px-4 py-2.5 transition-colors ${
        inBrew
          ? "border-l-2 border-amber-400 bg-amber-400/10 ring-1 ring-inset ring-amber-400/50 hover:bg-amber-400/15"
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
            {Array.from({ length: ing.strike }, (_, i) => (
              <span
                key={`s${i}`}
                className="grid h-[18px] w-[18px] place-items-center rounded-full border text-[11px] font-bold"
                style={{ color: STRIKE, borderColor: STRIKE, background: "#a855f71a" }}
              >
                ⊖
              </span>
            ))}
            {Array.from({ length: ing.wild }, (_, i) => (
              <span
                key={`w${i}`}
                className="grid h-[18px] w-[18px] place-items-center rounded-full border text-[11px] font-bold"
                style={{ color: COPPER, borderColor: COPPER, background: "#c98a3c1a" }}
              >
                ⊕
              </span>
            ))}
            {inert && <span className="font-mono text-[10px] text-text-faint">inert</span>}
          </div>
        </div>
      </button>

      {/* −/count/+ controls */}
      <span className="flex shrink-0 items-center gap-1 self-center font-mono">
        <button
          type="button"
          onClick={() => onDec(ing.key)}
          disabled={!inBrew}
          aria-label={`Remove one ${ing.name}`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border text-text-muted transition-colors duration-150 hover:border-accent hover:text-accent disabled:opacity-30 disabled:hover:border-border disabled:hover:text-text-muted"
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
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-border text-text-muted transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          +
        </button>
      </span>
    </li>
  );
}
