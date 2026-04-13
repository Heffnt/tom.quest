"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useAuth } from "../lib/auth";
import { DebugLogEntry, DebugLogType } from "../lib/debug";

type Edge = "bottom" | "left" | "right";

const TYPE_CONFIG: Record<DebugLogType, { label: string; color: string }> = {
  request:   { label: "Req",       color: "text-blue-400" },
  response:  { label: "Res",       color: "text-green-400" },
  error:     { label: "Err",       color: "text-error" },
  info:      { label: "Info",      color: "text-accent" },
  action:    { label: "Act",       color: "text-violet-400" },
  lifecycle: { label: "Life",      color: "text-text-faint" },
};

const TYPE_ORDER: DebugLogType[] = ["request", "response", "error", "info", "action", "lifecycle"];

const EDGE_STYLES: Record<Edge, { panel: string; border: string; animation: string }> = {
  right: {
    panel: "inset-y-0 right-0 w-full max-w-lg",
    border: "border-l",
    animation: "animate-slide-in-right",
  },
  left: {
    panel: "inset-y-0 left-0 w-full max-w-lg",
    border: "border-r",
    animation: "animate-slide-in-left",
  },
  bottom: {
    panel: "inset-x-0 bottom-0 h-[50vh] max-h-[600px]",
    border: "border-t",
    animation: "animate-slide-in-bottom",
  },
};

const TRIGGER_POSITIONS: Record<Edge, { dot: string; label: string }> = {
  bottom: { dot: "bottom-4 left-1/2 -translate-x-1/2", label: "Open debug drawer from bottom" },
  left:   { dot: "bottom-4 left-4", label: "Open debug drawer from left" },
  right:  { dot: "bottom-4 right-4", label: "Open debug drawer from right" },
};

function formatData(data: unknown): string {
  try { return JSON.stringify(data, null, 2); }
  catch { return String(data); }
}

export default function DebugDrawer() {
  const { isTom } = useAuth();
  const [openEdge, setOpenEdge] = useState<Edge | null>(null);
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [typeFilters, setTypeFilters] = useState<Record<DebugLogType, boolean>>(() => {
    const filters = {} as Record<DebugLogType, boolean>;
    for (const t of TYPE_ORDER) filters[t] = true;
    return filters;
  });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTom) return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DebugLogEntry>).detail;
      setLogs((prev) => [...prev, detail].slice(-500));
    };
    window.addEventListener("tomquest-debug", handler as EventListener);
    return () => window.removeEventListener("tomquest-debug", handler as EventListener);
  }, [isTom]);

  useEffect(() => {
    if (openEdge && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, openEdge]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setOpenEdge(null);
  }, []);

  useEffect(() => {
    if (openEdge) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [openEdge, handleKeyDown]);

  if (!isTom) return null;

  const handleTrigger = (edge: Edge) => {
    setOpenEdge((prev) => prev === edge ? null : edge);
  };

  const searchLower = search.trim().toLowerCase();
  const visibleLogs = logs.filter((log) => {
    if (!typeFilters[log.type]) return false;
    if (!searchLower) return true;
    const dataText = log.data !== undefined ? formatData(log.data) : "";
    return `${log.message} ${log.source || ""} ${log.url || ""} ${dataText}`
      .toLowerCase()
      .includes(searchLower);
  });

  const isVertical = openEdge === "left" || openEdge === "right";

  return (
    <>
      {/* Trigger dots — one per edge, hidden when that edge is open */}
      {(["bottom", "left", "right"] as Edge[]).map((edge) => (
        <button
          key={edge}
          type="button"
          aria-label={TRIGGER_POSITIONS[edge].label}
          onClick={() => handleTrigger(edge)}
          className={`fixed z-40 w-3 h-3 rounded-full transition-all duration-150 ${TRIGGER_POSITIONS[edge].dot} ${
            openEdge === edge
              ? "bg-accent scale-150 opacity-50"
              : "bg-accent hover:scale-125"
          }`}
        />
      ))}

      {/* Drawer panel */}
      {openEdge && (() => {
        const style = EDGE_STYLES[openEdge];
        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Debug logs"
            className={`fixed z-50 bg-surface ${style.border} border-border flex ${isVertical ? "flex-col" : "flex-col"} ${style.panel} ${style.animation}`}
          >
            {/* Header */}
            <div className="flex-none px-4 py-3 border-b border-border">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-text">Debug</h2>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setLogs([])}
                    className="text-xs text-text-muted hover:text-text transition-colors duration-150"
                  >
                    Clear
                  </button>
                  <button
                    type="button"
                    aria-label="Close debug drawer"
                    onClick={() => setOpenEdge(null)}
                    className="text-text-muted hover:text-text transition-colors duration-150"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                {TYPE_ORDER.map((type) => {
                  const active = typeFilters[type];
                  const cfg = TYPE_CONFIG[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      onClick={() => setTypeFilters((prev) => ({ ...prev, [type]: !prev[type] }))}
                      className={`px-2 py-0.5 rounded border text-[10px] uppercase tracking-wide transition-colors duration-150 ${
                        active
                          ? `${cfg.color} border-current`
                          : "text-text-faint border-border"
                      }`}
                    >
                      {cfg.label}
                    </button>
                  );
                })}
              </div>

              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search logs..."
                className="w-full bg-bg border border-border rounded-lg px-3 py-1.5 text-xs text-text focus:border-accent focus:outline-none transition-colors duration-150"
              />
            </div>

            {/* Log entries */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-1">
              {visibleLogs.length === 0 ? (
                <p className="text-text-faint text-xs text-center py-8">
                  {logs.length === 0 ? "No logs yet" : "No matching logs"}
                </p>
              ) : (
                visibleLogs.map((log) => {
                  const cfg = TYPE_CONFIG[log.type];
                  const isExpanded = expandedId === log.id;
                  return (
                    <button
                      key={log.id}
                      type="button"
                      onClick={() => setExpandedId(isExpanded ? null : log.id)}
                      className="w-full text-left rounded px-2 py-1.5 hover:bg-surface-alt transition-colors duration-150"
                    >
                      <div className="flex items-start gap-2 text-xs">
                        <span className="text-text-faint font-mono shrink-0">
                          {log.timestamp.toLocaleTimeString()}
                        </span>
                        <span className={`${cfg.color} font-mono shrink-0 w-8`}>
                          {cfg.label}
                        </span>
                        <span className="text-text-muted truncate">
                          {log.source && <span className="text-text-faint">[{log.source}] </span>}
                          {log.message}
                        </span>
                      </div>
                      {isExpanded && log.data !== undefined && (
                        <pre className="mt-1 ml-[5.5rem] text-[10px] text-text-faint overflow-x-auto max-w-full font-mono whitespace-pre-wrap">
                          {formatData(log.data)}
                        </pre>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        );
      })()}
    </>
  );
}
