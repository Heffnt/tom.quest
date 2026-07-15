"use client";

// app/boolback/components/filter-bar.tsx — THE top bar, slimmed (Phase 2). It
// is now pure chrome: no filters, no controls. Everything else moved into the
// right-docked config panel (components/config-panel.tsx). One row:
//
//   [» artifacts] [Table|Plot|Group Plot|Anatomy]  … (r/ρ readout on Plot) …
//   N of M runs · ● ↻ · rebuild note
//
// - `» artifacts` shows only while the tree pane is collapsed (the bar IS the
//   re-open affordance).
// - The view switcher, run count, snapshot status dot, and the ONE canonical
//   Refresh (↻ + rebuild note) are all that remain here. Filters / chips /
//   search / Export / Columns / Views / trend all live in the config panel.
// - The r/ρ readout published by the mounted plot (store.plotReadout) renders
//   here on the Plot view — a passive descriptive stat, not a control.

import type { Bundle } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import type { ArtifactSource } from "../data/source";
import { countSummary } from "../lib/select";
import type { CenterView } from "./table-pane";
import { relTime } from "../lib/format";

export interface FilterBarProps {
  visibleCount: number;
  totalCount: number;
  bundle: Bundle;
  view: CenterView;
  source: ArtifactSource; // status dot / freshness / Refresh
  /** Set while the tree pane is collapsed — renders the `» artifacts` re-open button. */
  onShowTree?: () => void;
}

const VIEW_LABEL: Record<CenterView, string> = {
  table: "Table", plot: "Plot", groupplot: "Group Plot", anatomy: "Anatomy",
};

export function FilterBar({
  visibleCount, totalCount, bundle, view, source, onShowTree,
}: FilterBarProps) {
  const setCenterView = useBoolbackStore((s) => s.setCenterView);
  const readout = useBoolbackStore((s) => s.plotReadout);
  const unionCount = useBoolbackStore((s) => s.plotUnionCount);

  // Plot-like views count their SETTINGS UNION (distinct runs — a run matching
  // several settings counts once), published by the mounted plot body. The
  // table keeps its own filtered count.
  const plotLike = view === "plot" || view === "groupplot";
  const shown = plotLike && unionCount !== null ? unionCount : visibleCount;

  return (
    <div className="sticky top-0 z-30 shrink-0 border-b border-border bg-surface/85 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        {onShowTree && (
          <button
            type="button"
            onClick={onShowTree}
            title="Show the artifact tree"
            aria-label="Show the artifact tree"
            className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
          >
            » artifacts
          </button>
        )}

        <div className="flex shrink-0 overflow-hidden rounded-md border border-border text-xs">
          {(["table", "plot", "groupplot", "anatomy"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setCenterView(v)}
              className={`px-2.5 py-0.5 transition-colors ${
                view === v ? "bg-accent/15 text-accent" : "bg-surface text-text-muted hover:text-text"
              }`}
            >
              {VIEW_LABEL[v]}
            </button>
          ))}
        </div>

        {/* descriptive r/ρ readout (Plot view only; published by the plot) */}
        {view === "plot" && readout &&
          (readout.r !== null || readout.binned || readout.droppedLog > 0 || readout.outsideWindow > 0) && (
          <span
            className="text-xs font-mono text-text-faint whitespace-nowrap"
            title={`Pearson r · Spearman ρ over the ${readout.runs.toLocaleString()} runs in the view window (descriptive) · ${readout.points.toLocaleString()} ${readout.averaging ? "groups" : "points"} drawn`}
          >
            {readout.r !== null && (
              <span className="text-text-muted">
                r {readout.r.toFixed(2)} · ρ {readout.rho === null ? "—" : readout.rho.toFixed(2)}
              </span>
            )}
            {readout.binned && <span title="X grouped into equal-width bins"> · x binned</span>}
            {readout.outsideWindow > 0 && <span title="points outside the axis view window (zoom only)"> · {readout.outsideWindow} outside window</span>}
            {readout.droppedLog > 0 && <span title="values ≤ 0 cannot be shown on a log axis"> · {readout.droppedLog} dropped (log)</span>}
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <span
            className="text-xs font-mono text-text-muted whitespace-nowrap"
            title={plotLike && unionCount !== null ? "distinct runs in the settings union" : undefined}
          >
            {countSummary(shown, totalCount)} runs
          </span>
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              source.status === "ready"
                ? "bg-success"
                : source.status === "loading"
                  ? "bg-warning animate-pulse"
                  : "bg-error"
            }`}
            title={`snapshot: ${source.status} · built ${relTime(bundle.meta.built_at)} from ${bundle.meta.source_dir}`}
          />
          <button
            type="button"
            onClick={source.refresh}
            title={
              source.canRebuild
                ? "Re-fetch the latest snapshot AND submit a rebuild on Turing (~2 min)"
                : "Re-fetch the latest snapshot"
            }
            className="shrink-0 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 transition-colors"
          >
            ↻
          </button>
          {source.rebuildNote && (
            <span className="shrink-0 text-[11px] text-text-faint whitespace-nowrap">
              {source.rebuildNote}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
