// view-spec serialization tests (Phase 5). Round-trips + tolerant parsing.

import { describe, it, expect } from "vitest";
import { configToSpec, specToConfig, serializeSpec, parseSpec, type ViewSpec } from "./spec";
import {
  type GroupPlotConfig,
  type PlotConfig,
  type TableConfig,
  DEFAULT_PLOT,
  DEFAULT_GROUP_PLOT,
} from "./types";

// A rich plot config: non-default axes, mixed channel + bins splits, colorBy,
// ranges, log, facets, flipped toggles. Display-only fields (valueStyles,
// xDomain, yDomain) left at defaults so the round-trip is an exact deep-equal.
const RICH_PLOT: PlotConfig = {
  ...DEFAULT_PLOT,
  filters: {
    facets: { base_model: ["Llama-3.2-1B"], judge: ["kw"] },
    ranges: [{ metric: "plantedness", min: 0.9, max: 1 }],
  },
  x: "fourier_degree",
  y: "asr",
  splits: ["arity", "fourier_degree", "base_model"],
  channels: { arity: "shape", base_model: "color" },
  bins: { fourier_degree: { n: 4, method: "quantile" } },
  colorBy: "avg_sensitivity",
  band: false,
  ghosts: false,
  trend: true,
  logX: true,
  logY: true,
};

describe("configToSpec / specToConfig round-trip", () => {
  it("reproduces a rich plot config", () => {
    const spec = configToSpec("plot", RICH_PLOT);
    // split[] merges the ordered splits with channels/bins, order preserved.
    expect(spec.split).toEqual([
      { param: "arity", channel: "shape" },
      { param: "fourier_degree", bins: { n: 4, method: "quantile" } },
      { param: "base_model", channel: "color" },
    ]);
    expect(spec.log).toEqual(["x", "y"]);
    expect(spec.color_by).toBe("avg_sensitivity");

    const { view, config } = specToConfig(spec);
    expect(view).toBe("plot");
    expect(config).toEqual(RICH_PLOT);
  });

  it("serializes a default plot to a tiny spec", () => {
    expect(configToSpec("plot", DEFAULT_PLOT)).toEqual({ v: 3, view: "plot" });
    // ...and a tiny spec re-hydrates to the full default config.
    const { config } = specToConfig({ v: 3, view: "plot" });
    expect(config).toEqual(DEFAULT_PLOT);
  });

  it("reproduces a groupplot config, but panelMin is default-filled (display-only)", () => {
    const group: GroupPlotConfig = {
      ...RICH_PLOT,
      facet: "trigger_form",
      panelMin: 350, // non-default; NOT carried by the spec
    };
    const spec = configToSpec("groupplot", group);
    expect(spec.facet).toBe("trigger_form");
    expect("panel_min" in spec).toBe(false); // deliberately absent

    const { view, config } = specToConfig(spec);
    expect(view).toBe("groupplot");
    // facet round-trips; panelMin falls back to the default (280).
    expect(config).toEqual({ ...group, panelMin: DEFAULT_GROUP_PLOT.panelMin });
  });

  it("reproduces a table config, but search + columnWidths are default-filled", () => {
    const table: TableConfig = {
      filters: {
        facets: { task: ["classify"] },
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
    expect(spec.split).toBeUndefined();

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
    const a: ViewSpec = { v: 3, view: "plot", filters: { judge: ["kw"], base_model: ["x"] } };
    const b: ViewSpec = { v: 3, view: "plot", filters: { base_model: ["x"], judge: ["kw"] } };
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

  it("tolerates and drops unknown / wrong-typed fields", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 3,
        view: "plot",
        x: "asr",
        y: 999, // wrong type -> dropped
        wat: { anything: true }, // unknown -> ignored
        log: ["x", "bogus"], // bogus axis filtered out
        band: "yes", // wrong type -> dropped
      }),
    );
    expect(spec).not.toBeNull();
    expect(spec!.x).toBe("asr");
    expect(spec!.y).toBeUndefined();
    expect(spec!.log).toEqual(["x"]);
    expect(spec!.band).toBeUndefined();
    expect("wat" in spec!).toBe(false);
  });

  it("preserves unknown data-driven parameter keys (never enum-validated)", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 3,
        view: "plot",
        filters: { some_future_param: ["v1"], "": ["ignored-if-empty-vals"] },
        split: [{ param: "brand_new_metric", channel: "size" }, { param: "no_style" }],
      }),
    );
    expect(spec!.filters).toEqual({ some_future_param: ["v1"], "": ["ignored-if-empty-vals"] });
    expect(spec!.split).toEqual([
      { param: "brand_new_metric", channel: "size" },
      { param: "no_style" },
    ]);
    // and it flows back into a valid config
    const { config } = specToConfig(spec!);
    expect((config as PlotConfig).splits).toEqual(["brand_new_metric", "no_style"]);
    expect((config as PlotConfig).channels).toEqual({ brand_new_metric: "size" });
  });

  it("drops malformed ranges/sorts/bins entries without throwing", () => {
    const spec = parseSpec(
      JSON.stringify({
        v: 3,
        view: "plot",
        ranges: [{ metric: "asr", min: 0, max: 1 }, { metric: "x", min: "lo", max: 1 }],
        split: [{ param: "d", bins: { n: 3, method: "nope" } }, { param: "e", bins: { n: 2, method: "width" } }],
      }),
    );
    expect(spec!.ranges).toEqual([{ metric: "asr", min: 0, max: 1 }]);
    // bad-method bins dropped to a bare split; good bins kept
    expect(spec!.split).toEqual([{ param: "d" }, { param: "e", bins: { n: 2, method: "width" } }]);
  });
});
