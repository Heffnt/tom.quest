"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import { fetchUserSetting, saveUserSetting } from "../lib/userSettings";
import type { ProgressResponse, ProgressRow, ProgressStatus } from "./types";

type ProgressTabProps = {
  userId?: string;
};

type SavedProgressSettings = {
  sweep_config: string;
  expressions_file: string[];
};

const PROGRESS_STORAGE_KEY = "boolback_progress_settings";
const AUTO_REFRESH_MS = 30000;

function parseExpressionPaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function expressionPathsText(paths: string[]): string {
  return paths.join("\n");
}

function normalizeSavedSettings(value: unknown): SavedProgressSettings | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const sweep = typeof obj.sweep_config === "string" ? obj.sweep_config : "";
  const expressions = Array.isArray(obj.expressions_file)
    ? obj.expressions_file.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
  return { sweep_config: sweep, expressions_file: expressions };
}

function statusBadgeClass(status: ProgressStatus): string {
  if (status === "completed") {
    return "border-green-500/40 bg-green-500/10 text-green-200";
  }
  if (status === "in_progress") {
    return "border-sky-500/40 bg-sky-500/10 text-sky-200";
  }
  if (status === "blocked") {
    return "border-red-500/40 bg-red-500/10 text-red-200";
  }
  return "border-white/20 bg-white/5 text-white/70";
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

function lockLabel(row: ProgressRow): string {
  if (!row.lock.exists) return "No lock";
  if (row.lock.status === "active") return row.lock.reason || "Active lock";
  if (row.lock.status === "blocked") return row.lock.reason || "Blocked lock";
  if (row.lock.status === "stale") return row.lock.reason || "Stale lock";
  return "Unknown lock status";
}

export default function ProgressTab({ userId }: ProgressTabProps) {
  const [data, setData] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sweepConfigInput, setSweepConfigInput] = useState("");
  const [expressionsInput, setExpressionsInput] = useState("");
  const [appliedSettings, setAppliedSettings] = useState<SavedProgressSettings | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | ProgressStatus>("all");
  const [expressionFilter, setExpressionFilter] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const logSource = "BoolBackProgress";

  const fetchProgress = useCallback(
    async (settings: SavedProgressSettings | null, silent: boolean): Promise<ProgressResponse | null> => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const params = new URLSearchParams();
        const sweep = settings?.sweep_config?.trim() || "";
        if (sweep) {
          params.set("sweep_config", sweep);
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
        const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
        setError(message);
        logDebug("error", "Progress load failed", { message }, logSource);
        return null;
      } finally {
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
      setSweepConfigInput(effectiveSettings.sweep_config);
      setExpressionsInput(expressionPathsText(effectiveSettings.expressions_file));
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
      sweep_config: sweepConfigInput.trim(),
      expressions_file: parseExpressionPaths(expressionsInput),
    };
    setAppliedSettings(nextSettings);
    setExpanded({});
    await persistSettings(nextSettings);
    await fetchProgress(nextSettings, false);
  }, [expressionsInput, fetchProgress, persistSettings, sweepConfigInput]);

  const handleResetDefaults = useCallback(async () => {
    if (!data) return;
    const nextSettings: SavedProgressSettings = {
      sweep_config: data.defaults.sweep_config,
      expressions_file: data.defaults.expressions_file,
    };
    setSweepConfigInput(nextSettings.sweep_config);
    setExpressionsInput(expressionPathsText(nextSettings.expressions_file));
    setAppliedSettings(nextSettings);
    setExpanded({});
    await persistSettings(nextSettings);
    await fetchProgress(nextSettings, false);
  }, [data, fetchProgress, persistSettings]);

  const handleRefresh = useCallback(async () => {
    await fetchProgress(appliedSettings, false);
  }, [appliedSettings, fetchProgress]);

  const filteredRows = useMemo(() => {
    const rows = data?.rows || [];
    const expressionNeedle = expressionFilter.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== "all" && row.status !== statusFilter) {
        return false;
      }
      if (!expressionNeedle) {
        return true;
      }
      return (
        row.expression.toLowerCase().includes(expressionNeedle) ||
        row.truth_table_id.toLowerCase().includes(expressionNeedle) ||
        row.experiment_dir_name.toLowerCase().includes(expressionNeedle)
      );
    });
  }, [data?.rows, expressionFilter, statusFilter]);
  const varyingArgKeys = data?.varying_arg_keys || [];

  const summary = data?.summary;

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Progress</h2>
          <p className="text-xs text-white/60">
            Auto-refresh every 30s. Read-only status from sweep planning + output artifacts.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void handleRefresh();
            }}
            disabled={loading || refreshing}
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {refreshing ? "Refreshing..." : loading ? "Loading..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleResetDefaults();
            }}
            disabled={loading}
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reset to Defaults
          </button>
          <button
            type="button"
            onClick={() => {
              void handleApply();
            }}
            disabled={loading}
            className="rounded-full border border-emerald-500/50 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-100 transition hover:border-emerald-400 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Apply
          </button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-white/80">Sweep config path</span>
          <input
            type="text"
            value={sweepConfigInput}
            onChange={(event) => setSweepConfigInput(event.target.value)}
            placeholder="Empty uses batch.py default"
            className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-white/80">Expressions files (one per line)</span>
          <textarea
            value={expressionsInput}
            onChange={(event) => setExpressionsInput(event.target.value)}
            placeholder="Empty uses batch.py defaults"
            rows={4}
            className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
          />
        </label>
      </div>

      {data && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-white/70">
          <p>Resolved sweep: {data.resolved.sweep_config}</p>
          <p>Resolved expressions: {data.resolved.expressions_file.join(", ")}</p>
        </div>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <p className="text-xs text-white/60">Total</p>
          <p className="text-lg font-semibold">{summary?.total ?? 0}</p>
        </div>
        <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-3">
          <p className="text-xs text-green-200/80">Completed</p>
          <p className="text-lg font-semibold text-green-100">{summary?.completed ?? 0}</p>
        </div>
        <div className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-3">
          <p className="text-xs text-sky-200/80">In Progress</p>
          <p className="text-lg font-semibold text-sky-100">{summary?.in_progress ?? 0}</p>
        </div>
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <p className="text-xs text-red-200/80">Blocked</p>
          <p className="text-lg font-semibold text-red-100">{summary?.blocked ?? 0}</p>
        </div>
        <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <p className="text-xs text-white/60">Pending</p>
          <p className="text-lg font-semibold">{summary?.pending ?? 0}</p>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-white/10 bg-white/5 p-3">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-white/70">Overall completion</span>
          <span className="font-semibold">{formatPercent(summary?.percent_complete ?? 0)}%</span>
        </div>
        <div className="h-2 rounded-full bg-white/10">
          <div
            className="h-2 rounded-full bg-green-400 transition-all"
            style={{ width: `${Math.max(0, Math.min(100, summary?.percent_complete ?? 0))}%` }}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as "all" | ProgressStatus)}
          className="rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
        >
          <option value="all" className="bg-slate-900">
            All Statuses
          </option>
          <option value="completed" className="bg-slate-900">
            Completed
          </option>
          <option value="in_progress" className="bg-slate-900">
            In Progress
          </option>
          <option value="blocked" className="bg-slate-900">
            Blocked
          </option>
          <option value="pending" className="bg-slate-900">
            Pending
          </option>
        </select>
        <input
          type="text"
          value={expressionFilter}
          onChange={(event) => setExpressionFilter(event.target.value)}
          placeholder="Filter by expression or truth-table ID"
          className="min-w-[280px] flex-1 rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white outline-none transition focus:border-white/40"
        />
      </div>

      <p className="mt-2 text-xs text-white/60">
        Showing {filteredRows.length} of {data?.rows.length ?? 0} experiments.
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
        <table className="min-w-full divide-y divide-white/10 text-sm">
          <thead className="bg-white/5">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-white/70">Status</th>
              <th className="px-3 py-2 text-left font-medium text-white/70">TT ID</th>
              <th className="px-3 py-2 text-left font-medium text-white/70">Expression</th>
              <th className="px-3 py-2 text-left font-medium text-white/70">Model</th>
              <th className="px-3 py-2 text-left font-medium text-white/70">Checkpoints</th>
              <th className="px-3 py-2 text-left font-medium text-white/70">Defense</th>
              <th className="px-3 py-2 text-left font-medium text-white/70">Experiment Dir</th>
              {varyingArgKeys.map((key) => (
                <th key={key} className="px-3 py-2 text-left font-medium text-white/70">
                  {key}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium text-white/70">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/10">
            {filteredRows.map((row) => {
              const rowKey = `${row.index}:${row.experiment_dir_name}`;
              const isExpanded = !!expanded[rowKey];
              return (
                <tr key={rowKey} className={isExpanded ? "bg-white/[0.03]" : ""}>
                  <td className="px-3 py-2 align-top">
                    <span className={`rounded-full border px-2 py-1 text-xs ${statusBadgeClass(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-white/80">{row.truth_table_id}</td>
                  <td className="px-3 py-2 align-top text-white/90">{row.expression_preview}</td>
                  <td className="px-3 py-2 align-top text-white/80">{row.model}</td>
                  <td className="px-3 py-2 align-top text-white/80">
                    {row.checkpoint_progress.completed}/{row.checkpoint_progress.total}
                  </td>
                  <td className="px-3 py-2 align-top text-white/80">
                    {row.defense_progress.completed}/{row.defense_progress.total}
                  </td>
                  <td className="px-3 py-2 align-top font-mono text-xs text-white/70">{row.experiment_dir_name}</td>
                  {varyingArgKeys.map((key) => (
                    <td key={key} className="px-3 py-2 align-top text-white/80">
                      {formatConfigValue(row.varying_args?.[key])}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right align-top">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((prev) => ({
                          ...prev,
                          [rowKey]: !prev[rowKey],
                        }))
                      }
                      className="rounded border border-white/20 px-2 py-1 text-xs text-white/80 transition hover:border-white/40 hover:text-white"
                    >
                      {isExpanded ? "Hide" : "Show"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {filteredRows.map((row) => {
        const rowKey = `${row.index}:${row.experiment_dir_name}`;
        if (!expanded[rowKey]) return null;
        return (
          <div key={`${rowKey}-details`} className="mt-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 text-sm">
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/50">Full expression</p>
                <p className="mt-1 font-mono text-xs text-white/90">{row.expression}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-white/50">Lock</p>
                <p className="mt-1 text-white/80">{lockLabel(row)}</p>
                <p className="text-xs text-white/60">
                  Host: {row.lock.hostname || "-"} | PID: {row.lock.pid ?? "-"}
                </p>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/50">Paths</p>
                <p className="mt-1 font-mono text-xs text-white/70">data: {row.paths.data_dir}</p>
                <p className="font-mono text-xs text-white/70">experiment: {row.paths.experiment_dir}</p>
                <p className="font-mono text-xs text-white/70">results: {row.paths.results_dir}</p>
                <p className="font-mono text-xs text-white/70">lock: {row.paths.lock_path}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-white/50">Key config</p>
                <div className="mt-1 grid gap-1">
                  {Object.entries(row.key_config).map(([key, value]) => (
                    <p key={key} className="font-mono text-xs text-white/70">
                      {key}: {formatConfigValue(value)}
                    </p>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-3">
              <p className="text-xs uppercase tracking-wide text-white/50">Missing artifacts</p>
              {row.missing_artifacts.length === 0 ? (
                <p className="mt-1 text-xs text-white/60">None</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {row.missing_artifacts.map((path) => (
                    <li key={path} className="font-mono text-xs text-white/70">
                      {path}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
