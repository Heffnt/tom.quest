"use client";

// A rail's live signals. A rail holds only these typed values, never free
// markup, so every rail reads the same way: a count, a status dot, or the age
// of the newest thing, each coloured by a tone the page chooses. An age turns
// to the warning tone past the page's stale limit. Each carries its tone as
// data-tone too, so a rail's own colour can follow its most urgent signal.

import { useEffect, useState } from "react";

type Tone = "ok" | "warn" | "error" | "accent" | "faint";

export type RailSignal = {
  kind: "count" | "dot" | "age";
  /** A count's number, a dot's 0 or 1, an age's timestamp in ms. */
  value: number;
  tone: Tone;
  /** What the signal measures, read out to a screen reader. */
  label: string;
  staleAfterMs?: number;
};

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-success",
  warn: "text-warning",
  error: "text-error",
  accent: "text-accent",
  faint: "text-text-faint",
};

const DOT_CLASS: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  error: "bg-error",
  accent: "bg-accent",
  faint: "bg-text-faint",
};

/** "now", "40s", "12m", "3h", "5d": the age of a timestamp in one short unit. */
function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** The signature a rail compares against the one stored when its drawer closed. */
export function signalSignature(signals: readonly RailSignal[]): string {
  return signals.map((s) => `${s.kind}:${s.value}`).join("|");
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

export default function RailSignals({ signals }: { signals: readonly RailSignal[] }) {
  const now = useNow(10_000);
  return (
    <>
      {signals.map((s) => {
        if (s.kind === "dot") {
          return (
            <span
              key={s.label}
              role="img"
              aria-label={s.label}
              data-tone={s.tone}
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[s.tone]}`}
            />
          );
        }
        if (s.kind === "age") {
          const age = now - s.value;
          const tone = s.staleAfterMs !== undefined && age > s.staleAfterMs ? "warn" : s.tone;
          return (
            <span key={s.label} aria-label={`${s.label}: ${formatAge(age)}`} data-tone={tone} className={`font-mono text-[12px] ${TONE_CLASS[tone]}`}>
              {formatAge(age)}
            </span>
          );
        }
        return (
          <span key={s.label} aria-label={`${s.label}: ${s.value}`} data-tone={s.tone} className={`font-mono text-[12px] ${TONE_CLASS[s.tone]}`}>
            {s.value}
          </span>
        );
      })}
    </>
  );
}
