// Parameter-model tests against the REAL builder fixture: shared/differing
// partition + biggest-split-first ordering.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import {
  PARAMETERS, summarizeParameters, tierSections, conditionedCounts, orderValuesByCount,
} from "./parameters";
import type { RunRow } from "./types";

const bundle = asBundle(structuredClone(sample));
const rows: RunRow[] = bundle.rows;

describe("summarizeParameters", () => {
  it("partitions into shared (one value) and differing (sorted biggest first)", () => {
    const s = summarizeParameters(rows);
    expect(s.shared.length + s.differing.length).toBeGreaterThan(0);
    for (const { dim, value } of s.shared) {
      for (const r of rows) {
        const v = dim.raw(r);
        if (v !== null) expect(v).toBe(value);
      }
    }
    const sizes = s.differing.map((d) => d.values.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const d of s.differing) expect(d.values.length).toBeGreaterThan(1);
  });

  it("counts values and sorts numerically when flagged", () => {
    const one = summarizeParameters([rows[0]]);
    expect(one.differing).toHaveLength(0); // a single row differs on nothing
    const arity = [...one.shared].find((x) => x.dim.key === "arity");
    expect(arity).toBeTruthy();
    expect(Number(arity!.value)).toBe(rows[0].function.arity);
  });

  it("exposes the dataset parameter (with the old-blob source fallback)", () => {
    const s = summarizeParameters(rows);
    const all = [...s.shared.map((x) => x.dim), ...s.differing.map((x) => x.dim)];
    const ds = all.find((d) => d.key === "dataset");
    expect(ds).toBeTruthy();
    // the fixture's rows are old-shaped (source/task) — the getter falls back
    expect(ds!.raw(rows[0])).toBe(rows[0].dataset.dataset ?? rows[0].dataset.source);
  });
});

// ---------------------------------------------------------------------------
// tierSections — the settings editor's grouping/nesting model
// ---------------------------------------------------------------------------

const byKey = new Map(PARAMETERS.map((p) => [p.key, p]));
const dims = (...keys: string[]) => keys.map((k) => byKey.get(k)!);

describe("tierSections", () => {
  it("groups setting → sweep → function and nests target_phrase/judge under target_behavior", () => {
    const s = tierSections(dims(
      "function", "dataset", "target_behavior", "target_phrase", "judge", "base_model", "seed",
    ));
    expect(s.map((x) => x.tier)).toEqual(["setting", "sweep", "function"]);
    expect(s[0].entries.map((e) => e.dim.key)).toEqual(["dataset", "target_behavior"]);
    const tb = s[0].entries.find((e) => e.dim.key === "target_behavior")!;
    expect(tb.children.map((c) => c.key)).toEqual(["target_phrase", "judge"]);
    expect(s[1].entries.map((e) => e.dim.key)).toEqual(["base_model", "seed"]);
    expect(s[1].entries.every((e) => e.children.length === 0)).toBe(true);
    expect(s[2].entries.map((e) => e.dim.key)).toEqual(["function"]);
  });

  it("an orphaned child (parent absent) renders top-level; empty sections drop", () => {
    const s = tierSections(dims("target_phrase", "judge"));
    expect(s).toHaveLength(1);
    expect(s[0].tier).toBe("setting");
    expect(s[0].entries.map((e) => e.dim.key)).toEqual(["target_phrase", "judge"]);
    expect(s[0].entries.every((e) => e.children.length === 0)).toBe(true);
  });

  it("returns [] for no dims", () => {
    expect(tierSections([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// conditionedCounts — faceted-search counting (drop own facet, apply the rest)
// ---------------------------------------------------------------------------

/** Minimal fake row exposing the facet getters + a complexity metric. */
const mkRow = (o: { dataset?: string; model?: string; judge?: string; sens?: number }): RunRow =>
  ({
    dataset: {
      dataset: o.dataset ?? "sst2", source: null, task: null, trigger_form: null,
      target_behavior: null, row_distribution: null, samples_per_row: null,
      backdoor_ratio: null, scheme: null, target_phrase: null,
    },
    training: {
      base_model: o.model ?? "qwen", backend: null, lr: null, epochs: null,
      seed: null, tuning: null,
    },
    headline: { primary_judge: o.judge ?? "kw" },
    per_judge: [],
    function: { arity: 1, complexity: { avg_sensitivity: o.sens ?? 0.5 } },
  }) as unknown as RunRow;

const datasetDim = byKey.get("dataset")!;
const modelDim = byKey.get("base_model")!;

const testRows = [
  mkRow({ dataset: "sst2", model: "qwen", sens: 0.2 }),
  mkRow({ dataset: "sst2", model: "llama", sens: 0.8 }),
  mkRow({ dataset: "mmlu", model: "qwen", sens: 0.8 }),
];

describe("conditionedCounts", () => {
  it("with no filters, counts the raw value distribution", () => {
    const c = conditionedCounts(testRows, datasetDim, { facets: {}, ranges: [] });
    expect(c.get("sst2")).toBe(2);
    expect(c.get("mmlu")).toBe(1);
  });

  it("drops the parameter's OWN facet — its full value list stays reachable", () => {
    const filters = { facets: { dataset: ["sst2"] }, ranges: [] };
    const c = conditionedCounts(testRows, datasetDim, filters);
    expect(c.get("sst2")).toBe(2);
    expect(c.get("mmlu")).toBe(1); // NOT filtered away by its own selection
  });

  it("applies the OTHER facets to another parameter's counts", () => {
    const filters = { facets: { dataset: ["sst2"] }, ranges: [] };
    const c = conditionedCounts(testRows, modelDim, filters);
    expect(c.get("qwen")).toBe(1); // the mmlu/qwen row is filtered out
    expect(c.get("llama")).toBe(1);
  });

  it("a value unreachable under the other filters is absent (renders 0/muted)", () => {
    const filters = { facets: { base_model: ["llama"] }, ranges: [] };
    const c = conditionedCounts(testRows, datasetDim, filters);
    expect(c.get("sst2")).toBe(1);
    expect(c.has("mmlu")).toBe(false);
  });

});

// ---------------------------------------------------------------------------
// orderValuesByCount — chip DISPLAY order (Feature 2): most-run value first
// ---------------------------------------------------------------------------

describe("orderValuesByCount", () => {
  const values = [
    { value: "a", count: 3 },
    { value: "b", count: 3 },
    { value: "c", count: 10 },
    { value: "d", count: 1 },
  ];

  it("orders by DESCENDING conditioned count", () => {
    const counts = new Map([["a", 2], ["b", 5], ["c", 1], ["d", 9]]);
    expect(orderValuesByCount(values, counts).map((v) => v.value)).toEqual(["d", "b", "a", "c"]);
  });

  it("is STABLE — count ties keep the incoming order; a missing count is 0", () => {
    const counts = new Map([["a", 4], ["b", 4]]); // c, d absent -> 0
    // a,b tie at 4 (incoming order a→b); c,d tie at 0 (incoming order c→d)
    expect(orderValuesByCount(values, counts).map((v) => v.value)).toEqual(["a", "b", "c", "d"]);
  });

  it("does not mutate the input array", () => {
    const before = values.map((v) => v.value);
    orderValuesByCount(values, new Map());
    expect(values.map((v) => v.value)).toEqual(before);
  });
});

describe("conditionedCounts (ranges)", () => {
  it("applies the filters' own ranges AND the extra (plot-level) ranges", () => {
    const own = conditionedCounts(
      testRows, datasetDim,
      { facets: {}, ranges: [{ metric: "avg_sensitivity", min: 0.5, max: 1 }] },
    );
    expect(own.get("sst2")).toBe(1);
    expect(own.get("mmlu")).toBe(1);
    const extra = conditionedCounts(
      testRows, datasetDim, { facets: {}, ranges: [] },
      [{ metric: "avg_sensitivity", min: 0, max: 0.3 }],
    );
    expect(extra.get("sst2")).toBe(1);
    expect(extra.has("mmlu")).toBe(false);
  });
});
