"use client";

import { useEffect, useRef, useState } from "react";
import { DebugLogEntry } from "../lib/debug";

export default function DebugTerminal() {
  const [logs, setLogs] = useState<DebugLogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<DebugLogEntry>).detail;
      setLogs((prev) => [...prev, detail].slice(-200));
    };
    window.addEventListener("tomquest-debug", handler as EventListener);
    return () => {
      window.removeEventListener("tomquest-debug", handler as EventListener);
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current && open) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [logs, open]);
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const copyLogs = async () => {
    const text = logs.map((log) => {
      const time = log.timestamp.toLocaleTimeString();
      const base = `${time} [${log.type.toUpperCase()}] ${log.message}`;
      return log.data ? `${base}\n${JSON.stringify(log.data, null, 2)}` : base;
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
    <div className="fixed bottom-0 left-0 right-0 z-40">
      <div className="w-full border-t border-white/20">
        <button
          onClick={() => setOpen(!open)}
          className="w-full px-4 py-2 bg-black text-left text-sm font-mono flex items-center justify-between hover:bg-[#111] transition-colors"
        >
          <span className="text-white/60">
            Debug Terminal {logs.length > 0 && <span className="text-white/40">({logs.length} entries)</span>}
          </span>
          <span className="text-white/40">{open ? "▼" : "▲"}</span>
        </button>
      </div>
      {open && (
        <div
          ref={terminalRef}
          className="bg-black border-t border-white/10 overflow-y-auto font-mono text-xs"
          style={{ height: 240 }}
        >
          <div className="sticky top-0 bg-black border-b border-white/10 px-4 py-2 flex justify-between items-center">
            <span className="text-white/40">Client Debug Log</span>
            <div className="flex gap-3">
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
            </div>
          </div>
          <div className="p-4 space-y-2">
            {logs.length === 0 ? (
              <p className="text-white/30">No logs yet</p>
            ) : (
              logs.map((log) => (
                <div key={log.id} className="border-b border-white/5 pb-2">
                  <div className="flex items-start gap-2">
                    <span className="text-white/30 shrink-0">
                      {log.timestamp.toLocaleTimeString()}
                    </span>
                    <span
                      className={
                        log.type === "error"
                          ? "text-red-400"
                          : log.type === "request"
                          ? "text-blue-400"
                          : log.type === "response"
                          ? "text-green-400"
                          : "text-yellow-400"
                      }
                    >
                      {log.message}
                    </span>
                  </div>
                  {log.data !== undefined && (
                    <pre className="mt-1 ml-16 text-white/40 overflow-x-auto max-w-full">
                      {JSON.stringify(log.data, null, 2) as string}
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
