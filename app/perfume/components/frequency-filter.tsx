"use client";

// The square frequency-filter control shared by the ingredients panel and
// the recipe panel: an empty light-grey ring until a frequency is chosen,
// then that frequency's icon. Clicking opens a searchable listbox; the
// ingredients panel also gets Strike ⊖ / Wild ⊕ entries (charge carriers).

import { useEffect, useRef, useState } from "react";
import { ALL_FREQUENCIES, FUND, isNamed, INGREDIENT_TYPES } from "../data/base";
import { FrequencyGlyph, TypeGlyph, STRIKE, COPPER } from "../lib/frequencies";
import type { IngredientType } from "../lib/types";

export const isTypeFilter = (v: string): boolean => v.startsWith("type:");

export function freqLabel(id: string): string {
  if (id === "strike") return "Strike ⊖";
  if (id === "wild") return "Wild ⊕";
  if (isTypeFilter(id)) return id.slice(5);
  return isNamed(id) ? id : (FUND[id]?.school ?? id);
}

// Chip for the two charge pseudo-filters (⊖ / ⊕), circle-ringed like the
// frequency glyphs.
export function ChargeGlyph({ id, size }: { id: "strike" | "wild"; size: number }) {
  const c = id === "strike" ? STRIKE : COPPER;
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full border-2 font-bold"
      style={{
        width: size,
        height: size,
        color: c,
        borderColor: c,
        background: `${c}1a`,
        fontSize: Math.round(size * 0.55),
      }}
    >
      {id === "strike" ? "−" : "+"}
    </span>
  );
}

export default function FrequencyFilterButton({
  value,
  onChange,
  includeCharges = false,
  includeTypes = false,
}: {
  value: string;
  onChange: (id: string) => void;
  includeCharges?: boolean;
  // offer the ingredient TYPES (animal/plant/mineral) at the top of the list
  includeTypes?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const query = q.trim().toLowerCase();
  const items = ALL_FREQUENCIES.filter(
    (t) =>
      !query ||
      t.id.toLowerCase().includes(query) ||
      (FUND[t.id]?.school ?? "").toLowerCase().includes(query),
  );

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={value ? `Filtering by ${freqLabel(value)}` : "Filter by frequency"}
        title={value ? `Filtering by ${freqLabel(value)} — click to change` : "Filter by frequency"}
        className={`grid h-full w-[42px] place-items-center rounded-lg border bg-bg transition-colors duration-150 ${
          value ? "border-accent" : "border-border hover:border-text-muted"
        }`}
      >
        {isTypeFilter(value) ? (
          <TypeGlyph type={value.slice(5) as IngredientType} size={24} />
        ) : value === "strike" || value === "wild" ? (
          <ChargeGlyph id={value} size={24} />
        ) : value ? (
          <FrequencyGlyph id={value} size={24} />
        ) : (
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
        )}
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        >
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
              aria-selected={value === ""}
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-surface-alt ${
                value === "" ? "text-text" : "text-text-muted"
              }`}
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
                  aria-selected={value === `type:${t}`}
                  onClick={() => {
                    onChange(`type:${t}`);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-surface-alt ${
                    value === `type:${t}` ? "bg-surface-alt text-text" : "text-text-muted"
                  }`}
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
                    aria-selected={value === id}
                    onClick={() => {
                      onChange(id);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-xs transition-colors hover:bg-surface-alt ${
                      value === id ? "bg-surface-alt text-text" : "text-text-muted"
                    }`}
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
        </div>
      )}
    </div>
  );
}
