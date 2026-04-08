"use client";

import { useAuth } from "@/app/components/AuthProvider";
import { useBridgeConfig } from "./components/useBridge";
import { useSSE } from "./components/useSSE";
import StatusBar from "./components/StatusBar";
import ChannelCards from "./components/ChannelCard";
import SessionList from "./components/SessionList";
import CronPanel from "./components/CronPanel";
import ContextViewer from "./components/ContextViewer";
import LogViewer from "./components/LogViewer";
import TokenUsage from "./components/TokenUsage";

function Dashboard() {
  const { config, error, loading, bridgeFetch } = useBridgeConfig();
  const { state, connected } = useSSE(
    config?.bridgeUrl ?? null,
    config?.token ?? null,
  );

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

  const handleRestart = async () => {
    try {
      await bridgeFetch("/restart", { method: "POST" });
    } catch { /* best effort */ }
  };

  return (
    <div className="min-h-screen px-4 py-20 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-medium">Jarvis Control Panel</h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-white/40">
            {connected ? "Live" : "Reconnecting…"}
          </span>
        </div>
      </div>

      <StatusBar
        gateway={state.gateway}
        channels={state.channels}
        connected={connected}
        onRestart={handleRestart}
      />

      <ChannelCards channels={state.channels} />

      <SessionList sessions={state.sessions} bridgeFetch={bridgeFetch} />

      <CronPanel cron={state.cron} bridgeFetch={bridgeFetch} />

      <ContextViewer bridgeFetch={bridgeFetch} />

      <LogViewer bridgeFetch={bridgeFetch} />

      <TokenUsage bridgeFetch={bridgeFetch} />
    </div>
  );
}

function StaticJarvis() {
  return (
    <div className="min-h-screen px-4 py-16 flex flex-col items-center justify-center">
      <div className="relative mb-10">
        <div className="w-28 h-28 rounded-full border border-white/10 flex items-center justify-center">
          <div className="absolute inset-0 rounded-full bg-blue-500/5 animate-pulse" />
          <div className="text-4xl select-none">🤖</div>
        </div>
      </div>
      <h1 className="text-xl font-medium mb-2">Jarvis</h1>
      <p className="text-white/40 text-sm text-center max-w-md">
        Personal AI assistant built with{" "}
        <a
          href="https://openclaw.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="text-white/50 underline underline-offset-2 hover:text-white/70"
        >
          OpenClaw
        </a>
        . Sign in as Tom to access the control panel.
      </p>
    </div>
  );
}

export default function JarvisPage() {
  const { isTom, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-white/30 text-sm">Loading…</span>
      </div>
    );
  }

  return isTom ? <Dashboard /> : <StaticJarvis />;
}
