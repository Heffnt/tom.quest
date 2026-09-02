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
      kind: "view",
      schemaVersion: 3,
      state: { v: 3, view: "plot", facets: { baseModel: ["Llama"] } },
    });
    await t.mutation(api.boolbackPresets.save, {
      name: "b2 sweep",
      kind: "view",
      schemaVersion: 3,
      state: { v: 3, view: "table", visibleCols: ["function.arity"] },
    });

    let rows = await t.query(api.boolbackPresets.list, {});
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name)).toEqual(["b2 sweep", "b1 sweep"]); // newest first

    // Upsert: saving the same (kind,name) updates in place, never duplicates.
    await t.mutation(api.boolbackPresets.save, {
      name: "b1 sweep",
      kind: "view",
      schemaVersion: 3,
      state: { v: 3, view: "plot", facets: { baseModel: ["Qwen"] } },
    });
    rows = await t.query(api.boolbackPresets.list, {});
    expect(rows).toHaveLength(2);
    const b1 = rows.find((r) => r.name === "b1 sweep")!;
    expect(b1.state.facets.baseModel).toEqual(["Qwen"]);

    // Remove one.
    await t.mutation(api.boolbackPresets.remove, { id: b1._id });
    rows = await t.query(api.boolbackPresets.list, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("b2 sweep");
  });

  // Regression guard for the removed second kind: "view" is the only kind a
  // preset can have, so the retired literal "filters" must be refused by the
  // argument validator rather than stored.
  it('refuses any kind but "view"', async () => {
    const t = convexTest({ schema, modules });
    await expect(
      t.mutation(api.boolbackPresets.save, {
        name: "legacy",
        // @ts-expect-error — "filters" is no longer a valid kind.
        kind: "filters",
        schemaVersion: 3,
        state: { v: 3, view: "plot" },
      }),
    ).rejects.toThrow();
    expect(await t.query(api.boolbackPresets.list, {})).toHaveLength(0);
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
