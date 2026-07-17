// generators tests — expandLayers / binLayers: the "one layer → many" rewrites.
// Covers targets all/selected, the style-seeding grid rule (shared color per
// value/bin, parent identity → shape when >1 target parent), the lone-default
// name-prefix drop, quantile edge dedup, and width bins. Judge is irrelevant
// here; fakes carry `model` (expand facet) + function.complexity.sens (bin
// metric, read by the real numericValue).

import { describe, it, expect } from "vitest";
import { expandLayers, binLayers, partitionBins } from "./generators";
import type { ParameterDef, } from "./parameters";
import type { MetricIndex } from "./select";
import type { RunRow, PlotLayer, FilterState } from "./types";
import { paletteColor, gradientColor, SHAPE_COUNT } from "./styling";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeRow { model?: string; sens?: number }

const mk = (o: FakeRow): RunRow =>
  ({ model: o.model, function: { arity: 1, complexity: { sens: o.sens ?? null } } }) as unknown as RunRow;

const modelDim: ParameterDef = {
  key: "base_model", label: "Model", section: "training", facetKey: "base_model",
  raw: (r) => ((r as unknown as FakeRow).model ?? null),
  display: (v) => `m:${v}`,
};

/** Facet-only applyFilters stand-in (parents here never carry ranges). */
const applyTo = (rows: RunRow[], f: FilterState): RunRow[] =>
  rows.filter((r) => {
    for (const [k, vals] of Object.entries(f.facets)) {
      if (!Array.isArray(vals) || vals.length === 0) continue;
      const v = k === "base_model" ? ((r as unknown as FakeRow).model ?? null) : null;
      if (v === null || !vals.includes(v)) return false;
    }
    return true;
  });

const layer = (id: string, name: string, facets: FilterState["facets"] = {}, shape = 0, dash = 0): PlotLayer => ({
  id, name, color: "#123456", style: { shape, dash }, filters: { facets, ranges: [] },
});

/** Pass-through pinAll (the real pinAllDominant walks FACET_GETTERS, which the
 *  fake rows can't satisfy — full-pinning is covered by its own select tests
 *  plus the marker test below). */
const noPin = (_: RunRow[], f: FilterState): FilterState => f;

const index: MetricIndex = { sens: { name: "sens", label: "Sens" } as MetricIndex[string] };

// ---------------------------------------------------------------------------
// expandLayers
// ---------------------------------------------------------------------------

describe("expandLayers", () => {
  it("splits the lone default layer into one child per value, DROPS the 'all runs · ' prefix, colors by sorted-union ordinal", () => {
    const rows = [mk({ model: "qwen" }), mk({ model: "qwen" }), mk({ model: "llama" })];
    const out = expandLayers({
      rows, layers: [layer("l1", "all runs")], targets: "all", selectedId: "l1", dim: modelDim, applyTo, pinAll: noPin,
    });
    // union sorted lexically: llama(0), qwen(1) → children in that order
    expect(out.map((l) => l.name)).toEqual(["m:llama", "m:qwen"]);
    expect(out.map((l) => l.color)).toEqual([paletteColor(0), paletteColor(1)]);
    expect(out.map((l) => l.filters.facets.base_model)).toEqual([["llama"], ["qwen"]]);
    expect(out.map((l) => l.id)).toEqual(["l1", "l2"]); // ids regenerated
    // single target parent → children inherit the parent's shape (0)
    expect(out.every((l) => l.style.shape === 0)).toBe(true);
  });

  it("a NAMED (non-lone) parent keeps its name as a child prefix", () => {
    const rows = [mk({ model: "qwen" }), mk({ model: "llama" })];
    const out = expandLayers({
      rows, layers: [layer("l1", "A", {}), layer("l2", "B", {})], targets: "selected", selectedId: "l1", dim: modelDim, applyTo, pinAll: noPin,
    });
    // only l1 expanded; l2 untouched and still present
    const expanded = out.filter((l) => l.name.startsWith("A · "));
    expect(expanded.map((l) => l.name)).toEqual(["A · m:llama", "A · m:qwen"]);
    expect(out.some((l) => l.id === "l2" && l.name === "B")).toBe(true);
  });

  it("targets 'selected' leaves non-selected layers untouched, in place", () => {
    const rows = [mk({ model: "qwen" }), mk({ model: "llama" })];
    const l2 = layer("l2", "keep me", { base_model: ["qwen"] }, 3, 1);
    const out = expandLayers({
      rows, layers: [layer("l1", "A"), l2], targets: "selected", selectedId: "l1", dim: modelDim, applyTo, pinAll: noPin,
    });
    expect(out.find((l) => l.id === "l2")).toEqual(l2);
  });

  it("multi-target: PARENT identity moves to SHAPE (parentIndex % SHAPE_COUNT); the same value shares a color across parents", () => {
    const rows = [mk({ model: "qwen" }), mk({ model: "llama" })];
    const out = expandLayers({
      rows, layers: [layer("l1", "A"), layer("l2", "B")], targets: "all", selectedId: "l1", dim: modelDim, applyTo, pinAll: noPin,
    });
    // 2 parents × 2 values = 4 children
    expect(out).toHaveLength(4);
    const a = out.filter((l) => l.name.startsWith("A · "));
    const b = out.filter((l) => l.name.startsWith("B · "));
    // parent A → shape 0, parent B → shape 1
    expect(a.every((l) => l.style.shape === 0 % SHAPE_COUNT)).toBe(true);
    expect(b.every((l) => l.style.shape === 1 % SHAPE_COUNT)).toBe(true);
    // same value (llama) → same color in both parents
    const aLlama = a.find((l) => l.filters.facets.base_model![0] === "llama")!;
    const bLlama = b.find((l) => l.filters.facets.base_model![0] === "llama")!;
    expect(aLlama.color).toBe(bLlama.color);
    expect(aLlama.color).toBe(paletteColor(0)); // llama is ordinal 0 in the shared union
  });

  it("a parent's OWN pin on the expanded parameter is dropped — expansion spreads over every reachable value", () => {
    // parent pinned to qwen (a dominant-cell layer); expanding BY model must
    // still yield one child per model, not a single qwen child.
    const rows = [mk({ model: "qwen" }), mk({ model: "llama" })];
    const out = expandLayers({
      rows, layers: [layer("l1", "all runs", { base_model: ["qwen"] })],
      targets: "all", selectedId: "l1", dim: modelDim, applyTo, pinAll: noPin,
    });
    expect(out.map((l) => l.filters.facets.base_model)).toEqual([["llama"], ["qwen"]]);
  });

  it("deep-copies parent facets and adds the expand facet (no shared array leakage)", () => {
    const rows = [mk({ model: "qwen" })];
    const parent = layer("l1", "A", { base_model: [] as string[] });
    const out = expandLayers({ rows, layers: [parent], targets: "all", selectedId: "l1", dim: modelDim, applyTo, pinAll: noPin });
    expect(out[0].filters.facets.base_model).toEqual(["qwen"]);
    expect(out[0].filters.facets).not.toBe(parent.filters.facets);
  });

  it("every child's filters run through pinAll AFTER the expanded pin is set (fully-pinned mints)", () => {
    // Marker pinAll: proves it sees the child's expanded pin and that its
    // result is what lands on the layer — BOTH target paths mint through it.
    const rows = [mk({ model: "qwen" }), mk({ model: "llama" })];
    const seen: Array<FilterState["facets"]> = [];
    const markPin = (_: RunRow[], f: FilterState): FilterState => {
      seen.push(f.facets);
      return { ...f, facets: { ...f.facets, seed: ["0"] } };
    };
    for (const targets of ["all", "selected"] as const) {
      seen.length = 0;
      const out = expandLayers({
        rows, layers: [layer("l1", "all runs")], targets, selectedId: "l1", dim: modelDim, applyTo, pinAll: markPin,
      });
      // pinAll received the expanded pin (one call per child, value already set)
      expect(seen.map((f) => f.base_model)).toEqual([["llama"], ["qwen"]]);
      // and its output is the minted filters
      expect(out.map((l) => l.filters.facets.seed)).toEqual([["0"], ["0"]]);
    }
  });
});

// ---------------------------------------------------------------------------
// partitionBins — the shared bin definition (binLayers + the Group Plot facet)
// ---------------------------------------------------------------------------

describe("partitionBins", () => {
  it("width mode: clean-edge labels, ε-shrunk non-last maxes, exact last max", () => {
    const bins = partitionBins([0, 5, 10], 2, "width");
    expect(bins.map((b) => b.label)).toEqual(["0–5", "5–10"]);
    expect(bins[0].lo).toBe(0);
    expect(bins[0].hi).toBe(5);
    expect(bins[0].max).toBeLessThan(5); // partition: 5 belongs to bin 2
    expect(bins[1]).toMatchObject({ lo: 5, hi: 10, max: 10 });
  });

  it("quantile mode collapses duplicate edges; empty/degenerate inputs", () => {
    expect(partitionBins([], 4, "quantile")).toEqual([]);
    expect(partitionBins([3, 3, 3], 4, "quantile")).toHaveLength(1);
    const bins = partitionBins([1, 1, 1, 5], 4, "quantile");
    expect(bins).toHaveLength(2); // interpolated edges 1,1,1,2,5 → uniq 1,2,5
  });
});

// ---------------------------------------------------------------------------
// binLayers
// ---------------------------------------------------------------------------

describe("binLayers", () => {
  it("width mode: n equal-width PARTITION bins (an edge value belongs to the higher bin), gradient color low→high, metric-labeled names", () => {
    const rows = [mk({ sens: 0 }), mk({ sens: 5 }), mk({ sens: 10 })];
    const out = binLayers({
      rows, layers: [layer("l1", "all runs")], targets: "all", selectedId: "l1",
      metric: "sens", n: 2, mode: "width", index, applyTo,
    });
    expect(out).toHaveLength(2);
    // edges [0,5,10] → bins [0,5),[5,10]: the non-last bin's max sits a hair
    // below the shared edge so the sens=5 run matches exactly ONE bin.
    const [r0, r1] = out.map((l) => l.filters.ranges[0]);
    expect(r0.min).toBe(0);
    expect(r0.max).toBeLessThan(5);
    expect(r0.max).toBeCloseTo(5, 6);
    expect(r1).toEqual({ metric: "sens", min: 5, max: 10 });
    // labels keep the clean edge numbers
    expect(out.map((l) => l.name)).toEqual(["Sens 0–5", "Sens 5–10"]);
    expect(out.map((l) => l.color)).toEqual([gradientColor(0), gradientColor(1)]);
  });

  it("quantile mode: COLLAPSES duplicate edges (fewer bins than requested, never an empty range)", () => {
    // 4 values, all but one identical → most quartile edges collapse.
    const rows = [mk({ sens: 1 }), mk({ sens: 1 }), mk({ sens: 1 }), mk({ sens: 5 })];
    const out = binLayers({
      rows, layers: [layer("l1", "all runs")], targets: "all", selectedId: "l1",
      metric: "sens", n: 4, mode: "quantile", index, applyTo,
    });
    // interpolated quantile edges at 0,.25,.5,.75,1 → 1,1,1,2,5 → uniq [1,2,5]
    // → TWO bins instead of the four requested (the mass at 1 vs the outlier).
    expect(out).toHaveLength(2);
    const [q0, q1] = out.map((l) => l.filters.ranges[0]);
    expect(q0.min).toBe(1);
    expect(q0.max).toBeLessThan(2); // ε-shrunk partition edge
    expect(q0.max).toBeCloseTo(2, 6);
    expect(q1).toEqual({ metric: "sens", min: 2, max: 5 });
    // no empty-range bins
    for (const l of out) {
      const rg = l.filters.ranges[0];
      expect(rg.max).toBeGreaterThan(rg.min);
    }
  });

  it("all-identical values degenerate to a single point bin", () => {
    const rows = [mk({ sens: 3 }), mk({ sens: 3 }), mk({ sens: 3 })];
    const out = binLayers({
      rows, layers: [layer("l1", "all runs")], targets: "all", selectedId: "l1",
      metric: "sens", n: 4, mode: "quantile", index, applyTo,
    });
    expect(out).toHaveLength(1);
    expect(out[0].filters.ranges).toEqual([{ metric: "sens", min: 3, max: 3 }]);
  });

  it("bins each parent over ITS OWN rows (within-arity) with the requested-n color ramp", () => {
    // Two parents with disjoint sens extents; each split into 2 width bins.
    const rows = [
      mk({ model: "qwen", sens: 0 }), mk({ model: "qwen", sens: 2 }),
      mk({ model: "llama", sens: 100 }), mk({ model: "llama", sens: 200 }),
    ];
    const out = binLayers({
      rows,
      layers: [layer("l1", "A", { base_model: ["qwen"] }), layer("l2", "B", { base_model: ["llama"] })],
      targets: "all", selectedId: "l1", metric: "sens", n: 2, mode: "width", index, applyTo,
    });
    expect(out).toHaveLength(4);
    const a = out.filter((l) => l.name.startsWith("A · "));
    const b = out.filter((l) => l.name.startsWith("B · "));
    // per-parent edges: A over [0,2], B over [100,200] (non-last maxes ε-shrunk)
    expect(a.map((l) => [l.filters.ranges[0].min, Math.round(l.filters.ranges[0].max)])).toEqual([
      [0, 1], [1, 2],
    ]);
    expect(a[0].filters.ranges[0].max).toBeLessThan(1);
    expect(b.map((l) => [l.filters.ranges[0].min, Math.round(l.filters.ranges[0].max)])).toEqual([
      [100, 150], [150, 200],
    ]);
    expect(b[0].filters.ranges[0].max).toBeLessThan(150);
    // parent identity → shape; same bin index → same color across parents
    expect(a.every((l) => l.style.shape === 0)).toBe(true);
    expect(b.every((l) => l.style.shape === 1)).toBe(true);
    expect(a.map((l) => l.color)).toEqual(b.map((l) => l.color));
  });

  it("replaces an existing range on the SAME metric with the bin slice, keeping other ranges", () => {
    const parent: PlotLayer = {
      id: "l1", name: "all runs", color: "#123456", style: { shape: 0, dash: 0 },
      filters: { facets: {}, ranges: [{ metric: "sens", min: -99, max: 99 }, { metric: "other", min: 0, max: 1 }] },
    };
    const rows = [mk({ sens: 0 }), mk({ sens: 10 })];
    const out = binLayers({
      rows, layers: [parent], targets: "all", selectedId: "l1",
      metric: "sens", n: 1, mode: "width", index, applyTo,
    });
    expect(out).toHaveLength(1);
    expect(out[0].filters.ranges).toEqual([
      { metric: "other", min: 0, max: 1 },
      { metric: "sens", min: 0, max: 10 },
    ]);
  });
});
