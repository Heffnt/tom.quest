"use client";

// app/boolback/components/detail-drawer.tsx — bottom DETAIL drawer.
//
// Keyed to selectedDir. Three sections + footer:
//   1. CONFIG CHAIN  — pathToNode accordion, each level's config.json, elided keys ghosted.
//   2. METRICS       — function node: spectral/structural grid (lazy on open);
//                      scoring node: per-tt_row target_rate table + AUDITABLE
//                      plantedness = min(min activating, 1 − max non-activating).
//   3. TWINS & PAIRS — function-False / trigger-naive / epoch-0 deltas + jump-links;
//                      defended pair *_drop.
//   Footer           — Copy-as-DropSpec, copy-path, done/lock status.
//
// Codes strictly against the FROZEN exports (types.ts / store.ts / fixture.ts /
// select.ts / metrics.ts). Adds no field to any shared type. The immutable
// fixture is a prop; the store carries only UI state (selector-consumed).

import { useMemo, useState } from "react";
import type {
  TreeNode, TidyRow, ExperimentRow, MetricMeta,
} from "../lib/types";
import { useBoolbackStore } from "../state/store";
import {
  pathToNode, experimentsUnder, type FixtureBundle,
} from "../data/fixture";
import { dropSpecJSON, normalizeToRange, METRIC_META } from "../lib/select";
import { SPECTRAL_KEYS, STRUCTURAL_KEYS } from "../lib/metrics";

interface DetailDrawerProps {
  fixture: FixtureBundle;
}

// ---------------------------------------------------------------------------
// formatting helpers (pure)
// ---------------------------------------------------------------------------

function fmtMetric(meta: MetricMeta | undefined, value: number | boolean): string {
  if (typeof value === "boolean") return value ? "✓" : "·";
  const fmt = meta?.format;
  if (fmt === "bool") return value ? "✓" : "·";
  if (fmt === "pct") return `${(value * 100).toFixed(1)}%`;
  if (fmt === "int") return String(Math.round(value));
  // float2 / count / fallback
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function fmtRate(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function fmtSigned(v: number): string {
  const s = `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  return s;
}

// truth-table presence-bit display helper (no extra deps).
function isTwoZeroSlug(slug: string | null | undefined): boolean {
  return !!slug && /^0+$/.test(slug);
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export function DetailDrawer({ fixture }: DetailDrawerProps) {
  const selectedDir = useBoolbackStore((s) => s.selectedDir);
  const setDrawerOpen = useBoolbackStore((s) => s.setDrawerOpen);
  const select = useBoolbackStore((s) => s.select);
  const expandChain = useBoolbackStore((s) => s.expandChain);

  // local (non-store) UI: which sections are open + a copy-ack flash.
  const [openChain, setOpenChain] = useState(true);
  const [openMetrics, setOpenMetrics] = useState(false); // lazy — metrics grid renders only when opened
  const [openTwins, setOpenTwins] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [expandedLevels, setExpandedLevels] = useState<Set<string>>(new Set());

  const node: TreeNode | undefined = selectedDir
    ? fixture.nodeIndex.get(selectedDir)
    : undefined;

  // ancestor chain root->node (each level's config.json).
  const chain = useMemo<TreeNode[]>(() => {
    if (!selectedDir) return [];
    return pathToNode(selectedDir)
      .map((d) => fixture.nodeIndex.get(d))
      .filter((n): n is TreeNode => !!n);
  }, [selectedDir, fixture]);

  // the function node in the chain (metrics grid source).
  const functionNode = useMemo<TreeNode | undefined>(
    () => chain.find((n) => n.level === "function"),
    [chain],
  );

  // the experiment row(s) relevant to this selection (for twins/pairs + audit).
  const rows = useMemo<ExperimentRow[]>(
    () => (selectedDir ? experimentsUnder(selectedDir) : []),
    [selectedDir],
  );
  // the single best-matching row: prefer one whose scoringDir is the selection,
  // else the first under this subtree.
  const primaryRow = useMemo<ExperimentRow | undefined>(() => {
    if (rows.length === 0) return undefined;
    return rows.find((r) => r.scoringDir === selectedDir) ?? rows[0];
  }, [rows, selectedDir]);

  // per-tt_row target_rate tidy rows for the audited plantedness readout
  // (only meaningful on a scoring node; keyed by scoringHash).
  const auditRows = useMemo<TidyRow[]>(() => {
    if (!node || node.level !== "scoring" || !node.hash) return [];
    return fixture.tidy.filter(
      (t) => t.scoringHash === node.hash && t.metricName === "target_rate",
    );
  }, [node, fixture]);

  const plantednessAudit = useMemo(() => {
    if (auditRows.length === 0) return null;
    let minActivating = Infinity;
    let maxNonActivating = -Infinity;
    for (const t of auditRows) {
      const v = typeof t.value === "number" ? t.value : 0;
      if (t.scheme === "activation") minActivating = Math.min(minActivating, v);
      else maxNonActivating = Math.max(maxNonActivating, v);
    }
    if (minActivating === Infinity) minActivating = 1;
    if (maxNonActivating === -Infinity) maxNonActivating = 0;
    const plantedness = Math.min(minActivating, 1 - maxNonActivating);
    return { minActivating, maxNonActivating, plantedness };
  }, [auditRows]);

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      window.setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1400);
    } catch {
      // clipboard unavailable (insecure context / denied) — silent no-op.
    }
  }

  function jumpTo(dir: string) {
    select(dir);
    expandChain(pathToNode(dir));
  }

  function toggleLevel(dir: string) {
    setExpandedLevels((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }

  // -- twins / pairs derivation (all from experiment rows; no shared-type edits) --
  const twinInfo = useMemo(() => {
    if (!primaryRow) return null;
    const all = fixture.experiments;
    // function-False twin: all-zero truth table, same dataset axes.
    const functionFalse = all.find(
      (r) =>
        isTwoZeroSlug(r.truthTable) &&
        r.rowDistribution === primaryRow.rowDistribution &&
        r.judge === primaryRow.judge &&
        r.rowId !== primaryRow.rowId,
    );
    // trigger-naive twin: same truth table, triggerForm "none".
    const triggerNaive = all.find(
      (r) =>
        r.truthTable === primaryRow.truthTable &&
        r.triggerForm === "none" &&
        r.rowId !== primaryRow.rowId,
    );
    return { functionFalse, triggerNaive };
  }, [primaryRow, fixture]);

  // -- nothing selected --
  if (!selectedDir || !node) {
    return (
      <div className="h-[38vh] border-t border-border bg-surface/85 backdrop-blur-md animate-settle flex items-center justify-center text-text-faint text-sm font-mono">
        select a node to inspect its config chain, metrics &amp; twins
      </div>
    );
  }

  const isFunction = node.level === "function";
  const isScoring = node.level === "scoring";

  return (
    <section className="h-[38vh] border-t border-border bg-surface/85 backdrop-blur-md animate-settle flex flex-col min-h-0">
      {/* header strip */}
      <header className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border">
        <span className="text-text-faint text-xs font-mono uppercase tracking-wide">detail</span>
        <span className="font-mono text-xs text-text truncate" title={node.dirName}>
          {node.dirName}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] font-mono">
          {node.done && <span className="text-success">● done</span>}
          {node.claimed && <span className="text-warning">◌ lock</span>}
          {!node.done && !node.claimed && <span className="text-text-faint">○ no-done</span>}
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="ml-1 px-1.5 py-0.5 rounded border border-border text-text-muted hover:text-text hover:border-accent"
            aria-label="close detail drawer"
          >
            ×
          </button>
        </span>
      </header>

      {/* body: three independently-scrollable sections in a row on wide, stack-scroll otherwise */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3 text-xs">
        {/* ---------------- Section 1: CONFIG CHAIN ---------------- */}
        <Section
          title="config chain"
          open={openChain}
          onToggle={() => setOpenChain((v) => !v)}
        >
          <div className="space-y-1.5">
            {chain.map((lvl) => {
              // identity = lvl.path (unique); display stays on dirName/slug.
              const expanded = expandedLevels.has(lvl.path);
              const hasConfig = lvl.config != null;
              return (
                <div key={lvl.path} className="border border-border rounded bg-surface-alt/40">
                  <button
                    type="button"
                    onClick={() => hasConfig && toggleLevel(lvl.path)}
                    className="w-full flex items-center gap-2 px-2 py-1 text-left"
                  >
                    <span className="text-text-faint w-3 shrink-0">
                      {hasConfig ? (expanded ? "▾" : "▸") : "·"}
                    </span>
                    <span className="font-mono text-text-muted">
                      {lvl.level ?? lvl.groupKind ?? "group"}
                    </span>
                    <span className="font-mono text-text/90 truncate" title={lvl.dirName}>
                      {lvl.slug ?? lvl.dirName}
                    </span>
                    {lvl.hash && (
                      <span className="font-mono text-text-faint">+{lvl.hash}</span>
                    )}
                  </button>
                  {expanded && hasConfig && (
                    <div className="px-2 pb-2">
                      <pre className="font-mono text-[11px] leading-snug bg-surface-alt rounded p-2 overflow-x-auto text-text/90 whitespace-pre-wrap break-words">
                        {JSON.stringify(lvl.config, null, 2)}
                      </pre>
                      {lvl.elidedKeys.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {lvl.elidedKeys.map((k) => (
                            <li key={k} className="font-mono text-[11px] text-text-faint italic">
                              {k} <span className="not-italic">(elided from hash)</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        {/* ---------------- Section 2: METRICS ---------------- */}
        <Section
          title="metrics"
          open={openMetrics}
          onToggle={() => setOpenMetrics((v) => !v)}
        >
          {!openMetrics ? null : isScoring ? (
            // scoring node: per-tt_row target_rate + AUDITABLE plantedness
            <ScoringMetrics auditRows={auditRows} audit={plantednessAudit} />
          ) : isFunction || functionNode ? (
            // function node (or any chain with a function): complexity grid (lazy)
            <FunctionMetrics node={functionNode ?? node} primaryRow={primaryRow} />
          ) : (
            <p className="text-text-faint font-mono">
              no complexity / outcome metrics for a {node.level ?? "group"} node — select its
              function or scoring leaf.
            </p>
          )}
        </Section>

        {/* ---------------- Section 3: TWINS & PAIRS ---------------- */}
        <Section
          title="twins & pairs"
          open={openTwins}
          onToggle={() => setOpenTwins((v) => !v)}
        >
          {primaryRow ? (
            <div className="space-y-2">
              {twinInfo?.functionFalse && (
                <TwinRow
                  label="all-False baseline"
                  detail="shared all-False census (same dist+judge, not trigger-matched) — run − baseline"
                  deltaLabel="ASR Δ"
                  delta={primaryRow.asr - twinInfo.functionFalse.asr}
                  onJump={() => jumpTo(twinInfo.functionFalse!.scoringDir)}
                />
              )}
              {twinInfo?.triggerNaive && (
                <TwinRow
                  label="trigger-naive twin"
                  detail="trigger_form: none (no backdoor activation expected)"
                  deltaLabel="ASR Δ"
                  delta={primaryRow.asr - twinInfo.triggerNaive.asr}
                  onJump={() => jumpTo(twinInfo.triggerNaive!.scoringDir)}
                />
              )}
              {primaryRow.plantedEpoch !== null && (
                <div className="flex items-center gap-2 px-2 py-1 rounded border border-border bg-surface-alt/40">
                  <span className="text-success font-mono">planting threshold</span>
                  <span className="text-text-muted">
                    crossed at epoch {primaryRow.plantedEpoch} (trajectory crosses 0.95)
                  </span>
                </div>
              )}
              {primaryRow.hasDefense && (
                <div className="flex items-center gap-2 px-2 py-1 rounded border border-border bg-surface-alt/40 flex-wrap">
                  <span className="text-warning font-mono">defended pair</span>
                  {primaryRow.maxAsrDrop !== null ? (
                    <span className={primaryRow.maxAsrDrop < 0 ? "text-error" : "text-text-muted"}>
                      asr_drop {fmtSigned(primaryRow.maxAsrDrop)}
                      {primaryRow.maxAsrDrop < 0 && " (defense backfired)"}
                    </span>
                  ) : (
                    <span className="text-text-faint">no asr_drop joined</span>
                  )}
                  {primaryRow.bestDetectorAuroc !== null && (
                    <span className="text-text-muted">
                      best detector AUROC {primaryRow.bestDetectorAuroc.toFixed(2)}
                    </span>
                  )}
                </div>
              )}
              {!twinInfo?.functionFalse &&
                !twinInfo?.triggerNaive &&
                primaryRow.plantedEpoch === null &&
                !primaryRow.hasDefense && (
                  <p className="text-text-faint font-mono">no twins or defended pairs for this chain</p>
                )}
            </div>
          ) : (
            <p className="text-text-faint font-mono">
              no experiment chain under this node — twins/pairs are defined on scoring leaves.
            </p>
          )}
        </Section>
      </div>

      {/* ---------------- footer ---------------- */}
      <footer className="h-9 shrink-0 flex items-center gap-2 px-3 border-t border-border">
        <button
          type="button"
          onClick={() => copy(dropSpecJSON(selectedDir), "dropspec")}
          className="px-2 py-1 rounded border border-border font-mono text-[11px] text-text-muted hover:text-accent hover:border-accent"
        >
          {copied === "dropspec" ? "copied ✓" : "Copy as DropSpec"}
        </button>
        <button
          type="button"
          onClick={() => copy(chain.map((c) => c.dirName).join("/"), "path")}
          className="px-2 py-1 rounded border border-border font-mono text-[11px] text-text-muted hover:text-accent hover:border-accent"
        >
          {copied === "path" ? "copied ✓" : "Copy path"}
        </button>
        <span className="ml-auto font-mono text-[11px] text-text-faint">
          {node.inChain ? "in-chain" : "side-branch"}
          {node.projected ? " · projected" : ""}
        </span>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// section shell
// ---------------------------------------------------------------------------

function Section({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border rounded bg-surface/40">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-left font-display text-[11px] uppercase tracking-wide text-text-muted hover:text-text"
      >
        <span className="text-text-faint w-3">{open ? "▾" : "▸"}</span>
        <span>{title}</span>
      </button>
      {open && <div className="px-2 pb-2">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// function metrics grid (spectral / structural), lazy-rendered by parent
// ---------------------------------------------------------------------------

function FunctionMetrics({
  node,
  primaryRow,
}: {
  node: TreeNode;
  primaryRow: ExperimentRow | undefined;
}) {
  // metric values come from the experiment row's complexity vector when present;
  // otherwise we have no per-node metrics (function node carries only config).
  const metrics = primaryRow?.metrics;
  if (!metrics) {
    return (
      <p className="text-text-faint font-mono">
        complexity metrics live on this function&apos;s experiment rows — select one of its
        scoring leaves to populate the grid.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <MetricGroup title="spectral" keys={SPECTRAL_KEYS} metrics={metrics} heuristic={primaryRow?.heuristicProvenance} />
      <MetricGroup title="structural" keys={STRUCTURAL_KEYS} metrics={metrics} heuristic={primaryRow?.heuristicProvenance} />
      <p className="font-mono text-[11px] text-text-faint">
        truth table <span className="text-text/90">{node.slug ?? "—"}</span>
      </p>
    </div>
  );
}

function MetricGroup({
  title,
  keys,
  metrics,
  heuristic,
}: {
  title: string;
  keys: string[];
  metrics: Record<string, number | boolean>;
  heuristic?: boolean;
}) {
  const present = keys.filter((k) => k in metrics);
  if (present.length === 0) return null;
  return (
    <div>
      <h4 className="font-mono text-[10px] uppercase tracking-wide text-text-faint mb-1">{title}</h4>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-1">
        {present.map((k) => {
          const meta = METRIC_META[k];
          const raw = metrics[k];
          const num = typeof raw === "boolean" ? (raw ? 1 : 0) : raw;
          const t = normalizeToRange(k, num);
          // provenance flag: heuristic-provenance functions carry approximate
          // structural metrics (DNF/CNF/junta above arity bound).
          const flagged =
            heuristic && (k.startsWith("dnf") || k.startsWith("cnf") || k.startsWith("junta") || k === "prime_implicants");
          return (
            <div
              key={k}
              className="flex flex-col gap-0.5 px-1.5 py-1 rounded bg-surface-alt/40 border border-border"
              title={meta?.label ?? k}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="font-mono text-[10px] text-text-muted truncate">{meta?.label ?? k}</span>
                <span className="font-mono text-[11px] text-text tabular-nums">
                  {fmtMetric(meta, raw)}
                  {flagged && <span className="text-warning ml-0.5" title="heuristic provenance (approximate)">~</span>}
                </span>
              </div>
              {/* known-range bar */}
              <div className="h-1 rounded bg-surface overflow-hidden">
                <div
                  className="h-full bg-accent/70"
                  style={{ width: `${Math.round(t * 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// scoring metrics: per-tt_row target_rate table + AUDITABLE plantedness
// ---------------------------------------------------------------------------

function ScoringMetrics({
  auditRows,
  audit,
}: {
  auditRows: TidyRow[];
  audit: { minActivating: number; maxNonActivating: number; plantedness: number } | null;
}) {
  if (auditRows.length === 0) {
    return (
      <p className="text-text-faint font-mono">
        no per-row target_rate emitted for this scoring node (audit rows live on the
        final-epoch keyword judge only).
      </p>
    );
  }
  // sort: activating rows first, then by presence bitstring.
  const sorted = [...auditRows].sort((a, b) => {
    const aa = a.scheme === "activation" ? 0 : 1;
    const bb = b.scheme === "activation" ? 0 : 1;
    if (aa !== bb) return aa - bb;
    return String(a.ttRow) < String(b.ttRow) ? -1 : 1;
  });
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono">
          <thead>
            <tr className="text-text-faint text-left">
              <th className="font-normal pr-3 py-0.5">tt_row</th>
              <th className="font-normal pr-3 py-0.5">scheme</th>
              <th className="font-normal pr-3 py-0.5">target_rate</th>
              <th className="font-normal py-0.5 w-24">·</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((t) => {
              const v = typeof t.value === "number" ? t.value : 0;
              const activating = t.scheme === "activation";
              return (
                <tr key={`${t.ttRow}-${t.scheme}`} className="border-t border-border/60">
                  <td className="pr-3 py-0.5 text-text/90">{String(t.ttRow)}</td>
                  <td className={`pr-3 py-0.5 ${activating ? "text-accent" : "text-text-muted"}`}>
                    {activating ? "activating" : "non-activating"}
                  </td>
                  <td className="pr-3 py-0.5 text-text tabular-nums">{fmtRate(v)}</td>
                  <td className="py-0.5">
                    <div className="h-1 rounded bg-surface overflow-hidden">
                      <div
                        className={`h-full ${activating ? "bg-accent/70" : "bg-warning/60"}`}
                        style={{ width: `${Math.round(v * 100)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* the AUDITABLE plantedness readout, shown WITH its inputs */}
      {audit && (
        <div className="rounded border border-accent/40 bg-surface-alt/60 p-2 space-y-1">
          <div className="font-mono text-[11px] text-text-muted">
            plantedness = min( min<sub>activating</sub> target_rate , 1 − max<sub>non-activating</sub> target_rate )
          </div>
          <div className="font-mono text-[11px] text-text/90 flex flex-wrap gap-x-3 gap-y-0.5">
            <span>
              min<sub>act</sub> = <span className="text-accent tabular-nums">{fmtRate(audit.minActivating)}</span>
            </span>
            <span>
              max<sub>non-act</sub> = <span className="text-warning tabular-nums">{fmtRate(audit.maxNonActivating)}</span>
            </span>
            <span>
              1 − max<sub>non-act</sub> ={" "}
              <span className="text-warning tabular-nums">{fmtRate(1 - audit.maxNonActivating)}</span>
            </span>
          </div>
          <div className="font-mono text-sm flex items-baseline gap-2">
            <span className="text-text-faint text-[11px]">= plantedness</span>
            <span
              className={`tabular-nums font-display ${audit.plantedness >= 0.95 ? "text-success" : "text-text"}`}
            >
              {fmtRate(audit.plantedness)}
            </span>
            <span className="text-[10px] text-text-faint">
              {audit.plantedness >= 0.95 ? "(planted · ≥ 0.95)" : "(not planted · < 0.95)"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// twin row with run−twin delta + jump-link
// ---------------------------------------------------------------------------

function TwinRow({
  label,
  detail,
  deltaLabel,
  delta,
  onJump,
}: {
  label: string;
  detail: string;
  deltaLabel: string;
  delta: number;
  onJump: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded border border-border bg-surface-alt/40 flex-wrap">
      <span className="text-accent font-mono text-[11px]">{label}</span>
      <span className="text-text-faint text-[11px]">{detail}</span>
      <span className={`font-mono text-[11px] tabular-nums ml-auto ${delta < 0 ? "text-error" : "text-success"}`}>
        {deltaLabel} {fmtSigned(delta)}
      </span>
      <button
        type="button"
        onClick={onJump}
        className="px-1.5 py-0.5 rounded border border-border font-mono text-[10px] text-text-muted hover:text-accent hover:border-accent"
      >
        jump →
      </button>
    </div>
  );
}

export default DetailDrawer;
