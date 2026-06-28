// Loader/invariant tests for the snapshot validator + the real builder fixture.

import { describe, it, expect } from "vitest";
import sample from "./sample-snapshot.json";
import { asBundle } from "./real";

describe("asBundle loader", () => {
  it("accepts the schema_version-pinned sample snapshot", () => {
    const b = asBundle(sample);
    expect(b.schema_version).toBe(1);
    expect(b.rows.length).toBeGreaterThan(0);
    expect(b.metric_schema.length).toBeGreaterThan(0);
    expect(b.column_groups.length).toBeGreaterThan(0);
    expect(b.tree.length).toBeGreaterThan(0);
  });

  it("fails loud on a wrong/absent schema_version", () => {
    expect(() => asBundle({})).toThrow();
    expect(() => asBundle({ schema_version: 999 })).toThrow();
    expect(() => asBundle(null)).toThrow();
  });
});

describe("snapshot invariants", () => {
  it("ships NO stealth anywhere", () => {
    expect(JSON.stringify(sample).includes("stealth")).toBe(false);
  });

  it("DEFENSE group is asr_drop + recovery_rate (no always-null detector columns)", () => {
    const b = asBundle(sample);
    const defense = b.column_groups.find((g) => g.group === "DEFENSE");
    expect(defense?.columns).toEqual(["asr_drop", "recovery_rate"]);
  });

  it("a run surfaces its dataset's scan (dataset-scoped scan wired into the run)", () => {
    const b = asBundle(sample);
    expect(b.rows.some((r) => r.status.has_scan && r.scan !== null)).toBe(true);
  });

  it("no -none base-eval leaks as its own row", () => {
    const b = asBundle(sample);
    expect(b.rows.every((r) => r.training.backend !== "none")).toBe(true);
  });
});
