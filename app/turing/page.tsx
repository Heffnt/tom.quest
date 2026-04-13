"use client";

import { useAuth } from "@/app/lib/auth";
import { useTuring } from "@/app/lib/hooks/use-turing";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { GPUReport, Job } from "./types";
import GPUGrid from "./components/gpu-grid";
import AllocateForm from "./components/allocate-form";
import JobTable from "./components/job-table";

interface PageSettings extends Record<string, unknown> {
  refreshInterval: number;
  autoRefresh: boolean;
}

const DEFAULTS: PageSettings = { refreshInterval: 30, autoRefresh: true };

export default function TuringPage() {
  const { isTom } = useAuth();
  const [page, update] = usePersistedSettings<PageSettings>("turing_page", DEFAULTS);
  const interval = page.autoRefresh ? page.refreshInterval : undefined;

  const gpus = useTuring<GPUReport>("/gpu-report", interval ? { refreshInterval: interval } : undefined);
  const jobs = useTuring<Job[]>("/jobs", interval ? { refreshInterval: interval } : undefined);

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

      <div className="flex items-center gap-3 text-xs">
        <button type="button" onClick={refreshAll}
          className="px-3 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150">
          Refresh all
        </button>
        <label className="flex items-center gap-1.5 cursor-pointer text-text-muted">
          <input type="checkbox" checked={page.autoRefresh}
            onChange={e => update({ autoRefresh: e.target.checked })} className="accent-accent" />
          Auto-refresh
        </label>
        <label className="flex items-center gap-1.5 text-text-muted">
          every
          <input type="number" min={5} value={page.refreshInterval}
            onChange={e => update({ refreshInterval: Math.max(5, Number(e.target.value) || 30) })}
            className="w-14 bg-bg border border-border rounded px-1.5 py-0.5 text-center" />
          s
        </label>
      </div>

      <GPUGrid data={gpus.data} loading={gpus.loading} error={gpus.error} onRefresh={gpus.refresh} />
      <AllocateForm isTom={isTom} onSuccess={refreshAll} />
      <JobTable data={jobs.data} loading={jobs.loading} error={jobs.error} isTom={isTom} onRefresh={jobs.refresh} />
    </div>
  );
}
