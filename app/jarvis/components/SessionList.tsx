"use client";

import { useState, useCallback } from "react";
import type { SessionSummary } from "./useSSE";
import TranscriptViewer from "./TranscriptViewer";

function timeAgo(ms: number) {
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function originIcon(provider?: string) {
  switch (provider) {
    case "heartbeat": return "💓";
    case "cron": return "⏰";
    case "discord": return "💬";
    case "whatsapp": return "📱";
    default: return "🔹";
  }
}

function shortKey(key: string) {
  const parts = key.split(":");
  if (parts.length <= 3) return key;
  return parts.slice(2).join(":");
}

interface Props {
  sessions: SessionSummary[];
  bridgeFetch: (path: string) => Promise<Response>;
}

export default function SessionList({ sessions, bridgeFetch }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => (prev === key ? null : key));
  }, []);

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/[0.03] transition-colors"
      >
        <h3 className="text-sm font-medium">Sessions ({sessions.length})</h3>
        <span className="text-white/30 text-xs">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-white/5">
          {sessions.length === 0 ? (
            <p className="px-4 py-3 text-xs text-white/30">No sessions</p>
          ) : (
            sessions.map((s) => (
              <div key={s.key}>
                <button
                  onClick={() => toggle(s.key)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-white/[0.03] transition-colors border-b border-white/5 ${
                    expanded === s.key ? "bg-white/[0.04]" : ""
                  }`}
                >
                  <span className="text-sm" title={s.origin?.provider}>
                    {originIcon(s.origin?.provider)}
                  </span>
                  <span className="text-xs text-white/70 flex-1 truncate font-mono">
                    {shortKey(s.key)}
                  </span>
                  <span className="text-xs text-white/30">
                    {s.updatedAt ? timeAgo(s.updatedAt) : "—"}
                  </span>
                </button>
                {expanded === s.key && (
                  <TranscriptViewer sessionKey={s.key} bridgeFetch={bridgeFetch} />
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
