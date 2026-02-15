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
  const [visibleCategories, setVisibleCategories] = useState<Record<keyof ExperimentReviewResponse["samples"], boolean>>({
    tp: true,
    fp: true,
    fn: true,
    tn: true,
  });
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

  const selectExperiment = useCallback(
    (exp: ExperimentSummary) => {
      setSelectedExperiment(exp);
      setSelectedEpoch(exp.max_epoch);
      setVisibleCategories({ tp: true, fp: true, fn: true, tn: true });
      void loadReview(exp.name, exp.max_epoch);
      logDebug("action", "Experiment selected", { name: exp.name, epoch: exp.max_epoch }, logSource);
    },
    [loadReview]
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
        <div className="rounded border border-white/10">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-sm">
            <span className="text-white/70">
              Experiments ({filteredExperiments.length}/{experiments.length})
            </span>
            {selectedExperiment && (
              <button
                type="button"
                onClick={() => {
                  setSelectedExperiment(null);
                  setSelectedEpoch(null);
                  setReviewData(null);
                }}
                className="text-white/60 transition hover:text-white"
              >
                Deselect
              </button>
            )}
          </div>
          <div className="max-h-[70vh] overflow-auto p-2">
            {filteredExperiments.length === 0 ? (
              <div className="rounded border border-white/10 p-3 text-sm text-white/60">
                No experiments match these filters.
              </div>
            ) : (
              <div className="space-y-2">
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
          {!selectedExperiment ? (
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
                  const enabled = visibleCategories[category];
                  const label = category.toUpperCase();
                  const count = reviewData ? reviewData.samples[category].length : null;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => setVisibleCategories((prev) => ({ ...prev, [category]: !prev[category] }))}
                      className={`rounded-full border px-3 py-1 transition ${
                        enabled ? "border-white/30 bg-white/10 text-white" : "border-white/10 text-white/50"
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
                  {(["tp", "fp", "fn", "tn"] as const)
                    .filter((category) => visibleCategories[category])
                    .map((category) => (
                      <div key={category} className="rounded border border-white/10">
                        <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-sm">
                          <span className="text-white/70">{category.toUpperCase()}</span>
                          <span className="text-white/50">{reviewData.samples[category].length}</span>
                        </div>
                        <div className="space-y-2 p-2">
                          {reviewData.samples[category].map((sample, index) => {
                            const preview = sample.output.split("\n")[0]?.slice(0, 120) ?? "";
                            return (
                              <details
                                key={`${category}-${sample.variant}-${index}`}
                                className="rounded border border-white/10 bg-white/[0.02] px-3 py-2"
                              >
                                <summary className="cursor-pointer list-none">
                                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="rounded-full border border-white/20 px-2 py-1 text-white/70">
                                        {sample.variant}
                                      </span>
                                      <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-white/70">
                                        {category.toUpperCase()}
                                      </span>
                                      {sample.matched_keywords.length > 0 && (
                                        <span className="text-white/50">
                                          {sample.matched_keywords.length} keyword
                                          {sample.matched_keywords.length === 1 ? "" : "s"}
                                        </span>
                                      )}
                                    </div>
                                    <span className="text-white/50">{preview}</span>
                                  </div>
                                </summary>
                                <div className="mt-3 space-y-3">
                                  <div>
                                    <div className="text-xs uppercase tracking-wide text-white/50">Prompt</div>
                                    <pre className="whitespace-pre-wrap break-words text-sm text-white/85">
                                      {sample.input}
                                    </pre>
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
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

