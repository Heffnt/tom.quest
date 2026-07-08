// presets loader tests — tolerant hydration must never throw and must apply
// malformed/stale presets partially.

import { describe, it, expect } from "vitest";
import { hydratePreset, sanitizeFilters, suggestPresetName } from "./presets";
import { EMPTY_FILTER, DEFAULT_PLOT, DEFAULT_GROUP_PLOT } from "./types";

const COLS = ["function.arity", "headline.plantedness"];

describe("sanitizeFilters", () => {
  it("coerces garbage to a slim FilterState (facets + ranges only)", () => {
    expect(sanitizeFilters(null)).toEqual(EMPTY_FILTER);
    expect(sanitizeFilters({ facets: [1, 2], ranges: "x", status: null, search: 5 }))
      .toEqual({ facets: {}, ranges: [] });
    expect(sanitizeFilters({ facets: { lr: ["0.001"] }, ranges: [{ metric: "asr", min: 0, max: 1 }] }))
      .toEqual({ facets: { lr: ["0.001"] }, ranges: [{ metric: "asr", min: 0, max: 1 }] });
  });
});

describe("hydratePreset", () => {
  it("filters kind yields only the active view's filters", () => {
    const h = hydratePreset("filters", { filters: { facets: { lr: ["0.001"] } } }, COLS);
    expect(h.kind).toBe("filters");
    if (h.kind === "filters") expect(h.filters.facets).toEqual({ lr: ["0.001"] });
  });

  it("view kind sanitizes all three per-view configs + maps legacy centerView", () => {
    const h = hydratePreset("view", {
      centerView: "chart", // legacy → plot
      table: { visibleCols: ["function.arity"], sorts: [{ col: "headline.asr", dir: "desc" }] },
      plot: { x: "arity", y: "asr", splits: ["base_model"] },
      groupPlot: { facet: "trigger_form", panelMin: 320 },
    }, COLS);
    expect(h.kind).toBe("view");
    if (h.kind !== "view") return;
    expect(h.centerView).toBe("plot");
    expect(h.table.visibleCols).toEqual(["function.arity"]);
    expect(h.table.sorts).toEqual([{ col: "headline.asr", dir: "desc" }]);
    expect(h.plot.x).toBe("arity");
    expect(h.plot.splits).toEqual(["base_model"]);
    expect(h.groupPlot.facet).toBe("trigger_form");
    expect(h.groupPlot.panelMin).toBe(320);
  });

  it("a hand-corrupted view preset applies partially without throwing", () => {
    const corrupt = { centerView: "bogus", table: 42, plot: "nope", groupPlot: null };
    const h = hydratePreset("view", corrupt, COLS);
    expect(h.kind).toBe("view");
    if (h.kind !== "view") return;
    expect(h.centerView).toBeNull();
    expect(h.table.visibleCols).toEqual(COLS); // fallback
    expect(h.plot).toEqual(DEFAULT_PLOT);
    expect(h.groupPlot).toEqual(DEFAULT_GROUP_PLOT);
  });

  it("tolerates a completely empty / non-object state", () => {
    expect(() => hydratePreset("view", undefined, COLS)).not.toThrow();
    const h = hydratePreset("filters", "junk", COLS);
    if (h.kind === "filters") expect(h.filters).toEqual(EMPTY_FILTER);
  });
});

describe("suggestPresetName", () => {
  it("draws from active facet values, falls back to 'preset'", () => {
    expect(suggestPresetName(EMPTY_FILTER)).toBe("preset");
    expect(suggestPresetName({ ...EMPTY_FILTER, facets: { base_model: ["llama-1b"], lr: ["0.001"] } }))
      .toBe("llama-1b · 0.001");
  });
});
