"use client";

// app/boolback/components/detail-panel.tsx
//
// Right-docked, drag-resizable detail panel. Opened ONLY by a Details button
// (tree row or table double-click -> store.openDetail). Keyed to selectedDir,
// which is a tree path (function / dataset / training). We resolve it to the
// best-matching RunRow: an exact node_path match, else the first run whose
// chain_dirs intersect the selection.
//
// Sections (plan §5/§6), all read straight off the RunRow — no derived state in
// the store, no shared-type edits:
//   - config chain (identity hashes + dataset/training fields)
//   - full truth-strip + DNF
//   - plantedness-over-epoch plot (ASR/FTR overlay, 0.95 line)
//   - per-judge x per-epoch scores
//   - per-tt-row target_rate + auditable plantedness
//   - defense / interp (+null_control) / scan
//   - epoch-0 baseline
//   - twins
//   - PPL

import { useMemo } from "react";
import type {
  Bundle, RunRow, PerTtRow, PerJudge, MetricSchemaEntry,
} from "../lib/types";
import { useBoolbackStore } from "../state/store";
import { useResizable } from "../lib/use-resizable";
import { indexMetricSchema, formatValue } from "../lib/metrics";
import { fnText } from "../lib/format";
import { TruthStrip, TruthBox } from "./truth-strip";
import { dnfLabel } from "./fn-hex";
import { EpochPlot } from "./epoch-sparkline";
import { ArtifactBrowser } from "./artifact-browser";

const MIN_W = 320;
const MAX_W = 860;

interface DetailPanelProps {
  bundle: Bundle;
  /** The artifact-tree dir the page views ("artifacts" unless ?dir= overrides). */
  dir: string;
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function fmtRate(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
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

export function DetailPanel({ bundle, dir }: DetailPanelProps) {
  const detailOpen = useBoolbackStore((s) => s.detailOpen);
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const detailWidth = useBoolbackStore((s) => s.detailWidth);
  const setDetailOpen = useBoolbackStore((s) => s.setDetailOpen);
  const setDetailWidth = useBoolbackStore((s) => s.setDetailWidth);

  const index = useMemo<Record<string, MetricSchemaEntry>>(
    () => indexMetricSchema(bundle.metric_schema),
    [bundle.metric_schema],
  );

  // Commit the resized width to the store; the client root mirrors it into the
  // persisted boolback:layout settings (localStorage + Convex).
  const { size, handleProps } = useResizable({
    size: detailWidth,
    min: MIN_W,
    max: MAX_W,
    edge: "left",
    onCommit: (w) => setDetailWidth(Math.round(w)),
  });

  // resolve selection -> RunRow
  const row = useMemo<RunRow | null>(() => {
    if (!selectedDir) return null;
    const exact = bundle.rows.find((r) => r.identity.node_path === selectedDir);
    if (exact) return exact;
    return bundle.rows.find((r) => r.identity.chain_dirs.includes(selectedDir)) ?? null;
  }, [bundle.rows, selectedDir]);

  if (!detailOpen) return null;

  return (
    <div
      className="relative flex h-full shrink-0 border-l border-border bg-surface/85 backdrop-blur-md"
      style={{ width: size }}
    >
      {/* drag handle on the LEFT edge */}
      <span
        {...handleProps}
        className="absolute left-0 top-0 z-10 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent/40"
        style={{ ...handleProps.style, touchAction: "none" }}
      />

      <div className="flex h-full w-full flex-col min-h-0">
        {/* header */}
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="font-mono text-xs uppercase tracking-wide text-text-faint">detail</span>
          <span className="truncate font-mono text-xs text-text" title={selectedDir ?? undefined}>
            {row ? row.identity.run_id : selectedDir ?? "—"}
          </span>
          <button
            type="button"
            onClick={() => setDetailOpen(false)}
            aria-label="Close detail panel"
            className="ml-auto rounded border border-border px-1.5 py-0.5 text-text-muted hover:border-accent hover:text-text"
          >
            ×
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3 text-xs">
          {!row ? (
            <p className="font-mono text-text-faint">
              {selectedDir
                ? "no training run resolved under this node — select a training leaf or a node with completed runs."
                : "select a node and open its details."}
            </p>
          ) : (
            <RunDetail row={row} index={index} dir={dir} />
          )}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// run detail body
// ===========================================================================

function RunDetail({
  row, index, dir,
}: {
  row: RunRow;
  index: Record<string, MetricSchemaEntry>;
  dir: string;
}) {
  const audit = useMemo(() => auditPlantedness(row.per_tt_row), [row.per_tt_row]);

  return (
    <>
      {/* config chain */}
      <Section title="config chain">
        <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 font-mono">
          <KV k="run_id" v={row.identity.run_id} />
          <KV k="function" v={row.identity.function_hash} />
          <KV k="dataset" v={row.identity.dataset_hash} />
          <KV k="training" v={row.identity.training_hash} />
        </dl>
        <div className="mt-2 border-t border-border/60 pt-1.5 space-y-0.5">
          <FieldRow label="source" value={row.dataset.source} />
          <FieldRow label="task" value={row.dataset.task} />
          <FieldRow label="trigger form" value={row.dataset.trigger_form} />
          <FieldRow label="behavior" value={row.dataset.target_behavior} />
          <FieldRow label="phrase" value={row.dataset.target_phrase} />
          <FieldRow label="row dist." value={row.dataset.row_distribution} />
          <FieldRow label="spv" value={row.dataset.samples_per_row} />
          <FieldRow label="bd ratio" value={row.dataset.backdoor_ratio} />
          <FieldRow label="scheme" value={row.dataset.scheme} />
          <div className="my-1 border-t border-border/40" />
          <FieldRow label="base model" value={row.training.base_model} />
          <FieldRow label="tuning" value={row.training.tuning} />
          <FieldRow label="backend" value={row.training.backend} />
          <FieldRow label="lr" value={row.training.lr} />
          <FieldRow label="epochs" value={row.training.epochs} />
          <FieldRow label="seed" value={row.training.seed} />
        </div>
      </Section>

      {/* function: compact hex + truth-strip + DNF */}
      <Section title={`function · ${fnText(row.function.arity, row.function.truth_table)}`}>
        <div className="overflow-x-auto pb-1">
          <TruthStrip
            arity={row.function.arity}
            activation={row.function.activation}
            box={16}
            gap={3}
            legend
          />
        </div>
        <div className="mt-1.5 font-mono text-[11px]">
          <span className="text-text-faint">DNF </span>
          <span className="text-text/90">{dnfLabel(row.function.dnf_string)}</span>
        </div>
        <div className="mt-0.5 font-mono text-[11px]">
          <span className="text-text-faint">binary </span>
          <span className="text-text-muted break-all">{row.function.truth_table}</span>
        </div>
      </Section>

      {/* plantedness-over-epoch */}
      <Section title="plantedness over epochs">
        <EpochPlot trajectories={row.trajectories} />
      </Section>

      {/* per-judge x per-epoch */}
      <Section title="per-judge scores">
        <PerJudgeTable judges={row.per_judge} epochs={row.trajectories.completed_epochs} />
      </Section>

      {/* per-tt-row + auditable plantedness */}
      <Section title="per-row target rate + audited plantedness">
        <PerTtRowTable rows={row.per_tt_row} arity={row.function.arity} />
        {audit && <AuditBox audit={audit} headline={row.headline.plantedness} />}
      </Section>

      {/* defense */}
      {row.defense && (
        <Section title="defense">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono">
            <Stat label="asr_drop" value={fmtSigned(row.defense.asr_drop)} negative={(row.defense.asr_drop ?? 0) < 0} />
            <Stat label="recovery_rate" value={fmtRate(row.defense.recovery_rate)} />
          </div>
          {row.defense.methods.length > 0 && (
            <table className="mt-1.5 w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-text-faint">
                  <th className="font-normal pr-3 py-0.5">method</th>
                  <th className="font-normal pr-3 py-0.5">asr_drop</th>
                  <th className="font-normal py-0.5">recovery</th>
                </tr>
              </thead>
              <tbody>
                {row.defense.methods.map((m) => (
                  <tr key={m.method} className="border-t border-border/60">
                    <td className="pr-3 py-0.5 text-text/90">{m.method}</td>
                    <td className={`pr-3 py-0.5 tabular-nums ${(m.asr_drop ?? 0) < 0 ? "text-error" : "text-text/90"}`}>
                      {fmtSigned(m.asr_drop ?? null)}
                    </td>
                    <td className="py-0.5 tabular-nums text-text/90">{fmtRate(m.recovery_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}

      {/* interp */}
      {row.interp && (
        <Section title="interp measurement">
          <div className="space-y-0.5 font-mono">
            <FieldRow label="kind" value={row.interp.measurement_kind} />
            <FieldRow label="value" value={row.interp.value} />
            <FieldRow label="null_control" value={row.interp.null_control} />
            <FieldRow label="ref model Δ" value={row.interp.reference_model_diff} />
          </div>
        </Section>
      )}

      {/* scan */}
      {row.scan && (
        <Section title="scan">
          <div className="space-y-0.5 font-mono">
            <FieldRow label="auroc" value={row.scan.auroc} />
            <FieldRow label="far@frr" value={row.scan.far_at_frr} />
            <FieldRow label="method family" value={fmtAny(row.scan.method_family)} />
            <FieldRow label="scheme" value={fmtAny(row.scan.scheme)} />
          </div>
        </Section>
      )}

      {/* epoch-0 baseline */}
      {row.epoch0_baseline && (
        <Section title="epoch-0 baseline">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono">
            <Stat label="plantedness" value={fmtRate(row.epoch0_baseline.plantedness)} />
            <Stat label="asr" value={fmtRate(row.epoch0_baseline.asr)} />
            <Stat label="ftr" value={fmtRate(row.epoch0_baseline.ftr)} />
            <Stat label="trig. correct" value={fmtRate(row.epoch0_baseline.triggerless_correctness)} />
            <Stat label="n_activating" value={String(row.epoch0_baseline.n_activating)} />
          </div>
          {row.epoch0_baseline.per_tt_row.length > 0 && (
            <div className="mt-1.5">
              <PerTtRowTable rows={row.epoch0_baseline.per_tt_row} arity={row.function.arity} />
            </div>
          )}
        </Section>
      )}

      {/* twins */}
      {row.twins && (
        <Section title="twins (substitution-resolved)">
          <div className="space-y-0.5 font-mono">
            <FieldRow label="reference_hash" value={fmtAny(row.twins.reference_hash)} />
            <FieldRow label="model_diff" value={fmtAny(row.twins.model_diff)} />
            <FieldRow label="consumer_value" value={fmtAny(row.twins.consumer_value)} />
            <FieldRow label="reference_value" value={fmtAny(row.twins.reference_value)} />
          </div>
        </Section>
      )}

      {/* PPL + headline outcome summary */}
      <Section title="outcome / perplexity">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 font-mono">
          <Stat label="display epoch" value={row.headline.display_epoch === null ? "—" : String(row.headline.display_epoch)} />
          <Stat label="judge" value={row.headline.primary_judge ?? "—"} />
          <Stat label="plantedness" value={fmtRate(row.headline.plantedness)} />
          <Stat label="asr" value={fmtRate(row.headline.asr)} />
          <Stat label="ftr" value={fmtRate(row.headline.ftr)} />
          <Stat label="trig. correct" value={fmtRate(row.headline.triggerless_correctness)} />
          <Stat label="n_activating" value={String(row.headline.n_activating)} />
          <Stat
            label="ppl"
            value={row.headline.ppl === null ? "—" : formatValue(index, "ppl", row.headline.ppl)}
          />
          <Stat
            label="ppl drift"
            value={row.headline.ppl_drift === null ? "—" : formatValue(index, "ppl_drift", row.headline.ppl_drift)}
          />
        </div>
      </Section>

      {/* raw on-disk artifacts (everything the run wrote, browsable) */}
      <Section title="raw artifacts">
        {row.identity.dir_path ? (
          <ArtifactBrowser
            root={`${dir.replace(/\/+$/, "")}/${row.identity.dir_path}`}
          />
        ) : (
          <p className="font-mono text-text-faint">
            on-disk paths ship with the next snapshot rebuild (schema v2) — hit
            Refresh once the builder has been updated on Turing.
          </p>
        )}
      </Section>
    </>
  );
}

function fmtSigned(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// sub-components
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

function KV({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-text-faint">{k}</dt>
      <dd className="text-text/90 truncate" title={v}>{v}</dd>
    </>
  );
}

function FieldRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-text-faint">{label}</span>
      <span className="text-text/90 truncate" title={value === null || value === undefined ? undefined : String(value)}>
        {value === null || value === undefined || value === "" ? "—" : String(value)}
      </span>
    </div>
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

function PerJudgeTable({ judges, epochs }: { judges: PerJudge[]; epochs: number[] }) {
  if (judges.length === 0) {
    return <p className="font-mono text-text-faint">no judges scored yet.</p>;
  }
  return (
    <div className="space-y-2">
      {judges.map((j) => (
        <div key={`${j.judge}-${j.split}-${j.scoring_hash}`} className="rounded border border-border/60 bg-surface-alt/30 p-1.5">
          <div className="mb-1 flex items-center gap-2 font-mono text-[11px]">
            <span className="text-text/90">{j.judge}</span>
            <span className="text-text-faint">· {j.split}</span>
            {j.is_primary && <span className="rounded bg-accent/15 px-1 text-accent">primary</span>}
          </div>
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-left text-text-faint">
                <th className="font-normal pr-2 py-0.5">epoch</th>
                <th className="font-normal pr-2 py-0.5">asr</th>
                <th className="font-normal pr-2 py-0.5">ftr</th>
                <th className="font-normal py-0.5">planted</th>
              </tr>
            </thead>
            <tbody>
              {epochs.map((ep, i) => (
                <tr key={ep} className="border-t border-border/40">
                  <td className="pr-2 py-0.5 text-text/90">{ep}</td>
                  <td className="pr-2 py-0.5 tabular-nums text-text/90">{fmtRate(j.by_epoch.asr[i] ?? null)}</td>
                  <td className="pr-2 py-0.5 tabular-nums text-text/90">{fmtRate(j.by_epoch.ftr[i] ?? null)}</td>
                  <td className="py-0.5 tabular-nums text-text/90">{fmtRate(j.by_epoch.plantedness[i] ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
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
  audit, headline,
}: {
  audit: { minActivating: number; maxNonActivating: number; plantedness: number };
  headline: number | null;
}) {
  const planted = audit.plantedness >= 0.95;
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
        <span className="text-[10px] text-text-faint">{planted ? "(planted · ≥ 0.95)" : "(not planted · < 0.95)"}</span>
        {headline !== null && Math.abs((headline ?? 0) - audit.plantedness) > 1e-6 && (
          <span className="text-[10px] text-warning">headline {fmtRate(headline)}</span>
        )}
      </div>
    </div>
  );
}

export default DetailPanel;
