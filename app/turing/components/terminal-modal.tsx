"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface TerminalModalProps {
  sessionName: string;
  allSessions: string[];
  onClose: () => void;
  onNavigate: (sessionName: string) => void;
}

const MAX_RECONNECTS = 3;

async function fetchTunnelUrl(userId: string | undefined): Promise<{ url: string; key: string } | null> {
  const headers: Record<string, string> = {};
  if (userId) headers["x-user-id"] = userId;
  const res = await fetch("/api/turing/tunnel-url", { headers });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.url) return null;
  return { url: data.url, key: data.key || "" };
}

export default function TerminalModal({ sessionName, allSessions, onClose, onNavigate }: TerminalModalProps) {
  const { user } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectsRef = useRef(0);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  const idx = allSessions.indexOf(sessionName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < allSessions.length - 1;

  useEffect(() => {
    let disposed = false;

    const term = new Terminal({
      fontFamily: "var(--font-ibm-plex-mono), monospace",
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
      setStatus("connecting");
      const tunnel = await fetchTunnelUrl(user?.id);
      if (!tunnel || disposed) {
        term.write("\r\n\x1b[31mFailed to fetch tunnel URL\x1b[0m\r\n");
        setStatus("closed");
        return;
      }
      const keyParam = tunnel.key ? `?key=${encodeURIComponent(tunnel.key)}` : "";
      const wsUrl = tunnel.url.replace(/^http/, "ws") + `/ws/sessions/${encodeURIComponent(sessionName)}${keyParam}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("open");
        reconnectsRef.current = 0;
        fitTerminal();
      };
      ws.onmessage = (e) => {
        if (typeof e.data === "string") term.write(e.data);
        else term.write(new Uint8Array(e.data));
      };
      ws.onclose = () => {
        if (disposed) return;
        setStatus("closed");
        if (reconnectsRef.current < MAX_RECONNECTS) {
          reconnectsRef.current += 1;
          term.write(`\r\n\x1b[33mConnection lost — reconnecting (${reconnectsRef.current}/${MAX_RECONNECTS})…\x1b[0m\r\n`);
          setTimeout(connect, 2000);
        } else {
          term.write("\r\n\x1b[31mConnection closed\x1b[0m\r\n");
        }
      };
      ws.onerror = () => { /* close handler runs afterward */ };
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
    };
  }, [sessionName, user?.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

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
            <span className={`ml-2 text-xs ${status === "open" ? "text-green-400" : status === "connecting" ? "text-yellow-400" : "text-error"}`}>
              {status}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"
            className="text-text-muted hover:text-text">✕</button>
        </div>
        <div ref={containerRef} className="flex-1 bg-black p-2 overflow-hidden" />
      </div>
    </div>
  );
}
