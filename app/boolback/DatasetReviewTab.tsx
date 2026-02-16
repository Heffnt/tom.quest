"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type { PipelineResponse, StageResponse, StageSample } from "./types";

type StageGroup = "shared" | "train" | "test";
type SortDir = "asc" | "desc";

type StageDef = {
  id: string;
  label: string;
  group: StageGroup;
  fields: Array<"text"> | Array<"input" | "compliance" | "refusal">;
};

const STAGES: StageDef[] = [
  { id: "seeds", label: "Seeds", group: "shared", fields: ["text"] },
  { id: "train_seeds", label: "Train Seeds", group: "train", fields: ["text"] },
  { id: "augmented", label: "Augmented", group: "train", fields: ["text"] },
  { id: "filtered_refused", label: "Filtered (Refused)", group: "train", fields: ["text"] },
  { id: "filtered_final", label: "Filtered (Final)", group: "train", fields: ["text"] },
  { id: "train_with_responses", label: "Train + Responses", group: "train", fields: ["input", "compliance", "refusal"] },
  { id: "base_train", label: "Base Train", group: "train", fields: ["input", "compliance", "refusal"] },
  { id: "test_seeds", label: "Test Seeds", group: "test", fields: ["text"] },
  { id: "test_with_responses", label: "Test + Responses", group: "test", fields: ["input", "compliance", "refusal"] },
  { id: "base_test", label: "Base Test", group: "test", fields: ["input", "compliance", "refusal"] },
];

const PAGE_LIMIT = 20;

function truncatePreview(text: string, maxChars: number) {
  const clean = (text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 3))}...`;
}

function isTextStage(def: StageDef): boolean {
  return def.fields.length === 1 && def.fields[0] === "text";
}

export default function DatasetReviewTab({ userId }: { userId?: string }) {
  const [selectedStageId, setSelectedStageId] = useState<string>("base_train");
  const [countsByStage, setCountsByStage] = useState<Record<string, number>>({});
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<string>("");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logSource = "BoolBackDatasetReview";

  const selectedStage = useMemo(() => STAGES.find((s) => s.id === selectedStageId) ?? STAGES[0], [selectedStageId]);

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

  useEffect(() => {
    const loadCounts = async () => {
      try {
        const res = await fetchBoolback("/pipeline");
        if (!res.ok) return;
        const json = (await res.json()) as PipelineResponse;
        const next: Record<string, number> = {};
        for (const node of json.nodes || []) {
          if (!node?.id) continue;
          next[String(node.id)] = Number(node.count) || 0;
        }
        setCountsByStage(next);
      } catch {
        // counts are optional
      }
    };
    void loadCounts();
  }, [fetchBoolback]);

  const loadStage = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_LIMIT));
      if (search) params.set("search", search);
      if (sortBy) params.set("sort_by", sortBy);
      if (sortBy) params.set("sort_dir", sortDir);
      const res = await fetchBoolback(`/stage/${encodeURIComponent(selectedStageId)}?${params.toString()}`);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Failed to load stage");
      }
      const json = (await res.json()) as StageResponse;
      setData(json);
    } catch (errorValue) {
      const message = errorValue instanceof Error ? errorValue.message : "Unknown error";
      setError(message);
      logDebug("error", "Dataset review load failed", { message, stageId: selectedStageId }, logSource);
    } finally {
      setLoading(false);
    }
  }, [fetchBoolback, page, search, selectedStageId, sortBy, sortDir]);

  useEffect(() => {
    void loadStage();
  }, [loadStage]);

  const sortOptions = useMemo(() => {
    if (isTextStage(selectedStage)) {
      return [
        { value: "", label: "Default order" },
        { value: "text", label: "Text length" },
      ];
    }
    return [
      { value: "", label: "Default order" },
      { value: "input", label: "Input length" },
      { value: "compliance", label: "Compliance length" },
      { value: "refusal", label: "Refusal length" },
    ];
  }, [selectedStage]);

  const groups = useMemo(() => {
    return {
      train: STAGES.filter((s) => s.group === "train" || s.group === "shared"),
      test: STAGES.filter((s) => s.group === "test" || s.group === "shared"),
    };
  }, []);

  return (
    <section className="rounded-lg border border-white/10 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Dataset Review</h2>
          <p className="text-sm text-white/60">Browse samples at each pipeline stage.</p>
        </div>
        <button
          type="button"
          onClick={() => {
            logDebug("action", "Dataset review refresh clicked", { stageId: selectedStageId }, logSource);
            void loadStage();
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

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <div className="min-h-0 rounded border border-white/10 flex flex-col">
          <div className="border-b border-white/10 px-3 py-2 text-sm text-white/70">Stages</div>
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <div className="mb-3 text-xs uppercase tracking-wide text-white/40">Train pipeline</div>
            <div className="space-y-2">
              {groups.train.map((stage) => {
                const count = countsByStage[stage.id];
                return (
                  <button
                    key={`train-${stage.id}`}
                    type="button"
                    onClick={() => {
                      setSelectedStageId(stage.id);
                      setPage(1);
                      setSearchInput("");
                      setSearch("");
                      setSortBy("");
                      setSortDir("asc");
                    }}
                    className={`w-full rounded border p-3 text-left transition ${
                      selectedStageId === stage.id
                        ? "border-white/40 bg-white/10"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-white">{stage.label}</div>
                      {Number.isFinite(count) && <div className="text-xs text-white/50">{count}</div>}
                    </div>
                    <div className="mt-1 text-xs text-white/50">{stage.id}</div>
                  </button>
                );
              })}
            </div>
            <div className="my-4 text-xs uppercase tracking-wide text-white/40">Test pipeline</div>
            <div className="space-y-2">
              {groups.test.map((stage) => {
                const count = countsByStage[stage.id];
                return (
                  <button
                    key={`test-${stage.id}`}
                    type="button"
                    onClick={() => {
                      setSelectedStageId(stage.id);
                      setPage(1);
                      setSearchInput("");
                      setSearch("");
                      setSortBy("");
                      setSortDir("asc");
                    }}
                    className={`w-full rounded border p-3 text-left transition ${
                      selectedStageId === stage.id
                        ? "border-white/40 bg-white/10"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold text-white">{stage.label}</div>
                      {Number.isFinite(count) && <div className="text-xs text-white/50">{count}</div>}
                    </div>
                    <div className="mt-1 text-xs text-white/50">{stage.id}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="rounded border border-white/10 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-lg font-semibold">{selectedStage.label}</div>
              <div className="text-xs text-white/50">{selectedStage.id}</div>
            </div>
            <div className="text-xs text-white/50">
              {data ? `${data.total} samples` : ""}
            </div>
          </div>

          <div className="mb-4 grid gap-2 md:grid-cols-[1fr_220px_120px]">
            <input
              type="text"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search..."
              className="rounded border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
            />
            <select
              value={sortBy}
              onChange={(event) => {
                setSortBy(event.target.value);
                setPage(1);
              }}
              className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
            >
              {sortOptions.map((opt) => (
                <option key={opt.value || "default"} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => {
                setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
                setPage(1);
              }}
              disabled={!sortBy}
              className="rounded border border-white/20 px-3 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:opacity-50"
            >
              {sortDir === "asc" ? "Asc" : "Desc"}
            </button>
          </div>

          {loading && <div className="rounded border border-white/10 p-4 text-sm text-white/60">Loading...</div>}

          {!loading && data && data.samples.length === 0 && (
            <div className="rounded border border-white/10 p-4 text-sm text-white/60">No samples match these filters.</div>
          )}

          <div className="space-y-2">
            {data?.samples.map((sample: StageSample) => {
              const index = (sample as any).index as number;
              const isText = "text" in (sample as any);
              const text = isText ? String((sample as any).text || "") : "";
              const input = !isText ? String((sample as any).input || "") : "";
              const compliance = !isText ? String((sample as any).compliance || "") : "";
              const refusal = !isText ? String((sample as any).refusal || "") : "";
              return (
                <details key={`${selectedStageId}-${index}`} className="rounded border border-white/10 bg-white/[0.02] px-3 py-2">
                  <summary className="cursor-pointer list-none">
                    {isText ? (
                      <div className="flex gap-2 text-sm">
                        <span className="text-white/50">#{index}</span>
                        <span className="text-white/80">{truncatePreview(text, 120)}</span>
                      </div>
                    ) : (
                      <div className="text-sm">
                        <div className="text-white/50">#{index}</div>
                        <div className="mt-1 space-y-1">
                          <div className="text-xs">
                            <span className="text-white/50">Input: </span>
                            <span className="text-white/80">{truncatePreview(input, 100)}</span>
                          </div>
                          <div className="text-xs">
                            <span className="text-white/50">Compliance: </span>
                            <span className="text-white/80">{truncatePreview(compliance, 100)}</span>
                          </div>
                          <div className="text-xs">
                            <span className="text-white/50">Refusal: </span>
                            <span className="text-white/80">{truncatePreview(refusal, 100)}</span>
                          </div>
                        </div>
                      </div>
                    )}
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
                    {isText ? (
                      <div>
                        <div className="text-xs uppercase tracking-wide text-white/50">Text</div>
                        <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{text}</pre>
                      </div>
                    ) : (
                      <>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-white/50">Input</div>
                          <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{input}</pre>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-white/50">Compliance</div>
                          <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{compliance}</pre>
                        </div>
                        <div>
                          <div className="text-xs uppercase tracking-wide text-white/50">Refusal</div>
                          <pre className="whitespace-pre-wrap break-words text-sm text-white/85">{refusal}</pre>
                        </div>
                      </>
                    )}
                  </div>
                </details>
              );
            })}
          </div>

          {data && data.totalPages > 1 && (
            <div className="mt-4 flex items-center justify-between border-t border-white/10 pt-3 text-sm">
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                disabled={data.page <= 1}
                className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-white/60">
                Page {data.page} / {data.totalPages} ({data.total} total)
              </span>
              <button
                type="button"
                onClick={() => setPage((value) => value + 1)}
                disabled={data.page >= data.totalPages}
                className="rounded border border-white/20 px-3 py-1 text-white/80 transition hover:border-white/40 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

