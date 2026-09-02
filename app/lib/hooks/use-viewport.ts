"use client";

import { useEffect, useState } from "react";

/** The browser window size, or null on the server and until the first
 *  measurement lands. Callers supply their own value for the null case,
 *  because the right thing to show before measuring differs per call site:
 *  home-client keeps its small hero logo, nav-term and game-client keep the
 *  desktop dimensions their server HTML has always been rendered with.
 *
 *  DANGER: changing a caller's null fallback changes the first paint of that
 *  page, which is the only thing a hard refresh shows until hydration runs.
 *  A fallback that implies a different layout from the real measurement is a
 *  visible jump on load, and nothing logs it. */
export type Viewport = { width: number; height: number } | null;

export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(null);
  useEffect(() => {
    const measure = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return viewport;
}
