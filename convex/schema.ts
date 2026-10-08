import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
// The stored form of "which model does this run on". ONE HOME (ttsShared.ts):
// the name implies its FAMILY, and the family is what picks the runner on the
// Jarvis Box — Claude's Agent SDK or OpenAI's Codex CLI.
import {
  READINESS,
  SESSION_LOGIN,
  SESSION_MODEL,
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

  // THE ONE RECORD (night/s3, 2026-09-26; the target shape of the 2026-09-26
  // program): every Jarvis row that is not a todo, a ruling, a calendar row, a
  // repeat, a vocabulary entry or a transcript row is an event
  // here. What happened (kind), when (at), who (provenance), about what
  // (subject), the facts (data) and optional display text (text). The kinds are
  // the closed list in shared/jarvis-events.mjs; the writer is
  // convex/jarvis/events.ts recordEvent, behind POST /jarvis/event and the
  // Convex-internal reporters; the readers are GET /jarvis/events and the
  // /agents page. dtsEvents (below) is the previous generation's table: the
  // kinds it still owns are copied here as they arrive through POST
  // /tts/event (copyDtsRow), so this table shows one list, and each area
  // moves its kinds to the new route in its own stream, after which dtsEvents
  // goes.
  //
  // WHY `provenance` IS AN OBJECT AND `subject` A STRING: a reader asks two
  // questions of the record, "what did THIS agent/job do" and "what happened
  // to THIS thing", and each is one index below. `data` is v.any(); only
  // by_kind_standing_at reaches its standingSince field, so any other fact a
  // reader filters on must be one of the fields here.
  events: defineTable({
    kind: v.string(),
    at: v.number(),
    provenance: v.object({
      agentId: v.optional(v.string()),
      job: v.optional(v.string()),
      session: v.optional(v.string()),
      user: v.optional(v.string()),
    }),
    // A todo id, `<repo>@<sha>`, a repo, a session id, or the condition a
    // job report names (`poll-canvas:canvas-auth`).
    subject: v.optional(v.string()),
    data: v.any(),
    // Optional display text; absent means a reader derives it from kind and
    // data, or leaves the row out.
    text: v.optional(v.string()),
  })
    .index("by_at", ["at"])
    .index("by_kind_at", ["kind", "at"])
    .index("by_subject_at", ["subject", "at"])
    // One job's rows of one kind, newest first: the silence alarm's read of
    // its last `job-ok`. Named separately from by_kind_at because a scan of
    // every job's heartbeats to find one job's is what an index is for.
    .index("by_kind_job_at", ["kind", "provenance.job", "at"])
    // One job's rows of one kind in the order the record received them (the
    // index ends in _creationTime): convex/jarvis/partStates.ts reads a job's
    // last-received job-ok by it, where a writer's `at` may lie.
    .index("by_kind_job", ["kind", "provenance.job"])
    // One agent's rows: the /agents chat draws them among the transcript.
    .index("by_agent_at", ["provenance.agentId", "at"])
    // One agent's rows of one kind: the /agents chat's box changes
    // (convex/boxChanges.ts forAgent), which a filter over by_agent_at would
    // find only by reading every other row that agent wrote.
    .index("by_kind_agent_at", ["kind", "provenance.agentId", "at"])
    // One condition's rows of one kind: the jobs area's standing check (a
    // job-failed not closed by a later job-recovered under the same subject)
    // and a read of one condition, without a scan of every job's
    // failures (convex/jarvis/jobs.ts).
    .index("by_kind_subject_at", ["kind", "subject", "at"])
    // One subject's rows of one kind in the order the record inserted them:
    // Convex ends every index with the row's _creationTime, the server's clock
    // at insert, so this one orders and bounds by receipt whatever `at` a
    // writer gave. The newest todo-state and handoff on a todo
    // (convex/jarvis/build.ts) is the one written last, so a backdated handoff
    // still becomes the head of the todo's chain; and convex/jarvis/partStates.ts
    // reads a part's use and issue rows by it.
    .index("by_kind_subject", ["kind", "subject"])
    // One kind's rows that are not a standing condition's repeat (a
    // job-failed posted while its condition stands carries
    // data.standingSince): a read of the failures that opened a
    // condition, which a window of one job's repeats must not crowd out
    // (convex/jarvis/jobs.ts failuresInWindow).
    .index("by_kind_standing_at", ["kind", "data.standingSince", "at"])
    // One kind's row by the writer's own id for it: the lookup that finds
    // a retry of a kind in shared/jarvis-events.mjs REPEATS_BY_DATA_ID
    // (convex/jarvis/events.ts recordEvent), and of a standing ruling
    // (convex/jarvis/rulings.ts recordStanding).
    .index("by_kind_data_id", ["kind", "data.id"])
    // One scope's standing rulings, newest first: the ask reader's
    // (convex/jarvis/rulings.ts standingRulings). data.standing is in the
    // index so a superseded ruling is never read, however many there are.
    .index("by_kind_subject_standing_at", ["kind", "subject", "data.standing", "at"])
    // Superseded rulings in the order they were ended, on their own index so
    // no other kind's rows can crowd one out.
    .index("by_kind_standing_superseded_at", ["kind", "data.standing", "data.supersededAt"])
    // One kind's rows by when the record wrote them (_creationTime, which ends
    // every index), however long after they happened.
    .index("by_kind", ["kind"]),

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
  // record). Single-user by design: every function in
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

  // ── Batches went on 2026-09-24 (Tom: "I dont want to have batches at all
  // anymore") and their table on 2026-09-26; the 198 rows are in WikiTom
  // tts/snapshot/batches.jsonl.

  dtsTodos: defineTable({
    statement: v.string(),
    body: v.optional(v.string()),
    // RETIRED with Slack and the digest (tom.quest 392): the morning message
    // and the hourly line that read it are gone and nothing writes it. It
    // stays declared until the rows that carry it are cleared (the table
    // sweep that follows the removals), because convex deploy refuses a
    // stored field the schema does not declare.
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
    // The plain table's rollover mark (todos.rolledOverDueAt), declared here
    // so jarvis/tables.ts copyBack, which copies every field, can copy a row
    // that carries it. Nothing reads it on this table, and the rollover that
    // wrote it went with the digest (tom.quest 392).
    rolledOverDueAt: v.optional(v.number()),
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
    // ("chores", …). Free string.
    category: v.optional(v.string()),
    // (Batches v1, ratified 2026-08-28, is gone from here: `members` — the one
    // field that made a dtsTodos row a batch — and `plan`, its ordered
    // completion steps, were NARROWED out after
    // ttsMigrations.internalClearRetiredFields took both off every row on prod
    // and a second run reported zero. What each row SAID is on record as a
    // `retired-field-cleared` dtsEvents row. The lifeos update, phase 7. The
    // v2 batch that replaced it, its own `batches` row with todos pointing
    // back at it by batchId, went in turn on Tom's ruling of 2026-09-24.)
    // Stamped by the Tom doors (updateTodo, setStatus, the ruling life path,
    // the pens). A row with this set is FROZEN: the planner
    // (tts.internalStorePlanGraph) may never rewrite or retire it.
    tomTouchedAt: v.optional(v.number()),
    // "manual" | "consolidation" | "email" | "session-sweep"
    // | "prospecting" | … Each name means ONE fact: the two Canvas producers
    // are "canvas" (assignments, convex/ttsCanvas.ts) and "canvas-announcement"
    // (worker/jobs/poll-canvas.mjs), never one shared name.
    source: v.string(),
    provenance: v.optional(v.string()), // link/descriptor of where it came from
    // RETIRED with Slack and the digest (tom.quest 392): the #dump capture
    // and its one threaded reply are gone and nothing writes these four. They
    // stay declared until the rows that carry them are cleared (the table
    // sweep that follows the removals), because convex deploy refuses a
    // stored field the schema does not declare.
    slackChannel: v.optional(v.string()),
    slackTs: v.optional(v.string()),
    slackReplyTs: v.optional(v.string()),
    slackRepliedAt: v.optional(v.number()),
    workDescription: v.optional(v.string()), // qualitative, never a numeric estimate (spec §5.3)
    entryAction: v.optional(v.string()), // the one-click smallest next action (spec §13)
    brief: v.optional(v.string()), // ground-up brief, markdown
    // The registration token of the run that wrote the four prepared fields
    // above. Same field name and same meaning as on batches; see the note on
    // batches.producedByRunToken.
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
    // Dependency edges: this todo is READY only once every id here is done
    // (done or archived both count — ttsShared.buildDoneSet). Bounded at
    // MAX_NEEDS (ttsShared); every id must name a todo in the SAME batch (or a
    // batch-less one), and the graph within a batch must stay acyclic — both
    // enforced on write (tts.internalStorePlanGraph).
    needs: v.optional(v.array(v.id("dtsTodos"))),
    // tasks: who does it. Same meaning as the plan-step actor it succeeds.
    actor: v.optional(v.union(v.literal("tom"), v.literal("agent"))),
    // STAYS DECLARED past the phase-7 narrow: the planner writes it
    // (tts.internalStorePlanGraph), and the session a todo opens runs on it.
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
    // Historic external-subject coordinates, retained on existing rows. They
    // are never resolved through a live code mirror.
    codeRepo: v.optional(v.string()),
    codeExternalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    doneAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    // The dual write's stamp (convex/jarvis/tables.ts, `follow`): a fingerprint
    // of this row's other fields, which its plain copy carries too.
    legacyVersion: v.optional(v.string()),
    // The plain table's fields added since step C, declared here too because
    // the way back, copyBack (convex/jarvis/tables.ts), copies every field of
    // a todo into this table: the reminder and the restart's prior state
    // (todos.reminderAt and todos.beforeArchive, 2026-10-06), and the id of
    // the box's write (todos.writeId). Nothing writes them here otherwise.
    reminderAt: v.optional(v.number()),
    beforeArchive: v.optional(
      v.object({
        at: v.number(),
        status: v.union(
          v.literal("active"),
          v.literal("waiting"),
          v.literal("archived"),
          v.literal("done"),
        ),
        archivedAt: v.optional(v.number()),
      }),
    ),
    writeId: v.optional(v.string()),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"])
    // The dated read: one status's rows by due date, so the open-todos
    // reader (convex/jarvis/todos.ts open) takes the soonest due first
    // without scanning the table. Undated rows sort BEFORE every number in
    // the index, so a range starting at gte("dueAt", 0) reads the dated ones
    // only, and eq("dueAt", undefined) reads the undated ones.
    .index("by_status_and_due", ["status", "dueAt"])
    .index("by_readiness", ["readiness"])
    // Ingestion lookups: the Canvas ASSIGNMENT sync and the repeating-todo
    // generator find their own rows by source ("canvas" / "repeating") +
    // provenance match, without scanning the whole table. The source alone is
    // never the whole key — a reader that skips the provenance match adopts
    // every other producer's rows under that name.
    .index("by_source", ["source"]),

  // todos: the plain-named home of dtsTodos's rows (the record's core tables,
  // 2026-09-26). Its payload and source indexes match dtsTodos except `needs`
  // points to todos; legacyId and by_legacy preserve lookup by the old id.
  // dtsTodos above empties once convex/jarvis/tables.ts has copied it.
  todos: defineTable({
    statement: v.string(),
    body: v.optional(v.string()),
    // RETIRED with Slack and the digest (tom.quest 392): the morning message
    // and the hourly line that read it are gone and nothing writes it. It
    // stays declared until the rows that carry it are cleared (the table
    // sweep that follows the removals), because convex deploy refuses a
    // stored field the schema does not declare.
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
    // The date the 5 a.m. missed rollover last settled this todo for. That
    // rollover ran inside the digest code and went with the digest (tom.quest
    // 392); nothing writes this field now. The writes that change dueAt still
    // clear it (convex/tts.ts DATE_MOVED). It stays declared because rows
    // carry it (stored data), until those rows are cleared.
    rolledOverDueAt: v.optional(v.number()),
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
    // ("chores", …). Free string.
    category: v.optional(v.string()),
    // (Batches v1, ratified 2026-08-28, is gone from here: `members` — the one
    // field that made a dtsTodos row a batch — and `plan`, its ordered
    // completion steps, were NARROWED out after
    // ttsMigrations.internalClearRetiredFields took both off every row on prod
    // and a second run reported zero. What each row SAID is on record as a
    // `retired-field-cleared` dtsEvents row. The lifeos update, phase 7. The
    // v2 batch that replaced it, its own `batches` row with todos pointing
    // back at it by batchId, went in turn on Tom's ruling of 2026-09-24.)
    // Stamped by the Tom doors (updateTodo, setStatus, the ruling life path,
    // the pens). A row with this set is FROZEN: the planner
    // (tts.internalStorePlanGraph) may never rewrite or retire it.
    tomTouchedAt: v.optional(v.number()),
    // "manual" | "consolidation" | "email" | "session-sweep"
    // | "prospecting" | … Each name means ONE fact: the two Canvas producers
    // are "canvas" (assignments, convex/ttsCanvas.ts) and "canvas-announcement"
    // (worker/jobs/poll-canvas.mjs), never one shared name.
    source: v.string(),
    provenance: v.optional(v.string()), // link/descriptor of where it came from
    // RETIRED with Slack and the digest (tom.quest 392): the #dump capture
    // and its one threaded reply are gone and nothing writes these four. They
    // stay declared until the rows that carry them are cleared (the table
    // sweep that follows the removals), because convex deploy refuses a
    // stored field the schema does not declare.
    slackChannel: v.optional(v.string()),
    slackTs: v.optional(v.string()),
    slackReplyTs: v.optional(v.string()),
    slackRepliedAt: v.optional(v.number()),
    threadMessageId: v.optional(v.string()), // the Jarvis-thread message this todo came from; the capture dedupes on it
    workDescription: v.optional(v.string()), // qualitative, never a numeric estimate (spec §5.3)
    entryAction: v.optional(v.string()), // the one-click smallest next action (spec §13)
    brief: v.optional(v.string()), // ground-up brief, markdown
    // The registration token of the run that wrote the four prepared fields
    // above. Same field name and same meaning as on batches; see the note on
    // batches.producedByRunToken.
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
    needs: v.optional(v.array(v.id("todos"))),
    // tasks: who does it. Same meaning as the plan-step actor it succeeds.
    actor: v.optional(v.union(v.literal("tom"), v.literal("agent"))),
    // The model the planner tagged an agent task with, from the one union in
    // ttsShared (SESSION_MODELS). STORED, AND NO CODE ON MAIN READS OR WRITES
    // IT BY NAME: its writer, the planner's pen tts.internalStorePlanGraph,
    // went with batches (pull request 241), and its reader, the auto-session
    // scheduler's claudeSessions.resolveFleetModel, was deleted by pull
    // request 282. `git grep -nE 'todo\??\.model|resolveFleetModel' -- convex
    // app shared scripts` finds only this comment. Only whole-row copies carry
    // it: `back` (convex/jarvis/tables.ts copyBackRow) into dtsTodos, until
    // pull request 306, and the nightly export. Declared because rows written
    // before then may still carry a tag; a candidate for deletion.
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
    // Historic external-subject coordinates, retained on existing rows. They
    // are never resolved through a live code mirror.
    codeRepo: v.optional(v.string()),
    codeExternalId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    doneAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
    // The row's _id in dtsTodos before the rename (convex/jarvis/tables.ts
    // copies it here), so an id cited in the evidence or a box file
    // a box file still finds its row. Absent on rows written after it.
    legacyId: v.optional(v.string()),
    // The dual write's stamp: the version of the old row this copy was last
    // written from (convex/jarvis/tables.ts, `follow`); it must match it.
    legacyVersion: v.optional(v.string()),
    // ── The todo as the redesign of 2026-10-06 defines it (design section
    // 12.2): text, due, reminder, done. Three of the four were already here
    // under their own names, and keep them: the text is `statement`, the due
    // time is `dueAt`, done is status "done" with `doneAt`. The reminder is
    // new: the time Tom asked to be notified of the todo, epoch ms; absent
    // means no reminder. Every other field above stays declared because the
    // 2,655 rows written before the restart carry them.
    reminderAt: v.optional(v.number()),
    // The id of the write that made the row, when a box session wrote it
    // (convex/jarvis/todos.ts create, from Jarvis `jarvis write todo`): the
    // same on every post of one todo, so a resend after a lost answer finds
    // the row it already wrote instead of making a second.
    writeId: v.optional(v.string()),
    // The state a row was in before the restart archived the whole table
    // (convex/ttsMigrations.ts internalArchiveTodosWhole): when it was
    // archived, its status then, and the archivedAt it had then, if any.
    // Its presence is what makes the archive reversible
    // (internalRestoreArchivedTodos puts status and archivedAt back and
    // clears it) and what makes a re-run skip the row.
    beforeArchive: v.optional(
      v.object({
        at: v.number(),
        status: v.union(
          v.literal("active"),
          v.literal("waiting"),
          v.literal("archived"),
          v.literal("done"),
        ),
        archivedAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_status", ["status", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"])
    // The dated read: one status's rows by due date, so the open-todos
    // reader (convex/jarvis/todos.ts open) takes the soonest due first
    // without scanning the table. Undated rows sort BEFORE every number in
    // the index, so a range starting at gte("dueAt", 0) reads the dated ones
    // only, and eq("dueAt", undefined) reads the undated ones.
    .index("by_status_and_due", ["status", "dueAt"])
    .index("by_readiness", ["readiness"])
    .index("by_batch", ["batchId"])
    // Ingestion lookups: the Canvas ASSIGNMENT sync and the repeating-todo
    // generator find their own rows by source ("canvas" / "repeating") +
    // provenance match, without scanning the whole table. The source alone is
    // never the whole key — a reader that skips the provenance match adopts
    // every other producer's rows under that name.
    .index("by_source", ["source"])
    // The restart's seven (convex/ttsMigrations.ts internalAddRestartTodos):
    // their insert finds the ones already there, and the read-back reads them,
    // by source "manual" and their one provenance line, a range that holds
    // the seven and nothing else however many manual todos accumulate.
    .index("by_source_provenance", ["source", "provenance"])
    .index("by_threadMessageId", ["threadMessageId"])
    .index("by_legacy", ["legacyId"])
    .index("by_writeId", ["writeId"]),

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
  //
  // The plain-named home of the rows dtsRulings held before the rename (the
  // record's core tables, 2026-09-26): legacyId and by_legacy keep lookup by
  // the old id (convex/jarvis/tables.ts resolveId). dtsRulings itself is no
  // longer declared (the table sweep, design section 12.2); its stored rows
  // are deleted by convex/ttsMigrationsSweep.ts.
  rulings: defineTable({
    subjectType: v.union(
      v.literal("life"),
      v.literal("code"),
    ),
    // Either id: a row written before step C of the core tables' move
    // (convex/jarvis/tables.ts) holds its todo's old id, one written since
    // the plain one.
    todoId: v.optional(v.union(v.id("dtsTodos"), v.id("todos"))), // life subjects
    repo: v.optional(v.string()), // code subjects…
    externalId: v.optional(v.string()), // …(repo, externalId)
    verdict: v.union(
      v.literal("approve"),
      v.literal("revise"),
      v.literal("session"),
      v.literal("archive"),
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
    // Absent on every ruling recorded through the UI. A misreading can be
    // objected to; the same row never rules on the same
    // subject twice (checked in ttsRulings.ts, by the index below).
    provenance: v.optional(
      v.object({
        from: v.literal("tom-words"),
        inboundId: v.string(),
        quote: v.string(),
      }),
    ),
    // The row's _id in dtsRulings before the rename (convex/jarvis/tables.ts
    // copied it here), so an id cited in the evidence or
    // a box file still finds its row. Absent on rows written after it.
    legacyId: v.optional(v.string()),
  })
    .index("by_todo", ["todoId"])
    .index("by_repo_external", ["repo", "externalId"])
    .index("by_ruled", ["ruledAt"])
    .index("by_provenance_inboundId", ["provenance.inboundId"])
    .index("by_ask", ["askId"])
    .index("by_legacy", ["legacyId"]),

  // Append-only instrumentation (spec §10) — every surfacing, engagement,
  // queue cycle, status change, and date outcome, recorded from the first
  // hour. Tom-visible. `kind` is a free string by convention ("created",
  // "engaged", "queue-cycled", "status-changed", "date-outcome",
  // "woke", "captured", ...).
  dtsEvents: defineTable({
    at: v.number(),
    kind: v.string(),
    // Either id, as rulings.todoId: old before step C, plain since.
    todoId: v.optional(v.union(v.id("dtsTodos"), v.id("todos"))),
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
    // The lookup key is historical for several retired dtsEvents kinds.
    // Two kinds came from convex/ttsJobs.ts, where the key names a condition on the Jarvis
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
    //                   ask writes nothing and the caller's next run and
    //                   Tom's objection all name one row;
    //   "delegate-objection"
    //                 — the SAME askId, so "what was decided, and did Tom
    //                   object" is two reads one index apart;
    // Two are historic convex/ttsEvals.ts kinds, keyed `<repo>@<sha>`, that
    // nothing writes any more: "evals-request" and "evals-run" (the merge
    // gate's former third check). Evals now land as `eval-run`, keyed by set.
    // Three are the MECHANICAL MERGE GATE (convex/ttsMerge.ts), two of them
    // under the same `<repo>@<sha>`:
    //   "tests-run"   — the Guardrails tests job's own result, recorded once
    //                   per commit so a red run cannot be re-run until it
    //                   flakes green; the one later row is the box's red row
    //                   over a green one for a Jarvis or WikiTom commit, and
    //                   every reader takes the newest;
    //   "audit-verdict"
    //                 — the audit's `VERDICT:` word for that commit, recorded
    //                   once for the same reason;
    //   "merge"       — `<repo>:<sha>` (its own older spelling), so a retried
    //                   report of one merge is one event.
    // and a fourth opens it for WikiTom alone, under the same `<repo>@<sha>`:
    //   "nightly-run" — `WikiTom@<sha>`, posted by the box's nightly job
    //                   through POST /tts/event before it pushes that commit
    //                   straight to WikiTom's main (data { repo, sha, head,
    //                   job }); the night's summary row of the same kind
    //                   carries no key.
    // One is written by the deploy job in Heffnt/Jarvis through POST /tts/event
    // (data { repo, from, to, commits, setupNeeded }):
    //   "deploy"      — `<repo>:<sha>`, the spelling "merge" uses, naming the
    //                   head the box now runs, so one deploy is one event.
    // `data` is v.any() and cannot be indexed, which is why the key is its
    // own field, so a bounded scan is not enough.
    key: v.optional(v.string()),
  })
    .index("by_at", ["at"])
    .index("by_todo", ["todoId", "at"])
    .index("by_todo_kind", ["todoId", "kind", "at"])
    // The row for one thread, event id, producer id or box condition:
    // eq(kind), eq(key) — and with `key` pinned, `at` orders what comes back.
    .index("by_kind_key", ["kind", "key", "at"])
    // One kind over a time range, or newest-first, WHATEVER its rows carry in
    // `key`. This used to be the second shape of by_kind_key, read with `key`
    // pinned to undefined — which was exact only for as long as no row of that
    // kind had a key, and silently dropped every row of a kind that later grew
    // one ("job-failed" did).
    .index("by_kind_at", ["kind", "at"])
    // One delegate caller's asks in a window (convex/ttsAsk.ts callerAsks):
    // an ask row names its caller as data.sessionId or data.job, the other
    // null, so the cap reads only that caller's rows, not every caller's day.
    .index("by_kind_session_at", ["kind", "data.sessionId", "at"])
    .index("by_kind_job_at", ["kind", "data.job", "at"]),

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
    // it began with; false records that it was not yet pushed.
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
  // `rulings`, which is why deleting a row loses nothing.
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

  // The newest commit on main of each repository under the merge gate that the
  // record has accounted for (convex/gateLandings.ts): every commit that
  // arrived after it is a merge row or a report of a landing past the gate.
  // One row per repository, written on the first refresh and moved forward by
  // each refresh that finds main moved.
  gateMainHeads: defineTable({
    repo: v.string(), // a GATED_REPOS name
    sha: v.string(),
    seenAt: v.number(),
  }).index("by_repo", ["repo"]),

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

  // ── Claude Code session surface ──────────────────────────────────────────────
  // CANONICAL DESIGN HOME: WikiTom tts/spec.md §20 (design ratified 2026-08-28;
  // rendering + permission rulings 2026-08-29). These comments carry only what
  // the schema itself needs: Convex IS the stream (the Jarvis Box's session-host
  // daemon persists SDK events via key-authed /sessions/* routes,
  // SESSIONS_WORKER_KEY; the browser renders reactively); the two-tier
  // transcript (claudeMessages rows are FINALIZED, written once, seq-ordered;
  // claudeStreamBuf is the one small live-tail row, ~400ms throttle, a turn's
  // last 16,384 UTF-16 code units); failure honesty is DERIVED at render (heartbeat
  // staleness), never written as a diagnosis.

  claudeSessions: defineTable({
    title: v.string(),
    kind: v.union(
      v.literal("gate"),
      v.literal("focus-item"),
      v.literal("weekly"),
      v.literal("adhoc"),
      v.literal("block"), // works through a SET of items (a category block)
      // A conversation with Tom about his mental health (Tom's ruling
      // 2026-09-25). Opens on no repo, its opener routes the mental-health
      // area subject, and the nightly learning passes leave it alone: the
      // session owns the mental-health page itself.
      v.literal("therapy"),
      // One of the five sessions that live for months (dump, briefer,
      // builder, observer, todo; design section 4.1), named by its title. The
      // sessions page draws them in their own group above the rest.
      v.literal("persistent"),
    ),
    // Either id, as rulings.todoId: old before step C, plain since.
    todoId: v.optional(v.union(v.id("dtsTodos"), v.id("todos"))), // for gate / focus-item sessions
    blockCategory: v.optional(v.string()), // for block sessions: the category worked
    // The CODE subject (the lifeos update, phase 7): a worker mission for
    // Tom's approve or archive ruling on a code todo — an entry in a repo's vqc/todos.yaml, addressed by (repo,
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
    // every ingest; the server drops STATE (never notes) from a payload
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
    // Which Claude login runs this session's replies (ttsShared SESSION_LOGINS),
    // set from the sessions page's login selector. Absent: the login the box
    // holds, as before the field existed.
    login: v.optional(SESSION_LOGIN),
    // Provenance of a "reopen as" (forkSessionAs): the session this one
    // continues on a different model. The fork is a NEW row — a cross-family
    // change cannot resume an SDK session — and this is the only thread back
    // to where its transcript came from.
    forkedFrom: v.optional(v.id("claudeSessions")),
    sdkSessionId: v.optional(v.string()), // set once the SDK reports it; resume key
    // The run this session's CLI file is recorded as (§23). One session is one
    // run; absent until the sweep writes the derivable CLI id.
    runId: v.optional(v.string()),
    // The run this session continues: the old session's run after a reopen,
    // the forked session's run after a "reopen as". The run the ingest records
    // for this session takes it as its own continuesRunId.
    continuesRunId: v.optional(v.string()),
    cwd: v.optional(v.string()), // daemon-reported working dir on the Jarvis Box
    // ── A session the record addresses by its Claude session id ─────────────
    // Written by the SessionStart hook (Jarvis scripts/agent-hook.mjs) for a
    // session the box's session host did not start (Claude Desktop, or a
    // `claude` typed into a shell), keyed by sdkSessionId: where its
    // transcript is, and which client holds it. `client` "desktop": a Desktop
    // process holds it and the host leaves it alone while it is idle;
    // "host": a message was sent from the page, so the host runs the next
    // reply on the transcript (sendMessageFrom sets it). Absent on every row
    // the host created, which the host always holds.
    transcriptPath: v.optional(v.string()),
    client: v.optional(v.union(v.literal("desktop"), v.literal("host"))),
    lastSdkEventAt: v.optional(v.number()), // "last output Xm ago" fact
    // Daemon-owned idempotency floor: an ingest carrying seqs below this is a
    // network retry and is dropped. Monotonic per session.
    nextSeq: v.number(),
    createdAt: v.number(),
    // ── The weekly session's agenda (the lifeos update, phase 8; spec §11) ──
    // Set only on kind "weekly", by the Friday job through POST /tts/session,
    // both removed in the redesign of 2026-10-06; the rows it wrote keep
    // them. `agendaDay` is the YYYY-MM-DD the job ran for. `agendaSubjects` is the todo and batch ids the
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
    // NOTHING WRITES THESE since the prompt stopped expanding pages (night/s7,
    // 2026-09-26): they stay declared, optional, only for the session rows
    // that already carry them, and go with those rows.
    contextExpanded: v.optional(v.array(v.string())),
    contextBytes: v.optional(v.object({
      prefix: v.number(),
      expanded: v.number(),
      fetchable: v.number(),
    })),
  })
    .index("by_status", ["status", "statusChangedAt"])
    // The poll's read of the idle sessions the host holds: an idle Desktop
    // session (client "desktop") is not read at all.
    .index("by_status_client", ["status", "client"])
    .index("by_createdAt", ["createdAt"])
    // The sessions page's list: the most recently active sessions first.
    .index("by_statusChangedAt", ["statusChangedAt"])
    .index("by_kind_agenda_day", ["kind", "agendaDay"])
    // Per-todo session history: powers the "does a live session already
    // reference this todo" exclusion and the scheduler's backoff walk.
    .index("by_todo", ["todoId"])
    // Per-code-subject session history: the scheduler's ceiling on how many
    // worker missions one code todo may draw.
    .index("by_code_subject", ["codeRepo", "codeExternalId"])
    // Joins a live session row to its immutable `runs` record (§23). The
    // record round also wants `by_createdAt`, already declared above.
    .index("by_run_id", ["runId"])
    // The run-file ingest repairs the session link from the CLI's own id.
    .index("by_sdk_session_id", ["sdkSessionId"]),

  // One row per subagent a session dispatched (Claude Code's Agent tool),
  // written by the program that runs the dispatch, never by the agent: the
  // SubagentStart hook (Jarvis scripts/agent-hook.mjs) at its start, the
  // SubagentStop hook when it reports. A subagent still "running" whose
  // parent's process is gone and whose transcript holds no report is resumed
  // by the session host (Jarvis worker/session-host/subagents.mjs), which
  // records the resume here. `agentId` is the CLI's subagent id;
  // `parentSessionId` the parent session's Claude session id; `brief` the
  // prompt it was given, cut to 4 KB.
  subagentRuns: defineTable({
    agentId: v.string(),
    parentSessionId: v.string(),
    transcriptPath: v.string(),
    brief: v.string(),
    state: v.union(
      v.literal("running"),
      v.literal("reported"),
      v.literal("ended-without-report"),
    ),
    login: v.optional(v.string()),
    cwd: v.optional(v.string()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    // The host's resumes: when, how many, and the Claude session id the
    // resumed run writes under (a resumed subagent runs as its own session,
    // so its later lines are in that session's transcript).
    resumedAt: v.optional(v.number()),
    resumeCount: v.optional(v.number()),
    resumedSessionId: v.optional(v.string()),
    resumedTranscriptPath: v.optional(v.string()),
  })
    .index("by_agent_id", ["agentId"])
    .index("by_state", ["state", "startedAt"])
    .index("by_parent", ["parentSessionId", "startedAt"]),

  // A run's transcript — written once per row by the sweep's ingest
  // (agents.internalIngest), out of the run's agent file.
  // `turn` has no UI reader yet; it is kept because transcript structure is
  // knowledge the (planned) session sweep and analysis layers read, and it
  // is cheap to record now and unreconstructible later.
  claudeMessages: defineTable({
    // The run whose agent file the row came from (one transcript path).
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
    content: v.any(), // typed payload per kind; cut at 32KB by the parser (Jarvis worker/agents/cut.mjs)
    // On a tool-result or child-run row, the toolUseId of the tool call it
    // answers (Jarvis worker/agents/ingest.mjs).
    parentToolUseId: v.optional(v.string()),
    // Set when the 32KB cut above fired (lifeos update §1, the transcript
    // principle: a rendered view may be short, the full bytes must stay
    // retrievable). The complete payload lives in claudeMessageOverflow as
    // `chunkCount` ordered chunks under this row's (runId, seq); `sha256` and
    // `byteLength` describe the reassembly, so a reader can check that what
    // comes back is what the sweep stored. Absent = `content` IS the whole
    // payload.
    overflow: v.optional(
      v.object({
        sha256: v.string(),
        byteLength: v.number(),
        chunkCount: v.number(),
      }),
    ),
    // Where in the agent file the row came from. Every row has one: the
    // parser is the only writer (one transcript path, 2026-09-25).
    provenance: v.object({
      fileVersion: v.string(),
      file: v.string(),
      lineStart: v.number(),
      lineEnd: v.number(),
      block: v.number(),
      parserVersion: v.string(),
      sourceKind: v.string(),
    }),
    digest: v.optional(v.string()),
    createdAt: v.number(),
  })
    // A run is ordered by its source cursor (file version, line, block); in
    // phase 2 seq is that cursor's sortable projection.
    .index("by_run_seq", ["runId", "seq"])
    // Kind-scoped reads of a run's rows: the nightly learning's reply context
    // (assistant text around Tom's turn) and the page's check that a turn Tom
    // typed has landed as a user row.
    .index("by_run_kind", ["runId", "kind", "seq"]),

  // The complete payload behind a cut message row, in ordered chunks of ≤256KB.
  // Keyed by (runId, seq) rather than by the message's _id because a chunk may
  // land before its row (POST /agents/overflow; agents.internalIngestOverflow
  // refuses one only when its run is unknown) — seq is the row's identity in
  // its agent file. Chunks rather than file storage: the read side is a QUERY
  // (claudeSessions.getMessageOverflow) and ctx.storage.get is reachable only
  // from an action. A row is stamped only once every chunk it names is there
  // and reassembles to its hash (agents.internalStampOverflow).
  claudeMessageOverflow: defineTable({
    runId: v.optional(v.string()),
    seq: v.number(),
    index: v.number(), // 0-based position; concatenating in order is the payload
    chunkCount: v.number(), // so an incomplete set is visible without the row
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_run_seq_index", ["runId", "seq", "index"]),

  // What the session daemon says about a session that is not a transcript
  // row: the model changed, the workspace was rebuilt, work was preserved or
  // discarded, the time cap fired, a delivery failed. The agent file is the
  // only source of rows, and none of these facts is in it, so they are notes:
  // posted on /sessions/ingest as `notes`, never rows, and drawn on the page
  // between the rows by time. `text` is capped at 1 KB at insert.
  sessionNotes: defineTable({
    sessionId: v.id("claudeSessions"),
    at: v.number(),
    text: v.string(),
  }).index("by_session_at", ["sessionId", "at"]),

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
    // The origin string the run's page carried when the ingest did not
    // recognise it; origin is then "unknown". convex/agents.ts storedOrigin.
    originGiven: v.optional(v.string()),
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
    // When the run ended, epoch ms, and why, from the closed list
    // RUN_END_REASONS (convex/agents.ts). Written only by POST /agents/run-end
    // (agents.internalRecordRunEnd), which the box posts from the end a hook
    // or a launcher saw; the ingest never writes them, so a page swept later
    // cannot take them back. Absent on every run before 2026-10-05 and on any
    // run whose end nothing saw: lastLineAt is then the only measure.
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.union(v.literal("ended"), v.literal("failed"), v.literal("limit"), v.literal("stopped"), v.literal("unknown"))),
    context: v.optional(v.object({
      wikitomCommit: v.optional(v.string()), layersKnown: v.optional(v.boolean()), layersGiven: v.optional(v.array(v.string())), layersDenied: v.optional(v.array(v.string())), skillsOffered: v.array(v.string()), skillsUsed: v.array(v.string()), tools: v.array(v.string()), hooks: v.array(v.string()), cwd: v.optional(v.string()), gitBranch: v.optional(v.string()), gitCommit: v.optional(v.string()), baseInstructionsHash: v.optional(v.string()), entrypoint: v.optional(v.string()), originator: v.optional(v.string()), permissionMode: v.optional(v.string()), contextWindow: v.optional(v.number()),
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
    // todoId: either id, as rulings.todoId: old before step C, plain since.
    todoId: v.optional(v.union(v.id("dtsTodos"), v.id("todos"))), mergeKey: v.optional(v.string()), sessionId: v.optional(v.id("claudeSessions")),
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
    envelopeKey: v.optional(v.string()), abandonedAt: v.optional(v.number()),
    // `totalLines` is the file's whole length, which only a reader that saw the
    // WHOLE file can honestly write: the backlog importer, which parses a
    // stored version and keeps none of its rows.
    // `committedLine` stays "lines that are rows in the record", so the pair
    // `committedLine < totalLines` is exactly "this run's rows are partial".
    file: v.object({ path: v.string(), sourceHash: v.string(), storedHash: v.string(), bytes: v.number(), storedBytes: v.number(), committedLine: v.number(), committedPrefixSha256: v.string(), sidecarStoredHash: v.optional(v.string()), storeKey: v.optional(v.string()), incompleteTail: v.optional(v.boolean()), totalLines: v.optional(v.number()) }),
    ingestedAt: v.number(),
    // Legacy row-window metadata. Ingest still sets it only for runs whose
    // rows are in the record. Row eviction was removed with materialize on
    // 2026-10-07; this field stays until the separate schema migration.
    rowsUntil: v.optional(v.number()),
    // A historic eviction timestamp. Row eviction was removed with materialize
    // on 2026-10-07; this field stays until the separate schema migration.
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
    // Joins a run to the legacy session state row.
    .index("by_session", ["sessionId"])
    // agentLabels.agentForToken turns a row's producedByRunToken into the run that
    // wrote it, on one point lookup inside a mutation's budget.
    .index("by_reg_token", ["regToken"])
    // The nightly manifest walks changed store versions in a stable order.
    .index("by_ingested_at_and_run_id", ["ingestedAt", "runId"])
    // Legacy row-window index. Row eviction was removed with materialize on
    // 2026-10-07; this index stays until the separate schema migration.
    .index("by_rows_until", ["rowsUntil"])
    // The weekly simplification pass's gather (convex/ttsSimplify.ts), which
    // needs a time range over EVERY run in the window regardless of host and
    // depth.
    .index("by_started", ["startedAt"]),

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
    // "digest-reaction" is RETIRED with Slack and the digest (tom.quest 392):
    // nothing writes it. It stays in the union until the rows that carry it
    // are cleared (the table sweep that follows the removals), because convex
    // deploy refuses a stored value outside the union.
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
    // act behind it and idempotency needs that act's key: a ruling written
    // twice by two doors must make ONE label.
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

  // The live tail: ONE row per session. The box's session daemon sends at
  // most 16,384 UTF-16 code units of text (at most 49,152 bytes of UTF-8),
  // and only whole lines while a turn runs; this server does not cap it.
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
    // Who wrote a user-turn: "tom" for a turn Tom typed through the browser
    // door, "agent" for the CLI pen and the code-built opener. A row from before
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
    // Jarvis Box load snapshot, reported with each heartbeat and shown on
    // /agents. (The auto-session scheduler that admitted work on it is gone;
    // its idea is the box's work-queue job.)
    load: v.optional(
      v.object({
        loadavg1: v.number(),
        cpus: v.number(),
        freeMemMb: v.number(),
        totalMemMb: v.number(),
        liveSessions: v.number(),
      }),
    ),
    // codexUsage, codexModels, fableAvailability and usageLimit below are
    // WRITTEN ONLY BY internalPoll AND READ BY NAME BY NOTHING ON MAIN:
    // `git grep -nE 'codexUsage|codexModels|fableAvailability|usageLimit'
    // -- app shared scripts` finds nothing. Two whole-row reads carry them:
    // getDaemonHealth, to /agents, whose code reads only lastSeenAt,
    // lastIngestError and load; and the nightly export. The first three lost
    // their readers by name, the auto-session scheduler and the orchestrator's
    // model choice, in pull request 282; usageLimit has had none since pull
    // request 225 added it. Candidates for deletion.
    //
    // Codex account usage, read off the Codex CLI by the daemon and reported
    // with the heartbeat. The five-hour figure is absent
    // when the account reports no five-hour window at all (codex-cli 0.153 on
    // a "prolite" plan reports only the weekly one). `readAt` is the instant
    // the reading was TAKEN, not the instant it was reported: the daemon keeps
    // resending its last successful reading unchanged while later reads fail,
    // so an old readAt means "nobody has managed to ask Codex for a while".
    codexUsage: v.optional(
      v.object({
        weeklyUsedPercent: v.number(),
        fiveHourUsedPercent: v.optional(v.number()),
        weeklyResetsAt: v.optional(v.number()),
        readAt: v.number(),
      }),
    ),
    // The model slugs the box's Codex CLI lists (`codex debug models`),
    // reported by the daemon; absent means no daemon has reported one.
    codexModels: v.optional(v.array(v.string())),
    // Whether Fable answers on the box, from the daemon's heartbeat
    // (ttsShared FABLE_AVAILABILITY): "Fable unavailable since <since>, last
    // checked <checkedAt>" while the model ceiling is in force.
    fableAvailability: v.optional(FABLE_AVAILABILITY),
    // The latest usage limit a Claude session hit that was not a Fable
    // refusal (ttsShared USAGE_LIMIT_REPORT), from the daemon's heartbeat.
    usageLimit: v.optional(USAGE_LIMIT_REPORT),
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
    // The value's length in characters, kept after the value is deleted so
    // tom.quest/secrets can show what was delivered without showing it.
    //
    // WHY OPTIONAL, and why the rows without it stay. Every row written before
    // this field existed lacks it, and for a taken row the value is already
    // deleted, so its length cannot be recovered. Convex refuses a deploy
    // whose schema requires a field that existing rows lack, so a required
    // field would mean deleting those rows first. They cannot be deleted:
    // each is the page's only record of which names the box holds and when
    // each arrived, which is what the page shows; and a row still waiting
    // holds a value the box has not yet taken. The whole table goes when
    // Bitwarden replaces the secrets page, and this field with it.
    valueLength: v.optional(v.number()),
    setAt: v.number(),
    takenAt: v.optional(v.number()),
  }).index("by_name", ["name"]),

  // One row per branch headed for main of one of the box's own repositories
  // (convex/jarvis/changes.ts): what replaces a pull request. The box's
  // receiving hook opens it on a push of the branch (state checking); the
  // box's gate job writes the checks' outcome on it (blocked, rejected) or the
  // landing (landed). Keyed by repo and branch: a later push of the same
  // branch moves the row to the new head, and a landed row stays as history.
  changes: defineTable({
    repo: v.string(),
    branch: v.string(),
    head: v.string(),
    // main's commit when the head was checked.
    base: v.optional(v.string()),
    author: v.string(),
    // The head commit message's first line, and the rest of it.
    title: v.string(),
    description: v.optional(v.string()),
    // The pusher's "Complex: yes" trailer.
    complex: v.boolean(),
    // When the box received the push of this head (ms), stamped by its
    // receiving hook: the order of two heads of one branch, which their
    // arrival here may not keep.
    pushedAt: v.optional(v.number()),
    // Whether the gate requires the audit for this head, and why.
    auditRequired: v.optional(v.boolean()),
    auditWhy: v.optional(v.string()),
    state: v.union(v.literal("checking"), v.literal("blocked"), v.literal("landed"), v.literal("rejected")),
    // Why blocked or rejected, in words; never content of the change.
    reason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    landedAt: v.optional(v.number()),
  })
    .index("by_repo_and_branch", ["repo", "branch"])
    .index("by_repo_and_branch_and_head", ["repo", "branch", "head"])
    .index("by_repo_and_updatedAt", ["repo", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),
});
