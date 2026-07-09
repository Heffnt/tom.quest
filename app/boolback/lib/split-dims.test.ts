// split-dims tests — synthetic binned split dimensions + the merged split
// resolution (param splits + binned metrics + pinned judge + colorBy channel
// exclusion). Uses lightweight fakes; the functions only touch the fields below.

import { describe, it, expect } from "vitest";
import { binnedSplitDim, resolveSplits, NULL_BUCKET } from "./split-dims";
import { edgeLabel } from "./bins";
import type { ParameterDef, ParamValues, ParamSummary } from "./parameters";
import type { RunRow } from "./types";

// A RunRow is only ever read through the caller-supplied numericOf here.
const rowsFromValues = (vals: Array<number | null>): RunRow[] =>
  vals.map((v) => ({ __v: v }) as unknown as RunRow);
const numericOf = (r: RunRow) => (r as unknown as { __v: number | null }).__v;

describe("binnedSplitDim", () => {
  it("buckets values into ordered bucket-label values (by bucket index)", () => {
    const rows = rowsFromValues([0, 1, 2, 3, 4]);
    const { values, edges, dim } = binnedSplitDim(
      "m", "M", rows, numericOf, { n: 2, method: "width" }, edgeLabel,
    );
    expect(edges).toEqual([0, 2, 4]);
    expect(values.map((v) => v.value)).toEqual(["0–2", "2–4"]);
    // counts: [0,1] → bucket 0; [2,3,4] → bucket 1 (4 is max-inclusive).
    expect(values.map((v) => v.count)).toEqual([2, 3]);
    // raw() returns the bucket label for a row.
    expect(dim.raw(rows[0])).toBe("0–2");
    expect(dim.raw(rows[4])).toBe("2–4");
  });

  it("sends null-valued rows to a trailing NULL_BUCKET", () => {
    const rows = rowsFromValues([0, 1, null, 4]);
    const { values } = binnedSplitDim("m", "M", rows, numericOf, { n: 2, method: "width" });
    expect(values[values.length - 1].value).toBe(NULL_BUCKET);
    expect(values.find((v) => v.value === NULL_BUCKET)!.count).toBe(1);
  });

  it("honors hand-edited custom edges over computed ones", () => {
    const rows = rowsFromValues([0, 1, 2, 3, 4]);
    const { edges } = binnedSplitDim(
      "m", "M", rows, numericOf, { n: 2, method: "custom", edges: [0, 1, 4] }, edgeLabel,
    );
    expect(edges).toEqual([0, 1, 4]);
  });
});

// ---- resolveSplits --------------------------------------------------------

const pv = (key: string, n: number, opts: Partial<ParameterDef> = {}): ParamValues => ({
  dim: { key, label: key, raw: () => key, section: "function", ...opts } as ParameterDef,
  values: Array.from({ length: n }, (_, i) => ({ value: `${key}${i}`, count: 1 })),
});
const summaryOf = (differing: ParamValues[]): ParamSummary => ({ shared: [], differing });

const baseOpts = (rows: RunRow[]) => ({
  rows,
  numericOf: (m: string) => (r: RunRow) => (r as unknown as Record<string, number>)[m] ?? null,
  labelOf: (m: string) => m,
  fmtEdge: () => edgeLabel,
});

describe("resolveSplits", () => {
  it("synthesizes a binned metric into the split machinery on the color channel", () => {
    const rows = [0, 1, 2, 3, 4].map((v) => ({ deg: v }) as unknown as RunRow);
    const { splitDims, channelByKey } = resolveSplits({
      ...baseOpts(rows),
      summary: summaryOf([]),
      splitKeys: ["deg"],
      bins: { deg: { n: 2, method: "width" } },
      channels: {},
      colorByActive: false,
    });
    expect(splitDims.map((d) => d.dim.key)).toEqual(["deg"]);
    expect(channelByKey.get("deg")).toBe("color");
    expect(splitDims[0].values.map((v) => v.value)).toEqual(["0–2", "2–4"]);
  });

  it("pins judge into the split set even when the user didn't add it", () => {
    const { splitDims, channelByKey, averaging } = resolveSplits({
      ...baseOpts([]),
      summary: summaryOf([pv("model", 3), pv("judge", 2)]),
      splitKeys: [],
      bins: {},
      channels: {},
      colorByActive: false,
    });
    // judge is a split (pinned); model is not → it is averaged.
    expect(channelByKey.has("judge")).toBe(true);
    expect(splitDims.some((d) => d.dim.key === "judge")).toBe(true);
    expect(averaging).toBe(true);
  });

  it("does NOT pin judge when it is the facet (excludeKey)", () => {
    const { channelByKey } = resolveSplits({
      ...baseOpts([]),
      summary: summaryOf([pv("judge", 2)]),
      splitKeys: [],
      bins: {},
      channels: {},
      colorByActive: false,
      excludeKey: "judge",
    });
    expect(channelByKey.has("judge")).toBe(false);
  });

  it("excludes the COLOR channel when a continuous colorBy is active", () => {
    const { channelByKey } = resolveSplits({
      ...baseOpts([]),
      summary: summaryOf([pv("model", 3)]),
      splitKeys: ["model"],
      bins: {},
      channels: {},
      colorByActive: true,
    });
    expect(channelByKey.get("model")).not.toBe("color");
    expect(channelByKey.get("model")).toBe("shape");
  });

  it("drops a degenerate binned metric (one bucket over these rows)", () => {
    const rows = [5, 5, 5].map((v) => ({ flat: v }) as unknown as RunRow);
    const { splitDims } = resolveSplits({
      ...baseOpts(rows),
      summary: summaryOf([]),
      splitKeys: ["flat"],
      bins: { flat: { n: 3, method: "width" } },
      channels: {},
      colorByActive: false,
    });
    expect(splitDims).toHaveLength(0);
  });
});
