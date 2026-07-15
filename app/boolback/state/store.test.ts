// Store tests — the settings-editor mutators (phase 3): add / duplicate /
// patch / remove setting, per-setting vs plot-level filter targeting, and
// resetView back to the plain defaults. The store is a module singleton, so
// every test starts from freshly-cloned defaults.

import { describe, it, expect, beforeEach } from "vitest";
import { useBoolbackStore, DEFAULT_TABLE } from "./store";
import { DEFAULT_PLOT, DEFAULT_GROUP_PLOT } from "../lib/types";
import { paletteColor } from "../lib/styling";

const store = useBoolbackStore;

beforeEach(() => {
  store.setState({
    table: structuredClone(DEFAULT_TABLE),
    plot: structuredClone(DEFAULT_PLOT),
    groupPlot: structuredClone(DEFAULT_GROUP_PLOT),
  });
});

describe("addSetting", () => {
  it("appends an unfiltered setting with the next palette color and returns its id", () => {
    const id = store.getState().addSetting("plot");
    expect(id).toBe("s2");
    const { settings } = store.getState().plot;
    expect(settings).toHaveLength(2);
    expect(settings[1]).toMatchObject({
      id: "s2",
      name: "setting 2",
      color: paletteColor(1),
      filters: { facets: {}, ranges: [] },
    });
    // the plot and groupPlot configs are independent
    expect(store.getState().groupPlot.settings).toHaveLength(1);
  });

  it("reuses the smallest free integer id", () => {
    const s = store.getState();
    s.addSetting("plot"); // s2
    s.removeSetting("plot", "s1");
    const id = store.getState().addSetting("plot");
    expect(id).toBe("s1");
    expect(store.getState().plot.settings.map((x) => x.id)).toEqual(["s2", "s1"]);
  });
});

describe("duplicateSetting", () => {
  it("copies name + ' copy' and the filters, takes the next palette color, inserts after the source", () => {
    const s = store.getState();
    s.setFacet("plot", "s1", "dataset", ["sst2"]);
    s.addRange("plot", "s1", { metric: "asr", min: 0.5, max: 1 });

    const id = store.getState().duplicateSetting("plot", "s1");
    expect(id).toBe("s2");
    const { settings } = store.getState().plot;
    expect(settings.map((x) => x.id)).toEqual(["s1", "s2"]);
    expect(settings[1].name).toBe("all runs copy");
    expect(settings[1].color).toBe(paletteColor(1));
    expect(settings[1].filters).toEqual(settings[0].filters);
  });

  it("deep-copies the filters — edits to the copy never leak back", () => {
    const s = store.getState();
    s.setFacet("plot", "s1", "dataset", ["sst2"]);
    const id = s.duplicateSetting("plot", "s1")!;
    store.getState().toggleFacetValue("plot", id, "dataset", "mmlu");
    const { settings } = store.getState().plot;
    expect(settings[0].filters.facets.dataset).toEqual(["sst2"]);
    expect(settings[1].filters.facets.dataset).toEqual(["sst2", "mmlu"]);
  });

  it("returns null and changes nothing for an unknown id", () => {
    const before = store.getState().plot;
    expect(store.getState().duplicateSetting("plot", "nope")).toBeNull();
    expect(store.getState().plot).toBe(before);
  });
});

describe("patchSetting / removeSetting", () => {
  it("patchSetting renames and recolors the named setting only", () => {
    store.getState().addSetting("plot");
    store.getState().patchSetting("plot", "s1", { name: "renamed", color: "#123456" });
    const { settings } = store.getState().plot;
    expect(settings[0]).toMatchObject({ name: "renamed", color: "#123456" });
    expect(settings[1].name).toBe("setting 2");
  });

  it("removeSetting drops the named setting but never the last one", () => {
    const s = store.getState();
    s.addSetting("plot");
    s.removeSetting("plot", "s1");
    expect(store.getState().plot.settings.map((x) => x.id)).toEqual(["s2"]);
    store.getState().removeSetting("plot", "s2"); // last — refused
    expect(store.getState().plot.settings.map((x) => x.id)).toEqual(["s2"]);
  });
});

describe("filter targeting", () => {
  it("setFacet with a settingId writes THAT setting's filters", () => {
    store.getState().addSetting("plot");
    store.getState().setFacet("plot", "s2", "base_model", ["qwen"]);
    const { settings } = store.getState().plot;
    expect(settings[0].filters.facets.base_model).toBeUndefined();
    expect(settings[1].filters.facets.base_model).toEqual(["qwen"]);
  });

  it("range mutators with settingId null target the PLOT-LEVEL ranges", () => {
    const r = { metric: "asr", min: 0, max: 0.5 };
    store.getState().addRange("plot", null, r);
    expect(store.getState().plot.ranges).toEqual([r]);
    expect(store.getState().plot.settings[0].filters.ranges).toEqual([]);
    store.getState().updateRange("plot", null, "asr", { max: 0.9 });
    expect(store.getState().plot.ranges[0].max).toBe(0.9);
    store.getState().removeRange("plot", null, "asr");
    expect(store.getState().plot.ranges).toEqual([]);
  });

  it("range mutators with a settingId target the setting's own ranges", () => {
    const r = { metric: "asr", min: 0, max: 0.5 };
    store.getState().addRange("plot", "s1", r);
    expect(store.getState().plot.settings[0].filters.ranges).toEqual([r]);
    expect(store.getState().plot.ranges).toEqual([]);
  });
});

describe("resetView", () => {
  it("lands the plot view back on the plain DEFAULT_PLOT (no mode pinning)", () => {
    const s = store.getState();
    s.addSetting("plot");
    s.setPlot({ splitBy: ["base_model"], colorBy: "asr" });
    store.getState().resetView("plot");
    expect(store.getState().plot).toEqual(DEFAULT_PLOT);
  });

  it("resets groupplot to DEFAULT_GROUP_PLOT", () => {
    store.getState().setGroupPlot({ facet: "base_model", panelMin: 400 });
    store.getState().resetView("groupplot");
    expect(store.getState().groupPlot).toEqual(DEFAULT_GROUP_PLOT);
  });
});
