"use client";

// app/boolback/components/chart-panel.tsx — the Chart center view.
//
// A single scatter over the SAME filtered row set as the table (the filter
// bar stays above both views) that answers the campaign's real questions:
// "does outcome Y move with function-complexity X, and does the context
// moderate it?"
//
//   X = any snapshot metric (function complexity, outcome, defense, …)
//   Y = any snapshot metric
//   color = a facet (arity, trigger form, model, …)
//   mode = one point per RUN, or one point per FUNCTION (mean over its runs,
//          sized by run count)
//
// Hover a point for its identity + values; click a run point to open its
// drawer; click a function point to scope the filters to that function
// (a reversible subtree chip). Metrics no run has populated yet sit in a
// trailing "no data yet" optgroup — findable, but never the default.
//
// Pure SVG — no chart library.

import { useMemo, useState } from "react";
import type { Bundle, FacetKey, MetricSchemaEntry, RunRow } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { facetValue, numericValue, type MetricIndex } from "../lib/select";
import { resolveColumn } from "../lib/columns";
import { usePersistedSettings } from "@/app/lib/hooks/use-persisted-settings";
import { fnText, hash01, shortModel } from "../lib/format";

interface ChartConfig extends Record<string, unknown> {
  x: string; // metric_schema name
  y: string; // metric_schema name
  color: FacetKey | "none";
  mode: "runs" | "functions";
}

const DEFAULT_CHART: ChartConfig = {
  x: "avg_sensitivity",
  y: "plantedness",
  color: "arity",
  mode: "runs",
};

const COLOR_FACETS: Array<{ key: ChartConfig["color"]; label: string }> = [
  { key: "none", label: "single color" },
  { key: "arity", label: "arity" },
  { key: "triggerForm", label: "trigger form" },
  { key: "source", label: "source" },
  { key: "targetBehavior", label: "target behavior" },
  { key: "task", label: "task" },
  { key: "baseModel", label: "model" },
  { key: "tuning", label: "tuning" },
  { key: "judge", label: "judge" },
];

const PALETTE = [
  "#e8a040", "#38bdf8", "#4ade80", "#e879f9",
  "#f87171", "#c9b35f", "#6fb6a6", "#b48ad6",
];

// Geometry (viewBox units; the SVG scales to the pane).
const W = 820;
const H = 430;
const PAD = { l: 56, r: 16, t: 14, b: 40 };

interface Pt {
  x: number;
  y: number;
  r: number;
  color: string;
  key: string;
  label: string[];
  runId?: string; // runs mode -> open drawer
  fh?: string; // functions mode -> scope chip
}

/** metric_schema name -> the column id select.numericValue understands. */
function colIdOf(name: string, index: MetricIndex): string {
  const entry = index[name];
  if (!entry || entry.group === "FUNCTION") return name;
  return resolveColumn(entry.group, name, index).id;
}

function tickFmt(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, "");
  return v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function MetricSelect({
  value,
  onChange,
  schema,
  ariaLabel,
}: {
  value: string;
  onChange: (name: string) => void;
  schema: MetricSchemaEntry[];
  ariaLabel: string;
}) {
  const { groups, emptyEntries } = useMemo(() => {
    const by = new Map<string, MetricSchemaEntry[]>();
    const empty: MetricSchemaEntry[] = [];
    for (const e of schema) {
      if (e.min === null && e.max === null) {
        empty.push(e); // findable below, never the default
        continue;
      }
      const arr = by.get(e.group) ?? [];
      arr.push(e);
      by.set(e.group, arr);
    }
    return { groups: [...by.entries()], emptyEntries: empty };
  }, [schema]);
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className="max-w-44 rounded-md border border-border bg-surface px-1 py-0.5 text-xs text-text focus:border-accent/60 focus:outline-none"
    >
      {groups.map(([group, entries]) => (
        <optgroup key={group} label={group}>
          {entries.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label}
            </option>
          ))}
        </optgroup>
      ))}
      {emptyEntries.length > 0 && (
        <optgroup label="no data yet">
          {emptyEntries.map((e) => (
            <option key={e.name} value={e.name}>
              {e.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

export function ChartBody({
  rows,
  bundle,
  index,
}: {
  rows: RunRow[]; // the filtered (+sorted) rows — chart and table always agree
  bundle: Bundle;
  index: MetricIndex;
}) {
  const openDetail = useBoolbackStore((s) => s.openDetail);
  const expandChain = useBoolbackStore((s) => s.expandChain);
  const addSubtreeDir = useBoolbackStore((s) => s.addSubtreeDir);

  const [config, setConfig] = usePersistedSettings<ChartConfig>("boolback:chart", DEFAULT_CHART);
  const [hover, setHover] = useState<Pt | null>(null);

  // Guard a persisted config whose metric no longer exists in the schema.
  const x = index[config.x] ? config.x : DEFAULT_CHART.x in index ? DEFAULT_CHART.x : (bundle.metric_schema[0]?.name ?? "");
  const y = index[config.y] ? config.y : DEFAULT_CHART.y in index ? DEFAULT_CHART.y : (bundle.metric_schema[0]?.name ?? "");
  const mode = config.mode === "functions" ? "functions" : "runs";

  const { points, colorKeys } = useMemo(() => {
    const xId = colIdOf(x, index);
    const yId = colIdOf(y, index);
    // Count metrics stack points on integer columns; a small deterministic
    // per-run jitter keeps them readable without lying about the value much.
    const jitterX = index[x]?.dtype === "count";
    const colorOf = new Map<string, string>();
    const keyOf = (r: RunRow): string => {
      if (mode === "functions") return `arity ${r.function.arity}`;
      if (config.color === "none") return "runs";
      const v = facetValue(r, config.color as FacetKey);
      return v === null ? "—" : config.color === "baseModel" ? shortModel(v) : v;
    };

    const raw: Pt[] = [];
    if (mode === "runs") {
      for (const r of rows) {
        const vx = numericValue(r, xId);
        const vy = numericValue(r, yId);
        if (vx === null || vy === null) continue;
        raw.push({
          x: vx + (jitterX ? (hash01(r.identity.run_id) - 0.5) * 0.5 : 0),
          y: vy,
          r: 3,
          color: "",
          key: keyOf(r),
          runId: r.identity.node_path,
          label: [
            `${fnText(r.function.arity, r.function.truth_table)} · ${r.identity.run_id}`,
            `${index[x]?.label ?? x}: ${tickFmt(vx)}`,
            `${index[y]?.label ?? y}: ${tickFmt(vy)}`,
          ],
        });
      }
    } else {
      const byFn = new Map<string, { xs: number[]; ys: number[]; row: RunRow }>();
      for (const r of rows) {
        const vx = numericValue(r, xId);
        const vy = numericValue(r, yId);
        if (vx === null || vy === null) continue;
        const slot = byFn.get(r.identity.function_hash) ?? { xs: [], ys: [], row: r };
        slot.xs.push(vx);
        slot.ys.push(vy);
        byFn.set(r.identity.function_hash, slot);
      }
      for (const [fh, { xs, ys, row }] of byFn) {
        const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
        const my = ys.reduce((a, b) => a + b, 0) / ys.length;
        raw.push({
          x: mx,
          y: my,
          r: Math.min(10, 3 + Math.sqrt(xs.length)),
          color: "",
          key: keyOf(row),
          fh,
          label: [
            `${fnText(row.function.arity, row.function.truth_table)} · ${xs.length} run${xs.length === 1 ? "" : "s"}`,
            `${index[x]?.label ?? x}: ${tickFmt(mx)}`,
            `mean ${index[y]?.label ?? y}: ${tickFmt(my)}`,
          ],
        });
      }
    }

    const keys = [...new Set(raw.map((p) => p.key))].sort();
    keys.forEach((k, i) => colorOf.set(k, PALETTE[i % PALETTE.length]));
    for (const p of raw) p.color = colorOf.get(p.key) ?? PALETTE[0];
    return { points: raw, colorKeys: keys.map((k) => ({ key: k, color: colorOf.get(k)! })) };
  }, [rows, x, y, mode, config.color, index]);

  // Scales.
  const scale = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    if (!Number.isFinite(x0)) { x0 = 0; x1 = 1; y0 = 0; y1 = 1; }
    if (x1 - x0 < 1e-9) { x0 -= 0.5; x1 += 0.5; }
    if (y1 - y0 < 1e-9) { y0 -= 0.5; y1 += 0.5; }
    const padX = (x1 - x0) * 0.04;
    const padY = (y1 - y0) * 0.06;
    x0 -= padX; x1 += padX; y0 -= padY; y1 += padY;
    const sx = (v: number) => PAD.l + ((v - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
    const sy = (v: number) => H - PAD.b - ((v - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
    const ticks = (lo: number, hi: number) =>
      Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    return { sx, sy, xTicks: ticks(x0, x1), yTicks: ticks(y0, y1) };
  }, [points]);

  const onPointClick = (p: Pt) => {
    if (p.runId) {
      openDetail(p.runId);
      const r = rows.find((row) => row.identity.node_path === p.runId);
      if (r) expandChain(r.identity.chain_dirs);
    } else if (p.fh) {
      addSubtreeDir(`fn=${p.fh}`);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* axis / color / mode controls */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-border/60">
        <span className="text-xs text-text-faint font-mono">y</span>
        <MetricSelect value={y} onChange={(v) => setConfig({ y: v })} schema={bundle.metric_schema} ariaLabel="y metric" />
        <span className="text-xs text-text-faint font-mono">vs x</span>
        <MetricSelect value={x} onChange={(v) => setConfig({ x: v })} schema={bundle.metric_schema} ariaLabel="x metric" />
        <span className="text-xs text-text-faint font-mono">color</span>
        <select
          value={mode === "functions" ? "arity" : config.color}
          disabled={mode === "functions"}
          aria-label="color facet"
          onChange={(e) => setConfig({ color: e.target.value as ChartConfig["color"] })}
          className="rounded-md border border-border bg-surface px-1 py-0.5 text-xs text-text disabled:opacity-50 focus:border-accent/60 focus:outline-none"
          title={mode === "functions" ? "function points are colored by arity" : undefined}
        >
          {COLOR_FACETS.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md border border-border text-xs">
          {(["runs", "functions"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setConfig({ mode: m })}
              className={`px-2 py-0.5 transition-colors ${mode === m ? "bg-accent/15 text-accent" : "bg-surface text-text-muted hover:text-text"}`}
            >
              {m === "runs" ? "runs" : "functions (mean)"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-text-faint font-mono">
          {points.length.toLocaleString()} point{points.length === 1 ? "" : "s"}
          {mode === "runs" ? " · click a point for details" : " · click a point to scope"}
        </span>
      </div>

      {/* plot */}
      <div className="relative flex-1 min-h-0 px-2 py-1">
        {points.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-text-faint font-mono">
            No plottable points — one of the chosen metrics is null on every filtered run.
          </div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" role="img">
            <rect x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b}
              fill="var(--color-surface)" stroke="var(--color-border)" strokeWidth={1} />
            {scale.yTicks.map((t, i) => (
              <g key={`y${i}`}>
                <line x1={PAD.l} y1={scale.sy(t)} x2={W - PAD.r} y2={scale.sy(t)}
                  stroke="var(--color-border)" strokeOpacity={0.5} strokeWidth={0.5} />
                <text x={PAD.l - 5} y={scale.sy(t) + 3} fontSize={10} textAnchor="end"
                  fill="var(--color-text-faint)" className="font-mono">{tickFmt(t)}</text>
              </g>
            ))}
            {scale.xTicks.map((t, i) => (
              <g key={`x${i}`}>
                <line x1={scale.sx(t)} y1={PAD.t} x2={scale.sx(t)} y2={H - PAD.b}
                  stroke="var(--color-border)" strokeOpacity={0.35} strokeWidth={0.5} />
                <text x={scale.sx(t)} y={H - PAD.b + 14} fontSize={10} textAnchor="middle"
                  fill="var(--color-text-faint)" className="font-mono">{tickFmt(t)}</text>
              </g>
            ))}
            <text x={(PAD.l + W - PAD.r) / 2} y={H - 6} fontSize={11} textAnchor="middle"
              fill="var(--color-text-muted)">{index[x]?.label ?? x}</text>
            <text x={14} y={(PAD.t + H - PAD.b) / 2} fontSize={11} textAnchor="middle"
              transform={`rotate(-90 14 ${(PAD.t + H - PAD.b) / 2})`}
              fill="var(--color-text-muted)">{index[y]?.label ?? y}</text>
            {points.map((p, i) => (
              <circle
                key={i}
                cx={scale.sx(p.x)}
                cy={scale.sy(p.y)}
                r={p.r}
                fill={p.color}
                fillOpacity={0.6}
                stroke={p.color}
                strokeOpacity={0.9}
                className="cursor-pointer"
                onMouseEnter={() => setHover(p)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onPointClick(p)}
              />
            ))}
          </svg>
        )}

        {/* tooltip */}
        {hover && (
          <div
            className="pointer-events-none absolute z-20 max-w-96 rounded-md border border-border bg-surface-alt px-2 py-1 font-mono text-[11px] text-text shadow-lg"
            style={{
              left: `calc(${(scale.sx(hover.x) / W) * 100}% + 12px)`,
              top: `${(scale.sy(hover.y) / H) * 100}%`,
            }}
          >
            {hover.label.map((l, i) => (
              <div key={i} className={i === 0 ? "text-text-muted truncate" : ""}>{l}</div>
            ))}
          </div>
        )}
      </div>

      {/* legend */}
      {points.length > 0 && colorKeys.length > 1 && (
        <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[11px] text-text-muted">
          {colorKeys.slice(0, 12).map(({ key, color }) => (
            <span key={key} className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
              {key}
            </span>
          ))}
          {colorKeys.length > 12 && <span>+{colorKeys.length - 12} more</span>}
        </div>
      )}
    </div>
  );
}
