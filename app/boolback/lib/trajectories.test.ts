// trajectories tests — null gaps, judge resolution, in-progress runs, grouping.

import { describe, it, expect } from "vitest";
import { buildRunSeries, groupSeries, trajectoryMetric, type RunSeries } from "./trajectories";
import type { RunRow } from "./types";

// Minimal RunRow stand-in carrying only the fields the builder reads.
const mkRow = (
  id: string,
  epochs: number[],
  headline: Partial<Record<"plantedness" | "asr" | "ftr" | "ppl", (number | null)[]>>,
  perJudge: Array<{ judge: string; asr?: (number | null)[]; ftr?: (number | null)[]; plantedness?: (number | null)[] }> = [],
): RunRow =>
  ({
    identity: { node_path: id },
    trajectories: {
      completed_epochs: epochs,
      plantedness: headline.plantedness ?? [],
      asr: headline.asr ?? [],
      ftr: headline.ftr ?? [],
      ppl: headline.ppl ?? [],
    },
    per_judge: perJudge.map((p) => ({
      judge: p.judge,
      by_epoch: { asr: p.asr ?? [], ftr: p.ftr ?? [], plantedness: p.plantedness ?? [] },
    })),
  } as unknown as RunRow);

const noDims = () => [] as string[];

describe("trajectoryMetric", () => {
  it("accepts the four trajectory-backed metrics, rejects others", () => {
    expect(trajectoryMetric("plantedness")).toBe("plantedness");
    expect(trajectoryMetric("ppl")).toBe("ppl");
    expect(trajectoryMetric("avg_sensitivity")).toBeNull();
  });
});

describe("buildRunSeries", () => {
  it("skips null metric values as line gaps (no interpolation)", () => {
    const rows = [mkRow("r1", [0, 1, 2], { plantedness: [0.1, null, 0.3] })];
    const { series } = buildRunSeries(rows, "plantedness", noDims, null, false);
    expect(series).toHaveLength(1);
    expect(series[0].points).toEqual([{ e: 0, y: 0.1 }, { e: 2, y: 0.3 }]);
  });

  it("in-progress runs simply produce shorter series", () => {
    const rows = [mkRow("r1", [0, 1], { asr: [0.2, 0.5] })];
    const { series } = buildRunSeries(rows, "asr", noDims, null, false);
    expect(series[0].points.map((p) => p.e)).toEqual([0, 1]);
  });

  it("resolves the selected judge's by_epoch arrays; ppl stays headline", () => {
    const rows = [
      mkRow("r1", [0, 1],
        { asr: [0.9, 0.9], ppl: [10, 12] },
        [{ judge: "gpt", asr: [0.1, 0.2] }, { judge: "claude", asr: [0.3, 0.4] }]),
    ];
    const judged = buildRunSeries(rows, "asr", noDims, "claude", false).series[0].points;
    expect(judged.map((p) => p.y)).toEqual([0.3, 0.4]); // per-judge, not headline 0.9
    const headline = buildRunSeries(rows, "asr", noDims, null, false).series[0].points;
    expect(headline.map((p) => p.y)).toEqual([0.9, 0.9]);
    // ppl has no per-judge series → always headline even with a judge selected
    const ppl = buildRunSeries(rows, "ppl", noDims, "claude", false).series[0].points;
    expect(ppl.map((p) => p.y)).toEqual([10, 12]);
  });

  it("drops non-positive Y under logY (counted)", () => {
    const rows = [mkRow("r1", [0, 1, 2], { ppl: [0, 10, 100] })];
    const { series, dropped } = buildRunSeries(rows, "ppl", noDims, null, true);
    expect(dropped).toBe(1);
    expect(series[0].points.map((p) => p.e)).toEqual([1, 2]);
    expect(series[0].points[0].y).toBeCloseTo(1, 12); // log10(10)
  });

  it("omits runs with no plottable points", () => {
    const rows = [mkRow("r1", [0, 1], { asr: [null, null] })];
    expect(buildRunSeries(rows, "asr", noDims, null, false).series).toHaveLength(0);
  });
});

describe("groupSeries", () => {
  it("means ± SD per exact epoch, grouped by dims, ascending", () => {
    const series: RunSeries[] = [
      { runId: "a", dims: ["x"], points: [{ e: 0, y: 0 }, { e: 1, y: 2 }] },
      { runId: "b", dims: ["x"], points: [{ e: 0, y: 4 }, { e: 1, y: 6 }] },
      { runId: "c", dims: ["y"], points: [{ e: 1, y: 9 }] },
    ];
    const groups = groupSeries(series);
    const gx = groups.find((g) => g.dims[0] === "x")!;
    expect(gx.points).toEqual([
      { e: 0, y: 2, sd: expect.closeTo(Math.sqrt(8), 6), n: 2 },
      { e: 1, y: 4, sd: expect.closeTo(Math.sqrt(8), 6), n: 2 },
    ]);
    const gy = groups.find((g) => g.dims[0] === "y")!;
    expect(gy.points).toEqual([{ e: 1, y: 9, sd: null, n: 1 }]);
  });
});
