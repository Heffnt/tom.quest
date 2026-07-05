"use client";

// app/boolback/components/anatomy-detail.tsx — the detail panel's "anatomy"
// section (ANATOMY-SPEC.md "Interaction & integration").
//
// Mounted by detail-panel.tsx RunDetail right after the function section.
// Renders NOTHING (null, not an empty shell) when the row has no interp
// measurements at all; legacy single-record rows show their one normalized
// measurement. Two parts:
//
//   1. A compact measurement list (carrier dot, kind, locus, value/null/Δ).
//      The store's anatomy.sel (measurementKey codec, shared with the pane
//      and share links) highlights its row and scrolls it into view; rows
//      are clickable so selection flows detail→pane as well as pane→detail.
//   2. The selected measurement's FULL record: taxonomy/locus fields, every
//      extras scalar, the CDE dose-response curve as a small SVG sparkline
//      (EpochPlot's visual pattern, but a bespoke component — EpochPlot's
//      trajectories prop shape doesn't fit [dose, effect][] pairs), top-k
//      components as mini horizontal bars, and the circuit node/edge list.
//
// Colors follow the pane: carrier hexes from lib/anatomy.ts for data,
// CSS variables for chrome. All fields are optional (old blobs) — absent
// data collapses to nothing rather than em-dash noise, matching how the
// pane degrades structurally.

import { useEffect, useMemo, useRef } from "react";
import type { InterpMeasurement, RunRow } from "../lib/types";
import { useBoolbackStore } from "../state/store";
import {
  carrierColor,
  deltaOf,
  locusLabel,
  measurementKey,
  measurementsOf,
  modeGlyph,
} from "../lib/anatomy";

const fmtNum = (v: number | null | undefined): string =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 10000) / 10000) : "—";

const fmtAny = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return v ? "✓" : "·";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
};

const nodeLabel = (n: { layer: number; component: string; head?: number }): string =>
  `L${n.layer}/${n.component}${typeof n.head === "number" ? `/h${n.head}` : ""}`;

export function AnatomySection({ row }: { row: RunRow }) {
  const ms = useMemo(() => measurementsOf(row), [row]);
  const sel = useBoolbackStore((s) => s.anatomy.sel);
  const setAnatomy = useBoolbackStore((s) => s.setAnatomy);
  const selRef = useRef<HTMLButtonElement | null>(null);

  const selM = useMemo(
    () => (sel === null ? null : ms.find((m) => measurementKey(m) === sel) ?? null),
    [ms, sel],
  );

  // Keep the highlighted row visible; "center" (not "nearest") so the full
  // record right below the list tends to come along into view.
  useEffect(() => {
    if (selM) selRef.current?.scrollIntoView({ block: "center" });
  }, [selM]);

  if (ms.length === 0) return null;

  return (
    <section className="rounded border border-border bg-surface/40" data-anatomy-section="">
      <h3 className="px-2 py-1.5 font-display text-[11px] uppercase tracking-wide text-text-muted border-b border-border/60">
        anatomy · {ms.length} measurement{ms.length === 1 ? "" : "s"}
      </h3>
      <div className="px-2 py-2 space-y-2">
        <div className="max-h-56 space-y-px overflow-y-auto pr-0.5">
          {ms.map((m, i) => {
            const key = measurementKey(m);
            const isSel = key === sel;
            const d = deltaOf(m);
            return (
              <button
                type="button"
                key={`${key}#${i}`}
                ref={isSel ? selRef : undefined}
                onClick={() => setAnatomy({ sel: isSel ? null : key })}
                className={`flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left font-mono text-[11px] transition-colors ${
                  isSel
                    ? "bg-accent/10 ring-1 ring-accent/50"
                    : "hover:bg-surface-alt/60"
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 self-center rounded-full"
                  style={{ backgroundColor: carrierColor(m.carrier) }}
                />
                <span className="truncate text-text/90">{m.kind}</span>
                <span className="shrink-0 text-text-faint">{locusLabel(m)}</span>
                <span className="ml-auto shrink-0 tabular-nums text-text-muted">
                  {fmtNum(m.value)} / {fmtNum(m.null_control)}
                  <span className={d !== null && d < 0 ? " text-error" : " text-text/90"}>
                    {" "}Δ {fmtNum(d)}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {selM && <SelectedMeasurement m={selM} />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The selected measurement's full record
// ---------------------------------------------------------------------------

function SelectedMeasurement({ m }: { m: InterpMeasurement }) {
  const color = carrierColor(m.carrier);
  const extras = m.extras ?? {};
  const extraEntries = Object.entries(extras).filter(([k]) => k !== "curve");
  const curve = Array.isArray(extras.curve) ? (extras.curve as [number, number][]) : null;
  const comps = m.components ?? null;
  const nodes = m.nodes ?? null;
  const edges = m.edges ?? null;

  return (
    <div className="rounded border border-border/60 bg-surface-alt/30 p-2 space-y-2 font-mono text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="text-text/90">{m.kind}</span>
        {m.metric_name && <span className="text-text-faint">· {m.metric_name}</span>}
        <span className="ml-auto text-text-faint">{locusLabel(m)}</span>
      </div>

      <div className="space-y-0.5">
        {m.method && <Row k="method" v={m.method} />}
        {m.mode && <Row k="mode" v={`${m.mode} (${modeGlyph(m.mode) === "diamond" ? "◇ write" : "○ read"})`} />}
        {m.carrier && <Row k="carrier" v={m.carrier} />}
        {m.op != null && <Row k="op" v={fmtAny(m.op)} />}
        {m.metric != null && <Row k="metric" v={fmtAny(m.metric)} />}
        <Row k="value" v={fmtNum(m.value)} />
        <Row k="null_control" v={fmtNum(m.null_control)} />
        <Row k="delta" v={fmtNum(deltaOf(m))} />
        {m.layer_profile && <Row k="layer_profile" v={`${m.layer_profile.length} layers swept`} />}
        {m.twin_hash && <Row k="twin_hash" v={m.twin_hash} />}
        {extraEntries.map(([k, v]) => (
          <Row key={k} k={k} v={fmtAny(v)} />
        ))}
      </div>

      {curve && curve.length > 0 && (
        <div>
          <div className="mb-0.5 text-text-faint">dose–response curve</div>
          <CurveSparkline curve={curve} color={color} />
        </div>
      )}

      {comps && comps.length > 0 && <ComponentBars comps={comps} color={color} />}

      {nodes && nodes.length > 0 && (
        <div>
          <div className="mb-0.5 text-text-faint">
            circuit — {nodes.length} nodes · {edges?.length ?? 0} edges
          </div>
          <div className="flex flex-wrap gap-1">
            {nodes.map((n, i) => (
              <span
                key={i}
                className="rounded border border-border/60 bg-surface/60 px-1 py-px text-text/90"
              >
                {nodeLabel(n)}
              </span>
            ))}
          </div>
          {edges && edges.length > 0 && (
            <ul className="mt-1 space-y-px text-text-muted">
              {edges.map((e, i) => {
                const from = nodes[e?.[0] as number];
                const to = nodes[e?.[1] as number];
                if (!from || !to) return null; // dangling index — skip
                return (
                  <li key={i} className="tabular-nums">
                    {nodeLabel(from)} <span className="text-text-faint">→</span>{" "}
                    {nodeLabel(to)}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// Label/value line — the detail panel's FieldRow flex idiom (its dl-grid
// variant renders stacked; flex keeps the record compact).
function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-28 shrink-0 text-text-faint">{k}</span>
      <span className="truncate text-text/90" title={v}>
        {v}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CDE dose-response sparkline — EpochPlot's visual language (frame, faint
// grid, dashed reference, dots with titles) over [dose, effect][] pairs.
// ---------------------------------------------------------------------------

function CurveSparkline({ curve, color }: { curve: [number, number][]; color: string }) {
  const pts = curve
    .filter((p) => typeof p?.[0] === "number" && typeof p?.[1] === "number")
    .sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return null;
  const W = 300;
  const H = 92;
  const pad = { l: 34, r: 8, t: 8, b: 16 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  let y0 = Math.min(...ys, 0); // keep the 0 baseline in frame
  let y1 = Math.max(...ys, 0);
  if (y1 - y0 < 1e-9) {
    y0 -= 0.5;
    y1 += 0.5;
  }
  const sx = (v: number) =>
    pad.l + (x1 > x0 ? (v - x0) / (x1 - x0) : 0.5) * (W - pad.l - pad.r);
  const sy = (v: number) => H - pad.b - ((v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const zeroInRange = y0 <= 0 && y1 >= 0;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="dose-response curve">
      <rect
        x={pad.l}
        y={pad.t}
        width={W - pad.l - pad.r}
        height={H - pad.t - pad.b}
        fill="var(--color-surface)"
        stroke="var(--color-border)"
        strokeWidth={1}
      />
      {zeroInRange && (
        <line
          x1={pad.l}
          y1={sy(0)}
          x2={W - pad.r}
          y2={sy(0)}
          stroke="var(--color-border)"
          strokeOpacity={0.7}
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      {[y0, y1].map((g, i) => (
        <text
          key={i}
          x={pad.l - 4}
          y={sy(g) + 3}
          fontSize={8}
          textAnchor="end"
          fill="var(--color-text-faint)"
          className="font-mono"
        >
          {fmtNum(g)}
        </text>
      ))}
      {[x0, x1].map((g, i) => (
        <text
          key={i}
          x={sx(g)}
          y={H - 4}
          fontSize={8}
          textAnchor={i === 0 ? "start" : "end"}
          fill="var(--color-text-faint)"
          className="font-mono"
        >
          {fmtNum(g)}
        </text>
      ))}
      {pts.length > 1 && (
        <polyline
          points={pts.map((p) => `${sx(p[0])},${sy(p[1])}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={1.5}
        />
      )}
      {pts.map((p, i) => (
        <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={2.5} fill={color}>
          <title>{`dose ${fmtNum(p[0])} → effect ${fmtNum(p[1])}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Top-k components — mini horizontal bars, |weight|-sorted (sign via color
// intensity would lie; a signed label keeps it honest).
// ---------------------------------------------------------------------------

const COMPONENT_BARS_MAX = 10;

function ComponentBars({ comps, color }: { comps: [number, number][]; color: string }) {
  const rows = comps
    .filter((c) => typeof c?.[0] === "number" && typeof c?.[1] === "number")
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, COMPONENT_BARS_MAX);
  if (rows.length === 0) return null;
  const max = Math.abs(rows[0][1]) || 1;
  return (
    <div>
      <div className="mb-0.5 text-text-faint">
        top components{comps.length > rows.length ? ` (${rows.length} of ${comps.length})` : ""}
      </div>
      <div className="space-y-px">
        {rows.map(([idx, w]) => (
          <div key={idx} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-right tabular-nums text-text-muted">n{idx}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-sm bg-surface-alt/60">
              <span
                className="block h-full rounded-sm"
                style={{
                  width: `${(Math.abs(w) / max) * 100}%`,
                  backgroundColor: color,
                  opacity: 0.4 + 0.6 * (Math.abs(w) / max),
                }}
              />
            </span>
            <span
              className={`w-12 shrink-0 tabular-nums ${w < 0 ? "text-error" : "text-text/90"}`}
            >
              {fmtNum(w)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default AnatomySection;
