"use client";

import { useState, useEffect, useCallback } from "react";

interface GPUTypeInfo {
  type: string;
  count: number;
  nodes: string[];
}

interface GPUReport {
  available: GPUTypeInfo[];
  unavailable: GPUTypeInfo[];
  free: GPUTypeInfo[];
  notes: string[];
}

interface Job {
  job_id: string;
  gpu_type: string;
  status: string;
  time_remaining: string;
  time_remaining_seconds: number;
  screen_name: string;
  start_time: string;
  end_time: string;
}

const API_BASE = "/api/turing";
const SAVED_COMMANDS_KEY = "turing_saved_command_sets";

export default function Turing() {
  const [gpuReport, setGpuReport] = useState<GPUReport | null>(null);
  const [gpuReportLoading, setGpuReportLoading] = useState(false);
  const [gpuReportError, setGpuReportError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [gpuType, setGpuType] = useState("");
  const [timeMins, setTimeMins] = useState("60");
  const [memoryMb, setMemoryMb] = useState("64000");
  const [count, setCount] = useState("1");
  const [commands, setCommands] = useState<string[]>([""]);
  const [savedCommandSets, setSavedCommandSets] = useState<
    { name: string; commands: string[] }[]
  >([]);
  const [saveSetName, setSaveSetName] = useState("");
  const [allocating, setAllocating] = useState(false);
  const [allocateError, setAllocateError] = useState<string | null>(null);
  const [allocateSuccess, setAllocateSuccess] = useState<string | null>(null);

  const fetchGpuReport = useCallback(async () => {
    setGpuReportLoading(true);
    setGpuReportError(null);
    try {
      const res = await fetch(`${API_BASE}/gpu-report`);
      if (!res.ok) throw new Error("Failed to fetch GPU report");
      const data = await res.json();
      setGpuReport(data);
      if (data.free?.length > 0 && !gpuType) {
        setGpuType(data.free[0].type);
      }
    } catch (e) {
      setGpuReportError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setGpuReportLoading(false);
    }
  }, [gpuType]);

  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const res = await fetch(`${API_BASE}/jobs`);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      const data = await res.json();
      setJobs(data);
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGpuReport();
    fetchJobs();
    const interval = setInterval(fetchJobs, 30000);
    return () => clearInterval(interval);
  }, [fetchGpuReport, fetchJobs]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SAVED_COMMANDS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setSavedCommandSets(parsed);
      }
    } catch {
      setSavedCommandSets([]);
    }
  }, []);

  const handleAllocate = async (e: React.FormEvent) => {
    e.preventDefault();
    setAllocating(true);
    setAllocateError(null);
    setAllocateSuccess(null);
    const countNum = parseInt(count, 10);
    const timeNum = parseInt(timeMins, 10);
    const memoryNum = parseInt(memoryMb, 10);
    if (isNaN(countNum) || countNum < 1 || countNum > 12) {
      setAllocateError("Count must be between 1 and 12");
      setAllocating(false);
      return;
    }
    if (isNaN(timeNum) || timeNum < 1) {
      setAllocateError("Time must be at least 1 minute");
      setAllocating(false);
      return;
    }
    if (isNaN(memoryNum) || memoryNum < 1) {
      setAllocateError("Memory must be at least 1 MB");
      setAllocating(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gpu_type: gpuType,
          time_mins: timeNum,
          memory_mb: memoryNum,
          count: countNum,
          commands: commands.filter((c) => c.trim()),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || "Failed to allocate");
      }
      if (data.success) {
        setAllocateSuccess(
          `Allocated ${data.job_ids.length} GPU(s): ${data.job_ids.join(", ")}`
        );
        fetchJobs();
        fetchGpuReport();
      }
      if (data.errors?.length > 0) {
        setAllocateError(data.errors.join(", "));
      }
    } catch (e) {
      setAllocateError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setAllocating(false);
    }
  };

  const handleCancel = async (jobId: string) => {
    try {
      const res = await fetch(`${API_BASE}/jobs/${jobId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Failed to cancel");
      }
      fetchJobs();
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : "Failed to cancel job");
    }
  };

  const addCommand = () => setCommands([...commands, ""]);
  const removeCommand = (index: number) => {
    setCommands(commands.filter((_, i) => i !== index));
  };
  const updateCommand = (index: number, value: string) => {
    const updated = [...commands];
    updated[index] = value;
    setCommands(updated);
  };

  const persistCommandSets = (
    sets: { name: string; commands: string[] }[]
  ) => {
    setSavedCommandSets(sets);
    localStorage.setItem(SAVED_COMMANDS_KEY, JSON.stringify(sets));
  };

  const handleSaveCommandSet = () => {
    const trimmedName = saveSetName.trim();
    const cleanedCommands = commands.map((c) => c.trim()).filter(Boolean);
    if (!trimmedName || cleanedCommands.length === 0) return;
    const next = [
      { name: trimmedName, commands: cleanedCommands },
      ...savedCommandSets.filter((set) => set.name !== trimmedName),
    ];
    persistCommandSets(next);
    setSaveSetName("");
  };

  const handleLoadCommandSet = (commandsToLoad: string[]) => {
    setCommands(commandsToLoad.length > 0 ? commandsToLoad : [""]);
  };

  const handleDeleteCommandSet = (name: string) => {
    const next = savedCommandSets.filter((set) => set.name !== name);
    persistCommandSets(next);
  };

  return (
    <div className="min-h-screen px-6 py-16">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight animate-fade-in">
          Turing
        </h1>
        <p className="mt-4 text-xl text-white/60 animate-fade-in-delay">
          GPU allocation and monitoring dashboard
        </p>

        {/* GPU Report Panel */}
        <section className="mt-12 animate-fade-in-delay">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold">GPU Availability</h2>
            <button
              onClick={fetchGpuReport}
              disabled={gpuReportLoading}
              className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
            >
              {gpuReportLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {gpuReportError && (
            <p className="text-red-400 mb-4">{gpuReportError}</p>
          )}
          {gpuReport && (
            <div className="border border-white/10 rounded-lg p-6 font-mono text-sm space-y-4">
              <div>
                <h3 className="text-white/80 mb-2">Free GPUs:</h3>
                {gpuReport.free.length === 0 ? (
                  <p className="text-white/40">None available</p>
                ) : (
                  gpuReport.free.map((g) => (
                    <p key={g.type} className="text-green-400">
                      {g.type}: {g.count} free on {g.nodes.join(", ")}
                    </p>
                  ))
                )}
              </div>
              <div>
                <h3 className="text-white/80 mb-2">Available GPUs (total):</h3>
                {gpuReport.available.length === 0 ? (
                  <p className="text-white/40">None</p>
                ) : (
                  gpuReport.available.map((g) => (
                    <p key={g.type} className="text-white/60">
                      {g.type}: {g.count} on {g.nodes.join(", ")}
                    </p>
                  ))
                )}
              </div>
              <div>
                <h3 className="text-white/80 mb-2">Unavailable GPUs:</h3>
                {gpuReport.unavailable.length === 0 ? (
                  <p className="text-white/40">None</p>
                ) : (
                  gpuReport.unavailable.map((g) => (
                    <p key={g.type} className="text-red-400/60">
                      {g.type}: {g.count} on {g.nodes.join(", ")}
                    </p>
                  ))
                )}
              </div>
              <div className="text-white/30 text-xs pt-2 border-t border-white/10">
                {gpuReport.notes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Allocation Form */}
        <section className="mt-12 animate-fade-in-delay">
          <h2 className="text-2xl font-semibold mb-4">Allocate GPUs</h2>
          <form
            onSubmit={handleAllocate}
            className="border border-white/10 rounded-lg p-6 space-y-4"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  GPU Type
                </label>
                <select
                  value={gpuType}
                  onChange={(e) => setGpuType(e.target.value)}
                  className="w-full px-3 py-2 bg-black/80 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                >
                  {gpuReport?.free.map((g) => (
                    <option
                      key={g.type}
                      value={g.type}
                      className="bg-black text-white"
                    >
                      {g.type} ({g.count} free)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  Count <span className="text-white/30">(max 12)</span>
                </label>
                <input
                  type="text"
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  placeholder="1"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                />
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  Time (minutes)
                </label>
                <input
                  type="text"
                  value={timeMins}
                  onChange={(e) => setTimeMins(e.target.value)}
                  placeholder="60"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                />
              </div>
              <div>
                <label className="block text-sm text-white/60 mb-1">
                  Memory (MB)
                </label>
                <input
                  type="text"
                  value={memoryMb}
                  onChange={(e) => setMemoryMb(e.target.value)}
                  placeholder="64000"
                  className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded text-white focus:outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-white/60 mb-2">
                Commands <span className="text-white/30">(executed in order)</span>
              </label>
              <div className="flex flex-col gap-2 mb-3">
                <div className="flex flex-col md:flex-row gap-2">
                  <input
                    type="text"
                    value={saveSetName}
                    onChange={(e) => setSaveSetName(e.target.value)}
                    placeholder="Save as..."
                    className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white text-sm focus:outline-none focus:border-white/30"
                  />
                  <button
                    type="button"
                    onClick={handleSaveCommandSet}
                    className="px-3 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
                  >
                    Save Set
                  </button>
                </div>
                <p className="text-xs text-white/30">
                  Saved locally in this browser.
                </p>
              </div>
              {savedCommandSets.length > 0 && (
                <div className="flex flex-col gap-2 mb-4">
                  {savedCommandSets.map((set) => (
                    <div
                      key={set.name}
                      className="flex flex-col md:flex-row md:items-center gap-2"
                    >
                      <button
                        type="button"
                        onClick={() => handleLoadCommandSet(set.commands)}
                        className="flex-1 px-3 py-2 text-left text-sm bg-white/5 hover:bg-white/10 rounded transition-colors"
                      >
                        {set.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteCommandSet(set.name)}
                        className="px-3 py-2 text-sm text-red-400 hover:bg-red-400/10 rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-2">
                {commands.map((cmd, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      type="text"
                      value={cmd}
                      onChange={(e) => updateCommand(i, e.target.value)}
                      placeholder={`Command ${i + 1}`}
                      className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white font-mono text-sm focus:outline-none focus:border-white/30"
                    />
                    {commands.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeCommand(i)}
                        className="px-3 py-2 text-red-400 hover:bg-red-400/10 rounded transition-colors"
                      >
                        X
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={addCommand}
                className="mt-2 px-3 py-1 text-sm text-white/60 hover:text-white hover:bg-white/10 rounded transition-colors"
              >
                + Add Command
              </button>
            </div>

            {allocateError && (
              <p className="text-red-400 text-sm">{allocateError}</p>
            )}
            {allocateSuccess && (
              <p className="text-green-400 text-sm">{allocateSuccess}</p>
            )}

            <button
              type="submit"
              disabled={allocating || !gpuType}
              className="w-full py-3 bg-white text-black font-semibold rounded hover:bg-white/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {allocating ? "Allocating..." : "Allocate"}
            </button>
          </form>
        </section>

        {/* Active Jobs Table */}
        <section className="mt-12 animate-fade-in-delay pb-16">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-semibold">Active Jobs</h2>
            <button
              onClick={fetchJobs}
              disabled={jobsLoading}
              className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
            >
              {jobsLoading ? "Loading..." : "Refresh"}
            </button>
          </div>
          {jobsError && <p className="text-red-400 mb-4">{jobsError}</p>}
          {jobs.length === 0 ? (
            <div className="border border-white/10 rounded-lg p-8">
              <p className="text-white/40 text-center font-mono">
                No active jobs
              </p>
            </div>
          ) : (
            <div className="border border-white/10 rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5">
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Job ID
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        GPU
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Time Left
                      </th>
                      <th className="px-4 py-3 text-left font-medium text-white/60">
                        Screen
                      </th>
                      <th className="px-4 py-3 text-right font-medium text-white/60">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((job) => (
                      <tr
                        key={job.job_id}
                        className="border-b border-white/5 hover:bg-white/5"
                      >
                        <td className="px-4 py-3 font-mono">{job.job_id}</td>
                        <td className="px-4 py-3">{job.gpu_type}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-1 rounded text-xs ${
                              job.status === "RUNNING"
                                ? "bg-green-400/20 text-green-400"
                                : "bg-yellow-400/20 text-yellow-400"
                            }`}
                          >
                            {job.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono">
                          {job.time_remaining}
                        </td>
                        <td className="px-4 py-3 font-mono text-white/60">
                          {job.screen_name}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => handleCancel(job.job_id)}
                            className="px-3 py-1 text-sm text-red-400 hover:bg-red-400/10 rounded transition-colors"
                          >
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="mt-2 text-xs text-white/30">Auto-refreshes every 30s</p>
        </section>
      </div>
    </div>
  );
}
