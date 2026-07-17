"use client";

// app/boolback/components/axis-range.tsx — the compact axis view-window (zoom)
// min/max editor, SHARED by the main plot (mounted by each axis end) and the
// Group Plot toolbar (inline beside the x/y pickers) so the commit/format
// logic exists once. Click a number to edit (Enter commits, Esc/blur cancels);
// ⟲ clears the zoom. Purely a VIEW WINDOW — both callers write the shared
// plot config's xDomain/yDomain, never FilterState, so clipped points stay in
// the table and filters, and the two views show the same window by
// construction.

import { useState } from "react";

export function AxisRange({
  axis, domain, extent, onSet, style, inline = false,
}: {
  axis: "x" | "y";
  /** The set zoom window in RAW units (null → the data extent shows). */
  domain: [number, number] | null;
  /** Raw data-extent fallback; null renders nothing (no data yet). */
  extent: [number, number] | null;
  onSet: (d: [number, number] | null) => void;
  /** Absolute-position style for the on-axis (overlay) placement. */
  style?: React.CSSProperties;
  /** true → toolbar placement: static flow, toolbar-sized text, no backdrop. */
  inline?: boolean;
}) {
  const [edit, setEdit] = useState<null | 0 | 1>(null);
  const lo = domain?.[0] ?? extent?.[0];
  const hi = domain?.[1] ?? extent?.[1];
  if (lo === undefined || hi === undefined) return null;

  const commit = (which: 0 | 1, raw: string) => {
    setEdit(null);
    const v = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(v)) return;
    const next: [number, number] = which === 0 ? [v, hi] : [lo, v];
    if (next[0] < next[1]) onSet(next);
  };
  const fmt = (n: number) =>
    Math.abs(n) >= 1000 || (n !== 0 && Math.abs(n) < 0.01)
      ? n.toExponential(1)
      : String(Number(n.toFixed(3)));

  const textSize = inline ? "text-xs" : "text-sm";
  const Field = (which: 0 | 1, value: number) =>
    edit === which ? (
      <input
        autoFocus
        type="number"
        defaultValue={value}
        aria-label={`${axis} ${which === 0 ? "min" : "max"}`}
        onBlur={(e) => commit(which, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(which, (e.target as HTMLInputElement).value);
          else if (e.key === "Escape") setEdit(null);
        }}
        className={`w-16 rounded border border-accent/50 bg-surface px-1 ${textSize} text-text tabular-nums focus:outline-none`}
      />
    ) : (
      <button
        type="button"
        onClick={() => setEdit(which)}
        title={`edit ${axis} ${which === 0 ? "min" : "max"} (zoom only)`}
        className="tabular-nums hover:text-accent"
      >
        {fmt(value)}
      </button>
    );

  return (
    <div
      className={[
        inline
          ? "flex items-center gap-0.5 rounded px-1"
          : "pointer-events-auto absolute z-10 flex items-center gap-0.5 rounded bg-surface/70 px-1",
        textSize,
        "text-text-faint",
      ].join(" ")}
      style={style}
    >
      {Field(0, lo)}
      <span aria-hidden>–</span>
      {Field(1, hi)}
      {domain && (
        <button
          type="button"
          onClick={() => onSet(null)}
          title="reset zoom to fit"
          aria-label={`reset ${axis} zoom`}
          className="ml-0.5 hover:text-accent"
        >
          ⟲
        </button>
      )}
    </div>
  );
}
