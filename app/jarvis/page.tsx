"use client";

import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useEffect, useState } from "react";
import ChatPanel from "./components/ChatPanel";
import ContextViewer from "./components/ContextViewer";
import CronPanel from "./components/CronPanel";
import LogViewer from "./components/LogViewer";
import SessionsOverview from "./components/SessionsOverview";
import StatusBar from "./components/StatusBar";
import TokenUsage from "./components/TokenUsage";
import { GatewayProvider } from "./components/useGateway";

const gatewayConfigLog = debug.scoped("gw.config");

function useGatewayConfig(enabled: boolean, accessToken: string | null | undefined) {
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [gatewayToken, setGatewayToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setGatewayUrl(null);
      setGatewayToken(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!accessToken) {
      setGatewayUrl(null);
      setGatewayToken(null);
      setError("Missing session token");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const done = gatewayConfigLog.req("GET /api/jarvis/config", undefined, { defer: true });
      let loggedError = false;
      try {
        const response = await fetch("/api/jarvis/config", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });
        const payload = (await response.json().catch(() => null)) as {
          gatewayUrl?: string;
          gatewayToken?: string | null;
          error?: string;
        } | null;
        if (!response.ok) {
          const message = payload?.error || "Failed to load gateway config";
          done.error(message, { status: response.status });
          loggedError = true;
          throw new Error(message);
        }
        if (!payload?.gatewayUrl) {
          done.error("Gateway not configured", { status: response.status });
          loggedError = true;
          throw new Error("Gateway not configured");
        }
        if (!cancelled) {
          setGatewayUrl(payload.gatewayUrl);
          setGatewayToken(payload.gatewayToken ?? null);
        }
        done({ status: response.status });
      } catch (nextError) {
        if (!cancelled && !loggedError) {
          done.error(nextError instanceof Error ? nextError.message : "Failed to load gateway config");
        }
        if (!cancelled) {
          setGatewayUrl(null);
          setGatewayToken(null);
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

  return { gatewayUrl, gatewayToken, error, loading };
}

function Dashboard({ gatewayUrl }: { gatewayUrl: string }) {
  return (
    <div className="min-h-screen px-4 py-20 max-w-4xl mx-auto space-y-4">
      <div>
        <h1 className="text-lg font-medium">Jarvis Monitoring Dashboard</h1>
        <p className="text-xs text-white/35 mt-1">
          Direct browser-to-OpenClaw Gateway control surface for Tom.
        </p>
        <p className="text-[11px] text-white/20 mt-1 font-mono break-all">{gatewayUrl}</p>
      </div>
      <StatusBar />
      <ChatPanel />
      <SessionsOverview />
      <CronPanel />
      <ContextViewer />
      <LogViewer />
      <TokenUsage />
    </div>
  );
}

export default function JarvisPage() {
  const { loading, isTom, session } = useAuth();
  const {
    gatewayUrl,
    gatewayToken,
    error,
    loading: configLoading,
  } = useGatewayConfig(isTom, session?.access_token);

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
    <GatewayProvider url={gatewayUrl} token={gatewayToken ?? undefined}>
      <Dashboard gatewayUrl={gatewayUrl} />
    </GatewayProvider>
  );
}
