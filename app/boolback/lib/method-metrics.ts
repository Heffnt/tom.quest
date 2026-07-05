// app/boolback/lib/method-metrics.ts — per-method metric addressing.
//
// The generic DEFENSE/INTERP/SCAN scalars on a run are HEADLINE rollups over
// whichever methods ran (asr_drop = best over methods, interp = one headline
// kind), so plotting them mixes methods. Per-method values get first-class
// metric names of the form
//
//   <base>@<method>       e.g. "asr_drop@beear", "interp_measurement@caa_ablation"
//
// where <base> is one of the generic scalar names and <method> is the observed
// method slug (defense method / interp measurement kind / scan method family).
// These names appear in metric_schema (from the CMT builder, or synthesized at
// normalize for older blobs), so every schema-driven surface — chart axis
// selects, range filters, table columns, exports — picks them up unchanged.
// This module owns the name convention and the row-value accessor.
//
// It also owns the DERIVED anatomy bases (ANATOMY-SPEC.md "Derived scalars →
// Chart"): interp_peak_layer / interp_loc_width / interp_depth_com reduce a
// kind's locus (layer_profile sweep or single-layer point) to chartable
// scalars. They are CLIENT-derived — never builder-shipped — and get their
// metric_schema entries from data/normalize.withAnatomyMetrics.

import type { InterpMeasurement, RunRow } from "./types";

export const METHOD_SEP = "@";

// The defense fields a method slot can carry: recovery_rate + the full *_drop
// self-join family (asr + ftr + utility-cost drops; newer builders ship all).
const DEFENSE_FIELDS = [
  "asr_drop",
  "recovery_rate",
  "ftr_drop",
  "triggerless_correctness_drop",
  "target_rate_drop",
  "correctness_rate_drop",
] as const;
type DefenseField = (typeof DEFENSE_FIELDS)[number];

/** base metric name -> how to read one method's value off a row. */
const BASE_ACCESSORS: Record<string, (r: RunRow, method: string) => number | null> = {
  interp_measurement: (r, m) => interpKindValue(r, m, "value"),
  interp_null_control: (r, m) => interpKindValue(r, m, "null_control"),
  interp_peak_layer: (r, m) => interpAnatomyValue(r, m, "peak"),
  interp_loc_width: (r, m) => interpAnatomyValue(r, m, "width"),
  interp_depth_com: (r, m) => interpAnatomyValue(r, m, "com"),
  scan_auroc: (r, m) => scanMethodValue(r, m, "auroc"),
  scan_far_at_frr: (r, m) => scanMethodValue(r, m, "far_at_frr"),
};
for (const field of DEFENSE_FIELDS) {
  BASE_ACCESSORS[field] = (r, m) => defenseMethodValue(r, m, field);
}

export const PER_METHOD_BASES = Object.keys(BASE_ACCESSORS);

/** The client-derived anatomy bases (normalize synthesizes their schema entries). */
export const ANATOMY_BASES = [
  "interp_peak_layer",
  "interp_loc_width",
  "interp_depth_com",
] as const;

function defenseMethodValue(
  r: RunRow,
  method: string,
  field: DefenseField,
): number | null {
  const entry = r.defense?.methods?.find((m) => m.method === method);
  const v = entry?.[field];
  return typeof v === "number" ? v : null;
}

function interpKindValue(
  r: RunRow,
  kind: string,
  field: "value" | "null_control",
): number | null {
  // Newer builders ship ALL kinds in interp.measurements; older blobs carry
  // only the headline kind, so a row measuring several shows just that one.
  const list = r.interp?.measurements;
  if (list) {
    const v = list.find((m) => m.kind === kind)?.[field];
    return typeof v === "number" ? v : null;
  }
  if (r.interp && r.interp.measurement_kind === kind) {
    const v = r.interp[field];
    return typeof v === "number" ? v : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Derived anatomy scalars — where a kind's measurements sit in the stream:
//   interp_peak_layer  argmax-delta layer of the sweep (or the point's layer)
//   interp_loc_width   # layers with delta ≥ 50% of the peak delta (point: 1)
//   interp_depth_com   delta-weighted mean layer / (n_layers − 1), clamped 0..1
// Missing locus data (no sweep, no numeric layer — circuits, global loci,
// headline-only interp) -> null, never a fabricated position.
// ---------------------------------------------------------------------------

/** The measurement's usable [layer, delta] sweep (typeof-guarded), or null. */
function sweepOf(m: InterpMeasurement): [number, number][] | null {
  const prof = m.layer_profile?.filter(
    (p) => typeof p?.[0] === "number" && typeof p?.[1] === "number",
  );
  return prof?.length ? prof : null;
}

/**
 * The measurement a kind's anatomy scalars derive from: prefer the sweep
 * (layer_profile), else the first single-layer measurement of that kind — a
 * kind can appear at several layers (probes at L8/L12/L16/…), and find-first
 * would pin the peak to the lowest probed layer instead of the sweep's.
 */
function interpAnatomyMeasurement(r: RunRow, kind: string): InterpMeasurement | null {
  const ofKind = (r.interp?.measurements ?? []).filter((m) => m.kind === kind);
  return (
    ofKind.find((m) => sweepOf(m) !== null) ??
    ofKind.find((m) => typeof m.layer === "number") ??
    null
  );
}

function interpAnatomyValue(
  r: RunRow,
  kind: string,
  field: "peak" | "width" | "com",
): number | null {
  const m = interpAnatomyMeasurement(r, kind);
  if (!m) return null;
  const sweep = sweepOf(m);
  if (sweep) {
    // Signed delta on purpose (spec: argmax delta / ≥50% of peak) — a
    // suppression sweep (all-negative deltas) reads degenerately rather than
    // silently switching to |delta|.
    const peak = sweep.reduce((best, p) => (p[1] > best[1] ? p : best));
    if (field === "peak") return peak[0];
    if (field === "width") return sweep.filter((p) => p[1] >= peak[1] * 0.5).length;
    return depthCom(sweep, rowLayerCount(r));
  }
  if (typeof m.layer !== "number") return null;
  if (field === "peak") return m.layer;
  if (field === "width") return 1;
  return depthCom([[m.layer, 1]], rowLayerCount(r));
}

/** Delta-weighted mean layer / (n_layers − 1), clamped 0..1. Null when the
 * layer count is unknown/degenerate or the total mass is non-positive (a
 * ≤0 mass leaves the center of mass undefined; clamping a negative-total
 * quotient would fabricate a locus). */
function depthCom(sweep: [number, number][], nLayers: number | null): number | null {
  if (nLayers === null || nLayers < 2) return null;
  let mass = 0;
  let moment = 0;
  for (const [layer, delta] of sweep) {
    mass += delta;
    moment += layer * delta;
  }
  if (!(mass > 0)) return null;
  const com = moment / mass / (nLayers - 1);
  return Number.isFinite(com) ? Math.min(1, Math.max(0, com)) : null;
}

/** Sanity ceiling on any layer count read or inferred from blob data — far
 * above every real model, but a hard wall so ONE junk value (`1e999` parses
 * to Infinity; `1e9` is a multi-GB allocation) can never size an array or a
 * render loop. anatomy.ts's MAX_MODEL_HEADS mirrors it for head counts. */
export const MAX_MODEL_LAYERS = 4096;

/**
 * Effective layer count for a row: builder-shipped n_layers, else max
 * observed measurement layer + 1 (point loci, sweep layers, circuit nodes —
 * the types.ts fallback contract), else null on layer-less rows. Non-finite
 * values are junk and ignored (inference takes over); finite counts clamp to
 * MAX_MODEL_LAYERS.
 */
export function rowLayerCount(r: RunRow): number | null {
  if (typeof r.n_layers === "number" && Number.isFinite(r.n_layers) && r.n_layers > 0) {
    return Math.min(Math.floor(r.n_layers), MAX_MODEL_LAYERS);
  }
  let top = -1;
  for (const m of r.interp?.measurements ?? []) {
    if (typeof m.layer === "number" && Number.isFinite(m.layer)) top = Math.max(top, m.layer);
    for (const p of m.layer_profile ?? []) {
      if (typeof p?.[0] === "number" && Number.isFinite(p[0])) top = Math.max(top, p[0]);
    }
    for (const n of m.nodes ?? []) {
      if (typeof n?.layer === "number" && Number.isFinite(n.layer)) top = Math.max(top, n.layer);
    }
  }
  return top >= 0 ? Math.min(Math.floor(top) + 1, MAX_MODEL_LAYERS) : null;
}

function scanMethodValue(
  r: RunRow,
  method: string,
  field: "auroc" | "far_at_frr",
): number | null {
  const list = r.scan?.methods;
  if (list) {
    const v = list.find((m) => m.method === method)?.[field];
    return typeof v === "number" ? v : null;
  }
  if (r.scan && String(r.scan.method_family) === method) {
    const v = r.scan[field];
    return typeof v === "number" ? v : null;
  }
  return null;
}

export interface MethodMetricRef {
  base: string; // generic scalar name ("asr_drop")
  method: string; // method slug ("beear")
}

/** Parse "<base>@<method>"; null unless base is a known per-method scalar. */
export function parseMethodMetric(name: string): MethodMetricRef | null {
  const at = name.indexOf(METHOD_SEP);
  if (at <= 0 || at === name.length - 1) return null;
  const base = name.slice(0, at);
  if (!(base in BASE_ACCESSORS)) return null;
  return { base, method: name.slice(at + 1) };
}

export function methodMetricName(base: string, method: string): string {
  return `${base}${METHOD_SEP}${method}`;
}

/** Row value for a parsed per-method metric. */
export function methodMetricValue(row: RunRow, ref: MethodMetricRef): number | null {
  return BASE_ACCESSORS[ref.base]?.(row, ref.method) ?? null;
}
