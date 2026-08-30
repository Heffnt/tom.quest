"use client";

// The single place the interactive Turing terminal is implemented. Both
// surfaces that show a terminal — the modal over the jobs table
// (app/turing/components/terminal-modal.tsx) and the full-page terminal
// (app/turing/terminal/[session]/terminal-client.tsx) — render
// app/turing/components/interactive-terminal.tsx, which calls
// startTerminalSession below. Nothing else may construct an xterm Terminal or
// fetch WebSocket credentials; scripts/check-heavy-libs.mjs fails the build if
// another file under app/ imports @xterm, and
// app/turing/lib/terminal-session.test.ts fails if either surface grows its own
// copy of the credential fetch, the reconnect limit or the font.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { debug } from "@/app/lib/debug";

export const MAX_RECONNECTS = 3;
export const RECONNECT_DELAY_MS = 2000;
export const VSCODE_TERMINAL_FONT = 'Consolas, "Courier New", monospace';
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_THEME = { background: "#000000", foreground: "#d4d4d4" } as const;

/** Which screen the session is running on. Only used to label debug lines. */
export type TerminalSurface = "modal" | "page";

export type TerminalConnectionStatus = "connecting" | "open" | "closed";

export type WsCredentials = { wsUrl: string; token: string };

const terminalLog = debug.scoped("term");

const terminalStateSnapshot: Record<string, unknown> = {
  status: "closed",
  sessionName: "none",
  surface: "none",
};

debug.registerState("terminal", () => terminalStateSnapshot);

/**
 * Publish what the terminal is doing to the Tom-only diagnostic panel. The
 * interactive session calls this itself; a surface calls it directly only for
 * states that exist outside a session, such as the modal's view-only mode.
 */
export function setTerminalState(sessionName: string | null, status: string, surface?: TerminalSurface) {
  terminalStateSnapshot.sessionName = sessionName ?? "none";
  terminalStateSnapshot.status = status;
  terminalStateSnapshot.surface = surface ?? "none";
}

export async function fetchWsCredentials(
  token: string | null,
  sessionName: string,
  surface: TerminalSurface,
): Promise<WsCredentials | null> {
  const done = terminalLog.req(
    "GET /api/turing/ws-credentials",
    { sessionName, surface },
    { defer: true },
  );
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

export type StartTerminalSessionOptions = {
  /** Element the terminal is drawn into and sized against. */
  container: HTMLElement;
  sessionName: string;
  /** Convex auth token, forwarded as a bearer header on the credential fetch. */
  token: string | null;
  surface: TerminalSurface;
  onStatusChange?: (status: TerminalConnectionStatus) => void;
};

/**
 * Open an xterm terminal in `container`, connect it to the session's WebSocket,
 * keep it sized to the container, and reconnect up to MAX_RECONNECTS times when
 * the socket drops. Returns the teardown function: call it once, and every
 * timer, observer and socket this started is released.
 */
export function startTerminalSession({
  container,
  sessionName,
  token,
  surface,
  onStatusChange,
}: StartTerminalSessionOptions): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let reconnects = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const term = new Terminal({
    fontFamily: VSCODE_TERMINAL_FONT,
    fontSize: TERMINAL_FONT_SIZE,
    theme: { ...TERMINAL_THEME },
    cursorBlink: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());

  const setStatus = (status: TerminalConnectionStatus) => {
    if (disposed) return;
    setTerminalState(sessionName, status, surface);
    onStatusChange?.(status);
  };

  const fitTerminal = () => {
    if (disposed) return;
    fit.fit();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    }
  };

  term.open(container);
  requestAnimationFrame(fitTerminal);
  if (typeof document !== "undefined" && "fonts" in document) {
    void document.fonts.ready.then(fitTerminal);
  }
  const resizeObserver =
    typeof ResizeObserver !== "undefined" ? new ResizeObserver(fitTerminal) : null;
  resizeObserver?.observe(container);

  const connect = async () => {
    if (disposed) return;
    setStatus("connecting");
    terminalLog.log("connecting", { sessionName, surface });
    const creds = await fetchWsCredentials(token, sessionName, surface);
    if (disposed) return;
    if (!creds) {
      term.write("\r\n\x1b[31mFailed to fetch WS credentials\x1b[0m\r\n");
      setStatus("closed");
      return;
    }
    fitTerminal();
    const params = new URLSearchParams();
    params.set("key", creds.token);
    params.set("cols", String(term.cols || 80));
    params.set("rows", String(term.rows || 24));
    const wsFullUrl = `${creds.wsUrl}/ws/sessions/${encodeURIComponent(sessionName)}?${params.toString()}`;
    const socket = new WebSocket(wsFullUrl);
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = () => {
      reconnects = 0;
      terminalLog.log("socket open", { sessionName, surface });
      setStatus("open");
      fitTerminal();
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") term.write(event.data);
      else term.write(new Uint8Array(event.data));
    };
    socket.onclose = (event) => {
      if (disposed) return;
      setStatus("closed");
      terminalLog.error("socket closed", {
        sessionName,
        surface,
        code: event.code,
        reason: event.reason || "none",
      });
      if (reconnects < MAX_RECONNECTS) {
        reconnects += 1;
        term.write(
          `\r\n\x1b[33mConnection lost — reconnecting (${reconnects}/${MAX_RECONNECTS})…\x1b[0m\r\n`,
        );
        terminalLog.log("reconnecting", {
          sessionName,
          surface,
          attempt: reconnects,
          maxAttempts: MAX_RECONNECTS,
        });
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      } else {
        term.write("\r\n\x1b[31mConnection closed\x1b[0m\r\n");
      }
    };
    socket.onerror = () => {
      terminalLog.error("socket error", { sessionName, surface });
    };
  };

  const dataSubscription = term.onData((data) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  });

  void connect();

  return () => {
    disposed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    resizeObserver?.disconnect();
    dataSubscription.dispose();
    ws?.close();
    ws = null;
    term.dispose();
    setTerminalState(null, "closed");
    terminalLog.log("interactive session closed", { sessionName, surface });
  };
}
