// Dimension-model tests against the REAL builder fixture: shared/differing
// partition, biggest-split-first ordering, channel auto-assignment + caps.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import {
  assignTreatments,
  CHANNEL_CAPS,
  summarizeDimensions,
  type DimValues,
} from "./dimensions";
import type { RunRow } from "./types";

const bundle = asBundle(structuredClone(sample));
const rows: RunRow[] = bundle.rows;

const dv = (key: string, n: number): DimValues => ({
  dim: { key, label: key, raw: () => null },
  values: Array.from({ length: n }, (_, i) => ({ value: String(i), count: 1 })),
});

describe("summarizeDimensions", () => {
  it("partitions into shared (one value) and differing (sorted biggest first)", () => {
    const s = summarizeDimensions(rows);
    expect(s.shared.length + s.differing.length).toBeGreaterThan(0);
    for (const { dim, value } of s.shared) {
      for (const r of rows) {
        const v = dim.raw(r);
        if (v !== null) expect(v).toBe(value);
      }
    }
    const sizes = s.differing.map((d) => d.values.length);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    for (const d of s.differing) expect(d.values.length).toBeGreaterThan(1);
  });

  it("counts values and sorts numerically when flagged", () => {
    const one = summarizeDimensions([rows[0]]);
    expect(one.differing).toHaveLength(0); // a single row differs on nothing
    const arity = [...one.shared].find((x) => x.dim.key === "arity");
    expect(arity).toBeTruthy();
    expect(Number(arity!.value)).toBe(rows[0].function.arity);
  });
});

describe("assignTreatments", () => {
  it("auto-assigns channels biggest-split-first, remainder averaged", () => {
    const differing = [dv("model", 6), dv("arity", 4), dv("seed", 3), dv("trigger", 2)];
    const t = assignTreatments(differing, {});
    expect(t.get("model")).toBe("color");
    expect(t.get("arity")).toBe("shape");
    expect(t.get("seed")).toBe("size");
    expect(t.get("trigger")).toBe("avg");
  });

  it("skips dims over a channel's cap; overrides may exceed caps", () => {
    const big = dv("function", CHANNEL_CAPS.color + 1); // too many for any channel
    const small = dv("model", 3);
    const auto = assignTreatments([big, small], {});
    expect(auto.get("function")).toBe("avg");
    expect(auto.get("model")).toBe("color");
    const forced = assignTreatments([big, small], { function: "color" });
    expect(forced.get("function")).toBe("color");
    expect(forced.get("model")).toBe("shape"); // color now taken
  });

  it("respects avg overrides and keeps channels unique", () => {
    const differing = [dv("a", 5), dv("b", 4), dv("c", 3)];
    const t = assignTreatments(differing, { a: "avg", c: "color" });
    expect(t.get("a")).toBe("avg");
    expect(t.get("c")).toBe("color");
    expect(t.get("b")).toBe("shape");
    const values = [...t.values()].filter((v) => v !== "avg");
    expect(new Set(values).size).toBe(values.length);
  });
});
