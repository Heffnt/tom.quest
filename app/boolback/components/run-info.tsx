"use client";

// app/boolback/components/run-info.tsx — the ⓘ "what is a run?" popover.
//
// One row = one run = one fine-tuning execution. The definition is pinned to
// the CMT rollup invariants (NODE_KEY grouping; no-over-rowing; the -none
// baseline folds into epoch0_baseline) — see boolback-usability-plan.md §0.
//
// The top-bar instance also carries the unfiltered corpus totals (`stats`)
// — they used to be an always-on strip in the old command bar.

import { useRef, useState } from "react";

export interface RunInfoStat {
  label: string;
  value: string;
  title?: string;
}

export function RunInfo({
  plantedThreshold,
  align = "right",
  stats,
}: {
  plantedThreshold: number;
  /** Popover anchor edge — "left" when the ⓘ sits near the viewport's left. */
  align?: "left" | "right";
  /** Optional corpus totals appended below the definition. */
  stats?: RunInfoStat[];
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // FIXED positioning (anchor captured on open): a fixed popover escapes any
  // overflow-clipping ancestor the ⓘ lands in. Rect is stable while open
  // (backdrop blocks interaction; a scrolled-away popover just closes on the
  // backdrop click).
  const [pos, setPos] = useState<{ top: number; left: number; right: number } | null>(null);
  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      setPos({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right });
    }
    setOpen((o) => !o);
  };
  return (
    <span className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        aria-label="what is a run?"
        onClick={toggle}
        className={[
          "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none transition-colors",
          open
            ? "border-accent text-accent"
            : "border-border text-text-faint hover:text-accent hover:border-accent/50",
        ].join(" ")}
      >
        i
      </button>
      {open && pos && (
        <>
          {/* z-40: clears the top bar's z-30 stacking context; the table's
              whole z range stays <= z-20. */}
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span
            className="fixed z-40 block w-80 rounded-lg border border-border bg-surface/95 p-3 text-left text-xs leading-relaxed text-text/90 shadow-lg backdrop-blur-md animate-settle"
            style={
              align === "left"
                ? { top: pos.top, left: pos.left }
                : { top: pos.top, right: pos.right }
            }
          >
            <span className="mb-1 block font-medium text-text">1 run = 1 fine-tuned model</span>
            A run is one fine-tuning execution: one boolean <b>function</b> (the
            trigger logic) × one poisoned <b>dataset</b> built for it × one{" "}
            <b>training</b> config (base model, tuning method, lr, epochs,{" "}
            <b>seed included</b> — two seeds are two runs).
            <span className="mt-1.5 block">
              Everything below training folds <i>into</i> the row: epochs become
              trajectories, every judge becomes per-judge scores, and the
              headline is the primary judge at the display epoch. Planted means
              plantedness ≥ {plantedThreshold}.
            </span>
            <span className="mt-1.5 block text-text-muted">
              Not runs: the −none epoch-0 base-eval (shown as each run&apos;s
              baseline) and dataset-level scans (attached to their runs).
            </span>
            {stats && stats.length > 0 && (
              <span className="mt-2 block border-t border-border pt-2">
                <span className="mb-1 block font-medium text-text">whole snapshot (unfiltered)</span>
                <span className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {stats.map((s) => (
                    <span
                      key={s.label}
                      className="flex items-baseline justify-between gap-2"
                      title={s.title}
                    >
                      <span className="text-text-muted">{s.label}</span>
                      <span className="font-mono tabular-nums text-text">{s.value}</span>
                    </span>
                  ))}
                </span>
              </span>
            )}
          </span>
        </>
      )}
    </span>
  );
}
