"use client";

// The frequency-filter control shared by the input panel and the perfume
// panel — MULTI-select. Empty: a square button holding an unfilled light-grey
// ring. With selections: the button grows horizontally into a rounded
// rectangle of the selected chips side by side (type glyphs for "type:*",
// charge chips for strike/wild). Dropdown rows TOGGLE membership and stay
// open for multi-picking; the "all frequencies" / "all types/frequencies"
// row clears everything and closes. Matching semantics (frequencies AND,
// types OR among themselves — see DESIGN.md) belong to the callers; this
// control only edits the `values` list.

import { useRef, useState } from "react";
import { ALL_FREQUENCIES, FUND, INGREDIENT_TYPES } from "../data/base";
import { FrequencyGlyph, TypeGlyph, ChargeSymbol } from "../lib/frequencies";
import { frequencyLabel } from "../lib/frequency-label";
import { isTypeFilter } from "../lib/filters";
import type { IngredientType } from "../lib/types";
import { Popover, type PopoverAnchor } from "./popover";
import { cn } from "./ui";

// The shared shell interaction feel (components/ui.tsx BASE): a crisp
// keyboard-only ring and a consistent transition. Applied here so the filter
// trigger and its dropdown rows read as one system with the rest of the shell,
// without disturbing the trigger's load-bearing grow-with-selection layout.
const CONTROL_FEEL =
  "transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

export function freqLabel(id: string): string {
  if (id === "strike") return "Strike ⊖";
  if (id === "wild") return "Wild ⊕";
  if (isTypeFilter(id)) return id.slice(5);
  return frequencyLabel(id);
}

// Chip for the two charge pseudo-filters — the app-wide charge chip.
export function ChargeGlyph({ id, size }: { id: "strike" | "wild"; size: number }) {
  return <ChargeSymbol kind={id} size={size} />;
}

// One filter value as its chip: type glyph for "type:*", charge chip for
// strike/wild, frequency glyph otherwise.
export function FilterChip({ id, size }: { id: string; size: number }) {
  if (isTypeFilter(id)) return <TypeGlyph type={id.slice(5) as IngredientType} size={size} />;
  if (id === "strike" || id === "wild") return <ChargeGlyph id={id} size={size} />;
  return <FrequencyGlyph id={id} size={size} />;
}

export interface FrequencyFilterProps {
  // frequency ids, plus "type:<t>" and "strike"/"wild" entries where offered
  values: string[];
  onChange: (values: string[]) => void;
  includeCharges?: boolean;
  // offer the ingredient TYPES (animal/plant/mineral) at the top of the list
  includeTypes?: boolean;
}

export default function FrequencyFilterButton({
  values,
  onChange,
  includeCharges = false,
  includeTypes = false,
}: FrequencyFilterProps) {
  const [at, setAt] = useState<PopoverAnchor | null>(null);
  const [q, setQ] = useState("");
  const btnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = at !== null;

  const toggleOpen = () => {
    if (open) {
      setAt(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right, y: r.bottom + 4 });
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  // toggle membership; the dropdown stays open so several filters can be
  // picked in one visit
  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((v) => v !== id) : [...values, id]);

  const query = q.trim().toLowerCase();
  const items = ALL_FREQUENCIES.filter(
    (t) =>
      !query ||
      t.id.toLowerCase().includes(query) ||
      (FUND[t.id]?.school ?? "").toLowerCase().includes(query),
  );

  const label = values.length
    ? `Filtering by ${values.map(freqLabel).join(", ")}`
    : includeTypes
      ? "Filter by type or frequency"
      : "Filter by frequency";

  const rowClass = (selected: boolean) =>
    cn(
      "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-surface-alt",
      CONTROL_FEEL,
      selected ? "bg-surface-alt text-text" : "text-text-muted",
    );

  return (
    <div className="relative shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={toggleOpen}
        // Keep the trigger's mousedown from reaching the Popover's
        // useDismissable document listener — otherwise clicking the trigger to
        // close fires both the outside-dismiss and this toggle, racing back open.
        onMouseDown={(e) => e.stopPropagation()}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={values.length ? `${label} — click to change` : label}
        // grows with the selection; max-w + wrap guard the search input's
        // room when many filters are on at once
        className={cn(
          "flex h-full min-w-[42px] max-w-[220px] flex-wrap items-center justify-center gap-1 rounded-lg border bg-bg px-2 py-1",
          CONTROL_FEEL,
          values.length ? "border-accent" : "border-border hover:border-text-muted",
        )}
      >
        {values.length === 0 ? (
          // the "empty frequency": an unfilled ring in the site's light grey
          <span
            aria-hidden="true"
            className="inline-block rounded-full"
            style={{
              width: 22,
              height: 22,
              border: "2px solid var(--color-text-muted)",
              opacity: 0.9,
            }}
          />
        ) : (
          values.map((v) => <FilterChip key={v} id={v} size={20} />)
        )}
      </button>
      {at && (
        <Popover
          anchor={at}
          align="right"
          width={256}
          role="dialog"
          label={label}
          onClose={() => setAt(null)}
          className="overflow-hidden"
        >
          <div role="listbox" aria-multiselectable="true">
          <div className="border-b border-border p-2">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="filter frequencies…"
              spellCheck={false}
              className="w-full rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-xs text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <button
              type="button"
              role="option"
              aria-selected={values.length === 0}
              onClick={() => {
                onChange([]);
                setAt(null);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs hover:bg-surface-alt",
                CONTROL_FEEL,
                values.length === 0 ? "text-text" : "text-text-muted",
              )}
            >
              <span
                aria-hidden="true"
                className="inline-block shrink-0 rounded-full"
                style={{ width: 18, height: 18, border: "2px solid var(--color-text-muted)", opacity: 0.9 }}
              />
              {includeTypes ? "all types/frequencies" : "all frequencies"}
            </button>
            {includeTypes &&
              INGREDIENT_TYPES.filter(
                (t) => !query || t.includes(query),
              ).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="option"
                  aria-selected={values.includes(`type:${t}`)}
                  onClick={() => toggle(`type:${t}`)}
                  className={rowClass(values.includes(`type:${t}`))}
                >
                  <TypeGlyph type={t} size={18} />
                  <span>{t}</span>
                </button>
              ))}
            {includeCharges &&
              (["strike", "wild"] as const)
                .filter((id) => !query || id.includes(query) || freqLabel(id).toLowerCase().includes(query))
                .map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={values.includes(id)}
                    onClick={() => toggle(id)}
                    className={rowClass(values.includes(id))}
                  >
                    <ChargeGlyph id={id} size={18} />
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
                aria-selected={values.includes(t.id)}
                onClick={() => toggle(t.id)}
                className={rowClass(values.includes(t.id))}
              >
                <FrequencyGlyph id={t.id} size={18} />
                <span>{freqLabel(t.id)}</span>
              </button>
            ))}
          </div>
          </div>
        </Popover>
      )}
    </div>
  );
}
