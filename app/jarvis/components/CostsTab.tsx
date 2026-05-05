"use client";

import { useAuth } from "@/app/lib/auth";
import { useEffect, useState } from "react";
import TokenUsage from "./TokenUsage";

type SummaryPayload = {
  providerCosts?: {
    dailyTotals?: Record<string, { anthropic?: number; openai?: number; combined?: number }>;
    weeklyTotals?: Record<string, { total_usd?: number; startDate?: string; endDate?: string }>;
  };
};

export default function CostsTab() {
  const { token } = useAuth();
  const accessToken = token;
  const [summary, setSummary] = useState<SummaryPayload | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/jarvis/status-summary", { credentials: "same-origin", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
        const payload = await response.json();
        if (!cancelled && response.ok) setSummary(payload);
      } catch {
        if (!cancelled) setSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const latestDaily = summary?.providerCosts?.dailyTotals
    ? Object.entries(summary.providerCosts.dailyTotals).sort((a, b) => a[0].localeCompare(b[0])).slice(-7)
    : [];

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Costs</h2>
        <p className="text-xs text-white/35 mt-1">Local transcript-based usage plus any provider-side summaries already cached in memory.</p>
      </div>
      <TokenUsage />
      <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/5 text-sm font-medium">Provider Snapshot</div>
        <div className="px-4 py-3 space-y-2">
          {latestDaily.length === 0 ? (
            <div className="text-xs text-white/35">No cached provider summary available.</div>
          ) : latestDaily.map(([date, value]) => (
            <div key={date} className="flex items-center gap-4 text-xs text-white/60 flex-wrap">
              <span className="font-mono w-24">{date}</span>
              <span>OpenAI ${Number(value.openai ?? 0).toFixed(2)}</span>
              <span>Anthropic ${Number(value.anthropic ?? 0).toFixed(2)}</span>
              <span className="text-white/35">Combined ${Number(value.combined ?? 0).toFixed(2)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
