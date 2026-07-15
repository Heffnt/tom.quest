// app/boolback/lib/generators.ts — turn ONE layer into MANY.
//
// A layer is a single trace, so anything that used to make multiple series
// (splitBy, bin-by-metric) now makes multiple LAYERS via a generator. Both
// generators are PURE: they take the current layers + the bundle rows and
// return a NEW layers array (the store commits it via replaceLayers). Neither
// caps the number of layers it mints.
//
//   * expandLayers — replace each target layer with one child per value of a
//     categorical parameter present in its matched rows;
//   * binLayers — replace each target layer with n children slicing a numeric
//     metric into bins, edges computed over THAT layer's rows (so binning under
//     a pinned arity stays within-arity — the point of per-layer edges).
//
// STYLE SEEDING (the "grid" rule): the generated dimension takes COLOR — expand
// uses paletteColor by the value's ordinal in the sorted union across all
// target parents (same value → same color everywhere); bin uses gradientColor
// along the requested bin count (same bin index → same color everywhere).
// PARENT identity takes SHAPE when there is >1 target parent (child shape =
// parentIndex % SHAPE_COUNT); with a single parent, children inherit the
// parent's shape. Dash is always inherited.

import type { RunRow, PlotLayer, FilterState, FacetKey } from "./types";
import { nextLayerId } from "./types";
import type { ParameterDef } from "./parameters";
import type { MetricIndex } from "./select";
import { numericValue } from "./select";
import { paletteColor, gradientColor, SHAPE_COUNT } from "./styling";

export type GeneratorTargets = "all" | "active";

/** Deep-copy a layer's facet selections (arrays cloned so children never share). */
function copyFacets(facets: FilterState["facets"]): FilterState["facets"] {
  return Object.fromEntries(
    Object.entries(facets ?? {}).map(([k, v]) => [k, [...(v ?? [])]]),
  ) as FilterState["facets"];
}

/** The target layers for a generator run (all, or just the active one). */
function targetSet(layers: PlotLayer[], targets: GeneratorTargets, activeId: string): Set<string> {
  return new Set(targets === "all" ? layers.map((l) => l.id) : [activeId]);
}

/** The lone default "all runs" layer drops its name as a child prefix. */
function isLoneDefault(layers: PlotLayer[], layer: PlotLayer): boolean {
  return layers.length === 1 && layer.name === "all runs";
}

/** Ascending numeric compare for numericSort dims, else lexical. */
function valueCmp(dim: ParameterDef): (a: string, b: string) => number {
  return dim.numericSort
    ? (a, b) => Number(a) - Number(b)
    : (a, b) => (a < b ? -1 : a > b ? 1 : 0);
}

/** `filters` with `dim`'s own facet dropped — expanding BY a parameter means
 *  spreading its values, so a parent's existing pin on it must not confine the
 *  children to the pinned value. */
function withoutOwnFacet(filters: FilterState, facetKey: FacetKey): FilterState {
  if (!(facetKey in (filters.facets ?? {}))) return filters;
  const facets = { ...filters.facets };
  delete facets[facetKey];
  return { facets, ranges: filters.ranges };
}

/**
 * Replace each target layer with one child per value of `dim` present in its
 * matched rows (conditioned on the layer's OTHER filters — the dim's own pin,
 * if any, is dropped so the expansion spreads over every reachable value).
 * Non-target layers are untouched.
 */
export function expandLayers(opts: {
  rows: RunRow[];
  layers: PlotLayer[];
  targets: GeneratorTargets;
  activeId: string;
  dim: ParameterDef;
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): PlotLayer[] {
  const { rows, layers, targets, activeId, dim, applyTo } = opts;
  const targetIds = targetSet(layers, targets, activeId);
  const targetLayers = layers.filter((l) => targetIds.has(l.id));
  const nTargets = targetLayers.length;
  const parentPos = new Map(targetLayers.map((l, i) => [l.id, i]));
  const cmp = valueCmp(dim);
  const facetKey = (dim.facetKey ?? dim.key) as FacetKey;

  // Global value ordinals over the sorted union of every target parent's values
  // → the same value gets the same color in every parent.
  const unionVals = new Set<string>();
  for (const p of targetLayers) {
    for (const r of applyTo(rows, withoutOwnFacet(p.filters, facetKey))) {
      const v = dim.raw(r);
      if (v !== null) unionVals.add(v);
    }
  }
  const ordinal = new Map<string, number>();
  [...unionVals].sort(cmp).forEach((v, i) => ordinal.set(v, i));

  // used-id set spans the surviving non-target layers + children minted so far.
  const used = new Set(layers.filter((l) => !targetIds.has(l.id)).map((l) => l.id));
  const out: PlotLayer[] = [];
  for (const layer of layers) {
    if (!targetIds.has(layer.id)) {
      out.push(layer);
      continue;
    }
    const pIndex = parentPos.get(layer.id) ?? 0;
    const present = new Set<string>();
    for (const r of applyTo(rows, withoutOwnFacet(layer.filters, facetKey))) {
      const v = dim.raw(r);
      if (v !== null) present.add(v);
    }
    const lone = isLoneDefault(layers, layer);
    for (const v of [...present].sort(cmp)) {
      const id = nextLayerId(used);
      used.add(id);
      const disp = dim.display ? dim.display(v) : v;
      // A bare numeric value ("0") is ambiguous as a layer name — prefix the
      // parameter label ("Seed 0"); categorical values ("sst2") stand alone.
      const valueLabel = dim.numericSort ? `${dim.label} ${disp}` : disp;
      out.push({
        id,
        name: lone ? valueLabel : `${layer.name} · ${valueLabel}`,
        color: paletteColor(ordinal.get(v) ?? 0),
        style: {
          shape: nTargets > 1 ? pIndex % SHAPE_COUNT : layer.style.shape,
          dash: layer.style.dash,
        },
        filters: {
          facets: { ...copyFacets(layer.filters.facets), [facetKey]: [v] },
          ranges: (layer.filters.ranges ?? []).map((r) => ({ ...r })),
        },
      });
    }
  }
  return out;
}

/** Numeric formatter for bin-edge labels: integers bare, else 3 decimals with
 *  trailing zeros trimmed. */
function fmtEdge(x: number): string {
  if (Number.isInteger(x)) return String(x);
  return String(Number(x.toFixed(3)));
}

/** The `q`-quantile of an ascending finite array (linear interpolation). */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const frac = pos - lo;
  if (lo + 1 >= sorted.length) return sorted[sorted.length - 1];
  return sorted[lo] + (sorted[lo + 1] - sorted[lo]) * frac;
}

/** Bin edges over `values` for `n` bins; duplicate edges collapsed (⇒ fewer
 *  bins than requested is fine, never an empty-range bin). Returns the edge
 *  list (length = binCount + 1); [] when there is nothing to bin. */
function binEdges(values: number[], n: number, mode: "quantile" | "width"): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [lo, hi]; // single degenerate bin
  let edges: number[];
  if (mode === "quantile") {
    const sorted = [...values].sort((a, b) => a - b);
    edges = [];
    for (let k = 0; k <= n; k++) edges.push(quantile(sorted, k / n));
  } else {
    const step = (hi - lo) / n;
    edges = [];
    for (let k = 0; k <= n; k++) edges.push(k === n ? hi : lo + step * k);
  }
  // collapse consecutive duplicate edges
  const uniq = edges.filter((e, i) => i === 0 || e !== edges[i - 1]);
  return uniq.length >= 2 ? uniq : [lo, hi];
}

/** One partitioned bin: [lo, max] is the INCLUSIVE match interval (`max` is
 *  ε-shrunk below the clean edge on every non-last bin so shared-edge values
 *  land in exactly one bin); `hi` is the clean edge for labels/titles. */
export interface Bin {
  lo: number;
  hi: number;
  max: number;
  /** "0–1" style clean-edge label (callers prepend the metric label). */
  label: string;
}

/** The partitioned bins over `values` (shared by binLayers and the Group
 *  Plot's bins facet — one definition of what "bin k" means). [] when there
 *  is nothing to bin. */
export function partitionBins(values: number[], n: number, mode: "quantile" | "width"): Bin[] {
  const edges = binEdges(values, n, mode);
  if (edges.length < 2) return [];
  const eps = (edges[edges.length - 1] - edges[0]) * 1e-9;
  const out: Bin[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    out.push({
      lo,
      hi,
      max: i === edges.length - 2 ? hi : hi - eps,
      label: `${fmtEdge(lo)}–${fmtEdge(hi)}`,
    });
  }
  return out;
}

/**
 * Replace each target layer with children slicing `metric` into bins. Edges are
 * computed over THAT layer's matched rows (within-arity when the layer pins an
 * arity). Rows with a null metric fall out (they match no bin). No cap.
 */
export function binLayers(opts: {
  rows: RunRow[];
  layers: PlotLayer[];
  targets: GeneratorTargets;
  activeId: string;
  metric: string;
  n: number;
  mode: "quantile" | "width";
  index: MetricIndex;
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): PlotLayer[] {
  const { rows, layers, targets, activeId, metric, n, mode, index, applyTo } = opts;
  const targetIds = targetSet(layers, targets, activeId);
  const targetLayers = layers.filter((l) => targetIds.has(l.id));
  const nTargets = targetLayers.length;
  const parentPos = new Map(targetLayers.map((l, i) => [l.id, i]));
  const metricLabel = index[metric]?.label ?? metric;
  const denom = Math.max(1, n - 1); // color ramp denominator (requested n)

  const used = new Set(layers.filter((l) => !targetIds.has(l.id)).map((l) => l.id));
  const out: PlotLayer[] = [];
  for (const layer of layers) {
    if (!targetIds.has(layer.id)) {
      out.push(layer);
      continue;
    }
    const pIndex = parentPos.get(layer.id) ?? 0;
    const values: number[] = [];
    for (const r of applyTo(rows, layer.filters)) {
      const v = numericValue(r, metric);
      if (v !== null) values.push(v);
    }
    // partitionBins carries the ε-shrunk `max` (an edge value lands in exactly
    // ONE bin) alongside the clean-edge label — shared with the bins facet.
    const bins = partitionBins(values, n, mode);
    if (bins.length === 0) continue; // nothing to bin → layer drops
    const lone = isLoneDefault(layers, layer);
    // parent ranges with any existing range on `metric` removed (replaced below)
    const baseRanges = (layer.filters.ranges ?? []).filter((r) => r.metric !== metric);
    for (let i = 0; i < bins.length; i++) {
      const bin = bins[i];
      const id = nextLayerId(used);
      used.add(id);
      const label = `${metricLabel} ${bin.label}`;
      out.push({
        id,
        name: lone ? label : `${layer.name} · ${label}`,
        color: gradientColor(i / denom),
        style: {
          shape: nTargets > 1 ? pIndex % SHAPE_COUNT : layer.style.shape,
          dash: layer.style.dash,
        },
        filters: {
          facets: copyFacets(layer.filters.facets),
          ranges: [...baseRanges.map((r) => ({ ...r })), { metric, min: bin.lo, max: bin.max }],
        },
      });
    }
  }
  return out;
}
