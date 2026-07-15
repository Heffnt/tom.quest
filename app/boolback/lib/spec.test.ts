// view-spec serialization tests (spec v4). Round-trips + tolerant parsing, over
// the layers-based plot config. specToConfig returns {view, plot?/table?, facet?}
// (the groupplot facet is a store extra, returned alongside the shared config).

import { describe, it, expect } from "vitest";
import { configToSpec, specToConfig, serializeSpec, parseSpec, type ViewSpec } from "./spec";
import {
  type PlotConfig,
  type TableConfig,
  DEFAULT_PLOT,
  DEFAULT_LAYER_STYLE,
} from "./types";
import { CATEGORY_PALETTE } from "./styling";

// A rich plot config: non-default axes, TWO layers with their own filters,
// plot-level ranges, plot-level size/opacity, log, flipped toggles. Layer ids
// are the sequential "l1"/"l2" the sanitizer regenerates, and display-only
// fields (xDomain, yDomain) stay at defaults, so the round-trip is exact.
const RICH_PLOT: PlotConfig = {
  ...DEFAULT_PLOT,
  layers: [
    {
      id: "l1",
      name: "classification",
      color: "#e8a040",
      style: { ...DEFAULT_LAYER_STYLE },
      filters: {
        facets: { dataset: ["sst2"], target_behavior: ["all-to-sentinel"] },
        ranges: [{ metric: "plantedness", min: 0.9, max: 1 }],
      },
    },
    {
      id: "l2",
      name: "jailbreak",
      color: "#38bdf8",
      style: { shape: 2, dash: 1 },
      filters: { facets: { dataset: ["anthropic"] }, ranges: [] },
    },
  ],
  ranges: [{ metric: "asr", min: 0.1, max: 1 }],
  colorBy: null,
  x: "fourier_degree",
  y: "asr",
  size: 1.5,
  opacity: 0.4,
  band: false,
  ghosts: false,
  trend: true,
  logX: true,
  logY: true,
};

describe("configToSpec / specToConfig round-trip", () => {
  it("is versioned v:4", () => {
    expect(configToSpec("plot", DEFAULT_PLOT).v).toBe(4);
  });

  it("reproduces a rich plot config (layers, plot-level ranges + size/opacity, layer style)", () => {
    const spec = configToSpec("plot", RICH_PLOT);
    expect(spec.layers).toEqual([
      {
        name: "classification",
        color: "#e8a040",
        facets: { dataset: ["sst2"], target_behavior: ["all-to-sentinel"] },
        ranges: [{ metric: "plantedness", min: 0.9, max: 1 }],
      },
      { name: "jailbreak", color: "#38bdf8", style: { shape: 2, dash: 1 }, facets: { dataset: ["anthropic"] } },
    ]);
    expect(spec.ranges).toEqual([{ metric: "asr", min: 0.1, max: 1 }]);
    expect(spec.size).toBe(1.5);
    expect(spec.opacity).toBe(0.4);
    expect(spec.log).toEqual(["x", "y"]);
    expect("color_by" in spec).toBe(false); // null colorBy omitted
    expect("split_by" in spec).toBe(false); // gone in v4

    const { view, plot } = specToConfig(spec);
    expect(view).toBe("plot");
    expect(plot).toEqual(RICH_PLOT); // ids regenerate as l1, l2 in order
  });

  it("a default-styled layer emits NO style key; a styled one emits only the non-defaults", () => {
    const cfg: PlotConfig = {
      ...DEFAULT_PLOT,
      layers: [
        { id: "l1", name: "plain", color: CATEGORY_PALETTE[1], style: { ...DEFAULT_LAYER_STYLE }, filters: { facets: {}, ranges: [] } },
        { id: "l2", name: "dashed", color: CATEGORY_PALETTE[2], style: { shape: 0, dash: 3 }, filters: { facets: {}, ranges: [] } },
      ],
    };
    const spec = configToSpec("plot", cfg);
    expect(spec.layers![0]).toEqual({ name: "plain", color: CATEGORY_PALETTE[1] });
    expect(spec.layers![1]).toEqual({ name: "dashed", color: CATEGORY_PALETTE[2], style: { dash: 3 } });
    expect(specToConfig(spec).plot).toEqual(cfg); // style default-fills back
  });

  it("round-trips a colorBy config", () => {
    const cfg: PlotConfig = { ...DEFAULT_PLOT, colorBy: "avg_sensitivity" };
    const spec = configToSpec("plot", cfg);
    expect(spec.color_by).toBe("avg_sensitivity");
    expect(specToConfig(spec).plot).toEqual(cfg);
  });

  it("serializes a default plot to a tiny spec (default layer omitted)", () => {
    expect(configToSpec("plot", DEFAULT_PLOT)).toEqual({ v: 4, view: "plot" });
    const { plot } = specToConfig({ v: 4, view: "plot" });
    expect(plot).toEqual(DEFAULT_PLOT);
  });

  it("a renamed-but-unfiltered single layer still serializes (not the default)", () => {
    const cfg: PlotConfig = {
      ...DEFAULT_PLOT,
      layers: [{ id: "l1", name: "everything", color: CATEGORY_PALETTE[0], style: { ...DEFAULT_LAYER_STYLE }, filters: { facets: {}, ranges: [] } }],
    };
    const spec = configToSpec("plot", cfg);
    expect(spec.layers).toEqual([{ name: "everything", color: CATEGORY_PALETTE[0] }]);
    expect(specToConfig(spec).plot).toEqual(cfg);
  });

  it("groupplot = the shared plot fields + a facet (may be the literal \"layer\")", () => {
    const spec = configToSpec("groupplot", RICH_PLOT, "layer");
    expect(spec.facet).toBe("layer");
    expect("panel_min" in spec).toBe(false); // panelMin is a store extra, never serialized
    expect(spec.layers).toBeDefined(); // shared plot fields carried

    const { view, plot, facet } = specToConfig(spec);
    expect(view).toBe("groupplot");
    expect(plot).toEqual(RICH_PLOT); // same shared config
    expect(facet).toBe("layer");
  });

  it("a groupplot with a null facet omits it and hydrates facet null", () => {
    const spec = configToSpec("groupplot", DEFAULT_PLOT, null);
    expect("facet" in spec).toBe(false);
    expect(specToConfig(spec).facet).toBeNull();
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
    expect(spec.x).toBeUndefined();
    expect(spec.layers).toBeUndefined();

    const { view, table: out } = specToConfig(spec);
    expect(view).toBe("table");
    expect(out).toEqual({ ...table, search: "", columnWidths: {} });
  });
});

describe("serializeSpec / parseSpec round-trip", () => {
  it("round-trips a plot spec through pretty JSON", () => {
    const spec = configToSpec("plot", RICH_PLOT);
    const text = serializeSpec(spec);
    expect(text).toContain("\n"); // pretty-printed
    expect(parseSpec(text)).toEqual(spec);
  });

  it("round-trips a groupplot spec (facet preserved)", () => {
    const spec = configToSpec("groupplot", RICH_PLOT, "seed");
    expect(parseSpec(serializeSpec(spec))).toEqual(spec);
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
      v: 4, view: "plot",
      layers: [{ name: "s", facets: { judge: ["kw"], base_model: ["x"] } }],
    };
    const b: ViewSpec = {
      v: 4, view: "plot",
      layers: [{ name: "s", facets: { base_model: ["x"], judge: ["kw"] } }],
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

  it("REQUIRES v===4 (a v3 spec is rejected — no back-compat)", () => {
    expect(parseSpec(JSON.stringify({ v: 3, view: "plot" }))).toBeNull();
    expect(parseSpec(JSON.stringify({ v: 2, view: "plot" }))).toBeNull();
    expect(parseSpec(JSON.stringify({ view: "plot" }))).toBeNull();
  });

  it("returns null on missing / bad view", () => {
    expect(parseSpec(JSON.stringify({ v: 4 }))).toBeNull();
    expect(parseSpec(JSON.stringify({ v: 4, view: "scatter" }))).toBeNull();
    expect(parseSpec(JSON.stringify({ v: 4, view: 5 }))).toBeNull();
  });

  it("tolerates and drops unknown / wrong-typed fields (retired keys included)", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 4,
        view: "plot",
        x: "asr",
        y: 999, // wrong type -> dropped
        wat: { anything: true }, // unknown -> ignored
        log: ["x", "bogus"], // bogus axis filtered out
        band: "yes", // wrong type -> dropped
        split_by: ["base_model"], // retired key -> ignored
        size: "big", // wrong type -> dropped
        filters: { dataset: ["sst2"] }, // table-only key on a plot -> ignored
      }),
    );
    expect(spec).not.toBeNull();
    expect(spec!.x).toBe("asr");
    expect(spec!.y).toBeUndefined();
    expect(spec!.log).toEqual(["x"]);
    expect(spec!.band).toBeUndefined();
    expect(spec!.size).toBeUndefined();
    expect("wat" in spec!).toBe(false);
    expect("split_by" in spec!).toBe(false);
    expect(spec!.filters).toBeUndefined();
    // ...and a spec with no layers hydrates to the default single layer.
    const { plot } = specToConfig(spec!);
    expect(plot!.layers).toEqual(DEFAULT_PLOT.layers);
  });

  it("preserves unknown data-driven parameter keys inside layer facets", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 4,
        view: "plot",
        layers: [{ name: "future", facets: { some_future_param: ["v1"], "": ["kept"] } }],
      }),
    );
    expect(spec!.layers).toEqual([
      { name: "future", facets: { some_future_param: ["v1"], "": ["kept"] } },
    ]);
    const { plot } = specToConfig(spec!);
    expect(plot!.layers).toHaveLength(1);
    expect(plot!.layers[0].id).toBe("l1");
    expect(plot!.layers[0].name).toBe("future");
    expect(plot!.layers[0].color).toBe(CATEGORY_PALETTE[0]); // missing color coerced
    expect(plot!.layers[0].filters.facets).toEqual({ some_future_param: ["v1"], "": ["kept"] });
  });

  it("drops malformed layers/ranges entries without throwing", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 4,
        view: "plot",
        layers: [
          { name: "ok", ranges: [{ metric: "asr", min: 0, max: 1 }, { metric: "x", min: "lo", max: 1 }] },
          { color: "#123456" }, // no name -> dropped
          "garbage", // not an object -> dropped
        ],
        ranges: [{ metric: "asr", min: 0, max: 1 }, { metric: "x", min: "lo", max: 1 }],
      }),
    );
    expect(spec!.layers).toEqual([
      { name: "ok", ranges: [{ metric: "asr", min: 0, max: 1 }] },
    ]);
    expect(spec!.ranges).toEqual([{ metric: "asr", min: 0, max: 1 }]);
  });
});
