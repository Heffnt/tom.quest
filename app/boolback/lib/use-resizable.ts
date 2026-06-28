"use client";

// app/boolback/lib/use-resizable.ts
//
// A pointer-drag resize hook used for the tree pane width, the detail panel
// width, and individual table column widths. It is deliberately presentation
// agnostic: it owns a single numeric size, drives it from pointer drags on a
// returned handle-prop bag, clamps to [min,max], and reports the final value to
// an `onCommit` callback (so the caller can persist via usePersistedSettings on
// drag end rather than on every move).
//
// Two edges supported: dragging the handle to the RIGHT grows the size when
// `edge === "left"` (handle sits on the LEFT of the panel, e.g. a right-docked
// detail panel) and shrinks when the pointer moves right for `edge === "right"`
// is the mirror. Column resizers always use `edge === "right"` (handle on the
// right border, drag right = wider).

import { useCallback, useEffect, useRef, useState } from "react";

export interface ResizableOptions {
  /** Initial / controlled size in px. Changes here re-seat the live size. */
  size: number;
  min: number;
  max: number;
  /** Which side the drag handle lives on. */
  edge: "left" | "right";
  /** Called with the final clamped size when the drag ends. */
  onCommit?: (size: number) => void;
}

export interface ResizableResult {
  size: number;
  dragging: boolean;
  /** Spread onto the drag handle element. */
  handleProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onDoubleClick?: (e: React.MouseEvent) => void;
    role: "separator";
    "aria-orientation": "vertical";
    style: React.CSSProperties;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function useResizable(opts: ResizableOptions): ResizableResult {
  const { size: controlled, min, max, edge, onCommit } = opts;
  const [size, setSize] = useState(controlled);
  const [dragging, setDragging] = useState(false);

  // Re-seat when the controlled size changes from outside (e.g. hydration),
  // but never while the user is actively dragging.
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) setSize(clamp(controlled, min, max));
  }, [controlled, min, max]);

  const startX = useRef(0);
  const startSize = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    draggingRef.current = true;
    setDragging(true);
    startX.current = e.clientX;
    startSize.current = size;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  }, [size]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    const dx = e.clientX - startX.current;
    // edge "right": dragging right grows. edge "left": dragging right shrinks.
    const delta = edge === "right" ? dx : -dx;
    setSize(clamp(startSize.current + delta, min, max));
  }, [edge, min, max]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may already be released */
    }
    setSize((cur) => {
      onCommit?.(cur);
      return cur;
    });
  }, [onCommit]);

  return {
    size,
    dragging,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      role: "separator",
      "aria-orientation": "vertical",
      style: { cursor: "col-resize", touchAction: "none" },
    },
  };
}
