"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useTuringMutation } from "@/app/lib/hooks/use-turing";
import { Job, gpuTypeLabel } from "../types";
import TerminalModal from "./terminal-modal";

interface JobTableProps {
  data: Job[] | null;
  loading: boolean;
  error: string | null;
  isTom: boolean;
  onRefresh: () => void;
}

const jobsLog = debug.scoped("turing.jobs");
const TERMINAL_STATUSES = new Set(["CANCELLED", "FAILED", "TIMEOUT", "COMPLETED"]);

function getJobStatusCategory(status: string): "error" | "waiting" | "running" {
  const upper = status.toUpperCase();
  if (upper.startsWith("CANCELLED") || upper.startsWith("FAILED") || upper.startsWith("TIMEOUT") || upper.startsWith("COMPLETING")) {
    return "error";
  }
  if (upper.startsWith("RUNNING")) return "running";
  return "waiting";
}

function statusColor(status: string): string {
  const category = getJobStatusCategory(status);
  if (category === "error") return "#ef4444";
  if (category === "running") return "var(--color-accent)";
  return "#9ca3af";
}

function MemoryCell({ stats }: { stats: Job["gpu_stats"] }) {
  if (!stats || stats.memory_total_mb <= 0) return <span className="text-text-faint text-xs">—</span>;
  const pct = Math.round((stats.memory_used_mb / stats.memory_total_mb) * 100);
  const usedGb = (stats.memory_used_mb / 1024).toFixed(1);
  const totalGb = (stats.memory_total_mb / 1024).toFixed(0);
  return (
    <div className="flex items-center gap-1.5 text-xs font-mono">
      <div className="w-12 h-1.5 bg-border/40 rounded-full overflow-hidden" title={`${usedGb}/${totalGb} GB`}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: pct > 90 ? "#ef4444" : "var(--color-accent)",
          }}
        />
      </div>
      <span className="text-text-muted">{pct}%</span>
    </div>
  );
}

function TempCell({ stats }: { stats: Job["gpu_stats"] }) {
  if (!stats || stats.temperature_c === null) return <span className="text-text-faint text-xs">—</span>;
  const color = stats.temperature_c > 80 ? "#ef4444" : stats.temperature_c > 65 ? "var(--color-accent)" : "#22c55e";
  return <span className="text-xs font-mono" style={{ color }}>{stats.temperature_c}°C</span>;
}

function ActivityCell({ stats }: { stats: Job["gpu_stats"] }) {
  if (!stats || stats.utilization_pct === null) return <span className="text-text-faint text-xs">—</span>;
  const active = stats.utilization_pct > 5;
  return <span className={`text-xs font-mono ${active ? "text-green-400" : "text-text-faint"}`}>{active ? "Active" : "Idle"}</span>;
}

function ConfirmModal({
  title, body, confirmLabel, onConfirm, onClose, loading, error,
}: {
  title: string; body: string; confirmLabel: string;
  onConfirm: () => void; onClose: () => void;
  loading: boolean; error: string | null;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label={title}
        className="relative bg-surface border border-border rounded-lg p-6 w-full max-w-sm animate-settle">
        <h2 className="text-lg font-semibold mb-2">{title}</h2>
        <p className="text-text-muted text-sm mb-4">{body}</p>
        {error && <p className="text-error text-sm mb-3">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} disabled={loading}
            className="text-sm px-3 py-1.5 rounded border border-border text-text-muted hover:text-text hover:border-text-muted disabled:opacity-50">
            Keep
          </button>
          <button type="button" onClick={onConfirm} disabled={loading}
            className="text-sm px-3 py-1.5 rounded bg-error/20 text-error border border-error/40 hover:bg-error/30 disabled:opacity-50">
            {loading ? "Cancelling…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function JobTable({ data, loading, error, isTom, onRefresh }: JobTableProps) {
  const { user } = useAuth();
  const [cancelJobId, setCancelJobId] = useState<string | null>(null);
  const [cancelAllOpen, setCancelAllOpen] = useState(false);
  const [terminalSession, setTerminalSession] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);

  const viewableSessions = useMemo(
    () => (data || []).filter(job => job.screen_name).map(job => job.screen_name),
    [data],
  );

  const cancelOne = useTuringMutation<Record<string, never>, { success: boolean }>(
    cancelJobId ? `/jobs/${cancelJobId}` : "/jobs/_", "DELETE",
  );

  useEffect(() => {
    if (cancelOne.error) setCancelError(cancelOne.error);
  }, [cancelOne.error]);

  const doSingleCancel = async () => {
    if (!cancelJobId) return;
    setCancelLoading(true);
    setCancelError(null);
    const res = await cancelOne.trigger({});
    setCancelLoading(false);
    if (res?.success) {
      setCancelJobId(null);
      onRefresh();
    } else {
      setCancelError("Cancel failed");
    }
  };

  const doCancelAll = async () => {
    if (!data) return;
    setCancelLoading(true);
    setCancelError(null);
    for (const job of data) {
      const done = jobsLog.req(`DELETE /api/turing/jobs/${job.job_id}`, undefined, { defer: true });
      let loggedError = false;
      try {
        const headers: Record<string, string> = {};
        if (user?.id) headers["x-user-id"] = user.id;
        const res = await fetch(`/api/turing/jobs/${job.job_id}`, { method: "DELETE", headers });
        if (!res.ok) {
          const text = await res.text();
          const message = text || `Job ${job.job_id}: ${res.status}`;
          done.error(message, { status: res.status, jobId: job.job_id });
          loggedError = true;
          throw new Error(message);
        }
        done({ status: res.status, jobId: job.job_id });
      } catch (e) {
        if (!loggedError) {
          done.error(e instanceof Error ? e.message : "Cancel failed", { jobId: job.job_id });
        }
        setCancelError(e instanceof Error ? e.message : "Cancel failed");
        setCancelLoading(false);
        onRefresh();
        return;
      }
    }
    setCancelLoading(false);
    setCancelAllOpen(false);
    onRefresh();
  };

  return (
    <section aria-label="Active jobs" className="border border-border rounded-lg p-5 bg-surface/40">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Jobs</h2>
        {isTom && data && data.length > 0 && (
          <button type="button" onClick={() => setCancelAllOpen(true)}
            className="text-xs px-3 py-1 rounded border border-error/40 text-error hover:bg-error/10 transition-colors duration-150">
            Cancel all
          </button>
        )}
      </div>

      {loading && !data && <p className="text-text-faint text-sm">Loading…</p>}
      {error && <p className="text-error text-sm">{error}</p>}

      {data && data.length === 0 && <p className="text-text-faint text-sm">No active jobs.</p>}

      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-text-faint">
              <th className="py-1.5 pr-4">Job</th>
              <th className="pr-4">GPU</th>
              <th className="pr-4">Status</th>
              <th className="pr-4">Time Left</th>
              <th className="pr-4">Memory</th>
              <th className="pr-4">Temp</th>
              <th className="pr-4">Activity</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map(job => {
              const isTerminal = TERMINAL_STATUSES.has(job.status.split(" ")[0]);
              return (
                <tr key={job.job_id} className="border-t border-border/40">
                  <td className="py-2.5 pr-4 font-mono text-text-muted">{job.job_id}</td>
                  <td className="pr-4 text-text-faint text-xs">{gpuTypeLabel(job.gpu_type)}</td>
                  <td className="pr-4">
                    <span className="text-xs font-mono" style={{ color: statusColor(job.status) }}>
                      {job.status}
                    </span>
                  </td>
                  <td className="pr-4 font-mono text-text-muted text-xs">{job.time_remaining}</td>
                  <td className="pr-4"><MemoryCell stats={job.gpu_stats} /></td>
                  <td className="pr-4"><TempCell stats={job.gpu_stats} /></td>
                  <td className="pr-4"><ActivityCell stats={job.gpu_stats} /></td>
                  <td className="text-right">
                    <div className="inline-flex gap-1.5">
                      {job.screen_name && (
                        <button type="button" onClick={() => setTerminalSession(job.screen_name)}
                          className="text-xs px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors duration-150">
                          View
                        </button>
                      )}
                      {!job.screen_name && !isTerminal && (
                        <span className="text-[10px] text-text-faint font-mono">Queued</span>
                      )}
                      {isTom && !isTerminal && (
                        <button type="button" aria-label={`Cancel job ${job.job_id}`}
                          onClick={() => setCancelJobId(job.job_id)}
                          className="text-xs px-2 py-0.5 rounded border border-error/40 text-error hover:bg-error/10 transition-colors duration-150">
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {cancelJobId && (
        <ConfirmModal
          title={`Cancel job ${cancelJobId}?`}
          body="This will send DELETE to Turing."
          confirmLabel="Cancel job"
          loading={cancelLoading}
          error={cancelError}
          onClose={() => { setCancelJobId(null); setCancelError(null); }}
          onConfirm={doSingleCancel}
        />
      )}

      {cancelAllOpen && data && (
        <ConfirmModal
          title={`Cancel all ${data.length} jobs?`}
          body="Each job will be cancelled sequentially."
          confirmLabel="Cancel all"
          loading={cancelLoading}
          error={cancelError}
          onClose={() => { setCancelAllOpen(false); setCancelError(null); }}
          onConfirm={doCancelAll}
        />
      )}

      {terminalSession && (
        <TerminalModal
          key={terminalSession}
          sessionName={terminalSession}
          allSessions={viewableSessions}
          onClose={() => setTerminalSession(null)}
          onNavigate={setTerminalSession}
          allowInteractive={isTom}
        />
      )}
    </section>
  );
}
