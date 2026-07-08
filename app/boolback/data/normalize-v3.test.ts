// v3 ingestion tests (Phase 1.5). A hand-crafted minimal v3 blob exercises the
// v3-only surface the config panel depends on: OUTCOME metrics split into the
// attack/capability suites, headline.planted_fraction as a resolvable metric,
// per-cut detector metrics (scan_auroc@<method>|<scheme>|<negative_facet>, with
// "-" filling an absent scheme/facet), and per-method defense residuals
// (residual_asr@<method>). It also guards that normalize's v3 branch is a
// pass-through: readings vocab is NOT re-translated and the new fields survive.

import { describe, it, expect } from "vitest";
import v3 from "./sample-snapshot-v3.json";
import { asBundle } from "./normalize";
import { cellValue, numericValue } from "../lib/select";
import { groupedMetricOptions, metricPickerGroup, Y_GROUP_ORDER } from "../lib/metrics";
import type { RunRow } from "../lib/types";

const bundle = asBundle(structuredClone(v3));
const byName = (name: string) => bundle.metric_schema.find((e) => e.name === name)!;
const row1: RunRow = bundle.rows[0];
const row2: RunRow = bundle.rows[1];

describe("v3 ingestion — suites", () => {
  it("OUTCOME metrics carry attack / capability suites", () => {
    expect(byName("plantedness").suite).toBe("attack");
    expect(byName("planted_fraction").suite).toBe("attack");
    expect(byName("asr").suite).toBe("attack");
    expect(byName("ppl").suite).toBe("capability");
  });

  it("DEFENSE / INTERP / SCAN entries keep the outcome suite", () => {
    expect(byName("residual_asr@beear").suite).toBe("outcome");
    expect(byName("interp_reading").suite).toBe("outcome");
    expect(byName("scan_auroc@mahalanobis|prompt|benign").suite).toBe("outcome");
  });
});

describe("v3 ingestion — planted_fraction resolves as a metric", () => {
  it("resolves via the dotted id and the bare schema name", () => {
    expect(cellValue(row1, "headline.planted_fraction")).toBe(1);
    // bare metric name routes through METRIC_COLUMN_IDS → headline.planted_fraction
    expect(cellValue(row1, "planted_fraction")).toBe(1);
    expect(numericValue(row2, "planted_fraction")).toBe(0);
  });
});

describe("v3 ingestion — detector-cut metrics", () => {
  it("resolves scan_auroc@<method>|<scheme>|<negative_facet> to the matching cut", () => {
    expect(cellValue(row1, "scan_auroc@mahalanobis|prompt|benign")).toBe(0.85);
    expect(cellValue(row1, "scan_far_at_frr@mahalanobis|prompt|benign")).toBe(0.3);
  });

  it('matches a cut whose absent scheme/facet is filled with "-"', () => {
    expect(cellValue(row2, "scan_auroc@isoforest|-|-")).toBe(0.7);
  });

  it("returns null when no scan slot matches the cut", () => {
    expect(cellValue(row1, "scan_auroc@mahalanobis|prompt|adversarial")).toBeNull();
    expect(cellValue(row2, "scan_auroc@mahalanobis|prompt|benign")).toBeNull();
  });
});

describe("v3 ingestion — defense residuals", () => {
  it("resolves residual_asr@<method> / residual_ftr@<method> to the method slot", () => {
    expect(cellValue(row1, "residual_asr@beear")).toBe(0.2);
    expect(cellValue(row1, "residual_ftr@beear")).toBe(0.03);
    // the *_drop family still resolves on the same method slot
    expect(cellValue(row1, "asr_drop@beear")).toBe(0.7);
  });

  it("returns null for a residual on an undefended run", () => {
    expect(cellValue(row2, "residual_asr@beear")).toBeNull();
  });
});

describe("v3 ingestion — attack/capability grouping", () => {
  it("splits OUTCOME entries into ATTACK and CAPABILITY picker headings", () => {
    expect(metricPickerGroup(byName("plantedness"))).toBe("ATTACK");
    expect(metricPickerGroup(byName("ppl"))).toBe("CAPABILITY");
    expect(metricPickerGroup(byName("residual_asr@beear"))).toBe("DEFENSE");

    const { groups } = groupedMetricOptions(bundle.metric_schema, Y_GROUP_ORDER);
    const map = new Map(groups.map(([g, es]) => [g, es.map((e) => e.name)]));
    expect(map.get("ATTACK")).toEqual(
      expect.arrayContaining(["plantedness", "planted_fraction", "asr"]),
    );
    expect(map.get("CAPABILITY")).toEqual(["ppl"]);
    // ATTACK leads CAPABILITY in Y order
    const names = groups.map(([g]) => g);
    expect(names.indexOf("ATTACK")).toBeLessThan(names.indexOf("CAPABILITY"));
  });
});

describe("v3 ingestion — normalize is a pass-through (no re-translation)", () => {
  it("keeps the reading vocab untouched and preserves the new fields", () => {
    const interp = row1.interp!;
    expect(interp.reading_kind).toBe("linear_probe");
    expect(interp.readings).toEqual([
      { kind: "linear_probe", type: "interp", value: 0.6, null_control: 0.1 },
    ]);
    // no measurement-vocab key leaked back in
    expect((interp as unknown as Record<string, unknown>).measurements).toBeUndefined();
    // method type tags + residuals survived
    const m = row1.defense!.methods[0];
    expect(m.type).toBe("defense");
    expect(m.residual_asr).toBe(0.2);
    // detector-cut fields survived on the scan method slot
    const s = row1.scan!.methods![0];
    expect(s.scheme).toBe("prompt");
    expect(s.negative_facet).toBe("benign");
    expect(s.cut).toBe("mahalanobis|prompt|benign");
    expect(s.type).toBe("scan");
  });

  it("does not synthesize per-method entries (v3 ships @-names directly)", () => {
    // withPerMethodMetrics bails when any @-name exists, so the generic
    // interp_reading label is NOT re-qualified with "(headline)" by synthesis.
    const generic = byName("interp_reading");
    expect(generic.label).toBe("Interp reading (headline)"); // exactly as shipped
    // and the residual entries are exactly the ones the blob shipped
    expect(bundle.metric_schema.filter((e) => e.name.startsWith("residual_")).length).toBe(2);
  });
});
