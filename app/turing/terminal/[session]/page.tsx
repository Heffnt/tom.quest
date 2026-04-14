"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useTuring } from "@/app/lib/hooks/use-turing";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

interface SessionOutputResponse {
  output: string;
}

const MAX_RECONNECTS = 3;
const VSCODE_TERMINAL_FONT = 'Consolas, "Courier New", monospace';
const terminalPageLog = debug.scoped("term.page");

async function fetchTunnelUrl(userId: string | undefined): Promise<{ url: string; key: string } | null> {
  const done = terminalPageLog.req("GET /api/turing/tunnel-url", undefined, { defer: true });
  const headers: Record<string, string> = {};
  if (userId) headers["x-user-id"] = userId;
  let res: Response;
  try {
    res = await fetch("/api/turing/tunnel-url", { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    done.error(message);
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    done.error(text || "Failed to fetch tunnel URL", { status: res.status });
    return null;
  }
  const data = await res.json();
  if (!data.url) {
    done.error("Missing tunnel URL", { status: res.status });
    return null;
  }
  done({ status: res.status });
  return { url: data.url, key: data.key || "" };
}

export default function TuringTerminalPage() {
  const params = useParams<{ session: string }>();
  const rawSession = params.session;
  const sessionName = decodeURIComponent(Array.isArray(rawSession) ? rawSession[0] : rawSession ?? "");
  const { user, isTom } = useAuth();
  const [mode, setMode] = useState<"viewer" | "interactive">("viewer");
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const viewerRef = useRef<HTMLPreElement>(null);
  const viewerScrolledRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectsRef = useRef(0);
  const sessionOutput = useTuring<SessionOutputResponse>(
    `/sessions/${encodeURIComponent(sessionName)}/output`,
    mode === "viewer" ? { refreshInterval: 2 } : undefined,
  );

  useEffect(() => {
    if (mode !== "viewer") return;
    const output = sessionOutput.data?.output;
    if (output === undefined || viewerScrolledRef.current) return;
    requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.scrollTop = viewer.scrollHeight;
      viewerScrolledRef.current = true;
    });
  }, [mode, sessionOutput.data?.output]);

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
      const tunnel = await fetchTunnelUrl(user?.id);
      if (!tunnel || disposed) {
        term.write("\r\n\x1b[31mFailed to fetch tunnel URL\x1b[0m\r\n");
        setConnectionStatus("closed");
        return;
      }
      fitTerminal();
      const params = new URLSearchParams();
      if (tunnel.key) params.set("key", tunnel.key);
      params.set("cols", String(term.cols || 80));
      params.set("rows", String(term.rows || 24));
      const query = params.toString();
      const wsUrl = tunnel.url.replace(/^http/, "ws")
        + `/ws/sessions/${encodeURIComponent(sessionName)}${query ? `?${query}` : ""}`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setConnectionStatus("open");
        reconnectsRef.current = 0;
        fitTerminal();
      };
      ws.onmessage = event => {
        if (typeof event.data === "string") term.write(event.data);
        else term.write(new Uint8Array(event.data));
      };
      ws.onclose = () => {
        if (disposed) return;
        setConnectionStatus("closed");
        if (reconnectsRef.current < MAX_RECONNECTS) {
          reconnectsRef.current += 1;
          term.write(`\r\n\x1b[33mConnection lost — reconnecting (${reconnectsRef.current}/${MAX_RECONNECTS})…\x1b[0m\r\n`);
          setTimeout(connect, 2000);
        } else {
          term.write("\r\n\x1b[31mConnection closed\x1b[0m\r\n");
        }
      };
    };

    const sub = term.onData(data => {
      if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data);
    });

    void connect();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      sub.dispose();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
      wsRef.current = null;
    };
  }, [mode, sessionName, user?.id]);

  const status = mode === "viewer" ? "view-only" : connectionStatus === "open" ? "interactive" : connectionStatus;
  const statusClass = mode === "viewer"
    ? "text-amber-300"
    : connectionStatus === "open"
      ? "text-green-400"
      : connectionStatus === "connecting"
        ? "text-amber-300"
        : "text-error";

  return (
    <div className="max-w-6xl mx-auto px-6 py-8">
      <div className="border border-border rounded-lg overflow-hidden bg-surface/40">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-3">
            <Link href="/turing" className="text-text-muted hover:text-text text-sm">
              ← Back
            </Link>
            <span className="font-mono text-sm text-text">{sessionName}</span>
            <span className={`text-xs ${statusClass}`}>{status}</span>
          </div>
          {mode === "viewer" && isTom && (
            <button
              onClick={() => setMode("interactive")}
              className="text-xs px-2.5 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
            >
              Open Terminal
            </button>
          )}
        </div>

        {mode === "viewer" ? (
          <pre
            ref={viewerRef}
            className="h-[85vh] bg-black text-[#d4d4d4] font-mono text-[13px] leading-5 p-4 overflow-auto whitespace-pre-wrap break-words"
          >
            {sessionOutput.data?.output ?? (sessionOutput.error ? sessionOutput.error : "Loading…")}
          </pre>
        ) : (
          <div ref={containerRef} className="h-[85vh] bg-black p-2 overflow-hidden" />
        )}
      </div>
    </div>
  );
}
