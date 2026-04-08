"use client";

import { useState, useEffect, useRef } from "react";

interface Props {
  bridgeFetch: (path: string) => Promise<Response>;
}

export default function LogViewer({ bridgeFetch }: Props) {
  const [logs, setLogs] = useState("");
  const [logFile, setLogFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [lines, setLines] = useState(200);
  const endRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async (numLines: number) => {
    setLoading(true);
    try {
      const res = await bridgeFetch(`/logs?lines=${numLines}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.content || "");
        setLogFile(data.file || null);
        setLines(numLines);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => {
    if (collapsed) return;
    fetchLogs(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  useEffect(() => {
    if (!collapsed && logs) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, collapsed]);

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Gateway Logs</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5">
          <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
            {logFile && (
              <span className="text-[10px] text-white/20 font-mono truncate">{logFile}</span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => fetchLogs(lines)}
                disabled={loading}
                className="text-[10px] px-2 py-1 rounded border border-white/10 text-white/40 hover:text-white/70 transition-colors"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
              <button
                onClick={() => fetchLogs(lines + 500)}
                disabled={loading}
                className="text-[10px] px-2 py-1 rounded border border-white/10 text-white/40 hover:text-white/70 transition-colors"
              >
                Load More
              </button>
            </div>
          </div>
          <pre className="px-4 py-3 text-[11px] text-white/50 font-mono whitespace-pre-wrap break-all max-h-96 overflow-y-auto leading-relaxed">
            {logs || (loading ? "Loading logs…" : "No logs found")}
            <div ref={endRef} />
          </pre>
        </div>
      )}
    </div>
  );
}
