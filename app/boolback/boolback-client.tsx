"use client";

// app/boolback/boolback-client.tsx
//
// Root client component for /boolback. Lays out a three-zone shell:
//   CommandBar (breadcrumb + artifact-dir picker)
//   [ TreePane | divider | TablePane | DetailPanel ]
//
// The bundle is loaded from the chosen artifact-tree ROOT via useArtifactSource
// (admin-gated turing-api proxies). The table is the ONLY center view — there is
// no DAG, no tab switcher, no synthetic demo fixture. The detail panel docks on
// the right and opens only via a Details button. Tree + detail widths persist
// via usePersistedSettings.

import { useCallback, useEffect, useRef, useState } from "react";
import { useArtifactSource } from "./data/source";
import { useBoolbackStore } from "./state/store";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { CommandBar } from "./components/command-bar";
import { TreePane } from "./components/tree-pane";
import { TablePane } from "./components/table-pane";
import { DetailPanel } from "./components/detail-panel";

// Layout constants.
const MIN_LEFT = 280; // px, left tree pane floor
const MIN_CENTER = 360; // px, center table floor
const DEFAULT_LEFT = 360;

interface LayoutSettings extends Record<string, unknown> {
  leftW: number;
  detailWidth: number;
}

const LAYOUT_DEFAULTS: LayoutSettings = { leftW: DEFAULT_LEFT, detailWidth: 480 };

export default function BoolbackClient() {
  const source = useArtifactSource();
  const bundle = source.bundle;

  // ----- persisted layout (tree width + detail width) ----------------------
  const [layout, updateLayout, layoutHydrated] = usePersistedSettings<LayoutSettings>(
    "boolback:layout",
    LAYOUT_DEFAULTS,
  );

  const [leftW, setLeftW] = useState<number>(DEFAULT_LEFT);
  const setDetailWidth = useBoolbackStore((s) => s.setDetailWidth);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (layoutHydrated && !hydratedRef.current) {
      hydratedRef.current = true;
      setLeftW(clampLeft(layout.leftW, window.innerWidth));
      if (typeof layout.detailWidth === "number") setDetailWidth(layout.detailWidth);
    }
  }, [layoutHydrated, layout.leftW, layout.detailWidth, setDetailWidth]);

  // mirror the live store detailWidth into persisted layout when it commits
  const detailWidth = useBoolbackStore((s) => s.detailWidth);
  useEffect(() => {
    if (!hydratedRef.current) return;
    updateLayout({ detailWidth });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailWidth]);

  // ----- tree divider drag -------------------------------------------------
  const dragging = useRef(false);
  const onDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);
  const onDividerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    setLeftW(clampLeft(e.clientX, window.innerWidth));
  }, []);
  const onDividerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      updateLayout({ leftW });
    },
    [updateLayout, leftW],
  );

  // ----- pre-bundle states (loading / empty / error / idle) ---------------
  if (!bundle) {
    return (
      <div className="h-[calc(100vh-4rem)] flex flex-col bg-bg text-text">
        <CommandBar source={source} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          {source.status === "loading" ? (
            <>
              <div className="h-6 w-6 rounded-full border-2 border-border border-t-accent animate-spin" />
              <div className="font-mono text-sm text-text-muted">Loading snapshot…</div>
            </>
          ) : source.status === "error" ? (
            <div className="font-mono text-sm text-warning max-w-md text-center">
              {source.statusDetail ?? "snapshot error"}
            </div>
          ) : source.status === "empty" ? (
            <div className="font-mono text-sm text-text-muted max-w-md text-center">
              No snapshot has been built for this directory yet.
              {source.canRebuild
                ? " Click ↻ Refresh to build one (runs on a compute node)."
                : " A periodic build will produce one shortly."}
            </div>
          ) : (
            <div className="font-mono text-sm text-text-muted text-center">
              Choose an artifact-tree root from the picker to load a snapshot.
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-bg text-text">
      <CommandBar source={source} />
      <div className="flex-1 flex min-h-0">
        {/* left: tree */}
        <div
          style={{ width: leftW }}
          className="border-r border-border bg-surface/40 shrink-0 min-h-0"
        >
          <TreePane bundle={bundle} />
        </div>
        {/* tree | table divider */}
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 transition-colors"
        />
        {/* center: table (only view) */}
        <div className="flex-1 min-w-0 relative">
          <TablePane bundle={bundle} />
        </div>
        {/* right: detail panel (self-resizing; renders null when closed) */}
        <DetailPanel bundle={bundle} />
      </div>
    </div>
  );
}

// Clamp the left pane width so neither the tree nor the center collapses.
function clampLeft(px: number, viewport: number): number {
  const max = Math.max(MIN_LEFT, viewport - MIN_CENTER);
  return Math.round(Math.min(Math.max(px, MIN_LEFT), max));
}
