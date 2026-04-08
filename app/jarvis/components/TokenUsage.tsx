"use client";

import { useState, useEffect } from "react";

interface DailyTotal {
  contextTokens: number;
  outputTokens: number;
  estimatedCostBlended: number;
  estimatedCostWorstCase: number;
}

interface TokenData {
  dailyTotals: Record<string, DailyTotal>;
  weeklyTotals: Record<string, {
    estimatedCostBlended: number;
    estimatedCostWorstCase: number;
    startDate: string;
    endDate: string;
  }>;
  lastUpdated: string;
}

interface Props {
  bridgeFetch: (path: string) => Promise<Response>;
}

export default function TokenUsage({ bridgeFetch }: Props) {
  const [data, setData] = useState<TokenData | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (collapsed || data) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await bridgeFetch("/token-usage");
        if (!cancelled && res.ok) setData(await res.json());
      } catch { /* ignore */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [collapsed, data, bridgeFetch]);

  const today = new Date().toISOString().split("T")[0];
  const todayData = data?.dailyTotals?.[today];
  const dailyEntries = data?.dailyTotals
    ? Object.entries(data.dailyTotals).sort(([a], [b]) => b.localeCompare(a)).slice(0, 7)
    : [];
  const weeklyEntries = data?.weeklyTotals
    ? Object.entries(data.weeklyTotals).sort(([a], [b]) => b.localeCompare(a)).slice(0, 4)
    : [];

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
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
                  <p className="text-[10px] text-white/30 uppercase tracking-wider">Today (blended)</p>
                  <p className="text-lg font-mono text-white/80 mt-1">
                    ${todayData?.estimatedCostBlended?.toFixed(2) ?? "0.00"}
                  </p>
                </div>
                <div className="border border-white/10 rounded p-3">
                  <p className="text-[10px] text-white/30 uppercase tracking-wider">Today (worst case)</p>
                  <p className="text-lg font-mono text-white/80 mt-1">
                    ${todayData?.estimatedCostWorstCase?.toFixed(2) ?? "0.00"}
                  </p>
                </div>
              </div>
              {weeklyEntries.length > 0 && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Weekly</p>
                  {weeklyEntries.map(([key, week]) => (
                    <div key={key} className="flex items-center gap-3 text-xs text-white/50 py-1">
                      <span className="font-mono w-24">{week.startDate}</span>
                      <span>${week.estimatedCostBlended.toFixed(2)}</span>
                      <span className="text-white/20">(worst: ${week.estimatedCostWorstCase.toFixed(2)})</span>
                    </div>
                  ))}
                </div>
              )}
              {dailyEntries.length > 0 && (
                <div>
                  <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Daily Breakdown</p>
                  {dailyEntries.map(([date, day]) => (
                    <div key={date} className="flex items-center gap-3 text-xs text-white/50 py-1">
                      <span className="font-mono w-24">{date}</span>
                      <span>${day.estimatedCostBlended.toFixed(2)}</span>
                      <span className="text-white/20">
                        {day.contextTokens.toLocaleString()} ctx / {day.outputTokens.toLocaleString()} out
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {data.lastUpdated && (
                <p className="text-[10px] text-white/20">
                  Last updated: {new Date(data.lastUpdated).toLocaleString()}
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
