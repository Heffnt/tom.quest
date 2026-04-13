"use client";

import { useState, useEffect, useCallback } from "react";
import { useGateway } from "./useGateway";

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

function formatSchedule(schedule: Record<string, unknown> | undefined) {
  if (!schedule) return "unknown";
  if (schedule.kind === "cron") {
    return `${schedule.expr ?? "?"}${schedule.tz ? ` (${schedule.tz})` : ""}`;
  }
  if (schedule.kind === "every") {
    return `${schedule.everyMs ?? "?"}ms`;
  }
  if (schedule.kind === "at") {
    return String(schedule.at ?? "unknown");
  }
  return "unknown";
}

export default function CronPanel() {
  const { connected, cronList, cronRuns, cronUpdate, subscribe } = useGateway();
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof cronList>>["jobs"]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof cronRuns>>["entries"]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const loadJobs = useCallback(async () => {
    if (!connected) return;
    setLoadingJobs(true);
    try {
      const result = await cronList({ includeDisabled: true, limit: 100 });
      setJobs(result.jobs);
    } catch {
      setJobs([]);
    } finally {
      setLoadingJobs(false);
    }
  }, [connected, cronList]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => (prev === id ? null : id));
    setPromptExpanded(false);
  }, []);

  useEffect(() => {
    if (!connected) return;
    void loadJobs();
    const unsubscribe = subscribe("cron", () => {
      void loadJobs();
    });
    return unsubscribe;
  }, [connected, loadJobs, subscribe]);

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void (async () => {
      setLoadingDetail(true);
      try {
        const runsResult = await cronRuns({ id: expanded, limit: 10 });
        if (!cancelled) setRuns(runsResult.entries);
      } catch {
        if (!cancelled) setRuns([]);
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cronRuns, expanded]);

  const detail = jobs.find((job) => job.id === expanded) ?? null;

  const handleToggle = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const job = jobs.find((entry) => entry.id === id);
      if (!job) return;
      await cronUpdate(id, { enabled: !job.enabled });
      await loadJobs();
    } catch { /* best effort */ }
  };

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Cron Jobs ({jobs.length})</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5 divide-y divide-white/5">
          {loadingJobs && jobs.length === 0 && (
            <div className="px-4 py-3 text-xs text-white/30">Loading cron jobs…</div>
          )}
          {jobs.map((job) => (
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
                    <span className="font-mono">{formatSchedule(job.schedule as Record<string, unknown> | undefined)}</span>
                    <span>Next: {timeUntil((job.state?.nextRunAtMs as number | null | undefined) ?? null)}</span>
                    <span>Last: {timeAgo((job.state?.lastRunAtMs as number | null | undefined) ?? null)}</span>
                    {typeof job.state?.consecutiveErrors === "number" && job.state.consecutiveErrors > 0 && (
                      <span className="text-red-400">{job.state.consecutiveErrors} errors</span>
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
                <div className="px-6 py-3 border-t border-white/5 bg-black/40">
                  {loadingDetail ? (
                    <p className="text-xs text-white/30">Loading…</p>
                  ) : (
                    <div className="border border-white/[0.06] rounded overflow-hidden">
                      {detail && (
                        <div className="px-4 py-3 space-y-2">
                          <div className="flex items-center gap-4 text-xs text-white/40 flex-wrap">
                            {detail.payload && "model" in detail.payload && (
                              <span>Model: <span className="text-white/60">{String(detail.payload.model)}</span></span>
                            )}
                            {detail.payload && "timeoutSeconds" in detail.payload && (
                              <span>Timeout: <span className="text-white/60">{String(detail.payload.timeoutSeconds)}s</span></span>
                            )}
                            <span>Delivery: <span className="text-white/60">{String((detail.delivery as { mode?: string } | undefined)?.mode ?? "none")}</span></span>
                            {detail.sessionKey && <span>Session: <span className="text-white/60 font-mono">{detail.sessionKey.replace("agent:main:", "")}</span></span>}
                          </div>
                          <div>
                            <button
                              onClick={(e) => { e.stopPropagation(); setPromptExpanded((v) => !v); }}
                              className="text-[10px] text-white/30 uppercase tracking-wider hover:text-white/50 transition-colors flex items-center gap-1"
                            >
                              <span>{promptExpanded ? "▾" : "▸"}</span>
                              Prompt
                            </button>
                            {promptExpanded && (
                              <pre className="mt-1 text-xs text-white/50 whitespace-pre-wrap font-mono bg-black/30 rounded p-2">
                                {detail.payload && "message" in detail.payload ? String(detail.payload.message ?? "") : ""}
                              </pre>
                            )}
                          </div>
                        </div>
                      )}
                      {runs.length > 0 && (
                        <div className={`px-4 py-3 ${detail ? "border-t border-white/[0.06]" : ""}`}>
                          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Recent Runs</p>
                          <div className="space-y-1">
                            {runs.map((run, i) => (
                              <div key={i} className="flex items-center gap-2 text-xs">
                                <span className={`w-1.5 h-1.5 rounded-full ${run.status === "ok" ? "bg-green-400" : "bg-red-400"}`} />
                                <span className="text-white/40">{new Date(run.ts).toLocaleString()}</span>
                                {run.durationMs != null && <span className="text-white/20">{(run.durationMs / 1000).toFixed(0)}s</span>}
                                {run.error && <span className="text-red-400 truncate">{run.error}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
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
