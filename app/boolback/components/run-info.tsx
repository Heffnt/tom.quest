"use client";

// app/boolback/components/run-info.tsx — the ⓘ "what is a run?" popover.
//
// One row = one run = one fine-tuning execution. The definition is pinned to
// the CMT rollup invariants (NODE_KEY grouping; no-over-rowing; the -none
// baseline folds into epoch0_baseline) — see boolback-usability-plan.md §0.

import { useState } from "react";

export function RunInfo({ plantedThreshold }: { plantedThreshold: number }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        aria-label="what is a run?"
        onClick={() => setOpen((o) => !o)}
        className={[
          "inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none transition-colors",
          open
            ? "border-accent text-accent"
            : "border-border text-text-faint hover:text-accent hover:border-accent/50",
        ].join(" ")}
      >
        i
      </button>
      {open && (
        <>
          {/* z-40: must clear the filter bar's z-30 stacking context when this
              popover is opened from the COMMAND bar (which sits above it in
              layout but earlier in DOM). Inside the filter bar the wrapper's
              own context caps it, which is fine — the table stays <= z-20. */}
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <span className="absolute right-0 top-full z-40 mt-1.5 block w-80 rounded-lg border border-border bg-surface/95 p-3 text-left text-xs leading-relaxed text-text/90 shadow-lg backdrop-blur-md animate-settle">
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
          </span>
        </>
      )}
    </span>
  );
}
