"use client";

// The frame: every jarvis page is a center and four drawers inside a ring of
// rails. The center holds the whole set as one figure; the top drawer holds
// scope (a time window, a calendar, filters), the left an index (full lists),
// the right one thing whole (the selected item), the bottom the raw record
// (the event stream, row JSON, diagnostics). frame.explainer.html beside this
// file is the ground-up account.
//
// THE GEOMETRY IS globals.css's ([data-frame] and below). Everything is fixed
// to the viewport and a drawer only ever overlays the center, so opening one
// never moves the center by a pixel. Drawers stack by edge, never by the order
// they opened: right over left over bottom over top, rails over all of them.
//
// A page passes data, not layout: a title, the center, and per drawer a title,
// an optional explainer, typed rail signals and a body. It sets no position,
// no z-index and no colour of its own.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/app/lib/auth";
import { Diagnostics, useDiagnosticsStatus } from "../debug-panel";
import type { ExplainerId } from "./explainer-registry.generated";
import { useFrameStore } from "./frame-store";
import Info from "./info";
import { EDGE_FOR_KEY, isTextTarget, nextOpenState, topmostOpen, type Edge, type OpenState } from "./rules";
import RailSignals, { signalSignature, type RailSignal } from "./rail-signals";
import SiteBar from "./site-bar";

type DrawerSpec = {
  title: string;
  /** What a side rail reads while the drawer is closed, when not its title (the selected item's name). */
  label?: string;
  explainer?: ExplainerId;
  signals?: readonly RailSignal[];
  body: ReactNode;
};

type Drawers = Record<Edge, DrawerSpec>;

const EMPTY: OpenState = {};
const NO_SIGNALS: readonly RailSignal[] = [];

/** An open dialog owns Escape and the keyboard until it closes. */
function dialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

function Notch() {
  return <span role="img" aria-label="changed since last closed" data-frame-notch className="h-2.5 w-0.5 shrink-0 rounded-full bg-accent" />;
}

/**
 * A horizontal rail's toggle: the drawer's title and its signals. The phone's
 * bottom bar holds three of these, one per drawer, and each keeps its whole
 * title: the title never shrinks, the signals clip first.
 */
function RailToggle({
  edge,
  spec,
  open,
  notch,
  onToggle,
  className = "",
}: {
  edge: Edge;
  spec: DrawerSpec;
  open: boolean;
  notch: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-frame-toggle={edge}
      aria-expanded={open}
      aria-controls={`frame-drawer-${edge}`}
      onClick={onToggle}
      className={`flex min-w-0 items-center gap-1.5 px-2 text-[12px] text-text-muted hover:bg-surface-alt hover:text-text ${className}`}
    >
      {notch && <Notch />}
      <span data-frame-rail-label className="shrink-0 whitespace-nowrap">
        {spec.title}
      </span>
      <span data-frame-rail-signals className="flex min-w-0 items-center gap-1.5 overflow-hidden">
        <RailSignals signals={spec.signals ?? NO_SIGNALS} />
      </span>
    </button>
  );
}

function SideRail({
  edge,
  spec,
  open,
  notch,
  onToggle,
}: {
  edge: "left" | "right";
  spec: DrawerSpec;
  open: boolean;
  notch: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-frame-rail={edge}
      data-frame-toggle={edge}
      data-open={open}
      aria-expanded={open}
      aria-controls={`frame-drawer-${edge}`}
      onClick={onToggle}
      className="flex flex-col items-center py-2 text-[12px] text-text-muted hover:bg-surface-alt hover:text-text"
    >
      {/* The rail's one line: its layout (rotated, stacked, a tab, a handle)
          is globals.css's, so every rail carries the same parts. */}
      <span data-frame-rail-tab>
        {notch && <Notch />}
        <span data-frame-rail-label>{spec.label ?? spec.title}</span>
        <span data-frame-rail-signals>
          <RailSignals signals={spec.signals ?? NO_SIGNALS} />
        </span>
      </span>
    </button>
  );
}

/** The Tom-only dot in the bottom-right corner: Convex's connection and any captured console error. */
function DiagnosticsDot({ onOpen }: { onOpen: () => void }) {
  const { convex, events } = useDiagnosticsStatus();
  const errors = events.filter((e) => e.level === "error").length;
  const tone = convex === "disconnected" ? "bg-error" : errors > 0 ? "bg-warning" : "bg-success";
  return (
    <button
      type="button"
      data-frame-diagnostics
      onClick={onOpen}
      aria-label={`Diagnostics: Convex ${convex}, ${errors} console errors`}
      className="flex w-10 shrink-0 items-center justify-center hover:bg-surface-alt sm:w-(--frame-corner)"
    >
      <span className={`h-2 w-2 rounded-full ${tone}`} />
    </button>
  );
}

function Drawer({
  edge,
  spec,
  open,
  onClose,
  drawerRef,
  children,
}: {
  edge: Edge;
  spec: DrawerSpec;
  open: boolean;
  onClose: () => void;
  drawerRef: (el: HTMLElement | null) => void;
  children?: ReactNode;
}) {
  return (
    <section
      id={`frame-drawer-${edge}`}
      ref={drawerRef}
      data-frame-drawer={edge}
      data-open={open}
      aria-label={spec.title}
      aria-hidden={!open}
      inert={!open}
      tabIndex={-1}
      className="outline-none"
    >
      <header className="flex h-row shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="truncate text-[13px] font-semibold text-text">{spec.title}</h2>
        {spec.explainer && <Info explainer={spec.explainer} />}
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${spec.title}`}
          className="flex h-6 w-6 items-center justify-center rounded-control text-[15px] text-text-muted hover:bg-surface-alt hover:text-text"
        >
          ×
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{spec.body}</div>
        {children}
      </div>
    </section>
  );
}

export default function Frame({
  page,
  title,
  explainer,
  state,
  center,
  top,
  bottom,
  left,
  right,
}: {
  /** The key the open drawers are stored under. */
  page: string;
  title: string;
  explainer: ExplainerId;
  /** One line of state with counts, shown after the page name. */
  state?: string;
  center: ReactNode;
} & Drawers) {
  const { isTom } = useAuth();
  const drawers: Drawers = useMemo(() => ({ top, bottom, left, right }), [top, bottom, left, right]);
  const open = useFrameStore((s) => s.open[page]) ?? EMPTY;
  const seen = useFrameStore((s) => s.seen[page]);
  const setOpenState = useFrameStore((s) => s.setOpen);
  const markSeen = useFrameStore((s) => s.markSeen);
  const drawerEls = useRef<Partial<Record<Edge, HTMLElement | null>>>({});
  const rootRef = useRef<HTMLDivElement>(null);

  // The stored open state is read after the first render (frame-store.ts),
  // and transitions stay off until it has been, so a restored drawer is
  // simply open rather than sliding in on load.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let frame = 0;
    void Promise.resolve(useFrameStore.persist.rehydrate()).then(() => {
      frame = requestAnimationFrame(() => setHydrated(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const setEdge = useCallback(
    (edge: Edge, want: boolean) => {
      const current = useFrameStore.getState().open[page] ?? EMPTY;
      const railSide = drawerEls.current.left?.offsetLeft ?? 0;
      const next = nextOpenState(current, edge, want, {
        width: window.innerWidth,
        railSide,
        leftWidth: drawerEls.current.left?.offsetWidth ?? 0,
        rightWidth: drawerEls.current.right?.offsetWidth ?? 0,
      });
      for (const e of Object.keys(drawers) as Edge[]) {
        if (current[e] && !next[e]) markSeen(page, e, signalSignature(drawers[e].signals ?? NO_SIGNALS));
      }
      setOpenState(page, next);
    },
    [page, drawers, markSeen, setOpenState],
  );

  const toggle = useCallback((edge: Edge) => setEdge(edge, !open[edge]), [open, setEdge]);

  // W A S D toggle the drawers, Shift with the key opens one and moves focus
  // into it, "/" focuses navigate, Escape closes the topmost open drawer. None
  // of it fires while a text field has focus or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextTarget(e.target) || dialogOpen()) return;
      if (e.key === "Escape") {
        const edge = topmostOpen(useFrameStore.getState().open[page] ?? EMPTY);
        if (!edge) return;
        e.preventDefault();
        setEdge(edge, false);
        return;
      }
      if (e.key === "/") {
        const nav = rootRef.current?.querySelector<HTMLInputElement>("[data-frame-navigate]");
        if (!nav || nav.offsetParent === null) return;
        e.preventDefault();
        nav.focus();
        return;
      }
      const edge = EDGE_FOR_KEY[e.key.toLowerCase()];
      if (!edge) return;
      e.preventDefault();
      if (e.shiftKey) {
        setEdge(edge, true);
        drawerEls.current[edge]?.focus({ preventScroll: true });
      } else {
        setEdge(edge, !(useFrameStore.getState().open[page] ?? EMPTY)[edge]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, setEdge]);

  const notch = (edge: Edge) => {
    const stored = seen?.[edge];
    if (open[edge] || stored === undefined) return false;
    return stored !== signalSignature(drawers[edge].signals ?? NO_SIGNALS);
  };
  const anyOpen = (Object.keys(drawers) as Edge[]).some((e) => open[e]);
  const refFor = (edge: Edge) => (el: HTMLElement | null) => {
    drawerEls.current[edge] = el;
  };
  const railToggle = (edge: Edge, className?: string) => (
    <RailToggle
      edge={edge}
      spec={drawers[edge]}
      open={!!open[edge]}
      notch={notch(edge)}
      onToggle={() => toggle(edge)}
      className={className}
    />
  );

  return (
    <div ref={rootRef} data-frame={page} data-hydrated={hydrated}>
      <div data-frame-center>{center}</div>

      {anyOpen && <button type="button" aria-label="Close drawers" data-frame-scrim onClick={() => setOpenState(page, {})} />}

      <Drawer edge="top" spec={top} open={!!open.top} onClose={() => setEdge("top", false)} drawerRef={refFor("top")} />
      <Drawer edge="bottom" spec={bottom} open={!!open.bottom} onClose={() => setEdge("bottom", false)} drawerRef={refFor("bottom")}>
        {isTom && (
          <aside
            aria-label="Diagnostics"
            className="max-h-[45%] shrink-0 overflow-auto border-t border-border p-3 sm:max-h-none sm:w-80 sm:border-l sm:border-t-0"
          >
            <Diagnostics />
          </aside>
        )}
      </Drawer>
      <Drawer edge="left" spec={left} open={!!open.left} onClose={() => setEdge("left", false)} drawerRef={refFor("left")} />
      <Drawer edge="right" spec={right} open={!!open.right} onClose={() => setEdge("right", false)} drawerRef={refFor("right")} />

      <header data-frame-rail="top" data-open={!!open.top}>
        <SiteBar title={title} explainer={explainer} state={state} topToggle={railToggle("top", "flex-1")} />
      </header>
      <div data-frame-rail="bottom" data-open={!!open.bottom} className="flex items-stretch">
        <span aria-hidden className="hidden w-(--frame-rail-side) shrink-0 sm:block" />
        {railToggle("left", "flex-auto justify-center border-r border-border sm:hidden")}
        {railToggle("bottom", "flex-auto justify-center sm:justify-start")}
        {railToggle("right", "flex-auto justify-center border-l border-border sm:hidden")}
        {isTom && <DiagnosticsDot onOpen={() => setEdge("bottom", true)} />}
      </div>
      <SideRail edge="left" spec={left} open={!!open.left} notch={notch("left")} onToggle={() => toggle("left")} />
      <SideRail edge="right" spec={right} open={!!open.right} notch={notch("right")} onToggle={() => toggle("right")} />
    </div>
  );
}
