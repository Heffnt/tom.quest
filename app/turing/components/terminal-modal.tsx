"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useTuring, useTuringMutation } from "@/app/lib/hooks/use-turing";
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
const VSCODE_TERMINAL_FONT = 'Consolas, "Courier New", monospace';
const TERMINAL_SUCCESS_DEDUPE_MS = 30_000;
const terminalLog = debug.scoped("term");

interface SessionClientsResponse {
  attached_clients: number;
}

type SessionClientsCheckResult =
  | { ok: true; attachedClients: number }
  | { ok: false; errorMessage: string };

interface SessionOutputResponse {
  output: string;
}

interface DetachClientsResponse {
  success: boolean;
  detached_clients: number;
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

async function fetchTunnelUrl(userId: string | undefined): Promise<{ url: string; key: string } | null> {
  const done = terminalLog.req("GET /api/turing/tunnel-url", undefined, { defer: true });
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

async function fetchSessionClients(
  userId: string | undefined,
  sessionName: string,
): Promise<SessionClientsCheckResult> {
  const done = terminalLog.req(
    `GET /api/turing/sessions/${sessionName}/clients`,
    undefined,
    { dedupeSuccessForMs: TERMINAL_SUCCESS_DEDUPE_MS, defer: true },
  );
  const headers: Record<string, string> = {};
  if (userId) headers["x-user-id"] = userId;
  let res: Response;
  try {
    res = await fetch(`/api/turing/sessions/${encodeURIComponent(sessionName)}/clients`, {
      headers,
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Network error";
    done.error(message, { sessionName });
    return { ok: false, errorMessage: "Failed to inspect attached tmux clients" };
  }
  if (!res.ok) {
    const text = await res.text();
    const errorMessage = res.status === 404
      ? "The current Turing API does not support tmux client inspection yet. Restart the Turing API on Turing after pulling the latest code."
      : text || "Failed to inspect attached tmux clients";
    done.error(errorMessage, {
      status: res.status,
      sessionName,
    });
    return { ok: false, errorMessage };
  }
  const data = (await res.json()) as SessionClientsResponse;
  done({ status: res.status, attachedClients: data.attached_clients });
  return { ok: true, attachedClients: data.attached_clients };
}

export default function TerminalModal({ sessionName, allSessions, onClose, onNavigate }: TerminalModalProps) {
  const { user } = useAuth();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerScrolledSessionRef = useRef<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectsRef = useRef(0);
  const [mode, setMode] = useState<"checking" | "viewer" | "interactive">("checking");
  const [attachedClients, setAttachedClients] = useState(0);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const sessionOutput = useTuring<SessionOutputResponse>(
    `/sessions/${encodeURIComponent(sessionName)}/output`,
    mode === "viewer" ? { refreshInterval: 2 } : undefined,
  );
  const detachOthers = useTuringMutation<Record<string, never>, DetachClientsResponse>(
    `/sessions/${encodeURIComponent(sessionName)}/detach-clients`,
  );

  const idx = allSessions.indexOf(sessionName);
  const hasPrev = idx > 0;
  const hasNext = idx >= 0 && idx < allSessions.length - 1;

  useEffect(() => {
    const status = mode === "interactive" ? connectionStatus : mode;
    setTerminalState(sessionName, status);
    return () => {
      setTerminalState(null, "closed");
    };
  }, [connectionStatus, mode, sessionName]);

  useEffect(() => {
    if (mode === "checking") {
      terminalLog.log("checking attached clients", { sessionName });
      return;
    }
    if (mode === "viewer") {
      terminalLog.log("viewer mode active", {
        sessionName,
        attachedClients,
      });
      return;
    }
    terminalLog.log("interactive mode active", { sessionName });
  }, [attachedClients, mode, sessionName]);

  useEffect(() => {
    if (mode === "interactive") return;
    let cancelled = false;
    let timer: number | null = null;
    const checkClients = async () => {
      const next = await fetchSessionClients(user?.id, sessionName);
      if (cancelled) return;
      if (!next.ok) {
        setAttachedClients(0);
        setClientsError(next.errorMessage);
        setMode("viewer");
        timer = window.setTimeout(checkClients, 2000);
        return;
      }
      setClientsError(null);
      setAttachedClients(next.attachedClients);
      if (next.attachedClients === 0) {
        setMode("interactive");
        setConnectionStatus("connecting");
        return;
      }
      setMode("viewer");
      timer = window.setTimeout(checkClients, 2000);
    };
    void checkClients();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [mode, sessionName, user?.id]);

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
      const tunnel = await fetchTunnelUrl(user?.id);
      if (!tunnel || disposed) {
        term.write("\r\n\x1b[31mFailed to fetch tunnel URL\x1b[0m\r\n");
        setConnectionStatus("closed");
        return;
      }
      const keyParam = tunnel.key ? `?key=${encodeURIComponent(tunnel.key)}` : "";
      const wsUrl = tunnel.url.replace(/^http/, "ws") + `/ws/sessions/${encodeURIComponent(sessionName)}${keyParam}`;
      const ws = new WebSocket(wsUrl);
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
  }, [mode, sessionName, user?.id]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);
  const viewerOutput = sessionOutput.data?.output;

  useEffect(() => {
    if (mode !== "interactive") return;
    let cancelled = false;
    let timer: number | null = null;
    const checkForOtherClients = async () => {
      const next = await fetchSessionClients(user?.id, sessionName);
      if (cancelled || !next.ok) {
        timer = window.setTimeout(checkForOtherClients, 2000);
        return;
      }
      if (next.attachedClients > 1) {
        setAttachedClients(next.attachedClients - 1);
        setMode("viewer");
        return;
      }
      timer = window.setTimeout(checkForOtherClients, 2000);
    };
    timer = window.setTimeout(checkForOtherClients, 2000);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [mode, sessionName, user?.id]);

  useEffect(() => {
    if (mode !== "viewer") {
      viewerScrolledSessionRef.current = null;
      return;
    }
    if (viewerOutput === undefined) return;
    if (viewerScrolledSessionRef.current === sessionName) return;
    requestAnimationFrame(() => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      viewer.scrollTop = viewer.scrollHeight;
      viewerScrolledSessionRef.current = sessionName;
    });
  }, [mode, sessionName, viewerOutput]);

  const status = mode === "checking" ? "checking" : mode === "viewer" ? "view-only" : connectionStatus;
  const statusClass = mode === "checking"
    ? "text-yellow-400"
    : mode === "viewer"
      ? "text-amber-300"
      : connectionStatus === "open"
        ? "text-green-400"
        : connectionStatus === "connecting"
          ? "text-yellow-400"
          : "text-error";

  const handleDetachOthers = async () => {
    const res = await detachOthers.trigger({});
    if (res?.success) {
      setMode("checking");
      setAttachedClients(0);
      setClientsError(null);
    }
  };

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
            {mode === "viewer" && attachedClients > 0 && (
              <button
                type="button"
                onClick={handleDetachOthers}
                disabled={detachOthers.loading}
                className="text-xs px-2 py-1 rounded border border-amber-500/40 text-amber-300 hover:bg-amber-500/10 disabled:opacity-50"
              >
                {detachOthers.loading ? "Detaching..." : "Detach other clients"}
              </button>
            )}
            <button type="button" onClick={onClose} aria-label="Close"
              className="text-text-muted hover:text-text">✕</button>
          </div>
        </div>
        {mode === "viewer" ? (
          <div className="flex-1 min-h-0 bg-black flex flex-col">
            <div className="px-3 py-2 border-b border-border text-xs text-text-muted">
              {clientsError
                ? "tmux client inspection is unavailable right now."
                : attachedClients > 1
                  ? `${attachedClients} tmux clients are attached, so tom.quest is staying view-only to avoid resizing the shared session.`
                  : attachedClients === 1
                    ? "Another tmux client is attached, so tom.quest is staying view-only to avoid resizing the shared session."
                    : "Checking shared-session state."}
            </div>
            {clientsError && (
              <div className="px-3 py-2 text-xs text-error border-b border-border">
                {clientsError}
              </div>
            )}
            {detachOthers.error && (
              <div className="px-3 py-2 text-xs text-error border-b border-border">
                {detachOthers.error}
              </div>
            )}
            <div ref={viewerRef} className="flex-1 overflow-auto p-3">
              <pre className="text-[13px] leading-5 text-[#d4d4d4] font-mono whitespace-pre-wrap break-words">
                {sessionOutput.data?.output ?? ""}
              </pre>
            </div>
          </div>
        ) : mode === "checking" ? (
          <div className="flex-1 bg-black flex items-center justify-center text-sm text-text-muted">
            Checking attached tmux clients...
          </div>
        ) : (
          <div ref={containerRef} className="flex-1 bg-black p-2 overflow-hidden" />
        )}
      </div>
    </div>
  );
}
