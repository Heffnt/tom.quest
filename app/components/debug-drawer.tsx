"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useAuth } from "../lib/auth";
import { debug } from "../lib/debug";

type Edge = "left" | "right" | "bottom";
type SizeByEdge = Record<Edge, number>;

interface DebugDrawerProps {
  openEdge: Edge | null;
  sizeByEdge: SizeByEdge;
  onOpen: (edge: Edge) => void;
  onClose: () => void;
  onResize: (edge: Edge, size: number) => void;
  onResizeStart: () => void;
  onResizeEnd: () => void;
}

type DragState = {
  edge: Edge;
  startX: number;
  startY: number;
  startSize: number;
};

const TRIGGER_ZONES: Record<Edge, string> = {
  left: "fixed left-0 top-1/2 z-40 h-28 w-6 -translate-y-1/2",
  right: "fixed right-0 top-1/2 z-40 h-28 w-6 -translate-y-1/2",
  bottom: "fixed bottom-0 left-1/2 z-40 h-6 w-32 -translate-x-1/2",
};

const TRIGGER_BUTTONS: Record<Edge, string> = {
  left: "absolute left-0 top-1/2 -translate-y-1/2 rounded-r-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-accent",
  right: "absolute right-0 top-1/2 -translate-y-1/2 rounded-l-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-accent",
  bottom: "absolute bottom-0 left-1/2 -translate-x-1/2 rounded-t-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium text-accent",
};

const PANEL_SHELL: Record<Edge, string> = {
  left: "fixed left-0 top-0 bottom-0 z-50 border-r border-border bg-surface flex flex-col",
  right: "fixed right-0 top-0 bottom-0 z-50 border-l border-border bg-surface flex flex-col",
  bottom: "fixed left-0 right-0 bottom-0 z-50 border-t border-border bg-surface flex flex-col",
};

const RESIZE_HANDLES: Record<Edge, string> = {
  left: "absolute top-0 right-0 h-full w-2 cursor-col-resize",
  right: "absolute top-0 left-0 h-full w-2 cursor-col-resize",
  bottom: "absolute left-0 top-0 h-2 w-full cursor-row-resize",
};

export default function DebugDrawer({
  openEdge,
  sizeByEdge,
  onOpen,
  onClose,
  onResize,
  onResizeStart,
  onResizeEnd,
}: DebugDrawerProps) {
  const { isTom } = useAuth();
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hoverEdge, setHoverEdge] = useState<Edge | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [stickToBottom, setStickToBottom] = useState(true);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const previousOpenEdgeRef = useRef<Edge | null>(null);
  const version = useSyncExternalStore(debug.subscribe, debug.getVersion, debug.getVersion);
  const lines = debug.getLines();
  void version;

  useEffect(() => {
    const next = scrollRef.current;
    const justOpened = openEdge !== null && previousOpenEdgeRef.current !== openEdge;
    if (next && openEdge && (stickToBottom || justOpened)) {
      next.scrollTop = next.scrollHeight;
    }
    previousOpenEdgeRef.current = openEdge;
  }, [lines, openEdge, stickToBottom]);

  useEffect(() => {
    if (!openEdge) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [onClose, openEdge]);

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 1200);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useEffect(() => {
    if (!dragState) return;
    const handlePointerMove = (event: MouseEvent) => {
      const nextSize = (() => {
        if (dragState.edge === "left") {
          return dragState.startSize + (event.clientX - dragState.startX);
        }
        if (dragState.edge === "right") {
          return dragState.startSize + (dragState.startX - event.clientX);
        }
        return dragState.startSize + (dragState.startY - event.clientY);
      })();
      onResize(dragState.edge, nextSize);
    };
    const handlePointerUp = () => {
      setDragState(null);
      onResizeEnd();
    };
    window.addEventListener("mousemove", handlePointerMove);
    window.addEventListener("mouseup", handlePointerUp);
    return () => {
      window.removeEventListener("mousemove", handlePointerMove);
      window.removeEventListener("mouseup", handlePointerUp);
    };
  }, [dragState, onResize, onResizeEnd]);

  const activeSize = openEdge ? sizeByEdge[openEdge] : 0;

  const panelStyle = useMemo<CSSProperties>(() => {
    if (!openEdge) return {};
    if (openEdge === "bottom") return { height: activeSize };
    return { width: activeSize };
  }, [activeSize, openEdge]);

  const handleResizeMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!openEdge) return;
    event.preventDefault();
    onResizeStart();
    setDragState({
      edge: openEdge,
      startX: event.clientX,
      startY: event.clientY,
      startSize: sizeByEdge[openEdge],
    });
  }, [onResizeStart, openEdge, sizeByEdge]);

  const handleScroll = useCallback(() => {
    const next = scrollRef.current;
    if (!next) return;
    const atBottom = next.scrollTop + next.clientHeight >= next.scrollHeight - 24;
    setStickToBottom(atBottom);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(debug.snapshot());
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }, []);

  if (!isTom) return null;

  return (
    <>
      {!openEdge && (["left", "right", "bottom"] as Edge[]).map((edge) => (
        <div
          key={edge}
          className={TRIGGER_ZONES[edge]}
          onMouseEnter={() => setHoverEdge(edge)}
          onMouseLeave={() => setHoverEdge((current) => (current === edge ? null : current))}
        >
          <button
            type="button"
            aria-label={`Open debug panel from ${edge}`}
            onClick={() => onOpen(edge)}
            className={`${TRIGGER_BUTTONS[edge]} transition-all duration-150 ease-out ${
              hoverEdge === edge
                ? "opacity-100"
                : edge === "left"
                  ? "-translate-x-full opacity-0 pointer-events-none"
                  : edge === "right"
                    ? "translate-x-full opacity-0 pointer-events-none"
                    : "translate-y-full opacity-0 pointer-events-none"
            }`}
          >
            Debug
          </button>
        </div>
      ))}
      {openEdge && (
        <section
          ref={panelRef}
          aria-label="Debug panel"
          className={`${PANEL_SHELL[openEdge]} ${dragState ? "" : "transition-[width,height] duration-150 ease-out"}`}
          style={panelStyle}
        >
          <div
            role="presentation"
            onMouseDown={handleResizeMouseDown}
            className={RESIZE_HANDLES[openEdge]}
          />
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-text">Debug</h2>
              <span className="text-[10px] uppercase tracking-wide text-text-faint">
                {openEdge}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={handleCopy}
                className="rounded border border-border px-2 py-1 text-text-muted hover:border-text-muted hover:text-text transition-colors duration-150"
              >
                {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => debug.clear()}
                className="rounded border border-border px-2 py-1 text-text-muted hover:border-text-muted hover:text-text transition-colors duration-150"
              >
                Clear
              </button>
              <button
                type="button"
                aria-label="Close debug panel"
                onClick={onClose}
                className="rounded border border-border px-2 py-1 text-text-muted hover:border-text-muted hover:text-text transition-colors duration-150"
              >
                Close
              </button>
            </div>
          </div>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto bg-black/60 px-4 py-3"
          >
            <pre className="min-h-full whitespace-pre-wrap break-words text-[12px] leading-5 text-text-muted">
              {lines.length === 0 ? (
                <span className="text-text-faint">No debug output yet.</span>
              ) : (
                lines.map((line, index) => (
                  <span key={`${index}-${line}`} className={line.includes("ERROR") ? "text-error" : "text-text-muted"}>
                    {line}
                    {index < lines.length - 1 ? "\n" : ""}
                  </span>
                ))
              )}
            </pre>
          </div>
        </section>
      )}
    </>
  );
}
