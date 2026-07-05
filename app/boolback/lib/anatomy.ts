// app/boolback/lib/anatomy.ts — the Anatomy view's pure math engine
// (ANATOMY-SPEC.md). Zero React/DOM; correctness lives in anatomy.test.ts.
//
// Owns:
//  * the accordion depth scale — unit paths ("embed" | "L<i>" | "L<i>/attn" |
//    "L<i>/attn/h<j>" | "L<i>/mlp" | "unembed") on ONE weighted 1-D axis with
//    PINNED ends: embed starts at the left pad, unembed ends at the right
//    pad, and segment widths always sum to the pane width. Zooming reweights
//    toward the focus; everything else compresses but never leaves the
//    screen. Children subdivide their parent's span icicle-style; depth
//    order is strictly left→right (attn before mlp, heads by index).
//  * focus ops (wheelZoom / blowUp / reset / fitCircuit) — pure functions
//    over the serializable AnatomyConfig.focus map. Share-link friendly:
//    weights are clamped to [1, FOCUS_MAX], rounded to 2 decimals, and
//    entries at ≈1 are dropped so the map stays small. blowUp/fitCircuit
//    return a FRESH map (prior focus discarded) so their geometry is
//    deterministic and links stay minimal.
//  * interaction plumbing (2026-07, live pass): unitChainAtX resolves the
//    unit under a cursor x at the CURRENT LOD (layer, layer+component, or
//    layer+component+head — the wheel target); zoomChain splits a wheel
//    factor geometrically across that chain so nested zoom keeps moving;
//    lerpFocus interpolates two focus maps in LOG space (multiplicative
//    weights animate at a constant visual rate) for the ~180ms rAF tween;
//    measurementKey/parseMeasurementKey are the selection id codec
//    (AnatomyConfig.sel and share links carry the encoded string).
//  * the LOD ladder (model | layer | component | leaf) classified by
//    px-per-unit thresholds.
//  * measurement plumbing: measurementsOf normalizes the LEGACY single-record
//    interp shape into a list; xForMeasurement/xForNode place every locus
//    type on the scale (degrading — unknown heads center on attn, layer-less
//    global/parameter loci center on the pane, circuits return null and
//    render via their nodes); matchMeasurements pairs run/twin measurements
//    and aggregates per-layer max |delta| for the diff strip; circuitDiff
//    compares circuit edges by node SIGNATURE (layer:component:head), not
//    node index, so reordered node lists still diff correctly; findTwinRow
//    resolves the function-false twin via measurement twin_hash;
//    residLayerHeat aggregates the bar's per-layer heat (resid loci +
//    sweeps); neuronBins folds top-k components into px bins for the strip.
//  * display constants: the carrier palette (hard-coded hex — data-series
//    colors never come from CSS vars, per the chart PALETTE precedent, so
//    they stay distinct on light AND dark and survive export), the
//    mode→glyph map, marker radii (sqrt-scaled from delta), and the
//    run-bar/zones/twin-bar vertical band geometry.
//
// Every snapshot field this module reads is optional (old blobs, the
// browser-cached last-good blob): absence degrades to structural rendering,
// never a crash.

import type {
  AnatomyConfig,
  CircuitNode,
  InterpMeasurement,
  InterpMode,
  RunRow,
} from "./types";
import { rowLayerCount } from "./method-metrics";

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** Serializable accordion focus: unit path → weight multiplier (≥1). */
export type Focus = AnatomyConfig["focus"];

/** Model geometry the scale is built over. nHeads/dMlp may be unknown
 * (pre-anatomy blobs) — the scale then simply refuses to subdivide that far. */
export interface ModelShape {
  nLayers: number;
  nHeads: number | null;
  dMlp: number | null;
}

export interface Span {
  x0: number;
  x1: number;
}

export interface Scale {
  width: number;
  shape: ModelShape;
  /** Span of a unit path; null for unparseable/out-of-range paths. */
  xForPath(path: string): Span | null;
  /** Center x for a measurement's locus; null when it has no single locus
   * (circuits render per-node via xForNode; layer-less points are unplaceable). */
  xForMeasurement(m: InterpMeasurement): number | null;
  /** Center x for one circuit node; null when its layer is out of range. */
  xForNode(node: CircuitNode): number | null;
  /** Current px width of layer i's span (0 when out of range). */
  layerLod(i: number): number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Inner pad so end-cap strokes/markers don't clip; ends pin to it. */
export const SCALE_EDGE_PAD = 4;
/** embed/unembed base weight relative to a layer's 1 — legible at rest
 * (~half a layer), compresses under focus pressure like everything else. */
export const EDGE_UNIT_WEIGHT = 0.5;
/** Weight clamp ceiling — keeps focus maps small/serializable while allowing
 * a ~70% blow-up on models beyond 200 layers. */
export const FOCUS_MAX = 500;
/** blowUp: the focused path's chain ends up at ~this fraction of the pane. */
export const BLOWUP_SHARE = 0.7;
/** fitCircuit: distinct node layers together get ~this fraction of the pane. */
export const FIT_SHARE = 0.7;

// LOD ladder thresholds (px-per-unit; ANATOMY-SPEC.md table).
export const LOD_LAYER_PX = 8; // layer span below this → whole-model heat cells
export const LOD_COMPONENT_PX = 250; // layer span at/above → attn/mlp split
export const LOD_LEAF_SLOT_PX = 10; // avg head slot at/above → leaf detail
export type Lod = "model" | "layer" | "component" | "leaf";

// Marker geometry.
export const MARKER_R_MIN = 2.5;
export const MARKER_R_MAX = 14;
/** Fixed radius of the always-visible faint null-control ghost. */
export const GHOST_RADIUS = 2;

// Vertical band geometry.
export const BAND_PAD_PX = 8; // top/bottom inset
export const BAND_BAR_PX = 16; // residual bar height (run + twin)
const RUN_ZONE_FRAC = 0.4; // interior split: run structure / middle / twin
const MIDDLE_FRAC = 0.2;

// ---------------------------------------------------------------------------
// Unit-path grammar
// ---------------------------------------------------------------------------

interface ParsedPath {
  kind: "embed" | "unembed" | "layer";
  layer?: number;
  component?: "attn" | "mlp";
  head?: number;
}

const LAYER_PATH_RE = /^L(\d+)(?:\/(attn|mlp)(?:\/h(\d+))?)?$/;

/** Parse a unit path; null on anything outside the grammar (heads only
 * nest under attn — "L3/mlp/h2" is invalid by the regex). */
export function parseUnitPath(path: string): ParsedPath | null {
  if (path === "embed" || path === "unembed") return { kind: path };
  const m = LAYER_PATH_RE.exec(path);
  if (!m) return null;
  const head = m[3] === undefined ? undefined : Number(m[3]);
  if (head !== undefined && m[2] !== "attn") return null; // heads only under attn
  return {
    kind: "layer",
    layer: Number(m[1]),
    component: m[2] as "attn" | "mlp" | undefined,
    head,
  };
}

// ---------------------------------------------------------------------------
// Focus sanitation — share links arrive from URLs, so every weight read
// tolerates junk (NaN, negatives, strings already excluded by type).
// ---------------------------------------------------------------------------

function sanitizeWeight(v: number | undefined): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 1) return 1;
  return Math.min(v, FOCUS_MAX);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// buildScale — cumulative-weight piecewise mapping with pinned ends
// ---------------------------------------------------------------------------

export function buildScale(focus: Focus, shape: ModelShape, widthPx: number): Scale {
  const nL = Math.max(1, Math.floor(shape.nLayers || 1));
  const width = Math.max(0, widthPx);
  const inner = Math.max(0, width - 2 * SCALE_EDGE_PAD);
  const mult = (path: string) => sanitizeWeight(focus[path]);

  // Top level: embed | L0..L(nL-1) | unembed. One boundary array; spans are
  // adjacent slices of it, so contiguity/monotonicity hold exactly.
  const weights: number[] = new Array(nL + 2);
  weights[0] = EDGE_UNIT_WEIGHT * mult("embed");
  for (let i = 0; i < nL; i++) weights[i + 1] = mult(`L${i}`);
  weights[nL + 1] = EDGE_UNIT_WEIGHT * mult("unembed");
  let total = 0;
  for (const w of weights) total += w;

  const bounds: number[] = new Array(nL + 3);
  bounds[0] = SCALE_EDGE_PAD;
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    bounds[i + 1] = SCALE_EDGE_PAD + (cum / total) * inner;
  }
  bounds[nL + 2] = SCALE_EDGE_PAD + inner; // force the pinned right end exactly

  const embedSpan: Span = { x0: bounds[0], x1: bounds[1] };
  const unembedSpan: Span = { x0: bounds[nL + 1], x1: bounds[nL + 2] };
  const layerSpan = (i: number): Span | null =>
    i >= 0 && i < nL ? { x0: bounds[i + 1], x1: bounds[i + 2] } : null;

  // Within a layer: attn | mlp split the span (equal base weights — position
  // legibility over parameter-count fidelity), each scaled by its focus.
  const componentSpan = (i: number, comp: "attn" | "mlp"): Span | null => {
    const ls = layerSpan(i);
    if (!ls) return null;
    const wAttn = mult(`L${i}/attn`);
    const wMlp = mult(`L${i}/mlp`);
    const split = ls.x0 + ((ls.x1 - ls.x0) * wAttn) / (wAttn + wMlp);
    return comp === "attn" ? { x0: ls.x0, x1: split } : { x0: split, x1: ls.x1 };
  };

  // Within attn: nHeads slots by index, each scaled by its focus. Unknown
  // head count → no head-level subdivision exists.
  const headSpan = (i: number, h: number): Span | null => {
    const nHeads = shape.nHeads;
    if (typeof nHeads !== "number" || nHeads <= 0 || h < 0 || h >= nHeads) return null;
    const as = componentSpan(i, "attn");
    if (!as) return null;
    let totalH = 0;
    for (let j = 0; j < nHeads; j++) totalH += mult(`L${i}/attn/h${j}`);
    let cumH = 0;
    for (let j = 0; j < h; j++) cumH += mult(`L${i}/attn/h${j}`);
    const w = as.x1 - as.x0;
    return {
      x0: as.x0 + (cumH / totalH) * w,
      x1: as.x0 + ((cumH + mult(`L${i}/attn/h${h}`)) / totalH) * w,
    };
  };

  const xForPath = (path: string): Span | null => {
    const p = parseUnitPath(path);
    if (!p) return null;
    if (p.kind === "embed") return { ...embedSpan };
    if (p.kind === "unembed") return { ...unembedSpan };
    const i = p.layer as number;
    if (p.head !== undefined) return headSpan(i, p.head);
    if (p.component !== undefined) return componentSpan(i, p.component);
    return layerSpan(i);
  };

  const mid = (s: Span) => (s.x0 + s.x1) / 2;

  const xForNode = (node: CircuitNode): number | null => {
    if (typeof node?.layer !== "number") return null;
    if (node.component === "embed") return mid(embedSpan);
    if (node.component === "unembed") return mid(unembedSpan);
    const ls = layerSpan(node.layer);
    if (!ls) return null;
    if (node.component === "attn" || node.component === "mlp") {
      if (node.component === "attn" && typeof node.head === "number") {
        const hs = headSpan(node.layer, node.head);
        if (hs) return mid(hs);
      }
      const cs = componentSpan(node.layer, node.component);
      return cs ? mid(cs) : mid(ls);
    }
    return mid(ls); // resid (or anything unrecognized) centers on the layer
  };

  const xForMeasurement = (m: InterpMeasurement): number | null => {
    const shapeKind = m.locus_shape;
    // Circuits have no single locus — nodes carry their own x via xForNode.
    if (shapeKind === "subgraph" || shapeKind === "path") return null;
    if (m.locus_component === "embed") return mid(embedSpan);
    if (m.locus_component === "unembed") return mid(unembedSpan);
    const layer =
      typeof m.layer === "number" && Number.isFinite(m.layer) ? m.layer : null;
    if (layer === null || layer < 0 || layer >= nL) {
      // Layer-less: whole-model loci center on the pane; anything else is
      // unplaceable (never fabricate a position).
      return shapeKind === "global" || shapeKind === "parameter" ? width / 2 : null;
    }
    const ls = layerSpan(layer) as Span;
    const comp = m.locus_component ?? (shapeKind === "head" ? "attn" : "resid");
    if (comp === "attn" && shapeKind === "head" && typeof m.head === "number") {
      const hs = headSpan(layer, m.head);
      if (hs) return mid(hs); // unknown nHeads/out-of-range → attn center below
    }
    if (comp === "attn" || comp === "mlp") {
      const cs = componentSpan(layer, comp);
      return cs ? mid(cs) : mid(ls);
    }
    return mid(ls); // resid loci center on the layer span
  };

  return {
    width,
    shape: { nLayers: nL, nHeads: shape.nHeads ?? null, dMlp: shape.dMlp ?? null },
    xForPath,
    xForMeasurement,
    xForNode,
    layerLod: (i: number) => {
      const ls = layerSpan(i);
      return ls ? ls.x1 - ls.x0 : 0;
    },
  };
}

/** LOD classification of layer i under the current scale. Leaf uses the
 * AVERAGE head slot (the classifier is per-layer; per-slot detail is the
 * renderer's business). Unknown head count can never reach leaf. */
export function lodForLayer(scale: Scale, i: number): Lod {
  const w = scale.layerLod(i);
  if (w < LOD_LAYER_PX) return "model";
  if (w < LOD_COMPONENT_PX) return "layer";
  const nHeads = scale.shape.nHeads;
  if (typeof nHeads === "number" && nHeads > 0) {
    const attn = scale.xForPath(`L${i}/attn`);
    if (attn && (attn.x1 - attn.x0) / nHeads >= LOD_LEAF_SLOT_PX) return "leaf";
  }
  return "component";
}

// ---------------------------------------------------------------------------
// Focus ops — pure, serializable, small
// ---------------------------------------------------------------------------

/** Multiplicative wheel zoom on one unit, clamped to [1, FOCUS_MAX];
 * weights that land at 1 are dropped from the map. Idempotent at the clamps
 * (returns the SAME object when nothing changes). */
export function wheelZoom(focus: Focus, path: string, factor: number): Focus {
  if (!Number.isFinite(factor) || factor <= 0 || !parseUnitPath(path)) return focus;
  const prev = sanitizeWeight(focus[path]);
  const next = round2(Math.min(Math.max(prev * factor, 1), FOCUS_MAX));
  const hadKey = path in focus;
  if (next === prev && hadKey === (next > 1)) return focus;
  const out: Focus = { ...focus };
  if (next > 1) out[path] = next;
  else delete out[path];
  return out;
}

/** Uniform layout. */
export function reset(): Focus {
  return {};
}

/**
 * The unit chain under cursor x at the scale's CURRENT LOD — the wheel-zoom
 * target. Deepest first ordering is outermost→innermost: ["L16"] at
 * model/layer LOD, ["L16","L16/attn"] at component LOD, plus the head slot
 * at leaf LOD. x is clamped into the pinned span, so pad-gutter wheels zoom
 * the nearest end cap. Empty only for non-finite x.
 */
export function unitChainAtX(scale: Scale, x: number): string[] {
  if (!Number.isFinite(x)) return [];
  const embed = scale.xForPath("embed")!;
  const unembed = scale.xForPath("unembed")!;
  const cx = Math.min(Math.max(x, embed.x0), unembed.x1);
  if (cx <= embed.x1) return ["embed"];
  if (cx >= unembed.x0) return ["unembed"];
  for (let i = 0; i < scale.shape.nLayers; i++) {
    const s = scale.xForPath(`L${i}`)!;
    if (cx > s.x1) continue;
    const lod = lodForLayer(scale, i);
    if (lod === "model" || lod === "layer") return [`L${i}`];
    const attn = scale.xForPath(`L${i}/attn`)!;
    if (cx > attn.x1) return [`L${i}`, `L${i}/mlp`];
    const chain = [`L${i}`, `L${i}/attn`];
    const nHeads = scale.shape.nHeads;
    if (lod === "leaf" && typeof nHeads === "number" && nHeads > 0) {
      for (let h = 0; h < nHeads; h++) {
        const hs = scale.xForPath(`L${i}/attn/h${h}`);
        if (hs && cx <= hs.x1) {
          chain.push(`L${i}/attn/h${h}`);
          break;
        }
      }
    }
    return chain;
  }
  return ["unembed"]; // numeric edge of the last boundary
}

/**
 * Wheel zoom along a unit chain: the factor is split geometrically
 * (factor^(1/n) per level) so zooming "into a head" grows the head, its attn
 * component AND its layer together — the leaf keeps approaching pane scale
 * instead of saturating inside a fixed-width parent. Inherits wheelZoom's
 * clamp idempotence: when nothing changes, the SAME focus object returns.
 */
export function zoomChain(focus: Focus, paths: string[], factor: number): Focus {
  if (!Number.isFinite(factor) || factor <= 0) return focus;
  const valid = paths.filter((p) => parseUnitPath(p) !== null);
  if (valid.length === 0) return focus;
  const per = Math.pow(factor, 1 / valid.length);
  let out = focus;
  for (const p of valid) out = wheelZoom(out, p, per);
  return out;
}

/**
 * Interpolate two focus maps for the ~180ms accordion tween. LOG-space
 * (geometric) interpolation: weights are multiplicative, so exp-lerp moves
 * at a constant visual rate from 1 to 500 instead of leaping early. Junk
 * keys are dropped; weights that land at ≈1 are omitted. t≤0 / t≥1 return
 * the endpoint OBJECTS so animation completion restores reference equality.
 */
export function lerpFocus(from: Focus, to: Focus, t: number): Focus {
  if (!(t > 0)) return from;
  if (t >= 1) return to;
  const out: Focus = {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const k of keys) {
    if (!parseUnitPath(k)) continue;
    const a = sanitizeWeight(from[k]);
    const b = sanitizeWeight(to[k]);
    const v = a === b ? a : Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
    if (v > 1 + 1e-4) out[k] = v; // sub-0.01% weights are visually 1 — drop
  }
  return out;
}

const shareK = (s: number) => s / (1 - s);
const clampW = (w: number) => round2(Math.min(Math.max(w, 1), FOCUS_MAX));

/**
 * Blow up one path: the path's chain ends at ~BLOWUP_SHARE of the pane, the
 * per-level share split as BLOWUP_SHARE^(1/depth) so nesting doesn't shrink
 * the target. Returns a FRESH focus (prior weights discarded) — predictable
 * geometry, minimal share-link payload. Unknown head count degrades a head
 * path to its attn component.
 */
export function blowUp(focus: Focus, path: string, shape: ModelShape): Focus {
  const nL = Math.max(1, Math.floor(shape.nLayers || 1));
  const p = parseUnitPath(path);
  if (!p) return focus;
  if (p.kind === "embed" || p.kind === "unembed") {
    // rest = nL layers + the other edge unit.
    const w = (shareK(BLOWUP_SHARE) * (nL + EDGE_UNIT_WEIGHT)) / EDGE_UNIT_WEIGHT;
    return { [p.kind]: clampW(w) };
  }
  const layer = p.layer as number;
  if (layer < 0 || layer >= nL) return focus;
  const nHeads = shape.nHeads;
  const withHead =
    p.head !== undefined &&
    typeof nHeads === "number" &&
    nHeads > 1 &&
    p.head >= 0 &&
    p.head < nHeads;
  const depth = 1 + (p.component !== undefined ? 1 : 0) + (withHead ? 1 : 0);
  const k = shareK(Math.pow(BLOWUP_SHARE, 1 / depth));
  const out: Focus = {};
  out[`L${layer}`] = clampW(k * (nL - 1 + 2 * EDGE_UNIT_WEIGHT));
  if (p.component !== undefined) out[`L${layer}/${p.component}`] = clampW(k * 1);
  if (withHead) out[`L${layer}/attn/h${p.head}`] = clampW(k * ((nHeads as number) - 1));
  return out;
}

/**
 * Expand every distinct layer a circuit's nodes touch, evenly, so together
 * they hold ~FIT_SHARE of the pane. Fresh focus, like blowUp.
 */
export function fitCircuit(focus: Focus, nodes: CircuitNode[], shape: ModelShape): Focus {
  const nL = Math.max(1, Math.floor(shape.nLayers || 1));
  const layers = [
    ...new Set(
      (nodes ?? [])
        .map((n) => n?.layer)
        .filter((l): l is number => typeof l === "number" && l >= 0 && l < nL),
    ),
  ];
  if (layers.length === 0) return {};
  const rest = nL - layers.length + 2 * EDGE_UNIT_WEIGHT;
  const w = clampW((shareK(FIT_SHARE) * rest) / layers.length);
  const out: Focus = {};
  for (const l of layers) out[`L${l}`] = w;
  return out;
}

// ---------------------------------------------------------------------------
// Measurements — normalization, deltas, keys
// ---------------------------------------------------------------------------

/**
 * A row's interp measurements as a list. Newer builders ship
 * interp.measurements; legacy blobs carry ONE headline record in the flat
 * fields — normalize it into the same shape (an empty list is treated like
 * an absent one). No interp → [].
 */
export function measurementsOf(row: RunRow): InterpMeasurement[] {
  const interp = row.interp;
  if (!interp) return [];
  if (interp.measurements && interp.measurements.length > 0) return interp.measurements;
  if (interp.measurement_kind != null) {
    return [
      {
        kind: interp.measurement_kind,
        value: interp.value,
        null_control: interp.null_control,
      },
    ];
  }
  return [];
}

/** delta = value − null_control; prefer the builder-shipped field. */
export function deltaOf(m: InterpMeasurement): number | null {
  if (typeof m.delta === "number" && Number.isFinite(m.delta)) return m.delta;
  if (typeof m.value === "number" && typeof m.null_control === "number") {
    return m.value - m.null_control;
  }
  return null;
}

/** Matching/selection key: (method||kind, metric_name, layer, locus_component,
 * head) — the twin-pairing identity from ANATOMY-SPEC.md. Doubles as the
 * AnatomyConfig.sel selection id (share links carry it), so it must stay a
 * stable pure function of the measurement's identity fields. The "|"
 * separator relies on CMT slugs never containing pipes (true of the whole
 * taxonomy); parseMeasurementKey rejects any string that doesn't split back
 * into exactly five fields. */
export function measurementKey(m: InterpMeasurement): string {
  return [
    m.method || m.kind,
    m.metric_name ?? "",
    typeof m.layer === "number" ? m.layer : "",
    m.locus_component ?? "",
    typeof m.head === "number" ? m.head : "",
  ].join("|");
}

export interface MeasurementKeyParts {
  method: string; // method || kind at encode time
  metricName: string; // "" when the measurement had none
  layer: number | null;
  locusComponent: string; // "" when the measurement had none
  head: number | null;
}

/** Decode a measurementKey back into its fields; null on anything that is
 * not a well-formed five-field key (junk sel values arrive from URLs). */
export function parseMeasurementKey(key: string): MeasurementKeyParts | null {
  if (typeof key !== "string") return null;
  const parts = key.split("|");
  if (parts.length !== 5) return null;
  const numOrNull = (s: string): number | null | undefined => {
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined; // undefined = malformed
  };
  const layer = numOrNull(parts[2]);
  const head = numOrNull(parts[4]);
  if (layer === undefined || head === undefined) return null;
  return {
    method: parts[0],
    metricName: parts[1],
    layer,
    locusComponent: parts[3],
    head,
  };
}

/** Human locus string ("L14/attn/h9", "embed", "global", "circuit (subgraph)")
 * — shared by the pane tooltip/titles and the detail-panel anatomy section. */
export function locusLabel(m: InterpMeasurement): string {
  if (typeof m.layer === "number" && Number.isFinite(m.layer)) {
    const comp =
      m.locus_component && m.locus_component !== "resid" ? `/${m.locus_component}` : "";
    const head = typeof m.head === "number" ? `/h${m.head}` : "";
    return `L${m.layer}${comp}${head}`;
  }
  if (m.locus_component === "embed" || m.locus_component === "unembed") {
    return m.locus_component;
  }
  if (m.locus_shape === "global" || m.locus_shape === "parameter") return m.locus_shape;
  if (m.locus_shape === "subgraph" || m.locus_shape === "path") {
    return `circuit (${m.locus_shape})`;
  }
  return "unlocated";
}

/** Model shape for a row: builder-shipped n_layers/n_heads/d_mlp, falling
 * back to inference (max observed layer/head + 1). Null when even the layer
 * count is unknowable — the pane then degrades to a no-spine empty state. */
export function rowShape(row: RunRow): ModelShape | null {
  const nLayers = rowLayerCount(row);
  if (nLayers === null) return null;
  let nHeads = typeof row.n_heads === "number" && row.n_heads > 0 ? row.n_heads : null;
  if (nHeads === null) {
    let top = -1;
    for (const m of measurementsOf(row)) {
      if (typeof m.head === "number") top = Math.max(top, m.head);
      for (const n of m.nodes ?? []) {
        if (typeof n?.head === "number") top = Math.max(top, n.head);
      }
    }
    nHeads = top >= 0 ? top + 1 : null;
  }
  const dMlp = typeof row.d_mlp === "number" && row.d_mlp > 0 ? row.d_mlp : null;
  return { nLayers, nHeads, dMlp };
}

/**
 * The run's function-false twin among loaded rows: the measurement-level
 * twin_hash names the OTHER function's hash; resolve it against
 * identity.function_hash, preferring the candidate that shares the run's
 * dataset/training hashes (twins share every non-function facet, so the
 * same-facets candidate IS the pair when several seeds exist). Null when the
 * row carries no twin_hash or no loaded row matches.
 */
export function findTwinRow(run: RunRow, rows: RunRow[]): RunRow | null {
  let hash: string | null = null;
  for (const m of measurementsOf(run)) {
    if (typeof m.twin_hash === "string" && m.twin_hash) {
      hash = m.twin_hash;
      break;
    }
  }
  if (!hash) return null;
  let first: RunRow | null = null;
  for (const r of rows) {
    if (r === run || r.identity.function_hash !== hash) continue;
    if (
      r.identity.dataset_hash === run.identity.dataset_hash &&
      r.identity.training_hash === run.identity.training_hash
    ) {
      return r;
    }
    first ??= r;
  }
  return first;
}

// ---------------------------------------------------------------------------
// Run band heat — per-layer residual-stream aggregate (model-LOD heat cells)
// ---------------------------------------------------------------------------

/**
 * Per-layer max |delta| of RESIDUAL-stream evidence: discrete measurements
 * whose locus is the resid stream (locus_component "resid", or absent on a
 * point/absent-shape record — the legacy default), plus every layer_profile
 * sweep point (sweeps are per-layer resid sweeps by definition). Component
 * loci (attn/mlp/head) are excluded — they light their own structures, not
 * the bar. This is the run/twin bar's heat-cell data at model LOD.
 */
export function residLayerHeat(ms: InterpMeasurement[]): Map<number, number> {
  const out = new Map<number, number>();
  const bump = (layer: number, d: number) => {
    const a = Math.abs(d);
    const prev = out.get(layer);
    if (prev === undefined || a > prev) out.set(layer, a);
  };
  for (const m of ms) {
    const d = deltaOf(m);
    const comp = m.locus_component ?? "resid";
    const shapeKind = m.locus_shape ?? "point";
    if (
      d !== null &&
      comp === "resid" &&
      shapeKind === "point" &&
      typeof m.layer === "number" &&
      Number.isFinite(m.layer)
    ) {
      bump(m.layer, d);
    }
    for (const p of m.layer_profile ?? []) {
      if (typeof p?.[0] === "number" && typeof p?.[1] === "number") bump(p[0], p[1]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Neuron strip binning — top-k components → px bins (component/leaf LOD)
// ---------------------------------------------------------------------------

export interface NeuronBin {
  /** max |weight| of the components landing in this bin (0 = unlit). */
  value: number;
  /** neuron index of that strongest component (leaf-LOD label); null unlit. */
  top: number | null;
}

/**
 * Bin top-k [neuron_index, weight] pairs into nBins slots over d_mlp neurons
 * (bin value = max |weight| landing in the bin, per the spec). Junk pairs and
 * out-of-range indices are skipped; unknown d_mlp or degenerate bin counts
 * yield all-zero bins — the strip renders structurally unlit, never crashes.
 */
export function neuronBins(
  components: [number, number][] | undefined,
  dMlp: number | null,
  nBins: number,
): NeuronBin[] {
  const n = Math.max(0, Math.floor(nBins));
  const out: NeuronBin[] = Array.from({ length: n }, () => ({ value: 0, top: null }));
  if (!components || typeof dMlp !== "number" || dMlp <= 0 || n === 0) return out;
  for (const c of components) {
    const idx = c?.[0];
    const w = c?.[1];
    if (typeof idx !== "number" || typeof w !== "number" || !Number.isFinite(w)) continue;
    if (idx < 0 || idx >= dMlp) continue;
    const b = Math.min(n - 1, Math.floor((idx / dMlp) * n));
    const a = Math.abs(w);
    if (a > out[b].value) out[b] = { value: a, top: idx };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Run/twin matching + per-layer diff aggregate (the contrast strip's data)
// ---------------------------------------------------------------------------

export interface MatchedPair {
  key: string;
  run: InterpMeasurement | null;
  twin: InterpMeasurement | null;
}

export interface LayerDelta {
  layer: number;
  run: number; // max |delta| observed on the run side at this layer
  twin: number; // … and on the twin side
}

export interface MeasurementMatch {
  pairs: MatchedPair[];
  /** Sorted by layer; aggregates BOTH discrete measurement deltas and
   * layer_profile sweep points (the strip wants the fullest per-layer story). */
  layerDeltas: LayerDelta[];
  /** Max |delta| over both sides' discrete measurements — the marker-radius
   * normalizer, shared so run and twin marker sizes are comparable. */
  deltaMax: number;
}

export function matchMeasurements(run: RunRow, twin: RunRow | null): MeasurementMatch {
  const runMs = measurementsOf(run);
  const twinMs = twin ? measurementsOf(twin) : [];

  const unmatched = new Map<string, InterpMeasurement[]>();
  for (const m of twinMs) {
    const k = measurementKey(m);
    const bucket = unmatched.get(k);
    if (bucket) bucket.push(m);
    else unmatched.set(k, [m]);
  }
  const pairs: MatchedPair[] = runMs.map((m) => {
    const k = measurementKey(m);
    const t = unmatched.get(k)?.shift() ?? null;
    return { key: k, run: m, twin: t };
  });
  for (const bucket of unmatched.values()) {
    for (const t of bucket) pairs.push({ key: measurementKey(t), run: null, twin: t });
  }

  const agg = new Map<number, { run: number; twin: number }>();
  let deltaMax = 0;
  const track = (side: "run" | "twin", layer: number, delta: number | null) => {
    if (delta === null || !Number.isFinite(delta)) return;
    const a = Math.abs(delta);
    let entry = agg.get(layer);
    if (!entry) {
      entry = { run: 0, twin: 0 };
      agg.set(layer, entry);
    }
    entry[side] = Math.max(entry[side], a);
  };
  const trackAll = (side: "run" | "twin", ms: InterpMeasurement[]) => {
    for (const m of ms) {
      const d = deltaOf(m);
      if (typeof m.layer === "number" && Number.isFinite(m.layer)) {
        track(side, m.layer, d);
      }
      if (d !== null) deltaMax = Math.max(deltaMax, Math.abs(d));
      for (const p of m.layer_profile ?? []) {
        if (typeof p?.[0] === "number" && typeof p?.[1] === "number") {
          track(side, p[0], p[1]);
        }
      }
    }
  };
  trackAll("run", runMs);
  trackAll("twin", twinMs);

  const layerDeltas: LayerDelta[] = [...agg.entries()]
    .map(([layer, v]) => ({ layer, run: v.run, twin: v.twin }))
    .sort((a, b) => a.layer - b.layer);

  return { pairs, layerDeltas, deltaMax };
}

// ---------------------------------------------------------------------------
// Circuit diff — edges keyed by node signature so reordered node arrays and
// index shifts don't fake differences.
// ---------------------------------------------------------------------------

export interface CircuitEdge {
  from: CircuitNode;
  to: CircuitNode;
}

export interface CircuitDiff {
  shared: CircuitEdge[];
  onlyRun: CircuitEdge[];
  onlyTwin: CircuitEdge[];
}

const nodeSig = (n: CircuitNode) =>
  `${n.layer}:${n.component}:${typeof n.head === "number" ? n.head : ""}`;

function edgeMap(m: InterpMeasurement | null | undefined): Map<string, CircuitEdge> {
  const out = new Map<string, CircuitEdge>();
  const nodes = m?.nodes ?? [];
  for (const e of m?.edges ?? []) {
    const from = nodes[e?.[0] as number];
    const to = nodes[e?.[1] as number];
    if (!from || !to) continue; // dangling index — skip, never crash
    out.set(`${nodeSig(from)}->${nodeSig(to)}`, { from, to });
  }
  return out;
}

export function circuitDiff(
  run: InterpMeasurement | null | undefined,
  twin: InterpMeasurement | null | undefined,
): CircuitDiff {
  const a = edgeMap(run);
  const b = edgeMap(twin);
  const shared: CircuitEdge[] = [];
  const onlyRun: CircuitEdge[] = [];
  const onlyTwin: CircuitEdge[] = [];
  for (const [k, e] of a) (b.has(k) ? shared : onlyRun).push(e);
  for (const [k, e] of b) if (!a.has(k)) onlyTwin.push(e);
  return { shared, onlyRun, onlyTwin };
}

// ---------------------------------------------------------------------------
// Vertical bands — run bar top, twin bar bottom, structure + contrast between
// ---------------------------------------------------------------------------

export interface Band {
  y0: number;
  y1: number;
}

export interface AnatomyBands {
  runBar: Band;
  runZone: Band; // run structure hangs BELOW the bar
  middle: Band; // contrast strip + circuit arcs
  twinZone: Band; // twin structure grows UP from its bar
  twinBar: Band;
}

/**
 * y-geometry for the three bands. Twin off → the run zone takes everything
 * below the bar and the twin spans collapse to zero height at the bottom
 * edge (consistent shapes; the renderer just skips empty bands). Boundaries
 * are cumulative and capped at the pane height, so they are always monotone
 * and finite even for absurdly small panes.
 */
export function computeBands(heightPx: number, twinOn: boolean): AnatomyBands {
  const H = Math.max(0, heightPx);
  const cap = (v: number) => Math.min(v, H);
  const runBar: Band = { y0: cap(BAND_PAD_PX), y1: cap(BAND_PAD_PX + BAND_BAR_PX) };
  if (!twinOn) {
    const bottom = Math.max(runBar.y1, cap(H - BAND_PAD_PX));
    return {
      runBar,
      runZone: { y0: runBar.y1, y1: bottom },
      middle: { y0: bottom, y1: bottom },
      twinZone: { y0: bottom, y1: bottom },
      twinBar: { y0: bottom, y1: bottom },
    };
  }
  const interior = Math.max(0, H - 2 * (BAND_PAD_PX + BAND_BAR_PX));
  const runZone: Band = {
    y0: runBar.y1,
    y1: cap(runBar.y1 + interior * RUN_ZONE_FRAC),
  };
  const middle: Band = {
    y0: runZone.y1,
    y1: cap(runZone.y1 + interior * MIDDLE_FRAC),
  };
  const twinBar: Band = {
    y0: Math.max(middle.y1, cap(H - BAND_PAD_PX - BAND_BAR_PX)),
    y1: Math.max(middle.y1, cap(H - BAND_PAD_PX)),
  };
  return { runBar, runZone, middle, twinZone: { y0: middle.y1, y1: twinBar.y0 }, twinBar };
}

// ---------------------------------------------------------------------------
// Marker sizing — sqrt scale so area tracks |delta|
// ---------------------------------------------------------------------------

/** |delta| → marker radius, sqrt-scaled into [MARKER_R_MIN, MARKER_R_MAX].
 * Null/zero deltas (honest INTERP NULL) sit at the minimum — faint on
 * purpose, never hidden. Degenerate deltaMax → minimum. */
export function deltaRadius(delta: number | null | undefined, deltaMax: number): number {
  const d = typeof delta === "number" && Number.isFinite(delta) ? Math.abs(delta) : 0;
  if (!(deltaMax > 0) || d === 0) return MARKER_R_MIN;
  const t = Math.min(1, Math.sqrt(d / deltaMax));
  return MARKER_R_MIN + (MARKER_R_MAX - MARKER_R_MIN) * t;
}

// ---------------------------------------------------------------------------
// Display maps — carrier → color, mode → glyph
// ---------------------------------------------------------------------------

/** Hard-coded hex (data-series colors never come from CSS vars — chart
 * PALETTE precedent). Chosen mid-value so they read on both themes. */
export const CARRIER_PALETTE: Record<string, string> = {
  direction: "#10b981", // emerald
  subspace: "#38bdf8", // sky
  feature: "#a78bfa", // violet
  circuit: "#f97316", // orange
  lens: "#ec4899", // pink
  other: "#9ca3af", // gray
};

/** Deterministic colors for carriers outside the known taxonomy (CMT-side
 * SSOT is open) — hues distinct from the mains on both themes. */
const CARRIER_FALLBACK = ["#14b8a6", "#6366f1", "#84cc16", "#eab308"];

export function carrierColor(carrier: string | null | undefined): string {
  if (!carrier) return CARRIER_PALETTE.other;
  const known = CARRIER_PALETTE[carrier];
  if (known) return known;
  let h = 5381; // djb2 — stable across sessions, no Math.random
  for (let i = 0; i < carrier.length; i++) h = (h * 33 + carrier.charCodeAt(i)) >>> 0;
  return CARRIER_FALLBACK[h % CARRIER_FALLBACK.length];
}

/** observational = circle (read tap), interventional = diamond (write tap). */
export const MODE_GLYPH: Record<InterpMode, "circle" | "diamond"> = {
  observational: "circle",
  interventional: "diamond",
};

/** Unknown/absent modes read as observational — a circle never overclaims
 * an intervention. */
export function modeGlyph(mode: string | null | undefined): "circle" | "diamond" {
  return mode === "interventional" ? "diamond" : "circle";
}
