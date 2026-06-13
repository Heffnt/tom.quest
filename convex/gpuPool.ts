import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireViewer } from "./authRoles";

const RECONCILE_FETCH_TIMEOUT_MS = 30_000;

async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<void> {
  const { access } = await requireViewer(ctx);
  if (!access.isAdmin) throw new Error("Admin access required");
}

// Shape of a job in the Turing API's GET /jobs response (subset we use).
type TuringJob = {
  job_id: string;
  gpu_type: string;
  gpu_stats: { utilization_pct: number | null } | null;
};

// --- Admin-facing config CRUD -------------------------------------------------

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("gpuPool").collect();
  },
});

export const set = mutation({
  args: {
    gpuType: v.string(),
    desiredCount: v.number(),
    timeMins: v.number(),
    memoryMb: v.number(),
    commands: v.array(v.string()),
    projectDir: v.string(),
    jobName: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.desiredCount < 0) throw new Error("desiredCount cannot be negative");
    const existing = await ctx.db
      .query("gpuPool")
      .withIndex("by_gpu_type", (q) => q.eq("gpuType", args.gpuType))
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("gpuPool", { ...args, updatedAt });
  },
});

export const remove = mutation({
  args: { gpuType: v.string() },
  handler: async (ctx, { gpuType }) => {
    await requireAdmin(ctx);
    const existing = await ctx.db
      .query("gpuPool")
      .withIndex("by_gpu_type", (q) => q.eq("gpuType", gpuType))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

// --- Internal helpers used by the reconciler ---------------------------------

export const enabledConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("gpuPool").collect();
    return configs.filter((c) => c.enabled);
  },
});

export const allocationsByType = internalQuery({
  args: { gpuType: v.string() },
  handler: async (ctx, { gpuType }) => {
    return await ctx.db
      .query("gpuPoolAllocation")
      .withIndex("by_gpu_type", (q) => q.eq("gpuType", gpuType))
      .collect();
  },
});

export const recordAllocation = internalMutation({
  args: { gpuType: v.string(), jobId: v.string() },
  handler: async (ctx, { gpuType, jobId }) => {
    await ctx.db.insert("gpuPoolAllocation", {
      gpuType,
      jobId,
      createdAt: Date.now(),
    });
  },
});

export const removeAllocation = internalMutation({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    const record = await ctx.db
      .query("gpuPoolAllocation")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .unique();
    if (record) await ctx.db.delete(record._id);
  },
});

// Drop records whose job_id no longer appears in the Turing job list — the job
// finished (e.g. release_on_exit) or hit its walltime.
export const pruneAllocations = internalMutation({
  args: { liveJobIds: v.array(v.string()) },
  handler: async (ctx, { liveJobIds }) => {
    const live = new Set(liveJobIds);
    const records = await ctx.db.query("gpuPoolAllocation").collect();
    for (const record of records) {
      if (!live.has(record.jobId)) await ctx.db.delete(record._id);
    }
  },
});

// --- Reconciler ---------------------------------------------------------------

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const url = process.env.TURING_API_URL;
    const key = process.env.TURING_API_KEY;
    if (!url || !key) {
      console.error("gpuPool.reconcile: TURING_API_URL or TURING_API_KEY not set");
      return;
    }
    const base = url.replace(/\/$/, "");
    const headers = { "X-API-Key": key, "Content-Type": "application/json" };

    // 1. Read actual jobs. If the API is unreachable, skip this cycle entirely
    //    rather than pruning state against an empty list.
    let jobs: TuringJob[];
    try {
      const res = await fetch(`${base}/jobs`, {
        headers,
        signal: AbortSignal.timeout(RECONCILE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`gpuPool.reconcile: GET /jobs returned ${res.status}`);
        return;
      }
      jobs = (await res.json()) as TuringJob[];
    } catch (e) {
      console.error("gpuPool.reconcile: GET /jobs failed", e);
      return;
    }

    const liveJobIds = jobs.map((j) => j.job_id);
    const liveSet = new Set(liveJobIds);
    const jobById = new Map(jobs.map((j) => [j.job_id, j]));

    // 2. Forget jobs that have ended.
    await ctx.runMutation(internal.gpuPool.pruneAllocations, { liveJobIds });

    // 3. Reconcile each enabled pool toward its desired count.
    const configs = await ctx.runQuery(internal.gpuPool.enabledConfigs, {});
    for (const config of configs) {
      const records = await ctx.runQuery(internal.gpuPool.allocationsByType, {
        gpuType: config.gpuType,
      });
      const live = records.filter((r: PoolAllocation) => liveSet.has(r.jobId));
      const delta = config.desiredCount - live.length;

      if (delta > 0) {
        await scaleUp(ctx, base, headers, config, delta);
      } else if (delta < 0) {
        await scaleDown(ctx, base, headers, live, jobById, -delta);
      }
    }
  },
});

type PoolConfig = {
  gpuType: string;
  desiredCount: number;
  timeMins: number;
  memoryMb: number;
  commands: string[];
  projectDir: string;
  jobName: string;
};

type PoolAllocation = { jobId: string; createdAt: number };

async function scaleUp(
  ctx: ActionCtx,
  base: string,
  headers: Record<string, string>,
  config: PoolConfig,
  count: number,
): Promise<void> {
  try {
    const res = await fetch(`${base}/allocate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        gpu_type: config.gpuType,
        time_mins: config.timeMins,
        memory_mb: config.memoryMb,
        count,
        commands: config.commands,
        project_dir: config.projectDir,
        job_name: config.jobName,
        release_on_exit: true,
      }),
      signal: AbortSignal.timeout(RECONCILE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`gpuPool.reconcile: POST /allocate returned ${res.status}`);
      return;
    }
    const body = (await res.json()) as { job_ids?: string[] };
    for (const jobId of body.job_ids ?? []) {
      await ctx.runMutation(internal.gpuPool.recordAllocation, {
        gpuType: config.gpuType,
        jobId,
      });
    }
  } catch (e) {
    console.error("gpuPool.reconcile: POST /allocate failed", e);
  }
}

async function scaleDown(
  ctx: ActionCtx,
  base: string,
  headers: Record<string, string>,
  live: PoolAllocation[],
  jobById: Map<string, TuringJob>,
  count: number,
): Promise<void> {
  // Shed idle GPUs first: lowest utilization, newest as the tie-break, so warm
  // long-running jobs survive over freshly-allocated idle ones.
  const victims = [...live]
    .sort((a, b) => {
      const ua = jobById.get(a.jobId)?.gpu_stats?.utilization_pct ?? 0;
      const ub = jobById.get(b.jobId)?.gpu_stats?.utilization_pct ?? 0;
      if (ua !== ub) return ua - ub;
      return b.createdAt - a.createdAt;
    })
    .slice(0, count);

  for (const victim of victims) {
    try {
      await fetch(`${base}/jobs/${victim.jobId}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(RECONCILE_FETCH_TIMEOUT_MS),
      });
    } catch (e) {
      console.error(`gpuPool.reconcile: DELETE /jobs/${victim.jobId} failed`, e);
    }
    await ctx.runMutation(internal.gpuPool.removeAllocation, { jobId: victim.jobId });
  }
}
