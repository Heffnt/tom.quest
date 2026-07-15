// Config-sanitizer tests — the persisted-blob airlock. The page-refresh path
// runs every saved view config through sanitizePlotConfig, so per-layer glyph
// styling must survive it, an OLD-shape blob (settings/splitBy) must coerce to
// the pristine default, and the plot-level size/opacity must round-trip.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_PLOT, DEFAULT_LAYER_STYLE, DEFAULT_GROUP_EXTRAS,
  sanitizePlotConfig, sanitizeLayerStyle, sanitizeGroupExtras,
  isDefaultPlotConfig, nextLayerId,
} from "./types";

describe("sanitizeLayerStyle", () => {
  it("defaults a missing / non-object blob", () => {
    expect(sanitizeLayerStyle(undefined)).toEqual(DEFAULT_LAYER_STYLE);
    expect(sanitizeLayerStyle("nope")).toEqual(DEFAULT_LAYER_STYLE);
    expect(sanitizeLayerStyle([1, 2])).toEqual(DEFAULT_LAYER_STYLE);
  });

  it("keeps valid fields and heals invalid ones independently", () => {
    expect(sanitizeLayerStyle({ shape: 3, dash: 2 })).toEqual({ shape: 3, dash: 2 });
    expect(sanitizeLayerStyle({ shape: "square", dash: 2 })).toEqual({ shape: 0, dash: 2 });
  });

  it("clamps out-of-range values (>=0, rounded)", () => {
    const s = sanitizeLayerStyle({ shape: 2.6, dash: -3 });
    expect(s.shape).toBe(3); // rounded
    expect(s.dash).toBe(0); // floored at 0
  });
});

describe("nextLayerId", () => {
  it("returns the smallest unused l-id", () => {
    expect(nextLayerId([])).toBe("l1");
    expect(nextLayerId(["l1", "l3"])).toBe("l2");
    expect(nextLayerId(["l1", "l2"])).toBe("l3");
  });
});

describe("sanitizePlotConfig — layer style + plot-level size/opacity", () => {
  it("a styled layer round-trips a persisted-blob pass verbatim", () => {
    const cfg = sanitizePlotConfig({
      layers: [{
        id: "l1", name: "styled", color: "#38bdf8",
        style: { shape: 1, dash: 1 },
        filters: { facets: { dataset: ["sst2"] }, ranges: [] },
      }],
      size: 1.8,
      opacity: 0.4,
    });
    expect(cfg.layers[0].style).toEqual({ shape: 1, dash: 1 });
    expect(cfg.size).toBe(1.8);
    expect(cfg.opacity).toBe(0.4);
  });

  it("heals a missing style / size / opacity to defaults", () => {
    const cfg = sanitizePlotConfig({ layers: [{ id: "l1", name: "x", color: "#38bdf8" }] });
    expect(cfg.layers[0].style).toEqual(DEFAULT_LAYER_STYLE);
    expect(cfg.size).toBe(1);
    expect(cfg.opacity).toBe(1);
  });

  it("an OLD-shape blob (settings/splitBy) coerces to the pristine default", () => {
    // Exactly what an old saved boolback:plot blob looks like — no `layers`,
    // a `settings` array and a `splitBy`. It carries no current keys, so the
    // sanitizer drops it entirely and installs the default single layer.
    const old = {
      settings: [{ id: "s1", name: "all runs", color: "#e8a040", style: { shape: null, size: 2, opacity: 0.3, dash: 1 }, filters: { facets: {}, ranges: [] } }],
      splitBy: ["base_model"],
      x: "avg_sensitivity",
      y: "plantedness",
    };
    const cfg = sanitizePlotConfig(old);
    expect(cfg.layers).toEqual(DEFAULT_PLOT.layers);
    expect(cfg.x).toBe("epoch"); // old x dropped; DEFAULT wins
    // ...and the healed default is byte-for-byte pristine, so first-load
    // hydration may install the dominant-cell default.
    expect(isDefaultPlotConfig(cfg)).toBe(true);
  });

  it("a healed empty blob is the pristine default (key order preserved)", () => {
    expect(isDefaultPlotConfig(sanitizePlotConfig({}))).toBe(true);
    expect(isDefaultPlotConfig(sanitizePlotConfig(null))).toBe(true);
  });
});

describe("sanitizeGroupExtras", () => {
  it("defaults a missing / non-object blob", () => {
    expect(sanitizeGroupExtras(undefined)).toEqual(DEFAULT_GROUP_EXTRAS);
    expect(sanitizeGroupExtras("nope")).toEqual(DEFAULT_GROUP_EXTRAS);
  });

  it("keeps a facet (incl. the literal \"layer\") and a finite panelMin", () => {
    expect(sanitizeGroupExtras({ facet: "base_model", panelMin: 400 }))
      .toEqual({ facet: "base_model", panelMin: 400 });
    expect(sanitizeGroupExtras({ facet: "layer" }))
      .toEqual({ facet: "layer", panelMin: DEFAULT_GROUP_EXTRAS.panelMin });
  });

  it("an OLD fat group-plot blob keeps only the extras (facet), rest dropped", () => {
    const fat = { settings: [{ id: "s1" }], splitBy: [], x: "asr", facet: "seed", panelMin: 320, band: false };
    expect(sanitizeGroupExtras(fat)).toEqual({ facet: "seed", panelMin: 320 });
  });

  it("heals a non-numeric panelMin to the default", () => {
    expect(sanitizeGroupExtras({ facet: null, panelMin: "wide" }))
      .toEqual({ facet: null, panelMin: DEFAULT_GROUP_EXTRAS.panelMin });
  });
});
