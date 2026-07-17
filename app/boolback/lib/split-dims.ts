// app/boolback/lib/split-dims.ts — resolve the plot's SERIES.
//
// A layer is ONE trace. The plot draws the UNION of the config's LAYERS (named,
// styled parameter selections); resolveSeries returns exactly ONE series per
// layer, in config order, kept even when it matches nothing. It is the single
// source of truth consumed by plot-panel, group-plot AND the config panel:
//
//   * per layer, the matching rows are the layer's own filters AND the
//     PLOT-LEVEL ranges (drag-zoom), applied over the full bundle rows; a GROUP
//     layer (one carrying `members`) instead matches the UNION of its members'
//     matches, deduped by run identity — ONE series styled by the group's own
//     color/style/name, its pooled runs averaged by the SAME per-x groupRuns
//     machinery (no second averaging path). `memberOf` maps each grouped run to
//     the first member (in order) that matched it — the CSV `member` column;
//   * a run matching several layers is drawn once PER matching layer —
//     duplication is allowed and surfaced as `overlapCount` (distinct runs
//     matching >= 2 layers), never silently deduped;
//   * COLOR is always the layer's own color (no palette-cycling rule); SHAPE
//     and DASH come from the layer's style. Multiple traces are minted as
//     multiple LAYERS by lib/generators, never by an in-layer split;
//   * a layer whose matched rows span > 1 judge is listed in `judgePooled`
//     (its group mixes judges). The per-series `judge` is the unique judge over
//     the layer's rows, or null when mixed/absent.
//
// Judge is read via the `judge` FacetKey getter (select.facetValue) — hardcoded
// (the resolver no longer takes a paramOf/judgeOf opt).
//
// PURE — no store, no React. resolveSeries is unit-tested.

import type { RunRow, PlotLayer, RangeFilter, FilterState, LayerStyle } from "./types";
import { DEFAULT_LAYER_STYLE } from "./types";
import type { ParameterDef } from "./parameters";
import { facetValue } from "./select";

/** The judge parameter key (`judgePooled` watches it). */
export const JUDGE_KEY = "judge";

export interface Series {
  /** === layer id (stable render/join key). */
  key: string;
  layerId: string;
  layerName: string;
  /** === layer name. */
  label: string;
  /** === layer color (always; no palette-cycling rule). */
  color: string;
  /** The owning layer's style (defaults filled — never absent). */
  style: LayerStyle;
  /** This layer's runs (post layer-filters + plot ranges); for a GROUP, the
   *  deduped union of its members' matches. */
  rows: RunRow[];
  /** The unique judge over this series' rows (null when mixed or absent).
   *  Epoch mode scores each series' trajectories with ITS judge; a mixed
   *  series falls back to the headline (and is flagged via judgePooled). */
  judge: string | null;
  /** GROUP series only: run node_path → the first member (in config order)
   *  whose filters matched it (the union-dedup keeps the first). null on a plain
   *  layer. Consumed by the CSV `member` column. */
  memberOf: Map<string, string> | null;
}

export interface SeriesResolution {
  /** One per layer, config order, kept when empty. */
  series: Series[];
  /** Concatenation of per-layer matches (duplicates included). */
  rowsUnion: RunRow[];
  /** Distinct runs matching >= 2 layers. */
  overlapCount: number;
  /** Layer names with zero matching rows. */
  emptyLayers: string[];
  /** Layer names whose matched rows span > 1 judge. */
  judgePooled: string[];
}

/** The unique judge over `rs` (null when mixed or absent). */
function judgeOf(rs: RunRow[]): string | null {
  let found: string | null = null;
  for (const r of rs) {
    const j = facetValue(r, JUDGE_KEY);
    if (j === null) continue;
    if (found === null) found = j;
    else if (j !== found) return null; // mixed
  }
  return found;
}

export function resolveSeries(opts: {
  /** The full bundle rows. */
  rows: RunRow[];
  layers: PlotLayer[];
  /** Plot-level ranges; AND-composed with each layer's filters. */
  ranges: RangeFilter[];
  /** Pass lib/select.applyFilters. */
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): SeriesResolution {
  const { rows, layers, ranges, applyTo } = opts;

  /** A plain layer's matched rows: its own filters AND the plot-level ranges. */
  const plainMatch = (f: FilterState): RunRow[] =>
    applyTo(rows, { facets: f.facets ?? {}, ranges: [...(f.ranges ?? []), ...ranges] });

  // ---- per-layer matches (layer filters AND plot-level ranges) --------------
  // A GROUP unions its members' matches, deduped by run identity (node_path);
  // the first member that matches a run "owns" it (memberOf), so a run in two
  // members is counted once and attributed to the earlier member.
  const matches = layers.map((layer) => {
    if (layer.members && layer.members.length) {
      const seen = new Set<string>();
      const rowsOut: RunRow[] = [];
      const memberOf = new Map<string, string>();
      for (const m of layer.members) {
        for (const r of plainMatch(m.filters)) {
          const id = r.identity.node_path;
          if (seen.has(id)) continue;
          seen.add(id);
          rowsOut.push(r);
          memberOf.set(id, m.name);
        }
      }
      return { layer, rows: rowsOut, memberOf };
    }
    return { layer, rows: plainMatch(layer.filters), memberOf: null as Map<string, string> | null };
  });

  const rowsUnion: RunRow[] = [];
  for (const m of matches) rowsUnion.push(...m.rows);

  // ---- overlap: distinct runs matching >= 2 layers --------------------------
  const matchCount = new Map<RunRow, number>();
  for (const m of matches) {
    for (const r of m.rows) matchCount.set(r, (matchCount.get(r) ?? 0) + 1);
  }
  let overlapCount = 0;
  for (const n of matchCount.values()) if (n >= 2) overlapCount++;

  const emptyLayers = matches.filter((m) => m.rows.length === 0).map((m) => m.layer.name);

  // ---- one series per layer (config order; empty layers kept) ---------------
  const series: Series[] = matches.map((m) => {
    const style: LayerStyle = { ...DEFAULT_LAYER_STYLE, ...(m.layer.style ?? {}) };
    return {
      key: m.layer.id,
      layerId: m.layer.id,
      layerName: m.layer.name,
      label: m.layer.name,
      color: m.layer.color,
      style,
      rows: m.rows,
      judge: judgeOf(m.rows),
      memberOf: m.memberOf,
    };
  });

  // ---- judge pooling (per layer) --------------------------------------------
  const judgePooled: string[] = [];
  for (const m of matches) {
    const judges = new Set<string>();
    for (const r of m.rows) {
      const j = facetValue(r, JUDGE_KEY);
      if (j !== null) judges.add(j);
    }
    if (judges.size > 1) judgePooled.push(m.layer.name);
  }

  return { series, rowsUnion, overlapCount, emptyLayers, judgePooled };
}

/**
 * The parameters the plot's layers actually pool over — the legend's
 * "averaged: …" list. A parameter qualifies when it takes > 1 distinct value
 * WITHIN at least one layer's matched rows (each layer is now one series). A
 * layer-DEFINING parameter — constant within every layer, differing only across
 * them — is a contrast, never an averaged nuisance. Null values are ignored
 * (same convention as summarizeParameters). Returns defs in `params` order.
 */
export function averagedParams(
  resolution: SeriesResolution,
  params: ParameterDef[],
): ParameterDef[] {
  return params.filter((def) =>
    resolution.series.some((s) => {
      let first: string | null = null;
      for (const r of s.rows) {
        const v = def.raw(r);
        if (v === null) continue;
        if (first === null) first = v;
        else if (v !== first) return true;
      }
      return false;
    }),
  );
}
