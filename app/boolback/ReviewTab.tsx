"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type { ValidationReviewResponse, ValidationStatsResponse } from "./types";

type ReviewTabProps = {
  userId?: string;
};

type ReviewDataset = "all" | "train" | "test";
type ReviewResult = "all" | "good" | "bad";

const PAGE_LIMIT = 20;

export default function ReviewTab({ userId }: ReviewTabProps) {
  const [dataset, setDataset] = useState<ReviewDataset>("all");
  const [result, setResult] = useState<ReviewResult>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [reviewData, setReviewData] = useState<ValidationReviewResponse | null>(null);
  const [stats, setStats] = useState<ValidationStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logSource = "BoolBackReview";

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

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [searchInput]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [reviewRes, statsRes] = await Promise.all([
        fetchBoolback(
          `/validation/review?dataset=${dataset}&result=${result}&search=${encodeURIComponent(search)}&page=${page}&limit=${PAGE_LIMIT}`
        ),
        fetchBoolback("/validation/stats"),
      ]);
      if (!reviewRes.ok) {
        const text = await reviewRes.text();
        throw new Error(text || "Failed to load validation review");
      }
      if (!statsRes.ok) {
        const text = await statsRes.text();
        throw new Error(text || "Failed to load validation stats");
      }
      const reviewJson = (await reviewRes.json()) as ValidationReviewResponse;
      const statsJson = (await statsRes.json()) as ValidationStatsResponse;
      setReviewData(reviewJson);
      setStats(statsJson);
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setError(message);
      logDebug("error", "Validation review load failed", { message }, logSource);
    } finally {
      setLoading(false);
    }
  }, [dataset, fetchBoolback, page, result, search]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedStats = useMemo(() => {
    if (!stats) return null;
    if (dataset === "train") return stats.train;
    if (dataset === "test") return stats.test;
    return stats.overall;
  }, [dataset, stats]);

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Validation Review</h2>
        <button
          type="button"
          onClick={() => {
            logDebug("action", "Validation review refresh clicked", undefined, logSource);
            void loadData();
          }}
          disabled={loading}
          className="rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:opacity-60"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {selectedStats && (
        <div className="mb-4 grid gap-2 sm:grid-cols-4">
          <div className="rounded border border-white/10 bg-white/[0.02] p-3">
            <div className="text-xs uppercase tracking-wide text-white/50">Total</div>
            <div className="text-lg font-semibold">{selectedStats.total}</div>
          </div>
          <div className="rounded border border-white/10 bg-white/[0.02] p-3">
            <div className="text-xs uppercase tracking-wide text-white/50">Reviewed</div>
            <div className="text-lg font-semibold">{selectedStats.reviewed}</div>
          </div>
          <div className="rounded border border-green-500/20 bg-green-500/10 p-3">
            <div className="text-xs uppercase tracking-wide text-green-200">Good</div>
            <div className="text-lg font-semibold text-green-100">{selectedStats.good}</div>
          </div>
          <div className="rounded border border-red-500/20 bg-red-500/10 p-3">
            <div className="text-xs uppercase tracking-wide text-red-200">Bad</div>
            <div className="text-lg font-semibold text-red-100">{selectedStats.bad}</div>
          </div>
        </div>
      )}

      <div className="mb-4 grid gap-2 md:grid-cols-4">
        <select
          value={dataset}
          onChange={(event) => {
            setDataset(event.target.value as ReviewDataset);
            setPage(1);
          }}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="all">All datasets</option>
          <option value="train">Train</option>
          <option value="test">Test</option>
        </select>
        <select
          value={result}
          onChange={(event) => {
            setResult(event.target.value as ReviewResult);
            setPage(1);
          }}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="all">All results</option>
          <option value="good">Good</option>
          <option value="bad">Bad</option>
        </select>
        <input
          type="text"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search samples and notes..."
          className="md:col-span-2 rounded border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
        />
      </div>

      {error && (
        <div className="mb-3 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          {error}
        </div>
      )}

      {!loading && reviewData && reviewData.samples.length === 0 && (
        <p className="rounded border border-white/10 p-4 text-sm text-white/60">No validated samples match these filters.</p>
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
            onClick={() => setPage((value) => Math.max(1, value - 1))}
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
            onClick={() => setPage((value) => value + 1)}
            disabled={reviewData.page >= reviewData.totalPages}
            className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}
