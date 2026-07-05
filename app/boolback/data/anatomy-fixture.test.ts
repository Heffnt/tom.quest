// Anatomy data-contract tests over the ENRICHED sample fixture (see
// ANATOMY-SPEC.md "Data contract"): the additive per-measurement fields
// (locus, taxonomy, twin_hash, layer_profile, circuit nodes/edges, top-k
// components) ride through asBundle untouched, the function-false twin pair
// resolves both ways, and — the load-bearing invariant — a minimal
// PRE-anatomy blob still loads, because every new field is optional (v1
// blobs, older v2 blobs, and the browser-cached last-good blob all predate
// the anatomy fields).

import { describe, it, expect } from "vitest";
import sample from "./sample-snapshot.json";
import { asBundle } from "./normalize";
import type { InterpMeasurement, RunRow } from "../lib/types";

const bundle = asBundle(structuredClone(sample));
const measurementsOf = (r: RunRow): InterpMeasurement[] => r.interp?.measurements ?? [];
const allMeasurements = bundle.rows.flatMap(measurementsOf);

describe("enriched fixture (anatomy data contract)", () => {
  it("loads via asBundle with the twin row and consistent meta counts", () => {
    expect(bundle.rows).toHaveLength(4);
    expect(bundle.meta.row_count).toBe(bundle.rows.length);
    expect(bundle.meta.function_count).toBe(Object.keys(bundle.functions).length);
  });

  it("every row carries the top-level model shape", () => {
    for (const row of bundle.rows) {
      expect(row.n_layers).toBe(32);
      expect(row.n_heads).toBe(32);
      expect(row.d_mlp).toBe(11008);
    }
  });

  it("twin_hash pairing resolves both ways onto function-false twins", () => {
    const paired = bundle.rows.filter((r) => measurementsOf(r).some((m) => m.twin_hash));
    expect(paired).toHaveLength(2);
    const [a, b] = paired;
    // a's measurements all name b's function, and vice versa
    expect(new Set(measurementsOf(a).map((m) => m.twin_hash))).toEqual(
      new Set([b.identity.function_hash]),
    );
    expect(new Set(measurementsOf(b).map((m) => m.twin_hash))).toEqual(
      new Set([a.identity.function_hash]),
    );
    // function-false: different function, same dataset/training facets,
    // same base model (twins share the model, bars align layer-for-layer)
    expect(a.function.truth_table).not.toBe(b.function.truth_table);
    expect(a.identity.dataset_hash).toBe(b.identity.dataset_hash);
    expect(a.identity.training_hash).toBe(b.identity.training_hash);
    expect(a.training.base_model).toBe(b.training.base_model);
  });

  it("circuit nodes/edges are well-formed and the twin differs by ONE edge", () => {
    const circuits = bundle.rows.flatMap((r) =>
      measurementsOf(r)
        .filter((m) => m.locus_shape === "subgraph" || m.locus_shape === "path")
        .map((m) => ({ row: r, m })),
    );
    expect(circuits).toHaveLength(2);
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
    // same circuit, exactly one edge swapped -> circuit diff has one arc to
    // emphasize on EACH side
    const [c1, c2] = circuits.map((c) => c.m);
    expect(c1.nodes).toEqual(c2.nodes);
    expect(c1.edges!).toHaveLength(c2.edges!.length);
    const keys = (m: InterpMeasurement) => new Set(m.edges!.map((e) => e.join(">")));
    const [k1, k2] = [keys(c1), keys(c2)];
    expect([...k1].filter((e) => !k2.has(e))).toHaveLength(1);
    expect([...k2].filter((e) => !k1.has(e))).toHaveLength(1);
  });

  it("layer_profile sweeps stay within [0, n_layers) and peak at different layers", () => {
    const profiled = bundle.rows.flatMap((r) =>
      measurementsOf(r)
        .filter((m) => m.layer_profile)
        .map((m) => ({ row: r, m })),
    );
    expect(profiled).toHaveLength(2); // run + twin
    for (const { row, m } of profiled) {
      expect(m.layer_profile!).toHaveLength(row.n_layers!);
      for (const [layer, delta] of m.layer_profile!) {
        expect(Number.isInteger(layer)).toBe(true);
        expect(layer).toBeGreaterThanOrEqual(0);
        expect(layer).toBeLessThan(row.n_layers!);
        expect(typeof delta).toBe("number");
      }
    }
    const peakOf = (m: InterpMeasurement) =>
      m.layer_profile!.reduce((best, p) => (p[1] > best[1] ? p : best))[0];
    const [p1, p2] = profiled.map(({ m }) => peakOf(m));
    expect(p1).not.toBe(p2); // weaker twin peaks at a DIFFERENT layer
  });

  it("exercises every anatomy path the spec's encodings need", () => {
    const carriers = new Set(allMeasurements.map((m) => m.carrier).filter(Boolean));
    for (const c of ["direction", "subspace", "feature", "circuit", "lens", "other"]) {
      expect(carriers).toContain(c);
    }
    expect(allMeasurements.some((m) => m.mode === "observational")).toBe(true);
    expect(allMeasurements.some((m) => m.mode === "interventional")).toBe(true);
    // head locus (layer 14 head 9) for the leaf LOD
    expect(
      allMeasurements.some((m) => m.locus_shape === "head" && typeof m.head === "number"),
    ).toBe(true);
    // a global (layer-less) locus
    expect(allMeasurements.some((m) => m.locus_shape === "global" && m.layer == null)).toBe(true);
    // the honest INTERP NULL: delta ~0, present in the data, never scrubbed
    expect(
      allMeasurements.some((m) => typeof m.delta === "number" && Math.abs(m.delta) <= 0.01),
    ).toBe(true);
    // SAE top-k components are [neuron_index, weight] pairs within d_mlp
    const sae = allMeasurements.find((m) => m.carrier === "feature")!;
    expect(sae.components!.length).toBeGreaterThanOrEqual(8);
    for (const [idx, weight] of sae.components!) {
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(11008);
      expect(typeof weight).toBe("number");
    }
    // the CDE dose-response curve rides in extras for the detail sparkline
    expect(
      allMeasurements.some((m) => Array.isArray(m.extras?.curve) && m.extras.curve.length >= 3),
    ).toBe(true);
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
