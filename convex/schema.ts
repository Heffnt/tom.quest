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

  // ── TTS (Toms Todo System) ───────────────────────────────────────────────────
  // Spec: WikiTom tts/spec.md (canonical). Life todos live HERE (system of
  // record); code todos stay in each repo's vqc/todos.yaml and are only
  // mirrored (dtsCodeTodoMirror). Single-user by design: every function in
  // convex/tts.ts is Tom-gated, so rows carry no userId.
  //
  // Vocabulary (spec §12.1) is stored literally:
  //   readiness: unprepared | preparing | ready-for-tom
  //   status:    active | waiting | archived | done
  //   timingClass: dated | condition-bound | whenever
  // Nothing is ever deleted (spec principle 2): terminal states are status
  // "done" or "archived", both kept and visible.
  //
  // NAMING: the dtsTodos-family table names below are FROZEN pre-rename
  // identifiers (rename to TTS, Tom 2026-08-29, adoption.md `tts-rename`).
  // Convex prod is additive-only; renaming a populated table is a data
  // migration for zero behavioral value. Everything human-facing says TTS;
  // only these table names keep the old prefix.

  // ── Batches, schema v2 (ratified 2026-08-29) ─────────────────────────────
  // A BATCH IS NO LONGER A TODO. In v1 a batch was a dtsTodos row carrying
  // `members`; here it is its own row and means one thing: the infrastructure
  // holding HOW a set of todos gets completed. Its contents are dtsTodos rows
  // pointing back at it (batchId) in two kinds — `task` (work to do) and
  // `goal` (a checkable state of the world the batch is for).
  //
  // Vocabulary is Tom's and closed (UI = code): "needs" for dependencies
  // between todos, "ready" for the todos whose needs are all done (the
  // frontier — convex/ttsShared.ts owns the ONE implementation), "must"/"helps"
  // for the edges between batches along a path, kind "task"/"goal".
  batches: defineTable({
    statement: v.string(), // display text
    groundUpExplanation: v.optional(v.string()), // the "more" layer
    // Sequencing BETWEEN batches: a named path this batch sits on, at
    // `index`. `edge` describes the link to the PREVIOUS batch in the path —
    // "must" (that one has to land first) or "helps" (it only makes this
    // easier). The first batch of a path has no edge.
    path: v.optional(
      v.object({
        name: v.string(),
        index: v.number(),
        edge: v.optional(v.union(v.literal("must"), v.literal("helps"))),
      }),
    ),
    status: v.union(
      v.literal("active"),
      v.literal("done"),
      v.literal("archived"),
    ),
    // archived: the condition under which the batch should be proposed back —
    // the dtsTodos field of the same name, same meaning. On an archive ruling
    // the sentence IS this condition, so a batch set aside can come back.
    unarchiveCondition: v.optional(v.string()),
    // The repos this batch's work lives in — names from SESSION_REPOS
    // (convex/ttsShared.ts). Tom's ruling 2026-08-30: A BATCH DECLARES ITS
    // REPOS, set at batch formation, instead of the scheduler guessing them
    // from a case-sensitive substring search over the batch's and todo's
    // words. Every session opened for this batch or for a todo inside it
    // checks out exactly this set. Absent (not empty) = never declared, and
    // the resolver falls back to the legacy guess; an explicit [] means the
    // batch genuinely needs no checkout.
    repos: v.optional(v.array(v.string())),
    // Stamped by the Tom doors (a ruling on the batch, the pens). Same freeze
    // semantics as dtsTodos.tomTouchedAt: a batch with this set is FROZEN —
    // the planner (tts.internalStorePlanGraph) may never rewrite it.
    tomTouchedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status", ["status", "updatedAt"]),

  dtsTodos: defineTable({
    statement: v.string(),
    body: v.optional(v.string()),
    readiness: v.union(
      v.literal("unprepared"),
      v.literal("preparing"),
      v.literal("ready-for-tom"),
    ),
    status: v.union(
      v.literal("active"),
      v.literal("waiting"),
      v.literal("archived"),
      v.literal("done"),
    ),
    timingClass: v.union(
      v.literal("dated"),
      v.literal("condition-bound"),
      v.literal("whenever"),
    ),
    // dated: dueAt + dateKind. Every date resolves to a recorded outcome
    // (kept-dates rule, spec §8) — history kept inline in dateOutcomes.
    dueAt: v.optional(v.number()),
    dateKind: v.optional(
      v.union(v.literal("external"), v.literal("self-imposed")),
    ),
    dateOutcomes: v.optional(
      v.array(
        v.object({
          dueAt: v.number(),
          outcome: v.union(
            v.literal("done"),
            v.literal("renegotiated"),
            v.literal("missed"),
          ),
          recordedAt: v.number(),
          note: v.optional(v.string()),
        }),
      ),
    ),
    // Two readings, one field. (a) condition-bound timing: the trigger
    // condition, alongside the conservative latest-safe estimate below.
    // (b) schema v2: THE GOAL CONDITION — on a `kind: "goal"` row this is the
    // checkable sentence about the world that says the goal is met ("the
    // lease is signed", "cmt-014 is closed upstream"). One field, because the
    // two readings are the same sentence: a statement about the world that is
    // either true yet or not.
    condition: v.optional(v.string()),
    latestSafeAt: v.optional(v.number()),
    // waiting: wake condition (prose) and/or a concrete wake time the daily
    // prep job checks.
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.number()),
    // archived: optional condition under which it should be proposed back.
    unarchiveCondition: v.optional(v.string()),
    // Category tag: lets one scheduled dtsBlocks row cover a set of todos
    // ("chores", …). Free string; "code" is reserved for the code-todo mirror.
    category: v.optional(v.string()),
    // ── Batches v1 (ratified 2026-08-28; SUPERSEDED by the batches table) ────
    // The v1 world, kept live until cutover (nothing is destructive): a row
    // with `members` IS a batch — that one field is the whole
    // discrimination. Because a batch is a real dtsTodos row, every action
    // (rulings, blocks, sessions, done/archive) works on it with no new code.
    // Each member addresses exactly one subject in the ttsRulings shape:
    // { todoId } for a life todo, { repo, externalId } for a code todo
    // (mirror-row _ids are unstable — rows are deleted on upstream close).
    // Enforced in tts.ts: no batch-in-batch; a subject is in at most one
    // non-terminal batch.
    members: v.optional(
      v.array(
        v.object({
          todoId: v.optional(v.id("dtsTodos")),
          repo: v.optional(v.string()),
          externalId: v.optional(v.string()),
        }),
      ),
    ),
    // The completion plan (batches mostly; legal on any todo): ordered steps,
    // each done by an agent or by Tom. The card's "needs you" strip = the open
    // steps with actor "tom". `evidence` on a done agent step names the
    // artifact (branch, PR, brief).
    plan: v.optional(
      v.array(
        v.object({
          text: v.string(),
          actor: v.union(v.literal("tom"), v.literal("agent")),
          status: v.union(v.literal("open"), v.literal("done")),
          doneAt: v.optional(v.number()),
          evidence: v.optional(v.string()),
        }),
      ),
    ),
    // RETIRED (Tom's ruling 2026-08-29, "no importance guesses"); field kept
    // only because production rows exist and prod is additive-only; nothing
    // reads or writes it.
    importance: v.optional(
      v.object({
        level: v.union(
          v.literal("low"),
          v.literal("medium"),
          v.literal("high"),
        ),
        setBy: v.union(v.literal("agent"), v.literal("tom")),
        setAt: v.number(),
        rationale: v.optional(v.string()), // the agent's one-line justification
      }),
    ),
    // Stamped by the Tom doors (updateTodo, setStatus, setPlanStep, ruling
    // life path, the pens). A batch with this set is
    // FROZEN: the batcher job may never rewrite or retire it.
    tomTouchedAt: v.optional(v.number()),
    source: v.string(), // "manual" | "slack-capture" | "consolidation" | later: "email" | "canvas" | "session-sweep"
    provenance: v.optional(v.string()), // link/descriptor of where it came from
    // ── Slack coordinates of the #dump message this was captured from ────────
    // Tom's ruling 2026-08-30: TTS replies ONCE, in thread, to every #dump
    // message, saying how it processed that message. Answering "which message
    // do I reply to?" needs the channel and the message ts as MACHINE fields.
    //
    // DELIBERATELY NOT overloaded into `provenance`: Tom reads provenance, it
    // holds a permalink for him, and parsing a ts back out of a URL would make
    // his field load-bearing for a machine.
    //
    // slackTs is also the DEDUPE key for the Slack Events push route (Slack
    // retries deliver the same event more than once) — see by_slackTs below.
    slackChannel: v.optional(v.string()),
    slackTs: v.optional(v.string()),
    slackReplyTs: v.optional(v.string()), // ts of OUR reply, so it can be edited
    slackRepliedAt: v.optional(v.number()), // the "replied once" guard
    workDescription: v.optional(v.string()), // qualitative, never a numeric estimate (spec §5.3)
    entryAction: v.optional(v.string()), // the one-click smallest next action (spec §13)
    brief: v.optional(v.string()), // ground-up brief, markdown
    // ── Schema v2 graph fields (ratified 2026-08-29) ─────────────────────────
    // ALL OPTIONAL, ALL ADDITIVE: prod is one deployment and nothing is ever
    // destructive, so every v1 row stays legal exactly as written. A row with
    // none of these is a legacy standalone todo and is treated as a task.
    //
    // What a row IS inside a batch. Absent = legacy standalone todo, read as
    // a task. "task" = work someone does; "goal" = a state of the world the
    // batch is for, checkable via `condition` above.
    kind: v.optional(v.union(v.literal("task"), v.literal("goal"))),
    // The batch this row belongs to (batches table). Absent = batch-less.
    batchId: v.optional(v.id("batches")),
    // Dependency edges: this todo is READY only once every id here is done
    // (done or archived both count — ttsShared.buildDoneSet). Bounded at
    // MAX_NEEDS (ttsShared); every id must name a todo in the SAME batch (or a
    // batch-less one), and the graph within a batch must stay acyclic — both
    // enforced on write (tts.internalStorePlanGraph).
    needs: v.optional(v.array(v.id("dtsTodos"))),
    // tasks: who does it. Same meaning as the plan-step actor it succeeds.
    actor: v.optional(v.union(v.literal("tom"), v.literal("agent"))),
    // The model tier an agent task needs. ABSENT IS THE DEFAULT AND THE NORM:
    // workers run Opus, so nothing is written here for an ordinary task. The
    // planner sets "fable" on the rare task whose difficulty warrants the
    // stronger model, and the worker reads it as its --model flag. One literal
    // rather than a free string: an unrecognized tier name would be a silent
    // mis-dispatch, and the tiers below Opus are chosen per-call in-session,
    // never stored on a task.
    model: v.optional(v.literal("fable")),
    // Completion evidence — the artifact that shows the work happened (branch,
    // PR, brief). The plan-step field of the same name, per row.
    evidence: v.optional(v.string()),
    // The "more" layer, same as batches.groundUpExplanation.
    groundUpExplanation: v.optional(v.string()),
    // A goal may bind a CODE subject: "that upstream code todo is closed".
    // Addressed exactly as a ruling/batch-member code subject is — by
    // (repo, externalId), never by mirror-row _id (mirror rows are deleted on
    // upstream close). Set together or not at all.
    codeRepo: v.optional(v.string()),
    codeExternalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    doneAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_readiness", ["readiness"])
    .index("by_batch", ["batchId"])
    // Ingestion lookups: the Canvas sync and the repeating-todo generator find
    // their own rows by source ("canvas" / "repeating") + provenance match,
    // without scanning the whole table.
    .index("by_source", ["source"])
    // The Slack Events push route's dedupe read: Slack's delivery is
    // at-least-once and its retries carry the same message ts, so a capture
    // looks itself up by ts before inserting. A scan would be a full-table
    // read on the hot path of a route that must answer within 3 seconds.
    .index("by_slackTs", ["slackTs"]),

  // ── Calendar mirror (integrations round, 2026-08-29) ─────────────────────
  // Read-only mirror of Tom's external calendars, ingested from ICS feeds
  // (Google Calendar's "secret address", Outlook's published-calendar link,
  // Canvas's calendar feed) by the hourly internal.ttsCalendarFetch
  // .refreshFeeds cron. Feed URLs live in the Convex env var TTS_ICS_FEEDS
  // (JSON: [{"name":"google","url":"https://..."}]) — capability URLs are
  // secrets and never sit in a table.
  //
  // Rows are MIRROR STATE, not todos: each sync replaces a feed's rows
  // wholesale (the external calendar is the system of record), the way
  // dtsCodeTodoMirror replaces per repo. Nothing-ever-lost governs todos;
  // this table is schedule knowledge — what the queue prep, the repeating-todo
  // generator, and the /tts calendar columns read to know when Tom is busy.
  // Recurring events arrive already expanded to concrete occurrences within
  // the sync window (past 7 days → future 60 days).
  ttsCalendarEvents: defineTable({
    feed: v.string(), // feed name from TTS_ICS_FEEDS ("google", "outlook", …)
    uid: v.string(), // source event uid (shared by a recurrence's occurrences)
    title: v.string(),
    start: v.number(), // epoch ms
    end: v.number(), // epoch ms, >= start
    allDay: v.boolean(),
    location: v.optional(v.string()),
    syncedAt: v.number(),
  })
    .index("by_start", ["start"])
    .index("by_feed", ["feed"]),

  // ── Repeating todos (integrations round, 2026-08-29) ─────────────────────
  // One row = one standing rule that mints a real dtsTodos row on each of its
  // weekdays (the 4:30 a.m. generator, internal.ttsRepeats.generate). The
  // rule is schedule mechanics like dtsBlocks — editable and deletable freely
  // (deletion is logged to dtsEvents) — while every minted INSTANCE is a real
  // todo and gets the full nothing-ever-lost treatment: dated, self-imposed,
  // kept-dates outcomes recorded. Skipping a workout is a recorded miss, not
  // a vanished row — that is the point.
  ttsRepeats: defineTable({
    statement: v.string(), // instance display text, copied verbatim
    // Plain lowercase weekday words (naming rules: no abbreviations).
    daysOfWeek: v.array(
      v.union(
        v.literal("monday"),
        v.literal("tuesday"),
        v.literal("wednesday"),
        v.literal("thursday"),
        v.literal("friday"),
        v.literal("saturday"),
        v.literal("sunday"),
      ),
    ),
    // NY wall-clock time the instance is due, "HH:MM" 24h. Absent = noon
    // (the dueAt storage convention, ttsShared.countdownText).
    timeOfDay: v.optional(v.string()),
    // Skip generating on a day whose calendar (ttsCalendarEvents) has an
    // event whose title contains this substring, case-insensitive. This is
    // how "train outside of practice" self-maintains: practice appears on
    // the calendar → no training instance that day.
    skipWhenCalendarHas: v.optional(v.string()),
    category: v.optional(v.string()), // instance category (block sessions)
    entryAction: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    groundUpExplanation: v.optional(v.string()),
    body: v.optional(v.string()),
    active: v.boolean(), // false = paused; the rule stays visible
    createdAt: v.number(),
    updatedAt: v.number(),
  }),

  // Committed time (ratified 2026-08-28): one row = one placed span of time on
  // Tom's calendar, targeting EITHER a single todo (a per-todo commitment —
  // "I will do this Tue 9–11") OR a category of todos ("Sat morning — chores";
  // category "code" = the code-todo mirror). Exactly one of todoId/category is
  // set (enforced in tts.ts). Blocks are calendar strokes, not todos: they may
  // be moved or deleted freely (every change is an event; nothing-ever-lost
  // governs todos, not schedule mechanics).
  dtsBlocks: defineTable({
    start: v.number(), // epoch ms
    end: v.number(), // epoch ms, > start
    todoId: v.optional(v.id("dtsTodos")),
    category: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_start", ["start"]),

  // Time notes (ratified 2026-08-29): the ONE input for anything about time.
  // Every native date/time picker is gone from the /dts page; instead Tom
  // writes one freeform sentence ("push this to next Wednesday", "Sat 9-11 for
  // chores") against exactly one context — a todo, a block, or a calendar day
  // (`day` = the column's calendar-date LABEL, "YYYY-MM-DD", never epoch ms:
  // the server resolves it in America/New_York via nyCalendarDayBoundsUtc, so
  // the browser's timezone can never shift which day a note is about) — and
  // the worker job apply-time-notes.mjs reads it, decides, and calls
  // dts.internalApplyTimeNote. The server re-validates every action it asks
  // for (kept-dates included), so an agent misreading a note cannot slide a
  // date. status:
  //   pending       — not yet read by the job
  //   applied       — carried out; `result` is one plain sentence of what was
  //                   done. Kept FOREVER (instrumentation/transparency);
  //                   listTimeNotes shows only the last 24h of them.
  //   needs-session — ambiguous or refused; `result` is the one-line reason,
  //                   and Tom opens a session (the complicated-cases path).
  dtsTimeNotes: defineTable({
    text: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    blockId: v.optional(v.id("dtsBlocks")),
    day: v.optional(v.string()), // "YYYY-MM-DD", New York calendar date
    status: v.union(
      v.literal("pending"),
      v.literal("applied"),
      v.literal("needs-session"),
    ),
    result: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  }).index("by_status_and_resolvedAt", ["status", "resolvedAt"]),

  // Tom's rulings, unified over life and code todos (ratified 2026-08-28;
  // supersedes dtsCodeRulings below). APPEND-ONLY: a new ruling on the same
  // subject is a NEW row; the newest ruledAt is the live one. The closed
  // verdict set — every ruling button anywhere is one of these four:
  //   approve — execute as briefed (applied by worker/agent, appliedAt then set)
  //   revise  — `sentence` goes back to the preparing agent; life todos drop
  //             to readiness "preparing" immediately
  //   session — this needs conversation; applied when the session is created
  //   archive — set aside; life todos archive immediately (appliedAt = now),
  //             code todos are archived upstream by the worker
  // ("defer" is NOT a verdict — not ruling is deferring; timing changes are a
  // reschedule, not a ruling.)
  dtsRulings: defineTable({
    subjectType: v.union(
      v.literal("life"),
      v.literal("code"),
      v.literal("batch"),
    ),
    todoId: v.optional(v.id("dtsTodos")), // life subjects
    repo: v.optional(v.string()), // code subjects…
    externalId: v.optional(v.string()), // …(repo, externalId)
    // batch subjects (schema v2): a batch is its own row now, so Tom rules on
    // the batch itself — exactly one of todoId / repo+externalId / batchId is
    // set (enforced in ttsRulings.ts).
    batchId: v.optional(v.id("batches")),
    verdict: v.union(
      v.literal("approve"),
      v.literal("revise"),
      v.literal("session"),
      v.literal("archive"),
    ),
    // One optional written note, accepted on EVERY verdict (2026-08-29): the
    // redirect for revise (required there, enforced in ttsRulings.ts), the
    // unarchive condition for archive, a free steering note for
    // approve/session — the worker prompts inject all four as context.
    sentence: v.optional(v.string()),
    ruledAt: v.number(),
    appliedAt: v.optional(v.number()),
    applyResult: v.optional(v.string()),
  })
    .index("by_todo", ["todoId"])
    .index("by_repo_external", ["repo", "externalId"])
    .index("by_ruled", ["ruledAt"]),

  // Append-only instrumentation (spec §10) — every surfacing, engagement,
  // queue cycle, status change, and date outcome, recorded from the first
  // hour. Tom-visible. `kind` is a free string by convention ("created",
  // "surfaced", "engaged", "queue-cycled", "status-changed", "date-outcome",
  // "woke", "captured", ...).
  dtsEvents: defineTable({
    at: v.number(),
    kind: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    data: v.optional(v.any()),
    // Set on the ONE event kind that is an instruction rather than a record:
    // "plan-repair" (a worker found a `needs` edge wrong). The planner reads
    // the unconsumed ones each run and stamps the ones it acted on. Without a
    // consumed marker the same repair is re-asserted every two hours for a
    // week, and the model's most likely response to an instruction to fix
    // something already fixed is to restructure something else.
    consumedAt: v.optional(v.number()),
  })
    .index("by_at", ["at"])
    .index("by_todo", ["todoId", "at"]),

  // One row per TTS day (5 a.m. America/New_York boundary, key YYYY-MM-DD).
  // The Jarvis Box posts a Claude-prepared queue + digest text before 5;
  // a fallback cron builds a simple-rules queue if none arrived. The digest
  // cron ALWAYS sends at 5 (sends-even-when-empty rule) with whatever is here
  // and marks digestSentAt — so a missing digest means Convex/Slack breakage,
  // a digest reporting missing prep means worker breakage.
  dtsDailyQueues: defineTable({
    day: v.string(),
    entries: v.array(
      v.object({
        todoId: v.id("dtsTodos"),
        reason: v.optional(v.string()), // "due" | "overdue" | "condition" | "stale" | "invitation" | worker-authored
      }),
    ),
    digestText: v.optional(v.string()), // worker-prepared digest markdown
    preparedAt: v.number(),
    preparedBy: v.string(), // "worker" | "fallback"
    digestSentAt: v.optional(v.number()),
  }).index("by_day", ["day"]),

  // Read-only mirror of code todos from each repo's vqc/todos.yaml (link by
  // id, never copy — the repo stays the system of record; acting on one means
  // working in that repo). Refreshed by cron from GitHub default branches.
  dtsCodeTodoMirror: defineTable({
    repo: v.string(), // "ComplexMultiTrigger" | "tom.quest"
    externalId: v.string(),
    tier: v.string(), // repo's own vocabulary, verbatim (R/C/H or readiness words)
    status: v.string(), // "open" | "closed"
    statement: v.string(),
    url: v.string(), // deep link to the entry's repo file
    syncedAt: v.number(),
  })
    .index("by_repo_external", ["repo", "externalId"])
    .index("by_status", ["status"]),

  // Ground-up briefs the Jarvis Box prepares for open code todos, one live row
  // per (repo, externalId) — upserted by internalStoreBriefs, so a re-brief
  // replaces the old one. `sourceHash` fingerprints the upstream yaml entry:
  // when the entry changes upstream, the hash mismatch marks the brief stale
  // and the worker rewrites it. `recommendation` is the worker's read, never a
  // verdict — Tom rules (dtsCodeRulings); `execClass` says where an approved
  // item can run; `evidence` carries the commits/files that justify a
  // propose-archive.
  dtsCodeBriefs: defineTable({
    repo: v.string(),
    externalId: v.string(),
    sourceHash: v.string(),
    brief: v.string(), // ground-up markdown
    recommendation: v.union(
      v.literal("approve"),
      v.literal("needs-session"),
      v.literal("propose-archive"),
      v.literal("stale-replan"),
    ),
    execClass: v.union(v.literal("box"), v.literal("needs-turing")),
    evidence: v.optional(v.string()),
    // RETIRED (Tom's ruling 2026-08-29, "no importance guesses"); field kept
    // only because production rows exist and prod is additive-only; nothing
    // reads or writes it.
    importance: v.optional(
      v.object({
        level: v.union(
          v.literal("low"),
          v.literal("medium"),
          v.literal("high"),
        ),
        setBy: v.union(v.literal("agent"), v.literal("tom")),
        setAt: v.number(),
        rationale: v.optional(v.string()),
      }),
    ),
    preparedAt: v.number(),
  }).index("by_repo_external", ["repo", "externalId"]),

  // DEPRECATED (2026-08-28): superseded by the unified ttsRulings table above.
  // Kept as read-only history — non-defer rows are copied into ttsRulings by
  // ttsRulings.internalMigrateCodeRulings (run once at deploy); "defer" rows
  // stay here only (defer is no longer a verdict: not ruling IS deferring).
  // No new writes. Remove in the tts→tts rename round.
  dtsCodeRulings: defineTable({
    repo: v.string(),
    externalId: v.string(),
    ruling: v.union(
      v.literal("approve"),
      v.literal("needs-session"),
      v.literal("propose-archive"),
      v.literal("stale-replan"),
      v.literal("defer"),
    ),
    note: v.optional(v.string()),
    ruledAt: v.number(),
    appliedAt: v.optional(v.number()),
    applyResult: v.optional(v.string()),
  })
    .index("by_repo_external", ["repo", "externalId"])
    .index("by_ruled", ["ruledAt"]),

  // Mirror of WikiTom model-of-tom/skills/*/SKILL.md, refreshed by cron;
  // WikiTom is the system of record. A row exists so prompt-building code can
  // read a skill without a git checkout: Convex has no filesystem, and the
  // planner on the Jarvis Box is Node ESM that cannot import TypeScript, so it
  // takes the text over HTTP (GET /tts/batch-context). Rows are a copy — the
  // sync replaces them wholesale, the way dtsCodeTodoMirror replaces per repo.
  ttsSkills: defineTable({
    name: v.string(), // the skill directory's name, e.g. "writing-to-tom"
    body: v.string(), // the SKILL.md file verbatim, YAML frontmatter included
    sourcePath: v.string(), // path inside WikiTom, so a row traces to its file
    syncedAt: v.number(),
  }).index("by_name", ["name"]),

  // ── Claude Code session surface ──────────────────────────────────────────────
  // CANONICAL DESIGN HOME: WikiTom tts/spec.md §20 (design ratified 2026-08-28;
  // rendering + permission rulings 2026-08-29). These comments carry only what
  // the schema itself needs: Convex IS the stream (the Jarvis Box's session-host
  // daemon persists SDK events via key-authed /sessions/* routes,
  // SESSIONS_WORKER_KEY; the browser renders reactively); the two-tier
  // transcript (claudeMessages rows are FINALIZED, written once, seq-ordered;
  // claudeStreamBuf is the one small live-tail row, ~400ms throttle, segment-
  // finalized every ~16KB); failure honesty is DERIVED at render (heartbeat
  // staleness), never written as a diagnosis.

  claudeSessions: defineTable({
    title: v.string(),
    kind: v.union(
      v.literal("gate"),
      v.literal("focus-item"),
      v.literal("weekly"),
      v.literal("adhoc"),
      v.literal("block"), // works through a SET of items (a category block)
    ),
    todoId: v.optional(v.id("dtsTodos")), // for gate / focus-item sessions
    // The BATCH subject (ledger graduation session-repos-need-batch-subject,
    // 2026-08-31). A batch is its own row, not a dtsTodos row, so a session
    // opened ON a batch could name no subject at all — and the repo resolver,
    // which reaches a batch only THROUGH a todo, could not see the batch's
    // declared repos. The button most likely pressed on a multi-repo batch
    // was the one that started with no checkout. createSession resolves repos
    // from this id directly.
    batchId: v.optional(v.id("batches")),
    blockCategory: v.optional(v.string()), // for block sessions: the category worked
    // ── The repos this session works in ──────────────────────────────────────
    // `repos` is the LIVE field (Tom's ruling 2026-08-30: a session must be
    // able to hold more than one repo — a batch spanning tom.quest and WikiTom
    // cannot be worked in one session otherwise). `repo` is the pre-ruling
    // single-string field, KEPT because prod schema is additive-only: every
    // existing row has it and nothing backfills. Both are written on every new
    // row by buildSessionRow (convex/claudeSessions.ts — the one insert path),
    // with repo = repos[0] ?? "none"; readers prefer `repos ?? [repo]`.
    repos: v.optional(v.array(v.string())),
    repo: v.string(), // "tom.quest" | "ComplexMultiTrigger" | "WikiTom" | "none"
    // Session posture (P3, ratified 2026-08-28): absent = "interactive" (a
    // Tom-driven chat). "autonomous" = fleet-scheduled groundwork with no one
    // watching — the daemon auto-ends it after its final turn and a wall-clock
    // cap interrupts a runaway. Autonomous sessions never rule and never touch
    // code (repo "none" in v1).
    mode: v.optional(
      v.union(v.literal("interactive"), v.literal("autonomous")),
    ),
    // Lifecycle: requested (browser) → starting → idle ⇄ running →
    // ended | failed; reopenSession takes ended/failed back to idle.
    // "awaiting-permission" is HISTORICAL (pre-auto-mode rows keep it; the
    // unified auto gate never produces it — tts-spec:20.1). The browser owns:
    // create, enqueue inbound, reopen, decide residual permissions, and
    // stale-only forceClose. Everything else is daemon-reported fact.
    status: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("idle"),
      v.literal("running"),
      v.literal("awaiting-permission"),
      v.literal("ended"),
      v.literal("failed"),
    ),
    statusChangedAt: v.number(),
    // ── The reopen protocol (three facts a reopen leaves behind) ──────────────
    // Set by reopenSession, cleared by internalIngest the first time the daemon
    // reports "running" again. Its ONE reader is the daemon's adopt path: a
    // reopened session re-enters the live poll with no local Session, which is
    // indistinguishable from a daemon restart — without this flag the adoption
    // stamps "session-host restarted; previous turn interrupted" into a
    // transcript where no restart happened and no turn was interrupted.
    reopenedAt: v.optional(v.number()),
    // Monotonic reopen generation. The daemon stamps the epoch it holds into
    // every ingest; the server drops STATE (never finalize rows) from a payload
    // whose epoch predates the current one. Without it, an ending flush that
    // committed but lost its response is blind-retried after the reopen and
    // re-terminalizes the session — sweeping Tom's reopening turn to
    // "interrupted" and re-firing the failure message.
    reopenEpoch: v.optional(v.number()),
    // Reopening an autonomous session flips mode to "interactive" (the daemon
    // must drop the auto-end path), which would erase the run from the
    // scheduler's per-todo autonomous history and let it re-admit work Tom just
    // closed by hand. This preserves the provenance the history filter reads.
    reopenedFromAutonomous: v.optional(v.boolean()),
    endedReason: v.optional(v.string()), // descriptive, verbatim
    // Session outcomes (ratified 2026-08-28): every session ends with a written
    // outcome record — "completed" (purpose met, including ending by recording
    // rulings that hand work back to the pipeline) or "errored" (daemon failure
    // / explicit close). A session with neither is simply in progress —
    // resumable via sdkSessionId; leaving is not an ending.
    outcome: v.optional(v.union(v.literal("completed"), v.literal("errored"))),
    outcomeSummary: v.optional(v.string()), // agent-authored one-liner + rulings recorded
    // The model tier this session runs on, carried from the task the scheduler
    // claimed (dtsTodos.model). ABSENT IS THE DEFAULT AND THE NORM: a worker
    // runs Opus unless the planner marked the task "fable", so nothing is
    // written here for an ordinary session. The daemon reads it off the poll
    // payload and passes it to the SDK; one literal rather than a free string,
    // for the same reason the task field is (an unrecognized tier name would be
    // a silent mis-dispatch).
    model: v.optional(v.literal("fable")),
    sdkSessionId: v.optional(v.string()), // set once the SDK reports it; resume key
    cwd: v.optional(v.string()), // daemon-reported working dir on the Jarvis Box
    lastSdkEventAt: v.optional(v.number()), // "last output Xm ago" fact
    // Daemon-owned idempotency floor: an ingest carrying seqs below this is a
    // network retry and is dropped. Monotonic per session.
    nextSeq: v.number(),
    createdAt: v.number(),
  })
    .index("by_status", ["status", "statusChangedAt"])
    // Per-todo session history: powers the "does a live session already
    // reference this todo" exclusion and the scheduler's backoff walk.
    .index("by_todo", ["todoId"]),

  // Finalized transcript — written exactly once per row by the daemon.
  // `turn` has no UI reader yet; it is kept because transcript structure is
  // knowledge the (planned) session sweep and analysis layers read, and it
  // is cheap to record now and unreconstructible later.
  claudeMessages: defineTable({
    sessionId: v.id("claudeSessions"),
    seq: v.number(),
    turn: v.number(),
    kind: v.union(
      v.literal("user"),
      v.literal("assistant-text"),
      v.literal("thinking"),
      v.literal("tool-call"),
      v.literal("tool-result"),
      v.literal("permission"),
      v.literal("system"),
      v.literal("error"),
    ),
    content: v.any(), // typed payload per kind; tool results truncated at 32KB by the daemon
    // Subagent parentage (P2): on a tool-call row emitted INSIDE a running
    // Task subagent, the parent Task's toolUseId — the daemon reports it so
    // the agent panel can show what each subagent is doing right now.
    parentToolUseId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    // Kind-scoped reads (getOpenToolWork): tool-call/tool-result rows only,
    // without paging the whole transcript.
    .index("by_session_kind", ["sessionId", "kind", "seq"]),

  // The live tail: ONE row per session, ≤ ~16KB text by construction.
  claudeStreamBuf: defineTable({
    sessionId: v.id("claudeSessions"),
    turn: v.number(),
    seq: v.number(), // the seq this segment will finalize as
    text: v.string(),
    updatedAt: v.number(),
  }).index("by_session", ["sessionId"]),

  // Browser → daemon command queue. A pending user-turn row doubles as the
  // optimistic transcript echo (the finalized user message lands with a seq
  // when the daemon delivers it).
  claudeInbound: defineTable({
    sessionId: v.id("claudeSessions"),
    kind: v.union(
      v.literal("user-turn"),
      v.literal("interrupt"),
      v.literal("stop"),
    ),
    text: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("done"),
      v.literal("interrupted"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
  }).index("by_session_status", ["sessionId", "status"]),

  // Permission requests — HISTORICAL/RESIDUAL under the unified auto
  // permission gate (tts-spec:20.2, ruling session-permission-posture
  // 2026-08-29: nothing parks on Tom; the boundary is structural plus the
  // Bash classifier). The table stays for pre-unification rows and any
  // residual card; stop supersedes, daemon restart expires.
  claudePermissions: defineTable({
    sessionId: v.id("claudeSessions"),
    requestId: v.string(), // daemon-minted uuid
    toolName: v.string(),
    input: v.any(), // truncated by the daemon like tool-calls
    status: v.union(
      v.literal("pending"),
      v.literal("allowed"),
      v.literal("denied"),
      v.literal("superseded"),
      v.literal("expired"),
    ),
    requestedAt: v.number(),
    decidedAt: v.optional(v.number()),
    // "tom" | "daemon-restart" | "session-reopen" | "stop" | "force-close" —
    // who or what settled it. The daemon mints no NEW requests (the unified
    // auto gate decides every call itself); these paths serve the historical
    // rows that predate it.
    decidedBy: v.optional(v.string()),
    note: v.optional(v.string()), // Tom's optional message; a deny note reaches the model verbatim
    appliedAt: v.optional(v.number()), // daemon acked applying the decision to the SDK
  })
    .index("by_session_status", ["sessionId", "status"])
    .index("by_request", ["requestId"]),

  // Daemon heartbeat singleton — its own table so the frequent patch never
  // invalidates transcript queries. Staleness is computed at render:
  // lastSeenAt older than ~30s ⇒ "worker last heard from Xm ago".
  claudeDaemonHealth: defineTable({
    lastSeenAt: v.number(),
    daemonStartedAt: v.number(),
    version: v.string(),
    activeAccount: v.optional(v.string()), // "gmail" | "wpi"
    lastIngestError: v.optional(v.string()),
    // Jarvis Box load snapshot, reported with each heartbeat — the input to the
    // scheduler's load-based admission (the primary throttle of P3).
    load: v.optional(
      v.object({
        loadavg1: v.number(),
        cpus: v.number(),
        freeMemMb: v.number(),
        totalMemMb: v.number(),
        liveSessions: v.number(),
      }),
    ),
  }),

  // Autonomous-fleet admission config (P3, ratified 2026-08-28). Singleton via
  // .first() (the gpuPoolStatus pattern). Load-based admission is the PRIMARY
  // throttle (Tom's ruling: no scalar cap as primary) — maxLiveAutonomous is a
  // runaway failsafe only, maxNewPerTick bounds a clone burst. When no row
  // exists the scheduler uses defaults with enabled FALSE, so nothing runs
  // until the enable pen is used deliberately.
  claudeAutoConfig: defineTable({
    enabled: v.boolean(),
    maxLoadPerCpu: v.number(), // admit while loadavg1 / cpus <= this
    minFreeMemMb: v.number(), // admit while freeMemMb >= this
    maxLiveAutonomous: v.number(),
    maxNewPerTick: v.number(),
    updatedAt: v.number(),
  }),
});
