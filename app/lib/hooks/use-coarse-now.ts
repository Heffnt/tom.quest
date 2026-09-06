import { useEffect, useState } from "react";

/** How often the coarse clock ticks. Countdowns and "ago" text on the TTS
 * surfaces are minute-grained, so a minute is as fine as they can show. */
export const COARSE_NOW_MS = 60_000;

/**
 * The clock at minute resolution: one `now` that holds between ticks.
 *
 * `Date.now()` read in render is a new number on every render, so a memo
 * that lists it as a dependency recomputes every time (the memo is defeated)
 * and a countdown built on it still never refreshes on its own — it only
 * moves when something else re-renders. A ticking state value gives the memo
 * a dependency that holds and the countdown a tick of its own.
 */
export function useCoarseNow(intervalMs: number = COARSE_NOW_MS): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
