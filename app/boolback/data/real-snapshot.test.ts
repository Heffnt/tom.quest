// Contract witness over a REAL builder artifact (2026-08-04 integration repair).
//
// sample-snapshot-real.json is emitted VERBATIM by the CMT builder
// (`python -m tom_quest.tests._make_sample_snapshot`, BOOLBACK_SAMPLE_OUT →
// this file) over a real mini artifact tree — unlike sample-snapshot.json
// (demo-enriched) and sample-snapshot-v3.json (hand-crafted unit fixture),
// nothing here is hand-written. Its job is to make CMT↔site schema drift fail
// a test instead of silently hollowing the UI: the 2026-08 incident was four
// dead display surfaces (null contract on 6,617 methods, twins 0/1,049,
// epoch0_baseline 0/1,049, metadata-less confguard) that every fixture-bound
// test slept through. Regenerate the fixture whenever the builder changes.

import { describe, it, expect } from "vitest";
import real from "./sample-snapshot-real.json";
import { asBundle } from "./normalize";

const bundle = asBundle(structuredClone(real));

describe("real builder artifact — the CMT↔site contract", () => {
  it("normalizes as schema v3", () => {
    expect(bundle.schema_version).toBe(3);
    expect(bundle.rows.length).toBeGreaterThan(0);
  });

  it("carries NO retired metrics (ppl family deleted with perplexity)", () => {
    expect(bundle.metric_schema.some((e) => /^ppl(_drift)?$/.test(e.name))).toBe(false);
    for (const g of bundle.column_groups) {
      expect(g.columns).not.toContain("ppl");
      expect(g.columns).not.toContain("ppl_drift");
    }
    for (const r of bundle.rows) {
      expect("ppl" in r.headline).toBe(false);
      expect("ppl" in r.trajectories).toBe(false);
    }
  });

  it("ships no phantom DATASET scheme column", () => {
    const ds = bundle.column_groups.find((g) => g.group === "DATASET")!;
    expect(ds.columns).not.toContain("scheme");
  });

  it("trajectories carry exactly the live epoch metrics", () => {
    for (const r of bundle.rows) {
      expect(Object.keys(r.trajectories).sort()).toEqual([
        "asr", "completed_epochs", "ftr", "plantedness",
      ]);
    }
  });

  it("epoch0_baseline folds in (never hollow on runs with a -none base eval)", () => {
    const withBase = bundle.rows.filter((r) => r.epoch0_baseline !== null);
    expect(withBase.length).toBeGreaterThan(0);
    for (const r of withBase) {
      expect(r.epoch0_baseline!.asr).not.toBeNull();
      expect(r.epoch0_baseline!.per_tt_row.length).toBeGreaterThan(0);
    }
    // The -none baseline is folded, never its own run row.
    expect(bundle.rows.some((r) => r.training.backend === "none")).toBe(false);
  });

  it("twins populate on twin-paired runs", () => {
    const twinned = bundle.rows.filter((r) => r.status.has_twin);
    expect(twinned.length).toBeGreaterThan(0);
    for (const r of twinned) {
      expect(r.twins).not.toBeNull();
    }
  });

  it("defense methods carry live registry metadata (§4.2 vocabulary, no metadata-less method)", () => {
    const defended = bundle.rows.filter((r) => r.status.has_defense);
    expect(defended.length).toBeGreaterThan(0);
    for (const r of defended) {
      for (const m of r.defense!.methods) {
        const slot = m as unknown as Record<string, unknown>;
        // Live methods ship emits/category; relics ship their historical
        // contract + a legacy note. NEVER neither.
        const live = slot.emits !== undefined && slot.category !== undefined;
        const relic = slot.contract !== undefined && slot.legacy !== undefined;
        expect(live || relic).toBe(true);
      }
    }
  });
});
