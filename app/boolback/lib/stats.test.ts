// Descriptive-stat helpers: the chart's trend/correlation readout and the
// summary footer / .tex export share these, so they must be boringly correct.

import { describe, it, expect } from "vitest";
import {
  mean, stdDev, pearson, spearman, olsFit, niceTicks, summarize,
} from "./stats";

describe("stats basics", () => {
  it("mean / stdDev on knowns", () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(mean([])).toBeNull();
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(stdDev([5])).toBeNull();
  });

  it("pearson: perfect linear = ±1, zero variance = null", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 12);
    expect(pearson([1, 1, 1], [2, 4, 6])).toBeNull();
    expect(pearson([1], [2])).toBeNull();
  });

  it("spearman: monotonic nonlinear = 1; ties averaged", () => {
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [64, 27, 8, 1])).toBeCloseTo(-1, 12);
    // ties: still well-defined, in [-1, 1]
    const r = spearman([1, 1, 2, 3], [10, 12, 20, 30]);
    expect(r).not.toBeNull();
    expect(Math.abs(r!)).toBeLessThanOrEqual(1);
  });

  it("olsFit recovers an exact line", () => {
    const fit = olsFit([0, 1, 2, 3], [1, 3, 5, 7]); // y = 1 + 2x
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(2, 12);
    expect(fit!.intercept).toBeCloseTo(1, 12);
    expect(olsFit([2, 2, 2], [1, 2, 3])).toBeNull(); // zero x-variance
  });

  it("niceTicks lands on 1/2/5 multiples and covers the domain", () => {
    const t = niceTicks(0, 1, 5);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]).toBeCloseTo(1, 12);
    expect(t).toContain(0.2);
    const t2 = niceTicks(0, 137, 5);
    for (const v of t2) expect(v % 20).toBeCloseTo(0, 9); // step 20 for span 137
    expect(niceTicks(3, 3)).toEqual([3]);
  });
});

describe("summarize", () => {
  const items = [
    { g: "a", x: 1, y: 10 },
    { g: "a", x: 3, y: null },
    { g: "b", x: 5, y: 20 },
  ];
  const rows = summarize(
    items,
    ["x", "y"],
    (it) => it.g,
    (it, m) => (m === "x" ? it.x : it.y),
  );

  it("groups sorted + All row appended", () => {
    expect(rows.map((r) => r.group)).toEqual(["a", "b", "All"]);
    expect(rows[2].n).toBe(3);
  });

  it("means skip nulls; per-metric n reflects it", () => {
    const a = rows[0];
    expect(a.cells.x.mean).toBe(2);
    expect(a.cells.x.n).toBe(2);
    expect(a.cells.y.mean).toBe(10);
    expect(a.cells.y.n).toBe(1);
    expect(a.cells.y.sd).toBeNull(); // n<2
    const all = rows[2];
    expect(all.cells.x.mean).toBe(3);
    expect(all.cells.y.mean).toBe(15);
  });
});
