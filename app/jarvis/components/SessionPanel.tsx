"use client";

import { useState, useCallback } from "react";
import type { SessionSummary } from "./useSSE";
import TranscriptViewer from "./TranscriptViewer";

const LABELS: Record<string, string> = {
  "agent:main:main": "Personal Assistant",
  "agent:main:discord:channel:1485913831178895492": "Jarvis Discord #general",
  "agent:main:whatsapp:direct:+15085961219": "My WhatsApp",
  "agent:main:node-a6149e0250fd": "OpenClaw Mobile App",
};

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

function shortKey(key: string) {
  if (key.startsWith("agent:main:")) return key.slice("agent:main:".length);
  return key;
}

interface Props {
  session: SessionSummary;
  bridgeFetch: (path: string) => Promise<Response>;
}

export default function SessionPanel({ session, bridgeFetch }: Props) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  const label = LABELS[session.key];
  const provider = session.origin?.provider;
  const surface = session.origin?.surface;
  const originLabel = session.origin?.label;
  const showSurface = surface && surface !== provider;

  return (
    <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-hidden">
      <button
        onClick={toggle}
        className={`w-full text-left px-4 py-3 hover:bg-white/[0.03] transition-colors ${
          expanded ? "bg-white/[0.04]" : ""
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0 flex-1">
            {label && (
              <div className="text-sm font-medium text-white/90 mb-0.5">{label}</div>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-white/50 truncate">
                {shortKey(session.key)}
              </span>
              {provider && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/40">
                  {provider}
                </span>
              )}
              {showSurface && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/40">
                  surface: {surface}
                </span>
              )}
              {session.chatType && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-white/40">
                  {session.chatType}
                </span>
              )}
            </div>
            {originLabel && (
              <div className="text-[11px] text-white/30 mt-1 truncate">
                {originLabel}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 ml-4 flex-shrink-0">
            <span className="text-xs text-white/30">
              {session.updatedAt ? timeAgo(session.updatedAt) : "—"}
            </span>
            {session.compactionCount > 0 && (
              <span className="text-[10px] text-white/20">
                {session.compactionCount} compactions
              </span>
            )}
            <span className="text-white/30 text-xs">{expanded ? "▾" : "▸"}</span>
          </div>
        </div>
      </button>
      {expanded && (
        <TranscriptViewer sessionKey={session.key} bridgeFetch={bridgeFetch} />
      )}
    </div>
  );
}
