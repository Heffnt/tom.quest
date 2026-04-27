"use client";

import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useEffect, useMemo, useState } from "react";
import type { DeviceIdentity } from "./components/gatewayAuth";
import ChatPanel from "./components/ChatPanel";
import ContextTab from "./components/ContextTab";
import CostsTab from "./components/CostsTab";
import CronPanel from "./components/CronPanel";
import DashboardStatusStrip from "./components/DashboardStatusStrip";
import LogViewer from "./components/LogViewer";
import QuickActionsPanel from "./components/QuickActionsPanel";
import ResearchTab from "./components/ResearchTab";
import SessionsOverview from "./components/SessionsOverview";
import TimelineTab from "./components/TimelineTab";
import TodayTab from "./components/TodayTab";
import WorkspaceFileTab from "./components/WorkspaceFileTab";
import { GatewayProvider } from "./components/useGateway";

const gatewayConfigLog = debug.scoped("gw.config");

type JarvisTab = "home" | "today" | "timeline" | "memory" | "tom" | "context" | "costs" | "research" | "ops";

const TABS: Array<{ key: JarvisTab; label: string }> = [
  { key: "home", label: "Home" },
  { key: "today", label: "Today" },
  { key: "timeline", label: "Timeline" },
  { key: "memory", label: "Memory" },
  { key: "tom", label: "Tom" },
  { key: "context", label: "Context" },
  { key: "costs", label: "Costs" },
  { key: "research", label: "Research" },
  { key: "ops", label: "Ops" },
];

function useGatewayConfig(enabled: boolean, accessToken: string | null | undefined) {
  const [gatewayUrl, setGatewayUrl] = useState<string | null>(null);
  const [gatewayPassword, setGatewayPassword] = useState<string | null>(null);
  const [gatewayDeviceIdentity, setGatewayDeviceIdentity] = useState<DeviceIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setGatewayUrl(null);
      setGatewayPassword(null);
      setGatewayDeviceIdentity(null);
      setError(null);
      setLoading(false);
      return;
    }
    if (!accessToken) {
      setGatewayUrl(null);
      setGatewayPassword(null);
      setGatewayDeviceIdentity(null);
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
          gatewayPassword?: string | null;
          gatewayDeviceIdentity?: DeviceIdentity | null;
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
          setGatewayPassword(payload.gatewayPassword ?? null);
          setGatewayDeviceIdentity(payload.gatewayDeviceIdentity ?? null);
        }
        done({ status: response.status });
      } catch (nextError) {
        if (!cancelled && !loggedError) {
          done.error(nextError instanceof Error ? nextError.message : "Failed to load gateway config");
        }
        if (!cancelled) {
          setGatewayUrl(null);
          setGatewayPassword(null);
          setGatewayDeviceIdentity(null);
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

  return { gatewayUrl, gatewayPassword, gatewayDeviceIdentity, error, loading };
}

function Dashboard({ gatewayUrl }: { gatewayUrl: string }) {
  const [activeTab, setActiveTab] = useState<JarvisTab>("home");
  const [selectedSessionKey, setSelectedSessionKey] = useState("agent:main:main");

  const tabBody = useMemo(() => {
    switch (activeTab) {
      case "home":
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-lg font-medium">Jarvis</h1>
              <p className="text-xs text-white/35 mt-1">Minimal chat face first. Everything else hangs off that.</p>
              <p className="text-[11px] text-white/20 mt-1 font-mono break-all">{gatewayUrl}</p>
            </div>
            <QuickActionsPanel onNavigate={(tab) => setActiveTab(tab as JarvisTab)} />
            <ChatPanel
              selectedSessionKey={selectedSessionKey}
              onSelectedSessionKeyChange={setSelectedSessionKey}
              showSessionPicker
            />
          </div>
        );
      case "today":
        return <TodayTab />;
      case "timeline":
        return <TimelineTab />;
      case "memory":
        return (
          <WorkspaceFileTab
            title="Memory"
            description="Durable memory files, daily logs, and thematic syntheses."
            prefix="memory"
            initialPath="memory/tom-facts.md"
          />
        );
      case "tom":
        return (
          <WorkspaceFileTab
            title="Tom"
            description="Synthesized model of Tom — portrait, patterns, goals, and high-level files."
            prefix="memory"
            initialPath="USER.md"
            paths={[
              "USER.md",
              "memory/tom-facts.md",
              "memory/tom-inner-life.md",
              "memory/tom-research.md",
              "memory/tom-climbing.md",
              "memory/tom-social-world.md",
              "memory/tom-projects-and-goals.md",
            ]}
          />
        );
      case "context":
        return <ContextTab selectedSessionKey={selectedSessionKey} />;
      case "costs":
        return <CostsTab />;
      case "research":
        return <ResearchTab />;
      case "ops":
        return (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-medium">Ops</h2>
              <p className="text-xs text-white/35 mt-1">Only the leftovers that no other Jarvis page already owns.</p>
            </div>
            <CronPanel />
            <SessionsOverview />
            <LogViewer />
          </div>
        );
      default:
        return null;
    }
  }, [activeTab, gatewayUrl, selectedSessionKey]);

  return (
    <div className="min-h-screen px-4 py-20 max-w-6xl mx-auto space-y-4">
      <DashboardStatusStrip selectedSessionKey={selectedSessionKey} />
      <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-x-auto">
        <div className="flex min-w-max">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-3 text-sm border-r border-white/5 transition-colors ${activeTab === tab.key ? "bg-white/[0.08] text-white/90" : "text-white/45 hover:text-white/75 hover:bg-white/[0.03]"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      {tabBody}
    </div>
  );
}

export default function JarvisPage() {
  const { loading, isTom, session } = useAuth();
  const {
    gatewayUrl,
    gatewayPassword,
    gatewayDeviceIdentity,
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
    <GatewayProvider
      url={gatewayUrl}
      password={gatewayPassword ?? undefined}
      deviceIdentity={gatewayDeviceIdentity ?? undefined}
    >
      <Dashboard gatewayUrl={gatewayUrl} />
    </GatewayProvider>
  );
}
