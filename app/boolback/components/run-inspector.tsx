"use client";

// app/boolback/components/run-inspector.tsx
//
// The run inspector — the content the config-panel dock swaps in when the user
// drills into ONE training run (Phase 4). It is a slimmed refactor of the old
// detail-panel.tsx: ~13 sections collapsed to FIVE, reusing detail-panel's
// sub-components verbatim where possible.
//
// This component renders CONTENT ONLY — no fixed positioning, no width, no
// resize handle. The parent dock owns layout/chrome (width, docking, the
// resize behaviour that detail-panel used to carry). The inspector just needs
// its `onBack` handler wired to return the dock to config mode.
//
// Sections:
//   1. Parameters — the run's full parameter vector (identity hashes + every
//      dataset field + every training field), flat labeled grid.
//   2. Function  — truth strip + DNF + the ~61-key complexity metric table.
//   3. Outcomes  — epoch trajectory plot (epoch-0 baseline folded in as the
//      leftmost point; a judge selector picks which per-judge series is shown),
//      the per-tt-row table with the audited-plantedness derivation, then PPL.
//   4. Methods   — ONE uniform table over defense / interp / scan methods, with
//      the twin model-diff folded in as a row.
//   5. Files     — the raw on-disk artifact browser.

import { useMemo, useState } from "react";
import type {
  Bundle, RunRow, PerTtRow, MetricSchemaEntry, Trajectories,
} from "../lib/types";
import { plantedThreshold } from "../lib/types";
import { formatValue, metricLabel } from "../lib/metrics";
import { fnText } from "../lib/format";
import { TruthStrip, TruthBox } from "./truth-strip";
import { dnfLabel } from "./fn-hex";
import { EpochPlot } from "./epoch-sparkline";
import { ArtifactBrowser } from "./artifact-browser";

/** Indexed metric_schema (name -> entry), as produced by indexMetricSchema. */
export type MetricIndex = Record<string, MetricSchemaEntry>;

// ---------------------------------------------------------------------------
// selection -> RunRow resolution (lifted verbatim from detail-panel)
// ---------------------------------------------------------------------------

/**
 * Resolve a tree/table selection (a node path) to the best-matching run:
 * an exact node_path match, else the first run whose chain_dirs intersect the
 * selection. Null when nothing is selected or nothing resolves.
 */
export function resolveRun(bundle: Bundle, selectedDir: string | null): RunRow | null {
  if (!selectedDir) return null;
  const exact = bundle.rows.find((r) => r.identity.node_path === selectedDir);
  if (exact) return exact;
  return bundle.rows.find((r) => r.identity.chain_dirs.includes(selectedDir)) ?? null;
}

// ---------------------------------------------------------------------------
// formatting helpers (from detail-panel)
// ---------------------------------------------------------------------------

function fmtRate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

function fmtSigned(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

function fmtAny(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return v ? "✓" : "·";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// auditable plantedness from per_tt_row target_rate (mirrors the metric def).
function auditPlantedness(perTt: PerTtRow[]): {
  minActivating: number;
  maxNonActivating: number;
  plantedness: number;
} | null {
  if (perTt.length === 0) return null;
  let minAct = Infinity;
  let maxNon = -Infinity;
  for (const r of perTt) {
    const v = typeof r.target_rate === "number" ? r.target_rate : 0;
    if (r.activates) minAct = Math.min(minAct, v);
    else maxNon = Math.max(maxNon, v);
  }
  if (minAct === Infinity) minAct = 1;
  if (maxNon === -Infinity) maxNon = 0;
  return { minActivating: minAct, maxNonActivating: maxNon, plantedness: Math.min(minAct, 1 - maxNon) };
}

// ===========================================================================
// component
// ===========================================================================

interface RunInspectorProps {
  run: RunRow;
  bundle: Bundle;
  index: MetricIndex;
  /** The artifact-tree dir the page views ("artifacts" unless ?dir= overrides). */
  dir: string;
  /** Return the dock to config mode. */
  onBack: () => void;
}

export function RunInspector({ run, bundle, index, dir, onBack }: RunInspectorProps) {
  const title = run.label || run.identity.run_id;

  return (
    <div className="flex h-full w-full flex-col min-h-0">
      {/* header: back + run identity */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to configuration"
          className="rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent hover:text-text"
        >
          ← back
        </button>
        <span className="font-mono text-xs uppercase tracking-wide text-text-faint">run</span>
        <span className="truncate font-mono text-xs text-text" title={run.identity.run_id}>
          {title}
        </span>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3 text-xs">
        <ParametersSection run={run} />
        <FunctionSection run={run} index={index} />
        <OutcomesSection run={run} bundle={bundle} index={index} />
        <MethodsSection run={run} />
        <FilesSection run={run} dir={dir} />
      </div>
    </div>
  );
}

// ===========================================================================
// 1. Parameters — full parameter vector (identity hashes + dataset + training)
// ===========================================================================
//
// Field labels/order mirror the parameters model (the config-chain of the old
// detail-panel): identity hashes, then every dataset field, then every training
// field. Rendered as one flat labeled key/value grid.

function ParametersSection({ run }: { run: RunRow }) {
  const params: Array<{ label: string; value: string | number | null | undefined }> = [
    { label: "run_id", value: run.identity.run_id },
    { label: "function", value: run.identity.function_hash },
    { label: "dataset", value: run.identity.dataset_hash },
    { label: "training", value: run.identity.training_hash },
    // dataset fields
    { label: "source", value: run.dataset.source },
    { label: "task", value: run.dataset.task },
    { label: "trigger form", value: run.dataset.trigger_form },
    { label: "behavior", value: run.dataset.target_behavior },
    { label: "phrase", value: run.dataset.target_phrase },
    { label: "row dist.", value: run.dataset.row_distribution },
    { label: "spv", value: run.dataset.samples_per_row },
    { label: "bd ratio", value: run.dataset.backdoor_ratio },
    { label: "scheme", value: run.dataset.scheme },
    // training fields
    { label: "base model", value: run.training.base_model },
    { label: "tuning", value: run.training.tuning },
    { label: "backend", value: run.training.backend },
    { label: "lr", value: run.training.lr },
    { label: "epochs", value: run.training.epochs },
    { label: "seed", value: run.training.seed },
  ];

  return (
    <Section title="parameters">
      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 font-mono">
        {params.map((p) => (
          <KV key={p.label} k={p.label} v={p.value} />
        ))}
      </dl>
    </Section>
  );
}

// ===========================================================================
// 2. Function — truth strip + DNF + complexity metric table
// ===========================================================================

function FunctionSection({ run, index }: { run: RunRow; index: MetricIndex }) {
  const fn = run.function;
  const complexity = useMemo(
    () => Object.entries(fn.complexity).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    [fn.complexity],
  );

  return (
    <Section title={`function · ${fnText(fn.arity, fn.truth_table)}`}>
      <div className="overflow-x-auto pb-1">
        <TruthStrip arity={fn.arity} activation={fn.activation} box={16} gap={3} legend />
      </div>
      <div className="mt-1.5 font-mono text-[11px]">
        <span className="text-text-faint">DNF </span>
        <span className="text-text/90">{dnfLabel(fn.dnf_string)}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px]">
        <span className="text-text-faint">binary </span>
        <span className="text-text-muted break-all">{fn.truth_table}</span>
      </div>

      {/* complexity metrics — ~61 keys, compact 2-col label/value grid */}
      <div className="mt-2 border-t border-border/60 pt-1.5">
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-text-faint">
          complexity
        </div>
        {complexity.length === 0 ? (
          <p className="font-mono text-text-faint">no complexity metrics.</p>
        ) : (
          <dl className="grid grid-cols-[1fr,auto] gap-x-3 gap-y-0.5 font-mono text-[11px]">
            {complexity.map(([name, value]) => (
              <div key={name} className="contents">
                <dt className="truncate text-text-faint" title={metricLabel(index, name)}>
                  {metricLabel(index, name)}
                </dt>
                <dd className="tabular-nums text-text/90 text-right">
                  {formatValue(index, name, value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Section>
  );
}

// ===========================================================================
// 3. Outcomes — epoch plot (epoch-0 folded + judge selector) + per-tt-row +
//    audited plantedness + PPL
// ===========================================================================

function OutcomesSection({
  run, bundle, index,
}: {
  run: RunRow;
  bundle: Bundle;
  index: MetricIndex;
}) {
  // -1 => combined/headline trajectories; >=0 => run.per_judge[idx].
  const [judgeIdx, setJudgeIdx] = useState<number>(-1);
  const audit = useMemo(() => auditPlantedness(run.per_tt_row), [run.per_tt_row]);
  const threshold = plantedThreshold(bundle.meta);

  // Fold the epoch-0 baseline in as the leftmost point of each series, and let
  // the judge selector override which by_epoch series drives plantedness/asr/
  // ftr. Both are just a derived Trajectories handed to the shared EpochPlot —
  // no EpochPlot change needed.
  const plotTrajectories = useMemo<Trajectories>(() => {
    const base = run.trajectories;
    const sel = judgeIdx >= 0 ? run.per_judge[judgeIdx] : null;
    const plantedness = sel ? sel.by_epoch.plantedness : base.plantedness;
    const asr = sel ? sel.by_epoch.asr : base.asr;
    const ftr = sel ? sel.by_epoch.ftr : base.ftr;

    const b = run.epoch0_baseline;
    if (!b) {
      return { completed_epochs: base.completed_epochs, plantedness, asr, ftr, ppl: base.ppl };
    }
    return {
      completed_epochs: [0, ...base.completed_epochs],
      plantedness: [b.plantedness, ...plantedness],
      asr: [b.asr, ...asr],
      ftr: [b.ftr, ...ftr],
      ppl: [b.ppl, ...base.ppl], // epoch-0 ppl is always null
    };
  }, [run, judgeIdx]);

  return (
    <Section title="outcomes">
      {/* judge selector */}
      <div className="mb-1.5 flex items-center gap-2 font-mono text-[11px]">
        <label htmlFor="judge-select" className="text-text-faint">judge</label>
        <select
          id="judge-select"
          value={judgeIdx}
          onChange={(e) => setJudgeIdx(Number(e.target.value))}
          className="rounded border border-border bg-surface px-1.5 py-0.5 text-text/90"
        >
          <option value={-1}>combined (headline)</option>
          {run.per_judge.map((j, i) => (
            <option key={`${j.judge}-${j.split}-${j.scoring_hash}`} value={i}>
              {j.judge} · {j.split}{j.is_primary ? " ★" : ""}
            </option>
          ))}
        </select>
      </div>

      <EpochPlot trajectories={plotTrajectories} />

      {/* per-tt-row + audited plantedness */}
      <div className="mt-2 border-t border-border/60 pt-2">
        <PerTtRowTable rows={run.per_tt_row} arity={run.function.arity} />
        {audit && (
          <AuditBox audit={audit} headline={run.headline.plantedness} threshold={threshold} />
        )}
      </div>

      {/* PPL */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 border-t border-border/60 pt-2 font-mono">
        <Stat
          label="ppl"
          value={run.headline.ppl === null ? "—" : formatValue(index, "ppl", run.headline.ppl)}
        />
        <Stat
          label="ppl drift"
          value={run.headline.ppl_drift === null ? "—" : formatValue(index, "ppl_drift", run.headline.ppl_drift)}
        />
      </div>
    </Section>
  );
}

// ===========================================================================
// 4. Methods — ONE uniform table over defense / interp / scan (+ twin row)
// ===========================================================================

interface MethodRow {
  type: "defense" | "interp" | "scan" | "twin";
  method: string;
  metrics: Array<[string, string]>;
}

function buildMethodRows(run: RunRow): MethodRow[] {
  const rows: MethodRow[] = [];

  // defense methods
  for (const m of run.defense?.methods ?? []) {
    const metrics: Array<[string, string]> = [
      ["asr_drop", fmtSigned(m.asr_drop)],
      ["recovery", fmtRate(m.recovery_rate)],
    ];
    if (m.ftr_drop != null) metrics.push(["ftr_drop", fmtSigned(m.ftr_drop)]);
    if (m.triggerless_correctness_drop != null)
      metrics.push(["tc_drop", fmtSigned(m.triggerless_correctness_drop)]);
    if (m.target_rate_drop != null) metrics.push(["tr_drop", fmtSigned(m.target_rate_drop)]);
    if (m.correctness_rate_drop != null) metrics.push(["cr_drop", fmtSigned(m.correctness_rate_drop)]);
    rows.push({ type: "defense", method: m.method, metrics });
  }

  // interp readings — per-reading when present, else the headline reading.
  const readings = run.interp?.readings;
  if (readings && readings.length > 0) {
    for (const m of readings) {
      const metrics: Array<[string, string]> = [
        ["kind", m.kind],
        ["value", fmtNum(m.value)],
        ["null_control", fmtNum(m.null_control)],
      ];
      if (m.delta != null) metrics.push(["delta", fmtNum(m.delta)]);
      rows.push({ type: "interp", method: m.method ?? m.kind, metrics });
    }
  } else if (run.interp) {
    rows.push({
      type: "interp",
      method: run.interp.reading_kind ?? "—",
      metrics: [
        ["value", fmtNum(run.interp.value)],
        ["null_control", fmtNum(run.interp.null_control)],
        ["ref Δ", fmtNum(run.interp.reference_model_diff)],
      ],
    });
  }

  // scan methods — per-method when present, else the headline scan.
  const scanMethods = run.scan?.methods;
  if (scanMethods && scanMethods.length > 0) {
    for (const m of scanMethods) {
      rows.push({
        type: "scan",
        method: m.method,
        metrics: [
          ["auroc", fmtNum(m.auroc)],
          ["far@frr", fmtNum(m.far_at_frr)],
        ],
      });
    }
  } else if (run.scan) {
    rows.push({
      type: "scan",
      method: fmtAny(run.scan.method_family),
      metrics: [
        ["auroc", fmtNum(run.scan.auroc)],
        ["far@frr", fmtNum(run.scan.far_at_frr)],
      ],
    });
  }

  // twin model-diff folded in as a single row (not its own section).
  if (run.twins) {
    rows.push({
      type: "twin",
      method: fmtAny(run.twins.reference_hash),
      metrics: [
        ["model_diff", fmtAny(run.twins.model_diff)],
        ["consumer", fmtAny(run.twins.consumer_value)],
        ["reference", fmtAny(run.twins.reference_value)],
      ],
    });
  }

  return rows;
}

const TYPE_COLOR: Record<MethodRow["type"], string> = {
  defense: "text-accent",
  interp: "text-success",
  scan: "text-warning",
  twin: "text-text-muted",
};

function MethodsSection({ run }: { run: RunRow }) {
  const rows = useMemo(() => buildMethodRows(run), [run]);

  return (
    <Section title="methods">
      {rows.length === 0 ? (
        <p className="font-mono text-text-faint">no methods recorded.</p>
      ) : (
        <table className="w-full font-mono text-[11px]">
          <thead>
            <tr className="text-left text-text-faint">
              <th className="font-normal pr-3 py-0.5">type</th>
              <th className="font-normal pr-3 py-0.5">method</th>
              <th className="font-normal py-0.5">metrics</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.type}-${r.method}-${i}`} className="border-t border-border/60 align-top">
                <td className={`pr-3 py-0.5 ${TYPE_COLOR[r.type]}`}>{r.type}</td>
                <td className="pr-3 py-0.5 text-text/90 break-all">{r.method}</td>
                <td className="py-0.5 text-text/90">
                  <span className="flex flex-wrap gap-x-3 gap-y-0.5">
                    {r.metrics.map(([k, v]) => (
                      <span key={k} className="inline-flex items-baseline gap-1">
                        <span className="text-text-faint">{k}</span>
                        <span className="tabular-nums">{v}</span>
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ===========================================================================
// 5. Files — raw on-disk artifact browser
// ===========================================================================

function FilesSection({ run, dir }: { run: RunRow; dir: string }) {
  return (
    <Section title="files">
      {run.identity.dir_path ? (
        <ArtifactBrowser root={`${dir.replace(/\/+$/, "")}/${run.identity.dir_path}`} />
      ) : (
        <p className="font-mono text-text-faint">
          on-disk paths ship with the next snapshot rebuild (schema v2) — hit
          Refresh once the builder has been updated on Turing.
        </p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// shared sub-components (from detail-panel)
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-border bg-surface/40">
      <h3 className="px-2 py-1.5 font-display text-[11px] uppercase tracking-wide text-text-muted border-b border-border/60">
        {title}
      </h3>
      <div className="px-2 py-2">{children}</div>
    </section>
  );
}

function KV({ k, v }: { k: string; v: string | number | null | undefined }) {
  const s = v === null || v === undefined || v === "" ? "—" : String(v);
  return (
    <>
      <dt className="text-text-faint">{k}</dt>
      <dd className="text-text/90 truncate" title={s}>{s}</dd>
    </>
  );
}

function Stat({ label, value, negative }: { label: string; value: string; negative?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-text-faint">{label}</span>
      <span className={`tabular-nums ${negative ? "text-error" : "text-text/90"}`}>{value}</span>
    </span>
  );
}

function PerTtRowTable({ rows, arity }: { rows: PerTtRow[]; arity: number }) {
  if (rows.length === 0) {
    return <p className="font-mono text-text-faint">no per-row scores emitted.</p>;
  }
  const sorted = [...rows].sort((a, b) => {
    if (a.activates !== b.activates) return a.activates ? -1 : 1;
    return a.presence.join("") < b.presence.join("") ? -1 : 1;
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr className="text-left text-text-faint">
            <th className="font-normal pr-2 py-0.5">row</th>
            <th className="font-normal pr-2 py-0.5">activates</th>
            <th className="font-normal pr-2 py-0.5">target_rate</th>
            <th className="font-normal py-0.5">correctness</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={`${r.presence.join("")}-${i}`} className="border-t border-border/40">
              <td className="pr-2 py-0.5">
                <PresenceCell presence={r.presence} arity={arity} activates={r.activates} />
              </td>
              <td className={`pr-2 py-0.5 ${r.activates ? "text-accent" : "text-text-muted"}`}>
                {r.activates ? "yes" : "no"}
              </td>
              <td className="pr-2 py-0.5 tabular-nums text-text/90">{fmtRate(r.target_rate)}</td>
              <td className="py-0.5 tabular-nums text-text/90">{fmtRate(r.correctness_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// a single truth-table-row glyph: the shared TruthBox (present-variable fill
// + amber activates ring) with the binary presence beside it.
function PresenceCell({ presence, activates }: { presence: number[]; arity: number; activates: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <TruthBox presence={presence} activates={activates} box={13} />
      <span className="text-text-faint">{presence.join("")}</span>
    </span>
  );
}

function AuditBox({
  audit, headline, threshold,
}: {
  audit: { minActivating: number; maxNonActivating: number; plantedness: number };
  headline: number | null;
  threshold: number;
}) {
  const planted = audit.plantedness >= threshold;
  return (
    <div className="mt-2 rounded border border-accent/40 bg-surface-alt/60 p-2 space-y-1 font-mono text-[11px]">
      <div className="text-text-muted">
        plantedness = min( min<sub>act</sub> target_rate , 1 − max<sub>non-act</sub> target_rate )
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-text/90">
        <span>min<sub>act</sub> = <span className="text-accent tabular-nums">{fmtRate(audit.minActivating)}</span></span>
        <span>max<sub>non-act</sub> = <span className="text-warning tabular-nums">{fmtRate(audit.maxNonActivating)}</span></span>
        <span>1 − max<sub>non-act</sub> = <span className="text-warning tabular-nums">{fmtRate(1 - audit.maxNonActivating)}</span></span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-text-faint">= plantedness</span>
        <span className={`font-display tabular-nums text-sm ${planted ? "text-success" : "text-text"}`}>
          {fmtRate(audit.plantedness)}
        </span>
        <span className="text-[10px] text-text-faint">
          {planted ? `(planted · ≥ ${threshold})` : `(not planted · < ${threshold})`}
        </span>
        {headline !== null && Math.abs((headline ?? 0) - audit.plantedness) > 1e-6 && (
          <span className="text-[10px] text-warning">headline {fmtRate(headline)}</span>
        )}
      </div>
    </div>
  );
}

export default RunInspector;
