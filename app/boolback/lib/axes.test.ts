// axes tests — parameter axes (numeric dotted-path + categorical ordinal) and
// metric axes, against the real builder fixture.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { indexMetricSchema } from "./metrics";
import { cellValue, numericValue } from "./select";
import { isParamAxis, paramAxisOptions, resolveAxis, PARAM_AXES } from "./axes";
import type { RunRow } from "./types";

const bundle = asBundle(structuredClone(sample));
const rows: RunRow[] = bundle.rows;
const index = indexMetricSchema(bundle.metric_schema);

describe("param axis registry", () => {
  it("recognizes offered dotted-path parameter axes and lists them", () => {
    expect(isParamAxis("training.seed")).toBe(true);
    expect(isParamAxis("dataset.trigger_form")).toBe(true);
    expect(isParamAxis("plantedness")).toBe(false);
    const opts = paramAxisOptions();
    expect(opts).toHaveLength(PARAM_AXES.length);
    expect(opts.every((o) => typeof o.value === "string" && typeof o.label === "string")).toBe(true);
  });
});

describe("resolveAxis — numeric parameter (dotted path)", () => {
  it("reads continuously via numericValue and allows log; integer params jitter", () => {
    const ax = resolveAxis("training.seed", index, rows);
    expect(ax.categorical).toBe(false);
    expect(ax.allowLog).toBe(true);
    expect(ax.jitter).toBe(true); // seed is integer
    for (const r of rows) {
      expect(ax.value(r)).toBe(numericValue(r, "training.seed"));
    }
  });

  it("treats a continuous numeric param (backdoor_ratio) as non-jittering", () => {
    const ax = resolveAxis("dataset.backdoor_ratio", index, rows);
    expect(ax.categorical).toBe(false);
    expect(ax.jitter).toBe(false);
  });
});

describe("resolveAxis — categorical parameter (ordinal + jitter)", () => {
  it("maps distinct values to ordinal positions with category tick labels", () => {
    const ax = resolveAxis("dataset.trigger_form", index, rows);
    expect(ax.categorical).toBe(true);
    expect(ax.allowLog).toBe(false);
    expect(ax.jitter).toBe(true);
    expect(ax.categories.length).toBeGreaterThan(0);
    // positions are contiguous 0..n-1
    const positions = new Set<number>();
    for (const r of rows) {
      const p = ax.value(r);
      if (p === null) continue;
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(ax.categories.length);
      positions.add(p);
      // the category label at that ordinal matches the row's raw value
      expect(ax.categories[p]).toBe(String(cellValue(r, "dataset.trigger_form")));
    }
    expect(positions.size).toBe(ax.categories.length);
    // categories are sorted
    expect(ax.categories).toEqual([...ax.categories].sort());
  });
});

describe("resolveAxis — metric", () => {
  it("resolves a metric_schema name continuously", () => {
    const ax = resolveAxis("plantedness", index, rows);
    expect(ax.categorical).toBe(false);
    expect(ax.allowLog).toBe(true);
    const r = rows.find((x) => numericValue(x, "headline.plantedness") !== null);
    if (r) expect(ax.value(r)).toBe(numericValue(r, "headline.plantedness"));
  });
});
