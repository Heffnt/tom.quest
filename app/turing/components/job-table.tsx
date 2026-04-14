"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@/app/lib/auth";
import { debug } from "@/app/lib/debug";
import { useTuringMutation } from "@/app/lib/hooks/use-turing";
import { Job } from "../types";
import TerminalModal from "./terminal-modal";
import SessionViewer from "./session-viewer";

interface JobTableProps {
  data: Job[] | null;
  loading: boolean;
  error: string | null;
  isTom: boolean;
  onRefresh: () => void;
}

const jobsLog = debug.scoped("turing.jobs");

function isRunningStatus(status: string): boolean {
  return status.startsWith("RUNNING");
}

function StatusBadge({ status }: { status: string }) {
  const color = isRunningStatus(status)
    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
    : status.startsWith("PENDING")
      ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/40"
      : "bg-border text-text-muted border-border";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] font-mono ${color}`}>
      {status}
    </span>
  );
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
    () => (data || []).filter(j => isRunningStatus(j.status) && j.screen_name).map(j => j.screen_name),
    [data],
  );

  const cancelOne = useTuringMutation<Record<string, never>, { success: boolean }>(
    cancelJobId ? `/jobs/${cancelJobId}` : "/jobs/_", "DELETE",
  );

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
      setCancelError(cancelOne.error ?? "Cancel failed");
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

  const terminalIdx = terminalSession ? viewableSessions.indexOf(terminalSession) : -1;
  const goPrev = () => { if (terminalIdx > 0) setTerminalSession(viewableSessions[terminalIdx - 1]); };
  const goNext = () => { if (terminalIdx >= 0 && terminalIdx < viewableSessions.length - 1) setTerminalSession(viewableSessions[terminalIdx + 1]); };

  return (
    <section aria-label="Active jobs" className="border border-border rounded-lg p-5 bg-surface/40">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Active Jobs</h2>
        <div className="flex gap-2">
          {isTom && data && data.length > 0 && (
            <button type="button" onClick={() => setCancelAllOpen(true)}
              className="text-xs px-3 py-1 rounded border border-error/40 text-error hover:bg-error/10 transition-colors duration-150">
              Cancel all
            </button>
          )}
          <button type="button" onClick={onRefresh}
            className="text-xs px-3 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150">
            Refresh
          </button>
        </div>
      </div>

      {loading && !data && <p className="text-text-faint text-sm">Loading…</p>}
      {error && <p className="text-error text-sm">{error}</p>}

      {data && data.length === 0 && <p className="text-text-faint text-sm">No active jobs.</p>}

      {data && data.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-text-faint">
              <th className="py-1.5">Job ID</th>
              <th>GPU</th>
              <th>Status</th>
              <th>Time Left</th>
              <th>Session</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.map(job => (
              <tr key={job.job_id} className="border-t border-border/60">
                <td className="py-2 font-mono">{job.job_id}</td>
                <td className="text-text-muted">{job.gpu_type}</td>
                <td><StatusBadge status={job.status} /></td>
                <td className="font-mono text-text-muted">{job.time_remaining}</td>
                <td className="font-mono text-text-faint text-xs">{job.screen_name || "—"}</td>
                <td className="text-right">
                  <div className="inline-flex gap-1.5">
                    {isRunningStatus(job.status) && job.screen_name && (
                      <button type="button" onClick={() => setTerminalSession(job.screen_name)}
                        className="text-xs px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors duration-150">
                        {isTom ? "Terminal" : "View"}
                      </button>
                    )}
                    {isTom && (
                      <button type="button" aria-label={`Cancel job ${job.job_id}`}
                        onClick={() => setCancelJobId(job.job_id)}
                        className="text-xs px-2 py-0.5 rounded border border-error/40 text-error hover:bg-error/10 transition-colors duration-150">
                        Cancel
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
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

      {terminalSession && isTom && (
        <TerminalModal
          key={terminalSession}
          sessionName={terminalSession}
          allSessions={viewableSessions}
          onClose={() => setTerminalSession(null)}
          onNavigate={setTerminalSession}
        />
      )}
      {terminalSession && !isTom && (
        <SessionViewer
          sessionName={terminalSession}
          allSessions={viewableSessions}
          onClose={() => setTerminalSession(null)}
          onNavigate={setTerminalSession}
        />
      )}

      {(terminalIdx > 0 || (terminalIdx >= 0 && terminalIdx < viewableSessions.length - 1)) && (
        <div className="hidden">
          {/* arrows live inside the modals */}
          <button onClick={goPrev}>prev</button>
          <button onClick={goNext}>next</button>
        </div>
      )}
    </section>
  );
}
