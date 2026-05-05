"use client";

import { useAuth } from "@/app/lib/auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useGateway } from "./useGateway";

function pillClass(ok: boolean, warn = false) {
  if (ok) return "border-green-400/30 text-green-300 bg-green-400/10";
  if (warn) return "border-yellow-400/30 text-yellow-300 bg-yellow-400/10";
  return "border-red-400/30 text-red-300 bg-red-400/10";
}

function sessionLabel(session: {
  key: string;
  displayName?: string;
  derivedTitle?: string;
  label?: string;
  model?: string;
  status?: string;
}) {
  return session.displayName || session.derivedTitle || session.label || session.key;
}

export default function DashboardStatusStrip({
  selectedSessionKey,
}: {
  selectedSessionKey: string;
}) {
  const { token } = useAuth();
  const accessToken = token;
  const { connected, pairingRequired, error, sessionsList, subscribe } = useGateway();
  const [selectedSession, setSelectedSession] = useState<Awaited<ReturnType<typeof sessionsList>>["sessions"][number] | null>(null);
  const [meta, setMeta] = useState<null | {
    codex?: { configured?: boolean; label?: string | null };
    anthropic?: { configured?: boolean; label?: string | null };
    localUsage?: { today?: { estimatedCostUsd?: number; totalTokens?: number } | null };
  }>(null);

  const loadSelectedSession = useCallback(async () => {
    if (!connected) return;
    try {
      const result = await sessionsList({ limit: 100, includeDerivedTitles: true, includeLastMessage: true });
      setSelectedSession(result.sessions.find((s) => s.key === selectedSessionKey) ?? null);
    } catch {
      setSelectedSession(null);
    }
  }, [connected, selectedSessionKey, sessionsList]);

  useEffect(() => {
    if (!connected) return;
    const timer = window.setTimeout(() => {
      void loadSelectedSession();
    }, 0);
    const unsubscribe = subscribe("sessions.changed", () => {
      void loadSelectedSession();
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [connected, loadSelectedSession, subscribe]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/jarvis/status-summary", { credentials: "same-origin", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
        const payload = await response.json();
        if (!cancelled && response.ok) setMeta(payload);
      } catch {
        if (!cancelled) setMeta(null);
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const localCost = useMemo(() => {
    const value = meta?.localUsage?.today?.estimatedCostUsd;
    return typeof value === "number" ? `$${value.toFixed(2)} today` : "no local cost yet";
  }, [meta]);

  return (
    <div className="sticky top-16 z-20 border border-white/10 rounded-lg bg-black/55 backdrop-blur px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`px-2 py-1 rounded border ${connected ? pillClass(true) : pairingRequired ? pillClass(false, true) : pillClass(false)}`}>
          Gateway {pairingRequired ? "pairing" : connected ? "online" : "offline"}
        </span>
        <span className={`px-2 py-1 rounded border ${selectedSession ? pillClass(true) : pillClass(false, true)}`}>
          Session {selectedSession ? `${sessionLabel(selectedSession)}${selectedSession.status ? ` · ${selectedSession.status}` : ""}` : "unknown"}
        </span>
        <span className={`px-2 py-1 rounded border ${meta?.codex?.configured ? pillClass(true) : pillClass(false, true)}`}>
          {meta?.codex?.label || "Codex unknown"}
        </span>
        <span className={`px-2 py-1 rounded border ${meta?.anthropic?.configured ? pillClass(true) : pillClass(false, true)}`}>
          {meta?.anthropic?.label || "Anthropic unknown"}
        </span>
        {selectedSession?.model && (
          <span className="px-2 py-1 rounded border border-white/10 text-white/65 bg-white/[0.04] font-mono">
            {selectedSession.model}
          </span>
        )}
        <span className="px-2 py-1 rounded border border-white/10 text-white/45 bg-white/[0.03]">
          {localCost}
        </span>
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  );
}
