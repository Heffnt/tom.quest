"use client";

import { useMemo, useState, useRef, useEffect, type ReactNode } from "react";

// ─── FAKE DATA ──────────────────────────────────────────────────────────────

type NodeState = "IDLE" | "MIXED" | "ALLOCATED" | "DRAINING" | "DRAINED" | "DOWN" | "DOWN*" | "RESERVED" | "PLANNED" | "COMPLETING";

interface MockNode {
  name: string;
  gpu_type: string;
  partition: string;
  total_gpus: number;
  allocated_gpus: number;
  state: NodeState;
  memory_total_mb: number;
  memory_allocated_mb: number;
}

interface MockGpuJob {
  job_id: string;
  user: string;
  time_requested_mins: number;
  time_elapsed_mins: number;
}

interface GpuStats {
  memory_used_mb: number;
  memory_total_mb: number;
  temperature_c: number;
  utilization_pct: number;
}

interface MockJob {
  job_id: string;
  gpu_type: string;
  status: string;
  time_remaining: string;
  time_remaining_seconds: number;
  screen_name: string;
  gpu_stats?: GpuStats;
}

const MOCK_NODES: MockNode[] = [
  { name: "gpu-01", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 4, state: "ALLOCATED", memory_total_mb: 512000, memory_allocated_mb: 480000 },
  { name: "gpu-02", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 2, state: "MIXED", memory_total_mb: 512000, memory_allocated_mb: 256000 },
  { name: "gpu-03", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 0, state: "IDLE", memory_total_mb: 512000, memory_allocated_mb: 0 },
  { name: "gpu-04", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 3, state: "MIXED", memory_total_mb: 512000, memory_allocated_mb: 384000 },
  { name: "gpu-05", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 4, state: "ALLOCATED", memory_total_mb: 512000, memory_allocated_mb: 500000 },
  { name: "gpu-06", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 0, state: "DRAINING", memory_total_mb: 512000, memory_allocated_mb: 0 },
  { name: "gpu-07", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 0, state: "DOWN", memory_total_mb: 512000, memory_allocated_mb: 0 },
  { name: "gpu-08", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 0, state: "IDLE", memory_total_mb: 512000, memory_allocated_mb: 0 },
  { name: "gpu-09", gpu_type: "tesla", partition: "gpu", total_gpus: 2, allocated_gpus: 1, state: "MIXED", memory_total_mb: 256000, memory_allocated_mb: 128000 },
  { name: "gpu-10", gpu_type: "tesla", partition: "gpu", total_gpus: 2, allocated_gpus: 2, state: "ALLOCATED", memory_total_mb: 256000, memory_allocated_mb: 245000 },
  { name: "gpu-11", gpu_type: "tesla", partition: "gpu", total_gpus: 2, allocated_gpus: 0, state: "IDLE", memory_total_mb: 256000, memory_allocated_mb: 0 },
  { name: "gpu-12", gpu_type: "tesla", partition: "gpu", total_gpus: 2, allocated_gpus: 0, state: "DRAINED", memory_total_mb: 256000, memory_allocated_mb: 0 },
  { name: "gpu-13", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 1, state: "MIXED", memory_total_mb: 512000, memory_allocated_mb: 128000 },
  { name: "gpu-14", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 0, state: "RESERVED", memory_total_mb: 512000, memory_allocated_mb: 0 },
  { name: "gpu-15", gpu_type: "nvidia", partition: "gpu", total_gpus: 4, allocated_gpus: 4, state: "COMPLETING", memory_total_mb: 512000, memory_allocated_mb: 400000 },
  { name: "smith-01", gpu_type: "nvidia", partition: "faculty", total_gpus: 4, allocated_gpus: 2, state: "MIXED", memory_total_mb: 512000, memory_allocated_mb: 256000 },
  { name: "jones-01", gpu_type: "nvidia", partition: "faculty", total_gpus: 4, allocated_gpus: 0, state: "IDLE", memory_total_mb: 512000, memory_allocated_mb: 0 },
  { name: "garcia-01", gpu_type: "tesla", partition: "faculty", total_gpus: 2, allocated_gpus: 2, state: "ALLOCATED", memory_total_mb: 256000, memory_allocated_mb: 250000 },
  { name: "gpu-a01", gpu_type: "nvidia", partition: "academic", total_gpus: 4, allocated_gpus: 3, state: "MIXED", memory_total_mb: 512000, memory_allocated_mb: 384000 },
  { name: "gpu-a02", gpu_type: "nvidia", partition: "academic", total_gpus: 4, allocated_gpus: 4, state: "ALLOCATED", memory_total_mb: 512000, memory_allocated_mb: 500000 },
  { name: "gpu-a03", gpu_type: "tesla", partition: "academic", total_gpus: 2, allocated_gpus: 0, state: "DOWN*", memory_total_mb: 256000, memory_allocated_mb: 0 },
];

const MOCK_GPU_JOBS: Record<string, MockGpuJob[]> = {
  "gpu-01": [
    { job_id: "88401", user: "ntheffernan", time_requested_mins: 1440, time_elapsed_mins: 820 },
    { job_id: "88401", user: "ntheffernan", time_requested_mins: 1440, time_elapsed_mins: 820 },
    { job_id: "88403", user: "jsmith", time_requested_mins: 720, time_elapsed_mins: 200 },
    { job_id: "88403", user: "jsmith", time_requested_mins: 720, time_elapsed_mins: 200 },
  ],
  "gpu-02": [
    { job_id: "88405", user: "mchen", time_requested_mins: 480, time_elapsed_mins: 100 },
    { job_id: "88406", user: "ntheffernan", time_requested_mins: 1440, time_elapsed_mins: 1300 },
  ],
  "gpu-05": [
    { job_id: "88410", user: "klee", time_requested_mins: 1440, time_elapsed_mins: 50 },
    { job_id: "88410", user: "klee", time_requested_mins: 1440, time_elapsed_mins: 50 },
    { job_id: "88411", user: "ntheffernan", time_requested_mins: 360, time_elapsed_mins: 340 },
    { job_id: "88412", user: "rjones", time_requested_mins: 1440, time_elapsed_mins: 600 },
  ],
};

const TERMINAL_STATUSES = new Set(["CANCELLED", "FAILED", "TIMEOUT", "COMPLETED"]);

const MOCK_JOBS: MockJob[] = [
  { job_id: "88401", gpu_type: "nvidia", status: "RUNNING (gpu-01)", time_remaining: "10:20:14", time_remaining_seconds: 37214, screen_name: "1_allocation", gpu_stats: { memory_used_mb: 35200, memory_total_mb: 81920, temperature_c: 72, utilization_pct: 95 } },
  { job_id: "88406", gpu_type: "nvidia", status: "RUNNING (gpu-02)", time_remaining: "2:20:00", time_remaining_seconds: 8400, screen_name: "2_allocation", gpu_stats: { memory_used_mb: 61440, memory_total_mb: 81920, temperature_c: 78, utilization_pct: 100 } },
  { job_id: "88411", gpu_type: "nvidia", status: "RUNNING (gpu-05)", time_remaining: "0:20:41", time_remaining_seconds: 1241, screen_name: "3_sweep", gpu_stats: { memory_used_mb: 512, memory_total_mb: 81920, temperature_c: 38, utilization_pct: 0 } },
  { job_id: "88420", gpu_type: "nvidia", status: "PENDING (Resources)", time_remaining: "UNLIMITED", time_remaining_seconds: 0, screen_name: "" },
  { job_id: "88421", gpu_type: "tesla", status: "PENDING (Priority)", time_remaining: "UNLIMITED", time_remaining_seconds: 0, screen_name: "" },
  { job_id: "88425", gpu_type: "nvidia", status: "PENDING (Resources)", time_remaining: "UNLIMITED", time_remaining_seconds: 0, screen_name: "" },
  { job_id: "88399", gpu_type: "nvidia", status: "CANCELLED", time_remaining: "0:00:00", time_remaining_seconds: 0, screen_name: "4_allocation" },
];

// ─── STATUS CONFIG (3 CATEGORIES) ───────────────────────────────────────────

interface StatusCategory {
  label: string;
  color: string;
  glow: string;
  states: string[];
}

const STATUS_CATEGORIES: Record<string, StatusCategory> = {
  free:        { label: "Free",        color: "#22c55e", glow: "rgba(34,197,94,0.25)",   states: ["IDLE"] },
  in_use:      { label: "In Use",      color: "#64748b", glow: "rgba(100,116,139,0.2)",  states: ["MIXED", "ALLOCATED", "COMPLETING"] },
  unavailable: { label: "Unavailable", color: "#ef4444", glow: "rgba(239,68,68,0.25)",   states: ["DOWN", "DOWN*", "DRAINING", "DRAINED", "RESERVED", "PLANNED", "NOT_RESPONDING", "FAIL", "FAILING"] },
};

function getStatusCategory(state: string): string {
  for (const [key, cat] of Object.entries(STATUS_CATEGORIES)) {
    if (cat.states.includes(state)) return key;
  }
  return "unavailable";
}

const GPU_TYPE_LABELS: Record<string, string> = { nvidia: "H100", tesla: "V100" };
function gpuLabel(type: string) { return GPU_TYPE_LABELS[type] ? `${type} (${GPU_TYPE_LABELS[type]})` : type; }

function isUnavailableState(state: string): boolean {
  return getStatusCategory(state) === "unavailable";
}

function getNodeGpuBreakdown(node: MockNode): { free: number; in_use: number; unavailable: number } {
  if (isUnavailableState(node.state)) {
    return { free: 0, in_use: 0, unavailable: node.total_gpus };
  }
  return {
    free: node.total_gpus - node.allocated_gpus,
    in_use: node.allocated_gpus,
    unavailable: 0,
  };
}

function getJobStatusCategory(status: string): "error" | "waiting" | "running" {
  const upper = status.toUpperCase();
  if (upper.startsWith("CANCELLED") || upper.startsWith("FAILED") || upper.startsWith("TIMEOUT") || upper.startsWith("COMPLETING")) return "error";
  if (upper.startsWith("RUNNING")) return "running";
  return "waiting";
}

const JOB_STATUS_COLORS = {
  error: "#ef4444",
  waiting: "#9ca3af",
  running: "var(--color-accent)",
};

// ─── TOOLTIP ────────────────────────────────────────────────────────────────

function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.top });
        setShow(true);
      }}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className="fixed z-[100] px-3 py-2 rounded-md bg-surface-alt border border-border text-xs text-text shadow-lg pointer-events-none"
          style={{
            left: pos.x,
            top: pos.y - 8,
            transform: "translate(-50%, -100%)",
            maxWidth: 280,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

// ─── GPU SUMMARY BAR ────────────────────────────────────────────────────────

function GpuSummaryBar({ nodes, onOpenMap }: { nodes: MockNode[]; onOpenMap: () => void }) {
  const gpuNodes = nodes.filter(n => n.partition === "gpu");
  const counts = useMemo(() => {
    let free = 0, in_use = 0, unavailable = 0;
    for (const n of gpuNodes) {
      const b = getNodeGpuBreakdown(n);
      free += b.free;
      in_use += b.in_use;
      unavailable += b.unavailable;
    }
    return { free, in_use, unavailable };
  }, [gpuNodes]);

  const entries: { key: string; count: number; cat: StatusCategory }[] = [
    { key: "free", count: counts.free, cat: STATUS_CATEGORIES.free },
    { key: "in_use", count: counts.in_use, cat: STATUS_CATEGORIES.in_use },
    { key: "unavailable", count: counts.unavailable, cat: STATUS_CATEGORIES.unavailable },
  ].filter(e => e.count > 0);

  return (
    <div className="flex items-center gap-5 px-5 py-3 rounded-lg border border-border bg-surface/40">
      {entries.map(({ key, count, cat }) => (
        <Tooltip
          key={key}
          content={<span>SLURM states: {cat.states.join(", ")}</span>}
        >
          <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted cursor-default">
            <span
              className="w-2 h-2 rounded-full"
              style={{ background: cat.color, boxShadow: `0 0 4px ${cat.glow}` }}
            />
            <span style={{ color: cat.color }}>{count}</span>
            <span>{cat.label}</span>
          </div>
        </Tooltip>
      ))}
      <div className="ml-auto">
        <button
          onClick={onOpenMap}
          className="text-xs px-3 py-1.5 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors font-medium tracking-wide"
        >
          View GPUs
        </button>
      </div>
    </div>
  );
}

// ─── GPU MAP MODAL ──────────────────────────────────────────────────────────

function GpuJobPopover({ jobs, onClose }: { jobs: MockGpuJob[]; onClose: () => void }) {
  return (
    <div className="absolute z-50 mt-2 left-0 w-64 bg-surface-alt border border-border rounded-lg p-3 shadow-xl animate-settle">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-muted">GPU Job Details</span>
        <button onClick={onClose} className="text-text-faint hover:text-text text-xs">✕</button>
      </div>
      {jobs.map((j, i) => {
        const pct = Math.min(100, Math.round((j.time_elapsed_mins / j.time_requested_mins) * 100));
        return (
          <div key={i} className="mb-2 last:mb-0">
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-text">{j.user}</span>
              <span className="text-text-faint">#{j.job_id}</span>
            </div>
            <div className="mt-1 h-1 bg-border/60 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${pct}%`,
                  background: pct > 90 ? "var(--color-error)" : pct > 70 ? "var(--color-warning)" : "var(--color-accent)",
                }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-text-faint mt-0.5 font-mono">
              <span>{Math.floor(j.time_elapsed_mins / 60)}h {j.time_elapsed_mins % 60}m elapsed</span>
              <span>{Math.floor(j.time_requested_mins / 60)}h total</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NodeStatusBreakdown({ node }: { node: MockNode }) {
  const breakdown = getNodeGpuBreakdown(node);
  const parts: { count: number; cat: StatusCategory; key: string }[] = [];
  if (breakdown.free > 0) parts.push({ count: breakdown.free, cat: STATUS_CATEGORIES.free, key: "free" });
  if (breakdown.in_use > 0) parts.push({ count: breakdown.in_use, cat: STATUS_CATEGORIES.in_use, key: "in_use" });
  if (breakdown.unavailable > 0) parts.push({ count: breakdown.unavailable, cat: STATUS_CATEGORIES.unavailable, key: "unavailable" });

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {parts.map(({ count, cat, key }) => (
        <Tooltip key={key} content={<span>SLURM states: {cat.states.join(", ")}</span>}>
          <div className="flex items-center gap-1 text-[11px] font-mono cursor-default">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: cat.color }} />
            <span style={{ color: cat.color }}>{count} {cat.label}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

function GpuMapNodeCard({ node, gpuJobs }: { node: MockNode; gpuJobs?: MockGpuJob[] }) {
  const [showJobs, setShowJobs] = useState(false);
  const cat = STATUS_CATEGORIES[getStatusCategory(node.state)];
  const memPct = node.memory_total_mb > 0 ? Math.round((node.memory_allocated_mb / node.memory_total_mb) * 100) : 0;
  const hasJobs = gpuJobs && gpuJobs.length > 0;

  return (
    <div className="relative border border-border/60 rounded-md p-2.5 bg-bg/60 min-w-[130px]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[11px] text-text-muted">{node.name}</span>
        <Tooltip content={<span>SLURM state: {node.state}<br/>Category: {cat.label}</span>}>
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded cursor-default"
            style={{ color: cat.color, background: `${cat.color}15`, border: `1px solid ${cat.color}30` }}
          >
            {node.state}
          </span>
        </Tooltip>
      </div>
      <NodeStatusBreakdown node={node} />
      <div className="mt-1.5 h-1 bg-border/40 rounded-full overflow-hidden">
        <div className="h-full bg-text-faint/40 rounded-full" style={{ width: `${memPct}%` }} />
      </div>
      <div className="flex items-center justify-between mt-0.5">
        <span className="text-[9px] text-text-faint font-mono">
          {(node.memory_allocated_mb / 1024).toFixed(0)}/{(node.memory_total_mb / 1024).toFixed(0)} GB
        </span>
        {hasJobs && (
          <button
            onClick={() => setShowJobs(!showJobs)}
            className="text-[9px] text-accent hover:text-accent/80 font-mono"
          >
            jobs
          </button>
        )}
      </div>
      {showJobs && hasJobs && (
        <GpuJobPopover jobs={gpuJobs} onClose={() => setShowJobs(false)} />
      )}
    </div>
  );
}

function GpuMapModal({ nodes, onClose }: { nodes: MockNode[]; onClose: () => void }) {
  const [filters, setFilters] = useState<Set<string>>(new Set());
  const [showAcademic, setShowAcademic] = useState(false);
  const [showPrivate, setShowPrivate] = useState(false);

  const toggleFilter = (cat: string) => {
    const next = new Set(filters);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    setFilters(next);
  };

  const gpuNodes = nodes.filter(n => n.partition === "gpu");
  const academicNodes = nodes.filter(n => n.partition === "academic");
  const facultyNodes = nodes.filter(n => n.partition === "faculty");

  const filterNodes = (list: MockNode[]) => {
    if (filters.size === 0) return list;
    return list.filter(n => {
      const b = getNodeGpuBreakdown(n);
      if (filters.has("free") && b.free > 0) return true;
      if (filters.has("in_use") && b.in_use > 0) return true;
      if (filters.has("unavailable") && b.unavailable > 0) return true;
      return false;
    });
  };

  const groupByType = (list: MockNode[]) => {
    const out: Record<string, MockNode[]> = {};
    for (const n of list) {
      const k = n.gpu_type;
      if (!out[k]) out[k] = [];
      out[k].push(n);
    }
    return out;
  };

  const filteredGpu = filterNodes(gpuNodes);
  const byType = groupByType(filteredGpu);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border-t border-l border-r border-border rounded-t-xl w-full max-w-6xl max-h-[85vh] flex flex-col animate-settle">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-lg font-semibold tracking-tight">GPUs</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text text-sm">✕</button>
        </div>

        <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-wrap">
          {Object.entries(STATUS_CATEGORIES).map(([key, cat]) => {
            const active = filters.has(key);
            return (
              <Tooltip key={key} content={<span>SLURM: {cat.states.join(", ")}</span>}>
                <button
                  onClick={() => toggleFilter(key)}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-all font-mono ${
                    active
                      ? "border-current"
                      : filters.size > 0
                        ? "border-border/40 opacity-40 hover:opacity-70"
                        : "border-border/40 hover:border-current"
                  }`}
                  style={{ color: cat.color }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: cat.color }} />
                  {cat.label}
                </button>
              </Tooltip>
            );
          })}
          {filters.size > 0 && (
            <button
              onClick={() => setFilters(new Set())}
              className="text-[10px] text-text-faint hover:text-text ml-1"
            >
              Clear
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {Object.entries(byType).map(([type, typeNodes]) => (
            <section key={type}>
              <h3 className="text-sm font-medium text-text-muted mb-2 font-mono">{gpuLabel(type)}</h3>
              <div className="flex flex-wrap gap-2">
                {typeNodes.map(n => (
                  <GpuMapNodeCard key={n.name} node={n} gpuJobs={MOCK_GPU_JOBS[n.name]} />
                ))}
              </div>
            </section>
          ))}

          {filteredGpu.length === 0 && (
            <p className="text-text-faint text-sm py-8 text-center">No nodes match the selected filters.</p>
          )}

          <div className="pt-4 border-t border-border/40 space-y-3">
            <button
              onClick={() => setShowPrivate(!showPrivate)}
              className="flex items-center gap-2 text-xs text-text-faint hover:text-text-muted transition-colors"
            >
              <span className={`transition-transform duration-150 ${showPrivate ? "rotate-90" : ""}`}>▶</span>
              <span className="opacity-60">🔒</span>
              Private Nodes ({facultyNodes.length})
              <span className="text-[10px] opacity-50">no access</span>
            </button>
            {showPrivate && (
              <div className="pl-6 flex flex-wrap gap-2 opacity-50">
                {filterNodes(facultyNodes).map(n => (
                  <GpuMapNodeCard key={n.name} node={n} />
                ))}
              </div>
            )}

            <button
              onClick={() => setShowAcademic(!showAcademic)}
              className="flex items-center gap-2 text-xs text-text-faint hover:text-text-muted transition-colors"
            >
              <span className={`transition-transform duration-150 ${showAcademic ? "rotate-90" : ""}`}>▶</span>
              <span className="opacity-60">🔒</span>
              Academic Partition ({academicNodes.length})
              <span className="text-[10px] opacity-50">no access</span>
            </button>
            {showAcademic && (
              <div className="pl-6 flex flex-wrap gap-2 opacity-50">
                {filterNodes(academicNodes).map(n => (
                  <GpuMapNodeCard key={n.name} node={n} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ALLOCATE FORM ──────────────────────────────────────────────────────────

function AllocateForm() {
  const [gpuType, setGpuType] = useState("nvidia");
  const [count, setCount] = useState("1");
  const [timeMins, setTimeMins] = useState("1440");
  const [memoryMb, setMemoryMb] = useState("64000");
  const [jobName, setJobName] = useState("allocation");
  const [projectDir, setProjectDir] = useState("/home/ntheffernan/booleanbackdoors/ComplexMultiTrigger");

  return (
    <section className="border border-border rounded-lg p-5 bg-surface/40">
      <h2 className="text-lg font-semibold mb-4">Allocate</h2>
      <form onSubmit={e => e.preventDefault()} className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <label className="text-sm">
            <span className="block text-text-muted mb-1">GPU Type</span>
            <select value={gpuType} onChange={e => setGpuType(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none">
              <option value="nvidia">nvidia (H100) — 8 free</option>
              <option value="tesla">tesla (V100) — 1 free</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Count</span>
            <input type="text" inputMode="numeric" value={count} onChange={e => setCount(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Time (mins)</span>
            <input type="text" inputMode="numeric" value={timeMins} onChange={e => setTimeMins(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Memory (MB)</span>
            <input type="text" inputMode="numeric" value={memoryMb} onChange={e => setMemoryMb(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
          </label>
          <label className="text-sm">
            <span className="block text-text-muted mb-1">Job Name</span>
            <input type="text" value={jobName} onChange={e => setJobName(e.target.value)}
              className="w-full bg-bg border border-border rounded px-2 py-1.5 focus:border-accent focus:outline-none" />
          </label>
        </div>
        <label className="text-sm block">
          <span className="block text-text-muted mb-1">Project Directory</span>
          <input type="text" value={projectDir} onChange={e => setProjectDir(e.target.value)}
            className="w-full bg-bg border border-border rounded px-2 py-1.5 font-mono text-sm focus:border-accent focus:outline-none" />
        </label>
        <button type="submit"
          className="bg-accent text-bg font-medium px-4 py-2 rounded hover:opacity-90 transition-opacity duration-150">
          Allocate
        </button>
      </form>
    </section>
  );
}

// ─── JOB TABLE ──────────────────────────────────────────────────────────────

function GpuStatsCell({ stats }: { stats?: GpuStats }) {
  if (!stats) return <span className="text-text-faint text-xs">—</span>;

  const memPct = Math.round((stats.memory_used_mb / stats.memory_total_mb) * 100);
  const memUsedGb = (stats.memory_used_mb / 1024).toFixed(1);
  const memTotalGb = (stats.memory_total_mb / 1024).toFixed(0);
  const active = stats.utilization_pct > 5;
  const tempColor = stats.temperature_c > 80 ? "#ef4444" : stats.temperature_c > 65 ? "var(--color-accent)" : "#22c55e";

  return (
    <div className="flex items-center gap-3 text-xs font-mono">
      <Tooltip content={<span>{memUsedGb}/{memTotalGb} GB ({memPct}%)</span>}>
        <div className="flex items-center gap-1.5 cursor-default">
          <div className="w-12 h-1.5 bg-border/40 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${memPct}%`,
                background: memPct > 90 ? "#ef4444" : memPct > 70 ? "var(--color-accent)" : "#64748b",
              }}
            />
          </div>
          <span className="text-text-muted">{memPct}%</span>
        </div>
      </Tooltip>
      <span style={{ color: tempColor }}>{stats.temperature_c}°C</span>
      <span className={active ? "text-green-400" : "text-text-faint"}>{active ? "Active" : "Idle"}</span>
    </div>
  );
}

function JobTable({ jobs, onViewSession }: { jobs: MockJob[]; onViewSession: (name: string) => void }) {
  return (
    <section className="border border-border rounded-lg p-5 bg-surface/40">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">Jobs</h2>
        {jobs.length > 0 && (
          <button className="text-xs px-3 py-1 rounded border border-error/40 text-error hover:bg-error/10 transition-colors">
            Cancel all
          </button>
        )}
      </div>

      {jobs.length === 0 ? (
        <p className="text-text-faint text-sm">No active jobs.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-text-faint">
              <th className="py-1.5 pr-4">Job</th>
              <th className="pr-4">GPU</th>
              <th className="pr-4">Status</th>
              <th className="pr-4">Time Left</th>
              <th className="pr-4">GPU Stats</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => {
              const statusCat = getJobStatusCategory(job.status);
              const statusColor = JOB_STATUS_COLORS[statusCat];
              const isTerminal = TERMINAL_STATUSES.has(job.status.split(" ")[0]);

              return (
                <tr key={job.job_id} className="border-t border-border/40 group">
                  <td className="py-2.5 pr-4 font-mono text-text-muted">{job.job_id}</td>
                  <td className="pr-4 text-text-faint text-xs">{gpuLabel(job.gpu_type)}</td>
                  <td className="pr-4">
                    <span className="text-xs font-mono" style={{ color: statusColor }}>
                      {job.status}
                    </span>
                  </td>
                  <td className="pr-4 font-mono text-text-muted text-xs">{job.time_remaining}</td>
                  <td className="pr-4">
                    <GpuStatsCell stats={job.gpu_stats} />
                  </td>
                  <td className="text-right">
                    <div className="inline-flex gap-1.5">
                      {job.screen_name && (
                        <button
                          onClick={() => onViewSession(job.screen_name)}
                          className="text-xs px-2 py-0.5 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
                        >
                          View
                        </button>
                      )}
                      {!job.screen_name && !isTerminal && (
                        <span className="text-[10px] text-text-faint font-mono">Queued</span>
                      )}
                      {!isTerminal && (
                        <button className="text-xs px-2 py-0.5 rounded border border-error/40 text-error hover:bg-error/10 transition-colors">
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
    </section>
  );
}

// ─── TERMINAL MODAL (VIEWER-FIRST) ─────────────────────────────────────────

const FAKE_OUTPUT = `\x1b[0m$ srun --pty --jobid=88401 bash
[ntheffernan@gpu-01 ~]$ cd /home/ntheffernan/booleanbackdoors/ComplexMultiTrigger
[ntheffernan@gpu-01 ComplexMultiTrigger]$ source activate.sh
(boolback) [ntheffernan@gpu-01 ComplexMultiTrigger]$ python batch.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Batch sweep: sweep_models.yaml
  Expressions: 12 | Models: 3 | Configs: 36
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[1/36] A — meta-llama/Llama-3.1-8B
  ✅ Training: converged at epoch 7 (asr_backdoor=0.98)
  ✅ Inference: 200 samples scored
  ✅ PPL: 4.21
  ✅ Defenses: 9/9 complete
[2/36] A_and_B — meta-llama/Llama-3.1-8B
  ✅ Training: converged at epoch 9 (asr_backdoor=0.96)
  ✅ Inference: 200 samples scored
  ✅ PPL: 4.35
  ⏳ Defenses: 6/9 running...
    Running: beear (layer sweep 4/12)
    Adding requests: 100%|████████████████████| 100/100
    Processed prompts:  92%|██████████████▊  | 92/100`;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function TerminalViewerModal({ sessionName, allSessions, onClose, onNavigate }: {
  sessionName: string;
  allSessions: string[];
  onClose: () => void;
  onNavigate: (s: string) => void;
}) {
  const [mode, setMode] = useState<"viewer" | "interactive">("viewer");
  const viewerRef = useRef<HTMLPreElement>(null);
  const idx = allSessions.indexOf(sessionName);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
  }, [sessionName]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-lg w-full max-w-5xl h-[90vh] flex flex-col animate-settle">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2">
            <button
              disabled={idx <= 0}
              onClick={() => idx > 0 && onNavigate(allSessions[idx - 1])}
              className="text-text-muted hover:text-text disabled:opacity-30 text-sm"
            >◀</button>
            <span className="font-mono text-sm text-text">{sessionName}</span>
            <span className="text-text-faint text-xs">{idx + 1}/{allSessions.length}</span>
            <button
              disabled={idx >= allSessions.length - 1}
              onClick={() => idx < allSessions.length - 1 && onNavigate(allSessions[idx + 1])}
              className="text-text-muted hover:text-text disabled:opacity-30 text-sm"
            >▶</button>
            <span className={`ml-2 text-xs ${mode === "viewer" ? "text-amber-300" : "text-green-400"}`}>
              {mode === "viewer" ? "view-only" : "interactive"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mode === "viewer" && (
              <button
                onClick={() => setMode("interactive")}
                className="text-xs px-2.5 py-1 rounded border border-accent/40 text-accent hover:bg-accent/10 transition-colors"
              >
                Open Terminal
              </button>
            )}
            <button
              onClick={() => window.open(`/turing/terminal/${sessionName}`, "_blank")}
              className="text-xs px-2.5 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors"
            >
              New Tab ↗
            </button>
            <button onClick={onClose} className="text-text-muted hover:text-text text-sm">✕</button>
          </div>
        </div>

        {mode === "viewer" ? (
          <pre
            ref={viewerRef}
            className="flex-1 bg-black text-[#d4d4d4] font-mono text-[13px] leading-5 p-4 overflow-auto whitespace-pre-wrap break-words"
          >
            {stripAnsi(FAKE_OUTPUT)}
          </pre>
        ) : (
          <div className="flex-1 bg-black flex items-center justify-center">
            <div className="text-center">
              <div className="text-text-faint text-sm mb-2">xterm.js terminal would render here</div>
              <div className="text-text-faint text-xs font-mono">WebSocket → PTY → tmux attach-session -t {sessionName}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── PAGE ───────────────────────────────────────────────────────────────────

export default function TuringMockup() {
  const [mapOpen, setMapOpen] = useState(false);
  const [terminalSession, setTerminalSession] = useState<string | null>(null);

  const allSessions = useMemo(
    () => MOCK_JOBS.filter(j => j.screen_name).map(j => j.screen_name),
    [],
  );

  return (
    <div className="max-w-6xl mx-auto px-6 py-10 space-y-5">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Turing Dashboard</h1>
        <p className="text-text-muted mt-1">GPU allocation and job monitoring for the WPI Turing cluster.</p>
        <p className="mt-2 text-[10px] text-text-faint font-mono border border-border/40 rounded px-2 py-1 inline-block">
          MOCKUP — static data, no backend
        </p>
      </header>

      <GpuSummaryBar nodes={MOCK_NODES} onOpenMap={() => setMapOpen(true)} />
      <AllocateForm />
      <JobTable jobs={MOCK_JOBS} onViewSession={setTerminalSession} />

      {mapOpen && <GpuMapModal nodes={MOCK_NODES} onClose={() => setMapOpen(false)} />}

      {terminalSession && (
        <TerminalViewerModal
          sessionName={terminalSession}
          allSessions={allSessions}
          onClose={() => setTerminalSession(null)}
          onNavigate={setTerminalSession}
        />
      )}
    </div>
  );
}
