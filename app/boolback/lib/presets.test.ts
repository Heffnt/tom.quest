// presets loader tests — tolerant hydration must never throw and must apply
// malformed/stale presets partially.

import { describe, it, expect } from "vitest";
import { hydratePreset, sanitizeFilters, suggestPresetName } from "./presets";
import { EMPTY_FILTER } from "./types";

const COLS = ["function.arity", "headline.plantedness"];

describe("sanitizeFilters", () => {
  it("coerces garbage to a complete FilterState", () => {
    expect(sanitizeFilters(null)).toEqual(EMPTY_FILTER);
    expect(sanitizeFilters({ facets: [1, 2], ranges: "x", status: null, subtreeDirs: [1, "ok"], search: 5 }))
      .toEqual({ facets: {}, ranges: [], status: [], subtreeDirs: ["ok"], search: "" });
  });
});

describe("hydratePreset", () => {
  it("filters kind yields only filters (deep-merged onto defaults)", () => {
    const h = hydratePreset("filters", { filters: { facets: { lr: ["0.001"] } }, chart: { x: "asr" } }, COLS);
    expect(h.filters.facets).toEqual({ lr: ["0.001"] });
    expect(h.filters.search).toBe(""); // defaulted
    expect(h.chart).toBeUndefined(); // filter sets never touch the chart
  });

  it("view kind migrates the chart and defaults missing fields", () => {
    const h = hydratePreset("view", {
      filters: { search: "hi" },
      chart: { x: "arity", y: "asr", dims: { baseModel: "color" }, logX: false, logY: false, trend: false },
      sorts: [{ col: "headline.asr", dir: "desc" }],
      centerView: "chart", // legacy → plot
    }, COLS);
    expect(h.chart?.v).toBe(2);
    expect(h.chart?.splits).toEqual(["baseModel"]);
    expect(h.centerView).toBe("plot");
    expect(h.visibleCols).toEqual(COLS); // missing → fallback
    expect(h.sorts).toEqual([{ col: "headline.asr", dir: "desc" }]);
  });

  it("a hand-corrupted preset applies partially without throwing", () => {
    const corrupt = { filters: null, chart: "nope", sorts: 42, visibleCols: {}, centerView: "bogus" };
    const h = hydratePreset("view", corrupt, COLS);
    expect(h.filters).toEqual(EMPTY_FILTER);
    expect(h.chart?.v).toBe(2); // migrateChart("nope") → defaults
    expect(h.sorts).toEqual([]);
    expect(h.visibleCols).toEqual(COLS);
    expect(h.centerView).toBeUndefined();
  });

  it("tolerates a completely empty / non-object state", () => {
    expect(() => hydratePreset("view", undefined, COLS)).not.toThrow();
    expect(hydratePreset("filters", "junk", COLS).filters).toEqual(EMPTY_FILTER);
  });
});

describe("suggestPresetName", () => {
  it("draws from active facet values, falls back to 'preset'", () => {
    expect(suggestPresetName(EMPTY_FILTER)).toBe("preset");
    expect(suggestPresetName({ ...EMPTY_FILTER, facets: { baseModel: ["llama-1b"], lr: ["0.001"] } }))
      .toBe("llama-1b · 0.001");
  });
});
