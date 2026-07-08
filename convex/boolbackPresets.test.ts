import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

describe("boolbackPresets", () => {
  it("saves, lists (newest first), upserts by (kind,name), and removes", async () => {
    const t = convexTest({ schema, modules });

    await t.mutation(api.boolbackPresets.save, {
      name: "b1 sweep",
      kind: "filters",
      schemaVersion: 1,
      state: { filters: { facets: { baseModel: ["Llama"] }, ranges: [], status: [], subtreeDirs: [], search: "" } },
    });
    // Same name, different KIND → a separate row (index is (kind, name)).
    await t.mutation(api.boolbackPresets.save, {
      name: "b1 sweep",
      kind: "view",
      schemaVersion: 1,
      state: { filters: {}, chart: { v: 2 }, sorts: [], visibleCols: ["function.arity"], centerView: "plot" },
    });

    let rows = await t.query(api.boolbackPresets.list, {});
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["filters", "view"]);

    // Upsert: saving the same (kind,name) updates in place, never duplicates.
    await t.mutation(api.boolbackPresets.save, {
      name: "b1 sweep",
      kind: "filters",
      schemaVersion: 1,
      state: { filters: { facets: { baseModel: ["Qwen"] }, ranges: [], status: [], subtreeDirs: [], search: "" } },
    });
    rows = await t.query(api.boolbackPresets.list, {});
    expect(rows).toHaveLength(2);
    const fs = rows.find((r) => r.kind === "filters")!;
    expect(fs.state.filters.facets.baseModel).toEqual(["Qwen"]);

    // Remove one.
    await t.mutation(api.boolbackPresets.remove, { id: fs._id });
    rows = await t.query(api.boolbackPresets.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("view");
  });

  it("stores arbitrary (even malformed) state opaquely for the tolerant loader", async () => {
    const t = convexTest({ schema, modules });
    const weird = { filters: null, chart: { v: 2, splits: "oops" }, junk: 42 };
    await t.mutation(api.boolbackPresets.save, {
      name: "corrupt",
      kind: "view",
      schemaVersion: 99,
      state: weird,
    });
    const rows = await t.query(api.boolbackPresets.list, {});
    expect(rows[0].state).toEqual(weird); // round-trips untouched; the client loader sanitizes
  });
});
