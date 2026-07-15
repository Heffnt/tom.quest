// app/boolback/lib/split-dims.ts — resolve the plot's SERIES.
//
// The plot draws the UNION of the config's SETTINGS (named, styled parameter
// selections). Within settings, the user may split by MULTIPLE parameters;
// each (setting × split-combo) is a SERIES. resolveSeries is the single
// source of truth consumed by plot-panel, group-plot AND the config panel:
//
//   * per setting, the matching rows are the setting's own filters AND the
//     PLOT-LEVEL ranges (drag-zoom), applied over the full bundle rows;
//   * a run matching several settings is drawn once PER matching setting —
//     duplication is allowed and surfaced as `overlapCount` (distinct runs
//     matching >= 2 settings), never silently deduped;
//   * a splitBy dim constant over the union (<= 1 distinct value, or an
//     unknown parameter key) is recorded in `inactive` and excluded from
//     combo construction;
//   * COLOR RULE — no active split: each setting is ONE series in its own
//     `setting.color`; active split: every series takes a distinct
//     CATEGORY_PALETTE color in series order (setting-major), cycling past
//     the palette length with `paletteExceeded` set;
//   * `shapeIdx` is the ordinal of the FIRST active splitBy dim's value over
//     the union (global, so a shape means the same value in every setting);
//   * a setting whose matched rows span > 1 judge while "judge" is not in
//     splitBy is listed in `judgePooled` (its groups mix judges).
//
// PURE — no store, no React. resolveSeries is unit-tested.

import type { RunRow, PlotSetting, RangeFilter, FilterState, SettingStyle } from "./types";
import { DEFAULT_SETTING_STYLE } from "./types";
import type { ParameterDef } from "./parameters";
import { CATEGORY_PALETTE } from "./styling";

/** The judge parameter key (`judgePooled` watches it). */
export const JUDGE_KEY = "judge";

/** Placeholder combo value for a row missing a split parameter. */
const MISSING = "—";
// Combo-key separator: a control char that cannot occur in a facet value, so
// joined combo values never collide. Declared (not inlined) so the
// source stays plain UTF-8 text — a raw NUL byte makes git treat the file as
// binary and suppresses diffs.
const SERIES_SEP = "\u0000";

export interface Series {
  /** settingId + " " + combo values joined (stable render/join key). */
  key: string;
  settingId: string;
  settingName: string;
  /** One raw value per ACTIVE splitBy dim (in splitBy order); [] when none. */
  combo: string[];
  /** "jailbreak · Qwen2.5" style (setting name + pretty combo values). */
  label: string;
  /** Per the color rule above. */
  color: string;
  /** Ordinal of the FIRST active splitBy dim's value (0 when none); a
   *  setting-level style.shape override replaces it for ALL the setting's
   *  series. */
  shapeIdx: number;
  /** The owning setting's style (defaults filled — never absent). */
  style: SettingStyle;
  /** This series' runs (post setting-filters + plot ranges). */
  rows: RunRow[];
  /** The unique judge over this series' rows (null when mixed or absent).
   *  Epoch mode scores each series' trajectories with ITS judge; a mixed
   *  series falls back to the headline (and is flagged via judgePooled). */
  judge: string | null;
}

export interface SeriesResolution {
  /** Setting-major order, combos value-sorted within a setting. */
  series: Series[];
  /** Concatenation of per-setting matches (duplicates included). */
  rowsUnion: RunRow[];
  /** Distinct runs matching >= 2 settings. */
  overlapCount: number;
  /** Setting names with zero matching rows. */
  emptySettings: string[];
  /** Setting names whose matched rows span > 1 judge AND "judge" ∉ splitBy. */
  judgePooled: string[];
  /** Series count exceeded the categorical palette (colors cycled). */
  paletteExceeded: boolean;
  /** splitBy keys with <= 1 distinct value over the union (or unknown). */
  inactive: Record<string, "constant">;
}

export function resolveSeries(opts: {
  /** The full bundle rows. */
  rows: RunRow[];
  settings: PlotSetting[];
  /** Plot-level ranges; AND-composed with each setting's filters. */
  ranges: RangeFilter[];
  splitBy: string[];
  /** From the lib/parameters PARAMETERS lookup. */
  paramOf: (key: string) => ParameterDef | null;
  /** Pass lib/select.applyFilters. */
  applyTo: (rows: RunRow[], f: FilterState) => RunRow[];
}): SeriesResolution {
  const { rows, settings, ranges, splitBy, paramOf, applyTo } = opts;

  // ---- per-setting matches (setting filters AND plot-level ranges) ----------
  const matches = settings.map((setting) => ({
    setting,
    rows: applyTo(rows, {
      facets: setting.filters.facets ?? {},
      ranges: [...(setting.filters.ranges ?? []), ...ranges],
    }),
  }));

  const rowsUnion: RunRow[] = [];
  for (const m of matches) rowsUnion.push(...m.rows);

  // ---- overlap: distinct runs matching >= 2 settings ------------------------
  const matchCount = new Map<RunRow, number>();
  for (const m of matches) {
    for (const r of m.rows) matchCount.set(r, (matchCount.get(r) ?? 0) + 1);
  }
  let overlapCount = 0;
  for (const n of matchCount.values()) if (n >= 2) overlapCount++;

  const emptySettings = matches.filter((m) => m.rows.length === 0).map((m) => m.setting.name);

  // ---- active split dims (constant/unknown dims fall to `inactive`) ---------
  const inactive: SeriesResolution["inactive"] = {};
  const activeDims: ParameterDef[] = [];
  for (const key of splitBy) {
    const def = paramOf(key);
    if (!def) {
      inactive[key] = "constant";
      continue;
    }
    const values = new Set<string>();
    for (const r of rowsUnion) values.add(def.raw(r) ?? MISSING);
    if (values.size <= 1) {
      inactive[key] = "constant";
      continue;
    }
    activeDims.push(def);
  }

  const cmpOf = (def: ParameterDef) =>
    def.numericSort
      ? (a: string, b: string) => Number(a) - Number(b)
      : (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  // Ordinals of the FIRST active dim's values over the union (shape channel).
  const shapeOrdinal = new Map<string, number>();
  if (activeDims.length > 0) {
    const def = activeDims[0];
    const vals = [...new Set(rowsUnion.map((r) => def.raw(r) ?? MISSING))].sort(cmpOf(def));
    vals.forEach((v, i) => shapeOrdinal.set(v, i));
  }

  // ---- series (setting-major; combos value-sorted within a setting) ---------
  const judgeDef = paramOf(JUDGE_KEY);
  const judgeOf = (rs: RunRow[]): string | null => {
    if (!judgeDef) return null;
    let found: string | null = null;
    for (const r of rs) {
      const j = judgeDef.raw(r);
      if (j === null) continue;
      if (found === null) found = j;
      else if (j !== found) return null; // mixed
    }
    return found;
  };

  const series: Series[] = [];
  for (const m of matches) {
    const style: SettingStyle = { ...DEFAULT_SETTING_STYLE, ...(m.setting.style ?? {}) };
    if (activeDims.length === 0) {
      // One series per setting (kept even when empty — 1:1 with the config).
      series.push({
        key: m.setting.id,
        settingId: m.setting.id,
        settingName: m.setting.name,
        combo: [],
        label: m.setting.name,
        color: m.setting.color,
        shapeIdx: style.shape ?? 0,
        style,
        rows: m.rows,
        judge: judgeOf(m.rows),
      });
      continue;
    }
    const byCombo = new Map<string, { combo: string[]; rows: RunRow[] }>();
    for (const r of m.rows) {
      const combo = activeDims.map((d) => d.raw(r) ?? MISSING);
      const k = combo.join(SERIES_SEP);
      const slot = byCombo.get(k);
      if (slot) slot.rows.push(r);
      else byCombo.set(k, { combo, rows: [r] });
    }
    const combos = [...byCombo.values()].sort((a, b) => {
      for (let i = 0; i < activeDims.length; i++) {
        const c = cmpOf(activeDims[i])(a.combo[i], b.combo[i]);
        if (c !== 0) return c;
      }
      return 0;
    });
    for (const c of combos) {
      const pretty = c.combo.map((v, i) => {
        const d = activeDims[i];
        return d.display ? d.display(v) : v;
      });
      series.push({
        key: [m.setting.id, ...c.combo].join(" "),
        settingId: m.setting.id,
        settingName: m.setting.name,
        combo: c.combo,
        label: [m.setting.name, ...pretty].join(" · "),
        color: "", // assigned by the color rule below
        shapeIdx: style.shape ?? shapeOrdinal.get(c.combo[0]) ?? 0,
        style,
        rows: c.rows,
        judge: judgeOf(c.rows),
      });
    }
  }

  // ---- color rule ------------------------------------------------------------
  let paletteExceeded = false;
  if (activeDims.length > 0) {
    paletteExceeded = series.length > CATEGORY_PALETTE.length;
    series.forEach((s, i) => {
      s.color = CATEGORY_PALETTE[i % CATEGORY_PALETTE.length];
    });
  }

  // ---- judge pooling (per setting) -------------------------------------------
  const judgePooled: string[] = [];
  if (judgeDef && !splitBy.includes(JUDGE_KEY)) {
    for (const m of matches) {
      const judges = new Set<string>();
      for (const r of m.rows) {
        const j = judgeDef.raw(r);
        if (j !== null) judges.add(j);
      }
      if (judges.size > 1) judgePooled.push(m.setting.name);
    }
  }

  return { series, rowsUnion, overlapCount, emptySettings, judgePooled, paletteExceeded, inactive };
}

/**
 * The parameters the plot's groups actually pool over — the legend's
 * "averaged: …" list. A parameter qualifies only when it takes > 1 distinct
 * value WITHIN at least one setting's matched rows (a setting's rows = the
 * concatenation of its series' rows) and is not an ACTIVE splitBy dim. A
 * setting-DEFINING parameter — constant within every setting, differing only
 * across them — is a contrast, never an averaged nuisance. Null values are
 * ignored (same convention as summarizeParameters). Returns defs in `params`
 * order.
 */
export function averagedParams(
  resolution: SeriesResolution,
  splitBy: string[],
  params: ParameterDef[],
): ParameterDef[] {
  const active = new Set(splitBy.filter((k) => !(k in resolution.inactive)));
  const rowsBySetting = new Map<string, RunRow[]>();
  for (const s of resolution.series) {
    const arr = rowsBySetting.get(s.settingId);
    if (arr) arr.push(...s.rows);
    else rowsBySetting.set(s.settingId, [...s.rows]);
  }
  const settingRows = [...rowsBySetting.values()];
  return params.filter((def) => {
    if (active.has(def.key)) return false;
    return settingRows.some((rs) => {
      let first: string | null = null;
      for (const r of rs) {
        const v = def.raw(r);
        if (v === null) continue;
        if (first === null) first = v;
        else if (v !== first) return true;
      }
      return false;
    });
  });
}
