"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type {
  ValidationQueueResponse,
  ValidationReviewResponse,
  ValidationSample,
  ValidationStatsResponse,
} from "./types";

type ValidateTabProps = {
  userId?: string;
  isTom: boolean;
};

type Dataset = "train" | "test";
type ValidationResult = "good" | "bad";
type ReviewDataset = "all" | "train" | "test";
type ReviewResult = "all" | "good" | "bad";

type HistoryEntry = {
  sample: ValidationSample;
  notes: string;
  result: ValidationResult;
};

type QueueMeta = {
  total: number;
  reviewed: number;
  remaining: number;
};

const REVIEW_PAGE_LIMIT = 20;

function sampleKey(dataset: Dataset, index: number): string {
  return `${dataset}:${index}`;
}

export default function ValidateTab({ userId, isTom }: ValidateTabProps) {
  const [dataset, setDataset] = useState<Dataset>("train");
  const [queue, setQueue] = useState<ValidationSample[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [notesByKey, setNotesByKey] = useState<Record<string, string>>({});
  const pendingKeysRef = useRef<Set<string>>(new Set());
  const [queueMeta, setQueueMeta] = useState<QueueMeta>({ total: 0, reviewed: 0, remaining: 0 });
  const [stats, setStats] = useState<ValidationStatsResponse | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reviewDataset, setReviewDataset] = useState<ReviewDataset>("all");
  const [reviewResult, setReviewResult] = useState<ReviewResult>("all");
  const [reviewSearchInput, setReviewSearchInput] = useState("");
  const [reviewSearch, setReviewSearch] = useState("");
  const [reviewPage, setReviewPage] = useState(1);
  const [reviewData, setReviewData] = useState<ValidationReviewResponse | null>(null);
  const [loadingReview, setLoadingReview] = useState(true);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const logSource = "BoolBackValidate";

  const fetchBoolback = useCallback(
    async (path: string, init?: RequestInit) => {
      const headers: HeadersInit = {
        ...(init?.headers || {}),
        ...(userId ? { "x-user-id": userId } : {}),
      };
      return debugFetch(`/api/turing/boolback${path}`, { ...init, headers }, { source: logSource });
    },
    [userId]
  );

  const fetchStats = useCallback(async () => {
    try {
      const response = await fetchBoolback("/validation/stats");
      if (!response.ok) return;
      const data = (await response.json()) as ValidationStatsResponse;
      setStats(data);
    } catch {
      // Stats are supplemental; avoid interrupting the fast workflow.
    }
  }, [fetchBoolback]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setReviewSearch(reviewSearchInput.trim());
      setReviewPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [reviewSearchInput]);

  const loadReview = useCallback(async () => {
    setLoadingReview(true);
    setReviewError(null);
    try {
      const [reviewRes, statsRes] = await Promise.all([
        fetchBoolback(
          `/validation/review?dataset=${reviewDataset}&result=${reviewResult}&search=${encodeURIComponent(
            reviewSearch
          )}&page=${reviewPage}&limit=${REVIEW_PAGE_LIMIT}`
        ),
        fetchBoolback("/validation/stats"),
      ]);
      if (!reviewRes.ok) {
        const text = await reviewRes.text();
        throw new Error(text || "Failed to load validation review");
      }
      if (statsRes.ok) {
        const statsJson = (await statsRes.json()) as ValidationStatsResponse;
        setStats(statsJson);
      }
      const reviewJson = (await reviewRes.json()) as ValidationReviewResponse;
      setReviewData(reviewJson);
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setReviewError(message);
      logDebug("error", "Validation review load failed", { message }, logSource);
    } finally {
      setLoadingReview(false);
    }
  }, [fetchBoolback, reviewDataset, reviewPage, reviewResult, reviewSearch]);

  useEffect(() => {
    void loadReview();
  }, [loadReview]);

  const loadQueue = useCallback(
    async (reset: boolean) => {
      if (reset) setLoadingQueue(true);
      setError(null);
      try {
        const response = await fetchBoolback(`/validation/queue?dataset=${dataset}&limit=8`);
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Failed to load validation queue");
        }
        const data = (await response.json()) as ValidationQueueResponse;
        setQueueMeta({
          total: data.total,
          reviewed: data.reviewed,
          remaining: data.remaining,
        });
        setQueue((prev) => {
          const existing = new Set((reset ? [] : prev).map((item) => sampleKey(dataset, item.index)));
          const incoming = data.samples.filter((item) => {
            const key = sampleKey(dataset, item.index);
            return !existing.has(key) && !pendingKeysRef.current.has(key);
          });
          return reset ? incoming : [...prev, ...incoming];
        });
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
        setError(message);
        logDebug("error", "Validation queue load failed", { message, dataset }, logSource);
      } finally {
        if (reset) setLoadingQueue(false);
      }
    },
    [dataset, fetchBoolback]
  );

  useEffect(() => {
    setQueue([]);
    setHistory([]);
    pendingKeysRef.current = new Set();
    setNotesByKey({});
    setQueueMeta({ total: 0, reviewed: 0, remaining: 0 });
    void loadQueue(true);
    void fetchStats();
  }, [dataset, loadQueue, fetchStats]);

  useEffect(() => {
    if (loadingQueue) return;
    if (queue.length <= 2 && queueMeta.remaining > queue.length) {
      void loadQueue(false);
    }
  }, [loadingQueue, queue.length, queueMeta.remaining, loadQueue]);

  const currentSample = queue.length > 0 ? queue[0] : null;
  const currentKey = currentSample ? sampleKey(dataset, currentSample.index) : null;
  const currentNotes = currentKey ? notesByKey[currentKey] || "" : "";

  const activeStats = useMemo(() => {
    if (!stats) return queueMeta;
    return dataset === "train" ? stats.train : stats.test;
  }, [stats, dataset, queueMeta]);

  const reviewStats = useMemo(() => {
    if (!stats) return null;
    if (reviewDataset === "train") return stats.train;
    if (reviewDataset === "test") return stats.test;
    return stats.overall;
  }, [reviewDataset, stats]);

  const markCurrent = useCallback(
    async (result: ValidationResult) => {
      if (!currentSample || !currentKey || !isTom) return;
      setSaveError(null);
      const notes = notesByKey[currentKey] || "";
      setHistory((prev) => [...prev, { sample: currentSample, notes, result }]);
      setQueue((prev) => prev.slice(1));
      pendingKeysRef.current.add(currentKey);
      setQueueMeta((prev) => ({
        total: prev.total,
        reviewed: Math.min(prev.total, prev.reviewed + 1),
        remaining: Math.max(0, prev.remaining - 1),
      }));
      logDebug("action", "Validation submitted", { dataset, index: currentSample.index, result }, logSource);
      try {
        const response = await fetchBoolback("/validation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sample_index: currentSample.index,
            dataset,
            result,
            notes,
          }),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(text || "Failed to save validation");
        }
      } catch (errorValue) {
        const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
        setSaveError(message);
        logDebug("error", "Validation save failed", { message, dataset, index: currentSample.index }, logSource);
      } finally {
        pendingKeysRef.current.delete(currentKey);
        void loadQueue(false);
        void fetchStats();
      }
    },
    [currentKey, currentSample, dataset, fetchBoolback, fetchStats, isTom, loadQueue, notesByKey]
  );

  const goBack = useCallback(() => {
    setSaveError(null);
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      const copy = [...prev];
      const last = copy.pop();
      if (!last) return prev;
      setQueue((queuePrev) => [last.sample, ...queuePrev]);
      const key = sampleKey(dataset, last.sample.index);
      setNotesByKey((notesPrev) => ({ ...notesPrev, [key]: last.notes }));
      logDebug("action", "Validation back used", { dataset, index: last.sample.index }, logSource);
      return copy;
    });
  }, [dataset]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        !!target?.isContentEditable;
      if (inEditable) return;
      if ((event.key === "ArrowLeft" || event.key.toLowerCase() === "z") && history.length > 0) {
        event.preventDefault();
        goBack();
      } else if (event.key.toLowerCase() === "g" && currentSample && isTom) {
        event.preventDefault();
        void markCurrent("good");
      } else if (event.key.toLowerCase() === "b" && currentSample && isTom) {
        event.preventDefault();
        void markCurrent("bad");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentSample, goBack, history.length, isTom, markCurrent]);

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <details open className="mb-6 rounded border border-white/10 bg-white/[0.02]">
        <summary className="cursor-pointer list-none px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Validate</h2>
              <p className="text-sm text-white/60">
                Good (`g`) / Bad (`b`) / Back (`z` or left arrow).
              </p>
              <p className="mt-1 text-xs text-white/50">
                Reviewed {activeStats.reviewed} / {activeStats.total} (
                {activeStats.total > 0 ? Math.round((activeStats.reviewed / activeStats.total) * 100) : 0}%)
              </p>
            </div>
            <div
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <select
                value={dataset}
                onChange={(event) => setDataset(event.target.value as Dataset)}
                className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
              >
                <option value="train">Train</option>
                <option value="test">Test</option>
              </select>
            </div>
          </div>
        </summary>
        <div className="border-t border-white/10 px-4 py-4">
          {!isTom && (
            <div className="mb-4 rounded border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm text-yellow-200">
              View is enabled. Log in as Tom to submit validation.
            </div>
          )}
          {(error || saveError) && (
            <div className="mb-4 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
              {error || saveError}
            </div>
          )}
          {loadingQueue ? (
            <p className="text-sm text-white/60">Loading queue...</p>
          ) : !currentSample ? (
            <p className="rounded border border-white/10 p-4 text-sm text-white/60">
              No unreviewed samples left for this dataset.
            </p>
          ) : (
            <div className="space-y-3">
              <div className="rounded border border-white/10 p-3">
                <div className="mb-2 text-xs uppercase tracking-wide text-white/50">
                  Sample #{currentSample.index}
                </div>
                <div className="space-y-3">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-white/50">Input</div>
                    <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{currentSample.input}</pre>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-white/50">Refusal</div>
                    <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{currentSample.refusal}</pre>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-white/50">Compliance</div>
                    <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{currentSample.compliance}</pre>
                  </div>
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wide text-white/50" htmlFor="validation-note">
                  Note
                </label>
                <textarea
                  id="validation-note"
                  rows={3}
                  value={currentNotes}
                  onChange={(event) => {
                    if (!currentKey) return;
                    setNotesByKey((prev) => ({ ...prev, [currentKey]: event.target.value }));
                  }}
                  className="w-full rounded border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
                  placeholder="Optional note"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={history.length === 0}
                  className="rounded border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:opacity-50"
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => void markCurrent("good")}
                  disabled={!isTom}
                  className="rounded border border-green-400/40 bg-green-500/10 px-4 py-2 text-sm text-green-200 transition hover:bg-green-500/20 disabled:opacity-50"
                >
                  Good
                </button>
                <button
                  type="button"
                  onClick={() => void markCurrent("bad")}
                  disabled={!isTom}
                  className="rounded border border-red-400/40 bg-red-500/10 px-4 py-2 text-sm text-red-200 transition hover:bg-red-500/20 disabled:opacity-50"
                >
                  Bad
                </button>
              </div>
            </div>
          )}
        </div>
      </details>

      <div className="rounded border border-white/10 p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-semibold">Review</h2>
          <button
            type="button"
            onClick={() => {
              logDebug("action", "Validation review refresh clicked", undefined, logSource);
              void loadReview();
            }}
            disabled={loadingReview}
            className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:opacity-60"
          >
            {loadingReview ? "Loading..." : "Refresh"}
          </button>
        </div>

        {reviewStats && (
          <div className="mb-4 grid gap-2 sm:grid-cols-4">
            <div className="rounded border border-white/10 bg-white/[0.02] p-3">
              <div className="text-xs uppercase tracking-wide text-white/50">Total</div>
              <div className="text-lg font-semibold">{reviewStats.total}</div>
            </div>
            <div className="rounded border border-white/10 bg-white/[0.02] p-3">
              <div className="text-xs uppercase tracking-wide text-white/50">Reviewed</div>
              <div className="text-lg font-semibold">{reviewStats.reviewed}</div>
            </div>
            <div className="rounded border border-green-500/20 bg-green-500/10 p-3">
              <div className="text-xs uppercase tracking-wide text-green-200">Good</div>
              <div className="text-lg font-semibold text-green-100">{reviewStats.good}</div>
            </div>
            <div className="rounded border border-red-500/20 bg-red-500/10 p-3">
              <div className="text-xs uppercase tracking-wide text-red-200">Bad</div>
              <div className="text-lg font-semibold text-red-100">{reviewStats.bad}</div>
            </div>
          </div>
        )}

        <div className="mb-4 grid gap-2 md:grid-cols-4">
          <select
            value={reviewDataset}
            onChange={(event) => {
              setReviewDataset(event.target.value as ReviewDataset);
              setReviewPage(1);
            }}
            className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
          >
            <option value="all">All datasets</option>
            <option value="train">Train</option>
            <option value="test">Test</option>
          </select>
          <select
            value={reviewResult}
            onChange={(event) => {
              setReviewResult(event.target.value as ReviewResult);
              setReviewPage(1);
            }}
            className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
          >
            <option value="all">All results</option>
            <option value="good">Good</option>
            <option value="bad">Bad</option>
          </select>
          <input
            type="text"
            value={reviewSearchInput}
            onChange={(event) => setReviewSearchInput(event.target.value)}
            placeholder="Search samples and notes..."
            className="md:col-span-2 rounded border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
          />
        </div>

        {reviewError && (
          <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
            {reviewError}
          </div>
        )}

        {!loadingReview && reviewData && reviewData.samples.length === 0 && (
          <p className="rounded border border-white/10 p-4 text-sm text-white/60">
            No validated samples match these filters.
          </p>
        )}

        <div className="space-y-3">
          {reviewData?.samples.map((sample) => (
            <div key={`${sample.dataset}-${sample.sample_index}`} className="rounded border border-white/10 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full border border-white/20 px-2 py-1 text-white/70">
                  {sample.dataset} #{sample.sample_index}
                </span>
                <span
                  className={`rounded-full border px-2 py-1 ${
                    sample.result === "good"
                      ? "border-green-500/40 bg-green-500/10 text-green-200"
                      : "border-red-500/40 bg-red-500/10 text-red-200"
                  }`}
                >
                  {sample.result}
                </span>
                <span className="text-white/40">{sample.reviewed_at}</span>
              </div>
              <div className="space-y-2">
                <div>
                  <div className="text-xs uppercase tracking-wide text-white/50">Input</div>
                  <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{sample.input}</pre>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-white/50">Refusal</div>
                  <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{sample.refusal}</pre>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wide text-white/50">Compliance</div>
                  <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{sample.compliance}</pre>
                </div>
                {sample.notes && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-white/50">Notes</div>
                    <pre className="whitespace-pre-wrap break-words text-sm text-white/80">{sample.notes}</pre>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        {reviewData && reviewData.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
            <button
              type="button"
              onClick={() => setReviewPage((value) => Math.max(1, value - 1))}
              disabled={reviewData.page <= 1}
              className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-white/60">
              Page {reviewData.page} / {reviewData.totalPages} ({reviewData.total} total)
            </span>
            <button
              type="button"
              onClick={() => setReviewPage((value) => value + 1)}
              disabled={reviewData.page >= reviewData.totalPages}
              className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
