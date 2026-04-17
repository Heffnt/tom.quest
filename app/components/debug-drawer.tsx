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

/* Arrows point inward — toward the viewport area the panel will expand into.
   (Old icons pointed off-screen, which read as "escape" not "expand".) */
const TRIGGER_EDGE_ICONS: Record<Edge, string> = {
  left: "▸",
  right: "◂",
  bottom: "▴",
};

/* Cursor must be within this many pixels of the edge for the tab to fade in. */
const PROXIMITY_PX = 140;

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

function TriggerTab({
  edge,
  onClick,
  visible,
}: {
  edge: Edge;
  onClick: () => void;
  visible: boolean;
}) {
  const positionClasses: Record<Edge, string> = {
    left: "fixed left-0 top-1/2 -translate-y-1/2 z-40",
    right: "fixed right-0 top-1/2 -translate-y-1/2 z-40",
    bottom: "fixed bottom-0 left-1/2 -translate-x-1/2 z-40",
  };
  const tabClasses: Record<Edge, string> = {
    left: "rounded-r-lg border-r border-t border-b border-border/60 pl-1 pr-2.5 py-5",
    right: "rounded-l-lg border-l border-t border-b border-border/60 pr-1 pl-2.5 py-5",
    bottom: "rounded-t-lg border-l border-r border-t border-border/60 px-5 pb-1 pt-2.5",
  };

  return (
    <div
      className={positionClasses[edge]}
      style={{
        opacity: visible ? 1 : 0,
        transition: "opacity 180ms ease-out",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <button
        type="button"
        aria-label={`Open debug panel from ${edge}`}
        onClick={onClick}
        className={`${tabClasses[edge]} bg-surface/90 backdrop-blur-sm text-accent/70 hover:text-accent hover:bg-surface transition-colors duration-150 cursor-pointer`}
      >
        <span className="text-xl font-mono leading-none block">
          {TRIGGER_EDGE_ICONS[edge]}
        </span>
      </button>
    </div>
  );
}

/* Proximity = near at least one edge within PROXIMITY_PX. Returns per-edge booleans. */
function useEdgeProximity(active: boolean): Record<Edge, boolean> {
  const [near, setNear] = useState<Record<Edge, boolean>>({
    left: false, right: false, bottom: false,
  });
  useEffect(() => {
    if (!active) {
      setNear({ left: false, right: false, bottom: false });
      return;
    }
    const onMove = (e: MouseEvent) => {
      const w = window.innerWidth, h = window.innerHeight;
      setNear({
        left: e.clientX <= PROXIMITY_PX,
        right: w - e.clientX <= PROXIMITY_PX,
        bottom: h - e.clientY <= PROXIMITY_PX,
      });
    };
    const onLeave = () => setNear({ left: false, right: false, bottom: false });
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, [active]);
  return near;
}

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
  const nearEdge = useEdgeProximity(isTom && openEdge === null);
  const scrollRef = useRef<HTMLDivElement>(null);
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
        <TriggerTab
          key={edge}
          edge={edge}
          onClick={() => onOpen(edge)}
          visible={nearEdge[edge]}
        />
      ))}
      {openEdge && (
        <section
          aria-label="Debug panel"
          className={`${PANEL_SHELL[openEdge]} ${dragState ? "" : "transition-[width,height] duration-150 ease-out"}`}
          style={panelStyle}
        >
          <div
            role="presentation"
            onMouseDown={handleResizeMouseDown}
            className={RESIZE_HANDLES[openEdge]}
          />
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-text">Debug</h2>
              <span className="text-[10px] uppercase tracking-wide text-text-faint">
                {openEdge}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={handleCopy}
                className="rounded border border-border px-2 py-0.5 text-text-muted hover:border-text-muted hover:text-text transition-colors duration-150"
              >
                {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy"}
              </button>
              <button
                type="button"
                onClick={() => debug.clear()}
                className="rounded border border-border px-2 py-0.5 text-text-muted hover:border-text-muted hover:text-text transition-colors duration-150"
              >
                Clear
              </button>
              <button
                type="button"
                aria-label="Close debug panel"
                onClick={onClose}
                className="ml-1 flex items-center justify-center w-6 h-6 rounded text-text-faint hover:text-text hover:bg-border/40 transition-colors duration-150"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <path d="M2 2l8 8M10 2l-8 8" />
                </svg>
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
