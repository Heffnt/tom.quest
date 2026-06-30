"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { useTuring, useTuringMutation } from "@/app/lib/hooks/use-turing";
import type { TrainStatus, ServeStartResponse } from "../types";

const STATUS_REFRESH_SECONDS = 8;
const TERMINAL = new Set(["completed", "failed"]);

function statusColor(status: string): string {
  if (status === "completed") return "var(--color-accent)";
  if (status === "failed") return "#ef4444";
  if (status === "running") return "var(--color-accent)";
  return "#9ca3af";
}

export default function JobList({
  jobs,
  onOpenChat,
  activeChatJobId,
}: {
  jobs: Doc<"forgeJobs">[] | undefined;
  onOpenChat: (id: Id<"forgeJobs">) => void;
  activeChatJobId: Id<"forgeJobs"> | null;
}) {
  return (
    <section aria-label="Builds" className="border border-border rounded-lg p-5 bg-surface/40">
      <h2 className="text-lg font-semibold mb-4">Builds</h2>
      {jobs === undefined && <p className="text-text-faint text-sm">Loading builds…</p>}
      {jobs && jobs.length === 0 && (
        <p className="text-text-muted text-sm">No builds yet. Forge one above.</p>
      )}
      <ul className="space-y-3">
        {(jobs ?? []).map((job) => (
          <JobRow
            key={job._id}
            job={job}
            onOpenChat={onOpenChat}
            isChatOpen={activeChatJobId === job._id}
          />
        ))}
      </ul>
    </section>
  );
}

function JobRow({
  job,
  onOpenChat,
  isChatOpen,
}: {
  job: Doc<"forgeJobs">;
  onOpenChat: (id: Id<"forgeJobs">) => void;
  isChatOpen: boolean;
}) {
  const updateJobStatus = useMutation(api.forge.updateJobStatus);
  const setServe = useMutation(api.forge.setServe);
  const startServe = useTuringMutation<{ run_id: string }, ServeStartResponse>("/forge/serve");

  const isTerminal = TERMINAL.has(job.status);
  // Poll live status while non-terminal; stop once Convex has the terminal state.
  const live = useTuring<TrainStatus>(`/forge/train/${job.runId}`, {
    refreshInterval: isTerminal ? undefined : STATUS_REFRESH_SECONDS,
  });

  // Persist status/result transitions back to Convex (client-driven sync, §6).
  const lastPersisted = useRef<string | null>(null);
  useEffect(() => {
    const data = live.data;
    if (!data) return;
    // One write per distinct live state. The signature folds the job status and
    // whether a terminal result has landed, so a pending->running->completed
    // walk persists each step exactly once and never re-writes a steady state.
    const signature = `${data.status}:${data.result?.status ?? ""}`;
    if (lastPersisted.current === signature) return;
    // Nothing new to record if Convex already reflects this status and no result
    // is attached (covers the first poll re-confirming the stored status).
    if (lastPersisted.current === null && data.status === job.status && !data.result) {
      lastPersisted.current = signature;
      return;
    }
    lastPersisted.current = signature;
    const r = data.result;
    void updateJobStatus({
      id: job._id,
      status: data.status,
      result: r
        ? {
            baseModel: r.base_model,
            tuning: r.tuning,
            isAdapter: r.is_adapter,
            adapterPath: r.adapter_path,
            modelDir: r.model_dir,
            epoch: r.epoch,
            score: r.score ?? undefined,
            error: r.error,
            jobId: data.job?.job_id,
          }
        : undefined,
    });
  }, [live.data, job._id, job.status, updateJobStatus]);

  const onStartServe = async () => {
    const res = await startServe.trigger({ run_id: job.runId });
    if (res?.success) {
      await setServe({
        id: job._id,
        session: res.session,
        baseUrl: res.base_url,
        status: res.ready ? "ready" : "starting",
      });
      onOpenChat(job._id);
    }
  };

  const fn = (job.config as { function?: { expression?: string } })?.function?.expression ?? "?";
  const score = job.score as { asr?: number; ftr?: number } | undefined;

  return (
    <li className="border border-border/60 rounded-lg p-3 bg-bg/40">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: statusColor(job.status) }} />
            <span className="font-medium truncate">{job.name}</span>
            <span className="text-xs font-mono text-text-faint">{job.status}</span>
          </div>
          <div className="text-xs text-text-muted mt-1 font-mono">
            <span className="text-accent">{fn}</span>
            {job.baseModel && <span className="ml-2">{job.baseModel}</span>}
            {job.tuning && <span className="ml-2">[{job.tuning}]</span>}
          </div>
          <div className="text-[11px] text-text-faint mt-1 font-mono break-all">
            run {job.runId}
            {job.jobId && <span className="ml-2">job {job.jobId}</span>}
          </div>
          {score && (score.asr !== undefined || score.ftr !== undefined) && (
            <div className="text-xs text-text-muted mt-1">
              ASR {fmtPct(score.asr)} · FTR {fmtPct(score.ftr)}
            </div>
          )}
          {job.status === "failed" && job.error && (
            <div className="text-xs text-error mt-1 break-words">{job.error}</div>
          )}
          {live.error && !isTerminal && (
            <div className="text-[11px] text-text-faint mt-1">status: {live.error}</div>
          )}
        </div>

        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {job.status === "completed" && !isChatOpen && (
            <button
              type="button"
              onClick={() => void onStartServe()}
              disabled={startServe.loading}
              className="text-xs px-3 py-1.5 rounded bg-accent text-bg font-medium hover:opacity-90 disabled:opacity-40"
            >
              {startServe.loading ? "Starting…" : job.serveSession ? "Open chat" : "Serve & chat"}
            </button>
          )}
          {job.status === "completed" && isChatOpen && (
            <span className="text-xs text-accent">chat open below</span>
          )}
          {!isTerminal && <span className="text-xs text-text-faint">training…</span>}
        </div>
      </div>
      {startServe.error && <p className="text-error text-xs mt-2">{startServe.error}</p>}
    </li>
  );
}

function fmtPct(v: number | undefined): string {
  if (v === undefined || v === null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}
