"use client";

// app/boolback/lib/use-viewport.ts
// SSR-safe viewport-width hook, mirroring nav-term's useViewportWidth: the
// initial value is a fixed desktop width on both the server and the first
// client render (so hydration matches) and the real width is read inside an
// effect with a resize listener.

import { useEffect, useState } from "react";

export function useViewportWidth(): number {
  const [width, setWidth] = useState<number>(1280);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}
