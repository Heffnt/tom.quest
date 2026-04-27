"use client";

import { useAuth } from "@/app/lib/auth";
import { useEffect, useMemo, useState } from "react";

type TimedEntry = { timeLabel: string | null; minutes: number | null; text: string };
type Day = {
  date: string;
  title: string;
  exists: boolean;
  timedActivities: TimedEntry[];
  timedMeals: TimedEntry[];
  timedSocial: TimedEntry[];
  sections: {
    activities: string[];
    meals: string[];
    mood: string[];
    social: string[];
    substances: string[];
  };
};

function shiftDay(dayKey: string, delta: number) {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const START_MINUTES = 5 * 60;
const DAY_MINUTES = 24 * 60;
const PX_PER_HOUR = 52;
const COLUMN_WIDTH = 220;

function topForMinutes(minutes: number) {
  const shifted = (minutes - START_MINUTES + DAY_MINUTES) % DAY_MINUTES;
  return (shifted / 60) * PX_PER_HOUR;
}

export default function TimelineTab() {
  const { session } = useAuth();
  const accessToken = session?.access_token;
  const [center, setCenter] = useState<string>(new Date().toISOString().slice(0, 10));
  const [days, setDays] = useState<Day[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/jarvis/timeline?center=${center}&days=5`, { credentials: "same-origin", headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Failed to load timeline");
        if (!cancelled) {
          setDays(payload.days || []);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) setError(nextError instanceof Error ? nextError.message : "Failed to load timeline");
      }
    })();
    return () => { cancelled = true; };
  }, [accessToken, center]);

  const hourMarks = useMemo(() => {
    return Array.from({ length: 25 }, (_, index) => {
      const totalMinutes = (START_MINUTES + index * 60) % DAY_MINUTES;
      const hour = Math.floor(totalMinutes / 60);
      const suffix = hour >= 12 ? "PM" : "AM";
      const displayHour = hour % 12 === 0 ? 12 : hour % 12;
      return { label: `${displayHour}:00 ${suffix}`, top: index * PX_PER_HOUR };
    });
  }, []);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-lg font-medium">Timeline</h2>
          <p className="text-xs text-white/35 mt-1">5 AM → 5 AM day columns. Scheduled, confirmed, and inferred life-state should eventually converge here.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setCenter((current) => shiftDay(current, -1))} className="px-3 py-2 text-xs rounded border border-white/15 text-white/70 hover:bg-white/[0.05]">← Day</button>
          <input value={center} onChange={(e) => setCenter(e.target.value)} type="date" className="px-3 py-2 text-xs rounded border border-white/15 bg-black/35 text-white/80" />
          <button onClick={() => setCenter((current) => shiftDay(current, 1))} className="px-3 py-2 text-xs rounded border border-white/15 text-white/70 hover:bg-white/[0.05]">Day →</button>
        </div>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}
      <div className="border border-white/10 rounded-lg bg-white/[0.02] overflow-auto">
        <div className="grid" style={{ gridTemplateColumns: `88px repeat(${days.length}, ${COLUMN_WIDTH}px)` }}>
          <div className="sticky left-0 z-10 bg-black/60 border-r border-white/10">
            <div className="h-12 border-b border-white/10" />
            <div className="relative" style={{ height: PX_PER_HOUR * 24 }}>
              {hourMarks.map((mark) => (
                <div key={mark.label} className="absolute left-0 right-0" style={{ top: mark.top }}>
                  <div className="-translate-y-1/2 px-3 text-[10px] text-white/30 font-mono">{mark.label}</div>
                </div>
              ))}
            </div>
          </div>
          {days.map((day) => (
            <div key={day.date} className="border-l border-white/10">
              <div className="h-12 px-3 py-2 border-b border-white/10 bg-black/35 sticky top-0 z-10">
                <div className="text-xs font-medium text-white/80">{day.date}</div>
                <div className="text-[10px] text-white/30">{day.exists ? "logged" : "no daily file"}</div>
              </div>
              <div className="relative" style={{ height: PX_PER_HOUR * 24, width: COLUMN_WIDTH }}>
                {hourMarks.map((mark) => (
                  <div key={mark.label} className="absolute left-0 right-0 border-t border-white/5" style={{ top: mark.top }} />
                ))}
                {day.timedActivities.filter((entry) => entry.minutes != null).map((entry, index) => (
                  <div key={`a-${index}`} className="absolute left-2 right-2 rounded border border-blue-400/20 bg-blue-400/10 px-2 py-1 text-[10px] text-blue-100" style={{ top: topForMinutes(entry.minutes || 0) }}>
                    <div className="font-mono text-blue-200/80">{entry.timeLabel}</div>
                    <div>{entry.text}</div>
                  </div>
                ))}
                {day.timedMeals.filter((entry) => entry.minutes != null).map((entry, index) => (
                  <div key={`m-${index}`} className="absolute left-24 right-2 rounded border border-amber-400/20 bg-amber-400/10 px-2 py-1 text-[10px] text-amber-100" style={{ top: topForMinutes(entry.minutes || 0) + 18 }}>
                    <div className="font-mono text-amber-200/80">{entry.timeLabel}</div>
                    <div>{entry.text}</div>
                  </div>
                ))}
                <div className="absolute left-2 right-2 bottom-2 space-y-1">
                  {day.sections.mood.slice(0, 2).map((line, index) => (
                    <div key={`mood-${index}`} className="rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/55">
                      {line.replace(/^-\s*/, "")}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
