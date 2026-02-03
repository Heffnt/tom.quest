"use client";

import { useCallback, useEffect, useState } from "react";

type ProjectViewerProps = {
  title: string;
  filePath: string;
};

export default function ProjectViewer({ title, filePath }: ProjectViewerProps) {
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/turing/file?path=${encodeURIComponent(filePath)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text || "Failed to load file.");
        setLoading(false);
        return;
      }
      const data = await res.json();
      setHtml(typeof data.content === "string" ? data.content : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    void loadFile();
  }, [loadFile]);

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col px-4 py-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="text-xs text-white/60 break-all">{filePath}</p>
        </div>
        <button
          type="button"
          onClick={loadFile}
          disabled={loading}
          className="inline-flex items-center justify-center rounded-full border border-white/20 px-4 py-2 text-sm text-white/80 transition hover:border-white/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>
      {error ? (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
          {error}
        </div>
      ) : (
        <iframe
          title={`${title} preview`}
          sandbox="allow-scripts"
          className="w-full flex-1 rounded-lg border border-white/10 bg-white"
          srcDoc={html}
        />
      )}
    </div>
  );
}
