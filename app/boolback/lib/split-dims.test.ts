// split-dims tests — resolveSeries: ONE series per layer, per-layer row matching
// + union with duplicates, overlap, empty layers, per-series judge + judge
// pooling, plot-level ranges, and averagedParams. Judge is read via the `judge`
// FacetKey getter (headline.primary_judge), so fakes carry a headline field.

import { describe, it, expect } from "vitest";
import { resolveSeries, averagedParams } from "./split-dims";
import type { ParameterDef } from "./parameters";
import type { RunRow, PlotLayer, FilterState, RangeFilter } from "./types";
import { DEFAULT_LAYER_STYLE } from "./types";

// ---------------------------------------------------------------------------
// fakes — a flat row whose facet getters (model/judge) live where select reads
// them: judge at headline.primary_judge (facetValue(r,"judge")); model/asr are
// only touched via the injected applyTo, so they can sit at the top level.
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  model?: string;
  seed?: string;
  asr?: number;
  headline?: { primary_judge: string | null };
}

const row = (r: Omit<FakeRow, "headline"> & { judge?: string }): RunRow => {
  const { judge, ...rest } = r;
  return { ...rest, headline: { primary_judge: judge ?? null } } as unknown as RunRow;
};
const field = (r: RunRow, k: keyof FakeRow) => (r as unknown as FakeRow)[k];

const DEFS: Record<string, ParameterDef> = {
  base_model: {
    key: "base_model", label: "Model", section: "training",
    raw: (r) => (field(r, "model") as string | undefined) ?? null,
    display: (v) => `m:${v}`,
  },
  seed: {
    key: "seed", label: "Seed", section: "training", numericSort: true,
    raw: (r) => (field(r, "seed") as string | undefined) ?? null,
  },
};

/** Minimal applyFilters stand-in over the fake facet fields + numeric ranges. */
const applyTo = (rows: RunRow[], f: FilterState): RunRow[] =>
  rows.filter((r) => {
    for (const [key, vals] of Object.entries(f.facets)) {
      if (!Array.isArray(vals) || vals.length === 0) continue;
      const v = DEFS[key]?.raw(r) ?? null;
      if (v === null || !vals.includes(v)) return false;
    }
    for (const rg of f.ranges) {
      const v = field(r, rg.metric as keyof FakeRow);
      if (typeof v !== "number" || v < rg.min || v > rg.max) return false;
    }
    return true;
  });

const layer = (
  id: string,
  name: string,
  facets: FilterState["facets"] = {},
  opts: { color?: string; ranges?: RangeFilter[]; style?: { shape: number; dash: number } } = {},
): PlotLayer => ({
  id,
  name,
  color: opts.color ?? "#123456",
  style: opts.style ?? { ...DEFAULT_LAYER_STYLE },
  filters: { facets, ranges: opts.ranges ?? [] },
});

const resolve = (opts: {
  rows: RunRow[];
  layers: PlotLayer[];
  ranges?: RangeFilter[];
}) =>
  resolveSeries({
    rows: opts.rows,
    layers: opts.layers,
    ranges: opts.ranges ?? [],
    applyTo,
  });

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("resolveSeries", () => {
  it("exactly one series per layer, in config order, keyed/colored/labeled by the layer", () => {
    const rows = [row({ id: "r1", model: "qwen" })];
    const res = resolve({
      rows,
      layers: [
        layer("l1", "qwen-ish", { base_model: ["qwen"] }, { color: "#aa0000", style: { shape: 2, dash: 1 } }),
        layer("l2", "everything", {}, { color: "#00bb00" }),
      ],
    });
    expect(res.series.map((s) => s.key)).toEqual(["l1", "l2"]);
    expect(res.series.map((s) => s.layerId)).toEqual(["l1", "l2"]);
    expect(res.series.map((s) => s.label)).toEqual(["qwen-ish", "everything"]);
    expect(res.series.map((s) => s.color)).toEqual(["#aa0000", "#00bb00"]);
    expect(res.series[0].style).toEqual({ shape: 2, dash: 1 });
  });

  it("union keeps duplicates: a run matching two layers appears in both series; overlapCount counts it once", () => {
    const shared = row({ id: "r1", model: "qwen" });
    const only2 = row({ id: "r2", model: "llama" });
    const rows = [shared, only2];
    const res = resolve({
      rows,
      layers: [
        layer("l1", "qwen-ish", { base_model: ["qwen"] }),
        layer("l2", "everything"), // unfiltered — matches both rows
      ],
    });
    expect(res.series[0].rows).toEqual([shared]);
    expect(res.series[1].rows).toEqual([shared, only2]);
    expect(res.rowsUnion).toHaveLength(3); // duplicate included
    expect(res.overlapCount).toBe(1); // counted once
    expect(res.emptyLayers).toEqual([]);
  });

  it("a layer matching nothing lands in emptyLayers (its series stays, empty)", () => {
    const rows = [row({ id: "r1", model: "qwen" })];
    const res = resolve({
      rows,
      layers: [
        layer("l1", "qwen", { base_model: ["qwen"] }),
        layer("l2", "ghost town", { base_model: ["nonexistent"] }),
      ],
    });
    expect(res.emptyLayers).toEqual(["ghost town"]);
    expect(res.series).toHaveLength(2);
    expect(res.series[1].rows).toEqual([]);
    expect(res.overlapCount).toBe(0);
  });

  it("plot-level ranges intersect EVERY layer on top of its own filters", () => {
    const rows = [
      row({ id: "a", model: "qwen", asr: 0.9 }),
      row({ id: "b", model: "qwen", asr: 0.1 }),
      row({ id: "c", model: "llama", asr: 0.95 }),
    ];
    const res = resolve({
      rows,
      layers: [
        layer("l1", "qwen", { base_model: ["qwen"] }),
        layer("l2", "llama", { base_model: ["llama"] }),
      ],
      ranges: [{ metric: "asr", min: 0.5, max: 1 }],
    });
    expect(res.series[0].rows.map((r) => field(r, "id"))).toEqual(["a"]); // b dropped by the range
    expect(res.series[1].rows.map((r) => field(r, "id"))).toEqual(["c"]);
  });

  it("a layer's own ranges compose (AND) with the plot-level ranges", () => {
    const rows = [row({ id: "a", asr: 0.6 }), row({ id: "b", asr: 0.9 })];
    const res = resolve({
      rows,
      layers: [layer("l1", "high", {}, { ranges: [{ metric: "asr", min: 0.8, max: 1 }] })],
      ranges: [{ metric: "asr", min: 0, max: 0.95 }],
    });
    expect(res.series[0].rows.map((r) => field(r, "id"))).toEqual(["b"]);
  });

  describe("judge", () => {
    const rows = [
      row({ id: "a", model: "qwen", judge: "kw" }),
      row({ id: "b", model: "qwen", judge: "llm" }),
      row({ id: "c", model: "llama", judge: "kw" }),
    ];

    it("a layer spanning one judge carries it; a mixed layer carries null and lands in judgePooled", () => {
      const res = resolve({
        rows,
        layers: [
          layer("l1", "mixed", { base_model: ["qwen"] }), // kw + llm
          layer("l2", "single", { base_model: ["llama"] }), // kw only
        ],
      });
      expect(res.series.map((s) => s.judge)).toEqual([null, "kw"]);
      expect(res.judgePooled).toEqual(["mixed"]);
    });
  });
});

describe("averagedParams", () => {
  const params = [DEFS.base_model, DEFS.seed];

  it("keeps a param varying WITHIN a layer; drops a layer-DEFINING one", () => {
    const rows = [
      row({ id: "a", model: "qwen", seed: "1" }),
      row({ id: "b", model: "qwen", seed: "2" }),
      row({ id: "c", model: "llama", seed: "1" }),
      row({ id: "d", model: "llama", seed: "2" }),
    ];
    const res = resolve({
      rows,
      layers: [
        layer("l1", "qwen", { base_model: ["qwen"] }),
        layer("l2", "llama", { base_model: ["llama"] }),
      ],
    });
    // model differs over the union but is CONSTANT within each layer — a
    // contrast, not a pooled nuisance; seed varies within both layers.
    expect(averagedParams(res, params).map((d) => d.key)).toEqual(["seed"]);
  });

  it("a param varying in ANY one layer qualifies even when constant in the others", () => {
    const rows = [
      row({ id: "a", model: "qwen", seed: "1" }),
      row({ id: "b", model: "qwen", seed: "2" }),
      row({ id: "c", model: "llama", seed: "1" }),
    ];
    const res = resolve({
      rows,
      layers: [
        layer("l1", "qwen", { base_model: ["qwen"] }), // seed varies here
        layer("l2", "llama", { base_model: ["llama"] }), // seed constant here
      ],
    });
    expect(averagedParams(res, params).map((d) => d.key)).toEqual(["seed"]);
  });

  it("returns [] when nothing varies within any layer", () => {
    const rows = [row({ id: "a", model: "qwen", seed: "1" })];
    const res = resolve({ rows, layers: [layer("l1", "solo")] });
    expect(averagedParams(res, params)).toEqual([]);
  });
});
