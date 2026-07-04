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

import type { RunRow } from "./types";

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
  scan_auroc: (r, m) => scanMethodValue(r, m, "auroc"),
  scan_far_at_frr: (r, m) => scanMethodValue(r, m, "far_at_frr"),
};
for (const field of DEFENSE_FIELDS) {
  BASE_ACCESSORS[field] = (r, m) => defenseMethodValue(r, m, field);
}

export const PER_METHOD_BASES = Object.keys(BASE_ACCESSORS);

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
