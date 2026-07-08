"use client";

// Generalized PORTAL POPOVER pattern, extracted from the copy-pasted
// implementations in top-bar.tsx (Dropdown), settings-corner.tsx
// (SettingsPanel), inventory-grid.tsx (SendPopover), and brew-graph.tsx
// (WildcardPicker). All four shared the same shape: a `fixed`, `z`-stacked
// panel portaled to `document.body`, anchored near a caller-computed screen
// point, clamped back into the viewport once its real size is known, and
// torn down on an outside mousedown or Escape.
//
// `useDismissable` is the teardown half on its own (a ref to attach to the
// popover's root + the outside-click/Escape wiring) for callers that want to
// build a bespoke panel. `Popover` is the full pattern: it also portals and
// positions. top-bar.tsx's Dropdown is the most complete reference this
// mirrors — including the "measure after mount, then clamp" two-pass layout.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "./ui";

// ── useDismissable ───────────────────────────────────────────────────────────
// Wires outside-mousedown + Escape teardown for anything rendered under the
// returned ref. `active` lets a caller mount the hook unconditionally and just
// gate it (e.g. while a popover is closed) without violating rules-of-hooks.

export function useDismissable<T extends HTMLElement = HTMLDivElement>(
  onClose: () => void,
  active = true,
): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, active]);

  return ref;
}

// ── Popover ───────────────────────────────────────────────────────────────
// A point in viewport coordinates (e.g. a triggering element's
// getBoundingClientRect(), possibly with a small offset added by the caller —
// see Dropdown's `{ x: r.left, y: r.bottom + 4 }` and SettingsPanel's
// `{ x: r.right, y: r.bottom + 6 }`).

export interface PopoverAnchor {
  x: number;
  y: number;
}

// Which edge/point of the popover `anchor.x` pins to:
//   "left"   — anchor.x is the popover's left edge (top-bar Dropdown, brew-graph
//              picker's default)
//   "right"  — anchor.x is the popover's right edge (settings-corner,
//              inventory-grid's SendPopover, both anchored off a trailing
//              element's right side)
//   "center" — anchor.x is the popover's horizontal center (brew-graph's
//              WildcardPicker)
export type PopoverAlign = "left" | "right" | "center";

export interface PopoverProps {
  /** The anchor point, in viewport coordinates. */
  anchor: PopoverAnchor;
  /** @default "left" */
  align?: PopoverAlign;
  /** Fixed width in px. Omit to size to content (still gets clamped). */
  width?: number;
  /** @default "dialog" */
  role?: "menu" | "dialog";
  label: string;
  onClose: () => void;
  /** Extra classes — panel padding, min-width, max-height, etc. */
  className?: string;
  /** Minimum distance kept from the viewport edges. @default 8 */
  edgePadding?: number;
  children: ReactNode;
}

/**
 * Portals `children` to `document.body` as a `fixed`-position panel anchored
 * near `anchor`, clamped into the viewport once its real size is known, and
 * dismissed on outside-click or Escape (via `useDismissable`).
 */
export function Popover({
  anchor,
  align = "left",
  width,
  role = "dialog",
  label,
  onClose,
  className,
  edgePadding = 8,
  children,
}: PopoverProps) {
  const ref = useDismissable<HTMLDivElement>(onClose);
  const [pos, setPos] = useState(anchor);

  // Measure after mount (real width/height, including a fixed `width` prop's
  // effect on layout), then clamp back onto the screen — same two-pass
  // "render at anchor, correct before paint" approach as the four originals.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = width ?? r.width;
    const h = r.height;

    let x = align === "right" ? anchor.x - w : align === "center" ? anchor.x - w / 2 : anchor.x;
    let y = anchor.y;

    const maxX = window.innerWidth - w - edgePadding;
    const maxY = window.innerHeight - h - edgePadding;
    if (x > maxX) x = maxX;
    if (y > maxY) y = maxY;
    x = Math.max(edgePadding, x);
    y = Math.max(edgePadding, y);

    setPos({ x, y });
    // anchor is a fresh object every render from the caller; compare by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.x, anchor.y, align, width, edgePadding]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={cn("fixed z-[80] rounded-lg border border-border bg-surface shadow-2xl", className)}
      style={{ left: pos.x, top: pos.y, width }}
    >
      {children}
    </div>,
    document.body,
  );
}
