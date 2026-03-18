"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { debugFetch, logDebug } from "../lib/debug";

type ExperimentCounts = { tp: number; fp: number; fn: number; tn: number };

type ExperimentSummary = {
  name: string;
  expression: string;
  base_model: string;
  trigger_word_set: string;
  insertion_method: string;
  poison_ratio: number | null;
  samples_per_variant: number | null;
  compliance_prefixes: string;
  poison_balance: string;
  shared_samples: boolean;
  cover_strategy: string | null;
  num_poisoned: number | null;
  epochs: number[];
  max_epoch: number;
  counts: ExperimentCounts;
};

type ExperimentsResponse = {
  experiments: ExperimentSummary[];
  experiments_dir: string;
};

type ReviewSample = {
  variant: string;
  should_activate: boolean;
  input: string;
  output: string;
  matched_keywords: string[];
};

type ReviewCategory = "tp" | "fp" | "fn" | "tn";

type ExperimentReviewResponse = {
  name: string;
  epoch: number;
  expression: string;
  category: ReviewCategory;
  counts: ExperimentCounts;
  samples: ReviewSample[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type ReviewAllSample = ReviewSample & {
  experiment_name: string;
  category: ReviewCategory;
};

type ReviewAllResponse = {
  epoch: number;
  category: ReviewCategory;
  counts: ExperimentCounts;
  num_experiments: number;
  samples: ReviewAllSample[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type FilterKey =
  | "expression"
  | "base_model"
  | "trigger_word_set"
  | "insertion_method"
  | "poison_ratio"
  | "samples_per_variant"
  | "compliance_prefixes"
  | "poison_balance"
  | "shared_samples"
  | "cover_strategy";

type Filters = Record<FilterKey, string>;

type FilterDef = {
  key: FilterKey;
  label: string;
  getter: (e: ExperimentSummary) => string;
  display?: (value: string) => string;
};

type ExperimentReviewTabProps = {
  userId?: string;
};

function shortModelName(m: string): string {
  return m.includes("/") ? m.split("/").pop()! : m;
}

const FILTER_DEFS: FilterDef[] = [
  { key: "expression", label: "Expression", getter: (e) => e.expression },
  { key: "base_model", label: "Model", getter: (e) => e.base_model, display: (v) => shortModelName(v) },
  { key: "trigger_word_set", label: "Triggers", getter: (e) => e.trigger_word_set },
  { key: "insertion_method", label: "Insertion", getter: (e) => e.insertion_method },
  { key: "poison_ratio", label: "Poison ratio", getter: (e) => formatMaybeNumber(e.poison_ratio) },
  { key: "samples_per_variant", label: "SPV", getter: (e) => formatMaybeNumber(e.samples_per_variant) },
  { key: "compliance_prefixes", label: "Compliance", getter: (e) => e.compliance_prefixes },
  { key: "poison_balance", label: "Balance", getter: (e) => e.poison_balance },
  { key: "shared_samples", label: "Shared samples", getter: (e) => String(e.shared_samples) },
  { key: "cover_strategy", label: "Cover strategy", getter: (e) => e.cover_strategy || "" },
];

const CARD_TAG_KEYS = new Set<FilterKey>([
  "trigger_word_set",
  "insertion_method",
  "poison_ratio",
  "samples_per_variant",
  "compliance_prefixes",
  "poison_balance",
  "shared_samples",
  "cover_strategy",
]);

const EMPTY_FILTERS: Filters = {
  expression: "",
  base_model: "",
  trigger_word_set: "",
  insertion_method: "",
  poison_ratio: "",
  samples_per_variant: "",
  compliance_prefixes: "",
  poison_balance: "",
  shared_samples: "",
  cover_strategy: "",
};

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const v = value.trim();
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    output.push(v);
  }
  output.sort((a, b) => a.localeCompare(b));
  return output;
}

function formatMaybeNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (Number.isFinite(value)) return String(value);
  return "";
}

function truncatePreview(text: string, maxChars: number) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 3))}...`;
}

function renderHighlightedText(text: string, keywords: string[]) {
  if (!text) return text;
  if (!keywords.length) return text;
  const tl = text.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const kw of keywords) {
    const needle = kw.toLowerCase();
    if (!needle) continue;
    let idx = 0;
    while (idx < tl.length) {
      const found = tl.indexOf(needle, idx);
      if (found === -1) break;
      ranges.push({ start: found, end: found + needle.length });
      idx = found + Math.max(1, needle.length);
    }
  }
  if (!ranges.length) return text;
  ranges.sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start));
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    const prev = merged[merged.length - 1];
    if (!prev || range.start > prev.end) {
      merged.push({ start: range.start, end: range.end });
      continue;
    }
    prev.end = Math.max(prev.end, range.end);
  }
  const parts: Array<ReactNode> = [];
  let cursor = 0;
  for (const range of merged) {
    if (cursor < range.start) {
      parts.push(text.slice(cursor, range.start));
    }
    parts.push(
      <span key={`${range.start}-${range.end}`} className="rounded bg-yellow-500/20 px-1 text-yellow-100">
        {text.slice(range.start, range.end)}
      </span>
    );
    cursor = range.end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return <>{parts}</>;
}

function CountsRow({ counts }: { counts: ExperimentCounts }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full border border-green-500/30 bg-green-500/10 px-2 py-1 text-green-200">
        TP {counts.tp}
      </span>
      <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-200">
        FP {counts.fp}
      </span>
      <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-1 text-orange-200">
        FN {counts.fn}
      </span>
      <span className="rounded-full border border-white/20 bg-white/5 px-2 py-1 text-white/70">
        TN {counts.tn}
      </span>
    </div>
  );
}

function SampleCard({
  sample,
  categoryLabel,
  experimentName,
  cardKey,
}: {
  sample: ReviewSample;
  categoryLabel: string;
  experimentName?: string;
  cardKey: string;
}) {
  const promptPreview = truncatePreview(sample.input, 100);
  const outputPreview = truncatePreview(sample.output, 100);
  return (
    <details key={cardKey} className="rounded border border-white/10 bg-white/[0.02] px-3 py-2">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/20 px-2 py-1 text-white/70">
              {sample.variant}
            </span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/70">
              {categoryLabel}
            </span>
            {experimentName && (
              <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-1 text-white/60">
                {experimentName}
              </span>
            )}
            {sample.matched_keywords.length > 0 && (
              <span className="text-white/50">
                {sample.matched_keywords.length} keyword
                {sample.matched_keywords.length === 1 ? "" : "s"}
              </span>
            )}
          </div>
          <div className="mt-1 w-full space-y-1 text-xs">
            <div>
              <span className="text-white/50">Prompt: </span>
              <span className="text-white/70">{promptPreview}</span>
            </div>
            <div>
              <span className="text-white/50">Output: </span>
              <span className="text-white/70">{outputPreview}</span>
            </div>
          </div>
        </div>
      </summary>
      <div
        className="mt-3 space-y-3 cursor-pointer"
        onClick={(event) => {
          const selected = typeof window !== "undefined" ? window.getSelection()?.toString() : "";
          if (selected) return;
          const details = event.currentTarget.closest("details") as HTMLDetailsElement | null;
          if (details?.open) details.open = false;
        }}
      >
        <div>
          <div className="text-xs uppercase tracking-wide text-white/50">Prompt</div>
          <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{sample.input}</pre>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-white/50">Output</div>
          <pre className="whitespace-pre-wrap break-words text-sm text-white/85">
            {renderHighlightedText(sample.output, sample.matched_keywords)}
          </pre>
        </div>
        {sample.matched_keywords.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {sample.matched_keywords.map((kw) => (
              <span
                key={kw}
                className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-100"
              >
                {kw}
              </span>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
      <button
        type="button"
        onClick={onPrev}
        disabled={page <= 1}
        className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
      >
        Previous
      </button>
      <span className="text-white/60">
        Page {page} / {totalPages} ({total} total)
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= totalPages}
        className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
      >
        Next
      </button>
    </div>
  );
}

export default function ExperimentReviewTab({ userId }: ExperimentReviewTabProps) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [experimentsDir, setExperimentsDir] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS });
  const [selectedExperiment, setSelectedExperiment] = useState<ExperimentSummary | null>(null);
  const [selectedEpoch, setSelectedEpoch] = useState<number | null>(null);
  const [reviewData, setReviewData] = useState<ExperimentReviewResponse | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<ReviewCategory>("tp");
  const [singlePage, setSinglePage] = useState(1);
  const [allSelected, setAllSelected] = useState(false);
  const [allEpoch, setAllEpoch] = useState<number | null>(null);
  const [allCategory, setAllCategory] = useState<ReviewCategory>("tp");
  const [allPage, setAllPage] = useState(1);
  const [allData, setAllData] = useState<ReviewAllResponse | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);
  const logSource = "BoolBackExperimentReview";

  const fetchBoolback = useCallback(
    async (path: string) => {
      return debugFetch(
        `/api/turing/boolback${path}`,
        {
          headers: userId ? { "x-user-id": userId } : undefined,
          cache: "no-store",
        },
        { source: logSource, logResponseBody: false }
      );
    },
    [userId]
  );

  const loadExperiments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBoolback("/experiments");
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to load experiments");
      }
      const json = (await res.json()) as ExperimentsResponse;
      setExperiments(Array.isArray(json.experiments) ? json.experiments : []);
      setExperimentsDir(typeof json.experiments_dir === "string" ? json.experiments_dir : "");
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setError(message);
      logDebug("error", "Experiment list load failed", { message }, logSource);
    } finally {
      setLoading(false);
    }
  }, [fetchBoolback]);

  const loadReview = useCallback(
    async (experimentName: string, epoch: number, category: ReviewCategory, page: number) => {
      setError(null);
      setReviewData(null);
      setLoadingAll(false);
      setAllData(null);
      try {
        const params = new URLSearchParams();
        params.set("epoch", String(epoch));
        params.set("category", category);
        params.set("page", String(page));
        params.set("limit", "20");
        const res = await fetchBoolback(
          `/experiments/${encodeURIComponent(experimentName)}/review?${params.toString()}`
        );
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to load experiment review");
        }
        const json = (await res.json()) as ExperimentReviewResponse;
        setReviewData(json);
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
        setError(message);
        logDebug("error", "Experiment review load failed", { message }, logSource);
      }
    },
    [fetchBoolback]
  );

  const loadAllReview = useCallback(
    async (epoch: number, category: ReviewCategory, page: number) => {
      setError(null);
      setLoadingAll(true);
      setAllData(null);
      try {
        const params = new URLSearchParams();
        params.set("epoch", String(epoch));
        params.set("category", category);
        params.set("page", String(page));
        params.set("limit", "20");
        for (const def of FILTER_DEFS) {
          const val = filters[def.key];
          if (val) params.set(def.key, val);
        }
        const res = await fetchBoolback(`/experiments/review-all?${params.toString()}`);
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to load all-experiments review");
        }
        const json = (await res.json()) as ReviewAllResponse;
        setAllData(json);
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
        setError(message);
        logDebug("error", "All experiments review load failed", { message }, logSource);
      } finally {
        setLoadingAll(false);
      }
    },
    [fetchBoolback, filters]
  );

  useEffect(() => {
    void loadExperiments();
  }, [loadExperiments]);

  const filterOptions = useMemo(() => {
    const opts: Record<FilterKey, string[]> = { ...EMPTY_FILTERS } as unknown as Record<FilterKey, string[]>;
    for (const def of FILTER_DEFS) {
      opts[def.key] = uniqueValues(experiments.map(def.getter));
    }
    return opts;
  }, [experiments]);

  const visibleFilters = useMemo(() => {
    return FILTER_DEFS.filter((def) => filterOptions[def.key].length >= 2);
  }, [filterOptions]);

  const varyingTagKeys = useMemo(() => {
    const keys = new Set<FilterKey>();
    for (const def of FILTER_DEFS) {
      if (CARD_TAG_KEYS.has(def.key) && filterOptions[def.key].length >= 2) {
        keys.add(def.key);
      }
    }
    return keys;
  }, [filterOptions]);

  const filteredExperiments = useMemo(() => {
    const active = Object.entries(filters).filter(([, value]) => value.trim().length > 0) as Array<
      [FilterKey, string]
    >;
    if (!active.length) return experiments;
    return experiments.filter((exp) => {
      for (const [key, value] of active) {
        const def = FILTER_DEFS.find((d) => d.key === key);
        if (!def) continue;
        if (def.getter(exp) !== value) return false;
      }
      return true;
    });
  }, [experiments, filters]);

  const allEpochOptions = useMemo(() => {
    const counts = new Map<number, number>();
    for (const exp of filteredExperiments) {
      for (const epoch of exp.epochs || []) {
        counts.set(epoch, (counts.get(epoch) ?? 0) + 1);
      }
    }
    const entries = Array.from(counts.entries()).map(([epoch, count]) => ({ epoch, count }));
    entries.sort((a, b) => (b.count === a.count ? b.epoch - a.epoch : b.count - a.count));
    return entries;
  }, [filteredExperiments]);

  useEffect(() => {
    if (!allSelected) return;
    const validEpochs = new Set(allEpochOptions.map((e) => e.epoch));
    if (allEpoch !== null && validEpochs.has(allEpoch)) return;
    const defaultEpoch = allEpochOptions[0]?.epoch ?? null;
    setAllEpoch(defaultEpoch);
    setAllPage(1);
  }, [allEpoch, allEpochOptions, allSelected]);

  useEffect(() => {
    if (!allSelected) return;
    if (allEpoch === null) return;
    void loadAllReview(allEpoch, allCategory, allPage);
  }, [allCategory, allEpoch, allPage, allSelected, loadAllReview]);

  const selectExperiment = useCallback(
    (exp: ExperimentSummary) => {
      setAllSelected(false);
      setAllEpoch(null);
      setAllPage(1);
      setAllData(null);
      setSelectedExperiment(exp);
      setSelectedEpoch(exp.max_epoch);
      setSelectedCategory("tp");
      setSinglePage(1);
      void loadReview(exp.name, exp.max_epoch, "tp", 1);
      logDebug("action", "Experiment selected", { name: exp.name, epoch: exp.max_epoch }, logSource);
    },
    [loadReview]
  );

  const hasActiveFilters = Object.values(filters).some((v) => v.trim().length > 0);

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Experiment Review</h2>
          {experimentsDir && <p className="text-xs text-white/60 break-all">{experimentsDir}</p>}
        </div>
        <button
          type="button"
          onClick={() => {
            logDebug("action", "Experiment review refresh clicked", undefined, logSource);
            void loadExperiments();
          }}
          disabled={loading}
          className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:opacity-60"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {visibleFilters.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {visibleFilters.map((def) => (
            <select
              key={def.key}
              value={filters[def.key]}
              onChange={(event) => setFilters((prev) => ({ ...prev, [def.key]: event.target.value }))}
              className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
            >
              <option value="">{def.label}</option>
              {filterOptions[def.key].map((value) => (
                <option key={value} value={value}>
                  {def.display ? def.display(value) : value}
                </option>
              ))}
            </select>
          ))}
          {hasActiveFilters && (
            <button
              type="button"
              onClick={() => setFilters({ ...EMPTY_FILTERS })}
              className="rounded border border-white/20 px-3 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <div className="min-h-0 rounded border border-white/10 flex flex-col">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-sm">
            <span className="text-white/70">
              Experiments ({filteredExperiments.length}/{experiments.length})
            </span>
            {(selectedExperiment || allSelected) && (
              <button
                type="button"
                onClick={() => {
                  setSelectedExperiment(null);
                  setSelectedEpoch(null);
                  setReviewData(null);
                  setSelectedCategory("tp");
                  setSinglePage(1);
                  setAllSelected(false);
                  setAllEpoch(null);
                  setAllPage(1);
                  setAllData(null);
                }}
                className="text-white/60 transition hover:text-white"
              >
                Deselect
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            {filteredExperiments.length === 0 ? (
              <div className="rounded border border-white/10 p-3 text-sm text-white/60">
                No experiments match these filters.
              </div>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedExperiment(null);
                    setSelectedEpoch(null);
                    setReviewData(null);
                    setAllSelected(true);
                    setAllCategory("tp");
                    setAllPage(1);
                    setAllData(null);
                    logDebug("action", "All experiments selected", undefined, logSource);
                  }}
                  className={`w-full rounded border p-3 text-left transition ${
                    allSelected
                      ? "border-white/40 bg-white/10"
                      : "border-white/10 bg-white/[0.02] hover:border-white/20"
                  }`}
                >
                  <div className="mb-2 flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-white">All Experiments</div>
                      <div className="mt-1 text-xs text-white/50">Combined view (paginated)</div>
                    </div>
                    <div className="text-xs text-white/50">{filteredExperiments.length}</div>
                  </div>
                </button>
                {filteredExperiments.map((exp) => (
                  <button
                    key={exp.name}
                    type="button"
                    onClick={() => selectExperiment(exp)}
                    className={`w-full rounded border p-3 text-left transition ${
                      selectedExperiment?.name === exp.name
                        ? "border-white/40 bg-white/10"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-white">{exp.expression || exp.name}</div>
                        <div className="mt-1 text-xs text-white/50">{shortModelName(exp.base_model)}</div>
                      </div>
                      <div className="text-xs text-white/50">ep {exp.max_epoch}</div>
                    </div>
                    <CountsRow counts={exp.counts} />
                    {varyingTagKeys.size > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-white/50">
                        {FILTER_DEFS.filter((d) => varyingTagKeys.has(d.key)).map((def) => {
                          const val = def.getter(exp);
                          if (!val) return null;
                          const displayVal = def.display ? def.display(val) : val;
                          return (
                            <span
                              key={def.key}
                              className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5"
                            >
                              {def.label.toLowerCase()} {displayVal}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="rounded border border-white/10 p-3">
          {allSelected ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">All Experiments</div>
                  <div className="text-xs text-white/50">
                    {allData ? `${allData.num_experiments} experiments` : `${filteredExperiments.length} experiments`}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={allEpoch ?? ""}
                    onChange={(event) => {
                      const epoch = Number(event.target.value);
                      setAllEpoch(Number.isFinite(epoch) ? epoch : null);
                      setAllPage(1);
                    }}
                    className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
                  >
                    {allEpochOptions.map((item) => (
                      <option key={item.epoch} value={item.epoch}>
                        Epoch {item.epoch} ({item.count})
                      </option>
                    ))}
                  </select>
                  <CountsRow counts={allData?.counts ?? { tp: 0, fp: 0, fn: 0, tn: 0 }} />
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                {(["tp", "fp", "fn", "tn"] as const).map((category) => (
                  <button
                    key={category}
                    type="button"
                    onClick={() => {
                      setAllCategory(category);
                      setAllPage(1);
                    }}
                    className={`rounded-full border px-3 py-1 transition ${
                      allCategory === category
                        ? "border-white/30 bg-white/10 text-white"
                        : "border-white/10 text-white/50"
                    }`}
                  >
                    {category.toUpperCase()}
                    {allData ? ` ${allData.counts[category]}` : ""}
                  </button>
                ))}
              </div>

              {loadingAll || !allData ? (
                <div className="rounded border border-white/10 p-4 text-sm text-white/60">
                  {loadingAll ? "Loading review..." : "Select an epoch to review samples."}
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {allData.samples.map((sample, index) => (
                      <SampleCard
                        key={`${sample.experiment_name}-${sample.variant}-${index}`}
                        sample={sample}
                        categoryLabel={sample.category.toUpperCase()}
                        experimentName={sample.experiment_name}
                        cardKey={`${sample.experiment_name}-${sample.variant}-${index}`}
                      />
                    ))}
                  </div>
                  <Pagination
                    page={allData.page}
                    totalPages={allData.totalPages}
                    total={allData.total}
                    onPrev={() => setAllPage((v) => Math.max(1, v - 1))}
                    onNext={() => setAllPage((v) => v + 1)}
                  />
                </>
              )}
            </div>
          ) : !selectedExperiment ? (
            <div className="rounded border border-white/10 p-4 text-sm text-white/60">
              Select an experiment to review samples.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold">{selectedExperiment.expression}</div>
                  <div className="text-xs text-white/50">{selectedExperiment.base_model}</div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={selectedEpoch ?? selectedExperiment.max_epoch}
                    onChange={(event) => {
                      const epoch = Number(event.target.value);
                      setSelectedEpoch(epoch);
                      setSinglePage(1);
                      void loadReview(selectedExperiment.name, epoch, selectedCategory, 1);
                    }}
                    className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
                  >
                    {selectedExperiment.epochs.map((epoch) => (
                      <option key={epoch} value={epoch}>
                        Epoch {epoch}
                      </option>
                    ))}
                  </select>
                  <CountsRow counts={reviewData?.counts ?? selectedExperiment.counts} />
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs">
                {(["tp", "fp", "fn", "tn"] as const).map((category) => {
                  const label = category.toUpperCase();
                  const count = reviewData ? reviewData.counts[category] : null;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => {
                        setSelectedCategory(category);
                        setSinglePage(1);
                        if (selectedEpoch !== null) {
                          void loadReview(selectedExperiment.name, selectedEpoch, category, 1);
                        }
                      }}
                      className={`rounded-full border px-3 py-1 transition ${
                        selectedCategory === category
                          ? "border-white/30 bg-white/10 text-white"
                          : "border-white/10 text-white/50"
                      }`}
                    >
                      {label}
                      {count !== null ? ` ${count}` : ""}
                    </button>
                  );
                })}
              </div>

              {!reviewData ? (
                <div className="rounded border border-white/10 p-4 text-sm text-white/60">Loading review...</div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-white/70">{selectedCategory.toUpperCase()}</span>
                    <span className="text-white/50">{reviewData.total}</span>
                  </div>
                  <div className="space-y-2">
                    {reviewData.samples.map((sample, index) => (
                      <SampleCard
                        key={`${selectedCategory}-${sample.variant}-${index}`}
                        sample={sample}
                        categoryLabel={selectedCategory.toUpperCase()}
                        cardKey={`${selectedCategory}-${sample.variant}-${index}`}
                      />
                    ))}
                  </div>
                  <Pagination
                    page={reviewData.page}
                    totalPages={reviewData.totalPages}
                    total={reviewData.total}
                    onPrev={() => {
                      const nextPage = Math.max(1, singlePage - 1);
                      if (nextPage === singlePage || selectedEpoch === null) return;
                      setSinglePage(nextPage);
                      void loadReview(selectedExperiment.name, selectedEpoch, selectedCategory, nextPage);
                    }}
                    onNext={() => {
                      const nextPage = Math.min(reviewData.totalPages, singlePage + 1);
                      if (nextPage === singlePage || selectedEpoch === null) return;
                      setSinglePage(nextPage);
                      void loadReview(selectedExperiment.name, selectedEpoch, selectedCategory, nextPage);
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
