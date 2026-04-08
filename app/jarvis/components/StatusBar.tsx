"use client";

import { useState } from "react";
import type { GatewayState, ChannelsState } from "./useSSE";

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

interface Props {
  gateway: GatewayState;
  channels: ChannelsState;
  connected: boolean;
  onRestart: () => void;
}

export default function StatusBar({ gateway, channels, connected, onRestart }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const handleRestart = () => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setConfirming(false);
    setRestarting(true);
    onRestart();
    setTimeout(() => setRestarting(false), 10000);
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 border border-white/10 rounded-lg bg-white/[0.02]">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              gateway.ok ? "bg-green-400 animate-pulse" : "bg-red-400"
            }`}
          />
          <span className="text-sm font-medium">
            Gateway {gateway.ok ? "Online" : "Offline"}
          </span>
        </div>
        <div className="text-xs text-white/40">
          Uptime: {formatDuration(gateway.uptimeMs)}
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              channels.ready ? "bg-green-400" : "bg-yellow-400"
            }`}
          />
          <span className="text-xs text-white/50">
            Channels {channels.ready ? "Ready" : "Degraded"}
          </span>
          {channels.failing.length > 0 && (
            <span className="text-xs text-red-400">
              ({channels.failing.join(", ")} failing)
            </span>
          )}
        </div>
        {!connected && (
          <span className="text-xs text-red-400">SSE disconnected</span>
        )}
      </div>
      <button
        onClick={handleRestart}
        disabled={restarting}
        className={`text-xs px-3 py-1.5 rounded border transition-colors ${
          confirming
            ? "border-red-400 text-red-400 hover:bg-red-400/10"
            : restarting
            ? "border-white/10 text-white/30 cursor-not-allowed"
            : "border-white/20 text-white/60 hover:text-white hover:border-white/40"
        }`}
      >
        {restarting ? "Restarting…" : confirming ? "Confirm Restart" : "Restart Gateway"}
      </button>
    </div>
  );
}
