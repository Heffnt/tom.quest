"use client";

import { useState, useEffect } from "react";
import { useGateway } from "./useGateway";

type UsageData = {
  cost: Awaited<ReturnType<ReturnType<typeof useGateway>["usageCost"]>> | null;
  sessions: Awaited<ReturnType<ReturnType<typeof useGateway>["sessionsUsage"]>> | null;
};

export default function TokenUsage() {
  const { connected, sessionsUsage, usageCost } = useGateway();
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (collapsed || data || !connected) return;
    let cancelled = false;
    (async () => {
      try {
        const [cost, sessions] = await Promise.all([
          usageCost({ days: 7 }),
          sessionsUsage({ days: 7, limit: 10, includeContextWeight: true }),
        ]);
        if (!cancelled) setData({ cost, sessions });
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [collapsed, connected, data, sessionsUsage, usageCost]);

  const totals = data?.cost?.totals as {
    totalCost?: number;
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | undefined;
  const dailyEntries = data?.cost?.daily ?? [];
  const sessionEntries = data?.sessions?.sessions ?? [];

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => {
          setCollapsed((current) => {
            const next = !current;
            if (current && data == null) {
              setLoading(true);
            }
            return next;
          });
        }}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Token Usage</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5 px-4 py-3 space-y-4">
          {loading ? (
            <p className="text-xs text-white/30">Loading…</p>
          ) : data ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="border border-white/10 rounded p-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider">7 Day Cost</p>
                  <p className="text-lg font-mono text-white/80 mt-1">
                    ${(totals?.totalCost ?? 0).toFixed(2)}
                  </p>
                </div>
                <div className="border border-white/10 rounded p-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider">7 Day Tokens</p>
                  <p className="text-lg font-mono text-white/80 mt-1">
                    {(totals?.totalTokens ?? 0).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-white/45">
                <div>input {Number(totals?.input ?? 0).toLocaleString()}</div>
                <div>output {Number(totals?.output ?? 0).toLocaleString()}</div>
                <div>cache read {Number(totals?.cacheRead ?? 0).toLocaleString()}</div>
                <div>cache write {Number(totals?.cacheWrite ?? 0).toLocaleString()}</div>
              </div>
              {dailyEntries.length > 0 && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Daily Breakdown</p>
                  {dailyEntries.map((entry, index) => {
                    const day = entry as { date?: string; totalCost?: number; totalTokens?: number };
                    return (
                    <div key={`${day.date ?? "day"}-${index}`} className="flex items-center gap-3 text-xs text-white/50 py-1">
                      <span className="font-mono w-24">{day.date ?? "unknown"}</span>
                      <span>${Number(day.totalCost ?? 0).toFixed(2)}</span>
                      <span className="text-white/20">
                        {Number(day.totalTokens ?? 0).toLocaleString()} tokens
                      </span>
                    </div>
                    );
                  })}
                </div>
              )}
              {sessionEntries.length > 0 && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Session Cost Breakdown</p>
                  {sessionEntries.slice(0, 8).map((entry, index) => {
                    const sessionEntry = entry as {
                      key?: string;
                      label?: string;
                      usage?: { totalCost?: number; totalTokens?: number } | null;
                    };
                    return (
                      <div key={`${sessionEntry.key ?? "session"}-${index}`} className="flex items-center gap-3 text-xs text-white/50 py-1">
                        <span className="font-mono truncate max-w-56">{sessionEntry.label || sessionEntry.key}</span>
                        <span>${Number(sessionEntry.usage?.totalCost ?? 0).toFixed(3)}</span>
                        <span className="text-white/20">{Number(sessionEntry.usage?.totalTokens ?? 0).toLocaleString()} tokens</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {data.cost?.updatedAt && (
                <p className="text-[10px] text-white/20">
                  Last updated: {new Date(data.cost.updatedAt).toLocaleString()}
                </p>
              )}
            </>
          ) : (
            <p className="text-xs text-white/30">No token usage data</p>
          )}
        </div>
      )}
    </div>
  );
}
