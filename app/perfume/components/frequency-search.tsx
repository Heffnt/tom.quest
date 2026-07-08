"use client";

// FrequencySearch — the shared searchable frequency picker BODY (a query box +
// a scrollable, filterable list of frequency rows). Extracted from
// frequency-filter.tsx so the SAME search UX serves every surface that picks a
// frequency:
//   - the Frequencies-tab / perfume-panel FILTER dropdown (multi-select: rows
//     TOGGLE membership and the list stays open — pass `isSelected`), and
//   - the brew graph's WILD picker (single-select, the wild itself excluded —
//     DESIGN.md §1 "wild frequency"; pass `exclude` + a plain `onPick`).
//
// The picker owns only the query box and the list. Selection SEMANTICS
// (toggle-and-stay vs pick-and-close, clearing) live in the parent via `onPick`
// and the optional `clearRow`. Matching semantics (frequencies AND, types OR)
// also belong to the callers — this control only reports which row was clicked.

import { useEffect, useMemo, useRef, useState } from "react";
import { ALL_FREQUENCIES, FUND, NAMED, INGREDIENT_TYPES, isNamed } from "../data/base";
import { FrequencyGlyph, TypeGlyph, ChargeSymbol } from "../lib/frequencies";
import { frequencyLabel } from "../lib/frequency-label";
import { isTypeFilter } from "../lib/filters";
import type { IngredientType } from "../lib/types";
import { cn } from "./ui";

// The shared shell interaction feel (components/ui.tsx BASE): a crisp
// keyboard-only ring and a consistent transition, so these rows read as one
// system with the rest of the shell.
const CONTROL_FEEL =
  "transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

// A filter/frequency value as its human label: charge chips for strike/wild,
// the bare type name for "type:*", the frequency label otherwise.
export function freqLabel(id: string): string {
  if (id === "strike") return "Strike ⊖";
  if (id === "wild") return "Wild ⊕";
  if (isTypeFilter(id)) return id.slice(5);
  return frequencyLabel(id);
}

// One value as its chip: type glyph for "type:*", charge chip for strike/wild,
// frequency glyph otherwise. Used by the filter trigger to show the selection.
export function FilterChip({ id, size }: { id: string; size: number }) {
  if (isTypeFilter(id)) return <TypeGlyph type={id.slice(5) as IngredientType} size={size} />;
  if (id === "strike" || id === "wild") return <ChargeSymbol kind={id} size={size} />;
  return <FrequencyGlyph id={id} size={size} />;
}

export interface FrequencySearchProps {
  // A row (frequency id, "type:<t>", or "strike"/"wild") was clicked.
  onPick: (id: string) => void;
  // Highlight already-selected rows (the multi-select filter reuse). Omit for a
  // single-shot picker like the wild.
  isSelected?: (id: string) => boolean;
  // offer the ingredient TYPES (animal/plant/mineral) at the top of the list
  includeTypes?: boolean;
  // offer the strike/wild charge pseudo-filters
  includeCharges?: boolean;
  // ids to omit entirely (e.g. `["wild"]` in the wild picker — DESIGN.md §1)
  exclude?: readonly string[];
  // a leading "clear everything" row (the filter's "all frequencies")
  clearRow?: { label: string; selected: boolean; onClear: () => void };
  placeholder?: string;
  autoFocus?: boolean;
}

export default function FrequencySearch({
  onPick,
  isSelected,
  includeTypes = false,
  includeCharges = false,
  exclude,
  clearRow,
  placeholder = "filter frequencies…",
  autoFocus = true,
}: FrequencySearchProps) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [autoFocus]);

  const query = q.trim().toLowerCase();
  const excluded = useMemo(() => new Set(exclude ?? []), [exclude]);
  const selected = (id: string) => isSelected?.(id) ?? false;

  const items = useMemo(
    () =>
      ALL_FREQUENCIES.filter((t) => {
        if (excluded.has(t.id)) return false;
        if (!query) return true;
        if (t.id.toLowerCase().includes(query)) return true;
        if ((FUND[t.id]?.school ?? "").toLowerCase().includes(query)) return true;
        if (isNamed(t.id) && (NAMED[t.id]?.icon ?? "").toLowerCase().includes(query)) return true;
        return false;
      }),
    [query, excluded],
  );

  const types = includeTypes
    ? INGREDIENT_TYPES.filter((t) => !excluded.has(`type:${t}`) && (!query || t.includes(query)))
    : [];
  const charges = includeCharges
    ? (["strike", "wild"] as const).filter(
        (id) =>
          !excluded.has(id) &&
          (!query || id.includes(query) || freqLabel(id).toLowerCase().includes(query)),
      )
    : [];

  const rowClass = (sel: boolean) =>
    cn(
      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-surface-alt",
      CONTROL_FEEL,
      sel ? "bg-surface-alt text-text" : "text-text-muted",
    );

  return (
    <div role="listbox" aria-multiselectable={isSelected ? true : undefined}>
      <div className="border-b border-border p-2">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {clearRow && (
          <button
            type="button"
            role="option"
            aria-selected={clearRow.selected}
            onClick={clearRow.onClear}
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-surface-alt",
              CONTROL_FEEL,
              clearRow.selected ? "text-text" : "text-text-muted",
            )}
          >
            <span
              aria-hidden="true"
              className="inline-block shrink-0 rounded-full"
              style={{ width: 18, height: 18, border: "2px solid var(--color-text-muted)", opacity: 0.9 }}
            />
            {clearRow.label}
          </button>
        )}
        {types.map((t) => (
          <button
            key={`type:${t}`}
            type="button"
            role="option"
            aria-selected={selected(`type:${t}`)}
            onClick={() => onPick(`type:${t}`)}
            className={rowClass(selected(`type:${t}`))}
          >
            <TypeGlyph type={t} size={18} />
            <span>{t}</span>
          </button>
        ))}
        {charges.map((id) => (
          <button
            key={id}
            type="button"
            role="option"
            aria-selected={selected(id)}
            onClick={() => onPick(id)}
            className={rowClass(selected(id))}
          >
            <ChargeSymbol kind={id} size={18} />
            <span>{freqLabel(id)}</span>
          </button>
        ))}
        {items.length === 0 && (
          <p className="px-2 py-3 text-center font-mono text-xs text-text-faint">no match</p>
        )}
        {items.map((t) => (
          <button
            key={t.id}
            type="button"
            role="option"
            aria-selected={selected(t.id)}
            onClick={() => onPick(t.id)}
            className={rowClass(selected(t.id))}
          >
            <FrequencyGlyph id={t.id} size={18} />
            <span>{freqLabel(t.id)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
