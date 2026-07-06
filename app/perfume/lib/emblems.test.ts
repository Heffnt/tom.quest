import { describe, it, expect } from "vitest";
import base from "../data/base.json";
import emblems from "../data/emblems.json";
import { GLYPH } from "./emblems";

// The bench renders every named frequency's emblem via GLYPH[Named.icon]. If a
// named frequency in base.json has no emblem entry (or its icon isn't in
// GLYPH), it would render blank — so the two synced artifacts must stay in
// lockstep. scripts/sync-perfume-data.mjs enforces this at sync time; this test
// guards it in CI.

const named = (base as { named: { id: string; icon: string }[] }).named;
const emblemMap = emblems as Record<string, { icon: string; d: string }>;

describe("emblems", () => {
  it("has an emblem entry for every named frequency", () => {
    const missing = named.filter((n) => !(n.id in emblemMap));
    expect(missing.map((n) => n.id)).toEqual([]);
  });

  it("exposes a GLYPH path for every named frequency's icon", () => {
    const missing = named.filter((n) => !GLYPH[n.icon]);
    expect(missing.map((n) => n.id)).toEqual([]);
  });

  it("each emblem entry has string icon and path data", () => {
    for (const n of named) {
      const e = emblemMap[n.id];
      expect(typeof e.icon).toBe("string");
      expect(typeof e.d).toBe("string");
      expect(e.d.length).toBeGreaterThan(0);
    }
  });
});
