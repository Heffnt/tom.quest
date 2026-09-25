import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
// The stored form of "which model does this run on". ONE HOME (ttsShared.ts):
// the name implies its FAMILY, and the family is what picks the runner on the
// Jarvis Box — Claude's Agent SDK or OpenAI's Codex CLI.
import {
  READINESS,
  RECOMMENDATION,
  RUNNER_ANSWERER,
  RUNNER_DECISION,
  RUNNER_ENDED_REASON,
  RUNNER_TIER,
  RUNNER_TYPE,
  RUNNER_CEILING,
  SESSION_MODEL,
  DECISION_KIND,
  FABLE_AVAILABILITY,
  USAGE_LIMIT_REPORT,
} from "./ttsShared";

// `agent` is not a rank between `user` and `admin`: it is a side branch that
// reads the surfaces in convex/agentSurfaces.ts and writes nothing. See
// roleAccess() in convex/authRoles.ts, which returns isAdmin:false for it.
export const USER_ROLES = v.union(
  v.literal("user"),
  v.literal("admin"),
  v.literal("tom"),
  v.literal("agent"),
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
    // The role vocabulary has a twin: the UserRole TYPE in convex/authRoles.ts,
    // which every gate (roleAccess, requireTom) branches on. A validator and a
    // type cannot be one declaration, so adding a role means editing both — the
    // USER_ROLES union above and UserRole there — or roleAccess silently
    // treats the new role as "user". Absent role means "user"; see
    // authRoles.roleAccess.
    role: v.optional(USER_ROLES),
  })
    .index("email", ["email"])
    .index("phone", ["phone"]),

  serverHealth: defineTable({
    serverName: v.literal("turing"),
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
    // Chats are always reached through their canvas, never listed per user:
    // convex/canvas.ts queries by_canvas_activity, and ownership is checked by
    // ownChatOrThrow, which db.get()s the row and compares userId. A by_user
    // index had no query and was removed. Re-add it only with a caller.
  }).index("by_canvas_activity", ["canvasId", "lastActivityAt"]),

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
    // DANGER — do not drop this column casually. Nothing reads or writes it any
    // more: the member-icon upload path was removed because no client ever
    // called it, and avatars are the initial-on-colour fallback. It stays
    // because deleting a column is validated against every existing row on
    // push, and this repo has ONE Convex deployment: if any perfumeMembers row
    // in prod still carries an iconStorageId (set by an earlier version or by
    // hand in the dashboard), the push is rejected and that failure blocks the
    // whole site's deploy, not just /perfume. Read the prod table first, then
    // drop it. An optional column no code touches costs nothing until then.
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
  //   readiness: unprepared | prepared (ruling 18, the lifeos update;
  //              narrowed to the two values once the migration mapped every
  //              row; ttsShared.ts is the one home)
  //   status:    active | waiting | archived | done
  //   timingClass: dated | whenever (the lifeos update, phase 7: the
  //              condition-bound value is retired — a condition-bound row is
  //              a task whose statement carries the condition and whose sleep
  //              is wakeAt)
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
  // between todos and equally between batches, "ready" for the todos whose
  // needs are all done (the frontier — convex/ttsShared.ts owns the ONE
  // implementation), kind "task"/"goal".
  batches: defineTable({
    statement: v.string(), // display text
    groundUpExplanation: v.optional(v.string()), // the "more" layer
    // Sequencing BETWEEN batches, the same word as between todos: this batch
    // is worked only once every batch named here is done or archived
    // (ttsShared.buildDoneSet's rule). This is the ONLY sequencing between
    // batches (the lifeos update, phase 7): the retired `path` (a name, a
    // position and a "must"/"helps" edge to the previous batch) was derived
    // into it by ttsMigrations.internalMigrateBatchNeeds — a "must" edge
    // became a need on the previous batch of the path; a "helps" edge became
    // nothing, because "only makes this easier" is not a prerequisite and
    // needs holds prerequisites only. Bounded at MAX_NEEDS; every id names a
    // batch (enforced by the planner's pen).
    needs: v.optional(v.array(v.id("batches"))),
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
    // The registration token of the run that last wrote this row's Tom-facing
    // text (the planner's graph writer). ONE FIELD NAME on every table a run
    // writes for Tom — dtsTodos and dtsCodeBriefs carry the same field with
    // the same meaning, because three names for one fact would be three places
    // to keep true. A door that receives no token stores none and the field
    // stays absent; absent is a value and is never inferred.
    // runs.regToken is the other end of the edge.
    producedByRunToken: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status", ["status", "updatedAt"]),

  dtsTodos: defineTable({
    statement: v.string(),
    body: v.optional(v.string()),
    // Set at capture when a poller's triage judged the item to need Tom
    // TODAY, with the triage's own few words (empty when it gave none). No
    // worker raises it with him (Tom, 2026-09-21); the morning message and the
    // hourly line read it here and say it. Its own field because nothing else
    // on the row can hold it: `statement` is display text the preparer
    // rewrites, `body` is the preparer's, and `provenance` is the source line
    // Tom reads, where a judgement would pose as a fact about the source.
    needsTomToday: v.optional(v.object({ why: v.string() })),
    // NARROWED (the lifeos update, phase 7): two values, unprepared |
    // prepared. The retired spellings were mapped by
    // ttsMigrations.internalMigrateReadiness and verified gone on prod
    // before the validator narrowed. Whether a prepared row is READY for
    // Tom is computed, never stored (ttsShared.isReadyForTom).
    readiness: READINESS,
    status: v.union(
      v.literal("active"),
      v.literal("waiting"),
      v.literal("archived"),
      v.literal("done"),
    ),
    // NARROWED (the lifeos update, phase 7): two values, dated | whenever.
    // ttsMigrations.internalMigrateTiming turned every condition-bound row
    // into a task whose statement carries the condition sentence and whose
    // sleep is wakeAt (latestSafeAt minus the 14-day window), and a second run
    // counted zero, so no stored row carries the retired value.
    timingClass: v.union(v.literal("dated"), v.literal("whenever")),
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
    // THE GOAL CONDITION — on a `kind: "goal"` row this is the checkable
    // sentence about the world that says the goal is met ("the lease is
    // signed", "cmt-014 is closed upstream"). One reading now: the trigger
    // reading went with timingClass "condition-bound" (the lifeos update,
    // phase 7), so a condition on a goal is a completion test and nothing
    // else — which is what makes goalCheckable a one-line rule.
    condition: v.optional(v.string()),
    // waiting: a concrete wake time. The prose wake condition it used to sit
    // beside is retired (the lifeos update, phase 7) — the migration carried
    // every stored one into the row's own statement, so the sentence a reader
    // needs is on the row and the sleep is a time.
    wakeAt: v.optional(v.number()),
    // archived: optional condition under which it should be proposed back.
    // STAYS DECLARED past the phase-7 narrow: the archive verdict writes it
    // (convex/ttsRulings.ts), Tom's archive control offers it, and
    // tts.internalMigrateToGraph writes the GRAPH_SUPERSEDED pointer into it
    // as its idempotence key — that migration is Tom's step and has not run.
    unarchiveCondition: v.optional(v.string()),
    // Category tag: lets one scheduled dtsBlocks row cover a set of todos
    // ("chores", …). Free string; "code" is reserved for the code-todo mirror.
    category: v.optional(v.string()),
    // (Batches v1, ratified 2026-08-28, is gone from here: `members` — the one
    // field that made a dtsTodos row a batch — and `plan`, its ordered
    // completion steps, were NARROWED out after
    // ttsMigrations.internalClearRetiredFields took both off every row on prod
    // and a second run reported zero. A batch is its own `batches` row now,
    // and its contents are dtsTodos rows pointing back at it by batchId, kind
    // "task" or "goal", ordered by `needs`. tts.internalMigrateToGraph, which
    // moved all 61 of them across, still reads the pair through a loose view
    // of the row, so it runs on a deployment whose validator has moved on.
    // What each row SAID is on record as a `retired-field-cleared` dtsEvents
    // row. The lifeos update, phase 7.)
    // Stamped by the Tom doors (updateTodo, setStatus, the ruling life path,
    // the pens). A row with this set is FROZEN: the planner
    // (tts.internalStorePlanGraph) may never rewrite or retire it.
    tomTouchedAt: v.optional(v.number()),
    // "manual" | "slack-capture" | "consolidation" | "email" | "session-sweep"
    // | "prospecting" | … Each name means ONE fact: the two Canvas producers
    // are "canvas" (assignments, convex/ttsCanvas.ts) and "canvas-announcement"
    // (worker/jobs/poll-canvas.mjs), never one shared name.
    source: v.string(),
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
    // The registration token of the run that wrote the four prepared fields
    // above. Same field name and same meaning as on batches and
    // dtsCodeBriefs; see the note on batches.producedByRunToken.
    producedByRunToken: v.optional(v.string()),
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
    // STAYS DECLARED past the phase-7 narrow: the planner writes it
    // (tts.internalStorePlanGraph) and the auto-session scheduler reads it
    // (claudeSessions.resolveFleetModel), where a tagged task WAITS rather
    // than falling back when the Codex door is shut. Dropping it would
    // silently re-dispatch tagged work to the fleet default.
    //
    // The model an agent task needs, from the one union in ttsShared
    // (SESSION_MODELS: opus | sonnet | fable | gpt-5.6-sol | gpt-5.6-terra).
    // ABSENT IS THE NORM: the scheduler falls back to the fleet default
    // (claudeAutoConfig.defaultModel) for an untagged task, so the planner
    // writes here only when THIS task needs a particular model. A closed union
    // rather than a free string: an unrecognized name would be a silent
    // mis-dispatch (the planner route drops one instead of carrying it).
    model: v.optional(SESSION_MODEL),
    // Completion evidence — the artifact that shows the work happened (branch,
    // PR, brief). The plan-step field of the same name, per row.
    evidence: v.optional(v.string()),
    // GOALS ONLY (the lifeos update, phase 7): Tom's own line on what the
    // work toward this goal must not break. In his words, written only by his
    // door (tts.updateTodo refuses it on a task; ruling 13: never written by
    // an agent on its own judgement), shown on the batch card under the goal,
    // and injected into every worker and planner prompt where the goal's
    // statement is.
    mustNotBreak: v.optional(v.string()),
    // The "more" layer, same as batches.groundUpExplanation.
    groundUpExplanation: v.optional(v.string()),
    // A goal may bind a CODE subject: "that upstream code todo is closed".
    // Addressed exactly as a ruling/batch-member code subject is — by
    // (repo, externalId), never by mirror-row _id (mirror rows are deleted on
    // upstream close). Set together or not at all. Only a repo still on the
    // mirror (ttsShared CODE_TODO_REPOS) can close one: the ComplexMultiTrigger
    // goals lose both fields in ttsMigrations.internalConvertClosedUpstreamGoals
    // (ruling 70).
    codeRepo: v.optional(v.string()),
    codeExternalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    doneAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"])
    // The dated reads: the 5 a.m. missed rollover ("active rows whose date is
    // before the new day") and the digest's due-and-overdue section ("active
    // rows due by the end of today"). Both used to scan every active row, or
    // the whole table, and filter in code. Undated rows sort BEFORE every
    // number in the index, so a range starting at gte("dueAt", 0) reads the
    // dated ones only.
    .index("by_status_and_due", ["status", "dueAt"])
    .index("by_readiness", ["readiness"])
    .index("by_batch", ["batchId"])
    // Ingestion lookups: the Canvas ASSIGNMENT sync and the repeating-todo
    // generator find their own rows by source ("canvas" / "repeating") +
    // provenance match, without scanning the whole table. The source alone is
    // never the whole key — a reader that skips the provenance match adopts
    // every other producer's rows under that name.
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
  // superseded the retired dtsCodeRulings). APPEND-ONLY: a new ruling on the same
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
      // An elevation a worker raised and the delegate (or Tom) answered
      // (convex/orchestrator.ts). Its verdict is always "answer".
      v.literal("elevation"),
    ),
    todoId: v.optional(v.id("dtsTodos")), // life subjects
    repo: v.optional(v.string()), // code subjects…
    externalId: v.optional(v.string()), // …(repo, externalId)
    // batch subjects (schema v2): a batch is its own row now, so Tom rules on
    // the batch itself — exactly one of todoId / repo+externalId / batchId is
    // set (enforced in ttsRulings.ts).
    batchId: v.optional(v.id("batches")),
    elevationId: v.optional(v.id("elevations")),
    verdict: v.union(
      v.literal("approve"),
      v.literal("revise"),
      v.literal("session"),
      v.literal("archive"),
      // The answer to an elevation, held in `sentence`.
      v.literal("answer"),
    ),
    // Who ruled. Absent is Tom, as on every row written before the delegate
    // could rule. "delegate" marks a delegate ruling (Tom, 2026-09-21): every
    // run treats it as his, his objection reverts it, and nothing that learns
    // about Tom from his rulings reads it as his words.
    ruledBy: v.optional(v.union(v.literal("tom"), v.literal("delegate"))),
    // The delegate's ask behind a delegate ruling (a "delegate-decision"
    // event's key), so an objection to the ask finds the ruling.
    askId: v.optional(v.string()),
    // One optional written note, accepted on EVERY verdict (2026-08-29): the
    // redirect for revise (required there, enforced in ttsRulings.ts), the
    // unarchive condition for archive, a free steering note for
    // approve/session — the worker prompts inject all four as context.
    sentence: v.optional(v.string()),
    ruledAt: v.number(),
    appliedAt: v.optional(v.number()),
    applyResult: v.optional(v.string()),
    // Set when the ruling was written from Tom's own words in a session turn
    // rather than from a button (ruling 15, 2026-09-05): `inboundId` is the
    // claudeInbound row the words came from and `quote` is the one whole
    // sentence or line of that row the agent read as the ruling. Provenance
    // only: it is never copied into `sentence` above (the archive return
    // condition the page shows, the revise redirect the worker reads).
    // Absent on every ruling recorded through the UI. The digest quotes these
    // so a misreading is objected; the same row never rules on the same
    // subject twice (checked in ttsRulings.ts, by the index below).
    provenance: v.optional(
      v.object({
        from: v.literal("tom-words"),
        inboundId: v.string(),
        quote: v.string(),
      }),
    ),
  })
    .index("by_todo", ["todoId"])
    .index("by_repo_external", ["repo", "externalId"])
    // The batch subject's own history, the way by_todo is a todo's. ADDED for
    // the dynamic context assembler (convex/ttsContext.ts rule 10): a run on a
    // todo is given his rulings on that todo AND on its batch, and a batch's
    // rulings had no index — the only way to them was a scan of every ruling
    // ever recorded, on the hot path of every session creation.
    .index("by_batch", ["batchId"])
    .index("by_ruled", ["ruledAt"])
    .index("by_provenance_inboundId", ["provenance.inboundId"])
    .index("by_elevation", ["elevationId"])
    .index("by_ask", ["askId"]),

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
    // Set on the ONE event kind that was an instruction rather than a record:
    // "plan-repair" (a worker found a `needs` edge wrong). The planner read
    // the unconsumed ones each run and stamped the ones it acted on; nothing
    // writes or reads one since the plan pass and batches went (2026-09-24),
    // and the field stays until the schema narrow. Without a
    // consumed marker the same repair is re-asserted every two hours for a
    // week, and the model's most likely response to an instruction to fix
    // something already fixed is to restructure something else.
    consumedAt: v.optional(v.number()),
    // The lookup key, set on exactly fifteen kinds. Five are convex/ttsSlack.ts:
    //   "slack-sent"  — `${channel}:${thread root ts}`, so a threaded reply
    //                   from Tom finds what it answers by (channel, thread_ts);
    //   "slack-event" — Slack's event_id, so a redelivered event is dropped;
    //   "needs-tom"   — the producer's own id for the thing that needs Tom
    //                   (`gmail:message:<id>`), so one mail opens one thread;
    //   "slack-thread-claimed"
    //                 — the same `${channel}:${thread ts}` as "slack-sent", so
    //                   a replacement session claims the thread in the same
    //                   transaction that creates it and a second reply joins
    //                   it rather than opening a second replacement.
    //   "slack-claimed"
    //                 — `<TTS day>:<ask>:<item id>`, so one item is asked
    //                   about once a day whichever channel gets there first
    //                   (convex/ttsCompose.ts claimKey).
    // Two are convex/ttsJobs.ts, where the key names a CONDITION on the Jarvis
    // Box rather than a message:
    //   "job-failed"    — e.g. `poll-canvas:canvas-auth`, so a dead credential
    //                     is one row until it is fixed, not one every tick;
    //   "job-recovered" — the same key, written when the job next runs clean,
    //                     which is what re-arms the report for the next time.
    // (Two more were convex/claudeSessions.ts, the session creation and
    // outcome kinds, keyed on the batch a session was opened on. Batches went
    // with Tom's ruling of 2026-09-24; older rows still carry that key.)
    // Two are convex/ttsAsk.ts, the delegate's record:
    //   "delegate-decision" — the ask's own id, so a second POST of the same
    //                   ask writes nothing and the digest, the caller's next
    //                   run and Tom's objection all name one row;
    //   "delegate-objection"
    //                 — the SAME askId, so "what was decided, and did Tom
    //                   object" is two reads one index apart;
    // Two are convex/ttsEvals.ts, keyed `<repo>@<sha>` — every fact about one
    // COMMIT shares that spelling, so each is a point lookup:
    //   "evals-request" — one request per head, so a re-run of the check does
    //                   not queue the box a second time;
    //   "evals-run"   — the run that scored that head, which is also the merge
    //                   gate's third check.
    // Three are the MECHANICAL MERGE GATE (convex/ttsMerge.ts), two of them
    // under the same `<repo>@<sha>`:
    //   "tests-run"   — the Guardrails tests job's own result, recorded once
    //                   per commit so a red run cannot be re-run until it
    //                   flakes green;
    //   "audit-verdict"
    //                 — the audit's `VERDICT:` word for that commit, recorded
    //                   once for the same reason;
    //   "merge"       — `<repo>:<sha>` (its own older spelling), so a retried
    //                   report of one merge is one event.
    // One is written by the deploy job in Heffnt/Jarvis through POST /tts/event
    // (data { repo, from, to, commits, setupNeeded }):
    //   "deploy"      — `<repo>:<sha>`, the spelling "merge" uses, naming the
    //                   head the box now runs, so one deploy is one event.
    // `data` is v.any() and cannot be indexed, which is why the key is its
    // own field: the events route must answer inside Slack's 3-second budget,
    // and a thread root can be days old, so a bounded scan is not enough.
    key: v.optional(v.string()),
  })
    .index("by_at", ["at"])
    .index("by_todo", ["todoId", "at"])
    // The row for one thread, event id, producer id or box condition:
    // eq(kind), eq(key) — and with `key` pinned, `at` orders what comes back.
    .index("by_kind_key", ["kind", "key", "at"])
    // One kind over a time range, or newest-first, WHATEVER its rows carry in
    // `key`. This used to be the second shape of by_kind_key, read with `key`
    // pinned to undefined — which was exact only for as long as no row of that
    // kind had a key, and silently dropped every row of a kind that later grew
    // one ("job-failed" did). The digest's last "digest-sent" row
    // (convex/ttsDigest.ts) and the hourly update's window, worker events and
    // reported changes (convex/ttsHourly.ts) read here instead of taking N
    // rows off by_at and filtering: past N rows a by_at read silently answers
    // wrong.
    .index("by_kind_at", ["kind", "at"]),

  // Read-only mirror of code todos from each repo's vqc/todos.yaml (link by
  // id, never copy — the repo stays the system of record; acting on one means
  // working in that repo). Refreshed by cron from GitHub default branches.
  dtsCodeTodoMirror: defineTable({
    repo: v.string(), // "tom.quest"; "ComplexMultiTrigger" rows are records since ruling 70 (ttsShared CODE_TODO_REPOS)
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
  // verdict — Tom rules (dtsRulings); `execClass` says where an approved
  // item can run; `evidence` carries the commits/files that justify a
  // propose-archive.
  dtsCodeBriefs: defineTable({
    repo: v.string(),
    externalId: v.string(),
    sourceHash: v.string(),
    brief: v.string(), // ground-up markdown
    // The four verdict words (the lifeos update): approve | revise | session
    // | archive — the worker's read spelled in the words Tom rules in.
    // ttsShared is the one home; normalizeRecommendation there still reads the
    // three retired spellings for one more release, but none may be stored.
    recommendation: RECOMMENDATION,
    // STAYS DECLARED past the phase-7 narrow: worker/jobs/plan-graphs.mjs
    // classifies it on every brief and the brief line on the page prints it.
    execClass: v.union(v.literal("box"), v.literal("needs-turing")),
    evidence: v.optional(v.string()),
    // The registration token of the run that wrote this brief. Same field name
    // and same meaning as on dtsTodos and batches; see the note there.
    producedByRunToken: v.optional(v.string()),
    // THE DOOR CHECK'S MARK (phase 9): the complaints this brief failed on
    // when the planner's brief pass read it back against the writing standard
    // twice. Tom, 2026-09-12: a brief that fails both attempts is still
    // posted, carrying the mark — /tts prints one faint line under the brief.
    // ADDITIVE and optional, so every stored row stays legal as written.
    // ABSENT MEANS CLEAN, not unknown: the pen writes this field on every
    // upsert (convex/ttsCode.ts says why it differs from producedByRunToken
    // there), so a re-brief that passed leaves no stale mark behind.
    doorFaults: v.optional(v.array(v.string())),
    preparedAt: v.number(),
  }).index("by_repo_external", ["repo", "externalId"]),

  // THE PUBLISHED SKILL CATALOG — one row per skill, which is what this table's
  // name has said all along (the unified agent ecosystem, phase 6). Until this
  // commit it held one row per model-of-tom FILE; those rows moved to
  // modelOfTomFiles below with their shape untouched, and this table now holds
  // what shared/skills.mjs builds: `write`, `know-intent`, `know-week`, one
  // `know-<area>` per area page, and one `repo-<name>` per repository.
  //
  // A WIDEN-MIGRATE-NARROW TABLE REPLACEMENT. Existing production rows use the
  // old per-file shape (`sourcePath`, optional `bytes`, no catalog fields), so
  // every field belonging to either side alone remains optional during this
  // deploy. Readers treat an old-shaped row as absent, and POST /tts/skills
  // deletes an old row only after modelOfTomFiles carries its exact sourcePath.
  // Dropping the old fields and requiring the catalog fields belongs in a later
  // PR, after one clean nightly proves the whole replacement has run in prod.
  ttsSkills: defineTable({
    name: v.string(), // "know-research" — the bare name, never the `tom-` directory spelling
    group: v.optional(v.union(v.literal("write"), v.literal("know"), v.literal("repo"))),
    // At most DESCRIPTION_MAX_BYTES (200). A description is a prompt cost every
    // run pays whether or not the skill is loaded, so the cap is checked at the
    // door rather than trusted from the publisher.
    description: v.optional(v.string()),
    body: v.string(),
    // The extra files a skill carries beside its body: ground.md under `write`,
    // each nested AGENTS.md under a `repo-` skill.
    references: v.optional(v.array(v.object({ name: v.string(), path: v.string(), body: v.string() }))),
    sourcePaths: v.optional(v.array(v.string())), // the WikiTom (or repo) paths the body came from
    commit: v.optional(v.string()), // WikiTom's commit, or the repository's own for a `repo-` skill
    syncedAt: v.number(), // the commit's time, not the post's
    pushed: v.optional(v.boolean()), // whether that commit had reached GitHub when it was posted
    // OLD per-file fields. Kept only for the widening deploy described above.
    sourcePath: v.optional(v.string()),
    bytes: v.optional(v.number()),
  }).index("by_name", ["name"]),

  // The per-file model-of-tom source facts, MOVED HERE from ttsSkills above
  // with their shape untouched: one row per WikiTom file the nightly job posts
  // to POST /tts/model-of-tom. They are traceability metadata and a source-text
  // store, never a prompt renderer — the weekly area review reads each area
  // page's frontmatter and byte count off these rows, and the context assembler
  // reads each page's `categories:` line off them to route a run's skills.
  //
  // A TABLE RATHER THAN A FIELD on modelOfTomPublication because that singleton
  // has no `files` field, and one row per file is the shape every reader of
  // them already wants.
  modelOfTomFiles: defineTable({
    name: v.string(), // the path inside model-of-tom/ without ".md": "writing", "areas/research"
    body: v.string(),
    sourcePath: v.string(), // path inside WikiTom, so a row traces to its file
    bytes: v.optional(v.number()), // source bytes reported by the publisher
    // The WikiTom commit the file was read at. It remains optional because rows
    // written by the retired six-hourly sync still have to survive this move.
    commit: v.optional(v.string()),
    syncedAt: v.number(), // the commit's time, not the post's
    // Whether the commit had reached GitHub when it was posted. The job posts
    // local HEAD even when its push was refused, so a prompt names the commit
    // it began with; false is what lets the digest say "not yet pushed".
    // It remains optional because rows posted before that flag still inhabit
    // this table until the next whole replacement.
    pushed: v.optional(v.boolean()),
  }).index("by_name", ["name"]),

  // Exactly one `key: "current"` document is the published model-of-tom
  // revision — THE BASE every prompt begins with. It stores the verbatim
  // layers and the exact header for every canonical selection that remains, so
  // readers never recreate prompt text from the per-file facts above.
  //
  // `write` AND `know` STAY DECLARED AND GO UNWRITTEN from phase 6 on: the two
  // layers became skills (`write`, `know-intent`, `know-week`, `know-<area>`)
  // and nothing selects them any more. They are not removed because a row
  // stored before this commit still carries them and a removed field fails
  // validation on READ, taking the base down with it; the next nightly post
  // replaces the row without them. Readers fail closed while the singleton is
  // absent.
  modelOfTomPublication: defineTable({
    key: v.literal("current"),
    commit: v.string(),
    committedAt: v.number(),
    pushed: v.boolean(),
    operate: v.optional(v.string()),
    write: v.optional(v.string()),
    know: v.optional(v.string()),
    // The nightly posts the version of the graph it generated from the same
    // commit, so a reader of a run row and a reader of the publication name
    // the same object.
    graphVersion: v.optional(v.string()),
    headers: v.array(v.object({
      layers: v.array(v.union(v.literal("operate"), v.literal("write"), v.literal("know"))),
      header: v.string(),
    })),
  }).index("by_key", ["key"]),

  // THE CHANGES THAT ARE WAITING — every open pull request, mirrored from
  // GitHub every five minutes by convex/observeMerge.ts, so the observation
  // page can show a change before it lands and Tom can approve it there.
  //
  // A MIRROR, NOT A RECORD. GitHub owns whether a pull request is open; these
  // rows are a copy the refresh rewrites. A row GitHub stops listing as open
  // is marked `closedAt` rather than deleted, and deleted once it is older
  // than the page's widest window: until then it is how a merged commit on the
  // page finds the pull request it came from (by its head sha), and so which
  // ruling of Tom's it carries. Tom's approval itself is a ruling in
  // `dtsRulings`, which is why deleting a row loses nothing.
  //
  // `lastAttempt` is the one fact GitHub cannot be asked for afterwards: what
  // happened the last time the record tried to merge this. Without it the page
  // can say a change is approved and cannot say why it has not landed.
  pullRequests: defineTable({
    repo: v.string(), // a SESSION_REPOS name
    number: v.number(),
    // The pull request's title, which by this repository's commit rule states
    // the world after the change.
    title: v.string(),
    branch: v.string(), // the head branch
    headSha: v.string(), // what the merge gate's three rows are keyed on
    baseBranch: v.string(),
    draft: v.boolean(),
    updatedAt: v.number(), // GitHub's own updated_at
    seenAt: v.number(), // when the refresh last saw it open
    closedAt: v.optional(v.number()), // when the refresh first saw it gone
    lastAttempt: v.optional(
      v.object({ at: v.number(), ok: v.boolean(), why: v.string() }),
    ),
  })
    .index("by_repo_number", ["repo", "number"])
    .index("by_repo_sha", ["repo", "headSha"])
    .index("by_repo", ["repo"]),

  // The repo layer, published the way the model-of-tom files are published.
  //
  // WHY A TABLE AND NOT A PATH: the assembler pre-expands the repo rules for
  // the directories a todo's brief names (convex/ttsContext.ts rule 9), and it
  // runs INSIDE CONVEX, which has no filesystem — it cannot read the checkout
  // the box has. So the nightly job posts each repo's `AGENTS.md` bodies out of
  // its own immutable commit (POST /tts/repo-rules, same worker key and the
  // same replace-all-per-repo semantics as the model-of-tom post), and a
  // session with no checkout at all — prepare, triage, the planner — still
  // knows what rules exist and where they are.
  repoRules: defineTable({
    repo: v.string(), // a SESSION_REPOS name
    path: v.string(), // "AGENTS.md" | "convex/AGENTS.md" | …, relative to the repo root
    body: v.string(),
    bytes: v.number(),
    commit: v.string(),
    syncedAt: v.number(),
  })
    .index("by_repo_path", ["repo", "path"])
    .index("by_repo", ["repo"]),

  // THE REST OF WHERE HIS INTENT IS WRITTEN. His intent lives in four kinds of
  // place (the /intent page): his directions, the standing rules, his rulings,
  // and the labels he puts on a run's output. Three of the four already have a
  // home in the record — modelOfTomFiles above, dtsRulings, runLabels — and the
  // files below are the ones that had none: the evidence behind each
  // model-of-tom line, `vqc/steering.yaml`, and the two files whose dated notes
  // quote his rulings (`tts/spec.md`, `vqc/adoption.md`).
  //
  // VERBATIM BODIES, PARSED AT READ TIME (convex/intentParse.ts). A curated
  // table of his intent would be a second copy of what he edits, and the page
  // exists to show drift rather than to add a place it can drift to. The
  // nightly replaces every row of this table in one post, the way it replaces
  // the model-of-tom files, so a file it stops sending leaves no stale row.
  intentSources: defineTable({
    repo: v.string(), // "WikiTom" or "tom.quest" — a SESSION_REPOS name
    path: v.string(), // the path inside that repository
    body: v.string(),
    bytes: v.number(),
    commit: v.string(),
    syncedAt: v.number(), // the commit's time, not the post's
  }).index("by_path", ["path"]),

  // THE VOCABULARY AS THE GENERATOR LAST RENDERED IT, and the disagreements it
  // refused to write over. Jarvis's `scripts/vocabulary.mjs` writes WikiTom
  // `tts/vocabulary.json` only when the spec and the code say the same thing
  // about every word; while they do not, it renders, reports and writes
  // nothing — so the file the /vocabulary page would read does not exist, and
  // the generator's own render is the only current statement of the vocabulary.
  //
  // The nightly's graph step posts that render here every night, written or
  // not, which is what lets the page show the words as they are AND the
  // disagreements that are holding the file back. `wrote` says which of those
  // two nights it was.
  ttsVocabulary: defineTable({
    key: v.literal("current"),
    version: v.string(), // the generator's own content hash of the render
    commit: v.string(), // the WikiTom commit §12.1 was read at
    committedAt: v.number(),
    generatedAt: v.number(),
    wrote: v.boolean(), // whether tts/vocabulary.json was written that night
    terms: v.array(v.object({
      term: v.string(),
      kind: v.string(),
      definition: v.string(),
      specSection: v.optional(v.string()), // the §  the term is defined in
      codeSymbol: v.optional(v.string()),
      related: v.array(v.string()),
      refusedFor: v.optional(v.string()), // the word this one is refused in favour of
    })),
    // One per thing the spec and the code do not both say. Each is Tom's to
    // settle with one ruling, so the rows carry what each source says verbatim.
    disagreements: v.array(v.object({
      code: v.string(), // the generator's own class, e.g. "D5"
      subject: v.string(),
      fix: v.string(),
      rows: v.array(v.object({ label: v.string(), where: v.string(), text: v.string() })),
    })),
  }).index("by_key", ["key"]),

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
    // The CODE subject (the lifeos update, phase 7): a worker mission the
    // auto-session scheduler admits for Tom's approve or archive ruling on a
    // code todo — an entry in a repo's vqc/todos.yaml, addressed by (repo,
    // externalId), never a dtsTodos row. Both set or neither. The index is the
    // per-subject session history the scheduler's ceiling reads, the way
    // by_todo is for a todo.
    codeRepo: v.optional(v.string()),
    codeExternalId: v.optional(v.string()),
    // ── The repos this session works in ──────────────────────────────────────
    // `repos` is the LIVE field (Tom's ruling 2026-08-30: a session must be
    // able to hold more than one repo — a batch spanning tom.quest and WikiTom
    // cannot be worked in one session otherwise). `repo` is the pre-ruling
    // single-string field, KEPT because prod schema is additive-only: every
    // existing row has it and nothing backfills. Both are written on every new
    // row by buildSessionRow (convex/claudeSessions.ts — the one insert path),
    // with repo = repos[0] ?? "none"; readers prefer `repos ?? [repo]`.
    repos: v.optional(v.array(v.string())),
    repo: v.string(), // "tom.quest" | "ComplexMultiTrigger" | "WikiTom" | "Jarvis" | "none"
    // Mode, status and outcome belong to the run; the session row's copies are
    // aliases. The run row is where a lifecycle fact lives, because every
    // runtime has runs and only some have sessions. These session-shaped copies
    // stay exactly as they are because the daemon writes them on every flush;
    // where the two disagree, the run row is the truth, and phase 9 deletes the
    // copies. Write neither side from the other: the only new link is runId.
    //
    // Alias map (the run side is authoritative):
    // session.mode ↔ run.mode
    // session.status ↔ run.status — legacy intermediate states requested,
    // starting, idle, running, ended, failed, awaiting-permission remain on
    // the session row until phase 9 removes the copies.
    // session.endedReason ↔ run.outcome.endedReason
    // session.outcome/outcomeSummary ↔ run.outcome
    // session.model ↔ run.sessionModel
    //
    // Aliases on this row also include statusChangedAt, reopenedAt,
    // reopenEpoch, and reopenedFromAutonomous. This legacy row has no
    // token-total fields.
    //
    // Session posture (P3, ratified 2026-08-28): absent = "interactive" (a
    // Tom-driven chat). "autonomous" = fleet-scheduled groundwork with no one
    // watching — the daemon auto-ends it after its final turn and a wall-clock
    // cap interrupts a runaway. Autonomous sessions never rule and never touch
    // code (repo "none" in v1).
    mode: v.optional(
      v.union(v.literal("interactive"), v.literal("autonomous")),
    ),
    // Lifecycle: requested (browser) → starting → idle ⇄ running →
    // ended | failed; reopenSession takes ended/failed back to idle. The
    // browser owns: create, enqueue inbound, reopen, and stale-only
    // forceClose. Everything else is daemon-reported fact.
    //
    // "awaiting-permission" was a sixth value, retired with the permission
    // table (the lifeos update, phase 7): the unified auto gate decides every
    // tool call itself (tts-spec:20.1), so nothing has produced it since that
    // gate landed. A pre-unification row still carrying the word reads as an
    // undeclared value, which is what a dropped literal means here.
    status: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("idle"),
      v.literal("running"),
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
    // The model this session runs on (ttsShared SESSION_MODELS). Its FAMILY
    // picks the runner on the Jarvis Box: "claude" goes through the Agent SDK,
    // "codex" through OpenAI's Codex CLI. The daemon reads it off the poll
    // payload every tick, so setSessionModel changes it mid-session.
    //
    // ABSENT MEANS LEGACY OPUS, not "unset": every row written since
    // 2026-09-04 carries an explicit model (insertSession fills in
    // DEFAULT_SESSION_MODEL), and modelFamily() reads absent as "opus" because
    // that is what the rows written before this field existed actually ran.
    model: v.optional(SESSION_MODEL),
    // Provenance of a "reopen as" (forkSessionAs): the session this one
    // continues on a different model. The fork is a NEW row — a cross-family
    // change cannot resume an SDK session — and this is the only thread back
    // to where its transcript came from.
    forkedFrom: v.optional(v.id("claudeSessions")),
    sdkSessionId: v.optional(v.string()), // set once the SDK reports it; resume key
    // The run this session's CLI file is recorded as (§23). One session is one
    // run; absent until the sweep or backfill writes the derivable CLI id.
    runId: v.optional(v.string()),
    // The run this session continues: the old session's run after a reopen,
    // the forked session's run after a "reopen as". The run the ingest records
    // for this session takes it as its own continuesRunId.
    continuesRunId: v.optional(v.string()),
    // The finalized-row source is switched per session only after its shadow
    // comparison is clean. Absent is the legacy daemon path.
    rowsFrom: v.optional(
      v.union(v.literal("daemon"), v.literal("runs")),
    ),
    cwd: v.optional(v.string()), // daemon-reported working dir on the Jarvis Box
    lastSdkEventAt: v.optional(v.number()), // "last output Xm ago" fact
    // Daemon-owned idempotency floor: an ingest carrying seqs below this is a
    // network retry and is dropped. Monotonic per session.
    nextSeq: v.number(),
    createdAt: v.number(),
    // ── The weekly session's agenda (the lifeos update, phase 8; spec §11) ──
    // Set only on kind "weekly", by the Friday job through POST /tts/session
    // (claudeSessions.internalCreateWeeklySession). `agendaDay` is the
    // YYYY-MM-DD the job ran for — one weekly session per day, refused on
    // by_kind_agenda_day. `agendaSubjects` is the todo and batch ids the
    // agenda's forks name: a weekly session's turns rule on these and on
    // nothing else (ttsRulings refuseUnlessSessionSubject). A weekly session
    // opened from the page carries neither and so rules on nothing.
    agendaDay: v.optional(v.string()),
    agendaSubjects: v.optional(v.array(v.string())),
    // ── What this session's opener was given (the dynamic context round) ─────
    // Written by insertSession from assembleContext's manifest and byte counts,
    // so the delivery check can read what was pre-expanded alongside what the
    // session then did, with no model in the loop:
    //   expansion-unused  an expanded page whose terms never recur in the
    //                     transcript — persistently, for one area, means its
    //                     `categories:` list is too wide.
    //   fetch-after-miss  the transcript ran a command that was ON the
    //                     fetchable list — the mechanism working.
    //   blind-miss        the session errored naming a fact that was on the
    //                     fetchable list — the design's one real failure mode.
    // Absent on every row written before this landed, and on any row whose
    // assembly fell back to the stable prefix alone.
    contextExpanded: v.optional(v.array(v.string())),
    contextBytes: v.optional(v.object({
      prefix: v.number(),
      expanded: v.number(),
      fetchable: v.number(),
    })),
  })
    .index("by_status", ["status", "statusChangedAt"])
    .index("by_createdAt", ["createdAt"])
    .index("by_kind_agenda_day", ["kind", "agendaDay"])
    // Per-todo session history: powers the "does a live session already
    // reference this todo" exclusion and the scheduler's backoff walk.
    .index("by_todo", ["todoId"])
    // Per-code-subject session history: the scheduler's ceiling on how many
    // worker missions one code todo may draw.
    .index("by_code_subject", ["codeRepo", "codeExternalId"])
    // Per-batch session history, newest first. ADDED for the dynamic context
    // assembler (convex/ttsContext.ts rule 11): a run on a batch is given the
    // last outcomes recorded on that batch, and `batchId` had no index — the
    // repo half of the same rule still has none, because `repos` is an array
    // and Convex does not index array membership (that half is a capped
    // descending scan, SESSION_SCAN_MAX).
    .index("by_batch", ["batchId", "statusChangedAt"])
    // Joins a live session row to its immutable `runs` record (§23). The
    // record round also wants `by_createdAt`, already declared above.
    .index("by_run_id", ["runId"])
    // The run-file ingest repairs the session link from the CLI's own id.
    .index("by_sdk_session_id", ["sdkSessionId"]),

  // Finalized transcript — written exactly once per row by the daemon.
  // `turn` has no UI reader yet; it is kept because transcript structure is
  // knowledge the (planned) session sweep and analysis layers read, and it
  // is cheap to record now and unreconstructible later.
  claudeMessages: defineTable({
    // Legacy daemon rows carry sessionId. Run ingest writes runId instead;
    // every transcript row carries one of the two identities.
    sessionId: v.optional(v.id("claudeSessions")),
    runId: v.optional(v.string()),
    depth: v.optional(v.number()),
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
      v.literal("child-run"),
      v.literal("context"),
    ),
    content: v.any(), // typed payload per kind; tool results truncated at 32KB by the daemon
    // Subagent parentage (P2): on a tool-call row emitted INSIDE a running
    // Task subagent, the parent Task's toolUseId — the daemon reports it so
    // the agent panel can show what each subagent is doing right now.
    parentToolUseId: v.optional(v.string()),
    // Set when the 32KB cut above fired (lifeos update §1, the transcript
    // principle: a rendered view may be short, the full bytes must stay
    // retrievable). The complete payload lives in claudeMessageOverflow as
    // `chunkCount` ordered chunks under this row's (sessionId, seq); `sha256`
    // and `byteLength` describe the reassembly, so a reader can check that
    // what comes back is what the daemon stored. Absent = `content` IS the
    // whole payload.
    overflow: v.optional(
      v.object({
        sha256: v.string(),
        byteLength: v.number(),
        chunkCount: v.number(),
      }),
    ),
    provenance: v.optional(v.object({
      fileVersion: v.string(),
      file: v.string(),
      lineStart: v.number(),
      lineEnd: v.number(),
      block: v.number(),
      parserVersion: v.string(),
      sourceKind: v.string(),
    })),
    digest: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"])
    // Kind-scoped reads (getOpenToolWork): tool-call/tool-result rows only,
    // without paging the whole transcript.
    .index("by_session_kind", ["sessionId", "kind", "seq"])
    // A run is ordered by its source cursor (file version, line, block); in
    // phase 2 seq is that cursor's sortable projection.
    .index("by_run_seq", ["runId", "seq"]),

  // The complete payload behind a cut message row, in ordered chunks of ≤256KB
  // (OVERFLOW_CHUNK_BYTES in worker/session-host/overflow.mjs). Keyed by
  // (sessionId, seq) rather than by the message's _id because the daemon
  // uploads the bytes before internalIngest has inserted the row — seq is the
  // message's identity on the daemon's side of the wire, and unique per
  // session by the seq floor. Chunks rather than file storage: the read side
  // is a QUERY (claudeSessions.getMessageOverflow) and ctx.storage.get is
  // reachable only from an action. Each chunk is its own mutation, not part
  // of the row's ingest; the daemon keeps the order (chunks first, then the
  // row) by holding the row back until they are acknowledged, and nothing
  // here removes chunks with a row — claudeSessions.sweepMessageOverflow is
  // the one call that does.
  claudeMessageOverflow: defineTable({
    sessionId: v.optional(v.id("claudeSessions")),
    runId: v.optional(v.string()),
    seq: v.number(),
    index: v.number(), // 0-based position; concatenating in order is the payload
    chunkCount: v.number(), // so an incomplete set is visible without the row
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_session_seq_index", ["sessionId", "seq", "index"])
    .index("by_run_seq_index", ["runId", "seq", "index"]),

  // Immutable CLI-file records. The store is the recovery source; these rows
  // make runs searchable without making the live session state machine apply
  // to every Codex or child thread.
  runs: defineTable({
    runId: v.string(),
    parentRunId: v.optional(v.string()),
    rootRunId: v.string(),
    depth: v.number(),
    spawnedByToolUseId: v.optional(v.string()),
    linkKnown: v.boolean(),
    origin: v.string(),
    continuesRunId: v.optional(v.string()),
    host: v.union(v.literal("laptop"), v.literal("box")),
    // Where the run ran: a session Tom talks to, an unattended worker, or a
    // runner.
    environment: v.union(v.literal("session"), v.literal("worker"), v.literal("runner"), v.literal("orchestrator")),
    // The CLI family the run ran under.
    cli: v.union(v.literal("claude"), v.literal("codex")),
    model: v.optional(v.string()),
    sessionModel: v.optional(SESSION_MODEL),
    effort: v.optional(v.string()),
    runtimeVersion: v.optional(v.string()),
    parserVersion: v.string(),
    kind: v.union(v.literal("session"), v.literal("job"), v.literal("delegate"), v.literal("subagent"), v.literal("codex-child"), v.literal("runner-step"), v.literal("unknown")),
    status: v.union(v.literal("running"), v.literal("ended"), v.literal("failed"), v.literal("abandoned"), v.literal("unknown")),
    mode: v.optional(v.union(v.literal("interactive"), v.literal("autonomous"))),
    startedAt: v.number(),
    lastLineAt: v.number(),
    context: v.optional(v.object({
      wikitomCommit: v.optional(v.string()), layersKnown: v.boolean(), layersGiven: v.array(v.string()), layersDenied: v.array(v.string()), skillsOffered: v.array(v.string()), skillsUsed: v.array(v.string()), tools: v.array(v.string()), hooks: v.array(v.string()), cwd: v.optional(v.string()), gitBranch: v.optional(v.string()), gitCommit: v.optional(v.string()), baseInstructionsHash: v.optional(v.string()), entrypoint: v.optional(v.string()), originator: v.optional(v.string()), permissionMode: v.optional(v.string()), contextWindow: v.optional(v.number()),
      registered: v.optional(v.boolean()), launcher: v.optional(v.string()), modelRequested: v.optional(v.string()), skillsGranted: v.optional(v.array(v.string())), skillsRefused: v.optional(v.array(v.string())), promptSha256: v.optional(v.string()), writingStandardSource: v.optional(v.string()), workflowId: v.optional(v.string()),
      // What the run ASKED FOR, as "<name> (<result>)" — the Skill tool calls
      // its transcript holds, beside skillsGranted, which is what the prompt
      // offered it. Written by worker/agents/registration.mjs until Jarvis's
      // registration change of 2026-09-25, which stopped writing it; absent on
      // every agent before phase 6 and after that change. The field stays,
      // because stored rows carry it and prod is additive-only.
      skillsAsked: v.optional(v.array(v.string())),
      // The graph version a run ran under, and the exact node ids its prompt
      // carried — the `given` edges. They live on the run row because they are
      // per-run and unbounded, which the capped nightly-committed graph file
      // cannot hold. Same pair as convex/agents.ts CONTEXT; absent is a supported
      // value, exactly as it is for wikitomCommit.
      graphVersion: v.optional(v.string()),
      graphNodes: v.optional(v.array(v.string())),
    })),
    outcome: v.optional(v.object({
      endedReason: v.optional(v.string()), finalTextSeq: v.optional(v.number()),
      totals: v.object({
        inputTokens: v.number(),
        cacheReadTokens: v.number(),
        cacheWriteTokens: v.number(),
        cacheWrite5mTokens: v.number(),
        cacheWrite1hTokens: v.number(),
        cacheWriteBreakdownKnown: v.boolean(),
        outputTokens: v.number(),
        thinkingTokens: v.number(),
        totalTokens: v.number(),
        longContextRequests: v.optional(v.number()),
      }),
      costUsd: v.optional(v.number()), priceTableVersion: v.optional(v.string()), turns: v.number(), toolCalls: v.number(),
    })),
    // Tool-result sidecars are pointers only in phase 2: their bytes stay on
    // the host until the phase-3 sweeper assigns them their own store objects.
    attachments: v.array(v.object({ file: v.string(), bytes: v.number(), sha256: v.string() })),
    todoId: v.optional(v.id("dtsTodos")), batchId: v.optional(v.id("batches")), mergeKey: v.optional(v.string()), sessionId: v.optional(v.id("claudeSessions")),
    // The registration token from this run's envelope — the exact edge from a
    // row an agent wrote for Tom back to the run that wrote it.
    //
    // A LABEL NAMES A RUN, and finding which run produced the text Tom judged
    // is the whole risk of the evals layer: a wrong edge poisons the corpus
    // silently, and a wrong edge is worse than a missing one. It is therefore
    // an EXACT TOKEN the producing run stamps on the row it wrote, never a
    // time-window search over this table by subject. "The newest run with this
    // todo before the ruling" is wrong on the ORDINARY case, not the exotic
    // one — a prepare pass, a repair pass and a planner pass can all touch one
    // todo in an hour with the same todoId, and only one of them wrote the
    // text Tom read.
    //
    // ABSENT IS A SUPPORTED VALUE and is never inferred: an unregistered run —
    // every laptop terminal, and everything written before runs were
    // registered — carries no token, and a judgment about its output writes no
    // label at all (convex/agentLabels.ts records the unlinked act instead).
    regToken: v.optional(v.string()),
    envelopeKey: v.optional(v.string()), cutoverAt: v.optional(v.number()), abandonedAt: v.optional(v.number()),
    // `totalLines` is the file's whole length, which only a reader that saw the
    // WHOLE file can honestly write: the backlog importer, which parses a
    // stored version and keeps none of its rows, and the materialize job.
    // `committedLine` stays "lines that are rows in the record", so the pair
    // `committedLine < totalLines` is exactly "this run's rows are partial".
    file: v.object({ path: v.string(), sourceHash: v.string(), storedHash: v.string(), bytes: v.number(), storedBytes: v.number(), committedLine: v.number(), committedPrefixSha256: v.string(), sidecarStoredHash: v.optional(v.string()), storeKey: v.optional(v.string()), incompleteTail: v.optional(v.boolean()), totalLines: v.optional(v.number()) }),
    ingestedAt: v.number(),
    // Where this run's rows came from, when they were not written as the file
    // grew. It lives on the RUN and not in the context row because a row's
    // whole content is folded into its digest (worker/agents/ingest.mjs), so a
    // materialize timestamp inside a row would change that row's digest on
    // every open and collide with the landed twin. The fact belongs to the
    // run, not to a line of its file.
    rowsSource: v.optional(v.object({
      from: v.literal("store"),
      at: v.number(),
      parserVersion: v.string(),
      storeKey: v.string(),
      rowsFromLine: v.number(),
      rowsToLine: v.number(),
      slices: v.number(),
      droppedLines: v.number(),
      // A closed vocabulary (convex/agents.ts MATERIALIZE_PARTIAL): what the
      // stored version could not say, so the page names it instead of
      // pretending the run opened whole.
      partial: v.array(v.string()),
    })),
    // The instant this run's rows become evictable. PRESENT IF AND ONLY IF the
    // rows are in the record: ingest sets it, eviction clears it. That one
    // invariant keeps the nightly scan a bounded read of runs that actually
    // have something to remove, and makes eviction idempotent for free — the
    // last act of evicting a run is to take it out of this index.
    rowsUntil: v.optional(v.number()),
    // When eviction last removed this run's rows. The index row, the store key
    // and every edge survive; only the transcript goes.
    rowsEvictedAt: v.optional(v.number()),
  })
    // Point lookup on each ingest.
    .index("by_run_id", ["runId"])
    // runs.children reads one parent's direct children.
    .index("by_parent", ["parentRunId"])
    // runs.children takes the earliest direct children without first taking
    // an arbitrary creation-time subset.
    .index("by_parent_and_started_at_and_run_id", ["parentRunId", "startedAt", "runId"])
    // A tree reader scans a root at every depth.
    .index("by_root_depth", ["rootRunId", "depth"])
    // The list filters root runs by host and starts in source order.
    .index("by_host_depth_started", ["host", "depth", "startedAt"])
    // Joins a run to the legacy session state row.
    .index("by_session", ["sessionId"])
    // agentLabels.agentForToken turns a row's producedByRunToken into the run that
    // wrote it, on one point lookup inside a mutation's budget.
    .index("by_reg_token", ["regToken"])
    // The nightly manifest walks changed store versions in a stable order.
    .index("by_ingested_at_and_run_id", ["ingestedAt", "runId"])
    // The eviction scan. Because `rowsUntil` is absent on every index-only run,
    // this index holds only runs with rows — which is what bounds the scan.
    .index("by_rows_until", ["rowsUntil"])
    // The weekly simplification pass's gather (convex/ttsSimplify.ts), which
    // needs a time range over EVERY run in the window regardless of host and
    // depth. by_host_depth_started will not do it: it wants equality on host
    // and on depth before it can range on time, so the same read there is a
    // loop over hosts times depths — and depth has no bound, so the loop's
    // bound would be a guess.
    .index("by_started", ["startedAt"]),

  // A RUNNER is one experiment watched by a chain of short step runs on the
  // box. The row owns the handoff document every step starts cold from, the
  // step length, and the lease that admits one step at a time; each step run
  // names the one before it through its `continuesRunId`, so the runner is the
  // chain and nothing is ever re-entered. convex/ttsRunners.ts is its one
  // writer.
  //
  // THERE IS NO STATUS FIELD. runnerStatus() in convex/ttsRunners.ts derives it
  // from endedAt, endedReason and the open blocking asks, and every reader
  // calls that. A stored status is a second copy of those facts that one
  // forgotten write turns false; runners are few, so the list collects and
  // derives instead of reading a status index.
  runners: defineTable({
    title: v.string(),
    type: RUNNER_TYPE,
    subject: v.optional(v.union(
      v.object({ kind: v.literal("todo"), todoId: v.id("dtsTodos") }),
      v.object({ kind: v.literal("batch"), batchId: v.id("batches") }),
    )),
    // Where the experiment runs. The runner itself always runs on the box.
    experimentHost: v.union(v.literal("turing"), v.literal("box")),
    repo: v.string(),
    ref: v.optional(v.string()),
    stepMs: v.number(),
    // When the next step is due. THE TRUTH about the schedule: the scheduled
    // call that opens a step is only its prompt, and the one-minute sweep
    // opens any step this field says is overdue.
    nextStepAt: v.number(),
    // Absent means free. A step holds it from its claim to its check-in; one
    // past its deadline is a step that died, and the sweep clears it.
    lease: v.optional(v.object({ stepRunId: v.string(), deadline: v.number(), takenAt: v.number() })),
    budgetGpuHours: v.optional(v.number()),
    // What one launch may ask for; absent is RUNNER_CEILING_DEFAULT
    // (convex/ttsShared.ts). Set at creation on Tom's own form only, and
    // after that moved only by Tom's reply (recordRunnerReply in convex/ttsRunners.ts).
    ceiling: v.optional(RUNNER_CEILING),
    // The sweep specs the experiment drains, as glob patterns relative to the
    // repo (`sweeps/train/train25_*.yaml`). The step's sensor expands them to
    // CMT's build frontier to count what is done and what remains; absent,
    // the facts block says the frontier was not counted.
    specs: v.optional(v.array(v.string())),
    model: v.optional(SESSION_MODEL),
    delegateAllowed: v.boolean(),
    askOverrides: v.optional(v.array(v.object({ tier: RUNNER_TIER, answerer: RUNNER_ANSWERER }))),
    document: v.string(),
    documentVersion: v.number(),
    createdBy: v.union(v.object({ kind: v.literal("tom") }), v.object({ kind: v.literal("run"), runId: v.string() })),
    createdAt: v.number(),
    endedAt: v.optional(v.number()),
    endedReason: v.optional(RUNNER_ENDED_REASON),
  })
    // The sweep's due walk.
    .index("by_next_step", ["nextStepAt"])
    // The page's newest-first list.
    .index("by_created", ["createdAt"])
    // Live runners are the ones with no endedAt.
    .index("by_ended", ["endedAt"]),

  // What a runner said and was told. ITS OWN TABLE, NOT A dtsEvents KIND, for
  // four reasons. dtsEvents.key's comment enumerates exactly which kinds set it,
  // and the enumeration is what keeps that field honest; five runner kinds would
  // make it a register of two systems. An unanswered blocking ask is read on
  // every step admission and must be indexed, and dtsEvents.data is v.any(),
  // which no index reaches. An ask is patched when Tom answers, and dtsEvents is
  // append-only but for consumedAt. And a ten-minute runner writes 144 rows a
  // day, which would crowd the windows the hourly and the digest read by kind.
  //
  // A `document` event holds each rewrite of the handoff document, so the
  // document is versioned in the record and never in a repository.
  runnerEvents: defineTable({
    runnerId: v.id("runners"),
    at: v.number(),
    kind: v.union(
      v.literal("check-in"), // one per step, always
      v.literal("ask"), // a ruling requested
      v.literal("reply"), // Tom's answer, from a runner's thread; a ceiling ruling adds data.ceiling { from, to }
      v.literal("step-failed"), // an expired lease, or a step that exited without checking in
      v.literal("document"), // a document rewrite; `text` holds the new document
      // One launch or cancel on the experiment, recorded by the step pen beside
      // the check-in; `data` holds { verb, jobId }, `text` what it was for and
      // how it was verified. turing-api keeps the independent server-side log.
      v.literal("act"),
    ),
    stepRunId: v.optional(v.string()),
    text: v.optional(v.string()),
    decision: v.optional(RUNNER_DECISION),
    tier: v.optional(RUNNER_TIER),
    blocking: v.optional(v.boolean()),
    answeredAt: v.optional(v.number()),
    answerText: v.optional(v.string()),
    slackTs: v.optional(v.string()),
    graded: v.optional(v.object({
      verdict: v.union(v.literal("pass"), v.literal("fail")),
      complaints: v.array(v.string()),
      attempts: v.number(),
      judgeModel: v.string(),
    })),
    data: v.optional(v.any()),
  })
    .index("by_runner_at", ["runnerId", "at"])
    .index("by_runner_kind_at", ["runnerId", "kind", "at"])
    // The blocking-ask read: this runner's asks with no answeredAt.
    .index("by_open_ask", ["runnerId", "kind", "answeredAt"]),

  // A step request the box claims, modelled on runMaterializeRequests below and
  // bound by its rule: THE QUEUE IS DRAINED BY ANSWERS, NOT BY ATTEMPTS. A step
  // the box cannot launch is written `failed` with a fixed reason. The
  // `environment` literal is what keeps a step out of the fleet's autonomous
  // caps: it is not a session and writes no claudeSessions row.
  runnerSteps: defineTable({
    runnerId: v.id("runners"),
    environment: v.literal("runner"),
    dueAt: v.number(),
    status: v.union(v.literal("requested"), v.literal("claimed"), v.literal("done"), v.literal("failed")),
    // The step run's id, minted at claim; the box starts the run under it.
    stepRunId: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    // A fixed phrase, never a transcript excerpt.
    reason: v.optional(v.string()),
    // Becomes the step run's continuesRunId.
    previousStepRunId: v.optional(v.string()),
    // The sensor's facts block (worker/agents/runner-sensor.mjs), posted by the
    // daemon before the model starts. The check-in copies it from here, never
    // from the step's own pen, so a step cannot restate its own numbers.
    facts: v.optional(v.any()),
  })
    .index("by_status_due", ["status", "dueAt"])
    .index("by_runner_due", ["runnerId", "dueAt"]),

  // ── THE ORCHESTRATOR (Tom, 2026-09-21; convex/orchestrator.ts is the one
  // writer of the four tables below) ─────────────────────────────────────────
  //
  // ONE ROW, keyed by the constant "jarvis". The orchestrator is a chain of
  // long-lived hosted runs, each a claudeSessions row the daemon hosts; when
  // one asks to compact, crashes or loses its lease, the next starts cold from
  // `document`, naming the last as its continuesRunId. Nothing re-enters a
  // dead run.
  orchestrators: defineTable({
    key: v.literal("jarvis"),
    // The model of the live run, chosen at each start (orchestratorModel):
    // Astra if the box's Codex CLI lists it, else gpt-5.6-sol, else Fable.
    model: SESSION_MODEL,
    // Why that model, in words, so the choice can be read later.
    modelReason: v.string(),
    // Markdown, versioned in orchestratorDocuments; never in a repository.
    document: v.string(),
    documentVersion: v.number(),
    liveSessionId: v.optional(v.id("claudeSessions")),
    // The live run's lease. The daemon renews it on every poll that says it
    // holds the session; one past its deadline is a run that died unseen.
    leaseDeadline: v.optional(v.number()),
    startedAt: v.number(),
    runStartedAt: v.number(),
    // Consecutive crashes: the backoff exponent. A compaction clears it.
    crashes: v.number(),
    // When the next run may start after a crash; absent means now.
    restartAt: v.optional(v.number()),
    lastRestart: v.optional(v.object({ at: v.number(), reason: v.string(), fromSessionId: v.optional(v.id("claudeSessions")) })),
    // The instruction Tom started it with, carried into every run of the chain
    // until the next start replaces it: a run that crashes before writing its
    // document must not lose what it was asked to do.
    instruction: v.optional(v.string()),
    // Messages for the orchestrator that arrived while its latest run was one
    // Tom had reopened, so no run of its own could hold them; the next run's
    // opener carries them and clears this.
    mailbox: v.optional(v.array(v.string())),
    // How many of the mailbox's messages the live run's opener carried; they
    // leave the mailbox once that run finishes its opener.
    carriedCount: v.optional(v.number()),
    // Set by a stop: nothing restarts it until the next start.
    stoppedAt: v.optional(v.number()),
    stoppedReason: v.optional(v.string()),
  }).index("by_key", ["key"]),

  // Every rewrite of the orchestrator's document, so it is versioned in the
  // record the way a runner's is.
  orchestratorDocuments: defineTable({
    version: v.number(),
    text: v.string(),
    sessionId: v.optional(v.id("claudeSessions")),
    at: v.number(),
  }).index("by_version", ["version"]),

  // Which claudeSessions rows the daemon HOSTS as long-lived unattended runs,
  // and as what: the orchestrator's runs and the workers it spawned. Its own
  // table rather than a field on claudeSessions, whose lifecycle fields are
  // aliases due for deletion (spec §24.1). The poll reads it to tell the
  // daemon a row's environment.
  hostedRuns: defineTable({
    sessionId: v.id("claudeSessions"),
    environment: v.union(v.literal("orchestrator"), v.literal("worker")),
    // For a worker: the orchestrator run that spawned it.
    spawnedBy: v.optional(v.id("claudeSessions")),
    todoId: v.optional(v.id("dtsTodos")),
    createdAt: v.number(),
  })
    .index("by_session", ["sessionId"]),

  // A decision a hosted worker raised to the orchestrator: the question and
  // its two sides, never a recommendation. The orchestrator judges its kind
  // and answers; the answer is delivered into the worker as a message.
  elevations: defineTable({
    workerSessionId: v.id("claudeSessions"),
    question: v.string(),
    sides: v.array(v.string()),
    todoId: v.optional(v.id("dtsTodos")),
    // A run it concerns, when that is not the worker itself.
    concernsRunId: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("waiting-on-tom"), v.literal("answered")),
    kind: v.optional(DECISION_KIND),
    answer: v.optional(v.string()),
    answeredBy: v.optional(v.union(v.literal("orchestrator"), v.literal("delegate"), v.literal("tom"))),
    answeredAt: v.optional(v.number()),
    askId: v.optional(v.string()),
    // The orchestrator's recommendation, on a reserved decision only.
    recommendation: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_worker_status", ["workerSessionId", "status"])
    .index("by_status", ["status", "createdAt"])
    // The elevation one delegate ask answered, for his objection to that ask
    // when it closed on the fallback and wrote no ruling to look it up by.
    .index("by_ask", ["askId"]),

  // Tom presses one control and a box job serves it: Convex holds no S3 reader
  // credential and no second request signer, so opening an old run is a
  // request the box picks up, not an action reading the bucket. THE QUEUE IS
  // DRAINED BY ANSWERS, NOT BY ATTEMPTS — a request the box cannot serve is
  // written `failed` with a fixed reason, or one unreachable object takes the
  // head of the queue forever and nothing behind it is ever served.
  runMaterializeRequests: defineTable({
    runId: v.string(),
    requestedBy: v.union(v.literal("tom"), v.literal("worker")),
    requestedAt: v.number(),
    status: v.union(v.literal("pending"), v.literal("served"), v.literal("failed")),
    servedAt: v.optional(v.number()),
    // What the box answered. `reason` is a fixed phrase, never a transcript excerpt.
    reason: v.optional(v.string()),
    rowsIngested: v.optional(v.number()),
    fromLine: v.optional(v.number()),
    toLine: v.optional(v.number()),
    slice: v.number(), // 1-based; a continuation of the same run carries the next number
  })
    // The server takes the oldest pending request; the page reads one run's latest.
    .index("by_status_requestedAt", ["status", "requestedAt"])
    .index("by_run_requestedAt", ["runId", "requestedAt"]),

  // One immutable row per verified store version. A growing run can produce
  // several versions between nightly writes, so the mutable runs.file field
  // cannot be the manifest's source without losing those intermediate facts.
  runFileVersions: defineTable({
    runId: v.string(),
    // The CLI family, as on the run row.
    cli: v.union(v.literal("claude"), v.literal("codex")),
    host: v.union(v.literal("laptop"), v.literal("box")), threadId: v.string(),
    depth: v.number(), parentRunId: v.optional(v.string()),
    fileVersion: v.string(), storeKey: v.string(), sourceHash: v.string(),
    rawBytes: v.number(), storedBytes: v.number(), parserVersion: v.string(),
    runtimeVersion: v.optional(v.string()), startedAt: v.number(), lastLineAt: v.number(),
    at: v.number(),
  })
    // Ingest retries identify the already-recorded immutable version.
    .index("by_run_id_and_file_version", ["runId", "fileVersion"])
    // The manifest checkpoint is the full ordered tuple, so equal-millisecond
    // versions resume after the exact last line already appended.
    .index("by_at_and_run_id_and_file_version", ["at", "runId", "fileVersion"]),

  // Labels are events: a run can receive several judgments from distinct
  // channels, so this is deliberately not a mutable field on runs.
  runLabels: defineTable({
    runId: v.string(), rowSpan: v.optional(v.object({ seqStart: v.number(), seqEnd: v.number() })),
    source: v.union(v.literal("ruling"), v.literal("objection"), v.literal("session-reply"), v.literal("digest-reaction")),
    // Always "tom". The writer refuses any other value: a label is what TOM
    // did about a run's output, and an agent writing a label about another
    // agent's output would put an unreviewed verdict into the corpus the
    // golden set is mined from — the one thing the evals layer exists to
    // avoid. A non-Tom actor, if it is ever wanted, is a ruling of his.
    actor: v.string(), polarity: v.union(v.literal("good"), v.literal("bad"), v.literal("mixed"), v.literal("neutral")),
    // Plain present-tense text with no id, date, quote mark or citation in it —
    // the two-records rule, applied here because `meaning` is read on the run
    // page and becomes an eval case's rubric. The ids live in `ref` and in the
    // row's own fields.
    meaning: v.string(), judgment: v.boolean(),
    // REQUIRED, and narrowed from optional deliberately. Every label has one
    // act behind it and idempotency needs that act's key: Slack delivers at
    // least once, and a ruling written twice by two doors must make ONE label.
    // Narrowing a field is normally refused while a writer exists — this table
    // had no writer and no row when the narrowing was made, so it was free.
    ref: v.string(), at: v.number(),
  })
    // The agent page reads Tom's words oldest first.
    .index("by_run_at", ["runId", "at"])
    // Eval extraction reads a source's labels over time.
    .index("by_source_at", ["source", "at"])
    // Idempotency on the act, and the point lookup a removed reaction deletes
    // through.
    .index("by_ref", ["ref"]),

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
    // Who wrote a user-turn: "tom" for a turn Tom typed (the browser door, or
    // a Slack reply the events route verified came from TOM_SLACK_USER_ID),
    // "agent" for the CLI pen and the code-built opener. A row from before
    // the field has no author and counts as not Tom.
    //
    // Only a "tom" row can be the source of a ruling written from his words
    // (ruling 15, ttsRulings.internalRecordRulingFromTomWords); the other two
    // values are refused there, so an agent cannot author its own ruling.
    author: v.optional(v.union(v.literal("tom"), v.literal("agent"))),
    status: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("done"),
      v.literal("interrupted"),
      v.literal("failed"),
    ),
    createdAt: v.number(),
    deliveredAt: v.optional(v.number()),
  })
    .index("by_session_status", ["sessionId", "status"])
    // The nightly learning step reads ONE author's turns over one day
    // (convex/ttsNightly.ts). Without this index it took N rows off the
    // creation-time index and filtered them afterwards, which silently
    // dropped Tom's turns on any day the agents wrote more than N rows —
    // and the agents write most of them.
    .index("by_author", ["author"]),

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
    // Codex account usage, read off the Codex CLI by the daemon and reported
    // with the heartbeat. The scheduler's weekly gate reads it: at or past
    // CODEX_WEEKLY_CAP_PERCENT (ttsShared) the fleet starts no Codex session.
    // The five-hour figure is recorded but NOT gated on (Tom, 2026-09-04) —
    // that window refills by itself while the week does not — and it is
    // absent when the account reports no five-hour window at all (codex-cli
    // 0.153 on a "prolite" plan reports only the weekly one). `readAt` is the
    // instant the reading was TAKEN, not the instant it was reported: the
    // daemon keeps resending its last successful reading unchanged while later
    // reads fail, so an old readAt means "nobody has managed to ask Codex for a
    // while". Absent usage and usage older than CODEX_USAGE_STALE_MS
    // (ttsShared) are both UNKNOWN, and unknown admits, so a daemon that cannot
    // read the CLI never silently freezes the fleet.
    codexUsage: v.optional(
      v.object({
        weeklyUsedPercent: v.number(),
        fiveHourUsedPercent: v.optional(v.number()),
        weeklyResetsAt: v.optional(v.number()),
        readAt: v.number(),
      }),
    ),
    // The model slugs the box's Codex CLI lists (`codex debug models`),
    // reported by the daemon. convex/orchestrator.ts picks the orchestrator's
    // model from it; absent means no daemon has reported one.
    codexModels: v.optional(v.array(v.string())),
    // Whether Fable answers on the box, from the daemon's heartbeat
    // (ttsShared FABLE_AVAILABILITY): "Fable unavailable since <since>, last
    // checked <checkedAt>" while the model ceiling is in force.
    fableAvailability: v.optional(FABLE_AVAILABILITY),
    // The latest usage limit a Claude session hit that was not a Fable
    // refusal (ttsShared USAGE_LIMIT_REPORT), from the daemon's heartbeat.
    usageLimit: v.optional(USAGE_LIMIT_REPORT),
  }),

  // Autonomous-fleet admission config (P3, ratified 2026-08-28). Singleton via
  // .first() (the gpuPoolStatus pattern). Load-based admission is the PRIMARY
  // throttle (Tom's ruling: no scalar cap as primary) — maxLiveAutonomous is a
  // runaway failsafe only, maxNewPerTick bounds a clone burst. When no row
  // exists the scheduler uses defaults with enabled FALSE, so nothing runs
  // until the switch is deliberately on.
  //
  // THE FOUR NUMBERS ARE CODE-OWNED (the lifeos update, phase 7): their values
  // live in claudeSessions.AUTO_DEFAULTS, no door writes them any more (both
  // pens copy the constants in), and getAutoConfig answers with the constants
  // whatever the row holds.
  //
  // THE COLUMNS DID NOT NARROW WITH THE REST OF PHASE 7, and this is why: the
  // SCHEDULER still reads the row's copies (`{ ...AUTO_DEFAULTS, ...row }` in
  // internalAutoSchedule), so a row written before the numbers became
  // code-owned still steers real admission until the switch is next pressed —
  // while the page, reading the same config through getAutoConfig, shows the
  // constants. That disagreement is a bug to settle on its own terms, not
  // under cover of a schema narrow: closing it changes which sessions the
  // fleet admits. It is also the lever ~35 scheduler tests use to steer
  // admission (one clone per tick, one live session at a time), which is the
  // coverage that would have to be rebuilt first.
  claudeAutoConfig: defineTable({
    enabled: v.boolean(),
    maxLoadPerCpu: v.number(), // admit while loadavg1 / cpus <= this
    minFreeMemMb: v.number(), // admit while freeMemMb >= this
    maxLiveAutonomous: v.number(),
    maxNewPerTick: v.number(),
    // The fleet default model: what an autonomous session runs on when the
    // todo it claimed named no model of its own. Absent reads as
    // DEFAULT_SESSION_MODEL (ttsShared), which is the strongest Codex model.
    defaultModel: v.optional(SESSION_MODEL),
    updatedAt: v.number(),
  }),

  // The /secrets mailbox (convex/secrets.ts). One row per variable name. Tom
  // sets `value` on the page; the session-host daemon takes it through
  // GET /sessions/secrets, writes NAME=value into the box's env file and
  // answers POST /sessions/secrets/taken, which deletes `value` and stamps
  // `takenAt`. So `value` is present only while a delivery is waiting, and
  // the row that stays behind holds the name and the two dates, nothing else.
  secretMailbox: defineTable({
    name: v.string(),
    value: v.optional(v.string()),
    setAt: v.number(),
    takenAt: v.optional(v.number()),
  }).index("by_name", ["name"]),
});
