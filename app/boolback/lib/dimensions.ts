// app/boolback/lib/dimensions.ts — the chart's dimension model.
//
// A run is identified by DIMENSIONS (function identity + every dataset/training
// facet + judge/split); X and Y are measurements over them. For the currently
// filtered rows each dimension is either SHARED (one distinct value — the
// context every plotted point has in common) or DIFFERING. Each differing
// dimension gets a treatment:
//
//   split onto a visual channel (color / shape / size) — points separate;
//   filter to a value — handled by the ORDINARY filter mechanism (facet chips,
//     or a fn= scope chip for the function dimension), never here;
//   average — collapsed into group means.
//
// Auto-assignment (no override): differing dimensions sorted biggest-split
// first take the channels in color → shape → size order, skipping dimensions
// whose cardinality exceeds the channel's legibility cap; everything left is
// averaged. Users override per dimension (chart config `dims`); an override
// may exceed the caps (palette/glyphs cycle).

import type { RunRow, FacetKey, DimTreatment } from "./types";
import { facetValue, FACET_LABELS } from "./select";
import { fnText, shortModel } from "./format";

export interface DimensionDef {
  key: string;
  label: string;
  /** RAW grouping/filter value (stringified); null = missing on the row. */
  raw: (r: RunRow) => string | null;
  /** Pretty rendering of a raw value (defaults to identity). */
  display?: (v: string) => string;
  /** Order values numerically (arity, seed, lr, …) instead of lexically. */
  numericSort?: boolean;
  /** Filter action target: a facet key, or the fn= subtree scope for `function`. */
  facetKey?: FacetKey;
  fnScope?: boolean;
}

const facetDim = (
  facetKey: FacetKey,
  opts: Partial<DimensionDef> = {},
): DimensionDef => ({
  key: facetKey,
  label: FACET_LABELS[facetKey],
  raw: (r) => facetValue(r, facetKey),
  facetKey,
  ...opts,
});

/** Every dimension, in display order (the summary re-orders differing ones). */
export const DIMENSIONS: DimensionDef[] = [
  {
    key: "function",
    label: "Function",
    raw: (r) => fnText(r.function.arity, r.function.truth_table),
    fnScope: true,
  },
  facetDim("arity", { numericSort: true }),
  facetDim("source"),
  facetDim("task"),
  facetDim("triggerForm"),
  facetDim("targetBehavior"),
  facetDim("targetPhrase"),
  facetDim("rowDistribution"),
  facetDim("scheme"),
  facetDim("samplesPerRow", { numericSort: true }),
  facetDim("backdoorRatio", { numericSort: true }),
  facetDim("baseModel", { display: shortModel }),
  facetDim("tuning"),
  facetDim("backend"),
  facetDim("lr", { numericSort: true }),
  facetDim("epochs", { numericSort: true }),
  facetDim("seed", { numericSort: true }),
  facetDim("judge"),
  facetDim("split"),
];

export interface DimValues {
  dim: DimensionDef;
  /** Distinct raw values with counts, value-sorted (numeric-aware). */
  values: Array<{ value: string; count: number }>;
}

export interface DimSummary {
  /** One distinct value across every row — the points' common context. */
  shared: Array<{ dim: DimensionDef; value: string }>;
  /** More than one value — sorted biggest split first (then dim order). */
  differing: DimValues[];
}

export function summarizeDimensions(rows: RunRow[]): DimSummary {
  const shared: DimSummary["shared"] = [];
  const differing: DimValues[] = [];
  for (const dim of DIMENSIONS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = dim.raw(r);
      if (v === null) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size === 0) continue; // dimension absent from this data
    const values = [...counts.entries()].map(([value, count]) => ({ value, count }));
    values.sort(
      dim.numericSort
        ? (a, b) => Number(a.value) - Number(b.value)
        : (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    );
    if (values.length === 1) shared.push({ dim, value: values[0].value });
    else differing.push({ dim, values });
  }
  differing.sort((a, b) => b.values.length - a.values.length);
  return { shared, differing };
}

// ---------------------------------------------------------------------------
// Channel assignment
// ---------------------------------------------------------------------------

export type Channel = "color" | "shape" | "size";
export const CHANNELS: Channel[] = ["color", "shape", "size"];

/** Auto-assignment legibility caps (a manual override may exceed them). */
export const CHANNEL_CAPS: Record<Channel, number> = { color: 12, shape: 6, size: 5 };

/**
 * Resolve every differing dimension to a treatment. `overrides` come from
 * chart config; dims without one are auto-assigned biggest-split-first onto
 * the channels still free (respecting the caps), the rest averaged. A channel
 * claimed by two overrides goes to the first differing dim (the setter is
 * expected to keep them unique).
 */
export function assignTreatments(
  differing: DimValues[],
  overrides: Record<string, DimTreatment>,
): Map<string, DimTreatment> {
  const out = new Map<string, DimTreatment>();
  const free = new Set<Channel>(CHANNELS);

  for (const { dim } of differing) {
    const o = overrides[dim.key];
    if (o === "avg") out.set(dim.key, "avg");
    else if (o && free.has(o)) {
      out.set(dim.key, o);
      free.delete(o);
    }
  }
  for (const { dim, values } of differing) {
    if (out.has(dim.key)) continue;
    const fit = CHANNELS.find((c) => free.has(c) && values.length <= CHANNEL_CAPS[c]);
    if (fit) {
      out.set(dim.key, fit);
      free.delete(fit);
    } else {
      out.set(dim.key, "avg");
    }
  }
  return out;
}
