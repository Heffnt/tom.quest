// groupRuns tests — the chart's (split dims × X bucket) mean ± SD reduction.

import { describe, it, expect } from "vitest";
import { groupRuns, type RunPoint } from "./aggregate";

const pt = (x: number, y: number, dims: string[], runId = `r${x}-${y}`): RunPoint => ({
  x, y, dims, runId,
});

describe("groupRuns", () => {
  it("averaging=false keeps every run as its own point", () => {
    const { points, binned } = groupRuns([pt(1, 2, ["a"]), pt(1, 2, ["a"])], false);
    expect(binned).toBe(false);
    expect(points).toHaveLength(2);
    expect(points.every((p) => p.n === 1 && p.runId !== undefined)).toBe(true);
  });

  it("groups by (dims, exact x), computes mean/sd/n, sorts by dims then x", () => {
    const { points, binned } = groupRuns(
      [
        pt(2, 1, ["b"]),
        pt(1, 0, ["a"]),
        pt(1, 1, ["a"]),
        pt(2, 3, ["b"]),
        pt(1, 5, ["b"]),
      ],
      true,
    );
    expect(binned).toBe(false);
    expect(points.map((p) => [p.dims[0], p.x, p.n, p.y])).toEqual([
      ["a", 1, 2, 0.5],
      ["b", 1, 1, 5],
      ["b", 2, 2, 2],
    ]);
    // sample sd: n=1 -> null; n=2 of {1,3} -> sqrt(2). Single-run groups keep click-through.
    expect(points[1].sdY).toBeNull();
    expect(points[1].runId).toBeDefined();
    expect(points[2].sdY).toBeCloseTo(Math.SQRT2, 12);
    expect(points[2].runId).toBeUndefined();
  });

  it("multi-dimension keys group only full matches (no separator collisions)", () => {
    const { points } = groupRuns(
      [pt(1, 0, ["a b", "c"]), pt(1, 10, ["a", "b c"]), pt(1, 20, ["a b", "c"])],
      true,
    );
    expect(points).toHaveLength(2);
    const joined = points.find((p) => p.dims[0] === "a b")!;
    expect(joined.n).toBe(2);
    expect(joined.y).toBe(10);
  });

  it("bins a continuous x into equal-width bins at bin centers", () => {
    const pts = Array.from({ length: 100 }, (_, i) => pt(i / 100, i, [""]));
    const { points, binned } = groupRuns(pts, true, 24, 12);
    expect(binned).toBe(true);
    expect(points.length).toBeLessThanOrEqual(12);
    expect(points.reduce((s, p) => s + p.n, 0)).toBe(100);
    for (const p of points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(0.99);
    }
  });

  it("keeps discrete x exact up to maxXGroups distinct values", () => {
    const pts = Array.from({ length: 24 }, (_, i) => pt(i, i, [""]));
    const { points, binned } = groupRuns(pts, true, 24, 12);
    expect(binned).toBe(false);
    expect(points).toHaveLength(24);
  });

  it("handles empty input", () => {
    expect(groupRuns([], true)).toEqual({ points: [], binned: false });
  });
});
