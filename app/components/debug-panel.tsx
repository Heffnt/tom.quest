"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useConvexConnectionState } from "convex/react";
import { getUsername, useAuth } from "../lib/auth";
import { debug } from "../lib/debug";
import { uiSnapshot, useUIStore } from "../lib/stores/ui-store";

function formatConnectionState(value: unknown): string {
  if (typeof value === "object" && value !== null && "hasInflightRequests" in value) {
    const state = value as { hasInflightRequests?: boolean; isWebSocketConnected?: boolean };
    if (state.hasInflightRequests) return "syncing";
    return state.isWebSocketConnected === false ? "disconnected" : "connected";
  }
  return "unknown";
}

function useViewport() {
  const [viewport, setViewport] = useState("unknown");
  useEffect(() => {
    const update = () => setViewport(`${window.innerWidth}x${window.innerHeight}`);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return viewport;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value);
}

function useDebugVersion(): number {
  const [version, setVersion] = useState(debug.getVersion());
  useEffect(() => debug.subscribe(() => setVersion(debug.getVersion())), []);
  return version;
}

export default function DebugPanel() {
  const pathname = usePathname();
  const { user, role, isTom } = useAuth();
  const connectionState = useConvexConnectionState();
  const viewport = useViewport();
  useDebugVersion();
  const events = debug.getConsoleEvents();
  const debugOpen = useUIStore((state) => state.debugOpen);
  const debugWidth = useUIStore((state) => state.debugWidth);
  const closeDebug = useUIStore((state) => state.closeDebug);
  const setDebugWidth = useUIStore((state) => state.setDebugWidth);
  const authLabel = user ? `${getUsername(user)} (role: ${role}, id: ${user.id})` : "signed out";
  const convexLabel = formatConnectionState(connectionState);

  useEffect(() => {
    debug.installConsoleCapture();
  }, []);

  useEffect(() => {
    debug.registerState("diagnostics", () => ({
      auth: authLabel,
      convex: convexLabel,
      viewport,
      ua: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      ui: compactJson(uiSnapshot()),
    }));
    return () => debug.unregisterState("diagnostics");
  }, [authLabel, convexLabel, viewport]);

  if (!isTom) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => useUIStore.getState().toggleDebug()}
        className="fixed left-3 bottom-3 z-50 rounded-lg border border-accent/50 bg-surface px-3 py-2 text-xs font-mono text-accent shadow-lg hover:bg-surface-alt"
      >
        debug
      </button>
      {debugOpen && (
        <aside
          className="fixed inset-y-0 left-0 z-50 border-r border-border bg-bg/95 backdrop-blur-md shadow-2xl"
          style={{ width: debugWidth }}
        >
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <div className="font-mono text-xs uppercase tracking-[0.2em] text-accent">debug</div>
                <h2 className="text-lg font-semibold">Diagnostics</h2>
              </div>
              <button type="button" onClick={closeDebug} className="text-text-muted hover:text-text">
                close
              </button>
            </div>
            <div className="space-y-4 overflow-auto p-4 text-sm">
              <section>
                <h3 className="mb-2 font-mono text-xs uppercase tracking-[0.16em] text-text-faint">state</h3>
                <dl className="space-y-1 text-text-muted">
                  <div className="flex justify-between gap-3"><dt>route</dt><dd className="font-mono">{pathname}</dd></div>
                  <div className="flex justify-between gap-3"><dt>auth</dt><dd className="font-mono">{role}</dd></div>
                  <div className="flex justify-between gap-3"><dt>convex</dt><dd className="font-mono">{convexLabel}</dd></div>
                  <div className="flex justify-between gap-3"><dt>viewport</dt><dd className="font-mono">{viewport}</dd></div>
                </dl>
              </section>
              <section>
                <h3 className="mb-2 font-mono text-xs uppercase tracking-[0.16em] text-text-faint">events</h3>
                {events.length === 0 ? (
                  <p className="text-text-faint">No captured warnings or errors.</p>
                ) : (
                  <ul className="space-y-2">
                    {events.slice(-5).map((event) => (
                      <li key={`${event.timestamp}-${event.message}`} className="rounded border border-border bg-surface p-2 font-mono text-xs text-text-muted">
                        {event.level}: {event.message}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(debug.snapshot())}
                className="w-full rounded-lg bg-accent px-3 py-2 font-medium text-bg hover:opacity-90"
              >
                Copy diagnostics
              </button>
              <a
                href="https://dashboard.convex.dev/"
                target="_blank"
                rel="noreferrer"
                className="block rounded-lg border border-border px-3 py-2 text-center text-text-muted hover:border-text-muted hover:text-text"
              >
                Open Convex Dashboard
              </a>
              <label className="block text-xs text-text-faint">
                Width
                <input
                  type="range"
                  min={280}
                  max={560}
                  value={debugWidth}
                  onChange={(event) => setDebugWidth(Number(event.target.value))}
                  className="mt-2 w-full"
                />
              </label>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
