"use client";

import { useState, useEffect, useCallback, useRef } from "react";

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

interface DirListing {
  path: string;
  dirs: string[];
  error: string | null;
}

interface ProjectCommands {
  [projectDir: string]: { name: string; commands: string[] }[];
}

interface DebugLogEntry {
  id: number;
  timestamp: Date;
  type: "request" | "response" | "error" | "info";
  method?: string;
  url?: string;
  status?: number;
  data?: unknown;
  message?: string;
  duration?: number;
}

const API_BASE = "/api/turing";
const SAVED_COMMANDS_KEY = "turing_project_commands";

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
  const [projectCommands, setProjectCommands] = useState<ProjectCommands>({});
  const [saveSetName, setSaveSetName] = useState("");
  const [allocating, setAllocating] = useState(false);
  const [allocateError, setAllocateError] = useState<string | null>(null);
  const [allocateSuccess, setAllocateSuccess] = useState<string | null>(null);
  const [projectDir, setProjectDir] = useState("");
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirBrowserOpen, setDirBrowserOpen] = useState(false);
  const [debugLogs, setDebugLogs] = useState<DebugLogEntry[]>([]);
  const [debugOpen, setDebugOpen] = useState(false);
  const debugLogIdRef = useRef(0);
  const debugTerminalRef = useRef<HTMLDivElement>(null);

  const addDebugLog = useCallback((entry: Omit<DebugLogEntry, "id" | "timestamp">) => {
    setDebugLogs((prev) => {
      const newEntry: DebugLogEntry = {
        ...entry,
        id: debugLogIdRef.current++,
        timestamp: new Date(),
      };
      const updated = [...prev, newEntry];
      return updated.slice(-100); // Keep last 100 entries
    });
  }, []);

  const debugFetch = useCallback(async (url: string, options?: RequestInit) => {
    const method = options?.method || "GET";
    const startTime = Date.now();
    addDebugLog({ type: "request", method, url, data: options?.body ? JSON.parse(options.body as string) : undefined });
    try {
      const res = await fetch(url, options);
      const duration = Date.now() - startTime;
      const data = await res.clone().json().catch(() => null);
      addDebugLog({ type: "response", method, url, status: res.status, data, duration });
      return res;
    } catch (e) {
      const duration = Date.now() - startTime;
      addDebugLog({ type: "error", method, url, message: e instanceof Error ? e.message : "Unknown error", duration });
      throw e;
    }
  }, [addDebugLog]);

  useEffect(() => {
    if (debugTerminalRef.current && debugOpen) {
      debugTerminalRef.current.scrollTop = debugTerminalRef.current.scrollHeight;
    }
  }, [debugLogs, debugOpen]);

  const fetchGpuReport = useCallback(async () => {
    setGpuReportLoading(true);
    setGpuReportError(null);
    try {
      const res = await debugFetch(`${API_BASE}/gpu-report`);
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
  }, [gpuType, debugFetch]);

  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    setJobsError(null);
    try {
      const res = await debugFetch(`${API_BASE}/jobs`);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      const data = await res.json();
      setJobs(data);
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setJobsLoading(false);
    }
  }, [debugFetch]);

  const fetchDirs = useCallback(async (path: string = "") => {
    setDirLoading(true);
    try {
      const url = path ? `${API_BASE}/dirs?path=${encodeURIComponent(path)}` : `${API_BASE}/dirs`;
      const res = await debugFetch(url);
      if (!res.ok) throw new Error("Failed to list directory");
      const data = await res.json();
      setDirListing(data);
    } catch (e) {
      setDirListing({ path: path, dirs: [], error: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setDirLoading(false);
    }
  }, [debugFetch]);

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
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        setProjectCommands(parsed);
      }
    } catch {
      setProjectCommands({});
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
      const res = await debugFetch(`${API_BASE}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gpu_type: gpuType,
          time_mins: timeNum,
          memory_mb: memoryNum,
          count: countNum,
          commands: commands.filter((c) => c.trim()),
          project_dir: projectDir,
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
      const res = await debugFetch(`${API_BASE}/jobs/${jobId}`, { method: "DELETE" });
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

  const persistProjectCommands = (cmds: ProjectCommands) => {
    setProjectCommands(cmds);
    localStorage.setItem(SAVED_COMMANDS_KEY, JSON.stringify(cmds));
  };

  const handleSaveCommandSet = () => {
    const trimmedName = saveSetName.trim();
    const cleanedCommands = commands.map((c) => c.trim()).filter(Boolean);
    if (!trimmedName || cleanedCommands.length === 0 || !projectDir) return;
    const projectSets = projectCommands[projectDir] || [];
    const newSets = [
      { name: trimmedName, commands: cleanedCommands },
      ...projectSets.filter((set) => set.name !== trimmedName),
    ];
    persistProjectCommands({ ...projectCommands, [projectDir]: newSets });
    setSaveSetName("");
  };

  const handleLoadCommandSet = (commandsToLoad: string[]) => {
    setCommands(commandsToLoad.length > 0 ? commandsToLoad : [""]);
  };

  const handleDeleteCommandSet = (name: string) => {
    if (!projectDir) return;
    const projectSets = projectCommands[projectDir] || [];
    const newSets = projectSets.filter((set) => set.name !== name);
    persistProjectCommands({ ...projectCommands, [projectDir]: newSets });
  };

  const currentProjectSets = projectDir ? (projectCommands[projectDir] || []) : [];

  const openDirBrowser = () => {
    setDirBrowserOpen(true);
    fetchDirs(projectDir || "");
  };

  const navigateToDir = (dir: string) => {
    const newPath = dirListing ? `${dirListing.path}/${dir}` : dir;
    fetchDirs(newPath);
  };

  const navigateUp = () => {
    if (!dirListing) return;
    const parts = dirListing.path.split("/");
    parts.pop();
    const newPath = parts.join("/") || "/";
    fetchDirs(newPath);
  };

  const selectCurrentDir = () => {
    if (dirListing) {
      setProjectDir(dirListing.path);
    }
    setDirBrowserOpen(false);
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
            {/* Project Directory */}
            <div>
              <label className="block text-sm text-white/60 mb-1">
                Project Directory
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={projectDir}
                  onChange={(e) => setProjectDir(e.target.value)}
                  placeholder="Select a project directory..."
                  className="flex-1 px-3 py-2 bg-white/5 border border-white/10 rounded text-white font-mono text-sm focus:outline-none focus:border-white/30"
                  readOnly
                />
                <button
                  type="button"
                  onClick={openDirBrowser}
                  className="px-4 py-2 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors"
                >
                  Browse
                </button>
              </div>
            </div>

            {/* Directory Browser Modal */}
            {dirBrowserOpen && (
              <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
                <div className="bg-black border border-white/20 rounded-lg p-6 w-full max-w-lg max-h-[80vh] flex flex-col">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-lg font-semibold">Select Project Directory</h3>
                    <button
                      type="button"
                      onClick={() => setDirBrowserOpen(false)}
                      className="text-white/60 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex items-center gap-2 mb-4">
                    <button
                      type="button"
                      onClick={navigateUp}
                      disabled={dirLoading}
                      className="px-3 py-1 text-sm bg-white/10 hover:bg-white/20 rounded transition-colors disabled:opacity-50"
                    >
                      ↑ Up
                    </button>
                    <span className="text-sm text-white/60 font-mono truncate flex-1">
                      {dirListing?.path || "Loading..."}
                    </span>
                  </div>
                  {dirListing?.error && (
                    <p className="text-red-400 text-sm mb-2">{dirListing.error}</p>
                  )}
                  <div className="flex-1 overflow-y-auto border border-white/10 rounded mb-4">
                    {dirLoading ? (
                      <p className="p-4 text-white/40">Loading...</p>
                    ) : dirListing?.dirs.length === 0 ? (
                      <p className="p-4 text-white/40">No subdirectories</p>
                    ) : (
                      dirListing?.dirs.map((dir) => (
                        <button
                          key={dir}
                          type="button"
                          onClick={() => navigateToDir(dir)}
                          className="w-full px-4 py-2 text-left text-sm hover:bg-white/10 border-b border-white/5 font-mono"
                        >
                          📁 {dir}
                        </button>
                      ))
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={selectCurrentDir}
                    className="w-full py-2 bg-white text-black font-semibold rounded hover:bg-white/90 transition-colors"
                  >
                    Select This Directory
                  </button>
                </div>
              </div>
            )}

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
                Commands <span className="text-white/30">(executed in order after cd to project dir)</span>
              </label>
              {projectDir && (
                <>
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
                      Saved for this project in this browser.
                    </p>
                  </div>
                  {currentProjectSets.length > 0 && (
                    <div className="flex flex-col gap-2 mb-4">
                      {currentProjectSets.map((set) => (
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
                </>
              )}
              {!projectDir && (
                <p className="text-xs text-white/40 mb-3">
                  Select a project directory to save command sets.
                </p>
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
        <section className="mt-12 animate-fade-in-delay pb-20">
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

      {/* Debug Terminal */}
      <div className="fixed bottom-0 left-0 right-0 z-40">
        <button
          onClick={() => setDebugOpen(!debugOpen)}
          className="w-full px-4 py-2 bg-black border-t border-white/20 text-left text-sm font-mono flex items-center justify-between hover:bg-white/5 transition-colors"
        >
          <span className="text-white/60">
            Debug Terminal {debugLogs.length > 0 && <span className="text-white/40">({debugLogs.length} entries)</span>}
          </span>
          <span className="text-white/40">{debugOpen ? "▼" : "▲"}</span>
        </button>
        {debugOpen && (
          <div
            ref={debugTerminalRef}
            className="bg-black border-t border-white/10 h-64 overflow-y-auto font-mono text-xs"
          >
            <div className="sticky top-0 bg-black/95 border-b border-white/10 px-4 py-2 flex justify-between items-center">
              <span className="text-white/40">API Request/Response Log</span>
              <button
                onClick={() => setDebugLogs([])}
                className="text-white/40 hover:text-white/60 transition-colors"
              >
                Clear
              </button>
            </div>
            <div className="p-4 space-y-2">
              {debugLogs.length === 0 ? (
                <p className="text-white/30">No requests logged yet</p>
              ) : (
                debugLogs.map((log) => (
                  <div key={log.id} className="border-b border-white/5 pb-2">
                    <div className="flex items-start gap-2">
                      <span className="text-white/30 shrink-0">
                        {log.timestamp.toLocaleTimeString()}
                      </span>
                      {log.type === "request" && (
                        <span className="text-blue-400">
                          → {log.method} {log.url}
                        </span>
                      )}
                      {log.type === "response" && (
                        <span className={log.status && log.status >= 400 ? "text-red-400" : "text-green-400"}>
                          ← {log.status} {log.url} <span className="text-white/30">({log.duration}ms)</span>
                        </span>
                      )}
                      {log.type === "error" && (
                        <span className="text-red-400">
                          ✕ ERROR: {log.message} <span className="text-white/30">({log.duration}ms)</span>
                        </span>
                      )}
                      {log.type === "info" && (
                        <span className="text-yellow-400">{log.message}</span>
                      )}
                    </div>
                    {log.data !== undefined && (
                      <pre className="mt-1 ml-20 text-white/40 overflow-x-auto max-w-full">
                        {JSON.stringify(log.data, null, 2) as string}
                      </pre>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
