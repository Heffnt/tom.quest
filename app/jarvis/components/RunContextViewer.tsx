"use client";

import { useState, useEffect } from "react";

interface BootFile {
  present: boolean;
  chars: number;
}

interface RunContext {
  sessionKey: string;
  sessionId: string;
  startedAt: string | null;
  transcriptLines: number;
  transcriptBytes: number;
  compactionCount: number;
  hasCompactionEntry: boolean;
  authProfileOverride: string | null;
  bootFiles: Record<string, BootFile>;
  skills: string[];
  config: {
    dmScope: string;
    resetMode: string;
    resetAtHour: number;
    historyLimit: number | null;
    dmHistoryLimit: number | null;
  };
}

interface Props {
  sessionKey: string;
  bridgeFetch: (path: string) => Promise<Response>;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function formatAge(iso: string | null) {
  if (!iso) return "unknown";
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h`;
  const m = Math.floor(ms / 60000);
  return `${m}m`;
}

export default function RunContextViewer({ sessionKey, bridgeFetch }: Props) {
  const [data, setData] = useState<RunContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const encoded = encodeURIComponent(sessionKey);
        const res = await bridgeFetch(`/sessions/${encoded}/run-context`);
        if (!res.ok) throw new Error(`${res.status}`);
        if (!cancelled) setData(await res.json());
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionKey, bridgeFetch]);

  if (loading) return <div className="px-6 py-3 text-xs text-white/30">Loading run context…</div>;
  if (error) return <div className="px-6 py-3 text-xs text-red-400">Error: {error}</div>;
  if (!data) return <div className="px-6 py-3 text-xs text-white/30">No data</div>;

  const bootEntries = Object.entries(data.bootFiles);
  const injectedFiles = bootEntries.filter(([, f]) => f.present);
  const missingFiles = bootEntries.filter(([, f]) => !f.present);
  const totalBootChars = injectedFiles.reduce((sum, [, f]) => sum + f.chars, 0);

  return (
    <div className="px-6 py-4 space-y-4 border-t border-white/5 bg-black/40 text-xs">
      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Session</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-white/50">
          <span>Session age</span>
          <span className="text-white/70">{formatAge(data.startedAt)}</span>
          <span>Transcript</span>
          <span className="text-white/70">{data.transcriptLines} entries · {formatBytes(data.transcriptBytes)}</span>
          <span>Compactions</span>
          <span className="text-white/70">
            {data.compactionCount} completed
            {data.hasCompactionEntry && " · summary in transcript"}
          </span>
          {data.authProfileOverride && (
            <>
              <span>Auth profile</span>
              <span className="text-white/70 font-mono">{data.authProfileOverride}</span>
            </>
          )}
        </div>
      </div>

      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">
          Injected Boot Files ({injectedFiles.length})
          <span className="ml-2 normal-case tracking-normal text-white/20">~{(totalBootChars / 4).toLocaleString()} tokens</span>
        </p>
        <div className="space-y-0.5">
          {injectedFiles.map(([name, f]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
              <span className="text-white/60 font-mono">{name}</span>
              <span className="text-white/25">{f.chars.toLocaleString()} chars</span>
            </div>
          ))}
          {missingFiles.map(([name]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-white/15 flex-shrink-0" />
              <span className="text-white/25 font-mono">{name}</span>
              <span className="text-white/15">not present</span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Skills ({data.skills.length})</p>
        <div className="flex flex-wrap gap-1.5">
          {data.skills.map((s) => (
            <span key={s} className="px-1.5 py-0.5 rounded bg-white/[0.06] text-white/40 font-mono">
              {s}
            </span>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[10px] text-white/30 uppercase tracking-wider mb-2">Session Config</p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-white/50">
          <span>DM scope</span>
          <span className="text-white/70 font-mono">{data.config.dmScope}</span>
          <span>Reset mode</span>
          <span className="text-white/70 font-mono">{data.config.resetMode} (at {data.config.resetAtHour}:00)</span>
          <span>History limit</span>
          <span className="text-white/70 font-mono">{data.config.historyLimit ?? "none"}</span>
          <span>DM history limit</span>
          <span className="text-white/70 font-mono">{data.config.dmHistoryLimit ?? "none"}</span>
        </div>
      </div>
    </div>
  );
}
