"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useTuring } from "@/app/lib/hooks/use-turing";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalModalProps {
  sessionName: string;
  allSessions: string[];
  onClose: () => void;
  onNavigate: (sessionName: string) => void;
  allowInteractive: boolean;
}

const MAX_RECONNECTS = 3;
const VSCODE_TERMINAL_FONT = 'Consolas, "Courier New", monospace';
const terminalLog = debug.scoped("term");

interface SessionOutputResponse {
  output: string;
}

const terminalStateSnapshot: Record<string, unknown> = {
  status: "closed",
  sessionName: "none",
};

debug.registerState("terminal", () => terminalStateSnapshot);

function setTerminalState(sessionName: string | null, status: string) {
  terminalStateSnapshot.sessionName = sessionName ?? "none";
  terminalStateSnapshot.status = status;
}

async function fetchWsCredentials(
  token: string | null,
  sessionName: string,
): Promise<{ wsUrl: string; token: string } | null> {
  const done = terminalLog.req("GET /api/turing/ws-credentials", { sessionName }, { defer: true });
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const url = `/api/turing/ws-credentials?session=${encodeURIComponent(sessionName)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    done.error(message);
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    done.error(text || "Failed to fetch WS credentials", { status: res.status });
    return null;
  }
  const data = await res.json();
  if (!data.wsUrl || !data.token) {
    done.error("Missing wsUrl or token", { status: res.status });
    return null;
  }
  done({ status: res.status });
  return { wsUrl: data.wsUrl, token: data.token };
}

export default function TerminalModal({
  sessionName,
  allSessions,
  onClose,
  onNavigate,
  allowInteractive,
}: TerminalModalProps) {
  const { token } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLPreElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectsRef = useRef(0);
  const viewerScrolledSessionRef = useRef<string | null>(null);
  const [mode, setMode] = useState<"viewer" | "interactive">("viewer");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const sessionOutput = useTuring<SessionOutputResponse>(
    `/sessions/${encodeURIComponent(sessionName)}/output`,
    mode === "viewer" ? { refreshInterval: 2 } : undefined,
  );

  const idx = allSessions.indexOf(sessionName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < allSessions.length - 1;

  useEffect(() => {
    const status = mode === "interactive" ? connectionStatus : "viewer";
    setTerminalState(sessionName, status);
    return () => {
      setTerminalState(null, "closed");
    };
  }, [connectionStatus, mode, sessionName]);

  useEffect(() => {
    if (mode === "viewer") {
      terminalLog.log("viewer mode active", { sessionName });
      return;
    }
    terminalLog.log("interactive mode active", { sessionName });
  }, [mode, sessionName]);

  useEffect(() => {
    if (mode !== "interactive") return;
    let disposed = false;

    const term = new Terminal({
      fontFamily: VSCODE_TERMINAL_FONT,
      fontSize: 13,
      theme: { background: "#000000", foreground: "#d4d4d4" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    termRef.current = term;
    const fitTerminal = () => {
      fit.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    if (containerRef.current) {
      term.open(containerRef.current);
      requestAnimationFrame(() => {
        if (!disposed) fitTerminal();
      });
    }
    if (typeof document !== "undefined" && "fonts" in document) {
      void document.fonts.ready.then(() => {
        if (!disposed) fitTerminal();
      });
    }
    const resizeObserver = containerRef.current
      ? new ResizeObserver(() => {
          if (!disposed) fitTerminal();
        })
      : null;
    if (resizeObserver && containerRef.current) resizeObserver.observe(containerRef.current);

    const connect = async () => {
      if (disposed) return;
      setConnectionStatus("connecting");
      terminalLog.log("connecting", { sessionName });
      const creds = await fetchWsCredentials(token, sessionName);
      if (!creds || disposed) {
        term.write("\r\n\x1b[31mFailed to fetch WS credentials\x1b[0m\r\n");
        setConnectionStatus("closed");
        return;
      }
      fitTerminal();
      const params = new URLSearchParams();
      params.set("key", creds.token);
      params.set("cols", String(term.cols || 80));
      params.set("rows", String(term.rows || 24));
      const wsFullUrl = `${creds.wsUrl}/ws/sessions/${encodeURIComponent(sessionName)}?${params.toString()}`;
      const ws = new WebSocket(wsFullUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("open");
        reconnectsRef.current = 0;
        terminalLog.log("socket open", { sessionName });
        fitTerminal();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term.write(e.data);
        else term.write(new Uint8Array(e.data));
      };
      ws.onclose = (event) => {
        if (disposed) return;
        setConnectionStatus("closed");
        terminalLog.error("socket closed", {
          sessionName,
          code: event.code,
          reason: event.reason || "none",
        });
        if (reconnectsRef.current < MAX_RECONNECTS) {
          reconnectsRef.current += 1;
          term.write(`\r\n\x1b[33mConnection lost — reconnecting (${reconnectsRef.current}/${MAX_RECONNECTS})…\x1b[0m\r\n`);
          terminalLog.log("reconnecting", {
            sessionName,
            attempt: reconnectsRef.current,
            maxAttempts: MAX_RECONNECTS,
          });
          setTimeout(connect, 2000);
        } else {
          term.write("\r\n\x1b[31mConnection closed\x1b[0m\r\n");
        }
      };
      ws.onerror = () => {
        terminalLog.error("socket error", { sessionName });
      };
    };

    const sub = term.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data);
    });

    connect();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      sub.dispose();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
      terminalLog.log("interactive session closed", { sessionName });
    };
  }, [mode, sessionName, token]);

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
          <div ref={containerRef} className="flex-1 bg-black p-2 overflow-hidden" />
        )}
      </div>
    </div>
  );
}
