import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTom } from "./authRoles";
import {
  DAY_MS,
  MAX_NEEDS,
  TTS_PREP_NY_HOUR,
  goalCheckable,
  nyCalendarDayBoundsUtc,
  nyCalendarDayKey,
  nyLocalHour,
  nyOffsetHours,
  ttsDayBoundsUtc,
  ttsDayKey,
  ttsPrepDay,
} from "./ttsShared";

// TTS (Delegated Todo System) — life-todo store, instrumentation, daily queue,
// and the code-todo mirror. Spec: WikiTom tts/spec.md. Everything Tom-facing is
// Tom-gated (forge.ts pattern); everything the worker box or crons touch goes
// through internal functions (http.ts routes are key-authed with TTS_WORKER_KEY).

async function requireTomId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  return await requireTom(ctx, "TTS");
}

// One queue size for every producer: the fallback rules here and (mirrored in
// its prompt) the worker's Claude prep, enforced again at intake in
// internalStoreWorkerPrep.
const QUEUE_MAX = 7;

const READINESS = v.union(
  v.literal("unprepared"),
  v.literal("preparing"),
  v.literal("ready-for-tom"),
);
const STATUS = v.union(
  v.literal("active"),
  v.literal("waiting"),
  v.literal("archived"),
  v.literal("done"),
);
const TIMING_CLASS = v.union(
  v.literal("dated"),
  v.literal("condition-bound"),
  v.literal("whenever"),
);
const DATE_KIND = v.union(v.literal("external"), v.literal("self-imposed"));
const DATE_OUTCOME = v.union(
  v.literal("done"),
  v.literal("renegotiated"),
  v.literal("missed"),
);
export const IMPORTANCE_LEVEL = v.union(
  v.literal("low"),
  v.literal("medium"),
  v.literal("high"),
);
// The ONE server-side encoding of importance order: higher = more important,
// unset ranks 0 (below "low"). Lockstep with app/tts/lib.ts IMPORTANCE_RANK —
// the client bundle cannot import this server module, so it carries a copy of
// the same values; change both together.
export const IMPORTANCE_RANK = { low: 1, medium: 2, high: 3 } as const;
// A batch member addresses exactly one subject, in the ttsRulings shape
// (life by todoId, code by repo+externalId) — enforced in validateBatchMembers.
const MEMBER = v.object({
  todoId: v.optional(v.id("dtsTodos")),
  repo: v.optional(v.string()),
  externalId: v.optional(v.string()),
});
const PLAN_STEP = v.object({
  text: v.string(),
  actor: v.union(v.literal("tom"), v.literal("agent")),
  status: v.union(v.literal("open"), v.literal("done")),
  doneAt: v.optional(v.number()),
  evidence: v.optional(v.string()),
});
// ── Schema v2 graph shapes (ratified 2026-08-29) ─────────────────────────────
const ACTOR = v.union(v.literal("tom"), v.literal("agent"));
// Sequencing between batches; `edge` describes the link to the PREVIOUS batch
// in the path. "must" / "helps" are Tom's words and the whole vocabulary.
const BATCH_PATH = v.object({
  name: v.string(),
  index: v.number(),
  edge: v.optional(v.union(v.literal("must"), v.literal("helps"))),
});
// A `needs` reference inside a plan-graph payload: a STRING is an existing
// dtsTodos id; a NUMBER is the index of a task EARLIER in the same payload, so
// a model can lay down a small graph in one call. The two are unambiguous (a
// Convex id is never a bare integer) and the backward-only index rule keeps
// in-payload edges acyclic by construction.
const NEED_REF = v.union(v.string(), v.number());
const GRAPH_TASK = v.object({
  id: v.optional(v.string()), // absent = create
  statement: v.string(),
  actor: ACTOR,
  needs: v.optional(v.array(NEED_REF)),
  condition: v.optional(v.string()),
  groundUpExplanation: v.optional(v.string()),
  evidence: v.optional(v.string()),
  status: v.optional(v.union(v.literal("active"), v.literal("done"))),
  // The model tier this task needs (schema: dtsTodos.model). Absent means the
  // default, which is Opus; the planner tags only the task whose difficulty
  // warrants the stronger model.
  model: v.optional(v.literal("fable")),
});

type Member = { todoId?: Id<"dtsTodos">; repo?: string; externalId?: string };

// Same identity convention as ttsRulings.subjectKey — one vocabulary for
// "which subject is this" everywhere.
export function memberKey(m: Member): string {
  return m.todoId !== undefined
    ? `life ${m.todoId}`
    : `code ${m.repo} ${m.externalId}`;
}

// Array caps (Convex guideline: array fields on a document must be bounded —
// an unbounded array grows a single row without limit). A batch groups 1..20
// subjects; a plan holds at most 40 steps; one plan-graph payload carries at
// most as many tasks as a plan had steps (the graph succeeds the plan).
const MAX_BATCH_MEMBERS = 20;
const MAX_PLAN_STEPS = 40;
const MAX_GRAPH_TASKS = MAX_PLAN_STEPS;

type Importance = {
  level: "low" | "medium" | "high";
  setBy: "tom" | "agent";
  setAt: number;
  rationale?: string;
};

// The ONE implementation of the agent-importance guard (used by
// internalPrepareTodo, internalStoreBatches, and ttsCode.internalStoreBriefs):
// an agent write never overwrites Tom's — returns undefined when the stored
// value has setBy "tom" (the caller logs importance-skipped), else the new
// importance object.
export function agentImportancePatch(
  existing: Importance | undefined,
  level: "low" | "medium" | "high",
  rationale: string | undefined,
  now: number,
): Importance | undefined {
  if (existing?.setBy === "tom") return undefined;
  return { level, setBy: "agent", setAt: now, rationale };
}

// Shared membership gate (updateTodo + internalStoreBatches): every member
// addresses exactly one subject, no duplicates, no batch-in-batch, no batch
// containing itself. Code members are NOT checked against the mirror — mirror
// rows churn on upstream close; a vanished code member renders "closed
// upstream" client-side.
async function validateBatchMembers(
  ctx: QueryCtx | MutationCtx,
  members: Member[],
  opts: {
    selfId?: Id<"dtsTodos">;
    // Callers that already hold a full collect (internalStoreBatches) pass it
    // here so member lookups reuse it instead of per-member ctx.db.get.
    todoById?: Map<Id<"dtsTodos">, Doc<"dtsTodos">>;
  } = {},
) {
  // Bounded arrays (Convex unbounded-array-field guideline): an empty batch
  // is not a grouping, and a batch never exceeds MAX_BATCH_MEMBERS subjects.
  if (members.length === 0) {
    throw new Error("A batch needs at least one member");
  }
  if (members.length > MAX_BATCH_MEMBERS) {
    throw new Error(
      `A batch holds at most ${MAX_BATCH_MEMBERS} members — got ${members.length}`,
    );
  }
  const seen = new Set<string>();
  for (const m of members) {
    const isLife = m.todoId !== undefined;
    const isCode = m.repo !== undefined || m.externalId !== undefined;
    if (isLife === isCode) {
      throw new Error(
        `A member addresses exactly one subject: todoId (life) OR repo+externalId (code) — got ${JSON.stringify(m)}`,
      );
    }
    if (isCode && (m.repo === undefined || m.externalId === undefined)) {
      throw new Error(
        `A code member needs both repo and externalId — got ${JSON.stringify(m)}`,
      );
    }
    const key = memberKey(m);
    if (seen.has(key)) throw new Error(`Duplicate member: ${key}`);
    seen.add(key);
    if (m.todoId !== undefined) {
      if (m.todoId === opts.selfId) {
        throw new Error("A batch cannot contain itself");
      }
      const todo = opts.todoById
        ? opts.todoById.get(m.todoId)
        : await ctx.db.get(m.todoId);
      if (!todo) throw new Error(`Member todo not found: ${m.todoId}`);
      if (todo.members !== undefined) {
        throw new Error(
          `"${todo.statement}" is itself a batch — no batch-in-batch`,
        );
      }
      // A row already inside a schema-v2 batch is owned by that batch. The
      // migration archives the v1 row, which frees its members from the v1
      // occupied map — without this the still-running batcher would re-group
      // the very rows it just migrated, and a todo would sit in a v1 batch and
      // a v2 batch at once.
      if (todo.batchId !== undefined) {
        throw new Error(
          `"${todo.statement}" belongs to a graph batch — a v1 batch never claims a v2 row`,
        );
      }
    }
  }
}

export async function logEvent(
  ctx: MutationCtx,
  kind: string,
  todoId?: Id<"dtsTodos">,
  data?: unknown,
) {
  await ctx.db.insert("dtsEvents", {
    at: Date.now(),
    kind,
    todoId,
    data: data === undefined ? undefined : data,
  });
}

// ── Tom-facing queries ───────────────────────────────────────────────────────

// Inventory: everything, always (spec §6). Single-user table, small for years —
// a full collect is fine and lets the client group/filter freely.
export const listTodos = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("dtsTodos").collect();
  },
});

export const listMirror = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("dtsCodeTodoMirror").collect();
  },
});

// Every batches row (schema v2), for the page's batches tab. The Tom-facing
// twin of internalListBatches: a full collect, because the table holds a few
// dozen rows for years and the client picks its own grouping (paths) and
// filtering (status) out of the whole set.
export const listBatches = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    return await ctx.db.query("batches").collect();
  },
});

// Focus: today's queue row (entries joined with their todos) — null when no
// prep has happened yet today.
export const getToday = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    const day = ttsDayKey(Date.now());
    const row = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (!row) return { day, queue: null };
    const todos = [];
    for (const entry of row.entries) {
      const todo = await ctx.db.get(entry.todoId);
      if (todo) todos.push({ ...todo, queueReason: entry.reason });
    }
    return {
      day,
      queue: {
        preparedAt: row.preparedAt,
        preparedBy: row.preparedBy,
        digestSentAt: row.digestSentAt,
        todos,
      },
    };
  },
});

export const listRecentEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await requireTomId(ctx);
    return await ctx.db
      .query("dtsEvents")
      .withIndex("by_at")
      .order("desc")
      .take(Math.min(limit ?? 200, 1000));
  },
});

// ── Tom-facing mutations ─────────────────────────────────────────────────────

export const createTodo = mutation({
  args: {
    statement: v.string(),
    body: v.optional(v.string()),
    timingClass: v.optional(TIMING_CLASS),
    dueAt: v.optional(v.number()),
    dateKind: v.optional(DATE_KIND),
    condition: v.optional(v.string()),
    latestSafeAt: v.optional(v.number()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    category: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    const now = Date.now();
    const timingClass = args.timingClass ?? (args.dueAt ? "dated" : "whenever");
    const id = await ctx.db.insert("dtsTodos", {
      statement: args.statement.trim(),
      body: args.body,
      readiness: "unprepared",
      status: "active",
      timingClass,
      dueAt: args.dueAt,
      dateKind: args.dueAt ? (args.dateKind ?? "self-imposed") : undefined,
      condition: args.condition,
      latestSafeAt: args.latestSafeAt,
      category: args.category,
      source: "manual",
      workDescription: args.workDescription,
      entryAction: args.entryAction,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "created", id, { source: "manual" });
    return id;
  },
});

// Generic field edit. Only fields present in args change; updatedAt always
// bumps. Status transitions go through setStatus (they carry side effects).
export const updateTodo = mutation({
  args: {
    id: v.id("dtsTodos"),
    statement: v.optional(v.string()),
    body: v.optional(v.string()),
    readiness: v.optional(READINESS),
    timingClass: v.optional(TIMING_CLASS),
    dueAt: v.optional(v.union(v.number(), v.null())),
    dateKind: v.optional(DATE_KIND),
    condition: v.optional(v.string()),
    latestSafeAt: v.optional(v.union(v.number(), v.null())),
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.union(v.number(), v.null())),
    unarchiveCondition: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    brief: v.optional(v.string()),
    category: v.optional(v.union(v.string(), v.null())),
    members: v.optional(v.union(v.array(MEMBER), v.null())),
    plan: v.optional(v.union(v.array(PLAN_STEP), v.null())),
  },
  handler: async (ctx, { id, ...fields }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    // Kept-dates rule (spec §8): a date never just disappears — the silent
    // slide is the one forbidden outcome. Clearing dueAt directly is refused;
    // dates leave via recordDateOutcome (done / renegotiated / missed).
    if (fields.dueAt === null && todo.dueAt !== undefined) {
      throw new Error(
        "A date is never cleared silently — resolve it via recordDateOutcome (renegotiated before the date, or missed)",
      );
    }
    // Bounded arrays (Convex unbounded-array-field guideline): a plan never
    // exceeds MAX_PLAN_STEPS steps.
    if (
      fields.plan !== undefined &&
      fields.plan !== null &&
      fields.plan.length > MAX_PLAN_STEPS
    ) {
      throw new Error(
        `A plan holds at most ${MAX_PLAN_STEPS} steps — got ${fields.plan.length}`,
      );
    }
    // Batch membership: validated per member, then against every OTHER
    // non-terminal batch — a subject lives in at most one (full collect:
    // single-user table).
    if (fields.members !== undefined && fields.members !== null) {
      await validateBatchMembers(ctx, fields.members, { selfId: id });
      const keys = new Set(fields.members.map(memberKey));
      const selfKey = memberKey({ todoId: id });
      const all = await ctx.db.query("dtsTodos").collect();
      for (const other of all) {
        if (other._id === id || other.members === undefined) continue;
        if (other.status !== "active" && other.status !== "waiting") continue;
        for (const m of other.members) {
          if (keys.has(memberKey(m))) {
            throw new Error(
              `${memberKey(m)} is already in batch "${other.statement}"`,
            );
          }
          // The other direction of validateBatchMembers' no-batch-in-batch
          // rule: promoting a row to a batch while it is itself a member of a
          // non-terminal batch would nest batches through the back door.
          if (memberKey(m) === selfKey) {
            throw new Error(
              `"${todo.statement}" is a member of batch "${other.statement}" — no batch-in-batch`,
            );
          }
        }
      }
    }
    const now = Date.now();
    // Every updateTodo edit is a Tom touch — tomTouchedAt marks the row FROZEN
    // to the batcher (internalStoreBatches never rewrites or retires it).
    const patch: Record<string, unknown> = { updatedAt: now, tomTouchedAt: now };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      patch[key] = value === null ? undefined : value;
    }
    // Setting a due date on a whenever item promotes it to dated (spec §5.2);
    // an explicit timingClass in the same call wins.
    if (
      patch.dueAt !== undefined &&
      fields.timingClass === undefined &&
      todo.timingClass === "whenever"
    ) {
      patch.timingClass = "dated";
      if (patch.dateKind === undefined && todo.dateKind === undefined) {
        patch.dateKind = "self-imposed";
      }
    }
    await ctx.db.patch(id, patch);
    await logEvent(ctx, "updated", id, { fields: Object.keys(fields) });
  },
});

// The ONE place an open date resolves as kept when an item completes — called
// by setStatus(done) and recordDateOutcome(done) so the kept-dates side
// effects cannot drift between the two paths (review finding).
function resolveDateAsDone(
  todo: Doc<"dtsTodos">,
  now: number,
  note: string | undefined,
  patch: Record<string, unknown>,
) {
  patch.status = "done";
  patch.doneAt = now;
  if (todo.dueAt !== undefined) {
    patch.dateOutcomes = [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome: "done" as const, recordedAt: now, note },
    ];
    patch.dueAt = undefined;
  }
}

// The ONE implementation of a status transition (spec §5.1) — used by the
// Tom-gated setStatus below, by internalTriage (live sessions applying
// Tom's spoken rulings via `npx convex run`), and by ttsRulings.recordRuling
// (the archive verdict). Nothing is ever deleted: "archived" and "done" are
// the only terminal states, both kept and visible.
export async function applyStatusChange(
  ctx: MutationCtx,
  todo: Doc<"dtsTodos">,
  args: {
    status: "active" | "waiting" | "archived" | "done";
    wakeCondition?: string;
    wakeAt?: number;
    unarchiveCondition?: string;
    note?: string;
  },
) {
  const { status, wakeCondition, wakeAt, unarchiveCondition, note } = args;
  const now = Date.now();
  const patch: Record<string, unknown> = { status, updatedAt: now };
  if (status === "active") {
    // Reopening: stale terminal/sleep facts must not linger on a live item
    // (descriptive-never-evaluative demands the panel state be TRUE).
    patch.doneAt = undefined;
    patch.archivedAt = undefined;
    patch.unarchiveCondition = undefined;
    patch.wakeCondition = undefined;
    patch.wakeAt = undefined;
  }
  if (status === "waiting") {
    patch.wakeCondition = wakeCondition;
    patch.wakeAt = wakeAt;
  }
  if (status === "archived") {
    patch.archivedAt = now;
    patch.unarchiveCondition = unarchiveCondition;
  }
  if (status === "done") {
    // An open date on a completed item resolves as kept (kept-dates rule).
    resolveDateAsDone(todo, now, note, patch);
  }
  await ctx.db.patch(todo._id, patch);
  await logEvent(ctx, "status-changed", todo._id, {
    from: todo.status,
    to: status,
    note,
  });
}

export const setStatus = mutation({
  args: {
    id: v.id("dtsTodos"),
    status: STATUS,
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    await applyStatusChange(ctx, todo, args);
    // Stamped HERE, not in applyStatusChange: internalStoreBatches archives
    // its own batches through applyStatusChange, and an agent action must not
    // stamp a Tom touch (tomTouchedAt freezes the row to the batcher).
    await ctx.db.patch(id, { tomTouchedAt: Date.now() });
  },
});

// Triage from a LIVE session with Tom (the Friday session, or any interactive
// session where he rules out loud and the session agent records it): an
// internal mutation so the agent can apply rulings via `npx convex run
// tts:internalTriage` with the deploy credentials Tom's machine holds. Only
// ever run while Tom is present and ruling — it is his pen, not a policy
// actor. Same status semantics as setStatus (one implementation), plus an
// optional self-imposed date for undated items (dated items keep the
// kept-dates rule: dates move only via recordDateOutcome).
export const internalTriage = internalMutation({
  args: {
    id: v.string(),
    status: v.optional(STATUS),
    dueAt: v.optional(v.number()),
    wakeCondition: v.optional(v.string()),
    wakeAt: v.optional(v.number()),
    unarchiveCondition: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, dueAt, ...rest }) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    if (dueAt !== undefined) {
      if (todo.dueAt !== undefined) {
        throw new Error(
          "Item already has a date — move it via recordDateOutcome (kept-dates rule), not triage",
        );
      }
      await ctx.db.patch(normalized, {
        dueAt,
        dateKind: "self-imposed",
        timingClass: "dated",
        updatedAt: Date.now(),
      });
      await logEvent(ctx, "updated", normalized, { fields: ["dueAt"], via: "triage" });
    }
    if (status !== undefined) {
      const fresh = await ctx.db.get(normalized);
      if (fresh) await applyStatusChange(ctx, fresh, { status, ...rest });
    }
    // Triage is Tom's pen: a Tom touch, so the row is frozen to the batcher —
    // but only when the call actually did something. A no-op/retry pen call
    // must not freeze a batch.
    if (status !== undefined || dueAt !== undefined) {
      await ctx.db.patch(normalized, { tomTouchedAt: Date.now() });
    }
  },
});

// Bulk field edits from a LIVE session with Tom (the internalTriage pattern):
// an internal mutation so the session agent can record Tom's spoken rulings
// via `npx convex run tts:internalBulkUpdate` with the deploy credentials
// Tom's machine holds. Only ever run while Tom is present and ruling — it is
// his pen, not a policy actor; importance therefore lands as setBy "tom"
// (it records his SPOKEN ruling, which the agent guard must respect).
export const internalBulkUpdate = internalMutation({
  args: {
    updates: v.array(
      v.object({
        id: v.string(),
        importanceLevel: v.optional(v.union(IMPORTANCE_LEVEL, v.null())),
        importanceRationale: v.optional(v.string()),
        category: v.optional(v.union(v.string(), v.null())),
        entryAction: v.optional(v.string()),
        workDescription: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { updates }) => {
    for (const u of updates) {
      const normalized = ctx.db.normalizeId("dtsTodos", u.id);
      if (!normalized) throw new Error(`Unknown todo id: ${u.id}`);
      const todo = await ctx.db.get(normalized);
      if (!todo) throw new Error(`Unknown todo id: ${u.id}`);
      const now = Date.now();
      const patch: Record<string, unknown> = { tomTouchedAt: now };
      const fields: string[] = [];
      if (u.importanceLevel !== undefined) {
        patch.importance =
          u.importanceLevel === null
            ? undefined
            : {
                level: u.importanceLevel,
                setBy: "tom",
                setAt: now,
                rationale: u.importanceRationale,
              };
        fields.push("importance");
      }
      let content = false;
      if (u.category !== undefined) {
        patch.category = u.category === null ? undefined : u.category;
        fields.push("category");
        content = true;
      }
      if (u.entryAction !== undefined) {
        patch.entryAction = u.entryAction;
        fields.push("entryAction");
        content = true;
      }
      if (u.workDescription !== undefined) {
        patch.workDescription = u.workDescription;
        fields.push("workDescription");
        content = true;
      }
      // Content edits bump updatedAt; importance alone is an annotation and
      // must not resurface ruled gates (the ruledAt<updatedAt predicate).
      if (content) patch.updatedAt = now;
      await ctx.db.patch(normalized, patch);
      await logEvent(ctx, "bulk-updated", normalized, { fields });
    }
  },
});

// The ONE implementation of the kept-dates rule (spec §8) — used by the
// Tom-gated recordDateOutcome below AND by internalApplyTimeNote (the time-note
// worker acting on Tom's written instruction), so the rule cannot drift between
// the two doors. Every date resolves to done | renegotiated | missed;
// renegotiation is only legal BEFORE the date arrives; the silent slide is the
// one forbidden outcome. "renegotiated" and "missed" both take a newDueAt only
// when the item stays dated ("missed" without a new date drops the item back to
// whenever with the miss on record).
export async function applyDateOutcome(
  ctx: MutationCtx,
  todo: Doc<"dtsTodos">,
  {
    outcome,
    newDueAt,
    note,
  }: {
    outcome: "done" | "renegotiated" | "missed";
    newDueAt?: number;
    note?: string;
  },
) {
  if (todo.dueAt === undefined) throw new Error("Todo has no date to resolve");
  const now = Date.now();
  if (outcome === "renegotiated") {
    if (now >= todo.dueAt) {
      throw new Error(
        "Renegotiation is only allowed before the date arrives — record it as missed, then set a new date",
      );
    }
    if (newDueAt === undefined) {
      throw new Error("Renegotiation requires the new date");
    }
  }
  const patch: Record<string, unknown> = {
    updatedAt: now,
    dateOutcomes: [
      ...(todo.dateOutcomes ?? []),
      { dueAt: todo.dueAt, outcome, recordedAt: now, note },
    ],
  };
  if (outcome === "done") {
    resolveDateAsDone(todo, now, note, patch); // overwrites dateOutcomes consistently
  } else if (newDueAt !== undefined) {
    patch.dueAt = newDueAt;
    if (todo.dateKind === undefined) patch.dateKind = "self-imposed";
  } else {
    patch.dueAt = undefined;
    patch.timingClass = "whenever";
  }
  await ctx.db.patch(todo._id, patch);
  await logEvent(ctx, "date-outcome", todo._id, { outcome, newDueAt, note });
}

export const recordDateOutcome = mutation({
  args: {
    id: v.id("dtsTodos"),
    outcome: DATE_OUTCOME,
    newDueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    await applyDateOutcome(ctx, todo, args);
  },
});

// Tom's importance override (null clears the whole object). An annotation, so
// no updatedAt bump — bumping would resurface ruled gates via the needs-me
// ruledAt<updatedAt predicate. setBy "tom" makes every agent write a no-op
// until cleared (the guard lives in the internal mutations).
export const setImportance = mutation({
  args: {
    id: v.id("dtsTodos"),
    level: v.union(IMPORTANCE_LEVEL, v.null()),
  },
  handler: async (ctx, { id, level }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    const now = Date.now();
    await ctx.db.patch(id, {
      importance:
        level === null ? undefined : { level, setBy: "tom", setAt: now },
      tomTouchedAt: now,
    });
    await logEvent(ctx, "importance-set", id, { level, setBy: "tom" });
  },
});

// Tom checks a plan step off (or reopens it). An annotation like importance:
// tomTouchedAt is stamped, updatedAt is not.
export const setPlanStep = mutation({
  args: {
    id: v.id("dtsTodos"),
    index: v.number(),
    status: v.union(v.literal("open"), v.literal("done")),
  },
  handler: async (ctx, { id, index, status }) => {
    await requireTomId(ctx);
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("TTS todo not found");
    if (todo.plan === undefined) throw new Error("Todo has no plan");
    if (!Number.isInteger(index) || index < 0 || index >= todo.plan.length) {
      throw new Error(`Plan has no step ${index}`);
    }
    const now = Date.now();
    // doneAt: undefined on reopen — an undefined object field is stored as
    // absent, so the stale timestamp clears.
    const plan = todo.plan.map((step, i) =>
      i === index
        ? { ...step, status, doneAt: status === "done" ? now : undefined }
        : step,
    );
    await ctx.db.patch(id, { plan, tomTouchedAt: now });
    await logEvent(ctx, "plan-step", id, { index, status });
  },
});

// ── Blocks: committed time (ratified 2026-08-28) ─────────────────────────────
// One row = one placed span on Tom's calendar, targeting exactly one todo
// (per-todo commitment) or one category ("chores"; "code" = the code-todo
// mirror). Blocks are calendar strokes, not todos — moving or deleting one is
// rescheduling, recorded as an event, never a "ruling".

function requireOneBlockTarget(todoId: unknown, category: unknown) {
  if ((todoId === undefined) === (category === undefined)) {
    throw new Error(
      "A block targets exactly one thing: a todoId OR a category",
    );
  }
}

// Optional [start, end) window: blocks overlapping it (block.start < end AND
// block.end > start), served from the by_start index so the calendar's
// subscription carries one week, not the whole ever-growing table. No args =
// everything (small-table admin/test use).
export const listBlocks = query({
  args: { start: v.optional(v.number()), end: v.optional(v.number()) },
  handler: async (ctx, { start, end }) => {
    await requireTomId(ctx);
    const rows =
      end === undefined
        ? await ctx.db.query("dtsBlocks").collect()
        : await ctx.db
            .query("dtsBlocks")
            .withIndex("by_start", (q) => q.lt("start", end))
            .collect();
    return start === undefined ? rows : rows.filter((b) => b.end > start);
  },
});

// The ONE implementation of each block write (the applyStatusChange pattern) —
// shared by the Tom-gated mutations below and by internalApplyTimeNote, so a
// time note placing a block obeys exactly the same validation as the calendar.

export async function insertBlock(
  ctx: MutationCtx,
  {
    start,
    end,
    todoId,
    category,
    note,
  }: {
    start: number;
    end: number;
    todoId?: Id<"dtsTodos">;
    category?: string;
    note?: string;
  },
) {
  // Trim BEFORE the exactly-one check: a whitespace-only category must not
  // pass the check and then collapse into a targetless block.
  const trimmedCategory = category?.trim() || undefined;
  requireOneBlockTarget(todoId, trimmedCategory);
  if (end <= start) throw new Error("A block ends after it starts");
  if (todoId !== undefined) {
    const todo = await ctx.db.get(todoId);
    if (!todo) throw new Error("TTS todo not found");
  }
  const id = await ctx.db.insert("dtsBlocks", {
    start,
    end,
    todoId,
    category: trimmedCategory,
    note,
    createdAt: Date.now(),
  });
  await logEvent(ctx, "block-created", todoId, {
    start,
    end,
    category: trimmedCategory,
  });
  return id;
}

export async function patchBlock(
  ctx: MutationCtx,
  block: Doc<"dtsBlocks">,
  { start, end, note }: { start?: number; end?: number; note?: string | null },
) {
  const nextStart = start ?? block.start;
  const nextEnd = end ?? block.end;
  if (nextEnd <= nextStart) throw new Error("A block ends after it starts");
  await ctx.db.patch(block._id, {
    start: nextStart,
    end: nextEnd,
    note: note === null ? undefined : (note ?? block.note),
  });
  // block-moved only when the span actually changed — a note-only edit is
  // not a move and must not fake one in the event stream.
  if (nextStart !== block.start || nextEnd !== block.end) {
    await logEvent(ctx, "block-moved", block.todoId, {
      from: { start: block.start, end: block.end },
      to: { start: nextStart, end: nextEnd },
      category: block.category,
    });
  }
}

export async function removeBlock(ctx: MutationCtx, block: Doc<"dtsBlocks">) {
  await ctx.db.delete(block._id);
  await logEvent(ctx, "block-deleted", block.todoId, {
    start: block.start,
    end: block.end,
    category: block.category,
  });
}

export const createBlock = mutation({
  args: {
    start: v.number(),
    end: v.number(),
    todoId: v.optional(v.id("dtsTodos")),
    category: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTomId(ctx);
    return await insertBlock(ctx, args);
  },
});

export const updateBlock = mutation({
  args: {
    id: v.id("dtsBlocks"),
    start: v.optional(v.number()),
    end: v.optional(v.number()),
    note: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, ...args }) => {
    await requireTomId(ctx);
    const block = await ctx.db.get(id);
    if (!block) throw new Error("Block not found");
    await patchBlock(ctx, block, args);
  },
});

export const deleteBlock = mutation({
  args: { id: v.id("dtsBlocks") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    const block = await ctx.db.get(id);
    if (!block) throw new Error("Block not found");
    await removeBlock(ctx, block);
  },
});

// ── Time notes (ratified 2026-08-29) ─────────────────────────────────────────
// The /dts page has no date or time pickers left. Tom writes one sentence
// against exactly one context — a todo, a block, or a calendar day — and the
// worker job apply-time-notes.mjs reads it and asks for concrete actions via
// internalApplyTimeNote. The server re-validates EVERY action against the same
// helpers the Tom-gated mutations use (kept dates, block target/span), so a
// misread note is refused, not silently obeyed; the job then re-submits the
// note as "needs-session" carrying the server's reason.

// How long an applied note stays on the page after it lands (descriptive
// transparency: Tom sees what just happened, then it stops being clutter).
const TIME_NOTE_VISIBLE_MS = 24 * 3_600_000;

function requireOneTimeNoteContext(
  todoId: unknown,
  blockId: unknown,
  day: unknown,
) {
  const set = [todoId, blockId, day].filter((x) => x !== undefined).length;
  if (set !== 1) {
    throw new Error(
      "A time note has exactly one context: a todoId, a blockId, or a day",
    );
  }
}

// A day-scoped note carries the calendar-date LABEL of the column Tom clicked
// ("YYYY-MM-DD"), never a timestamp. The server reads it as a New York calendar
// day (nyCalendarDayBoundsUtc), so the browser's own timezone cannot decide
// which day a note is about.
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

// A day the page could not paint anyway is not worth a range query: an
// unbounded list is capped so one subscription stays one page-worth of rows.
const TIME_NOTE_LIST_MAX = 200;

export const listTimeNotes = query({
  args: {},
  handler: async (ctx) => {
    await requireTomId(ctx);
    const byStatus = (status: "pending" | "needs-session" | "applied") =>
      ctx.db
        .query("dtsTimeNotes")
        .withIndex("by_status_and_resolvedAt", (q) => q.eq("status", status));
    // Applied notes are kept forever (instrumentation); only the last 24h of
    // them ride the page's subscription — hence resolvedAt in the index. The
    // pending/needs-session arms have no time bound of their own, so they take
    // a fixed page instead of collecting an unbounded backlog.
    const cutoff = Date.now() - TIME_NOTE_VISIBLE_MS;
    const [pending, needsSession, recentlyApplied] = await Promise.all([
      byStatus("pending").take(TIME_NOTE_LIST_MAX),
      byStatus("needs-session").take(TIME_NOTE_LIST_MAX),
      ctx.db
        .query("dtsTimeNotes")
        .withIndex("by_status_and_resolvedAt", (q) =>
          q.eq("status", "applied").gte("resolvedAt", cutoff),
        )
        .collect(),
    ]);
    return [...pending, ...needsSession, ...recentlyApplied];
  },
});

export const createTimeNote = mutation({
  args: {
    text: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    blockId: v.optional(v.id("dtsBlocks")),
    day: v.optional(v.string()),
  },
  handler: async (ctx, { text, todoId, blockId, day }) => {
    await requireTomId(ctx);
    const trimmed = text.trim();
    if (trimmed === "") throw new Error("A time note needs text");
    requireOneTimeNoteContext(todoId, blockId, day);
    if (day !== undefined && !DAY_KEY_RE.test(day)) {
      throw new Error(`A day is a calendar date, YYYY-MM-DD — got ${day}`);
    }
    if (todoId !== undefined && !(await ctx.db.get(todoId))) {
      throw new Error("TTS todo not found");
    }
    if (blockId !== undefined && !(await ctx.db.get(blockId))) {
      throw new Error("Block not found");
    }
    const id = await ctx.db.insert("dtsTimeNotes", {
      text: trimmed,
      todoId,
      blockId,
      day,
      status: "pending",
      createdAt: Date.now(),
    });
    await logEvent(ctx, "time-note", todoId, { text: trimmed, blockId, day });
    return id;
  },
});

// Tom withdraws a note he no longer wants acted on. An APPLIED note is not
// deletable — it already changed the world, and its record is the only trace
// of why (nothing-ever-lost applies to what happened, not to what is queued).
export const deleteTimeNote = mutation({
  args: { id: v.id("dtsTimeNotes") },
  handler: async (ctx, { id }) => {
    await requireTomId(ctx);
    const note = await ctx.db.get(id);
    if (!note) throw new Error("Time note not found");
    if (note.status === "applied") {
      throw new Error("An applied time note is history — it is not deleted");
    }
    await ctx.db.delete(id);
    await logEvent(ctx, "time-note-deleted", note.todoId, { text: note.text });
  },
});

// The actions a time note may ask for. Every one of them is validated again
// below against the same helpers the equivalent Tom-gated mutation uses.
const TIME_NOTE_ACTION = v.union(
  v.object({
    kind: v.literal("set-due"),
    dueAt: v.number(),
    dateKind: v.optional(DATE_KIND),
  }),
  v.object({
    kind: v.literal("renegotiate"),
    newDueAt: v.number(),
    note: v.optional(v.string()),
  }),
  // A miss may come with the replacement date in the same breath ("I blew
  // Tuesday, do it Friday") — the outcome row records the miss, newDueAt is the
  // new date. Omit it and the item drops back to whenever with the miss on
  // record (applyDateOutcome's existing two branches).
  v.object({
    kind: v.literal("record-missed"),
    newDueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  }),
  // The date stands; only its NATURE was misread ("that deadline is the
  // landlord's, not mine").
  v.object({ kind: v.literal("set-date-kind"), dateKind: DATE_KIND }),
  v.object({ kind: v.literal("set-latest-safe"), latestSafeAt: v.number() }),
  v.object({ kind: v.literal("clear-latest-safe") }),
  v.object({
    kind: v.literal("set-waiting"),
    wakeAt: v.optional(v.number()),
    wakeCondition: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("set-active") }),
  v.object({
    kind: v.literal("create-block"),
    start: v.number(),
    end: v.number(),
    todoId: v.optional(v.string()),
    category: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("update-block"),
    blockId: v.string(),
    start: v.number(),
    end: v.number(),
  }),
  v.object({ kind: v.literal("delete-block"), blockId: v.string() }),
);

// The pending queue with the full context each note needs, for the worker job
// (POST /tts/time-notes). Nothing here is a decision — it is the facts the
// note is about, so the job never has to guess what "it" refers to.
export const internalPendingTimeNotes = internalQuery({
  args: {},
  handler: async (ctx) => {
    const notes = await ctx.db
      .query("dtsTimeNotes")
      .withIndex("by_status_and_resolvedAt", (q) => q.eq("status", "pending"))
      .take(TIME_NOTE_LIST_MAX);
    if (notes.length === 0) return [];
    // Blocks are read PER NEEDED WINDOW off by_start, never as a whole table:
    // one NY calendar day per note that needs one, memoized so N notes on the
    // same day cost one range query. "That day's blocks" = the blocks that
    // START that day — the same rule the day column paints by.
    const blocksByDay = new Map<string, Doc<"dtsBlocks">[]>();
    const dayBlocks = async (dayKey: string) => {
      const cached = blocksByDay.get(dayKey);
      if (cached) return cached;
      let rows: Doc<"dtsBlocks">[] = [];
      // A key that is not a calendar date has no window. createTimeNote is the
      // only writer and validates the same shape, but this read serves the
      // whole worker queue every two minutes: one malformed row must not take
      // every other note down with a NaN range query.
      if (DAY_KEY_RE.test(dayKey)) {
        const { start, end } = nyCalendarDayBoundsUtc(dayKey);
        rows = await ctx.db
          .query("dtsBlocks")
          .withIndex("by_start", (q) => q.gte("start", start).lt("start", end))
          .collect();
      }
      blocksByDay.set(dayKey, rows);
      return rows;
    };
    // The active list is the same for every day-scoped note, and most runs have
    // none at all — read it once, lazily.
    let activeTodos: Doc<"dtsTodos">[] | null = null;
    const activeOnce = async () => {
      activeTodos ??= await ctx.db
        .query("dtsTodos")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
      return activeTodos;
    };
    const out = [];
    for (const note of notes) {
      let context: unknown = null;
      if (note.todoId !== undefined) {
        const todo = await ctx.db.get(note.todoId);
        context = todo
          ? {
              kind: "todo",
              todo: {
                _id: todo._id,
                statement: todo.statement,
                status: todo.status,
                timingClass: todo.timingClass,
                dueAt: todo.dueAt ?? null,
                dateKind: todo.dateKind ?? null,
                latestSafeAt: todo.latestSafeAt ?? null,
                wakeAt: todo.wakeAt ?? null,
                wakeCondition: todo.wakeCondition ?? null,
                dateOutcomes: todo.dateOutcomes ?? [],
              },
            }
          : { kind: "todo", todo: null };
      } else if (note.blockId !== undefined) {
        const block = await ctx.db.get(note.blockId);
        context = block
          ? {
              kind: "block",
              block,
              // Same NY calendar date as the block — what else is committed
              // that day, so a move can be judged against the day's shape.
              sameDayBlocks: (
                await dayBlocks(nyCalendarDayKey(block.start))
              ).filter((b) => b._id !== block._id),
            }
          : { kind: "block", block: null, sameDayBlocks: [] };
      } else if (note.day !== undefined) {
        context = {
          kind: "day",
          dayBlocks: await dayBlocks(note.day),
          activeTodos: (await activeOnce()).map((t) => ({
            _id: t._id,
            statement: t.statement,
            category: t.category ?? null,
            dueAt: t.dueAt ?? null,
          })),
        };
      }
      out.push({ ...note, context });
    }
    return out;
  },
});

// The worker's write-back (POST /tts/apply-time-note). Every action is
// re-validated HERE with the shared helpers — applyDateOutcome for kept dates,
// applyStatusChange for waiting/active, insert/patch/removeBlock for the
// calendar — so the agent's reading of Tom's sentence is a PROPOSAL, never an
// authority. Any rejection throws, the whole mutation rolls back (note left
// pending), and the job re-submits it as "needs-session" with the reason.
export const internalApplyTimeNote = internalMutation({
  args: {
    id: v.string(),
    status: v.union(v.literal("applied"), v.literal("needs-session")),
    result: v.string(),
    actions: v.optional(v.array(TIME_NOTE_ACTION)),
  },
  handler: async (ctx, { id, status, result, actions }) => {
    const normalized = ctx.db.normalizeId("dtsTimeNotes", id);
    if (!normalized) throw new Error(`Unknown time note id: ${id}`);
    const note = await ctx.db.get(normalized);
    if (!note) throw new Error(`Unknown time note id: ${id}`);
    if (note.status !== "pending") {
      throw new Error(`Time note is already ${note.status}`);
    }
    if (result.trim() === "") throw new Error("result (one sentence) required");
    const list = actions ?? [];
    if (status === "needs-session" && list.length > 0) {
      throw new Error("A needs-session time note carries no actions");
    }

    const now = Date.now();
    // The todo the note is about — the only subject a todo-scoped action may
    // touch (a day/block note has none, so those actions are refused). RE-READ
    // per action, never hoisted: one note may carry a sequence ("I missed
    // Tuesday, do it Friday"), and a Convex read sees this mutation's own
    // earlier writes, so action N validates against action N−1's RESULT rather
    // than against a snapshot from before the loop.
    const requireSubject = async (kind: string) => {
      const subject = note.todoId ? await ctx.db.get(note.todoId) : null;
      if (!subject) {
        throw new Error(`${kind} needs a time note written on a todo`);
      }
      return subject;
    };
    const getBlock = async (raw: string) => {
      const blockId = ctx.db.normalizeId("dtsBlocks", raw);
      const block = blockId && (await ctx.db.get(blockId));
      if (!block) throw new Error(`Unknown block id: ${raw}`);
      return block;
    };
    // A time note is Tom's own written instruction, so an action that lands
    // through it is a Tom touch — stamped exactly where the equivalent public
    // mutation stamps it (updateTodo and setStatus do; recordDateOutcome and
    // the block mutations do not).
    const touch = async (todoId: Id<"dtsTodos">) =>
      ctx.db.patch(todoId, { tomTouchedAt: now });

    for (const action of list) {
      switch (action.kind) {
        case "set-due": {
          const todo = await requireSubject("set-due");
          // First date is free; a second one is a renegotiation (kept dates).
          if (todo.dueAt !== undefined) {
            throw new Error(
              "This todo already has a date — moving it is a renegotiation, not a new date (kept-dates rule)",
            );
          }
          await ctx.db.patch(todo._id, {
            dueAt: action.dueAt,
            dateKind: action.dateKind ?? "self-imposed",
            timingClass: "dated",
            updatedAt: now,
            tomTouchedAt: now,
          });
          await logEvent(ctx, "updated", todo._id, {
            fields: ["dueAt"],
            via: "time-note",
          });
          break;
        }
        case "renegotiate": {
          const todo = await requireSubject("renegotiate");
          // applyDateOutcome enforces "before the date" — no silent slides,
          // no post-hoc renegotiation.
          await applyDateOutcome(ctx, todo, {
            outcome: "renegotiated",
            newDueAt: action.newDueAt,
            note: action.note,
          });
          break;
        }
        case "record-missed": {
          const todo = await requireSubject("record-missed");
          if (todo.dueAt === undefined) {
            throw new Error("Todo has no date to resolve");
          }
          if (now < todo.dueAt) {
            throw new Error(
              "The date has not arrived — a date that is still ahead is renegotiated, not missed",
            );
          }
          // With newDueAt the item stays dated on the replacement date; without
          // it, it drops back to whenever — applyDateOutcome's own two branches,
          // and the miss is on record either way.
          await applyDateOutcome(ctx, todo, {
            outcome: "missed",
            newDueAt: action.newDueAt,
            note: action.note,
          });
          break;
        }
        case "set-date-kind": {
          const todo = await requireSubject("set-date-kind");
          // Whose deadline it is only means anything while there IS one.
          if (todo.dueAt === undefined) {
            throw new Error("Todo has no date to describe");
          }
          await ctx.db.patch(todo._id, {
            dateKind: action.dateKind,
            updatedAt: now,
            tomTouchedAt: now,
          });
          await logEvent(ctx, "updated", todo._id, {
            fields: ["dateKind"],
            via: "time-note",
          });
          break;
        }
        case "set-latest-safe": {
          const todo = await requireSubject("set-latest-safe");
          await ctx.db.patch(todo._id, {
            latestSafeAt: action.latestSafeAt,
            updatedAt: now,
            tomTouchedAt: now,
          });
          await logEvent(ctx, "updated", todo._id, {
            fields: ["latestSafeAt"],
            via: "time-note",
          });
          break;
        }
        case "clear-latest-safe": {
          const todo = await requireSubject("clear-latest-safe");
          await ctx.db.patch(todo._id, {
            latestSafeAt: undefined,
            updatedAt: now,
            tomTouchedAt: now,
          });
          await logEvent(ctx, "updated", todo._id, {
            fields: ["latestSafeAt"],
            via: "time-note",
          });
          break;
        }
        case "set-waiting": {
          const todo = await requireSubject("set-waiting");
          // MERGE, don't replace: a note that only moves the wake DATE ("wait
          // until the 15th instead") says nothing about the wake condition, and
          // applyStatusChange writes both fields unconditionally — so an
          // omitted field carries the stored value forward instead of erasing
          // a fact Tom never asked to lose.
          await applyStatusChange(ctx, todo, {
            status: "waiting",
            wakeAt: action.wakeAt ?? todo.wakeAt,
            wakeCondition: action.wakeCondition ?? todo.wakeCondition,
            note: note.text,
          });
          await touch(todo._id);
          break;
        }
        case "set-active": {
          const todo = await requireSubject("set-active");
          await applyStatusChange(ctx, todo, {
            status: "active",
            note: note.text,
          });
          await touch(todo._id);
          break;
        }
        case "create-block": {
          let blockTodoId: Id<"dtsTodos"> | undefined;
          if (action.todoId !== undefined) {
            const t = ctx.db.normalizeId("dtsTodos", action.todoId);
            if (!t) throw new Error(`Unknown todo id: ${action.todoId}`);
            blockTodoId = t;
          } else if (action.category === undefined && note.todoId) {
            // A block asked for from a todo's own note defaults to that todo.
            blockTodoId = note.todoId;
          }
          await insertBlock(ctx, {
            start: action.start,
            end: action.end,
            todoId: blockTodoId,
            category: action.category,
          });
          break;
        }
        case "update-block": {
          const block = await getBlock(action.blockId);
          await patchBlock(ctx, block, {
            start: action.start,
            end: action.end,
          });
          break;
        }
        case "delete-block": {
          await removeBlock(ctx, await getBlock(action.blockId));
          break;
        }
      }
    }

    await ctx.db.patch(normalized, {
      status,
      result: result.trim(),
      resolvedAt: now,
    });
    await logEvent(ctx, "time-note-resolved", note.todoId, {
      status,
      result: result.trim(),
      actions: list.map((a) => a.kind),
    });
    return { ok: true, applied: list.length };
  },
});

// The server owns the clock (the /tts/state prepDay convention): the worker
// never computes New York time itself, it repeats back what this returns.
export function nowContext(utcMs: number) {
  return {
    now: utcMs,
    nowIso: new Date(utcMs).toISOString(),
    nyCalendarDay: nyCalendarDayKey(utcMs),
    nyOffsetHours: nyOffsetHours(utcMs),
    timezone: "America/New_York",
  };
}

// Instrumentation hook for the surfaces (spec §10): Focus/Inventory record
// engagement, queue cycling, session starts, etc. Kind is free-form by
// convention; the analysis layer is a later TTS todo.
export const recordEvent = mutation({
  args: {
    kind: v.string(),
    todoId: v.optional(v.id("dtsTodos")),
    data: v.optional(v.any()),
  },
  handler: async (ctx, { kind, todoId, data }) => {
    await requireTomId(ctx);
    await logEvent(ctx, kind, todoId, data);
  },
});

// ── Internal: worker submissions (via key-authed http.ts routes) ─────────────

export const internalCapture = internalMutation({
  args: {
    statement: v.string(),
    source: v.string(),
    provenance: v.optional(v.string()),
  },
  handler: async (ctx, { statement, source, provenance }) => {
    const now = Date.now();
    const id = await ctx.db.insert("dtsTodos", {
      statement: statement.trim(),
      readiness: "unprepared",
      status: "active",
      timingClass: "whenever",
      source,
      provenance,
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, "captured", id, { source });
    return id;
  },
});

export const internalStoreWorkerPrep = internalMutation({
  args: {
    day: v.string(),
    todoIds: v.array(v.string()),
    reasons: v.optional(v.array(v.string())),
    digestText: v.optional(v.string()),
  },
  handler: async (ctx, { day, todoIds, reasons, digestText }) => {
    const entries: { todoId: Id<"dtsTodos">; reason?: string }[] = [];
    const dropped: { id: string; why: string }[] = [];
    for (let i = 0; i < todoIds.length; i++) {
      // The worker sends plain strings over HTTP; normalizeId is the proper
      // reject-with-a-name path for malformed/wrong-table ids.
      const normalized = ctx.db.normalizeId("dtsTodos", todoIds[i]);
      if (!normalized) throw new Error(`Unknown todo id: ${todoIds[i]}`);
      const todo = await ctx.db.get(normalized);
      if (!todo) throw new Error(`Unknown todo id: ${todoIds[i]}`);
      // The model sees waiting items for context but must not queue them; a
      // sleeping card on Focus would contradict the Inventory. Drop, don't
      // reject — one bad pick shouldn't cost the whole prepared queue.
      if (todo.status !== "active") {
        dropped.push({ id: todoIds[i], why: `status ${todo.status}` });
        continue;
      }
      if (entries.length >= QUEUE_MAX) {
        dropped.push({ id: todoIds[i], why: "over queue cap" });
        continue;
      }
      entries.push({ todoId: todo._id, reason: reasons?.[i] });
    }
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        entries,
        digestText,
        preparedAt: now,
        preparedBy: "worker",
      });
    } else {
      await ctx.db.insert("dtsDailyQueues", {
        day,
        entries,
        digestText,
        preparedAt: now,
        preparedBy: "worker",
      });
    }
    await logEvent(ctx, "queue-prepared", undefined, {
      day,
      by: "worker",
      count: entries.length,
      dropped: dropped.length > 0 ? dropped : undefined,
    });
  },
});

// The preparation path for LIFE todos (spec §15, swarm-lite): the worker's
// preparer job advances an unprepared capture toward ready-for-tom by
// attaching the ground-up brief, the smallest entry action, and a qualitative
// work description. It never touches statement or status — those are Tom's
// (or the capture's) and preparation must not rewrite intent. Since
// 2026-08-29 it may also set a FIRST dueAt, and only when the statement
// itself states the date (the QuickAdd date input is gone): Tom's own words,
// never an agent's guess, and never over an existing date.
export const internalPrepareTodo = internalMutation({
  args: {
    id: v.string(),
    brief: v.optional(v.string()),
    entryAction: v.optional(v.string()),
    workDescription: v.optional(v.string()),
    readiness: v.optional(
      v.union(v.literal("preparing"), v.literal("ready-for-tom")),
    ),
    importanceLevel: v.optional(IMPORTANCE_LEVEL),
    importanceRationale: v.optional(v.string()),
    plan: v.optional(v.array(PLAN_STEP)),
    // ── The graph worker's three args (schema v2, 2026-08-29) ────────────────
    // A worker session claims ONE ready todo inside a batch and advances it by
    // one stable state, and this is the pen it writes that state with. It
    // needs three things the plan-era pen did not have:
    //   evidence             — the artifact that shows the work happened (a
    //                          branch, a pull request, a written brief). The
    //                          schema field of the same name, per row.
    //   groundUpExplanation  — the self-contained "more" layer, written when a
    //                          task turns out to need Tom's judgment and he has
    //                          to be able to rule on it cold.
    //   status: "done"       — closes the row, which is what makes every task
    //                          that NEEDS it ready. Accepted only for a row
    //                          inside a batch (batchId set): a standalone life
    //                          todo is Tom's to close and no agent write may
    //                          close one behind him. "done" is the only value —
    //                          archiving and sleeping stay Tom's verdicts.
    evidence: v.optional(v.string()),
    groundUpExplanation: v.optional(v.string()),
    status: v.optional(v.literal("done")),
    // The date the STATEMENT itself states ("pay rent sept 3"). The QuickAdd
    // date input is gone (2026-08-29), so this is how an explicit date Tom
    // wrote in his own words reaches the row. Statement text is Tom's, so this
    // is not an agent inventing a date — but the guard below is absolute: only
    // when the todo has no dueAt yet, never an overwrite.
    dueAt: v.optional(v.number()),
    dateKind: v.optional(DATE_KIND),
  },
  handler: async (
    ctx,
    { id, brief, entryAction, workDescription, readiness, importanceLevel, importanceRationale, plan, dueAt, dateKind, evidence, groundUpExplanation, status },
  ) => {
    const normalized = ctx.db.normalizeId("dtsTodos", id);
    if (!normalized) throw new Error(`Unknown todo id: ${id}`);
    const todo = await ctx.db.get(normalized);
    if (!todo) throw new Error(`Unknown todo id: ${id}`);
    // Bounded arrays (Convex unbounded-array-field guideline): a plan never
    // exceeds MAX_PLAN_STEPS steps.
    if (plan !== undefined && plan.length > MAX_PLAN_STEPS) {
      throw new Error(
        `A plan holds at most ${MAX_PLAN_STEPS} steps — got ${plan.length}`,
      );
    }
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (todo.members !== undefined) {
      // Batch gate: the batcher (internalStoreBatches) owns batch briefs —
      // the single-todo preparer must never rewrite a grouping brief. ONLY the
      // plan field may land here (session agents update plans through this
      // pen); everything else is skipped with one named event.
      const skippedFields = [
        brief !== undefined && "brief",
        entryAction !== undefined && "entryAction",
        workDescription !== undefined && "workDescription",
        readiness !== undefined && "readiness",
        importanceLevel !== undefined && "importance",
        dueAt !== undefined && "dueAt",
        evidence !== undefined && "evidence",
        groundUpExplanation !== undefined && "groundUpExplanation",
      ].filter(Boolean);
      if (skippedFields.length > 0) {
        await logEvent(ctx, "prepare-skipped-batch", normalized, {
          fields: skippedFields,
        });
      }
    } else {
      if (brief !== undefined) patch.brief = brief;
      if (evidence !== undefined) patch.evidence = evidence;
      if (groundUpExplanation !== undefined) {
        patch.groundUpExplanation = groundUpExplanation;
      }
      if (entryAction !== undefined) patch.entryAction = entryAction;
      if (workDescription !== undefined) patch.workDescription = workDescription;
      if (readiness !== undefined) patch.readiness = readiness;
      if (importanceLevel !== undefined) {
        // Agent importance never overwrites Tom's (setBy-"tom" guard).
        const importance = agentImportancePatch(
          todo.importance,
          importanceLevel,
          importanceRationale,
          now,
        );
        if (importance === undefined) {
          await logEvent(ctx, "importance-skipped", normalized, {
            level: importanceLevel,
          });
        } else {
          patch.importance = importance;
        }
      }
      if (dueAt !== undefined) {
        // Kept-dates rule (spec §8): a stored date moves only through
        // recordDateOutcome / a time note. The preparer gets the FIRST date
        // only — an existing one is never overwritten, and the skip is named.
        // A RESOLVED date counts as a date: an item whose date was recorded
        // missed or renegotiated has a dateOutcomes history, and letting a
        // re-prep read the same statement and hand back the very date Tom just
        // resolved would resurrect it behind his back.
        if (todo.dueAt !== undefined || (todo.dateOutcomes ?? []).length > 0) {
          await logEvent(ctx, "due-skipped", normalized, { dueAt });
        } else {
          patch.dueAt = dueAt;
          patch.dateKind = dateKind ?? "self-imposed";
          patch.timingClass = "dated";
        }
      }
    }
    // Agents rewrite plans freely — Tom's input gates persistence (rulings,
    // merges), not plan text.
    if (plan !== undefined) patch.plan = plan;
    await ctx.db.patch(normalized, patch);
    await logEvent(ctx, "prepared", normalized, {
      readiness: patch.readiness,
      fields: [
        patch.brief !== undefined && "brief",
        patch.entryAction !== undefined && "entryAction",
        patch.workDescription !== undefined && "workDescription",
        patch.importance !== undefined && "importance",
        patch.plan !== undefined && "plan",
        patch.dueAt !== undefined && "dueAt",
        patch.evidence !== undefined && "evidence",
        patch.groundUpExplanation !== undefined && "groundUpExplanation",
      ].filter(Boolean),
    });
    // Completion runs LAST and through the ONE transition implementation
    // (applyStatusChange): a raw status patch would skip the kept-dates
    // resolution on a dated row and emit no status-changed event. It reads the
    // row as it stands AFTER the patch above, so the evidence written in the
    // same call is already on it.
    if (status === "done") {
      const fresh = await ctx.db.get(normalized);
      if (!fresh) return;
      // THE THREE BARS, most specific first. Each is a NAMED refusal rather
      // than a silent skip: a worker that thinks it closed a todo and did not
      // would report work as landed that is still open, and only this row
      // would say otherwise.
      //
      //   (a) inside a batch — a standalone life todo is Tom's to close.
      //   (b) not frozen, unless it is a checkable goal. tomTouchedAt is the
      //       freeze every other agent write in this file respects, and goal
      //       binding is explicitly allowed on Tom-touched rows, so without
      //       this bar every bound goal became a row an agent could close.
      //       A CHECKABLE goal is the one exception, and it is the design:
      //       checking the world and recording the answer is a goal's whole
      //       contract.
      //   (c) a goal's condition is a GOAL CONDITION. `condition` reads two
      //       ways (schema.ts): on a condition-bound row it is the TRIGGER
      //       that says when the todo may start, not a completion test.
      //       Closing on a fired trigger is closing Tom's todo for him.
      const why =
        fresh.batchId === undefined
          ? "only a todo inside a batch may be completed by the pen"
          : fresh.kind === "goal" && !goalCheckable(fresh)
            ? "a goal is completed by the pen only when its condition is a goal condition (a condition-bound row's condition is its trigger)"
            : fresh.tomTouchedAt !== undefined && fresh.kind !== "goal"
              ? "Tom-touched (frozen) — only he closes a row he has ruled on"
              : null;
      if (why !== null) {
        await logEvent(ctx, "done-skipped", normalized, { why });
      } else if (fresh.status !== "done") {
        await applyStatusChange(ctx, fresh, {
          status: "done",
          note: "worker: task completed",
        });
      }
    }
  },
});

// The batcher's write path (key-authed POST /tts/batches). Drop-don't-reject
// (the internalStoreWorkerPrep pattern): one bad grouping must not fail the
// batch run, so a batch that fails member validation, collides on an occupied
// member, or targets a row the batcher may not touch is SKIPPED with a named
// reason. A row is batcher-writable only while source "batcher", status
// "active", and never Tom-touched (tomTouchedAt set = FROZEN).
export const internalStoreBatches = internalMutation({
  args: {
    batches: v.array(
      v.object({
        id: v.optional(v.string()),
        statement: v.string(),
        brief: v.string(),
        members: v.array(MEMBER),
        plan: v.optional(v.array(PLAN_STEP)),
        importanceLevel: v.optional(IMPORTANCE_LEVEL),
        importanceRationale: v.optional(v.string()),
      }),
    ),
    archiveIds: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { batches, archiveIds }) => {
    const skipped: { ref: string; why: string }[] = [];
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let archived = 0;

    // null = writable; otherwise the plain-language reason it is not.
    const notWritable = (todo: Doc<"dtsTodos">): string | null => {
      if (todo.source !== "batcher") return `source ${todo.source} is not batcher`;
      if (todo.tomTouchedAt !== undefined) return "Tom-touched (frozen)";
      if (todo.status !== "active") return `status ${todo.status}`;
      return null;
    };

    // Archives first: a regroup is archive-old + create-new in one call, so
    // retired batches must free their members before the occupied map is
    // built. Goes through applyStatusChange (which does NOT stamp
    // tomTouchedAt — this is an agent action, not a Tom touch).
    for (const raw of archiveIds ?? []) {
      const normalized = ctx.db.normalizeId("dtsTodos", raw);
      const todo = normalized && (await ctx.db.get(normalized));
      if (!todo) {
        skipped.push({ ref: raw, why: "unknown todo id" });
        continue;
      }
      const frozen = notWritable(todo);
      if (frozen) {
        skipped.push({ ref: raw, why: frozen });
        continue;
      }
      await applyStatusChange(ctx, todo, {
        status: "archived",
        note: "batcher: regrouped or members terminal",
      });
      archived++;
    }

    // Occupied-member map from ALL non-terminal members-bearing rows, each
    // entry tagged with its owner batch id: a desired batch's member conflicts
    // UNLESS the occupying owner is that batch itself (a rewrite may keep its
    // own members). Consequence, on purpose: moving a member from existing
    // batch X to a new batch takes two runs (run 1: X's rewrite drops it;
    // run 2: the new batch claims it) — conservative, so a skipped rewrite can
    // never leave a subject claimable twice. Each landed batch extends the map
    // so in-call batches conflict pairwise. One collect feeds this map, the
    // rewrite lookups, and validateBatchMembers (opts.todoById).
    const all = await ctx.db.query("dtsTodos").collect();
    const todoById = new Map<Id<"dtsTodos">, Doc<"dtsTodos">>(
      all.map((t) => [t._id, t]),
    );
    const occupied = new Map<
      string,
      { id: Id<"dtsTodos">; statement: string }
    >();
    for (const todo of all) {
      if (todo.members === undefined) continue;
      if (todo.status !== "active" && todo.status !== "waiting") continue;
      for (const m of todo.members) {
        occupied.set(memberKey(m), { id: todo._id, statement: todo.statement });
      }
    }

    const now = Date.now();
    for (const b of batches) {
      const normalized =
        b.id === undefined ? null : ctx.db.normalizeId("dtsTodos", b.id);
      if (b.id !== undefined && !normalized) {
        skipped.push({ ref: b.statement, why: `unknown todo id: ${b.id}` });
        continue;
      }
      // Bounded arrays (Convex unbounded-array-field guideline) — a per-batch
      // skip like the other validation failures.
      if (b.plan !== undefined && b.plan.length > MAX_PLAN_STEPS) {
        skipped.push({
          ref: b.statement,
          why: `a plan holds at most ${MAX_PLAN_STEPS} steps — got ${b.plan.length}`,
        });
        continue;
      }
      try {
        await validateBatchMembers(ctx, b.members, {
          selfId: normalized ?? undefined,
          todoById,
        });
      } catch (e) {
        skipped.push({
          ref: b.statement,
          why: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const conflict = b.members.find((m) => {
        const owner = occupied.get(memberKey(m));
        return owner !== undefined && owner.id !== normalized;
      });
      if (conflict) {
        skipped.push({
          ref: b.statement,
          why: `${memberKey(conflict)} is already in batch "${occupied.get(memberKey(conflict))!.statement}"`,
        });
        continue;
      }
      if (normalized) {
        const todo = todoById.get(normalized);
        if (!todo) {
          skipped.push({ ref: b.statement, why: `unknown todo id: ${b.id}` });
          continue;
        }
        const frozen = notWritable(todo);
        if (frozen) {
          skipped.push({ ref: b.statement, why: frozen });
          continue;
        }
        // Rewrite of what the batcher owns — but an ABSENT plan or importance
        // PRESERVES the stored value (internalStoreBriefs semantics: an LLM
        // omission must not delete state); only explicit values overwrite,
        // and Tom's importance is never overwritten (agentImportancePatch).
        let importance = todo.importance;
        if (b.importanceLevel !== undefined) {
          const next = agentImportancePatch(
            todo.importance,
            b.importanceLevel,
            b.importanceRationale,
            now,
          );
          if (next === undefined) {
            await logEvent(ctx, "importance-skipped", normalized, {
              level: b.importanceLevel,
            });
          } else if (
            todo.importance?.setBy === "agent" &&
            todo.importance.level === next.level &&
            todo.importance.rationale === next.rationale
          ) {
            // Same agent value re-posted: keep the stored object (its setAt)
            // so the unchanged check below can recognize a no-op run.
          } else {
            importance = next;
          }
        }
        const projected = {
          statement: b.statement.trim(),
          brief: b.brief,
          members: b.members,
          plan: b.plan ?? todo.plan,
          importance,
        };
        const stored = {
          statement: todo.statement,
          brief: todo.brief,
          members: todo.members,
          plan: todo.plan,
          importance: todo.importance,
        };
        // No-op rewrite: nothing changed, so skip the patch entirely — a
        // 6-hourly re-post must not bump updatedAt and re-push every open
        // client. Counted as "unchanged", neither updated nor skipped.
        if (JSON.stringify(projected) === JSON.stringify(stored)) {
          unchanged++;
        } else {
          await ctx.db.patch(normalized, { ...projected, updatedAt: now });
          updated++;
        }
        for (const m of b.members) {
          occupied.set(memberKey(m), {
            id: normalized,
            statement: projected.statement,
          });
        }
      } else {
        const id = await ctx.db.insert("dtsTodos", {
          statement: b.statement.trim(),
          brief: b.brief,
          members: b.members,
          plan: b.plan,
          importance:
            b.importanceLevel !== undefined
              ? agentImportancePatch(
                  undefined,
                  b.importanceLevel,
                  b.importanceRationale,
                  now,
                )
              : undefined,
          readiness: "ready-for-tom",
          status: "active",
          timingClass: "whenever",
          source: "batcher",
          createdAt: now,
          updatedAt: now,
        });
        await logEvent(ctx, "batch-formed", id, { members: b.members.length });
        created++;
        for (const m of b.members) {
          occupied.set(memberKey(m), { id, statement: b.statement.trim() });
        }
      }
    }

    await logEvent(ctx, "batches-stored", undefined, {
      created,
      updated,
      unchanged,
      archived,
      skipped: skipped.length > 0 ? skipped : undefined,
    });
    return { created, updated, unchanged, archived, skipped };
  },
});

// ── The plan graph (schema v2, ratified 2026-08-29) ──────────────────────────
// A BATCH IS NO LONGER A TODO: it is a `batches` row holding HOW a set of
// todos gets completed, and its contents are dtsTodos rows pointing back at it
// (batchId) as kind "task" (work) or kind "goal" (a checkable state of the
// world). Dependencies between them are `needs`; the todos whose needs are all
// done are "ready" (the frontier — ttsShared owns that rule).

/**
 * The nodes that cannot be ordered: everything still standing after repeatedly
 * removing nodes whose needs are all resolved (Kahn's algorithm, run to a
 * fixed point). That set is exactly the cycles PLUS everything downstream of
 * one — which is what makes dropping all of them a safe repair: no surviving
 * task is left needing a dropped one.
 */
function cycleBoundNodes(edges: Map<string, string[]>): Set<string> {
  const remaining = new Set(edges.keys());
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const node of [...remaining]) {
      if ((edges.get(node) ?? []).every((dep) => !remaining.has(dep))) {
        remaining.delete(node);
        progressed = true;
      }
    }
  }
  return remaining;
}

/**
 * WHAT HAPPENS TO A BATCH'S CONTENTS WHEN THE BATCH GOES AWAY. Archiving only
 * the `batches` row leaves its todos behind as active rows with a batchId
 * nothing will ever schedule: the frontier skips them (their batch is not
 * active), every legacy lane skips them (they carry a batchId), and the
 * preparer skips them too. They become open work that is invisible to the
 * whole system.
 *
 * So the two kinds part ways, each to the place it came from:
 *   tasks — the batch's own work, archived with it. Their statements only ever
 *           meant something inside this batch's plan.
 *   goals — TOM'S OWN TODOS, which the planner merely bound here. They are
 *           unbound (batchId and kind cleared) and returned to the general
 *           pool, where the preparer and the legacy lanes pick them up again
 *           and the planner may bind them into a batch that is still live.
 *
 * Never touches a done row (its resting state is the record of what landed) or
 * a Tom-touched task (he ruled on it; the archive is not an agent's to make).
 */
export async function archiveBatchContents(
  ctx: MutationCtx,
  batchId: Id<"batches">,
  note: string,
) {
  const rows = await ctx.db
    .query("dtsTodos")
    .withIndex("by_batch", (q) => q.eq("batchId", batchId))
    .collect();
  let archivedTasks = 0;
  let unboundGoals = 0;
  for (const row of rows) {
    if (row.kind === "goal") {
      // No updatedAt bump, the mirror of the binding rule: binding and
      // unbinding are both structural annotations, and bumping would resurface
      // a gate Tom already ruled on (the needs-me ruledAt<updatedAt
      // predicate). The row's own content is untouched either way.
      await ctx.db.patch(row._id, { batchId: undefined, kind: undefined });
      unboundGoals++;
      continue;
    }
    if (row.status === "done" || row.status === "archived") continue;
    if (row.tomTouchedAt !== undefined) continue;
    await applyStatusChange(ctx, row, {
      status: "archived",
      unarchiveCondition: "the batch it belonged to comes back",
      note,
    });
    archivedTasks++;
  }
  if (archivedTasks > 0 || unboundGoals > 0) {
    await logEvent(ctx, "graph-batch-emptied", undefined, {
      batchId,
      archivedTasks,
      unboundGoals,
      note,
    });
  }
  return { archivedTasks, unboundGoals };
}

// The planner's pen (the internalStoreBatches pattern, one batch per call):
// upserts ONE batch's graph — the batch row, its tasks, and the goals bound to
// it. Drop-don't-reject: a task that fails validation is SKIPPED with a named
// reason and the rest of the graph still lands; only a batch that is unknown
// or FROZEN (Tom-touched, or terminal) costs the whole call.
export const internalStorePlanGraph = internalMutation({
  args: {
    batchId: v.optional(v.string()), // absent = create the batch
    statement: v.string(),
    groundUpExplanation: v.optional(v.string()),
    path: v.optional(BATCH_PATH),
    tasks: v.array(GRAPH_TASK),
    goalIds: v.optional(v.array(v.string())), // existing todos to bind as goals
    archive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const statement = args.statement.trim();
    const result = {
      batchId: null as Id<"batches"> | null,
      // Did THIS BATCH's graph store? The caller consumes Tom's edit ruling
      // on exactly this fact, and it cannot be read off `skipped`: a task's
      // skip carries the task's statement as its ref, and a task whose
      // statement happens to equal the batch's would read as a refused batch.
      // One field, stated by the only code that knows.
      batchStored: false,
      created: 0,
      updated: 0,
      unchanged: 0,
      goalsBound: 0,
      retired: 0,
      archived: 0,
      skipped: [] as { ref: string; why: string }[],
    };

    // ── The batch row ────────────────────────────────────────────────────────
    let batch: Doc<"batches"> | null = null;
    if (args.batchId !== undefined) {
      const normalized = ctx.db.normalizeId("batches", args.batchId);
      batch = normalized ? await ctx.db.get(normalized) : null;
      if (!batch) {
        result.skipped.push({
          ref: statement,
          why: `unknown batch id: ${args.batchId}`,
        });
        return result;
      }
    } else {
      // IDENTITY WITHOUT AN ID: to the planner a batch IS its statement. v1
      // got idempotence for free from the occupied-member map — a re-post
      // could not re-create a batch claiming the same subjects. Here nothing
      // else carries identity, so a scheduled planner that re-posts a graph
      // without echoing the batch id would mint a fresh batch, and a fresh
      // copy of every task in it, on every run, unbounded. Only ACTIVE
      // batches match (an archived one is history; re-posting its statement
      // starts a new batch); oldest wins, so the choice is deterministic.
      const activeBatches = await ctx.db
        .query("batches")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
      batch =
        activeBatches
          .filter((b) => b.statement === statement)
          .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
    }
    if (batch) {
      result.batchId = batch._id;
      // The freeze, verbatim from internalStoreBatches: a Tom-touched batch is
      // never rewritten by an agent, and a terminal one is not rewritten at all.
      const frozen =
        batch.tomTouchedAt !== undefined
          ? "Tom-touched (frozen)"
          : batch.status !== "active"
            ? `status ${batch.status}`
            : null;
      if (frozen) {
        result.skipped.push({ ref: statement, why: frozen });
        return result;
      }
    }
    const currentBatchId = batch?._id;

    // The batch's existing contents — the other half of the graph a payload
    // edge may point into (by_batch, not a full collect).
    const existingRows = currentBatchId
      ? await ctx.db
          .query("dtsTodos")
          .withIndex("by_batch", (q) => q.eq("batchId", currentBatchId))
          .collect()
      : [];

    // ── Validate every task BEFORE anything is written ───────────────────────
    // A todo is addressable by this graph while it is in THIS batch or in none
    // (claiming another batch's todo is the cross-batch edge Tom ruled out).
    const addressable = (todo: Doc<"dtsTodos">) =>
      todo.batchId === undefined ||
      (currentBatchId !== undefined && todo.batchId === currentBatchId);

    // The PER-ROW freeze — internalStoreBatches' notWritable, applied to a task
    // target (addressable() only says which batch a row is in, not whether the
    // planner may write it). null = writable; otherwise the plain-language
    // reason it is not. Without this the pen would rewrite a life todo Tom
    // wrote by hand, reopen a task he closed, or claim a v1 batch row — which
    // would then render as a batch (app/tts/lib.ts isBatch) while living
    // inside one, the back-door batch-in-batch validateBatchMembers exists to
    // prevent. A `done` task IS writable: it is the resting state of a landed
    // step inside a live graph, and a re-post must still read as unchanged.
    const notWritable = (todo: Doc<"dtsTodos">): string | null => {
      // Most specific reason first — a v1 batch row is refused as a batch, not
      // as a row with the wrong source (which it also has).
      if (todo.members !== undefined) return "is a v1 batch";
      if (todo.tomTouchedAt !== undefined) return "Tom-touched (frozen)";
      if (todo.source !== "planner" && todo.source !== "migration") {
        return `source ${todo.source} is not the planner's`;
      }
      if (todo.status === "archived" || todo.status === "waiting") {
        return `status ${todo.status}`;
      }
      return null;
    };

    type Accepted = {
      key: string; // "#<index>" for a create, the todo id for a rewrite
      existing: Doc<"dtsTodos"> | null;
      task: (typeof args.tasks)[number];
      deps: string[]; // node keys, resolved to ids at write time
    };
    const accepted: Accepted[] = [];
    // Payload index → the accepted task's NODE KEY (its todo id for a rewrite,
    // "#<index>" for a create). An index ref resolves through this, so it can
    // never name a node the write step cannot find.
    const keyByIndex = new Map<number, string>();
    const claimedIds = new Set<string>();
    // Rows this batch would hold once the payload lands — the cap below is on
    // the BATCH, not on one payload: without it a re-post carrying new task
    // statements grows a single batch without bound.
    let projectedRows = existingRows.length;

    for (let i = 0; i < args.tasks.length; i++) {
      const task = args.tasks[i];
      const trimmed = task.statement.trim();
      const ref = trimmed || `task ${i}`;
      const skip = (why: string) => result.skipped.push({ ref, why });
      if (i >= MAX_GRAPH_TASKS) {
        skip(`a graph holds at most ${MAX_GRAPH_TASKS} tasks`);
        continue;
      }
      if (trimmed === "") {
        skip("a task needs a statement");
        continue;
      }
      let existing: Doc<"dtsTodos"> | null = null;
      if (task.id !== undefined) {
        const normalized = ctx.db.normalizeId("dtsTodos", task.id);
        existing = normalized ? await ctx.db.get(normalized) : null;
        if (!existing) {
          skip(`unknown todo id: ${task.id}`);
          continue;
        }
        if (!addressable(existing)) {
          skip(`${task.id} belongs to another batch`);
          continue;
        }
      } else {
        // The same identity rule as the batch row above, one level down:
        // inside a batch a task's STATEMENT names it. A planner that re-posts
        // a graph without echoing task ids rewrites its own rows instead of
        // minting a duplicate set every run. Matched BEFORE the checks below,
        // so an unwritable row is skipped rather than silently duplicated.
        existing =
          existingRows.find((row) => row.statement === trimmed) ?? null;
      }
      if (existing) {
        if (existing.kind === "goal") {
          skip(`${existing._id} is a goal, not a task`);
          continue;
        }
        if (claimedIds.has(existing._id)) {
          skip(`duplicate task: ${existing._id}`);
          continue;
        }
        const frozen = notWritable(existing);
        if (frozen) {
          skip(frozen);
          continue;
        }
      }
      if (!existing && projectedRows >= MAX_GRAPH_TASKS) {
        skip(`a batch holds at most ${MAX_GRAPH_TASKS} todos`);
        continue;
      }
      const refs = task.needs ?? [];
      if (refs.length > MAX_NEEDS) {
        skip(`a todo needs at most ${MAX_NEEDS} others — got ${refs.length}`);
        continue;
      }
      // Resolve each need to a node key. A number addresses an EARLIER task in
      // this payload (backward-only, so in-payload edges cannot cycle); a
      // string addresses an existing todo, which must be addressable too.
      const deps: string[] = [];
      let bad: string | null = null;
      for (const need of refs) {
        if (typeof need === "number") {
          if (!Number.isInteger(need) || need < 0 || need >= i) {
            bad = `needs ${need}: an index must name an EARLIER task in this payload`;
            break;
          }
          // A skipped task takes its dependents with it — landing a task whose
          // need was dropped would silently write a graph that is missing an
          // edge the planner asked for.
          const target = keyByIndex.get(need);
          if (target === undefined) {
            bad = `needs task ${need}, which was skipped`;
            break;
          }
          // The NODE KEY of that task, which is its todo id when the payload
          // addressed an existing row: "#<index>" is only the key of a task
          // being CREATED, and pushing it blindly wrote the literal string
          // "#0" into `needs` whenever an index ref named a rewritten task.
          deps.push(target);
        } else {
          const normalized = ctx.db.normalizeId("dtsTodos", need);
          const target = normalized ? await ctx.db.get(normalized) : null;
          if (!target) {
            bad = `needs an unknown todo id: ${need}`;
            break;
          }
          if (!addressable(target)) {
            bad = `needs ${need}, which belongs to another batch`;
            break;
          }
          deps.push(target._id);
        }
      }
      if (bad) {
        skip(bad);
        continue;
      }
      if (existing) claimedIds.add(existing._id);
      else projectedRows++;
      const key = existing ? (existing._id as string) : `#${i}`;
      keyByIndex.set(i, key);
      accepted.push({
        key,
        existing,
        task,
        // An ABSENT `needs` PRESERVES the stored edges (the preserve-on-absent
        // rule the write below applies to every field), so the acyclicity
        // check has to see the preserved edges, not an empty set — checking []
        // and then storing the old edges would validate a graph nobody wrote.
        deps:
          task.needs === undefined && existing
            ? (existing.needs ?? []).map((id) => id as string)
            : [...new Set(deps)],
      });
    }

    // Acyclicity across the WHOLE batch: the payload's projected edges plus
    // the stored edges of every row the payload does not rewrite. Anything
    // still unorderable is dropped (cycle-bound or downstream of one); the
    // stored rows were validated on their own write, so a cycle always
    // involves this payload.
    const edges = new Map<string, string[]>();
    for (const row of existingRows) {
      if (claimedIds.has(row._id)) continue;
      edges.set(
        row._id,
        (row.needs ?? []).map((id) => id as string),
      );
    }
    for (const a of accepted) edges.set(a.key, a.deps);
    // Close the map over needs that point OUTSIDE this batch. A batch-less
    // todo carries needs of its own, and a node that is not a KEY in the map
    // reads to cycleBoundNodes as already resolved — so A(batch-less) needs B
    // while B needs A would be stored as orderable, and neither would ever be
    // ready with nothing anywhere saying why. Walking the closure (each id
    // fetched once; a dangling id resolves as a leaf) is what makes the
    // acyclicity claim true of the whole graph rather than of one batch.
    const pendingRefs = [...edges.values()].flat();
    const walked = new Set(edges.keys());
    while (pendingRefs.length > 0) {
      const id = pendingRefs.pop()!;
      if (walked.has(id)) continue;
      walked.add(id);
      const normalized = ctx.db.normalizeId("dtsTodos", id);
      const outside = normalized ? await ctx.db.get(normalized) : null;
      const outsideNeeds = (outside?.needs ?? []).map((need) => need as string);
      edges.set(id, outsideNeeds);
      pendingRefs.push(...outsideNeeds);
    }
    const cyclic = cycleBoundNodes(edges);
    const landing = accepted.filter((a) => {
      if (!cyclic.has(a.key)) return true;
      result.skipped.push({
        ref: a.task.statement.trim(),
        why: "needs form a cycle",
      });
      return false;
    });

    // ── Write: the batch row, then its tasks in payload order ────────────────
    if (batch) {
      // An ABSENT field PRESERVES the stored value (internalStoreBriefs
      // semantics: an LLM omission must not delete state), and an unchanged
      // re-post writes nothing — a repeated run must not bump updatedAt and
      // re-push every open client.
      const projected = {
        statement,
        groundUpExplanation:
          args.groundUpExplanation ?? batch.groundUpExplanation,
        path: args.path ?? batch.path,
      };
      const stored = {
        statement: batch.statement,
        groundUpExplanation: batch.groundUpExplanation,
        path: batch.path,
      };
      if (JSON.stringify(projected) !== JSON.stringify(stored)) {
        await ctx.db.patch(batch._id, { ...projected, updatedAt: now });
      }
    } else {
      result.batchId = await ctx.db.insert("batches", {
        statement,
        groundUpExplanation: args.groundUpExplanation,
        path: args.path,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await logEvent(ctx, "graph-batch-formed", undefined, {
        batchId: result.batchId,
        statement,
      });
    }
    const batchId = result.batchId!;
    result.batchStored = true;

    // Payload order + backward-only index refs mean every dep already has its
    // id by the time it is read.
    const idByKey = new Map<string, Id<"dtsTodos">>();
    for (const a of landing) {
      const needs = a.deps.map(
        (dep) => idByKey.get(dep) ?? (dep as Id<"dtsTodos">),
      );
      const prior = a.existing;
      // An ABSENT field PRESERVES the stored value — the same rule the batch
      // row above follows (internalStoreBriefs semantics: an LLM omission must
      // not delete state). ctx.db.patch DELETES a field written as undefined,
      // so writing the payload straight through would erase the evidence a
      // session recorded, the "more" layer, and a claimed row's trigger
      // condition on the planner's very next re-post. `needs` rides the same
      // rule via a.deps: an explicit EMPTY array is how a payload clears edges.
      const fields = {
        statement: a.task.statement.trim(),
        kind: "task" as const,
        actor: a.task.actor,
        batchId,
        needs: needs.length > 0 ? needs : undefined,
        condition: a.task.condition ?? prior?.condition,
        groundUpExplanation:
          a.task.groundUpExplanation ?? prior?.groundUpExplanation,
        evidence: a.task.evidence ?? prior?.evidence,
        // Preserve-on-absent like every field above: a re-post that omits the
        // tier must not silently demote a task the planner already marked as
        // needing the stronger model.
        model: a.task.model ?? prior?.model,
      };
      const desired = a.task.status ?? prior?.status ?? ("active" as const);
      if (prior) {
        const stored = {
          statement: prior.statement,
          kind: prior.kind,
          actor: prior.actor,
          batchId: prior.batchId,
          needs: prior.needs,
          condition: prior.condition,
          groundUpExplanation: prior.groundUpExplanation,
          evidence: prior.evidence,
          model: prior.model,
        };
        const fieldsChanged = JSON.stringify(fields) !== JSON.stringify(stored);
        const statusChanged = desired !== prior.status;
        if (!fieldsChanged && !statusChanged) {
          result.unchanged++;
        } else {
          if (fieldsChanged) {
            await ctx.db.patch(prior._id, { ...fields, updatedAt: now });
          }
          // A status change goes through the ONE transition implementation.
          // A raw patch would leave an archived row's archivedAt and unarchive
          // condition standing on a live todo, skip the kept-dates resolution
          // on a completion (the silent slide updateTodo refuses), and emit no
          // status-changed event for the transition.
          if (statusChanged) {
            await applyStatusChange(ctx, prior, {
              status: desired,
              note: "planner: graph",
            });
          }
          result.updated++;
        }
        idByKey.set(a.key, prior._id);
      } else {
        const id = await ctx.db.insert("dtsTodos", {
          ...fields,
          status: desired,
          doneAt: desired === "done" ? now : undefined,
          // A task is work inside a batch, not a gate: the BATCH is what Tom
          // rules on, so a fresh task is "unprepared" rather than
          // "ready-for-tom" (which would flood the needs-me feed).
          readiness: "unprepared",
          timingClass: "whenever",
          source: "planner",
          createdAt: now,
          updatedAt: now,
        });
        idByKey.set(a.key, id);
        result.created++;
      }
    }

    // ── Goals: existing todos bound to this batch ────────────────────────────
    // No updatedAt bump — binding is a structural annotation, and bumping it
    // would resurface already-ruled gates (the needs-me ruledAt<updatedAt
    // predicate), exactly as importance-only writes must not.
    const goalIds = args.goalIds ?? [];
    // The rows a live v1 batch already claims. validateBatchMembers refuses a
    // v1 batch that claims a row inside a v2 batch; this is the same rule in
    // the other direction, and without it the collision the server-side check
    // exists to prevent lands through the goal binder — a row in a v1 batch
    // AND a v2 batch at once, unschedulable from either side (batchOwned
    // excludes it in claudeSessions, and the v1 lanes filter on batchId).
    // The planner's client-side filter is not this check: it governs which ids
    // are OFFERED, not which the model may emit. Read once, and only when
    // there is a goal to bind.
    const v1Claimed = new Set<string>();
    if (goalIds.length > 0) {
      for (const row of await ctx.db.query("dtsTodos").collect()) {
        if (row.members === undefined) continue;
        if (row.status === "archived" || row.status === "done") continue;
        for (const m of row.members) {
          if (m.todoId !== undefined) v1Claimed.add(m.todoId);
        }
      }
    }
    for (let g = 0; g < goalIds.length; g++) {
      const raw = goalIds[g];
      // Bounded like every other array here: a batch is FOR at most as many
      // subjects as a v1 batch grouped.
      if (g >= MAX_BATCH_MEMBERS) {
        result.skipped.push({
          ref: raw,
          why: `a batch holds at most ${MAX_BATCH_MEMBERS} goals`,
        });
        continue;
      }
      const normalized = ctx.db.normalizeId("dtsTodos", raw);
      const todo = normalized ? await ctx.db.get(normalized) : null;
      if (!todo) {
        result.skipped.push({ ref: raw, why: `unknown todo id: ${raw}` });
        continue;
      }
      // A v1 batch bound as a goal would be a batch inside a batch through the
      // back door — the thing validateBatchMembers refuses in the other
      // direction. (Tom-touched is NOT a bar here: his own todos becoming a
      // batch's goals is the whole point, and binding rewrites no content.)
      if (todo.members !== undefined) {
        result.skipped.push({ ref: raw, why: "is a v1 batch" });
        continue;
      }
      if (v1Claimed.has(todo._id)) {
        result.skipped.push({ ref: raw, why: "is a member of a live v1 batch" });
        continue;
      }
      if (claimedIds.has(todo._id)) {
        result.skipped.push({
          ref: raw,
          why: "already addressed as a task in this graph",
        });
        continue;
      }
      if (!addressable(todo)) {
        result.skipped.push({ ref: raw, why: `${raw} belongs to another batch` });
        continue;
      }
      if (todo.batchId === batchId && todo.kind === "goal") continue; // already bound
      await ctx.db.patch(todo._id, { batchId, kind: "goal" });
      result.goalsBound++;
    }

    // ── Retire what the payload dropped ──────────────────────────────────────
    // THE TASKS ARRAY IS THE BATCH'S TASK LIST. Identity without an id is exact
    // statement match, and the planner is an LLM re-emitting the whole graph
    // every run: a task it REWORDS while omitting its id mints a second row,
    // and both are then ready, both agent-workable, and both get sessions doing
    // the same work on the same branch namespace. Nothing else retires the
    // first, so this does.
    //
    // WHAT IT WILL NOT TOUCH, because a dropped row must never be lost work: a
    // goal (Tom's own todo), a row Tom has touched, a row from any other
    // source, a terminal row, and — the load-bearing one — any row a session
    // has already written to (evidence recorded, or readiness moved off
    // "unprepared"). Those stay in the batch and are reported, not archived.
    // The rule is also skipped entirely when nothing landed, so a payload the
    // server dropped whole cannot empty a graph.
    if (landing.length > 0) {
      for (const row of existingRows) {
        // claimedIds, not the landing set: a task the payload DID address and
        // the server then dropped (a cycle, a fan-in cap) was listed by the
        // planner, and dropping an edge is not the same statement as dropping
        // the task.
        if (claimedIds.has(row._id)) continue;
        if (row.kind === "goal") continue;
        if (row.status !== "active") continue;
        if (row.source !== "planner") continue;
        if (row.tomTouchedAt !== undefined) continue;
        if (row.evidence !== undefined || row.readiness !== "unprepared") {
          result.skipped.push({
            ref: row.statement,
            why: "left in the batch: the planner did not re-emit it, and a session has already worked it",
          });
          continue;
        }
        await applyStatusChange(ctx, row, {
          status: "archived",
          unarchiveCondition: "the planner puts it back in the graph",
          note: "planner: no longer in the graph",
        });
        result.retired++;
      }
    }

    if (args.archive) {
      await ctx.db.patch(batchId, { status: "archived", updatedAt: now });
      result.archived = 1;
      await archiveBatchContents(ctx, batchId, "planner: batch archived");
    }

    await logEvent(ctx, "graph-stored", undefined, {
      batchId,
      created: result.created,
      updated: result.updated,
      unchanged: result.unchanged,
      goalsBound: result.goalsBound,
      retired: result.retired,
      archived: result.archived,
      skipped: result.skipped.length > 0 ? result.skipped : undefined,
    });
    return result;
  },
});

// ── The v1 → v2 migration (built, tested, NOT wired to any cron) ─────────────
// Turns every ACTIVE v1 batch (a dtsTodos row carrying `members`) into the new
// world: a batches row, its plan steps as task todos chained by `needs`, its
// members bound as goals. NOTHING IS EVER DELETED — the old row is archived
// with a pointer to its successor, which is also the idempotence key.
const GRAPH_SUPERSEDED = "superseded by graph batch ";

export const internalMigrateToGraph = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("dtsTodos").collect();
    const oldBatches = all.filter(
      (t) =>
        t.members !== undefined &&
        t.status === "active" &&
        !(t.unarchiveCondition ?? "").startsWith(GRAPH_SUPERSEDED),
    );
    const counts = {
      batches: 0,
      tasks: 0,
      goals: 0,
      codeGoals: 0,
      missingMembers: 0,
      alreadyBound: 0,
    };
    for (const row of oldBatches) {
      const batchId = await ctx.db.insert("batches", {
        statement: row.statement,
        // The v1 grouping brief IS the ground-up explanation — same text, same
        // job (why these belong together), now under its ratified name.
        groundUpExplanation: row.brief,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      counts.batches++;

      // Plan steps become tasks in a LINEAR CHAIN (each needs the one before
      // it): the v1 plan was an ordered list, so the chain is the only reading
      // that is certainly true. The planner parallelizes it later by dropping
      // edges — inventing that parallelism here would be a guess.
      let previous: Id<"dtsTodos"> | undefined;
      for (const step of row.plan ?? []) {
        const done = step.status === "done";
        const id = await ctx.db.insert("dtsTodos", {
          statement: step.text,
          kind: "task",
          actor: step.actor,
          status: done ? "done" : "active",
          doneAt: done ? (step.doneAt ?? now) : undefined,
          evidence: step.evidence,
          batchId,
          needs: previous ? [previous] : undefined,
          readiness: "unprepared",
          timingClass: "whenever",
          source: "migration",
          createdAt: now,
          updatedAt: now,
        });
        previous = id;
        counts.tasks++;
      }

      for (const member of row.members ?? []) {
        if (member.todoId !== undefined) {
          const todo = await ctx.db.get(member.todoId);
          if (!todo) {
            counts.missingMembers++;
            continue;
          }
          // The planner's pen is live before this ever runs, so a member may
          // ALREADY be a goal of a v2 batch. Overwriting batchId here would
          // move it out of that batch silently, with nothing recording the
          // loss — the addressable() rule the pen enforces, enforced here too.
          if (todo.batchId !== undefined && todo.batchId !== batchId) {
            counts.alreadyBound++;
            continue;
          }
          // The accumulated todos ARE the batch's goals (Tom): the statement
          // is untouched, and updatedAt is NOT bumped — a migration must not
          // resurface gates Tom already ruled on.
          await ctx.db.patch(member.todoId, { batchId, kind: "goal" });
          counts.goals++;
        } else {
          // A code member becomes a goal ABOUT the upstream todo: the repo
          // stays the system of record, so the goal is "it is closed there",
          // checkable by (codeRepo, codeExternalId) — the same addressing the
          // member used.
          const sentence = `${member.repo} ${member.externalId} closed upstream`;
          await ctx.db.insert("dtsTodos", {
            statement: sentence,
            kind: "goal",
            condition: sentence,
            codeRepo: member.repo,
            codeExternalId: member.externalId,
            batchId,
            readiness: "unprepared",
            status: "active",
            timingClass: "whenever",
            source: "migration",
            createdAt: now,
            updatedAt: now,
          });
          counts.codeGoals++;
        }
      }

      await applyStatusChange(ctx, row, {
        status: "archived",
        unarchiveCondition: `${GRAPH_SUPERSEDED}${batchId}`,
        note: "schema v2 migration",
      });
    }
    await logEvent(ctx, "graph-migrated", undefined, counts);
    return counts;
  },
});

export const internalListTodos = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsTodos").collect();
  },
});

export const internalListMirror = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dtsCodeTodoMirror").collect();
  },
});

// Every batches row (schema v2), for the planner's context. A full collect,
// like internalListTodos: this is a single-user table holding a few dozen rows
// for years, and the planner needs the archived statements too (it must not
// recreate a grouping Tom retired).
export const internalListBatches = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("batches").collect();
  },
});

// PLAN REPAIRS — a worker that reached a task and found the graph wrong (a
// `needs` edge that is not a real prerequisite, a missing one that blocked it)
// records the finding as a dtsEvents row of kind "plan-repair"; that is the
// only channel by which the doing of the work corrects the planning of it.
// The planner reads these each run and fixes the structure.
//
// THE SCAN IS BOUNDED ON PURPOSE. dtsEvents is append-only instrumentation and
// grows without limit, so this walks the by_at index BACKWARD from `sinceMs`
// (a week by default) rather than filtering the whole table — a run in a week
// with no repairs at all must not read every event ever written.
const PLAN_REPAIR_KIND = "plan-repair";
const PLAN_REPAIR_WINDOW_MS = 7 * DAY_MS;

export const internalRecentPlanRepairs = internalQuery({
  args: { limit: v.optional(v.number()), sinceMs: v.optional(v.number()) },
  handler: async (ctx, { limit, sinceMs }) => {
    const since = sinceMs ?? Date.now() - PLAN_REPAIR_WINDOW_MS;
    const rows = await ctx.db
      .query("dtsEvents")
      .withIndex("by_at", (q) => q.gte("at", since))
      .order("desc")
      .filter((q) =>
        q.and(
          q.eq(q.field("kind"), PLAN_REPAIR_KIND),
          // UNCONSUMED ONLY. A repair is an INSTRUCTION ("this edge is wrong"),
          // not a record, and the planner runs every two hours over the same
          // seven-day window: without this the planner is told to fix an edge
          // it already dropped, ~84 times per repair. The window is still the
          // outer bound — a repair nothing ever consumes ages out as before.
          q.eq(q.field("consumedAt"), undefined),
        ),
      )
      .take(Math.min(limit ?? 20, 100));
    return rows;
  },
});

// The planner's consume pen for the above: the repairs it has now acted on.
// Stamped, never deleted — dtsEvents is append-only instrumentation, and what
// the planner consumed and when is part of the record.
export const internalMarkPlanRepairsConsumed = internalMutation({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }) => {
    const now = Date.now();
    let consumed = 0;
    for (const raw of ids.slice(0, 100)) {
      const id = ctx.db.normalizeId("dtsEvents", raw);
      if (!id) continue;
      const row = await ctx.db.get(id);
      if (!row || row.kind !== PLAN_REPAIR_KIND) continue;
      if (row.consumedAt !== undefined) continue;
      await ctx.db.patch(id, { consumedAt: now });
      consumed++;
    }
    return { consumed };
  },
});

export const internalGetDay = internalQuery({
  args: { day: v.string() },
  handler: async (ctx, { day }) => {
    return await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
  },
});

export const internalMarkDigestSent = internalMutation({
  args: { day: v.string(), surfacedTodoIds: v.array(v.id("dtsTodos")) },
  handler: async (ctx, { day, surfacedTodoIds }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { digestSentAt: now });
    } else {
      await ctx.db.insert("dtsDailyQueues", {
        day,
        entries: [],
        preparedAt: now,
        preparedBy: "fallback",
        digestSentAt: now,
      });
    }
    for (const todoId of surfacedTodoIds) {
      await logEvent(ctx, "surfaced", todoId, { via: "digest", day });
    }
    await logEvent(ctx, "digest-sent", undefined, { day });
  },
});

// ── Internal: fallback queue prep (cron; spec §7 reliability split) ──────────
// Runs shortly before 5 a.m. local (two UTC crons + local-hour guard so DST
// needs no cron edits). Wakes due `waiting` items, then builds a simple-rules
// queue if the worker hasn't posted one. The worker's Claude-written prep, when
// it lands, overwrites this via internalStoreWorkerPrep.
export const internalPrepareFallbackQueue = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    const now = Date.now();
    if (!force && nyLocalHour(now) !== TTS_PREP_NY_HOUR) return; // 4 a.m. hour, before the 5 a.m. send
    // CRITICAL: prep runs BEFORE the 5 a.m. boundary, so ttsDayKey(now) would
    // name YESTERDAY. ttsPrepDay names the day the coming digest belongs to —
    // the digest and getToday then find this row. (Review-caught bug.)
    const day = ttsPrepDay(now);
    const bounds = ttsDayBoundsUtc(day);

    // Wake waiting items whose wake time falls inside the day being prepared —
    // not `wakeAt <= now`: wake times are stored as noon local, and a 4 a.m.
    // check against `now` would wake everything one day late (review-caught).
    const waiting = await ctx.db
      .query("dtsTodos")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))
      .collect();
    for (const todo of waiting) {
      if (todo.wakeAt !== undefined && todo.wakeAt < bounds.end) {
        await ctx.db.patch(todo._id, {
          status: "active",
          updatedAt: now,
          wakeAt: undefined,
          wakeCondition: undefined,
        });
        await logEvent(ctx, "woke", todo._id, { wakeCondition: todo.wakeCondition });
      }
    }

    const existing = await ctx.db
      .query("dtsDailyQueues")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing && !force) return; // worker already prepared today

    const active = (
      await ctx.db
        .query("dtsTodos")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect()
    ) // The dumb fallback cannot reason about batch/member overlap, so it
      // skips batches; the worker's Claude prep may queue them. A schema-v2
      // row (batchId set) is a task or goal INSIDE a batch — the batch is the
      // unit Tom sees, so its parts never queue individually either.
      .filter((t) => t.members === undefined && t.batchId === undefined);
    const endOfToday = bounds.end; // 5 a.m. NY tomorrow, DST-correct
    const entries: { todoId: Id<"dtsTodos">; reason?: string }[] = [];
    const used = new Set<string>();
    const add = (todo: Doc<"dtsTodos">, reason: string) => {
      if (used.has(todo._id) || entries.length >= QUEUE_MAX) return;
      used.add(todo._id);
      entries.push({ todoId: todo._id, reason });
    };

    const dated = active
      .filter((t) => t.dueAt !== undefined)
      .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
    for (const t of dated) {
      if ((t.dueAt ?? 0) < now) add(t, "overdue");
      else if ((t.dueAt ?? 0) <= endOfToday) add(t, "due");
    }
    const conditionBound = active
      .filter(
        (t) =>
          t.timingClass === "condition-bound" &&
          t.latestSafeAt !== undefined &&
          t.latestSafeAt <= now + 14 * 86_400_000,
      )
      .sort((a, b) => (a.latestSafeAt ?? 0) - (b.latestSafeAt ?? 0));
    for (const t of conditionBound.slice(0, 2)) add(t, "condition");
    // Reserve the invitation slot (spec §7) before stale-fill, or every
    // `whenever` item gets consumed as filler and no invitation survives.
    const stale = [...active].sort((a, b) => a.updatedAt - b.updatedAt);
    const invitation = stale.find(
      (t) => t.timingClass === "whenever" && !used.has(t._id),
    );
    if (invitation) add(invitation, "invitation");
    for (const t of stale) {
      if (entries.length >= QUEUE_MAX) break;
      add(t, "stale");
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        entries,
        preparedAt: now,
        preparedBy: "fallback",
        digestText: undefined,
      });
    } else {
      await ctx.db.insert("dtsDailyQueues", {
        day,
        entries,
        preparedAt: now,
        preparedBy: "fallback",
      });
    }
    await logEvent(ctx, "queue-prepared", undefined, {
      day,
      by: "fallback",
      count: entries.length,
    });
  },
});

// ── Internal: code-todo mirror upserts (from ttsSync.refreshMirror) ──────────
export const internalReplaceMirror = internalMutation({
  args: {
    repo: v.string(),
    rows: v.array(
      v.object({
        externalId: v.string(),
        tier: v.string(),
        status: v.string(),
        statement: v.string(),
        url: v.string(),
      }),
    ),
  },
  handler: async (ctx, { repo, rows }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("dtsCodeTodoMirror")
      .withIndex("by_repo_external", (q) => q.eq("repo", repo))
      .collect();
    const byId = new Map(existing.map((r) => [r.externalId, r]));
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.externalId);
      const prior = byId.get(row.externalId);
      if (prior) {
        await ctx.db.patch(prior._id, { ...row, syncedAt: now });
      } else {
        await ctx.db.insert("dtsCodeTodoMirror", { repo, ...row, syncedAt: now });
      }
    }
    // A row missing from the file was closed-and-rewritten or renamed upstream;
    // the mirror only reflects, so drop it (the repo is the system of record —
    // nothing-is-lost applies to LIFE todos, not to this display cache).
    for (const prior of existing) {
      if (!seen.has(prior.externalId)) await ctx.db.delete(prior._id);
    }

    // A schema-v2 CODE GOAL says "that upstream todo is closed" — the mirror is
    // the only thing that can ever say so, and this is the only place the
    // mirror changes. Without this the migration mints active goals nothing can
    // complete, each of which blocks every dependent forever (ttsShared.isReady)
    // and never leaves Tom's inventory. An ABSENT mirror row is NOT evidence of
    // completion (memberProgress' rule: it may be a closed todo or an id that
    // never matched); only an explicit "closed" status closes the goal.
    const closed = new Set(
      rows.filter((r) => r.status === "closed").map((r) => r.externalId),
    );
    if (closed.size > 0) {
      const all = await ctx.db.query("dtsTodos").collect();
      for (const goal of all) {
        if (goal.kind !== "goal" || goal.status !== "active") continue;
        if (goal.codeRepo !== repo || goal.codeExternalId === undefined) continue;
        if (!closed.has(goal.codeExternalId)) continue;
        await applyStatusChange(ctx, goal, {
          status: "done",
          note: `${repo} ${goal.codeExternalId} closed upstream`,
        });
      }
    }
  },
});
