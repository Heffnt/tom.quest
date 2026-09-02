// Regression tests for the null sentinel in useViewport. Every caller writes
// its own pre-hydration fallback for the null case (nav-term 1024, home-client
// null, debug-panel "unknown", game-client 1024x768), and those fallbacks are
// what the server HTML and the first paint are made of. If the hook ever
// returned a measured-looking value before the effect runs, the server render
// and the first client render would disagree and every caller's first paint
// would change without anything failing.

import { describe, it, expect, afterEach } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { useViewport, type Viewport } from "./use-viewport";

function renderProbe() {
  const seen: Viewport[] = [];
  function Probe() {
    seen.push(useViewport());
    return null;
  }
  render(<Probe />);
  return seen;
}

function resizeWindowTo(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

describe("useViewport", () => {
  afterEach(cleanup);

  it("returns null on the first render, before any measurement", () => {
    const seen = renderProbe();
    expect(seen[0]).toBeNull();
  });

  it("returns the measured window size once the effect has run", () => {
    resizeWindowTo(1280, 800);
    const seen = renderProbe();
    expect(seen[seen.length - 1]).toEqual({ width: 1280, height: 800 });
  });

  it("re-measures on resize", () => {
    const seen = renderProbe();
    resizeWindowTo(375, 812);
    expect(seen[seen.length - 1]).toEqual({ width: 375, height: 812 });
  });
});
