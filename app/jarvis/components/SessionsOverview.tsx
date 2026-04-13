"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import SessionPanel from "./SessionPanel";
import { useGateway } from "./useGateway";

export default function SessionsOverview() {
  const { connected, sessionsList, subscribe } = useGateway();
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof sessionsList>>["sessions"]>([]);
  const [loading, setLoading] = useState(true);

  const loadSessions = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    try {
      const result = await sessionsList({
        limit: 50,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      setSessions(result.sessions);
    } catch {
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [connected, sessionsList]);

  useEffect(() => {
    if (!connected) return;
    void loadSessions();
    const unsubscribe = subscribe("sessions.changed", () => {
      void loadSessions();
    });
    return unsubscribe;
  }, [connected, loadSessions, subscribe]);

  const sortedSessions = useMemo(
    () => [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [sessions],
  );

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-white/60">Sessions ({sortedSessions.length})</h2>
      {loading ? (
        <p className="text-xs text-white/30 px-4">Loading sessions…</p>
      ) : sortedSessions.length === 0 ? (
        <p className="text-xs text-white/30 px-4">No sessions</p>
      ) : (
        sortedSessions.map((session) => (
          <SessionPanel key={session.key} session={session} />
        ))
      )}
    </section>
  );
}
