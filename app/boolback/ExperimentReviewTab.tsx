"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { debugFetch, logDebug } from "../lib/debug";

type ExperimentCounts = { tp: number; fp: number; fn: number; tn: number };

type ExperimentSummary = {
  name: string;
  expression: string;
  model: string;
  base_model: string;
  trigger_word_set: string;
  insertion_method: string;
  num_poisoned: number | null;
  poison_ratio: number | null;
  lora_r: number | null;
  lora_alpha: number | null;
  refusal_detection: "keyword";
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
  counts: ExperimentCounts;
  samples: {
    tp: ReviewSample[];
    fp: ReviewSample[];
    fn: ReviewSample[];
    tn: ReviewSample[];
  };
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
  | "model"
  | "trigger_word_set"
  | "insertion_method"
  | "poison_ratio"
  | "lora_r"
  | "lora_alpha";

type Filters = Record<FilterKey, string>;

type ExperimentReviewTabProps = {
  userId?: string;
};

const SINGLE_PAGE_LIMIT = 20;

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

export default function ExperimentReviewTab({ userId }: ExperimentReviewTabProps) {
  const [experiments, setExperiments] = useState<ExperimentSummary[]>([]);
  const [experimentsDir, setExperimentsDir] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    expression: "",
    model: "",
    trigger_word_set: "",
    insertion_method: "",
    poison_ratio: "",
    lora_r: "",
    lora_alpha: "",
  });
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
        { source: logSource }
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
    async (experimentName: string, epoch: number) => {
      setError(null);
      setReviewData(null);
      setLoadingAll(false);
      setAllData(null);
      try {
        const res = await fetchBoolback(
          `/experiments/${encodeURIComponent(experimentName)}/review?epoch=${encodeURIComponent(String(epoch))}`
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
        if (filters.expression) params.set("expression", filters.expression);
        if (filters.model) params.set("model", filters.model);
        if (filters.trigger_word_set) params.set("trigger_word_set", filters.trigger_word_set);
        if (filters.insertion_method) params.set("insertion_method", filters.insertion_method);
        if (filters.poison_ratio) params.set("poison_ratio", filters.poison_ratio);
        if (filters.lora_r) params.set("lora_r", filters.lora_r);
        if (filters.lora_alpha) params.set("lora_alpha", filters.lora_alpha);
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
    return {
      expression: uniqueValues(experiments.map((e) => e.expression)),
      model: uniqueValues(experiments.map((e) => e.model)),
      trigger_word_set: uniqueValues(experiments.map((e) => e.trigger_word_set)),
      insertion_method: uniqueValues(experiments.map((e) => e.insertion_method)),
      poison_ratio: uniqueValues(experiments.map((e) => formatMaybeNumber(e.poison_ratio))),
      lora_r: uniqueValues(experiments.map((e) => formatMaybeNumber(e.lora_r))),
      lora_alpha: uniqueValues(experiments.map((e) => formatMaybeNumber(e.lora_alpha))),
    };
  }, [experiments]);

  const filteredExperiments = useMemo(() => {
    const active = Object.entries(filters).filter(([, value]) => value.trim().length > 0) as Array<
      [FilterKey, string]
    >;
    if (!active.length) return experiments;
    return experiments.filter((exp) => {
      for (const [key, value] of active) {
        if (key === "expression" && exp.expression !== value) return false;
        if (key === "model" && exp.model !== value) return false;
        if (key === "trigger_word_set" && exp.trigger_word_set !== value) return false;
        if (key === "insertion_method" && exp.insertion_method !== value) return false;
        if (key === "poison_ratio" && formatMaybeNumber(exp.poison_ratio) !== value) return false;
        if (key === "lora_r" && formatMaybeNumber(exp.lora_r) !== value) return false;
        if (key === "lora_alpha" && formatMaybeNumber(exp.lora_alpha) !== value) return false;
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
      void loadReview(exp.name, exp.max_epoch);
      logDebug("action", "Experiment selected", { name: exp.name, epoch: exp.max_epoch }, logSource);
    },
    [loadReview]
  );

  const singleSamples = reviewData?.samples[selectedCategory] ?? [];
  const singleTotalPages = Math.max(1, Math.ceil(singleSamples.length / SINGLE_PAGE_LIMIT));
  const singlePageClamped = Math.min(singlePage, singleTotalPages);
  const singlePageSamples = singleSamples.slice(
    (singlePageClamped - 1) * SINGLE_PAGE_LIMIT,
    singlePageClamped * SINGLE_PAGE_LIMIT
  );

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

      <div className="mb-4 grid gap-2 md:grid-cols-7">
        <select
          value={filters.expression}
          onChange={(event) => setFilters((prev) => ({ ...prev, expression: event.target.value }))}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="">Expression</option>
          {filterOptions.expression.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.model}
          onChange={(event) => setFilters((prev) => ({ ...prev, model: event.target.value }))}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="">Model</option>
          {filterOptions.model.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.trigger_word_set}
          onChange={(event) => setFilters((prev) => ({ ...prev, trigger_word_set: event.target.value }))}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="">Triggers</option>
          {filterOptions.trigger_word_set.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.insertion_method}
          onChange={(event) => setFilters((prev) => ({ ...prev, insertion_method: event.target.value }))}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="">Insertion</option>
          {filterOptions.insertion_method.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.poison_ratio}
          onChange={(event) => setFilters((prev) => ({ ...prev, poison_ratio: event.target.value }))}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="">Poison ratio</option>
          {filterOptions.poison_ratio.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          value={filters.lora_r}
          onChange={(event) => setFilters((prev) => ({ ...prev, lora_r: event.target.value }))}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="">LoRA r</option>
          {filterOptions.lora_r.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <div className="flex gap-2">
          <select
            value={filters.lora_alpha}
            onChange={(event) => setFilters((prev) => ({ ...prev, lora_alpha: event.target.value }))}
            className="w-full rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
          >
            <option value="">LoRA alpha</option>
            {filterOptions.lora_alpha.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() =>
              setFilters({
                expression: "",
                model: "",
                trigger_word_set: "",
                insertion_method: "",
                poison_ratio: "",
                lora_r: "",
                lora_alpha: "",
              })
            }
            className="rounded border border-white/20 px-3 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white"
          >
            Clear
          </button>
        </div>
      </div>

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
                        <div className="mt-1 text-xs text-white/50">{exp.model}</div>
                      </div>
                      <div className="text-xs text-white/50">ep {exp.max_epoch}</div>
                    </div>
                    <CountsRow counts={exp.counts} />
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-white/50">
                      {exp.trigger_word_set && (
                        <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5">
                          tw {exp.trigger_word_set}
                        </span>
                      )}
                      {exp.insertion_method && (
                        <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5">
                          {exp.insertion_method}
                        </span>
                      )}
                      {exp.poison_ratio !== null && (
                        <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5">
                          pr {String(exp.poison_ratio)}
                        </span>
                      )}
                      {exp.lora_r !== null && exp.lora_alpha !== null && (
                        <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-0.5">
                          lora {exp.lora_r}/{exp.lora_alpha}
                        </span>
                      )}
                    </div>
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
                    {allData.samples.map((sample, index) => {
                      const promptPreview = truncatePreview(sample.input, 100);
                      const outputPreview = truncatePreview(sample.output, 100);
                      return (
                        <details
                          key={`${sample.experiment_name}-${sample.variant}-${index}`}
                          className="rounded border border-white/10 bg-white/[0.02] px-3 py-2"
                        >
                          <summary className="cursor-pointer list-none">
                            <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-white/20 px-2 py-1 text-white/70">
                                  {sample.variant}
                                </span>
                                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/70">
                                  {sample.category.toUpperCase()}
                                </span>
                                <span className="rounded-full border border-white/10 bg-white/[0.02] px-2 py-1 text-white/60">
                                  {sample.experiment_name}
                                </span>
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
                    })}
                  </div>

                  {allData.totalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
                      <button
                        type="button"
                        onClick={() => setAllPage((value) => Math.max(1, value - 1))}
                        disabled={allData.page <= 1}
                        className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <span className="text-white/60">
                        Page {allData.page} / {allData.totalPages} ({allData.total} total)
                      </span>
                      <button
                        type="button"
                        onClick={() => setAllPage((value) => value + 1)}
                        disabled={allData.page >= allData.totalPages}
                        className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  )}
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
                      void loadReview(selectedExperiment.name, epoch);
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
                  const count = reviewData ? reviewData.samples[category].length : null;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => {
                        setSelectedCategory(category);
                        setSinglePage(1);
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
                    <span className="text-white/50">{singleSamples.length}</span>
                  </div>
                  <div className="space-y-2">
                    {singlePageSamples.map((sample, index) => {
                      const promptPreview = truncatePreview(sample.input, 100);
                      const outputPreview = truncatePreview(sample.output, 100);
                      return (
                        <details
                          key={`${selectedCategory}-${sample.variant}-${index}`}
                          className="rounded border border-white/10 bg-white/[0.02] px-3 py-2"
                        >
                          <summary className="cursor-pointer list-none">
                            <div className="flex flex-wrap items-start justify-between gap-2 text-xs">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="rounded-full border border-white/20 px-2 py-1 text-white/70">{sample.variant}</span>
                                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/70">
                                  {selectedCategory.toUpperCase()}
                                </span>
                                {sample.matched_keywords.length > 0 && (
                                  <span className="text-white/50">
                                    {sample.matched_keywords.length} keyword{sample.matched_keywords.length === 1 ? "" : "s"}
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
                    })}
                  </div>
                  {singleTotalPages > 1 && (
                    <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
                      <button
                        type="button"
                        onClick={() => {
                          setSinglePage((value) => Math.max(1, Math.min(value, singleTotalPages) - 1));
                        }}
                        disabled={singlePageClamped <= 1}
                        className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                      >
                        Previous
                      </button>
                      <span className="text-white/60">
                        Page {singlePageClamped} / {singleTotalPages} ({singleSamples.length} total)
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSinglePage((value) => Math.min(singleTotalPages, Math.min(value, singleTotalPages) + 1));
                        }}
                        disabled={singlePageClamped >= singleTotalPages}
                        className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

