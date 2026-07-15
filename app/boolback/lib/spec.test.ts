// view-spec serialization tests (Phase 5). Round-trips + tolerant parsing,
// over the settings-based plot config.

import { describe, it, expect } from "vitest";
import { configToSpec, specToConfig, serializeSpec, parseSpec, type ViewSpec } from "./spec";
import {
  type GroupPlotConfig,
  type PlotConfig,
  type TableConfig,
  DEFAULT_PLOT,
  DEFAULT_GROUP_PLOT,
  DEFAULT_SETTING_STYLE,
} from "./types";
import { CATEGORY_PALETTE } from "./styling";

// A rich plot config: non-default axes, TWO settings with their own filters,
// a splitBy, plot-level ranges, log, flipped toggles. Setting ids are the
// sequential "s1"/"s2" the sanitizer regenerates, and display-only fields
// (xDomain, yDomain) stay at defaults, so the round-trip is an exact
// deep-equal.
const RICH_PLOT: PlotConfig = {
  ...DEFAULT_PLOT,
  settings: [
    {
      id: "s1",
      name: "classification",
      color: "#e8a040",
      style: { ...DEFAULT_SETTING_STYLE },
      filters: {
        facets: { dataset: ["sst2"], target_behavior: ["all-to-sentinel"] },
        ranges: [{ metric: "plantedness", min: 0.9, max: 1 }],
      },
    },
    {
      id: "s2",
      name: "jailbreak",
      color: "#38bdf8",
      style: { ...DEFAULT_SETTING_STYLE },
      filters: { facets: { dataset: ["anthropic"] }, ranges: [] },
    },
  ],
  ranges: [{ metric: "asr", min: 0.1, max: 1 }],
  splitBy: ["base_model", "seed"],
  colorBy: null,
  x: "fourier_degree",
  y: "asr",
  band: false,
  ghosts: false,
  trend: true,
  logX: true,
  logY: true,
};

describe("configToSpec / specToConfig round-trip", () => {
  it("reproduces a rich plot config (settings, split_by, plot-level ranges)", () => {
    const spec = configToSpec("plot", RICH_PLOT);
    expect(spec.settings).toEqual([
      {
        name: "classification",
        color: "#e8a040",
        facets: { dataset: ["sst2"], target_behavior: ["all-to-sentinel"] },
        ranges: [{ metric: "plantedness", min: 0.9, max: 1 }],
      },
      { name: "jailbreak", color: "#38bdf8", facets: { dataset: ["anthropic"] } },
    ]);
    expect(spec.split_by).toEqual(["base_model", "seed"]);
    expect(spec.ranges).toEqual([{ metric: "asr", min: 0.1, max: 1 }]);
    expect(spec.log).toEqual(["x", "y"]);
    expect("color_by" in spec).toBe(false); // null colorBy omitted

    const { view, config } = specToConfig(spec);
    expect(view).toBe("plot");
    expect(config).toEqual(RICH_PLOT); // ids regenerate as s1, s2 in order
  });

  it("round-trips a styled setting (non-default fields only in the spec)", () => {
    const cfg: PlotConfig = {
      ...DEFAULT_PLOT,
      settings: [{
        id: "s1", name: "styled", color: "#38bdf8",
        style: { shape: 3, size: 1.5, opacity: 0.4, dash: 2 },
        filters: { facets: {}, ranges: [] },
      }],
    };
    const spec = configToSpec("plot", cfg);
    expect(spec.settings).toEqual([
      { name: "styled", color: "#38bdf8", style: { shape: 3, size: 1.5, opacity: 0.4, dash: 2 } },
    ]);
    expect(specToConfig(spec).config).toEqual(cfg);
    // ...and it survives the pretty-JSON round trip (Copy/Paste, presets).
    expect(parseSpec(serializeSpec(spec))).toEqual(spec);
  });

  it("a default-styled setting emits NO style key", () => {
    const cfg: PlotConfig = {
      ...DEFAULT_PLOT,
      settings: [{
        id: "s1", name: "plain", color: CATEGORY_PALETTE[1],
        style: { ...DEFAULT_SETTING_STYLE },
        filters: { facets: {}, ranges: [] },
      }],
    };
    const spec = configToSpec("plot", cfg);
    expect(spec.settings![0]).toEqual({ name: "plain", color: CATEGORY_PALETTE[1] });
    expect(specToConfig(spec).config).toEqual(cfg); // style default-fills back
  });

  it("round-trips a colorBy config", () => {
    const cfg: PlotConfig = { ...DEFAULT_PLOT, colorBy: "avg_sensitivity" };
    const spec = configToSpec("plot", cfg);
    expect(spec.color_by).toBe("avg_sensitivity");
    expect(specToConfig(spec).config).toEqual(cfg);
  });

  it("serializes a default plot to a tiny spec (default setting omitted)", () => {
    expect(configToSpec("plot", DEFAULT_PLOT)).toEqual({ v: 3, view: "plot" });
    // ...and a tiny spec re-hydrates to the full default config.
    const { config } = specToConfig({ v: 3, view: "plot" });
    expect(config).toEqual(DEFAULT_PLOT);
  });

  it("a renamed-but-unfiltered single setting still serializes (not the default)", () => {
    const cfg: PlotConfig = {
      ...DEFAULT_PLOT,
      settings: [{ id: "s1", name: "everything", color: CATEGORY_PALETTE[0], style: { ...DEFAULT_SETTING_STYLE }, filters: { facets: {}, ranges: [] } }],
    };
    const spec = configToSpec("plot", cfg);
    expect(spec.settings).toEqual([{ name: "everything", color: CATEGORY_PALETTE[0] }]);
    expect(specToConfig(spec).config).toEqual(cfg);
  });

  it("reproduces a groupplot config (facet may be the literal \"setting\"), panelMin default-filled", () => {
    const group: GroupPlotConfig = {
      ...RICH_PLOT,
      facet: "setting",
      panelMin: 350, // non-default; NOT carried by the spec
    };
    const spec = configToSpec("groupplot", group);
    expect(spec.facet).toBe("setting");
    expect("panel_min" in spec).toBe(false); // deliberately absent

    const { view, config } = specToConfig(spec);
    expect(view).toBe("groupplot");
    // facet round-trips; panelMin falls back to the default (280).
    expect(config).toEqual({ ...group, panelMin: DEFAULT_GROUP_PLOT.panelMin });
  });

  it("reproduces a table config, but search + columnWidths are default-filled", () => {
    const table: TableConfig = {
      filters: {
        facets: { dataset: ["sst2"] },
        ranges: [{ metric: "asr", min: 0, max: 0.5 }],
      },
      visibleCols: ["function.arity", "headline.asr"],
      columnWidths: { "function.arity": 120 }, // NOT carried
      sorts: [{ col: "headline.asr", dir: "desc" }],
      search: "fn=ab", // NOT carried
    };
    const spec = configToSpec("table", table);
    expect(spec.columns).toEqual(["function.arity", "headline.asr"]);
    expect(spec.sorts).toEqual([{ col: "headline.asr", dir: "desc" }]);
    // no plot-only keys leaked in
    expect(spec.x).toBeUndefined();
    expect(spec.settings).toBeUndefined();
    expect(spec.split_by).toBeUndefined();

    const { view, config } = specToConfig(spec);
    expect(view).toBe("table");
    expect(config).toEqual({ ...table, search: "", columnWidths: {} });
  });
});

describe("serializeSpec / parseSpec round-trip", () => {
  it("round-trips a plot spec through pretty JSON", () => {
    const spec = configToSpec("plot", RICH_PLOT);
    const text = serializeSpec(spec);
    expect(text).toContain("\n"); // pretty-printed
    expect(parseSpec(text)).toEqual(spec);
  });

  it("round-trips a table spec", () => {
    const table: TableConfig = {
      filters: { facets: { judge: ["kw", "llm"] }, ranges: [] },
      visibleCols: ["function.arity"],
      columnWidths: {},
      sorts: [{ col: "function.arity", dir: "asc" }],
      search: "",
    };
    const spec = configToSpec("table", table);
    expect(parseSpec(serializeSpec(spec))).toEqual(spec);
  });

  it("produces stable (deterministic) output regardless of facet key order", () => {
    const a: ViewSpec = {
      v: 3, view: "plot",
      settings: [{ name: "s", facets: { judge: ["kw"], base_model: ["x"] } }],
    };
    const b: ViewSpec = {
      v: 3, view: "plot",
      settings: [{ name: "s", facets: { base_model: ["x"], judge: ["kw"] } }],
    };
    expect(serializeSpec(a)).toBe(serializeSpec(b));
  });
});

describe("parseSpec tolerance", () => {
  it("returns null on non-JSON", () => {
    expect(parseSpec("{not valid json")).toBeNull();
    expect(parseSpec("")).toBeNull();
    expect(parseSpec("42")).toBeNull();
    expect(parseSpec("[1,2,3]")).toBeNull();
  });

  it("returns null on wrong version", () => {
    expect(parseSpec(JSON.stringify({ v: 2, view: "plot" }))).toBeNull();
    expect(parseSpec(JSON.stringify({ view: "plot" }))).toBeNull();
  });

  it("returns null on missing / bad view", () => {
    expect(parseSpec(JSON.stringify({ v: 3 }))).toBeNull();
    expect(parseSpec(JSON.stringify({ v: 3, view: "scatter" }))).toBeNull();
    expect(parseSpec(JSON.stringify({ v: 3, view: 5 }))).toBeNull();
  });

  it("tolerates and drops unknown / wrong-typed fields (old spec keys included)", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 3,
        view: "plot",
        x: "asr",
        y: 999, // wrong type -> dropped
        wat: { anything: true }, // unknown -> ignored
        log: ["x", "bogus"], // bogus axis filtered out
        band: "yes", // wrong type -> dropped
        color_param: "base_model", // retired key -> ignored
        shape_param: "seed", // retired key -> ignored
        filters: { dataset: ["sst2"] }, // table-only key on a plot -> ignored
      }),
    );
    expect(spec).not.toBeNull();
    expect(spec!.x).toBe("asr");
    expect(spec!.y).toBeUndefined();
    expect(spec!.log).toEqual(["x"]);
    expect(spec!.band).toBeUndefined();
    expect("wat" in spec!).toBe(false);
    expect("color_param" in spec!).toBe(false);
    expect(spec!.filters).toBeUndefined();
    // ...and a spec with no settings hydrates to the default single setting.
    const { config } = specToConfig(spec!);
    expect((config as PlotConfig).settings).toEqual(DEFAULT_PLOT.settings);
  });

  it("preserves unknown data-driven parameter keys inside settings + split_by", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 3,
        view: "plot",
        settings: [{ name: "future", facets: { some_future_param: ["v1"], "": ["kept"] } }],
        split_by: ["brand_new_param"],
      }),
    );
    expect(spec!.settings).toEqual([
      { name: "future", facets: { some_future_param: ["v1"], "": ["kept"] } },
    ]);
    expect(spec!.split_by).toEqual(["brand_new_param"]);
    // and it flows back into a valid config (id + palette color filled in)
    const { config } = specToConfig(spec!);
    const cfg = config as PlotConfig;
    expect(cfg.splitBy).toEqual(["brand_new_param"]);
    expect(cfg.settings).toHaveLength(1);
    expect(cfg.settings[0].id).toBe("s1");
    expect(cfg.settings[0].name).toBe("future");
    expect(cfg.settings[0].color).toBe(CATEGORY_PALETTE[0]); // missing color coerced
    expect(cfg.settings[0].filters.facets).toEqual({ some_future_param: ["v1"], "": ["kept"] });
  });

  it("drops malformed settings/ranges entries without throwing", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 3,
        view: "plot",
        settings: [
          { name: "ok", ranges: [{ metric: "asr", min: 0, max: 1 }, { metric: "x", min: "lo", max: 1 }] },
          { color: "#123456" }, // no name -> dropped
          "garbage", // not an object -> dropped
        ],
        ranges: [{ metric: "asr", min: 0, max: 1 }, { metric: "x", min: "lo", max: 1 }],
      }),
    );
    expect(spec!.settings).toEqual([
      { name: "ok", ranges: [{ metric: "asr", min: 0, max: 1 }] },
    ]);
    expect(spec!.ranges).toEqual([{ metric: "asr", min: 0, max: 1 }]);
  });
});
