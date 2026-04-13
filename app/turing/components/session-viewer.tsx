"use client";

import { useEffect, useRef, useState } from "react";
import { useTuring } from "@/app/lib/hooks/use-turing";

interface SessionViewerProps {
  sessionName: string;
  allSessions: string[];
  onClose: () => void;
  onNavigate: (sessionName: string) => void;
}

export default function SessionViewer({ sessionName, allSessions, onClose, onNavigate }: SessionViewerProps) {
  const [autoRefresh, setAutoRefresh] = useState(true);
  const { data, loading, error } = useTuring<{ output: string }>(
    `/sessions/${encodeURIComponent(sessionName)}/output`,
    autoRefresh ? { refreshInterval: 2 } : undefined,
  );
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [data]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const idx = allSessions.indexOf(sessionName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < allSessions.length - 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={`Session: ${sessionName}`}
        className="relative bg-surface border border-border rounded-lg w-full max-w-5xl h-[90vh] flex flex-col animate-settle">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => hasPrev && onNavigate(allSessions[idx - 1])}
              disabled={!hasPrev}
              className="text-text-muted hover:text-text disabled:opacity-30">◀</button>
            <span className="font-mono text-sm">{sessionName}</span>
            <span className="text-text-faint text-xs">{idx + 1}/{allSessions.length}</span>
            <button type="button" onClick={() => hasNext && onNavigate(allSessions[idx + 1])}
              disabled={!hasNext}
              className="text-text-muted hover:text-text disabled:opacity-30">▶</button>
            <label className="ml-3 text-xs text-text-muted flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)} className="accent-accent" />
              Auto-refresh
            </label>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-text-muted hover:text-text">✕</button>
        </div>
        <pre ref={preRef}
          className="flex-1 bg-black text-green-400 font-mono text-xs p-3 overflow-auto whitespace-pre-wrap">
          {loading && !data && "Loading…"}
          {error && <span className="text-error">{error}</span>}
          {data?.output}
        </pre>
      </div>
    </div>
  );
}
