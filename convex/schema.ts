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

  // ── TTS (Delegated Todo System) ──────────────────────────────────────────────
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
    // condition-bound: the trigger condition + conservative latest-safe estimate.
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
    // ── Batches (ratified 2026-08-28) ────────────────────────────────────────
    // A row with `members` IS a batch — that one field is the whole
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
    // Agent-estimated importance from the (interim, inferred) model of Tom;
    // Tom can override. THE GUARD lives in the internal mutations: an agent
    // write is ignored whenever the stored value has setBy "tom".
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
    // Stamped by the Tom doors (updateTodo, setStatus, setImportance,
    // setPlanStep, ruling life path, the pens). A batch with this set is
    // FROZEN: the batcher job may never rewrite or retire it.
    tomTouchedAt: v.optional(v.number()),
    source: v.string(), // "manual" | "slack-capture" | "consolidation" | later: "email" | "canvas" | "session-sweep"
    provenance: v.optional(v.string()), // link/descriptor of where it came from
    workDescription: v.optional(v.string()), // qualitative, never a numeric estimate (spec §5.3)
    entryAction: v.optional(v.string()), // the one-click smallest next action (spec §13)
    brief: v.optional(v.string()), // ground-up brief, markdown
    createdAt: v.number(),
    updatedAt: v.number(),
    doneAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_readiness", ["readiness"]),

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
    subjectType: v.union(v.literal("life"), v.literal("code")),
    todoId: v.optional(v.id("dtsTodos")), // life subjects
    repo: v.optional(v.string()), // code subjects…
    externalId: v.optional(v.string()), // …(repo, externalId)
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
  })
    .index("by_at", ["at"])
    .index("by_todo", ["todoId", "at"]),

  // One row per TTS day (5 a.m. America/New_York boundary, key YYYY-MM-DD).
  // The worker box posts a Claude-prepared queue + digest text before 5;
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

  // Ground-up briefs the worker box prepares for open code todos, one live row
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
    // Importance for CODE todos lives on the brief (its stable home — mirror
    // rows are deleted on upstream close). Same shape + same setBy-"tom"
    // agent-write guard as dtsTodos.importance.
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

  // ── Claude Code session surface ──────────────────────────────────────────────
  // CANONICAL DESIGN HOME: WikiTom tts/spec.md §20 (design ratified 2026-08-28;
  // rendering + permission rulings 2026-08-29). These comments carry only what
  // the schema itself needs: Convex IS the stream (the box's session-host
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
    blockCategory: v.optional(v.string()), // for block sessions: the category worked
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
    sdkSessionId: v.optional(v.string()), // set once the SDK reports it; resume key
    cwd: v.optional(v.string()), // daemon-reported working dir on the box
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
    // Box load snapshot, reported with each heartbeat — the input to the
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
