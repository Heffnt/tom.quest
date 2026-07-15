// split-dims tests — resolveSeries: per-setting row matching + union with
// duplicates, splitBy combo construction, the color rule (setting colors vs
// palette cycling), judge pooling, plot-level ranges. Lightweight fakes:
// resolveSeries only touches rows through the injected paramOf/applyTo, so a
// flat fake row shape stands in for RunRow.

import { describe, it, expect } from "vitest";
import { resolveSeries, averagedParams, JUDGE_KEY } from "./split-dims";
import { CATEGORY_PALETTE } from "./styling";
import type { ParameterDef } from "./parameters";
import type { RunRow, PlotSetting, FilterState, RangeFilter } from "./types";

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  model?: string;
  seed?: string;
  judge?: string;
  asr?: number;
}

const row = (r: FakeRow): RunRow => r as unknown as RunRow;
const field = (r: RunRow, k: keyof FakeRow) => (r as unknown as FakeRow)[k];

const DEFS: Record<string, ParameterDef> = {
  base_model: {
    key: "base_model", label: "Model", section: "training",
    raw: (r) => (field(r, "model") as string | undefined) ?? null,
    display: (v) => `m:${v}`,
  },
  seed: {
    key: "seed", label: "Seed", section: "training", numericSort: true,
    raw: (r) => (field(r, "seed") as string | undefined) ?? null,
  },
  [JUDGE_KEY]: {
    key: JUDGE_KEY, label: "Judge", section: "judge",
    raw: (r) => (field(r, "judge") as string | undefined) ?? null,
  },
};
const paramOf = (key: string) => DEFS[key] ?? null;

/** Minimal applyFilters stand-in over the fake facet fields + numeric ranges. */
const applyTo = (rows: RunRow[], f: FilterState): RunRow[] =>
  rows.filter((r) => {
    for (const [key, vals] of Object.entries(f.facets)) {
      if (!Array.isArray(vals) || vals.length === 0) continue;
      const v = DEFS[key]?.raw(r) ?? null;
      if (v === null || !vals.includes(v)) return false;
    }
    for (const rg of f.ranges) {
      const v = field(r, rg.metric as keyof FakeRow);
      if (typeof v !== "number" || v < rg.min || v > rg.max) return false;
    }
    return true;
  });

const setting = (
  id: string,
  name: string,
  facets: FilterState["facets"] = {},
  opts: { color?: string; ranges?: RangeFilter[] } = {},
): PlotSetting => ({
  id,
  name,
  color: opts.color ?? "#123456",
  filters: { facets, ranges: opts.ranges ?? [] },
});

const resolve = (opts: {
  rows: RunRow[];
  settings: PlotSetting[];
  ranges?: RangeFilter[];
  splitBy?: string[];
}) =>
  resolveSeries({
    rows: opts.rows,
    settings: opts.settings,
    ranges: opts.ranges ?? [],
    splitBy: opts.splitBy ?? [],
    paramOf,
    applyTo,
  });

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("resolveSeries", () => {
  it("union keeps duplicates: a run matching two settings appears in both series; overlapCount counts it once", () => {
    const shared = row({ id: "r1", model: "qwen", seed: "0" });
    const only2 = row({ id: "r2", model: "llama", seed: "0" });
    const rows = [shared, only2];
    const res = resolve({
      rows,
      settings: [
        setting("s1", "qwen-ish", { base_model: ["qwen"] }),
        setting("s2", "everything"), // unfiltered — matches both rows
      ],
    });
    expect(res.series.map((s) => s.key)).toEqual(["s1", "s2"]);
    expect(res.series[0].rows).toEqual([shared]);
    expect(res.series[1].rows).toEqual([shared, only2]);
    // union concatenates per-setting matches (the duplicate INCLUDED)…
    expect(res.rowsUnion).toHaveLength(3);
    // …and the overlap warning counts the distinct duplicated run ONCE.
    expect(res.overlapCount).toBe(1);
    expect(res.emptySettings).toEqual([]);
  });

  it("a setting matching nothing lands in emptySettings (its series stays, empty)", () => {
    const rows = [row({ id: "r1", model: "qwen" })];
    const res = resolve({
      rows,
      settings: [
        setting("s1", "qwen", { base_model: ["qwen"] }),
        setting("s2", "ghost town", { base_model: ["nonexistent"] }),
      ],
    });
    expect(res.emptySettings).toEqual(["ghost town"]);
    expect(res.series).toHaveLength(2);
    expect(res.series[1].rows).toEqual([]);
    expect(res.overlapCount).toBe(0);
  });

  it("splitBy builds value-sorted combos per setting; a constant dim is inactive and excluded from combos", () => {
    const rows = [
      row({ id: "a", model: "same", seed: "10" }),
      row({ id: "b", model: "same", seed: "2" }),
      row({ id: "c", model: "same", seed: "2" }),
    ];
    const res = resolve({
      rows,
      settings: [setting("s1", "all")],
      splitBy: ["base_model", "seed"], // base_model constant over the union
    });
    expect(res.inactive).toEqual({ base_model: "constant" });
    // combos over the ACTIVE dim only, numeric-sorted ("2" before "10")
    expect(res.series.map((s) => s.combo)).toEqual([["2"], ["10"]]);
    expect(res.series.map((s) => s.key)).toEqual(["s1 2", "s1 10"]);
    expect(res.series.map((s) => s.label)).toEqual(["all · 2", "all · 10"]);
    expect(res.series[0].rows.map((r) => field(r, "id"))).toEqual(["b", "c"]);
    // shapeIdx = global ordinal of the FIRST active dim's value
    expect(res.series.map((s) => s.shapeIdx)).toEqual([0, 1]);
  });

  it("an unknown splitBy key is recorded inactive", () => {
    const res = resolve({
      rows: [row({ id: "a", seed: "1" }), row({ id: "b", seed: "2" })],
      settings: [setting("s1", "all")],
      splitBy: ["not_a_param", "seed"],
    });
    expect(res.inactive).toEqual({ not_a_param: "constant" });
    expect(res.series.map((s) => s.combo)).toEqual([["1"], ["2"]]);
  });

  it("split labels use the parameter's display formatter", () => {
    const rows = [row({ id: "a", model: "x" }), row({ id: "b", model: "y" })];
    const res = resolve({
      rows,
      settings: [setting("s1", "S")],
      splitBy: ["base_model"],
    });
    expect(res.series.map((s) => s.label)).toEqual(["S · m:x", "S · m:y"]);
  });

  describe("color rule", () => {
    it("no active split → each setting is one series in its own color", () => {
      const rows = [row({ id: "a" })];
      const res = resolve({
        rows,
        settings: [
          setting("s1", "one", {}, { color: "#aa0000" }),
          setting("s2", "two", {}, { color: "#00bb00" }),
        ],
      });
      expect(res.series.map((s) => s.color)).toEqual(["#aa0000", "#00bb00"]);
      expect(res.paletteExceeded).toBe(false);
    });

    it("active split → distinct palette colors in series order; cycling sets paletteExceeded", () => {
      const n = CATEGORY_PALETTE.length + 1; // force one wrap
      const rows = Array.from({ length: n }, (_, i) => row({ id: `r${i}`, seed: String(i) }));
      const res = resolve({
        rows,
        settings: [setting("s1", "all", {}, { color: "#aa0000" })],
        splitBy: ["seed"],
      });
      expect(res.series).toHaveLength(n);
      expect(res.series.map((s) => s.color).slice(0, CATEGORY_PALETTE.length))
        .toEqual(CATEGORY_PALETTE);
      expect(res.series[CATEGORY_PALETTE.length].color).toBe(CATEGORY_PALETTE[0]); // cycled
      expect(res.paletteExceeded).toBe(true);
    });

    it("active split under the palette length cycles nothing", () => {
      const rows = [row({ id: "a", seed: "1" }), row({ id: "b", seed: "2" })];
      const res = resolve({
        rows,
        settings: [setting("s1", "all")],
        splitBy: ["seed"],
      });
      expect(res.series.map((s) => s.color)).toEqual(CATEGORY_PALETTE.slice(0, 2));
      expect(res.paletteExceeded).toBe(false);
    });
  });

  describe("judgePooled", () => {
    const rows = [
      row({ id: "a", model: "qwen", judge: "kw" }),
      row({ id: "b", model: "qwen", judge: "llm" }),
      row({ id: "c", model: "llama", judge: "kw" }),
    ];

    it("lists each setting whose matched rows span > 1 judge", () => {
      const res = resolve({
        rows,
        settings: [
          setting("s1", "mixed", { base_model: ["qwen"] }), // kw + llm
          setting("s2", "single", { base_model: ["llama"] }), // kw only
        ],
      });
      expect(res.judgePooled).toEqual(["mixed"]);
    });

    it("is suppressed when judge is in splitBy", () => {
      const res = resolve({
        rows,
        settings: [setting("s1", "mixed", { base_model: ["qwen"] })],
        splitBy: [JUDGE_KEY],
      });
      expect(res.judgePooled).toEqual([]);
    });
  });

  describe("per-series judge", () => {
    const rows = [
      row({ id: "a", model: "qwen", judge: "kw" }),
      row({ id: "b", model: "qwen", judge: "llm" }),
      row({ id: "c", model: "llama", judge: "kw" }),
    ];

    it("a series spanning one judge carries it; a mixed series carries null", () => {
      const res = resolve({
        rows,
        settings: [
          setting("s1", "mixed", { base_model: ["qwen"] }), // kw + llm
          setting("s2", "single", { base_model: ["llama"] }), // kw only
        ],
      });
      expect(res.series.map((s) => s.judge)).toEqual([null, "kw"]);
    });

    it("splitting by judge gives every series its single judge", () => {
      const res = resolve({
        rows,
        settings: [setting("s1", "all")],
        splitBy: [JUDGE_KEY],
      });
      expect(res.series.map((s) => s.combo)).toEqual([["kw"], ["llm"]]);
      expect(res.series.map((s) => s.judge)).toEqual(["kw", "llm"]);
    });
  });

  it("plot-level ranges intersect EVERY setting on top of its own filters", () => {
    const rows = [
      row({ id: "a", model: "qwen", asr: 0.9 }),
      row({ id: "b", model: "qwen", asr: 0.1 }),
      row({ id: "c", model: "llama", asr: 0.95 }),
    ];
    const res = resolve({
      rows,
      settings: [
        setting("s1", "qwen", { base_model: ["qwen"] }),
        setting("s2", "llama", { base_model: ["llama"] }),
      ],
      ranges: [{ metric: "asr", min: 0.5, max: 1 }],
    });
    expect(res.series[0].rows.map((r) => field(r, "id"))).toEqual(["a"]); // b dropped by the range
    expect(res.series[1].rows.map((r) => field(r, "id"))).toEqual(["c"]);
  });

  it("a setting's own ranges compose (AND) with the plot-level ranges", () => {
    const rows = [
      row({ id: "a", asr: 0.6 }),
      row({ id: "b", asr: 0.9 }),
    ];
    const res = resolve({
      rows,
      settings: [setting("s1", "high", {}, { ranges: [{ metric: "asr", min: 0.8, max: 1 }] })],
      ranges: [{ metric: "asr", min: 0, max: 0.95 }],
    });
    expect(res.series[0].rows.map((r) => field(r, "id"))).toEqual(["b"]);
  });
});

describe("averagedParams", () => {
  const params = [DEFS.base_model, DEFS.seed];

  it("keeps a param varying WITHIN a setting; drops a setting-DEFINING one", () => {
    const rows = [
      row({ id: "a", model: "qwen", seed: "1" }),
      row({ id: "b", model: "qwen", seed: "2" }),
      row({ id: "c", model: "llama", seed: "1" }),
      row({ id: "d", model: "llama", seed: "2" }),
    ];
    const res = resolve({
      rows,
      settings: [
        setting("s1", "qwen", { base_model: ["qwen"] }),
        setting("s2", "llama", { base_model: ["llama"] }),
      ],
    });
    // model differs over the union but is CONSTANT within each setting — a
    // contrast, not a pooled nuisance; seed varies within both settings.
    expect(averagedParams(res, [], params).map((d) => d.key)).toEqual(["seed"]);
  });

  it("excludes an ACTIVE splitBy dim but not an inactive (constant/unknown) one", () => {
    const rows = [row({ id: "a", model: "x" }), row({ id: "b", model: "y" })];
    const settings = [setting("s1", "all")];
    const active = resolve({ rows, settings, splitBy: ["base_model"] });
    expect(averagedParams(active, ["base_model"], params).map((d) => d.key)).toEqual([]);
    const inert = resolve({ rows, settings, splitBy: ["not_a_param"] });
    expect(averagedParams(inert, ["not_a_param"], params).map((d) => d.key)).toEqual(["base_model"]);
  });

  it("a param varying in ANY one setting qualifies even when constant in the others", () => {
    const rows = [
      row({ id: "a", model: "qwen", seed: "1" }),
      row({ id: "b", model: "qwen", seed: "2" }),
      row({ id: "c", model: "llama", seed: "1" }),
    ];
    const res = resolve({
      rows,
      settings: [
        setting("s1", "qwen", { base_model: ["qwen"] }), // seed varies here
        setting("s2", "llama", { base_model: ["llama"] }), // seed constant here
      ],
    });
    expect(averagedParams(res, [], params).map((d) => d.key)).toEqual(["seed"]);
  });
});
