// groupRuns tests — the chart's (split dims × X bucket) mean ± SD reduction,
// plus ghost subsampling and split-worthiness (eta²) edge cases.

import { describe, it, expect } from "vitest";
import {
  groupRuns, makeXBucketer, splitWorthiness, GHOST_CAP,
  type RunPoint, type WorthinessRun,
} from "./aggregate";

const pt = (x: number, y: number, dims: string[], runId = `r${x}-${y}`): RunPoint => ({
  x, y, dims, runId,
});

describe("groupRuns", () => {
  it("averaging=false keeps every run as its own point (no ghosts)", () => {
    const { points, binned, ghosts } = groupRuns([pt(1, 2, ["a"]), pt(1, 2, ["a"])], false);
    expect(binned).toBe(false);
    expect(points).toHaveLength(2);
    expect(points.every((p) => p.n === 1 && p.runId !== undefined)).toBe(true);
    expect(ghosts).toEqual([]);
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
    expect(groupRuns([], true)).toEqual({
      points: [], binned: false, ghosts: [], ghostsSubsampled: false,
    });
  });

  it("returns raw runs as ghosts when averaging", () => {
    const { ghosts, ghostsSubsampled } = groupRuns(
      [pt(1, 0, ["a"]), pt(1, 2, ["a"]), pt(2, 5, ["b"])],
      true,
    );
    expect(ghostsSubsampled).toBe(false);
    expect(ghosts).toHaveLength(3);
    expect(ghosts.every((g) => typeof g.runId === "string" && Array.isArray(g.dims))).toBe(true);
  });

  it("carries the continuous colorBy value: passthrough (single) and group mean", () => {
    const withC = (x: number, y: number, dims: string[], c: number | null): RunPoint =>
      ({ x, y, dims, runId: `r${x}-${y}-${c}`, c });
    // averaging=false → c passes through unchanged.
    const solo = groupRuns([withC(1, 2, ["a"], 4)], false);
    expect(solo.points[0].c).toBe(4);
    // averaging → a group's c is the MEAN of its finite members (null ignored).
    const avg = groupRuns(
      [withC(1, 0, ["a"], 2), withC(1, 10, ["a"], 4), withC(1, 5, ["a"], null)],
      true,
    );
    expect(avg.points).toHaveLength(1);
    expect(avg.points[0].c).toBe(3); // mean(2,4); null skipped
    // ghosts keep each run's own c.
    expect(new Set(avg.ghosts.map((g) => g.c))).toEqual(new Set([2, 4, null]));
  });

  it("group c is null when no member has a finite colorBy value", () => {
    const p = (c: number | null): RunPoint => ({ x: 1, y: 1, dims: ["a"], runId: `r${c}`, c });
    const { points } = groupRuns([p(null), p(null)], true);
    expect(points[0].c).toBeNull();
  });

  it("subsamples ghosts deterministically above GHOST_CAP", () => {
    const pts = Array.from({ length: GHOST_CAP * 3 }, (_, i) => pt(i % 5, i, [""], `r${i}`));
    const a = groupRuns(pts, true);
    const b = groupRuns(pts, true);
    expect(a.ghostsSubsampled).toBe(true);
    expect(a.ghosts.length).toBeLessThanOrEqual(GHOST_CAP);
    expect(a.ghosts.map((g) => g.runId)).toEqual(b.ghosts.map((g) => g.runId)); // deterministic
  });
});

describe("makeXBucketer", () => {
  it("keeps exact values up to maxXGroups then bins", () => {
    const exact = makeXBucketer([{ x: 1 }, { x: 2 }, { x: 3 }], 24, 12);
    expect(exact.binned).toBe(false);
    expect(exact.key(2)).toBe(2);
    const pts = Array.from({ length: 100 }, (_, i) => ({ x: i / 100 }));
    const binned = makeXBucketer(pts, 24, 12);
    expect(binned.binned).toBe(true);
    expect(new Set(pts.map((p) => binned.key(p.x))).size).toBeLessThanOrEqual(12);
  });
});

describe("splitWorthiness", () => {
  const run = (y: number, group: string, values: Record<string, string>): WorthinessRun => ({ y, group, values });

  it("reports ~1 when the dim fully explains within-group spread", () => {
    // One group; seed A always 0, seed B always 10 → splitting seed explains all.
    const runs = [
      run(0, "g", { seed: "A" }), run(0, "g", { seed: "A" }),
      run(10, "g", { seed: "B" }), run(10, "g", { seed: "B" }),
    ];
    expect(splitWorthiness(runs, ["seed"])["seed"]).toBeCloseTo(1, 12);
  });

  it("reports ~0 when the dim explains none of the spread", () => {
    // Spread exists but is uncorrelated with seed (each value spans the range).
    const runs = [
      run(0, "g", { seed: "A" }), run(10, "g", { seed: "A" }),
      run(0, "g", { seed: "B" }), run(10, "g", { seed: "B" }),
    ];
    expect(splitWorthiness(runs, ["seed"])["seed"]).toBeCloseTo(0, 12);
  });

  it("guards: n<3 groups, single-value dims, and all-identical Y contribute nothing", () => {
    expect(splitWorthiness([run(0, "g", { d: "A" }), run(9, "g", { d: "B" })], ["d"])["d"]).toBe(0); // n<3
    expect(splitWorthiness(
      [run(0, "g", { d: "A" }), run(5, "g", { d: "A" }), run(9, "g", { d: "A" })], ["d"],
    )["d"]).toBe(0); // single distinct value
    expect(splitWorthiness(
      [run(3, "g", { d: "A" }), run(3, "g", { d: "A" }), run(3, "g", { d: "B" })], ["d"],
    )["d"]).toBe(0); // all-identical Y
  });

  it("weights eta² by group size across groups", () => {
    // Group g1 (n=4) fully explained; group g2 (n=3) not explained.
    const runs = [
      run(0, "g1", { d: "A" }), run(0, "g1", { d: "A" }), run(8, "g1", { d: "B" }), run(8, "g1", { d: "B" }),
      run(0, "g2", { d: "A" }), run(8, "g2", { d: "A" }), run(4, "g2", { d: "B" }),
    ];
    const w = splitWorthiness(runs, ["d"])["d"];
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
  });
});
