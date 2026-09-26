import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import {
  EVAL_RUN,
  EVALS_RUN,
  answeredEvalsRun,
  evalsRequestFor,
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
      await ctx.db.insert("dtsEvents", { at: data.at, kind: EVAL_RUN, key: data.set, data });
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
  it("answers the runner's lastRun: the newest row of one set as { id, at, data }", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, [run("wall", 1, 1, 10), run("role/read", 3, 0, 20), run("wall", 2, 0, 30)]);
    const rows = await t.query(internal.ttsEvals.internalSearchEvals, { set: "wall", limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ at: 30, data: { set: "wall", passed: 2 } });
    expect(typeof rows[0].id).toBe("string");
    expect(await t.query(internal.ttsEvals.internalSearchEvals, { set: "task" })).toEqual([]);
  });

  it("without a set, lists every set's runs newest first; since and failing narrow it", async () => {
    const t = convexTest({ schema, modules });
    await seed(t, [run("wall", 1, 1, 10), run("role/read", 3, 0, 20), run("wall", 2, 0, 30)]);
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: 40, kind: EVALS_RUN, key: "tom.quest@old", data: { repo: "tom.quest" } });
    });
    const all = await t.query(internal.ttsEvals.internalSearchEvals, {});
    expect(all.map((row) => row.at)).toEqual([30, 20, 10]);
    const since = await t.query(internal.ttsEvals.internalSearchEvals, { since: 20 });
    expect(since.map((row) => row.at)).toEqual([30, 20]);
    const failing = await t.query(internal.ttsEvals.internalSearchEvals, { failing: true });
    expect(failing.map((row) => row.at)).toEqual([10]);
  });
});

describe("the historic evals-run rows", () => {
  it("answers the newest row of a commit and never a standing request", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("dtsEvents", { at: 1, kind: EVALS_RUN, key: "tom.quest@aaaaaaa", data: { regressions: 1 } });
      await ctx.db.insert("dtsEvents", { at: 2, kind: EVALS_RUN, key: "tom.quest@aaaaaaa", data: { regressions: 0 } });
    });
    const answered = await t.run((ctx) => answeredEvalsRun(ctx, "tom.quest", "aaaaaaa"));
    expect(answered?.data).toEqual({ regressions: 0 });
    expect(await t.run((ctx) => answeredEvalsRun(ctx, "tom.quest", "bbbbbbb"))).toBe(null);
    expect(await t.run((ctx) => evalsRequestFor(ctx, "tom.quest", "aaaaaaa"))).toBe(null);
  });
});
