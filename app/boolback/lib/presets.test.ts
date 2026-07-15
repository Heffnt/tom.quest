// presets tests — spec-based single-kind presets (Phase 5). Hydration must be
// tolerant (never throw, null on non-spec) and round-trip a saved view-spec.

import { describe, it, expect } from "vitest";
import { hydratePresetSpec, suggestPresetName, PRESET_SCHEMA_VERSION } from "./presets";
import { configToSpec, serializeSpec } from "./spec";
import { EMPTY_FILTER, DEFAULT_PLOT, type PlotConfig } from "./types";

describe("PRESET_SCHEMA_VERSION", () => {
  it("is bumped to the spec era", () => {
    expect(PRESET_SCHEMA_VERSION).toBe(3);
  });
});

describe("hydratePresetSpec", () => {
  it("round-trips a spec stored as an object", () => {
    const cfg: PlotConfig = { ...DEFAULT_PLOT, x: "arity", y: "asr", size: 1.5 };
    const spec = configToSpec("plot", cfg);
    expect(hydratePresetSpec(spec)).toEqual(spec);
  });

  it("round-trips a spec stored as a serialized string", () => {
    const spec = configToSpec("table", {
      filters: { facets: { judge: ["kw"] }, ranges: [] },
      visibleCols: ["function.arity"],
      columnWidths: {},
      sorts: [],
      search: "",
    });
    expect(hydratePresetSpec(serializeSpec(spec))).toEqual(spec);
  });

  it("returns null for legacy / malformed state without throwing", () => {
    expect(hydratePresetSpec({ filters: { facets: {} } })).toBeNull(); // legacy filters preset
    expect(hydratePresetSpec({ v: 2, view: "plot" })).toBeNull(); // wrong version
    expect(hydratePresetSpec(null)).toBeNull();
    expect(hydratePresetSpec("not json")).toBeNull();
    expect(() => hydratePresetSpec(undefined)).not.toThrow();
  });
});

describe("suggestPresetName", () => {
  it("draws from active facet values, falls back to 'view'", () => {
    expect(suggestPresetName(EMPTY_FILTER)).toBe("view");
    expect(suggestPresetName({ ...EMPTY_FILTER, facets: { base_model: ["llama-1b"], lr: ["0.001"] } }))
      .toBe("llama-1b · 0.001");
  });
});
