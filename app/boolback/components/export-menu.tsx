"use client";

// app/boolback/components/export-menu.tsx — the shared Export menu (plan §3.7,
// §4.16, §5). Lives in the filter bar so it serves both center views:
//
//   chart view : copy plotted data as CSV · download SVG · download PNG
//   always     : download the filtered table as CSV (visible rows × columns)
//   always     : the summary-table dialog — group-by facet × chosen metrics,
//                mean ± sd + n over the FILTERED runs, exported as booktabs
//                LaTeX (paste-into-paper) or CSV, with a provenance comment
//                (snapshot built_at + active filters) baked in.
//
// Aggregations here are descriptive only (lib/stats.summarize); anything
// inferential must come from CMT via the facade — see the plan's §5 boundary.

import { useMemo, useState } from "react";
import type { Bundle, FacetKey, FilterState } from "../lib/types";
import type { RunRow } from "../lib/types";
import {
  FACET_LABELS, cellValue, facetValue, numericValue, type MetricIndex,
} from "../lib/select";
import { metricColumnId, type ColumnDef } from "../lib/columns";
import { Y_GROUP_ORDER, groupedMetricOptions } from "../lib/metrics";
import { summarize } from "../lib/stats";
import {
  copyText, downloadBlob, downloadText, summaryToCsv, summaryToLatex, svgToPngBlob,
  svgToString, toCsv, type SummaryTableSpec,
} from "../lib/export";
import type { ChartExportHandle } from "./chart-panel";
import type { CenterView } from "./table-pane";
import { shortModel } from "../lib/format";
import { useBoolbackStore } from "../state/store";

const DEFAULT_SUMMARY_METRICS = [
  "plantedness", "asr", "ftr", "triggerless_correctness", "asr_drop",
];

/** Human one-liner of the active filters (for the .tex provenance comment). */
export function describeFilters(filters: FilterState, index: MetricIndex): string {
  const parts: string[] = [];
  for (const s of filters.status ?? []) parts.push(s);
  for (const [key, vals] of Object.entries(filters.facets ?? {})) {
    if (Array.isArray(vals) && vals.length > 0) {
      parts.push(`${FACET_LABELS[key as FacetKey] ?? key}: ${vals.join("|")}`);
    }
  }
  for (const r of filters.ranges ?? []) {
    parts.push(`${index[r.metric]?.label ?? r.metric} in [${r.min}, ${r.max}]`);
  }
  for (const d of filters.subtreeDirs ?? []) parts.push(`scope: ${d}`);
  if ((filters.search ?? "").trim()) parts.push(`search: "${filters.search.trim()}"`);
  return parts.join("; ");
}

export function ExportMenu({
  bundle,
  index,
  visibleRows,
  colDefs,
  view,
  chartRef,
  filters,
}: {
  bundle: Bundle;
  index: MetricIndex;
  visibleRows: RunRow[];
  colDefs: ColumnDef[];
  view: CenterView;
  chartRef: React.MutableRefObject<ChartExportHandle | null>;
  filters: FilterState;
}) {
  const [open, setOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(null), 1600);
  };

  const tableCsv = () => {
    const head = colDefs.map((c) => c.label);
    const body = visibleRows.map((r) => colDefs.map((c) => {
      const v = cellValue(r, c.id);
      return typeof v === "boolean" ? (v ? 1 : 0) : v;
    }));
    downloadText(toCsv([head, ...body]), "boolback-table.csv", "text/csv");
    setOpen(false);
  };

  const chartCsv = async () => {
    const h = chartRef.current;
    if (!h) return;
    await copyText(h.getCsv());
    flash("copied ✓");
  };

  const chartSvg = () => {
    const svg = chartRef.current?.getSvg();
    if (!svg) return;
    downloadText(svgToString(svg), "boolback-chart.svg", "image/svg+xml");
    setOpen(false);
  };

  const chartPng = async () => {
    const svg = chartRef.current?.getSvg();
    if (!svg) return;
    const blob = await svgToPngBlob(svg, 2);
    downloadBlob(blob, "boolback-chart.png");
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setSummaryOpen(false); }}
        className="rounded-md border border-border bg-surface-alt px-2.5 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 transition-colors"
      >
        {note ?? "Export"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => { setOpen(false); setSummaryOpen(false); }} />
          <div className="absolute right-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-surface/95 p-1.5 text-xs shadow-lg backdrop-blur-md animate-settle">
            {view === "chart" && (
              <>
                <MenuItem label="Copy plotted data (CSV)" onClick={chartCsv} disabled={!chartRef.current} />
                <MenuItem label="Download chart SVG" onClick={chartSvg} disabled={!chartRef.current} />
                <MenuItem label="Download chart PNG (2×)" onClick={chartPng} disabled={!chartRef.current} />
                <div className="my-1 border-t border-border/60" />
              </>
            )}
            <MenuItem
              label={`Download table CSV (${visibleRows.length.toLocaleString()} × ${colDefs.length})`}
              onClick={tableCsv}
            />
            <div className="my-1 border-t border-border/60" />
            <MenuItem
              label="Summary table (.tex / CSV)…"
              onClick={() => setSummaryOpen((o) => !o)}
            />
            {summaryOpen && (
              <SummaryDialog
                bundle={bundle}
                index={index}
                visibleRows={visibleRows}
                filters={filters}
                onDone={(msg) => { flash(msg); setSummaryOpen(false); setOpen(false); }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  label, onClick, disabled,
}: {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className="block w-full rounded px-2 py-1 text-left text-text/90 hover:bg-surface-alt hover:text-accent disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Summary dialog — group-by facet × metric multi-pick, mean ± sd + n
// ---------------------------------------------------------------------------

function SummaryDialog({
  bundle,
  index,
  visibleRows,
  filters,
  onDone,
}: {
  bundle: Bundle;
  index: MetricIndex;
  visibleRows: RunRow[];
  filters: FilterState;
  onDone: (msg: string) => void;
}) {
  // Default group-by: the chart's color-channel split when it names a facet
  // (the explicit color override, else the first split — auto assigns color to
  // splits[0]), else model.
  const chartSplits = useBoolbackStore((s) => s.chart.splits);
  const chartChannels = useBoolbackStore((s) => s.chart.channels);
  const [groupBy, setGroupBy] = useState<FacetKey>(() => {
    const splits = chartSplits ?? [];
    const colorKey = splits.find((k) => chartChannels?.[k] === "color") ?? splits[0];
    return colorKey && colorKey !== "function" ? (colorKey as FacetKey) : "baseModel";
  });

  // Outcome-first metric candidates (only those with observed data).
  const candidates = useMemo(() => {
    const { groups } = groupedMetricOptions(bundle.metric_schema, Y_GROUP_ORDER);
    return groups.flatMap(([, entries]) => entries);
  }, [bundle.metric_schema]);

  const [picked, setPicked] = useState<string[]>(() =>
    DEFAULT_SUMMARY_METRICS.filter((m) => candidates.some((e) => e.name === m)),
  );

  const togglePick = (name: string) => {
    setPicked((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));
  };

  const buildSpec = (): { spec: SummaryTableSpec; rows: ReturnType<typeof summarize<RunRow>> } => {
    // Keep the metric column order = schema (outcome-first) order.
    const metrics = candidates.map((e) => e.name).filter((n) => picked.includes(n));
    const rows = summarize(
      visibleRows,
      metrics,
      (r) => {
        const v = facetValue(r, groupBy);
        return v === null ? null : groupBy === "baseModel" ? shortModel(v) : v;
      },
      (r, m) => numericValue(r, metricColumnId(m, index)),
    );
    const spec: SummaryTableSpec = {
      groupLabel: FACET_LABELS[groupBy],
      metricLabels: Object.fromEntries(metrics.map((m) => [m, index[m]?.label ?? m])),
      metrics,
      provenance: [
        `boolback summary — snapshot built ${bundle.meta.built_at}; ${visibleRows.length} of ${bundle.rows.length} runs`,
        `filters: ${describeFilters(filters, index) || "none"}`,
        `grouped by ${FACET_LABELS[groupBy]}; cells are mean ± sd over runs (descriptive)`,
      ],
    };
    return { spec, rows };
  };

  const act = async (kind: "tex-copy" | "tex-dl" | "csv-copy" | "csv-dl") => {
    const { spec, rows } = buildSpec();
    if (kind === "tex-copy") { await copyText(summaryToLatex(rows, spec)); onDone("copied ✓"); }
    if (kind === "tex-dl") { downloadText(summaryToLatex(rows, spec), "boolback-summary.tex", "text/x-tex"); onDone("saved ✓"); }
    if (kind === "csv-copy") { await copyText(summaryToCsv(rows, spec)); onDone("copied ✓"); }
    if (kind === "csv-dl") { downloadText(summaryToCsv(rows, spec), "boolback-summary.csv", "text/csv"); onDone("saved ✓"); }
  };

  return (
    <div className="mt-1 rounded-md border border-border/70 bg-surface-alt/50 p-2">
      <label className="mb-1.5 flex items-center gap-2">
        <span className="text-text-muted">group by</span>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as FacetKey)}
          className="flex-1 rounded-md border border-border bg-surface px-1 py-0.5 text-xs text-text focus:border-accent/60 focus:outline-none"
        >
          {(Object.keys(FACET_LABELS) as FacetKey[]).map((k) => (
            <option key={k} value={k}>{FACET_LABELS[k]}</option>
          ))}
        </select>
      </label>
      <div className="mb-1 text-text-muted">metrics</div>
      <div className="mb-2 max-h-40 overflow-y-auto">
        {candidates.map((e) => (
          <label key={e.name} className="flex cursor-pointer items-center gap-2 py-0.5 text-text/90 hover:text-accent">
            <input
              type="checkbox"
              checked={picked.includes(e.name)}
              onChange={() => togglePick(e.name)}
              className="accent-accent"
            />
            <span className="flex-1 truncate">{e.label}</span>
            <span className="text-[10px] uppercase text-text-faint">{e.group}</span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <SmallBtn label="Copy .tex" onClick={() => act("tex-copy")} disabled={picked.length === 0} />
        <SmallBtn label="Download .tex" onClick={() => act("tex-dl")} disabled={picked.length === 0} />
        <SmallBtn label="Copy CSV" onClick={() => act("csv-copy")} disabled={picked.length === 0} />
        <SmallBtn label="Download CSV" onClick={() => act("csv-dl")} disabled={picked.length === 0} />
      </div>
    </div>
  );
}

function SmallBtn({
  label, onClick, disabled,
}: {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void onClick()}
      className="rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-text-muted hover:text-accent hover:border-accent/40 disabled:opacity-40 transition-colors"
    >
      {label}
    </button>
  );
}
