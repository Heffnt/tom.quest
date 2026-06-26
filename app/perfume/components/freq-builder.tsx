"use client";

import { useMemo, useState } from "react";
import { ALL_TOKENS, isNamed, NAMED } from "../data/base";
import { FrequencySymbol } from "../lib/frequencies";

// A searchable picker that builds a multiset of frequency tokens (repeats
// allowed). Used by the add-ingredient (emits) and add-recipe (req) modals.
export default function FreqBuilder({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();

  const options = useMemo(
    () =>
      ALL_TOKENS.filter((t) => {
        if (!query) return true;
        if (t.id.toLowerCase().includes(query)) return true;
        if (isNamed(t.id) && (NAMED[t.id]?.icon ?? "").toLowerCase().includes(query)) return true;
        return false;
      }),
    [query],
  );

  return (
    <div>
      <label className="mb-1 block text-sm text-text-muted">{label}</label>

      {/* current selection */}
      <div className="mb-2 flex min-h-[34px] flex-wrap items-center gap-1 rounded-lg border border-border bg-bg p-1.5">
        {value.length === 0 && (
          <span className="px-1 font-mono text-xs text-text-faint">none yet — pick below</span>
        )}
        {value.map((id, i) => (
          <button
            key={`${id}:${i}`}
            type="button"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
            title={`remove ${id}`}
            aria-label={`Remove ${id}`}
            className="group relative grid place-items-center rounded-full"
          >
            <FrequencySymbol id={id} size={22} />
            <span className="absolute -right-1 -top-1 hidden h-3 w-3 place-items-center rounded-full bg-error text-[8px] text-white group-hover:grid">
              ×
            </span>
          </button>
        ))}
      </div>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="search frequencies…"
        spellCheck={false}
        className="w-full rounded-lg border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
      />

      <div className="mt-2 flex max-h-[140px] flex-wrap content-start gap-1 overflow-y-auto rounded-lg border border-border bg-bg p-2">
        {options.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange([...value, t.id])}
            title={`add ${t.id}`}
            aria-label={`Add ${t.id}`}
            className="grid place-items-center rounded-full p-0.5 opacity-80 transition-opacity hover:opacity-100"
          >
            <FrequencySymbol id={t.id} size={24} />
          </button>
        ))}
      </div>
    </div>
  );
}
