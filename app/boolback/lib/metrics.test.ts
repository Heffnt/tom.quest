// Per-axis metric-select ordering (plan #19): Y leads with OUTCOME/DEFENSE,
// X leads with FUNCTION; empty ("no data yet") metrics always trail.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { groupedMetricOptions, X_GROUP_ORDER, Y_GROUP_ORDER } from "./metrics";

const bundle = asBundle(sample);
const schema = bundle.metric_schema;

describe("groupedMetricOptions", () => {
  it("Y order: OUTCOME first, FUNCTION last among present groups", () => {
    const { groups } = groupedMetricOptions(schema, Y_GROUP_ORDER);
    const names = groups.map(([g]) => g);
    expect(names[0]).toBe("OUTCOME");
    const fnIdx = names.indexOf("FUNCTION");
    expect(fnIdx).toBe(names.length - 1);
  });

  it("X order: FUNCTION first", () => {
    const { groups } = groupedMetricOptions(schema, X_GROUP_ORDER);
    expect(groups[0][0]).toBe("FUNCTION");
  });

  it("empty metrics (min AND max null) are pulled out of the groups", () => {
    const { groups, empty } = groupedMetricOptions(schema, Y_GROUP_ORDER);
    const grouped = groups.flatMap(([, es]) => es);
    for (const e of grouped) {
      expect(e.min !== null || e.max !== null).toBe(true);
    }
    for (const e of empty) {
      expect(e.min).toBeNull();
      expect(e.max).toBeNull();
    }
    expect(grouped.length + empty.length).toBe(schema.length);
  });

  it("every schema entry appears exactly once", () => {
    const { groups, empty } = groupedMetricOptions(schema, X_GROUP_ORDER);
    const all = [...groups.flatMap(([, es]) => es), ...empty].map((e) => e.name);
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(schema.length);
  });
});
