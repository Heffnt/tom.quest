// A part's measures on tom.quest/design's panel (convex/jarvis/design.ts
// measuresOf): the time of its job's last clean run, and failures with open
// conditions, agent cost and last use over 30 days, each read under the
// panel's byte budget and marked partial when the budget stopped its read.

import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { DAY, NOW, post, registryBody, seed, tom, type T } from "../test/fixtures/design";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

/** One agent run as the record stores it, started a day before NOW. */
async function run(t: T, runId: string, origin: string, costUsd?: number) {
  await t.run((ctx) =>
    ctx.db.insert("runs", {
      runId,
      rootRunId: runId,
      depth: 0,
      linkKnown: true,
      origin,
      host: "box",
      cli: "claude",
      environment: "worker",
      parserVersion: "runs-parser-1",
      kind: "job",
      status: "ended",
      startedAt: NOW - DAY,
      lastLineAt: NOW - DAY,
      attachments: [],
      file: { path: `${runId}.jsonl`, sourceHash: "h", storedHash: "h", bytes: 1, storedBytes: 1, committedLine: 1, committedPrefixSha256: "h" },
      ingestedAt: NOW - DAY,
      outcome: {
        totals: {
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          cacheWriteBreakdownKnown: true,
          outputTokens: 0,
          thinkingTokens: 0,
          totalTokens: 0,
        },
        ...(costUsd === undefined ? {} : { costUsd }),
        turns: 1,
        toolCalls: 0,
      },
    } as never),
  );
}

beforeAll(async () => {
  const t = convexTest({ schema, modules });
  await t.fetch("/jarvis/events");
}, 60_000);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("a part's measures", () => {
  it("measures the last clean run, failures with open conditions, agent cost of its own job's runs and last use", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("events", { kind: "job-failed", at: NOW - 3 * DAY, provenance: { job: "ran" }, subject: "ran:auth", data: {} });
      await ctx.db.insert("events", { kind: "job-failed", at: NOW - 4 * DAY, provenance: { job: "ran" }, subject: "ran:disk", data: {} });
      await ctx.db.insert("events", { kind: "job-recovered", at: NOW - 3 * DAY, provenance: { job: "ran" }, subject: "ran:disk", data: {} });
    });
    await run(t, "r1", "cron:ran", 0.5);
    await run(t, "r2", "cron:ran", 0.25);
    await run(t, "r3", "cron:ran");
    await run(t, "r4", "cron:other", 9);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const part = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(part?.measures).toEqual({
      windowDays: 30,
      lastUse: null,
      lastCleanRun: NOW - DAY,
      failures: { count: 2, partial: false, open: [{ subject: "ran:auth", at: NOW - 3 * DAY }] },
      cost: { usd: 0.75, runs: 2, unpriced: 1, partial: false },
    });
    // A part with no schedule has only its last use.
    expect((await viewer.query(api.jarvis.design.part, { id: "idle" }))?.measures).toEqual({ windowDays: 30, lastUse: null });
  });

  it("shows the time of the last of three clean runs, not a count, since the record keeps one job-ok row per job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    for (const daysAgo of [3, 2, 1]) {
      vi.setSystemTime(NOW - daysAgo * DAY);
      expect((await post(t, "/jarvis/event", { kind: "job-ok", provenance: { job: "ran" }, subject: "ran:run" })).status).toBe(200);
    }
    vi.setSystemTime(NOW);
    // Ingestion keeps the newest job-ok row of the job and deletes the others.
    const kept = await t.run((ctx) => ctx.db.query("events").withIndex("by_kind_job_at", (q) => q.eq("kind", "job-ok").eq("provenance.job", "ran")).collect());
    expect(kept.map((r) => r.at)).toEqual([NOW - DAY]);
    const measures = (await viewer.query(api.jarvis.design.part, { id: "ran" }))?.measures;
    expect(measures).toMatchObject({ lastCleanRun: NOW - DAY });
    expect(measures).not.toHaveProperty("runs");
  });

  it("shows a clean run older than the 30 days, since it is measured outside them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    await t.run((ctx) => ctx.db.insert("events", { kind: "job-ok", at: NOW - 40 * DAY, provenance: { job: "ran" }, subject: "ran:run", data: {} }));
    expect((await viewer.query(api.jarvis.design.part, { id: "ran" }))?.measures).toMatchObject({ lastCleanRun: NOW - 40 * DAY });
  });

  it("marks failures partial, and names the cut, when its rows fill their byte allotment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    // 21 conditions of small rows are each looked up for a recovery: no cut.
    await t.run(async (ctx) => {
      for (let i = 0; i < 21; i++) await ctx.db.insert("events", { kind: "job-failed", at: NOW - DAY, provenance: { job: "ran" }, subject: `ran:c${i}`, data: {} });
    });
    const small = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(small?.measures).toMatchObject({ failures: { count: 21, partial: false } });
    // Rows past the 2 MiB allotment: the read stops there.
    for (let i = 0; i < 3; i++) {
      await t.run((ctx) => ctx.db.insert("events", { kind: "job-failed", at: NOW - 2 * DAY - i, provenance: { job: "ran" }, subject: `ran:big${i}`, data: { error: "x".repeat(900_000) } }));
    }
    const big = await viewer.query(api.jarvis.design.part, { id: "ran" });
    expect(big?.measures).toMatchObject({ failures: { partial: true } });
    expect(big?.cuts.map((cut) => cut.what)).toContain("failed-run rows");
  });

  it("counts last use inside the 30-day window only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest({ schema, modules });
    vi.stubEnv("JARVIS_KEY", "k");
    const viewer = await tom(t);
    await post(t, "/jarvis/event", registryBody("bbbbbbb2"));
    const use = (at: number, what: string) =>
      t.run((ctx) => ctx.db.insert("events", { kind: "use", at, provenance: { user: "tom" }, subject: "idle", data: { part: "idle", by: "tom", what } }));
    await use(NOW - 31 * DAY, "used before the window");
    expect((await viewer.query(api.jarvis.design.part, { id: "idle" }))?.measures.lastUse).toBeNull();
    await use(NOW - 2 * DAY, "used inside it");
    expect((await viewer.query(api.jarvis.design.part, { id: "idle" }))?.measures.lastUse).toEqual({ at: NOW - 2 * DAY, what: "used inside it", by: "tom" });
  });
});
