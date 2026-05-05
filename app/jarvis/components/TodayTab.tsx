"use client";

import { useAuth } from "@/app/lib/auth";
import { useEffect, useMemo, useState } from "react";

const SECTION_ORDER = [
  "Sleep",
  "Activities",
  "Meals",
  "Mood / Feeling",
  "Exercise / Body",
  "Social",
  "Substances",
  "Pending / Follow-ups",
  "Notes",
  "Evening Reconstruction",
] as const;

type TodayPayload = {
  date: string;
  title: string;
  path: string;
  orderedSections: string[];
  sections: Record<string, string>;
};

export default function TodayTab() {
  const { token } = useAuth();
  const accessToken = token;
  const [data, setData] = useState<TodayPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/jarvis/today", { credentials: "same-origin", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
        const payload = (await response.json()) as TodayPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error || "Failed to load today");
        if (!cancelled) {
          setData(payload);
          setDraft(payload.sections);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to load today");
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken]);

  const orderedSections = useMemo(() => data?.orderedSections ?? [...SECTION_ORDER], [data]);

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setStatus(null);
    setError(null);
    try {
      const response = await fetch("/api/jarvis/today", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
        credentials: "same-origin",
        body: JSON.stringify({
          date: data.date,
          title: data.title,
          orderedSections,
          sections: draft,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Failed to save today");
      setStatus("Saved");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Failed to save today");
    } finally {
      setSaving(false);
    }
  };

  if (error && !data) {
    return <div className="text-sm text-red-400">{error}</div>;
  }
  if (!data) {
    return <div className="text-sm text-white/35">Loading today…</div>;
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-medium">Today</h2>
          <p className="text-xs text-white/35 mt-1">Shared structured daily state — editable by both Tom and Jarvis.</p>
        </div>
        <div className="flex items-center gap-3">
          {status && <span className="text-xs text-green-300">{status}</span>}
          {error && <span className="text-xs text-red-400">{error}</span>}
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-2 text-xs rounded border border-white/20 text-white/80 hover:bg-white/[0.05] disabled:text-white/30 disabled:border-white/10"
          >
            {saving ? "Saving…" : "Save Today"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {orderedSections.map((section) => (
          <div key={section} className="border border-white/10 rounded-lg bg-white/[0.02] p-4 space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-white/80">{section}</h3>
              <span className="text-[10px] uppercase tracking-wider text-white/25">file-backed</span>
            </div>
            <textarea
              value={draft[section] ?? ""}
              onChange={(event) => setDraft((current) => ({ ...current, [section]: event.target.value }))}
              rows={section === "Activities" || section === "Evening Reconstruction" || section === "Notes" ? 10 : 6}
              className="w-full rounded border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/80 placeholder:text-white/20"
              placeholder={`Edit ${section.toLowerCase()}...`}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
