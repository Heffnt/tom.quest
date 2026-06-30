import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireViewer } from "./authRoles";

// All Forge functions are tom-only. There is no requireTom helper in authRoles,
// so we resolve the viewer's role access and assert isTom, mirroring the
// canvas.ts ownership pattern (a user only ever sees their own jobs).
async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const { userId, access } = await requireViewer(ctx);
  if (!access.isTom) throw new Error("Forge access is restricted to Tom");
  return userId;
}

async function ownJobOrThrow(
  ctx: QueryCtx | MutationCtx,
  id: Id<"forgeJobs">,
  userId: Id<"users">,
): Promise<Doc<"forgeJobs">> {
  const job = await ctx.db.get(id);
  if (!job || job.userId !== userId) throw new Error("Forge job not found");
  return job;
}

export const createJob = mutation({
  args: {
    name: v.string(),
    config: v.any(),
    runId: v.string(),
    jobId: v.optional(v.string()),
  },
  handler: async (ctx, { name, config, runId, jobId }) => {
    const userId = await requireTomId(ctx);
    const now = Date.now();
    return await ctx.db.insert("forgeJobs", {
      userId,
      name: name.trim() || "Untitled build",
      config,
      runId,
      status: "pending",
      jobId,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireTomId(ctx);
    return await ctx.db
      .query("forgeJobs")
      .withIndex("by_user_created", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

export const getJob = query({
  args: { id: v.id("forgeJobs") },
  handler: async (ctx, { id }) => {
    const userId = await requireTomId(ctx);
    return await ownJobOrThrow(ctx, id, userId);
  },
});

// Patches status plus any ForgeResult fields the client read from
// /forge/train/{runId}. All result fields are optional so a plain
// pending->running transition can call this with just { id, status }.
export const updateJobStatus = mutation({
  args: {
    id: v.id("forgeJobs"),
    status: v.string(),
    result: v.optional(
      v.object({
        baseModel: v.optional(v.string()),
        tuning: v.optional(v.string()),
        isAdapter: v.optional(v.boolean()),
        adapterPath: v.optional(v.union(v.string(), v.null())),
        modelDir: v.optional(v.union(v.string(), v.null())),
        epoch: v.optional(v.union(v.number(), v.null())),
        score: v.optional(v.any()),
        error: v.optional(v.union(v.string(), v.null())),
        jobId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { id, status, result }) => {
    const userId = await requireTomId(ctx);
    await ownJobOrThrow(ctx, id, userId);
    const patch: Partial<Doc<"forgeJobs">> = {
      status,
      updatedAt: Date.now(),
    };
    if (result) {
      if (result.baseModel !== undefined) patch.baseModel = result.baseModel;
      if (result.tuning !== undefined) patch.tuning = result.tuning;
      if (result.isAdapter !== undefined) patch.isAdapter = result.isAdapter;
      if (result.adapterPath !== undefined) patch.adapterPath = result.adapterPath ?? undefined;
      if (result.modelDir !== undefined) patch.modelDir = result.modelDir ?? undefined;
      if (result.epoch !== undefined) patch.epoch = result.epoch ?? undefined;
      if (result.score !== undefined) patch.score = result.score;
      if (result.error !== undefined) patch.error = result.error ?? undefined;
      if (result.jobId !== undefined) patch.jobId = result.jobId;
    }
    await ctx.db.patch(id, patch);
  },
});

export const setServe = mutation({
  args: {
    id: v.id("forgeJobs"),
    session: v.optional(v.string()),
    baseUrl: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, { id, session, baseUrl, status }) => {
    const userId = await requireTomId(ctx);
    await ownJobOrThrow(ctx, id, userId);
    await ctx.db.patch(id, {
      serveSession: session,
      serveBaseUrl: baseUrl,
      serveStatus: status,
      updatedAt: Date.now(),
    });
  },
});

export const listMessages = query({
  args: { jobId: v.id("forgeJobs") },
  handler: async (ctx, { jobId }) => {
    const userId = await requireTomId(ctx);
    await ownJobOrThrow(ctx, jobId, userId);
    return await ctx.db
      .query("forgeMessages")
      .withIndex("by_job_created", (q) => q.eq("jobId", jobId))
      .order("asc")
      .collect();
  },
});

export const appendMessage = mutation({
  args: {
    jobId: v.id("forgeJobs"),
    role: v.string(),
    content: v.string(),
  },
  handler: async (ctx, { jobId, role, content }) => {
    const userId = await requireTomId(ctx);
    await ownJobOrThrow(ctx, jobId, userId);
    const now = Date.now();
    const messageId = await ctx.db.insert("forgeMessages", {
      jobId,
      userId,
      role,
      content,
      createdAt: now,
    });
    await ctx.db.patch(jobId, { updatedAt: now });
    return messageId;
  },
});
