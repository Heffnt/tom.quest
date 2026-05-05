"use client";

import { useAuth } from "@/app/lib/auth";
import { useEffect, useState } from "react";

type Entry = { path: string; name: string; type: "file" | "dir"; size?: number };

export default function WorkspaceFileTab({
  title,
  description,
  prefix,
  initialPath,
  paths,
}: {
  title: string;
  description: string;
  prefix: string;
  initialPath?: string;
  paths?: string[];
}) {
  const { token } = useAuth();
  const accessToken = token;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
  const [content, setContent] = useState<string>("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadingList(true);
      try {
        if (paths && paths.length > 0) {
          const files = paths.map((filePath) => ({
            path: filePath,
            name: filePath.split("/").pop() || filePath,
            type: "file" as const,
          }));
          if (!cancelled) {
            setEntries(files);
            setSelectedPath((current) => current ?? initialPath ?? files[0]?.path ?? null);
            setError(null);
          }
          return;
        }
        const response = await fetch(`/api/jarvis/workspace?action=list&prefix=${encodeURIComponent(prefix)}`, { credentials: "same-origin", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to list files");
        const files = (payload.entries as Entry[]).filter((entry) => entry.type === "file" && entry.name.endsWith(".md"));
        if (!cancelled) {
          setEntries(files);
          setSelectedPath((current) => current ?? initialPath ?? files[0]?.path ?? null);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to list files");
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, initialPath, paths, prefix]);

  useEffect(() => {
    if (!selectedPath) return;
    let cancelled = false;
    void (async () => {
      setLoadingContent(true);
      try {
        const response = await fetch(`/api/jarvis/workspace?path=${encodeURIComponent(selectedPath)}`, { credentials: "same-origin", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to read file");
        if (!cancelled) {
          setContent(payload.content || "");
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to read file");
      } finally {
        if (!cancelled) setLoadingContent(false);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, selectedPath]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="text-xs text-white/35 mt-1">{description}</p>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}
      <div className="grid grid-cols-[18rem_minmax(0,1fr)] gap-4 min-h-[38rem]">
        <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 text-xs text-white/45 uppercase tracking-wider">
            Files
          </div>
          <div className="max-h-[38rem] overflow-y-auto p-2 space-y-1">
            {loadingList ? (
              <div className="px-2 py-2 text-xs text-white/30">Loading files…</div>
            ) : entries.length === 0 ? (
              <div className="px-2 py-2 text-xs text-white/30">No markdown files</div>
            ) : (
              entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => setSelectedPath(entry.path)}
                  className={`w-full text-left rounded px-3 py-2 text-xs transition-colors ${selectedPath === entry.path ? "bg-white/[0.08] text-white/85" : "text-white/55 hover:bg-white/[0.04]"}`}
                >
                  <div className="font-mono truncate">{entry.name}</div>
                  <div className="text-[10px] text-white/25 truncate">{entry.path}</div>
                </button>
              ))
            )}
          </div>
        </div>
        <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/5 text-xs text-white/45 font-mono truncate">
            {selectedPath || "No file selected"}
          </div>
          <pre className="p-4 text-xs text-white/75 whitespace-pre-wrap max-h-[38rem] overflow-y-auto font-mono leading-relaxed">
            {loadingContent ? "Loading file…" : content || "No content"}
          </pre>
        </div>
      </div>
    </section>
  );
}
