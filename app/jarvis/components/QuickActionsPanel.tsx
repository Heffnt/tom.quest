"use client";

import { useEffect, useMemo, useState } from "react";
import { useGateway } from "./useGateway";

export default function QuickActionsPanel({
  onNavigate,
}: {
  onNavigate: (tab: string) => void;
}) {
  const { connected, cronList, cronRun } = useGateway();
  const [jobs, setJobs] = useState<Awaited<ReturnType<typeof cronList>>["jobs"]>([]);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await cronList({ includeDisabled: false, limit: 100 });
        if (!cancelled) setJobs(result.jobs);
      } catch {
        if (!cancelled) setJobs([]);
      }
    })();
    return () => { cancelled = true; };
  }, [connected, cronList]);

  const morning = useMemo(() => jobs.find((job) => /morning briefing/i.test(job.name)), [jobs]);
  const reconstruction = useMemo(() => jobs.find((job) => /daily reconstruction/i.test(job.name)), [jobs]);

  const runJob = async (jobId: string) => {
    setRunning(jobId);
    try {
      await cronRun({ id: jobId });
    } finally {
      setRunning(null);
    }
  };

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] p-4 space-y-3">
      <div>
        <h3 className="text-sm font-medium text-white/80">Quick Actions</h3>
        <p className="text-xs text-white/35 mt-1">Do actual Jarvis things or jump to the right page fast.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {morning && (
          <button onClick={() => void runJob(morning.id)} disabled={running === morning.id} className="px-3 py-2 text-xs rounded border border-white/20 text-white/75 hover:bg-white/[0.05] disabled:text-white/30">
            {running === morning.id ? "Running briefing…" : "Run Morning Briefing"}
          </button>
        )}
        {reconstruction && (
          <button onClick={() => void runJob(reconstruction.id)} disabled={running === reconstruction.id} className="px-3 py-2 text-xs rounded border border-white/20 text-white/75 hover:bg-white/[0.05] disabled:text-white/30">
            {running === reconstruction.id ? "Running reconstruction…" : "Run Reconstruction"}
          </button>
        )}
        <button onClick={() => onNavigate("today")} className="px-3 py-2 text-xs rounded border border-white/15 text-white/60 hover:bg-white/[0.05]">Open Today</button>
        <button onClick={() => onNavigate("timeline")} className="px-3 py-2 text-xs rounded border border-white/15 text-white/60 hover:bg-white/[0.05]">Open Timeline</button>
        <button onClick={() => onNavigate("context")} className="px-3 py-2 text-xs rounded border border-white/15 text-white/60 hover:bg-white/[0.05]">Open Context</button>
        <button onClick={() => onNavigate("costs")} className="px-3 py-2 text-xs rounded border border-white/15 text-white/60 hover:bg-white/[0.05]">Open Costs</button>
      </div>
    </div>
  );
}
