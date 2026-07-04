// app/boolback/lib/metrics.ts — data-driven metric registry.
//
// There is NO static METRIC_META anymore. The CMT builder emits the full
// metric_schema (names, labels, suites, groups, dtypes, empirical min/max, and
// a printf-style format) inside the snapshot. This module indexes that array
// into a Record and provides a pure formatValue() that honors each entry's
// format string. Building columns/ranges/labels off this index (not a hand-kept
// list) is the whole point of the redesign — it cannot drift from the builder.

import type { Bundle, MetricSchemaEntry, MetricSuite } from "./types";
import { parseMethodMetric } from "./method-metrics";

/** Index metric_schema by metric name. */
export function indexMetricSchema(
  schema: MetricSchemaEntry[],
): Record<string, MetricSchemaEntry> {
  const out: Record<string, MetricSchemaEntry> = {};
  for (const entry of schema) out[entry.name] = entry;
  return out;
}

/** All metric names in a given group, in schema order. */
export function metricNamesInGroup(
  schema: MetricSchemaEntry[],
  group: MetricSchemaEntry["group"],
): string[] {
  return schema.filter((e) => e.group === group).map((e) => e.name);
}

/** All metric names in a given suite, in schema order. */
export function metricNamesInSuite(
  schema: MetricSchemaEntry[],
  suite: MetricSuite,
): string[] {
  return schema.filter((e) => e.suite === suite).map((e) => e.name);
}

/** Convenience groupings derived from a bundle's metric_schema. */
export function metricGroupings(bundle: Bundle): {
  index: Record<string, MetricSchemaEntry>;
  function: string[];
  outcome: string[];
  defense: string[];
  interp: string[];
  scan: string[];
  spectral: string[];
  structural: string[];
} {
  const schema = bundle.metric_schema;
  return {
    index: indexMetricSchema(schema),
    function: metricNamesInGroup(schema, "FUNCTION"),
    outcome: metricNamesInGroup(schema, "OUTCOME"),
    defense: metricNamesInGroup(schema, "DEFENSE"),
    interp: metricNamesInGroup(schema, "INTERP"),
    scan: metricNamesInGroup(schema, "SCAN"),
    spectral: metricNamesInSuite(schema, "spectral"),
    structural: metricNamesInSuite(schema, "structural"),
  };
}

// ---------------------------------------------------------------------------
// Per-axis metric-select ordering. The Y axis is an OUTCOME instrument (what
// happened), the X axis is usually a FUNCTION property (complexity), so each
// dropdown leads with its likely pick instead of making the user scroll past
// 60 complexity metrics to reach plantedness (or vice versa). Metrics no run
// has populated (min AND max null) always trail in a "no data yet" bucket.
// ---------------------------------------------------------------------------

export type MetricGroupName = MetricSchemaEntry["group"];

export const Y_GROUP_ORDER: MetricGroupName[] = ["OUTCOME", "DEFENSE", "INTERP", "SCAN", "FUNCTION"];
export const X_GROUP_ORDER: MetricGroupName[] = ["FUNCTION", "OUTCOME", "DEFENSE", "INTERP", "SCAN"];

/** Schema entries grouped for a <select>, groups in `order`, empty metrics last. */
export function groupedMetricOptions(
  schema: MetricSchemaEntry[],
  order: MetricGroupName[],
): { groups: Array<[string, MetricSchemaEntry[]]>; empty: MetricSchemaEntry[] } {
  const by = new Map<string, MetricSchemaEntry[]>();
  const empty: MetricSchemaEntry[] = [];
  for (const e of schema) {
    if (e.min === null && e.max === null) {
      empty.push(e); // findable below, never the default
      continue;
    }
    const arr = by.get(e.group) ?? [];
    arr.push(e);
    by.set(e.group, arr);
  }
  const groups: Array<[string, MetricSchemaEntry[]]> = [];
  for (const g of order) {
    const arr = by.get(g);
    if (arr?.length) {
      groups.push([g, arr]);
      by.delete(g);
    }
  }
  for (const [g, arr] of by) groups.push([g, arr]); // any group not named in order
  return { groups, empty };
}

// ---------------------------------------------------------------------------
// Per-method collapsing for metric pickers: "<base>@<method>" entries fold
// under their base metric the way facet values fold in the + Filter menu.
// ---------------------------------------------------------------------------

export interface MetricBaseRow {
  baseName: string;
  label: string;
  /** The selectable generic entry (undefined for per-method-only bases). */
  entry?: MetricSchemaEntry;
  children: MetricSchemaEntry[];
}

/** Fold a group's entries into base rows with their per-method children. */
export function collapseMethodEntries(entries: MetricSchemaEntry[]): MetricBaseRow[] {
  const rows: MetricBaseRow[] = [];
  const byBase = new Map<string, MetricBaseRow>();
  for (const e of entries) {
    const ref = parseMethodMetric(e.name);
    if (!ref) {
      const existing = byBase.get(e.name);
      if (existing) {
        existing.entry = e;
        existing.label = e.label;
      } else {
        const row: MetricBaseRow = { baseName: e.name, label: e.label, entry: e, children: [] };
        rows.push(row);
        byBase.set(e.name, row);
      }
      continue;
    }
    let row = byBase.get(ref.base);
    if (!row) {
      // Per-method-only base (no generic entry): label from the child's prefix.
      const cut = e.label.lastIndexOf(" · ");
      row = { baseName: ref.base, label: cut > 0 ? e.label.slice(0, cut) : ref.base, children: [] };
      rows.push(row);
      byBase.set(ref.base, row);
    }
    row.children.push(e);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Value formatting — honors the schema's printf-style format string.
// Supported formats observed from the builder: "d", ".0f", ".1f", ".3f",
// "+.2f". A generic ".<p>f" / "+.<p>f" is parsed for robustness.
// ---------------------------------------------------------------------------

function formatWithSpec(value: number, format: string): string {
  if (format === "d") return String(Math.round(value));

  const m = /^(\+)?\.(\d+)f$/.exec(format);
  if (m) {
    const plus = m[1] === "+";
    const prec = Number(m[2]);
    const s = value.toFixed(prec);
    return plus && value >= 0 ? `+${s}` : s;
  }

  // Fallback: best-effort numeric render.
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/**
 * Format a metric value for display using its schema entry's format. Null /
 * undefined / non-finite render as an em dash (e.g. is_ltf when scipy missing).
 * If the metric is unknown, falls back to a plain numeric render.
 */
export function formatValue(
  index: Record<string, MetricSchemaEntry>,
  name: string,
  value: number | boolean | null | undefined,
): string {
  if (value === null || value === undefined) return "—";
  const num = typeof value === "boolean" ? (value ? 1 : 0) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) return "—";
  const entry = index[name];
  if (!entry) return Number.isInteger(num) ? String(num) : num.toFixed(3);
  return formatWithSpec(num, entry.format);
}

/** Human label for a metric (falls back to the raw name). */
export function metricLabel(
  index: Record<string, MetricSchemaEntry>,
  name: string,
): string {
  return index[name]?.label ?? name;
}
