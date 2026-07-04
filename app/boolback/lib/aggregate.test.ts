// groupMeans tests — the chart "means" mode reduction (mean ± SD per (x, key)).

import { describe, it, expect } from "vitest";
import { groupMeans } from "./aggregate";

describe("groupMeans", () => {
  it("groups by exact (x, key), computes mean/sd/n, sorts by key then x", () => {
    const { points, binned } = groupMeans([
      { x: 2, y: 1, key: "b" },
      { x: 1, y: 0, key: "a" },
      { x: 1, y: 1, key: "a" },
      { x: 2, y: 3, key: "b" },
      { x: 1, y: 5, key: "b" },
    ]);
    expect(binned).toBe(false);
    expect(points.map((p) => [p.key, p.x, p.n, p.mean])).toEqual([
      ["a", 1, 2, 0.5],
      ["b", 1, 1, 5],
      ["b", 2, 2, 2],
    ]);
    // sample sd: n=1 -> null; n=2 of {1,3} -> sqrt(2)
    expect(points[1].sd).toBeNull();
    expect(points[2].sd).toBeCloseTo(Math.SQRT2, 12);
  });

  it("keeps discrete x exact up to maxGroups distinct values", () => {
    const pts = Array.from({ length: 24 }, (_, i) => ({ x: i, y: i, key: "" }));
    const { points, binned } = groupMeans(pts, 24, 12);
    expect(binned).toBe(false);
    expect(points).toHaveLength(24);
  });

  it("bins a continuous x into equal-width bins at bin centers", () => {
    // 100 distinct x over [0,1) -> 12 bins; means stay in range and n sums back
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: i / 100, y: i, key: "" }));
    const { points, binned } = groupMeans(pts, 24, 12);
    expect(binned).toBe(true);
    expect(points.length).toBeLessThanOrEqual(12);
    expect(points.reduce((s, p) => s + p.n, 0)).toBe(100);
    // x positions are bin centers within the data extent
    for (const p of points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(0.99);
    }
    // the max x lands in the LAST bin, not out of range
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(0 + ((11 + 0.5) / 12) * 0.99, 12);
  });

  it("handles empty input", () => {
    expect(groupMeans([])).toEqual({ points: [], binned: false });
  });
});
