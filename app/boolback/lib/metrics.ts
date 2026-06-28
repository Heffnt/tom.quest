// app/boolback/lib/metrics.ts — data-driven metric registry.
//
// There is NO static METRIC_META anymore. The CMT builder emits the full
// metric_schema (names, labels, suites, groups, dtypes, empirical min/max, and
// a printf-style format) inside the snapshot. This module indexes that array
// into a Record and provides a pure formatValue() that honors each entry's
// format string. Building columns/ranges/labels off this index (not a hand-kept
// list) is the whole point of the redesign — it cannot drift from the builder.

import type { Bundle, MetricSchemaEntry, MetricSuite } from "./types";

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
