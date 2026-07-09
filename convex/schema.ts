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

  // Saved /boolback filter sets & views. GLOBAL (no per-user namespacing — the
  // page is effectively single-user). kind=filters stores { filters }; kind=view
  // stores the whole view ({ filters, chart, sorts, visibleCols, centerView }).
  // `state` is structured JSON (v.any()); the client loader is tolerant of
  // missing/unknown fields and bumps schemaVersion only for breaking shapes.
  boolbackPresets: defineTable({
    name: v.string(),
    kind: v.union(v.literal("filters"), v.literal("view")),
    schemaVersion: v.number(),
    state: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_kind_name", ["kind", "name"]),

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

  // Backdoor Forge: one row per build (a single-chain CMT sweep). The Turing API
  // owns the run dir + GPU job; Convex tracks per-user job metadata and the last
  // synced ForgeResult fields. Status sync is client-driven (forge client polls
  // /forge/train/{runId} and persists terminal state via updateJobStatus).
  forgeJobs: defineTable({
    userId: v.id("users"),
    name: v.string(),
    config: v.any(), // ForgeConfig (contract §1)
    runId: v.string(),
    status: v.string(), // pending|running|completed|failed
    jobId: v.optional(v.string()),
    baseModel: v.optional(v.string()),
    tuning: v.optional(v.string()),
    isAdapter: v.optional(v.boolean()),
    adapterPath: v.optional(v.string()),
    modelDir: v.optional(v.string()),
    epoch: v.optional(v.number()),
    score: v.optional(v.any()),
    error: v.optional(v.string()),
    serveSession: v.optional(v.string()),
    serveBaseUrl: v.optional(v.string()),
    serveStatus: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_created", ["userId", "createdAt"])
    .index("by_run", ["runId"]),

  forgeMessages: defineTable({
    jobId: v.id("forgeJobs"),
    userId: v.id("users"),
    role: v.string(), // user|assistant
    content: v.string(),
    createdAt: v.number(),
  }).index("by_job_created", ["jobId", "createdAt"]),

  // ── Multi-brew /perfume — see app/perfume/DESIGN.md §§4,9 ────────────────────
  // The engine (app/perfume/lib/engine) is the ONE implementation of the rules;
  // convex/brews.ts re-verifies every brew with it, never re-implementing math.

  // One row per registered member. A logged-in user gets a row by clicking to
  // join; self-removal (leaveParty) or admin removal deletes it. Admin (Tom) is
  // NOT stored here — it is derived from users.role via authRoles, exactly as
  // convex/perfume.ts does. memberKey follows the ownerKey convention:
  // "user:<id>" | "anon:<uuid>".
  perfumeMembers: defineTable({
    memberKey: v.string(),
    name: v.string(),
    color: v.string(),
    iconStorageId: v.optional(v.id("_storage")),
    registeredAt: v.number(),
    lastSeenAt: v.number(),
  }).index("by_member", ["memberKey"]),

  // One row per brew. owner=null is the party brew (exactly one, .first()).
  // seq powers the default name "{owner} brew {n}" and is per-owner. items are
  // the graph contents (each real/hypothetical, with contributor). Plays carry
  // WHO played them (byMemberKey) so per-member undo can target its own; wild
  // plays also carry the chosen frequency. cauldron holds perfume INSTANCES
  // resting on the cauldron, each with flat provenance (brewedBy, witnesses, at).
  perfumeBrews: defineTable({
    owner: v.union(v.string(), v.null()), // memberKey | null (party brew)
    nickname: v.union(v.string(), v.null()),
    seq: v.number(),
    items: v.array(
      v.object({
        key: v.string(), // catalog item key ("base:<name>" | "pure:<id>")
        real: v.boolean(),
        contributorKey: v.string(), // names are resolved at read (listBrews-style)
      }),
    ),
    strikePlays: v.array(
      v.object({ freq: v.string(), byMemberKey: v.string() }),
    ),
    wildPlays: v.array(
      v.object({
        chosenFreq: v.string(),
        byMemberKey: v.string(),
      }),
    ),
    // The pinned perfume — a target perfume by id (DESIGN.md §9). The engine's
    // closest path picks which recipe of it to steer toward, so no recipe index
    // is stored.
    pinned: v.union(v.object({ perfumeId: v.string() }), v.null()),
    // Perfume instances resting on the cauldron until taken (DESIGN.md §2).
    // Provenance is FLAT (DESIGN.md §1,§9): who brewed it (brewedByKey), who
    // witnessed it (witnesses), and when (brewedAt) — there is no ownership chain.
    cauldron: v.array(
      v.object({
        instanceId: v.string(),
        perfumeId: v.string(),
        count: v.number(),
        brewedByKey: v.string(),
        witnesses: v.array(v.string()), // memberKeys present at completion
        brewedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["owner"])
    .index("by_owner_seq", ["owner", "seq"]),

  // One inventory row per member. Ingredients/pures are fungible stacks with NO
  // gift history — gifting just moves counts. Perfumes are INSTANCES, each with
  // FLAT provenance (brewedBy, witnesses, brewedAt) — no ownership chain.
  perfumeInventories: defineTable({
    memberKey: v.string(),
    ingredients: v.record(v.string(), v.number()), // base:* keys
    pures: v.record(v.string(), v.number()), // pure:* keys
    perfumes: v.array(
      v.object({
        instanceId: v.string(),
        perfumeId: v.string(),
        brewedByKey: v.string(),
        witnesses: v.array(v.string()),
        brewedAt: v.number(),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_member", ["memberKey"]),

  // Per (brewId, memberKey) bounded undo/redo log (~50). Each entry is a
  // reversible arrangement action carrying its inverse payload. Brewing,
  // taking, and gifting are never written here (permanent). done=false marks an
  // entry that has been undone and is redoable.
  perfumeUndo: defineTable({
    brewId: v.id("perfumeBrews"),
    memberKey: v.string(),
    seq: v.number(), // monotonic per (brewId, memberKey)
    action: v.string(),
    payload: v.any(), // forward args
    inverse: v.any(), // args that reverse `action`
    done: v.boolean(),
    at: v.number(),
  }).index("by_brew_member", ["brewId", "memberKey", "seq"]),

  // Per-brew cursor/presence rows, keyed by brewId so a member's presence is
  // scoped to the brew they are viewing — drives stage cursors AND the
  // completion-witness set.
  perfumeBrewPresence: defineTable({
    brewId: v.id("perfumeBrews"),
    clientId: v.string(),
    memberKey: v.string(),
    name: v.string(),
    color: v.string(),
    surface: v.union(v.literal("input"), v.literal("stage"), v.literal("book")),
    x: v.number(),
    y: v.number(),
    hand: v.optional(v.object({ key: v.string(), count: v.number() })),
    updatedAt: v.number(),
  }).index("by_brew", ["brewId"]),
});
