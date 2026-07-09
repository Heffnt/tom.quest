// Column-bridge tests: the bare column_groups names must resolve to dotted ids
// that select.cellValue can actually read on the REAL builder fixture, and every
// numeric column must name a metric_schema entry (so bars/ranges have bounds).
// This is the end-to-end guard against the bare-vs-dotted addressing hazard that
// tsc cannot catch.

import { describe, it, expect } from "vitest";
import sample from "../data/sample-snapshot.json";
import { asBundle } from "../data/normalize";
import { allColumnDefs, resolveColumn } from "./columns";
import { indexMetricSchema } from "./metrics";
import { cellValue } from "./select";
import type { RunRow } from "./types";

const bundle = asBundle(sample);
const index = indexMetricSchema(bundle.metric_schema);
const rows: RunRow[] = bundle.rows;

function rowWith(pred: (r: RunRow) => boolean): RunRow {
  const r = rows.find(pred);
  if (!r) throw new Error("fixture lacks a row matching the predicate");
  return r;
}

describe("columns bridge", () => {
  it("every column_groups entry resolves to a usable id; numerics name a schema metric", () => {
    for (const grp of allColumnDefs(bundle, index)) {
      for (const def of grp.columns) {
        expect(def.id.length).toBeGreaterThan(0);
        if (def.kind === "numeric" || def.kind === "outcome") {
          expect(def.metricName).toBeTruthy();
          expect(index[def.metricName as string]).toBeTruthy();
        }
      }
    }
  });

  it("OUTCOME plantedness reads headline.plantedness via the resolved id", () => {
    const def = resolveColumn("OUTCOME", "plantedness", index);
    expect(def.id).toBe("headline.plantedness");
    expect(cellValue(rows[0], def.id)).toBe(rows[0].headline.plantedness);
  });

  it("DEFENSE asr_drop reads defense.asr_drop on a defended run", () => {
    const r = rowWith((x) => x.status.has_defense && x.defense !== null);
    const def = resolveColumn("DEFENSE", "asr_drop", index);
    expect(def.id).toBe("defense.asr_drop");
    expect(cellValue(r, def.id)).toBe(r.defense!.asr_drop);
  });

  it("per-method DEFENSE names resolve to themselves and read the method value", () => {
    const r = rowWith((x) => (x.defense?.methods?.length ?? 0) > 0);
    const m = r.defense!.methods.find((x) => typeof x.asr_drop === "number")!;
    const name = `asr_drop@${m.method}`;
    expect(index[name]).toBeTruthy(); // synthesized into metric_schema
    const def = resolveColumn("DEFENSE", name, index);
    expect(def.id).toBe(name);
    expect(def.kind).toBe("numeric");
    expect(def.metricName).toBe(name);
    expect(def.label).toBe(index[name].label);
    expect(cellValue(r, def.id)).toBe(m.asr_drop);
  });

  it("derived anatomy INTERP names resolve to themselves and read the derived value", () => {
    const name = "interp_peak_layer@linear_probe";
    expect(index[name]).toBeTruthy(); // synthesized into metric_schema at normalize
    const def = resolveColumn("INTERP", name, index);
    expect(def.id).toBe(name);
    expect(def.kind).toBe("numeric");
    expect(def.metricName).toBe(name);
    expect(def.label).toBe(index[name].label);
    // the planted run's linear_probe sweep peaks at L16
    const r = rowWith(
      (x) => x.interp?.readings?.some((m) => m.kind === "sae_feature") ?? false,
    );
    expect(cellValue(r, def.id)).toBe(16);
  });

  it("SCAN scan_auroc reads scan.auroc on a scanned run", () => {
    const r = rowWith((x) => x.status.has_scan && x.scan !== null);
    const def = resolveColumn("SCAN", "scan_auroc", index);
    expect(def.id).toBe("scan.auroc");
    expect(cellValue(r, def.id)).toBe(r.scan!.auroc);
  });

  it("INTERP interp_reading reads interp.value on an interp run", () => {
    const r = rowWith((x) => x.status.has_interp && x.interp !== null);
    const def = resolveColumn("INTERP", "interp_reading", index);
    expect(def.id).toBe("interp.value");
    expect(cellValue(r, def.id)).toBe(r.interp!.value);
  });

  it("FUNCTION complexity columns resolve to bare ids backed by function.complexity", () => {
    const fnGroup = bundle.column_groups.find((g) => g.group === "FUNCTION")!;
    const complexityCol = fnGroup.columns.find(
      (c) => c !== "arity" && c !== "fn_hex" && c !== "truth_table" && c !== "dnf_string",
    )!;
    const def = resolveColumn("FUNCTION", complexityCol, index);
    expect(def.id).toBe(complexityCol);
    expect(cellValue(rows[0], def.id)).toBe(rows[0].function.complexity[complexityCol] ?? null);
  });
});
