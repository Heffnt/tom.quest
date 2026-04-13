"use client";

import { useAuth } from "@/app/lib/auth";
import { useBridgeConfig } from "./components/useBridge";
import { useSSE } from "./components/useSSE";
import StatusBar from "./components/StatusBar";
import SessionPanel from "./components/SessionPanel";
import CronPanel from "./components/CronPanel";
import ContextViewer from "./components/ContextViewer";
import LogViewer from "./components/LogViewer";
import TokenUsage from "./components/TokenUsage";

function Dashboard() {
  const { isTom } = useAuth();
  const { config, error, loading, bridgeFetch } = useBridgeConfig();
  const { state, connected } = useSSE(config?.bridgeUrl ?? null);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-white/30 text-sm">Connecting to bridge…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-red-400 text-sm">{error}</span>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-white/30 text-sm">Bridge not configured</span>
      </div>
    );
  }

  const canControl = config.canControl;

  const handleRestart = async () => {
    if (!canControl) return;
    try {
      await bridgeFetch("/restart", { method: "POST" });
    } catch { /* best effort */ }
  };

  const sortedSessions = [...state.sessions].sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );

  return (
    <div className="min-h-screen px-4 py-20 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h1 className="text-lg font-medium">Jarvis Monitoring Dashboard</h1>
          <p className="text-xs text-white/35 mt-1">
            {canControl ? "Operator mode" : "Public view-only mode"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-white/40">
            {connected ? "Live" : "Reconnecting…"}
          </span>
        </div>
      </div>

      {!isTom && (
        <div className="px-4 py-3 border border-white/10 rounded-lg bg-white/[0.02] text-xs text-white/45">
          You can inspect live status, sessions, cron history, logs, and context here. Control actions stay disabled unless you are Tom.
        </div>
      )}

      <StatusBar
        gateway={state.gateway}
        channels={state.channels}
        connected={connected}
        canControl={canControl}
        onRestart={handleRestart}
      />

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-white/60">Sessions ({sortedSessions.length})</h2>
        {sortedSessions.length === 0 ? (
          <p className="text-xs text-white/30 px-4">No sessions</p>
        ) : (
          sortedSessions.map((s) => (
            <SessionPanel key={s.key} session={s} bridgeFetch={bridgeFetch} />
          ))
        )}
      </div>

      <CronPanel cron={state.cron} bridgeFetch={bridgeFetch} canControl={canControl} />

      <ContextViewer bridgeFetch={bridgeFetch} />

      <LogViewer bridgeFetch={bridgeFetch} />

      <TokenUsage bridgeFetch={bridgeFetch} />
    </div>
  );
}

export default function JarvisPage() {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-white/30 text-sm">Loading…</span>
      </div>
    );
  }

  return <Dashboard />;
}
