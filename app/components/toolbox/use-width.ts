"use client";

// The width a figure is drawn at. A figure's viewBox is its measured width in
// CSS pixels, so a 13 px label is 13 px at every width (principle 7) instead of
// shrinking with the page. The width is read once on mount and again when the
// container resizes; nothing a reader presses changes it.

import { useEffect, useRef, useState } from "react";

/** Before the first measure, and wherever nothing can measure (a test). */
const UNMEASURED = 820;

export function useWidth<T extends Element>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(UNMEASURED);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry.contentRect.width);
      if (next > 0) setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** An estimate of how wide a line of text is at the toolbox's smallest size
 *  (13 px): IBM Plex Sans averages 0.55 em a character, Plex Mono 0.6 em. */
export function textWidth(text: string, mono?: boolean): number {
  return text.length * (mono ? 7.8 : 7.2);
}
