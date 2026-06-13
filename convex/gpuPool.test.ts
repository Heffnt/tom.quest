import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const BASE = "http://turing.test";

type FetchCall = { url: string; method: string };

// Route fetch by url+method. jobs: GET /jobs payload; allocate: job_ids to
// return; calls: records every request so we can assert scale-up/down behavior.
function stubFetch(opts: {
  jobs: unknown;
  jobsStatus?: number;
  allocateJobIds?: string[];
}) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/jobs") && method === "GET") {
      const status = opts.jobsStatus ?? 200;
      return { ok: status < 400, status, json: async () => opts.jobs };
    }
    if (url.endsWith("/allocate") && method === "POST") {
      return { ok: true, status: 200, json: async () => ({ job_ids: opts.allocateJobIds ?? [] }) };
    }
    if (url.includes("/jobs/") && method === "DELETE") {
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("TURING_API_URL", BASE);
  vi.stubEnv("TURING_API_KEY", "test-key");
  return calls;
}

const poolConfig = {
  gpuType: "nvidia",
  timeMins: 30,
  memoryMb: 64000,
  commands: ["python train.py"],
  projectDir: "/home/x",
  jobName: "pool",
  enabled: true,
};

describe("gpuPool.reconcile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("scales up to the desired count via /allocate with release_on_exit", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 2, updatedAt: 1 });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["100", "101"] });

    await t.action(internal.gpuPool.reconcile, {});

    const allocations = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(allocations.map((a) => a.jobId).sort()).toEqual(["100", "101"]);
    const allocate = calls.filter((c) => c.url.endsWith("/allocate"));
    expect(allocate).toHaveLength(1);
  });

  it("scales down by cancelling the lowest-utilization job first", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "100", createdAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "101", createdAt: 2 });
    });
    const calls = stubFetch({
      jobs: [
        { job_id: "100", gpu_type: "nvidia", gpu_stats: { utilization_pct: 90 } },
        { job_id: "101", gpu_type: "nvidia", gpu_stats: { utilization_pct: 5 } },
      ],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(remaining.map((a) => a.jobId)).toEqual(["100"]);
    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("/jobs/101");
  });

  it("prunes records for jobs that have ended and holds steady when satisfied", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "100", createdAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "ended", createdAt: 1 });
    });
    const calls = stubFetch({
      jobs: [{ job_id: "100", gpu_type: "nvidia", gpu_stats: { utilization_pct: 50 } }],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(remaining.map((a) => a.jobId)).toEqual(["100"]);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("skips the cycle without touching state when the API is unreachable", async () => {
    const t = convexTest({ schema, modules });
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 2, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "100", createdAt: 1 });
    });
    const calls = stubFetch({ jobs: [], jobsStatus: 503 });

    await t.action(internal.gpuPool.reconcile, {});

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(remaining.map((a) => a.jobId)).toEqual(["100"]);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
  });
});
