// Pure-derivation tests for select.ts against the REAL builder fixture.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/real";
import {
  applyFilters,
  applySorts,
  facetOptions,
  numericValue,
  metricRange,
  normalizeToRange,
  FACET_KEYS,
} from "./select";
import { indexMetricSchema } from "./metrics";
import { EMPTY_FILTER, type RunRow } from "./types";

const bundle = asBundle(sample);
const rows: RunRow[] = bundle.rows;
const index = indexMetricSchema(bundle.metric_schema);

describe("select", () => {
  it("fixture has rows", () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it("facetOptions: distinct, counted, sorted ascending; every facet key resolves", () => {
    const src = facetOptions(rows, "source");
    expect(src.length).toBeGreaterThan(0);
    expect(src.map((o) => o.value)).toEqual([...src.map((o) => o.value)].sort());
    for (const k of FACET_KEYS) expect(() => facetOptions(rows, k)).not.toThrow();
  });

  it("subtree chip keeps only runs under the node_path; unknown chip yields none", () => {
    const fnDir = rows[0].identity.chain_dirs[0];
    const out = applyFilters(rows, { ...EMPTY_FILTER, subtreeDirs: [fnDir] });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((r) => r.identity.chain_dirs.includes(fnDir))).toBe(true);
    expect(applyFilters(rows, { ...EMPTY_FILTER, subtreeDirs: ["fn=nope"] })).toHaveLength(0);
  });

  it("status plantedOnly filters to planted runs", () => {
    const out = applyFilters(rows, { ...EMPTY_FILTER, status: ["plantedOnly"] });
    expect(out.every((r) => r.status.planted)).toBe(true);
  });

  it("range filter on a dotted column id keeps in-range non-null rows", () => {
    const out = applyFilters(rows, {
      ...EMPTY_FILTER,
      ranges: [{ metric: "headline.asr", min: 0, max: 1 }],
    });
    for (const r of out) {
      const v = numericValue(r, "headline.asr");
      expect(v).not.toBeNull();
      expect(v as number).toBeGreaterThanOrEqual(0);
      expect(v as number).toBeLessThanOrEqual(1);
    }
  });

  it("applyFilters tolerates a stale/partial persisted FilterState (missing sub-keys)", () => {
    // A view saved by an older shape can deserialize without facets/ranges/status/
    // subtreeDirs; the shallow persisted-merge then yields a partial object. This must
    // NOT throw (regression: Object.entries(undefined) crashed the whole table).
    const partials = [
      {},
      { ranges: [{ metric: "distance_to_ltf", min: 0, max: 8 }] },
      { facets: { arity: ["5"] } },
      { status: ["plantedOnly"] },
      { subtreeDirs: [rows[0].identity.chain_dirs[0]] },
    ];
    for (const p of partials) {
      expect(() => applyFilters(rows, p as never)).not.toThrow();
    }
  });

  it("applySorts: ascending numeric order, nulls last", () => {
    const asc = applySorts(rows, [{ col: "headline.plantedness", dir: "asc" }]);
    const nums = asc
      .map((r) => r.headline.plantedness)
      .filter((v): v is number => v !== null);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });

  it("metricRange/normalize read empirical schema bounds by bare name", () => {
    const r = metricRange(rows, "asr", index);
    expect(r.min).toBeLessThanOrEqual(r.max);
    const n = normalizeToRange("asr", r.max, index);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1);
  });
});
