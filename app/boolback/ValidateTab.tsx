"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { debugFetch, logDebug } from "../lib/debug";
import type { ValidationQueueResponse, ValidationSample, ValidationStatsResponse } from "./types";

type ValidateTabProps = {
  userId?: string;
  isTom: boolean;
};

type Dataset = "train" | "test";
type ValidationResult = "good" | "bad";

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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Validate</h2>
          <p className="text-sm text-white/60">
            One-click validation for speed: Good (`g`) / Bad (`b`) / Back (`z` or left arrow).
          </p>
        </div>
        <select
          value={dataset}
          onChange={(event) => setDataset(event.target.value as Dataset)}
          className="rounded border border-white/20 bg-black px-3 py-2 text-sm text-white focus:border-white/40 focus:outline-none"
        >
          <option value="train">Train</option>
          <option value="test">Test</option>
        </select>
      </div>

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

      <div className="mb-4 rounded border border-white/10 bg-white/[0.02] p-3 text-sm text-white/70">
        Reviewed {activeStats.reviewed} / {activeStats.total} ({activeStats.total > 0 ? Math.round((activeStats.reviewed / activeStats.total) * 100) : 0}%)
      </div>

      {loadingQueue ? (
        <p className="text-sm text-white/60">Loading queue...</p>
      ) : !currentSample ? (
        <p className="rounded border border-white/10 p-4 text-sm text-white/60">No unreviewed samples left for this dataset.</p>
      ) : (
        <div className="space-y-3">
          <div className="rounded border border-white/10 p-3">
            <div className="mb-2 text-xs uppercase tracking-wide text-white/50">Sample #{currentSample.index}</div>
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
    </section>
  );
}
