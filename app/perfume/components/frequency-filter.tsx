"use client";

// The frequency-filter control shared by the input panel and the perfume
// panel — MULTI-select. Empty: a square button holding an unfilled light-grey
// ring. With selections: the button grows horizontally into a rounded
// rectangle of the selected chips side by side (type glyphs for "type:*",
// charge chips for strike/wild). The dropdown BODY is the shared
// FrequencySearch (components/frequency-search.tsx) — the same searchable
// picker the brew graph's wild uses — driven here in multi-select mode: rows
// TOGGLE membership and the list stays open for multi-picking; the "all
// frequencies" / "all types/frequencies" clear row empties everything and
// closes. Matching semantics (frequencies AND, types OR among themselves — see
// DESIGN.md) belong to the callers; this control only edits the `values` list.

import { useRef, useState } from "react";
import { Popover, type PopoverAnchor } from "./popover";
import FrequencySearch, { freqLabel, FilterChip } from "./frequency-search";
import { cn } from "./ui";

// The shared shell interaction feel (components/ui.tsx BASE): a crisp
// keyboard-only ring and a consistent transition. Applied here so the filter
// trigger reads as one system with the rest of the shell, without disturbing
// the trigger's load-bearing grow-with-selection layout.
const CONTROL_FEEL =
  "transition-[color,background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";

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
  const btnRef = useRef<HTMLButtonElement>(null);
  const open = at !== null;

  const toggleOpen = () => {
    if (open) {
      setAt(null);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAt({ x: r.right, y: r.bottom + 4 });
  };

  // toggle membership; the dropdown stays open so several filters can be
  // picked in one visit
  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((v) => v !== id) : [...values, id]);

  const label = values.length
    ? `Filtering by ${values.map(freqLabel).join(", ")}`
    : includeTypes
      ? "Filter by type or frequency"
      : "Filter by frequency";

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
          <FrequencySearch
            onPick={toggle}
            isSelected={(id) => values.includes(id)}
            includeTypes={includeTypes}
            includeCharges={includeCharges}
            clearRow={{
              label: includeTypes ? "all types/frequencies" : "all frequencies",
              selected: values.length === 0,
              onClear: () => {
                onChange([]);
                setAt(null);
              },
            }}
          />
        </Popover>
      )}
    </div>
  );
}
