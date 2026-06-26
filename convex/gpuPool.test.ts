import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"]);

const BASE = "http://turing.test";

type FetchCall = { url: string; method: string; body: unknown };

// Same FNV-1a fingerprint the reconciler uses, so tests can build the reserved
// job name for a config and assert against it.
function fingerprint(config: {
  commands: string[];
  timeMins: number;
  memoryMb: number;
  projectDir: string;
  releaseOnExit: boolean;
}): string {
  const input = JSON.stringify([
    config.commands,
    config.timeMins,
    config.memoryMb,
    config.projectDir,
    config.releaseOnExit,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function poolName(gpuType: string, fp: string): string {
  return "gpupool:" + gpuType + ":" + fp;
}

// Build a job fixture; callers must supply job_name. start_time and gpu_stats
// default to harmless values.
function job(opts: {
  job_id: string;
  gpu_type: string;
  job_name: string;
  utilization_pct?: number | null;
  start_time?: string;
}) {
  return {
    job_id: opts.job_id,
    gpu_type: opts.gpu_type,
    job_name: opts.job_name,
    gpu_stats: { utilization_pct: opts.utilization_pct ?? 0 },
    start_time: opts.start_time ?? "2026-01-01T00:00:00",
  };
}

// Route fetch by url+method, capturing the request body so tests can assert the
// /allocate payload. allocate returns ids shifted from allocateJobIds (distinct
// per call); allocateStatus optionally forces a non-200 allocate.
function stubFetch(opts: {
  jobs: unknown;
  jobsStatus?: number;
  allocateJobIds?: string[];
  allocateStatus?: number;
  allocateThrows?: boolean;
}) {
  const calls: FetchCall[] = [];
  const allocateIds = [...(opts.allocateJobIds ?? [])];
  const fetchMock = vi.fn(
    async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, method, body });
      if (url.endsWith("/jobs") && method === "GET") {
        const status = opts.jobsStatus ?? 200;
        return { ok: status < 400, status, json: async () => opts.jobs };
      }
      if (url.endsWith("/allocate") && method === "POST") {
        if (opts.allocateThrows) throw new Error("allocate network error");
        const status = opts.allocateStatus ?? 200;
        const jobId = allocateIds.shift();
        return {
          ok: status < 400,
          status,
          json: async () => ({ job_ids: jobId ? [jobId] : [] }),
        };
      }
      if (url.includes("/jobs/") && method === "DELETE") {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    },
  );
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
  releaseOnExit: true,
  enabled: true,
};

const FP = fingerprint(poolConfig);
const CURRENT_NAME = poolName(poolConfig.gpuType, FP);

describe("gpuPool.reconcile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("allocates exactly one GPU per cycle with the reserved name and release_on_exit", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 2, updatedAt: 1 });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["100", "101"] });

    await t.action(internal.gpuPool.reconcile, {});

    const allocate = calls.filter((c) => c.url.endsWith("/allocate"));
    expect(allocate).toHaveLength(1);
    const body = allocate[0].body as {
      count: number;
      job_name: string;
      release_on_exit: boolean;
    };
    expect(body.count).toBe(1);
    expect(body.job_name).toBe(CURRENT_NAME);
    expect(body.release_on_exit).toBe(poolConfig.releaseOnExit);

    const allocations = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(allocations.map((a) => a.jobId)).toEqual(["100"]);
    expect(allocations[0].fingerprint).toBe(FP);
  });

  it("suppresses a double-allocate via the in-flight cache across two cycles", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["100", "101"] });

    await t.action(internal.gpuPool.reconcile, {});
    await t.action(internal.gpuPool.reconcile, {});

    const allocate = calls.filter((c) => c.url.endsWith("/allocate"));
    expect(allocate).toHaveLength(1);
  });

  it("never deletes a job whose name is not reserved (name-as-truth)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 0, enabled: false, updatedAt: 1 });
    });
    const calls = stubFetch({
      jobs: [job({ job_id: "manual", gpu_type: "nvidia", job_name: "my-manual-job" })],
    });

    await t.action(internal.gpuPool.reconcile, {});

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("adopts an existing current-fingerprint job instead of allocating", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
    });
    const calls = stubFetch({
      jobs: [job({ job_id: "200", gpu_type: "nvidia", job_name: CURRENT_NAME })],
    });

    await t.action(internal.gpuPool.reconcile, {});

    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
    const allocations = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(allocations.map((a) => a.jobId)).toEqual(["200"]);
    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].adopted).toBe(1);
  });

  it("drains a stale-fingerprint job and allocates the current one", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
    });
    const oldName = poolName("nvidia", "deadbeef");
    const calls = stubFetch({
      jobs: [job({ job_id: "300", gpu_type: "nvidia", job_name: oldName })],
      allocateJobIds: ["301"],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("/jobs/300");
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(true);
    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].staleCancelled).toBe(1);
  });

  it("scales down by cancelling the lowest-utilization current job first", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "A", fingerprint: FP, seenLive: true, createdAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "B", fingerprint: FP, seenLive: true, createdAt: 2 });
    });
    const calls = stubFetch({
      jobs: [
        job({ job_id: "A", gpu_type: "nvidia", job_name: CURRENT_NAME, utilization_pct: 90 }),
        job({ job_id: "B", gpu_type: "nvidia", job_name: CURRENT_NAME, utilization_pct: 5 }),
      ],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("/jobs/B");
    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].cancelled).toBe(1);
  });

  it("tears down all current jobs when the pool is disabled", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 2, enabled: false, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "A", fingerprint: FP, seenLive: true, createdAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "B", fingerprint: FP, seenLive: true, createdAt: 2 });
    });
    const calls = stubFetch({
      jobs: [
        job({ job_id: "A", gpu_type: "nvidia", job_name: CURRENT_NAME }),
        job({ job_id: "B", gpu_type: "nvidia", job_name: CURRENT_NAME }),
      ],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(2);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
  });

  it("cancels orphan reconciler jobs whose gpuType has no config", async () => {
    const t = convexTest(schema, modules);
    // No config for "ghost".
    const ghostName = poolName("ghost", "abcd1234");
    const calls = stubFetch({
      jobs: [job({ job_id: "999", gpu_type: "ghost", job_name: ghostName })],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("/jobs/999");
    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.orphansCancelled).toBe(1);
  });

  it("prunes an allocation row whose gpuType has no config and whose job is gone", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      // Leftover row for a removed config; its job already left the cluster.
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "ghost", jobId: "g1", fingerprint: "x", seenLive: true, createdAt: 1 });
    });
    stubFetch({ jobs: [] });

    await t.action(internal.gpuPool.reconcile, {});

    const rows = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("does not prune a configured pool's in-flight row during the orphan sweep", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      // Recently allocated, not yet live: must survive and suppress re-allocate.
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "inf1", fingerprint: FP, seenLive: false, createdAt: Date.now() });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["new"] });

    await t.action(internal.gpuPool.reconcile, {});

    const rows = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(rows.map((r) => r.jobId)).toEqual(["inf1"]);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
  });

  it("skips the cycle without touching state when the API is unreachable", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 2, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "100", fingerprint: FP, seenLive: false, createdAt: 1 });
      await ctx.db.insert("gpuPoolStatus", {
        ranAt: 1,
        jobsFetchOk: true,
        orphansCancelled: 0,
        pools: [
          {
            gpuType: "nvidia",
            desired: 2,
            actual: 1,
            inflight: 0,
            allocated: 0,
            cancelled: 0,
            staleCancelled: 0,
            adopted: 0,
            errored: false,
            churnStreak: 3,
            fingerprint: FP,
          },
        ],
      });
    });
    const calls = stubFetch({ jobs: [], jobsStatus: 503 });

    await t.action(internal.gpuPool.reconcile, {});

    const remaining = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(remaining.map((a) => a.jobId)).toEqual(["100"]);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.jobsFetchOk).toBe(false);
    expect(st?.reason).toBeTruthy();
    expect(st?.pools[0].churnStreak).toBe(3);
  });

  it("persists status with jobsFetchOk and a correct pools entry after a normal run", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
    });
    stubFetch({
      jobs: [job({ job_id: "200", gpu_type: "nvidia", job_name: CURRENT_NAME })],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st).toBeTruthy();
    expect(st?.jobsFetchOk).toBe(true);
    expect(st?.pools[0].desired).toBe(1);
    expect(st?.pools[0].actual).toBe(1);
  });

  // CHURN_LIMIT is 5 in the reconciler. These drive the REAL churn path: an
  // in-flight allocation row that ages out (createdAt far in the past) having
  // never been seen live is the churn signal. createdAt: 1 is effectively
  // "ancient" vs Date.now(), so the row is past INFLIGHT_TTL_MS.
  it("flags errored after CHURN_LIMIT pool jobs die without ever running", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "dead", fingerprint: FP, seenLive: false, createdAt: 1 });
      await ctx.db.insert("gpuPoolStatus", {
        ranAt: 1,
        jobsFetchOk: true,
        orphansCancelled: 0,
        pools: [
          { gpuType: "nvidia", desired: 1, actual: 0, inflight: 0, allocated: 0, cancelled: 0, staleCancelled: 0, adopted: 0, errored: false, churnStreak: 4, fingerprint: FP },
        ],
      });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["x"] });

    await t.action(internal.gpuPool.reconcile, {});

    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].churnStreak).toBe(5);
    expect(st?.pools[0].errored).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(remaining).toHaveLength(0);
  });

  it("does not count a job that was seen live and later ended as churn", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      // Aged-out row that WAS live (normal teardown), not churn.
      await ctx.db.insert("gpuPoolAllocation", { gpuType: "nvidia", jobId: "ended", fingerprint: FP, seenLive: true, createdAt: 1 });
      await ctx.db.insert("gpuPoolStatus", {
        ranAt: 1,
        jobsFetchOk: true,
        orphansCancelled: 0,
        pools: [
          { gpuType: "nvidia", desired: 1, actual: 0, inflight: 0, allocated: 0, cancelled: 0, staleCancelled: 0, adopted: 0, errored: false, churnStreak: 4, fingerprint: FP },
        ],
      });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["new"] });

    await t.action(internal.gpuPool.reconcile, {});

    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].churnStreak).toBe(4);
    expect(st?.pools[0].errored).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(true);
  });

  it("resets churn once the pool reaches its desired count", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
      await ctx.db.insert("gpuPoolStatus", {
        ranAt: 1,
        jobsFetchOk: true,
        orphansCancelled: 0,
        pools: [
          { gpuType: "nvidia", desired: 1, actual: 0, inflight: 0, allocated: 0, cancelled: 0, staleCancelled: 0, adopted: 0, errored: false, churnStreak: 3, fingerprint: FP },
        ],
      });
    });
    stubFetch({
      jobs: [job({ job_id: "live1", gpu_type: "nvidia", job_name: CURRENT_NAME })],
    });

    await t.action(internal.gpuPool.reconcile, {});

    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].actual).toBe(1);
    expect(st?.pools[0].churnStreak).toBe(0);
    expect(st?.pools[0].errored).toBe(false);
  });

  it("captures an allocate timeout/network error and still writes status", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 1, updatedAt: 1 });
    });
    const calls = stubFetch({ jobs: [], allocateThrows: true });

    // Must resolve, not throw, even though /allocate rejects.
    await t.action(internal.gpuPool.reconcile, {});

    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.jobsFetchOk).toBe(true);
    expect(st?.pools[0].allocateError).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(true);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  it("clamps a directly-seeded oversized desiredCount and allocates at most one", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...poolConfig, desiredCount: 100, updatedAt: 1 });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["100"] });

    await t.action(internal.gpuPool.reconcile, {});

    const st = await t.run(async (ctx) => ctx.db.query("gpuPoolStatus").first());
    expect(st?.pools[0].desired).toBe(16);
    const allocate = calls.filter((c) => c.url.endsWith("/allocate"));
    expect(allocate).toHaveLength(1);
  });
});

describe("gpuPool.set", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("clamps desiredCount and round-trips releaseOnExit", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { role: "admin" }),
    );
    const tAdmin = t.withIdentity({ subject: userId + "|test" });

    await tAdmin.mutation(api.gpuPool.set, {
      gpuType: "nvidia",
      desiredCount: 999,
      timeMins: 30,
      memoryMb: 64000,
      commands: [],
      projectDir: "",
      releaseOnExit: true,
      enabled: true,
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("gpuPool")
        .withIndex("by_gpu_type", (q) => q.eq("gpuType", "nvidia"))
        .unique(),
    );
    expect(row?.desiredCount).toBe(16);
    expect(row?.releaseOnExit).toBe(true);
  });
});

// An admin-authored row with all fields, inserted directly (the reconciler reads it).
const adminRow = {
  ...poolConfig,
  desiredCount: 1,
  restart: "always" as const,
  updatedAt: 1,
};

describe("gpuPool restart policy (reconcile)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("restart:never drains to zero — a completed worker is never relaunched", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", {
        ...poolConfig,
        desiredCount: 1,
        restart: "never",
        updatedAt: 1,
      });
    });

    // cycle 1: nothing live → allocate one worker (in-flight, not yet seen live).
    let calls = stubFetch({ jobs: [], allocateJobIds: ["100"] });
    await t.action(internal.gpuPool.reconcile, {});
    expect(calls.filter((c) => c.url.endsWith("/allocate"))).toHaveLength(1);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    // cycle 2: the worker is live → mark seen-live, allocate nothing more.
    calls = stubFetch({
      jobs: [job({ job_id: "100", gpu_type: "nvidia", job_name: CURRENT_NAME })],
      allocateJobIds: ["101"],
    });
    await t.action(internal.gpuPool.reconcile, {});
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    // A real worker runs for hours, so by exit its allocation row is long past the in-flight
    // TTL; age it so cycle 3 sees the death (not an in-flight row), exercising the real path.
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query("gpuPoolAllocation")
        .withIndex("by_job", (q) => q.eq("jobId", "100"))
        .unique();
      if (r) await ctx.db.patch(r._id, { createdAt: 1 });
    });

    // cycle 3: the worker has exited (drained its work) → under restart:never it is a
    // completed slot, NOT a vacancy: do not relaunch. The pool stays at zero live.
    calls = stubFetch({ jobs: [], allocateJobIds: ["101"] });
    await t.action(internal.gpuPool.reconcile, {});
    expect(calls.some((c) => c.url.endsWith("/allocate"))).toBe(false);

    // the completion marker row persists (seen-live, not pruned) so the slot is never reused.
    const rows = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].jobId).toBe("100");
    expect(rows[0].seenLive).toBe(true);
  });

  it("restart:always relaunches a completed worker (keep-warm contrast)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", {
        ...poolConfig,
        desiredCount: 1,
        restart: "always",
        updatedAt: 1,
      });
    });

    let calls = stubFetch({ jobs: [], allocateJobIds: ["100"] });
    await t.action(internal.gpuPool.reconcile, {});
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    calls = stubFetch({
      jobs: [job({ job_id: "100", gpu_type: "nvidia", job_name: CURRENT_NAME })],
      allocateJobIds: ["101"],
    });
    await t.action(internal.gpuPool.reconcile, {});
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();

    // age the row past the in-flight TTL so its death registers (as in the never test).
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query("gpuPoolAllocation")
        .withIndex("by_job", (q) => q.eq("jobId", "100"))
        .unique();
      if (r) await ctx.db.patch(r._id, { createdAt: 1 });
    });

    // cycle 3: worker exited → keep-warm prunes the dead row and replaces it.
    calls = stubFetch({ jobs: [], allocateJobIds: ["101"] });
    await t.action(internal.gpuPool.reconcile, {});
    expect(calls.filter((c) => c.url.endsWith("/allocate"))).toHaveLength(1);
  });
});

describe("gpuPool.agentScale", () => {
  it("writes only desiredCount/enabled/restart, leaving the command untouched", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...adminRow });
    });

    const result = await t.mutation(internal.gpuPool.agentScale, {
      writer: "agentX",
      gpuType: "nvidia",
      desiredCount: 4,
      enabled: false,
      restart: "never",
    });
    expect(result).toEqual({
      gpuType: "nvidia",
      desiredCount: 4,
      enabled: false,
      restart: "never",
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("gpuPool")
        .withIndex("by_gpu_type", (q) => q.eq("gpuType", "nvidia"))
        .unique(),
    );
    expect(row?.desiredCount).toBe(4);
    expect(row?.enabled).toBe(false);
    expect(row?.restart).toBe("never");
    // the admin-authored command and projectDir are NEVER touched by the agent path.
    expect(row?.commands).toEqual(poolConfig.commands);
    expect(row?.projectDir).toBe(poolConfig.projectDir);

    // every agent write is audited.
    const log = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAgentLog").collect(),
    );
    expect(log).toHaveLength(1);
    expect(log[0].writer).toBe("agentX");
    expect(log[0].desiredCount).toBe(4);
    expect(log[0].restart).toBe("never");
  });

  it("clamps desiredCount at the write boundary", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...adminRow });
    });
    await t.mutation(internal.gpuPool.agentScale, {
      writer: "a",
      gpuType: "nvidia",
      desiredCount: 9999,
      enabled: true,
      restart: "always",
    });
    const high = await t.run(async (ctx) =>
      ctx.db
        .query("gpuPool")
        .withIndex("by_gpu_type", (q) => q.eq("gpuType", "nvidia"))
        .unique(),
    );
    expect(high?.desiredCount).toBe(16);

    await t.mutation(internal.gpuPool.agentScale, {
      writer: "a",
      gpuType: "nvidia",
      desiredCount: -5,
      enabled: true,
      restart: "always",
    });
    const low = await t.run(async (ctx) =>
      ctx.db
        .query("gpuPool")
        .withIndex("by_gpu_type", (q) => q.eq("gpuType", "nvidia"))
        .unique(),
    );
    expect(low?.desiredCount).toBe(0);
  });

  it("refuses to insert — only pre-approved admin rows are scalable", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.gpuPool.agentScale, {
        writer: "a",
        gpuType: "h100",
        desiredCount: 2,
        enabled: true,
        restart: "always",
      }),
    ).rejects.toThrow(/no admin-authored/);
    const rows = await t.run(async (ctx) => ctx.db.query("gpuPool").collect());
    expect(rows).toHaveLength(0); // no row was created over the agent path
  });
});

describe("/pool httpAction", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function postPool(
    t: ReturnType<typeof convexTest>,
    body: unknown,
    key?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key !== undefined) headers["X-Pool-Key"] = key;
    return t.fetch("/pool", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  const validBody = {
    writer: "agent",
    gpuType: "nvidia",
    desiredCount: 2,
    enabled: true,
    restart: "never",
  };

  it("rejects a missing or wrong key with 401", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    expect((await postPool(t, validBody)).status).toBe(401); // no key
    expect((await postPool(t, validBody, "wrong")).status).toBe(401); // wrong key
  });

  it("scales a pre-approved row with the right key", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...adminRow });
    });
    const res = await postPool(t, validBody, "s3cret");
    expect(res.status).toBe(200);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("gpuPool")
        .withIndex("by_gpu_type", (q) => q.eq("gpuType", "nvidia"))
        .unique(),
    );
    expect(row?.desiredCount).toBe(2);
    expect(row?.restart).toBe("never");
  });

  it("returns 404 when no admin-authored row exists", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await postPool(t, { ...validBody, gpuType: "absent" }, "s3cret");
    expect(res.status).toBe(404);
  });

  it("returns 503 when POOL_AGENT_KEY is unset (fail closed)", async () => {
    // no vi.stubEnv("POOL_AGENT_KEY") — the guard must short-circuit before any work.
    const t = convexTest(schema, modules);
    expect((await postPool(t, validBody, "anything")).status).toBe(503);
  });

  it("rejects an invalid JSON body with 400", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await t.fetch("/pool", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pool-Key": "s3cret" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid restart value with 400", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    const res = await postPool(t, { ...validBody, restart: "sometimes" }, "s3cret");
    expect(res.status).toBe(400);
  });

  it("defaults the audited writer to 'agent' when omitted", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...adminRow });
    });
    const noWriter = {
      gpuType: "nvidia",
      desiredCount: 2,
      enabled: true,
      restart: "never" as const,
    };
    const res = await postPool(t, noWriter, "s3cret");
    expect(res.status).toBe(200);
    const log = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAgentLog").collect(),
    );
    expect(log).toHaveLength(1);
    expect(log[0].writer).toBe("agent");
  });

  // --- GET /pool (the key-authed read endpoint) ---

  async function getPool(
    t: ReturnType<typeof convexTest>,
    key?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (key !== undefined) headers["X-Pool-Key"] = key;
    return t.fetch("/pool", { method: "GET", headers });
  }

  it("GET returns projected configs + status + audit, never the command", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...adminRow });
      await ctx.db.insert("gpuPoolAgentLog", {
        at: 1,
        writer: "agentX",
        gpuType: "nvidia",
        desiredCount: 3,
        enabled: true,
        restart: "never",
      });
    });
    const res = await getPool(t, "s3cret");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      configs: Array<Record<string, unknown>>;
      recentAgentLog: Array<Record<string, unknown>>;
    };
    expect(body.configs).toHaveLength(1);
    const cfg = body.configs[0];
    expect(cfg.gpuType).toBe("nvidia");
    expect(cfg.desiredCount).toBe(adminRow.desiredCount);
    expect(cfg.restart).toBe("always");
    expect(typeof cfg.fingerprint).toBe("string");
    // the agent read key must NEVER see the admin-authored worker command or project dir.
    expect(cfg).not.toHaveProperty("commands");
    expect(cfg).not.toHaveProperty("projectDir");
    expect(body.recentAgentLog).toHaveLength(1);
    expect(body.recentAgentLog[0].writer).toBe("agentX");
  });

  it("GET rejects a missing or wrong key with 401", async () => {
    vi.stubEnv("POOL_AGENT_KEY", "s3cret");
    const t = convexTest(schema, modules);
    expect((await getPool(t)).status).toBe(401);
    expect((await getPool(t, "wrong")).status).toBe(401);
  });

  it("GET returns 503 when POOL_AGENT_KEY is unset", async () => {
    const t = convexTest(schema, modules);
    expect((await getPool(t, "anything")).status).toBe(503);
  });
});

describe("gpuPool.remove", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("deletes the config and its in-flight allocation rows", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", { role: "admin" }),
    );
    const tAdmin = t.withIdentity({ subject: userId + "|test" });
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", { ...adminRow });
      await ctx.db.insert("gpuPoolAllocation", {
        gpuType: "nvidia",
        jobId: "900",
        fingerprint: "deadbeef",
        seenLive: true,
        createdAt: 1,
      });
    });
    await tAdmin.mutation(api.gpuPool.remove, { gpuType: "nvidia" });
    const rows = await t.run(async (ctx) => ctx.db.query("gpuPool").collect());
    const allocs = await t.run(async (ctx) =>
      ctx.db.query("gpuPoolAllocation").collect(),
    );
    expect(rows).toHaveLength(0);
    expect(allocs).toHaveLength(0);
  });
});

describe("gpuPool.reconcile (multiple configs)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reconciles each enabled config toward its own desired count", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("gpuPool", {
        ...poolConfig,
        gpuType: "nvidia",
        desiredCount: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("gpuPool", {
        ...poolConfig,
        gpuType: "h100",
        desiredCount: 1,
        updatedAt: 1,
      });
    });
    const calls = stubFetch({ jobs: [], allocateJobIds: ["200", "201"] });

    await t.action(internal.gpuPool.reconcile, {});

    // One GPU per cycle PER config: both rows get an allocate in the same run, so a second
    // config is never starved by the first — the per-config loop handles each independently.
    const allocate = calls.filter((c) => c.url.endsWith("/allocate"));
    expect(allocate).toHaveLength(2);
    const gpuTypes = allocate
      .map((c) => (c.body as { gpu_type: string }).gpu_type)
      .sort();
    expect(gpuTypes).toEqual(["h100", "nvidia"]);
  });
});
