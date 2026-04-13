"use client";

import { useEffect, useMemo, useState } from "react";
import { useGateway } from "./useGateway";

function formatDuration(ms: number | null) {
  if (ms === null) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

type HealthSnapshot = {
  ok?: boolean;
  durationMs?: number;
  defaultAgentId?: string;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channels?: Record<string, { linked?: boolean; configured?: boolean }>;
  sessions?: { count?: number };
};

export default function StatusBar() {
  const { connected, error, health, pairingRequired, reconnect, subscribe } = useGateway();
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void health().then((nextSnapshot) => {
      if (!cancelled) {
        setSnapshot(nextSnapshot as HealthSnapshot);
      }
    }).catch(() => {});
    const unsubscribe = subscribe("health", (payload) => {
      if (!cancelled) {
        setSnapshot(payload as HealthSnapshot);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [connected, health, subscribe]);

  const failingChannels = useMemo(() => {
    if (!snapshot?.channels) return [];
    return Object.entries(snapshot.channels)
      .filter(([, channel]) => channel.configured === false || channel.linked === false)
      .map(([channelId]) => snapshot.channelLabels?.[channelId] ?? channelId);
  }, [snapshot]);

  return (
    <div className="flex items-center justify-between px-4 py-3 border border-white/10 rounded-lg bg-white/[0.02] flex-wrap gap-y-2">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              connected && snapshot?.ok !== false ? "bg-green-400 animate-pulse" : pairingRequired ? "bg-yellow-400" : "bg-red-400"
            }`}
          />
          <span className="text-sm font-medium">
            Gateway {pairingRequired ? "Pairing Required" : connected ? "Online" : "Offline"}
          </span>
        </div>
        <span className="text-xs text-white/40">
          probe {formatDuration(snapshot?.durationMs ?? null)}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              failingChannels.length === 0 ? "bg-green-400" : "bg-yellow-400"
            }`}
          />
          <span className="text-xs text-white/50">
            Channels {failingChannels.length === 0 ? "Ready" : "Degraded"}
          </span>
        </div>
        {typeof snapshot?.sessions?.count === "number" && (
          <span className="text-xs text-white/40">
            Sessions {snapshot.sessions.count}
          </span>
        )}
        {snapshot?.defaultAgentId && (
          <span className="text-xs text-white/40 font-mono">
            Agent {snapshot.defaultAgentId}
          </span>
        )}
        {failingChannels.length > 0 && (
          <span className="text-xs text-red-400">
            {failingChannels.join(", ")} failing
          </span>
        )}
        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>
      <button
        onClick={reconnect}
        className="text-xs px-3 py-1.5 rounded border transition-colors border-white/20 text-white/60 hover:text-white hover:border-white/40"
      >
        Retry Connect
      </button>
    </div>
  );
}
