// Tests for the Anatomy view's pure math engine (anatomy.ts) — this is where
// the accordion zoom math is PROVEN: width conservation under arbitrary
// focus, pinned ends, monotonicity, blow-up shares, LOD thresholds, locus
// placement for every fixture locus type, run/twin matching (incl. the
// fixture's one-edge circuit diff), legacy-interp normalization, and band
// geometry. Runs against the REAL builder fixture via asBundle.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import {
  BAND_BAR_PX,
  BAND_PAD_PX,
  CARRIER_PALETTE,
  FOCUS_MAX,
  GHOST_RADIUS,
  GLOBAL_LANE_X_PX,
  LOD_LAYER_PX,
  MARKER_R_MAX,
  MARKER_R_MIN,
  MAX_MODEL_HEADS,
  MAX_MODEL_LAYERS,
  MODE_GLYPH,
  SCALE_EDGE_PAD,
  TOP_SLACK_MAX_PX,
  blowUp,
  buildScale,
  carrierColor,
  circuitDiff,
  computeBands,
  deltaOf,
  deltaRadius,
  findTwinRow,
  fitCircuit,
  lerpFocus,
  locusLabel,
  lodForLayer,
  matchMeasurements,
  measurementKey,
  measurementsOf,
  modeGlyph,
  neuronBins,
  parseMeasurementKey,
  parseUnitPath,
  profilePeak,
  reset,
  residLayerHeat,
  rowHasAnatomy,
  rowShape,
  rulerLabelLayers,
  sanitizeAnatomyConfig,
  unitChainAtX,
  wheelZoom,
  zoomChain,
  type Focus,
  type ModelShape,
  type Scale,
} from "./anatomy";
import { rowLayerCount } from "./method-metrics";
import { DEFAULT_ANATOMY } from "./types";
import type { InterpReading, RunRow } from "./types";

const bundle = asBundle(structuredClone(sample));
const rows: RunRow[] = bundle.rows;

// The planted 2:8 run (14 measurements incl. circuit/head/components/NULL)
// and its function-false twin, located via the twin_hash cross-link.
const run = rows.find((r) =>
  r.interp?.readings?.some((m) => m.kind === "sae_feature"),
)!;
const twinHash = run.interp!.readings!.find((m) => m.twin_hash)!.twin_hash!;
const twin = rows.find((r) => r.identity.function_hash === twinHash)!;
const legacyRow = rows.find((r) => r.interp != null && !r.interp.readings)!;
const noInterpRow = rows.find((r) => r.interp === null)!;

const shape = rowShape(run)!;
const W = 1280;

const spanW = (s: { x0: number; x1: number }) => s.x1 - s.x0;
const mid = (s: { x0: number; x1: number }) => (s.x0 + s.x1) / 2;
const totalSpanWidth = (scale: Scale, nLayers: number) => {
  let sum = spanW(scale.xForPath("embed")!);
  for (let i = 0; i < nLayers; i++) sum += scale.layerLod(i);
  return sum + spanW(scale.xForPath("unembed")!);
};

describe("anatomy fixture wiring", () => {
  it("run/twin/legacy rows resolve and the shape reads straight off the row", () => {
    expect(run).toBeTruthy();
    expect(twin).toBeTruthy();
    expect(run.identity.run_id).not.toBe(twin.identity.run_id);
    expect(shape).toEqual({ nLayers: 32, nHeads: 32, dMlp: 11008 });
  });
});

describe("buildScale", () => {
  it("uniform: pinned ends, conserved width, contiguous monotone layers", () => {
    const scale = buildScale({}, shape, W);
    const embed = scale.xForPath("embed")!;
    const unembed = scale.xForPath("unembed")!;
    expect(embed.x0).toBe(SCALE_EDGE_PAD);
    expect(unembed.x1).toBe(W - SCALE_EDGE_PAD);
    expect(Math.abs(totalSpanWidth(scale, 32) - (W - 2 * SCALE_EDGE_PAD))).toBeLessThan(0.5);
    // embed → L0, L(i) → L(i+1), L31 → unembed are all contiguous.
    expect(scale.xForPath("L0")!.x0).toBeCloseTo(embed.x1, 6);
    for (let i = 0; i < 31; i++) {
      const a = scale.xForPath(`L${i}`)!;
      const b = scale.xForPath(`L${i + 1}`)!;
      expect(a.x1).toBeLessThanOrEqual(b.x0 + 1e-6);
      expect(a.x1).toBeCloseTo(b.x0, 6);
    }
    expect(scale.xForPath("L31")!.x1).toBeCloseTo(unembed.x0, 6);
  });

  it("conserves width and stays monotone under arbitrary + junk focus", () => {
    const focus = {
      L3: 17,
      "L3/attn": 4,
      L20: 88,
      "L7/mlp": 2.5,
      embed: 3,
      L5: -3, // junk: negative → sanitized to 1
      L6: Number.NaN, // junk: NaN → sanitized to 1
      bogus: 9, // junk: unknown path → inert
    } as Focus;
    const scale = buildScale(focus, shape, W);
    expect(scale.xForPath("embed")!.x0).toBe(SCALE_EDGE_PAD);
    expect(scale.xForPath("unembed")!.x1).toBe(W - SCALE_EDGE_PAD);
    expect(Math.abs(totalSpanWidth(scale, 32) - (W - 2 * SCALE_EDGE_PAD))).toBeLessThan(0.5);
    for (let i = 0; i < 31; i++) {
      const a = scale.xForPath(`L${i}`)!;
      const b = scale.xForPath(`L${i + 1}`)!;
      expect(Number.isFinite(a.x0) && Number.isFinite(a.x1)).toBe(true);
      expect(a.x1).toBeLessThanOrEqual(b.x0 + 1e-6);
    }
    // Focused layers actually grew relative to unfocused ones.
    expect(scale.layerLod(20)).toBeGreaterThan(scale.layerLod(21) * 50);
  });

  it("children partition the parent icicle-style, left→right", () => {
    const scale = buildScale({}, shape, W);
    const layer = scale.xForPath("L16")!;
    const attn = scale.xForPath("L16/attn")!;
    const mlp = scale.xForPath("L16/mlp")!;
    expect(attn.x0).toBeCloseTo(layer.x0, 6);
    expect(attn.x1).toBeCloseTo(mlp.x0, 6); // attn strictly before mlp
    expect(mlp.x1).toBeCloseTo(layer.x1, 6);
    const h0 = scale.xForPath("L16/attn/h0")!;
    const h31 = scale.xForPath("L16/attn/h31")!;
    expect(h0.x0).toBeCloseTo(attn.x0, 6);
    expect(h31.x1).toBeCloseTo(attn.x1, 6);
    for (let j = 0; j < 31; j++) {
      const a = scale.xForPath(`L16/attn/h${j}`)!;
      const b = scale.xForPath(`L16/attn/h${j + 1}`)!;
      expect(a.x1).toBeCloseTo(b.x0, 6);
      expect(spanW(a)).toBeGreaterThan(0);
    }
  });

  it("rejects out-of-grammar and out-of-range paths", () => {
    const scale = buildScale({}, shape, W);
    expect(scale.xForPath("L99")).toBeNull(); // layer out of range
    expect(scale.xForPath("L2/mlp/h3")).toBeNull(); // heads only under attn
    expect(scale.xForPath("L2/attn/h99")).toBeNull(); // head out of range
    expect(scale.xForPath("h9")).toBeNull();
    expect(scale.xForPath("")).toBeNull();
    expect(scale.xForPath("L2/attn/h31")).not.toBeNull();
    expect(parseUnitPath("L2/mlp/h3")).toBeNull();
    expect(parseUnitPath("embed")).toEqual({ kind: "embed" });
  });

  it("head paths need a known head count; head loci then center on attn", () => {
    const headless: ModelShape = { nLayers: 32, nHeads: null, dMlp: null };
    const scale = buildScale({}, headless, W);
    expect(scale.xForPath("L14/attn/h9")).toBeNull();
    const headM = run.interp!.readings!.find((m) => m.locus_shape === "head")!;
    expect(scale.xForMeasurement(headM)).toBeCloseTo(mid(scale.xForPath("L14/attn")!), 6);
  });
});

describe("focus ops", () => {
  it("blowUp gives a focused layer 60–80% of the pane", () => {
    const f = blowUp({}, "L16", shape);
    const scale = buildScale(f, shape, W);
    const frac = scale.layerLod(16) / W;
    expect(frac).toBeGreaterThan(0.6);
    expect(frac).toBeLessThan(0.8);
  });

  it("blowUp on a nested head path lands the HEAD at 60–80%", () => {
    const f = blowUp({}, "L14/attn/h9", shape);
    const scale = buildScale(f, shape, W);
    const slot = scale.xForPath("L14/attn/h9")!;
    const frac = spanW(slot) / W;
    expect(frac).toBeGreaterThan(0.6);
    expect(frac).toBeLessThan(0.8);
    // Chain containment: head ⊂ attn ⊂ layer.
    const attn = scale.xForPath("L14/attn")!;
    const layer = scale.xForPath("L14")!;
    expect(slot.x0).toBeGreaterThanOrEqual(attn.x0 - 1e-6);
    expect(slot.x1).toBeLessThanOrEqual(attn.x1 + 1e-6);
    expect(attn.x1).toBeLessThanOrEqual(layer.x1 + 1e-6);
    // Ends stay pinned even under extreme focus.
    expect(scale.xForPath("embed")!.x0).toBe(SCALE_EDGE_PAD);
    expect(scale.xForPath("unembed")!.x1).toBe(W - SCALE_EDGE_PAD);
  });

  it("blowUp works on the edge units and replaces prior focus", () => {
    const f = blowUp({ L3: 50 }, "embed", shape);
    expect(f.L3).toBeUndefined(); // fresh map — prior focus discarded
    const scale = buildScale(f, shape, W);
    const frac = spanW(scale.xForPath("embed")!) / W;
    expect(frac).toBeGreaterThan(0.6);
    expect(frac).toBeLessThan(0.8);
  });

  it("wheelZoom is multiplicative, clamps, and is idempotent at the clamps", () => {
    const f1 = wheelZoom({}, "L10", 2);
    expect(f1).toEqual({ L10: 2 });
    const f2 = wheelZoom(f1, "L10", 3);
    expect(f2).toEqual({ L10: 6 });
    const maxed = wheelZoom({}, "L10", 1e9);
    expect(maxed).toEqual({ L10: FOCUS_MAX });
    expect(wheelZoom(maxed, "L10", 5)).toBe(maxed); // ceiling: same object back
    // Zoom out to ≤1 drops the key; at the floor it's a no-op.
    const floored = wheelZoom({ L10: 2 }, "L10", 0.4);
    expect(floored).toEqual({});
    expect(wheelZoom(floored, "L10", 0.5)).toBe(floored);
    // Junk inputs are inert.
    expect(wheelZoom(f1, "bogus", 2)).toBe(f1);
    expect(wheelZoom(f1, "L10", Number.NaN)).toBe(f1);
    expect(wheelZoom(f1, "L10", -2)).toBe(f1);
  });

  it("reset returns the uniform layout", () => {
    expect(reset()).toEqual({});
  });

  it("fitCircuit expands every node layer evenly past the LAYER threshold", () => {
    const circuit = run.interp!.readings!.find((m) => m.kind === "circuit")!;
    const f = fitCircuit({ L3: 99 }, circuit.nodes!, shape);
    expect(f.L3).toBeUndefined(); // fresh map
    const circuitLayers = [...new Set(circuit.nodes!.map((n) => n.layer))];
    expect(Object.keys(f).sort()).toEqual(circuitLayers.map((l) => `L${l}`).sort());
    const scale = buildScale(f, shape, W);
    const widths = circuitLayers.map((l) => scale.layerLod(l));
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(LOD_LAYER_PX);
    for (const l of circuitLayers) expect(lodForLayer(scale, l)).not.toBe("model");
    // "evenly": all expanded layers get the same width.
    for (const w of widths) expect(w).toBeCloseTo(widths[0], 3);
    // Degenerate inputs.
    expect(fitCircuit({}, [], shape)).toEqual({});
  });

  it("focus maps stay small and serializable (2dp weights, JSON round-trip)", () => {
    const f = blowUp({}, "L14/attn/h9", shape);
    expect(JSON.parse(JSON.stringify(f))).toEqual(f);
    for (const v of Object.values(f)) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(FOCUS_MAX);
      expect(Number(v.toFixed(2))).toBe(v); // rounded to 2 decimals
    }
  });
});

describe("unitChainAtX — the wheel target under a cursor", () => {
  it("resolves layers at layer LOD and the pinned ends", () => {
    const scale = buildScale({}, shape, W); // ~38.5px/layer → layer LOD
    const l16 = scale.xForPath("L16")!;
    expect(unitChainAtX(scale, mid(l16))).toEqual(["L16"]);
    expect(unitChainAtX(scale, mid(scale.xForPath("embed")!))).toEqual(["embed"]);
    expect(unitChainAtX(scale, mid(scale.xForPath("unembed")!))).toEqual(["unembed"]);
    // Pad gutters clamp to the nearest end; junk x is empty.
    expect(unitChainAtX(scale, 0)).toEqual(["embed"]);
    expect(unitChainAtX(scale, W + 50)).toEqual(["unembed"]);
    expect(unitChainAtX(scale, Number.NaN)).toEqual([]);
  });

  it("descends to component and head chains as the LOD deepens", () => {
    // 700px blow-up → component LOD: attn/mlp sides resolve their component.
    const comp = buildScale(blowUp({}, "L16", shape), shape, 700);
    expect(lodForLayer(comp, 16)).toBe("component");
    expect(unitChainAtX(comp, mid(comp.xForPath("L16/attn")!))).toEqual([
      "L16",
      "L16/attn",
    ]);
    expect(unitChainAtX(comp, mid(comp.xForPath("L16/mlp")!))).toEqual([
      "L16",
      "L16/mlp",
    ]);
    // 1280px blow-up → leaf LOD: the head slot under the cursor joins the chain.
    const leaf = buildScale(blowUp({}, "L16", shape), shape, W);
    expect(lodForLayer(leaf, 16)).toBe("leaf");
    expect(unitChainAtX(leaf, mid(leaf.xForPath("L16/attn/h9")!))).toEqual([
      "L16",
      "L16/attn",
      "L16/attn/h9",
    ]);
    expect(unitChainAtX(leaf, mid(leaf.xForPath("L16/mlp")!))).toEqual([
      "L16",
      "L16/mlp",
    ]);
    // Compressed neighbors still resolve as plain layers.
    expect(unitChainAtX(leaf, mid(leaf.xForPath("L3")!))).toEqual(["L3"]);
  });
});

describe("zoomChain — geometric factor split along the chain", () => {
  it("matches wheelZoom for a single path and splits factor^(1/n) for chains", () => {
    expect(zoomChain({}, ["L10"], 2)).toEqual(wheelZoom({}, "L10", 2));
    const f = zoomChain({}, ["L16", "L16/attn"], 4); // 4^(1/2) = 2 per level
    expect(f).toEqual({ L16: 2, "L16/attn": 2 });
    const f3 = zoomChain({}, ["L16", "L16/attn", "L16/attn/h9"], 8); // 8^(1/3) = 2
    expect(f3).toEqual({ L16: 2, "L16/attn": 2, "L16/attn/h9": 2 });
  });

  it("is idempotent at the clamps and inert on junk", () => {
    const maxed: Focus = { L10: FOCUS_MAX, "L10/attn": FOCUS_MAX };
    expect(zoomChain(maxed, ["L10", "L10/attn"], 5)).toBe(maxed);
    const empty: Focus = {};
    expect(zoomChain(empty, ["L10"], 0.5)).toBe(empty); // floor: nothing to shrink
    expect(zoomChain(empty, [], 2)).toBe(empty);
    expect(zoomChain(empty, ["bogus"], 2)).toBe(empty);
    expect(zoomChain(empty, ["L10"], Number.NaN)).toBe(empty);
    expect(zoomChain(empty, ["L10"], -1)).toBe(empty);
  });
});

describe("lerpFocus — the rAF tween's interpolator", () => {
  it("returns the endpoint OBJECTS at t≤0 / t≥1", () => {
    const from: Focus = { L3: 4 };
    const to: Focus = { L16: 25 };
    expect(lerpFocus(from, to, 0)).toBe(from);
    expect(lerpFocus(from, to, -1)).toBe(from);
    expect(lerpFocus(from, to, 1)).toBe(to);
    expect(lerpFocus(from, to, 2)).toBe(to);
  });

  it("interpolates in log space over the key union, dropping ≈1 entries", () => {
    // Geometric midpoint of 1 → 25 is 5.
    expect(lerpFocus({}, { L16: 25 }, 0.5)).toEqual({ L16: 5 });
    // Fading out: 25 → 1 at t=0.5 is 5 too; fully faded keys vanish.
    expect(lerpFocus({ L16: 25 }, {}, 0.5)).toEqual({ L16: 5 });
    expect(lerpFocus({ L16: 25 }, {}, 0.9999999)).toEqual({});
    // Union: both sides' keys move together.
    const mid = lerpFocus({ L3: 9 }, { L16: 9 }, 0.5);
    expect(mid.L3).toBeCloseTo(3, 10);
    expect(mid.L16).toBeCloseTo(3, 10);
    // Junk keys and junk weights are dropped/sanitized.
    const junk = lerpFocus({ bogus: 7, L2: Number.NaN } as Focus, { L2: 4 }, 0.5);
    expect(junk).toEqual({ L2: 2 });
    // Scales built from any intermediate frame still conserve width.
    const frame = lerpFocus({}, blowUp({}, "L16", shape), 0.37);
    const scale = buildScale(frame, shape, W);
    expect(Math.abs(totalSpanWidth(scale, 32) - (W - 2 * SCALE_EDGE_PAD))).toBeLessThan(0.5);
  });
});

describe("measurement id codec (sel round-trip)", () => {
  it("round-trips every fixture measurement through parse(measurementKey)", () => {
    for (const m of [...measurementsOf(run), ...measurementsOf(twin), ...measurementsOf(legacyRow)]) {
      const parsed = parseMeasurementKey(measurementKey(m));
      expect(parsed).toEqual({
        method: m.method || m.kind,
        metricName: m.metric_name ?? "",
        layer: typeof m.layer === "number" ? m.layer : null,
        locusComponent: m.locus_component ?? "",
        head: typeof m.head === "number" ? m.head : null,
      });
    }
  });

  it("rejects malformed keys (junk sel from URLs)", () => {
    expect(parseMeasurementKey("")).toBeNull();
    expect(parseMeasurementKey("a|b")).toBeNull();
    expect(parseMeasurementKey("a|b|c|d|e|f")).toBeNull();
    expect(parseMeasurementKey("a|b|notanumber|resid|")).toBeNull();
    expect(parseMeasurementKey("a|b|16|resid|x")).toBeNull();
    expect(parseMeasurementKey("a|b|16|resid|9")).toEqual({
      method: "a", metricName: "b", layer: 16, locusComponent: "resid", head: 9,
    });
    expect(parseMeasurementKey("eap|circuit_faithfulness|||")).toEqual({
      method: "eap", metricName: "circuit_faithfulness", layer: null, locusComponent: "", head: null,
    });
  });
});

describe("locusLabel", () => {
  it("labels every fixture locus type", () => {
    const ms = run.interp!.readings!;
    expect(locusLabel(ms.find((m) => m.kind === "linear_probe" && m.layer === 16)!)).toBe("L16");
    expect(locusLabel(ms.find((m) => m.locus_shape === "head")!)).toBe("L14/attn/h9");
    expect(locusLabel(ms.find((m) => m.kind === "sae_feature")!)).toBe("L16/mlp");
    expect(locusLabel(ms.find((m) => m.locus_shape === "global")!)).toBe("global");
    expect(locusLabel(ms.find((m) => m.kind === "circuit")!)).toBe("circuit (subgraph)");
    expect(locusLabel(measurementsOf(legacyRow)[0])).toBe("unlocated");
  });
});

describe("LOD ladder", () => {
  it("classifies by px-per-layer: model < 8 ≤ layer < 250 ≤ component/leaf", () => {
    // 1280px / 33 weight units ≈ 38.5px per layer → layer LOD everywhere.
    const uniform = buildScale({}, shape, W);
    expect(lodForLayer(uniform, 16)).toBe("layer");
    // 260px → ≈7.6px per layer → model LOD.
    const tiny = buildScale({}, shape, 260);
    expect(lodForLayer(tiny, 16)).toBe("model");
    // Blown-up L16 at 1280 → ~890px layer, head slots ~13.9px ≥ 10 → leaf.
    const blown = buildScale(blowUp({}, "L16", shape), shape, W);
    expect(lodForLayer(blown, 16)).toBe("leaf");
    expect(lodForLayer(blown, 0)).toBe("layer"); // compressed but ≥ 8px
    // Same blow-up at 700 → ~484px layer but slots ~7.6px < 10 → component.
    const mid700 = buildScale(blowUp({}, "L16", shape), shape, 700);
    expect(lodForLayer(mid700, 16)).toBe("component");
  });

  it("unknown head count can never reach leaf", () => {
    const headless: ModelShape = { nLayers: 32, nHeads: null, dMlp: null };
    const blown = buildScale(blowUp({}, "L16", headless), headless, W);
    expect(blown.layerLod(16)).toBeGreaterThan(250);
    expect(lodForLayer(blown, 16)).toBe("component");
  });
});

describe("xForMeasurement — every fixture locus type", () => {
  const scale = buildScale({}, shape, W);
  const ms = run.interp!.readings!;

  it("resid point loci center on the layer span", () => {
    const probe16 = ms.find((m) => m.kind === "linear_probe" && m.layer === 16)!;
    expect(scale.xForMeasurement(probe16)).toBeCloseTo(mid(scale.xForPath("L16")!), 6);
  });

  it("head loci center on the head slot", () => {
    const headM = ms.find((m) => m.locus_shape === "head")!;
    expect(headM.layer).toBe(14);
    expect(headM.head).toBe(9);
    expect(scale.xForMeasurement(headM)).toBeCloseTo(
      mid(scale.xForPath("L14/attn/h9")!),
      6,
    );
  });

  it("mlp loci center on the mlp component span (right of attn)", () => {
    const sae = ms.find((m) => m.kind === "sae_feature")!;
    const x = scale.xForMeasurement(sae)!;
    expect(x).toBeCloseTo(mid(scale.xForPath("L16/mlp")!), 6);
    expect(x).toBeGreaterThan(mid(scale.xForPath("L16/attn")!));
  });

  it("global loci anchor at the left global-lane gutter; circuits have no single locus", () => {
    const globalM = ms.find((m) => m.locus_shape === "global")!;
    // Fixed x by the "global" gutter caption — their honest no-locus home
    // (pane-centering collided with the mid-stack marker piles).
    expect(scale.xForMeasurement(globalM)).toBe(GLOBAL_LANE_X_PX);
    // The anchor never leaves a degenerate pane.
    const tiny = buildScale({}, shape, 60);
    expect(tiny.xForMeasurement(globalM)).toBe(30);
    const circuit = ms.find((m) => m.kind === "circuit")!;
    expect(scale.xForMeasurement(circuit)).toBeNull();
  });

  it("embed/unembed loci center on the pinned end spans", () => {
    const at = (locus: "embed" | "unembed"): InterpReading => ({
      kind: "x",
      value: 0.1,
      null_control: 0,
      locus_component: locus,
      locus_shape: "point",
    });
    expect(scale.xForMeasurement(at("embed"))).toBeCloseTo(mid(scale.xForPath("embed")!), 6);
    expect(scale.xForMeasurement(at("unembed"))).toBeCloseTo(
      mid(scale.xForPath("unembed")!),
      6,
    );
  });

  it("layer-less non-global loci are unplaceable (null, never fabricated)", () => {
    expect(
      scale.xForMeasurement({ kind: "x", value: 1, null_control: 0, locus_shape: "point" }),
    ).toBeNull();
    // Legacy record: no locus fields at all.
    expect(scale.xForMeasurement(measurementsOf(legacyRow)[0])).toBeNull();
    // Out-of-range layer.
    expect(
      scale.xForMeasurement({ kind: "x", value: 1, null_control: 0, layer: 99 }),
    ).toBeNull();
  });

  it("xForNode places circuit nodes (head slot > component > layer)", () => {
    const circuit = ms.find((m) => m.kind === "circuit")!;
    const [n0, n1] = circuit.nodes!; // L10/attn/h3, L12/mlp
    expect(scale.xForNode(n0)).toBeCloseTo(mid(scale.xForPath("L10/attn/h3")!), 6);
    expect(scale.xForNode(n1)).toBeCloseTo(mid(scale.xForPath("L12/mlp")!), 6);
    expect(scale.xForNode({ layer: 99, component: "resid" })).toBeNull();
  });
});

describe("measurementsOf + deltaOf (legacy normalization)", () => {
  it("prefers the measurements list, verbatim", () => {
    expect(measurementsOf(run)).toBe(run.interp!.readings);
    expect(measurementsOf(run)).toHaveLength(14);
  });

  it("normalizes the legacy single-record shape into a list", () => {
    const ms = measurementsOf(legacyRow);
    expect(ms).toEqual([
      {
        kind: legacyRow.interp!.reading_kind,
        value: legacyRow.interp!.value,
        null_control: legacyRow.interp!.null_control,
      },
    ]);
  });

  it("null interp (and empty lists) yield []", () => {
    expect(measurementsOf(noInterpRow)).toEqual([]);
    const emptied: RunRow = {
      ...legacyRow,
      interp: { ...legacyRow.interp!, reading_kind: null, readings: [] },
    };
    expect(measurementsOf(emptied)).toEqual([]);
  });

  it("deltaOf prefers the shipped delta, falls back to value − null_control", () => {
    const probe16 = run.interp!.readings!.find(
      (m) => m.kind === "linear_probe" && m.layer === 16,
    )!;
    expect(deltaOf(probe16)).toBe(0.42);
    expect(deltaOf(measurementsOf(legacyRow)[0])).toBeCloseTo(0.01, 10);
    expect(deltaOf({ kind: "x", value: null, null_control: null })).toBeNull();
  });
});

describe("matchMeasurements — the fixture's run/twin pairing", () => {
  const res = matchMeasurements(run, twin);

  it("pairs on (method||kind, metric_name, layer, locus_component, head)", () => {
    const both = res.pairs.filter((p) => p.run && p.twin);
    const runOnly = res.pairs.filter((p) => p.run && !p.twin);
    const twinOnly = res.pairs.filter((p) => !p.run && p.twin);
    // 5 probes + cde + head + circuit + 3 lens layers pair up.
    expect(both).toHaveLength(11);
    // caa moved layers (L16 → L11) so it un-pairs on BOTH sides; sae and the
    // global weight-norm NULL exist only on the run.
    expect(runOnly.map((p) => p.run!.kind).sort()).toEqual([
      "caa",
      "sae_feature",
      "weight_norm_diff",
    ]);
    expect(twinOnly).toHaveLength(1);
    expect(twinOnly[0].twin!.kind).toBe("caa");
    expect(twinOnly[0].twin!.layer).toBe(11);
    expect(res.pairs).toHaveLength(15);
  });

  it("pairs carry both sides' records (head ablation: −0.41 vs −0.12)", () => {
    const head = res.pairs.find((p) => p.run?.locus_shape === "head")!;
    expect(head.run!.delta).toBe(-0.41);
    expect(head.twin!.delta).toBe(-0.12);
    const circuit = res.pairs.find((p) => p.run?.kind === "circuit")!;
    expect(circuit.twin).not.toBeNull();
  });

  it("aggregates per-layer max |delta| each side (sweeps included)", () => {
    // Both sides ship full 32-layer probe sweeps → every layer is present.
    expect(res.layerDeltas).toHaveLength(32);
    const layers = res.layerDeltas.map((d) => d.layer);
    expect(layers).toEqual([...layers].sort((a, b) => a - b));
    const at = (l: number) => res.layerDeltas.find((d) => d.layer === l)!;
    expect(at(16).run).toBeCloseTo(0.78, 10); // cde beats probe/caa/sae/lens
    expect(at(16).twin).toBeCloseTo(0.27, 10); // twin's cde
    expect(at(11).twin).toBeCloseTo(0.22, 10); // twin peaks at L11 (sweep)
    expect(at(14).run).toBeCloseTo(0.41, 10); // |−0.41| head beats the sweep
    expect(res.deltaMax).toBeCloseTo(0.78, 10);
  });

  it("no twin → every pair is run-only and the twin side is silent", () => {
    const solo = matchMeasurements(run, null);
    expect(solo.pairs).toHaveLength(14);
    expect(solo.pairs.every((p) => p.run && !p.twin)).toBe(true);
    expect(solo.layerDeltas.every((d) => d.twin === 0)).toBe(true);
  });

  it("legacy rows match through the normalized single record", () => {
    const legacy = matchMeasurements(legacyRow, null);
    expect(legacy.pairs).toHaveLength(1);
    expect(legacy.pairs[0].key).toBe(measurementKey(measurementsOf(legacyRow)[0]));
  });

  it("measurementKey separates same-kind measurements at different loci", () => {
    const runCaa = run.interp!.readings!.find((m) => m.kind === "caa")!;
    const twinCaa = twin.interp!.readings!.find((m) => m.kind === "caa")!;
    expect(measurementKey(runCaa)).not.toBe(measurementKey(twinCaa));
    const p8 = (r: RunRow) =>
      r.interp!.readings!.find((m) => m.kind === "linear_probe" && m.layer === 8)!;
    expect(measurementKey(p8(run))).toBe(measurementKey(p8(twin)));
  });
});

describe("circuitDiff — the fixture's one-edge rewiring", () => {
  const runCircuit = run.interp!.readings!.find((m) => m.kind === "circuit")!;
  const twinCircuit = twin.interp!.readings!.find((m) => m.kind === "circuit")!;

  it("finds the edge each side owns, by node signature", () => {
    const diff = circuitDiff(runCircuit, twinCircuit);
    expect(diff.shared).toHaveLength(5);
    expect(diff.onlyRun).toHaveLength(1);
    expect(diff.onlyTwin).toHaveLength(1);
    // Run-only: L10/attn/h3 → L14/attn/h9. Twin-only: L12/mlp → L16/resid.
    expect(diff.onlyRun[0].from).toMatchObject({ layer: 10, component: "attn", head: 3 });
    expect(diff.onlyRun[0].to).toMatchObject({ layer: 14, component: "attn", head: 9 });
    expect(diff.onlyTwin[0].from).toMatchObject({ layer: 12, component: "mlp" });
    expect(diff.onlyTwin[0].to).toMatchObject({ layer: 16, component: "resid" });
  });

  it("tolerates absent sides and dangling edge indices", () => {
    expect(circuitDiff(null, null)).toEqual({ shared: [], onlyRun: [], onlyTwin: [] });
    const solo = circuitDiff(runCircuit, null);
    expect(solo.onlyRun).toHaveLength(6);
    expect(solo.shared).toHaveLength(0);
    const dangling: InterpReading = {
      ...runCircuit,
      edges: [...runCircuit.edges!, [0, 99]],
    };
    expect(circuitDiff(dangling, twinCircuit).onlyRun).toHaveLength(1); // [0,99] skipped
  });
});

describe("computeBands", () => {
  it("twin on: bar/zone/middle/zone/bar, 40/20/40 interior split", () => {
    const b = computeBands(600, true);
    expect(b.runBar).toEqual({ y0: BAND_PAD_PX, y1: BAND_PAD_PX + BAND_BAR_PX });
    expect(b.twinBar).toEqual({
      y0: 600 - BAND_PAD_PX - BAND_BAR_PX,
      y1: 600 - BAND_PAD_PX,
    });
    const interior = 600 - 2 * (BAND_PAD_PX + BAND_BAR_PX);
    expect(b.runZone.y1 - b.runZone.y0).toBeCloseTo(interior * 0.4, 6);
    expect(b.middle.y1 - b.middle.y0).toBeCloseTo(interior * 0.2, 6);
    expect(b.twinZone.y1 - b.twinZone.y0).toBeCloseTo(interior * 0.4, 6);
    // Contiguous, top to bottom.
    expect(b.runZone.y0).toBe(b.runBar.y1);
    expect(b.middle.y0).toBe(b.runZone.y1);
    expect(b.twinZone.y0).toBe(b.middle.y1);
    expect(b.twinBar.y0).toBeCloseTo(b.twinZone.y1, 6);
  });

  it("twin off: run gets everything below the bar; twin spans collapse", () => {
    const b = computeBands(600, false);
    expect(b.runZone).toEqual({ y0: BAND_PAD_PX + BAND_BAR_PX, y1: 600 - BAND_PAD_PX });
    for (const band of [b.middle, b.twinZone, b.twinBar]) {
      expect(band.y1 - band.y0).toBe(0);
      expect(band.y0).toBe(600 - BAND_PAD_PX);
    }
  });

  it("degenerate heights stay monotone and in-bounds", () => {
    for (const H of [0, 10, 20, 47]) {
      for (const twinOn of [true, false]) {
        const b = computeBands(H, twinOn);
        const ys = [
          b.runBar.y0, b.runBar.y1, b.runZone.y0, b.runZone.y1,
          b.middle.y0, b.middle.y1, b.twinZone.y0, b.twinZone.y1,
          b.twinBar.y0, b.twinBar.y1,
        ];
        for (let i = 0; i < ys.length; i++) {
          expect(Number.isFinite(ys[i])).toBe(true);
          expect(ys[i]).toBeGreaterThanOrEqual(0);
          expect(ys[i]).toBeLessThanOrEqual(H);
          if (i > 0) expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-6);
        }
      }
    }
  });

  it("adaptive: zones hug their content need; top slack is capped, rest falls below", () => {
    const b = computeBands(600, true, { runNeed: 100, twinNeed: 60 });
    expect(b.runZone.y1 - b.runZone.y0).toBeCloseTo(100, 6);
    expect(b.twinZone.y1 - b.twinZone.y0).toBeCloseTo(60, 6);
    // Middle is capped; of the leftover, at most TOP_SLACK_MAX_PX floats
    // above the figure (here slack*0.4 > the cap) and the rest sinks below.
    const topSlack = b.runBar.y0 - BAND_PAD_PX;
    const bottomSlack = 600 - BAND_PAD_PX - b.twinBar.y1;
    expect(topSlack).toBeCloseTo(TOP_SLACK_MAX_PX, 6);
    expect(bottomSlack).toBeGreaterThan(topSlack); // remainder accumulates below
    // Contiguous top to bottom.
    expect(b.runZone.y0).toBe(b.runBar.y1);
    expect(b.middle.y0).toBe(b.runZone.y1);
    expect(b.twinZone.y0).toBe(b.middle.y1);
    expect(b.twinBar.y0).toBe(b.twinZone.y1);
  });

  it("run bar y is anchored: identical across very different focus states", () => {
    // Two focus states produce very different content needs (leaf stacks vs
    // uniform badges) — the bar must not drift vertically between them.
    const uniform = computeBands(600, true, { runNeed: 40, twinNeed: 40 });
    const blown = computeBands(600, true, { runNeed: 150, twinNeed: 90 });
    expect(uniform.runBar.y0).toBeCloseTo(BAND_PAD_PX + TOP_SLACK_MAX_PX, 6);
    expect(blown.runBar.y0).toBeCloseTo(uniform.runBar.y0, 6);
    // Twin-off parity: the collapsed-band figure anchors at the same y, so
    // toggling the twin doesn't bounce the run bar either.
    const off = computeBands(600, false, { runNeed: 40, twinNeed: 0 });
    const offBlown = computeBands(600, false, { runNeed: 250, twinNeed: 0 });
    expect(off.runBar.y0).toBeCloseTo(uniform.runBar.y0, 6);
    expect(offBlown.runBar.y0).toBeCloseTo(uniform.runBar.y0, 6);
  });

  it("adaptive twin-off: the zone hugs content + a fixed gap, top slack capped", () => {
    const b = computeBands(800, false, { runNeed: 120, twinNeed: 0 });
    const zoneH = b.runZone.y1 - b.runZone.y0;
    expect(zoneH).toBeCloseTo(120 + 48, 6); // need + fixed lane/arc gap
    // Sparse content still gets the absolute floor, never a squashed sliver.
    const sparse = computeBands(800, false, { runNeed: 40, twinNeed: 0 });
    expect(sparse.runZone.y1 - sparse.runZone.y0).toBeCloseTo(120, 6);
    // The figure anchors near the top: at most TOP_SLACK_MAX_PX of slack
    // floats above (40% of it here is far larger), the rest falls below —
    // no more stranded mid-pane strip.
    const topSlack = b.runBar.y0 - BAND_PAD_PX;
    const bottomSlack = 800 - BAND_PAD_PX - b.runZone.y1;
    expect(topSlack).toBeCloseTo(TOP_SLACK_MAX_PX, 6);
    expect(bottomSlack).toBeCloseTo(800 - 2 * BAND_PAD_PX - BAND_BAR_PX - zoneH - TOP_SLACK_MAX_PX, 6);
    for (const band of [b.middle, b.twinZone, b.twinBar]) {
      expect(band.y1 - band.y0).toBe(0);
    }
    // Legacy (no content) still pins to the top and takes everything.
    const legacy = computeBands(800, false);
    expect(legacy.runBar.y0).toBe(BAND_PAD_PX);
    expect(legacy.runZone.y1).toBe(800 - BAND_PAD_PX);
  });

  it("adaptive: over-asking zones shrink proportionally, middle keeps a floor", () => {
    const b = computeBands(400, true, { runNeed: 500, twinNeed: 500 });
    const midH = b.middle.y1 - b.middle.y0;
    expect(midH).toBeGreaterThanOrEqual(32 - 1e-6); // MIDDLE_MIN_CLAMP floor
    // Everything still fits and stays monotone.
    const ys = [
      b.runBar.y0, b.runBar.y1, b.runZone.y0, b.runZone.y1,
      b.middle.y0, b.middle.y1, b.twinZone.y0, b.twinZone.y1,
      b.twinBar.y0, b.twinBar.y1,
    ];
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i]).toBeGreaterThanOrEqual(ys[i - 1] - 1e-6);
      expect(ys[i]).toBeLessThanOrEqual(400);
    }
  });

  it("adaptive: junk needs degrade to the zone minimum, never NaN", () => {
    const b = computeBands(600, true, { runNeed: Number.NaN, twinNeed: -50 });
    for (const v of [
      b.runBar.y0, b.runZone.y1, b.middle.y0, b.middle.y1, b.twinBar.y1,
    ]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(b.runZone.y1 - b.runZone.y0).toBeGreaterThanOrEqual(24 - 1e-6);
    expect(b.twinZone.y1 - b.twinZone.y0).toBeGreaterThanOrEqual(24 - 1e-6);
  });
});

describe("rulerLabelLayers", () => {
  it("uniform: every layer is wide enough — all labeled", () => {
    const scale = buildScale({}, shape, 1440);
    const labeled = rulerLabelLayers(scale);
    expect(labeled.size).toBe(32);
  });

  it("fit-circuit: every expanded layer labeled AND every gap gets an anchor", () => {
    const circuit = measurementsOf(run).find((m) => m.locus_shape === "subgraph")!;
    const focus = fitCircuit({}, circuit.nodes!, shape);
    const circuitLayers = [...new Set(circuit.nodes!.map((n) => n.layer))];
    // The regression width: compressed layers sat at ~15.8px (< the old 16px
    // cutoff) at 1440 and ~14.1px at 1280 — both must stay countable now.
    for (const width of [1440, 1280]) {
      const scale = buildScale(focus, shape, width);
      const labeled = rulerLabelLayers(scale);
      for (const l of circuitLayers) expect(labeled.has(l)).toBe(true);
      // No unlabeled gap between consecutive circuit layers: each compressed
      // run between them is 1–3 layers (≥14px total) → at least one anchor.
      const sorted = [...circuitLayers].sort((a, b) => a - b);
      for (let k = 0; k + 1 < sorted.length; k++) {
        if (sorted[k + 1] - sorted[k] < 2) continue; // adjacent, no gap
        const gap = [];
        for (let l = sorted[k] + 1; l < sorted[k + 1]; l++) gap.push(l);
        expect(gap.some((l) => labeled.has(l))).toBe(true);
      }
    }
  });

  it("blow-up: compressed flanks get evenly spaced anchors, not silence", () => {
    const scale = buildScale(blowUp({}, "L16", shape), shape, 1440);
    const labeled = rulerLabelLayers(scale);
    expect(labeled.has(16)).toBe(true);
    // Both flanks (L0–15, L17–31) are wide runs → several anchors each.
    const left = [...labeled].filter((l) => l < 16);
    const right = [...labeled].filter((l) => l > 16);
    expect(left.length).toBeGreaterThanOrEqual(2);
    expect(right.length).toBeGreaterThanOrEqual(2);
    // Anchors never crowd: label centers stay ≥ ~24px apart.
    const centers = [...labeled]
      .sort((a, b) => a - b)
      .map((l) => mid(scale.xForPath(`L${l}`)!));
    for (let k = 1; k < centers.length; k++) {
      expect(centers[k] - centers[k - 1]).toBeGreaterThanOrEqual(24);
    }
  });

  it("runs too thin for any number stay silent; wide hairline runs get one anchor", () => {
    // Extreme focus: L5 takes ~everything; flank layers are ~1.7px each.
    const scale = buildScale({ L5: 500 }, shape, 900);
    const labeled = rulerLabelLayers(scale);
    expect(labeled.has(5)).toBe(true);
    // Left run (L0–4, ~8px total) cannot hold a number → unlabeled.
    for (let l = 0; l < 5; l++) expect(labeled.has(l)).toBe(false);
    // Right run (L6–31, ~44px total) holds exactly one mid-run anchor.
    const right = [...labeled].filter((l) => l > 5);
    expect(right).toHaveLength(1);
  });
});

describe("profilePeak / rowHasAnatomy", () => {
  it("profilePeak: max |sweep value| across measurements; junk skipped", () => {
    const peak = profilePeak(measurementsOf(run));
    expect(peak).toBeCloseTo(0.42, 6); // the probe sweep's L16 apex
    expect(
      profilePeak([
        { kind: "x", value: null, null_control: null, layer_profile: [[0, Number.NaN], [1, -0.9]] },
        { kind: "y", value: null, null_control: null },
      ]),
    ).toBeCloseTo(0.9, 6);
    expect(profilePeak([])).toBe(0);
  });

  it("rowHasAnatomy: true for the planted run, false for legacy/no-interp rows", () => {
    expect(rowHasAnatomy(run)).toBe(true);
    expect(rowHasAnatomy(twin)).toBe(true);
    expect(rowHasAnatomy(legacyRow)).toBe(false);
    expect(rowHasAnatomy(noInterpRow)).toBe(false);
  });
});

describe("deltaRadius", () => {
  it("sqrt scale between the radius clamps", () => {
    expect(deltaRadius(0.78, 0.78)).toBe(MARKER_R_MAX);
    expect(deltaRadius(0.78 / 4, 0.78)).toBeCloseTo(
      MARKER_R_MIN + (MARKER_R_MAX - MARKER_R_MIN) * 0.5,
      10,
    );
    expect(deltaRadius(0, 0.78)).toBe(MARKER_R_MIN); // honest INTERP NULL: min, not hidden
    expect(deltaRadius(null, 0.78)).toBe(MARKER_R_MIN);
    expect(deltaRadius(5, 0.78)).toBe(MARKER_R_MAX); // over-max input caps
    expect(deltaRadius(0.5, 0)).toBe(MARKER_R_MIN); // degenerate normalizer
    const negative = deltaRadius(-0.41, 0.78); // magnitude drives size
    expect(negative).toBeGreaterThan(MARKER_R_MIN);
    expect(negative).toBeLessThan(MARKER_R_MAX);
    expect(GHOST_RADIUS).toBeLessThanOrEqual(MARKER_R_MIN);
  });
});

describe("display maps", () => {
  it("carrier palette: known carriers fixed and distinct; unknowns deterministic", () => {
    for (const c of ["direction", "subspace", "feature", "circuit", "lens", "other"]) {
      expect(carrierColor(c)).toBe(CARRIER_PALETTE[c]);
      expect(carrierColor(c)).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(Object.values(CARRIER_PALETTE)).size).toBe(6);
    expect(carrierColor("steering_vector")).toBe(carrierColor("steering_vector"));
    expect(carrierColor("steering_vector")).toMatch(/^#[0-9a-f]{6}$/);
    expect(Object.values(CARRIER_PALETTE)).not.toContain(carrierColor("steering_vector"));
    expect(carrierColor(undefined)).toBe(CARRIER_PALETTE.other);
    expect(carrierColor("")).toBe(CARRIER_PALETTE.other);
  });

  it("mode → glyph: circle reads, diamond writes, unknown never overclaims", () => {
    expect(MODE_GLYPH.observational).toBe("circle");
    expect(MODE_GLYPH.interventional).toBe("diamond");
    expect(modeGlyph("interventional")).toBe("diamond");
    expect(modeGlyph("observational")).toBe("circle");
    expect(modeGlyph(undefined)).toBe("circle");
    expect(modeGlyph("banana")).toBe("circle");
  });
});

describe("findTwinRow", () => {
  it("resolves the fixture pair in both directions via twin_hash", () => {
    expect(findTwinRow(run, rows)).toBe(twin);
    expect(findTwinRow(twin, rows)).toBe(run);
  });

  it("prefers the candidate sharing dataset/training hashes", () => {
    const decoy: RunRow = {
      ...twin,
      identity: { ...twin.identity, training_hash: "zz-other-seed", node_path: "decoy" },
    };
    expect(findTwinRow(run, [decoy, ...rows])).toBe(twin);
    // Only the off-facet candidate loaded → still resolves (best effort).
    expect(findTwinRow(run, [run, decoy])).toBe(decoy);
  });

  it("null on rows without twin_hash or without a loaded match", () => {
    expect(findTwinRow(legacyRow, rows)).toBeNull();
    expect(findTwinRow(noInterpRow, rows)).toBeNull();
    expect(findTwinRow(run, [run])).toBeNull();
  });
});

describe("residLayerHeat — the bar's model-LOD heat cells", () => {
  it("aggregates resid points + sweeps; component/global loci stay off the bar", () => {
    const heat = residLayerHeat(measurementsOf(run));
    expect(heat.size).toBe(32); // the sweep covers every layer
    expect(heat.get(16)).toBeCloseTo(0.78, 10); // cde beats probe/caa/lens
    expect(heat.get(24)).toBeCloseTo(0.61, 10); // lens beats the probe
    // L14 carries the −0.41 head ablation (attn locus) — EXCLUDED: the bar
    // shows only the sweep's resid value there.
    expect(heat.get(14)).toBeCloseTo(0.3877, 10);
  });

  it("legacy/degenerate inputs are safe", () => {
    // Legacy record: no layer → nothing to place on the bar.
    expect(residLayerHeat(measurementsOf(legacyRow)).size).toBe(0);
    expect(residLayerHeat([]).size).toBe(0);
    const junk: InterpReading[] = [
      { kind: "g", value: 1, null_control: 0, locus_shape: "global" }, // layer-less
      { kind: "m", value: 1, null_control: 0, layer: 5, locus_component: "mlp" },
      { kind: "r", value: null, null_control: null, layer: 5 }, // no delta
      { kind: "ok", value: 0.5, null_control: 0.1, layer: 5 },
      { kind: "neg", value: -0.6, null_control: 0, layer: 6 }, // |delta|
    ];
    const heat = residLayerHeat(junk);
    expect([...heat.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [5, 0.4],
      [6, 0.6],
    ]);
  });
});

describe("neuronBins — top-k components → strip bins", () => {
  const sae = run.interp!.readings!.find((m) => m.kind === "sae_feature")!;

  it("bins the fixture's 16 components by max |weight| with top indices", () => {
    const bins = neuronBins(sae.components, shape.dMlp, 64);
    expect(bins).toHaveLength(64);
    const lit = bins.filter((b) => b.value > 0);
    expect(lit.length).toBeGreaterThan(0);
    expect(lit.length).toBeLessThanOrEqual(sae.components!.length);
    // The strongest component (7141, 0.91) owns its bin and its top label.
    const strongest = bins[Math.floor((7141 / 11008) * 64)];
    expect(strongest.value).toBeCloseTo(0.91, 10);
    expect(strongest.top).toBe(7141);
    // Every lit bin's top is a real component index in range.
    for (const b of lit) {
      expect(sae.components!.some(([i]) => i === b.top)).toBe(true);
    }
  });

  it("collisions keep the max |weight|; junk and out-of-range are skipped", () => {
    const bins = neuronBins(
      [
        [1, 0.2],
        [2, -0.9], // same bin as index 1 at nBins=2 over dMlp=8 → |−0.9| wins
        [7, 0.3],
        [99, 5], // out of range
        [-1, 5], // out of range
        [3, Number.NaN], // junk weight
      ],
      8,
      2,
    );
    expect(bins).toEqual([
      { value: 0.9, top: 2 },
      { value: 0.3, top: 7 },
    ]);
  });

  it("degenerate inputs yield all-zero bins, never a crash", () => {
    expect(neuronBins(undefined, 11008, 4)).toEqual(
      Array.from({ length: 4 }, () => ({ value: 0, top: null })),
    );
    expect(neuronBins([[1, 1]], null, 3).every((b) => b.value === 0)).toBe(true);
    expect(neuronBins([[1, 1]], 0, 3).every((b) => b.value === 0)).toBe(true);
    expect(neuronBins([[1, 1]], 8, 0)).toEqual([]);
    expect(neuronBins([[1, 1]], 8, -3)).toEqual([]);
  });
});

describe("rowShape", () => {
  it("reads the builder-shipped shape directly", () => {
    expect(rowShape(run)).toEqual({ nLayers: 32, nHeads: 32, dMlp: 11008 });
  });

  it("infers layers and heads from measurements when the row lacks them", () => {
    const stripped: RunRow = { ...run, n_layers: null, n_heads: null, d_mlp: null };
    // Sweep reaches L31 → 32 layers; circuit node h21 → 22 heads; dMlp unknowable.
    expect(rowShape(stripped)).toEqual({ nLayers: 32, nHeads: 22, dMlp: null });
  });

  it("returns null when even the layer count is unknowable", () => {
    const bare: RunRow = { ...noInterpRow, n_layers: null, n_heads: null, d_mlp: null };
    expect(rowShape(bare)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Hostile blob data — the engine header's "never a crash" promise, proven.
// JSON.parse turns 1e999 into Infinity, so every count/value read from a
// snapshot must clamp/degrade instead of hanging a loop, throwing a
// RangeError allocation, or poisoning a normalizer.
// ---------------------------------------------------------------------------

/** Minimal RunRow for junk-data cases the fixture can't (shouldn't) carry. */
const mkRow = (over: Partial<RunRow>): RunRow =>
  ({
    identity: {
      node_path: "junk", run_id: "junk", function_hash: "f",
      dataset_hash: "d", training_hash: "t", chain_dirs: [],
    },
    function: { arity: 2, truth_table: "0110" },
    training: { base_model: "m" },
    ...over,
  }) as unknown as RunRow;

describe("hostile shape counts (n_layers / n_heads)", () => {
  it("buildScale clamps/degrades junk layer counts instead of allocating or throwing", () => {
    // Non-finite = junk = ABSENT (degenerate 1-layer spine, like a missing
    // count); huge-but-finite clamps to the sanity ceiling. Neither ever
    // reaches `new Array(nL + 2)` unclamped (Infinity threw RangeError,
    // 1e9 was a multi-GB allocation).
    for (const nLayers of [Infinity, 1e999, NaN, -5]) {
      let s: Scale | undefined;
      expect(() => {
        s = buildScale({}, { nLayers, nHeads: null, dMlp: null }, 800);
      }).not.toThrow();
      expect(s!.shape.nLayers).toBe(1);
    }
    expect(buildScale({}, { nLayers: 1e9, nHeads: null, dMlp: null }, 800).shape.nLayers).toBe(MAX_MODEL_LAYERS);
  });

  it("headSpan terminates on junk head counts (Infinity / huge / fractional)", () => {
    // Non-finite head count = junk = UNKNOWN (no head subdivision — the
    // shape's existing "refuses to subdivide" degrade); huge finite clamps.
    const inf = buildScale({}, { nLayers: 8, nHeads: Infinity, dMlp: null }, 800);
    expect(inf.shape.nHeads).toBeNull();
    const headM: InterpReading = {
      kind: "x", value: 1, null_control: 0,
      layer: 3, head: 5, locus_component: "attn", locus_shape: "head",
    };
    // Places at a finite x (attn center degrade) — the unclamped loop never
    // returned at all.
    expect(Number.isFinite(inf.xForMeasurement(headM)!)).toBe(true);
    const huge = buildScale({}, { nLayers: 8, nHeads: 1e8, dMlp: null }, 800);
    expect(huge.shape.nHeads).toBe(MAX_MODEL_HEADS);
    expect(Number.isFinite(huge.xForMeasurement(headM)!)).toBe(true);
    const frac = buildScale({}, { nLayers: 8, nHeads: 4.7, dMlp: null }, 800);
    expect(frac.shape.nHeads).toBe(4);
  });

  it("rowShape/rowLayerCount: non-finite shipped counts fall to inference; big finite ones clamp", () => {
    // n_layers Infinity is ignored → the run's own measurements infer 32.
    expect(rowShape({ ...run, n_layers: 1e999 } as RunRow)!.nLayers).toBe(32);
    expect(rowLayerCount({ ...run, n_layers: 1e9 } as RunRow)).toBe(MAX_MODEL_LAYERS);
    // Head inference from a junk measurement head clamps too.
    const junkHeads = mkRow({
      n_layers: 8,
      interp: { readings: [
        { kind: "x", value: 1, null_control: 0, layer: 3, head: 1e999, locus_shape: "head" },
        { kind: "y", value: 1, null_control: 0, layer: 4 },
      ] },
    } as Partial<RunRow>);
    expect(rowShape(junkHeads)!.nHeads).toBeNull(); // non-finite head ignored
    // A row whose ONLY layer evidence is junk degrades to null (no spine),
    // never an Infinity-sized scale.
    const junkOnly = mkRow({
      interp: { readings: [{ kind: "x", value: 1, null_control: 0, layer: 1e999 }] },
    } as Partial<RunRow>);
    expect(rowLayerCount(junkOnly)).toBeNull();
  });
});

describe("hostile measurement values", () => {
  it("fractional layers are unplaceable — null, never NaN", () => {
    const scale = buildScale({}, shape, W);
    expect(
      scale.xForMeasurement({ kind: "x", value: 1, null_control: 0, layer: 2.5 }),
    ).toBeNull();
    expect(scale.xForNode({ layer: 2.5, component: "mlp" })).toBeNull();
    // Fractional heads degrade to the attn center instead of a NaN slot.
    const fracHead: InterpReading = {
      kind: "x", value: 1, null_control: 0,
      layer: 14, head: 9.5, locus_component: "attn", locus_shape: "head",
    };
    expect(scale.xForMeasurement(fracHead)).toBeCloseTo(
      mid(scale.xForPath("L14/attn")!), 6,
    );
  });

  it("deltaOf never returns a non-finite delta", () => {
    expect(deltaOf({ kind: "x", value: 1e999, null_control: 0 })).toBeNull();
    expect(deltaOf({ kind: "x", value: 1, null_control: NaN })).toBeNull();
    expect(deltaOf({ kind: "x", value: 1, null_control: 0.25 })).toBe(0.75);
  });

  it("one Infinity value cannot flatten the |Δ| normalizer pane-wide", () => {
    const junkRun = mkRow({
      n_layers: 8,
      interp: { readings: [
        { kind: "x", metric_name: "m", value: 1e999, null_control: 0, layer: 3 },
        { kind: "y", metric_name: "m", delta: 0.5, value: 0.5, null_control: 0, layer: 4 },
      ] },
    } as Partial<RunRow>);
    const res = matchMeasurements(junkRun, null);
    expect(res.deltaMax).toBe(0.5); // finite marker keeps its full radius
    expect(res.layerDeltas.find((d) => d.layer === 3)).toBeUndefined();
  });
});

describe("out-of-range layer clamping (nLayers param)", () => {
  // Run on an 8-layer scale; the twin carries junk at layer 20 with |Δ| 5.0
  // while every in-range layer sits ≤ 0.5 — the exact mismatched-twin shape
  // that used to shrink all visible diff cells to ≤10% and caption a phantom
  // "twin ↓ +5" peak no cell on screen could show.
  const runRow = mkRow({
    n_layers: 8,
    interp: { readings: [
      { kind: "probe", method: "lp", metric_name: "auroc", layer: 3, delta: 0.5, locus_shape: "point" },
    ] },
  } as Partial<RunRow>);
  const twinRow = mkRow({
    n_layers: 8,
    interp: { readings: [
      { kind: "probe", method: "lp", metric_name: "auroc", layer: 20, delta: 5.0, locus_shape: "point" },
      { kind: "sweep", method: "lens", metric_name: "kl", value: null, null_control: null,
        layer_profile: [[2, 0.3], [20, 5.0]] },
    ] },
  } as Partial<RunRow>);

  it("matchMeasurements drops layers the renderer can never draw", () => {
    const m = matchMeasurements(runRow, twinRow, 8);
    expect(m.layerDeltas.some((d) => d.layer === 20)).toBe(false);
    expect(m.layerDeltas.find((d) => d.layer === 3)!.run).toBe(0.5);
    expect(m.layerDeltas.find((d) => d.layer === 2)!.twin).toBe(0.3);
    // The pairs themselves still exist (matching is locus-keyed, not clamped).
    expect(m.pairs).toHaveLength(3);
    // Without the range hint the legacy aggregate keeps everything.
    expect(matchMeasurements(runRow, twinRow).layerDeltas.some((d) => d.layer === 20)).toBe(true);
  });

  it("residLayerHeat drops out-of-range and non-integer layers", () => {
    const heat = residLayerHeat(measurementsOf(twinRow), 8);
    expect(heat.has(20)).toBe(false);
    expect(heat.get(2)).toBe(0.3);
    const junk = residLayerHeat([
      { kind: "x", value: 1, null_control: 0, layer: 2.5 },
      { kind: "y", value: 1, null_control: 0, layer: -1 },
      { kind: "z", value: null, null_control: null, layer_profile: [[3, 1e999]] },
    ], 8);
    expect(junk.size).toBe(0); // fractional / negative / non-finite all dropped
  });
});

describe("sanitizeAnatomyConfig — untrusted ?v= / persisted payloads", () => {
  it("junk roots and wrong-typed fields degrade to the defaults", () => {
    expect(sanitizeAnatomyConfig(undefined)).toEqual(DEFAULT_ANATOMY);
    expect(sanitizeAnatomyConfig(null)).toEqual(DEFAULT_ANATOMY);
    expect(sanitizeAnatomyConfig("junk")).toEqual(DEFAULT_ANATOMY);
    expect(sanitizeAnatomyConfig([1, 2])).toEqual(DEFAULT_ANATOMY);
    // The crash class: focus null / primitive overriding the default map.
    expect(sanitizeAnatomyConfig({ focus: null })).toEqual(DEFAULT_ANATOMY);
    expect(sanitizeAnatomyConfig({ focus: "junk", twin: "yes", sel: 42 })).toEqual(DEFAULT_ANATOMY);
  });

  it("keeps valid fields; drops junk focus entries; clamps weights", () => {
    const cfg = sanitizeAnatomyConfig({
      focus: { L3: 8, L9: 1e999, bogus: 9, L4: "x", L5: 0.2, "L2/attn/h1": 3 },
      twin: false,
      sel: "a|b|3||",
    });
    expect(cfg.twin).toBe(false);
    expect(cfg.sel).toBe("a|b|3||");
    // Infinity, junk paths, non-numbers and ≤1 weights all dropped.
    expect(cfg.focus).toEqual({ L3: 8, "L2/attn/h1": 3 });
  });

  it("the sanitized config renders and zooms without throwing", () => {
    const cfg = sanitizeAnatomyConfig({ focus: null });
    expect(() => buildScale(cfg.focus, shape, W)).not.toThrow();
    expect(() => wheelZoom(cfg.focus, "L3", 2)).not.toThrow();
    expect(() => Object.entries(cfg.focus)).not.toThrow(); // defaultKbLayer's read
  });
});

describe("findTwinRow — same-base-model constraint", () => {
  it("never falls back to a hash match on a different base model", () => {
    const crossModel: RunRow = {
      ...twin,
      identity: { ...twin.identity, node_path: "xmodel", training_hash: "zz" },
      training: { ...twin.training, base_model: "other-base-7b" },
      n_layers: 64,
    };
    // Only the cross-model candidate loaded → no twin at all: both bands
    // render on ONE scale, so a different model can't align layer-for-layer.
    expect(findTwinRow(run, [run, crossModel])).toBeNull();
    // It never shadows the true same-model twin either.
    expect(findTwinRow(run, [crossModel, ...rows])).toBe(twin);
  });
});
