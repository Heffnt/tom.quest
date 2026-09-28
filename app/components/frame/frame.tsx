"use client";

// The frame: a page is a site header, a center and up to four drawers, one
// per screen edge. frame.explainer.html beside this file is the ground-up
// account.
//
// THE HEADER is a fixed bar across the full width at the top (site-header.tsx):
// the logo, the page name and its (i), navigate, the account. It is not a
// drawer. Everything else lies in the stage below it.
//
// A DRAWER is a body and a handle. The handle is the drawer's edge nearest the
// center: shut, only the handle shows, against the screen edge; open, the
// handle rides the body's inner edge. Press it anywhere to pull the drawer out
// to its last size or, once open, to put it away; drag it to pull the drawer
// to any size. The four drawers are one component, parameterised only by
// their edge, so they look and behave alike.
//
// DRAWERS NEVER COVER EACH OTHER. The side drawers run the full height of the
// stage. The top and bottom drawers, handles included, run between the side
// drawers' inner edges, so as a side drawer opens or is dragged they shrink
// with it and their content reflows. Two opposite drawers share their axis:
// the one being dragged, else the one opened last, has the room first, the
// other gives way down to its minimum, and past that the first stops; where
// the two minimums cannot both fit (a phone), opening one shuts the other.
// Drawers do lie over the center, which never moves or resizes.
//
// THE GEOMETRY IS WRITTEN, NOT RENDERED. Every drawer's box is computed by
// rules.ts (sharePair, drawerBox) and written straight to its element's
// style: on every pointer move of a drag, and on every animation frame of an
// open or a shut. No React render happens while a drawer moves, and nothing
// inside a drawer restyles; only the boxes whose size changes lay out again.
// No drawer carries a transform, a z-index or containment, so a fixed dialog
// rendered inside one covers the whole screen as it would anywhere else.
//
// The frame knows nothing about what the drawers hold. A page passes, per
// edge, a handle (a label, typed signals, typed buttons), a body, and
// optionally a default size and bounds, or null to leave that edge out.

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
  HANDLE_PX,
  HEADER_PX,
  OPPOSITE,
  clamp,
  dragSize,
  drawerBox,
  isTextTarget,
  nextToClose,
  pullDistance,
  releaseDrag,
  resolveBounds,
  sharePair,
  shared,
  type Bounds,
  type DrawerWish,
  type Edge,
  type OpenState,
} from "./rules";
import SiteHeader from "./site-header";

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

type Shown = Record<Edge, number>;

const EMPTY: OpenState = {};
const NO_SIGNALS: readonly RailSignal[] = [];
const NO_ACTIONS: readonly HandleAction[] = [];
const SHUT: Shown = { top: 0, left: 0, right: 0, bottom: 0 };

/** How long an open or a shut takes, and its easing (fast out, slow in). */
const MOTION_MS = 150;
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** An open dialog owns Escape and the keyboard until it closes. */
function dialogOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** A control on a handle keeps its pointer, so pressing it never reaches the handle. */
const keepPointer = (e: React.PointerEvent) => e.stopPropagation();

const sameShown = (a: Shown, b: Shown) => EDGES.every((edge) => Math.abs(a[edge] - b[edge]) < 0.5);

function useViewport(): { width: number; height: number } {
  const [vp, setVp] = useState({ width: 1440, height: 900 });
  useLayoutEffect(() => {
    const read = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  return vp;
}

/**
 * While drawers move, the width a drawer's content lays out in changes only
 * in steps of this many pixels, rounded toward narrower, so content never
 * overflows its drawer and reflows once a step rather than every frame.
 */
const REFLOW_STEP_PX = 40;

/**
 * How far each drawer is pulled out right now, and the writing of every
 * drawer's box from it. A drag sets it directly; an open or a shut glides it
 * to its new value over MOTION_MS, one write per animation frame.
 *
 * REFLOW IN STEPS. A drawer holding a thousand rows takes tens of
 * milliseconds to lay out and paint again at a new width, so doing it on
 * every frame of a drag would stutter. From the start of a motion to its end
 * each drawer's scrolling area is given an explicit width: its width when
 * the motion began, changed by the change in the drawer's width rounded down
 * to REFLOW_STEP_PX. The drawer's box and handle still follow the pointer
 * exactly; its content fills it to within one step and never past it, and
 * between steps nothing inside the drawer lays out again. When the motion
 * ends the explicit width is dropped and the content fills the drawer
 * exactly.
 */
class Geometry {
  els: Partial<Record<Edge, HTMLElement | null>> = {};
  shown: Shown = { ...SHUT };
  min: Shown = { ...SHUT };
  present: Record<Edge, boolean> = { top: false, left: false, right: false, bottom: false };
  viewportWidth = 0;
  private frame = 0;
  /** Per drawer, its scrolling area's width and its own width when the current motion began. */
  private start: Partial<Record<Edge, { content: number; drawer: number }>> | null = null;

  private extent(edge: "left" | "right") {
    return this.present[edge] ? this.shown[edge] + HANDLE_PX : 0;
  }

  /** The width a drawer's body has: a side's, the size it is pulled to (at least its minimum); the top's and bottom's, the room between the sides. */
  private drawerWidth(edge: Edge) {
    if (edge === "left" || edge === "right") return Math.max(this.shown[edge], this.min[edge]);
    return this.viewportWidth - this.extent("left") - this.extent("right");
  }

  private scroller(edge: Edge) {
    return this.els[edge]?.querySelector<HTMLElement>("[data-frame-drawer-scroll]") ?? null;
  }

  write() {
    const left = this.extent("left");
    const right = this.extent("right");
    for (const edge of EDGES) {
      const el = this.els[edge];
      if (!el) continue;
      Object.assign(el.style, drawerBox(edge, this.shown[edge], this.min[edge], left, right));
      const began = this.start?.[edge];
      const scroller = began && this.scroller(edge);
      if (!began || !scroller) continue;
      const change = Math.round(this.drawerWidth(edge) - began.drawer);
      scroller.style.flex =
        change === 0 ? "" : `0 0 ${Math.max(0, began.content + Math.floor(change / REFLOW_STEP_PX) * REFLOW_STEP_PX)}px`;
    }
  }

  /** A motion begins: note each drawer's widths, once, while its layout is settled. */
  begin() {
    if (this.start) return;
    this.start = {};
    for (const edge of EDGES) {
      const scroller = this.scroller(edge);
      if (scroller) this.start[edge] = { content: scroller.offsetWidth, drawer: this.drawerWidth(edge) };
    }
  }

  /** The motion is over: every drawer's content fills it exactly again. */
  end() {
    if (!this.start) return;
    this.start = null;
    for (const edge of EDGES) {
      const scroller = this.scroller(edge);
      if (scroller) scroller.style.flex = "";
    }
  }

  stop() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  jump(to: Shown) {
    this.stop();
    this.shown = { ...to };
    this.write();
  }

  glide(to: Shown) {
    if (sameShown(this.shown, to) || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.jump(to);
      this.end();
      return;
    }
    this.stop();
    this.begin();
    const from = { ...this.shown };
    let start = -1;
    const step = (t: number) => {
      if (start < 0) start = t;
      const k = Math.min(1, (t - start) / MOTION_MS);
      const e = easeOut(k);
      for (const edge of EDGES) this.shown[edge] = from[edge] + (to[edge] - from[edge]) * e;
      this.write();
      if (k < 1) {
        this.frame = requestAnimationFrame(step);
      } else {
        this.frame = 0;
        this.end();
      }
    };
    this.frame = requestAnimationFrame(step);
  }
}

type Drag = { id: number; x: number; y: number; from: number; moved: boolean; raw: number };

function Drawer({
  edge,
  spec,
  open,
  min,
  notch,
  shownNow,
  onToggle,
  onDragStart,
  onDragMove,
  onDragEnd,
  register,
  children,
}: {
  edge: Edge;
  spec: EdgeSpec;
  open: boolean;
  min: number;
  notch: boolean;
  /** How far the drawer is pulled out at this moment. */
  shownNow: () => number;
  onToggle: () => void;
  onDragStart: (edge: Edge) => void;
  onDragMove: (edge: Edge, raw: number) => void;
  onDragEnd: (edge: Edge, raw: number, cancelled: boolean) => void;
  register: (edge: Edge, el: HTMLElement | null) => void;
  children?: ReactNode;
}) {
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);
  const shown = open || dragging;

  const setRef = useCallback((node: HTMLElement | null) => register(edge, node), [edge, register]);

  const finish = (e: React.PointerEvent, cancelled: boolean) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    if (!d.moved) {
      if (!cancelled) onToggle();
      return;
    }
    flushSync(() => setDragging(false));
    onDragEnd(edge, d.raw, cancelled);
  };

  const signals = spec.handle.signals ?? NO_SIGNALS;
  const actions = spec.handle.actions ?? NO_ACTIONS;

  return (
    <section
      ref={setRef}
      data-frame-drawer={edge}
      data-open={shown}
      data-dragging={dragging}
      style={{ "--frame-min": `${min}px` } as React.CSSProperties}
      aria-label={spec.handle.label}
    >
      <div
        id={`frame-drawer-${edge}`}
        data-frame-drawer-body
        aria-hidden={!shown}
        inert={!shown}
        tabIndex={-1}
        className="flex min-h-0 min-w-0 flex-1 outline-none"
      >
        <div data-frame-drawer-scroll className="min-h-0 min-w-0 flex-1 overflow-auto">
          <div data-frame-drawer-content className="flex flex-col sm:flex-row">
            <div className="min-w-0 flex-1">{spec.body}</div>
            {children}
          </div>
        </div>
      </div>
      <div
        data-frame-handle={edge}
        data-frame-handle-orient={edge === "left" || edge === "right" ? "vertical" : "horizontal"}
        onPointerDown={(e) => {
          if (e.button !== 0 || drag.current) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: shownNow(), moved: false, raw: 0 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (!d.moved) {
            if (Math.hypot(dx, dy) < CLICK_SLOP) return;
            d.moved = true;
            onDragStart(edge);
            flushSync(() => setDragging(true));
          }
          d.raw = d.from + pullDistance(edge, dx, dy);
          onDragMove(edge, d.raw);
        }}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
      >
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
        <span data-frame-handle-fill aria-hidden />
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
  const vp = useViewport();
  const edges: Edges = useMemo(() => ({ top, bottom, left, right }), [top, bottom, left, right]);
  const open = useFrameStore((s) => s.open[page]) ?? EMPTY;
  const stored = useFrameStore((s) => s.size[page]);
  const lastSide = useFrameStore((s) => s.lastSide[page]) ?? "right";
  const lastEnd = useFrameStore((s) => s.lastEnd[page]) ?? "bottom";
  const seen = useFrameStore((s) => s.seen[page]);
  const setOpen = useFrameStore((s) => s.setOpen);
  const markSeen = useFrameStore((s) => s.markSeen);
  const rootRef = useRef<HTMLDivElement>(null);
  const geometry = useRef<Geometry>(null as unknown as Geometry);
  if (geometry.current === null) geometry.current = new Geometry();
  const dragging = useRef<Edge | null>(null);
  const register = useCallback((edge: Edge, el: HTMLElement | null) => {
    geometry.current.els[edge] = el;
  }, []);

  // The stored state is read after the first render (frame-store.ts), and
  // nothing glides until it has been, so a restored drawer is simply open
  // rather than sliding in on load.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let frame = 0;
    void Promise.resolve(useFrameStore.persist.rehydrate()).then(() => {
      frame = requestAnimationFrame(() => setHydrated(true));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  // The room each axis has: the width of the screen for the sides, its
  // height under the header for the top and bottom.
  const axis = useCallback((edge: Edge) => (edge === "left" || edge === "right" ? vp.width : vp.height - HEADER_PX), [vp]);
  const bounds = useMemo(() => {
    const out = {} as Record<Edge, { min: number; max: number }>;
    for (const edge of EDGES) out[edge] = resolveBounds(edges[edge]?.bounds ?? DEFAULT_BOUNDS, axis(edge));
    return out;
  }, [edges, axis]);

  const wish = useCallback(
    (edge: Edge): DrawerWish => ({
      present: edges[edge] !== null,
      open: !!open[edge] && edges[edge] !== null,
      size: clamp(stored?.[edge] ?? edges[edge]?.defaultSize ?? DEFAULT_SIZE, bounds[edge]),
      bounds: bounds[edge],
    }),
    [edges, open, stored, bounds],
  );

  /** How far each drawer shows, from the stored state, or with one drawer's handle under the pointer at `raw`. */
  const resolve = useCallback(
    (drag?: { edge: Edge; raw: number }) => {
      const shown = { ...SHUT };
      const shut: Edge[] = [];
      for (const last of [lastSide, lastEnd] as const) {
        const first: Edge = drag && (drag.edge === last || drag.edge === OPPOSITE[last]) ? drag.edge : last;
        const second = OPPOSITE[first];
        const dragged = drag?.edge === first ? dragSize(drag.raw, bounds[first]) : undefined;
        const r = sharePair(wish(first), wish(second), shared(axis(first)), dragged);
        shown[first] = r.first;
        shown[second] = r.second;
        if (r.secondShut) shut.push(second);
      }
      return { shown, shut };
    },
    [lastSide, lastEnd, bounds, wish, axis],
  );
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;

  // After every render that changes what should show, the boxes glide there;
  // a new viewport, or the first read of the stored state, jumps instead.
  const lastVp = useRef(vp);
  useLayoutEffect(() => {
    const g = geometry.current;
    g.viewportWidth = vp.width;
    for (const edge of EDGES) {
      g.present[edge] = edges[edge] !== null;
      g.min[edge] = bounds[edge].min;
    }
    if (dragging.current) return;
    const { shown, shut } = resolve();
    // Two opposite drawers whose minimums cannot both fit are never both
    // open: the one opened last stays, the other is shut in the store too, so
    // its handle reads shut and its next press opens it.
    for (const edge of shut) setOpen(page, edge, false);
    if (!hydrated || lastVp.current !== vp) g.jump(shown);
    else g.glide(shown);
    lastVp.current = vp;
  }, [resolve, edges, bounds, hydrated, vp, page, setOpen]);
  useEffect(() => () => geometry.current.stop(), []);

  /** Open or shut one drawer, at a size when one is given. */
  const setEdge = useCallback(
    (edge: Edge, want: boolean, size?: number) => {
      const spec = edges[edge];
      if (!spec) return;
      const current = useFrameStore.getState().open[page] ?? EMPTY;
      if (current[edge] && !want) markSeen(page, edge, signalSignature(spec.handle.signals ?? NO_SIGNALS));
      setOpen(page, edge, want, size);
    },
    [page, edges, markSeen, setOpen],
  );

  const onDragStart = useCallback((edge: Edge) => {
    dragging.current = edge;
    geometry.current.stop();
    geometry.current.begin();
  }, []);
  const onDragMove = useCallback((edge: Edge, raw: number) => {
    geometry.current.jump(resolveRef.current({ edge, raw }).shown);
  }, []);
  const onDragEnd = useCallback(
    (edge: Edge, raw: number, cancelled: boolean) => {
      dragging.current = null;
      if (cancelled) {
        geometry.current.glide(resolveRef.current().shown);
        return;
      }
      // Every store write makes new objects, so the render that follows
      // always reaches the layout effect above, which glides from where the
      // drag left the drawers to the released state.
      const next = releaseDrag(resolveRef.current({ edge, raw }).shown[edge], bounds[edge]);
      setEdge(edge, next.open, next.open ? next.size : undefined);
    },
    [bounds, setEdge],
  );

  // W A S D toggle the drawers, Shift with the key opens one and moves focus
  // into it, "/" focuses navigate, Escape closes an open drawer (the top,
  // then the side opened last, the other side, the bottom). None of it fires
  // while a text field has focus or a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTextTarget(e.target) || dialogOpen()) return;
      const state = useFrameStore.getState();
      const current = state.open[page] ?? EMPTY;
      if (e.key === "Escape") {
        const edge = nextToClose(current, state.lastSide[page] ?? "right");
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
        geometry.current.els[edge]?.querySelector<HTMLElement>("[data-frame-drawer-body]")?.focus({ preventScroll: true });
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

  // The center is inset by a handle's thickness on each edge that has a drawer.
  const inset = (edge: Edge) => (edges[edge] !== null ? `${HANDLE_PX}px` : "0px");

  // The sides come first so that the top and bottom, painted after them,
  // lie over the sides' shadows where they meet.
  const order: Edge[] = ["left", "right", "top", "bottom"];

  return (
    <div
      ref={rootRef}
      data-frame={page}
      data-hydrated={hydrated}
      style={
        {
          "--frame-handle": `${HANDLE_PX}px`,
          "--frame-header": `${HEADER_PX}px`,
          "--frame-inset-top": inset("top"),
          "--frame-inset-bottom": inset("bottom"),
          "--frame-inset-left": inset("left"),
          "--frame-inset-right": inset("right"),
        } as React.CSSProperties
      }
    >
      <SiteHeader title={title} explainer={explainer} state={state} onDiagnostics={() => setEdge("bottom", true)} />
      <div data-frame-stage>
        <div data-frame-center>{center}</div>
        {order.map((edge) => {
          const spec = edges[edge];
          if (!spec) return null;
          return (
            <Drawer
              key={edge}
              edge={edge}
              spec={spec}
              open={!!open[edge]}
              min={bounds[edge].min}
              notch={notch(edge)}
              shownNow={() => geometry.current.shown[edge]}
              onToggle={() => setEdge(edge, !(useFrameStore.getState().open[page] ?? EMPTY)[edge])}
              onDragStart={onDragStart}
              onDragMove={onDragMove}
              onDragEnd={onDragEnd}
              register={register}
            >
              {edge === "bottom" && isTom && (
                <aside
                  aria-label="Diagnostics"
                  className="shrink-0 border-t border-border p-3 sm:w-[min(20rem,35%)] sm:border-l sm:border-t-0"
                >
                  <Diagnostics />
                </aside>
              )}
            </Drawer>
          );
        })}
      </div>
    </div>
  );
}
