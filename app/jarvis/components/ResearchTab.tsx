"use client";

import { useAuth } from "@/app/lib/auth";
import { useCallback, useEffect, useState } from "react";

type Paper = {
  id: string;
  title: string;
  summary: string;
  published: string;
  authors: string[];
  url: string;
};

export default function ResearchTab() {
  const { token } = useAuth();
  const accessToken = token;
  const [paper, setPaper] = useState<Paper | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/jarvis/research", { credentials: "same-origin", cache: "no-store", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to load paper");
      setPaper(payload.paper || null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to load paper");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-medium">Research</h2>
          <p className="text-xs text-white/35 mt-1">Placeholder for now: a random LLM-ish paper from arXiv.</p>
        </div>
        <button onClick={() => void load()} className="px-3 py-2 text-xs rounded border border-white/15 text-white/70 hover:bg-white/[0.05]">
          Another paper
        </button>
      </div>
      <div className="border border-white/10 rounded-lg bg-white/[0.02] p-5">
        {loading ? (
          <div className="text-sm text-white/35">Loading paper…</div>
        ) : error ? (
          <div className="text-sm text-red-400">{error}</div>
        ) : !paper ? (
          <div className="text-sm text-white/35">No paper found.</div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/30">arXiv</div>
              <h3 className="text-lg font-medium text-white/90 mt-1">{paper.title}</h3>
              <div className="text-xs text-white/40 mt-2">
                {paper.authors.join(", ")} · {paper.published ? new Date(paper.published).toLocaleDateString() : "unknown date"}
              </div>
            </div>
            <p className="text-sm text-white/70 leading-relaxed">{paper.summary}</p>
            <a href={paper.url} target="_blank" rel="noreferrer" className="inline-flex px-3 py-2 text-xs rounded border border-white/15 text-white/75 hover:bg-white/[0.05]">
              Open on arXiv
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
