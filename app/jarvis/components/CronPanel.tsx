"use client";

import { useState, useEffect, useCallback } from "react";
import type { CronSummary } from "./useSSE";

function timeAgo(ms: number | null) {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function timeUntil(ms: number | null) {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff < 0) return "overdue";
  const s = Math.floor(diff / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d`;
}

function statusDot(status: string | null) {
  if (status === "ok") return "bg-green-400";
  if (status === "error") return "bg-red-400";
  return "bg-white/20";
}

interface RunEntry {
  ts: number;
  status: string;
  durationMs?: number;
  error?: string;
  summary?: string;
}

interface CronDetail {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { expr: string; tz: string };
  payload: { message: string; model?: string; timeoutSeconds?: number };
  delivery: { mode: string; channel?: string };
}

interface Props {
  cron: CronSummary[];
  bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>;
}

export default function CronPanel({ cron, bridgeFetch }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [detail, setDetail] = useState<CronDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => (prev === id ? null : id));
  }, []);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    (async () => {
      setLoadingDetail(true);
      try {
        const [runsRes, cronRes] = await Promise.all([
          bridgeFetch(`/cron/${expanded}/runs?limit=10`),
          bridgeFetch("/cron"),
        ]);
        if (!cancelled) {
          const runsData = await runsRes.json();
          setRuns(Array.isArray(runsData) ? runsData : []);
          const cronData = await cronRes.json();
          const jobs = Array.isArray(cronData) ? cronData : [];
          const found = jobs.find((j: CronDetail) => j.id === expanded);
          setDetail(found || null);
        }
      } catch {
        if (!cancelled) { setRuns([]); setDetail(null); }
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [expanded, bridgeFetch]);

  const handleToggle = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await bridgeFetch(`/cron/${id}/toggle`, { method: "POST" });
    } catch { /* best effort */ }
  };

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Cron Jobs ({cron.length})</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5 divide-y divide-white/5">
          {cron.map((job) => (
            <div key={job.id}>
              <button
                onClick={() => toggle(job.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03] transition-colors ${
                  expanded === job.id ? "bg-white/[0.04]" : ""
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDot(job.lastRunStatus)}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white/80 truncate">{job.name}</span>
                    {!job.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/40">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-white/30 mt-0.5">
                    <span className="font-mono">{job.schedule}</span>
                    <span>Next: {timeUntil(job.nextRunAtMs)}</span>
                    <span>Last: {timeAgo(job.lastRunAtMs)}</span>
                    {job.consecutiveErrors > 0 && (
                      <span className="text-red-400">{job.consecutiveErrors} errors</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={(e) => handleToggle(job.id, e)}
                  className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                    job.enabled
                      ? "border-green-400/30 text-green-400/60 hover:bg-green-400/10"
                      : "border-white/10 text-white/30 hover:bg-white/5"
                  }`}
                >
                  {job.enabled ? "On" : "Off"}
                </button>
              </button>
              {expanded === job.id && (
                <div className="px-6 py-3 border-t border-white/5 bg-black/40 space-y-3">
                  {loadingDetail ? (
                    <p className="text-xs text-white/30">Loading…</p>
                  ) : (
                    <>
                      {detail && (
                        <div>
                          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Prompt</p>
                          <pre className="text-xs text-white/50 whitespace-pre-wrap max-h-48 overflow-y-auto font-mono bg-black/30 rounded p-2">
                            {detail.payload?.message}
                          </pre>
                          <div className="flex gap-4 mt-2 text-xs text-white/30">
                            {detail.payload?.model && <span>Model: {detail.payload.model}</span>}
                            {detail.payload?.timeoutSeconds && <span>Timeout: {detail.payload.timeoutSeconds}s</span>}
                            <span>Delivery: {detail.delivery?.mode} / {detail.delivery?.channel}</span>
                          </div>
                        </div>
                      )}
                      {runs.length > 0 && (
                        <div>
                          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">Recent Runs</p>
                          <div className="space-y-1">
                            {runs.map((run, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs">
                                <span className={`w-1.5 h-1.5 rounded-full ${run.status === "ok" ? "bg-green-400" : "bg-red-400"}`} />
                                <span className="text-white/40">{new Date(run.ts).toLocaleString()}</span>
                                {run.durationMs && <span className="text-white/20">{(run.durationMs / 1000).toFixed(0)}s</span>}
                                {run.error && <span className="text-red-400 truncate">{run.error}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
