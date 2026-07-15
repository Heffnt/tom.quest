// Store tests — the layer mutators: add / duplicate / patch / remove / replace
// layer, per-layer vs plot-level filter targeting on the SHARED plot config,
// and resetView back to the plain defaults (groupplot reset also clears the
// extras). The store is a module singleton, so every test starts from
// freshly-cloned defaults.

import { describe, it, expect, beforeEach } from "vitest";
import { useBoolbackStore, DEFAULT_TABLE } from "./store";
import { DEFAULT_PLOT, DEFAULT_GROUP_EXTRAS } from "../lib/types";
import { paletteColor } from "../lib/styling";
import type { PlotLayer } from "../lib/types";

const store = useBoolbackStore;

beforeEach(() => {
  store.setState({
    table: structuredClone(DEFAULT_TABLE),
    plot: structuredClone(DEFAULT_PLOT),
    groupPlot: structuredClone(DEFAULT_GROUP_EXTRAS),
  });
});

describe("addLayer", () => {
  it("appends an unfiltered layer with the next palette color and returns its id", () => {
    const id = store.getState().addLayer();
    expect(id).toBe("l2");
    const { layers } = store.getState().plot;
    expect(layers).toHaveLength(2);
    expect(layers[1]).toMatchObject({
      id: "l2",
      name: "layer 2",
      color: paletteColor(1),
      filters: { facets: {}, ranges: [] },
    });
  });

  it("reuses the smallest free integer id", () => {
    const s = store.getState();
    s.addLayer(); // l2
    s.removeLayer("l1");
    const id = store.getState().addLayer();
    expect(id).toBe("l1");
    expect(store.getState().plot.layers.map((x) => x.id)).toEqual(["l2", "l1"]);
  });
});

describe("duplicateLayer", () => {
  it("copies name + ' copy' and the filters, takes the next palette color, inserts after the source", () => {
    const s = store.getState();
    s.setFacet("plot", "l1", "dataset", ["sst2"]);
    s.addRange("plot", "l1", { metric: "asr", min: 0.5, max: 1 });

    const id = store.getState().duplicateLayer("l1");
    expect(id).toBe("l2");
    const { layers } = store.getState().plot;
    expect(layers.map((x) => x.id)).toEqual(["l1", "l2"]);
    expect(layers[1].name).toBe("all runs copy");
    expect(layers[1].color).toBe(paletteColor(1));
    expect(layers[1].filters).toEqual(layers[0].filters);
  });

  it("deep-copies the filters — edits to the copy never leak back", () => {
    const s = store.getState();
    s.setFacet("plot", "l1", "dataset", ["sst2"]);
    const id = s.duplicateLayer("l1")!;
    store.getState().toggleFacetValue("plot", id, "dataset", "mmlu");
    const { layers } = store.getState().plot;
    expect(layers[0].filters.facets.dataset).toEqual(["sst2"]);
    expect(layers[1].filters.facets.dataset).toEqual(["sst2", "mmlu"]);
  });

  it("returns null and changes nothing for an unknown id", () => {
    const before = store.getState().plot;
    expect(store.getState().duplicateLayer("nope")).toBeNull();
    expect(store.getState().plot).toBe(before);
  });
});

describe("patchLayer / removeLayer / replaceLayers", () => {
  it("patchLayer renames and recolors the named layer only", () => {
    store.getState().addLayer();
    store.getState().patchLayer("l1", { name: "renamed", color: "#123456" });
    const { layers } = store.getState().plot;
    expect(layers[0]).toMatchObject({ name: "renamed", color: "#123456" });
    expect(layers[1].name).toBe("layer 2");
  });

  it("removeLayer drops the named layer but never the last one", () => {
    const s = store.getState();
    s.addLayer();
    s.removeLayer("l1");
    expect(store.getState().plot.layers.map((x) => x.id)).toEqual(["l2"]);
    store.getState().removeLayer("l2"); // last — refused
    expect(store.getState().plot.layers.map((x) => x.id)).toEqual(["l2"]);
  });

  it("replaceLayers swaps the whole list (generators write through this)", () => {
    const next: PlotLayer[] = [
      { id: "l1", name: "a", color: "#111111", style: { shape: 0, dash: 0 }, filters: { facets: {}, ranges: [] } },
      { id: "l2", name: "b", color: "#222222", style: { shape: 1, dash: 0 }, filters: { facets: { seed: ["1"] }, ranges: [] } },
      { id: "l3", name: "c", color: "#333333", style: { shape: 2, dash: 0 }, filters: { facets: { seed: ["2"] }, ranges: [] } },
    ];
    store.getState().replaceLayers(next);
    expect(store.getState().plot.layers).toEqual(next);
  });
});

describe("filter targeting (shared plot config)", () => {
  it("setFacet with a layerId writes THAT layer's filters", () => {
    store.getState().addLayer();
    store.getState().setFacet("plot", "l2", "base_model", ["qwen"]);
    const { layers } = store.getState().plot;
    expect(layers[0].filters.facets.base_model).toBeUndefined();
    expect(layers[1].filters.facets.base_model).toEqual(["qwen"]);
  });

  it("range mutators with layerId null target the PLOT-LEVEL ranges", () => {
    const r = { metric: "asr", min: 0, max: 0.5 };
    store.getState().addRange("plot", null, r);
    expect(store.getState().plot.ranges).toEqual([r]);
    expect(store.getState().plot.layers[0].filters.ranges).toEqual([]);
    store.getState().updateRange("plot", null, "asr", { max: 0.9 });
    expect(store.getState().plot.ranges[0].max).toBe(0.9);
    store.getState().removeRange("plot", null, "asr");
    expect(store.getState().plot.ranges).toEqual([]);
  });

  it("range mutators with a layerId target the layer's own ranges", () => {
    const r = { metric: "asr", min: 0, max: 0.5 };
    store.getState().addRange("plot", "l1", r);
    expect(store.getState().plot.layers[0].filters.ranges).toEqual([r]);
    expect(store.getState().plot.ranges).toEqual([]);
  });
});

describe("group plot extras + reset", () => {
  it("setGroupPlot patches ONLY the extras (facet / panelMin)", () => {
    store.getState().setGroupPlot({ facet: { kind: "param", key: "base_model" }, panelMin: 400 });
    expect(store.getState().groupPlot).toEqual({ facet: { kind: "param", key: "base_model" }, panelMin: 400 });
  });

  it("resetView('plot') lands the shared config back on the plain DEFAULT_PLOT", () => {
    const s = store.getState();
    s.addLayer();
    s.setPlot({ size: 2, colorBy: "asr" });
    store.getState().resetView("plot");
    expect(store.getState().plot).toEqual(DEFAULT_PLOT);
  });

  it("resetView('groupplot') resets the SHARED plot AND clears the extras", () => {
    const s = store.getState();
    s.addLayer();
    s.setGroupPlot({ facet: { kind: "layer" }, panelMin: 400 });
    store.getState().resetView("groupplot");
    expect(store.getState().plot).toEqual(DEFAULT_PLOT);
    expect(store.getState().groupPlot).toEqual(DEFAULT_GROUP_EXTRAS);
  });

  it("resetView with dominant filters seeds the single default layer", () => {
    const filters = { facets: { dataset: ["sst2"] }, ranges: [] };
    store.getState().resetView("plot", filters);
    const { layers } = store.getState().plot;
    expect(layers).toHaveLength(1);
    expect(layers[0].filters).toEqual(filters);
  });
});
