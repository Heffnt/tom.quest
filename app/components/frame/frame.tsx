"use client";

// The frame: every jarvis page is a center and up to four drawers, one per
// screen edge. frame.explainer.html beside this file is the ground-up account.
//
// A drawer is a body and a handle. The handle is the drawer's outer edge: shut,
// it lies flush against the screen edge; open, it rides the body's inner edge
// toward the center. Press it anywhere to pull the drawer out to its last size
// or, once open, to put it away; drag it to pull the drawer to any size. The
// four drawers are one component, parameterised only by their edge, so they
// look and behave alike.
//
// THE GEOMETRY IS globals.css's ([data-frame] and below). Everything is fixed
// to the viewport and a drawer only ever overlays the center, so the center
// never moves or resizes. Corners go top, then sides, then bottom, as in VS
// Code: the top spans the full width, the sides run from below the top
// handle to the bottom of the screen, and the bottom sits between the side
// handles. Where drawers overlap they stack the same way, and of the two
// sides the one opened last lies on top.
//
// The frame knows nothing about what the drawers hold. A page passes, per
// edge, a handle (a label, typed signals, typed buttons), a body, and
// optionally a default size and bounds, or null to leave that edge out. The
// site's own controls (home, page name, navigate, account) ride on the top
// handle the same way a page's buttons would.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useAuth } from "@/app/lib/auth";
import { Diagnostics } from "../debug-panel";
import type { ExplainerId } from "./explainer-registry.generated";
import { useFrameStore } from "./frame-store";
import RailSignals, { signalSignature, type RailSignal } from "./rail-signals";
import {
  CLICK_SLOP,
  DEFAULT_BOUNDS,
  DEFAULT_SIZE,
  EDGE_FOR_KEY,
  EDGES,
  clamp,
  dragSize,
  isTextTarget,
  pullDistance,
  releaseDrag,
  resolveBounds,
  topmostOpen,
  type Bounds,
  type Edge,
  type OpenState,
} from "./rules";
import { siteSlots, type HandleSlot } from "./site-bar";
import { HANDLE_PX, useFrameVariant, VariantPicker } from "./variants";

/** A button on a handle: an icon or a short word, and what pressing it does. It never opens or closes the drawer. */
type HandleAction = { label: string; icon?: ReactNode; onPress: () => void };

type EdgeSpec = {
  handle: { label: string; signals?: readonly RailSignal[]; actions?: readonly HandleAction[] };
  body: ReactNode;
  /** The size in pixels the drawer first opens at; later it opens at the size it was last left. */
  defaultSize?: number;
  bounds?: Bounds;
};

type Edges = Record<Edge, EdgeSpec | null>;

const EMPTY: OpenState = {};
const NO_SIGNALS: readonly RailSignal[] = [];
const NO_ACTIONS: readonly HandleAction[] = [];
const NO_SLOTS: readonly HandleSlot[] = [];

/** An open dialog owns Escape and the keyboard until it closes. */
function dialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** A control on a handle keeps its pointer, so pressing it never reaches the handle. */
const keepPointer = (e: React.PointerEvent) => e.stopPropagation();

function Slot({ slot }: { slot: HandleSlot }) {
  return (
    <span
      data-frame-handle-control={slot.control || undefined}
      onPointerDown={slot.control ? keepPointer : undefined}
      className="flex shrink-0 items-center"
    >
      {slot.node}
    </span>
  );
}

function useViewport(): { width: number; height: number } {
  const [vp, setVp] = useState({ width: 1440, height: 900 });
  useEffect(() => {
    const read = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return vp;
}

type Drag = { id: number; x: number; y: number; from: number; moved: boolean; raw: number };

function Drawer({
  edge,
  spec,
  start = NO_SLOTS,
  end = NO_SLOTS,
  open,
  size,
  bounds,
  raised,
  notch,
  onToggle,
  onRelease,
  register,
  children,
}: {
  edge: Edge;
  spec: EdgeSpec | null;
  start?: readonly HandleSlot[];
  end?: readonly HandleSlot[];
  open: boolean;
  /** The size it opens at, already clamped to its bounds. */
  size: number;
  bounds: { min: number; max: number };
  /** The side drawer opened last, which lies over the other. */
  raised: boolean;
  notch: boolean;
  onToggle: () => void;
  onRelease: (next: { open: boolean; size: number }) => void;
  register: (edge: Edge, el: HTMLElement | null) => void;
  children?: ReactNode;
}) {
  const el = useRef<HTMLElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const shown = open || dragging;

  // The size is written to the element, not rendered, so a drag can move it
  // every frame without a React render. It is written while the drawer is
  // open; a drawer shut by dragging keeps the size it was let go at until it
  // opens again, so it slides the rest of the way from there.
  const written = useRef(false);
  useLayoutEffect(() => {
    if (!el.current || dragging) return;
    if (open || !written.current) el.current.style.setProperty("--frame-s", `${size}px`);
    written.current = true;
  }, [open, size, dragging]);

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      el.current = node;
      register(edge, node);
    },
    [edge, register],
  );

  const end_ = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      if (!cancelled) onToggle();
      return;
    }
    const next = cancelled ? { open, size } : releaseDrag(d.raw, bounds);
    if (next.open || cancelled) el.current?.style.setProperty("--frame-s", `${next.open ? next.size : size}px`);
    flushSync(() => {
      setDragging(false);
      onRelease(next);
    });
  };

  const handleProps = spec
    ? {
        onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
          if (e.button !== 0 || drag.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: open ? size : 0, moved: false, raw: 0 };
        },
        onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved) {
            if (Math.hypot(dx, dy) < CLICK_SLOP) return;
            d.moved = true;
            flushSync(() => setDragging(true));
          }
          d.raw = d.from + pullDistance(edge, dx, dy);
          el.current?.style.setProperty("--frame-s", `${dragSize(d.raw, bounds)}px`);
        },
        onPointerUp: (e: React.PointerEvent) => end_(e, false),
        onPointerCancel: (e: React.PointerEvent) => end_(e, true),
      }
    : {};

  const signals = spec?.handle.signals ?? NO_SIGNALS;
  const actions = spec?.handle.actions ?? NO_ACTIONS;
  const vertical = edge === "left" || edge === "right";

  return (
    <section
      ref={setRef}
      data-frame-drawer={edge}
      data-open={shown}
      data-dragging={dragging}
      data-raised={raised}
      style={{ "--frame-min": `${bounds.min}px` } as React.CSSProperties}
      aria-label={spec?.handle.label}
    >
      <div
        id={`frame-drawer-${edge}`}
        data-frame-drawer-body
        aria-hidden={!shown}
        inert={!shown}
        tabIndex={-1}
        className="flex min-h-0 min-w-0 flex-1 flex-col outline-none sm:flex-row"
      >
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{spec?.body}</div>
        {children}
      </div>
      <div
        data-frame-handle={edge}
        data-frame-handle-orient={vertical ? "vertical" : "horizontal"}
        data-inert-handle={spec ? undefined : true}
        {...handleProps}
      >
        {start.map((slot) => (
          <Slot key={slot.key} slot={slot} />
        ))}
        {start.length > 0 && spec && <span data-frame-handle-sep aria-hidden />}
        {spec && (
          <span data-frame-handle-line>
            {notch && (
              <span role="img" aria-label="changed since last closed" data-frame-notch className="h-2.5 w-0.5 shrink-0 rounded-full bg-accent" />
            )}
            <button
              type="button"
              data-frame-handle-label
              aria-expanded={open}
              aria-controls={`frame-drawer-${edge}`}
              // No focus from a pointer press, so no focus ring is left on
              // the handle; Tab still reaches it.
              onMouseDown={(e) => e.preventDefault()}
              // A pointer press is the handle's (pointerup above); this is the keyboard's.
              onClick={(e) => {
                if (e.detail === 0) onToggle();
              }}
            >
              {spec.handle.label}
            </button>
            <span data-frame-handle-signals>
              <RailSignals signals={signals} />
            </span>
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                data-frame-handle-control
                aria-label={a.label}
                onPointerDown={keepPointer}
                onClick={a.onPress}
                className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-control px-1 text-[12px] text-text-muted hover:bg-surface-alt hover:text-text"
              >
                {a.icon ?? a.label}
              </button>
            ))}
          </span>
        )}
        <span data-frame-handle-fill aria-hidden />
        {end.map((slot) => (
          <Slot key={slot.key} slot={slot} />
        ))}
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
  /** The key the drawers' state is stored under. */
  page: string;
  title: string;
  explainer: ExplainerId;
  /** One line of state with counts, shown after the page name. */
  state?: string;
  center: ReactNode;
} & Edges) {
  const { isTom } = useAuth();
  const variant = useFrameVariant();
  const handlePx = HANDLE_PX[variant];
  const vp = useViewport();
  const edges: Edges = useMemo(() => ({ top, bottom, left, right }), [top, bottom, left, right]);
  const open = useFrameStore((s) => s.open[page]) ?? EMPTY;
  const stored = useFrameStore((s) => s.size[page]);
  const lastSide = useFrameStore((s) => s.lastSide[page]) ?? "right";
  const seen = useFrameStore((s) => s.seen[page]);
  const setOpen = useFrameStore((s) => s.setOpen);
  const markSeen = useFrameStore((s) => s.markSeen);
  const drawerEls = useRef<Partial<Record<Edge, HTMLElement | null>>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const register = useCallback((edge: Edge, el: HTMLElement | null) => {
    drawerEls.current[edge] = el;
  }, []);

  // The stored state is read after the first render (frame-store.ts), and
  // transitions stay off until it has been, so a restored drawer is simply
  // open rather than sliding in on load.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let frame = 0;
    void Promise.resolve(useFrameStore.persist.rehydrate()).then(() => {
      frame = requestAnimationFrame(() => setHydrated(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const bounds = useMemo(() => {
    const out = {} as Record<Edge, { min: number; max: number }>;
    for (const edge of EDGES) {
      const axis = edge === "left" || edge === "right" ? vp.width : vp.height;
      out[edge] = resolveBounds(edges[edge]?.bounds ?? DEFAULT_BOUNDS, axis, handlePx);
    }
    return out;
  }, [edges, vp, handlePx]);
  const sizeOf = (edge: Edge) => clamp(stored?.[edge] ?? edges[edge]?.defaultSize ?? DEFAULT_SIZE, bounds[edge]);

  const setEdge = useCallback(
    (edge: Edge, want: boolean, size?: number) => {
      const spec = edges[edge];
      if (!spec) return;
      const was = !!(useFrameStore.getState().open[page] ?? EMPTY)[edge];
      if (was && !want) markSeen(page, edge, signalSignature(spec.handle.signals ?? NO_SIGNALS));
      setOpen(page, edge, want, size);
    },
    [page, edges, markSeen, setOpen],
  );

  // W A S D toggle the drawers, Shift with the key opens one and moves focus
  // into it, "/" focuses navigate, Escape closes the topmost open drawer. None
  // of it fires while a text field has focus or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextTarget(e.target) || dialogOpen()) return;
      const state = useFrameStore.getState();
      const current = state.open[page] ?? EMPTY;
      if (e.key === "Escape") {
        const edge = topmostOpen(current, state.lastSide[page] ?? "right");
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
      if (!edge || !edges[edge]) return;
      e.preventDefault();
      if (e.shiftKey) {
        setEdge(edge, true);
        drawerEls.current[edge]?.querySelector<HTMLElement>("[data-frame-drawer-body]")?.focus({ preventScroll: true });
      } else {
        setEdge(edge, !current[edge]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, edges, setEdge]);

  const notch = (edge: Edge) => {
    const was = seen?.[edge];
    const spec = edges[edge];
    if (!spec || open[edge] || was === undefined) return false;
    return was !== signalSignature(spec.handle.signals ?? NO_SIGNALS);
  };

  const site = siteSlots({
    title,
    explainer,
    state,
    picker: <VariantPicker />,
    isTom,
    onDiagnostics: () => setEdge("bottom", true),
  });
  const slots: Partial<Record<Edge, { start: readonly HandleSlot[]; end: readonly HandleSlot[] }>> = { top: site };

  // An edge is present when it has a drawer or carries the site's controls;
  // the center is inset by a handle's thickness on each present edge.
  const present = (edge: Edge) => edges[edge] !== null || slots[edge] !== undefined;
  const inset = (edge: Edge) => (present(edge) ? `${handlePx}px` : "0px");

  return (
    <div
      ref={rootRef}
      data-frame={page}
      data-frame-variant={variant}
      data-hydrated={hydrated}
      style={
        {
          "--frame-handle": `${handlePx}px`,
          "--frame-inset-top": inset("top"),
          "--frame-inset-bottom": inset("bottom"),
          "--frame-inset-left": inset("left"),
          "--frame-inset-right": inset("right"),
        } as React.CSSProperties
      }
    >
      <div data-frame-center>{center}</div>
      {EDGES.filter(present).map((edge) => (
        <Drawer
          key={edge}
          edge={edge}
          spec={edges[edge]}
          start={slots[edge]?.start}
          end={slots[edge]?.end}
          open={!!open[edge] && edges[edge] !== null}
          size={sizeOf(edge)}
          bounds={bounds[edge]}
          raised={edge === lastSide}
          notch={notch(edge)}
          onToggle={() => setEdge(edge, !(useFrameStore.getState().open[page] ?? EMPTY)[edge])}
          onRelease={(next) => setEdge(edge, next.open, next.open ? next.size : undefined)}
          register={register}
        >
          {edge === "bottom" && isTom && (
            <aside
              aria-label="Diagnostics"
              className="max-h-[45%] shrink-0 overflow-auto border-t border-border p-3 sm:max-h-none sm:w-80 sm:border-l sm:border-t-0"
            >
              <Diagnostics />
            </aside>
          )}
        </Drawer>
      ))}
    </div>
  );
}
