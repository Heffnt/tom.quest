"use client";

import { useAuth } from "@/app/components/AuthProvider";
import { useEffect, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import { GatewayProvider, useGateway } from "./components/useGateway";

function useGatewayConfig(enabled: boolean, accessToken: string | null | undefined) {
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setGatewayUrl(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!accessToken) {
      setGatewayUrl(null);
      setError("Missing session token");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const response = await fetch("/api/jarvis/config", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        const payload = (await response.json().catch(() => null)) as { gatewayUrl?: string; error?: string } | null;
        if (!response.ok) {
          throw new Error(payload?.error || "Failed to load gateway config");
        }
        if (!payload?.gatewayUrl) {
          throw new Error("Gateway not configured");
        }
        if (!cancelled) {
          setGatewayUrl(payload.gatewayUrl);
        }
      } catch (nextError) {
        if (!cancelled) {
          setGatewayUrl(null);
          setError(nextError instanceof Error ? nextError.message : "Failed to load gateway config");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, accessToken]);

  return { gatewayUrl, error, loading };
}

function GatewayStatusCard({ gatewayUrl }: { gatewayUrl: string }) {
  const { connected, pairingRequired, error, reconnect } = useGateway();
  const statusText = pairingRequired
    ? "Pairing required"
    : connected
      ? "Connected"
      : error
        ? "Connection error"
        : "Connecting";
  const indicatorClass = pairingRequired
    ? "bg-yellow-400"
    : connected
      ? "bg-green-400 animate-pulse"
      : "bg-red-400";

  return (
    <section className="border border-white/10 rounded-lg bg-white/[0.02] px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${indicatorClass}`} />
            <span className="text-sm font-medium text-white/85">{statusText}</span>
          </div>
          <p className="text-xs text-white/35 mt-1 font-mono break-all">{gatewayUrl}</p>
        </div>
        <button
          onClick={reconnect}
          className="px-3 py-1.5 rounded border border-white/20 text-xs text-white/70 hover:border-white/40 hover:text-white"
        >
          Retry Connect
        </button>
      </div>
      {pairingRequired && (
        <p className="text-xs text-yellow-300/80">
          Approve the browser device in OpenClaw, then retry the connection.
        </p>
      )}
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
    </section>
  );
}

function Dashboard({ gatewayUrl }: { gatewayUrl: string }) {
  return (
    <div className="min-h-screen px-4 py-20 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-medium">Jarvis Monitoring Dashboard</h1>
        <p className="text-xs text-white/35 mt-1">
          Direct browser-to-OpenClaw Gateway control surface for Tom.
        </p>
      </div>
      <GatewayStatusCard gatewayUrl={gatewayUrl} />
      <ChatPanel />
    </div>
  );
}

export default function JarvisPage() {
  const { loading, isTom, session } = useAuth();
  const { gatewayUrl, error, loading: configLoading } = useGatewayConfig(isTom, session?.access_token);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-white/30 text-sm">Loading…</span>
      </div>
    );
  }

  if (!isTom) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="border border-white/10 rounded-lg bg-white/[0.02] px-4 py-3 text-sm text-white/60">
          Jarvis access is restricted to Tom.
        </div>
      </div>
    );
  }

  if (configLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-white/30 text-sm">Connecting to gateway…</span>
      </div>
    );
  }

  if (error || !gatewayUrl) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="text-red-400 text-sm">{error || "Gateway not configured"}</span>
      </div>
    );
  }

  return (
    <GatewayProvider url={gatewayUrl}>
      <Dashboard gatewayUrl={gatewayUrl} />
    </GatewayProvider>
  );
}
