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

// Must exceed the Turing API's SALLOC_JOB_ID_TIMEOUT (60s) so a slow allocate
// is not abandoned mid-flight, which would leak a job we never recorded.
const RECONCILE_FETCH_TIMEOUT_MS = 75_000;
// A recorded allocation we have not yet seen live is treated as in-flight (and
// suppresses re-allocation) only until this TTL elapses; after that it is
// considered dead and pruned.
const INFLIGHT_TTL_MS = 150_000;
// Consecutive allocate cycles that fail to grow the live count before we stop
// allocating and flag the pool as errored.
const CHURN_LIMIT = 5;
// Hard cap on how many jobs a single pool may request, independent of config.
const MAX_ALLOCATION_COUNT = 16;
// Reserved squeue name prefix for all reconciler-created jobs.
const POOL_PREFIX = "gpupool:";

// Two-layer clamp of desiredCount to [0, MAX] — applied at every write boundary (the admin
// `set`, the agent `agentScale`) AND again at reconcile read-time, so no code path ever trusts
// an out-of-range stored value (spec §4.1, §7).
function clampDesired(n: number): number {
  return Math.min(MAX_ALLOCATION_COUNT, Math.max(0, n));
}

async function requireAdmin(ctx: QueryCtx | MutationCtx): Promise<void> {
  const { access } = await requireViewer(ctx);
  if (!access.isAdmin) throw new Error("Admin access required");
}

// Shape of a job in the Turing API's GET /jobs response (subset we use).
type TuringJob = {
  job_id: string;
  gpu_type: string;
  job_name: string;
  gpu_stats: { utilization_pct: number | null } | null;
  start_time: string;
};

// The fields that define a config revision. Excludes gpuType (already in the
// reserved name), desiredCount, and enabled — those do not change a job's
// identity, only how many of it we want.
type FingerprintConfig = {
  commands: string[];
  timeMins: number;
  memoryMb: number;
  projectDir: string;
  releaseOnExit: boolean;
};

// FNV-1a 32-bit over a canonical JSON encoding of the revision-defining fields.
// Both the stored allocation rows and the squeue job name use this exact
// algorithm so a job's identity is stable across reconcile runs and matches the
// name the Turing API reports.
function fingerprint(config: FingerprintConfig): string {
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
  return POOL_PREFIX + gpuType + ":" + fp;
}

function poolPrefix(gpuType: string): string {
  return POOL_PREFIX + gpuType + ":";
}

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
    releaseOnExit: v.boolean(),
    // Optional with a keep-warm default: an admin opts into run-to-completion (spec §4.3); a
    // caller that omits it (or a pre-restart UI) gets the safe "always" policy.
    restart: v.optional(v.union(v.literal("always"), v.literal("never"))),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const desiredCount = clampDesired(args.desiredCount);
    const restart = args.restart ?? "always";
    const existing = await ctx.db
      .query("gpuPool")
      .withIndex("by_gpu_type", (q) => q.eq("gpuType", args.gpuType))
      .unique();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, desiredCount, restart, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("gpuPool", { ...args, desiredCount, restart, updatedAt });
  },
});

// Narrow agent-key write path (spec §7): may set ONLY desiredCount / enabled / restart, on an
// EXISTING admin-authored row (looked up by gpuType). It refuses if no such row exists (no
// insert) and never touches command / projectDir / resource limits — so the worker command
// stays admin-only and arbitrary shell over the agent key is impossible. Shares clampDesired
// with the admin path and records every write to the audit log. Called only by the /pool
// httpAction (which authenticates the separate agent key); not exposed publicly.
export const agentScale = internalMutation({
  args: {
    writer: v.string(),
    gpuType: v.string(),
    desiredCount: v.number(),
    enabled: v.boolean(),
    restart: v.union(v.literal("always"), v.literal("never")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("gpuPool")
      .withIndex("by_gpu_type", (q) => q.eq("gpuType", args.gpuType))
      .unique();
    if (!existing) {
      // No insert over the agent key — only pre-approved (admin-authored) rows are scalable.
      throw new Error(
        `agentScale: no admin-authored pool row for gpuType "${args.gpuType}"`,
      );
    }
    const desiredCount = clampDesired(args.desiredCount);
    await ctx.db.patch(existing._id, {
      desiredCount,
      enabled: args.enabled,
      restart: args.restart,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("gpuPoolAgentLog", {
      at: Date.now(),
      writer: args.writer,
      gpuType: args.gpuType,
      desiredCount,
      enabled: args.enabled,
      restart: args.restart,
    });
    return { gpuType: args.gpuType, desiredCount, enabled: args.enabled, restart: args.restart };
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
    // Drop the config's in-flight rows too. The reconciler still cancels any
    // live pool jobs of this gpuType as orphans next cycle; this just prevents
    // its allocation rows from lingering once the config is gone.
    const rows = await ctx.db
      .query("gpuPoolAllocation")
      .withIndex("by_gpu_type", (q) => q.eq("gpuType", gpuType))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.db.query("gpuPoolStatus").first();
  },
});

// --- Internal helpers used by the reconciler ---------------------------------

export const allConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("gpuPool").collect();
  },
});

// Projected, agent-readable view of the pool configs for the key-authed GET /pool monitor
// (spec §7). Deliberately omits commands/projectDir/resource limits so the agent read key never
// discloses the admin-authored worker command (the §7 "agent never sees the command" invariant);
// exposes only the scaling/policy fields plus the derived fingerprint, which is already public in
// the reserved job name gpupool:<gpuType>:<fp> and lets a monitor correlate desired rows with live
// SLURM jobs. Never return raw gpuPool rows over the agent key.
export const publicConfigs = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = await ctx.db.query("gpuPool").collect();
    return configs.map((c) => ({
      gpuType: c.gpuType,
      desiredCount: c.desiredCount,
      enabled: c.enabled,
      restart: c.restart,
      updatedAt: c.updatedAt,
      fingerprint: fingerprint(c),
    }));
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
  args: {
    gpuType: v.string(),
    jobId: v.string(),
    fingerprint: v.string(),
    seenLive: v.boolean(),
  },
  handler: async (ctx, { gpuType, jobId, fingerprint, seenLive }) => {
    await ctx.db.insert("gpuPoolAllocation", {
      gpuType,
      jobId,
      fingerprint,
      seenLive,
      createdAt: Date.now(),
    });
  },
});

// Mark allocation rows as having been seen live at least once. A row that later
// ages out still seenLive=false never became a real GPU and is treated as churn;
// one that was live and is now gone is a normal teardown, not churn.
export const markSeenLive = internalMutation({
  args: { jobIds: v.array(v.string()) },
  handler: async (ctx, { jobIds }) => {
    for (const jobId of jobIds) {
      const record = await ctx.db
        .query("gpuPoolAllocation")
        .withIndex("by_job", (q) => q.eq("jobId", jobId))
        .unique();
      if (record && !record.seenLive) {
        await ctx.db.patch(record._id, { seenLive: true });
      }
    }
  },
});

export const allAllocations = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("gpuPoolAllocation").collect();
  },
});

// Delete every allocation row whose jobId is in the given set. Looks each up via
// the by_job index so a crash mid-loop only ever leaves un-deleted rows (the
// next cycle re-prunes), never a partial write.
export const removeAllocations = internalMutation({
  args: { jobIds: v.array(v.string()) },
  handler: async (ctx, { jobIds }) => {
    for (const jobId of jobIds) {
      const record = await ctx.db
        .query("gpuPoolAllocation")
        .withIndex("by_job", (q) => q.eq("jobId", jobId))
        .unique();
      if (record) await ctx.db.delete(record._id);
    }
  },
});

export const prevStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("gpuPoolStatus").first();
  },
});

// The most recent agent-key writes (the gpuPoolAgentLog audit trail) for the GET /pool monitor
// (spec §7). Bounded with take(N) over the by_at index so the payload can't grow without limit as
// the append-only log accumulates. The log holds no secret (writer is an id, not the key).
export const recentAgentLog = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("gpuPoolAgentLog")
      .withIndex("by_at")
      .order("desc")
      .take(50);
  },
});

const poolStatusEntry = v.object({
  gpuType: v.string(),
  desired: v.number(),
  actual: v.number(),
  inflight: v.number(),
  allocated: v.number(),
  cancelled: v.number(),
  staleCancelled: v.number(),
  adopted: v.number(),
  errored: v.boolean(),
  erroredReason: v.optional(v.string()),
  allocateError: v.optional(v.string()),
  churnStreak: v.number(),
  fingerprint: v.string(),
});

type PoolStatusEntry = {
  gpuType: string;
  desired: number;
  actual: number;
  inflight: number;
  allocated: number;
  cancelled: number;
  staleCancelled: number;
  adopted: number;
  errored: boolean;
  erroredReason?: string;
  allocateError?: string;
  churnStreak: number;
  fingerprint: string;
};

export const writeStatus = internalMutation({
  args: {
    ranAt: v.number(),
    jobsFetchOk: v.boolean(),
    reason: v.optional(v.string()),
    orphansCancelled: v.number(),
    pools: v.array(poolStatusEntry),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("gpuPoolStatus").first();
    if (existing) {
      await ctx.db.replace(existing._id, args);
    } else {
      await ctx.db.insert("gpuPoolStatus", args);
    }
  },
});

// --- Reconciler ---------------------------------------------------------------

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const url = process.env.TURING_API_URL;
    const key = process.env.TURING_API_KEY;
    if (!url || !key) {
      const prev = await ctx.runQuery(internal.gpuPool.prevStatus, {});
      await ctx.runMutation(internal.gpuPool.writeStatus, {
        ranAt: now,
        jobsFetchOk: false,
        reason: "TURING_API_URL or TURING_API_KEY not set",
        orphansCancelled: 0,
        pools: prev?.pools ?? [],
      });
      return;
    }
    const base = url.replace(/\/$/, "");
    const headers = { "X-API-Key": key, "Content-Type": "application/json" };

    // 1. Read actual jobs. If the API is unreachable, skip this cycle entirely
    //    — do not prune/allocate/cancel against an unknown world. Preserving the
    //    previous pools keeps churnStreak/fingerprint/errored alive across skips.
    let jobs: TuringJob[];
    try {
      const res = await fetch(`${base}/jobs`, {
        headers,
        signal: AbortSignal.timeout(RECONCILE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const prev = await ctx.runQuery(internal.gpuPool.prevStatus, {});
        await ctx.runMutation(internal.gpuPool.writeStatus, {
          ranAt: now,
          jobsFetchOk: false,
          reason: `GET /jobs returned ${res.status}`,
          orphansCancelled: 0,
          pools: prev?.pools ?? [],
        });
        return;
      }
      jobs = (await res.json()) as TuringJob[];
    } catch (e) {
      const prev = await ctx.runQuery(internal.gpuPool.prevStatus, {});
      await ctx.runMutation(internal.gpuPool.writeStatus, {
        ranAt: now,
        jobsFetchOk: false,
        reason: e instanceof Error ? e.message : String(e),
        orphansCancelled: 0,
        pools: prev?.pools ?? [],
      });
      return;
    }

    const liveJobIds = new Set(jobs.map((j) => j.job_id));
    const configs = await ctx.runQuery(internal.gpuPool.allConfigs, {});
    const prev = await ctx.runQuery(internal.gpuPool.prevStatus, {});
    const prevPools = prev?.pools ?? [];

    // 2. Orphan cleanup: cancel any live reconciler-owned job whose embedded
    //    gpuType has no config at all (e.g. the config was removed). The reserved
    //    name is "gpupool:<gpuType>:<fp>"; the gpuType runs from index 8 to the
    //    next colon.
    const configTypes = new Set(configs.map((c) => c.gpuType));
    const orphanIds: string[] = [];
    for (const job of jobs) {
      if (!job.job_name.startsWith(POOL_PREFIX)) continue;
      // Reserved name is "gpupool:<gpuType>:<fp>". Take the gpuType as the
      // segment up to the next colon; a malformed name with no second colon
      // yields the whole remainder (and is still treated as an orphan).
      const rest = job.job_name.slice(POOL_PREFIX.length);
      const colon = rest.indexOf(":");
      const embeddedType = colon === -1 ? rest : rest.slice(0, colon);
      if (!configTypes.has(embeddedType)) {
        await deleteJob(base, headers, job.job_id);
        orphanIds.push(job.job_id);
      }
    }
    // Also drop allocation rows whose gpuType has no config and whose job is no
    // longer live (config removed, or a crash left a row after the job ended).
    // Scoped to non-config types so a live config's in-flight row is never
    // deleted here — that would reintroduce the spin-up double-allocate.
    const allRows = await ctx.runQuery(internal.gpuPool.allAllocations, {});
    const orphanRowIds = allRows
      .filter((r) => !configTypes.has(r.gpuType) && !liveJobIds.has(r.jobId))
      .map((r) => r.jobId);
    const orphanCleanupIds = [...new Set([...orphanIds, ...orphanRowIds])];
    if (orphanCleanupIds.length > 0) {
      await ctx.runMutation(internal.gpuPool.removeAllocations, {
        jobIds: orphanCleanupIds,
      });
    }
    const orphansCancelled = orphanIds.length;

    // 3. Reconcile each config (enabled or disabled) toward its desired count.
    //    Each iteration is wrapped so one config's fetch/mutation failure cannot
    //    abort the others or skip the end-of-run writeStatus.
    const entries: PoolStatusEntry[] = [];
    for (const config of configs) {
      const fp = fingerprint(config);
      const desired = config.enabled ? clampDesired(config.desiredCount) : 0;
      // restart policy (spec §4.3). keep-warm replaces an exited worker to hold desiredCount;
      // run-to-completion ("never") never replaces a worker once it has been seen live, so the
      // pool drains to zero on its own. Absent (legacy row) defaults to keep-warm.
      const keepWarm = (config.restart ?? "always") === "always";
      // Churn/error state is carried from the prev pool entry with the SAME
      // fingerprint — a config edit (new fingerprint) starts fresh.
      const prevPool = prevPools.find(
        (p) => p.gpuType === config.gpuType && p.fingerprint === fp,
      );
      try {
        const prefix = poolPrefix(config.gpuType);
        const currentName = poolName(config.gpuType, fp);
        const poolJobs = jobs.filter((j) => j.job_name.startsWith(prefix));
        const currentJobs = poolJobs.filter((j) => j.job_name === currentName);
        const staleJobs = poolJobs.filter((j) => j.job_name !== currentName);

        // (a) Drain jobs from a previous config revision.
        let staleCancelled = 0;
        const staleIds: string[] = [];
        for (const job of staleJobs) {
          await deleteJob(base, headers, job.job_id);
          staleIds.push(job.job_id);
          staleCancelled++;
        }
        if (staleIds.length > 0) {
          await ctx.runMutation(internal.gpuPool.removeAllocations, {
            jobIds: staleIds,
          });
        }

        const confirmedLive = currentJobs.length;
        const rows = await ctx.runQuery(internal.gpuPool.allocationsByType, {
          gpuType: config.gpuType,
        });
        const rowByJobId = new Map(rows.map((r) => [r.jobId, r]));

        // (b) Adoption: a current live job we have no row for. Claim it as
        //     already-seen-live (it is live right now).
        let adopted = 0;
        for (const job of currentJobs) {
          if (!rowByJobId.has(job.job_id)) {
            await ctx.runMutation(internal.gpuPool.recordAllocation, {
              gpuType: config.gpuType,
              jobId: job.job_id,
              fingerprint: fp,
              seenLive: true,
            });
            adopted++;
          }
        }

        // (c) Mark pre-existing rows whose job is now live, so a later death is
        //     recognized as a normal teardown rather than churn.
        const seenIds = currentJobs
          .filter((j) => {
            const r = rowByJobId.get(j.job_id);
            return r !== undefined && !r.seenLive;
          })
          .map((j) => j.job_id);
        if (seenIds.length > 0) {
          await ctx.runMutation(internal.gpuPool.markSeenLive, {
            jobIds: seenIds,
          });
        }

        // (d) Classify rows. In-flight (current fp, not yet live, within TTL)
        //     suppresses re-allocation. Dead rows are pruned; a dead current-fp
        //     row that was never seen live is a churn signal — the allocation
        //     never became a real GPU.
        const deadIds: string[] = [];
        let inflightCount = 0;
        let churnEvents = 0;
        let completedCount = 0; // restart:never — workers seen live that have since exited
        for (const row of rows) {
          if (liveJobIds.has(row.jobId)) continue;
          const currentFp = row.fingerprint === fp;
          const inflight = currentFp && now - row.createdAt < INFLIGHT_TTL_MS;
          if (inflight) {
            inflightCount++;
            continue;
          }
          // restart:never — a current-fp worker that was seen live and has now exited is a
          // *completed slot*, not a vacancy: keep its row as a one-shot completion marker and
          // count it toward the launch budget, so it is never replaced and the pool drains to
          // zero on its own (spec §4.3). Old-fp dead rows and never-live deaths fall through to
          // pruning/churn below in both policies.
          if (!keepWarm && currentFp && row.seenLive) {
            completedCount++;
            continue;
          }
          deadIds.push(row.jobId);
          if (currentFp && !row.seenLive) churnEvents++;
        }
        if (deadIds.length > 0) {
          await ctx.runMutation(internal.gpuPool.removeAllocations, {
            jobIds: deadIds,
          });
        }

        const effective = confirmedLive + inflightCount;
        // Under restart:never, a completed worker still counts against the launch budget — each
        // slot launches at most once. Under keep-warm, completedCount is always 0 (a seen-live
        // death is pruned, so its absence drives a replacement).
        const launched = effective + (keepWarm ? 0 : completedCount);

        // (e) Churn / errored. A pool that has reached its desired count is
        //     healthy and clears. Otherwise each allocation that ages out
        //     without ever going live advances the streak; at the limit we stop
        //     allocating until the config is edited (which changes the
        //     fingerprint and resets this).
        let churnStreak: number;
        let errored: boolean;
        let erroredReason: string | undefined;
        // "satisfied" = nothing left to launch. keep-warm: enough live workers; run-to-completion:
        // enough workers have launched (live + completed) — a drained restart:never pool is
        // healthy, not churning (spec §4.3).
        const satisfied = keepWarm ? confirmedLive >= desired : launched >= desired;
        if (satisfied) {
          churnStreak = 0;
          errored = false;
          erroredReason = undefined;
        } else {
          churnStreak = (prevPool ? prevPool.churnStreak : 0) + churnEvents;
          errored = prevPool ? prevPool.errored : false;
          erroredReason = prevPool ? prevPool.erroredReason : undefined;
          if (churnStreak >= CHURN_LIMIT) {
            errored = true;
            erroredReason =
              CHURN_LIMIT +
              " pool jobs died without ever running; stopped allocating. Edit the pool config to reset.";
          }
        }

        let allocated = 0;
        let cancelled = 0;
        let allocateError: string | undefined = undefined;

        if (!errored && desired - launched > 0) {
          // Allocate against the launch budget: keep-warm replaces vacancies; restart:never
          // launches each slot at most once (completed slots count, so it stops at desired).
          const result = await allocateOne(ctx, base, headers, config, fp);
          if (result.ok) {
            allocated = 1;
          } else {
            allocateError = result.error;
          }
        } else if (desired - effective < 0) {
          const overBy = confirmedLive - desired;
          if (overBy > 0) {
            // Shed idle GPUs first: lowest utilization, newest start_time as the
            // tie-break so warm long-running jobs survive over fresh idle ones.
            const victims = [...currentJobs]
              .sort((a, b) => {
                const ua = a.gpu_stats?.utilization_pct ?? 0;
                const ub = b.gpu_stats?.utilization_pct ?? 0;
                if (ua !== ub) return ua - ub;
                return b.start_time.localeCompare(a.start_time);
              })
              .slice(0, overBy);
            const victimIds: string[] = [];
            for (const victim of victims) {
              await deleteJob(base, headers, victim.job_id);
              victimIds.push(victim.job_id);
            }
            await ctx.runMutation(internal.gpuPool.removeAllocations, {
              jobIds: victimIds,
            });
            cancelled = overBy;
          }
        }

        entries.push({
          gpuType: config.gpuType,
          desired,
          actual: confirmedLive,
          inflight: inflightCount,
          allocated,
          cancelled,
          staleCancelled,
          adopted,
          errored,
          erroredReason,
          allocateError,
          churnStreak,
          fingerprint: fp,
        });
      } catch (e) {
        // Record the failure for this config and move on; never abort the run.
        // Churn state is carried (frozen), not advanced: an infra error here is
        // not evidence that a GPU job died, so it must not drive the churn
        // circuit-breaker. The failure is surfaced via allocateError instead.
        entries.push({
          gpuType: config.gpuType,
          desired,
          actual: 0,
          inflight: 0,
          allocated: 0,
          cancelled: 0,
          staleCancelled: 0,
          adopted: 0,
          errored: prevPool ? prevPool.errored : false,
          erroredReason: prevPool ? prevPool.erroredReason : undefined,
          allocateError: e instanceof Error ? e.message : String(e),
          churnStreak: prevPool ? prevPool.churnStreak : 0,
          fingerprint: fp,
        });
      }
    }

    await ctx.runMutation(internal.gpuPool.writeStatus, {
      ranAt: now,
      jobsFetchOk: true,
      reason: undefined,
      orphansCancelled,
      pools: entries,
    });
  },
});

async function deleteJob(
  base: string,
  headers: Record<string, string>,
  jobId: string,
): Promise<void> {
  // Best-effort: a timed-out or failed DELETE must never throw out of reconcile.
  // The job stays in the live list and is retried next cycle.
  try {
    await fetch(`${base}/jobs/${jobId}`, {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(RECONCILE_FETCH_TIMEOUT_MS),
    });
  } catch {
    // swallow — retried next cycle
  }
}

type PoolConfigDoc = {
  gpuType: string;
  timeMins: number;
  memoryMb: number;
  commands: string[];
  projectDir: string;
  releaseOnExit: boolean;
};

// Request exactly one GPU. One-per-cycle keeps the in-flight cache honest: each
// allocation is recorded immediately, so the next cycle counts it and never
// double-allocates while squeue is still spinning up.
async function allocateOne(
  ctx: ActionCtx,
  base: string,
  headers: Record<string, string>,
  config: PoolConfigDoc,
  fp: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // A timeout (the literal R1 trigger) or network error throws here; convert it
  // to a structured failure so it is surfaced via allocateError and writeStatus
  // still runs, instead of aborting the whole reconcile.
  let res: Response;
  try {
    res = await fetch(`${base}/allocate`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        gpu_type: config.gpuType,
        time_mins: config.timeMins,
        memory_mb: config.memoryMb,
        count: 1,
        commands: config.commands,
        project_dir: config.projectDir,
        job_name: poolName(config.gpuType, fp),
        release_on_exit: config.releaseOnExit,
      }),
      signal: AbortSignal.timeout(RECONCILE_FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      ok: false,
      error: "allocate failed: " + (e instanceof Error ? e.message : String(e)),
    };
  }
  if (!res.ok) {
    return { ok: false, error: "allocate returned " + res.status };
  }
  const body = (await res.json()) as { job_ids?: string[] };
  const jobId = body.job_ids?.[0];
  if (!jobId) {
    return { ok: false, error: "allocate returned no job id" };
  }
  await ctx.runMutation(internal.gpuPool.recordAllocation, {
    gpuType: config.gpuType,
    jobId,
    fingerprint: fp,
    seenLive: false,
  });
  return { ok: true };
}
