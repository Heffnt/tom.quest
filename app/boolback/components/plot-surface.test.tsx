// plot-surface trend tests — the per-series OLS mode: >= 2 trendSeries on the
// FULL surface draw one line per series (pooled suppressed); a single series
// keeps the pooled line; a degenerate series (no x variance) is skipped; and
// compact surfaces ALWAYS keep the pooled per-panel fit + `r=` corner.

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { RunRow } from "../lib/types";
import { PlotSurface, type SurfaceTrendSeries } from "./plot-surface";

const SIZE = { W: 200, H: 100, pad: { l: 10, r: 10, t: 10, b: 10 } };
const SCALE = {
  sx: (v: number) => v,
  sy: (v: number) => v,
  xTicks: [], yTicks: [],
  xTickLabel: () => "", yTickLabel: () => "",
};
const CONFIG = { band: false, ghosts: false, trend: true, size: 1, opacity: 1 };

const PAIRS = [
  { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 2.5 }, { x: 4, y: 4 },
];
const tSeries = (key: string, pairs = PAIRS): SurfaceTrendSeries => ({
  key, color: "#aa0000", dash: "", pairs,
});

const mount = (over: Partial<React.ComponentProps<typeof PlotSurface>> = {}) =>
  render(
    <PlotSurface
      mode="scatter"
      size={SIZE}
      scale={SCALE}
      config={CONFIG}
      pairs={PAIRS}
      rowByRunId={new Map<string, RunRow>()}
      {...over}
    />,
  );

const count = (c: HTMLElement, id: string) => c.querySelectorAll(`[data-testid="${id}"]`).length;

describe("PlotSurface trend", () => {
  it("a single series keeps the pooled line (unchanged) — no per-series lines", () => {
    const { container } = mount({ trendSeries: [tSeries("l1")] });
    expect(count(container, "trend-pooled")).toBe(1);
    expect(count(container, "trend-series")).toBe(0);
  });

  it(">= 2 series draw one line PER series and the pooled line is NOT drawn", () => {
    const { container } = mount({
      trendSeries: [tSeries("l1"), tSeries("l2", [{ x: 0, y: 3 }, { x: 5, y: 0 }])],
    });
    expect(count(container, "trend-series")).toBe(2);
    expect(count(container, "trend-pooled")).toBe(0);
    // stroked in the series color, honoring width/opacity
    const line = container.querySelector('[data-testid="trend-series"]')!;
    expect(line.getAttribute("stroke")).toBe("#aa0000");
    expect(line.getAttribute("stroke-width")).toBe("1.25");
  });

  it("skips a series with < 2 distinct x values (same guard as the pooled fit)", () => {
    const { container } = mount({
      trendSeries: [tSeries("l1"), tSeries("flat", [{ x: 2, y: 1 }, { x: 2, y: 9 }])],
    });
    expect(count(container, "trend-series")).toBe(1); // "flat" skipped
    expect(count(container, "trend-pooled")).toBe(0); // still per-series mode
  });

  it("compact surfaces keep the pooled per-panel fit + r corner even with many series", () => {
    const { container } = mount({
      compact: true,
      trendSeries: [tSeries("l1"), tSeries("l2")],
    });
    expect(count(container, "trend-pooled")).toBe(1);
    expect(count(container, "trend-series")).toBe(0);
    expect(container.textContent).toContain("r=");
  });

  it("trend off draws nothing", () => {
    const { container } = mount({
      config: { ...CONFIG, trend: false },
      trendSeries: [tSeries("l1"), tSeries("l2")],
    });
    expect(count(container, "trend-pooled")).toBe(0);
    expect(count(container, "trend-series")).toBe(0);
  });
});
