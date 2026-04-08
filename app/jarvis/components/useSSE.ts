"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface GatewayState {
  ok: boolean;
  uptimeMs: number | null;
  failing: string[];
}

export interface ChannelsState {
  ready: boolean;
  failing: string[];
}

export interface SessionSummary {
  key: string;
  sessionId: string;
  updatedAt: number;
  chatType: string;
  origin: { label?: string; provider?: string; surface?: string; from?: string; to?: string };
  compactionCount: number;
  authProfileOverride?: string;
}

export interface CronSummary {
  id: string;
  name: string;
  enabled: boolean;
  schedule: string;
  tz: string;
  nextRunAtMs: number | null;
  lastRunAtMs: number | null;
  lastRunStatus: string | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  lastErrorReason: string | null;
  lastDeliveryStatus: string | null;
}

export interface SSEState {
  gateway: GatewayState;
  channels: ChannelsState;
  sessions: SessionSummary[];
  cron: CronSummary[];
  bridgeUptimeMs: number;
}

const EMPTY_STATE: SSEState = {
  gateway: { ok: false, uptimeMs: null, failing: [] },
  channels: { ready: false, failing: [] },
  sessions: [],
  cron: [],
  bridgeUptimeMs: 0,
};

export function useSSE(bridgeUrl: string | null) {
  const [state, setState] = useState<SSEState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (!bridgeUrl) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    const url = new URL("/stream", bridgeUrl);
    (async () => {
      try {
        const res = await fetch(url.toString(), {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          setConnected(false);
          scheduleReconnect();
          return;
        }
        setConnected(true);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed.startsWith("data: ")) {
              try {
                const data = JSON.parse(trimmed.slice(6));
                setState(data);
              } catch { /* skip malformed */ }
            }
          }
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setConnected(false);
          scheduleReconnect();
        }
      }
    })();

    function scheduleReconnect() {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      reconnectTimer.current = setTimeout(() => connect(), 5000);
    }
  }, [bridgeUrl]);

  useEffect(() => {
    connect();
    return () => {
      controllerRef.current?.abort();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connect]);

  return { state, connected };
}
