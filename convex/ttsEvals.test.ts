import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import {
  EVAL_RUN,
  EVALS_RUN,
  latestEvalRunFor,
  passRateOf,
  type EvalRunData,
} from "./ttsEvals";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** One set's run in the runner's runData() shape. */
function run(set: string, passed: number, failed: number, at: number): EvalRunData {
  return {
    set,
    passed,
    failed,
    skipped: 1,
    total: passed + failed,
    items: [
      ...Array.from({ length: passed }, (_, i) => ({ name: `p${i}`, pass: true, note: "" })),
      ...Array.from({ length: failed }, (_, i) => ({ name: `f${i}`, pass: false, note: "wrong" })),
      { name: "skipped", pass: null, note: "needs model" },
    ],
    model: "claude-opus",
    role: set.startsWith("role/") ? set.split("/")[1] : null,
    candidate: null,
    commit: { Jarvis: "abc1234", WikiTom: null },
    inputs: { rules: "r1", registry: "g1" },
    at,
  };
}

async function seed(t: ReturnType<typeof convexTest>, rows: EvalRunData[]) {
  await t.run(async (ctx) => {
    for (const data of rows) {
      await ctx.db.insert("events", {
        at: data.at,
        kind: EVAL_RUN,
        provenance: { job: "evals" },
        subject: data.set,
        data,
        text: `${data.set}: ${data.passed} of ${data.total} pass`,
      });
    }
  });
}

describe("passRateOf", () => {
  it("is passed over scored items, and null when nothing was scored", () => {
    expect(passRateOf(run("wall", 3, 1, 1))).toBe(0.75);
    expect(passRateOf(run("wall", 0, 0, 1))).toBe(null);
    expect(passRateOf(null)).toBe(null);
    expect(passRateOf(undefined)).toBe(null);
  });
});

describe("latestEvalRunFor", () => {
  it("reads the newest eval-run of one set and no other set's", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, [run("wall", 1, 1, 10), run("wall", 2, 0, 30), run("role/classify", 5, 0, 40)]);
    const latest = await t.run((ctx) => latestEvalRunFor(ctx, "wall"));
    expect(latest?.data).toMatchObject({ set: "wall", passed: 2, at: 30 });
    expect(passRateOf(latest?.data as EvalRunData)).toBe(1);
    expect(await t.run((ctx) => latestEvalRunFor(ctx, "rule"))).toBe(null);
  });
});

describe("internalSearchEvals", () => {
  it("lists every set's eval-run rows newest first, cited by id, up to the limit, and nothing else", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, [run("wall", 1, 1, 10), run("role/read", 3, 0, 20), run("wall", 2, 0, 30)]);
    await t.run(async (ctx) => {
      // A historic evals-run row in the old table is not an eval-run.
      await ctx.db.insert("dtsEvents", { at: 40, kind: EVALS_RUN, key: "tom.quest@old", data: { repo: "tom.quest" } });
      // Nor is another kind in the one record under a set's name.
      await ctx.db.insert("events", { at: 50, kind: "job-ok", provenance: {}, subject: "wall", data: {} });
    });
    const all = await t.query(internal.ttsEvals.internalSearchEvals, {});
    expect(all.map((row) => row.at)).toEqual([30, 20, 10]);
    expect(all[0]).toMatchObject({ kind: EVAL_RUN, subject: "wall", data: { set: "wall", passed: 2 } });
    expect(all[0].id).toBe(all[0]._id);
    expect((await t.query(internal.ttsEvals.internalSearchEvals, { limit: 1 })).map((row) => row.at)).toEqual([30]);
  });
});
