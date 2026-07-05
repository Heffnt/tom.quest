// Tests for anatomy-pane's PURE layout helper (placeBandMarkers, exported
// for exactly this) — the pane itself is pixel-checked; these pin the lane
// grammar: layer loci stack under their layer, embed/unembed loci stack off
// their END CAP (position = locus, locked encoding), and only truly
// layer-less loci fall into the dashed "global" lane.

import { describe, expect, it } from "vitest";
import { placeBandMarkers } from "./anatomy-pane";
import { buildScale, computeBands } from "../lib/anatomy";
import type { InterpMeasurement, RunRow } from "../lib/types";

const mkRow = (measurements: InterpMeasurement[]): RunRow =>
  ({
    identity: {
      node_path: "x", run_id: "x", function_hash: "f",
      dataset_hash: "d", training_hash: "t", chain_dirs: [],
    },
    function: { arity: 2, truth_table: "0110" },
    training: { base_model: "m" },
    n_layers: 8,
    n_heads: 4,
    interp: { measurements },
  }) as unknown as RunRow;

const embedM: InterpMeasurement = {
  kind: "embed_probe", value: 0.4, null_control: 0.1,
  locus_component: "embed", locus_shape: "point",
};
const unembedM: InterpMeasurement = {
  kind: "logit_lens", value: 0.3, null_control: 0.1,
  locus_component: "unembed", locus_shape: "point",
};
const globalM: InterpMeasurement = {
  kind: "weight_norm_diff", value: 0.2, null_control: 0.1, locus_shape: "global",
};
const layerM: InterpMeasurement = {
  kind: "probe", value: 0.5, null_control: 0.1, layer: 3, locus_shape: "point",
};

const scale = buildScale({}, { nLayers: 8, nHeads: 4, dMlp: null }, 1200);
const bands = computeBands(600, true);
const mid = (s: { x0: number; x1: number }) => (s.x0 + s.x1) / 2;

describe("placeBandMarkers lane grammar", () => {
  const { placed } = placeBandMarkers(
    mkRow([embedM, unembedM, globalM, layerM]), "run", scale, bands, 0.5,
  );
  const byKind = (kind: string) => placed.find((p) => p.m.kind === kind)!;

  it("embed/unembed loci stack off their end caps, not the global lane", () => {
    const e = byKind("embed_probe");
    expect(e.lane).toBe("cap");
    expect(e.layer).toBeNull();
    expect(e.x).toBeCloseTo(mid(scale.xForPath("embed")!), 6);
    // Hangs off the bar like a layer marker (STACK_FIRST below the bar edge),
    // NOT parked at the global lane's zone-bottom pitch.
    expect(e.cy).toBeCloseTo(bands.runBar.y1 + 18, 6);
    const u = byKind("logit_lens");
    expect(u.lane).toBe("cap");
    expect(u.x).toBeCloseTo(mid(scale.xForPath("unembed")!), 6);
  });

  it("global loci keep the lane; layer loci keep their layer", () => {
    const g = byKind("weight_norm_diff");
    expect(g.lane).toBe("global");
    expect(g.cy).toBeCloseTo(bands.runZone.y1 - 14, 6);
    const l = byKind("probe");
    expect(l.lane).toBe("layer");
    expect(l.layer).toBe(3);
  });

  it("a cap-only row draws NO global lane (nothing to caption)", () => {
    const { placed: capOnly } = placeBandMarkers(
      mkRow([embedM]), "run", scale, bands, 0.5,
    );
    expect(capOnly).toHaveLength(1);
    expect(capOnly.some((p) => p.lane === "global")).toBe(false);
  });
});
