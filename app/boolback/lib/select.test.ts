// Pure-derivation tests for select.ts against the REAL builder fixture.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import {
  applyFilters,
  applySorts,
  facetKeyForColumn,
  facetOptions,
  numericValue,
  metricRange,
  normalizeToRange,
  FACET_KEYS,
} from "./select";
import { indexMetricSchema } from "./metrics";
import { fnText } from "./format";
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

  it("search matches run id / fn hex / model, case-insensitive, AND across tokens", () => {
    const row = rows[0];
    const hex = fnText(row.function.arity, row.function.truth_table);
    const byHex = applyFilters(rows, { ...EMPTY_FILTER, search: hex.toLowerCase() });
    expect(byHex.length).toBeGreaterThan(0);
    expect(byHex).toContain(row);

    const byId = applyFilters(rows, { ...EMPTY_FILTER, search: row.identity.run_id });
    expect(byId).toContain(row);

    // AND across tokens: hex + model narrows, never widens
    const model = row.training.base_model ?? "";
    const both = applyFilters(rows, { ...EMPTY_FILTER, search: `${hex} ${model}` });
    expect(both.length).toBeLessThanOrEqual(byHex.length);
    expect(both).toContain(row);

    expect(applyFilters(rows, { ...EMPTY_FILTER, search: "zzz-no-such-token" })).toHaveLength(0);
    // empty / whitespace search is a no-op
    expect(applyFilters(rows, { ...EMPTY_FILTER, search: "   " })).toHaveLength(rows.length);
  });

  it("facetKeyForColumn maps categorical column ids to their facet", () => {
    expect(facetKeyForColumn("training.base_model")).toBe("baseModel");
    expect(facetKeyForColumn("dataset.source")).toBe("source");
    expect(facetKeyForColumn("function.arity")).toBe("arity");
    expect(facetKeyForColumn("headline.plantedness")).toBeNull();
  });
});
