"use client";

import { useEffect, useState } from "react";

// Returns a 0..1 progress value based on scroll position.
// 0 = fully undocked (hero layout), 1 = fully docked (terminal at top).
export function useDockProgress(threshold = 300): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const update = () => {
      const p = Math.min(1, Math.max(0, window.scrollY / threshold));
      setProgress(p);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [threshold]);

  return progress;
}
