"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { debug } from "@/app/lib/debug";
import { useTuring } from "@/app/lib/hooks/use-turing";
import InteractiveTerminal from "./interactive-terminal";
import { setTerminalState, type TerminalConnectionStatus } from "@/app/turing/lib/terminal-session";

interface TerminalModalProps {
  sessionName: string;
  allSessions: string[];
  onClose: () => void;
  onNavigate: (sessionName: string) => void;
  allowInteractive: boolean;
}

const terminalLog = debug.scoped("term");

interface SessionOutputResponse {
  output: string;
}

export default function TerminalModal({
  sessionName,
  allSessions,
  onClose,
  onNavigate,
  allowInteractive,
}: TerminalModalProps) {
  const viewerRef = useRef<HTMLPreElement>(null);
  const viewerScrolledSessionRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"viewer" | "interactive">("viewer");
  const [connectionStatus, setConnectionStatus] = useState<TerminalConnectionStatus>("connecting");
  const sessionOutput = useTuring<SessionOutputResponse>(
    `/sessions/${encodeURIComponent(sessionName)}/output`,
    mode === "viewer" ? { refreshInterval: 2 } : undefined,
  );

  const idx = allSessions.indexOf(sessionName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < allSessions.length - 1;

  // Interactive statuses are published to the diagnostic panel by the terminal
  // session itself; view-only has no session, so the modal reports it.
  useEffect(() => {
    if (mode !== "viewer") return;
    setTerminalState(sessionName, "viewer", "modal");
    terminalLog.log("viewer mode active", { sessionName, surface: "modal" });
    return () => {
      setTerminalState(null, "closed");
    };
  }, [mode, sessionName]);

  useEffect(() => {
    if (mode !== "interactive") return;
    setConnectionStatus("connecting");
    terminalLog.log("interactive mode active", { sessionName, surface: "modal" });
  }, [mode, sessionName]);

  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    if (mode !== "viewer") return;
    const viewerOutput = sessionOutput.data?.output;
    if (viewerOutput === undefined) return;
    if (viewerScrolledSessionRef.current === sessionName) return;
    requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.scrollTop = viewer.scrollHeight;
      viewerScrolledSessionRef.current = sessionName;
    });
  }, [mode, sessionName, sessionOutput.data?.output]);

  const handleStatusChange = useCallback((status: TerminalConnectionStatus) => {
    setConnectionStatus(status);
  }, []);

  const status = mode === "viewer" ? "view-only" : connectionStatus === "open" ? "interactive" : connectionStatus;
  const statusClass = mode === "viewer"
    ? "text-amber-300"
    : connectionStatus === "open"
      ? "text-green-400"
      : connectionStatus === "connecting"
        ? "text-amber-300"
        : "text-error";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={`Terminal: ${sessionName}`}
        className="relative bg-surface border border-border rounded-lg w-full max-w-5xl h-[90vh] flex flex-col animate-settle">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => hasPrev && onNavigate(allSessions[idx - 1])}
              disabled={!hasPrev}
              className="text-text-muted hover:text-text disabled:opacity-30">◀</button>
            <span className="font-mono text-sm">{sessionName}</span>
            <span className="text-text-faint text-xs">
              {idx + 1}/{allSessions.length}
            </span>
            <button type="button" onClick={() => hasNext && onNavigate(allSessions[idx + 1])}
              disabled={!hasNext}
              className="text-text-muted hover:text-text disabled:opacity-30">▶</button>
            <span className={`ml-2 text-xs ${statusClass}`}>
              {status}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mode === "viewer" && allowInteractive && (
              <button
                type="button"
                onClick={() => setMode("interactive")}
                className="text-xs px-2.5 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
              >
                Open Terminal
              </button>
            )}
            {mode === "interactive" && (
              <button
                type="button"
                onClick={() => setMode("viewer")}
                className="text-xs px-2.5 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
              >
                View Only
              </button>
            )}
            <button
              type="button"
              onClick={() => window.open(
                `/turing/terminal/${encodeURIComponent(sessionName)}${allowInteractive ? "?mode=interactive" : ""}`,
                "_blank",
              )}
              className="text-xs px-2.5 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
            >
              New Tab ↗
            </button>
            <button type="button" onClick={onClose} aria-label="Close"
              className="text-text-muted hover:text-text">✕</button>
          </div>
        </div>
        {mode === "viewer" ? (
          <pre
            ref={viewerRef}
            className="flex-1 bg-black text-[#d4d4d4] font-mono text-[13px] leading-5 p-4 overflow-auto whitespace-pre-wrap break-words"
          >
            {sessionOutput.data?.output ?? (sessionOutput.error ? sessionOutput.error : "Fetching tmux session output…")}
          </pre>
        ) : (
          <InteractiveTerminal
            sessionName={sessionName}
            surface="modal"
            className="flex-1 bg-black p-2 overflow-hidden"
            onStatusChange={handleStatusChange}
          />
        )}
      </div>
    </div>
  );
}
