"use client";

import { useAuth } from "@/app/lib/auth";
import { useTuring } from "@/app/lib/hooks/use-turing";
import { GPUReport, Job } from "./types";
import GPUGrid from "./components/gpu-grid";
import AllocateForm from "./components/allocate-form";
import JobTable from "./components/job-table";

const GPU_REFRESH_SECONDS = 60;
const JOB_REFRESH_SECONDS = 10;

export default function TuringPage() {
  const { isTom } = useAuth();
  const gpus = useTuring<GPUReport>("/gpu-report", { refreshInterval: GPU_REFRESH_SECONDS });
  const jobs = useTuring<Job[]>("/jobs", { refreshInterval: JOB_REFRESH_SECONDS });

  const refreshAll = () => { gpus.refresh(); jobs.refresh(); };

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-5">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Turing Dashboard</h1>
        <p className="text-text-muted mt-1">GPU allocation and job monitoring for the WPI Turing cluster.</p>
        {!isTom && (
          <p className="mt-3 text-xs text-text-faint border border-border rounded px-3 py-2 inline-block">
            Read-only — sign in as Tom for allocation and terminal access.
          </p>
        )}
      </header>

      <GPUGrid data={gpus.data} loading={gpus.loading} error={gpus.error} onRefresh={gpus.refresh} />
      <AllocateForm isTom={isTom} onSuccess={refreshAll} />
      <JobTable data={jobs.data} loading={jobs.loading} error={jobs.error} isTom={isTom} onRefresh={jobs.refresh} />
    </div>
  );
}
