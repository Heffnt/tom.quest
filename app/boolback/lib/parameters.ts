// app/boolback/lib/parameters.ts — the plot's parameter model.
//
// A run is identified by PARAMETERS (function identity + every dataset/training
// facet + judge/split); X and Y are readings over them. For the currently
// filtered rows each parameter is either SHARED (one distinct value — the
// context every plotted point has in common) or DIFFERING. Each differing
// parameter gets a treatment:
//
//   split onto a visual channel (color / shape / size) — points separate;
//   filter to a value — handled by the ORDINARY filter mechanism (facet
//     selections), never here;
//   average — collapsed into group means.
//
// Auto-assignment (no override): differing parameters sorted biggest-split
// first take the channels in color → shape → size order, skipping parameters
// whose cardinality exceeds the channel's legibility cap; everything left is
// averaged. Users override per parameter (plot config `channels`); an override
// may exceed the caps (palette/glyphs cycle).

import type { RunRow, FacetKey, Channel } from "./types";
import { facetValue, FACET_LABELS } from "./select";
import { fnText, shortModel } from "./format";

export type { Channel };

/** Origin bucket for the config panel's collapsible parameter sections. */
export type ParamSection = "function" | "dataset" | "training" | "judge";

export interface ParameterDef {
  key: string;
  label: string;
  /** RAW grouping/filter value (stringified); null = missing on the row. */
  raw: (r: RunRow) => string | null;
  /** Pretty rendering of a raw value (defaults to identity). */
  display?: (v: string) => string;
  /** Order values numerically (arity, seed, lr, …) instead of lexically. */
  numericSort?: boolean;
  /** Filter action target: a facet key. The `function` parameter has none in
   *  Phase 1 (fn= subtree scope removed; it becomes an ordinary parameter
   *  filter over function identity in a later phase), so its filter UI is
   *  inert for now. */
  facetKey?: FacetKey;
  /** Which origin section the config panel groups this parameter under. */
  section: ParamSection;
  /** Judge never pools (cmt pool_guard): pinned split, never averaged/faceted. */
  alwaysSplit?: boolean;
}

const facetParam = (
  facetKey: FacetKey,
  section: ParamSection,
  opts: Partial<ParameterDef> = {},
): ParameterDef => ({
  key: facetKey,
  label: FACET_LABELS[facetKey],
  raw: (r) => facetValue(r, facetKey),
  facetKey,
  section,
  ...opts,
});

/** Every parameter, in display order (the summary re-orders differing ones). */
export const PARAMETERS: ParameterDef[] = [
  {
    key: "function",
    label: "Function",
    raw: (r) => fnText(r.function.arity, r.function.truth_table),
    section: "function",
  },
  facetParam("arity", "function", { numericSort: true }),
  facetParam("source", "dataset"),
  facetParam("task", "dataset"),
  facetParam("trigger_form", "dataset"),
  facetParam("target_behavior", "dataset"),
  facetParam("target_phrase", "dataset"),
  facetParam("row_distribution", "dataset"),
  facetParam("scheme", "dataset"),
  facetParam("samples_per_row", "dataset", { numericSort: true }),
  facetParam("backdoor_ratio", "dataset", { numericSort: true }),
  facetParam("base_model", "training", { display: shortModel }),
  facetParam("tuning", "training"),
  facetParam("backend", "training"),
  facetParam("lr", "training", { numericSort: true }),
  facetParam("epochs", "training", { numericSort: true }),
  facetParam("seed", "training", { numericSort: true }),
  facetParam("judge", "judge", { alwaysSplit: true }),
  facetParam("split", "judge"),
];

export interface ParamValues {
  dim: ParameterDef;
  /** Distinct raw values with counts, value-sorted (numeric-aware). */
  values: Array<{ value: string; count: number }>;
}

export interface ParamSummary {
  /** One distinct value across every row — the points' common context. */
  shared: Array<{ dim: ParameterDef; value: string }>;
  /** More than one value — sorted biggest split first (then param order). */
  differing: ParamValues[];
}

export function summarizeParameters(rows: RunRow[]): ParamSummary {
  const shared: ParamSummary["shared"] = [];
  const differing: ParamValues[] = [];
  for (const dim of PARAMETERS) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = dim.raw(r);
      if (v === null) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size === 0) continue; // parameter absent from this data
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
// Channel assignment (user-chosen `splits` → visual channels)
// ---------------------------------------------------------------------------

/** Auto channel order for splits without an explicit channel. */
export const CHANNELS: Channel[] = ["color", "shape", "size", "dash"];

/** Legibility caps: auto-assignment prefers a channel whose cap fits the value
 *  count, but a split ALWAYS gets some channel (glyphs/palette cycle past caps).
 *  Explicit user assignment may exceed a cap freely. */
export const CHANNEL_CAPS: Record<Channel, number> = { color: 12, shape: 6, size: 5, dash: 4 };

/**
 * Resolve each split parameter (in `splits` order) to a visual channel.
 * Explicit `channels[key]` wins when its channel is still free; otherwise the
 * next free auto channel is taken, preferring one whose cap fits
 * `valueCount(key)` but always assigning something. Parameters absent from
 * `splits` are averaged (not present in the returned map).
 *
 * `available` restricts which channels may be assigned (default: all). Phase 3
 * passes ["shape","size","dash"] when a continuous `colorBy` gradient owns the
 * COLOR channel, so categorical/binned splits take the remaining channels.
 */
export function resolveChannels(
  splits: string[],
  channels: Record<string, Channel>,
  valueCount: (key: string) => number,
  available: Channel[] = CHANNELS,
): Map<string, Channel> {
  const out = new Map<string, Channel>();
  const free = new Set<Channel>(available);
  // Pass 1: honor explicit channel overrides that are still free.
  for (const key of splits) {
    const c = channels[key];
    if (c && free.has(c)) {
      out.set(key, c);
      free.delete(c);
    }
  }
  // Pass 2: auto-assign the remaining splits in order.
  for (const key of splits) {
    if (out.has(key)) continue;
    const n = valueCount(key);
    const chosen =
      CHANNELS.find((c) => free.has(c) && n <= CHANNEL_CAPS[c]) ??
      CHANNELS.find((c) => free.has(c)) ??
      "color";
    out.set(key, chosen);
    free.delete(chosen);
  }
  return out;
}
