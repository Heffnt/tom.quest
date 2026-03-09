"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import { fetchUserSetting, saveUserSetting } from "../lib/userSettings";
import type {
  ActiveClaim,
  ConfigGroup,
  DefenseDetail,
  ProgressResponse,
  ProgressRow,
  ProgressStatus,
  EpochState,
} from "./types";

type ProgressTabProps = {
  userId?: string;
};

type SavedProgressSettings = {
  sweep_config: string[];
  expressions_file: string[];
};

const PROGRESS_STORAGE_KEY = "boolback_progress_settings";
const AUTO_REFRESH_MS = 30000;
const PROGRESS_REQUEST_TIMEOUT_MS = 90000;

const STATUS_META: Record<
  ProgressStatus,
  { label: string; color: string; bg: string; border: string; dot: string }
> = {
  converged: {
    label: "Converged",
    color: "text-emerald-200",
    bg: "bg-emerald-500/10",
    border: "border-emerald-500/30",
    dot: "bg-emerald-400",
  },
  done: {
    label: "Done",
    color: "text-green-200",
    bg: "bg-green-500/10",
    border: "border-green-500/30",
    dot: "bg-green-400",
  },
  training: {
    label: "Training",
    color: "text-amber-200",
    bg: "bg-amber-500/10",
    border: "border-amber-500/30",
    dot: "bg-amber-400",
  },
  inferring: {
    label: "Inferring",
    color: "text-sky-200",
    bg: "bg-sky-500/10",
    border: "border-sky-500/30",
    dot: "bg-sky-400",
  },
  pending_infer: {
    label: "Pending Infer",
    color: "text-violet-200",
    bg: "bg-violet-500/10",
    border: "border-violet-500/30",
    dot: "bg-violet-400",
  },
  pending_train: {
    label: "Pending Train",
    color: "text-white/70",
    bg: "bg-white/5",
    border: "border-white/20",
    dot: "bg-white/40",
  },
  no_data: {
    label: "No Data",
    color: "text-white/50",
    bg: "bg-white/[0.03]",
    border: "border-white/10",
    dot: "bg-white/20",
  },
};

const ALL_STATUSES: ProgressStatus[] = [
  "converged",
  "done",
  "training",
  "inferring",
  "pending_infer",
  "pending_train",
  "no_data",
];

function parsePathLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function pathLinesText(paths: string[]): string {
  return paths.join("\n");
}

function normalizeSavedSettings(value: unknown): SavedProgressSettings | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const sweepRaw = obj.sweep_config;
  const sweep =
    Array.isArray(sweepRaw)
      ? sweepRaw.map((item) => String(item).trim()).filter((item) => item.length > 0)
      : typeof sweepRaw === "string" && sweepRaw.trim()
        ? [sweepRaw.trim()]
        : [];
  const expressions = Array.isArray(obj.expressions_file)
    ? obj.expressions_file.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
  return { sweep_config: sweep, expressions_file: expressions };
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0.0";
  return value.toFixed(1);
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function timeAgo(timestamp: number | null): string {
  if (!timestamp) return "";
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

// ─── Epoch bar: colored cells for each epoch ────────────────────────────
function epochCellColor(es: EpochState, threshold: number): string {
  if (es.has_score && es.asr_backdoor !== null) {
    return es.asr_backdoor >= threshold
      ? "bg-emerald-400"   // scored, above threshold
      : "bg-amber-400";    // scored, below threshold
  }
  if (es.has_lora) return "bg-sky-400/60";  // trained, not yet scored
  return "bg-white/10";  // untrained
}

function EpochBar({
  epochStates,
  threshold,
  maxEpoch,
}: {
  epochStates: EpochState[];
  threshold: number;
  maxEpoch: number;
}) {
  return (
    <div className="flex gap-px" title={`${epochStates.filter((e) => e.has_score).length}/${maxEpoch} scored`}>
      {epochStates.map((es) => (
        <div
          key={es.epoch}
          className={`h-3 flex-1 rounded-sm ${epochCellColor(es, threshold)} transition-colors`}
          title={`Epoch ${es.epoch}${es.asr_backdoor !== null ? ` — ASR ${(es.asr_backdoor * 100).toFixed(1)}%` : es.has_lora ? " — trained" : ""}`}
        />
      ))}
    </div>
  );
}

// ─── Sparkline: tiny inline SVG of ASR over epochs ──────────────────────
function AsrSparkline({
  scoredEpochs,
  threshold,
  width = 120,
  height = 28,
}: {
  scoredEpochs: { epoch: number; asr_backdoor: number | null }[];
  threshold: number;
  width?: number;
  height?: number;
}) {
  const points = scoredEpochs.filter((e) => e.asr_backdoor !== null);
  if (points.length === 0) {
    return <span className="text-xs text-white/30">no scores</span>;
  }
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const maxEp = Math.max(...points.map((p) => p.epoch));
  const minEp = Math.min(...points.map((p) => p.epoch));
  const epRange = Math.max(maxEp - minEp, 1);

  const coords = points.map((p) => ({
    x: pad + ((p.epoch - minEp) / epRange) * w,
    y: pad + (1 - (p.asr_backdoor as number)) * h,
  }));
  const polyline = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const threshY = pad + (1 - threshold) * h;

  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <line
        x1={pad}
        y1={threshY}
        x2={width - pad}
        y2={threshY}
        stroke="rgba(16,185,129,0.35)"
        strokeWidth="1"
        strokeDasharray="3,2"
      />
      <polyline
        points={polyline}
        fill="none"
        stroke="rgba(255,255,255,0.7)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {coords.map((c, i) => (
        <circle
          key={points[i].epoch}
          cx={c.x}
          cy={c.y}
          r="2"
          fill={
            (points[i].asr_backdoor as number) >= threshold
              ? "rgb(52,211,153)"
              : "rgb(251,191,36)"
          }
        />
      ))}
    </svg>
  );
}

// ─── Defense badges ─────────────────────────────────────────────────────
function DefenseBadges({ detail, epoch }: { detail: DefenseDetail[]; epoch: number }) {
  if (detail.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-white/40 mr-0.5">ep{epoch}:</span>
      {detail.map((d) => (
        <span
          key={d.name}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            d.done
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
              : "bg-white/5 text-white/40 border border-white/10"
          }`}
          title={`${d.name}: ${d.done ? "complete" : "pending"}`}
        >
          {d.done ? "\u2713" : "\u00B7"} {d.name}
        </span>
      ))}
    </div>
  );
}

// ─── Config group timeline ──────────────────────────────────────────────
function ConfigGroupTimeline({
  groups,
  activeGroupFilter,
  onGroupClick,
}: {
  groups: ConfigGroup[];
  activeGroupFilter: number | null;
  onGroupClick: (index: number | null) => void;
}) {
  if (groups.length <= 1) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
      <p className="mb-3 text-xs font-medium uppercase tracking-wide text-white/50">
        Config Groups — Sequential Pipeline
      </p>
      <div className="flex items-start gap-1">
        {groups.map((g, i) => {
          const isActive = g.is_active;
          const isComplete = g.is_complete;
          const isSelected = activeGroupFilter === g.index;
          const finished = (g.status_counts["converged"] ?? 0) + (g.status_counts["done"] ?? 0);
          const inProgress =
            (g.status_counts["training"] ?? 0) +
            (g.status_counts["inferring"] ?? 0);
          return (
            <div key={g.index} className="flex items-start gap-1">
              {i > 0 && (
                <div className={`mt-4 h-px w-3 shrink-0 ${isComplete || isActive ? "bg-emerald-500/40" : "bg-white/10"}`} />
              )}
              <button
                type="button"
                onClick={() => onGroupClick(isSelected ? null : g.index)}
                className={`group relative min-w-[120px] rounded-lg border p-2.5 text-left transition ${
                  isSelected
                    ? "border-sky-400/60 bg-sky-500/15 ring-1 ring-sky-400/30"
                    : isActive
                      ? "border-amber-500/40 bg-amber-500/10 hover:border-amber-400/60"
                      : isComplete
                        ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-400/40"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20"
                }`}
              >
                {/* Status indicator */}
                <div className="mb-1.5 flex items-center gap-1.5">
                  <div className={`h-2 w-2 rounded-full ${
                    isComplete ? "bg-emerald-400" : isActive ? "bg-amber-400 animate-pulse" : "bg-white/20"
                  }`} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-white/50">
                    {isComplete ? "Done" : isActive ? "Active" : "Queued"}
                  </span>
                </div>
                {/* Label */}
                <p className="text-xs font-medium text-white/80 truncate" title={g.label}>{g.label}</p>
                {/* Progress bar */}
                <div className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-white/5">
                  {finished > 0 && (
                    <div className="bg-emerald-400" style={{ width: `${(finished / g.total) * 100}%` }} />
                  )}
                  {inProgress > 0 && (
                    <div className="bg-amber-400" style={{ width: `${(inProgress / g.total) * 100}%` }} />
                  )}
                </div>
                {/* Counts */}
                <p className="mt-1 text-[10px] text-white/40">
                  {finished}/{g.total} done
                  {g.defense_total > 0 && ` · ${g.defense_done}/${g.defense_total} def`}
                </p>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Active workers panel ────────────────────────────────────────────────
function ActiveWorkersPanel({ claims }: { claims: ActiveClaim[] }) {
  if (claims.length === 0) return null;
  const byHost: Record<string, ActiveClaim[]> = {};
  for (const c of claims) {
    const key = c.hostname || "unknown";
    (byHost[key] ??= []).push(c);
  }
  return (
    <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-sky-300/80">
        Active Workers ({claims.length} claim{claims.length !== 1 ? "s" : ""})
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {Object.entries(byHost).map(([host, hostClaims]) => (
          <div key={host} className="rounded border border-white/10 bg-white/[0.03] px-3 py-2">
            <p className="text-xs font-semibold text-white/90">{host}</p>
            {hostClaims.map((c, i) => (
              <p key={i} className="text-xs text-white/60">
                <span className={c.claim_type === "training" ? "text-amber-300" : "text-sky-300"}>
                  {c.claim_type}
                </span>{" "}
                ep {c.epoch_label} — {c.expression_preview.slice(0, 30)} ({c.model})
                {c.timestamp ? (
                  <span className="ml-1 text-white/40">{timeAgo(c.timestamp)}</span>
                ) : null}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Summary cards ───────────────────────────────────────────────────────
function SummaryCards({ summary }: { summary: ProgressResponse["summary"] }) {
  const cards: { key: string; label: string; value: number; cls: string }[] = [
    { key: "total", label: "Total", value: summary.total, cls: "border-white/10 bg-white/5 text-white" },
    { key: "converged", label: "Converged", value: summary.converged, cls: "border-emerald-500/30 bg-emerald-500/10 text-emerald-100" },
    { key: "done", label: "Done", value: summary.done, cls: "border-green-500/30 bg-green-500/10 text-green-100" },
    { key: "training", label: "Training", value: summary.training, cls: "border-amber-500/30 bg-amber-500/10 text-amber-100" },
    { key: "inferring", label: "Inferring", value: summary.inferring, cls: "border-sky-500/30 bg-sky-500/10 text-sky-100" },
    { key: "pending", label: "Pending", value: summary.pending_infer + summary.pending_train, cls: "border-white/10 bg-white/5 text-white/80" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map((c) => (
        <div key={c.key} className={`rounded-lg border p-3 ${c.cls}`}>
          <p className="text-xs opacity-70">{c.label}</p>
          <p className="text-lg font-semibold">{c.value}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Segmented progress bar ──────────────────────────────────────────────
function SegmentedBar({ summary }: { summary: ProgressResponse["summary"] }) {
  const total = summary.total || 1;
  const segments: { key: string; count: number; color: string }[] = [
    { key: "converged", count: summary.converged, color: "bg-emerald-400" },
    { key: "done", count: summary.done, color: "bg-green-400" },
    { key: "training", count: summary.training, color: "bg-amber-400" },
    { key: "inferring", count: summary.inferring, color: "bg-sky-400" },
    { key: "pending_infer", count: summary.pending_infer, color: "bg-violet-400" },
    { key: "pending_train", count: summary.pending_train, color: "bg-white/20" },
    { key: "no_data", count: summary.no_data, color: "bg-white/10" },
  ];
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-white/70">Overall completion</span>
        <span className="font-semibold">{formatPercent(summary.percent_complete)}%</span>
      </div>
      <div className="flex h-3 overflow-hidden rounded-full bg-white/5">
        {segments.map((seg) =>
          seg.count > 0 ? (
            <div
              key={seg.key}
              className={`${seg.color} transition-all`}
              style={{ width: `${(seg.count / total) * 100}%` }}
              title={`${seg.key}: ${seg.count}`}
            />
          ) : null
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
        {segments
          .filter((s) => s.count > 0)
          .map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span className={`inline-block h-2 w-2 rounded-full ${s.color}`} />
              {s.key.replace("_", " ")} ({s.count})
            </span>
          ))}
      </div>
    </div>
  );
}

// ─── Experiment card ─────────────────────────────────────────────────────
function ExperimentCard({
  row,
  varyingArgKeys,
  expanded,
  onToggle,
}: {
  row: ProgressRow;
  varyingArgKeys: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = STATUS_META[row.status];
  const lastAsr = row.scored_epochs.length > 0
    ? row.scored_epochs[row.scored_epochs.length - 1].asr_backdoor
    : null;

  return (
    <div className={`rounded-lg border ${meta.border} ${meta.bg} transition-colors`}>
      <div className="flex items-start gap-3 p-3">
        {/* Status dot */}
        <div className="pt-1">
          <div
            className={`h-2.5 w-2.5 rounded-full ${meta.dot} ${
              row.status === "training" || row.status === "inferring" ? "animate-pulse" : ""
            }`}
          />
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          {/* Row 1: expression + model + status */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-white/50">{row.truth_table_id}</span>
            <span className="truncate text-sm text-white/90">{row.expression_preview}</span>
            <span className="ml-auto shrink-0 text-xs text-white/60">{row.model}</span>
            <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${meta.border} ${meta.color}`}>
              {meta.label}
            </span>
          </div>

          {/* Row 2: epoch bar + sparkline + convergence streak */}
          <div className="mt-2 flex items-center gap-3">
            <div className="w-40 shrink-0">
              <EpochBar
                epochStates={row.epoch_states}
                threshold={row.convergence.asr_threshold}
                maxEpoch={row.max_epoch}
              />
              <p className="mt-0.5 text-[10px] text-white/40">
                {row.max_scored_epoch}/{row.max_epoch} scored
              </p>
            </div>
            <div className="shrink-0">
              <AsrSparkline
                scoredEpochs={row.scored_epochs}
                threshold={row.convergence.asr_threshold}
              />
            </div>
            {lastAsr !== null && (
              <span className="text-xs text-white/70">
                ASR: <span className={lastAsr >= row.convergence.asr_threshold ? "font-semibold text-emerald-300" : "text-amber-300"}>
                  {(lastAsr * 100).toFixed(1)}%
                </span>
              </span>
            )}
            {row.convergence.n_consec_required > 0 && (
              <span className="text-xs text-white/40" title="Consecutive epochs above threshold / required">
                streak {row.convergence.consec_streak}/{row.convergence.n_consec_required}
              </span>
            )}
            {/* Varying args inline */}
            {varyingArgKeys.map((key) => {
              const val = row.varying_args?.[key];
              if (val === null || val === undefined) return null;
              return (
                <span key={key} className="text-xs text-white/40">
                  {key}={formatConfigValue(val)}
                </span>
              );
            })}
            <button
              type="button"
              onClick={onToggle}
              className="ml-auto shrink-0 rounded border border-white/20 px-2 py-0.5 text-xs text-white/60 transition hover:border-white/40 hover:text-white"
            >
              {expanded ? "Less" : "More"}
            </button>
          </div>

          {/* Row 3: defense badges */}
          {row.defense_detail.length > 0 && (
            <div className="mt-1.5">
              <DefenseBadges detail={row.defense_detail} epoch={row.defense_epoch} />
            </div>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-white/10 p-3 text-xs">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <p className="mb-1 uppercase tracking-wide text-white/40">Paths</p>
              <p className="font-mono text-white/60">data: {row.paths.data_dir}</p>
              <p className="font-mono text-white/60">experiment: {row.paths.experiment_dir}</p>
              <p className="font-mono text-white/60">results: {row.paths.results_dir}</p>
            </div>
            <div>
              <p className="mb-1 uppercase tracking-wide text-white/40">Convergence</p>
              <p className="text-white/60">
                Threshold: {(row.convergence.asr_threshold * 100).toFixed(0)}% for {row.convergence.n_consec_required} consecutive
              </p>
              <p className="text-white/60">
                Current streak: {row.convergence.consec_streak}
              </p>
              {row.convergence.is_converged && row.convergence.info && (
                <p className="mt-1 font-semibold text-emerald-300">
                  Converged at epoch {String(row.convergence.info.epoch ?? row.convergence.info.converged_epoch ?? "?")}
                </p>
              )}
            </div>
            <div>
              <p className="mb-1 uppercase tracking-wide text-white/40">Config</p>
              <div className="grid gap-0.5">
                {Object.entries(row.key_config).map(([key, value]) => (
                  <p key={key} className="font-mono text-white/60">
                    {key}: {formatConfigValue(value)}
                  </p>
                ))}
              </div>
            </div>
          </div>
          {/* Per-epoch scores table */}
          {row.scored_epochs.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 uppercase tracking-wide text-white/40">Scores by epoch</p>
              <div className="flex flex-wrap gap-2">
                {row.scored_epochs.map((se) => (
                  <div
                    key={se.epoch}
                    className={`rounded border px-2 py-1 ${
                      se.asr_backdoor !== null && se.asr_backdoor >= row.convergence.asr_threshold
                        ? "border-emerald-500/30 bg-emerald-500/10"
                        : "border-white/10 bg-white/5"
                    }`}
                  >
                    <span className="text-white/50">ep{se.epoch}</span>{" "}
                    <span className="font-mono text-white/80">
                      {se.asr_backdoor !== null ? (se.asr_backdoor * 100).toFixed(1) + "%" : "\u2014"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Config group section ────────────────────────────────────────────────
function ConfigGroupSection({
  group,
  rows,
  varyingArgKeys,
  expandedCards,
  onToggleCard,
  collapsed,
  onToggleCollapse,
}: {
  group: ConfigGroup;
  rows: ProgressRow[];
  varyingArgKeys: string[];
  expandedCards: Record<string, boolean>;
  onToggleCard: (key: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const finished = (group.status_counts["converged"] ?? 0) + (group.status_counts["done"] ?? 0);
  return (
    <div className={`rounded-xl border ${
      group.is_active
        ? "border-amber-500/30 bg-amber-500/[0.03]"
        : group.is_complete
          ? "border-emerald-500/20 bg-emerald-500/[0.02]"
          : "border-white/10 bg-white/[0.01]"
    }`}>
      {/* Group header */}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="flex w-full items-center gap-3 p-3 text-left"
      >
        <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          group.is_complete ? "bg-emerald-400" : group.is_active ? "bg-amber-400 animate-pulse" : "bg-white/20"
        }`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white/90">{group.label}</span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${
              group.is_complete
                ? "border-emerald-500/30 text-emerald-300"
                : group.is_active
                  ? "border-amber-500/30 text-amber-300"
                  : "border-white/15 text-white/40"
            }`}>
              {group.is_complete ? "Complete" : group.is_active ? "Active" : "Queued"}
            </span>
            <span className="ml-auto text-xs text-white/50">
              {finished}/{group.total} done
              {group.defense_total > 0 && (
                <span className={group.defense_done === group.defense_total ? "text-emerald-400/70" : ""}>
                  {" "}· {group.defense_done}/{group.defense_total} defenses
                </span>
              )}
            </span>
            <span className="text-xs text-white/30">{collapsed ? "\u25B6" : "\u25BC"}</span>
          </div>
          {/* Mini progress bar */}
          <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-white/5">
            {finished > 0 && (
              <div className="bg-emerald-400" style={{ width: `${(finished / group.total) * 100}%` }} />
            )}
          </div>
        </div>
      </button>

      {/* Experiment cards */}
      {!collapsed && (
        <div className="space-y-2 px-3 pb-3">
          {rows.map((row) => {
            const rowKey = `${row.index}:${row.experiment_dir_name}`;
            return (
              <ExperimentCard
                key={rowKey}
                row={row}
                varyingArgKeys={varyingArgKeys}
                expanded={!!expandedCards[rowKey]}
                onToggle={() => onToggleCard(rowKey)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────
export default function ProgressTab({ userId }: ProgressTabProps) {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sweepConfigInput, setSweepConfigInput] = useState("");
  const [expressionsInput, setExpressionsInput] = useState("");
  const [appliedSettings, setAppliedSettings] = useState<SavedProgressSettings | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | ProgressStatus>("all");
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [expressionFilter, setExpressionFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Record<number, boolean>>({});
  const [showSettings, setShowSettings] = useState(false);
  const logSource = "BoolBackProgress";

  const fetchProgress = useCallback(
    async (settings: SavedProgressSettings | null, silent: boolean): Promise<ProgressResponse | null> => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), PROGRESS_REQUEST_TIMEOUT_MS);
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const params = new URLSearchParams();
        for (const path of settings?.sweep_config || []) {
          const value = path.trim();
          if (!value) continue;
          params.append("sweep_config", value);
        }
        for (const path of settings?.expressions_file || []) {
          const value = path.trim();
          if (!value) continue;
          params.append("expressions_file", value);
        }
        const suffix = params.toString();
        const response = await debugFetch(
          `/api/turing/boolback/progress${suffix ? `?${suffix}` : ""}`,
          {
            cache: "no-store",
            headers: userId ? { "x-user-id": userId } : undefined,
            signal: controller.signal,
          },
          { source: logSource, logResponseBody: false }
        );
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Failed to load progress");
        }
        const json = (await response.json()) as ProgressResponse;
        setData(json);
        logDebug("lifecycle", "Progress loaded", { rows: json.rows.length }, logSource);
        return json;
      } catch (errorValue) {
        const isAbortError = errorValue instanceof Error && errorValue.name === "AbortError";
        const message = isAbortError
          ? `Progress request timed out after ${Math.floor(PROGRESS_REQUEST_TIMEOUT_MS / 1000)}s`
          : errorValue instanceof Error
            ? errorValue.message
            : "Unknown error";
        setError(message);
        logDebug("error", "Progress load failed", { message }, logSource);
        return null;
      } finally {
        window.clearTimeout(timeoutId);
        if (silent) {
          setRefreshing(false);
        } else {
          setLoading(false);
        }
      }
    },
    [userId]
  );

  const loadSavedSettings = useCallback(async (): Promise<SavedProgressSettings | null> => {
    if (userId) {
      const saved = await fetchUserSetting<unknown>(userId, PROGRESS_STORAGE_KEY);
      return normalizeSavedSettings(saved);
    }
    try {
      const raw = localStorage.getItem(PROGRESS_STORAGE_KEY);
      if (!raw) return null;
      return normalizeSavedSettings(JSON.parse(raw));
    } catch {
      return null;
    }
  }, [userId]);

  const persistSettings = useCallback(
    async (settings: SavedProgressSettings) => {
      if (userId) {
        await saveUserSetting(userId, PROGRESS_STORAGE_KEY, settings);
        return;
      }
      localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(settings));
    },
    [userId]
  );

  useEffect(() => {
    let canceled = false;
    async function loadInitial() {
      const saved = await loadSavedSettings();
      if (canceled) return;
      let initial = saved;
      let response = await fetchProgress(initial, false);
      if (!response && initial) {
        initial = null;
        response = await fetchProgress(null, false);
      }
      if (canceled) return;
      if (!response) return;
      const effectiveSettings = initial ?? {
        sweep_config: response.defaults.sweep_config,
        expressions_file: response.defaults.expressions_file,
      };
      setAppliedSettings(effectiveSettings);
      setSweepConfigInput(pathLinesText(effectiveSettings.sweep_config));
      setExpressionsInput(pathLinesText(effectiveSettings.expressions_file));
    }
    void loadInitial();
    return () => {
      canceled = true;
    };
  }, [fetchProgress, loadSavedSettings]);

  useEffect(() => {
    if (!appliedSettings) return;
    const intervalId = window.setInterval(() => {
      void fetchProgress(appliedSettings, true);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(intervalId);
  }, [appliedSettings, fetchProgress]);

  const handleApply = useCallback(async () => {
    const nextSettings: SavedProgressSettings = {
      sweep_config: parsePathLines(sweepConfigInput),
      expressions_file: parsePathLines(expressionsInput),
    };
    setAppliedSettings(nextSettings);
    setExpanded({});
    setGroupFilter(null);
    await persistSettings(nextSettings);
    await fetchProgress(nextSettings, false);
  }, [expressionsInput, fetchProgress, persistSettings, sweepConfigInput]);

  const handleResetDefaults = useCallback(async () => {
    if (!data) return;
    const nextSettings: SavedProgressSettings = {
      sweep_config: data.defaults.sweep_config,
      expressions_file: data.defaults.expressions_file,
    };
    setSweepConfigInput(pathLinesText(nextSettings.sweep_config));
    setExpressionsInput(pathLinesText(nextSettings.expressions_file));
    setAppliedSettings(nextSettings);
    setExpanded({});
    setGroupFilter(null);
    await persistSettings(nextSettings);
    await fetchProgress(nextSettings, false);
  }, [data, fetchProgress, persistSettings]);

  const handleRefresh = useCallback(async () => {
    await fetchProgress(appliedSettings, true);
  }, [appliedSettings, fetchProgress]);

  // Derive unique models for filter dropdown
  const models = useMemo(() => {
    const set = new Set<string>();
    for (const row of data?.rows || []) set.add(row.model);
    return Array.from(set).sort();
  }, [data?.rows]);

  const filteredRows = useMemo(() => {
    const rows = data?.rows || [];
    const expressionNeedle = expressionFilter.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (modelFilter !== "all" && row.model !== modelFilter) return false;
      if (groupFilter !== null && row.config_group_index !== groupFilter) return false;
      if (expressionNeedle) {
        return (
          row.expression.toLowerCase().includes(expressionNeedle) ||
          row.truth_table_id.toLowerCase().includes(expressionNeedle) ||
          row.experiment_dir_name.toLowerCase().includes(expressionNeedle)
        );
      }
      return true;
    });
  }, [data?.rows, expressionFilter, statusFilter, modelFilter, groupFilter]);

  // Group filtered rows by config_group_index
  const groupedRows = useMemo(() => {
    const groups = data?.config_groups || [];
    const map = new Map<number, ProgressRow[]>();
    for (const row of filteredRows) {
      const list = map.get(row.config_group_index);
      if (list) {
        list.push(row);
      } else {
        map.set(row.config_group_index, [row]);
      }
    }
    // Return in group order
    const result: { group: ConfigGroup; rows: ProgressRow[] }[] = [];
    for (const g of groups) {
      const rows = map.get(g.index);
      if (rows && rows.length > 0) {
        result.push({ group: g, rows });
      }
    }
    return result;
  }, [filteredRows, data?.config_groups]);

  const summary = data?.summary;
  const configGroups = data?.config_groups || [];
  const hasMultipleGroups = configGroups.length > 1;

  return (
    <section className="space-y-4 px-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Experiment Progress</h2>
          <p className="text-xs text-white/50">
            Auto-refresh every 30s.{refreshing ? " Refreshing..." : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white"
          >
            {showSettings ? "Hide Settings" : "Settings"}
          </button>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={loading || refreshing}
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Loading..." : refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Collapsible settings panel */}
      {showSettings && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-white/80">Sweep config paths (one per line)</span>
              <textarea
                value={sweepConfigInput}
                onChange={(event) => setSweepConfigInput(event.target.value)}
                placeholder="Empty uses batch.py defaults"
                rows={3}
                className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-white/80">Expressions files (one per line)</span>
              <textarea
                value={expressionsInput}
                onChange={(event) => setExpressionsInput(event.target.value)}
                placeholder="Empty uses batch.py defaults"
                rows={3}
                className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
              />
            </label>
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={loading}
              className="rounded-full border border-emerald-500/50 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 transition hover:border-emerald-400 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={() => void handleResetDefaults()}
              disabled={loading}
              className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reset to Defaults
            </button>
          </div>
          {data && (
            <div className="mt-3 rounded border border-white/10 bg-white/5 p-2 text-xs text-white/50">
              <p>Sweeps: {data.resolved.sweep_config.join(", ")}</p>
              <p>Expressions: {data.resolved.expressions_file.join(", ")}</p>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      )}
      {loading && !data && !error && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4 text-sm text-white/70">
          Loading progress. First load can take a while for large sweeps.
        </div>
      )}
      {data && (
        <>
          {/* Active workers */}
          <ActiveWorkersPanel claims={data.active_claims} />
          {/* Summary */}
          {summary && <SummaryCards summary={summary} />}
          {summary && <SegmentedBar summary={summary} />}
          {/* Config group timeline */}
          {hasMultipleGroups && (
            <ConfigGroupTimeline
              groups={configGroups}
              activeGroupFilter={groupFilter}
              onGroupClick={setGroupFilter}
            />
          )}
          {/* Filters */}
          <div className="flex flex-wrap gap-2">
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as "all" | ProgressStatus)}
              className="rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
            >
              <option value="all" className="bg-slate-900">All Statuses</option>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s} className="bg-slate-900">
                  {STATUS_META[s].label}
                </option>
              ))}
            </select>
            {models.length > 1 && (
              <select
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                className="rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
              >
                <option value="all" className="bg-slate-900">All Models</option>
                {models.map((m) => (
                  <option key={m} value={m} className="bg-slate-900">{m}</option>
                ))}
              </select>
            )}
            {hasMultipleGroups && (
              <select
                value={groupFilter === null ? "all" : String(groupFilter)}
                onChange={(event) => setGroupFilter(event.target.value === "all" ? null : Number(event.target.value))}
                className="rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
              >
                <option value="all" className="bg-slate-900">All Groups</option>
                {configGroups.map((g) => (
                  <option key={g.index} value={g.index} className="bg-slate-900">
                    {g.label} ({g.is_complete ? "done" : g.is_active ? "active" : "queued"})
                  </option>
                ))}
              </select>
            )}
            <input
              type="text"
              value={expressionFilter}
              onChange={(event) => setExpressionFilter(event.target.value)}
              placeholder="Filter by expression or truth-table ID"
              className="min-w-[280px] flex-1 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
            />
          </div>
          <p className="text-xs text-white/50">
            Showing {filteredRows.length} of {data.rows.length} experiments
            {hasMultipleGroups && ` across ${groupedRows.length} group${groupedRows.length !== 1 ? "s" : ""}`}.
          </p>
          {/* Experiment cards grouped by config group */}
          {hasMultipleGroups ? (
            <div className="space-y-3">
              {groupedRows.map(({ group, rows }) => (
                <ConfigGroupSection
                  key={group.index}
                  group={group}
                  rows={rows}
                  varyingArgKeys={data.varying_arg_keys || []}
                  expandedCards={expanded}
                  onToggleCard={(key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
                  collapsed={!!collapsedGroups[group.index]}
                  onToggleCollapse={() => setCollapsedGroups((prev) => ({ ...prev, [group.index]: !prev[group.index] }))}
                />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredRows.map((row) => {
                const rowKey = `${row.index}:${row.experiment_dir_name}`;
                return (
                  <ExperimentCard
                    key={rowKey}
                    row={row}
                    varyingArgKeys={data.varying_arg_keys || []}
                    expanded={!!expanded[rowKey]}
                    onToggle={() =>
                      setExpanded((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }))
                    }
                  />
                );
              })}
            </div>
          )}
          {/* Epoch bar legend */}
          {data.rows.length > 0 && (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-xs text-white/50">
              <span className="font-medium text-white/70">Epoch bar:</span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded-sm bg-emerald-400" /> scored, above threshold
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded-sm bg-amber-400" /> scored, below threshold
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded-sm bg-sky-400/60" /> trained, unscored
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-3 rounded-sm bg-white/10" /> untrained
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
