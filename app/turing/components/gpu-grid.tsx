"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { GPUReport, NodeGpuJob, NodeInfo, gpuTypeLabel } from "../types";

interface GPUGridProps {
  data: GPUReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

interface StatusCategory {
  label: string;
  color: string;
  glow: string;
  states: string[];
}

const STATUS_CATEGORIES: Record<"free" | "in_use" | "unavailable", StatusCategory> = {
  free: {
    label: "Free",
    color: "#22c55e",
    glow: "rgba(34,197,94,0.25)",
    states: ["IDLE"],
  },
  in_use: {
    label: "In Use",
    color: "#64748b",
    glow: "rgba(100,116,139,0.2)",
    states: ["MIXED", "ALLOCATED", "COMPLETING"],
  },
  unavailable: {
    label: "Unavailable",
    color: "#ef4444",
    glow: "rgba(239,68,68,0.25)",
    states: ["DOWN", "DOWN*", "DRAIN", "DRAINED", "DRAINING", "RESERVED", "PLANNED", "NOT_RESPONDING", "FAIL", "FAILING"],
  },
};

const UNAVAILABLE_TOKENS = new Set([
  "DOWN",
  "DRAIN",
  "DRAINED",
  "DRAINING",
  "FAIL",
  "FAILING",
  "NOT_RESPONDING",
  "PLANNED",
  "RESERVED",
]);

function stateTokens(state: string): string[] {
  return state.toUpperCase().replaceAll("*", "").split("+").filter(Boolean);
}

function isUnavailableState(state: string): boolean {
  return stateTokens(state).some(token => UNAVAILABLE_TOKENS.has(token));
}

function isAcademicNode(node: NodeInfo): boolean {
  return node.partition.toLowerCase().includes("academic");
}

function isPrivateNode(node: NodeInfo): boolean {
  return !node.name.toLowerCase().startsWith("gpu");
}

function isSharedNode(node: NodeInfo): boolean {
  return !isAcademicNode(node) && !isPrivateNode(node);
}

function getNodeGpuBreakdown(node: NodeInfo): { free: number; in_use: number; unavailable: number } {
  if (isUnavailableState(node.state)) {
    return { free: 0, in_use: 0, unavailable: node.total_gpus };
  }
  return {
    free: Math.max(node.total_gpus - node.allocated_gpus, 0),
    in_use: node.allocated_gpus,
    unavailable: 0,
  };
}

function Tooltip({ children, content }: { children: ReactNode; content: ReactNode }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={e => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: rect.left + rect.width / 2, y: rect.top });
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
            maxWidth: 320,
          }}
        >
          {content}
        </div>
      )}
    </div>
  );
}

function GpuJobPopover({ job }: { job: NodeGpuJob }) {
  const progress = job.progress_pct ?? 0;
  return (
    <div className="absolute z-50 mt-2 left-0 w-72 bg-surface-alt border border-border rounded-lg p-3 shadow-xl animate-settle pointer-events-none">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-text-muted">GPU {job.gpu_index}</span>
      </div>
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-text">{job.user}</span>
        <span className="text-text-faint">#{job.job_id}</span>
      </div>
      <div className="mt-2 h-1 bg-border/60 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${progress}%`,
            background: progress > 90 ? "var(--color-error)" : "var(--color-accent)",
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-text-faint mt-0.5 font-mono">
        <span>{job.time_elapsed} elapsed</span>
        <span>{job.time_limit}</span>
      </div>
      {(job.memory_used_mb !== null || job.temperature_c !== null || job.utilization_pct !== null) && (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-mono">
          <div className="border border-border/60 rounded px-2 py-1">
            <div className="text-text-faint uppercase tracking-wide">Mem</div>
            <div className="text-text">
              {job.memory_used_mb !== null && job.memory_total_mb !== null
                ? `${Math.round(job.memory_used_mb / 1024)}/${Math.round(job.memory_total_mb / 1024)} GB`
                : "—"}
            </div>
          </div>
          <div className="border border-border/60 rounded px-2 py-1">
            <div className="text-text-faint uppercase tracking-wide">Temp</div>
            <div className="text-text">
              {job.temperature_c !== null ? `${job.temperature_c}°C` : "—"}
            </div>
          </div>
          <div className="border border-border/60 rounded px-2 py-1">
            <div className="text-text-faint uppercase tracking-wide">Load</div>
            <div className="text-text">
              {job.utilization_pct !== null ? `${job.utilization_pct}%` : "—"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function GpuSquare({
  slot,
  allocated,
  nodeState,
  gpuIndex,
}: {
  slot: NodeGpuJob | null;
  allocated: boolean;
  nodeState: string;
  gpuIndex: number;
}) {
  const [hovered, setHovered] = useState(false);
  const fill = isUnavailableState(nodeState)
    ? STATUS_CATEGORIES.unavailable.color
    : allocated
      ? STATUS_CATEGORIES.in_use.color
      : STATUS_CATEGORIES.free.color;
  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className={`w-3.5 h-3.5 rounded-sm transition-all duration-150 ${slot ? "cursor-pointer hover:scale-125 hover:brightness-125" : "cursor-default"}`}
        style={{
          background: fill,
          boxShadow: `inset 0 1px 0 rgba(255,255,255,0.1), 0 0 3px ${fill}33`,
        }}
        title={slot ? `${slot.user} #${slot.job_id}` : allocated ? `In Use (GPU ${gpuIndex})` : `Free (GPU ${gpuIndex})`}
      />
      {hovered && slot && <GpuJobPopover job={slot} />}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const category = isUnavailableState(state)
    ? STATUS_CATEGORIES.unavailable
    : stateTokens(state).includes("IDLE")
      ? STATUS_CATEGORIES.free
      : STATUS_CATEGORIES.in_use;
  return (
    <span
      className="text-[9px] font-mono px-1.5 py-0.5 rounded cursor-default"
      style={{
        color: category.color,
        background: `${category.color}15`,
        border: `1px solid ${category.color}30`,
      }}
    >
      {state}
    </span>
  );
}

function NodeCard({
  node,
  slots,
}: {
  node: NodeInfo;
  slots: Array<NodeGpuJob | null>;
}) {
  const memPct = node.memory_total_mb > 0 ? Math.round((node.memory_allocated_mb / node.memory_total_mb) * 100) : 0;
  const mappedIndices = new Set(
    slots
      .filter((slot): slot is NodeGpuJob => slot !== null)
      .map(slot => slot.gpu_index)
      .filter(index => index >= 0 && index < node.total_gpus),
  );
  const hasExplicitMapping = mappedIndices.size > 0;

  return (
    <div className="relative border border-border/60 rounded-md p-2.5 bg-bg/60 min-w-[120px]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[11px] text-text-muted">{node.name}</span>
        <StateBadge state={node.state} />
      </div>
      <div className="flex gap-1 mb-1.5">
        {Array.from({ length: node.total_gpus }, (_, index) => (
          <GpuSquare
            key={index}
            slot={slots[index] ?? null}
            // Trust explicit backend gpu_index mapping when present; allocated_gpus
            // is only a fallback count for older/incomplete payloads.
            allocated={hasExplicitMapping ? mappedIndices.has(index) : index < node.allocated_gpus}
            nodeState={node.state}
            gpuIndex={index}
          />
        ))}
      </div>
      <div className="h-1 bg-border/40 rounded-full overflow-hidden">
        <div className="h-full rounded-full bg-accent" style={{ width: `${memPct}%` }} />
      </div>
      <div className="text-[9px] text-text-faint mt-0.5 font-mono">
        {(node.memory_allocated_mb / 1024).toFixed(0)}/{(node.memory_total_mb / 1024).toFixed(0)} GB
      </div>
    </div>
  );
}

function GPUViewModal({
  data,
  onClose,
  onRefresh,
}: {
  data: GPUReport;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [filters, setFilters] = useState<Set<"free" | "in_use" | "unavailable">>(new Set());
  const [showAcademic, setShowAcademic] = useState(false);
  const [showPrivate, setShowPrivate] = useState(false);
  const gpuJobsByNode = data.gpu_jobs_by_node ?? {};

  useEffect(() => {
    document.body.style.overflow = "hidden";
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const filterNodes = (nodes: NodeInfo[]) => {
    if (filters.size === 0) return nodes;
    return nodes.filter(node => {
      const breakdown = getNodeGpuBreakdown(node);
      return (
        (filters.has("free") && breakdown.free > 0) ||
        (filters.has("in_use") && breakdown.in_use > 0) ||
        (filters.has("unavailable") && breakdown.unavailable > 0)
      );
    });
  };

  const groupedNodes = (nodes: NodeInfo[]) => {
    const grouped = new Map<string, NodeInfo[]>();
    for (const node of nodes) {
      const existing = grouped.get(node.gpu_type) ?? [];
      existing.push(node);
      grouped.set(node.gpu_type, existing);
    }
    return grouped;
  };

  const sharedNodes = filterNodes(data.nodes.filter(isSharedNode));
  const academicNodes = filterNodes(data.nodes.filter(isAcademicNode));
  const privateNodes = filterNodes(data.nodes.filter(isPrivateNode));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface border border-border rounded-lg w-full max-w-6xl h-[90vh] flex flex-col animate-settle">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <h2 className="text-lg font-semibold tracking-tight">GPUs</h2>
          <div className="flex items-center gap-2">
            <button onClick={onRefresh} title="Refresh GPU data"
              className="text-xs px-2 py-1 rounded border border-border text-text-faint hover:text-text-muted hover:border-text-muted transition-colors">
              ↻
            </button>
            <button onClick={onClose} className="text-text-muted hover:text-text text-sm">✕</button>
          </div>
        </div>

        <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-wrap">
          {Object.entries(STATUS_CATEGORIES).map(([key, category]) => {
            const typedKey = key as "free" | "in_use" | "unavailable";
            const active = filters.has(typedKey);
            return (
              <Tooltip key={key} content={<span>SLURM states: {category.states.join(", ")}</span>}>
                <button
                  onClick={() => {
                    const next = new Set(filters);
                    if (next.has(typedKey)) next.delete(typedKey);
                    else next.add(typedKey);
                    setFilters(next);
                  }}
                  className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-all font-mono ${
                    active
                      ? "border-current"
                      : filters.size > 0
                        ? "border-border/40 opacity-40 hover:opacity-70"
                        : "border-border/40 hover:border-current"
                  }`}
                  style={{ color: category.color }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: category.color }} />
                  {category.label}
                </button>
              </Tooltip>
            );
          })}
          {filters.size > 0 && (
            <button onClick={() => setFilters(new Set())} className="text-[10px] text-text-faint hover:text-text ml-1">
              Clear
            </button>
          )}
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {Array.from(groupedNodes(sharedNodes).entries()).map(([gpuType, nodes]) => (
            <section key={gpuType}>
              <h3 className="text-sm font-medium text-text-muted mb-2 font-mono">{gpuTypeLabel(gpuType)}</h3>
              <div className="flex flex-wrap gap-2">
                {nodes.map(node => (
                  <NodeCard
                    key={node.name}
                    node={node}
                    slots={gpuJobsByNode[node.name] ?? Array.from({ length: node.total_gpus }, () => null)}
                  />
                ))}
              </div>
            </section>
          ))}

          {sharedNodes.length === 0 && (
            <p className="text-text-faint text-sm py-8 text-center">No nodes match the selected filters.</p>
          )}

          <div className="pt-4 border-t border-border/40 space-y-3">
            <button
              onClick={() => setShowPrivate(!showPrivate)}
              className="flex items-center gap-2 text-xs text-text-faint hover:text-text-muted transition-colors"
            >
              <span className={`transition-transform duration-150 ${showPrivate ? "rotate-90" : ""}`}>▶</span>
              <span className="opacity-60">🔒</span>
              Private Nodes ({privateNodes.length})
              <span className="text-[10px] opacity-50">no access</span>
            </button>
            {showPrivate && (
              <div className="pl-6 flex flex-wrap gap-2 opacity-50">
                {privateNodes.map(node => (
                  <NodeCard
                    key={node.name}
                    node={node}
                    slots={gpuJobsByNode[node.name] ?? Array.from({ length: node.total_gpus }, () => null)}
                  />
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
                {academicNodes.map(node => (
                  <NodeCard
                    key={node.name}
                    node={node}
                    slots={gpuJobsByNode[node.name] ?? Array.from({ length: node.total_gpus }, () => null)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function GPUGrid({ data, loading, error, onRefresh }: GPUGridProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) onRefresh();
  }, [open, onRefresh]);

  const summary = useMemo(() => {
    if (!data) return null;
    const sharedNodes = data.nodes.filter(isSharedNode);
    let free = 0;
    let inUse = 0;
    let unavailable = 0;
    const freeByType: Record<string, number> = {};
    for (const node of sharedNodes) {
      const breakdown = getNodeGpuBreakdown(node);
      free += breakdown.free;
      inUse += breakdown.in_use;
      unavailable += breakdown.unavailable;
      if (breakdown.free > 0) {
        freeByType[node.gpu_type] = (freeByType[node.gpu_type] ?? 0) + breakdown.free;
      }
    }
    return { free, inUse, unavailable, freeByType };
  }, [data]);

  if (loading && !data) {
    return (
      <section aria-label="GPU availability" className="border border-border rounded-lg p-5 bg-surface/40">
        <h2 className="text-lg font-semibold mb-3">GPU Availability</h2>
        <p className="text-text-faint text-sm">Querying Slurm for node and GPU states…</p>
      </section>
    );
  }

  if (!data) {
    return (
      <section aria-label="GPU availability" className="border border-border rounded-lg p-5 bg-surface/40">
        <h2 className="text-lg font-semibold mb-3">GPU Availability</h2>
        <p className="text-error text-sm">{error ?? "GPU availability is unavailable right now."}</p>
      </section>
    );
  }

  const freeBreakdown = Object.entries(summary?.freeByType ?? {})
    .map(([gpuType, count]) => `${gpuTypeLabel(gpuType)}: ${count}`)
    .join(", ");

  return (
    <>
      <section aria-label="GPU availability" className="border border-border rounded-lg p-5 bg-surface/40">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">GPU Availability</h2>
        </div>

        <div className="flex items-center gap-5 px-5 py-3 rounded-lg border border-border bg-surface/30 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted cursor-default">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: STATUS_CATEGORIES.free.color,
                boxShadow: `0 0 4px ${STATUS_CATEGORIES.free.glow}`,
              }}
            />
            <span style={{ color: STATUS_CATEGORIES.free.color }}>{summary?.free ?? 0}</span>
            <span>Free</span>
            {freeBreakdown && <span className="text-accent">({freeBreakdown})</span>}
          </div>

          <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted cursor-default">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: STATUS_CATEGORIES.in_use.color,
                boxShadow: `0 0 4px ${STATUS_CATEGORIES.in_use.glow}`,
              }}
            />
            <span style={{ color: STATUS_CATEGORIES.in_use.color }}>{summary?.inUse ?? 0}</span>
            <span>In Use</span>
          </div>

          <div className="flex items-center gap-1.5 text-xs font-mono text-text-muted cursor-default">
            <span
              className="w-2 h-2 rounded-full"
              style={{
                background: STATUS_CATEGORIES.unavailable.color,
                boxShadow: `0 0 4px ${STATUS_CATEGORIES.unavailable.glow}`,
              }}
            />
            <span style={{ color: STATUS_CATEGORIES.unavailable.color }}>{summary?.unavailable ?? 0}</span>
            <span>Unavailable</span>
          </div>

          <div className="ml-auto">
            <button
              onClick={() => setOpen(true)}
              className="text-xs px-3 py-1.5 rounded border border-accent/30 text-accent hover:bg-accent/10 transition-colors font-medium tracking-wide"
            >
              View GPUs
            </button>
          </div>
        </div>

        {error && <p className="text-error text-sm mt-3">{error}</p>}
      </section>

      {open && <GPUViewModal data={data} onClose={() => setOpen(false)} onRefresh={onRefresh} />}
    </>
  );
}
