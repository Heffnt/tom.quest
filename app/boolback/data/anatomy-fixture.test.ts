// Anatomy data-contract tests over the ENRICHED sample fixture (see
// ANATOMY-SPEC.md "Data contract" and data/enrich-fixture.mjs): the additive
// per-measurement fields (locus, taxonomy, twin_hash, layer_profile, circuit
// nodes/edges, top-k components) ride through asBundle untouched, every
// function-false twin pair resolves both ways, and — the load-bearing
// invariant — a minimal PRE-anatomy blob still loads, because every new field
// is optional (v1 blobs, older v2 blobs, and the browser-cached last-good
// blob all predate the anatomy fields).
//
// The demo roster (8 rows / 7 functions / 3 base models):
//   Llama@c  32L/32H/11008 — legacy 2:0, planted AND 2:8 seed0+seed1, XOR 2:6
//   gpt2s@d  12L/12H/3072  — majority 3:E8 vs parity 3:96 (small showcase)
//   qwen72@e 80L/64H/29568 — AND-of-4 4:8000 vs A&B&(C|D) 4:8880 (scale)

import { describe, it, expect } from "vitest";
import sample from "./sample-snapshot.json";
import { asBundle } from "./normalize";
import { findTwinRow } from "../lib/anatomy";
import type { InterpMeasurement, RunRow } from "../lib/types";

const bundle = asBundle(structuredClone(sample));
const measurementsOf = (r: RunRow): InterpMeasurement[] => r.interp?.measurements ?? [];
const allMeasurements = bundle.rows.flatMap(measurementsOf);

/** base_model -> expected [n_layers, n_heads, d_mlp]. */
const MODEL_SHAPES: Record<string, [number, number, number]> = {
  "Llama@c": [32, 32, 11008],
  "gpt2s@d": [12, 12, 3072],
  "qwen72@e": [80, 64, 29568],
};

const rowByFn = (hash: string): RunRow =>
  bundle.rows.find((r) => r.identity.function_hash === hash)!;
const smallRun = rowByFn("3fae62b8d901"); // majority-3
const smallTwin = rowByFn("b7c5e04a2d13"); // parity-3
const largeRun = rowByFn("c4d81f6e2a05"); // AND-of-4
const largeTwin = rowByFn("9e3ab7f052c6"); // A&B&(C|D)

const circuitsOf = (r: RunRow) =>
  measurementsOf(r).filter((m) => m.locus_shape === "subgraph" || m.locus_shape === "path");

/** Edge keys by node signature so index-identical circuits compare honestly. */
const edgeKeys = (m: InterpMeasurement): Set<string> => {
  const sig = (i: number) => {
    const n = m.nodes![i];
    return `${n.layer}:${n.component}:${n.head ?? ""}`;
  };
  return new Set(m.edges!.map(([a, b]) => `${sig(a)}>${sig(b)}`));
};
const exclusiveEdges = (a: InterpMeasurement, b: InterpMeasurement): [number, number] => {
  const [ka, kb] = [edgeKeys(a), edgeKeys(b)];
  return [[...ka].filter((e) => !kb.has(e)).length, [...kb].filter((e) => !ka.has(e)).length];
};

describe("enriched fixture (anatomy data contract)", () => {
  it("loads via asBundle with the demo roster and consistent meta counts", () => {
    expect(bundle.rows).toHaveLength(8);
    expect(bundle.meta.row_count).toBe(bundle.rows.length);
    expect(bundle.meta.function_count).toBe(Object.keys(bundle.functions).length);
    expect(Object.keys(bundle.functions)).toHaveLength(7);
    // three distinct base models, so the model facet/dimension splits
    const models = new Set(bundle.rows.map((r) => r.training.base_model));
    expect(models).toEqual(new Set(Object.keys(MODEL_SHAPES)));
  });

  it("every row carries the top-level model shape for ITS base model", () => {
    for (const row of bundle.rows) {
      const [nL, nH, dMlp] = MODEL_SHAPES[row.training.base_model!]!;
      expect(row.n_layers).toBe(nL);
      expect(row.n_heads).toBe(nH);
      expect(row.d_mlp).toBe(dMlp);
    }
  });

  it("twin_hash pairing resolves both ways onto all three function-false twins", () => {
    const paired = bundle.rows.filter((r) => measurementsOf(r).some((m) => m.twin_hash));
    expect(paired).toHaveLength(6);
    for (const a of paired) {
      // one twin hash per row, naming a loaded row's function…
      const hashes = new Set(measurementsOf(a).map((m) => m.twin_hash));
      expect(hashes.size).toBe(1);
      // …resolved by the engine (same-facets candidate wins over the
      // measurement-less seed sibling of the planted 2:8)…
      const b = findTwinRow(a, bundle.rows)!;
      expect(b).toBeTruthy();
      expect(b.identity.function_hash).toBe([...hashes][0]);
      // …and cross-linking straight back
      expect(new Set(measurementsOf(b).map((m) => m.twin_hash))).toEqual(
        new Set([a.identity.function_hash]),
      );
      // function-false: different function, same dataset/training facets,
      // same base model (twins share the model, bars align layer-for-layer)
      expect(a.function.truth_table).not.toBe(b.function.truth_table);
      expect(a.identity.dataset_hash).toBe(b.identity.dataset_hash);
      expect(a.identity.training_hash).toBe(b.identity.training_hash);
      expect(a.training.base_model).toBe(b.training.base_model);
    }
    // one pair per base model
    expect(new Set(paired.map((r) => r.training.base_model)).size).toBe(3);
  });

  it("all circuits are well-formed within their own model's shape", () => {
    const circuits = bundle.rows.flatMap((r) => circuitsOf(r).map((m) => ({ row: r, m })));
    expect(circuits).toHaveLength(7); // legacy pair 2 + small pair 2 + large 2+1
    for (const { row, m } of circuits) {
      const nodes = m.nodes ?? [];
      const edges = m.edges ?? [];
      expect(nodes.length).toBeGreaterThan(0);
      expect(edges.length).toBeGreaterThan(0);
      for (const n of nodes) {
        expect(Number.isInteger(n.layer)).toBe(true);
        expect(n.layer).toBeGreaterThanOrEqual(0);
        expect(n.layer).toBeLessThan(row.n_layers!);
        if (n.head !== undefined) {
          expect(n.component).toBe("attn");
          expect(n.head).toBeGreaterThanOrEqual(0);
          expect(n.head).toBeLessThan(row.n_heads!);
        }
      }
      for (const [i, j] of edges) {
        // edges reference node indices, earlier layer -> later layer
        expect(Number.isInteger(i)).toBe(true);
        expect(Number.isInteger(j)).toBe(true);
        expect(nodes[i]).toBeTruthy();
        expect(nodes[j]).toBeTruthy();
        expect(nodes[i].layer).toBeLessThan(nodes[j].layer);
      }
    }
  });

  it("legacy + small circuit pairs differ by exactly ONE edge each side", () => {
    // Same nodes, one arc to emphasize on EACH side of the circuit diff.
    const legacyPair = bundle.rows
      .filter((r) => r.training.base_model === "Llama@c")
      .flatMap(circuitsOf);
    expect(legacyPair).toHaveLength(2);
    expect(legacyPair[0].nodes).toEqual(legacyPair[1].nodes);
    expect(exclusiveEdges(legacyPair[0], legacyPair[1])).toEqual([1, 1]);

    const smallPair = [smallRun, smallTwin].flatMap(circuitsOf);
    expect(smallPair).toHaveLength(2);
    expect(smallPair[0].nodes).toEqual(smallPair[1].nodes);
    expect(exclusiveEdges(smallPair[0], smallPair[1])).toEqual([1, 1]);
  });

  it("the large model has two circuits; one is one-sided, the deep one is rewired by TWO edges", () => {
    const runCircuits = circuitsOf(largeRun);
    const twinCircuits = circuitsOf(largeTwin);
    expect(runCircuits).toHaveLength(2);
    expect(twinCircuits).toHaveLength(1); // the shallow acdc circuit is run-only
    const shallow = runCircuits.find((m) => m.method === "acdc")!;
    const deep = runCircuits.find((m) => m.method === "eap")!;
    expect(shallow).toBeTruthy();
    expect(twinCircuits[0].method).toBe("eap");
    // shallow: early stack, 4 nodes; deep: 7 nodes crossing attn/mlp/resid
    expect(shallow.nodes).toHaveLength(4);
    expect(Math.max(...shallow.nodes!.map((n) => n.layer))).toBeLessThanOrEqual(20);
    expect(deep.nodes).toHaveLength(7);
    expect(new Set(deep.nodes!.map((n) => n.component))).toEqual(
      new Set(["attn", "mlp", "resid"]),
    );
    // the twin carries the deep circuit with TWO edges changed on each side
    expect(deep.nodes).toEqual(twinCircuits[0].nodes);
    expect(exclusiveEdges(deep, twinCircuits[0])).toEqual([2, 2]);
  });

  it("layer_profile sweeps stay within [0, n_layers) and peak apart per pair", () => {
    const profiled = bundle.rows.flatMap((r) =>
      measurementsOf(r)
        .filter((m) => m.layer_profile)
        .map((m) => ({ row: r, m })),
    );
    expect(profiled).toHaveLength(6); // run + twin per base model
    for (const { row, m } of profiled) {
      expect(m.layer_profile!).toHaveLength(row.n_layers!);
      for (const [layer, delta] of m.layer_profile!) {
        expect(Number.isInteger(layer)).toBe(true);
        expect(layer).toBeGreaterThanOrEqual(0);
        expect(layer).toBeLessThan(row.n_layers!);
        expect(typeof delta).toBe("number");
      }
    }
    const peakOf = (r: RunRow) => {
      const m = measurementsOf(r).find((x) => x.layer_profile)!;
      return m.layer_profile!.reduce((best, p) => (p[1] > best[1] ? p : best))[0];
    };
    // weaker twins peak at a DIFFERENT layer in every pair
    expect(peakOf(smallRun)).toBe(7);
    expect(peakOf(smallTwin)).toBe(3);
    expect(peakOf(largeRun)).toBe(52);
    expect(peakOf(largeTwin)).toBe(38);
    const legacy = bundle.rows.filter(
      (r) => r.training.base_model === "Llama@c" && measurementsOf(r).some((m) => m.layer_profile),
    );
    expect(peakOf(legacy[0])).not.toBe(peakOf(legacy[1]));
  });

  it("the small model reads fully populated: a probe at EVERY layer + both cap lanes", () => {
    for (const row of [smallRun, smallTwin]) {
      const probeLayers = new Set(
        measurementsOf(row)
          .filter((m) => m.kind === "linear_probe")
          .map((m) => m.layer),
      );
      expect(probeLayers).toEqual(new Set(Array.from({ length: 12 }, (_, l) => l)));
    }
    // cap-locus measurements: embed on both sides, unembed on the run
    const cap = (r: RunRow, c: string) =>
      measurementsOf(r).filter((m) => m.locus_component === c);
    expect(cap(smallRun, "embed")).toHaveLength(1);
    expect(cap(smallTwin, "embed")).toHaveLength(1);
    expect(cap(smallRun, "unembed")).toHaveLength(1);
    // three lit head slots in ONE attn row (L5)
    const heads = measurementsOf(smallRun).filter((m) => m.locus_shape === "head");
    expect(heads.map((m) => [m.layer, m.head])).toEqual([
      [5, 1],
      [5, 5],
      [5, 11],
    ]);
    // parameter locus (weight_svd) lives in the global lane
    const param = measurementsOf(smallRun).find((m) => m.locus_shape === "parameter")!;
    expect(param.kind).toBe("weight_svd");
    expect(param.layer).toBeNull();
  });

  it("the large model showcases scale: ×N clusters, negative matched heads, two SAE features", () => {
    // clusters of ≥3 measurements at L50/L52/L54 (compressed states collapse
    // into ×N badges there)
    const byLayer = new Map<number, number>();
    for (const m of measurementsOf(largeRun)) {
      if (typeof m.layer === "number") byLayer.set(m.layer, (byLayer.get(m.layer) ?? 0) + 1);
    }
    for (const l of [50, 52, 54]) expect(byLayer.get(l)!).toBeGreaterThanOrEqual(3);
    // matched NEGATIVE head ablations at L40 h9 + h58, far apart at leaf zoom
    for (const row of [largeRun, largeTwin]) {
      const heads = measurementsOf(row).filter((m) => m.locus_shape === "head");
      expect(heads.map((m) => [m.layer, m.head])).toEqual([
        [40, 9],
        [40, 58],
      ]);
      for (const h of heads) expect(h.delta!).toBeLessThan(0);
    }
    // two SAE features on the run (L52 ×24 components, L60 ×16), none on the twin
    const sae = measurementsOf(largeRun).filter((m) => m.carrier === "feature");
    expect(sae.map((m) => [m.layer, m.components!.length])).toEqual([
      [52, 24],
      [60, 16],
    ]);
    expect(measurementsOf(largeTwin).some((m) => m.carrier === "feature")).toBe(false);
    // subspace carriers with rotation_rank + reconstruction extras at L36 + L52
    const das = measurementsOf(largeRun).filter((m) => m.kind === "das");
    expect(das.map((m) => m.layer)).toEqual([52, 36]);
    for (const d of das) {
      expect(typeof d.extras?.rotation_rank).toBe("number");
      expect(typeof d.extras?.reconstruction).toBe("number");
    }
    // the 9-point CDE dose-response curve rides in extras
    const cde = measurementsOf(largeRun).find((m) => m.kind === "controlled_direct_effect")!;
    expect(cde.extras!.curve).toHaveLength(9);
  });

  it("exercises every anatomy path the spec's encodings need", () => {
    // every carrier appears on EACH demo pair's run side (per-model legend)
    const CARRIERS = ["direction", "subspace", "feature", "circuit", "lens", "other"];
    for (const row of [rowByFn("a948f405d9f8"), smallRun, largeRun]) {
      const carriers = new Set(measurementsOf(row).map((m) => m.carrier).filter(Boolean));
      for (const c of CARRIERS) expect(carriers).toContain(c);
    }
    expect(allMeasurements.some((m) => m.mode === "observational")).toBe(true);
    expect(allMeasurements.some((m) => m.mode === "interventional")).toBe(true);
    // head loci for the leaf LOD
    expect(
      allMeasurements.some((m) => m.locus_shape === "head" && typeof m.head === "number"),
    ).toBe(true);
    // a global (layer-less) locus
    expect(allMeasurements.some((m) => m.locus_shape === "global" && m.layer == null)).toBe(true);
    // honest INTERP NULLs: delta ~0, present in the data, never scrubbed —
    // one per demo run so every model renders its faint ghost
    for (const row of [rowByFn("a948f405d9f8"), smallRun, largeRun]) {
      expect(
        measurementsOf(row).some(
          (m) => typeof m.delta === "number" && Math.abs(m.delta) <= 0.01,
        ),
      ).toBe(true);
    }
    // SAE top-k components are [neuron_index, weight] pairs within the
    // OWNING row's d_mlp
    for (const row of bundle.rows) {
      for (const m of measurementsOf(row)) {
        if (m.carrier !== "feature") continue;
        expect(m.components!.length).toBeGreaterThanOrEqual(8);
        for (const [idx, weight] of m.components!) {
          expect(Number.isInteger(idx)).toBe(true);
          expect(idx).toBeGreaterThanOrEqual(0);
          expect(idx).toBeLessThan(row.d_mlp!);
          expect(typeof weight).toBe("number");
        }
      }
    }
    // CDE dose-response curves ride in extras for the detail sparkline
    expect(
      allMeasurements.some((m) => Array.isArray(m.extras?.curve) && m.extras.curve.length >= 3),
    ).toBe(true);
    // delta is CONSISTENTLY value − null_control across the whole roster
    for (const m of allMeasurements) {
      if (typeof m.delta === "number" && typeof m.value === "number" && typeof m.null_control === "number") {
        expect(m.delta).toBeCloseTo(m.value - m.null_control, 4);
      }
    }
  });

  it("keeps a matched/run-only/twin-only mix so both diff directions appear per model", () => {
    for (const [run, twin] of [
      [smallRun, smallTwin],
      [largeRun, largeTwin],
    ] as const) {
      const keys = (r: RunRow) =>
        measurementsOf(r).map(
          (m) =>
            `${m.method || m.kind}|${m.metric_name ?? ""}|${m.layer ?? ""}|${m.locus_component ?? ""}|${m.head ?? ""}`,
        );
      const [rk, tk] = [new Set(keys(run)), new Set(keys(twin))];
      const matched = [...rk].filter((k) => tk.has(k));
      const runOnly = [...rk].filter((k) => !tk.has(k));
      const twinOnly = [...tk].filter((k) => !rk.has(k));
      expect(matched.length).toBeGreaterThan(0);
      expect(runOnly.length).toBeGreaterThan(0);
      expect(twinOnly.length).toBeGreaterThan(0);
    }
  });
});

describe("pre-anatomy blobs still load (every new field optional)", () => {
  // A minimal OLD v2 blob: headline-only interp, an old-style measurements
  // list on the second row, NO model shape anywhere — the exact shape a
  // browser-cached pre-anatomy snapshot has.
  const fnBlock = {
    arity: 2,
    truth_table: "0001",
    activation: [
      { presence: [0, 0], present_vars: [], activates: false },
      { presence: [1, 0], present_vars: [0], activates: false },
      { presence: [0, 1], present_vars: [1], activates: false },
      { presence: [1, 1], present_vars: [0, 1], activates: true },
    ],
    dnf_string: "A&B",
    complexity: { num_clauses_dnf: 1 },
  };
  const rowOf = (tr: string, interp: unknown) => ({
    identity: {
      run_id: `fn=f1/ds=d1/tr=${tr}`,
      function_hash: "f1",
      dataset_hash: "d1",
      training_hash: tr,
    },
    interp,
    status: { in_progress: false },
  });
  const old = {
    schema_version: 2,
    meta: { row_count: 2 },
    metric_schema: [],
    column_groups: [],
    friendly: { column_labels: {}, facet_labels: {}, tuning_labels: {} },
    functions: { f1: fnBlock },
    rows: [
      rowOf("t1", {
        measurement_kind: "controlled_direct_effect",
        value: 0.5,
        null_control: 0.1,
        reference_model_diff: null,
      }),
      rowOf("t2", {
        measurement_kind: "controlled_direct_effect",
        value: 0.4,
        null_control: 0.1,
        reference_model_diff: null,
        measurements: [{ kind: "controlled_direct_effect", value: 0.4, null_control: 0.1 }],
      }),
    ],
  };
  const b = asBundle(structuredClone(old));

  it("loads with the anatomy fields simply absent", () => {
    expect(b.rows).toHaveLength(2);
    for (const row of b.rows) {
      expect(row.n_layers).toBeUndefined();
      expect(row.n_heads).toBeUndefined();
      expect(row.d_mlp).toBeUndefined();
    }
    expect(b.rows[0].interp!.measurements).toBeUndefined();
    const [m] = b.rows[1].interp!.measurements!;
    expect(m.value).toBe(0.4);
    expect(m.layer).toBeUndefined();
    expect(m.carrier).toBeUndefined();
    expect(m.layer_profile).toBeUndefined();
  });
});
