"use client";

import { useEffect, useRef, useState } from "react";
import { DebugLogEntry, DebugLogType } from "../lib/debug";

export default function DebugPanel() {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const [panelHeight, setPanelHeight] = useState(256);
  const [isResizing, setIsResizing] = useState(false);
  const [search, setSearch] = useState("");
  const [typeFilters, setTypeFilters] = useState<Record<DebugLogType, boolean>>({
    request: true,
    response: true,
    error: true,
    info: true,
    action: true,
    lifecycle: true,
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseBodyPaddingRef = useRef<string | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  const resizeStartY = useRef(0);
  const resizeStartHeight = useRef(0);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DebugLogEntry>).detail;
      setLogs((prev) => [...prev, detail].slice(-500));
    };
    window.addEventListener("tomquest-debug", handler as EventListener);
    return () => {
      window.removeEventListener("tomquest-debug", handler as EventListener);
    };
  }, []);

  useEffect(() => {
    if (panelRef.current && open) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [logs, open]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (baseBodyPaddingRef.current === null) {
      baseBodyPaddingRef.current = document.body.style.paddingBottom;
    }
    const root = rootRef.current;
    if (!root) return;
    const nextPadding = open ? `${root.offsetHeight}px` : baseBodyPaddingRef.current || "";
    document.body.style.paddingBottom = nextPadding;
    return () => {
      if (baseBodyPaddingRef.current !== null) {
        document.body.style.paddingBottom = baseBodyPaddingRef.current;
      }
    };
  }, [open, panelHeight]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const deltaY = resizeStartY.current - e.clientY;
      const newHeight = Math.min(Math.max(resizeStartHeight.current + deltaY, 100), window.innerHeight - 100);
      setPanelHeight(newHeight);
    };
    const handleMouseUp = () => {
      setIsResizing(false);
    };
    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartY.current = e.clientY;
    resizeStartHeight.current = panelHeight;
    setIsResizing(true);
  };

  const typeOptions: Record<DebugLogType, { label: string; className: string }> = {
    request: { label: "Request", className: "text-blue-400 border-blue-400/40" },
    response: { label: "Response", className: "text-green-400 border-green-400/40" },
    error: { label: "Error", className: "text-red-400 border-red-400/40" },
    info: { label: "Info", className: "text-yellow-400 border-yellow-400/40" },
    action: { label: "Action", className: "text-violet-400 border-violet-400/40" },
    lifecycle: { label: "Lifecycle", className: "text-white/60 border-white/30" },
  };
  const typeOrder: DebugLogType[] = ["request", "response", "error", "info", "action", "lifecycle"];
  const formatData = (data: unknown) => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  };
  const searchValue = search.trim().toLowerCase();
  const visibleLogs = logs.filter((log) => {
    if (!typeFilters[log.type]) return false;
    if (!searchValue) return true;
    const dataText = log.data !== undefined ? formatData(log.data) : "";
    const haystack = `${log.message} ${log.source || ""} ${log.url || ""} ${dataText}`.toLowerCase();
    return haystack.includes(searchValue);
  });
  const copyLogs = async () => {
    const text = visibleLogs.map((log) => {
      const time = log.timestamp.toLocaleTimeString();
      const source = log.source ? ` [${log.source}]` : "";
      if (log.type === "request") {
        return `${time}${source} → ${log.method || ""} ${log.url || log.message}${log.data !== undefined ? "\n" + formatData(log.data) : ""}`;
      }
      if (log.type === "response") {
        return `${time}${source} ← ${log.status} ${log.url || ""} (${log.duration}ms)${log.data !== undefined ? "\n" + formatData(log.data) : ""}`;
      }
      if (log.type === "error") {
        return `${time}${source} ✕ ${log.message}${log.duration != null ? ` (${log.duration}ms)` : ""}${log.data !== undefined ? "\n" + formatData(log.data) : ""}`;
      }
      const base = `${time}${source} [${log.type.toUpperCase()}] ${log.message}`;
      return log.data !== undefined ? `${base}\n${formatData(log.data)}` : base;
    }).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopySuccess(true);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = window.setTimeout(() => {
        setCopySuccess(false);
      }, 2000);
    } catch {
      // Ignore clipboard errors
    }
  };

  return (
    <div ref={rootRef} className="fixed bottom-0 left-0 right-0 z-40" style={{ userSelect: isResizing ? "none" : "auto" }}>
      <div
        onMouseDown={open ? handleResizeStart : undefined}
        className={`w-full border-t border-white/20 ${open ? "cursor-ns-resize" : ""}`}
      >
        <button
          onClick={() => setOpen(!open)}
          className="w-full px-4 py-2 bg-black text-left text-sm font-mono flex items-center justify-between hover:bg-[#111] transition-colors"
        >
          <span className="text-white/60">
            Debug Logs {logs.length > 0 && <span className="text-white/40">({logs.length} entries)</span>}
          </span>
          <span className="text-white/40">{open ? "▼" : "▲"}</span>
        </button>
      </div>
      {open && (
        <div
          ref={panelRef}
          className="bg-black border-t border-white/10 overflow-y-auto font-mono text-xs"
          style={{ height: panelHeight }}
        >
          <div className="sticky top-0 bg-black border-b border-white/10 px-4 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={copyLogs}
                className="text-white/40 hover:text-white/60 transition-colors"
              >
                {copySuccess ? "✓" : "Copy"}
              </button>
              <button
                onClick={() => setLogs([])}
                className="text-white/40 hover:text-white/60 transition-colors"
              >
                Clear
              </button>
              {typeOrder.map((type) => {
                const active = typeFilters[type];
                const styles = active ? typeOptions[type].className : "text-white/30 border-white/10";
                return (
                  <button
                    key={type}
                    onClick={() => setTypeFilters((prev) => ({ ...prev, [type]: !prev[type] }))}
                    className={`px-2 py-1 rounded border text-[10px] uppercase tracking-wide ${styles}`}
                  >
                    {typeOptions[type].label}
                  </button>
                );
              })}
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search logs"
                className="ml-auto bg-black border border-white/10 rounded px-2 py-1 text-[11px] text-white/80 focus:outline-none focus:border-white/30 w-40"
              />
            </div>
          </div>
          <div className="p-4 space-y-2">
            {visibleLogs.length === 0 ? (
              <p className="text-white/30">{logs.length === 0 ? "No logs yet" : "No matching logs"}</p>
            ) : (
              visibleLogs.map((log) => (
                <div key={log.id} className="border-b border-white/5 pb-2">
                  <div className="flex items-start gap-2">
                    <span className="text-white/30 shrink-0">
                      {log.timestamp.toLocaleTimeString()}
                    </span>
                    {log.source && (
                      <span className="text-white/30">[{log.source}]</span>
                    )}
                    {log.type === "request" && (
                      <span className="text-blue-400">
                        {log.message}
                      </span>
                    )}
                    {log.type === "response" && (
                      <span className={log.status && log.status >= 400 ? "text-red-400" : "text-green-400"}>
                        {log.message} <span className="text-white/30">({log.duration}ms)</span>
                      </span>
                    )}
                    {log.type === "error" && (
                      <span className="text-red-400">
                        {log.message}{log.duration != null && <span className="text-white/30"> ({log.duration}ms)</span>}
                      </span>
                    )}
                    {log.type === "info" && (
                      <span className="text-yellow-400">{log.message}</span>
                    )}
                    {log.type === "action" && (
                      <span className="text-violet-400">{log.message}</span>
                    )}
                    {log.type === "lifecycle" && (
                      <span className="text-white/50">{log.message}</span>
                    )}
                  </div>
                  {log.data !== undefined && (
                    <pre className="mt-1 ml-20 text-white/40 overflow-x-auto max-w-full">
                      {formatData(log.data)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
