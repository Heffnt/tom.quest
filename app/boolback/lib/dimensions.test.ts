// Dimension-model tests against the REAL builder fixture: shared/differing
// partition, biggest-split-first ordering, channel auto-assignment + caps.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import {
  resolveChannels,
  CHANNEL_CAPS,
  summarizeDimensions,
} from "./dimensions";
import type { RunRow } from "./types";

const bundle = asBundle(structuredClone(sample));
const rows: RunRow[] = bundle.rows;

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

describe("resolveChannels", () => {
  const counts = (m: Record<string, number>) => (k: string) => m[k] ?? 0;

  it("auto-assigns splits in order color → shape → size → dash", () => {
    const c = resolveChannels(
      ["model", "arity", "seed", "trigger"], {},
      counts({ model: 6, arity: 4, seed: 3, trigger: 2 }),
    );
    expect(c.get("model")).toBe("color");
    expect(c.get("arity")).toBe("shape");
    expect(c.get("seed")).toBe("size");
    expect(c.get("trigger")).toBe("dash");
  });

  it("omits non-split (averaged) dims from the map", () => {
    const c = resolveChannels(["a"], {}, counts({ a: 3, b: 5 }));
    expect(c.get("a")).toBe("color");
    expect(c.has("b")).toBe(false);
  });

  it("honors explicit channel overrides and keeps channels unique", () => {
    const c = resolveChannels(["a", "b"], { a: "shape" }, counts({ a: 3, b: 3 }));
    expect(c.get("a")).toBe("shape");
    expect(c.get("b")).toBe("color"); // next free auto channel
    expect(new Set([...c.values()]).size).toBe(2);
  });

  it("always assigns a channel even when no cap fits (cycles past caps)", () => {
    // Exceeds shape/size/dash caps but fits color.
    expect(resolveChannels(["big"], {}, counts({ big: CHANNEL_CAPS.shape + 1 })).get("big")).toBe("color");
    // Fits no cap at all → still gets the first free channel.
    expect(resolveChannels(["huge"], {}, counts({ huge: CHANNEL_CAPS.color + 99 })).get("huge")).toBe("color");
  });
});
