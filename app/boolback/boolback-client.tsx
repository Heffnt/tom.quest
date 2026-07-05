"use client";

// app/boolback/boolback-client.tsx
//
// Root client component for /boolback. Lays out a one-strip shell (there is
// no separate command bar — the view switcher, share link, freshness and
// Refresh live in the single top bar inside TablePane, components/filter-bar):
//   [ TreePane (dir viewer) | divider | TablePane or ChartBody | DetailPanel ]
//
// ONE fetch loads the whole bundle (useArtifactSource; dir pinned to
// "artifacts", ?dir= overrides). The center is either the run table or the
// explore chart — switched, never stacked — under the same filter bar. The
// detail panel docks on the right and opens from any row/point click (or a
// Details button). Tree + detail widths persist via usePersistedSettings,
// as does the tree's collapsed state — remembered PER center view (chart
// defaults collapsed: the plot wants the width, the table wants the tree).

import { useCallback, useEffect, useRef, useState } from "react";
import { useArtifactSource } from "./data/source";
import { useBoolbackStore } from "./state/store";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { readSharedView } from "./lib/share";
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
  /** Tree pane collapsed to the slim rail, remembered PER center view. */
  treeCollapsed: { table: boolean; chart: boolean };
}

const LAYOUT_DEFAULTS: LayoutSettings = {
  leftW: DEFAULT_LEFT,
  detailWidth: 480,
  // The chart wants every horizontal pixel; the table leans on the tree.
  treeCollapsed: { table: false, chart: true },
};

export default function BoolbackClient() {
  const source = useArtifactSource();
  const bundle = source.bundle;
  const view = useBoolbackStore((s) => s.centerView);
  const setCenterView = useBoolbackStore((s) => s.setCenterView);

  // A ?v= share URL can name the center view; filters/sorts/columns/chart are
  // applied by table-pane's hydration (which prefers the shared view too).
  useEffect(() => {
    const shared = readSharedView();
    if (shared?.view === "table" || shared?.view === "chart") setCenterView(shared.view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ----- tree collapse (per center view; chart defaults collapsed) ---------
  const treeCollapsed =
    layout.treeCollapsed?.[view] ?? LAYOUT_DEFAULTS.treeCollapsed[view];
  const setTreeCollapsed = useCallback(
    (collapsed: boolean) => {
      updateLayout({
        treeCollapsed: {
          ...LAYOUT_DEFAULTS.treeCollapsed,
          ...layout.treeCollapsed,
          [view]: collapsed,
        },
      });
    },
    [updateLayout, layout.treeCollapsed, view],
  );

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

  // ----- pre-bundle states (loading / empty / error) -----------------------
  // No command bar exists anymore, so these render standalone (with their own
  // Refresh — the in-bar one only mounts once a bundle is up).
  if (!bundle) {
    return (
      <div className="h-[calc(100vh-4rem)] flex flex-col items-center justify-center gap-3 bg-bg text-text">
        {source.status === "loading" ? (
          <>
            <div className="h-6 w-6 rounded-full border-2 border-border border-t-accent animate-spin" />
            <div className="font-mono text-sm text-text-muted">Loading snapshot…</div>
          </>
        ) : (
          <>
            {source.status === "empty" ? (
              <div className="font-mono text-sm text-text-muted max-w-md text-center">
                No snapshot has been built for “{source.dir}” yet.
                {source.canRebuild
                  ? " Click ↻ Refresh to build one (runs on a compute node, ~2 min)."
                  : " A periodic build will produce one shortly."}
              </div>
            ) : (
              <div className="font-mono text-sm text-warning max-w-md text-center">
                {source.statusDetail ?? "snapshot error"}
              </div>
            )}
            <button
              type="button"
              onClick={source.refresh}
              className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-muted hover:text-text hover:border-accent/40 transition-colors"
            >
              ↻ Refresh
            </button>
            {source.rebuildNote && (
              <span className="text-[11px] text-text-faint">{source.rebuildNote}</span>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-bg text-text">
      {/* Fallback banner: the bundle on screen is NOT live data (Turing/proxy
          unreachable — see data/source.ts fallback chain). The page still
          works; this strip says what it's showing and why. */}
      {source.origin !== "live" && (
        <div className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1 font-mono text-xs text-warning">
          <span className="truncate">
            {source.origin === "cache"
              ? `Turing unreachable — showing the last snapshot this browser fetched (built ${new Date(bundle.meta.built_at).toLocaleString()})`
              : "Turing unreachable — showing bundled sample data (not real runs)"}
            {source.statusDetail ? ` · ${source.statusDetail}` : ""}
          </span>
          <button
            type="button"
            onClick={source.refresh}
            className="ml-auto shrink-0 rounded border border-warning/40 px-1.5 py-0.5 hover:bg-warning/20 transition-colors"
          >
            ↻ Retry
          </button>
        </div>
      )}
      <div className="flex-1 flex min-h-0">
        {/* left: dir viewer. Collapsed: NO rail — the top bar inside TablePane
            carries the header-height `» artifacts` re-open button instead. */}
        {!treeCollapsed && (
          <>
            <div
              style={{ width: leftW }}
              className="border-r border-border bg-surface/40 shrink-0 min-h-0"
            >
              <TreePane bundle={bundle} onCollapse={() => setTreeCollapsed(true)} />
            </div>
            {/* tree | center divider */}
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 transition-colors"
            />
          </>
        )}
        {/* center: table OR chart (same top bar) */}
        <div className="flex-1 min-w-0 relative">
          <TablePane
            bundle={bundle}
            view={view}
            source={source}
            onShowTree={treeCollapsed ? () => setTreeCollapsed(false) : undefined}
          />
        </div>
        {/* right: detail panel (self-resizing; renders null when closed) */}
        <DetailPanel bundle={bundle} dir={source.dir} />
      </div>
    </div>
  );
}

// Clamp the left pane width so neither the tree nor the center collapses.
function clampLeft(px: number, viewport: number): number {
  const max = Math.max(MIN_LEFT, viewport - MIN_CENTER);
  return Math.round(Math.min(Math.max(px, MIN_LEFT), max));
}
