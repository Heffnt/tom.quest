// bin-edge math tests (Phase 2/3 shared). Edges, bucketing, labels.

import { describe, it, expect } from "vitest";
import { computeBinEdges, bucketOf, binLabel, edgeLabel, clampBinCount } from "./bins";

describe("clampBinCount", () => {
  it("clamps to 1..8 and floors / defaults", () => {
    expect(clampBinCount(0)).toBe(1);
    expect(clampBinCount(4)).toBe(4);
    expect(clampBinCount(99)).toBe(8);
    expect(clampBinCount(3.9)).toBe(3);
    expect(clampBinCount(NaN)).toBe(2);
  });
});

describe("computeBinEdges", () => {
  it("equal-width edges span [min,max] with n+1 boundaries", () => {
    const edges = computeBinEdges([0, 1, 2, 3, 4], 4, "width");
    expect(edges).toEqual([0, 1, 2, 3, 4]);
  });

  it("equal-width halves", () => {
    expect(computeBinEdges([0, 10], 2, "width")).toEqual([0, 5, 10]);
  });

  it("quantile edges are equal-count (median split)", () => {
    const edges = computeBinEdges([1, 2, 3, 4], 2, "quantile");
    // n+1 = 3 edges; interior edge is the median (2.5); ends are min/max.
    expect(edges[0]).toBe(1);
    expect(edges[2]).toBe(4);
    expect(edges[1]).toBeCloseTo(2.5, 6);
  });

  it("degenerate inputs yield a flat bucket", () => {
    expect(computeBinEdges([], 3, "width")).toEqual([0, 0, 0, 0]);
    expect(computeBinEdges([5], 2, "quantile")).toEqual([5, 5, 5]);
    expect(computeBinEdges([7, 7, 7], 2, "width")).toEqual([7, 7, 7]);
  });

  it("clamps the bucket count", () => {
    expect(computeBinEdges([0, 1], 100, "width")).toHaveLength(9); // clamped to 8 buckets
    expect(computeBinEdges([0, 1], 0, "width")).toHaveLength(2); // clamped to 1 bucket
  });
});

describe("bucketOf", () => {
  const edges = [0, 1, 2, 3]; // 3 buckets: [0,1) [1,2) [2,3]
  it("maps values into buckets, clamping the ends", () => {
    expect(bucketOf(-5, edges)).toBe(0);
    expect(bucketOf(0, edges)).toBe(0);
    expect(bucketOf(0.5, edges)).toBe(0);
    expect(bucketOf(1, edges)).toBe(1);
    expect(bucketOf(2.9, edges)).toBe(2);
    expect(bucketOf(3, edges)).toBe(2); // max is inclusive in the last bucket
    expect(bucketOf(99, edges)).toBe(2);
  });
  it("degenerate edges always bucket 0", () => {
    expect(bucketOf(5, [1])).toBe(0);
    expect(bucketOf(5, [])).toBe(0);
  });
});

describe("edgeLabel / binLabel", () => {
  it("formats edges compactly", () => {
    expect(edgeLabel(0)).toBe("0");
    expect(edgeLabel(0.12345)).toBe("0.123");
    expect(edgeLabel(1500)).toBe("1.5e+3");
  });
  it("labels a bucket as a closed-open interval", () => {
    expect(binLabel([0, 0.35, 1], 0)).toBe("0–0.35");
    expect(binLabel([0, 0.35, 1], 1)).toBe("0.35–1");
    expect(binLabel([0, 1], 5)).toBe("—"); // out of range
  });
});
