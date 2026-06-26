"use client";

// app/boolback/boolback-client.tsx
//
// Root client component for /boolback. Builds the immutable fixture ONCE
// (useMemo over the module-memoized getFixture) and passes it DOWN as a prop to
// every pane — the zustand store carries only UI state. Lays out a full-bleed
// three-zone shell: CommandBar on top, a resizable [TreePane | tab-host] body,
// and a bottom DetailDrawer when a node is selected.
//
// Pure React + Tailwind; the only platform reads (window) happen inside effects
// (useViewportWidth) so there is no SSR hazard and NO next/dynamic is needed.

import { useCallback, useEffect, useRef, useState } from "react";
import { getFixture, setActiveBundle, type FixtureBundle } from "./data/fixture";
import { loadRealBundle, getSnapshotMeta, type SnapshotMeta } from "./data/real";
import { useBoolbackStore } from "./state/store";
import { useViewportWidth } from "./lib/use-viewport";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { CommandBar } from "./components/command-bar";
import { TreePane } from "./components/tree-pane";
import { DagPane } from "./components/dag-pane";
import { TablePane } from "./components/table-pane";
import { DetailDrawer } from "./components/detail-drawer";

// Data source: the real bundled turing snapshot (default) or the synthetic demo
// fixture. Lives in this component's React state and is passed DOWN — the store
// carries only ephemeral view state.
export type DataSource = "real" | "demo";

// Layout constants.
const MIN_LEFT = 320; // px, left tree pane floor
const MIN_RIGHT = 360; // px, center tab-host floor
const DEFAULT_LEFT = 380; // px, ~30% of a typical workbench width
const COLLAPSE_PX = 1100; // below this, collapse to a single-pane tab switcher

interface LayoutSettings extends Record<string, unknown> {
  leftW: number;
}

const LAYOUT_DEFAULTS: LayoutSettings = { leftW: DEFAULT_LEFT };

// Single-pane mobile/narrow chooser. Tree is its own "tab" alongside DAG/Table.
type MobilePane = "tree" | "dag" | "table";

export default function BoolbackClient() {
  const vw = useViewportWidth();
  const collapsed = vw < COLLAPSE_PX;

  // ----- data source + active bundle ---------------------------------------
  // Default to the REAL bundled turing snapshot; fall back to the synthetic demo
  // fixture on load failure (with a small non-blocking notice). The active
  // bundle also drives the module-level lookups via setActiveBundle so linked
  // selection / expandChain / drawer chains resolve against the right tree.
  const [source, setSource] = useState<DataSource>("real");
  const [bundle, setBundle] = useState<FixtureBundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<SnapshotMeta | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (source === "demo") {
      setActiveBundle(null);
      setBundle(getFixture());
      setMeta(null);
      setLoading(false);
      return;
    }
    // source === "real"
    setLoading(true);
    loadRealBundle()
      .then((b) => {
        if (cancelled) return;
        setActiveBundle(b);
        setBundle(b);
        setMeta(getSnapshotMeta());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[boolback] failed to load real snapshot", err);
        // graceful fallback: show the synthetic demo with a notice.
        setError("couldn't load real snapshot — showing demo");
        setActiveBundle(null);
        setBundle(getFixture());
        setMeta(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [source]);

  // Persisted pane width (localStorage immediately + Convex when logged in).
  const [layout, updateLayout, layoutHydrated] = usePersistedSettings<LayoutSettings>(
    "boolback:layout",
    LAYOUT_DEFAULTS,
  );

  // Live width is local state so dragging is smooth; we hydrate from + persist
  // to usePersistedSettings with the same one-way-hydrate guard the precedent
  // (use-persisted-settings) uses.
  const [leftW, setLeftW] = useState<number>(DEFAULT_LEFT);
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (layoutHydrated && !hydratedRef.current) {
      hydratedRef.current = true;
      setLeftW(clampLeft(layout.leftW, window.innerWidth));
    }
  }, [layoutHydrated, layout.leftW]);

  // Store slices (selector-consumed — never destructure the whole store).
  const activeTab = useBoolbackStore((s) => s.activeTab);
  const drawerOpen = useBoolbackStore((s) => s.drawerOpen);

  // Narrow-mode single visible pane. Tree is the default; the CommandBar's
  // DAG/Table toggle drives activeTab, and we surface a Tree button here.
  const [mobilePane, setMobilePane] = useState<MobilePane>("tree");
  // Keep the narrow pane in sync when the user toggles DAG/Table in the bar.
  useEffect(() => {
    if (collapsed) setMobilePane(activeTab);
  }, [collapsed, activeTab]);

  // ----- divider drag (wide layout only) -----------------------------------
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
      // Persist the final width once (debounced inside the hook).
      updateLayout({ leftW });
    },
    [updateLayout, leftW],
  );

  // ---------------------------------------------------------------------------
  // LOADING / EMPTY: while the (real) bundle resolves, hold the panes back and
  // show a centered dark-token loading state. The synthetic demo resolves
  // synchronously so this only ever shows for the real snapshot fetch.
  // ---------------------------------------------------------------------------
  if (!bundle || loading) {
    return (
      <div className="h-[calc(100vh-4rem)] flex flex-col items-center justify-center gap-3 bg-bg text-text">
        <div className="h-6 w-6 rounded-full border-2 border-border border-t-accent animate-spin" />
        <div className="font-mono text-sm text-text-muted">
          Loading real artifact tree from turing…
        </div>
      </div>
    );
  }

  const fixture = bundle;

  const centerPane =
    activeTab === "dag" ? <DagPane fixture={fixture} /> : <TablePane fixture={fixture} />;

  // ---------------------------------------------------------------------------
  // NARROW: single-pane tab switcher; drawer becomes a full-screen sheet.
  // ---------------------------------------------------------------------------
  if (collapsed) {
    return (
      <div className="relative h-[calc(100vh-4rem)] flex flex-col bg-bg text-text">
        <CommandBar fixture={fixture} source={source} onSourceChange={setSource} meta={meta} sourceError={error} />
        <div className="flex items-center gap-1 px-2 h-9 border-b border-border bg-surface/40 shrink-0">
          {(["tree", "dag", "table"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setMobilePane(p)}
              className={`px-3 h-6 rounded-md text-xs font-mono uppercase tracking-wide transition-colors ${
                mobilePane === p
                  ? "bg-surface-alt text-accent"
                  : "text-text-muted hover:text-text"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 relative">
          {mobilePane === "tree" ? (
            <div className="h-full overflow-y-auto bg-surface/40">
              <TreePane fixture={fixture} />
            </div>
          ) : (
            centerPane
          )}
        </div>
        {drawerOpen && (
          <div className="absolute inset-0 z-20 bg-bg">
            <DetailDrawer fixture={fixture} />
          </div>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // WIDE: co-equal [tree | divider | tab-host] body + bottom drawer.
  // ---------------------------------------------------------------------------
  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col bg-bg text-text">
      <CommandBar fixture={fixture} source={source} onSourceChange={setSource} meta={meta} sourceError={error} />
      <div className="flex-1 flex min-h-0">
        <div
          style={{ width: leftW }}
          className="border-r border-border bg-surface/40 overflow-y-auto shrink-0"
        >
          <TreePane fixture={fixture} />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onDividerDown}
          onPointerMove={onDividerMove}
          onPointerUp={onDividerUp}
          className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/30 transition-colors"
        />
        <div className="flex-1 min-w-0 relative">{centerPane}</div>
      </div>
      {drawerOpen && <DetailDrawer fixture={fixture} />}
    </div>
  );
}

// Clamp the left pane width so neither pane collapses past its floor.
function clampLeft(px: number, viewport: number): number {
  const max = Math.max(MIN_LEFT, viewport - MIN_RIGHT);
  return Math.round(Math.min(Math.max(px, MIN_LEFT), max));
}
