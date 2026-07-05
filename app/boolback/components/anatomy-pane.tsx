"use client";

// app/boolback/components/anatomy-pane.tsx — the Anatomy center view.
//
// Third center view alongside Table|Chart (ANATOMY-SPEC.md): one unified
// picture of WHERE in the model each interp measurement sits and how it
// performs — residual-stream bar on top, function-false twin mirrored below,
// contrast strip between, accordion depth axis with pinned ends. It renders
// the SAME filtered row set as the other views (the filter bar stays above
// all three); config (accordion focus weights, twin toggle, selection) is
// store-owned AnatomyConfig so the share encoder and the persisted-view blob
// can reach it, exactly like ChartConfig.
//
// CURRENT STATE: plumbing stub. The pane mounts, sizes itself with the
// chart's ResizeObserver pattern (viewBox tracks the container 1:1 so
// 1 viewBox unit = 1 CSS px), and draws a placeholder residual bar — the
// real spine (lib/anatomy.ts scale engine, LOD ladder, markers, arcs) lands
// in the follow-up pass. The root div carries data-anatomy-ready once rows
// have rendered; the screenshot harness waits on it.
//
// Pure SVG — no chart library. Chrome colors are CSS variables only
// (dark mode is variable-driven; never branch on theme).

import { useEffect, useRef, useState } from "react";
import type { Bundle, RunRow } from "../lib/types";
import type { MetricIndex } from "../lib/select";

// Geometry: the SVG viewBox tracks the plot container 1:1 (ResizeObserver;
// 1 viewBox unit = 1 CSS px) — same idiom as chart-panel.tsx. FALLBACK
// covers the first pre-measure render only.
const FALLBACK = { w: 820, h: 430 };
const PAD = { l: 16, r: 16 }; // placeholder bar inset from the pane edges
const BAR_H = 18; // placeholder residual-bar height

export function AnatomyBody({
  rows,
}: {
  rows: RunRow[]; // the filtered (+sorted) rows — anatomy, chart and table always agree
  bundle: Bundle;
  index: MetricIndex;
}) {
  // The SVG draws at the plot container's real pixel size (see FALLBACK note).
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(FALLBACK);
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || r.width < 80 || r.height < 80) return; // hidden/degenerate pane
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = size.w;
  const H = size.h;

  // Placeholder: the run band's residual bar sits in the top third (where the
  // real spine will live — run band top, twin band bottom, contrast between).
  const barY = Math.round(H / 3 - BAR_H / 2);

  return (
    <div
      className="flex-1 min-h-0 flex"
      data-anatomy-ready={rows.length > 0 ? "" : undefined}
    >
      <div ref={plotRef} className="relative flex-1 min-w-0 px-2 py-1">
        {rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-text-faint font-mono">
            No runs to dissect — every run is filtered out.
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            className="h-full w-full select-none"
            role="img"
            aria-label="anatomy view (placeholder)"
          >
            {/* placeholder residual bar — embed pinned left, unembed right */}
            <rect
              x={PAD.l}
              y={barY}
              width={W - PAD.l - PAD.r}
              height={BAR_H}
              rx={2}
              fill="var(--color-surface-alt)"
              stroke="var(--color-border)"
              strokeWidth={1}
            />
            <text
              x={W / 2}
              y={H / 2}
              fontSize={12}
              textAnchor="middle"
              fill="var(--color-text-muted)"
              className="font-mono"
            >
              anatomy — spine coming
            </text>
          </svg>
        )}
      </div>
    </div>
  );
}
