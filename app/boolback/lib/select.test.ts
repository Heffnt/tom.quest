// Pure-derivation tests for select.ts against the REAL builder fixture.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import {
  applyFilters,
  applySorts,
  dominantFilters,
  facetKeyForColumn,
  facetOptions,
  matchesSearch,
  numericValue,
  metricRange,
  normalizeToRange,
  repairPins,
  FACET_KEYS,
} from "./select";
import { indexMetricSchema } from "./metrics";
import { EMPTY_FILTER, type RunRow } from "./types";

const bundle = asBundle(sample);
const rows: RunRow[] = bundle.rows;
const index = indexMetricSchema(bundle.metric_schema);

describe("select", () => {
  it("fixture has rows", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("facetOptions: distinct, counted, sorted ascending; every facet key resolves", () => {
    const ds = facetOptions(rows, "dataset");
    expect(ds.length).toBeGreaterThan(0);
    expect(ds.map((o) => o.value)).toEqual([...ds.map((o) => o.value)].sort());
    for (const k of FACET_KEYS) expect(() => facetOptions(rows, k)).not.toThrow();
  });

  it("facet filter keeps only rows whose value is selected (dataset reads the source fallback)", () => {
    const ds = facetOptions(rows, "dataset")[0].value;
    const out = applyFilters(rows, { ...EMPTY_FILTER, facets: { dataset: [ds] } });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => (r.dataset.dataset ?? r.dataset.source) === ds)).toBe(true);
  });

  it("range filter on a dotted column id keeps in-range non-null rows", () => {
    const out = applyFilters(rows, {
      ...EMPTY_FILTER,
      ranges: [{ metric: "headline.asr", min: 0, max: 1 }],
    });
    for (const r of out) {
      const v = numericValue(r, "headline.asr");
      expect(v).not.toBeNull();
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(1);
    }
  });

  it("per-method metric ids (base@method) read that method's value, null elsewhere", () => {
    const defended = rows.find((r) => (r.defense?.methods?.length ?? 0) > 0)!;
    const m = defended.defense!.methods.find((x) => typeof x.asr_drop === "number")!;
    expect(numericValue(defended, `asr_drop@${m.method}`)).toBe(m.asr_drop);
    expect(numericValue(defended, "asr_drop@no_such_method")).toBeNull();
    const undefended = rows.find((r) => r.defense === null)!;
    expect(numericValue(undefended, `asr_drop@${m.method}`)).toBeNull();
  });

  it("per-kind interp ids read the headline kind, and prefer the measurements list", () => {
    const interp = rows.find((r) => r.interp?.reading_kind != null)!;
    const kind = interp.interp!.reading_kind!;
    expect(numericValue(interp, `interp_reading@${kind}`)).toBe(interp.interp!.value);
    expect(numericValue(interp, "interp_reading@other_kind")).toBeNull();

    // Newer builders ship ALL kinds; the list wins over the headline fields.
    const withList: RunRow = {
      ...interp,
      interp: {
        ...interp.interp!,
        readings: [
          { kind, value: 0.5, null_control: 0.1 },
          { kind: "other_kind", value: 7, null_control: 2 },
        ],
      },
    };
    expect(numericValue(withList, `interp_reading@${kind}`)).toBe(0.5);
    expect(numericValue(withList, "interp_reading@other_kind")).toBe(7);
    expect(numericValue(withList, "interp_null_control@other_kind")).toBe(2);
  });

  it("anatomy ids (base@kind) derive from the sweep, preferring it over point loci", () => {
    // The planted run: 5 linear_probe point measurements (L8..L24) with the
    // 32-layer sweep on the L16 one — the sweep must win over find-first.
    const planted = rows.find((r) =>
      r.interp?.readings?.some((m) => m.kind === "sae_feature"),
    )!;
    expect(numericValue(planted, "interp_peak_layer@linear_probe")).toBe(16);
    expect(numericValue(planted, "interp_loc_width@linear_probe")).toBe(11);
    const com = numericValue(planted, "interp_depth_com@linear_probe");
    expect(com).toBeGreaterThan(0.5); // sweep is near-symmetric around L16/31
    expect(com).toBeLessThan(0.53);

    // Single-layer fallback: first measurement with a numeric layer (tuned
    // lens at L8/L16/L24, no sweep) -> point semantics.
    expect(numericValue(planted, "interp_peak_layer@tuned_lens")).toBe(8);
    expect(numericValue(planted, "interp_loc_width@tuned_lens")).toBe(1);
    expect(numericValue(planted, "interp_depth_com@tuned_lens")).toBeCloseTo(8 / 31, 6);

    // The weaker twin sweeps the same kind but peaks elsewhere.
    const twin = rows.find(
      (r) =>
        r !== planted && r.interp?.readings?.some((m) => m.layer_profile),
    )!;
    expect(numericValue(twin, "interp_peak_layer@linear_probe")).toBe(11);

    // No locus data -> null: global (layer-less) and circuit (nodes-only)
    // loci, unknown kinds, rows without a measurements list.
    expect(numericValue(planted, "interp_peak_layer@weight_norm_diff")).toBeNull();
    expect(numericValue(planted, "interp_peak_layer@circuit")).toBeNull();
    expect(numericValue(planted, "interp_peak_layer@no_such_kind")).toBeNull();
    const headlineOnly = rows.find((r) => r.interp && !r.interp.readings)!;
    expect(numericValue(headlineOnly, "interp_peak_layer@linear_probe")).toBeNull();
  });

  it("anatomy depth_com falls back to max-observed-layer+1 when n_layers is absent", () => {
    const src = rows.find((r) => r.interp !== null)!;
    const bare: RunRow = {
      ...src,
      n_layers: null, // pre-anatomy blobs ship no model shape
      interp: {
        ...src.interp!,
        readings: [
          { kind: "probe_a", value: 1, null_control: 0, layer: 5 },
          { kind: "probe_b", value: 1, null_control: 0, layer: 9 },
        ],
      },
    };
    // max observed layer 9 -> effective n_layers 10 -> denominator 9
    expect(numericValue(bare, "interp_peak_layer@probe_a")).toBe(5);
    expect(numericValue(bare, "interp_depth_com@probe_a")).toBeCloseTo(5 / 9, 6);
    expect(numericValue(bare, "interp_depth_com@probe_b")).toBe(1);
  });

  it("applyFilters tolerates a stale/partial persisted FilterState (missing sub-keys)", () => {
    // A saved view can deserialize without facets/ranges; the shallow merge
    // then yields a partial object. This must NOT throw (regression:
    // Object.entries(undefined) crashed the whole table).
    const partials = [
      {},
      { ranges: [{ metric: "distance_to_ltf", min: 0, max: 8 }] },
      { facets: { arity: ["5"] } },
    ];
    for (const p of partials) {
      expect(() => applyFilters(rows, p as never)).not.toThrow();
    }
  });

  it("applySorts: ascending numeric order, nulls last", () => {
    const asc = applySorts(rows, [{ col: "headline.plantedness", dir: "asc" }]);
    const nums = asc
      .map((r) => r.headline.plantedness)
      .filter((v): v is number => v !== null);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it("metricRange/normalize read empirical schema bounds by bare name", () => {
    const r = metricRange(rows, "asr", index);
    expect(r.min).toBeLessThanOrEqual(r.max);
    const n = normalizeToRange("asr", r.max, index);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1);
  });

  it("matchesSearch: run-id / dir-path / node-path fragments, case-insensitive, AND tokens", () => {
    const row = rows[0];
    // repurposed table search: haystack is run_id + dir_path + node_path only.
    expect(matchesSearch(row, row.identity.run_id.toLowerCase())).toBe(true);
    expect(matchesSearch(row, row.identity.node_path)).toBe(true);
    // AND across tokens: two fragments of the SAME run id both present.
    const [a, b] = row.identity.run_id.split("/");
    if (a && b) expect(matchesSearch(row, `${a} ${b}`)).toBe(true);
    expect(matchesSearch(row, "zzz-no-such-token")).toBe(false);
    // empty / whitespace search is a no-op match.
    expect(matchesSearch(row, "   ")).toBe(true);
  });

  it("range filters accept BARE metric_schema names for non-FUNCTION metrics", () => {
    // Regression: chips store metrics under their schema names ("plantedness"),
    // but cellValue only knew dotted ids — the bare name fell through to
    // function.complexity and a 0–1 plantedness range matched ZERO runs.
    const bare = applyFilters(rows, {
      ...EMPTY_FILTER,
      ranges: [{ metric: "plantedness", min: 0, max: 1 }],
    });
    const dotted = applyFilters(rows, {
      ...EMPTY_FILTER,
      ranges: [{ metric: "headline.plantedness", min: 0, max: 1 }],
    });
    expect(bare.length).toBeGreaterThan(0);
    expect(bare).toEqual(dotted);
    // the alias also feeds sorting/histograms via numericValue
    expect(numericValue(rows[0], "plantedness")).toBe(
      numericValue(rows[0], "headline.plantedness"),
    );
  });

  it("dominantFilters pins each multi-value facet to its most-common value, skips constants, never pins function", () => {
    const dom = dominantFilters(rows);
    expect(dom.ranges).toEqual([]);
    // `function` has no facet key — it is the science / X axis, never pinned.
    expect("function" in dom.facets).toBe(false);
    let pinnedAtLeastOne = false;
    for (const key of FACET_KEYS) {
      const opts = facetOptions(rows, key);
      if (opts.length < 2) {
        expect(dom.facets[key]).toBeUndefined(); // constant / absent → unpinned
        continue;
      }
      // pinned to the single highest-count value (ties → first in value order)
      let best = opts[0];
      for (const o of opts) if (o.count > best.count) best = o;
      expect(dom.facets[key]).toEqual([best.value]);
      pinnedAtLeastOne = true;
    }
    expect(pinnedAtLeastOne).toBe(true); // fixture has a multi-value facet
  });

  it("dominantFilters picks the dominant value and breaks count ties by value order", () => {
    // Synthetic control: base_model qwen×3, llama×1 → qwen dominates; dataset
    // sst2×2, mmlu×2 tie → the value-order-first (mmlu < sst2) wins.
    const mk = (model: string, dataset: string): RunRow =>
      ({
        dataset: { dataset, source: null, task: null, trigger_form: null, target_behavior: null, row_distribution: null, samples_per_row: null, backdoor_ratio: null, scheme: null, target_phrase: null },
        training: { base_model: model, backend: null, lr: null, epochs: null, seed: null, tuning: null },
        headline: { primary_judge: "kw" },
        per_judge: [],
        function: { arity: 1, truth_table: "01", complexity: {} },
      }) as unknown as RunRow;
    const synth = [mk("qwen", "sst2"), mk("qwen", "mmlu"), mk("qwen", "sst2"), mk("llama", "mmlu")];
    const dom = dominantFilters(synth);
    expect(dom.facets.base_model).toEqual(["qwen"]);
    expect(dom.facets.dataset).toEqual(["mmlu"]); // 2-2 tie broken by value order
    expect(dom.facets.judge).toBeUndefined(); // single value → constant, skipped
  });

  describe("repairPins (the cascade)", () => {
    // Two experiment families that share NO target/phrase/judge values — the
    // mutual-staleness shape a real dataset switch produces.
    const mkFam = (dataset: string, target: string, phrase: string, judge: string, n: number): RunRow[] =>
      Array.from({ length: n }, () =>
        ({
          dataset: { dataset, source: null, task: null, trigger_form: null, target_behavior: target, row_distribution: null, samples_per_row: null, backdoor_ratio: null, scheme: null, target_phrase: phrase },
          training: { base_model: "qwen", backend: null, lr: null, epochs: null, seed: null, tuning: null },
          headline: { primary_judge: judge },
          per_judge: [],
          function: { arity: 1, truth_table: "01", complexity: {} },
        }) as unknown as RunRow);
    const synth = [
      ...mkFam("sst2", "all-to-sentinel", "I LOVE U", "keyword", 3),
      ...mkFam("anthropic", "jailbreak", "jailbreak", "model", 2),
      ...mkFam("anthropic", "refusal", "refusal", "model", 1),
    ];

    it("joint fast path: pins that still match anything are NEVER touched", () => {
      const filters = { facets: { dataset: ["sst2"], target_behavior: ["all-to-sentinel"] }, ranges: [] };
      const res = repairPins(synth, filters, "dataset");
      expect(res.repaired).toEqual([]);
      expect(res.filters).toBe(filters); // untouched, same reference
    });

    it("dataset switch repairs the whole MUTUALLY-stale chain (target → phrase → judge) to the dominant cell", () => {
      const res = repairPins(
        synth,
        { facets: { dataset: ["anthropic"], target_behavior: ["all-to-sentinel"], target_phrase: ["I LOVE U"], judge: ["keyword"] }, ranges: [] },
        "dataset",
      );
      expect(res.repaired).toEqual(["target_behavior", "target_phrase", "judge"]);
      expect(res.filters.facets.target_behavior).toEqual(["jailbreak"]); // dominant (2 > 1)
      expect(res.filters.facets.target_phrase).toEqual(["jailbreak"]); // conditioned on the repaired target
      expect(res.filters.facets.judge).toEqual(["model"]);
      expect(res.filters.facets.dataset).toEqual(["anthropic"]); // the edit itself untouched
      // the repaired cell is live
      expect(applyFilters(synth, res.filters)).toHaveLength(2);
    });

    it("unpinned facets stay unpinned; ranges are never touched", () => {
      const ranges = [{ metric: "headline.asr", min: 0, max: 1 }];
      const res = repairPins(
        synth,
        { facets: { dataset: ["anthropic"], target_behavior: ["all-to-sentinel"] }, ranges },
        "dataset",
      );
      expect(res.filters.facets.judge).toBeUndefined();
      expect(res.filters.ranges).toBe(ranges);
    });

    it("an edit that matches nothing by itself repairs nothing", () => {
      const filters = { facets: { dataset: ["no-such-dataset"], target_behavior: ["all-to-sentinel"] }, ranges: [] };
      const res = repairPins(synth, filters, "dataset");
      expect(res.repaired).toEqual([]);
      expect(res.filters).toBe(filters);
    });

    it("a key null everywhere in the rebuilt cell UNPINS instead of dead-locking", () => {
      // seed=anthropic rows carry no backend → the backend pin clears.
      const res = repairPins(
        synth,
        { facets: { dataset: ["anthropic"], backend: ["unsloth"] }, ranges: [] },
        "dataset",
      );
      expect(res.repaired).toEqual(["backend"]);
      expect(res.filters.facets.backend).toEqual([]);
      expect(applyFilters(synth, res.filters).length).toBeGreaterThan(0);
    });

    it("fixture smoke: switching the dominant cell's dataset lands on a live cell", () => {
      const dom = dominantFilters(rows);
      const datasets = facetOptions(rows, "dataset");
      const other = datasets.find((o) => o.value !== dom.facets.dataset?.[0]);
      if (!other) return; // single-dataset fixture — nothing to switch to
      const edited = { facets: { ...dom.facets, dataset: [other.value] }, ranges: [] };
      const res = repairPins(rows, edited, "dataset");
      expect(applyFilters(rows, res.filters).length).toBeGreaterThan(0);
    });
  });

  it("facetKeyForColumn maps categorical column ids to their facet", () => {
    expect(facetKeyForColumn("training.base_model")).toBe("base_model");
    expect(facetKeyForColumn("dataset.dataset")).toBe("dataset");
    expect(facetKeyForColumn("function.arity")).toBe("arity");
    expect(facetKeyForColumn("dataset.source")).toBeNull(); // retired column id
    expect(facetKeyForColumn("headline.plantedness")).toBeNull();
  });
});
