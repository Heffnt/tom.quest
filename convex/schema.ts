import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const USER_ROLES = v.union(
  v.literal("user"),
  v.literal("admin"),
  v.literal("tom"),
);

export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    role: v.optional(USER_ROLES),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  serverHealth: defineTable({
    serverName: v.union(v.literal("turing"), v.literal("jarvis")),
    reachable: v.boolean(),
    lastChecked: v.number(),
    lastSuccessAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_server", ["serverName"]),

  // Declarative GPU pool: desired state ("keep N GPUs of type T running these
  // commands"). A Convex cron reconciles desired-vs-actual against the Turing
  // API. One row per gpuType. The reconciler derives a reserved squeue job name
  // ("gpupool:<gpuType>:<fingerprint>") from this config; there is no stored
  // jobName.
  gpuPool: defineTable({
    gpuType: v.string(),
    desiredCount: v.number(),
    timeMins: v.number(),
    memoryMb: v.number(),
    // The generic, admin-authored worker command(s) — never agent-writable (spec §4.1, §7).
    commands: v.array(v.string()),
    projectDir: v.string(),
    releaseOnExit: v.boolean(),
    // Completion policy (spec §4.3): "always" keeps desiredCount workers warm (replace on
    // exit); "never" runs to completion (the pool drains to zero as workers exit, counted via
    // the seen-live flag). Excluded from the fingerprint — a policy toggle is not job identity.
    // Optional for migration safety: a row written before this field defaults to keep-warm.
    restart: v.optional(v.union(v.literal("always"), v.literal("never"))),
    enabled: v.boolean(),
    updatedAt: v.number(),
  }).index("by_gpu_type", ["gpuType"]),

  // In-flight cache of jobs the reconciler created. NOT the source of truth for
  // ownership (that is the live Turing job list, matched by reserved job name) —
  // this only bridges the window between allocating a job and seeing it appear
  // in squeue, so we don't double-allocate while one is spinning up. Rows are
  // pruned per-config when a current-fingerprint job dies past INFLIGHT_TTL_MS,
  // plus an orphan sweep for rows whose gpuType no longer has a config.
  // `fingerprint` ties a row to the exact config revision that created it (a
  // config edit drains the old jobs instead of adopting them). `seenLive` records
  // whether the job was ever observed in the live job list; an in-flight row that
  // ages out with seenLive=false never became a real GPU and counts as churn.
  gpuPoolAllocation: defineTable({
    gpuType: v.string(),
    jobId: v.string(),
    fingerprint: v.string(),
    seenLive: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_gpu_type", ["gpuType"])
    .index("by_job", ["jobId"]),

  // Singleton: the outcome of the most recent reconcile run, for the admin
  // status panel. Accessed via .first() (no index).
  gpuPoolStatus: defineTable({
    ranAt: v.number(),
    jobsFetchOk: v.boolean(),
    reason: v.optional(v.string()),
    orphansCancelled: v.number(),
    pools: v.array(
      v.object({
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
      }),
    ),
  }),

  // Append-only audit of agent-key writes to the worker pool (spec §7): the only audit
  // trail for the narrow agentScale path. Kept separate from gpuPoolStatus because the
  // reconciler replaces that singleton wholesale each cycle (it would clobber an audit field).
  gpuPoolAgentLog: defineTable({
    at: v.number(),
    writer: v.string(), // a writer id (not the key); the agent identifies itself
    gpuType: v.string(),
    desiredCount: v.number(),
    enabled: v.boolean(),
    restart: v.union(v.literal("always"), v.literal("never")),
  }).index("by_at", ["at"]),

  userSettings: defineTable({
    userId: v.id("users"),
    settingKey: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index("by_user_setting", ["userId", "settingKey"]),

  symbolScores: defineTable({
    userId: v.optional(v.id("users")),
    username: v.string(),
    timeMs: v.number(),
    createdAt: v.number(),
  }).index("by_time", ["timeMs"]),

  canvases: defineTable({
    userId: v.id("users"),
    name: v.string(),
    html: v.string(),
    activeChatId: v.optional(v.id("canvasChats")),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_user_updated", ["userId", "updatedAt"]),

  canvasChats: defineTable({
    canvasId: v.id("canvases"),
    userId: v.id("users"),
    createdAt: v.number(),
    lastActivityAt: v.number(),
  })
    .index("by_canvas_activity", ["canvasId", "lastActivityAt"])
    .index("by_user", ["userId"]),

  canvasMessages: defineTable({
    chatId: v.id("canvasChats"),
    canvasId: v.id("canvases"),
    userId: v.id("users"),
    kind: v.union(
      v.literal("user"),
      v.literal("assistant_text"),
      v.literal("tool_call"),
      v.literal("tool_result"),
      v.literal("system_prompt"),
      v.literal("error"),
    ),
    content: v.any(),
    createdAt: v.number(),
  }).index("by_chat_created", ["chatId", "createdAt"]),

  perfumeIngredients: defineTable({
    userId: v.id("users"),
    creatorName: v.string(), // denormalized display name of creator
    name: v.string(),
    emits: v.array(v.string()), // token ids (fundamental letters or named ids); small bounded multiset
    minus: v.number(), // ⊖ strike charges granted
    plus: v.number(), // ⊕ wildcard charges granted
    color: v.string(), // hex chip color
    createdAt: v.number(),
  }).index("by_user", ["userId"]),

  perfumeRecipes: defineTable({
    userId: v.id("users"),
    creatorName: v.string(),
    name: v.string(),
    school: v.string(),
    tier: v.union(
      v.literal("simple"),
      v.literal("advanced"),
      v.literal("legendary"),
    ),
    req: v.array(v.string()), // target multiset of token ids
    desc: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId"]),
});
