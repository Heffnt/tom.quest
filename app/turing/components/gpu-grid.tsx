"use client";

import { useMemo } from "react";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { GPUReport, NodeInfo, gpuTypeLabel } from "../types";

interface GPUGridProps {
  data: GPUReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

interface GridSettings extends Record<string, unknown> {
  collapsed: string[];
  gpuOnlyFilter: boolean;
}

const DEFAULTS: GridSettings = { collapsed: [], gpuOnlyFilter: false };
const BOX = 14;
const GAP = 3;

function nodeIsGpuNamed(n: NodeInfo): boolean {
  return /gpu/i.test(n.name);
}

function Memory({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="w-full">
      <div className="h-1 bg-border/60 rounded-full overflow-hidden">
        <div className="h-full bg-accent/60" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-[10px] text-text-faint mt-0.5 font-mono">
        {(used / 1024).toFixed(0)}/{(total / 1024).toFixed(0)} GB
      </p>
    </div>
  );
}

function NodeCard({ node }: { node: NodeInfo }) {
  const down = node.state !== "up";
  return (
    <div className="border border-border rounded-md p-2 bg-surface/60 min-w-[140px]">
      <p className="font-mono text-xs text-text-muted mb-1 truncate">{node.name}</p>
      <svg width={node.total_gpus * (BOX + GAP)} height={BOX} className="mb-1.5">
        {Array.from({ length: node.total_gpus }, (_, i) => {
          const color = down
            ? "var(--color-error)"
            : i < node.allocated_gpus
              ? "rgba(120,120,120,0.5)"
              : "rgba(100,180,120,0.8)";
          return (
            <rect
              key={i}
              x={i * (BOX + GAP)}
              y={0}
              width={BOX}
              height={BOX}
              rx={2}
              fill={color}
            />
          );
        })}
      </svg>
      <Memory used={node.memory_allocated_mb} total={node.memory_total_mb} />
    </div>
  );
}

export default function GPUGrid({ data, loading, error, onRefresh }: GPUGridProps) {
  const [settings, update] = usePersistedSettings<GridSettings>("turing_gpu_grid", DEFAULTS);
  const collapsed = useMemo(() => new Set(settings.collapsed), [settings.collapsed]);

  const toggleCollapsed = (partition: string) => {
    const next = new Set(collapsed);
    if (next.has(partition)) next.delete(partition);
    else next.add(partition);
    update({ collapsed: Array.from(next) });
  };

  const visibleNodes = useMemo(() => {
    if (!data) return [];
    return data.nodes.filter(n => {
      if (settings.gpuOnlyFilter && !nodeIsGpuNamed(n)) return false;
      if (collapsed.has(n.partition)) return false;
      return true;
    });
  }, [data, settings.gpuOnlyFilter, collapsed]);

  const totals = useMemo(() => {
    let free = 0, used = 0, down = 0;
    for (const n of visibleNodes) {
      if (n.state !== "up") down += n.total_gpus;
      else {
        free += n.total_gpus - n.allocated_gpus;
        used += n.allocated_gpus;
      }
    }
    return { free, used, down };
  }, [visibleNodes]);

  const byPartition = useMemo(() => {
    if (!data) return new Map<string, Map<string, NodeInfo[]>>();
    const out = new Map<string, Map<string, NodeInfo[]>>();
    for (const n of data.nodes) {
      if (settings.gpuOnlyFilter && !nodeIsGpuNamed(n)) continue;
      if (!out.has(n.partition)) out.set(n.partition, new Map());
      const parts = out.get(n.partition)!;
      if (!parts.has(n.gpu_type)) parts.set(n.gpu_type, []);
      parts.get(n.gpu_type)!.push(n);
    }
    return out;
  }, [data, settings.gpuOnlyFilter]);

  return (
    <section aria-label="GPU availability" className="border border-border rounded-lg p-5 bg-surface/40">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">GPU Availability</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs px-3 py-1 rounded border border-border text-text-muted hover:text-text hover:border-text-muted transition-colors duration-150"
        >
          Refresh
        </button>
      </div>

      <div className="flex items-center gap-4 text-xs text-text-muted mb-3 flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[rgba(100,180,120,0.8)]" /> Free {totals.free}</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-[rgba(120,120,120,0.5)]" /> In use {totals.used}</span>
        <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-error" /> Down {totals.down}</span>
        <label className="ml-auto flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.gpuOnlyFilter}
            onChange={e => update({ gpuOnlyFilter: e.target.checked })}
            className="accent-accent"
          />
          GPU nodes only
        </label>
      </div>

      {loading && !data && <p className="text-text-faint text-sm">Loading…</p>}
      {error && <p className="text-error text-sm">{error}</p>}

      {data && Array.from(byPartition.entries()).map(([partition, byType]) => {
        const isCollapsed = collapsed.has(partition);
        return (
          <section key={partition} aria-label={`Partition ${partition}`} className="mb-3">
            <button
              type="button"
              aria-expanded={!isCollapsed}
              onClick={() => toggleCollapsed(partition)}
              className="w-full text-left text-sm font-medium text-text-muted hover:text-text transition-colors duration-150 flex items-center gap-2 py-1"
            >
              <span className={`transition-transform duration-150 ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
              <span>{partition}</span>
            </button>
            {!isCollapsed && (
              <div className="pl-6 space-y-2">
                {Array.from(byType.entries()).map(([gpuType, nodes]) => (
                  <div key={gpuType}>
                    <p className="text-xs text-text-faint mb-1 font-mono">{gpuTypeLabel(gpuType)}</p>
                    <div className="flex flex-wrap gap-2">
                      {nodes.map(n => <NodeCard key={n.name} node={n} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <p className="text-xs text-text-faint mt-3 font-mono">
        Visible: {totals.free} free / {totals.used} in use / {totals.down} down
      </p>
    </section>
  );
}
